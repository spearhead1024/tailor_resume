"""Auth endpoints: login, register, me, change password."""
from __future__ import annotations

import re
from datetime import datetime
from fastapi import APIRouter, Body, Depends, HTTPException, Request, status

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


# ─── Keyboard-shortcut bindings (Chrome extension card) ──────────────────────
# Single source of truth: the web "Help → Shortcuts" tab renders this catalog;
# the extension fetches the effective bindings and applies them. Modifier is
# always Alt; each action maps to one key in [a-z0-9], all keys unique.
SHORTCUT_CATALOG = [
    {"id": "toggle",     "label": "Show / hide the bar", "default": "a", "group": "Bar"},
    {"id": "download",   "label": "Download resume",     "default": "d", "group": "Actions"},
    {"id": "report",     "label": "Report job",          "default": "r", "group": "Actions"},
    {"id": "screenshot", "label": "Screenshot page",     "default": "s", "group": "Actions"},
    {"id": "first",      "label": "First name",          "default": "f", "group": "Copy / paste"},
    {"id": "last",       "label": "Last name",           "default": "l", "group": "Copy / paste"},
    {"id": "full",       "label": "Full name",           "default": "n", "group": "Copy / paste"},
    {"id": "email",      "label": "Email",               "default": "e", "group": "Copy / paste"},
    {"id": "phone",      "label": "Phone",               "default": "p", "group": "Copy / paste"},
    {"id": "location",   "label": "Location",            "default": "o", "group": "Copy / paste"},
    {"id": "address",    "label": "Address",             "default": "b", "group": "Copy / paste"},
    {"id": "zip",        "label": "Zip code",            "default": "z", "group": "Copy / paste"},
    {"id": "linkedin",   "label": "LinkedIn",            "default": "i", "group": "Copy / paste"},
    {"id": "github",     "label": "Github",              "default": "g", "group": "Copy / paste"},
    {"id": "portfolio",  "label": "Portfolio",           "default": "t", "group": "Copy / paste"},
    {"id": "university", "label": "University history",   "default": "u", "group": "Copy / paste"},
    {"id": "exp1",       "label": "Experience 1",        "default": "1", "group": "Copy / paste"},
    {"id": "exp2",       "label": "Experience 2",        "default": "2", "group": "Copy / paste"},
    {"id": "exp3",       "label": "Experience 3",        "default": "3", "group": "Copy / paste"},
    {"id": "exp4",       "label": "Experience 4",        "default": "4", "group": "Copy / paste"},
]
SHORTCUT_DEFAULTS = {a["id"]: a["default"] for a in SHORTCUT_CATALOG}
_VALID_KEY = re.compile(r"^[a-z0-9]$")


def _effective_bindings(user: dict) -> dict:
    """Stored overrides merged over defaults → the full effective map."""
    stored = user.get("shortcuts") or {}
    merged = dict(SHORTCUT_DEFAULTS)
    for action, key in stored.items():
        if action in SHORTCUT_DEFAULTS and isinstance(key, str) and _VALID_KEY.match(key):
            merged[action] = key
    return merged


@router.get("/shortcuts")
def get_shortcuts(user: dict = Depends(get_current_user)):
    """Effective bindings for this user + the catalog (for the Help UI)."""
    return {"bindings": _effective_bindings(user), "catalog": SHORTCUT_CATALOG}


@router.put("/shortcuts")
def put_shortcuts(body: dict = Body(...), user: dict = Depends(get_current_user)):
    """Save this user's bindings. Validates: known actions, single [a-z0-9] keys,
    no duplicates. The client sends the full effective map under `bindings`."""
    raw = body.get("bindings") if isinstance(body, dict) else None
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="Expected { bindings: { action: key } }")

    cleaned: dict[str, str] = {}
    for action, key in raw.items():
        if action not in SHORTCUT_DEFAULTS:
            raise HTTPException(status_code=400, detail=f"Unknown action: {action}")
        key = str(key or "").lower()
        if not _VALID_KEY.match(key):
            raise HTTPException(status_code=400, detail=f"'{action}' must be a single letter or digit (got '{key}').")
        cleaned[action] = key

    # Fill any actions the client omitted with their defaults, then check dupes.
    full = dict(SHORTCUT_DEFAULTS) | cleaned
    seen: dict[str, str] = {}
    for action, key in full.items():
        if key in seen:
            raise HTTPException(
                status_code=400,
                detail=f"Key '{key}' is used by both '{seen[key]}' and '{action}'. Each shortcut needs a unique key.",
            )
        seen[key] = action

    storage.update_user(user["id"], {"shortcuts": full})
    return {"ok": True, "bindings": full}


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
