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

router = APIRouter(prefix="/api/interviews", tags=["interviews"])

# Admins, callers and team managers can all use the board.
_access = require_role("admin", "caller", "manager")
# A caller is read-only on the board except these columns: Approved, Status, and the
# Chat & Feedback thread (c_feedback). Chat posts also go through the dedicated /chat endpoint.
_CALLER_EDITABLE = {"c_approved", "c_status", "c_feedback"}
# A manager can additionally hand a call to a different caller — but only one of their own (enforced
# in patch_row: writing c_caller with someone outside the team is rejected, not silently accepted).
_MANAGER_EDITABLE = _CALLER_EDITABLE | {"c_caller"}


def _editable_cols(user: dict) -> set:
    return _MANAGER_EDITABLE if is_manager(user) else _CALLER_EDITABLE

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_GRID_FILE = DATA_DIR / "interviews.json"
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

    admin   → everything.
    manager → their whole team (incl. calls handed to the team with no Caller yet).
    caller  → their own calls, PLUS their team's whole schedule if they're on a team, so a team can
              see what the rest of the team is booked for. Seeing is not editing — see _writability.
    """
    if user.get("is_admin"):
        return lambda row: True

    if is_manager(user):
        return _team_scope(user)

    ids = _caller_ids(user)
    mine = lambda row: str((row.get("cells") or {}).get("c_caller", "")).strip().lower() in ids
    if not team_id_of(user):
        return mine
    in_team = _team_scope(user)
    return lambda row: mine(row) or in_team(row)


def _writability(user: dict):
    """WRITE scope — deliberately NARROWER than the read scope.

    A team member can see the whole team's schedule but may only edit their OWN calls; without this
    split, widening visibility would have silently let any caller set Approved/Status/Feedback on a
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
        {"id": "c_type", "name": "Call Type", "type": "select", "width": 180, "options": [
            s("Intro 1(Recruiter)", "#6366f1"), s("Tech Call(1)", "#ef4444"),
            s("Phone Call", "#64748b"), s("Intro + Tech", "#22c55e")]},
        {"id": "c_client", "name": "Interviewer(role)", "type": "text", "width": 180},
        {"id": "c_min", "name": "Duration(min)", "type": "text", "width": 100},
        {"id": "c_sched", "name": "Scheduled_at", "type": "date", "width": 140},
        {"id": "c_created", "name": "Created_at", "type": "date", "width": 130},
        {"id": "c_team", "name": "Team", "type": "select", "width": 140, "options": []},
        {"id": "c_caller", "name": "Caller", "type": "select", "width": 140, "options": []},
        {"id": "c_approved", "name": "Approved", "type": "select", "width": 120, "options": [
            s("Confirmed", "#22c55e"), s("Pending", "#f59e0b"), s("Rejected", "#ef4444")]},
        {"id": "c_creater", "name": "Creater", "type": "person", "width": 140},
        {"id": "c_status", "name": "Status", "type": "select", "width": 120, "options": [
            s("Done", "#3b82f6"), s("Failed", "#ef4444"), s("OnSite", "#06b6d4"),
            s("Closed", "#64748b"), s("Not Done", "#ef4444"), s("On-hold", "#f59e0b"),
            s("Filled", "#a855f7"), s("Account", "#f59e0b")]},
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
        if not storage.get_interview_columns():          # empty DB board → seed it
            grid = _read_legacy_json() or _default_grid()
            storage.seed_interview_grid(grid["columns"], grid["rows"])
        storage.append_interview_columns(_REQUIRED_COLS)  # add newly-required columns
        _migrate_sched_db()                               # legacy wall-clock Scheduled_at → UTC
        _bootstrapped = True


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


@router.get("")
def get_grid(user: dict = Depends(_access)):
    grid = _load_grid()
    # Admins see every interview; a caller sees only their own rows; a manager sees their whole team's
    # (including calls handed to the team that have no Caller assigned yet).
    if not user.get("is_admin"):
        can_see = _visibility(user)
        grid = {**grid, "rows": [r for r in grid["rows"] if can_see(r)]}
    return grid


@router.get("/people")
def list_people(user: dict = Depends(_access)):
    """All users — feeds the Caller dropdown (filtered by role) and the Creater avatars.

    For a manager this is narrowed to their own team, so the Caller dropdown can only ever offer
    someone they're allowed to assign (the backend rejects the rest anyway — this just stops the UI
    from presenting a choice that would be refused)."""
    team_only = is_manager(user)
    tid = team_id_of(user)
    out = []
    for u in storage.get_users():
        un = str(u.get("username", "")).strip()
        fn = str(u.get("full_name", "")).strip()
        if not (un or fn):
            continue
        if team_only and str(u.get("team_id", "")).strip() != tid:
            continue
        out.append({
            "username": un, "full_name": fn, "label": fn or un,
            "roles": u.get("roles") or [],
            "team_id": str(u.get("team_id", "")).strip(),   # groups the Caller dropdown by team
            "avatar_url": str(u.get("avatar_url", "")).strip(),
        })
    return {"people": out}


