"""Web Push endpoints: hand out the VAPID public key, register/unregister a browser
subscription for the signed-in user, and fire a test notification."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from auth import get_current_user
from core import push

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/vapid-public-key")
def vapid_public_key():
    """Public — the browser needs this (applicationServerKey) before it can subscribe."""
    return {"key": push.public_key_b64()}


@router.post("/subscribe")
def subscribe(body: dict = Body(...), user: dict = Depends(get_current_user)):
    sub = (body or {}).get("subscription") or body
    if not isinstance(sub, dict) or not str(sub.get("endpoint", "")).strip():
        raise HTTPException(status_code=400, detail="Missing push subscription")
    push.add_subscription(user["id"], sub)
    return {"ok": True}


@router.post("/unsubscribe")
def unsubscribe(body: dict = Body(default={}), user: dict = Depends(get_current_user)):
    endpoint = str((body or {}).get("endpoint", "")).strip()
    if endpoint:
        push.remove_subscription(user["id"], endpoint)
    return {"ok": True}


@router.get("/status")
def status(user: dict = Depends(get_current_user)):
    return {"subscribed": push.has_subscription(user["id"])}


@router.post("/snooze")
def snooze(body: dict = Body(...)):
    """Re-fire an alarm in N minutes — the Snooze button on an interview reminder.

    Deliberately NOT behind the normal auth dependency: this is called from the service worker, which
    has no access to the app's JWT and may run with no tab open at all. It authenticates instead with
    the single-purpose ticket the server itself put inside that alarm, so it can only ever re-send
    that same reminder to that same person.
    """
    import jwt

    from auth import JWT_ALGORITHM, JWT_SECRET
    from core import notify

    token = str((body or {}).get("token", ""))
    minutes = (body or {}).get("minutes", 5)
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired snooze ticket")

    user_id = str(data.get("sub", ""))
    payload = data.get("snz")
    if not user_id or not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Malformed snooze ticket")

    notify.snooze_add(user_id, payload, minutes)
    return {"ok": True, "minutes": min(max(int(minutes or 5), 1), 120)}


@router.post("/test")
def test(user: dict = Depends(get_current_user)):
    """Send a test notification to the caller's own devices (used by the Enable-notifications UI)."""
    sent = push.send_push(user["id"], {
        "title": "Notifications enabled ✅",
        "body": "You'll get interview reminders here.",
        "tag": "tailorresume-test",
        "url": "/interviews",
        "alarm": True,        # rings, so you can actually hear what a real reminder will sound like
    })
    return {"ok": True, "sent": sent}
