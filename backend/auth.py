"""JWT auth helpers and FastAPI dependencies."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from core.devices import DeviceStore
from core.storage import Storage, verify_password

JWT_SECRET = "TAILORRESUME_JWT_SECRET_2026"
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_DAYS = 30

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
storage = Storage(DATA_DIR)
devices = DeviceStore(DATA_DIR / "app.db")

bearer_scheme = HTTPBearer(auto_error=False)


def create_jwt(user_id: str, session_id: str = "") -> str:
    payload = {
        "sub": user_id,
        "sid": session_id,
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": int((datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRES_DAYS)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


def authenticate_user(identifier: str, password: str) -> dict | None:
    needle = (identifier or "").strip().lower()
    if not needle:
        return None
    user = storage.get_user_by_username(needle)
    if not user:
        for u in storage.get_users():
            if str(u.get("email", "")).strip().lower() == needle:
                user = u
                break
    if not user:
        return None
    if not verify_password(password, user.get("password_salt", ""), user.get("password_hash", "")):
        return None
    return user


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_jwt(credentials.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user_id = payload.get("sub")
    user = storage.get_user_by_id(user_id) if user_id else None
    if not user or user.get("status") != "approved":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or not approved")
    # If the JWT carries a session id, that session must still be active.
    # (Old tokens without sid stay valid for back-compat — they'll get an sid
    # on next login.)
    sid = payload.get("sid")
    if sid:
        sess = devices.get(sid)
        if not sess:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session not found")
        if sess.get("revoked"):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked — please sign in again")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user
