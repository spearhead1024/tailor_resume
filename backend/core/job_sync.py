"""Pull approved jobs from the remote PostgreSQL (Resume-Generator-v2) into
the local SQLite every 20 minutes.

Rules
-----
New jobs (not yet in local DB):
  - All 5 required fields present → inserted as 'approved'
  - Any field missing            → inserted as 'rejected'

Rejected sync jobs (retry):
  - On every run, locally-rejected sync jobs are re-checked against the remote.
  - If the remote record now has all required fields (human filled in the
    missing description) → local status upgraded to 'approved'.
  - Otherwise left as 'rejected', retried next run.

Duplicate detection:
  - Normalized URL match first, then company+title key.
  - 'rejected' local records are exempt so they can be upgraded.

Run as a standalone script — loops forever with a 20-minute sleep.
"""
from __future__ import annotations

import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# Load credentials from backend/.env (and project root .env as fallback).
try:
    from dotenv import load_dotenv
    load_dotenv(_BACKEND_DIR / ".env")
    load_dotenv(_BACKEND_DIR.parent / ".env")
except Exception:
    pass

import requests

from auth import storage

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# The remote DB is Docker-internal and not reachable; instead we pull approved
# jobs over the remote box's public REST API (the same API its UI uses).
# Credentials live in backend/.env (git-ignored) — see .env.template.
API_BASE_URL = os.environ.get("JOB_SYNC_API_BASE_URL", "http://69.169.109.18:8010").rstrip("/")
API_USER = os.environ.get("JOB_SYNC_API_USER", "")
API_PASSWORD = os.environ.get("JOB_SYNC_API_PASSWORD", "")
API_TTL_DAYS = 7
API_PAGE_SIZE = 200
HTTP_TIMEOUT = 30

SYNC_INTERVAL_SECONDS = 20 * 60
LOOKBACK_HOURS = 24  # kept for log compatibility; the API has no since filter.

REQUIRED_FIELDS = ("company", "job_title", "link", "region", "description_preview")
_SCRAPE_FAILED_NOTE = "Automatic scrape failed. Review manually before approving."

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [job-sync] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("job_sync")

# ---------------------------------------------------------------------------
# Remote API client (auth + fetch)
# ---------------------------------------------------------------------------
_session = requests.Session()
_token: str | None = None


