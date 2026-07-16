"""Profiles CRUD + DOCX upload."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from auth import get_current_user, require_admin, storage
from core import vps1_adapt
from schemas import ProfileUpsertRequest


def _extract_docx_text(path: Path) -> str:
    """Extract paragraph text from a .docx. Best-effort: returns empty string on failure."""
    try:
        from docx import Document  # type: ignore[import]
        doc = Document(str(path))
        return "\n".join(p.text for p in doc.paragraphs if p.text)
    except Exception:
        return ""

router = APIRouter(prefix="/api/profiles", tags=["profiles"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"


def _accessible(user: dict, profiles: list[dict]) -> list[dict]:
    if user.get("is_admin"):
        return profiles
    allowed = set(user.get("assigned_profile_ids") or [])
    return [p for p in profiles if p.get("id") in allowed]


@router.get("")
def list_profiles(user: dict = Depends(get_current_user)):
    """Local profiles (tagged VPS_2), plus — for admins — VPS_1's profiles (tagged VPS_1, read-only).
    VPS_1 rows are a live best-effort proxy: if VPS_1 is down they simply don't appear."""
    local = vps1_adapt.tag_local(_accessible(user, storage.get_profiles()))
    if not user.get("is_admin"):
        return local
    # VPS_1 rows come from the local hourly mirror (core/vps1_sync.py), so this stays a fast DB read —
    # no per-load network call to VPS_1.
    remote = [vps1_adapt.profile(p) for p in storage.get_vps1_profiles()]
    return local + remote


@router.get("/{profile_id}")
def get_profile(profile_id: str, user: dict = Depends(get_current_user)):
    profile = storage.get_profile_by_id(profile_id) if hasattr(storage, "get_profile_by_id") else None
    if not profile:
        for p in storage.get_profiles():
            if p.get("id") == profile_id:
                profile = p
                break
    if not profile:
        raise HTTPException(status_code=404, detail="Not found")
    if not user.get("is_admin") and profile_id not in (user.get("assigned_profile_ids") or []):
        raise HTTPException(status_code=403, detail="Forbidden")
    return profile


@router.post("")
def create_profile(body: ProfileUpsertRequest, user: dict = Depends(require_admin)):
    payload = dict(body.payload)
    if not payload.get("id"):
        payload["id"] = storage.make_id("profile")
    storage.upsert_profile(payload)
    return next((p for p in storage.get_profiles() if p["id"] == payload["id"]), {"id": payload["id"]})


@router.patch("/{profile_id}")
def update_profile(profile_id: str, body: ProfileUpsertRequest, user: dict = Depends(get_current_user)):
    if not user.get("is_admin") and profile_id not in (user.get("assigned_profile_ids") or []):
        raise HTTPException(status_code=403, detail="Forbidden")
    payload = dict(body.payload)
    payload["id"] = profile_id
    storage.upsert_profile(payload)
    return next((p for p in storage.get_profiles() if p["id"] == profile_id), {"id": profile_id})


@router.delete("/{profile_id}")
def delete_profile(profile_id: str, user: dict = Depends(require_admin)):
    storage.delete_profile(profile_id)
    return {"ok": True}


@router.post("/{profile_id}/upload-resume")
async def upload_resume(profile_id: str, file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    if not user.get("is_admin") and profile_id not in (user.get("assigned_profile_ids") or []):
        raise HTTPException(status_code=403, detail="Forbidden")
    if not file.filename or not file.filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="Must upload a .docx file")

    profile = next((p for p in storage.get_profiles() if p["id"] == profile_id), None)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found")

    target_dir = DATA_DIR / "profile_resumes" / profile_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / file.filename
    content = await file.read()
    target_path.write_bytes(content)

    # Persist the upload metadata in the shape the docx exporter expects.
    profile["uploaded_resume"] = {
        "filename":       file.filename,
        "content_type":   file.content_type or "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "size_bytes":     len(content),
        "path":           str(target_path),
        "relative_path":  str(target_path.relative_to(DATA_DIR.parent)),
        "uploaded_at":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "extracted_text": _extract_docx_text(target_path),
    }
    storage.upsert_profile(profile)

    updated = next((p for p in storage.get_profiles() if p["id"] == profile_id), profile)
    return updated
