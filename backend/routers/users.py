"""User management.

Admins manage everyone. A team MANAGER manages only their own team: they may create callers (who
land in their team automatically) and approve/edit them — but never touch another team, change
anyone's role or team, or create an admin. Every one of those limits is enforced here, server-side;
the UI only mirrors them.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user, is_manager, require_admin, storage, team_id_of
from core import vps1_adapt, vps1_client
from core.storage import build_password_record
# detach_team(): a deleted team must not leave its name behind on the calls it was given.
from routers import interviews
from schemas import UserUpsertRequest

router = APIRouter(prefix="/api/users", tags=["users"])

# What a manager is allowed to set. Notably absent: roles, team_id, is_admin, parent_admin_id —
# so a manager can neither escalate a user nor move them out of (or into) their team.
_MANAGER_FIELDS = {
    "username", "full_name", "email", "password", "status",
    "timezone", "country", "telegram", "whatsapp", "discord", "force_password_change",
}


def _sanitize(u: dict) -> dict:
    return {k: v for k, v in u.items() if k not in ("password_hash", "password_salt")}


def _roles_of(u: dict) -> set[str]:
    return {str(r).strip() for r in (u.get("roles") or [])}


def _manager_may_touch(actor: dict, target: dict) -> bool:
    """A manager may only act on a plain caller inside their own team."""
    tid = team_id_of(actor)
    if not tid:
        return False
    roles = _roles_of(target)
    return (
        str(target.get("team_id", "")).strip() == tid
        and "caller" in roles
        and not roles & {"admin", "manager"}
    )


def _access(user: dict = Depends(get_current_user)) -> dict:
    """Admins and team managers may reach this router."""
    if user.get("is_admin") or is_manager(user):
        return user
    raise HTTPException(status_code=403, detail="Admin or team manager only")


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
    """Admins see everyone (local, tagged VPS_2 — plus VPS_1's users, tagged VPS_1 and read-only);
    a manager sees only their own local team."""
    users = vps1_adapt.tag_local([_sanitize(u) for u in storage.get_users()])
    if not user.get("is_admin"):
        tid = team_id_of(user)
        return [u for u in users if str(u.get("team_id", "")).strip() == tid]
    remote = [vps1_adapt.user(u) for u in vps1_client.get_users()]
    return users + remote


@router.post("")
def create_user(body: UserUpsertRequest, user: dict = Depends(_access)):
    payload = dict(body.payload)

    if not user.get("is_admin"):                      # manager: force a caller into their own team
        tid = team_id_of(user)
        if not tid:
            raise HTTPException(status_code=400, detail="You are not assigned to a team.")
        payload = {k: v for k, v in payload.items() if k in _MANAGER_FIELDS}
        payload["roles"] = ["caller"]
        payload["team_id"] = tid
        payload["is_admin"] = False

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

    if not user.get("is_admin"):                      # manager: own team's callers, safe fields only
        if not _manager_may_touch(user, target):
            raise HTTPException(status_code=403, detail="You can only manage callers in your own team.")
        payload = {k: v for k, v in payload.items() if k in _MANAGER_FIELDS}
        if not payload:
            return _sanitize(target)
    else:
        payload = _autoteam_for_manager(payload, target)   # promoted to manager → mint "<Name> team"

    storage.update_user(user_id, _apply_password(payload))
    return _sanitize(storage.get_user_by_id(user_id) or {"id": user_id})


@router.delete("/{user_id}")
def delete_user(user_id: str, user: dict = Depends(require_admin)):
    """Admin only — a manager can deactivate a caller (status), but not erase the account.

    Deleting a MANAGER takes their team with them. The team was minted for them and is named after them
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
