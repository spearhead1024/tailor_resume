"""To-Do endpoints.

Admin role
    Returns every approved job for the requested profile, each tagged with
    ``processing_status`` ∈ {pending, generated, skipped}. The frontend filters
    client-side so admins can see / change status of any job.

Bidder role
    Returns saved resumes pending application for the requested profile.

Mutations
    POST /api/todo/skip   — bulk skip (profile, job) pairs
    POST /api/todo/reset  — bulk reset (profile, job) pairs back to "pending"
                            by deleting the matching generated_resume rows
"""
from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user, storage

router = APIRouter(prefix="/api/todo", tags=["todo"])


def _regions_match(job_region: str, profile_region: str) -> bool:
    """A job is relevant to a profile when either side is ANY, or they match."""
    return "ANY" in (job_region, profile_region) or job_region == profile_region


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _profile_or_403(user: dict, profile_id: str) -> dict:
    if not profile_id:
        raise HTTPException(status_code=400, detail="profile_id required")
    profile = next((p for p in storage.get_profiles() if p.get("id") == profile_id), None)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    if not user.get("is_admin"):
        if profile_id not in (user.get("assigned_profile_ids") or []):
            raise HTTPException(status_code=403, detail="Forbidden")
    return profile


def _resume_status_index(profile_id: str) -> dict[str, dict]:
    """Map job_id → most recent generated_resume row for this profile."""
    by_job: dict[str, dict] = {}
    for r in storage.get_generated_resumes():
        if r.get("profile_id") != profile_id:
            continue
        jid = r.get("job_id") or ""
        if not jid:
            continue
        existing = by_job.get(jid)
        if not existing or (r.get("created_at") or "") > (existing.get("created_at") or ""):
            by_job[jid] = r
    return by_job


@router.get("")
def get_todo(profile_id: str = "", user: dict = Depends(get_current_user)):
    is_admin = bool(user.get("is_admin"))
    role = "admin" if is_admin else "bidder"

    profiles = storage.get_profiles()
    if not is_admin:
        allowed = set(user.get("assigned_profile_ids") or [])
        profiles = [p for p in profiles if p.get("id") in allowed]

    if not profile_id:
        # Decorate each profile with a role-appropriate `pending_count`:
        #   • admin:  approved jobs not yet generated/skipped for the profile
        #   • bidder: generated resumes for the profile not yet marked applied
        decorated: list[dict] = []
        if is_admin:
            approved_jobs = [
                j for j in storage.get_jobs()
                if j.get("status") == "approved"
                and not j.get("flagged")
                and not j.get("admin_applied")
            ]
            processed_by_profile: dict[str, set[str]] = {}
            for r in storage.get_generated_resumes():
                pid = r.get("profile_id") or ""
                jid = r.get("job_id") or ""
                if pid and jid and r.get("status") in ("generated", "skipped"):
                    processed_by_profile.setdefault(pid, set()).add(jid)
            for p in profiles:
                p_region = str(p.get("region") or "ANY").upper()
                matched_ids = {
                    j["id"] for j in approved_jobs
                    if _regions_match(str(j.get("region") or "ANY").upper(), p_region)
                }
                processed = processed_by_profile.get(p.get("id", ""), set())
                decorated.append({**p, "pending_count": len(matched_ids - processed)})
        else:
            pending_by_profile: dict[str, int] = {}
            for r in storage.get_generated_resumes():
                if r.get("status") != "generated":
                    continue
                if r.get("applied_status") == "applied":
                    continue
                pid = r.get("profile_id") or ""
                if pid:
                    pending_by_profile[pid] = pending_by_profile.get(pid, 0) + 1
            for p in profiles:
                decorated.append({**p, "pending_count": pending_by_profile.get(p.get("id", ""), 0)})
        return {"role": role, "profiles": decorated}

    _profile_or_403(user, profile_id)

    if is_admin:
        profile = next((p for p in profiles if p.get("id") == profile_id), {})
        p_region = str(profile.get("region") or "ANY").upper()
        index = _resume_status_index(profile_id)
        result = []
        for job in storage.get_jobs():
            if job.get("status") != "approved":
                continue
            if job.get("flagged") or job.get("admin_applied"):
                continue
            if not _regions_match(str(job.get("region") or "ANY").upper(), p_region):
                continue
            jid = job.get("id", "")
            record = index.get(jid)
            if record:
                proc_status = record.get("status") or "generated"
                saved_resume_id = record.get("saved_resume_id", "")
            else:
                proc_status = "pending"
                saved_resume_id = ""
            result.append({
                **job,
                "processing_status": proc_status,
                "saved_resume_id": saved_resume_id,
            })
        result.sort(key=lambda j: j.get("submitted_at") or "", reverse=True)
        return {"role": role, "profiles": profiles, "jobs": result}

    # Bidder — return all generated resumes for this profile (pending + applied).
    # Frontend chip-filters by applied_status.
    resumes = [
        r for r in storage.get_generated_resumes()
        if r.get("profile_id") == profile_id
        and r.get("status") == "generated"
    ]
    # Sort: pending first (urgent), then applied; within each group newest first.
    # Python's sort is stable — apply secondary key first, then primary.
    resumes.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    resumes.sort(key=lambda r: 1 if r.get("applied_status") == "applied" else 0)
    return {"role": role, "profiles": profiles, "resumes": resumes}


# ── Mutations ───────────────────────────────────────────────────────────────

class JobIdsRequest(BaseModel):
    profile_id: str
    job_ids: list[str]


@router.post("/skip")
def skip_jobs(body: JobIdsRequest, user: dict = Depends(get_current_user)):
    _profile_or_403(user, body.profile_id)
    # Reset any existing record first so a single (profile, job) pair stays unique
    if hasattr(storage, "delete_generated_resumes_for"):
        storage.delete_generated_resumes_for(body.profile_id, body.job_ids)
    now = _utcnow()
    skipped = 0
    for jid in body.job_ids:
        jid = (jid or "").strip()
        if not jid:
            continue
        job = storage.get_job_by_id(jid)
        if not job:
            continue
        storage.save_generated_resume({
            "profile_id": body.profile_id,
            "job_id": jid,
            "job_company": job.get("company", ""),
            "job_title": job.get("job_title", ""),
            "job_link": job.get("link", ""),
            "status": "skipped",
            "applied_status": "pending",
            "created_at": now,
            "created_by_user_id": user.get("id", ""),
            "created_by_username": user.get("username", ""),
        })
        skipped += 1
    return {"skipped": skipped}


@router.post("/reset")
def reset_jobs(body: JobIdsRequest, user: dict = Depends(get_current_user)):
    """Delete any generated/skipped records for (profile_id, job_ids), so
    those jobs return to 'pending' status."""
    _profile_or_403(user, body.profile_id)
    if not hasattr(storage, "delete_generated_resumes_for"):
        return {"reset": 0}
    deleted = storage.delete_generated_resumes_for(body.profile_id, body.job_ids)
    return {"reset": deleted}
