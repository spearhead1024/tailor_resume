"""JWT auth helpers and FastAPI dependencies."""
from __future__ import annotations

import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from core.devices import DeviceStore
from core.storage import Storage, verify_password

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# The HMAC key every session/snooze JWT is signed with. Used to be a short string hardcoded in source
# (and therefore committed to git — anyone who could read the repo could forge a valid token for any
# user) that also tripped PyJWT's InsecureKeyLengthWarning (RFC 7518 §3.2 wants >= 32 bytes for
# HS256). Generated once (48 random bytes, well over that minimum) and persisted outside git, the same
# pattern core/push.py already uses for the VAPID key. PUSH_VAPID_PRIVATE_KEY_FILE-style override via
# TR_JWT_SECRET_FILE for a deploy that wants the file to live elsewhere / survive a redeploy in a
# mounted volume. Losing this file (or it changing) invalidates every existing session — a one-time
# sign-out for everyone, not something to regenerate casually.
_JWT_SECRET_FILE = Path(os.environ.get("TR_JWT_SECRET_FILE", "").strip() or (DATA_DIR / "jwt_secret.txt"))


def _load_or_create_jwt_secret() -> str:
    try:
        existing = _JWT_SECRET_FILE.read_text(encoding="utf-8").strip()
        if len(existing) >= 32:
            return existing
    except FileNotFoundError:
        pass
    secret = secrets.token_urlsafe(48)
    _JWT_SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    _JWT_SECRET_FILE.write_text(secret, encoding="utf-8")
    return secret


JWT_SECRET = _load_or_create_jwt_secret()
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_DAYS = 30

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


def identity_taken(value: str, exclude_user_id: str = "") -> bool:
    """True if `value` is already another user's username, full name or email (case-insensitive).
    The board identifies a Caller (and a chat author) by NAME, and login accepts username OR email —
    so letting two accounts share one would let a user see/edit another caller's calls, or shadow an
    admin's email at sign-in."""
    v = str(value or "").strip().lower()
    if not v:
        return False
    for u in storage.get_users():
        if u.get("id") == exclude_user_id:
            continue
        if v in {str(u.get(k) or "").strip().lower() for k in ("username", "full_name", "email")}:
            return True
    return False


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


def token_problem(payload: dict) -> str:
    """Why a decoded JWT may NOT act as a login, or '' if it may. Shared by the REST dependency and
    the live-board WebSocket, so the two can't drift apart (the socket used to skip the session check
    and kept streaming to revoked devices)."""
    if "snz" in payload:
        # A reminder's snooze ticket is signed with the same secret but means only "re-send this
        # alarm" (routers/push.py) — it must never work as a 12-hour bearer token for the account.
        return "Invalid token"
    sid = payload.get("sid")
    if sid:
        sess = devices.get(sid)
        if not sess:
            return "Session not found"
        if sess.get("revoked"):
            return "Session revoked — please sign in again"
        # A re-login un-revokes the row but must not revive the tokens that were revoked: those were
        # minted at or before the revoke's second (iat is whole seconds; record_login waits out that
        # second so the new token's iat is strictly later).
        cutoff = sess.get("tokens_valid_after") or 0
        if cutoff and int(payload.get("iat") or 0) <= int(cutoff):
            return "Session revoked — please sign in again"
    return ""


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
    problem = token_problem(payload)
    if problem:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=problem)
    user_id = payload.get("sub")
    user = storage.get_user_by_id(user_id) if user_id else None
    if not user or user.get("status") != "approved":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or not approved")
    # (Old tokens without a session id stay valid for back-compat — they get one on next login.)
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
