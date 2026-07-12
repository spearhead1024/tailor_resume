"""JWT auth helpers and FastAPI dependencies."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import Depends, HTTPException, status
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


def _user_roles(user: dict) -> set[str]:
    roles = user.get("roles") or []
    return {str(r).strip() for r in roles if str(r).strip()}


def has_role(user: dict, *roles: str) -> bool:
    """True if user holds ANY of the given roles."""
    user_set = _user_roles(user)
    return any(r in user_set for r in roles)


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if "admin" not in _user_roles(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user


# ── caller teams ─────────────────────────────────────────────────────────────
def is_manager(user: dict) -> bool:
    """A team manager (and not an admin — admins are handled by their own, wider rules)."""
    return "manager" in _user_roles(user) and "admin" not in _user_roles(user)


def team_id_of(user: dict) -> str:
    return str((user or {}).get("team_id", "")).strip()


def team_members(team_id: str) -> list[dict]:
    """Everyone in a team. Empty team_id matches nobody (never "all ungrouped users")."""
    tid = str(team_id or "").strip()
    if not tid:
        return []
    return [u for u in storage.get_users() if str(u.get("team_id", "")).strip() == tid]


def team_caller_names(team_id: str) -> set[str]:
    """The identities a team's callers appear under in the board's Caller cell (username + full
    name, lowercased) — the board stores a display string, not a user id."""
    out: set[str] = set()
    for u in team_members(team_id):
        if "caller" not in {str(r).strip() for r in (u.get("roles") or [])}:
            continue
        for key in ("username", "full_name"):
            v = str(u.get(key, "")).strip().lower()
            if v:
                out.add(v)
    return out


def require_role(*roles: str):
    """FastAPI dependency factory: require ANY of the listed roles."""
    def _check(user: dict = Depends(get_current_user)) -> dict:
        if not has_role(user, *roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of: {', '.join(roles)}",
            )
        return user
    return _check
