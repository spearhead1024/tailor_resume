"""To-Do dashboard: jobs that need attention for the current user.

Returns approved jobs the user has access to, minus jobs they've already
generated/saved a resume for (per assigned profile).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from auth import get_current_user, storage

router = APIRouter(prefix="/api/todo", tags=["todo"])


@router.get("")
def get_todo(user: dict = Depends(get_current_user)):
    jobs = [j for j in storage.get_jobs() if j.get("status") == "approved"]
    profiles = storage.get_profiles()
    if not user.get("is_admin"):
        allowed = set(user.get("assigned_profile_ids") or [])
        profiles = [p for p in profiles if p.get("id") in allowed]
    profile_ids = {p["id"] for p in profiles}

    applied: dict[str, set[str]] = {}
    for r in storage.get_generated_resumes():
        jid = r.get("job_id", "")
        pid = r.get("profile_id", "")
        if jid and pid:
            applied.setdefault(jid, set()).add(pid)

    todo_items = []
    for job in jobs:
        if job.get("admin_applied"):
            continue
        applied_pids = applied.get(job["id"], set())
        remaining = [p for p in profiles if p["id"] not in applied_pids]
        if remaining or user.get("is_admin"):
            todo_items.append({
                "job": job,
                "remaining_profile_ids": [p["id"] for p in remaining],
            })
    return {"items": todo_items, "profiles": profiles}
