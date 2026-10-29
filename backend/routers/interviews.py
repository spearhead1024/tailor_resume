"""Interviews — a Notion/Coda-style editable grid for the caller dashboard.

Stored in the DB: `interview_columns` (the typed schema) + `interview_rows` (each row = column-id ->
value). Gated to admin / caller / manager. Granular endpoints (schema / add-row / patch-row /
delete-row / chat) map to targeted SQL, so a cell edit is a single-row UPDATE inside a transaction
and concurrent edits can't clobber each other.

This used to be one JSON document (data/interviews.json) rewritten in full on every keystroke under a
process lock. That made every write O(board), and a `git pull` overwriting the file mid-write
corrupted the board. The legacy file is imported once on first use and then left alone.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except Exception:                       # pragma: no cover
    ZoneInfo = None

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from auth import is_manager, require_role, storage, team_caller_names, team_id_of
from core import live as live_notify
from core.hub import hub

router = APIRouter(prefix="/api/interviews", tags=["interviews"])

# Admins, callers and team managers can all use the board.
_access = require_role("admin", "caller", "manager")
# A caller is read-only on the board except Status. The Chat & Feedback thread
# (c_feedback) is NOT cell-editable for them: it changes only through the /chat endpoints, which
# append and let you delete only your own messages — a cell PATCH would replace the whole thread
# (wipe others' messages, or post under anyone's name). Non-editable keys are dropped in patch_row.
_CALLER_EDITABLE = {"c_status"}
# A manager can additionally hand a call to a different caller — but only one of their own (enforced
# in patch_row: writing c_caller with someone outside the team is rejected, not silently accepted).
_MANAGER_EDITABLE = _CALLER_EDITABLE | {"c_caller"}


def _editable_cols(user: dict) -> set:
    return _MANAGER_EDITABLE if is_manager(user) else _CALLER_EDITABLE

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_GRID_FILE = DATA_DIR / "interviews.json"
log = logging.getLogger("interviews")

_lock = threading.Lock()

COLUMN_TYPES = {"text", "number", "date", "select", "checkbox", "url", "email", "phone", "person", "file", "button"}

# ── Scheduled_at is stored as a UTC instant so every viewer sees it in their own time zone. ──
_SCHED_INSTANT = re.compile(r"(?:[zZ]|[+-]\d\d:?\d\d)$")           # already UTC / offset
_SCHED_WALL = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})")


def _sched_to_utc(val, tz: str):
    """A bare wall-clock Scheduled_at typed in `tz` → the absolute UTC instant. Idempotent
    (an existing instant, empty value, or a non-parseable/no-tz value is returned unchanged)."""
    s = str(val or "").strip()
    if not s or _SCHED_INSTANT.search(s):
        return val
    m = _SCHED_WALL.match(s)
    if not m or not tz or ZoneInfo is None:
        return val
    try:
        dt = datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), tzinfo=ZoneInfo(tz))
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return val


def _user_tz_map() -> dict:
    """full_name / username (lowercased) → time zone, for users that have one set."""
    m: dict = {}
    for u in storage.get_users():
        tz = str(u.get("timezone", "")).strip()
        if not tz:
            continue
        for key in (str(u.get("full_name", "")).strip().lower(), str(u.get("username", "")).strip().lower()):
            if key:
                m[key] = tz
    return m

# Pill colours auto-assigned to select options that don't specify one.
_PALETTE = [
    "#3b82f6", "#22c55e", "#a855f7", "#14b8a6", "#f59e0b",
    "#ef4444", "#ec4899", "#6366f1", "#84cc16", "#06b6d4",
    "#f97316", "#8b5cf6",
]


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def _is_hex(c: str) -> bool:
    return len(c) == 7 and c[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in c[1:])


def _caller_ids(user: dict) -> set:
    """Identities a caller's rows are matched against (the Caller cell holds one of these)."""
    return {s for s in (str(user.get("username", "")).strip().lower(),
                        str(user.get("full_name", "")).strip().lower()) if s}


def _team_name_of(user: dict) -> str:
    t = storage.get_team(team_id_of(user)) or {}
    return str(t.get("name", "")).strip().lower()


def _team_scope(user: dict):
    """Predicate: is this row part of the user's team? Either the row was handed to the team (Team
    cell), or its Caller is someone on the team. Built once per request — resolving the team and its
    members per row would hit storage N times."""
    tname = _team_name_of(user)
    members = team_caller_names(team_id_of(user))

    def _in_team(row: dict) -> bool:
        cells = row.get("cells") or {}
        row_team = str(cells.get("c_team", "")).strip().lower()
        row_caller = str(cells.get("c_caller", "")).strip().lower()
        return (bool(tname) and row_team == tname) or (row_caller in members)
    return _in_team


def _visibility(user: dict):
    """READ scope — "may this user SEE this row?"

    admin   → everything. They are the only ones with the whole picture.
    manager → their whole team, INCLUDING calls handed to the team with nobody picked yet — that is the
              queue they assign from, so they have to see it.
    caller  → ONLY the calls assigned to them, full stop — being on a team does not widen this. A
              caller has no business reading a colleague's interviews, their contact details, or who
              they are speaking to; the team's schedule is the manager's view, not theirs.
    """
    if user.get("is_admin"):
        return lambda row: True

    if is_manager(user):
        return _team_scope(user)

    ids = _caller_ids(user)
    return lambda row: str((row.get("cells") or {}).get("c_caller", "")).strip().lower() in ids


def _writability(user: dict):
    """WRITE scope — deliberately NARROWER than the read scope.

    A team member can see the whole team's schedule but may only edit their OWN calls; without this
    split, widening visibility would have silently let any caller set Status/Feedback on a
    team-mate's interview. A manager may write anywhere in their team (that's their job)."""
    if user.get("is_admin"):
        return lambda row: True
    if is_manager(user):
        return _team_scope(user)
    ids = _caller_ids(user)
    return lambda row: str((row.get("cells") or {}).get("c_caller", "")).strip().lower() in ids


def _owns_row(user: dict, row: dict) -> bool:
    """Used by every WRITE path (patch_row, chat). Reads use _visibility, which is wider."""
    return _writability(user)(row)


def _avail_scope(user: dict):
    """WHOSE working hours (and days off, and daily meeting) may this user READ?

    admin   → everyone.
    manager → their own team. Rostering the team is their job; they need to know when people can work.
    caller  → THEMSELVES ONLY.

    A caller is deliberately NOT given their team-mates' hours, even though they can see the team's
    calls. Seeing the schedule is the team's business; seeing when a colleague works, and which days
    they are on holiday, is that colleague's. Only the person who assigns the work needs the roster.

    This is its own predicate and not just "whoever /people returns": /people deliberately returns EVERY
    user to a caller (it feeds the Creater avatars, which need a name for anyone who ever booked a call).
    Hanging availability off that list would hand the whole company's roster to every caller.
    """
    if user.get("is_admin"):
        return lambda u: True

    if is_manager(user):
        tid = team_id_of(user)
        # An ungrouped manager has tid == "" — which must NOT match every other ungrouped user.
        return lambda u: bool(tid) and str(u.get("team_id", "")).strip() == tid

    ids = _caller_ids(user)

    def ok(u: dict) -> bool:
        keys = {s for s in (str(u.get("username", "")).strip().lower(),
                            str(u.get("full_name", "")).strip().lower()) if s}
        return bool(keys & ids)                           # yourself, and nobody else

    return ok


