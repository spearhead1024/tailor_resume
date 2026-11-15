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

import fcntl
import logging
import os
import sys
import time
from contextlib import contextmanager
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
from core.storage import COMPANY_DEDUP_DAYS

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# The remote DB is Docker-internal and not reachable; instead we pull approved
# jobs over the remote box's public REST API (the same API its UI uses).
# Credentials live in backend/.env (git-ignored) — see .env.template.
API_BASE_URL = os.environ.get("JOB_SYNC_API_BASE_URL", "https://easyremotejob.duckdns.org").rstrip("/")
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


def _remote_submitted_at(job: dict) -> str:
    """VPS1's own submitted_at (when the job was added there) as "…Z" UTC, or ''."""
    raw = str(job.get("submitted_at") or "").strip()
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _build_payload(job: dict, status: str) -> dict:
    # Date the job by when it was ADDED on VPS1 (its submitted_at), not by when we
    # happened to sync it. Stamping the sync time made any backlog that arrived late
    # look brand new: when the title blacklist was emptied, ~290 VPS1 jobs from
    # June–October were inserted at once and all showed as "today" (and entered the
    # Bid queue, whose deadline keys on submitted_at). VPS1 exposes no approval time,
    # so approved_at stays our first-seen time.
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    added_iso = _remote_submitted_at(job) or now_iso
    return {
        "company":        str(job.get("company") or "").strip(),
        "job_title":      str(job.get("job_title") or "").strip(),
        "link":           str(job.get("link") or "").strip(),
        "region":         _normalize_region(job.get("region")),
        "note":           str(job.get("note") or "").strip(),
        "description":    str(job.get("description_preview") or "").strip(),
        "status":         status,
        "source":         "sync",
        "submitted_at":   added_iso,
        "approved_at":    now_iso if status == "approved" else "",
        "sync_remote_id": str(job.get("id") or ""),
        "scrape_status":  "done" if str(job.get("description_preview") or "").strip() else "queued",
        # Who added the job on VPS1. Display-only: created_by_user_id stays empty so
        # VPS1 accounts are never confused with local users (access + metrics use the id).
        "created_by_username": str(job.get("created_by_username") or "").strip(),
    }


def _rejection(payload: dict, remote_id: str, link: str) -> str | None:
    """'blocked' (admin blacklist: domain / title keyword / company) or 'dup' (this company already
    has an active job in the region within the dedup window), else None."""
    block_reason = storage.job_block_reason(payload)
    if block_reason is not None:
        _log_once(remote_id, "blocked:" + block_reason, "Blocked (%s): %s — %s — %s",
                  block_reason, payload["company"], payload["job_title"], link)
        return "blocked"
    recent = storage.find_recent_company_job(payload["company"], payload["region"])
    if recent is not None:
        _log_once(remote_id, "dup:" + str(recent.get("id", "")),
                  "Skipped company-dup: %s [%s] — already have '%s' (%s) within %dd",
                  payload["company"] or remote_id, payload["region"],
                  recent.get("job_title", ""), recent.get("id", ""), COMPANY_DEDUP_DAYS)
        return "dup"
    return None


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
        # Only SYNCED jobs the sync owns: a manually added or human-approved job (or any job a person
        # changed — sync_locked) must never be auto-rejected; nothing fills a manual job's
        # description, so they were all being rejected within one cycle.
        if j.get("status") != "approved" or j.get("source") != "sync" or j.get("sync_locked"):
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
        # Re-read right before writing: the network calls above take a while, and an admin may have
        # deleted/rejected the job meanwhile (which sets sync_locked) — that decision must win.
        fresh = storage.get_job_by_id(local["id"]) or {}
        if fresh.get("status") != "rejected" or fresh.get("sync_locked"):
            continue
        payload = _build_payload(rjob, "approved")
        if storage.job_block_reason(payload) is not None:
            continue                      # blacklisted — stays rejected (was miscounted as upgraded)
        if storage.find_recent_company_job(payload["company"], payload["region"],
                                           exclude_job_id=local["id"]) is not None:
            continue                      # the company already has an active job in the window
        # It becomes biddable NOW. Dating it by its VPS1 add time put an upgrade made more than the
        # Bid deadline (12 h) after that already past it, so it never appeared in any Bid queue.
        payload["submitted_at"] = payload["approved_at"]
        storage.update_job(local["id"], payload)    # merge: keeps reports / flags / notes
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

_LOCK_FILE = Path(__file__).resolve().parents[2] / "data" / "job_sync.lock"


