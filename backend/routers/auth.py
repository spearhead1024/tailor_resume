"""Auth endpoints: login, register, me, change password."""
from __future__ import annotations

import re
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status

from auth import (
    authenticate_user,
    create_jwt,
    get_current_user,
    storage,
)
from core.storage import build_password_record
from schemas import (
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _password_policy_error(password: str) -> str:
    value = str(password or "")
    if len(value) < 10:
        return "Use at least 10 characters."
    if not re.search(r"[A-Za-z]", value) or not re.search(r"\d", value):
        return "Include at least one letter and one number."
    return ""


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest):
    user = authenticate_user(body.identifier, body.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if user.get("status") != "approved":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account pending approval")
    token = create_jwt(user["id"])
    sanitized = {k: v for k, v in user.items() if k not in ("password_hash", "password_salt")}
    return LoginResponse(token=token, user=sanitized)


@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return {k: v for k, v in user.items() if k not in ("password_hash", "password_salt")}


@router.post("/register")
def register(body: RegisterRequest):
    full_name = body.full_name.strip()
    email = body.email.strip()
    username = body.username.strip().lower()
    password = body.password
    if not all([full_name, email, username, password]):
        raise HTTPException(status_code=400, detail="All fields required")
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(status_code=400, detail="Invalid email")
    err = _password_policy_error(password)
    if err:
        raise HTTPException(status_code=400, detail=err)
    if storage.get_user_by_username(username):
        raise HTTPException(status_code=409, detail="Username taken")
    for u in storage.get_users():
        if str(u.get("email", "")).strip().lower() == email.lower():
            raise HTTPException(status_code=409, detail="Email in use")
    pw = build_password_record(password)
    storage.upsert_user({
        "id": storage.make_id("user"),
        "username": username,
        "full_name": full_name,
        "email": email,
        "password_hash": pw["password_hash"],
        "password_salt": pw["password_salt"],
        "is_admin": False,
        "status": "pending",
        "assigned_profile_ids": [],
        "created_at": datetime.utcnow().isoformat() + "Z",
    })
    return {"ok": True}


@router.post("/change-password")
def change_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    err = _password_policy_error(body.new_password)
    if err:
        raise HTTPException(status_code=400, detail=err)
    pw = build_password_record(body.new_password)
    storage.update_user(user["id"], pw | {"force_password_change": False})
    return {"ok": True}
