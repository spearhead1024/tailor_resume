"""Resume generation, update, save, export."""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import Response

from auth import get_current_user, storage
from core.resume_engine import (
    analyze_ats_score,
    generate_application_answers,
    generate_resume_content,
    update_resume_content,
)
from core.docx_resume_export import build_docx_style_pdf_bundle
from schemas import (
    GenerateAnswersRequest,
    GenerateResumeRequest,
    SaveResumeRequest,
    UpdateResumeRequest,
)

router = APIRouter(prefix="/api/resumes", tags=["resumes"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
PDF_CACHE_DIR = DATA_DIR / "pdf_cache"
PDF_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _get_profile(profile_id: str) -> dict:
    for p in storage.get_profiles():
        if p.get("id") == profile_id:
            return p
    raise HTTPException(status_code=404, detail="Profile not found")


def _check_profile_access(user: dict, profile_id: str) -> None:
    if user.get("is_admin"):
        return
    if profile_id not in (user.get("assigned_profile_ids") or []):
        raise HTTPException(status_code=403, detail="Forbidden")


def _resume_hash(resume: dict, profile_id: str) -> str:
    payload = json.dumps({"p": profile_id, "r": resume}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _render_pdf_to_cache(saved_resume_id: str) -> Path | None:
    """Render the PDF for a saved resume and write to the id-keyed cache file.

    Returns the cache file path on success, else None. Safe to call repeatedly
    — short-circuits when the cache file already exists with content.
    """
    sid = (saved_resume_id or "").strip()
    if not sid:
        return None
    cache_file = PDF_CACHE_DIR / f"{sid}.pdf"
    if cache_file.exists() and cache_file.stat().st_size > 0:
        return cache_file
    record = storage.get_generated_resume_by_id(sid) if hasattr(storage, "get_generated_resume_by_id") else None
    if not record:
        return None
    profile_id = record.get("profile_id", "")
    profile = next((p for p in storage.get_profiles() if p.get("id") == profile_id), None)
    if not profile:
        return None
    try:
        bundle = build_docx_style_pdf_bundle(record.get("resume", {}), profile, str(PDF_CACHE_DIR))
        pdf_bytes = bundle.get("pdf") or b""
    except Exception:
        return None
    if pdf_bytes:
        cache_file.write_bytes(pdf_bytes)
        return cache_file
    return None


@router.get("")
def list_resumes(user: dict = Depends(get_current_user)):
    items = storage.get_generated_resumes()
    if user.get("is_admin"):
        return items
    allowed = set(user.get("assigned_profile_ids") or [])
    return [r for r in items if r.get("profile_id") in allowed]


@router.post("/generate")
def generate(body: GenerateResumeRequest, user: dict = Depends(get_current_user)):
    _check_profile_access(user, body.profile_id)
    profile = _get_profile(body.profile_id)
    job_description = body.job_description
    if body.job_id and not job_description:
        job = storage.get_job_by_id(body.job_id)
        if job:
            job_description = job.get("description", "")
    result = generate_resume_content(
        profile=profile,
        job_description=job_description,
        target_role=body.target_role,
        default_prompt=body.default_prompt,
        use_ai=body.use_ai,
        model=body.model,
    )
    resume = result.get("resume") or {}
    try:
        ats = analyze_ats_score(resume, job_description, target_role=body.target_role)
    except Exception:
        ats = {}
    return {"mode": result.get("mode"), "resume": resume, "ats": ats}


@router.post("/update")
def update(body: UpdateResumeRequest, user: dict = Depends(get_current_user)):
    _check_profile_access(user, body.profile_id)
    profile = _get_profile(body.profile_id)
    result = update_resume_content(
        profile=profile,
        job_description=body.job_description,
        current_resume=body.current_resume,
        fix_prompt=body.fix_prompt,
        target_role=body.target_role,
        default_prompt=body.default_prompt,
        model=body.model,
    )
    resume = result.get("resume") or body.current_resume
    try:
        ats = analyze_ats_score(resume, body.job_description, target_role=body.target_role)
    except Exception:
        ats = {}
    return {"resume": resume, "ats": ats}


@router.post("/answers")
def answers(body: GenerateAnswersRequest, user: dict = Depends(get_current_user)):
    result = generate_application_answers(
        resume=body.resume,
        job_description=body.job_description,
        questions=body.questions,
        target_role=body.target_role,
        model=body.model,
    )
    return result


@router.post("/save")
def save(body: SaveResumeRequest, background_tasks: BackgroundTasks, user: dict = Depends(get_current_user)):
    payload = dict(body.payload)
    profile_id = payload.get("profile_id", "")
    _check_profile_access(user, profile_id)
    payload.setdefault("created_by_user_id", user["id"])
    payload.setdefault("created_by_username", user.get("username", ""))
    payload.setdefault("created_at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    if not payload.get("saved_resume_id"):
        payload["saved_resume_id"] = f"resume_{uuid.uuid4().hex[:10]}"
    storage.save_generated_resume(payload)
    # Pre-render PDF in background so the first bidder view is instant.
    if payload.get("status") != "skipped":
        background_tasks.add_task(_render_pdf_to_cache, payload["saved_resume_id"])
    return {"saved_resume_id": payload["saved_resume_id"]}


@router.patch("/{resume_id}")
def patch_resume(resume_id: str, payload: dict, user: dict = Depends(get_current_user)):
    """Partial update — used for company_message + application_answers."""
    if hasattr(storage, "update_generated_resume"):
        storage.update_generated_resume(resume_id, payload)
    return {"ok": True}


@router.post("/{resume_id}/apply")
def mark_applied(resume_id: str, user: dict = Depends(get_current_user)):
    """Bidder marks a generated resume as applied. Records who + when."""
    if hasattr(storage, "update_generated_resume"):
        storage.update_generated_resume(resume_id, {
            "applied_status": "applied",
            "applied_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "applied_by_user_id": user.get("id", ""),
            "applied_by_username": user.get("username", ""),
        })
    return {"ok": True}


@router.post("/{resume_id}/unapply")
def mark_unapplied(resume_id: str, user: dict = Depends(get_current_user)):
    """Revert an applied resume back to pending — clears applied_status + applied_at + applied_by."""
    if hasattr(storage, "update_generated_resume"):
        storage.update_generated_resume(resume_id, {
            "applied_status": "pending",
            "applied_at": "",
            "applied_by_user_id": "",
            "applied_by_username": "",
        })
    return {"ok": True}


@router.delete("/{resume_id}")
def delete(resume_id: str, user: dict = Depends(get_current_user)):
    if hasattr(storage, "delete_generated_resume"):
        storage.delete_generated_resume(resume_id)
    return {"ok": True}


@router.get("/{resume_id}/pdf")
def get_resume_pdf(resume_id: str, user: dict = Depends(get_current_user)):
    """Fast PDF endpoint for saved resumes.

    Cache key is the saved_resume_id — stable across calls, so cache hits
    reliably (unlike content-hash, which broke when normalize altered the
    saved record vs. the in-memory generation output).
    """
    record = storage.get_generated_resume_by_id(resume_id) if hasattr(storage, "get_generated_resume_by_id") else None
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found")
    _check_profile_access(user, record.get("profile_id", ""))

    cache_file = PDF_CACHE_DIR / f"{resume_id}.pdf"
    if cache_file.exists() and cache_file.stat().st_size > 0:
        return Response(content=cache_file.read_bytes(), media_type="application/pdf")

    cached = _render_pdf_to_cache(resume_id)
    if cached and cached.exists() and cached.stat().st_size > 0:
        return Response(content=cached.read_bytes(), media_type="application/pdf")
    raise HTTPException(status_code=500, detail="PDF render failed")


@router.post("/export-pdf")
def export_pdf(payload: dict, user: dict = Depends(get_current_user)):
    """Legacy POST endpoint — used by the generation flow before save.

    Bidders use the GET /{id}/pdf endpoint instead (id-keyed cache).
    """
    profile_id = payload.get("profile_id", "")
    resume = payload.get("resume") or {}
    _check_profile_access(user, profile_id)
    profile = _get_profile(profile_id)

    cache_key = _resume_hash(resume, profile_id)
    cache_file = PDF_CACHE_DIR / f"{cache_key}.pdf"
    if cache_file.exists():
        return Response(content=cache_file.read_bytes(), media_type="application/pdf")

    try:
        bundle = build_docx_style_pdf_bundle(resume, profile, str(PDF_CACHE_DIR))
        pdf_bytes = bundle.get("pdf") or b""
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PDF export failed: {exc}")

    if pdf_bytes:
        cache_file.write_bytes(pdf_bytes)
    return Response(content=pdf_bytes, media_type="application/pdf")


@router.post("/ats")
def ats_score(payload: dict, user: dict = Depends(get_current_user)):
    resume = payload.get("resume") or {}
    jd = payload.get("job_description", "")
    role = payload.get("target_role", "")
    try:
        return analyze_ats_score(resume, jd, target_role=role)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
