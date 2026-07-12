"""Interview notifications: turn board events + the schedule into Web Push messages for callers.

Two sources:
  • event pushes  — fired from the interviews router when an admin assigns a caller or changes an
                    interview's time/content (on_row_changed).
  • timed reminders — a background tick (run_due_reminders) that fires, per the caller's timezone:
                        7pm the day before, 8am the interview day, and 1 hour before the start.

All sends are best-effort; nothing here raises into a request or the scheduler loop. Sent reminders
are de-duped in data/notif_state.json (keyed by row+type+scheduled-time, so changing the time re-arms
the reminders).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except Exception:                       # pragma: no cover
    ZoneInfo = None

from core import push

log = logging.getLogger("notify")

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_GRID_FILE = DATA_DIR / "interviews.json"
_STATE_FILE = DATA_DIR / "notif_state.json"
_lock = threading.Lock()

_CONTENT_KEYS = ("c_title", "c_company", "c_skill", "c_client", "c_jd", "c_account", "c_type")
_CONTENT_DEBOUNCE = timedelta(minutes=10)   # at most one "interview updated" per row per window
_MISS_WINDOW = timedelta(hours=2)           # a reminder more than this late is suppressed, not spammed


# ── state file (sent reminders + content-notif debounce) ─────────────────────
def _read_state() -> dict:
    if not _STATE_FILE.exists():
        return {"sent": [], "content_at": {}}
    try:
        s = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
        s.setdefault("sent", [])
        s.setdefault("content_at", {})
        return s
    except Exception:
        return {"sent": [], "content_at": {}}


def _write_state(state: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _STATE_FILE)


# ── caller resolution (c_caller cell → user) ─────────────────────────────────
def _resolve_caller(identity: str) -> dict | None:
    """Match a c_caller value (username or full name, case-insensitive) to a user record."""
    needle = str(identity or "").strip().lower()
    if not needle:
        return None
    from auth import storage   # lazy: avoids an import cycle (auth imports core.*)
    u = storage.get_user_by_username(needle)
    if u:
        return u
    for x in storage.get_users():
        if needle in (str(x.get("username", "")).strip().lower(), str(x.get("full_name", "")).strip().lower()):
            return x
    return None


def _notify_caller_async(identity: str, payload: dict) -> None:
    """Resolve the caller and push in a daemon thread so an interview edit never blocks on the network."""
    def _run():
        try:
            user = _resolve_caller(identity)
            if user:
                push.send_push(user["id"], payload)
        except Exception:
            log.exception("event push failed for caller %r", identity)
    threading.Thread(target=_run, daemon=True).start()


def _title_of(cells: dict) -> str:
    return str(cells.get("c_title") or cells.get("c_index") or "interview").strip() or "interview"


# ── event pushes (called by the interviews router after a save) ──────────────
def on_row_changed(row_id: str, before: dict, after: dict, actor: dict) -> None:
    """Emit assignment / time-change / content-change pushes to the affected caller. Only ADMIN edits
    notify (a caller editing their own Approved/Status must not ping themselves). Best-effort."""
    try:
        if not (actor or {}).get("is_admin"):
            return
        after = after or {}
        before = before or {}
        caller = str(after.get("c_caller", "")).strip()
        prev_caller = str(before.get("c_caller", "")).strip()
        title = _title_of(after)

        # (1) assignment: the Caller cell was set or reassigned to someone new
        if caller and caller.lower() != prev_caller.lower():
            _notify_caller_async(caller, {
                "title": "New interview assigned",
                "body": f"You've been assigned: {title}",
                "tag": f"iv-assign-{row_id}", "url": "/interviews",
            })
            return   # brand-new to them → don't also fire change pushes for the same edit
        if not caller:
            return

        # (2) time change
        if str(after.get("c_sched", "")) != str(before.get("c_sched", "")):
            _notify_caller_async(caller, {
                "title": "Interview time changed",
                "body": f"{title}: the schedule was updated — check the board.",
                "tag": f"iv-time-{row_id}", "url": "/interviews",
            })
            return

        # (3) content change (debounced so per-field edits don't spam)
        if any(str(after.get(k, "")) != str(before.get(k, "")) for k in _CONTENT_KEYS):
            with _lock:
                state = _read_state()
                last = state["content_at"].get(row_id)
                now = datetime.now(timezone.utc)
                if last:
                    try:
                        if now - datetime.fromisoformat(last) < _CONTENT_DEBOUNCE:
                            return
                    except Exception:
                        pass
                state["content_at"][row_id] = now.isoformat()
                _write_state(state)
            _notify_caller_async(caller, {
                "title": "Interview updated",
                "body": f"{title}: the details were updated — check the board.",
                "tag": f"iv-content-{row_id}", "url": "/interviews",
            })
    except Exception:
        log.exception("on_row_changed failed for row %s", row_id)


# ── timed reminders ──────────────────────────────────────────────────────────
def _parse_instant(s: str) -> datetime | None:
    """Parse a Scheduled_at UTC instant (ends in Z or ±hh:mm). Bare wall-clock values are skipped."""
    try:
        dt = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc) if dt.tzinfo else None
    except Exception:
        return None


def _reminder_targets(sched_utc: datetime, tz_name: str) -> dict:
    """{reminder_type: target_utc}. `hour_before` is absolute; the 7pm/8am ones need the caller tz."""
    targets = {"hour_before": sched_utc - timedelta(hours=1)}
    if tz_name and ZoneInfo is not None:
        try:
            tz = ZoneInfo(tz_name)
            d = sched_utc.astimezone(tz).date()
            prev = d - timedelta(days=1)
            targets["day_of_8am"] = datetime(d.year, d.month, d.day, 8, 0, tzinfo=tz).astimezone(timezone.utc)
            targets["day_before_7pm"] = datetime(prev.year, prev.month, prev.day, 19, 0, tzinfo=tz).astimezone(timezone.utc)
        except Exception:
            pass
    return targets


def _fmt_local(sched_utc: datetime, tz_name: str) -> str:
    # Format in the caller's tz. Built manually — the %-d / %-I strftime codes are glibc-only and
    # raise on Windows (which silently fell the display back to UTC).
    dt = sched_utc
    if tz_name and ZoneInfo is not None:
        try:
            dt = sched_utc.astimezone(ZoneInfo(tz_name))
        except Exception:
            dt = sched_utc
    try:
        hour12 = dt.hour % 12 or 12
        ampm = "AM" if dt.hour < 12 else "PM"
        return f"{dt.strftime('%a %b')} {dt.day}, {hour12}:{dt.minute:02d} {ampm}"
    except Exception:
        return ""


def _reminder_payload(rtype: str, title: str, sched_utc: datetime, tz_name: str) -> dict:
    when = _fmt_local(sched_utc, tz_name)
    text = {
        "day_before_7pm": ("Interview tomorrow", f"{title} — tomorrow, {when}"),
        "day_of_8am": ("Interview today", f"{title} — today, {when}"),
        "hour_before": ("Interview in 1 hour", f"{title} — {when}"),
    }.get(rtype, ("Interview reminder", f"{title} — {when}"))
    return {"title": text[0], "body": text[1], "tag": f"{rtype}-{title}",
            "url": "/interviews", "requireInteraction": True}


def _read_grid() -> dict:
    try:
        g = json.loads(_GRID_FILE.read_text(encoding="utf-8"))
        return g if isinstance(g, dict) else {}
    except Exception:
        return {}


def run_due_reminders() -> int:
    """Scan the board once and fire any reminder whose target time has just arrived. Returns the number
    of notifications sent. De-dupes via data/notif_state.json so a reminder fires at most once."""
    now = datetime.now(timezone.utc)
    grid = _read_grid()
    rows = grid.get("rows", []) if isinstance(grid, dict) else []
    with _lock:
        state = _read_state()
    sent = set(state.get("sent", []))
    fired = 0
    dirty = False
    for row in rows:
        cells = row.get("cells") or {}
        caller_id = str(cells.get("c_caller", "")).strip()
        sched_raw = str(cells.get("c_sched", "")).strip()
        if not caller_id or not sched_raw:
            continue
        sched_utc = _parse_instant(sched_raw)
        if not sched_utc or sched_utc < now:        # unparseable or already started → no reminders
            continue
        user = _resolve_caller(caller_id)
        if not user:
            continue
        tz_name = str(user.get("timezone", "")).strip()
        title = _title_of(cells)
        for rtype, target in _reminder_targets(sched_utc, tz_name).items():
            key = f"{row.get('id')}|{rtype}|{sched_raw}"   # includes sched → a time change re-arms
            if key in sent or now < target:
                continue
            sent.add(key); dirty = True
            if now - target > _MISS_WINDOW:               # missed the window (downtime) → suppress, don't spam
                continue
            try:
                push.send_push(user["id"], _reminder_payload(rtype, title, sched_utc, tz_name))
                fired += 1
            except Exception:
                log.exception("reminder push failed (%s, row %s)", rtype, row.get("id"))
    if dirty:
        with _lock:
            state = _read_state()
            state["sent"] = sorted(set(state.get("sent", [])) | sent)[-5000:]   # cap growth
            _write_state(state)
    return fired


def scheduler_loop(interval_s: int = 60) -> None:
    """Blocking loop for a background thread: run reminders every `interval_s` seconds, forever."""
    log.info("Interview reminder scheduler started (every %ss)", interval_s)
    while True:
        try:
            run_due_reminders()
        except Exception:
            log.exception("reminder tick failed")
        time.sleep(interval_s)