def _login() -> str:
    """Authenticate against the remote API and return a bearer token."""
    if not API_USER or not API_PASSWORD:
        raise RuntimeError(
            "Missing JOB_SYNC_API_USER / JOB_SYNC_API_PASSWORD — set them in backend/.env"
        )
    resp = _session.post(
        f"{API_BASE_URL}/api/auth/login",
        json={"identifier": API_USER, "password": API_PASSWORD, "ttl_days": API_TTL_DAYS},
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    token = (resp.json() or {}).get("token")
    if not token:
        raise RuntimeError("Login succeeded but no token in response")
    return token


def _api_get(path: str, params: dict | None = None):
    """GET with bearer auth; re-login once on 401."""
    global _token
    if _token is None:
        _token = _login()
    url = f"{API_BASE_URL}{path}"
    headers = {"Authorization": f"Bearer {_token}"}
    resp = _session.get(url, params=params or {}, headers=headers, timeout=HTTP_TIMEOUT)
    if resp.status_code == 401:
        _token = _login()
        headers = {"Authorization": f"Bearer {_token}"}
        resp = _session.get(url, params=params or {}, headers=headers, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def _fetch_all_approved() -> list[dict]:
    """Page through GET /api/jobs?status=approved and return all rows.

    JobListItem carries description_preview (possibly truncated); the full
    description is fetched per-job via _fetch_detail only for jobs we actually
    insert/upgrade, to avoid hammering the API.
    """
    rows: list[dict] = []
    offset = 0
    try:
        while True:
            batch = _api_get("/api/jobs", {
                "status": "approved",
                "available_only": "false",
                "limit": API_PAGE_SIZE,
                "offset": offset,
            })
            if not isinstance(batch, list) or not batch:
                break
            rows.extend(batch)
            if len(batch) < API_PAGE_SIZE:
                break
            offset += API_PAGE_SIZE
    except Exception as exc:
        log.error("Remote fetch (approved list) failed: %s", exc)
        return []
    log.info("Remote returned %d approved job(s)", len(rows))
    return rows


def _fetch_detail(remote_id: str) -> dict | None:
    """Fetch a single job's full detail (includes the complete description)."""
    rid = str(remote_id or "").strip()
    if not rid:
        return None
    try:
        return _api_get(f"/api/jobs/{rid}")
    except Exception as exc:
        log.error("Remote detail fetch failed for %s: %s", rid, exc)
        return None


def _with_full_description(job: dict) -> dict:
    """Return a copy of the list-item enriched with the full description."""
    detail = _fetch_detail(job.get("id"))
    if detail:
        full = str(detail.get("description") or "").strip()
        if full:
            return {**job, "description_preview": full}
    return dict(job)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_REGION_MAP = {"US": "US", "EU": "EU", "LATAM": "LATAM"}


def _normalize_region(value: str | None) -> str:
    return _REGION_MAP.get(str(value or "").upper().strip(), "ANY")


def _is_complete(job: dict) -> bool:
    return all(str(job.get(f) or "").strip() for f in REQUIRED_FIELDS)


def _missing_fields(job: dict) -> list[str]:
    return [f for f in REQUIRED_FIELDS if not str(job.get(f) or "").strip()]


def _status_for(job: dict) -> str:
    """Determine insert status: 'pending' if scrape failed note, else approved/rejected by completeness."""
    if str(job.get("note") or "").strip() == _SCRAPE_FAILED_NOTE:
        return "pending"
    return "approved" if _is_complete(job) else "rejected"


def _build_payload(job: dict, status: str) -> dict:
    # The API exposes no approval timestamp, so we stamp the moment we first
    # ingest the job. Dedup means existing jobs are never re-inserted, so this
    # is effectively the local "first seen" time — which is what the platform's
    # daily-intake window keys on.
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "company":        str(job.get("company") or "").strip(),
        "job_title":      str(job.get("job_title") or "").strip(),
        "link":           str(job.get("link") or "").strip(),
        "region":         _normalize_region(job.get("region")),
        "note":           str(job.get("note") or "").strip(),
        "description":    str(job.get("description_preview") or "").strip(),
        "status":         status,
        "source":         "sync",
        "submitted_at":   now_iso,
        "approved_at":    now_iso if status == "approved" else "",
        "sync_remote_id": str(job.get("id") or ""),
        "scrape_status":  "done" if str(job.get("description_preview") or "").strip() else "queued",
    }


def _find_existing(link: str, company: str, job_title: str) -> bool:
    """True if any local job already matches by URL or company+title, regardless of status.
    Covers approved, pending, rejected (manual or sync), and deleted — all block re-insertion."""
    if link:
        found = storage.find_job_by_url(link)
        if found:
            return True
    if company and job_title:
        found = storage.find_duplicate_job(company, job_title)
        if found:
            return True
    return False

# ---------------------------------------------------------------------------
# Reject approved local jobs that have no description (DB clean-up)
# ---------------------------------------------------------------------------

def reject_incomplete_approved() -> int:
    """Set status='rejected' for any locally-approved sync job with no description."""
    count = 0
    for j in storage.get_jobs():
        if j.get("status") != "approved":
            continue
        if str(j.get("description") or "").strip():
            continue
        storage.update_job(j["id"], {"status": "rejected"})
        count += 1
        log.warning(
            "Rejected (no description): %s — %s [%s]",
            j.get("company"), j.get("job_title"), j.get("id"),
        )
    if count:
        log.info("Rejected %d approved job(s) with missing description", count)
    return count

# ---------------------------------------------------------------------------
# Retry: upgrade locally-rejected sync jobs whose remote record is now complete
# ---------------------------------------------------------------------------

def _norm_link(link: str) -> str:
    try:
        return storage.normalize_job_url(link)  # type: ignore[attr-defined]
    except Exception:
        return str(link or "").strip().lower()


def retry_rejected(approved: list[dict] | None = None) -> int:
    """Re-check remote for rejected sync jobs; upgrade to 'approved' if complete.
    Skips any job where sync_locked=True (manually changed by a human).

    A rejected sync job that has since become approved+complete on the remote
    will appear in the approved list, matched by remote id or normalized link.
    """
    rejected_sync = [
        j for j in storage.get_jobs()
        if j.get("status") == "rejected"
        and j.get("source") == "sync"
        and not j.get("sync_locked")
    ]
    if not rejected_sync:
        return 0

    if approved is None:
        approved = _fetch_all_approved()
    if not approved:
        log.info("Retry check: %d rejected sync job(s), remote list empty", len(rejected_sync))
        return 0

    by_id = {str(j.get("id") or ""): j for j in approved if j.get("id")}
    by_link = {_norm_link(j.get("link")): j for j in approved if j.get("link")}

    upgraded = 0
    for local in rejected_sync:
        rid = str(local.get("sync_remote_id") or "").strip()
        match = by_id.get(rid) or by_link.get(_norm_link(local.get("link")))
        if not match:
            continue
        rjob = _with_full_description(match)
        if not _is_complete(rjob):
            continue
        payload = _build_payload(rjob, "approved")
        payload["id"] = local["id"]
        storage.upsert_job(payload)
        upgraded += 1
        log.info("Upgraded rejected→approved: %s — %s", rjob.get("company"), rjob.get("job_title"))

    if upgraded:
        log.info("Upgraded %d rejected job(s) to approved", upgraded)
    else:
        log.info("Retry check: %d rejected sync job(s), none ready yet", len(rejected_sync))

    return upgraded

# ---------------------------------------------------------------------------
# Main sync: fetch new approved jobs from remote
# ---------------------------------------------------------------------------

def sync_once() -> dict:
    remote_jobs = _fetch_all_approved()

    fetched  = len(remote_jobs)
    inserted = 0
    skipped  = 0

    blocked = 0
    for listitem in remote_jobs:
        link      = str(listitem.get("link") or "").strip()
        company   = str(listitem.get("company") or "").strip()
        job_title = str(listitem.get("job_title") or "").strip()
        remote_id = str(listitem.get("id") or "")

        # Never ingest placeholder "Manual Job" listings.
        if job_title.casefold() == "manual job":
            skipped += 1
            log.info("Skipped placeholder 'Manual Job': %s — %s", company or remote_id, link)
            continue

        # Skip if any local record already exists with this URL or company+title,
        # regardless of status — preserves manual pending/rejected/deleted decisions.
        # Done BEFORE the detail fetch so we don't hit the API for known jobs.
        if _find_existing(link, company, job_title):
            skipped += 1
            continue

        # New job → fetch full description, then classify and build payload.
        job = _with_full_description(listitem)
        status = _status_for(job)
        payload = _build_payload(job, status)

        # Defence-in-depth: drop placeholder "Manual Job" even if the title is
        # only resolved after the detail fetch (the early skip above catches the
        # common case where the listing already carries it).
        if payload["job_title"].casefold() == "manual job":
            skipped += 1
            log.info("Skipped placeholder 'Manual Job': %s — %s", company or remote_id, link)
            continue

        # Blacklist (admin-configured: domain / title keyword / company).
        # Blocked jobs are logged at info level — they're a deliberate filter.
        block_reason = storage.job_block_reason(payload)
        if block_reason is not None:
            blocked += 1
            log.info("Blocked (%s): %s — %s — %s", block_reason, company, job_title, link)
            continue

        # One job per company per region per week: if this company already has an
        # active job in the same region within the last 7 days, skip the new one.
        recent = storage.find_recent_company_job(payload["company"], payload["region"], within_days=7)
        if recent is not None:
            skipped += 1
            log.info(
                "Skipped company-week dup: %s [%s] — already have '%s' (%s) within 7d",
                payload["company"] or remote_id, payload["region"],
                recent.get("job_title", ""), recent.get("id", ""),
            )
            continue

        try:
            ok = storage.upsert_job(payload)
            if not ok:
                # Defensive — only hits if the blacklist changed mid-loop.
                blocked += 1
                continue
            inserted += 1
            if status == "approved":
                log.info("Inserted [approved]: %s — %s", company, job_title)
            elif status == "pending":
                log.warning(
                    "Inserted [pending – scrape failed]: %s — %s",
                    company or remote_id, job_title,
                )
            else:
                log.warning(
                    "Inserted [rejected – incomplete]: %s — %s | missing: %s",
                    company or remote_id, job_title, _missing_fields(job),
                )
        except Exception as exc:
            log.error("Failed to insert %s/%s: %s", company, job_title, exc)
            skipped += 1

    log.info(
        "Sync done — fetched=%d inserted=%d skipped=%d blocked=%d",
        fetched, inserted, skipped, blocked,
    )
    return {"fetched": fetched, "inserted": inserted, "skipped": skipped, "blocked": blocked}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info(
        "Job sync started — interval=%ds remote API=%s user=%s",
        SYNC_INTERVAL_SECONDS,
        API_BASE_URL,
        API_USER or "(unset)",
    )
    while True:
        try:
            reject_incomplete_approved()
            retry_rejected()
            sync_once()
        except Exception as exc:
            log.error("Unhandled error in sync cycle: %s", exc)
        time.sleep(SYNC_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