def _schedulable(u: dict) -> bool:
    """Someone you could actually book a call with — so their availability is worth sending."""
    roles = {str(r).strip() for r in (u.get("roles") or [])}
    return bool(roles & {"caller", "manager"}) and str(u.get("status", "")).strip() == "approved"


def _normalize_column(raw: dict) -> dict:
    cid = str(raw.get("id") or "").strip() or _new_id("c")
    ctype = str(raw.get("type") or "text").strip()
    if ctype not in COLUMN_TYPES:
        ctype = "text"
    # Select options are {label, color}; accept legacy plain strings too.
    options: list[dict] = []
    for o in (raw.get("options") or []):
        if isinstance(o, dict):
            label = str(o.get("label") or "").strip()
            color = str(o.get("color") or "").strip()
        else:
            label, color = str(o).strip(), ""
        if not label:
            continue
        if not _is_hex(color):
            color = _PALETTE[len(options) % len(_PALETTE)]
        options.append({"label": label, "color": color})
    name = str(raw.get("name") or "").strip() or "Untitled"
    try:
        width = int(raw.get("width") or 0)
    except (TypeError, ValueError):
        width = 0
    width = max(60, min(width or 160, 1000))   # px column width; clamp + sane default
    return {"id": cid, "name": name, "type": ctype, "options": options, "width": width}


def _default_grid() -> dict:
    def s(label, color):
        return {"label": label, "color": color}
    cols = [
        {"id": "c_index", "name": "Index", "type": "text", "width": 64},
        {"id": "c_title", "name": "Position / Title", "type": "text", "width": 190},
        {"id": "c_skill", "name": "Skillset", "type": "text", "width": 170},
        {"id": "c_company", "name": "Company Info", "type": "text", "width": 170},
        {"id": "c_salary", "name": "Salary Range", "type": "text", "width": 130},
        # The interview funnel, in the order it actually happens — the dropdown lists them in this
        # order, so picking the next step is reading down the list rather than hunting through it.
        {"id": "c_type", "name": "Call Type", "type": "select", "width": 180, "options": [
            s("Phone Call", "#64748b"),
            s("Intro 1(Recruiter)", "#6366f1"), s("Intro 2(Company)", "#a855f7"),
            s("Intro + Tech", "#22c55e"),
            s("Tech Call(1)", "#ef4444"), s("Tech Call(2)", "#f59e0b"),
            s("Final Call", "#06b6d4"), s("Final Call(Hiring)", "#3b82f6")]},
        {"id": "c_client", "name": "Interviewer(role)", "type": "text", "width": 180},
        {"id": "c_min", "name": "Duration(min)", "type": "text", "width": 100},
        {"id": "c_sched", "name": "Scheduled_at", "type": "date", "width": 140},
        {"id": "c_created", "name": "Created_at", "type": "date", "width": 130},
        {"id": "c_team", "name": "Team", "type": "select", "width": 140, "options": []},
        {"id": "c_caller", "name": "Caller", "type": "select", "width": 140, "options": []},
        {"id": "c_creater", "name": "Creater", "type": "person", "width": 140},
        # Where the call has got to. Starts before the call exists in anyone's diary (Not Scheduled →
        # Scheduled), then how it went. Ordered by the life of a call, for the same reason as Call Type.
        #
        # Colours are the EXACT Notion muted-token hexes (the board snaps every pill to the nearest of
        # nine tokens, so passing the token's own hex pins each status to one deliberate colour instead
        # of drifting). Each status gets its own token, mapped by meaning — inactive→gray, active→blue,
        # good→green, missed→orange, bad→red, progressed→purple, paused→yellow, won→pink, filled→brown.
        # The two dormant ends of the funnel (Not Scheduled / Closed) share gray on purpose: both mean
        # "no call is happening", and their position in the list tells them apart.
        {"id": "c_status", "name": "Status", "type": "select", "width": 120, "options": [
            s("Not Scheduled", "#9B9B9B"), s("Scheduled", "#447ACB"),
            s("Passed", "#2E8B57"),
            s("Done", "#4F9768"), s("Not Done", "#CB7B37"), s("Failed", "#BE524B"),
            s("OnSite", "#865DBB"), s("On-hold", "#C19138"), s("Account", "#BA4A78"),
            s("Filled", "#A27763"), s("Closed", "#9B9B9B")]},
        {"id": "c_link", "name": "Meeting Link", "type": "url", "width": 64},
        {"id": "c_account", "name": "Account Profile", "type": "select", "width": 150, "options": []},
        {"id": "c_jd", "name": "JD", "type": "button", "width": 88},
        {"id": "c_resume", "name": "Resume", "type": "file", "width": 150},
        {"id": "c_feedback", "name": "Feedback", "type": "button", "width": 100},
    ]
    # Start a fresh board with one empty row so it's ready to type into.
    return {"columns": [_normalize_column(c) for c in cols], "rows": [{"id": _new_id("r"), "cells": {}}]}


# Columns every board must have (added to existing boards on first read → their cells persist).
_REQUIRED_COLS = [
    {"id": "c_company", "name": "Company Info", "type": "text", "width": 170},
    {"id": "c_salary", "name": "Salary Range", "type": "text", "width": 130},
    # Which caller team owns this interview. An admin sets it; the team's manager then sees the row —
    # even with no Caller yet — and picks which of their callers takes it. Options are injected from
    # the teams table (like Caller / Account Profile), so the cell holds the team NAME.
    {"id": "c_team", "name": "Team", "type": "select", "width": 140, "options": []},
]


# The starting state a brand-new row is given (see _apply_new_row_defaults, used by add_row). Each is
# a select option that must exist on its column, so the values here are matched against the live option
# list before use — a mismatch is skipped rather than written, so renaming an option can't strand a row.
_NEW_ROW_DEFAULTS = {
    "c_status": "Not Scheduled",
    "c_type": "Intro1",
}


def _apply_new_row_defaults(cells: dict, columns: list[dict]) -> None:
    """Fill blank status/type on a new row with their defaults — in place. Only touches a cell
    that is empty AND whose column exists AND still offers that option, so an explicit value always
    wins and a default can never point at an option that has been renamed away."""
    by_id = {c["id"]: c for c in columns}
    for col_id, default in _NEW_ROW_DEFAULTS.items():
        if str(cells.get(col_id, "") or "").strip():
            continue                                  # explicit value provided → leave it
        col = by_id.get(col_id)
        if not col:
            continue
        labels = {str(o.get("label", "")).strip() for o in (col.get("options") or [])}
        if default in labels:
            cells[col_id] = default


