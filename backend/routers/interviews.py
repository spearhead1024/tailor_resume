"""Interviews — a Notion/Coda-style editable grid for the caller dashboard.

Stored as a single JSON document (data/interviews.json): a list of typed
columns plus a list of rows (each row = column-id -> value). Gated to admin +
caller. Granular endpoints (schema / add-row / patch-row / delete-row) so
concurrent cell edits don't clobber each other; every read-modify-write is
done under a process lock.
"""
from __future__ import annotations

import json
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
from auth import require_role, storage

router = APIRouter(prefix="/api/interviews", tags=["interviews"])

# Both admins and callers can use the board.
_access = require_role("admin", "caller")
# A caller is read-only on the board except these two columns (Approved + Feedback).
_CALLER_EDITABLE = {"c_approved", "c_feedback"}

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


def _owns_row(user: dict, row: dict) -> bool:
    if user.get("is_admin"):
        return True
    return str((row.get("cells") or {}).get("c_caller", "")).strip().lower() in _caller_ids(user)


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
]


def _ensure_columns(grid: dict) -> bool:
    """Append any required column that's missing. Returns True if the grid changed."""
    have = {c.get("id") for c in grid.get("columns", [])}
    changed = False
    for spec in _REQUIRED_COLS:
        if spec["id"] not in have:
            grid.setdefault("columns", []).append(_normalize_column(spec))
            changed = True
    return changed


def _migrate_sched(grid: dict) -> bool:
    """One-time: convert legacy wall-clock Scheduled_at values to UTC, interpreting each in the
    timezone of the row's Creater (who typed it). Rows whose Creater has no time zone are left as-is."""
    tzmap = None
    changed = False
    for row in grid.get("rows", []):
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
            cells["c_sched"] = new
            changed = True
    return changed


# ── file I/O (callers must hold _lock) ──────────────────────────────────────
def _read_unlocked() -> dict:
    if not _GRID_FILE.exists():
        grid = _default_grid()
        _write_unlocked(grid)
        return grid
    raw = _GRID_FILE.read_text(encoding="utf-8")
    try:
        grid = json.loads(raw)
    except Exception:
        # tolerate a truncated / trailing-garbage file: recover the leading valid object
        try:
            grid, _ = json.JSONDecoder().raw_decode(raw.lstrip())
        except Exception:
            grid = _default_grid()
    if not isinstance(grid, dict):
        grid = _default_grid()
    grid["columns"] = [_normalize_column(c) for c in (grid.get("columns") or []) if isinstance(c, dict)]
    grid.setdefault("rows", [])
    changed = _ensure_columns(grid)     # add newly-required columns
    changed = _migrate_sched(grid) or changed   # convert legacy wall-clock Scheduled_at → UTC
    if changed:
        _write_unlocked(grid)
    return grid


def _write_unlocked(grid: dict) -> None:
    """Atomic write: serialise to a temp file, then rename over the target. Prevents partial or
    interleaved writes from corrupting the grid (which previously wiped the table)."""
    _GRID_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _GRID_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(grid, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _GRID_FILE)


@router.get("")
def get_grid(user: dict = Depends(_access)):
    with _lock:
        grid = _read_unlocked()
    # Admins see every interview; a caller sees only rows where the Caller is them.
    if not user.get("is_admin"):
        ids = _caller_ids(user)
        grid = {**grid, "rows": [r for r in grid["rows"]
                                 if str((r.get("cells") or {}).get("c_caller", "")).strip().lower() in ids]}
    return grid


