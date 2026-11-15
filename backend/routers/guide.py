"""Help → Guide video.

A single guide video that admins upload and everyone (signed in) can watch.
Stored on disk under data/guide/ with a small JSON sidecar. Until one is
uploaded the meta reports `available: false` and the UI shows "Coming soon".
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from auth import get_current_user, require_admin

router = APIRouter(prefix="/api/guide", tags=["guide"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
GUIDE_DIR = DATA_DIR / "guide"
GUIDE_DIR.mkdir(parents=True, exist_ok=True)
_META = GUIDE_DIR / "video.json"

_MAX_BYTES = 300 * 1024 * 1024  # 300 MB
_ALLOWED = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogv",
    "video/quicktime": ".mov",
}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_meta() -> dict | None:
    if not _META.exists():
        return None
    try:
        meta = json.loads(_META.read_text())
    except Exception:
        return None
    fname = str(meta.get("file") or "").strip()
    if not fname or not (GUIDE_DIR / fname).exists():
        return None
    return meta


@router.get("/video/meta")
def video_meta(user: dict = Depends(get_current_user)):
    meta = _load_meta()
    if not meta:
        return {"available": False}
    return {
        "available": True,
        "content_type": meta.get("content_type", "video/mp4"),
        "bytes": meta.get("bytes", 0),
        "uploaded_at": meta.get("uploaded_at", ""),
        "uploaded_by": meta.get("uploaded_by", ""),
        "original_name": meta.get("original_name", ""),
    }


@router.get("/video")
def video(user: dict = Depends(get_current_user)):
    """Serve the guide video. Requires login so the URL can't be opened/shared
    by anyone signed out. The web app fetches it as an authenticated blob (the
    <video> tag can't send a bearer token on its own)."""
    meta = _load_meta()
    if not meta:
        raise HTTPException(status_code=404, detail="No guide video yet.")
    fpath = GUIDE_DIR / meta["file"]
    return FileResponse(fpath, media_type=meta.get("content_type", "video/mp4"))


def _atomic_write_text(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


@router.post("/video")
def upload_video(
    request: Request,
    video: UploadFile = File(...),
    user: dict = Depends(require_admin),
):
    """Replace the guide video. Admin only.

    A plain `def` on purpose: FastAPI runs it in the threadpool, so copying up to 300 MB to disk
    doesn't block the event loop (the single uvicorn worker also serves the live-board sockets)."""
    # Reject early on the declared size before copying anything.
    try:
        if int(request.headers.get("content-length") or 0) > _MAX_BYTES + 1024 * 1024:
            raise HTTPException(status_code=413, detail="Video too large (max 300 MB).")
    except (TypeError, ValueError):
        pass

    ext = _ALLOWED.get((video.content_type or "").lower())
    if not ext:
        raise HTTPException(status_code=400, detail="Unsupported video type (mp4 / webm / ogg / mov).")

    # Stream into a temp file beside the target with a running size cap, then os.replace — a failed
    # or oversized upload never touches the current video.
    fd, tmp = tempfile.mkstemp(dir=GUIDE_DIR, prefix=".upload-", suffix=".part")
    size = 0
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := video.file.read(1024 * 1024):
                size += len(chunk)
                if size > _MAX_BYTES:
                    raise HTTPException(status_code=413, detail="Video too large (max 300 MB).")
                out.write(chunk)
        if not size:
            raise HTTPException(status_code=400, detail="Empty file.")
        fname = f"video{ext}"
        prev = _load_meta()
        os.replace(tmp, GUIDE_DIR / fname)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise

    # Drop the prior file only once the new one is in place (its extension may differ).
    if prev and prev.get("file") != fname:
        try:
            (GUIDE_DIR / prev["file"]).unlink(missing_ok=True)
        except Exception:
            pass

    meta = {
        "file": fname,
        "content_type": video.content_type,
        "bytes": size,
        "original_name": video.filename or "",
        "uploaded_at": _utcnow_iso(),
        "uploaded_by": user.get("username", ""),
    }
    _atomic_write_text(_META, json.dumps(meta, indent=2))
    return {"ok": True, **{k: meta[k] for k in ("content_type", "bytes", "uploaded_at", "original_name")}}


@router.delete("/video")
def delete_video(user: dict = Depends(require_admin)):
    """Remove the guide video. Admin only."""
    meta = _load_meta()
    if meta:
        try:
            (GUIDE_DIR / meta["file"]).unlink(missing_ok=True)
        except Exception:
            pass
    _META.unlink(missing_ok=True)
    return {"ok": True}
