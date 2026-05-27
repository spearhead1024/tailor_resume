"""Auth endpoints: login, register, me, change password."""
from __future__ import annotations

import re
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request, status

from auth import (
    authenticate_user,
    create_jwt,
    devices,
    get_current_user,
    storage,
)
from core.devices import is_mobile_or_tablet, parse_user_agent
from core.storage import build_password_record
from schemas import (
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
)


def _client_ip(request: Request) -> str:
    # Trust X-Forwarded-For from the reverse proxy (nginx → uvicorn).
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _password_policy_error(password: str) -> str:
    value = str(password or "")
    if len(value) < 10:
        return "Use at least 10 characters."
    if not re.search(r"[A-Za-z]", value) or not re.search(r"\d", value):
        return "Include at least one letter and one number."
    return ""


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request):
    ua = request.headers.get("user-agent", "")

    # Block mobile + tablet logins outright. Admins log in from desktop only.
    if is_mobile_or_tablet(ua):
        info = parse_user_agent(ua)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Mobile and tablet devices are not allowed ({info['device_type']}). "
                f"Please sign in from a desktop browser."
            ),
        )

    user = authenticate_user(body.identifier, body.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if user.get("status") != "approved":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account pending approval")

    # Record (or refresh) the device session for this user.
    session = devices.record_login(user["id"], ua, _client_ip(request))
    token = create_jwt(user["id"], session_id=session.get("id", ""))
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
