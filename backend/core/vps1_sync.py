"""Hourly mirror of VPS_1 (Resume-Generator-v2) into VPS_2's local DB.

WHY a background sync instead of fetching on each tab load: the live proxy hit VPS_1 over the network
on every Profiles/Users/Applied page view — a network round-trip in the critical path of every load.
This worker pulls the whole snapshot once an hour into dedicated cache tables (vps1_profiles /
vps1_users / vps1_applications), so the tabs read from local SQLite and render instantly.

Design:
  • FULL REPLACE each cycle. It is always-correct (it also picks up status changes on old rows, which
    an incremental created_at pull would miss) and the payloads are small (profiles/users are KBs;
    applications ~7 MB / ~4 s — trivial hourly). No dedup/merge logic to get wrong.
  • Each table is swapped in ONE transaction (storage.replace_vps1_*), so a reader never sees a
    half-written snapshot.
  • Best-effort: a failed fetch leaves the previous snapshot in place (the tabs keep showing the last
    good data) and we retry next cycle. A partial success (e.g. users ok, applications failed) keeps
    the stale table for the part that failed rather than blanking it.

Runs as a standalone pm2 process, like core/job_sync.py.
"""
from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

try:
    from dotenv import load_dotenv
    load_dotenv(_BACKEND_DIR / ".env")
    load_dotenv(_BACKEND_DIR.parent / ".env")
except Exception:
    pass

from auth import storage
from core import vps1_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [vps1-sync] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("vps1_sync")

SYNC_INTERVAL_SECONDS = 60 * 60          # every hour, per requirement


def _sync_feed(name: str, fetch, replace) -> None:
    """Fetch one feed and full-replace its cache table. A fetch that returns nothing is treated as a
    failure (leave the previous snapshot), NOT as "VPS_1 now has zero rows" — the far more likely
    cause is that VPS_1 was briefly unreachable, and blanking the tab would be the worse outcome."""
    try:
        rows = fetch()
    except Exception:
        log.exception("%s: fetch raised; keeping previous snapshot", name)
        return
    if not rows:
        log.warning("%s: fetched 0 rows — keeping previous snapshot (treating as a transient miss)", name)
        return
    try:
        n = replace(rows)
        log.info("%s: mirrored %d rows", name, n)
    except Exception:
        log.exception("%s: DB replace failed; previous snapshot left intact", name)


def sync_once() -> None:
    if not vps1_client.is_configured():
        log.warning("VPS_1 not configured (need JOB_SYNC_API_BASE_URL + VPS1_API_KEY) — skipping cycle")
        return
    log.info("Sync starting — remote=%s", vps1_client.BASE_URL)
    _sync_feed("profiles", vps1_client.get_profiles, storage.replace_vps1_profiles)
    _sync_feed("users", vps1_client.get_users, storage.replace_vps1_users)
    _sync_feed("applications", vps1_client.get_applications, storage.replace_vps1_applications)
    log.info("Sync done")


def main() -> None:
    log.info("VPS_1 mirror started — interval=%ss remote=%s", SYNC_INTERVAL_SECONDS, vps1_client.BASE_URL)
    while True:
        try:
            sync_once()
        except Exception:
            log.exception("Unexpected error in sync cycle")
        time.sleep(SYNC_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
