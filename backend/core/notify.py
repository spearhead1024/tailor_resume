"""Interview reminders — schedule-driven Web Push notifications.

Per interview (times shown on each RECIPIENT's own timezone):
  • CALLER — three reminders: the day-before digest (default 7pm), the day-of digest (default 8am),
    and a lead reminder a fixed time before the call (default 60 min). ONE app-wide lead time, admin-set
    in Settings → Notifications — no per-user override for this one.
  • CREATER — a heads-up before the call to whoever booked it, at EVERY lead time THAT PERSON has
    configured on their own Account page (a list — e.g. a 90-min AND a 30-min heads-up can both fire);
    names the caller. Only fires once the row's Approved cell is exactly "Confirmed". Whether the
    feature runs at all is a global admin switch (Settings → Notifications); WHEN it fires is each
    creater's own choice — a shared app-wide time used to mean one admin's preference silently became
    every other admin's too.
  • CALL BOARD MANAGER — the same shape as the creater's heads-up (EACH manager's own configured list
    of lead times, on their own Account page) to EVERY user holding the 'call_board_manager' role, for
    every scheduled call they aren't already personally on. Also gated on Approved: Confirmed.

Board edits (assignment, reassignment, status/content changes, chat/feedback replies) notify
separately — see core/live.py — and never ring.

A background tick (scheduler_loop → run_due_reminders) scans the board every minute and fires any
reminder whose moment has arrived. The board is read from the DB (interview_rows). Sends are
best-effort and never raise into the loop. Reminders are de-duped in data/notif_state.json, keyed by
row + type + lead + scheduled-time — so each fires once, and changing an interview's time re-arms the
schedule-relative ones.

The 7pm / 8am caller digests need the caller's profile timezone; without one, only the lead / creater
/ board-manager reminders (which are absolute — a fixed offset from the call) can fire.

Creater/CBM reminders additionally require Approved == "Confirmed" — a call still Pending or Rejected
isn't settled enough to be worth a heads-up to whoever booked it or oversees the board. This gate is
scoped to creater/CBM ONLY: the caller's own lead reminder and the daily digests are unaffected and
still fire on Status == "Scheduled" alone (see NOTIFY_STATUS) — a caller/team-manager hears about a
call the moment it's booked, same as always.
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
from core.storage import Storage

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
_STATE_FILE = DATA_DIR / "notif_state.json"
_SNOOZE_FILE = DATA_DIR / "notif_snooze.json"   # alarms the user hit "Snooze" on, to re-fire later
_lock = threading.Lock()

# The board lives in SQLite (interview_columns / interview_rows). Storage is a thin handle over the
# DB path, so building our own here costs nothing and keeps core.notify free of an import cycle
# back through auth.
_storage = Storage(DATA_DIR)

# Every schedule-relative reminder announces its NOMINAL lead — the value set in Settings → Notifications
# (caller "in 1 hour", creater / call-board-manager "in 1 hour 30 minutes") — never the exact time left.
# So each must fire CLOSE to that moment or not at all: once more than _HEADSUP_GRACE has passed since
# the ideal moment (sched − N minutes) the reminder is skipped. A call booked or rescheduled at shorter
# notice than a reminder's lead simply doesn't get that reminder — you can't send a "1 hour" (or "1.5
# hour") notice for a call already nearer than that. The scheduler ticks every 60s, so 10 minutes is
# ample slack to catch the moment without the announced time ever drifting from the setting.
_HEADSUP_GRACE = timedelta(minutes=10)



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
    """Match a Caller/Creater cell value (username or full name, case-insensitive) to a user.

    The board stores a DISPLAY name, not an id, and full names are not unique. So two people called
    "John Smith" — or one whose full name is another's username — are genuinely ambiguous here, and a
    reminder/creator ping resolved to the wrong one lands on a person who was never on the call while
    the real caller hears nothing. We cannot invent the missing id, but we can refuse to guess: an
    ambiguous name resolves to NOBODY (and says so), which fails loudly instead of misdelivering.

    Exact-username stays the fast, unambiguous path — usernames ARE unique — so this only affects the
    full-name fallback, and only when a name really is shared.
    """
    needle = str(identity or "").strip().lower()
    if not needle:
        return None
    from auth import storage   # lazy: avoids an import cycle (auth imports core.*)
    u = storage.get_user_by_username(needle)
    if u:
        return u
    matches = [x for x in storage.get_users()
               if needle in (str(x.get("username", "")).strip().lower(),
                             str(x.get("full_name", "")).strip().lower())]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        log.warning("Notification target %r is ambiguous — %d users share it (%s); not delivering to "
                    "a guess. Give the Caller cell a unique name.", identity, len(matches),
                    ", ".join(str(m.get("username")) for m in matches))
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
            "company": str(cells.get("c_company", "") or "").strip(),  # Company Info — shown to the caller
            "caller": caller_id,                                       # shown to the creater
            "creater": _resolve_person(creater_name) if creater_name else None,
            "creater_name": creater_name,                              # raw cell text — shown to the CBM,
                                                                        # independent of whether it resolved
            # Whether the call is actually agreed — the creater/CBM heads-up requires this to be
            # exactly "Confirmed" (see run_due_reminders); the caller/team-manager lead does not.
            "approved": str(cells.get("c_approved", "") or "").strip(),
        })
    return out


def _call_line(c: dict, tz_name: str) -> str:
    """One call, as the CALLER (or team member) making it needs to see it at a glance — enough to know
    which job this is without opening the board:
         "#4  1:30 PM — Acme Corp · Senior Software Engineer · with Robert James (HR manager)"
    Call number, company and interviewer are dropped when the board leaves them blank."""
    head = f"#{c['index']}  " if c["index"] else ""
    parts = [p for p in (c.get("company"), c["title"]) if p]
    line = f"{head}{_fmt_time(c['sched'], tz_name)} — {' · '.join(parts)}"
    if c["who"]:
        line += f" · with {c['who']}"
    return line


def _creator_cbm_line(c: dict, tz_name: str) -> str:
    """One call, for the CREATER/CALL-BOARD-MANAGER heads-up — just enough to know which call is
    coming up and who is covering it. They aren't on the call, so the job details (company, position)
    aren't theirs to need; the board has those if they want them.
         "#4  1:30 PM — caller: John Doe" """
    head = f"#{c['index']}  " if c["index"] else ""
    line = f"{head}{_fmt_time(c['sched'], tz_name)}"
    if c.get("caller"):
        line += f" — caller: {c['caller']}"
    return line


def _manager_line(c: dict, tz_name: str) -> str:
    """One call, for a TEAM MANAGER's reminder about a call that isn't their own — just enough to know
    which call and who on their team is covering it.
         "#4  1:30 PM — John Doe" """
    head = f"#{c['index']}  " if c["index"] else ""
    line = f"{head}{_fmt_time(c['sched'], tz_name)}"
    if c.get("caller"):
        line += f" — {c['caller']}"
    return line


def _digest_payload(rtype: str, calls: list[dict], tz_name: str, recipient_id: str) -> dict:
    """One notification covering ALL of a day's interviews for one recipient.

    Recipient is either the caller (their own calls — full call_line, company + position) or their
    team manager (the whole team's calls that day — the terser manager_line, just who's covering each
    one). `rtype` is 'before@<hour>' (day-before) or 'dayof@<hour>'."""
    when = "tomorrow" if rtype.startswith("before@") else "today"
    n = len(calls)
    lines = [
        _manager_line(c, tz_name) if str(recipient_id) != str(c["user"]["id"]) else _call_line(c, tz_name)
        for c in calls
    ]
    return {
        "title": f"{n} interview{'' if n == 1 else 's'} {when}",
        "body": "\n".join(lines),
        "tag": f"{rtype}-{recipient_id}",
        "url": "/interviews", "alarm": True,
    }


_CONFIG_DEFAULTS = {"lead_enabled": True, "lead_minutes": 60, "day_before_enabled": True,
                    "day_before_hour": 19, "day_of_enabled": True, "day_of_hour": 8,
                    "creator_enabled": True, "cbm_enabled": True}


def _person_lead_minutes(user: dict, field: str, default: list[int]) -> list[int]:
    """A specific person's OWN configured lead times (Account page → "Reminder times"), not a shared
    app-wide value — see storage._normalize_minutes_list, which already clamped/de-duped/sorted this
    on save. Empty (nobody has set anything) falls back to `default` so a newly-made admin or CBM still
    gets a sensible heads-up out of the box instead of silently none."""
    vals = user.get(field)
    return list(vals) if isinstance(vals, list) and vals else list(default)


def _config() -> dict:
    """Admin-set reminder settings (Settings → Notifications). Falls back to the defaults if the
    settings row can't be read (or a key is missing), so the scheduler always has usable values.

    creator_enabled/cbm_enabled are whole-feature switches here; WHEN each fires is per-person (see
    _person_lead_minutes) — there is deliberately no app-wide creator/CBM time anymore."""
    try:
        from auth import storage
        cfg = storage.get_app_settings().get("notifications")
        if not isinstance(cfg, dict):
            cfg = {}
    except Exception:
        log.exception("could not read notification settings; using defaults")
        cfg = {}
    return {**_CONFIG_DEFAULTS, **cfg}


def _call_board_managers() -> list[dict]:
    """Every approved user holding the 'call_board_manager' role.

    Unlike the caller or creater — each one person on a single call — a call-board manager oversees
    the WHOLE board, so they get a creater-style heads-up before EVERY scheduled call. Read fresh on
    each tick, so granting or removing the role takes effect on the next scan. Never raises."""
    try:
        from auth import storage   # lazy: avoids an import cycle (auth imports core.*)
        return [u for u in storage.get_users()
                if "call_board_manager" in {str(r).strip() for r in (u.get("roles") or [])}
                and str(u.get("status", "")).strip() == "approved"]
    except Exception:
        log.exception("could not read call-board managers; skipping their reminders this tick")
        return []


def _team_managers_of(user: dict) -> list[dict]:
    """The manager(s) of a caller's team — kept on their team's calls alongside the caller.

    A team manager runs one caller team, so they get the same TEAM-level reminders as their callers
    (the caller lead and the daily digest) — but scoped to their own team, never the whole board.
    Empty when the caller is on no team, or the team has no manager. An admin who happens to sit on
    the team is not treated as its manager here — admins have their own, wider view. Read fresh each
    tick, so moving a caller between teams takes effect on the next scan. Never raises."""
    try:
        tid = str((user or {}).get("team_id", "")).strip()
        if not tid:
            return []
        from auth import storage   # lazy: avoids an import cycle (auth imports core.*)
        out = []
        for u in storage.get_users():
            if str(u.get("team_id", "")).strip() != tid:
                continue
            roles = {str(r).strip() for r in (u.get("roles") or [])}
            if "manager" in roles and "admin" not in roles and str(u.get("status", "")).strip() == "approved":
                out.append(u)
        return out
    except Exception:
        log.exception("could not read team managers; skipping their team reminders this tick")
        return []


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

    def claim_at_moment(key: str, target: datetime, sched: datetime, grace: "timedelta | None" = None) -> bool:
        """For the "N minutes before" reminders (caller lead + creater + call-board-manager heads-up).

        Fires from the ideal moment (`target` = sched − N minutes) up until the call STARTS, then
        stays silent. `grace`, when given, ALSO caps how late it may fire: once more than `grace` has
        passed since `target` it is skipped. Every reminder passes _HEADSUP_GRACE, because each
        announces its NOMINAL lead ("in 1 hour", "in 1 hour 30 minutes") — so it must land near that
        moment or not go out at all, rather than announce a lead the call is already nearer than.

        Crucially the key is consumed ONLY when we actually send. A reminder we skipped (call already
        started, or past its grace) is not "already sent"; and because the key embeds the scheduled
        time, moving a call to a new time is a NEW key — so a reschedule always re-arms it."""
        nonlocal dirty
        if key in sent or now < target:
            return False
        if now >= sched:
            return False                       # call already started → too late, silent, NOT consumed
        if grace is not None and (now - target) > grace:
            return False                       # too late to be THIS lead (e.g. a 1.5h heads-up gone stale) → skip
        sent.add(key); dirty = True
        return True

    # (1) the lead reminder (admin-set, default 60 min before). Goes to the assigned caller AND that
    #     caller's team manager — a team-level heads-up. Keyed on sched + lead + RECIPIENT, so each is
    #     tracked (and re-armed on reschedule) independently, and changing the time or the setting
    #     re-arms it. Meaningful right up until the interview actually starts. The manager's copy is on
    #     the manager's own clock and names the caller so they know who is covering it.
    if cfg.get("lead_enabled", True):
        for c in calls:
            caller = c["user"]
            recipients = [caller] + [m for m in _team_managers_of(caller) if str(m["id"]) != str(caller["id"])]
            for r in recipients:
                key = f"{c['row_id']}|lead{lead_min}m|{c['sched_raw']}|{r['id']}"
                if claim_at_moment(key, c["sched"] - timedelta(minutes=lead_min), c["sched"], _HEADSUP_GRACE):
                    try:
                        rtz = str(r.get("timezone", "")).strip() or c["tz"]
                        # The caller gets the full picture (company + position) — they're the one on
                        # the call. Their team manager only needs to know which call and who's on it.
                        is_mgr = str(r["id"]) != str(caller["id"])
                        body = _manager_line(c, rtz) if is_mgr else _call_line(c, rtz)
                        _deliver(r["id"], {
                            "title": f"Interview in {_lead_label(lead_min)}",
                            "body": body,
                            "tag": f"lead-{c['row_id']}",
                            "url": "/interviews", "alarm": True,
                        }, c["row_id"])
                        fired += 1
                    except Exception:
                        log.exception("lead push failed (row %s, user %s)", c["row_id"], r["id"])

    # (1b) the CREATER's own heads-up — goes to whoever booked the call, not the caller, and names the
    #      caller so they know who's covering it. Times are shown on the CREATER's clock, since it's
    #      their reminder. The CREATER configures their OWN several lead times (their Account page,
    #      creator_lead_minutes_list — e.g. a 90-min AND a 30-min heads-up), each firing independently;
    #      creator_enabled here is just the whole-feature admin switch. Only fires once the row is
    #      Approved: Confirmed. Scoped to creater/CBM only; the caller's lead above is unaffected.
    if cfg.get("creator_enabled", True):
        for c in calls:
            creater = c.get("creater")
            if not creater:
                continue                       # nobody in the Creater cell (or it matched no user)
            if str(c.get("approved", "")).strip().lower() != "confirmed":
                continue                        # not yet Approved: Confirmed → too soon to remind
            for lead in _person_lead_minutes(creater, "creator_lead_minutes_list", [90]):
                # Keyed on row + lead + scheduled time, so moving the call re-arms it: a reschedule
                # sends a fresh heads-up for the NEW time. It fires at most once per (row, lead, time),
                # so nudging the SAME time never double-pings — but a real reschedule does. The lead is
                # in the key (and the tag) so several configured times each track and notify separately.
                key = f"{c['row_id']}|creator|{lead}m|{c['sched_raw']}"
                if claim_at_moment(key, c["sched"] - timedelta(minutes=lead), c["sched"], _HEADSUP_GRACE):
                    try:
                        ctz = str(creater.get("timezone", "")).strip()
                        body = _creator_cbm_line(c, ctz)
                        _deliver(creater["id"], {
                            "title": f"Interview you booked — in {_lead_label(lead)}",
                            "body": body,
                            "tag": f"creator-{c['row_id']}-{lead}",
                            "url": "/interviews", "alarm": True,
                        }, c["row_id"])
                        fired += 1
                    except Exception:
                        log.exception("creator push failed (row %s)", c["row_id"])

    # (1c) the CALL-BOARD MANAGER's heads-up, shaped like the creater's: each manager's OWN configured
    #      list of lead times (their Account page), independent of every other CBM's and the creater's.
    #      A call-board manager oversees the WHOLE board, so — unlike the creater, who is one person
    #      per call — every user holding the role gets it before EVERY scheduled call. Same Approved:
    #      Confirmed gate as the creater's. Skipped for a call this manager is already personally on
    #      (its caller or creater): they get a call-specific reminder already.
    if cfg.get("cbm_enabled", True):
        managers = _call_board_managers()
        for c in calls:
            if str(c.get("approved", "")).strip().lower() != "confirmed":
                continue                        # not yet Approved: Confirmed → too soon to remind
            caller_uid = str(c["user"]["id"])
            creater_uid = str((c.get("creater") or {}).get("id", ""))
            for mgr in managers:
                mid = str(mgr["id"])
                if mid == caller_uid or mid == creater_uid:
                    continue                   # already reminded about this call in another role
                for lead in _person_lead_minutes(mgr, "cbm_lead_minutes_list", [90]):
                    key = f"{c['row_id']}|cbm|{mid}|{lead}m|{c['sched_raw']}"
                    if claim_at_moment(key, c["sched"] - timedelta(minutes=lead), c["sched"], _HEADSUP_GRACE):
                        try:
                            mtz = str(mgr.get("timezone", "")).strip()
                            body = _creator_cbm_line(c, mtz)
                            # Names whose CALL this is (the Creater who booked it) right in the title —
                            # a CBM oversees the whole board, so at a glance they need to know who
                            # booked it, not just that some call is coming. The caller (who's actually
                            # on the call) is already named in the body, one line down.
                            creater_display = c.get("creater_name") or "someone"
                            _deliver(mgr["id"], {
                                "title": f"Board interview — {creater_display} — in {_lead_label(lead)}",
                                "body": body,
                                "tag": f"cbm-{c['row_id']}-{lead}",
                                "url": "/interviews", "alarm": True,
                            }, c["row_id"])
                            fired += 1
                        except Exception:
                            log.exception("call-board-manager push failed (row %s, user %s)", c["row_id"], mgr["id"])

    # (2) day-before + day-of digests — ONE per RECIPIENT per day. Recipients: the caller (their own
    #     calls) and each of their team managers (the whole team's calls that day). Each digest is
    #     placed in the RECIPIENT's own timezone; a recipient without one is skipped (their per-call
    #     lead still works). rtz_of remembers each recipient's tz so it is dated and built on their clock.
    groups: dict[tuple[str, object], list[dict]] = {}
    rtz_of: dict[str, str] = {}
    for c in calls:
        caller = c["user"]
        recipients = [caller] + [m for m in _team_managers_of(caller) if str(m["id"]) != str(caller["id"])]
        for r in recipients:
            rtz = str(r.get("timezone", "")).strip()
            if not rtz or ZoneInfo is None:
                continue
            try:
                day = c["sched"].astimezone(ZoneInfo(rtz)).date()
            except Exception:
                continue
            rid = str(r["id"])
            rtz_of[rid] = rtz
            groups.setdefault((rid, day), []).append(c)

    for (uid, day), group in groups.items():
        group.sort(key=lambda c: c["sched"])
        tz_name = rtz_of[uid]
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
            key = f"{uid}|{day.isoformat()}|{rtype}"      # one digest per recipient per day per type
            if claim(key, target, deadline):
                try:
                    _deliver(uid, _digest_payload(rtype, group, tz_name, uid))
                    fired += 1
                except Exception:
                    log.exception("%s digest push failed (user %s, %s)", rtype, uid, day)

    if dirty:
        with _lock:
            state = _read_state()
            state["sent"] = sorted(set(state.get("sent", [])) | sent)[-5000:]   # cap growth
            _write_state(state)
    return fired


_sched_lock_handle = None   # kept open for the process's lifetime, so the OS lock is held


def _become_sole_scheduler() -> bool:
    """Win a cross-process lock so only ONE process ever runs the reminder scheduler.

    uvicorn runs as a parent+child pair here (and a sloppy restart can leave extra instances). If each
    ran the startup scheduler thread, EVERY reminder would fire once per process — the exact "twice in
    the bell, rings twice" bug. The in-process threading lock can't stop that; this takes an OS-level
    exclusive lock on data/scheduler.lock, held for the process's lifetime (the OS frees it on exit).
    The first process to reach here wins and schedules; any other backs off and never fires. Never
    raises — on any error it assumes it did NOT win, so at worst a tick is skipped, never doubled."""
    global _sched_lock_handle
    fh = None
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        fh = open(DATA_DIR / "scheduler.lock", "a+")
        fh.seek(0)
        try:
            import msvcrt                                       # Windows
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        except ImportError:
            import fcntl                                        # POSIX
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        _sched_lock_handle = fh                                # keep the handle → keep the lock
        return True
    except Exception:
        if fh is not None:
            try: fh.close()
            except Exception: pass
        return False


def scheduler_loop(interval_s: int = 60) -> None:
    """Blocking loop for a background thread: run reminders every `interval_s` seconds, forever.

    Only the process that wins the single-scheduler lock actually runs; any other returns at once, so
    a reminder is never fired (or rung, or filed in the bell) twice."""
    if not _become_sole_scheduler():
        log.info("Another process already holds the reminder-scheduler lock — not starting a second "
                 "scheduler here (prevents double-fired reminders).")
        return
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
