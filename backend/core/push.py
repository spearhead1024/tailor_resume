"""Web Push (VAPID) core for caller notifications.

Holds the VAPID keypair (generated once, stored under data/), a per-user store of browser
push subscriptions, and a send helper that delivers a JSON payload to every device a user has
subscribed and prunes subscriptions the browser has expired (404/410).

Delivery is best-effort and never raises to the caller: a dead push must not break an interview
edit or a scheduler tick.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid01
from pywebpush import WebPushException, webpush

log = logging.getLogger("push")

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
# The VAPID keypair identifies THIS server to the push services. It is generated once and then must
# be kept: if it ever changes, every browser subscription made with the old key silently stops
# receiving pushes and each caller has to re-enable notifications. So it lives outside git (secret)
# and PUSH_VAPID_PRIVATE_KEY_FILE lets a deploy point at a path that survives redeploys/rebuilds.
_VAPID_PEM = Path(os.environ.get("PUSH_VAPID_PRIVATE_KEY_FILE", "").strip() or (DATA_DIR / "vapid_private.pem"))
_SUBS_FILE = DATA_DIR / "push_subscriptions.json"
# The VAPID "sub" claim must be a mailto: or https: the push service can contact about issues.
_VAPID_SUB = os.environ.get("PUSH_VAPID_SUB", "mailto:admin@tailorresume.duckdns.org")

_lock = threading.Lock()          # guards the subscriptions file
_vapid_lock = threading.Lock()    # guards first-time key generation


# ── VAPID keypair ────────────────────────────────────────────────────────────
def _vapid() -> Vapid01:
    """Load the VAPID keypair, generating + persisting it on first use."""
    with _vapid_lock:
        if _VAPID_PEM.exists():
            return Vapid01.from_file(str(_VAPID_PEM))
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        v = Vapid01()
        v.generate_keys()
        v.save_key(str(_VAPID_PEM))
        log.info("Generated a new VAPID keypair at %s", _VAPID_PEM)
        return v


def public_key_b64() -> str:
    """The applicationServerKey the browser needs to subscribe: the uncompressed P-256 public
    point, base64url without padding."""
    raw = _vapid().public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


# ── subscription store (data/push_subscriptions.json) ────────────────────────
# Shape: { user_id: [ {endpoint, keys:{p256dh, auth}, ...}, ... ] }.  A user may have several
# devices/browsers subscribed at once.
def _read() -> dict:
    if not _SUBS_FILE.exists():
        return {}
    try:
        data = json.loads(_SUBS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _SUBS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _SUBS_FILE)


def add_subscription(user_id: str, sub: dict) -> None:
    """Store (or refresh) one browser subscription for a user, de-duped by endpoint."""
    endpoint = str((sub or {}).get("endpoint", "")).strip()
    if not endpoint:
        return
    with _lock:
        data = _read()
        subs = [s for s in data.get(user_id, []) if s.get("endpoint") != endpoint]
        subs.append(sub)
        data[user_id] = subs
        _write(data)


def remove_subscription(user_id: str, endpoint: str) -> None:
    with _lock:
        data = _read()
        subs = [s for s in data.get(user_id, []) if s.get("endpoint") != endpoint]
        if subs:
            data[user_id] = subs
        else:
            data.pop(user_id, None)
        _write(data)


def has_subscription(user_id: str) -> bool:
    with _lock:
        return bool(_read().get(user_id))


def _prune(user_id: str, endpoint: str) -> None:
    """Drop a subscription the push service reported gone (404/410)."""
    remove_subscription(user_id, endpoint)


def send_push(user_id: str, payload: dict) -> int:
    """Deliver `payload` (a JSON-serialisable dict) to every device `user_id` has subscribed.
    Returns the number of successful sends. Never raises."""
    with _lock:
        subs = list(_read().get(user_id, []))
    if not subs:
        return 0
    try:
        pem = str(_VAPID_PEM)
        _vapid()  # ensure the key exists on disk before webpush reads it
    except Exception:
        log.exception("VAPID key unavailable; cannot send push")
        return 0
    body = json.dumps(payload, ensure_ascii=False)
    sent = 0
    for sub in subs:
        try:
            webpush(subscription_info=sub, data=body,
                    vapid_private_key=pem, vapid_claims={"sub": _VAPID_SUB})
            sent += 1
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                _prune(user_id, sub.get("endpoint", ""))
                log.info("Pruned expired push subscription for %s", user_id)
            else:
                log.warning("Push to %s failed (%s): %s", user_id, status, exc)
        except Exception:
            log.exception("Unexpected error pushing to %s", user_id)
    return sent