# ── persistence: the board lives in the DB (interview_columns / interview_rows) ──────────────
# It used to be data/interviews.json — every keystroke rewrote the whole file under a process lock,
# and a `git pull` overwriting that file mid-write corrupted the board. Now a cell edit is a
# single-row UPDATE inside a transaction.
_bootstrapped = False


def _read_legacy_json() -> dict | None:
    """The old data/interviews.json, if it's still around — imported once, then left alone."""
    if not _GRID_FILE.exists():
        return None
    try:
        raw = _GRID_FILE.read_text(encoding="utf-8")
        try:
            grid = json.loads(raw)
        except Exception:                       # tolerate trailing garbage
            grid, _ = json.JSONDecoder().raw_decode(raw.lstrip())
        if not isinstance(grid, dict) or not grid.get("columns"):
            return None
        return {
            "columns": [_normalize_column(c) for c in grid.get("columns") or [] if isinstance(c, dict)],
            "rows": [r for r in grid.get("rows") or [] if isinstance(r, dict) and r.get("id")],
        }
    except Exception:
        return None


def _bootstrap() -> None:
    """Seed the DB board on first use (import the legacy JSON if present, else the default board),
    then keep the schema current and finish the Scheduled_at → UTC migration. Idempotent."""
    global _bootstrapped
    if _bootstrapped:
        return
    with _lock:
        if _bootstrapped:
            return
        if not storage.get_interview_columns():           # empty DB board → seed it whole
            grid = _read_legacy_json() or _default_grid()
            storage.seed_interview_grid(grid["columns"], grid["rows"])
        elif not storage.get_interview_rows():
            # Columns exist but there are no rows — a restore that carried the schema but not the
            # data. Backfill the rows from the legacy JSON if it's still around, WITHOUT touching the
            # existing columns (seed_interview_grid would delete them). An empty board is a valid
            # state, so do nothing when there's no JSON to recover from.
            legacy = _read_legacy_json()
            if legacy and legacy.get("rows"):
                for i, r in enumerate(legacy["rows"]):
                    storage.insert_interview_row(r["id"], r.get("cells") or {}, i)
        storage.append_interview_columns(_REQUIRED_COLS)  # add newly-required columns
        _drop_retired_columns()                           # e.g. Approved — column AND its cells
        _migrate_sched_db()                               # legacy wall-clock Scheduled_at → UTC
        _migrate_option_colors()                          # repaint Status pills (see below)
        _ensure_status_options()                          # add "Passed" to legacy boards' Status
        _bootstrapped = True


# The professional pill colours, keyed by option label. Applied to boards seeded before the palette
# changed — the seed only paints a FRESH board, so without this an existing deployment keeps the old
# bright hexes, which the pill renderer snaps to the wrong muted token (Not Scheduled and Closed came
# out green, Scheduled/Done/OnSite all one blue). Matches by label; leaves any admin-added option alone.
_OPTION_COLORS = {
    "c_status": {
        "Not Scheduled": "#9B9B9B", "Scheduled": "#447ACB", "Passed": "#2E8B57", "Done": "#4F9768",
        "Not Done": "#CB7B37", "Failed": "#BE524B", "OnSite": "#865DBB",
        "On-hold": "#C19138", "Account": "#BA4A78", "Filled": "#A27763", "Closed": "#9B9B9B",
    },
}

# Columns the board no longer has. Removed from existing boards on bootstrap — the column AND every
# row's value for it (replace_interview_columns prunes cells whose column is gone), so nothing keeps
# a dead field alive. Listed by id, never by name: an admin may later add their own column that
# happens to reuse a retired NAME, and that one must survive.
#   c_approved — "Approved" (Confirmed/Pending/Rejected). Retired; Status alone tracks a call.
_RETIRED_COLS = {"c_approved"}


def _drop_retired_columns() -> None:
    """Remove the retired columns (and their cells) from a board created before they were dropped.
    Idempotent: a board that no longer has them is left untouched (no write at all)."""
    cols = storage.get_interview_columns()
    keep = [c for c in cols if c.get("id") not in _RETIRED_COLS]
    if len(keep) != len(cols):
        storage.replace_interview_columns(keep)
        log.info("interviews: dropped retired column(s) %s",
                 sorted({c.get("id") for c in cols} & _RETIRED_COLS))

# Status options that must exist on EVERY board (added to legacy boards on bootstrap).
# "Passed" drives the auto-clone follow-up flow, so it has to be selectable everywhere.
_ENSURE_STATUS_OPTIONS = [("Passed", "#2E8B57")]


def _ensure_status_options() -> None:
    """Append any missing must-have Status options (e.g. Passed) to existing boards.
    Idempotent — only adds a label that isn't already present."""
    cols = storage.get_interview_columns()
    changed = False
    for col in cols:
        if col.get("id") != "c_status":
            continue
        opts = col.get("options") or []
        have = {str(o.get("label", "")).strip() for o in opts}
        # Insert "Passed" right after "Scheduled" when possible, else append.
        for label, color in _ENSURE_STATUS_OPTIONS:
            if label in have:
                continue
            new_opt = {"label": label, "color": color}
            idx = next((i for i, o in enumerate(opts) if str(o.get("label", "")).strip() == "Scheduled"), None)
            if idx is not None:
                opts.insert(idx + 1, new_opt)
            else:
                opts.append(new_opt)
            changed = True
        col["options"] = opts
    if changed:
        storage.replace_interview_columns(cols)


def _migrate_option_colors() -> None:
    """Repaint known Status options to the professional palette. Idempotent, and only touches
    the options it knows by name, so a board an admin has customised keeps their own additions."""
    cols = storage.get_interview_columns()
    changed = False
    for col in cols:
        want = _OPTION_COLORS.get(col.get("id", ""))
        if not want:
            continue
        for opt in (col.get("options") or []):
            label = str(opt.get("label", "")).strip()
            if label in want and opt.get("color") != want[label]:
                opt["color"] = want[label]
                changed = True
    if changed:
        storage.replace_interview_columns(cols)


def _migrate_sched_db() -> None:
    """Convert any legacy wall-clock Scheduled_at to a UTC instant, interpreting each in the
    timezone of the row's Creater (who typed it). Rows whose Creater has no zone are left alone."""
    tzmap = None
    for row in storage.get_interview_rows():
        cells = row.get("cells") or {}
        v = cells.get("c_sched")
        s = str(v or "").strip()
        if not s or _SCHED_INSTANT.search(s) or not _SCHED_WALL.match(s):
            continue
        if tzmap is None:
            tzmap = _user_tz_map()
        tz = tzmap.get(str(cells.get("c_creater", "")).strip().lower())
        if not tz:
            continue
        new = _sched_to_utc(v, tz)
        if new != v:
            storage.patch_interview_row(row["id"], {"c_sched": new})


def _load_grid() -> dict:
    _bootstrap()
    return storage.get_interview_grid()


# Who booked a call is an admin's business. A caller, a team manager and a team member all see the
# call; none of them see who put it there.
PRIVATE_CELLS = ("c_creater", "c_created")


