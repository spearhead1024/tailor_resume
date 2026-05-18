"""Admin users management."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from auth import get_current_user, require_admin, storage
from core.storage import build_password_record
from schemas import UserUpsertRequest

router = APIRouter(prefix="/api/users", tags=["users"])


def _sanitize(u: dict) -> dict:
    return {k: v for k, v in u.items() if k not in ("password_hash", "password_salt")}


@router.get("")
def list_users(user: dict = Depends(require_admin)):
    return [_sanitize(u) for u in storage.get_users()]


@router.post("")
def create_user(body: UserUpsertRequest, user: dict = Depends(require_admin)):
    payload = dict(body.payload)
    if not payload.get("id"):
        payload["id"] = storage.make_id("user")
    pw_plain = payload.pop("password", None)
    if pw_plain:
        pw = build_password_record(pw_plain)
        payload["password_hash"] = pw["password_hash"]
        payload["password_salt"] = pw["password_salt"]
    storage.upsert_user(payload)
    return _sanitize(storage.get_user_by_id(payload["id"]) or {"id": payload["id"]})


@router.patch("/{user_id}")
def update_user(user_id: str, body: UserUpsertRequest, user: dict = Depends(require_admin)):
    payload = dict(body.payload)
    pw_plain = payload.pop("password", None)
    if pw_plain:
        pw = build_password_record(pw_plain)
        payload["password_hash"] = pw["password_hash"]
        payload["password_salt"] = pw["password_salt"]
    storage.update_user(user_id, payload)
    return _sanitize(storage.get_user_by_id(user_id) or {"id": user_id})


@router.delete("/{user_id}")
def delete_user(user_id: str, user: dict = Depends(require_admin)):
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    storage.delete_user(user_id)
    return {"ok": True}
