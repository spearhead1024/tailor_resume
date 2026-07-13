"""Interview reminders — Web Push notifications for the caller, driven purely by the schedule.

Exactly three reminders per interview, in the CALLER's timezone:
  • 7pm the day before the interview
  • 8am on the interview day
  • 1 hour before it starts

Nothing else notifies: board edits (assignment, time/content changes, chat) deliberately stay silent.

A background tick (scheduler_loop → run_due_reminders) scans the board every minute and fires any
reminder whose moment has arrived. The board is read from the DB (interview_rows). Sends are
best-effort and never raise into the loop. Reminders are de-duped in data/notif_state.json, keyed by
row + type + scheduled-time — so each fires once, and changing an interview's time re-arms its
reminders.

The 7pm / 8am reminders need the caller's profile timezone; without one, only the 1-hour reminder
(which is absolute) can fire for them.
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
from core.storage import Storage

log = logging.getLogger("notify")

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_STATE_FILE = DATA_DIR / "notif_state.json"
_lock = threading.Lock()

# The board lives in SQLite (interview_columns / interview_rows). Storage is a thin handle over the
# DB path, so building our own here costs nothing and keeps core.notify free of an import cycle
# back through auth.
_storage = Storage(DATA_DIR)



# ── sent-reminder log (de-dupe) ──────────────────────────────────────────────
def _read_state() -> dict:
    if not _STATE_FILE.exists():
        return {"sent": []}
    try:
        s = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
        s.setdefault("sent", [])
        return s
    except Exception:
        return {"sent": []}


def _write_state(state: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _STATE_FILE)


# ── caller resolution (the Caller cell → a user record) ──────────────────────
def _resolve_person(identity: str) -> dict | None:
    """Match a Caller cell value (username or full name, case-insensitive) to a user."""
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


def _title_of(cells: dict) -> str:
    return str(cells.get("c_title") or cells.get("c_index") or "interview").strip() or "interview"


# ── reminder times ───────────────────────────────────────────────────────────
def _parse_instant(s: str) -> datetime | None:
    """Parse a Scheduled_at UTC instant (ends in Z or ±hh:mm). Bare wall-clock values are skipped."""
    try:
        dt = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc) if dt.tzinfo else None
    except Exception:
        return None


def _local(sched_utc: datetime, tz_name: str) -> datetime:
    if tz_name and ZoneInfo is not None:
        try:
            return sched_utc.astimezone(ZoneInfo(tz_name))
        except Exception:
            pass
    return sched_utc


def _fmt_time(sched_utc: datetime, tz_name: str) -> str:
    """"2:30 PM" in the caller's tz. Built manually — the %-I strftime code is glibc-only and raises
    on Windows (which silently fell the display back to UTC)."""
    dt = _local(sched_utc, tz_name)
    try:
        return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"
    except Exception:
        return ""


def _read_grid() -> dict:
    """The board, straight from the DB. Read-only — the scheduler never writes to it."""
    try:
        return _storage.get_interview_grid()
    except Exception:
        log.exception("could not read the interviews board; skipping this reminder tick")
        return {}


def _upcoming(now: datetime) -> list[dict]:
    """Every future interview on the board that has both a caller and a schedule, resolved to a user."""
    out = []
    for row in (_read_grid().get("rows", []) or []):
        cells = row.get("cells") or {}
        caller_id = str(cells.get("c_caller", "")).strip()
        sched_raw = str(cells.get("c_sched", "")).strip()
        if not caller_id or not sched_raw:
            continue
        sched_utc = _parse_instant(sched_raw)
        if not sched_utc or sched_utc < now:        # unparseable or already started → no reminders
            continue
        user = _resolve_person(caller_id)
        if not user:
            continue
        out.append({
            "row_id": row.get("id"), "user": user, "tz": str(user.get("timezone", "")).strip(),
            "sched": sched_utc, "sched_raw": sched_raw, "title": _title_of(cells),
            "index": str(cells.get("c_index", "") or "").strip(),      # the call number
            "who": str(cells.get("c_client", "") or "").strip(),       # Interviewer(role) — who they speak to
        })
    return out


def _call_line(c: dict, tz_name: str) -> str:
    """One call, as a caller needs to see it at a glance:
         "#4  1:30 PM — Senior Software Engineer · with Robert James (HR manager)"
    Call number and interviewer are dropped when the board leaves them blank."""
    head = f"#{c['index']}  " if c["index"] else ""
    line = f"{head}{_fmt_time(c['sched'], tz_name)} — {c['title']}"
    if c["who"]:
        line += f" · with {c['who']}"
    return line


def _digest_payload(rtype: str, calls: list[dict], tz_name: str) -> dict:
    """One notification covering ALL of a caller's interviews for a given day.
    `rtype` is 'before@<hour>' (the day-before digest) or 'dayof@<hour>'."""
    when = "tomorrow" if rtype.startswith("before@") else "today"
    n = len(calls)
    return {
        "title": f"{n} interview{'' if n == 1 else 's'} {when}",
        "body": "\n".join(_call_line(c, tz_name) for c in calls),
        "tag": f"{rtype}-{calls[0]['user']['id']}",
        "url": "/interviews", "requireInteraction": True,
    }


def _config() -> dict:
    """Admin-set reminder settings (Settings → Notifications). Falls back to the defaults if the
    settings row can't be read, so the scheduler always has usable values."""
    try:
        from auth import storage
        cfg = storage.get_app_settings().get("notifications")
        if isinstance(cfg, dict) and cfg:
            return cfg
    except Exception:
        log.exception("could not read notification settings; using defaults")
    return {"lead_enabled": True, "lead_minutes": 60, "day_before_enabled": True,
            "day_before_hour": 19, "day_of_enabled": True, "day_of_hour": 8}


