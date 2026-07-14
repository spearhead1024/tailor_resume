"""Notification inbox — a per-user, persistent, read/unread list.

A toast is gone in two seconds. If you were on another page, in another tab, or simply looked away,
the change is lost to you forever. Everything the app tells a person is therefore also filed here,
so it can be caught up on later.

Two KINDS, kept deliberately apart because they answer different questions:

  board    — "somebody just changed something": assigned you a call, moved it away, updated a status.
             Fires the moment it happens.
  reminder — "this is about to happen": the 7pm/8am digests, the lead reminder, the creator heads-up.
             Fires on a schedule, from the notification scheduler.

Mixing them would bury an urgent "your interview starts in an hour" under a stream of edit chatter.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_FILE = DATA_DIR / "notifications.json"
_lock = threading.Lock()

KINDS = ("board", "reminder")
_MAX_PER_USER = 200          # newest kept; a busy board must not grow the file without bound


def _read() -> dict:
    if not _FILE.exists():
        return {"items": []}
    try:
        d = json.loads(_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) and isinstance(d.get("items"), list) else {"items": []}
    except Exception:
        return {"items": []}


def _write(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _FILE)


def _trim(items: list[dict]) -> list[dict]:
    """Keep only the newest _MAX_PER_USER per person (items are newest-first)."""
    seen: dict[str, int] = {}
    out = []
    for it in items:
        uid = it.get("user_id", "")
        seen[uid] = seen.get(uid, 0) + 1
        if seen[uid] <= _MAX_PER_USER:
            out.append(it)
    return out


def add(user_ids, kind: str, title: str, body: str, row_id: str = "", frm: str = "") -> list[dict]:
    """File one notification for each user. Returns the created items."""
    ids = [u for u in {str(u) for u in (user_ids or [])} if u]
    if not ids or kind not in KINDS:
        return []
    now = datetime.now(timezone.utc).isoformat()
    made = [{
        "id": f"n_{uuid.uuid4().hex[:12]}",
        "user_id": uid,
        "kind": kind,
        "title": str(title or ""),
        "body": str(body or ""),
        "row_id": str(row_id or ""),
        "from": str(frm or ""),
        "at": now,
        "read": False,
    } for uid in ids]
    with _lock:
        data = _read()
        data["items"] = _trim(made + data["items"])      # newest first
        _write(data)
    return made


def list_for(user_id: str, kind: str = "", limit: int = 100) -> list[dict]:
    uid = str(user_id or "")
    with _lock:
        items = _read()["items"]
    out = [i for i in items if i.get("user_id") == uid and (not kind or i.get("kind") == kind)]
    return out[:limit]


def counts(user_id: str) -> dict:
    uid = str(user_id or "")
    with _lock:
        items = _read()["items"]
    mine = [i for i in items if i.get("user_id") == uid and not i.get("read")]
    return {
        "unread": len(mine),
        "board": sum(1 for i in mine if i.get("kind") == "board"),
        "reminder": sum(1 for i in mine if i.get("kind") == "reminder"),
    }


def mark_read(user_id: str, ids: list[str] | None = None, kind: str = "") -> int:
    """Mark specific ids read, or (ids=None) everything — optionally only one kind."""
    uid = str(user_id or "")
    want = set(ids or [])
    n = 0
    with _lock:
        data = _read()
        for it in data["items"]:
            if it.get("user_id") != uid or it.get("read"):
                continue
            if want and it.get("id") not in want:
                continue
            if kind and it.get("kind") != kind:
                continue
            it["read"] = True
            n += 1
        if n:
            _write(data)
    return n


def clear(user_id: str) -> int:
    uid = str(user_id or "")
    with _lock:
        data = _read()
        before = len(data["items"])
        data["items"] = [i for i in data["items"] if i.get("user_id") != uid]
        removed = before - len(data["items"])
        if removed:
            _write(data)
    return removed