@router.get("/profiles")
def list_profiles(user: dict = Depends(_access)):
    """All profile names (from the Profiles tab / DB) — feeds the Account Profile dropdown.
    Labels only; every board user (admin + caller) sees the full list, like the Caller dropdown."""
    out = []
    for p in storage.get_profiles():
        pid = str(p.get("id", "")).strip()
        name = str(p.get("name", "")).strip()
        if not name:
            continue
        region = str(p.get("region", "")).strip()
        label = f"{name}({region})" if region else name    # e.g. "Charlie Barahona(US)"
        out.append({"id": pid, "name": name, "region": region, "label": label})
    return {"profiles": out}


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
        if col["id"] in seen:
            col["id"] = _new_id("c")
        seen.add(col["id"])
        cols.append(col)
    _bootstrap()
    storage.replace_interview_columns(cols)      # prunes cells of removed columns
    return storage.get_interview_grid()


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
    # an explicit id + position lets the client re-insert a row (undo of a delete / redo of an add)
    rid = str(body2.get("id") or "").strip()
    if not rid or any(r["id"] == rid for r in grid["rows"]):
        rid = _new_id("r")
    at = body2.get("at")
    return storage.insert_interview_row(rid, cells, at if isinstance(at, int) else None)


def _check_workflow(before: dict, patch: dict) -> None:
    """Interview workflow rules, enforced server-side so the UI can't be worked around:

      1. Approved can only be 'Confirmed' once a Caller is assigned — you can't confirm a call that
         nobody is going to make. Unassigned calls stay 'Pending'.
      2. Status can only be set once the call is 'Confirmed' — no outcome before it's even agreed.

    Checked against the row as it will look AFTER the patch, so setting the caller and confirming in
    the same write is fine.
    """
    after = {**before, **patch}
    caller = str(after.get("c_caller", "") or "").strip()
    approved = str(after.get("c_approved", "") or "").strip()

    if str(patch.get("c_approved", "") or "").strip() == "Confirmed" and not caller:
        raise HTTPException(status_code=400, detail="Assign a caller before confirming this interview.")

    if str(patch.get("c_status", "") or "").strip() and approved != "Confirmed":
        raise HTTPException(status_code=400, detail="Confirm the interview before setting its status.")


@router.patch("/rows/{row_id}")
def patch_row(row_id: str, body: dict, user: dict = Depends(_access)):
    _bootstrap()
    valid = {c["id"] for c in storage.get_interview_columns()}
    patch = {k: v for k, v in ((body or {}).get("cells", {}) or {}).items() if k in valid}
    if not user.get("is_admin"):     # callers: Approved/Status/Feedback. Managers: + Caller.
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

    row = storage.get_interview_row(row_id)
    if row is None or not _owns_row(user, row):
        raise HTTPException(status_code=404, detail="Row not found")
    if not patch:                    # nothing this user is allowed to change → no-op
        return row
    _check_workflow(row.get("cells") or {}, patch)
    updated = storage.patch_interview_row(row_id, patch)   # one-row UPDATE, in a transaction
    if updated is None:
        raise HTTPException(status_code=404, detail="Row not found")
    return updated


@router.delete("/rows/{row_id}")
def delete_row(row_id: str, user: dict = Depends(_access)):
    if not user.get("is_admin"):         # only admins delete rows
        raise HTTPException(status_code=403, detail="Only admins can delete rows.")
    _bootstrap()
    row = storage.get_interview_row(row_id)
    if row is None or not _owns_row(user, row):
        raise HTTPException(status_code=404, detail="Row not found")
    storage.delete_interview_row(row_id)
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

    if storage.mutate_interview_cell(row_id, _CHAT_COL, _mutate) is None:
        raise HTTPException(status_code=404, detail="Row not found")
    return out


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
    _owned_row_or_404(row_id, user)
    msg = {
        "id": _new_id("m"),
        "author": (user.get("full_name") or user.get("username") or "").strip(),
        "avatar": str(user.get("avatar_url", "")).strip(),
        "at": datetime.now(timezone.utc).isoformat(),
        "text": text,
    }
    return {"messages": _append_msg(row_id, user, msg)}


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

    if storage.mutate_interview_cell(row_id, _CHAT_COL, _mutate) is None:
        raise HTTPException(status_code=404, detail="Row not found")
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
    _owned_row_or_404(row_id, user)
    _CHAT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{_new_id('img')}{_IMG_EXT[file.content_type]}"
    (_CHAT_IMG_DIR / name).write_bytes(content)
    msg = {
        "id": _new_id("m"),
        "author": (user.get("full_name") or user.get("username") or "").strip(),
        "avatar": str(user.get("avatar_url", "")).strip(),
        "at": datetime.now(timezone.utc).isoformat(),
        "text": str(text or "").strip(),
        "image": f"/api/interviews/chat-image/{name}",
    }
    return {"messages": _append_msg(row_id, user, msg)}


@router.get("/chat-image/{name}")
def get_chat_image(name: str, user: dict = Depends(_access)):
    """Serve a chat image (auth-gated to board users). The frontend fetches it as a blob."""
    if not re.match(r"^[A-Za-z0-9_.-]+$", name) or "/" in name or ".." in name:
        raise HTTPException(status_code=404, detail="Not found")
    path = _CHAT_IMG_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(str(path))
