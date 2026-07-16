"""Read-only client for VPS_1 (Resume-Generator-v2) — the live proxy behind the Profiles, Users,
and Applied tabs, and the resume-file download.

VPS_1 is a *separate* project on another machine (Docker + Postgres, reached only via its nginx HTTPS
vhost). It exposes a dedicated machine-to-machine feed guarded by a shared secret — NOT an interactive
login — mirroring the `/api/external/jobs` + `X-API-Key` pattern both projects already use:

    GET /api/external/profiles           → {profiles: [...], count}
    GET /api/external/users              → {users: [...], count}
    GET /api/external/applications       → {applications: [...], count}   (VPS_1's "Applied")
    GET /api/external/resumes/{id}/file  → the rendered resume bytes (pdf/docx)

Everything here is READ-ONLY and best-effort: if VPS_1 is slow or down, list callers get an empty list
(never an exception into the request), so the local tab still renders its own rows. List results are
cached briefly so a tab load — and its React-Query refetches — don't stampede VPS_1.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

import requests

_BACKEND_DIR = Path(__file__).resolve().parent.parent
try:  # populate os.environ from backend/.env (mirrors job_sync / external router)
    from dotenv import load_dotenv
    load_dotenv(_BACKEND_DIR / ".env")
    load_dotenv(_BACKEND_DIR.parent / ".env")
except Exception:
    pass

log = logging.getLogger("vps1")

# Same remote box as job_sync (one source of truth for the VPS_1 address), but the read feed
# authenticates with a shared API key, not the admin login.
BASE_URL = os.environ.get("JOB_SYNC_API_BASE_URL", "").rstrip("/")
API_KEY = os.environ.get("VPS1_API_KEY", "").strip()
HTTP_TIMEOUT = 15           # a tab load must not hang on a slow remote
FILE_TIMEOUT = 45           # a resume render can take longer than a list read
CACHE_TTL_S = 30            # serve repeated tab loads from cache instead of re-hitting VPS_1

_session = requests.Session()
_cache: dict[str, tuple[float, list]] = {}   # url → (fetched_at, rows)
_cache_lock = threading.Lock()


def is_configured() -> bool:
    return bool(BASE_URL and API_KEY)


def _headers() -> dict:
    return {"X-API-Key": API_KEY}


def _get_json(path: str, params: dict | None = None) -> dict:
    resp = _session.get(f"{BASE_URL}{path}", params=params or {}, headers=_headers(), timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, dict) else {}


def _fetch_list(path: str, key: str, params: dict | None = None) -> list:
    """Best-effort cached read of a `{<key>: [...]}` feed. On any failure returns the cached copy
    (even if stale), else []. Never raises into the caller."""
    if not is_configured():
        return []
    cache_key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted((params or {}).items()))
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit and (now - hit[0]) < CACHE_TTL_S:
            return hit[1]
    try:
        rows = _get_json(path, params).get(key) or []
        if not isinstance(rows, list):
            rows = []
        with _cache_lock:
            _cache[cache_key] = (now, rows)
        return rows
    except Exception as e:
        log.warning("VPS_1 fetch %s failed: %s", path, e)
        with _cache_lock:
            hit = _cache.get(cache_key)          # fall back to a stale copy rather than showing nothing
        return hit[1] if hit else []


# ── the three feeds the tabs need ────────────────────────────────────────────
def get_profiles() -> list[dict]:
    return _fetch_list("/api/external/profiles", "profiles")


def get_users() -> list[dict]:
    return _fetch_list("/api/external/users", "users")


def get_applications(limit: int = 2000) -> list[dict]:
    return _fetch_list("/api/external/applications", "applications", {"limit": limit})


# ── resume file passthrough (not cached — streamed straight to the browser) ──
def get_resume_file(resume_id: str, fmt: str = "pdf") -> tuple[bytes, str, str] | None:
    """Fetch a VPS_1 resume's rendered file. Returns (content, filename, media_type) or None if
    unconfigured / not found / VPS_1 unreachable. `resume_id` is VPS_1's raw id (no 'vps1:' prefix)."""
    if not is_configured():
        return None
    try:
        resp = _session.get(
            f"{BASE_URL}/api/external/resumes/{resume_id}/file",
            params={"fmt": fmt}, headers=_headers(), timeout=FILE_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception as e:
        log.warning("VPS_1 resume file %s (%s) failed: %s", resume_id, fmt, e)
        return None
    cd = resp.headers.get("Content-Disposition", "")
    filename = "resume.pdf"
    if "filename*=UTF-8''" in cd:
        from urllib.parse import unquote
        filename = unquote(cd.split("filename*=UTF-8''", 1)[1].strip())
    elif "filename=" in cd:
        filename = cd.split("filename=", 1)[1].strip().strip('"')
    media = resp.headers.get("Content-Type", "application/octet-stream")
    return resp.content, filename, media
