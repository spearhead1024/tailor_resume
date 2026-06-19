"""Screenshot capture storage (Chrome extension).

The extension captures the visible viewport of the current tab and uploads it
here, linked to the selected profile and (optionally) the matched job. Files
are stored on disk under data/screenshots/<profile_id>/ and indexed in a small
JSON metadata sidecar so admins can list/browse them later.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from auth import get_current_user, has_role, storage

router = APIRouter(prefix="/api/screenshots", tags=["screenshots"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
SHOTS_DIR = DATA_DIR / "screenshots"
SHOTS_DIR.mkdir(parents=True, exist_ok=True)
_INDEX = SHOTS_DIR / "_index.json"

_MAX_BYTES = 12 * 1024 * 1024  # 12 MB cap per screenshot
_ALLOWED = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", str(value or ""))[:64]


def _load_index() -> list[dict]:
    if not _INDEX.exists():
        return []
    try:
        return json.loads(_INDEX.read_text())
    except Exception:
        return []


def _save_index(items: list[dict]) -> None:
    _INDEX.write_text(json.dumps(items, indent=2))


def _check_profile_access(user: dict, profile_id: str) -> None:
    if has_role(user, "admin"):
        return
    if profile_id not in (user.get("assigned_profile_ids") or []):
        raise HTTPException(status_code=403, detail="Forbidden")


@router.post("")
async def upload_screenshot(
    image: UploadFile = File(...),
    profile_id: str = Form(""),
    url: str = Form(""),
    job_id: str = Form(""),
    user: dict = Depends(get_current_user),
):
    """Store a screenshot uploaded by the extension."""
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")

    pid = _safe_id(profile_id)
    if pid:
        _check_profile_access(user, pid)

    ext = _ALLOWED.get((image.content_type or "").lower())
    if not ext:
        raise HTTPException(status_code=400, detail="Unsupported image type (png/jpeg/webp only).")

    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image.")
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Screenshot too large.")

    shot_id = f"shot_{uuid.uuid4().hex[:12]}"
    sub = SHOTS_DIR / (pid or "_unassigned")
    sub.mkdir(parents=True, exist_ok=True)
    fpath = sub / f"{shot_id}{ext}"
    fpath.write_bytes(data)

    # Resolve a friendly job/company label if a job_id was provided.
    company = job_title = ""
    if job_id:
        job = storage.get_job_by_id(job_id)
        if job:
            company = job.get("company", "")
            job_title = job.get("job_title", "")

    entry = {
        "id": shot_id,
        "profile_id": pid,
        "job_id": _safe_id(job_id),
        "company": company,
        "job_title": job_title,
        "url": str(url or "")[:2048],
        "file": str(fpath.relative_to(DATA_DIR)),
        "content_type": image.content_type,
        "bytes": len(data),
        "created_at": _utcnow_iso(),
        "created_by_user_id": user.get("id", ""),
        "created_by_username": user.get("username", ""),
    }
    items = _load_index()
    items.append(entry)
    _save_index(items)

    return {"ok": True, "id": shot_id, "file": entry["file"]}


@router.get("")
def list_screenshots(profile_id: str = "", user: dict = Depends(get_current_user)):
    """List screenshot metadata. Admins see all; bidders see their own/assigned."""
    items = _load_index()
    if not has_role(user, "admin"):
        allowed = set(user.get("assigned_profile_ids") or [])
        items = [
            s for s in items
            if s.get("created_by_user_id") == user.get("id")
            or s.get("profile_id") in allowed
        ]
    if profile_id:
        items = [s for s in items if s.get("profile_id") == _safe_id(profile_id)]
    items.sort(key=lambda s: s.get("created_at") or "", reverse=True)

    # Resolve friendly profile names (cached so we hit storage once per profile).
    name_cache: dict[str, str] = {}

    def _profile_name(pid: str) -> str:
        if not pid:
            return ""
        if pid not in name_cache:
            prof = storage.get_profile_by_id(pid)
            name_cache[pid] = (prof or {}).get("name", "") if prof else ""
        return name_cache[pid]

    return [{**s, "profile_name": _profile_name(s.get("profile_id", ""))} for s in items]


@router.get("/{shot_id}/image")
def get_screenshot_image(shot_id: str, user: dict = Depends(get_current_user)):
    sid = _safe_id(shot_id)
    entry = next((s for s in _load_index() if s.get("id") == sid), None)
    if not entry:
        raise HTTPException(status_code=404, detail="Not found")
    if not has_role(user, "admin"):
        allowed = set(user.get("assigned_profile_ids") or [])
        if entry.get("created_by_user_id") != user.get("id") and entry.get("profile_id") not in allowed:
            raise HTTPException(status_code=403, detail="Forbidden")
    fpath = DATA_DIR / entry["file"]
    if not fpath.exists():
        raise HTTPException(status_code=404, detail="File missing")
    return Response(content=fpath.read_bytes(), media_type=entry.get("content_type") or "image/png")