@contextmanager
def _cycle_lock():
    """Cross-process lock: the scheduled cycle runs in the job-sync worker, "Sync now" in the API
    process. A thread lock can't see across processes, so both could insert the same new job (as
    two rows). Yields False when another sync is already running."""
    _LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(_LOCK_FILE, "w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def sync_once() -> dict:
    """Fetch and insert new approved jobs now ("Sync now"). Returns {"busy": True} if a sync is
    already running in another process."""
    with _cycle_lock() as got:
        if not got:
            return {"busy": True}
        return _sync(_fetch_all_approved())


# Remote jobs we decided not to ingest are seen again every cycle (they're never stored), so their
# "Skipped"/"Blocked" line used to repeat ~300 times every 20 minutes. Log each one once per process.
_reported: set[tuple[str, str]] = set()


def _log_once(remote_id: str, reason: str, msg: str, *args) -> None:
    key = (remote_id, reason)
    if key not in _reported:
        _reported.add(key)
        log.info(msg, *args)


def _sync(remote_jobs: list[dict]) -> dict:
    fetched  = len(remote_jobs)
    inserted = 0
    skipped  = 0
    # VPS1 ids we already hold: a job whose company/title/link VPS1 later corrected must not look new.
    known_remote_ids = storage.sync_remote_ids()

    blocked = 0
    for listitem in remote_jobs:
        link      = str(listitem.get("link") or "").strip()
        company   = str(listitem.get("company") or "").strip()
        job_title = str(listitem.get("job_title") or "").strip()
        remote_id = str(listitem.get("id") or "")

        # Never ingest placeholder "Manual Job" listings.
        if job_title.casefold() == "manual job":
            skipped += 1
            _log_once(remote_id, "manual", "Skipped placeholder 'Manual Job': %s — %s", company or remote_id, link)
            continue

        if remote_id and remote_id in known_remote_ids:
            skipped += 1
            continue

        # Skip if any local record already exists with this URL or company+title,
        # regardless of status — preserves manual pending/rejected/deleted decisions.
        # Done BEFORE the detail fetch so we don't hit the API for known jobs.
        if _find_existing(link, company, job_title):
            skipped += 1
            continue

        # Blacklist and one-per-company checks need only the listing (company, title, link, region),
        # so run them BEFORE the detail fetch: these jobs are never stored and come back every cycle,
        # and fetching each one's description first cost ~120 needless VPS1 calls per cycle.
        reason = _rejection(_build_payload(listitem, "approved"), remote_id, link)
        if reason is not None:
            if reason == "blocked":
                blocked += 1
            else:
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
            _log_once(remote_id, "manual", "Skipped placeholder 'Manual Job': %s — %s", company or remote_id, link)
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

def backfill_added_by(approved: list[dict] | None = None, max_detail_lookups: int = 300) -> int:
    """Fill in the VPS1 adder's username on synced jobs that were stored without it.

    Matches by the VPS1 job id (sync_remote_id): first from the approved list, then
    — for jobs no longer approved on VPS1 — one detail lookup each (capped per run,
    so a large backlog is filled over a few cycles without hammering VPS1)."""
    missing = [j for j in storage.get_jobs()
               if j.get("source") == "sync" and j.get("sync_remote_id")
               and not str(j.get("created_by_username") or "").strip()
               and not j.get("added_by_unknown")]          # VPS1 had no adder last time — don't re-ask forever
    if not missing:
        return 0
    if approved is None:
        approved = _fetch_all_approved()
    by_id = {str(j.get("id") or ""): str(j.get("created_by_username") or "").strip()
             for j in approved or [] if j.get("id")}
    filled = lookups = 0
    for local in missing:
        rid = str(local["sync_remote_id"])
        name = by_id.get(rid, "")
        answered = False                 # VPS1 answered for this job (detail, or 404: gone) — not a failed request
        if not name and lookups < max_detail_lookups:
            lookups += 1
            try:
                detail = _api_get(f"/api/jobs/{rid}")
                answered = True
            except requests.HTTPError as exc:
                detail = None
                answered = exc.response is not None and exc.response.status_code == 404
            except Exception:
                detail = None
            name = str((detail or {}).get("created_by_username") or "").strip()
        if name:
            storage.update_job(local["id"], {"created_by_username": name})
            filled += 1
        elif answered:
            # Only a job VPS1 actually answered for: one past the lookup cap, or a failed request,
            # just hasn't been asked yet.
            storage.update_job(local["id"], {"added_by_unknown": True})
    log.info("Added-by backfill: filled %d of %d synced jobs (%d detail lookups)",
             filled, len(missing), lookups)
    return filled


def main() -> None:
    log.info(
        "Job sync started — interval=%ds remote API=%s user=%s",
        SYNC_INTERVAL_SECONDS,
        API_BASE_URL,
        API_USER or "(unset)",
    )
    while True:
        try:
            with _cycle_lock() as got:
                if got:
                    # Each step fetches the approved list itself and lets it go: holding one shared
                    # copy (7k jobs with descriptions) alongside get_jobs() for the whole cycle pushed
                    # the worker past pm2's 256M max_memory_restart, so it was killed mid-cycle.
                    reject_incomplete_approved()
                    retry_rejected()
                    _sync(_fetch_all_approved())
                    backfill_added_by()
                else:
                    log.info("Sync skipped — another sync (\"Sync now\") is running")
        except Exception as exc:
            log.error("Unhandled error in sync cycle: %s", exc)
        time.sleep(SYNC_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
