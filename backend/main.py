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

FRONTEND_DIST = PROJECT_ROOT.parent / "frontend" / "dist"

app = FastAPI(title="TailorResume API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # nginx serves same-origin in prod; CORS open for local dev
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


@app.get("/api/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# Frontend static files (SPA fallback for non-/api/* paths)
# ---------------------------------------------------------------------------

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        # /api/* is handled by routers; anything else returns index.html for client-side routing
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        target = FRONTEND_DIST / full_path
        if target.is_file():
            return FileResponse(str(target))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
else:
    @app.get("/")
    def root():
        return {"ok": True, "msg": "Frontend not built yet. Run `npm run build` in frontend/."}