@router.get("/people")
def list_people(user: dict = Depends(_access)):
    """All users — feeds the Caller dropdown (filtered by role) and the Creater avatars."""
    out = []
    for u in storage.get_users():
        un = str(u.get("username", "")).strip()
        fn = str(u.get("full_name", "")).strip()
        if not (un or fn):
            continue
        out.append({
            "username": un, "full_name": fn, "label": fn or un,
            "roles": u.get("roles") or [],
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
    with _lock:
        grid = _read_unlocked()
        valid = {c["id"] for c in cols}
        for row in grid["rows"]:
            cells = row.get("cells", {}) or {}
            row["cells"] = {k: v for k, v in cells.items() if k in valid}
        grid["columns"] = cols
        _write_unlocked(grid)
        return grid


@router.post("/rows")
def add_row(body: dict | None = None, user: dict = Depends(_access)):
    if not user.get("is_admin"):     # only admins add rows (callers are read-only; appliers use the Schedule flow)
        raise HTTPException(status_code=403, detail="Only admins can add rows.")
    with _lock:
        grid = _read_unlocked()
        valid = {c["id"] for c in grid["columns"]}
        body2 = body or {}
        cells = {k: v for k, v in (body2.get("cells", {}) or {}).items() if k in valid}
        if "c_sched" in cells:           # store Scheduled_at as a UTC instant (idempotent)
            cells["c_sched"] = _sched_to_utc(cells["c_sched"], str(user.get("timezone", "")).strip())
        # an explicit id + position lets the client re-insert a row (undo of a delete / redo of an add)
        rid = str(body2.get("id") or "").strip()
        if not rid or any(r.get("id") == rid for r in grid["rows"]):
            rid = _new_id("r")
        row = {"id": rid, "cells": cells}
        at = body2.get("at")
        if isinstance(at, int) and 0 <= at <= len(grid["rows"]):
            grid["rows"].insert(at, row)
        else:
            grid["rows"].append(row)
        _write_unlocked(grid)
        return row


@router.patch("/rows/{row_id}")
def patch_row(row_id: str, body: dict, user: dict = Depends(_access)):
    with _lock:
        grid = _read_unlocked()
        valid = {c["id"] for c in grid["columns"]}
        patch = {k: v for k, v in ((body or {}).get("cells", {}) or {}).items() if k in valid}
        if not user.get("is_admin"):     # callers are read-only except Approved + Feedback
            patch = {k: v for k, v in patch.items() if k in _CALLER_EDITABLE}
        if "c_sched" in patch:           # store Scheduled_at as a UTC instant (idempotent)
            patch["c_sched"] = _sched_to_utc(patch["c_sched"], str(user.get("timezone", "")).strip())
        for row in grid["rows"]:
            if row.get("id") == row_id:
                if not _owns_row(user, row):
                    raise HTTPException(status_code=404, detail="Row not found")
                if not patch:            # nothing this user is allowed to change → no-op
                    return row
                row.setdefault("cells", {}).update(patch)
                _write_unlocked(grid)
                return row
    raise HTTPException(status_code=404, detail="Row not found")


@router.delete("/rows/{row_id}")
def delete_row(row_id: str, user: dict = Depends(_access)):
    if not user.get("is_admin"):         # only admins delete rows
        raise HTTPException(status_code=403, detail="Only admins can delete rows.")
    with _lock:
        grid = _read_unlocked()
        target = next((r for r in grid["rows"] if r.get("id") == row_id), None)
        if target is None or not _owns_row(user, target):
            raise HTTPException(status_code=404, detail="Row not found")
        grid["rows"] = [r for r in grid["rows"] if r.get("id") != row_id]
        _write_unlocked(grid)
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


def _find_owned_row(grid: dict, row_id: str, user: dict) -> dict:
    row = next((r for r in grid["rows"] if r.get("id") == row_id), None)
    if row is None or not _owns_row(user, row):
        raise HTTPException(status_code=404, detail="Row not found")
    return row


@router.get("/rows/{row_id}/chat")
def get_chat(row_id: str, user: dict = Depends(_access)):
    with _lock:
        grid = _read_unlocked()
        row = _find_owned_row(grid, row_id, user)
    return {"messages": _parse_chat((row.get("cells") or {}).get(_CHAT_COL, ""))}


@router.post("/rows/{row_id}/chat")
def append_chat(row_id: str, body: dict, user: dict = Depends(_access)):
    """Append one message to the thread (atomic under the lock, so concurrent posts don't clobber
    each other). Both admins and callers may post — that's the Chat & Feedback column."""
    text = str((body or {}).get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty message")
    if len(text) > 20000:
        raise HTTPException(status_code=400, detail="Message too long")
    msg = {
        "id": _new_id("m"),
        "author": (user.get("full_name") or user.get("username") or "").strip(),
        "avatar": str(user.get("avatar_url", "")).strip(),
        "at": datetime.now(timezone.utc).isoformat(),
        "text": text,
    }
    with _lock:
        grid = _read_unlocked()
        row = _find_owned_row(grid, row_id, user)
        msgs = _parse_chat((row.get("cells") or {}).get(_CHAT_COL, ""))
        msgs = [m for m in msgs if m.get("id") != "legacy" or m.get("text")]   # keep legacy note in-thread
        msgs.append(msg)
        row.setdefault("cells", {})[_CHAT_COL] = json.dumps(msgs, ensure_ascii=False)
        _write_unlocked(grid)
    return {"messages": msgs}


@router.delete("/rows/{row_id}/chat/{msg_id}")
def delete_chat(row_id: str, msg_id: str, user: dict = Depends(_access)):
    """Delete a message — your own, or any if you're an admin."""
    author = (user.get("full_name") or user.get("username") or "").strip()
    with _lock:
        grid = _read_unlocked()
        row = _find_owned_row(grid, row_id, user)
        msgs = _parse_chat((row.get("cells") or {}).get(_CHAT_COL, ""))
        target = next((m for m in msgs if m.get("id") == msg_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail="Message not found")
        if not user.get("is_admin") and str(target.get("author", "")).strip() != author:
            raise HTTPException(status_code=403, detail="You can only delete your own messages")
        msgs = [m for m in msgs if m.get("id") != msg_id]
        row.setdefault("cells", {})[_CHAT_COL] = json.dumps(msgs, ensure_ascii=False)
        _write_unlocked(grid)
    return {"messages": msgs}


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
    with _lock:
        grid = _read_unlocked()
        row = _find_owned_row(grid, row_id, user)
        msgs = _parse_chat((row.get("cells") or {}).get(_CHAT_COL, ""))
        msgs.append(msg)
        row.setdefault("cells", {})[_CHAT_COL] = json.dumps(msgs, ensure_ascii=False)
        _write_unlocked(grid)
    return {"messages": msgs}


@router.get("/chat-image/{name}")
def get_chat_image(name: str, user: dict = Depends(_access)):
    """Serve a chat image (auth-gated to board users). The frontend fetches it as a blob."""
    if not re.match(r"^[A-Za-z0-9_.-]+$", name) or "/" in name or ".." in name:
        raise HTTPException(status_code=404, detail="Not found")
    path = _CHAT_IMG_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(str(path))
