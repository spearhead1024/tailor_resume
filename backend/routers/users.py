"""User management — ADMIN ONLY.

Accounts are an admin's business: creating them, setting roles, approving, deleting. A team manager
runs their team's CALLS (see routers/interviews.py), not the accounts behind them, and reaches none of
this. Enforced server-side in _access; hiding the tab in the UI is only a courtesy on top.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user, require_admin, storage
from core import vps1_adapt
from core.storage import build_password_record
# detach_team(): a deleted team must not leave its name behind on the calls it was given.
from routers import interviews
from schemas import UserUpsertRequest

router = APIRouter(prefix="/api/users", tags=["users"])

def _sanitize(u: dict) -> dict:
    return {k: v for k, v in u.items() if k not in ("password_hash", "password_salt")}


def _roles_of(u: dict) -> set[str]:
    return {str(r).strip() for r in (u.get("roles") or [])}


def _access(user: dict = Depends(get_current_user)) -> dict:
    """Admin only. Accounts are an admin's business — creating them, setting roles, approving,
    deleting. A team manager runs their team's CALLS (routers/interviews.py), not the accounts behind
    them. Enforced here rather than by hiding the tab: the tab is a courtesy, this is the door."""
    if user.get("is_admin"):
        return user
    raise HTTPException(status_code=403, detail="Admin only")


def _apply_password(payload: dict) -> dict:
    pw_plain = payload.pop("password", None)
    if pw_plain:
        pw = build_password_record(pw_plain)
        payload["password_hash"] = pw["password_hash"]
        payload["password_salt"] = pw["password_salt"]
    return payload


def _autoteam_for_manager(payload: dict, existing: dict | None = None) -> dict:
    """Give a brand-new manager a team of their own, named after them ("Hamna" → "Hamna team").

    A manager is useless without a team — they'd see an empty board and be unable to add callers —
    so rather than make the admin create one by hand, we mint it here. Only ever fills a BLANK team:
    an explicit team_id, or a manager who already has one, is left exactly as-is. If a team with that
    name already exists we reuse it instead of creating a duplicate.
    """
    roles = {str(r).strip() for r in (payload.get("roles") or (existing or {}).get("roles") or [])}
    if "manager" not in roles or "admin" in roles:
        return payload
    # respect whatever team was explicitly asked for, or one the user already has
    if str(payload.get("team_id", "")).strip() or str((existing or {}).get("team_id", "")).strip():
        return payload

    label = (str(payload.get("full_name", "")).strip()
             or str((existing or {}).get("full_name", "")).strip()
             or str(payload.get("username", "")).strip()
             or str((existing or {}).get("username", "")).strip())
    if not label:
        return payload
    name = f"{label} team"
    match = next((t for t in storage.get_teams() if t["name"].strip().lower() == name.lower()), None)
    team = match or storage.upsert_team({"name": name})
    payload["team_id"] = team["id"]
    return payload


@router.get("")
def list_users(user: dict = Depends(_access)):
    """Every user: this server's own (tagged VPS_2) plus VPS_1's mirrored ones (tagged VPS_1,
    read-only). Admin-only — see _access."""
    users = vps1_adapt.tag_local([_sanitize(u) for u in storage.get_users()])
    # VPS_1 users come from the local hourly mirror (core/vps1_sync.py) — a fast DB read.
    remote = [vps1_adapt.user(u) for u in storage.get_vps1_users()]
    return users + remote


@router.post("")
def create_user(body: UserUpsertRequest, user: dict = Depends(require_admin)):
    """Admin only. A manager still reaches this router to see and edit their own team (see _access),
    but bringing a NEW account into existence is an admin's call — so the New-user button is hidden
    for them in the UI and the door is shut here, which is the half that actually counts."""
    payload = dict(body.payload)

    if not payload.get("id"):
        payload["id"] = storage.make_id("user")
    username = str(payload.get("username", "")).strip().lower()
    if username and storage.get_user_by_username(username):
        raise HTTPException(status_code=409, detail="Username taken")

    payload = _autoteam_for_manager(payload)          # new manager → mint "<Name> team"
    storage.upsert_user(_apply_password(payload))
    return _sanitize(storage.get_user_by_id(payload["id"]) or {"id": payload["id"]})


@router.patch("/{user_id}")
def update_user(user_id: str, body: UserUpsertRequest, user: dict = Depends(_access)):
    payload = dict(body.payload)
    target = storage.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    payload = _autoteam_for_manager(payload, target)   # promoted to manager → mint "<Name> team"

    storage.update_user(user_id, _apply_password(payload))
    return _sanitize(storage.get_user_by_id(user_id) or {"id": user_id})


@router.delete("/{user_id}")
def delete_user(user_id: str, user: dict = Depends(require_admin)):
    """Deleting a MANAGER takes their team with them. The team was minted for them and is named after them
    ("Hamna" → "Hamna team", see _autoteam_for_manager), so leaving it behind orphans a team with no
    Hamna in it — nobody runs it, yet it keeps appearing in every Caller dropdown and can still be
    assigned calls that will never reach a manager.

    Two things it does NOT do:
      • delete the members — storage.delete_team un-groups them, it never erases anyone.
      • delete a team somebody else still runs — if another manager is on it, the team stays.
    """
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    victim = storage.get_user_by_id(user_id) or {}
    roles = {str(r).strip() for r in (victim.get("roles") or [])}
    tid = str(victim.get("team_id", "")).strip()
    team = storage.get_team(tid) if tid else None

    storage.delete_user(user_id)

    if "manager" in roles and team:
        still_run = any(
            str(u.get("team_id", "")).strip() == tid
            and "manager" in {str(r).strip() for r in (u.get("roles") or [])}
            for u in storage.get_users()
        )
        if not still_run:
            storage.delete_team(tid)                       # un-groups the members; deletes nobody
            interviews.detach_team(str(team.get("name", "")))   # and strips the dead name off its calls
    return {"ok": True}
