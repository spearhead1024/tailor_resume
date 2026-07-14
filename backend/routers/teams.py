"""Caller teams.

A team groups callers under a manager. Admins create teams and decide who is in them; a manager
may read their own team. Membership itself lives on the user (`team_id`) and is set through the
users API — this router only owns the team records.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from auth import get_current_user, require_admin, storage, team_id_of
# detach_team(): a deleted team must not leave its name behind on the calls it was given.
from routers import interviews

router = APIRouter(prefix="/api/teams", tags=["teams"])


@router.get("")
def list_teams(user: dict = Depends(get_current_user)):
    """Admins see every team; anyone else sees only the team they belong to (or manage)."""
    teams = storage.get_teams()
    if user.get("is_admin"):
        return teams
    mine = team_id_of(user)
    return [t for t in teams if t["id"] == mine]


@router.post("")
def create_team(body: dict = Body(...), user: dict = Depends(require_admin)):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Team name is required")
    if any(t["name"].strip().lower() == name.lower() for t in storage.get_teams()):
        raise HTTPException(status_code=409, detail="A team with that name already exists")
    return storage.upsert_team({"name": name})


@router.patch("/{team_id}")
def rename_team(team_id: str, body: dict = Body(...), user: dict = Depends(require_admin)):
    if not storage.get_team(team_id):
        raise HTTPException(status_code=404, detail="Team not found")
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Team name is required")
    if any(t["id"] != team_id and t["name"].strip().lower() == name.lower() for t in storage.get_teams()):
        raise HTTPException(status_code=409, detail="A team with that name already exists")
    return storage.upsert_team({"id": team_id, "name": name})


@router.delete("/{team_id}")
def delete_team(team_id: str, user: dict = Depends(require_admin)):
    """Delete the team. Its members are kept — they just become ungrouped.

    The calls it was handed are un-teamed too: a Team cell pointing at a team that no longer exists is a
    call assigned to a phantom, and every notification for its manager and members would go silently
    nowhere. The Caller is untouched — if a person was picked, the call is still theirs."""
    team = storage.get_team(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    storage.delete_team(team_id)
    interviews.detach_team(str(team.get("name", "")))
    return {"ok": True}
