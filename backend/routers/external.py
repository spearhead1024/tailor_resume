"""External job-feed API (machine-to-machine).

A read-only, API-key-authenticated endpoint that lets a *separate* server
(another VPS) pull recent jobs from this instance. This is the PROVIDER side;
auth is a shared secret sent in a header, NOT the user JWT.

Configure the secret in backend/.env (git-ignored):

    EXTERNAL_API_KEY=<long-random-string>

If the key is unset/blank the endpoint is DISABLED (503) so jobs are never
exposed without a configured secret.

Usage from the other VPS:

    curl -H "X-API-Key: <key>" \
         "https://tailorresume.duckdns.org/api/external/jobs?limit=200&since=2026-06-01T00:00:00Z"
"""
from __future__ import annotations

import hmac
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query

# Load EXTERNAL_API_KEY from backend/.env (mirrors core/job_sync.py). Importing
# this module (done by main.py) populates os.environ for the whole process.
_BACKEND_DIR = Path(__file__).resolve().parent.parent
try:  # pragma: no cover - best effort
    from dotenv import load_dotenv
    load_dotenv(_BACKEND_DIR / ".env")
    load_dotenv(_BACKEND_DIR.parent / ".env")
except Exception:
    pass

from auth import storage

router = APIRouter(prefix="/api/external", tags=["external"])

# Job statuses the feed is allowed to expose. "all" lifts the status filter.
_ALLOWED_STATUS = {"approved", "pending", "rejected", "deleted", "all"}


def _configured_key() -> str:
    return os.environ.get("EXTERNAL_API_KEY", "").strip()


def require_api_key(
    x_api_key: str = Header(default="", alias="X-API-Key"),
    authorization: str = Header(default=""),
) -> None:
    """Constant-time shared-secret check.

    Accepts the key as either `X-API-Key: <key>` or `Authorization: Bearer <key>`.
    When no key is configured server-side the feature is disabled (503) — it
    never falls open.
    """
    configured = _configured_key()
    if not configured:
        raise HTTPException(status_code=503, detail="External job API is not enabled.")
    presented = (x_api_key or "").strip()
    if not presented and authorization.lower().startswith("bearer "):
        presented = authorization[7:].strip()
    # hmac.compare_digest is constant-time; guard empty to avoid a trivial pass.
    if not presented or not hmac.compare_digest(presented, configured):
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_since(s: str) -> datetime | None:
    """Parse an ISO-8601 instant into a naive-UTC datetime (matching how
    submitted_at is stored). Returns None for blank input."""
    raw = (s or "").strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Invalid 'since' — use ISO-8601, e.g. 2026-06-01T00:00:00Z.",
        )
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _public_job(j: dict) -> dict:
    """Project a stored job down to the content fields safe to share. Internal
    bookkeeping (reports, flags, who-added, sync/scrape state, admin actions,
    private notes) is deliberately omitted."""
    return {
        "id": j.get("id", ""),
        "company": j.get("company", ""),
        "job_title": j.get("job_title", ""),
        "description": j.get("description", ""),
        "link": j.get("link", ""),
        "region": j.get("region", "ANY"),
        "status": j.get("status", "approved"),
        "submitted_at": j.get("submitted_at", ""),
        "approved_at": j.get("approved_at", ""),
        "source": j.get("source", ""),
    }


@router.get("/jobs")
def external_jobs(
    limit: int = Query(100, ge=1, le=1000, description="Max number of jobs to return (size)."),
    since: str = Query("", description="Only jobs submitted at/after this ISO-8601 UTC instant."),
    region: str = Query("", description="Filter by region code (e.g. US). Blank = all regions."),
    status: str = Query("approved", description="Job status to export; 'all' for any. Default approved."),
    _: None = Depends(require_api_key),
):
    """Read-only feed of recent jobs for a trusted external server.

    Newest jobs first, capped by `limit` (the requested size). Authenticate with
    the shared secret via `X-API-Key` (or `Authorization: Bearer`).
    """
    st = (status or "approved").strip().lower()
    if st not in _ALLOWED_STATUS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status — allowed: {', '.join(sorted(_ALLOWED_STATUS))}.",
        )
    since_dt = _parse_since(since)
    rows = storage.export_recent_jobs(
        limit=limit,
        since=since_dt,
        status="" if st == "all" else st,
        region=region,
    )
    jobs = [_public_job(j) for j in rows]
    return {
        "jobs": jobs,
        "count": len(jobs),
        "limit": limit,
        "since": since_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if since_dt else "",
        "server_time": _utcnow_iso(),
    }
