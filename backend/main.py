"""TailorResume v2 — FastAPI backend.

Serves both the React frontend (built into ../frontend/dist/) and the
/api/* JSON endpoints.

Start:
    uvicorn main:app --host 0.0.0.0 --port 8503
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Make project imports work
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from routers import auth as auth_router
from routers import devices as devices_router
from routers import jobs as jobs_router
from routers import metrics as metrics_router
from routers import profiles as profiles_router
from routers import resumes as resumes_router
from routers import settings as settings_router
from routers import todo as todo_router
from routers import users as users_router
from routers import screenshots as screenshots_router
from routers import extension as extension_router
from routers import guide as guide_router
from routers import external as external_router
from routers import interviews as interviews_router
from routers import push as push_router

FRONTEND_DIST = PROJECT_ROOT.parent / "frontend" / "dist"

app = FastAPI(title="TailorResume API", version="2.0.0")

# CORS: the web app is same-origin via nginx; the Chrome extension calls the API
# cross-origin from a chrome-extension:// origin. We allow the site origin plus
# any chrome-extension:// origin (matched by regex) instead of a blanket "*",
# which is incompatible with allow_credentials.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://tailorresume.duckdns.org",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_origin_regex=r"^chrome-extension://[a-z]+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount /api/* routers
app.include_router(auth_router.router)
app.include_router(jobs_router.router)
app.include_router(profiles_router.router)
app.include_router(resumes_router.router)
app.include_router(users_router.router)
app.include_router(settings_router.router)
app.include_router(todo_router.router)
app.include_router(metrics_router.router)
app.include_router(devices_router.router)
app.include_router(screenshots_router.router)
app.include_router(extension_router.router)
app.include_router(guide_router.router)
app.include_router(external_router.router)
app.include_router(interviews_router.router)
app.include_router(push_router.router)


@app.get("/api/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# Interview reminder scheduler — fires the 7pm-day-before / 8am-day-of / 1h-before
# Web Push reminders (per caller timezone). Runs as an in-process background thread.
# Set PUSH_SCHEDULER=0 to disable it here (e.g. to run it as a dedicated pm2 process
# instead when the API runs with multiple workers).
# ---------------------------------------------------------------------------
@app.on_event("startup")
def _start_reminder_scheduler():
    import threading
    if os.environ.get("PUSH_SCHEDULER", "1") == "0":
        return
    from core import notify
    threading.Thread(target=notify.scheduler_loop, kwargs={"interval_s": 60}, daemon=True).start()


# ---------------------------------------------------------------------------
# Frontend static files (SPA fallback for non-/api/* paths)
# ---------------------------------------------------------------------------

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    # index.html must never be cached, or browsers keep loading a stale JS bundle after a rebuild
    # (the hashed /assets/* files are safe to cache — a new build gives them new URLs).
    _NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        # /api/* is handled by routers; anything else returns index.html for client-side routing
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        target = FRONTEND_DIST / full_path
        if target.is_file() and target.name != "index.html":
            return FileResponse(str(target))
        return FileResponse(str(FRONTEND_DIST / "index.html"), headers=_NO_CACHE)
else:
    @app.get("/")
    def root():
        return {"ok": True, "msg": "Frontend not built yet. Run `npm run build` in frontend/."}
