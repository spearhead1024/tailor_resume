"""Device session management — admin-only.

Endpoints:
  GET    /api/devices            — list all device sessions across all users
  GET    /api/devices/user/{uid} — list sessions for one user
  POST   /api/devices/{sid}/revoke — kick out a device (forces re-login)
  DELETE /api/devices/{sid}      — delete a session row entirely
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from auth import devices, require_admin, storage

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _enrich(rows: list[dict]) -> list[dict]:
    """Attach username + full_name for display."""
    users_by_id = {u["id"]: u for u in storage.get_users()}
    out: list[dict] = []
    for r in rows:
        u = users_by_id.get(r.get("user_id", ""), {})
        out.append({
            **r,
            "username": u.get("username", ""),
            "full_name": u.get("full_name", ""),
            "is_admin": bool(u.get("is_admin")),
        })
    return out


@router.get("")
def list_devices(_admin: dict = Depends(require_admin)):
    return _enrich(devices.list_all())


@router.get("/user/{user_id}")
def list_user_devices(user_id: str, _admin: dict = Depends(require_admin)):
    return _enrich(devices.list_for_user(user_id))


@router.post("/{session_id}/revoke")
def revoke_device(session_id: str, _admin: dict = Depends(require_admin)):
    if not devices.revoke(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.delete("/{session_id}")
def delete_device(session_id: str, _admin: dict = Depends(require_admin)):
    if not devices.delete(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}
