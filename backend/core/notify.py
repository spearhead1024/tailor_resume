"""Interview reminders — Web Push notifications for the caller, driven purely by the schedule.

Exactly three reminders per interview, in the CALLER's timezone:
  • 7pm the day before the interview
  • 8am on the interview day
  • 1 hour before it starts

Nothing else notifies: board edits (assignment, time/content changes, chat) deliberately stay silent.

A background tick (scheduler_loop → run_due_reminders) scans the board every minute and fires any
reminder whose moment has arrived. Sends are best-effort and never raise into the loop. Reminders are
de-duped in data/notif_state.json, keyed by row + type + scheduled-time — so each fires once, and
changing an interview's time re-arms its reminders.

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

from core import inbox, push
from core.hub import hub

log = logging.getLogger("notify")


def _snooze_token(user_id: str, payload: dict) -> str:
    """A short-lived, self-contained ticket that lets the SNOOZE button work with no tab open.

    A service worker has no access to the app's JWT, so it cannot authenticate a normal API call.
    The alarm therefore carries its own signed ticket: the server minted it, so it can trust it back.
    Signed with the app secret and expiring in 12h, it only ever means "re-send THIS reminder to THIS
    person"."""
    import jwt as _jwt
    from auth import JWT_ALGORITHM, JWT_SECRET
    clean = {k: v for k, v in payload.items() if k != "snooze_token"}   # never nest the ticket in itself
    return _jwt.encode(
        {"sub": user_id, "snz": clean,
         "exp": int((datetime.now(timezone.utc) + timedelta(hours=12)).timestamp())},
        JWT_SECRET, algorithm=JWT_ALGORITHM)


def _deliver(user_id: str, payload: dict, row_id: str = "") -> None:
    """One reminder → three places: the OS push, the in-app inbox (so it can't be missed), and the
    live socket (so an open tab's bell updates without a refresh). Filed as 'reminder', kept apart
    from board-change chatter so an imminent interview never gets buried under edit noise."""
    if payload.get("alarm"):
        payload = {**payload, "snooze_token": _snooze_token(user_id, payload)}
    push.send_push(user_id, payload)
    title, body = str(payload.get("title", "")), str(payload.get("body", ""))
    inbox.add([user_id], "reminder", title, body, row_id=row_id)
    hub.broadcast_soon({"type": "notify", "kind": "reminder", "title": title, "body": body,
                        "row_id": row_id}, {user_id})


