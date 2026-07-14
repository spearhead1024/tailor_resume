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

import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from auth import decode_jwt, storage
from core.hub import connected, hub

log = logging.getLogger("live.ws")

router = APIRouter()

_BOARD_ROLES = {"admin", "caller", "manager"}


def _user_from_token(token: str) -> dict | None:
    try:
        payload = decode_jwt(token)
    except Exception:
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
        await ws.close(code=4401)          # unauthorised — never accept, so nothing leaks
        return

    await ws.accept()
    async with connected(ws, user) as conn:
        try:
            while True:
                msg = await ws.receive_json()
                kind = str((msg or {}).get("type", ""))
                row_id = str((msg or {}).get("row_id", "")).strip()
                col_id = str((msg or {}).get("col_id", "")).strip()

                if kind == "edit_start" and row_id and col_id:
                    if not await hub.acquire(row_id, col_id, conn):
                        held = hub.held_by_other(row_id, col_id, conn.user_id)
                        await hub.send(ws, {
                            "type": "lock_denied", "row_id": row_id, "col_id": col_id,
                            "label": held.label if held else "someone else",
                        })
                elif kind == "edit_ping" and row_id and col_id:
                    await hub.touch(row_id, col_id, conn.user_id)      # keep the lock alive while typing
                elif kind == "edit_end" and row_id and col_id:
                    await hub.release(row_id, col_id, conn.user_id)
                elif kind == "ping":
                    await hub.send(ws, {"type": "pong"})
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("board socket error for %s", conn.username)