def _public_row(row: dict, is_admin: bool) -> dict:
    """The row as this user is allowed to receive it.

    PURE — it returns a copy. Never strip in place: `row_audience` and `on_row_changed` read c_creater
    off the very same dict to decide who the update goes to and who gets the notification, so mutating
    it would quietly drop the creator out of their own board and their own reminders.

    The COLUMN stays in the schema (hiding it there would let a non-admin's schema save delete it);
    only the value is withheld, and the frontend renders no Creater column for these roles anyway. So
    this is defence in depth, not the only lock — but without it the name was still on the wire, and
    "can't see the creator" would have meant nothing more than "can't see it without opening devtools".
    """
    if is_admin:
        return row
    cells = {k: v for k, v in (row.get("cells") or {}).items() if k not in PRIVATE_CELLS}
    return {**row, "cells": cells}


def _broadcast_row(row: dict, audience: set[str]) -> None:
    """Push a row to everyone who may see it — full to admins, creator-stripped to everyone else.

    The hub fans out one payload to a set of user ids, so a per-recipient view means two sends. The
    audience is computed by the CALLER from the unstripped cells; we only split it here."""
    admins = {u["id"] for u in storage.get_users() if u.get("is_admin")}
    staff = audience & admins
    others = audience - admins
    if staff:
        hub.broadcast_soon({"type": "row", "row": _public_row(row, True)}, staff)
    if others:
        hub.broadcast_soon({"type": "row", "row": _public_row(row, False)}, others)


@router.get("")
def get_grid(user: dict = Depends(_access)):
    grid = _load_grid()
    # Admins see every interview; a caller sees only their own rows; a manager sees their whole team's
    # (including calls handed to the team that have no Caller assigned yet).
    if not user.get("is_admin"):
        can_see = _visibility(user)
        grid = {**grid, "rows": [_public_row(r, False) for r in grid["rows"] if can_see(r)]}
    return grid


@router.get("/people")
def list_people(user: dict = Depends(_access)):
    """The people this user may be shown — feeds the Caller dropdown, the Creater avatars (admins),
    and the calendar's availability panel.

    WHO IS IN THE LIST:
        admin              → everyone.
        manager            → their own team, so the Caller dropdown can only ever offer someone they
                             are allowed to assign (the backend rejects the rest anyway — this just
                             stops the UI presenting a choice that would be refused).
        caller on a team   → their own team. They cannot assign anybody, but they SEE their team-mates'
                             calls, and a Caller cell with no matching person renders as a bare string.
        caller on no team  → themselves, and nobody else. Every row on their board is already theirs.

    This used to hand EVERY user to every caller. The reason was the Creater avatars: the board had to
    be able to put a face to whoever booked a call, and that could be anyone. Creater is now withheld
    from everyone but an admin (see _public_row), so that reason is gone — and what was left was a
    caller being able to read the full staff directory out of the Caller dropdown, including people on
    other teams they have nothing to do with.

    Availability rides along for the calendar, but only for people whose roster this user may read
    (_avail_scope: your team, or everyone if you're an admin) and only for approved callers/managers.

    `timezone` is load-bearing, not decoration: the hours are wall-clock times in the CALLER's own
    zone, so a calendar cannot place them without it (09:00 in Los Angeles is a different row on the
    grid from 09:00 in Seoul, and can even land on a different day).
    """
    tid = team_id_of(user)
    my_ids = _caller_ids(user)
    may_see_roster = _avail_scope(user)

    def _in_scope(u: dict) -> bool:
        if user.get("is_admin"):
            return True
        if tid:                                     # manager or team caller → the team
            return str(u.get("team_id", "")).strip() == tid
        return {str(u.get("username", "")).strip().lower(),
                str(u.get("full_name", "")).strip().lower()} & my_ids != set()   # solo caller → self

    out = []
    for u in storage.get_users():
        un = str(u.get("username", "")).strip()
        fn = str(u.get("full_name", "")).strip()
        if not (un or fn):
            continue
        if not _in_scope(u):
            continue
        person = {
            "username": un, "full_name": fn, "label": fn or un,
            "roles": u.get("roles") or [],
            "team_id": str(u.get("team_id", "")).strip(),   # groups the Caller dropdown by team
            "avatar_url": str(u.get("avatar_url", "")).strip(),
        }
        if _schedulable(u) and may_see_roster(u):
            # Only a roster the person actually filled in, and only if we know which clock it is on.
            # Without BOTH, the hours are a fiction: the normalizer hands everyone a default Mon–Fri
            # 09:00–18:00, and with no timezone we cannot say whose 09:00 that is. The board would rather
            # show nothing than shade a week nobody agreed to.
            tz = str(u.get("timezone", "")).strip()
            configured = bool(u.get("availability_set")) and bool(tz)
            person["availability_set"] = configured
            person["timezone"] = tz
            if configured:
                person["availability"] = u.get("availability") or {}
                person["daily_meetings"] = u.get("daily_meetings") or []
                person["days_off"] = u.get("days_off") or []
        out.append(person)
    return {"people": out}


@router.get("/profiles")
def list_profiles(user: dict = Depends(_access)):
    """All profile names — feeds the Account Profile dropdown. Includes BOTH this server's profiles
    (Profiles tab / DB) and VPS_1's mirrored profiles, so a caller can attach any profile to an
    interview regardless of which server it lives on. Labels only; de-duped by label."""
    out: list[dict] = []
    seen: set[str] = set()

    def _add(pid: str, name: str, region: str) -> None:
        name = name.strip()
        if not name:
            return
        label = f"{name}({region.strip()})" if region.strip() else name   # e.g. "Charlie Barahona(US)"
        key = label.lower()
        if key in seen:
            return
        seen.add(key)
        out.append({"id": pid, "name": name, "region": region.strip(), "label": label})

    for p in storage.get_profiles():
        _add(str(p.get("id", "")).strip(), str(p.get("name", "")), str(p.get("region", "")))
    # VPS_1's profiles from the local hourly mirror — namespaced ids so they can't collide.
    for p in storage.get_vps1_profiles():
        _add(f"vps1:{p.get('id', '')}", str(p.get("name", "")), str(p.get("region", "")))

    return {"profiles": out}


# What the eye button on the board actually shows. Deliberately a curated view, not the raw record:
# the résumé blob, template settings and generation config are the Profiles tab's business, not a
# caller's — they want to know WHO they are about to be on a call as.
_PROFILE_VIEW = (
    "id", "name", "region", "email", "phone", "location", "address", "zip_code",
    "linkedin", "github", "portfolio", "summary_seed", "technical_skills",
    "total_years_of_experience", "work_history", "education_history",
    # Date of birth, engagement terms and salary expectation. A caller is ON the call AS this person
    # and gets asked all three, so they are on the card — but note this widens what a caller can read:
    # anyone who can see a call can now read that profile's DOB and pay expectation.
    "date_of_birth", "contract_types", "b2b_country", "expected_salary",
)