# ── snooze queue ─────────────────────────────────────────────────────────────
def _read_snooze() -> list[dict]:
    try:
        d = json.loads(_SNOOZE_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _write_snooze(items: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _SNOOZE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _SNOOZE_FILE)


def snooze_add(user_id: str, payload: dict, minutes: int = 5) -> None:
    """Re-send this alarm in `minutes`. Persisted, so a server restart doesn't lose it."""
    minutes = min(max(int(minutes or 5), 1), 120)
    due = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    with _lock:
        items = _read_snooze()
        items.append({"at": due.isoformat(), "user_id": str(user_id), "payload": payload})
        _write_snooze(items[-500:])


def run_due_snoozes() -> int:
    """Fire any snoozed alarm whose time has come. Called on each scheduler tick."""
    now = datetime.now(timezone.utc)
    with _lock:
        items = _read_snooze()
    due, keep = [], []
    for it in items:
        try:
            when = datetime.fromisoformat(str(it.get("at", "")).replace("Z", "+00:00"))
        except Exception:
            continue                     # unparseable → drop it rather than retry forever
        (due if when <= now else keep).append(it)
    for it in due:
        try:
            push.send_push(it["user_id"], it["payload"])
        except Exception:
            log.exception("snoozed alarm failed")
    if due:
        with _lock:
            _write_snooze(keep)
    return len(due)

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_GRID_FILE = DATA_DIR / "interviews.json"
_STATE_FILE = DATA_DIR / "notif_state.json"
_SNOOZE_FILE = DATA_DIR / "notif_snooze.json"   # alarms the user hit "Snooze" on, to re-fire later
_lock = threading.Lock()

# How late a "N minutes before" reminder (caller lead / creator ping) may still fire.
#
# It must be generous enough that a call booked at short notice STILL warns the caller — dropping the
# reminder entirely would be worse than the bug it fixes — but tight enough that a 90-minute creator
# ping never goes out when the call is nearly starting. With the truthful label below, a late fire
# says what's actually left ("in 50 minutes"), so it is never a lie either way.
_LEAD_GRACE = timedelta(minutes=30)



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
    try:
        g = json.loads(_GRID_FILE.read_text(encoding="utf-8"))
        return g if isinstance(g, dict) else {}
    except Exception:
        return {}


# Only an interview in this Status is live enough to remind anyone about. Anything else — Done,
# Closed, On-hold, Not Done, Failed, … — is finished or parked, so it must stay silent.
NOTIFY_STATUS = "scheduled"


def _upcoming(now: datetime) -> list[dict]:
    """Every future, still-Scheduled interview that has a caller, resolved to users."""
    out = []
    for row in (_read_grid().get("rows", []) or []):
        cells = row.get("cells") or {}
        if str(cells.get("c_status", "")).strip().lower() != NOTIFY_STATUS:
            continue                                # not Scheduled → no reminders at all
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
        creater_name = str(cells.get("c_creater", "") or "").strip()
        out.append({
            "row_id": row.get("id"), "user": user, "tz": str(user.get("timezone", "")).strip(),
            "sched": sched_utc, "sched_raw": sched_raw, "title": _title_of(cells),
            "index": str(cells.get("c_index", "") or "").strip(),      # the call number
            "who": str(cells.get("c_client", "") or "").strip(),       # Interviewer(role) — who they speak to
            "caller": caller_id,                                       # shown to the creater
            "creater": _resolve_person(creater_name) if creater_name else None,
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
        "url": "/interviews", "alarm": True,
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


def _remaining_label(sched_utc: datetime, now: datetime) -> str:
    """How long is ACTUALLY left, so a reminder can never overstate its own lead time.

    Rounded to the nearest 5 minutes: a tick firing 40s after the 90-minute mark still reads as a
    clean "1 hour 30 minutes", while a genuinely late one tells the truth instead of lying."""
    mins = (sched_utc - now).total_seconds() / 60.0
    return _lead_label(max(5, int(round(mins / 5.0)) * 5))


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
    creator_min = int(cfg.get("creator_minutes", 90) or 90)
    h_before = int(cfg.get("day_before_hour", 19))
    h_of = int(cfg.get("day_of_hour", 8))
    with _lock:
        state = _read_state()
    sent = set(state.get("sent", []))
    fired, dirty = 0, False

    def claim(key: str, target: datetime, deadline: datetime) -> bool:
        """For the DAY digests. Fires once; catching up matters here — an interview booked for later
        today must say "today" straight away rather than stay silent. `deadline` is when the wording
        stops being true (e.g. "tomorrow" only holds until that day begins); past it, it's dropped."""
        nonlocal dirty
        if key in sent or now < target:
            return False
        sent.add(key); dirty = True
        return now < deadline

    def claim_at_moment(key: str, target: datetime, sched: datetime) -> bool:
        """For the "N minutes before" reminders (caller lead + creator ping).

        These must land near their moment. A call booked with less notice than the configured lead
        has already missed it — firing then announced "in 90 minutes" with far less time left, which
        is what produced the bogus creator ping. Past the grace window we stay silent.

        Crucially the key is consumed ONLY when we actually send. A reminder we skipped is not
        "already sent": if the call is later moved to a time that gives it a real moment again, it
        must still be able to fire."""
        nonlocal dirty
        if key in sent or now < target:
            return False
        if (now - target) > _LEAD_GRACE or now >= sched:
            return False                       # moment missed / call already started → silent, NOT consumed
        sent.add(key); dirty = True
        return True

    # (1) the lead reminder (admin-set, default 60 min before) — one per call. Keyed on the sched AND
    #     the lead, so changing either the interview time or the setting re-arms it. Meaningful right
    #     up until the interview actually starts.
    if cfg.get("lead_enabled", True):
        for c in calls:
            key = f"{c['row_id']}|lead{lead_min}m|{c['sched_raw']}"
            if claim_at_moment(key, c["sched"] - timedelta(minutes=lead_min), c["sched"]):
                try:
                    _deliver(c["user"]["id"], {
                        "title": f"Interview in {_remaining_label(c['sched'], now)}",
                        "body": _call_line(c, c["tz"]),
                        "tag": f"lead-{c['row_id']}",
                        "url": "/interviews", "alarm": True,
                    }, c["row_id"])
                    fired += 1
                except Exception:
                    log.exception("lead push failed (row %s)", c["row_id"])

    # (1b) the CREATER's own heads-up (admin-set, default 90 min before) — goes to whoever booked the
    #      call, not the caller, and names the caller so they know who's covering it. Times are shown
    #      on the CREATER's clock, since it's their reminder.
    if cfg.get("creator_enabled", True):
        for c in calls:
            creater = c.get("creater")
            if not creater:
                continue                       # nobody in the Creater cell (or it matched no user)
            # Keyed on the ROW ALONE — deliberately not on the scheduled time. The creator is the one
            # who books and reschedules the call, so one heads-up is all they need; re-arming on every
            # time change is what pinged them twice for the same interview.
            key = f"{c['row_id']}|creator"
            if claim_at_moment(key, c["sched"] - timedelta(minutes=creator_min), c["sched"]):
                try:
                    ctz = str(creater.get("timezone", "")).strip()
                    body = _call_line(c, ctz)
                    if c.get("caller"):
                        body += f" · caller: {c['caller']}"
                    _deliver(creater["id"], {
                        "title": f"Interview you booked — in {_remaining_label(c['sched'], now)}",
                        "body": body,
                        "tag": f"creator-{c['row_id']}",
                        "url": "/interviews", "alarm": True,
                    }, c["row_id"])
                    fired += 1
                except Exception:
                    log.exception("creator push failed (row %s)", c["row_id"])

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
                    _deliver(uid, _digest_payload(rtype, group, tz_name))
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
        try:
            run_due_snoozes()      # re-fire alarms the user hit "Snooze" on
        except Exception:
            log.exception("snooze tick failed")
        time.sleep(interval_s)
