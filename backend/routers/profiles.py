"""Profiles CRUD + DOCX upload."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from auth import get_current_user, require_admin, storage
from core import vps1_adapt
from schemas import ProfileUpsertRequest


def _extract_docx_text(path: Path) -> str:
    """Extract paragraph + table text from a .docx. Best-effort: '' on failure.
    Ported from VPS1 (includes table rows, which many resume templates use)."""
    try:
        from docx import Document  # type: ignore[import]
        doc = Document(str(path))
    except Exception:
        return ""
    parts: list[str] = []
    for paragraph in doc.paragraphs:
        value = paragraph.text.strip()
        if value:
            parts.append(value)
    for table in doc.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts).strip()


# --- Work-history detection from the uploaded DOCX (ported verbatim from VPS1) ---
# Populates a profile's detected_work_history, which seeds the ChatGPT prompt's
# FIXED WORK HISTORY block (companies + durations + per-company bullet targets).
_SECTION_HEADINGS = {
    "summary": {"SUMMARY", "PROFESSIONAL SUMMARY", "PROFILE", "ABOUT"},
    "skills": {"SKILLS", "TECHNICAL SKILLS", "TECHNOLOGIES", "TECH STACK"},
    "experience": {"WORK EXPERIENCE", "EXPERIENCE", "PROFESSIONAL EXPERIENCE", "EMPLOYMENT HISTORY"},
    "education": {"EDUCATION", "EDUCATION HISTORY"},
}
_DATE_RANGE_RE = re.compile(
    r"(?i)\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)?\s*\d{4}\b\s*(?:-|–|—|to)\s*(?:present|current|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)?\s*\d{4})\b"
)


def _clean_resume_line(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("•", "-")).strip()


def _resume_lines(text: str) -> list[str]:
    out: list[str] = []
    for raw in str(text or "").splitlines():
        clean = _clean_resume_line(raw)
        if clean:
            out.append(clean)
    return out


def _heading_key(line: str) -> str:
    return re.sub(r"[^A-Z ]+", "", str(line or "").upper()).strip()


def _find_heading_index(lines: list[str], heading_group: set) -> int | None:
    lookup = {_heading_key(item) for item in heading_group}
    for idx, line in enumerate(lines):
        if _heading_key(line) in lookup:
            return idx
    return None


def _section_lines(lines: list[str], heading_group: set, stop_groups: list) -> list[str]:
    start = _find_heading_index(lines, heading_group)
    if start is None:
        return []
    stop_lookup = {_heading_key(item) for group in stop_groups for item in group}
    end = len(lines)
    for idx in range(start + 1, len(lines)):
        if _heading_key(lines[idx]) in stop_lookup:
            end = idx
            break
    return lines[start + 1:end]


def _looks_like_role_title(line: str) -> bool:
    value = _clean_resume_line(line)
    if not value or value == "-" or "|" in value or "@" in value:
        return False
    if _DATE_RANGE_RE.search(value):
        return False
    return bool(re.search(
        r"(?i)\b(engineer|developer|architect|lead|manager|analyst|consultant|specialist|designer|administrator|scientist)\b",
        value,
    ))


def _parse_company_line(line: str):
    value = _clean_resume_line(line)
    if "|" not in value and not _DATE_RANGE_RE.search(value):
        return None
    parts = [part.strip() for part in re.split(r"\s*\|\s*", value) if part.strip()]
    if len(parts) >= 2 and (_DATE_RANGE_RE.search(value) or len(parts) >= 3):
        company = parts[0]
        duration = parts[-1]
        location = " | ".join(parts[1:-1]) if len(parts) > 2 else ""
        if company and (_DATE_RANGE_RE.search(duration) or _DATE_RANGE_RE.search(value)):
            return company, location, duration
    match = _DATE_RANGE_RE.search(value)
    if match:
        before = value[:match.start()].strip(" -–—|")
        company = before.split("|")[0].strip() if before else ""
        if company:
            return company, "", match.group(0)
    return None


def _extract_work_history_from_resume_text(text: str) -> list[dict]:
    lines = _resume_lines(text)
    section = _section_lines(lines, _SECTION_HEADINGS["experience"], [_SECTION_HEADINGS["education"]])
    if not section:
        section = lines
    items: list[dict] = []
    current: dict | None = None
    pending_role = ""
    all_headings = {h for group in _SECTION_HEADINGS.values() for h in group}
    for line in section:
        if _heading_key(line) in all_headings:
            continue
        if line == "-":
            continue
        # Skip template placeholder lines (VPS1-format templates carry __role__ /
        # __headline__ markers). Parsing them as company lines produced garbage
        # "company" names like "__role__ | Jul 2024".
        if re.search(r"_{2,3}[a-z_]+_{2,3}", line, re.IGNORECASE):
            continue
        # Skip education lines that leak into the experience scan (e.g.
        # "Baylor University (2012 - 2016) | Bachelor's Degree…") — mis-parsing one
        # as a company seeds the prompt with a fake role.
        if re.search(r"(?i)\b(university|college|institute|bachelor|master|degree)\b", line):
            continue
        parsed = _parse_company_line(line)
        if parsed:
            company, location, duration = parsed
            current = {"company_name": company, "role_title": pending_role or "", "duration": duration, "location": location, "bullets": []}
            items.append(current)
            pending_role = ""
            continue
        bullet = re.sub(r"^[-•]\s*", "", line).strip()
        if current is not None and line.startswith(("-", "•")) and len(bullet) > 12:
            current.setdefault("bullets", []).append(bullet)
            continue
        if _looks_like_role_title(line):
            pending_role = line
    return items[:8]


def _detect_work_history(extracted_text: str, existing_profile: dict) -> list[dict]:
    """Build detected_work_history from the DOCX text, preserving any per-company
    bullet targets the admin already set (matched by company name)."""
    gs = (existing_profile or {}).get("generation_settings", {}) or {}
    default_bullets = int(gs.get("bullets_per_company_default") or 5)
    prev = {
        str(item.get("company_name") or "").strip().lower(): int(item.get("bullets") or default_bullets)
        for item in (existing_profile or {}).get("detected_work_history", []) or []
        if isinstance(item, dict)
    }
    detected = _extract_work_history_from_resume_text(extracted_text)
    out: list[dict] = []
    for item in detected:
        name = str(item.get("company_name") or "").strip()
        if not name:
            continue
        out.append({
            "company_name": name,
            "role_title": str(item.get("role_title") or "").strip(),
            "duration": str(item.get("duration") or "").strip(),
            "location": str(item.get("location") or "").strip(),
            "bullets": prev.get(name.lower(), default_bullets),
        })
    return out

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
    # A VPS_1 profile is edited HERE but lives THERE: VPS_1 only sends a few fields, so admins fill the
    # rest in on this side. The edit is stored as an override (admin edits win, and the hourly mirror
    # can't wipe them) — we never write back to VPS_1.
    if profile_id.startswith("vps1:"):
        if not user.get("is_admin"):
            raise HTTPException(status_code=403, detail="Only an admin can edit a VPS_1 profile.")
        patch = {k: v for k, v in dict(body.payload).items() if k != "id"}
        updated = storage.patch_vps1_profile(profile_id[len("vps1:"):], patch)
        if not updated:
            raise HTTPException(status_code=404, detail="Profile not found")
        return vps1_adapt.profile(updated)

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
    extracted_text = _extract_docx_text(target_path)
    profile["uploaded_resume"] = {
        "filename":       file.filename,
        "content_type":   file.content_type or "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "size_bytes":     len(content),
        "path":           str(target_path),
        "relative_path":  str(target_path.relative_to(DATA_DIR.parent)),
        "uploaded_at":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "extracted_text": extracted_text,
    }
    # Re-detect the FIXED WORK HISTORY that seeds the ChatGPT prompt, preserving
    # any per-company bullet targets already set for the same companies.
    profile["detected_work_history"] = _detect_work_history(extracted_text, profile)
    storage.upsert_profile(profile)

    updated = next((p for p in storage.get_profiles() if p["id"] == profile_id), profile)
    return updated


_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@router.get("/{profile_id}/resume")
def download_resume(profile_id: str, user: dict = Depends(require_admin)):
    """Download a profile's uploaded DOCX template. Admin-only."""
    profile = next((p for p in storage.get_profiles() if p["id"] == profile_id), None)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    meta = profile.get("uploaded_resume") if isinstance(profile.get("uploaded_resume"), dict) else {}
    path_value = str((meta or {}).get("path") or "").strip()
    if not path_value or not Path(path_value).exists():
        raise HTTPException(status_code=404, detail="No résumé uploaded for this profile")
    filename = str((meta or {}).get("filename") or Path(path_value).name)
    return FileResponse(path_value, media_type=_DOCX_MIME, filename=filename)
