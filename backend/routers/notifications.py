"""The notification inbox: what happened while you weren't looking."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from auth import get_current_user
from core import inbox

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("")
def list_notifications(
    kind: str = Query(default="", description="'board' | 'reminder' | '' for both"),
    limit: int = Query(default=100, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    return {
        "items": inbox.list_for(user["id"], kind=kind if kind in inbox.KINDS else "", limit=limit),
        "counts": inbox.counts(user["id"]),
    }


@router.post("/read")
def mark_read(body: dict = Body(default={}), user: dict = Depends(get_current_user)):
    """Mark specific ids read, or everything (optionally just one kind)."""
    body = body or {}
    ids = body.get("ids")
    kind = str(body.get("kind", "") or "")
    n = inbox.mark_read(user["id"],
                        ids=[str(i) for i in ids] if isinstance(ids, list) else None,
                        kind=kind if kind in inbox.KINDS else "")
    return {"ok": True, "marked": n, "counts": inbox.counts(user["id"])}


@router.delete("")
def clear_all(user: dict = Depends(get_current_user)):
    return {"ok": True, "removed": inbox.clear(user["id"]), "counts": inbox.counts(user["id"])}
