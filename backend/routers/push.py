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


@router.post("/test")
def test(user: dict = Depends(get_current_user)):
    """Send a test notification to the caller's own devices (used by the Enable-notifications UI)."""
    sent = push.send_push(user["id"], {
        "title": "Notifications enabled ✅",
        "body": "You'll get interview reminders here.",
        "tag": "tailorresume-test",
        "url": "/interviews",
    })
    return {"ok": True, "sent": sent}