def _lead_label(minutes: int) -> str:
    """60 → '1 hour', 90 → '1 hour 30 minutes', 30 → '30 minutes'."""
    h, m = divmod(max(1, int(minutes)), 60)
    parts = []
    if h:
        parts.append(f"{h} hour{'' if h == 1 else 's'}")
    if m:
        parts.append(f"{m} minute{'' if m == 1 else 's'}")
    return " ".join(parts)


def run_due_reminders() -> int:
    """Scan the board once and fire every reminder whose moment has arrived.

    Per caller (all times on the CALLER's clock; the hours/lead are admin-set in Settings):
      • day-before hour (default 7pm) and day-of hour (default 8am) → ONE digest each, covering ALL
        that day's calls (2 calls on a day = 1 notification at 7pm, not 2).
      • lead reminder (default 60 min before) → one per call.
      So a caller with 2 calls on one day gets 4 notifications: 1 + 1 + 2.

    De-duped via data/notif_state.json, so each fires at most once. The dedupe keys embed the
    configured lead/hour, so changing a setting re-arms the affected reminders. Returns the number
    sent."""
    now = datetime.now(timezone.utc)
    calls = _upcoming(now)
    cfg = _config()
    lead_min = int(cfg.get("lead_minutes", 60) or 60)
    h_before = int(cfg.get("day_before_hour", 19))
    h_of = int(cfg.get("day_of_hour", 8))
    with _lock:
        state = _read_state()
    sent = set(state.get("sent", []))
    fired, dirty = 0, False

    def claim(key: str, target: datetime, deadline: datetime) -> bool:
        """True if this reminder is due AND still meaningful. Marks it sent either way, so it fires once.

        A reminder whose moment already passed still fires — catching up matters: an interview booked
        for later today must tell the caller "today" straight away, not stay silent until an hour
        before. `deadline` is when the wording stops being true (e.g. "interview tomorrow" is only
        true until that day actually begins); past it the reminder is dropped rather than sent wrong."""
        nonlocal dirty
        if key in sent or now < target:
            return False
        sent.add(key); dirty = True
        return now < deadline

    # (1) the lead reminder (admin-set, default 60 min before) — one per call. Keyed on the sched AND
    #     the lead, so changing either the interview time or the setting re-arms it. Meaningful right
    #     up until the interview actually starts.
    if cfg.get("lead_enabled", True):
        for c in calls:
            key = f"{c['row_id']}|lead{lead_min}m|{c['sched_raw']}"
            if claim(key, c["sched"] - timedelta(minutes=lead_min), c["sched"]):
                try:
                    push.send_push(c["user"]["id"], {
                        "title": f"Interview in {_lead_label(lead_min)}",
                        "body": _call_line(c, c["tz"]),
                        "tag": f"lead-{c['row_id']}",
                        "url": "/interviews", "requireInteraction": True,
                    })
                    fired += 1
                except Exception:
                    log.exception("lead push failed (row %s)", c["row_id"])

    # (2) day-before + day-of digests — ONE per caller per day, covering all that day's calls. Both
    #     need the caller's timezone; without one they can't be placed (the lead reminder still works).
    groups: dict[tuple[str, object], list[dict]] = {}
    for c in calls:
        if not c["tz"] or ZoneInfo is None:
            continue
        try:
            day = c["sched"].astimezone(ZoneInfo(c["tz"])).date()
        except Exception:
            continue
        groups.setdefault((c["user"]["id"], day), []).append(c)

    for (uid, day), group in groups.items():
        group.sort(key=lambda c: c["sched"])
        tz_name = group[0]["tz"]
        try:
            tz = ZoneInfo(tz_name)
            prev = day - timedelta(days=1)
            # Each digest is due at its (admin-set) hour and stays valid only while its wording holds:
            #   "interviews tomorrow" — until that day actually begins (local midnight)
            #   "interviews today"    — until the day's last call starts
            midnight = datetime(day.year, day.month, day.day, 0, 0, tzinfo=tz).astimezone(timezone.utc)
            last_call = group[-1]["sched"]
            targets = {}
            if cfg.get("day_before_enabled", True):
                targets[f"before@{h_before}"] = (
                    datetime(prev.year, prev.month, prev.day, h_before, 0, tzinfo=tz).astimezone(timezone.utc), midnight)
            if cfg.get("day_of_enabled", True):
                targets[f"dayof@{h_of}"] = (
                    datetime(day.year, day.month, day.day, h_of, 0, tzinfo=tz).astimezone(timezone.utc), last_call)
        except Exception:
            continue
        for rtype, (target, deadline) in targets.items():
            key = f"{uid}|{day.isoformat()}|{rtype}"      # one digest per caller per day per type
            if claim(key, target, deadline):
                try:
                    push.send_push(uid, _digest_payload(rtype, group, tz_name))
                    fired += 1
                except Exception:
                    log.exception("%s digest push failed (user %s, %s)", rtype, uid, day)

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
