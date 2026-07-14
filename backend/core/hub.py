"""Live board hub — WebSocket fan-out for the interviews board.

Solves two things the plain REST board could not:

  1. LOST WRITES. Two people editing at once each held their own copy of the board; the last save
     won and the other person's work silently vanished. Now every change is broadcast, so every
     board updates in place, and a cell someone else is editing is visibly locked before you touch it.

  2. INSTANT NOTIFICATIONS. Assigning a caller, changing a cell, moving a call to another caller or
     team — the people affected are told immediately, rather than only via a scheduled push.

Design notes
  • One connection per browser tab; a user may have several.
  • Broadcasts are addressed by USER ID. The caller of `broadcast` decides who is allowed to know,
     because row visibility is role-scoped (a caller must not learn about another team's rows).
  • Everything here is best-effort: a dead socket is dropped, never raised into the request that
     triggered the broadcast. A failing socket must not fail an interview edit.
  • Locks are soft. They stop the accidental double-edit that was destroying work; they are not a
     security boundary (the REST layer still enforces every permission).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("hub")

# A lock older than this is stale — the editor closed the tab, lost the network, or wandered off.
# Refreshed on every keystroke-ish heartbeat from the client, so a real editor never expires.
LOCK_TTL_S = 12.0


@dataclass
class Conn:
    ws: Any                       # fastapi WebSocket
    user_id: str
    username: str
    label: str                    # display name shown to others ("Hamna is editing…")


@dataclass
class Lock:
    user_id: str
    label: str
    at: float = field(default_factory=time.time)

    @property
    def stale(self) -> bool:
        return (time.time() - self.at) > LOCK_TTL_S


class Hub:
    def __init__(self) -> None:
        self._conns: dict[int, Conn] = {}                    # id(ws) → Conn
        self._locks: dict[tuple[str, str], Lock] = {}        # (row_id, col_id) → Lock
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    # ── connections ──────────────────────────────────────────────────────────
    async def join(self, ws, user: dict) -> Conn:
        self._loop = asyncio.get_running_loop()
        conn = Conn(
            ws=ws,
            user_id=str(user.get("id", "")),
            username=str(user.get("username", "")),
            label=str(user.get("full_name") or user.get("username") or "Someone"),
        )
        async with self._lock:
            self._conns[id(ws)] = conn
        await self.send(ws, {"type": "locks", "locks": self.lock_list()})
        return conn

    async def leave(self, ws) -> None:
        async with self._lock:
            conn = self._conns.pop(id(ws), None)
        if conn:
            await self.release_all(conn.user_id)      # never leave a departed editor holding a cell

    def online(self) -> list[dict]:
        seen: dict[str, dict] = {}
        for c in self._conns.values():
            seen[c.user_id] = {"user_id": c.user_id, "label": c.label}
        return list(seen.values())

    # ── sending ──────────────────────────────────────────────────────────────
    async def send(self, ws, msg: dict) -> None:
        try:
            await ws.send_json(msg)
        except Exception:
            pass                                       # dead socket; cleaned up by the read loop

    async def broadcast(self, msg: dict, user_ids: set[str] | None = None, skip_ws=None) -> None:
        """Send to every connection whose user is in `user_ids` (None = everyone connected)."""
        targets = [c for c in list(self._conns.values())
                   if (user_ids is None or c.user_id in user_ids) and c.ws is not skip_ws]
        if not targets:
            return
        await asyncio.gather(*(self.send(c.ws, msg) for c in targets), return_exceptions=True)

    def broadcast_soon(self, msg: dict, user_ids: set[str] | None = None) -> None:
        """Fire-and-forget from SYNCHRONOUS code (the REST handlers are sync `def`).

        The socket loop lives on the server's event loop; a sync request handler runs in a worker
        thread and cannot await into it. `run_coroutine_threadsafe` hands the coroutine back to the
        loop safely. Silent no-op if nobody has ever connected."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self.broadcast(msg, user_ids), loop)
        except Exception:
            log.exception("broadcast_soon failed")

    # ── soft cell locks ──────────────────────────────────────────────────────
    def lock_list(self) -> list[dict]:
        out = []
        for (row_id, col_id), lk in list(self._locks.items()):
            if lk.stale:
                self._locks.pop((row_id, col_id), None)
                continue
            out.append({"row_id": row_id, "col_id": col_id, "user_id": lk.user_id, "label": lk.label})
        return out

    async def acquire(self, row_id: str, col_id: str, conn: Conn) -> bool:
        """Claim a cell. Returns False if somebody else holds a live lock on it."""
        key = (row_id, col_id)
        cur = self._locks.get(key)
        if cur and not cur.stale and cur.user_id != conn.user_id:
            return False
        self._locks[key] = Lock(user_id=conn.user_id, label=conn.label)
        await self.broadcast({"type": "lock", "row_id": row_id, "col_id": col_id,
                              "user_id": conn.user_id, "label": conn.label})
        return True

    async def release(self, row_id: str, col_id: str, user_id: str) -> None:
        key = (row_id, col_id)
        cur = self._locks.get(key)
        if cur and cur.user_id == user_id:
            self._locks.pop(key, None)
            await self.broadcast({"type": "unlock", "row_id": row_id, "col_id": col_id})

    async def release_all(self, user_id: str) -> None:
        gone = [k for k, v in self._locks.items() if v.user_id == user_id]
        for row_id, col_id in gone:
            self._locks.pop((row_id, col_id), None)
            await self.broadcast({"type": "unlock", "row_id": row_id, "col_id": col_id})

    def held_by_other(self, row_id: str, col_id: str, user_id: str) -> Lock | None:
        lk = self._locks.get((row_id, col_id))
        if lk and not lk.stale and lk.user_id != user_id:
            return lk
        if lk and lk.stale:
            self._locks.pop((row_id, col_id), None)
        return None

    async def touch(self, row_id: str, col_id: str, user_id: str) -> None:
        """Heartbeat: keep a lock alive while its owner is still typing."""
        lk = self._locks.get((row_id, col_id))
        if lk and lk.user_id == user_id:
            lk.at = time.time()


hub = Hub()


@contextlib.asynccontextmanager
async def connected(ws, user: dict):
    conn = await hub.join(ws, user)
    try:
        yield conn
    finally:
        await hub.leave(ws)
