"""Device session tracking — fingerprinting, mobile detection, audit log.

Mobile / tablet User-Agents are blocked at login. Every successful login
creates (or updates) a DeviceSessionRow keyed by (user_id, fingerprint).
The JWT carries the session id so admins can revoke a single device
without rotating the whole user's password.

Note: User-Agent is trivially spoofable. This is a soft block / audit
trail, not a security boundary.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from user_agents import parse as ua_parse  # type: ignore[import-untyped]

from .db import session_scope
from .db.models import DeviceSessionRow


_FINGERPRINT_SALT = "TAILORRESUME_DEVICE_FP_V1"


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_user_agent(ua_string: str) -> dict:
    """Return {browser, os, device_type, is_mobile, is_tablet, is_pc, raw}."""
    raw = (ua_string or "").strip()
    if not raw:
        return {
            "browser": "Unknown", "os": "Unknown", "device_type": "unknown",
            "is_mobile": False, "is_tablet": False, "is_pc": False, "raw": "",
        }
    parsed = ua_parse(raw)
    browser = f"{parsed.browser.family} {parsed.browser.version_string}".strip()
    os_name = f"{parsed.os.family} {parsed.os.version_string}".strip()
    if parsed.is_mobile:
        device_type = "mobile"
    elif parsed.is_tablet:
        device_type = "tablet"
    elif parsed.is_pc:
        device_type = "desktop"
    elif parsed.is_bot:
        device_type = "bot"
    else:
        device_type = "other"
    return {
        "browser": browser or "Unknown",
        "os": os_name or "Unknown",
        "device_type": device_type,
        "is_mobile": bool(parsed.is_mobile),
        "is_tablet": bool(parsed.is_tablet),
        "is_pc": bool(parsed.is_pc),
        "raw": raw,
    }


def is_mobile_or_tablet(ua_string: str) -> bool:
    info = parse_user_agent(ua_string)
    return info["is_mobile"] or info["is_tablet"]


def fingerprint(user_id: str, ua_string: str) -> str:
    """Stable hash of (user, browser-family, os-family) so the same browser
    on the same device collapses to a single row across logins.

    We deliberately ignore version numbers + IP so browser updates and
    DHCP renewals don't create duplicate sessions.
    """
    info = parse_user_agent(ua_string)
    parsed = ua_parse(ua_string or "")
    key = "|".join([
        _FINGERPRINT_SALT,
        user_id or "",
        parsed.browser.family or "",
        parsed.os.family or "",
        info["device_type"],
    ])
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

class DeviceStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def record_login(self, user_id: str, ua_string: str, ip: str) -> dict:
        """Insert-or-update a device session for this user+fingerprint.
        Returns the row as a dict (always — bumps login_count + last_seen)."""
        info = parse_user_agent(ua_string)
        fp = fingerprint(user_id, ua_string)
        now = datetime.utcnow()
        with session_scope(self.db_path) as session:
            stmt = select(DeviceSessionRow).where(
                DeviceSessionRow.user_id == user_id,
                DeviceSessionRow.fingerprint == fp,
            )
            row = session.execute(stmt).scalar_one_or_none()
            if row is None:
                row = DeviceSessionRow(
                    id=f"dev_{uuid.uuid4().hex[:12]}",
                    user_id=user_id,
                    fingerprint=fp,
                    user_agent=(ua_string or "")[:500],
                    browser=info["browser"][:64],
                    os=info["os"][:64],
                    device_type=info["device_type"],
                    ip=(ip or "")[:64],
                    login_count=1,
                    first_seen=now,
                    last_seen=now,
                    revoked=False,
                )
                session.add(row)
            else:
                row.login_count = (row.login_count or 0) + 1
                row.last_seen = now
                row.ip = (ip or "")[:64]
                row.user_agent = (ua_string or "")[:500]
                # If admin previously revoked this device, fresh login un-revokes
                # (admin can revoke again to kick out).
                row.revoked = False
                row.revoked_at = None
            session.flush()
            return _row_to_dict(row)

    def get(self, session_id: str) -> dict | None:
        with session_scope(self.db_path) as session:
            row = session.get(DeviceSessionRow, session_id)
            return _row_to_dict(row) if row else None

    def list_all(self) -> list[dict]:
        with session_scope(self.db_path) as session:
            stmt = select(DeviceSessionRow).order_by(DeviceSessionRow.last_seen.desc())
            return [_row_to_dict(r) for r in session.execute(stmt).scalars().all()]

    def list_for_user(self, user_id: str) -> list[dict]:
        with session_scope(self.db_path) as session:
            stmt = (
                select(DeviceSessionRow)
                .where(DeviceSessionRow.user_id == user_id)
                .order_by(DeviceSessionRow.last_seen.desc())
            )
            return [_row_to_dict(r) for r in session.execute(stmt).scalars().all()]

    def revoke(self, session_id: str) -> bool:
        with session_scope(self.db_path) as session:
            row = session.get(DeviceSessionRow, session_id)
            if not row:
                return False
            row.revoked = True
            row.revoked_at = datetime.utcnow()
            return True

    def delete(self, session_id: str) -> bool:
        with session_scope(self.db_path) as session:
            row = session.get(DeviceSessionRow, session_id)
            if not row:
                return False
            session.delete(row)
            return True


def _row_to_dict(row: DeviceSessionRow | None) -> dict:
    if row is None:
        return {}
    return {
        "id": row.id,
        "user_id": row.user_id,
        "fingerprint": row.fingerprint,
        "user_agent": row.user_agent or "",
        "browser": row.browser or "",
        "os": row.os or "",
        "device_type": row.device_type or "desktop",
        "ip": row.ip or "",
        "login_count": row.login_count or 0,
        "first_seen": _iso(row.first_seen),
        "last_seen": _iso(row.last_seen),
        "revoked": bool(row.revoked),
        "revoked_at": _iso(row.revoked_at) if row.revoked_at else "",
    }


def _iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()
