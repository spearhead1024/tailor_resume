"""Resume endpoints.

Resume content is now produced by the operator pasting ChatGPT JSON in
the Resumes tab. This module:
  • Hands out the per-(profile, job) prompt to copy into ChatGPT
  • Accepts the pasted JSON, validates it, saves a generated_resume record,
    and renders the PDF via core.docx_resume_export
  • Continues to serve cached PDFs and lets bidders mark applies
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import Response

from auth import get_current_user, has_role, storage
from core import vps1_adapt, vps1_client
from core.docx_resume_export import build_docx_style_pdf_bundle
from core.storage import normalize_job_url, tech_stacks_match

router = APIRouter(prefix="/api/resumes", tags=["resumes"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
PDF_CACHE_DIR = DATA_DIR / "pdf_cache"
PDF_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ── Bid activity tracking (anti-cheat audit) ────────────────────────────────
# Bid-tab buttons are no longer gated; instead every click is logged here so an
# admin can see who skipped steps. When a job is marked applied we evaluate
# whether the bidder actually did the full flow and flag any that didn't.
LOG_DIR = DATA_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
BID_ACTIVITY_LOG = LOG_DIR / "bid_activity.jsonl"     # every event, one JSON per line
BID_SUSPICIOUS_LOG = LOG_DIR / "bid_suspicious.log"   # human-readable cheat flags

_BID_ACTIONS = {"copy_prompt", "generate", "download", "open_link", "mark_applied", "report"}
# Steps a bidder is expected to have done before marking a job applied.
_BID_REQUIRED_BEFORE_APPLY = ["copy_prompt", "generate", "download", "open_link"]

_bid_log_lock = threading.Lock()
# In-memory per (user_id, profile_id, job_id) -> {action: timestamp}; used only
# to score completeness at mark-applied time. The JSONL file is the durable log.
_bid_steps: dict[tuple, dict] = {}


def _append_line(path: Path, text: str) -> None:
    with _bid_log_lock:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_profile(profile_id: str) -> dict:
    for p in storage.get_profiles():
        if p.get("id") == profile_id:
            return p
    raise HTTPException(status_code=404, detail="Profile not found")


def _check_profile_access(user: dict, profile_id: str) -> None:
    if has_role(user, "admin"):
        return
    if profile_id not in (user.get("assigned_profile_ids") or []):
        raise HTTPException(status_code=403, detail="Forbidden")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Job deadline (hours), admin-configurable in Settings. Fallback default if
# the setting is missing. Two rolling windows share this one value:
#   • Resumes tab — measured from the JOB's submitted_at (how long a job is
#     worth generating a resume for).
#   • Apply tab — measured from the RESUME's created_at (how long a bidder has
#     to apply a resume they generated). Keyed on generation, NOT job age, so
#     a freshly-made resume never vanishes just because its job aged out.
DEFAULT_JOB_DEADLINE_HOURS = 12
JOB_DEADLINE_HOURS = DEFAULT_JOB_DEADLINE_HOURS  # legacy alias
RESUMES_WINDOW_HOURS = DEFAULT_JOB_DEADLINE_HOURS
APPLY_WINDOW_HOURS = DEFAULT_JOB_DEADLINE_HOURS
RECENT_JOB_WINDOW_HOURS = DEFAULT_JOB_DEADLINE_HOURS


try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover — pre-3.9 / no tzdata fallback
    _ET = timezone(timedelta(hours=-5))  # type: ignore[arg-type]


def deadline_hours() -> int:
    """Admin-configured rolling deadline, in hours (falls back to default)."""
    try:
        return int(storage.get_app_settings().get("job_deadline_hours") or DEFAULT_JOB_DEADLINE_HOURS)
    except Exception:
        return DEFAULT_JOB_DEADLINE_HOURS


def _within_hours(raw_ts: str, hours: int) -> bool:
    raw = str(raw_ts or "").strip()
    if not raw:
        return False
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ts).total_seconds() <= hours * 3600


def _is_recent_job(job: dict, *, hours: int | None = None) -> bool:
    """True if the job was added within the deadline window (from submitted_at)."""
    window = deadline_hours() if hours is None else hours
    return _within_hours(job.get("submitted_at"), window)


def _is_recent_resume(resume: dict, *, hours: int | None = None) -> bool:
    """True if the resume was GENERATED within the deadline window — keyed on
    created_at, so a just-generated resume stays applyable regardless of job age."""
    window = deadline_hours() if hours is None else hours
    return _within_hours(resume.get("created_at"), window)


def _regions_match(job_region: str, profile_region: str) -> bool:
    return "ANY" in (job_region, profile_region) or job_region == profile_region


def _render_pdf_to_cache(saved_resume_id: str, *, raise_errors: bool = False) -> Path | None:
    sid = (saved_resume_id or "").strip()
    if not sid:
        if raise_errors:
            raise HTTPException(status_code=400, detail="Missing resume id")
        return None
    cache_file = PDF_CACHE_DIR / f"{sid}.pdf"
    if cache_file.exists() and cache_file.stat().st_size > 0:
        return cache_file
    record = storage.get_generated_resume_by_id(sid) if hasattr(storage, "get_generated_resume_by_id") else None
    if not record:
        if raise_errors:
            raise HTTPException(status_code=404, detail="Resume not found")
        return None
    profile = next((p for p in storage.get_profiles() if p.get("id") == record.get("profile_id", "")), None)
    if not profile:
        if raise_errors:
            raise HTTPException(status_code=404, detail="Profile not found")
        return None

    ur = profile.get("uploaded_resume") if isinstance(profile.get("uploaded_resume"), dict) else None
    ur_path = (ur or {}).get("path") if ur else None
    if not ur or not ur_path or not Path(ur_path).exists():
        if raise_errors:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Cannot render PDF — no DOCX template uploaded for profile "
                    f"\"{profile.get('name','this profile')}\". Ask the admin to upload "
                    f"a resume template in the Profiles tab."
                ),
            )
        return None

    try:
        bundle = build_docx_style_pdf_bundle(record.get("resume", {}), profile, str(PDF_CACHE_DIR))
        pdf_bytes = cast(bytes, bundle.get("pdf") or b"")
    except Exception as exc:
        if raise_errors:
            raise HTTPException(status_code=500, detail=f"PDF render failed: {exc}")
        return None
    if pdf_bytes:
        cache_file.write_bytes(pdf_bytes)
        return cache_file
    if raise_errors:
        raise HTTPException(status_code=500, detail="PDF render produced empty output")
    return None


# ---------------------------------------------------------------------------
# List + per-id read
# ---------------------------------------------------------------------------

@router.get("")
def list_resumes(user: dict = Depends(get_current_user)):
    items = storage.get_generated_resumes()
    if has_role(user, "admin"):
        return items
    allowed = set(user.get("assigned_profile_ids") or [])
    return [r for r in items if r.get("profile_id") in allowed]


def _et_day(iso_ts: str) -> str:
    """ET calendar date (YYYY-MM-DD) of a UTC ISO timestamp, '' if unparseable."""
    raw = str(iso_ts or "").strip()
    if not raw:
        return ""
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw[:10]
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(_ET).date().isoformat()


@router.get("/search")
def search_applied_resumes(
    q: str = Query(""),
    profile_id: str = Query(""),
    bidder: str = Query(""),
    date_from: str = Query(""),   # ET date YYYY-MM-DD (applied_at)
    date_to: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    """Search APPLIED resumes (admin archive).

    Keyword (`q`) matches job company / title / description and the bidder
    username. Bidders are restricted to their assigned profiles; admins see all.
    Returns lightweight rows (no heavy resume blob), paginated, newest-applied
    first, plus a `profiles`/`bidders` facet list for the filter dropdowns.
    """
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")

    profiles = {p.get("id"): p for p in storage.get_profiles()}
    allowed_pids = None
    if not has_role(user, "admin"):
        allowed_pids = set(user.get("assigned_profile_ids") or [])

    ql = q.strip().lower()
    bl = bidder.strip().lower()

    rows: list[dict] = []
    facet_profiles: dict[str, str] = {}
    facet_bidders: set[str] = set()

    for r in storage.get_generated_resumes():
        if r.get("applied_status") != "applied":
            continue
        pid = r.get("profile_id") or ""
        if allowed_pids is not None and pid not in allowed_pids:
            continue

        # facets (built from the full applied set this user can see)
        if pid in profiles:
            facet_profiles[pid] = profiles[pid].get("name", "")
        who = (r.get("applied_by_username") or r.get("created_by_username") or "").strip()
        if who:
            facet_bidders.add(who)

        # filters
        if profile_id and pid != profile_id:
            continue
        if bl and who.lower() != bl:
            continue
        applied_day = _et_day(r.get("applied_at") or r.get("created_at"))
        if date_from and applied_day and applied_day < date_from:
            continue
        if date_to and applied_day and applied_day > date_to:
            continue
        if ql:
            hay = " ".join([
                str(r.get("job_company", "")),
                str(r.get("job_title", "")),
                str(r.get("job_description", "")),
                who,
            ]).lower()
            if ql not in hay:
                continue

        rows.append({
            "saved_resume_id": r.get("saved_resume_id"),
            "job_id": r.get("job_id", ""),
            "job_company": r.get("job_company", ""),
            "job_title": r.get("job_title", ""),
            "job_link": r.get("job_link", ""),
            "job_region": r.get("job_region", ""),
            "profile_id": pid,
            "profile_name": profiles.get(pid, {}).get("name", ""),
            "bidder": who,
            "applied_at": r.get("applied_at", ""),
            "created_at": r.get("created_at", ""),
            "source": vps1_adapt.SOURCE_LOCAL,
        })

    # Admins also see VPS_1's applied rows (read-only, live proxy). Apply the same keyword / bidder
    # filters so a search stays consistent across both sources; VPS_1 rows feed the facet lists too.
    if has_role(user, "admin"):
        # local hourly mirror, pre-filtered to 'applied' in SQL — no per-search network call and no
        # deserializing the thousands of non-applied VPS_1 rows. VPS_1 rows honour EVERY filter the
        # local rows do (profile / bidder / date / keyword), so the filters behave identically across
        # both sources.
        for a in storage.get_vps1_applications(status="applied"):
            row = vps1_adapt.applied_row(a)
            who = str(row["bidder"]).strip()

            # facets first (built from the full applied set, like the local loop above)
            if row["profile_name"]:
                facet_profiles[row["profile_id"]] = row["profile_name"]
            if who:
                facet_bidders.add(who)

            # filters — same semantics as the local block
            if profile_id and row["profile_id"] != profile_id:
                continue
            if bl and who.lower() != bl:
                continue
            applied_day = _et_day(row.get("applied_at") or row.get("created_at"))
            if date_from and applied_day and applied_day < date_from:
                continue
            if date_to and applied_day and applied_day > date_to:
                continue
            if ql:
                hay = " ".join(str(row.get(k, "")) for k in
                               ("job_company", "job_title", "bidder")).lower()
                if ql not in hay:
                    continue

            rows.append(row)

    rows.sort(key=lambda x: x.get("applied_at") or x.get("created_at") or "", reverse=True)
    total = len(rows)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]

    return {
        "results": page_rows,
        "total": total,
        "page": page,
        "page_size": page_size,
        "profiles": sorted(
            ({"id": pid, "name": name} for pid, name in facet_profiles.items()),
            key=lambda p: p["name"].lower(),
        ),
        "bidders": sorted(facet_bidders, key=str.lower),
    }


@router.get("/{resume_id}/job")
def get_resume_job_detail(resume_id: str, user: dict = Depends(get_current_user)):
    """Full job detail (description, link, region) behind an applied resume —
    for the expandable row in the Applied tab."""
    # VPS_1 applied resume: pull the job detail from the local mirror (admins only).
    if resume_id.startswith("vps1:"):
        if not has_role(user, "admin"):
            raise HTTPException(status_code=403, detail="Forbidden")
        rid = resume_id[len("vps1:"):]
        app = next((a for a in storage.get_vps1_applications()
                    if str(a.get("generated_resume_id") or a.get("id")) == rid), None)
        if not app:
            raise HTTPException(status_code=404, detail="Resume not found")
        return {
            "job_id": app.get("job_id", ""),
            "company": app.get("company", ""),
            "job_title": app.get("job_title", ""),
            "link": app.get("job_link", ""),
            "region": app.get("region", ""),
            "status": app.get("current_status", ""),
            "description": str(app.get("target_role") or ""),   # VPS_1 doesn't ship the JD in the summary
            "job_exists": bool(app.get("job_id")),
        }

    rec = storage.get_generated_resume_by_id(resume_id) if hasattr(storage, "get_generated_resume_by_id") else None
    if not rec:
        raise HTTPException(status_code=404, detail="Resume not found")
    _check_profile_access(user, rec.get("profile_id", ""))
    job = storage.get_job_by_id(rec.get("job_id", "")) or {}
    # Prefer the job's current description; fall back to the snapshot stored on
    # the resume record (jobs can be deleted/edited after applying).
    description = str(job.get("description") or rec.get("job_description") or "")
    return {
        "job_id": rec.get("job_id", ""),
        "company": job.get("company") or rec.get("job_company", ""),
        "job_title": job.get("job_title") or rec.get("job_title", ""),
        "link": job.get("link") or rec.get("job_link", ""),
        "region": job.get("region") or rec.get("job_region", ""),
        "status": job.get("status", ""),
        "description": description,
        "job_exists": bool(job),
    }


# ---------------------------------------------------------------------------
# Resumes tab — pending jobs per profile + per-job prompt
# ---------------------------------------------------------------------------

@router.get("/pending")
def list_pending_for_profile(profile_id: str, user: dict = Depends(get_current_user)):
    """Jobs that don't yet have a generated resume for this profile.

    Used by the left pane of the Resumes tab.
    """
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    _check_profile_access(user, profile_id)

    profile = _get_profile(profile_id)
    p_region = str(profile.get("region") or "ANY").upper()

    # Jobs already generated/skipped for this profile (so we exclude them)
    processed_ids: set[str] = set()
    for r in storage.get_generated_resumes():
        if r.get("profile_id") != profile_id:
            continue
        if r.get("status") in ("generated", "skipped"):
            jid = r.get("job_id") or ""
            if jid:
                processed_ids.add(jid)

    out: list[dict] = []
    for job in storage.get_jobs():
        if job.get("status") != "approved":
            continue
        if job.get("flagged") or job.get("admin_applied"):
            continue
        if not _regions_match(str(job.get("region") or "ANY").upper(), p_region):
            continue
        if not tech_stacks_match(job.get("description"), profile.get("tech_stacks") or []):
            continue  # profile's main skills aren't mentioned in this job
        if job.get("id") in processed_ids:
            continue
        if not _is_recent_job(job):  # configurable deadline from settings
            continue
        out.append({
            "id": job.get("id"),
            "company": job.get("company", ""),
            "job_title": job.get("job_title", ""),
            "region": job.get("region", "ANY"),
            "submitted_at": job.get("submitted_at", ""),
            "approved_at": job.get("approved_at", ""),
        })

    out.sort(key=lambda j: j.get("submitted_at") or "", reverse=True)
    return out


def _eligible_bid_items(profile: dict) -> list[dict]:
    """Unified Bid queue for one profile: approved, region- + tech-stack-matched,
    within-deadline jobs the profile has NOT applied to yet. Each item carries an
    existing résumé id (when one was already generated) so the Bid card can skip
    straight to Download instead of regenerating."""
    pid = profile.get("id", "")
    p_region = str(profile.get("region") or "ANY").upper()

    latest_by_job: dict[str, dict] = {}
    applied_jobs: set[str] = set()
    for r in storage.get_generated_resumes():
        if r.get("profile_id") != pid:
            continue
        jid = r.get("job_id") or ""
        if not jid:
            continue
        if r.get("applied_status") == "applied":
            applied_jobs.add(jid)
        if r.get("status") == "generated":
            cur = latest_by_job.get(jid)
            if cur is None or (r.get("created_at") or "") > (cur.get("created_at") or ""):
                latest_by_job[jid] = r

    items: list[dict] = []
    for job in storage.get_jobs():
        if job.get("status") != "approved":
            continue
        if job.get("flagged") or job.get("admin_applied"):
            continue
        jid = job.get("id") or ""
        if not jid or jid in applied_jobs:
            continue  # already applied for this profile
        if not _regions_match(str(job.get("region") or "ANY").upper(), p_region):
            continue
        if not tech_stacks_match(job.get("description"), profile.get("tech_stacks") or []):
            continue
        if not _is_recent_job(job):
            continue
        existing = latest_by_job.get(jid)
        items.append({
            "id": jid,
            "company": job.get("company", ""),
            "job_title": job.get("job_title", ""),
            "region": job.get("region", "ANY"),
            "link": job.get("link", ""),
            "submitted_at": job.get("submitted_at", ""),
            "resume_id": (existing or {}).get("saved_resume_id", ""),
        })
    items.sort(key=lambda j: j.get("submitted_at") or "", reverse=True)
    return items


def _bid_public_profile(p: dict) -> dict:
    """The profile fields the Bid sidebar shows (click-to-copy)."""
    return {
        "id": p.get("id", ""),
        "name": p.get("name", ""),
        "email": p.get("email", ""),
        "phone": p.get("phone", ""),
        "location": p.get("location", ""),
        "address": p.get("address", ""),
        "zip_code": p.get("zip_code", ""),
        "linkedin": p.get("linkedin", ""),
        "github": p.get("github", ""),
        "portfolio": p.get("portfolio", ""),
        "status": p.get("status", "active"),
        "education_history": [
            {
                "university": e.get("university", ""),
                "degree": e.get("degree", ""),
                "duration": e.get("duration", ""),
                "location": e.get("location", ""),
            }
            for e in (p.get("education_history", []) or [])
        ],
        "work_history": [
            {
                "company_name": w.get("company_name", ""),
                "duration": w.get("duration", ""),
                "location": w.get("location", ""),
                "legacy_role": w.get("legacy_role", ""),
            }
            for w in (p.get("work_history", []) or [])
        ],
    }


@router.get("/bid/profiles")
def bid_profiles(user: dict = Depends(get_current_user)):
    """Accessible profiles for the Bid tab — full copyable fields + to-bid count."""
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    profiles = storage.get_profiles()
    if not user.get("is_admin"):
        allowed = set(user.get("assigned_profile_ids") or [])
        profiles = [p for p in profiles if p.get("id") in allowed]
    out = [
        {**_bid_public_profile(p), "bid_count": len(_eligible_bid_items(p))}
        for p in profiles
    ]
    return {"role": "admin" if user.get("is_admin") else "bidder", "profiles": out}


@router.get("/bid")
def bid_queue(profile_id: str, user: dict = Depends(get_current_user)):
    """The ordered Bid queue (jobs to bid) for one profile."""
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    _check_profile_access(user, profile_id)
    return _eligible_bid_items(_get_profile(profile_id))


@router.get("/bid-job/{job_id}")
def bid_job_detail(job_id: str, user: dict = Depends(get_current_user)):
    """Public detail (incl. full description) of an approved job, for the Bid tab."""
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    job = storage.get_job_by_id(job_id)
    if not job or job.get("status") != "approved" or job.get("flagged") or job.get("admin_applied"):
        raise HTTPException(status_code=404, detail="Job not available")
    return {
        "id": job.get("id", ""),
        "company": job.get("company", ""),
        "job_title": job.get("job_title", ""),
        "region": job.get("region", "ANY"),
        "link": job.get("link", ""),
        "description": job.get("description", ""),
    }


@router.post("/bid/track")
def bid_track(body: dict, user: dict = Depends(get_current_user)):
    """Record a Bid-tab button click for the anti-cheat audit log.

    Buttons are enabled (not gated); every click is appended to bid_activity.jsonl.
    On `mark_applied` we check the bidder did copy_prompt → generate → download →
    open_link and flag the job in bid_suspicious.log when any step is missing.
    """
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    body = body or {}
    action = str(body.get("action") or "").strip()
    if action not in _BID_ACTIONS:
        raise HTTPException(status_code=400, detail="Unknown action")

    uid = user.get("id", "")
    uname = user.get("username", "") or uid
    pid = str(body.get("profile_id") or "")
    jid = str(body.get("job_id") or "")
    company = str(body.get("company") or "")
    title = str(body.get("job_title") or "")
    ts = _utcnow_iso()

    # Never persist the opaque ids — only the human-readable audit fields.
    rec = {"ts": ts, "username": uname, "company": company, "job_title": title, "action": action}
    _append_line(BID_ACTIVITY_LOG, json.dumps(rec, ensure_ascii=False))

    key = (uid, pid, jid)   # transient in-memory correlation only (not written anywhere)
    steps = _bid_steps.setdefault(key, {})
    steps[action] = ts

    if action == "mark_applied":
        done = [s for s in _BID_REQUIRED_BEFORE_APPLY if s in steps]
        missing = [s for s in _BID_REQUIRED_BEFORE_APPLY if s not in steps]
        summary = {"ts": ts, "username": uname, "company": company, "job_title": title,
                   "action": "apply_summary", "steps_done": done,
                   "missing": missing, "suspicious": bool(missing)}
        _append_line(BID_ACTIVITY_LOG, json.dumps(summary, ensure_ascii=False))
        if missing:
            _append_line(
                BID_SUSPICIOUS_LOG,
                f'{ts}  SUSPICIOUS  {uname}  applied "{company} — {title}"  '
                f'| missing steps: {", ".join(missing)}',
            )
        _bid_steps.pop(key, None)   # reset for a possible re-bid of the same job
    return {"ok": True}


@router.get("/bid/logs")
def bid_logs(which: str = Query("activity"), user: dict = Depends(get_current_user)):
    """Download the Bid audit log (admin only). which=activity|suspicious."""
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admins only")
    path = BID_SUSPICIOUS_LOG if which == "suspicious" else BID_ACTIVITY_LOG
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    return Response(content=text, media_type="text/plain")


def _latest_resume_for(profile_id: str, job_id: str) -> dict | None:
    """Most-recent generated resume record for a (profile, job) pair, if any."""
    best = None
    for r in storage.get_generated_resumes():
        if r.get("profile_id") != profile_id or r.get("job_id") != job_id:
            continue
        if r.get("status") != "generated":
            continue
        if best is None or (r.get("created_at") or "") > (best.get("created_at") or ""):
            best = r
    return best


@router.get("/by-job-url")
def find_resume_by_job_url(
    profile_id: str = Query(...),
    url: str = Query(...),
    user: dict = Depends(get_current_user),
):
    """Chrome-extension lookup: given the current tab URL + selected profile,
    find the matching job and its generated resume.

    Matching is layered so it tolerates tracking params and apply-vs-posting
    differences:
      1) exact normalized-URL match (tracking params stripped)
      2) host + path match (ignore query entirely)
      3) Greenhouse short-link token: a job stored as https://grnh.se/<token>
         resolves at click time to job-boards.greenhouse.io/...?gh_src=<token>,
         so we bridge the two by that token.
    Returns {matched, job:{...}|None, resume:{saved_resume_id, applied_status}|None}.
    """
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    _check_profile_access(user, profile_id)
    _get_profile(profile_id)  # 404 if profile missing / no access

    target = str(url or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="url is required")

    job = storage.find_job_by_url(target)

    # Fallback: match on scheme-less host+path (ignore all query params), which
    # catches apply links that differ only by session/job query strings.
    if not job:
        def _host_path(u: str) -> str:
            try:
                from urllib.parse import urlparse
                p = urlparse(u if "://" in u else f"http://{u}")
                host = (p.netloc or "").lower()
                if host.startswith("www."):
                    host = host[4:]
                return f"{host}{p.path.rstrip('/')}"
            except Exception:
                return ""
        want = _host_path(target)
        if want:
            for j in storage.get_jobs():
                if j.get("status") not in ("approved",):
                    continue
                if _host_path(str(j.get("link") or "")) == want:
                    job = j
                    break

    # Layer 3: Greenhouse short-link token. The stored job link is often a
    # https://grnh.se/<token> short link; clicking it lands the bidder on
    # job-boards.greenhouse.io/<co>/jobs/<id>?gh_src=<token>. Bridge by token.
    if not job:
        from urllib.parse import urlparse, parse_qs

        def _grnh_short_token(u: str) -> str:
            """Token from a grnh.se short link (its first path segment)."""
            try:
                p = urlparse(u if "://" in u else f"http://{u}")
                if p.netloc.lower().endswith("grnh.se"):
                    seg = [s for s in p.path.split("/") if s]
                    return seg[0].lower() if seg else ""
            except Exception:
                pass
            return ""

        def _page_token(u: str) -> str:
            """Token from the current page: grnh.se path, or a greenhouse gh_src."""
            try:
                p = urlparse(u if "://" in u else f"http://{u}")
                host = p.netloc.lower()
                if host.endswith("grnh.se"):
                    seg = [s for s in p.path.split("/") if s]
                    return seg[0].lower() if seg else ""
                if "greenhouse.io" in host:
                    return (parse_qs(p.query).get("gh_src") or [""])[0].lower()
            except Exception:
                pass
            return ""

        tok = _page_token(target)
        if tok:
            for j in storage.get_jobs():
                if j.get("status") not in ("approved",):
                    continue
                if _grnh_short_token(str(j.get("link") or "")) == tok:
                    job = j
                    break

    if not job:
        return {"matched": False, "job": None, "resume": None}

    job_lite = {
        "id": job.get("id"),
        "company": job.get("company", ""),
        "job_title": job.get("job_title", ""),
        "region": job.get("region", "ANY"),
        "status": job.get("status"),
        "flagged": bool(job.get("flagged")),
        "link": job.get("link", ""),
    }
    rec = _latest_resume_for(profile_id, job.get("id") or "")
    resume_lite = None
    if rec:
        resume_lite = {
            "saved_resume_id": rec.get("saved_resume_id"),
            "applied_status": rec.get("applied_status", "pending"),
            "created_at": rec.get("created_at", ""),
            "job_company": rec.get("job_company", ""),
            "job_title": rec.get("job_title", ""),
        }
    return {"matched": True, "job": job_lite, "resume": resume_lite}


def _build_prompt(profile: dict, job: dict, template: str) -> str:
    """Assemble the 3-section prompt the operator copies into ChatGPT."""
    # PROFILE JSON — only the fields the prompt template references
    work_history = []
    for w in profile.get("work_history", []) or []:
        work_history.append({
            "company_name": w.get("company_name", ""),
            "duration": w.get("duration", ""),
            "legacy_role": w.get("role_title") or w.get("role", "") or w.get("legacy_role", ""),
            # bullet_count is filled below from generation_settings
        })
    gs = profile.get("generation_settings", {}) or {}
    bullet_counts = gs.get("bullet_counts", []) or []
    for i, w in enumerate(work_history):
        if i < len(bullet_counts):
            w["bullet_count"] = int(bullet_counts[i] or 10)
        else:
            w["bullet_count"] = 10

    profile_json = {
        "profile_id": profile.get("id", ""),
        "total_years_of_experience": int(profile.get("total_years_of_experience") or 0),
        "skills_count": int(gs.get("skills_count") or 85),
        "summary_char_count": int(gs.get("summary_char_count") or 650),
        "work_history": work_history,
    }
    # Restricted profiles carry 2-3 main skills (their real/LinkedIn stack) that
    # MUST appear on the résumé even when the JD doesn't mention them — this is
    # also what keeps the résumé from being a perfect, AI-detectable JD match.
    # All-Stack profiles (no tech_stacks) leave the prompt byte-identical to before.
    must_include = [str(s).strip() for s in (profile.get("tech_stacks") or []) if str(s).strip()]
    if must_include:
        profile_json["must_include_skills"] = must_include
    job_json = {
        "job_id": job.get("id", ""),
        "description": job.get("description", ""),
    }

    extra = ""
    if must_include:
        extra = (
            "\n# REQUIRED PROFILE SKILLS\n"
            f"The candidate's core stack is: {', '.join(must_include)}.\n"
            "Include EVERY one of these in technical_skills even if the job "
            "description does not mention it, and weave the most relevant one or "
            "two into professional_experience bullets, consistent with the work "
            "history timeline. Do NOT wrap a skill in <B>...</B> unless the job "
            "description itself requests it, so the résumé reads as naturally "
            "curated rather than keyword-matched to the posting.\n"
        )

    return (
        f"{template.strip()}\n\n"
        f"# PROFILE JSON\n```json\n{json.dumps(profile_json, indent=2)}\n```\n\n"
        f"# JOB DESCRIPTION JSON\n```json\n{json.dumps(job_json, indent=2)}\n```\n"
        f"{extra}"
    )


@router.get("/prompt")
def get_prompt(profile_id: str, job_id: str, user: dict = Depends(get_current_user)):
    """Return the full ChatGPT prompt for a (profile, job) pair."""
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    _check_profile_access(user, profile_id)
    profile = _get_profile(profile_id)
    job = storage.get_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    settings = storage.get_app_settings()
    template = str(settings.get("prompt_template", "")).strip()
    if not template:
        from core.storage import DEFAULT_PROMPT_TEMPLATE
        template = DEFAULT_PROMPT_TEMPLATE
    return {"prompt": _build_prompt(profile, job, template)}


# ---------------------------------------------------------------------------
# Generate-from-JSON: the new core flow
# ---------------------------------------------------------------------------

def _coerce_chatgpt_json(raw: str) -> dict:
    """Parse the pasted text. Tolerates ```json ... ``` fences."""
    text = (raw or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Paste the JSON output from ChatGPT first.")
    # Strip optional ```json or ``` fences
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[: -3].rstrip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc.msg} (line {exc.lineno}, col {exc.colno})")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="JSON root must be an object.")
    return data


def _validate_resume_json(data: dict) -> None:
    required = ["job_id", "profile_id", "professional_summary", "professional_experience", "technical_skills"]
    missing = [k for k in required if not data.get(k)]
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required fields: {', '.join(missing)}")
    if not isinstance(data["professional_experience"], list):
        raise HTTPException(status_code=400, detail='"professional_experience" must be an array.')
    if not isinstance(data["technical_skills"], list):
        raise HTTPException(status_code=400, detail='"technical_skills" must be an array.')


_SUMMARY_TOLERANCE = 50
# A bullet passes validation if it is long enough to wrap to AT LEAST two
# lines in the rendered PDF. The resume column wraps at roughly 95–105 chars,
# so anything below ~110 chars renders as a single line and is rejected.
# There is no upper bound — overly long bullets are tolerated, only single-
# liners are rejected.
_BULLET_MIN_LEN_FOR_TWO_LINES = 110


def _validate_against_profile(data: dict, profile: dict) -> None:
    """Enforce the per-profile format requirements declared in the prompt.

    Raises HTTP 422 with a specific reason if ChatGPT's output deviates so the
    operator can ask ChatGPT to retry rather than ending up with a malformed
    PDF.
    """
    issues: list[str] = []

    gs = profile.get("generation_settings", {}) or {}
    target_summary = int(gs.get("summary_char_count") or 0)
    target_bullet_counts = list(gs.get("bullet_counts") or [])
    target_skills = int(gs.get("skills_count") or 0)
    profile_history = profile.get("work_history", []) or []

    # 1) Summary length — counted including <B>...</B> tags, since that is how
    # the prompt instructs ChatGPT to measure.
    summary_raw = str(data.get("professional_summary") or "")
    summary_len = len(summary_raw)
    if target_summary > 0:
        lo = target_summary - _SUMMARY_TOLERANCE
        hi = target_summary + _SUMMARY_TOLERANCE
        if summary_len < lo or summary_len > hi:
            issues.append(
                f"Summary length is {summary_len} chars but must be between {lo} and {hi} "
                f"(target {target_summary} ±{_SUMMARY_TOLERANCE})."
            )

    # 2) Professional experience — one entry per profile work_history item,
    # each with the configured bullet count and bullet length band.
    exp = data.get("professional_experience") or []
    if len(exp) != len(profile_history):
        issues.append(
            f"professional_experience has {len(exp)} companies but the profile has {len(profile_history)}."
        )
    for i, src in enumerate(profile_history):
        company_label = src.get("company_name") or f"company #{i+1}"
        if i >= len(exp):
            issues.append(f"Missing entry for {company_label}.")
            continue
        entry = exp[i] if isinstance(exp[i], dict) else {}
        bullets = entry.get("bullets") or []
        expected = int(target_bullet_counts[i]) if i < len(target_bullet_counts) and target_bullet_counts[i] else None
        if expected is not None and len(bullets) != expected:
            issues.append(
                f"{company_label}: returned {len(bullets)} bullets but profile requires exactly {expected}."
            )
        for j, b in enumerate(bullets):
            # Strip <B>...</B> bold-marker tags before counting. Those tags are
            # invisible markup the renderer consumes to apply bold styling; they
            # don't take any space on the page, so they should not count toward
            # the "renders as ≥ 2 lines" length check. Counting them was making
            # short bullets pass validation purely because they had a lot of
            # bold phrases, and making long-but-tag-light bullets fail when the
            # visible text was actually fine.
            visible = re.sub(r"<\s*/?\s*[bB]\s*>", "", str(b or ""))
            n = len(visible)
            if n < _BULLET_MIN_LEN_FOR_TWO_LINES:
                issues.append(
                    f"{company_label} bullet #{j+1} is only {n} visible chars (renders as 1 line); "
                    f"each bullet must be at least {_BULLET_MIN_LEN_FOR_TWO_LINES} visible chars "
                    f"(not counting <B>/</B> markup) so it wraps to 2 lines."
                )

    # 3) Technical skills — total count across all categories must match.
    if target_skills > 0:
        total_skills = 0
        for grp in data.get("technical_skills") or []:
            if not isinstance(grp, dict):
                continue
            items = grp.get("skills") or grp.get("items") or []
            total_skills += sum(1 for s in items if str(s).strip())
        # Overcount is tolerated — _resume_blob_from_json trims the tail down
        # to target_skills. Only undercount is a hard fail because we cannot
        # invent skills on the server side.
        if total_skills < target_skills:
            issues.append(
                f"technical_skills total is {total_skills} but profile requires at least {target_skills}."
            )

    if issues:
        # Cap the message length so the toast stays readable, but list the
        # first few issues so the user knows what to ask ChatGPT to fix.
        head = issues[:6]
        extra = len(issues) - len(head)
        body = " ".join(head)
        if extra > 0:
            body += f" (+{extra} more issue{'s' if extra != 1 else ''})"
        raise HTTPException(
            status_code=422,
            detail=f"JSON validation failed — retry ChatGPT with the same prompt. {body}",
        )


_BOLD_TAG_RE = re.compile(r"<\s*/?\s*[bB]\s*>")
_BOLD_PHRASE_RE = re.compile(r"<\s*[bB]\s*>(.*?)<\s*/\s*[bB]\s*>", re.DOTALL)


def _strip_bold_tags(text: str) -> str:
    """Remove <B> and </B> tags but keep the text inside them."""
    return _BOLD_TAG_RE.sub("", str(text or ""))


def _extract_bold_phrases(text: str, sink: set[str]) -> None:
    """Collect every <B>...</B> phrase into the sink set (lowercase-deduped, original casing preserved on first sight)."""
    if not text:
        return
    for m in _BOLD_PHRASE_RE.finditer(str(text)):
        phrase = m.group(1).strip()
        if len(phrase) >= 2:
            sink.add(phrase)


def _resume_blob_from_json(data: dict, profile: dict, job: dict) -> dict:
    """Map ChatGPT JSON → the dict shape consumed by build_docx_style_pdf_bundle.

    `<B>...</B>` tags ChatGPT emits get TWO things done in one pass:
      1. The wrapped phrase is added as an extra bold-keyword so the exporter
         renders it bold wherever it appears in the resume.
      2. The tags themselves are stripped from the text so they don't leak
         into the rendered PDF.
    """
    bold_phrases: set[str] = set()

    profile_history = profile.get("work_history", []) or []
    chat_experience = data.get("professional_experience", []) or []

    work_history: list[dict] = []
    for i, src in enumerate(profile_history):
        chat = chat_experience[i] if i < len(chat_experience) else {}
        bullets_raw = [str(b).strip() for b in (chat.get("bullets") or []) if str(b).strip()]
        for b in bullets_raw:
            _extract_bold_phrases(b, bold_phrases)
        bullets_clean = [_strip_bold_tags(b) for b in bullets_raw]
        work_history.append({
            "company_name": _strip_bold_tags(chat.get("company") or src.get("company_name", "")),
            "role_title":   _strip_bold_tags(chat.get("role") or src.get("role_title", "")),
            "duration":     _strip_bold_tags(chat.get("duration") or src.get("duration", "")),
            "location":     src.get("location", ""),
            "role_headline": "",
            "bullets":      bullets_clean,
        })

    # Skill groups: ChatGPT returns {skill_category, skills}; the exporter
    # expects {category, items}. Strip tags from both, collect bolds first.
    skill_groups: list[dict] = []
    flat_skills: list[str] = []
    for grp in data.get("technical_skills", []) or []:
        if not isinstance(grp, dict):
            continue
        cat_raw = str(grp.get("skill_category") or grp.get("category") or "").strip()
        items_raw = [str(s).strip() for s in (grp.get("skills") or grp.get("items") or []) if str(s).strip()]
        _extract_bold_phrases(cat_raw, bold_phrases)
        for s in items_raw:
            _extract_bold_phrases(s, bold_phrases)
        cat = _strip_bold_tags(cat_raw)
        items = [_strip_bold_tags(s) for s in items_raw]
        if cat or items:
            skill_groups.append({"category": cat, "items": items})
            flat_skills.extend(items)

    # If ChatGPT returned more skills than the profile target, trim from the
    # tail (drop the last items of the last group, dropping the entire last
    # group when emptied) until totals match. This avoids rejecting an
    # otherwise-valid resume just because ChatGPT padded a few extra skills.
    gs = profile.get("generation_settings", {}) or {}
    target_skills = int(gs.get("skills_count") or 0)
    if target_skills > 0:
        total = sum(len(g["items"]) for g in skill_groups)
        while total > target_skills and skill_groups:
            last = skill_groups[-1]
            if last["items"]:
                last["items"].pop()
                total -= 1
            if not last["items"]:
                skill_groups.pop()
        flat_skills = [s for g in skill_groups for s in g["items"]]

    # Summary: collect bolds, then strip
    summary_raw = str(data.get("professional_summary") or "").strip()
    _extract_bold_phrases(summary_raw, bold_phrases)
    summary_clean = _strip_bold_tags(summary_raw)

    # Headline: ChatGPT's professional positioning line feeds the resume's
    # title placeholder. Falls back to the candidate name (legacy behaviour)
    # when the model omits it. The name itself is static in the uploaded DOCX.
    headline_clean = _strip_bold_tags(str(data.get("headline") or "")).strip() or profile.get("name", "")

    # Use ChatGPT's bold phrases as auto-bold keywords for the exporter.
    # technical_skills is already used as a keyword list by docx_resume_export,
    # so merging the bold phrases in here means they get bolded wherever they
    # appear in summary + bullets, on top of the built-in KNOWN_TECH_TERMS.
    merged_keywords: list[str] = list(flat_skills)
    for phrase in bold_phrases:
        if phrase.lower() not in {s.lower() for s in merged_keywords}:
            merged_keywords.append(phrase)

    return {
        "headline": headline_clean,
        "summary": summary_clean,
        "technical_skills": merged_keywords,
        "skill_groups": skill_groups,
        "work_history": work_history,
        "education_history": profile.get("education_history", []) or [],
        "_job_id": data.get("job_id", ""),
        "_profile_id": data.get("profile_id", ""),
    }


@router.post("/generate-from-json")
def generate_from_json(
    body: dict,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Parse pasted JSON → save resume record → render PDF.

    Body: {"json_text": "<the pasted text from ChatGPT>"}
    """
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")

    raw = str(body.get("json_text") or "")
    data = _coerce_chatgpt_json(raw)
    _validate_resume_json(data)

    job_id = str(data.get("job_id") or "").strip()
    json_profile_id = str(data.get("profile_id") or "").strip()

    # The profile the operator actually selected in the UI is authoritative —
    # NOT the profile_id ChatGPT echoes back (which it sometimes swaps,
    # cross-wiring one candidate's content onto another's resume template).
    # If the frontend sent the selected profile, require the pasted JSON to
    # match it; otherwise fall back to the JSON's id (older clients).
    selected_profile_id = str(body.get("profile_id") or "").strip()
    profile_id = selected_profile_id or json_profile_id

    if selected_profile_id and json_profile_id and json_profile_id != selected_profile_id:
        sel = next((p for p in storage.get_profiles() if p.get("id") == selected_profile_id), None)
        jsn = next((p for p in storage.get_profiles() if p.get("id") == json_profile_id), None)
        raise HTTPException(
            status_code=400,
            detail=(
                f"Profile mismatch — this JSON was generated for "
                f"\"{(jsn or {}).get('name', json_profile_id)}\" but you have "
                f"\"{(sel or {}).get('name', selected_profile_id)}\" selected. "
                f"Re-copy the prompt for the selected profile and regenerate."
            ),
        )

    job = storage.get_job_by_id(job_id) if job_id else None
    if not job:
        raise HTTPException(status_code=400, detail=f"Job not found in DB: {job_id!r}")
    profile = next((p for p in storage.get_profiles() if p.get("id") == profile_id), None)
    if not profile:
        raise HTTPException(status_code=400, detail=f"Profile not found in DB: {profile_id!r}")
    _check_profile_access(user, profile_id)

    # Verify the pasted IDs are internally consistent (no silent crosswiring).
    job_region = str(job.get("region") or "ANY").upper()
    profile_region = str(profile.get("region") or "ANY").upper()
    if not _regions_match(job_region, profile_region):
        raise HTTPException(
            status_code=400,
            detail=f"Region mismatch: job is {job_region}, profile is {profile_region}.",
        )
    if not tech_stacks_match(job.get("description"), profile.get("tech_stacks") or []):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Tech-stack mismatch: none of this profile's skills "
                f"({', '.join(profile.get('tech_stacks') or []) or '—'}) appear in this job."
            ),
        )

    # Format validation (summary length, bullet counts/lengths, skills count)
    # is temporarily disabled. Re-enable by uncommenting the call below when
    # ready — _validate_against_profile is still defined above.
    # _validate_against_profile(data, profile)

    resume_blob = _resume_blob_from_json(data, profile, job)

    saved_resume_id = f"resume_{uuid.uuid4().hex[:10]}"
    record = {
        "saved_resume_id": saved_resume_id,
        "profile_id": profile_id,
        "job_id": job_id,
        "job_company": job.get("company", ""),
        "job_title": job.get("job_title", ""),
        "job_link": job.get("link", ""),
        "resume": resume_blob,
        "status": "generated",
        "applied_status": "pending",
        "created_at": _utcnow_iso(),
        "created_by_user_id": user.get("id", ""),
        "created_by_username": user.get("username", ""),
        "source": "chatgpt_json",
    }
    storage.save_generated_resume(record)
    background_tasks.add_task(_render_pdf_to_cache, saved_resume_id)

    return {
        "ok": True,
        "saved_resume_id": saved_resume_id,
        "job_company": job.get("company", ""),
        "job_title": job.get("job_title", ""),
    }


