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
from core.ats_score import analyze_ats_score
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

_BID_ACTIONS = {"copy_prompt", "generate", "download", "open_link", "mark_applied", "report", "skip", "autofill"}
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


def _resume_on_visible_call(user: dict, resume_id: str) -> bool:
    """Does an interview this user may SEE reference this resume?

    The Schedule button puts the resume link (/api/resumes/<id>/pdf) on the board's Resume cell, so the
    caller assigned to that call has to be able to open it — but they are NOT assigned the profile (a
    caller makes the call, they don't own the persona), so _check_profile_access alone 403s them. This
    grants access strictly through a call they can already see: no wider than the board itself.
    """
    from routers.interviews import _visibility
    can_see = _visibility(user)
    needle = f"/api/resumes/{resume_id}/pdf"
    for row in storage.get_interview_rows():
        if not can_see(row):
            continue
        if str((row.get("cells") or {}).get("c_resume", "")).strip() == needle:
            return True
    return False


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

    # Lightweight index (json_extract in SQL) — never pulls the ~40 MB of resume blobs into Python.
    for r in storage.get_applied_resume_index():
        pid = r.get("profile_id") or ""
        if allowed_pids is not None and pid not in allowed_pids:
            continue

        # facets (built from the full applied set this user can see)
        if pid in profiles:
            facet_profiles[pid] = profiles[pid].get("name", "")
        who = (r.get("applied_by") or r.get("created_by") or "").strip()
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
            "job_id": r.get("job_id") or "",
            "job_company": r.get("job_company") or "",
            "job_title": r.get("job_title") or "",
            "job_link": r.get("job_link") or "",
            "job_region": r.get("job_region") or "",
            "profile_id": pid,
            "profile_name": profiles.get(pid, {}).get("name", ""),
            "bidder": who,
            "applied_at": r.get("applied_at") or "",
            "created_at": r.get("created_at") or "",
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




def _biddable_jobs() -> list[dict]:
    """The approved, recent, un-flagged jobs — the profile-independent part of the
    Bid queue. Computed once so bid_profiles can reuse it across every profile
    instead of re-scanning all jobs (thousands) per profile.

    Fast path: the DB filters to approved (indexed status) so pending/rejected rows
    are never normalized, and the deadline window is read ONCE — previously
    _is_recent_job called get_app_settings() per job, hitting settings thousands of
    times (~2.4s). The recent-window filter then trims ~3k approved jobs to the
    handful still open."""
    hours = deadline_hours()
    out: list[dict] = []
    for job in storage.get_jobs(include_pending=False):
        if job.get("flagged") or job.get("admin_applied"):
            continue
        if not job.get("id"):
            continue
        if not _is_recent_job(job, hours=hours):
            continue
        out.append(job)
    return out


def _eligible_bid_items(
    profile: dict,
    *,
    jobs: list[dict] | None = None,
    resumes: list[dict] | None = None,
) -> list[dict]:
    """Unified Bid queue for one profile: approved, region- + tech-stack-matched,
    within-deadline jobs the profile has NOT applied to yet. Each item carries an
    existing résumé id (when one was already generated) so the Bid card can skip
    straight to Download instead of regenerating.

    `jobs` (from _biddable_jobs) and `resumes` (from storage.get_generated_resumes)
    may be passed in so a caller processing many profiles fetches each ONCE rather
    than re-querying the DB per profile — the source of the slow Bid tab load."""
    pid = profile.get("id", "")
    p_region = str(profile.get("region") or "ANY").upper()
    p_stacks = profile.get("tech_stacks") or []

    latest_by_job: dict[str, dict] = {}
    applied_jobs: set[str] = set()
    # Only this profile's resumes are needed. When the caller didn't pre-fetch a
    # shared list, query by the indexed profile_id (≈50 rows) instead of loading
    # every generated resume (~3.8k rows / ~1.8s) — the slow Bid tab's main cost.
    profile_resumes = resumes if resumes is not None else storage.get_generated_resumes_for_profile(pid)
    # Jobs a bidder skipped for this profile ("Skip job") never come back to it.
    applied_jobs |= storage.skipped_bid_job_ids(pid)
    for r in profile_resumes:
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
    for job in (jobs if jobs is not None else _biddable_jobs()):
        jid = job.get("id") or ""
        if not jid or jid in applied_jobs:
            continue  # already applied for this profile
        if not _regions_match(str(job.get("region") or "ANY").upper(), p_region):
            continue
        if not tech_stacks_match(job.get("description"), p_stacks):
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
            "ats_score": (existing or {}).get("ats_score", 0),
            "ats": (existing or {}).get("ats") or None,
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
    # Fetch the biddable-jobs list ONCE and reuse it for every profile (previously
    # each profile re-scanned all ~3.4k jobs). Each profile's resumes are fetched
    # via the indexed profile_id column (≈50 rows each) rather than deserializing
    # all ~3.8k generated resumes per profile — together this took the Bid tab load
    # from ~20s to well under a second.
    jobs = _biddable_jobs()
    out = [
        {
            **_bid_public_profile(p),
            "bid_count": len(_eligible_bid_items(
                p, jobs=jobs, resumes=storage.get_generated_resumes_for_profile(p.get("id", "")),
            )),
        }
        for p in profiles
    ]
    return {"role": "admin" if user.get("is_admin") else "bidder", "profiles": out}


