"""The board's WebSocket endpoint.

A browser tab connects once and then receives, in real time:
  • `row` / `row_delete` / `schema` — the board changed; apply it in place (no more stale copies
    silently overwriting each other on the next save)
  • `lock` / `unlock`             — somebody started or finished editing a cell
  • `notify`                      — you personally are affected by a change

and sends:
  • `edit_start` / `edit_ping` / `edit_end` — I am editing this cell (claims a soft lock)

Auth rides in the query string: a WebSocket handshake can't carry an Authorization header, so the
JWT is passed as `?token=…` and validated exactly like a REST request before the socket is accepted.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from auth import decode_jwt, storage, token_problem
from core import live as live_notify
from core.hub import connected, hub

# How often an open socket re-checks its token: revoking a session or disabling a user must also
# cut off a board that is already connected, not just new ones.
_RECHECK_S = 60

log = logging.getLogger("live.ws")

router = APIRouter()

_BOARD_ROLES = {"admin", "caller", "manager"}


def _user_from_token(token: str) -> dict | None:
    try:
        payload = decode_jwt(token)
    except Exception:
        return None
    if token_problem(payload):              # revoked device / snooze ticket — same rule as REST
        return None
    user = storage.get_user_by_id(str(payload.get("sub", "")))
    if not user or user.get("status") != "approved":
        return None
    roles = {str(r).strip() for r in (user.get("roles") or [])}
    return user if roles & _BOARD_ROLES else None


@router.websocket("/api/interviews/live")
async def board_live(ws: WebSocket, token: str = Query(default="")):
    user = _user_from_token(token)
    if not user:
        # Accept first, then close with 4401 and send nothing, so nothing leaks. Closing before accept turns
        # into a bare HTTP 403 the browser can't tell from a dropped connection, so tabs holding an
        # expired token retried forever (tens of thousands of attempts per tab in the logs).
        await ws.accept()
        await ws.close(code=4401)
        return

    await ws.accept()

    async def _recheck() -> None:
        while True:
            await asyncio.sleep(_RECHECK_S)
            if not await run_in_threadpool(_user_from_token, token):
                await ws.close(code=4401)
                return

    def _row_audience(row_id: str) -> set[str] | None:
        """Who may see this row, if THIS user may (else None: no lock on rows you can't see)."""
        from routers.interviews import _visibility
        row = storage.get_interview_row(row_id)
        if row is None or not _visibility(user)(row):
            return None
        return live_notify.row_audience(row.get("cells") or {}) | {conn.user_id}

    async with connected(ws, user) as conn:
        recheck = asyncio.create_task(_recheck())
        try:
            while True:
                msg = await ws.receive_json()
                kind = str((msg or {}).get("type", ""))
                row_id = str((msg or {}).get("row_id", "")).strip()
                col_id = str((msg or {}).get("col_id", "")).strip()

                if kind == "edit_start" and row_id and col_id:
                    audience = await run_in_threadpool(_row_audience, row_id)
                    if audience is None:
                        continue
                    if not await hub.acquire(row_id, col_id, conn, audience):
                        held = hub.held_by_other(row_id, col_id, conn.user_id)
                        await hub.send(ws, {
                            "type": "lock_denied", "row_id": row_id, "col_id": col_id,
                            "label": held.label if held else "someone else",
                        })
                elif kind == "edit_ping" and row_id and col_id:
                    # Keep the lock alive while typing; re-claim it if it was dropped meanwhile.
                    if not await hub.touch(row_id, col_id, conn.user_id):
                        audience = await run_in_threadpool(_row_audience, row_id)
                        if audience is not None:
                            await hub.acquire(row_id, col_id, conn, audience)
                elif kind == "edit_end" and row_id and col_id:
                    await hub.release(row_id, col_id, conn.user_id)
                elif kind == "ping":
                    await hub.send(ws, {"type": "pong"})
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("board socket error for %s", conn.username)
        finally:
            recheck.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recheck