@router.get("/profiles/{profile_id}")
def get_board_profile(profile_id: str, user: dict = Depends(_access)):
    """The person behind a call — opened from the eye on the board's Profile cell.

    This is NOT /api/profiles/{id}. That one belongs to the bidder workflow and only lets you read a
    profile ASSIGNED to you, so it 403s a caller: a caller is not assigned the profile, they are simply
    making the call for it. Widening that endpoint would hand the whole profile library to every bidder,
    so the board gets its own door with its own rule:

        admin  → any profile.
        anyone else → only a profile that appears on a call they can actually SEE.

    That last clause matters. Without it, any caller could walk the profile ids and read the contact
    details of every persona in the company, including ones on another team's interviews.
    """
    pid = str(profile_id or "").strip()
    # A VPS_1 profile ("vps1:<uuid>") is read from the local mirror, with any admin edits merged in —
    # same door, same rule as a local one.
    p = (storage.get_vps1_profile_by_id(pid[len("vps1:"):]) if pid.startswith("vps1:")
         else storage.get_profile_by_id(pid))
    if not p:
        raise HTTPException(status_code=404, detail="Profile not found")

    name = str(p.get("name", "")).strip()
    region = str(p.get("region", "")).strip()
    label = f"{name}({region})" if region else name

    if not user.get("is_admin"):
        can_see = _visibility(user)
        on_my_board = {
            str((r.get("cells") or {}).get("c_account", "")).strip()
            for r in storage.get_interview_rows() if can_see(r)
        }
        if label not in on_my_board:
            raise HTTPException(status_code=403, detail="That profile is not on any of your calls.")

    view = {k: p.get(k) for k in _PROFILE_VIEW}
    view["label"] = label
    return view


@router.put("/schema")
def put_schema(body: dict, user: dict = Depends(_access)):
    """Replace the column list (add / rename / retype / reorder / delete / resize /
    edit select options). Admin only. Cells whose column no longer exists are dropped."""
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Only admins can change the table structure.")
    raw_cols = (body or {}).get("columns", [])
    cols, seen = [], set()
    for c in raw_cols:
        if not isinstance(c, dict):
            continue
        col = _normalize_column(c)
        if col["id"] in _RETIRED_COLS:
            continue                   # a tab still running the old page must not bring one back
        if col["id"] in seen:
            col["id"] = _new_id("c")
        seen.add(col["id"])
        cols.append(col)
    _bootstrap()
    storage.replace_interview_columns(cols)      # prunes cells of removed columns
    grid = storage.get_interview_grid()
    # The schema is replaced wholesale, so two admins editing columns at once would each save their
    # own list and clobber the other's new column. Push the winning schema to every open board at
    # once, so the loser sees the truth immediately instead of holding a stale copy to save later.
    hub.broadcast_soon({"type": "schema", "columns": grid["columns"]})
    return grid


# ── Call-index helpers ──────────────────────────────────────────────────────
# An index may be a plain number ("13") OR a passed-clone chain ("13_16_19"), where
# EVERY part is a distinct call number. We treat the whole board as one pool of used
# numbers (all parts of every index) and hand out the SMALLEST unused positive int,
# so the pool stays unique and gap-free (fills holes left by deletes).

def _index_parts(value: object) -> list[int]:
    out: list[int] = []
    for part in str(value or "").split("_"):
        part = part.strip()
        if part.isdigit():
            out.append(int(part))
    return out


def _used_index_numbers(rows: list[dict]) -> set[int]:
    used: set[int] = set()
    for r in rows:
        used.update(_index_parts((r.get("cells") or {}).get("c_index", "")))
    return used


def _next_index_number(rows: list[dict]) -> int:
    """Smallest positive integer not already used anywhere on the board."""
    used = _used_index_numbers(rows)
    n = 1
    while n in used:
        n += 1
    return n


def _dedupe_and_compact_indexes(rows: list[dict]) -> list[tuple[str, str, str]]:
    """Make every call number UNIQUE and GAP-FREE across all rows, keeping follow-up chains intact.

    A follow-up's index is "<parent's index>_<its own number>" (see _build_clone_cells), so only the
    LAST part is the row's own number; the earlier parts point at its ancestors. (Deduping every
    part, as this used to, read "2_3" as a second #2 and renumbered it, which broke every chain:
    _followup_of could no longer find a parent's follow-up, so a duplicate one got cloned.)

    Returns [(row_id, old_index, new_index)] for rows whose index changed. Three passes:
      1. Dedupe own numbers in row order: the first row keeps its number, a later duplicate gets the
         smallest unused one.
      2. Compact: move the largest own numbers down into the holes so they become 1..N.
      3. Rebuild each index as its parent's NEW index + "_" + its own new number. A prefix whose row
         no longer exists (parent deleted) keeps its old number, which stays reserved so passes 1-2
         never hand it to another call.
    Rows whose index isn't a clean "N" / "N_M_..." chain are left untouched."""
    chains: list[tuple[dict, str, list[int]]] = []
    for r in rows:
        old = str((r.get("cells") or {}).get("c_index", "") or "").strip()
        bits = old.split("_")
        if old and all(b.isdigit() for b in bits):
            chains.append((r, old, [int(b) for b in bits]))
    by_old: dict[str, str] = {}
    for r, old, _ in chains:
        by_old.setdefault(old, r["id"])

    # Numbers of ancestors that no longer exist — still referenced, so never reused.
    reserved: set[int] = set()
    for _, _, parts in chains:
        for k in range(1, len(parts)):
            if "_".join(map(str, parts[:k])) not in by_old:
                reserved.add(parts[k - 1])

    # Pass 1 — dedupe own numbers. Every first occurrence keeps its number BEFORE any duplicate is
    # renumbered, so a duplicate never takes a number that a later, unique row already holds.
    own: dict[str, int] = {}
    taken: set[int] = set()
    dups: list[str] = []
    for r, _, parts in chains:
        n = parts[-1]
        if n in taken or n in reserved:
            dups.append(r["id"])
        else:
            own[r["id"]] = n
            taken.add(n)
    for rid in dups:
        n = 1
        while n in taken or n in reserved:
            n += 1
        own[rid] = n
        taken.add(n)

    # Pass 2 — compact: largest numbers into the smallest holes.
    holes = [n for n in range(1, len(taken) + len(reserved) + 1) if n not in taken and n not in reserved]
    highs = sorted(taken, reverse=True)
    remap: dict[int, int] = {}
    for high, hole in zip(highs, holes):
        if hole >= high:
            break
        remap[high] = hole
    own = {rid: remap.get(n, n) for rid, n in own.items()}

    # Pass 3 — rebuild, resolving each prefix through the parent's new index.
    memo: dict[str, str] = {}

    def resolve(old: str) -> str:
        if old not in memo:
            head, _, tail = old.rpartition("_")
            rid = by_old.get(old)
            mine = str(own[rid]) if rid else tail          # a deleted ancestor keeps its number
            memo[old] = (resolve(head) + "_" + mine) if head else mine
        return memo[old]

    changes: list[tuple[str, str, str]] = []
    for r, old, _ in chains:
        head = old.rpartition("_")[0]
        new_index = (resolve(head) + "_" if head else "") + str(own[r["id"]])
        if new_index != old:
            changes.append((r["id"], old, new_index))
    return changes