@router.get("/bid")
def bid_queue(profile_id: str, user: dict = Depends(get_current_user)):
    """The ordered Bid queue (jobs to bid) for one profile."""
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    _check_profile_access(user, profile_id)
    items = _eligible_bid_items(_get_profile(profile_id))
    infos = storage.company_info_for_names([it["company"] for it in items])
    for it in items:
        it["company_info"] = infos.get(it["company"])
    return items


@router.post("/bid/skip")
def bid_skip(body: dict, user: dict = Depends(get_current_user)):
    """Skip a job for one profile — it leaves that profile's Bid queue for good
    (other profiles still see it). Body: {profile_id, job_id}."""
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    profile_id = str((body or {}).get("profile_id") or "").strip()
    job_id = str((body or {}).get("job_id") or "").strip()
    if not profile_id or not job_id:
        raise HTTPException(status_code=400, detail="profile_id and job_id are required")
    _check_profile_access(user, profile_id)
    if not storage.get_job_by_id(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    storage.skip_bid_job(profile_id, job_id, user_id=user.get("id", ""), username=user.get("username", ""))
    return {"ok": True}


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
        "company_info": storage.company_info_for_names([job.get("company", "")]).get(job.get("company", "")),
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


# ---------------------------------------------------------------------------
# ChatGPT prompt (ported verbatim from VPS1's manual "chatGPT mode" flow).
# The operator copies this into ChatGPT and pastes the returned JSON back into
# generate-from-json. The prompt is fully self-contained — the whole spec lives
# here, so there is no separate admin prompt-template setting. Sentinel tokens
# {{TECH_MIN}} etc. are substituted below (str.replace, not .format(), because
# the JSON skeleton is full of literal braces).
# ---------------------------------------------------------------------------
_CHATGPT_PROMPT_TEMPLATE = """You are an expert resume writer. Build a single JSON object that this app will feed directly into a DOCX/PDF template. Output the JSON inside ONE ```json fenced code block (so it renders with a copy button) and nothing else — no commentary before or after.

INPUTS
- TARGET ROLE: {{TARGET_ROLE}}
- FIXED WORK HISTORY (use these companies and durations exactly — do NOT invent, reorder, or skip):
{{COMPANY_BLOCK}}
- JOB DESCRIPTION:
{{JOB_DESCRIPTION}}

METHOD — perform this analysis silently before writing; do NOT include it in the output:
1. JOB DESCRIPTION ANALYSIS — extract every technology and theme and split into: (A) Required/must-have technologies across ALL layers (language, frontend, backend, database, cloud, DevOps, testing, auth, observability, messaging, AI); (B) Preferred/nice-to-have; (C) Engineering themes (architecture, scale, APIs, performance, CI/CD, testing, reliability, security); (D) Domain/workflow signals (product type, integrations, team structure). FIRST identify the PRIMARY stack — the language/framework the JD presents as its main stack (e.g. "our stack is Ruby on Rails", or the first/most-emphasized required technology). Languages or frameworks the JD offers only as acceptable ALTERNATIVES ("or Python/TypeScript works too", "willing to learn", "nice to have") are SECONDARY, not the lead — even if the candidate's background leans toward them.
2. STACK EXPANSION — expand the required stack into a complete, realistic production environment by adding strongly-adjacent frameworks, libraries, infrastructure, and testing/operational tooling until technical_skills reaches the target. Only include tools strongly adjacent to the required stack; no generic terms.
3. EXPERIENCE MAPPING — map the work history to the requirements as a believable career arc: thread the candidate's core competency through all roles, but using ERA-APPROPRIATE tools for each role's dates, deepening seniority and broadening the stack toward the present. Use exact matches first, then adjacent/related experience to cover required themes (e.g. if a role used REST APIs, surface OpenAPI/Swagger when the JD asks for it). Do NOT repeat the same modern stack in every role; reserve the newest tools for recent roles and keep early roles foundational.
4. SCENARIO ASSIGNMENT — before writing any bullet, silently give EACH company a DIFFERENT engineering scenario by picking a distinct combination along these axes (see HARD RULE 16): product/domain context, core problem, system shape, team/ownership mode, and supporting tech mix. Then spread the JD's themes ACROSS the arc so each theme lands in the one or two companies where it fits best — never repeat every theme in every company. Sanity-check: if two companies' bullets could be swapped without anyone noticing, redo the assignment.

OUTPUT — return ONE JSON object, wrapped in a single ```json fenced code block, with EXACTLY these top-level keys:
{
  "headline": string,            // The CANDIDATE'S professional identity — NOT the employer's product. Format "<Standard Role Title> | <Technical Specialization>", Title Case, ~4–8 words. (a) The ROLE TITLE must be a standard industry title, chosen from: Senior Software Engineer, Senior Backend Engineer, Senior Frontend Engineer, Senior Full Stack Engineer, Senior Platform Engineer, Senior Data Engineer, Senior DevOps Engineer, Senior Machine Learning Engineer, Staff Software Engineer, Principal Software Engineer. Pick the one closest to TARGET ROLE and let the work history set the seniority. NEVER coin a title out of the employer's product, feature, or business domain, and never copy the posting's literal title or level suffix. BAD: "Assessment Software Engineer", "Front End Software Engineer II", "Payments Platform Engineer". (b) The SPECIALIZATION must be an ENGINEERING domain grounded in the primary technical stack — never the employer's product, feature, or business domain. BAD: "AI-Enabled Technical Evaluation", "Platform UI Experiences", "Python Serverless Data Platforms". GOOD: "Senior Backend Engineer | Distributed Systems & APIs", "Senior Frontend Engineer | Design Systems & Web Performance", "Senior Full Stack Engineer | Cloud-Native Web Applications", "Senior Software Engineer | Scalable Backend & Cloud Infrastructure". Litmus test: the headline must still make sense on the candidate's LinkedIn a year from now, at a different company in a different industry. Not a sentence, no first person, no team/product names, no trailing tech list
  "summary": string,             // 3–4 polished sentences (~50–80 words), confident third person, no first-person pronouns. Open with seniority and EXACTLY {{YEARS}} years of experience (use this exact number — do NOT invent a different figure), then domains and senior ownership of production systems, then the specialization angle. Weave in 3–5 of the JD's most important REQUIRED technologies as natural prose — no long comma-separated lists, and no raw tokens/shorthand (write "JavaScript" not "JS(ES+)", "SQL Server development" not "MS SQL objects")
  "technical_skills": string[],  // EXACTLY {{TECH_MIN}}–{{TECH_MAX}} unique technologies/tools (target ≈ {{TECH_TARGET}}); broad coverage across languages, frameworks, databases, cloud, infra, testing, observability, data, security; specific items only (e.g. "PostgreSQL", "FastAPI"), not vague ("Backend")
  "skill_groups": [              // 6–10 groups (more groups for the wider skill list), each item appears in technical_skills, no duplicates across groups
    { "category": string, "items": string[] }
  ],
  "fit_keywords": string[],      // UP TO 18 keywords lifted from the JD that the resume must satisfy
  "work_history": [              // EXACTLY one entry per company in FIXED WORK HISTORY, in the same order; company_index = 0 is the FIRST listed company
    {
      "company_index": number,   // 0-based, matches the FIXED WORK HISTORY order
      "company_name": string,    // copy verbatim from FIXED WORK HISTORY
      "role_title": string,      // tuned to TARGET ROLE; do not fabricate seniority
      "role_headline": string,   // OR "" — short tagline; leave "" if unsure
      "duration": string,        // copy verbatim from FIXED WORK HISTORY
      "location": string,        // OR "" — leave "" if unsure
      "bullets": string[]        // count controlled by FIXED WORK HISTORY ("EXACTLY N bullets" per company). Each bullet = a concrete piece of engineering work inside THIS company's assigned scenario (see HARD RULE 16): the problem or system, what was built/decided, and the outcome. Name only technologies that are era-appropriate for THIS role — do NOT force the JD's stack into every bullet; the JD's primary stack should dominate the RECENT roles and thin out in older ones. Show senior signals (architecture, ownership, trade-offs, performance, reliability, testing, CI/CD, observability) — but introduce them gradually along the arc, not in every role. NEVER include percentages or "%" anywhere; no "Responsible for"; max ~28 words; no trailing period required
    }
  ],
  "education_history": [
    { "institution": string, "degree": string, "field": string, "graduation_date": string }
  ]
}

HARD RULES
1. Output ONLY the JSON object, inside ONE ```json ... ``` fenced code block — nothing before the opening fence and nothing after the closing fence. No preamble, no explanation, no extra markdown.
2. Use double quotes for every key and string. No trailing commas.
3. work_history MUST contain exactly one entry per company listed in FIXED WORK HISTORY, in the same order, with company_name and duration copied verbatim.
4. Bullets per company MUST match the count specified next to each company in FIXED WORK HISTORY — exact, not approximate.
5. Weave JD vocabulary (frameworks, methodologies, domain terms) naturally into summary + bullets. Cover every required item from fit_keywords across the resume body.
6. technical_skills count MUST be between {{TECH_MIN}} and {{TECH_MAX}} inclusive (aim for ≈ {{TECH_TARGET}}). Group every listed skill into exactly one skill_groups entry — no skill may appear in two groups.
7. NEVER include percentages or the "%" character in any bullet, summary, or headline. No "reduced X by 30%", no "improved performance 25%", no "boosted by 40%". The character "%" must not appear anywhere in the JSON. Quantify with absolute numbers only when natural (e.g., "served 12 million requests/day", "shipped 4 production services"); otherwise lead with action and qualitative impact.
8. RELEVANT — NOT A MIRROR OF THE JD. You do not have the candidate's actual achievements, so write strong bullets a senior practitioner could credibly own. But do NOT restate the job description's responsibilities back as their history, and do NOT make any SINGLE role a 100% match to the posting. The experience must be ADJACENT and TRANSFERABLE: the same class of engineering problems and the same technical depth, solved in DIFFERENT products, domains, and contexts than the JD's. A believable senior has deep relevant experience PLUS neighboring experience that is clearly not a carbon copy of this one JD. GROUND each role in its REAL company from FIXED WORK HISTORY: infer that company's likely industry and product from its name and write a scenario that fits a company of that kind (a fintech, a healthcare SaaS, an agency, a gaming studio, an enterprise integrator, etc.), so the arc reads like real, distinct employers — never as the same JD retold four times. A reader should conclude "this person has already solved comparable or harder problems elsewhere, so they can clearly do this job" — never "this reads like the job posting rewritten in past tense." Do not reuse the JD's phrasing, feature names, or product vocabulary as if it were the candidate's past work.
9. Do NOT include any field besides the seven listed above. Do NOT include comments inside the JSON.
10. If a section has no real data (e.g. no formal degree), use an empty array — not placeholder strings.
11. headline and summary must read as polished professional copy, not keyword dumps. The headline describes the CANDIDATE (standard engineering title + technical specialization joined by " | "), NEVER the employer's product or business domain — do not coin a title or a specialization out of what the company sells (no "Assessment Software Engineer", no "AI-Enabled Technical Evaluation", no "Platform UI Experiences"), and never use the posting's literal title or a level suffix ("II"/"III"). The summary is confident third-person prose that weaves in only a few technologies naturally. NEVER put raw tokens or internal shorthand such as "JS(ES+)", "MS SQL objects", or "Transact SQL objects" in the headline or summary — use clean professional terms (JavaScript, SQL Server development, stored procedures).
12. Spread the JD's core competencies across roles AS A BELIEVABLE CAREER PROGRESSION — not the same resume repeated. Seniority, scope, and ownership must GROW toward the present: early roles are hands-on/foundational (implementing, testing, supporting), mid roles add design and cross-team work, recent roles add architecture, then leadership and mentoring. Each company must have a DISTINCT focus and a largely DIFFERENT supporting-technology mix; never reuse the same tech set or sentence structures from one company to the next.
13. RESPECT TECHNOLOGY TIMELINES — be realistic about when each tool existed. Only use technologies that were actually available and in common use during a role's dates; never place a framework, library, platform, or AI tool in a job that ended before that tool was released or widely adopted. Gate by real-world MAINSTREAM-ADOPTION years, for example: AngularJS ~2012, React ~2014, Angular(2+) ~2016, Vue ~2016, Node.js ~2011, TypeScript ~2014, Next.js ~2017, Tailwind CSS ~2019, Docker ~2014, Kubernetes ~2016, GraphQL ~2016, FastAPI ~2019, Spring Boot ~2014, Terraform ~2015, serverless/AWS Lambda ~2016, and most LLM/AI tooling ~2022+. For a role whose dates predate a required tool, DO NOT name that tool in that role — substitute the predecessor that was actually dominant then: jQuery / Backbone / AngularJS instead of React before ~2014; server-rendered PHP / Java / .NET / Rails instead of modern serverless; SVN before Git's mainstream dominance; jQuery AJAX / XMLHttpRequest before fetch/axios; hand-rolled scripts or Jenkins before GitHub Actions; on-prem or early EC2 before managed Kubernetes. Reserve the newest tools for the most recent roles; the earliest roles should read as junior/foundational with period-correct tools, not as a senior architect using a cutting-edge stack. A reviewer who checks each role's dates must find EVERY named technology plausible for that exact period.
14. Required technologies must DOMINATE the Technical Skills section and thread through Experience; include preferred technologies only when relevant. Across all roles the bullets should collectively cover the JD's key engineering themes (architecture, APIs, performance, testing, CI/CD, observability, security) wherever the JD calls for them — but introduced gradually along the progression, not all at once in every role.
15. LEAD WITH THE PRIMARY STACK. The summary and the MAJORITY of RECENT experience bullets must foreground the JD's primary language/framework as the candidate's core expertise (e.g. for a "Ruby on Rails" JD, lead with Ruby on Rails — not Python/TypeScript). Acceptable ALTERNATIVE languages and nice-to-haves ("or Python/TypeScript works too", "willing to learn") appear only as SECONDARY supporting skills, never as the dominant thread, and are listed AFTER the primary stack in Technical Skills. Do not let a secondary/alternative language dominate just because it is also mentioned or fits the candidate's background. In EARLY roles use that era's predecessors instead — the primary stack should thread the arc, not be pasted into every bullet.
16. GIVE EVERY COMPANY A DISTINCT SCENARIO. Each company must read like a different job at a different kind of business. Vary these axes so no two companies overlap: (a) PRODUCT/DOMAIN CONTEXT — internal platform, customer-facing SaaS, data/ETL pipeline, marketplace, B2B integration, legacy modernization, greenfield build, developer tooling; (b) CORE PROBLEM — scale/throughput, latency, reliability and incidents, data correctness, developer velocity, cost, security/compliance, migration; (c) SYSTEM SHAPE — monolith, service extraction, event-driven, batch vs streaming, API platform, SDK/library; (d) TEAM/OWNERSHIP MODE — sole owner, embedded in a squad, cross-team lead, mentor, on-call owner; (e) SUPPORTING TECH MIX — largely different per company; only the ONE core competency thread may recur. Every bullet in a company must belong to THAT company's scenario. Never reuse another company's problem framing, tech set, or bullet pattern.
17. VARY THE LANGUAGE. No two bullets anywhere in the resume may open with the same verb. No two companies may share the same sentence rhythm or bullet template. Deliberately mix bullet shapes: some open with the problem, some with the system built, some with a decision or trade-off, some with the operational outcome, some with scope/ownership. Do NOT repeat a uniform "Verb + JD technology + to + benefit" formula across the resume — that is the most common failure mode and it makes every company read identically.
18. SHAPE THE RESUME AROUND THIS CANDIDATE — NOT A TEMPLATE. Several different candidates are tailored to this same job and their resumes may be read side by side, so the resume must be driven by THIS candidate's own companies, durations, and era — never a generic JD-shaped skeleton. Let the specific company scenarios and the era gating (RULES 8, 13, 16) do the differentiating, and additionally vary the SUMMARY's opening strategy (lead with a signature strength, OR the span of industries worked in, OR seniority + years), the headline's specialization angle, and the ordering of skill_groups. Two different candidates for this job must NOT produce the same summary skeleton, the same headline shape, or the same first-bullet pattern.

Return the JSON now, inside a single ```json fenced code block."""


# A detected/work-history "company" that is really an EDUCATION line (e.g.
# "Baylor University … | Bachelor's Degree in Computer Science") or a leftover
# template placeholder must never seed the FIXED WORK HISTORY — ChatGPT would then
# generate a single fake "Computer Science Student" role. This guards the prompt.
_NOT_A_COMPANY_RE = re.compile(
    r"(?i)\b(university|college|institute|bachelor|master|degree|__role__|__headline__)\b"
)


def _looks_like_real_company(name: str, duration: str = "") -> bool:
    txt = f"{name} {duration}"
    if not str(name or "").strip():
        return False
    return not _NOT_A_COMPANY_RE.search(txt)


def _prompt_companies(profile: dict) -> list[dict]:
    """The FIXED WORK HISTORY companies that seed the prompt. Prefer the
    DOCX-detected list (VPS1 flow), but fall back to the profile's own
    work_history — and crucially use whichever source has MORE valid companies,
    so a corrupted single detected entry (e.g. an education line mis-parsed as a
    company) never overrides a clean multi-company work_history."""
    gs = profile.get("generation_settings", {}) or {}
    default_bullets = int(gs.get("bullets_per_company_default") or 5)
    overrides = {
        str(o.get("company_name") or "").strip().lower(): int(o.get("bullets") or default_bullets)
        for o in (gs.get("bullets_per_company") or []) if isinstance(o, dict)
    }

    def _from_detected() -> list[dict]:
        out: list[dict] = []
        for item in profile.get("detected_work_history") or []:
            name = str(item.get("company_name") or "").strip()
            duration = str(item.get("duration") or "").strip()
            if not _looks_like_real_company(name, duration):
                continue
            bullets = int(item.get("bullets") or 0) or overrides.get(name.lower()) or default_bullets
            out.append({"company_name": name, "duration": duration, "bullets": bullets})
        return out

    def _from_work_history() -> list[dict]:
        bullet_counts = gs.get("bullet_counts", []) or []
        out: list[dict] = []
        for i, w in enumerate(profile.get("work_history", []) or []):
            name = str(w.get("company_name") or "").strip()
            duration = str(w.get("duration") or "").strip()
            if not _looks_like_real_company(name, duration):
                continue
            bullets = int(bullet_counts[i]) if i < len(bullet_counts) and bullet_counts[i] else default_bullets
            out.append({"company_name": name, "duration": duration, "bullets": bullets})
        return out

    detected = _from_detected()
    work = _from_work_history()
    # Use whichever source yields more real companies. work_history is the reliable
    # structured field; detected is a best-effort DOCX parse, so ties go to work_history.
    return detected if len(detected) > len(work) else work


def _build_prompt(profile: dict, job: dict) -> str:
    """Assemble VPS1's self-contained ChatGPT prompt, with the target role, the
    FIXED WORK HISTORY block, and the job description filled in."""
    gs = profile.get("generation_settings", {}) or {}
    tech_target = int(gs.get("tech_skills_target") or 70)
    tech_min = max(40, tech_target - 5)
    tech_max = tech_target + 5
    # The candidate's real years of experience — differs per profile. Injected into
    # the summary instruction so ChatGPT stops writing a hardcoded "8 years" for
    # everyone. Falls back to 8 only when the profile has no value set.
    try:
        years = int(profile.get("total_years_of_experience") or 0)
    except (TypeError, ValueError):
        years = 0
    if years <= 0:
        years = 8

    companies = _prompt_companies(profile)
    if companies:
        company_block = "\n".join(
            f"  {idx}. {c['company_name']}"
            + (f" · {c['duration']}" if c.get("duration") else "")
            + f"  →  EXACTLY {c['bullets']} bullets"
            for idx, c in enumerate(companies)
        )
    else:
        company_block = "  (no companies detected yet — upload a DOCX in the profile first)"

    role = str(job.get("job_title") or "").strip() or '<<<paste target role here, e.g. "Senior Backend Engineer">>>'
    jd = str(job.get("description") or "").strip() or "<<<paste the job description here>>>"

    return (
        _CHATGPT_PROMPT_TEMPLATE
        .replace("{{TARGET_ROLE}}", role)
        .replace("{{COMPANY_BLOCK}}", company_block)
        .replace("{{JOB_DESCRIPTION}}", jd)
        .replace("{{TECH_MIN}}", str(tech_min))
        .replace("{{TECH_MAX}}", str(tech_max))
        .replace("{{TECH_TARGET}}", str(tech_target))
        .replace("{{YEARS}}", str(years))
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
    return {"prompt": _build_prompt(profile, job)}


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


def _coerce_pasted_resume(raw: dict) -> dict:
    """Coerce the pasted ChatGPT JSON (VPS1's 7-key shape) into the internal blob
    the DOCX/PDF exporter consumes, WITHOUT rewriting content — only enforce
    field types/defaults. Ported from VPS1's _coerce_pasted_resume.

    7 keys in: headline, summary, technical_skills[], skill_groups[{category,items}],
    fit_keywords[], work_history[{company_index,company_name,role_title,role_headline,
    duration,location,bullets[]}], education_history[{institution,degree,field,graduation_date}].
    """
    def _s(x) -> str:
        return str(x).strip() if x is not None else ""

    def _slist(x) -> list:
        if not isinstance(x, list):
            return []
        return [_s(item) for item in x if _s(item)]

    work_raw = raw.get("work_history") if isinstance(raw.get("work_history"), list) else []
    work_history: list[dict] = []
    for idx, item in enumerate(work_raw):
        if not isinstance(item, dict):
            continue
        try:
            company_index = int(item.get("company_index", idx))
        except Exception:
            company_index = idx
        work_history.append({
            "company_index": company_index,
            "company_name": _s(item.get("company_name")),
            "role_title": _s(item.get("role_title")),
            "role_headline": _s(item.get("role_headline")),
            "duration": _s(item.get("duration")),
            "location": _s(item.get("location")),
            "bullets": _slist(item.get("bullets")),
        })

    edu_raw = raw.get("education_history") if isinstance(raw.get("education_history"), list) else []
    education_history: list[dict] = []
    for item in edu_raw:
        if not isinstance(item, dict):
            continue
        education_history.append({
            "institution": _s(item.get("institution")),
            "degree": _s(item.get("degree")),
            "field": _s(item.get("field")),
            "graduation_date": _s(item.get("graduation_date")),
        })

    sg_raw = raw.get("skill_groups") if isinstance(raw.get("skill_groups"), list) else []
    skill_groups: list[dict] = []
    for grp in sg_raw:
        if not isinstance(grp, dict):
            continue
        items = _slist(grp.get("items"))
        category = _s(grp.get("category"))
        if category and items:
            skill_groups.append({"category": category, "items": items})

    return {
        "headline": _s(raw.get("headline")),
        "summary": _s(raw.get("summary")),
        "technical_skills": _slist(raw.get("technical_skills")),
        "skill_groups": skill_groups,
        "fit_keywords": _slist(raw.get("fit_keywords")),
        "work_history": work_history,
        "education_history": education_history,
    }


def _missing_required_resume_fields(resume: dict) -> list:
    """VPS1's required-field check on the coerced blob."""
    missing: list[str] = []
    if not resume.get("headline"):
        missing.append("headline")
    if not resume.get("summary"):
        missing.append("summary")
    if not resume.get("technical_skills"):
        missing.append("technical_skills")
    if not resume.get("work_history"):
        missing.append("work_history")
    else:
        if not any(item.get("bullets") for item in resume["work_history"]):
            missing.append("work_history bullets")
    return missing




@router.post("/generate-from-json")
def generate_from_json(
    body: dict,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Parse pasted ChatGPT JSON (VPS1's 7-key shape) → save resume record → render PDF.

    Body: {"json_text": "<pasted text>", "profile_id": "<selected>", "job_id": "<selected>"}

    The job and profile come from the BODY (what the operator selected in the UI),
    NOT from the pasted JSON — VPS1's prompt no longer echoes ids, and trusting the
    UI selection also removes the old crosswiring risk.
    """
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")

    raw = str(body.get("json_text") or "")
    data = _coerce_chatgpt_json(raw)
    resume_blob = _coerce_pasted_resume(data)
    missing = _missing_required_resume_fields(resume_blob)
    if missing:
        raise HTTPException(status_code=400, detail=f"Pasted JSON is missing required fields: {', '.join(missing)}")

    job_id = str(body.get("job_id") or data.get("job_id") or "").strip()
    profile_id = str(body.get("profile_id") or data.get("profile_id") or "").strip()

    job = storage.get_job_by_id(job_id) if job_id else None
    if not job:
        raise HTTPException(status_code=400, detail=f"Job not found in DB: {job_id!r}")
    profile = next((p for p in storage.get_profiles() if p.get("id") == profile_id), None)
    if not profile:
        raise HTTPException(status_code=400, detail=f"Profile not found in DB: {profile_id!r}")
    _check_profile_access(user, profile_id)

    # Keep VPS2's guards: the selected profile must fit this job's market + stack.
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

    # Education is preserved from the profile (VPS1 flow: never rendered from the
    # pasted JSON — the profile/template owns education).
    resume_blob["education_history"] = profile.get("education_history", []) or []

    # VPS1's ATS score (keyword / title / skills / experience / structure / fit).
    ats = analyze_ats_score(resume_blob, job.get("description", "") or "", target_role=job.get("job_title", ""))

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
        "ats_score": int(ats.get("overall_score", 0) or 0),
        "ats": ats,
    }
    storage.save_generated_resume(record)
    background_tasks.add_task(_render_pdf_to_cache, saved_resume_id)

    return {
        "ok": True,
        "saved_resume_id": saved_resume_id,
        "job_company": job.get("company", ""),
        "job_title": job.get("job_title", ""),
        "ats_score": record["ats_score"],
        "ats": ats,
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
    # Admin, or a bidder assigned this profile — OR a caller/manager for whom this resume sits on a
    # call they can see (the Schedule button links it onto the board). Without that last clause the
    # assigned caller can't open the very resume they're calling about.
    if not has_role(user, "admin") \
            and record.get("profile_id", "") not in (user.get("assigned_profile_ids") or []) \
            and not _resume_on_visible_call(user, resume_id):
        raise HTTPException(status_code=403, detail="Forbidden")

    cache_file = PDF_CACHE_DIR / f"{resume_id}.pdf"
    if cache_file.exists() and cache_file.stat().st_size > 0:
        return Response(content=cache_file.read_bytes(), media_type="application/pdf")

    cached = _render_pdf_to_cache(resume_id, raise_errors=True)
    if cached and cached.exists() and cached.stat().st_size > 0:
        return Response(content=cached.read_bytes(), media_type="application/pdf")
    raise HTTPException(status_code=500, detail="PDF render failed")
