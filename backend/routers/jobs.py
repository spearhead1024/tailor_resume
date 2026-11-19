"""Jobs CRUD."""
from __future__ import annotations

import re
import threading
from urllib.parse import urlsplit
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from auth import get_current_user, require_role, storage

# Both admins and job_adders can manage jobs.
require_jobs_access = require_role("admin", "job_adder")
from schemas import JobUpsertRequest
from core.job_questions import clean_questions
from core import job_ai



def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _work_day_to_utc(date_str: str, *, end: bool = False) -> datetime | None:
    """A 'YYYY-MM-DD' WORK DAY → its naive-UTC start (or the next day's start if end).

    A work day runs 5pm JST → 5pm JST (08:00 UTC), labelled by the date it starts on — the same
    day as the Metrics and Applied tabs (routers/metrics.py `_metrics_day`), so a day's numbers
    agree on every tab."""
    s = str(date_str or "").strip()
    if not s:
        return None
    try:
        y, m, d = (int(x) for x in s.split("-"))
        start = datetime(y, m, d, 8, 0)          # 5pm JST = 08:00 UTC
    except (ValueError, TypeError):
        return None
    return start + timedelta(days=1) if end else start


# Guards against overlapping manual + scheduled sync runs.
_sync_lock = threading.Lock()


# ── Stricter job submit ──────────────────────────────────────────────────────
# A manually added job is only useful when it is complete: duplicate detection keys on
# company + title and the link, bidders open the link, and the resume flow needs the full
# description. Every client (web Jobs tab, browser extension) gets the same rules here.
_JOB_REQUIRED = {"company": "company", "job_title": "job title", "link": "job link", "description": "job description"}
_JOB_REGIONS = {"US", "EU", "LATAM", "ANY"}                         # what profiles are matched on
_JOB_REGION_ALIASES = {"GLOBAL": "ANY", "ANYWHERE": "ANY", "WORLDWIDE": "ANY", "ALL": "ANY", "REMOTE": "ANY"}
_JOB_MIN_DESCRIPTION = 100                                          # a pasted link or one line is not a posting
_JOB_MAX_LEN = {"company": 200, "job_title": 200, "link": 2000, "description": 60_000, "note": 5_000}


def _valid_job_link(link: str) -> bool:
    try:
        parts = urlsplit(link)
    except ValueError:
        return False
    host = parts.hostname or ""
    return parts.scheme in ("http", "https") and "." in host and not any(c.isspace() for c in link)


def _clean_job_fields(payload: dict, *, partial: bool = False) -> dict:
    """Trim the job's text fields and enforce the submit rules; raise ONE 422 naming every
    problem (so a form can show them all at once). partial=True (an edit) checks only the
    fields the edit sends — changing a job's status alone never trips over its other fields."""
    out = dict(payload)
    problems: list[str] = []
    present = lambda key: not partial or key in out  # noqa: E731
    for key in ("company", "job_title", "link", "description", "note"):
        if key in out:
            out[key] = str(out.get(key) or "").strip()
    missing = [label for key, label in _JOB_REQUIRED.items() if present(key) and not out.get(key)]
    if missing:
        problems.append(f"Missing: {', '.join(missing)}. Company, job title, job link and job description are all required.")
    link = out.get("link", "")
    if link and not _valid_job_link(link):
        problems.append("The job link must be a full web address starting with http:// or https:// (e.g. https://boards.greenhouse.io/acme/jobs/123).")
    for key, label in (("company", "company"), ("job_title", "job title")):
        if re.match(r"(?i)^(https?://|www\.)", out.get(key, "")):
            problems.append(f"The {label} looks like a link — enter the {label} itself.")
    desc = out.get("description", "")
    if desc and len(desc) < _JOB_MIN_DESCRIPTION:
        problems.append(f"The job description is too short ({len(desc)} characters) — paste the full posting (at least {_JOB_MIN_DESCRIPTION} characters).")
    for key, limit in _JOB_MAX_LEN.items():
        if len(out.get(key, "") or "") > limit:
            problems.append(f"The {_JOB_REQUIRED.get(key, key)} is too long (at most {limit:,} characters).")
    if present("region"):
        region = str(out.get("region") or "").strip().upper()
        region = _JOB_REGION_ALIASES.get(region, region)
        if region not in _JOB_REGIONS:
            problems.append("Pick the region: US, EU, LATAM or Any.")
        else:
            out["region"] = region
    if problems:
        raise HTTPException(status_code=422, detail=" ".join(problems))
    return out


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