@router.post("/reindex")
def reindex_board(user: dict = Depends(_access)):
    """One-time cleanup: make all call indices unique + gap-free (keeping chains).
    Admin-only. Backs up the DB first. Returns the list of changed indices."""
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Only admins can reindex the board.")
    _bootstrap()
    grid = _load_grid()
    changes = _dedupe_and_compact_indexes(grid["rows"])
    if not changes:
        return {"changed": 0, "changes": []}
    # Back up the SQLite DB before rewriting indices (best-effort; never blocks the fix).
    try:
        import shutil
        from datetime import datetime as _dt
        src = storage.db_path
        bak = src.with_name(f"{src.name}.bak-reindex-{_dt.now().strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(src, bak)
        log.info("reindex: DB backed up to %s", bak.name)
    except Exception:
        log.warning("reindex: DB backup failed; proceeding (indices will still be corrected)")
    for rid, _old, new_index in changes:
        updated = storage.patch_interview_row(rid, {"c_index": new_index})
        if updated is not None:
            after = dict(updated.get("cells") or {})
            _broadcast_row({"id": rid, "cells": after}, live_notify.row_audience(after))
    return {"changed": len(changes),
            "changes": [{"row_id": rid, "old": old, "new": new} for rid, old, new in changes]}


_CLONE_CLEAR = ("c_sched", "c_link", "c_min", "c_type")   # emptied on the follow-up row


def _followup_of(rows: list[dict], parent_index: str) -> dict | None:
    """The follow-up row of this index (its index is "<parent>_<n>"), or None. With a
    chain (80 → 80_106 → 80_106_108) the direct child — the shortest index — wins."""
    base = str(parent_index or "").strip()
    if not base:
        return None
    kids = [r for r in rows
            if str((r.get("cells") or {}).get("c_index", "")).strip().startswith(base + "_")]
    return min(kids, key=lambda r: len(str(r["cells"].get("c_index", ""))), default=None)


def _has_passed_child(rows: list[dict], parent_index: str) -> bool:
    """True if a follow-up row already exists for this index. Guards against
    spawning duplicate follow-ups."""
    return _followup_of(rows, parent_index) is not None


def _build_clone_cells(src_cells: dict, rows: list[dict], valid: set[str]) -> dict:
    """The follow-up row's cells: a verbatim copy of the source (INCLUDING the full
    c_feedback chat JSON), with the fields the spec resets."""
    cells = {k: v for k, v in dict(src_cells or {}).items() if k in valid}
    # Chain the index: "<source>_<smallest unused number>".
    src_index = str(src_cells.get("c_index", "") or "").strip()
    new_num = _next_index_number(rows)
    cells["c_index"] = f"{src_index}_{new_num}" if src_index else str(new_num)
    # Emptied fields.
    for cid in _CLONE_CLEAR:
        if cid in valid:
            cells[cid] = ""
    # Reset workflow + stamp.
    if "c_status" in valid:
        cells["c_status"] = ""          # fresh follow-up, no outcome yet
    if "c_created" in valid:
        cells["c_created"] = datetime.now(timezone.utc).isoformat()
    return cells


@router.post("/rows/{row_id}/clone")
def clone_row(row_id: str, user: dict = Depends(_access)):
    """Create a follow-up row from a 'passed' call: copies every cell verbatim
    (incl. the Chat & Feedback thread), chains the index, clears schedule/link/
    duration/type, clears Status, and appends it at the bottom. Admin-only.
    Guards against duplicate follow-ups (one child per source row)."""
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Only admins can create follow-up rows.")
    _bootstrap()
    grid = _load_grid()
    valid = {c["id"] for c in grid["columns"]}
    src = storage.get_interview_row(row_id)
    if src is None or not _owns_row(user, src):
        raise HTTPException(status_code=404, detail="Row not found")
    src_cells = dict(src.get("cells") or {})
    src_index = str(src_cells.get("c_index", "") or "").strip()
    existing: list[dict] = []

    def _prepare(rows: list[dict]) -> dict | None:       # inside the insert's write lock
        found = _followup_of(rows, src_index)
        if found is not None:
            existing.append(found)
            return None
        return _build_clone_cells(src_cells, rows, valid)

    rid = _new_id("r")
    row = storage.insert_interview_row(rid, {}, None, prepare=_prepare)   # append at bottom
    if row is None:
        # Usually created a moment ago by marking the call Passed (see patch_row). Name it, so
        # the board can jump to it instead of just saying no.
        ex_index = str(existing[0]["cells"].get("c_index", ""))
        raise HTTPException(status_code=409, detail={
            "message": f"This call already has a follow-up row (#{ex_index}).",
            "row_id": existing[0]["id"], "index": ex_index,
        })
    cells = row["cells"]
    _broadcast_row(row, live_notify.row_audience(cells))
    live_notify.on_row_changed(rid, {}, cells, user)
    return _public_row(row, True)


@router.post("/rows")
def add_row(body: dict | None = None, user: dict = Depends(_access)):
    if not user.get("is_admin"):     # only admins add rows (callers are read-only; appliers use the Schedule flow)
        raise HTTPException(status_code=403, detail="Only admins can add rows.")
    grid = _load_grid()
    valid = {c["id"] for c in grid["columns"]}
    body2 = body or {}
    cells = {k: v for k, v in (body2.get("cells", {}) or {}).items() if k in valid}
    if "c_sched" in cells:           # store Scheduled_at as a UTC instant (idempotent)
        cells["c_sched"] = _sched_to_utc(cells["c_sched"], str(user.get("timezone", "")).strip())
    # The Creator is whoever added the row. Stamp it here, once, so it is always true and never
    # depends on anyone clicking the cell — the board used to fill it on a plain left-click, which
    # meant simply selecting your way across an empty Creater cell silently signed you as author
    # (and made you the person the 90-minute heads-up went to). An explicit value is respected, so
    # re-inserting a row (undo of a delete) keeps its original creator.
    if "c_creater" in valid and not str(cells.get("c_creater", "") or "").strip():
        cells["c_creater"] = str(user.get("full_name") or user.get("username") or "").strip()
    # Created_At is a machine stamp, so stamp it HERE — not in the browser. It used to be set only by
    # the frontend's Add-row, which meant any row born another way (the API, a seed, an import) simply
    # had no creation date. Nobody noticed because the field was hidden; now it sits under Creater, so
    # the hole would be on screen. An explicit value is respected, so re-inserting a row (undo of a
    # delete) keeps its original date rather than being back-dated to the moment it was restored.
    if "c_created" in valid and not str(cells.get("c_created", "") or "").strip():
        cells["c_created"] = datetime.now(timezone.utc).isoformat()
    # Sensible starting state for a fresh call: not yet scheduled, not yet agreed, an Intro as the
    # first call type. Only fills a BLANK cell — an explicit value (e.g. re-inserting a row on undo)
    # wins — and only if the column still exists and the option is still valid, so renaming/removing a
    # select option can never leave a row pointing at a dead value. _NEW_ROW_DEFAULTS keeps these in
    # one place next to _default_grid, where the option lists live.
    _apply_new_row_defaults(cells, grid["columns"])
    # an explicit id + position lets the client re-insert a row (undo of a delete / redo of an add)
    rid = str(body2.get("id") or "").strip()
    if not rid or any(r["id"] == rid for r in grid["rows"]):
        rid = _new_id("r")
    at = body2.get("at")

    def _prepare(rows: list[dict]) -> dict:              # inside the insert's write lock
        # Index — the call number. Auto-assign the SMALLEST unused positive integer (across every
        # plain index AND every part of a "13_16_19" chain), so numbers stay unique and gap-free —
        # filling holes left by deletes rather than only ever climbing. An explicit value (undo of a
        # delete) is kept unless another call has taken that number meanwhile: the freed number goes
        # to the next new row, so restoring it blindly made two calls with one number.
        if "c_index" in valid:
            idx = str(cells.get("c_index", "") or "").strip()
            own = idx.rpartition("_")[2]
            taken = {str((r.get("cells") or {}).get("c_index", "")).strip().rpartition("_")[2] for r in rows}
            if not idx or own in taken:
                head = idx.rpartition("_")[0]
                n = str(_next_index_number(rows))
                cells["c_index"] = f"{head}_{n}" if head else n
        return cells

    row = storage.insert_interview_row(rid, cells, at if isinstance(at, int) else None, prepare=_prepare)
    _broadcast_row(row, live_notify.row_audience(cells))   # audience from the UNSTRIPPED cells
    live_notify.on_row_changed(rid, {}, cells, user)      # a row created already naming a caller/team
    return _public_row(row, bool(user.get("is_admin")))


def rename_team_cells(old_name: str, new_name: str) -> int:
    """A team was renamed — move every call handed to it over to the new name. The Team cell holds the
    team's NAME, and visibility (_team_scope) and notifications (_team_people) match on the current
    name, so without this its manager lost sight of the team's queue and nobody was told about it."""
    return detach_team(old_name, new_name)


def detach_team(team_name: str, new_name: str = "") -> int:
    """A team has been deleted — strip its name off every interview that was handed to it.

    Without this the Team cell keeps pointing at a team that no longer exists: the board shows a call
    assigned to a phantom, `_team_people()` resolves it to nobody, and every notification meant for that
    team's manager and members goes silently nowhere. Exactly the failure the orphaned Creater names
    caused. The CALLER is left alone — if a person was picked, the call is still theirs to make; only
    the team it was routed through is gone.

    Returns the number of rows changed. Never raises: losing a team must not fail the delete.
    """
    name = str(team_name or "").strip()
    if not name:
        return 0
    touched: list[dict] = []
    try:
        with _lock:
            for row in storage.get_interview_rows():
                cells = row.get("cells") or {}
                if str(cells.get("c_team", "")).strip().lower() == name.lower():
                    updated = storage.patch_interview_row(row["id"], {"c_team": new_name})
                    if updated:
                        touched.append(updated)
    except Exception:
        log.exception("Could not move interviews off team %r", name)
        return 0

    # Tell every open board, so nobody keeps the stale name. Through _broadcast_row, not the hub
    # directly: it is the one place that decides who may see the Creater, and a raw send here would
    # hand every caller on the row the creator's name that the REST path is careful to withhold.
    for row in touched:
        _broadcast_row(row, live_notify.row_audience(row.get("cells") or {}))
    return len(touched)


@router.patch("/rows/{row_id}")
def patch_row(row_id: str, body: dict, user: dict = Depends(_access)):
    _bootstrap()
    valid = {c["id"] for c in storage.get_interview_columns()}
    patch = {k: v for k, v in ((body or {}).get("cells", {}) or {}).items() if k in valid}
    # The chat thread changes only through the /chat endpoints, for admins too: a cell PATCH carries
    # the sender's cached copy, so e.g. an admin pasting across the column wrote back a stale thread
    # and deleted every message posted since their board loaded.
    patch.pop(_CHAT_COL, None)
    if not user.get("is_admin"):     # callers: Status. Managers: + Caller.
        patch = {k: v for k, v in patch.items() if k in _editable_cols(user)}
        # A manager may hand a call to another caller — but only one of their own team's. Reject
        # rather than drop it, so a bad re-assign is never silently ignored (it would also make
        # the row vanish from their board).
        if "c_caller" in patch:
            target = str(patch["c_caller"] or "").strip().lower()
            if target and target not in team_caller_names(team_id_of(user)):
                raise HTTPException(status_code=403, detail="You can only assign callers on your own team.")
    if "c_sched" in patch:           # store Scheduled_at as a UTC instant (idempotent)
        patch["c_sched"] = _sched_to_utc(patch["c_sched"], str(user.get("timezone", "")).strip())
    # Somebody else is actively editing one of these cells — refuse rather than silently overwrite
    # their work. This is the fix for the lost-write bug: two people typing into the same cell
    # used to end with whoever saved last, and the other person's content simply vanished.
    for cid in patch:
        held = hub.held_by_other(row_id, cid, str(user.get("id", "")))
        if held:
            raise HTTPException(status_code=409,
                                detail=f"{held.label} is editing this cell right now — try again in a moment.")

    row = storage.get_interview_row(row_id)
    if row is None or not _owns_row(user, row):
        raise HTTPException(status_code=404, detail="Row not found")
    is_admin = bool(user.get("is_admin"))
    if not patch:                    # nothing this user is allowed to change → no-op
        return _public_row(row, is_admin)
    before = dict(row.get("cells") or {})
    updated = storage.patch_interview_row(row_id, patch)   # one-row UPDATE, in a transaction
    if updated is None:
        raise HTTPException(status_code=404, detail="Row not found")

    # Push the new row to every board that may see it, and tell whoever the change affects. Both are
    # fire-and-forget — a socket must never fail an interview edit. The audience is worked out from
    # the FULL cells (it needs the creator to find them); only the payload is trimmed per recipient.
    after = dict(updated.get("cells") or {})
    seen_before, seen_after = live_notify.row_audience(before), live_notify.row_audience(after)
    _broadcast_row({"id": row_id, "cells": after}, seen_after)
    # Whoever could see the row and now can't (the call was handed to someone else) must drop it,
    # not keep a stale copy that later edits never reach.
    if seen_before - seen_after:
        hub.broadcast_soon({"type": "row_delete", "row_id": row_id}, seen_before - seen_after)
    live_notify.on_row_changed(row_id, before, after, user)

    # Auto-clone on "Passed": when an admin marks a call Passed, spawn its follow-up
    # row (copied verbatim incl. Chat & Feedback), once. Guarded so re-selecting
    # Passed or editing the passed row never spawns a second follow-up. Best-effort —
    # a clone failure must never fail the status edit itself.
    if (is_admin and "c_status" in patch
            and str(after.get("c_status", "")).strip().lower() == "passed"
            and str(before.get("c_status", "")).strip().lower() != "passed"):
        try:
            valid = {c["id"] for c in storage.get_interview_columns()}
            src_index = str(after.get("c_index", "") or "").strip()
            crid = _new_id("r")
            # The "already has a follow-up?" check runs inside the insert's write lock: two Passed
            # saves at once both passed an earlier unlocked check and cloned twice.
            crow = storage.insert_interview_row(
                crid, {}, None,
                prepare=lambda rows: None if _has_passed_child(rows, src_index)
                else _build_clone_cells(after, rows, valid))
            if crow is not None:
                clone_cells = crow["cells"]
                _broadcast_row(crow, live_notify.row_audience(clone_cells))
                # One notification for the one action: fold "follow-up created" into the Passed edit's.
                if not live_notify.note_followup(row_id, user, str(clone_cells.get("c_index", ""))):
                    live_notify.on_row_changed(crid, {}, clone_cells, user)
        except Exception:
            log.exception("Passed auto-clone failed for row %s", row_id)

    return _public_row(updated, is_admin)


@router.delete("/rows/{row_id}")
def delete_row(row_id: str, user: dict = Depends(_access)):
    if not user.get("is_admin"):         # only admins delete rows
        raise HTTPException(status_code=403, detail="Only admins can delete rows.")
    _bootstrap()
    row = storage.get_interview_row(row_id)
    if row is None or not _owns_row(user, row):
        raise HTTPException(status_code=404, detail="Row not found")
    storage.delete_interview_row(row_id)
    live_notify.forget_row(row_id)          # don't announce edits to a call that no longer exists
    hub.broadcast_soon({"type": "row_delete", "row_id": row_id},
                       live_notify.row_audience(row.get("cells") or {}))
    return {"ok": True}


# ── Chat & Feedback thread (the c_feedback cell holds a JSON list of messages) ──────────────
_CHAT_COL = "c_feedback"


def _parse_chat(value) -> list:
    """Read the stored chat: a JSON list of {id, author, avatar, at, text}. A legacy plain-text
    note is surfaced as one message so nothing is lost."""
    s = str(value or "").strip()
    if not s:
        return []
    try:
        arr = json.loads(s)
        if isinstance(arr, list):
            return [m for m in arr if isinstance(m, dict) and ("text" in m or "image" in m)]
    except Exception:
        pass
    return [{"id": "legacy", "author": "", "avatar": "", "at": "", "text": s}]


def _owned_row_or_404(row_id: str, user: dict) -> dict:
    _bootstrap()
    row = storage.get_interview_row(row_id)
    if row is None or not _owns_row(user, row):
        raise HTTPException(status_code=404, detail="Row not found")
    return row


def _append_msg(row_id: str, user: dict, msg: dict) -> list:
    """Append one message to the thread. The read-modify-write happens inside a single transaction
    on that one cell, so two people posting at the same time can't clobber each other."""
    out: list = []

    def _mutate(cur):
        msgs = _parse_chat(cur)
        msgs = [m for m in msgs if m.get("id") != "legacy" or m.get("text")]   # keep the legacy note in-thread
        msgs.append(msg)
        out.extend(msgs)
        return json.dumps(msgs, ensure_ascii=False)

    _thread_changed(row_id, _mutate)
    return out


def _thread_changed(row_id: str, mutate) -> None:
    """Apply a chat change and push the row to open boards, so their cached thread (and its count)
    stays current instead of going stale until reload."""
    row = storage.mutate_interview_cell(row_id, _CHAT_COL, mutate)
    if row is None:
        raise HTTPException(status_code=404, detail="Row not found")
    _broadcast_row(row, live_notify.row_audience(row.get("cells") or {}))


@router.get("/rows/{row_id}/chat")
def get_chat(row_id: str, user: dict = Depends(_access)):
    row = _owned_row_or_404(row_id, user)
    return {"messages": _parse_chat((row.get("cells") or {}).get(_CHAT_COL, ""))}


@router.post("/rows/{row_id}/chat")
def append_chat(row_id: str, body: dict, user: dict = Depends(_access)):
    """Append one message to the thread. Both admins and callers may post — that's the
    Chat & Feedback column. The append is a transactional read-modify-write of that one cell."""
    text = str((body or {}).get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty message")
    if len(text) > 20000:
        raise HTTPException(status_code=400, detail="Message too long")
    row = _owned_row_or_404(row_id, user)
    msg = {
        "id": _new_id("m"),
        "author": (user.get("full_name") or user.get("username") or "").strip(),
        "avatar": str(user.get("avatar_url", "")).strip(),
        "at": datetime.now(timezone.utc).isoformat(),
        "text": text,
    }
    out = _append_msg(row_id, user, msg)
    live_notify.on_feedback_added(row_id, row.get("cells") or {}, user, text)
    return {"messages": out}


@router.delete("/rows/{row_id}/chat/{msg_id}")
def delete_chat(row_id: str, msg_id: str, user: dict = Depends(_access)):
    """Delete a message — your own, or any if you're an admin."""
    author = (user.get("full_name") or user.get("username") or "").strip()
    row = _owned_row_or_404(row_id, user)
    msgs = _parse_chat((row.get("cells") or {}).get(_CHAT_COL, ""))
    target = next((m for m in msgs if m.get("id") == msg_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Message not found")
    if not user.get("is_admin") and str(target.get("author", "")).strip() != author:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")

    out: list = []

    def _mutate(cur):
        kept = [m for m in _parse_chat(cur) if m.get("id") != msg_id]
        out.extend(kept)
        return json.dumps(kept, ensure_ascii=False)

    _thread_changed(row_id, _mutate)
    return {"messages": out}


# ── Chat image attachments (screenshots) ──────────────────────────────────────
_CHAT_IMG_DIR = DATA_DIR / "chat_images"
_IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


@router.post("/rows/{row_id}/chat/image")
async def append_chat_image(row_id: str, file: UploadFile = File(...), text: str = Form(""), user: dict = Depends(_access)):
    """Attach a screenshot/image to the thread as a message (optionally with a caption)."""
    if file.content_type not in _IMG_EXT:
        raise HTTPException(status_code=400, detail="Only PNG / JPG / WEBP / GIF images")
    content = await file.read()
    if len(content) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image too large (max 8 MB)")
    row = _owned_row_or_404(row_id, user)
    _CHAT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{_new_id('img')}{_IMG_EXT[file.content_type]}"
    (_CHAT_IMG_DIR / name).write_bytes(content)
    caption = str(text or "").strip()
    msg = {
        "id": _new_id("m"),
        "author": (user.get("full_name") or user.get("username") or "").strip(),
        "avatar": str(user.get("avatar_url", "")).strip(),
        "at": datetime.now(timezone.utc).isoformat(),
        "text": caption,
        "image": f"/api/interviews/chat-image/{name}",
    }
    out = _append_msg(row_id, user, msg)
    live_notify.on_feedback_added(row_id, row.get("cells") or {}, user, caption)
    return {"messages": out}


@router.get("/chat-image/{name}")
def get_chat_image(name: str, user: dict = Depends(_access)):
    """Serve a chat image (auth-gated to board users). The frontend fetches it as a blob."""
    if not re.match(r"^[A-Za-z0-9_.-]+$", name) or "/" in name or ".." in name:
        raise HTTPException(status_code=404, detail="Not found")
    path = _CHAT_IMG_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(str(path))
