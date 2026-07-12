"""Jobs CRUD."""
from __future__ import annotations

import threading
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from auth import get_current_user, require_role, storage

# Both admins and job_adders can manage jobs.
require_jobs_access = require_role("admin", "job_adder")
from schemas import JobUpsertRequest

try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover
    _ET = timezone(timedelta(hours=-5))  # type: ignore[arg-type]


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _et_date_to_utc(date_str: str, *, end: bool = False) -> datetime | None:
    """Interpret a 'YYYY-MM-DD' string as an ET calendar date and return the
    naive-UTC datetime for its start (or the start of the NEXT day if end)."""
    s = str(date_str or "").strip()
    if not s:
        return None
    try:
        y, m, d = (int(x) for x in s.split("-"))
        et_midnight = datetime(y, m, d, tzinfo=_ET)
    except (ValueError, TypeError):
        return None
    if end:
        et_midnight = et_midnight + timedelta(days=1)
    return et_midnight.astimezone(timezone.utc).replace(tzinfo=None)


# Guards against overlapping manual + scheduled sync runs.
_sync_lock = threading.Lock()


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


def _check_company_week(payload: dict, exclude_job_id: str = "") -> None:
    """Enforce one job per company per region per month. Raises 409 if this
    company already has an active job in the same region within the dedup window
    (storage.COMPANY_DEDUP_DAYS, currently one month)."""
    recent = storage.find_recent_company_job(
        payload.get("company", ""), payload.get("region", ""),
        exclude_job_id=exclude_job_id,
    )
    if recent:
        raise HTTPException(
            status_code=409,
            detail={
                "kind": "company_week",
                "message": (
                    f"{recent.get('company','')} already has a job this month "
                    f"({recent.get('job_title','')}). Only one job per company per "
                    f"region is accepted within one month."
                ),
                "existing_id":      recent.get("id", ""),
                "existing_company": recent.get("company", ""),
                "existing_title":   recent.get("job_title", ""),
            },
        )


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs(
    status: str = Query(""),
    region: str = Query(""),
    company: str = Query(""),
    q: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    reported: bool = Query(False),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    """Paginated, server-side-filtered jobs for the Jobs tab.

    Returns {jobs, total, page, page_size, counts}. The `jobs` list omits the
    heavy description/note fields — GET /api/jobs/{id} returns the full row.
    Pass reported=true to show only flagged (reported) jobs for review.
    """
    # Job-adders only see jobs they uploaded; admins see every job.
    created_by = "" if user.get("is_admin") else user.get("id", "")
    return storage.query_jobs(
        status=status,
        region=region,
        company=company,
        q=q,
        date_from=_et_date_to_utc(date_from),
        date_to=_et_date_to_utc(date_to, end=True),
        reported=reported,
        created_by=created_by,
        page=page,
        page_size=page_size,
    )


@router.post("/sync-now")
async def sync_now(user: dict = Depends(require_role("admin"))):
    """Trigger an immediate job-sync fetch from the remote server. Admin only.

    Runs the same `sync_once()` the background poller runs, in a threadpool so
    the event loop isn't blocked. A lock prevents overlap with the scheduled
    cycle or a double-click."""
    if not _sync_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A sync is already running — try again in a moment.")
    try:
        from core import job_sync
        result = await run_in_threadpool(job_sync.sync_once)
        return {"ok": True, **(result or {})}
    except Exception as exc:  # surface the failure to the toast
        raise HTTPException(status_code=502, detail=f"Sync failed: {exc}")
    finally:
        _sync_lock.release()


@router.get("/{job_id}")
def get_job(job_id: str, user: dict = Depends(get_current_user)):
    job = storage.get_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Not found")
    # Job-adders can only open jobs they uploaded; admins can open any.
    if not user.get("is_admin") and job.get("created_by_user_id") != user.get("id"):
        raise HTTPException(status_code=404, detail="Not found")
    return job


@router.post("")
def create_job(body: JobUpsertRequest, user: dict = Depends(require_jobs_access)):
    payload = dict(body.payload)
    _check_duplicate(payload)
    _check_company_week(payload)
    # Reject blacklisted jobs up-front so the toast shows the real reason
    # (domain / title keyword / company) instead of a misleading "saved".
    reason = storage.job_block_reason(payload)
    if reason is not None:
        raise HTTPException(
            status_code=422,
            detail=f"Blocked — {reason} (Settings → Blacklist).",
        )
    if not payload.get("id"):
        payload["id"] = storage.make_id("job")
    payload.setdefault("created_by_user_id", user["id"])
    payload.setdefault("created_by_username", user.get("username", ""))
    now = _utcnow()
    payload.setdefault("submitted_at", now)
    # Manually-added jobs go live as approved (job_adders included).
    payload.setdefault("status", "approved")
    if payload.get("status") == "approved":
        payload.setdefault("approved_at", now)
        payload.setdefault("approved_by_user_id", user["id"])
        payload.setdefault("approved_by_username", user.get("username", ""))
    if not storage.upsert_job(payload):
        # Defensive — blacklist could change between the check above and now.
        raise HTTPException(status_code=422, detail="Blocked by blacklist.")
    return storage.get_job_by_id(payload["id"]) or {"id": payload["id"]}


@router.patch("/{job_id}")
def update_job(job_id: str, body: JobUpsertRequest, user: dict = Depends(require_jobs_access)):
    patch = dict(body.payload)
    # When the edit touches a duplicate-relevant field, check against the
    # rest of the table (but allow the row to keep its own values).
    if any(k in patch for k in ("link", "company", "job_title")):
        merged = dict(storage.get_job_by_id(job_id) or {})
        merged.update(patch)
        _check_duplicate(merged, exclude_job_id=job_id)
    # Reject edits that retarget the job to a blacklisted domain/title/company.
    if any(k in patch for k in ("link", "company", "job_title")):
        merged = dict(storage.get_job_by_id(job_id) or {})
        merged.update(patch)
        reason = storage.job_block_reason(merged)
        if reason is not None:
            raise HTTPException(
                status_code=422,
                detail=f"Blocked — {reason} (Settings → Blacklist).",
            )
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
def delete_job(job_id: str, user: dict = Depends(require_jobs_access)):
    storage.delete_job(job_id)
    return {"ok": True}


@router.post("/{job_id}/reports")
def report_job(job_id: str, body: dict, user: dict = Depends(get_current_user)):
    """Flag a job as problematic (broken link, closed, spam, etc.).

    Any authenticated user — including bidders working the Apply tab — can
    report. Reporting flags the job, which removes it from the pending queue
    pending admin review.
    """
    job = storage.get_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # An admin already reviewed + dismissed reports for this job (double-approved).
    # Don't let it be reported again — that's the report/dismiss ping-pong.
    if job.get("report_locked") and not user.get("is_admin"):
        raise HTTPException(
            status_code=409,
            detail="This job was already reviewed and confirmed by an admin — it can't be reported again.",
        )
    reason = str((body or {}).get("reason") or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="A reason is required to report a job.")
    storage.add_job_report(job_id, {
        "reason": reason,
        "reported_by_user_id": user.get("id", ""),
        "reported_by_username": user.get("username", ""),
        "reported_at": _utcnow(),
        "source": "user",
    })
    return {"ok": True}


@router.post("/{job_id}/reports/clear")
def clear_job_report(job_id: str, user: dict = Depends(require_jobs_access)):
    """Dismiss a job's reports and un-flag it (admin / job_adder review action).

    The job returns to circulation (visible again in Resumes/Apply). To take
    it OUT of circulation instead, change its status to rejected/deleted.
    """
    job = storage.get_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    storage.clear_job_reports(job_id)
    return {"ok": True}
