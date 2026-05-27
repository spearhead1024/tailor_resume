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
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from auth import storage

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
REMOTE_DB_URL = (
    "postgresql+psycopg://postgres:postgres@69.169.109.18:5432/tailorresume"
)
SYNC_INTERVAL_SECONDS = 20 * 60
LOOKBACK_HOURS = 24

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
# Remote queries
# ---------------------------------------------------------------------------

# New approved jobs in the last 24 h — full description via job_descriptions.
_QUERY_NEW = """
SELECT
    j.id::text,
    j.company,
    j.job_title,
    j.link,
    j.region,
    j.note,
    COALESCE(jd.description, j.description_preview) AS description_preview,
    j.approved_at
FROM jobs j
LEFT JOIN job_descriptions jd ON jd.job_id = j.id AND jd.is_active = TRUE
WHERE j.status = 'approved'
  AND j.approved_at >= %(since)s
ORDER BY j.approved_at ASC
"""

# Remote records for a specific set of UUIDs (retry path).
_QUERY_BY_IDS = """
SELECT
    j.id::text,
    j.company,
    j.job_title,
    j.link,
    j.region,
    j.note,
    COALESCE(jd.description, j.description_preview) AS description_preview,
    j.approved_at
FROM jobs j
LEFT JOIN job_descriptions jd ON jd.job_id = j.id AND jd.is_active = TRUE
WHERE j.id = ANY(%(ids)s)
"""


def _connect():
    import psycopg
    conn_str = REMOTE_DB_URL.replace("postgresql+psycopg://", "postgresql://", 1)
    return psycopg.connect(conn_str, connect_timeout=15)


def _fetch_new(since: datetime) -> list[dict]:
    rows: list[dict] = []
    try:
        with _connect() as conn:
            with conn.cursor() as cur:
                cur.execute(_QUERY_NEW, {"since": since})
                cols = [d.name for d in (cur.description or [])]
                rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    except Exception as exc:
        log.error("Remote fetch (new) failed: %s", exc)
    log.info("Remote returned %d approved job(s) since %s", len(rows), since.isoformat())
    return rows


def _fetch_by_remote_ids(remote_ids: list[str]) -> list[dict]:
    if not remote_ids:
        return []
    rows: list[dict] = []
    try:
        with _connect() as conn:
            with conn.cursor() as cur:
                cur.execute(_QUERY_BY_IDS, {"ids": remote_ids})
                cols = [d.name for d in (cur.description or [])]
                rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    except Exception as exc:
        log.error("Remote fetch (retry) failed: %s", exc)
    return rows

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


def _approved_at_str(job: dict) -> str:
    raw = job.get("approved_at")
    if isinstance(raw, datetime):
        return raw.isoformat()
    return str(raw or "")


def _status_for(job: dict) -> str:
    """Determine insert status: 'pending' if scrape failed note, else approved/rejected by completeness."""
    if str(job.get("note") or "").strip() == _SCRAPE_FAILED_NOTE:
        return "pending"
    return "approved" if _is_complete(job) else "rejected"


def _build_payload(job: dict, status: str) -> dict:
    return {
        "company":        str(job.get("company") or "").strip(),
        "job_title":      str(job.get("job_title") or "").strip(),
        "link":           str(job.get("link") or "").strip(),
        "region":         _normalize_region(job.get("region")),
        "note":           str(job.get("note") or "").strip(),
        "description":    str(job.get("description_preview") or "").strip(),
        "status":         status,
        "source":         "sync",
        "submitted_at":   _approved_at_str(job),
        "approved_at":    _approved_at_str(job) if status == "approved" else "",
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

def retry_rejected() -> int:
    """Re-check remote for rejected sync jobs; upgrade to 'approved' if complete.
    Skips any job where sync_locked=True (manually changed by a human)."""
    rejected_sync = [
        j for j in storage.get_jobs()
        if j.get("status") == "rejected"
        and j.get("source") == "sync"
        and not j.get("sync_locked")
    ]
    if not rejected_sync:
        return 0

    # Build lookup: remote_id → local job  (prefer remote_id; fall back to link)
    by_remote_id: dict[str, dict] = {}
    by_link: dict[str, dict] = {}
    for j in rejected_sync:
        rid = str(j.get("sync_remote_id") or "").strip()
        lnk = str(j.get("link") or "").strip()
        if rid:
            by_remote_id[rid] = j
        elif lnk:
            by_link[lnk] = j

    remote_rows: list[dict] = []

    # Fetch by remote UUID
    if by_remote_id:
        remote_rows += _fetch_by_remote_ids(list(by_remote_id.keys()))

    # Fetch by link for jobs without a stored remote_id
    if by_link:
        try:
            with _connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT id::text, company, job_title, link, region,
                               note, description_preview, approved_at
                        FROM jobs
                        WHERE link = ANY(%(links)s)
                    """, {"links": list(by_link.keys())})
                    cols = [d.name for d in (cur.description or [])]
                    remote_rows += [dict(zip(cols, r)) for r in cur.fetchall()]
        except Exception as exc:
            log.error("Remote fetch (retry by link) failed: %s", exc)

    upgraded = 0
    for rjob in remote_rows:
        rid  = str(rjob.get("id") or "")
        lnk  = str(rjob.get("link") or "").strip()
        local = by_remote_id.get(rid) or by_link.get(lnk)
        if not local:
            continue
        if not _is_complete(rjob):
            log.debug(
                "Still incomplete on remote: %s — missing %s",
                rid, _missing_fields(rjob),
            )
            continue
        payload = _build_payload(rjob, "approved")
        payload["id"] = local["id"]
        storage.upsert_job(payload)
        upgraded += 1
        log.info(
            "Upgraded rejected→approved: %s — %s",
            rjob.get("company"), rjob.get("job_title"),
        )

    if upgraded:
        log.info("Upgraded %d rejected job(s) to approved", upgraded)
    else:
        log.info("Retry check: %d rejected sync job(s), none ready yet", len(rejected_sync))

    return upgraded

# ---------------------------------------------------------------------------
# Main sync: fetch new approved jobs from remote
# ---------------------------------------------------------------------------

def sync_once() -> dict:
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    remote_jobs = _fetch_new(since)

    fetched  = len(remote_jobs)
    inserted = 0
    skipped  = 0

    for job in remote_jobs:
        link      = str(job.get("link") or "").strip()
        company   = str(job.get("company") or "").strip()
        job_title = str(job.get("job_title") or "").strip()
        status    = _status_for(job)
        remote_id = str(job.get("id") or "")

        # Skip if any local record already exists with this URL or company+title,
        # regardless of status — preserves manual pending/rejected/deleted decisions.
        if _find_existing(link, company, job_title):
            skipped += 1
            continue

        payload = _build_payload(job, status)
        try:
            storage.upsert_job(payload)
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

    log.info("Sync done — fetched=%d inserted=%d skipped=%d", fetched, inserted, skipped)
    return {"fetched": fetched, "inserted": inserted, "skipped": skipped}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info(
        "Job sync started — interval=%ds lookback=%dh remote=%s",
        SYNC_INTERVAL_SECONDS,
        LOOKBACK_HOURS,
        REMOTE_DB_URL.split("@")[-1],
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
