"""Jobs CRUD."""
from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from auth import get_current_user, require_admin, storage
from schemas import JobUpsertRequest


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _check_duplicate(payload: dict, exclude_job_id: str = "") -> None:
    """Reject creates/updates that collide with an existing job.

    Detection order matches the legacy app:
      1. job link (URL is normalized — tracking params like utm_* are stripped)
      2. company + job_title (case-insensitive, alphanumeric-only key)

    Raises HTTPException(409) with the conflicting job's identity so the UI
    can render a helpful message.
    """
    link = (payload.get("link") or "").strip()
    if link:
        url_dup = storage.find_job_by_url(link, exclude_job_id=exclude_job_id)
        if url_dup:
            raise HTTPException(
                status_code=409,
                detail={
                    "kind": "url",
                    "message": (
                        f"This URL is already on file as "
                        f"{url_dup.get('company','')} — {url_dup.get('job_title','')}."
                    ),
                    "existing_id":      url_dup.get("id", ""),
                    "existing_company": url_dup.get("company", ""),
                    "existing_title":   url_dup.get("job_title", ""),
                },
            )

    company = (payload.get("company") or "").strip()
    title = (payload.get("job_title") or "").strip()
    if company and title:
        title_dup = storage.find_duplicate_job(company, title, exclude_job_id=exclude_job_id)
        if title_dup:
            raise HTTPException(
                status_code=409,
                detail={
                    "kind": "company_title",
                    "message": (
                        f"A job with the same company + title already exists "
                        f"({title_dup.get('company','')} — {title_dup.get('job_title','')})."
                    ),
                    "existing_id":      title_dup.get("id", ""),
                    "existing_company": title_dup.get("company", ""),
                    "existing_title":   title_dup.get("job_title", ""),
                },
            )


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs(user: dict = Depends(get_current_user)):
    return storage.get_jobs()


@router.get("/{job_id}")
def get_job(job_id: str, user: dict = Depends(get_current_user)):
    job = storage.get_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Not found")
    return job


@router.post("")
def create_job(body: JobUpsertRequest, user: dict = Depends(get_current_user)):
    payload = dict(body.payload)
    _check_duplicate(payload)
    if not payload.get("id"):
        payload["id"] = storage.make_id("job")
    payload.setdefault("created_by_user_id", user["id"])
    payload.setdefault("created_by_username", user.get("username", ""))
    now = _utcnow()
    payload.setdefault("submitted_at", now)
    if payload.get("status") == "approved":
        payload.setdefault("approved_at", now)
        payload.setdefault("approved_by_user_id", user["id"])
        payload.setdefault("approved_by_username", user.get("username", ""))
    storage.upsert_job(payload)
    return storage.get_job_by_id(payload["id"]) or {"id": payload["id"]}


@router.patch("/{job_id}")
def update_job(job_id: str, body: JobUpsertRequest, user: dict = Depends(get_current_user)):
    patch = dict(body.payload)
    # When the edit touches a duplicate-relevant field, check against the
    # rest of the table (but allow the row to keep its own values).
    if any(k in patch for k in ("link", "company", "job_title")):
        merged = dict(storage.get_job_by_id(job_id) or {})
        merged.update(patch)
        _check_duplicate(merged, exclude_job_id=job_id)
    if patch.get("status") == "approved":
        patch.setdefault("approved_at", _utcnow())
        patch.setdefault("approved_by_user_id", user["id"])
        patch.setdefault("approved_by_username", user.get("username", ""))
    # Any manual status change locks the job so job-sync never overwrites it.
    if "status" in patch:
        patch["sync_locked"] = True
    storage.update_job(job_id, patch)
    return storage.get_job_by_id(job_id) or {"id": job_id}


@router.delete("/{job_id}")
def delete_job(job_id: str, user: dict = Depends(require_admin)):
    storage.delete_job(job_id)
    return {"ok": True}