# Who added / approved a job is recorded by the server, never taken from the client — nor is
# anything the AI check writes (core/job_ai.py).
_SERVER_OWNED = ("id", "created_by_user_id", "created_by_username",
                 "approved_by_user_id", "approved_by_username", "approved_at", "sync_locked",
                 "ai_status", "ai_reason", "ai_work_mode", "ai_error", "ai_checked_at", "analyzed", "ai_auto",
                 "rejected_at", "rejected_by_username")
# Only an admin decides a job's status, its tech stack and why it was rejected.
_ADMIN_ONLY = ("status", "tech_stack", "reject_reason")
# Changing these on a job means its AI check is out of date.
_AI_INPUTS = ("company", "job_title", "description")


def _job_for_write(job_id: str, user: dict) -> dict:
    """The job, if this user may change it: admins any job, job_adders only the jobs they added —
    the same rule list/get already apply (404, so other people's job ids aren't confirmed)."""
    job = storage.get_job_by_id(job_id)
    if not job or (not user.get("is_admin") and job.get("created_by_user_id") != user.get("id")):
        raise HTTPException(status_code=404, detail="Not found")
    return job


@router.get("")
def list_jobs(
    status: str = Query(""),
    region: str = Query(""),
    company: str = Query(""),
    q: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    reported: bool = Query(False),
    added_by: str = Query(""),
    apply: str = Query(""),        # 'easy' (LinkedIn Easy Apply) / 'out' / '' = both
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    """Paginated, server-side-filtered jobs for the Jobs tab.

    Returns {jobs, total, page, page_size, counts}. The `jobs` list omits the
    heavy description/note fields — GET /api/jobs/{id} returns the full row.
    Pass reported=true to show only flagged (reported) jobs for review.
    added_by (admins only) narrows to one adder's jobs — see storage.query_jobs.
    """
    # Job-adders only see jobs they uploaded; admins see every job.
    is_admin = bool(user.get("is_admin"))
    created_by = "" if is_admin else user.get("id", "")
    return storage.query_jobs(
        status=status,
        region=region,
        company=company,
        q=q,
        date_from=_work_day_to_utc(date_from),
        date_to=_work_day_to_utc(date_to, end=True),
        reported=reported,
        apply_type=apply,
        created_by=created_by,
        added_by=added_by if is_admin else "",   # a job_adder's list is already just their own
        page=page,
        page_size=page_size,
    )


@router.get("/adders")
def list_job_adders(
    status: str = Query(""),
    region: str = Query(""),
    company: str = Query(""),
    q: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    reported: bool = Query(False),
    apply: str = Query(""),
    user: dict = Depends(require_role("admin")),
):
    """Options for the Jobs tab's "Added by" filter: [{name, count}], counted within the same
    filters as the list (GET /api/jobs, minus added_by itself) — so each count is what picking
    that adder would show. name '' = no adder on record. Admin only, like the Added by column."""
    return storage.job_adders(
        status=status, region=region, company=company, q=q,
        date_from=_work_day_to_utc(date_from), date_to=_work_day_to_utc(date_to, end=True),
        reported=reported, apply_type=apply)


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
        if (result or {}).get("busy"):
            raise HTTPException(status_code=409, detail="A sync is already running — try again in a moment.")
        return {"ok": True, **(result or {})}
    except HTTPException:
        raise
    except Exception as exc:  # surface the failure to the toast
        raise HTTPException(status_code=502, detail=f"Sync failed: {exc}")
    finally:
        _sync_lock.release()


@router.get("/lookup")
def lookup_job(url: str = Query(""), user: dict = Depends(get_current_user)):
    """Is this page a job TailorResume already has? For the extension, which opens the right tab for
    the page the bidder is on (a known job → Out Bids, a new one → Add Jobs). Read-only; only says
    whether it exists (and its id / status) — any signed-in user. A company's apply form under the
    posting (…/jobs/123/apply) counts as that posting."""
    raw = str(url or "").strip()[:2048]
    if not raw.startswith(("http://", "https://")):
        return {"exists": False}
    tries = [raw]
    base = raw.split("#")[0].split("?")[0].rstrip("/")
    if base.rsplit("/", 1)[-1].lower() in ("apply", "application", "applications", "applynow"):
        tries.append(base.rsplit("/", 1)[0])
    for u in tries:
        job = storage.find_job_by_url(u)
        if job and job.get("status") != "deleted":
            return {"exists": True, "job_id": job.get("id", ""), "status": job.get("status", "")}
    return {"exists": False}


@router.get("/ai-status")
def ai_status(user: dict = Depends(require_role("admin"))):
    """The AI job check: on/off, key, model, the last temporary error, and what it cost
    (today = since 00:00 UTC, and the last 30 days)."""
    out = job_ai.status()
    now = datetime.now(timezone.utc)
    day = now.strftime("%Y-%m-%d")
    month_ago = (now - timedelta(days=30)).strftime("%Y-%m-%d")
    spent_today = spent_30d = 0.0
    calls_30d = 0
    for c in storage.get_openai_calls_since(month_ago):
        if c.get("call_kind") != "analyze_job":
            continue
        usd = (c.get("cost") or {}).get("total_cost_usd") or 0
        calls_30d += 1
        spent_30d += float(usd)
        if str(c.get("recorded_at", "")) >= day:
            spent_today += float(usd)
    out.update(spent_today_usd=round(spent_today, 4), spent_30d_usd=round(spent_30d, 4), calls_30d=calls_30d)
    return out


@router.get("/{job_id}/similar")
def similar_jobs(job_id: str, user: dict = Depends(require_role("admin"))):
    """This job (with its description) and up to 10 other jobs like it — same link, same company +
    title, or same company — for a side-by-side check before approving."""
    job = storage.get_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Not found")
    return {"job": job, "similar": storage.similar_jobs(job_id, limit=10)}


@router.get("/{job_id}")
def get_job(job_id: str, user: dict = Depends(get_current_user)):
    job = storage.get_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Not found")
    # Job-adders can only open jobs they uploaded; admins can open any.
    if not user.get("is_admin") and job.get("created_by_user_id") != user.get("id"):
        raise HTTPException(status_code=404, detail="Not found")
    return job


@router.post("/check-duplicate")
def check_duplicate(body: dict, user: dict = Depends(require_jobs_access)):
    """Live pre-save check for the add/edit form: runs the SAME rules as saving
    (same link, same company + title, one job per company per region per month,
    blacklist) and returns every conflict instead of rejecting. Read-only.

    Body: {company, job_title, link, region, exclude_job_id?} — exclude_job_id is
    the job being edited, so it never conflicts with itself. Editing skips the
    one-per-month rule, matching update_job."""
    payload = {k: str((body or {}).get(k) or "").strip() for k in ("company", "job_title", "link", "region")}
    exclude = str((body or {}).get("exclude_job_id") or "").strip()
    conflicts: list[dict] = []
    checks = [lambda: _check_duplicate(payload, exclude_job_id=exclude)]
    if not exclude and payload["company"]:
        checks.append(lambda: _check_company_week(payload))
    for check in checks:
        try:
            check()
        except HTTPException as exc:
            if isinstance(exc.detail, dict):
                conflicts.append(exc.detail)
    if payload["company"] or payload["link"] or payload["job_title"]:
        reason = storage.job_block_reason(payload)
        if reason is not None:
            conflicts.append({"kind": "blacklist", "message": f"Blocked — {reason} (Settings → Blacklist)."})
    return {"duplicate": bool(conflicts), "conflicts": conflicts}


@router.post("")
def create_job(body: JobUpsertRequest, user: dict = Depends(require_jobs_access)):
    payload = _clean_job_fields({k: v for k, v in dict(body.payload).items() if k not in _SERVER_OWNED})
    payload["application_questions"] = clean_questions(str(payload.get("note") or "").splitlines())
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
    # Always a fresh id: upsert_job REPLACES a row with the same id, so a client-chosen id could
    # overwrite somebody else's job.
    payload["id"] = storage.make_id("job")
    payload["created_by_user_id"] = user["id"]
    payload["created_by_username"] = user.get("username", "")
    now = _utcnow()
    payload.setdefault("submitted_at", now)
    if not user.get("is_admin"):
        payload.pop("tech_stack", None)
        payload.pop("reject_reason", None)
        # A job_adder's job waits (pending) for the AI check, which approves a 'fit' at once and
        # leaves the rest for an admin (Jobs → Pending). AI check off: it goes live, as before.
        payload["status"] = "pending" if job_ai.enabled() else "approved"
        payload["ai_auto"] = payload["status"] == "pending"
    else:
        payload.setdefault("status", "approved")       # an admin's job goes live at once
    if payload.get("status") == "approved":
        payload["approved_at"] = now
        payload["approved_by_user_id"] = user["id"]
        payload["approved_by_username"] = user.get("username", "")
    if not storage.upsert_job(payload):
        # Defensive — blacklist could change between the check above and now.
        raise HTTPException(status_code=422, detail="Blocked by blacklist.")
    job_ai.kick()                                       # check it now (verdict + tech stack)
    return storage.get_job_by_id(payload["id"]) or {"id": payload["id"]}


@router.patch("/{job_id}")
def update_job(job_id: str, body: JobUpsertRequest, user: dict = Depends(require_jobs_access)):
    current = _job_for_write(job_id, user)
    raw = dict(body.payload)
    if not user.get("is_admin"):
        # A job_adder may take their own job out of circulation (reject / delete), never approve
        # it — that is the AI check's or an admin's call.
        if str(raw.get("status") or "") not in ("rejected", "deleted"):
            raw.pop("status", None)
        raw = {k: v for k, v in raw.items() if k == "status" or k not in _ADMIN_ONLY}
    patch = _clean_job_fields({k: v for k, v in raw.items() if k not in _SERVER_OWNED}, partial=True)
    # The job's text changed: check it again. A job_adder's job still waiting on its check, or sent
    # back to them as not a fit, goes back to pending for a fresh verdict.
    if any(k in patch and str(patch[k]) != str(current.get(k) or "") for k in _AI_INPUTS):
        patch["analyzed"] = False
        if (not user.get("is_admin") and current.get("status") == "pending" and job_ai.enabled()):
            patch["ai_auto"] = True
    # The web form's "Application questions" box is `note`: on a VPS2 job it IS the shared
    # question list. (A synced job's note is VPS1's reviewer note — left alone.)
    if "note" in patch and (storage.get_job_by_id(job_id) or {}).get("source") != "sync":
        patch["application_questions"] = clean_questions(str(patch.get("note") or "").splitlines())
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
    if "status" in patch and patch["status"] != current.get("status"):
        _stamp_status(patch, current, user, patch.get("reject_reason"))
    # Any manual status change locks the job so job-sync never overwrites it.
    if "status" in patch:
        patch["sync_locked"] = True
    storage.update_job(job_id, patch)
    if patch.get("analyzed") is False:
        job_ai.kick()
    return storage.get_job_by_id(job_id) or {"id": job_id}


def _stamp_status(patch: dict, current: dict, user: dict, reason: str | None = None) -> None:
    """A person decided this job's status: the AI check no longer holds it, and a rejection records
    who rejected it and why (the adder sees the reason)."""
    patch["ai_auto"] = False
    if patch.get("status") == "rejected":
        patch["reject_reason"] = str(reason if reason is not None else current.get("reject_reason") or "").strip()[:300]
        patch["rejected_at"] = _utcnow()
        patch["rejected_by_username"] = user.get("username", "")
    else:
        patch["reject_reason"] = ""


def _auto_reject_reason(job: dict) -> str:
    """Why a job was rejected when the admin gave no reason (VPS1's order, minus the duplicate
    notes VPS2 never stores): the newest report, else the AI's reason, else a plain line."""
    reports = job.get("reports") or []
    if job.get("flagged") and reports:
        latest = str(reports[-1].get("reason") or "").strip()
        if latest:
            return f"Reported: {latest}"
    if job.get("ai_reason") and job.get("ai_status") in ("not_fit", "needs_check"):
        return f"AI: {job['ai_reason']}"
    return "Rejected after review"


def _ids_of(body: dict, cap: int = 500) -> list[str]:
    ids = [str(i).strip() for i in ((body or {}).get("ids") or []) if str(i).strip()]
    if len(ids) > cap:
        raise HTTPException(status_code=400, detail=f"At most {cap} jobs at once.")
    return list(dict.fromkeys(ids))


@router.post("/reject")
def reject_jobs(body: dict, user: dict = Depends(require_role("admin"))):
    """Reject these jobs. {ids, reason?}: with a reason, every job gets it; without one, each gets
    its own (_auto_reject_reason). The person who added a job sees why."""
    ids = _ids_of(body)
    given = str((body or {}).get("reason") or "").strip()
    done = 0
    for jid in ids:
        job = storage.get_job_by_id(jid)
        if not job or job.get("status") == "deleted":
            continue
        patch = {"status": "rejected", "sync_locked": True}
        _stamp_status(patch, job, user, given or _auto_reject_reason(job))
        storage.update_job(jid, patch)
        done += 1
    from core import cv_queue
    cv_queue.close(storage.db_path, job_ids=ids)          # rejected: out of every Bid queue
    return {"ok": True, "rejected": done}


@router.post("/approve")
def approve_jobs(body: dict, user: dict = Depends(require_role("admin"))):
    """Approve these pending jobs ({ids}), or every pending job that nobody reported ({all: true})."""
    if (body or {}).get("all"):
        ids = [j["id"] for j in storage.query_jobs(status="pending", page=1, page_size=200_000)["jobs"]
               if not j.get("flagged")]
    else:
        ids = _ids_of(body)
    now = _utcnow()
    done = 0
    for jid in ids:
        job = storage.get_job_by_id(jid)
        if not job or job.get("status") != "pending":
            continue
        patch = {"status": "approved", "approved_at": now, "approved_by_user_id": user["id"],
                 "approved_by_username": user.get("username", ""), "sync_locked": True}
        _stamp_status(patch, job, user)
        storage.update_job(jid, patch)
        done += 1
    return {"ok": True, "approved": done}


@router.post("/analyze")
async def analyze_jobs(body: dict, user: dict = Depends(require_role("admin"))):
    """Run the AI check now on these jobs ({ids}, at most 25) and save each verdict + tech stack.
    A verdict made here never changes a job's status — the admin decides (VPS1's Analyze button)."""
    ids = _ids_of(body, cap=25)
    if not job_ai.key_present():
        raise HTTPException(status_code=400, detail=job_ai.friendly_ai_error("no openai key"))

    def run() -> dict:
        results, errors = [], []
        for jid in ids:
            try:
                results.append(job_ai.check_job(jid, user=user, approve_fit=False))
            except LookupError:
                errors.append({"id": jid, "error": "Job not found"})
            except Exception as exc:
                errors.append({"id": jid, "error": job_ai.friendly_ai_error(exc)})
                if job_ai.is_transient_ai_error(exc):
                    break                               # the rest would fail the same way
        return {"results": results, "errors": errors}
    return await run_in_threadpool(run)




@router.delete("/{job_id}")
def delete_job(job_id: str, user: dict = Depends(require_jobs_access)):
    """Soft delete: status "deleted" + sync_locked. A hard delete removed the row, so the next job-sync
    found the job "new" on VPS1 again and re-inserted it within 20 minutes; the kept row is what
    tells the sync (and duplicate checks) that this job was already handled."""
    _job_for_write(job_id, user)
    storage.update_job(job_id, {"status": "deleted", "sync_locked": True})
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
    # Reported: the job leaves every Bid queue — its ChatGPT conversations are deleted.
    from core import cv_queue
    cv_queue.close(storage.db_path, job_ids=[job_id])
    return {"ok": True}


@router.post("/{job_id}/reports/clear")
def clear_job_report(job_id: str, user: dict = Depends(require_jobs_access)):
    """Dismiss a job's reports and un-flag it (admin / job_adder review action).

    The job returns to circulation (visible again in Resumes/Apply). To take
    it OUT of circulation instead, change its status to rejected/deleted.
    """
    _job_for_write(job_id, user)
    storage.clear_job_reports(job_id)
    return {"ok": True}
