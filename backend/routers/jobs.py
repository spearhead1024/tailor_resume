"""Jobs CRUD."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from auth import get_current_user, require_admin, storage
from schemas import JobUpsertRequest

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
    if not payload.get("id"):
        payload["id"] = storage.make_id("job")
    payload.setdefault("created_by_user_id", user["id"])
    payload.setdefault("created_by_username", user.get("username", ""))
    storage.upsert_job(payload)
    return storage.get_job_by_id(payload["id"]) or {"id": payload["id"]}


@router.patch("/{job_id}")
def update_job(job_id: str, body: JobUpsertRequest, user: dict = Depends(get_current_user)):
    storage.update_job(job_id, body.payload)
    return storage.get_job_by_id(job_id) or {"id": job_id}


@router.delete("/{job_id}")
def delete_job(job_id: str, user: dict = Depends(require_admin)):
    storage.delete_job(job_id)
    return {"ok": True}