# ---------------------------------------------------------------------------
# Bidder Apply actions (kept from previous flow)
# ---------------------------------------------------------------------------

@router.patch("/{resume_id}")
def patch_resume(resume_id: str, payload: dict, user: dict = Depends(get_current_user)):
    if hasattr(storage, "update_generated_resume"):
        storage.update_generated_resume(resume_id, payload)
    return {"ok": True}


@router.post("/{resume_id}/apply")
def mark_applied(resume_id: str, user: dict = Depends(get_current_user)):
    if hasattr(storage, "update_generated_resume"):
        storage.update_generated_resume(resume_id, {
            "applied_status": "applied",
            "applied_at": _utcnow_iso(),
            "applied_by_user_id": user.get("id", ""),
            "applied_by_username": user.get("username", ""),
        })
    return {"ok": True}


@router.post("/{resume_id}/unapply")
def mark_unapplied(resume_id: str, user: dict = Depends(get_current_user)):
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


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------

@router.get("/{resume_id}/pdf")
def get_resume_pdf(resume_id: str, user: dict = Depends(get_current_user)):
    # A VPS_1 resume (id "vps1:<uuid>") — admins only, since only they see VPS_1 rows. We don't sync
    # every resume file hourly (thousands of renders nobody views); instead fetch from VPS_1 the first
    # time someone opens it, then cache the PDF locally so the next open is instant.
    if resume_id.startswith("vps1:"):
        if not has_role(user, "admin"):
            raise HTTPException(status_code=403, detail="Forbidden")
        remote_id = resume_id[len("vps1:"):]
        cache_file = PDF_CACHE_DIR / f"vps1_{remote_id}.pdf"
        if cache_file.exists() and cache_file.stat().st_size > 0:
            return Response(content=cache_file.read_bytes(), media_type="application/pdf")
        got = vps1_client.get_resume_file(remote_id, "pdf")
        if got and got[0]:
            content, _fn, media = got
            try:
                cache_file.write_bytes(content)      # cache for next time; a write failure just re-fetches
            except Exception:
                pass
            return Response(content=content, media_type=media or "application/pdf")
        # Couldn't fetch/render the file — hand back VPS_1's own PUBLIC resume link so the user can
        # still open it. 409 + the URL in the body; the Applied tab opens it in a new tab. (A redirect
        # would be fetched cross-origin by the blob XHR and hit CORS — a plain URL avoids that.)
        share_url = vps1_client.get_resume_share_link(remote_id, "pdf")
        if share_url:
            raise HTTPException(status_code=409, detail={"vps1_resume_url": share_url})
        raise HTTPException(status_code=502, detail="Could not fetch resume from VPS_1")

    record = storage.get_generated_resume_by_id(resume_id) if hasattr(storage, "get_generated_resume_by_id") else None
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found")
    _check_profile_access(user, record.get("profile_id", ""))

    cache_file = PDF_CACHE_DIR / f"{resume_id}.pdf"
    if cache_file.exists() and cache_file.stat().st_size > 0:
        return Response(content=cache_file.read_bytes(), media_type="application/pdf")

    cached = _render_pdf_to_cache(resume_id, raise_errors=True)
    if cached and cached.exists() and cached.stat().st_size > 0:
        return Response(content=cached.read_bytes(), media_type="application/pdf")
    raise HTTPException(status_code=500, detail="PDF render failed")
