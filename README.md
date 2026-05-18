# TailorResume v2

Full-stack rewrite of the Streamlit Resume Generator. FastAPI backend + React (Vite + TS) frontend.

## Architecture

```
[ nginx ]
   │  /          → static  /var/@TailorResume/frontend/dist/
   │  /api/*     → proxy   127.0.0.1:8503 (uvicorn)
```

- **Backend**: FastAPI + JWT auth, reuses `core/` (resume_engine, docx_resume_export, storage) unchanged
- **Frontend**: React + Vite + TanStack Query
- **DB**: SQLite at `data/app.db` (separate from the legacy Streamlit app)
- **PDF cache**: `data/pdf_cache/` (keyed by resume content hash)

## Pages

- **Login** — JWT, sign-in + request-access
- **To-Do** — approved jobs that haven't been applied to per profile
- **Jobs** — list / create / approve / delete
- **Resumes** — generate, edit & fix, PDF preview & export, ATS notes, job application answers, structured data, source profile
- **Profiles** — CRUD, DOCX template upload, technical-skills / work-history / education editing
- **Users** (admin) — CRUD, role + status, profile assignments
- **Settings** (admin) — JSON-edited app settings

## Local development

```bash
# Backend
cd backend
.venv/bin/uvicorn main:app --reload --port 8503

# Frontend (with proxy to backend on 8503)
cd frontend
npm run dev   # http://localhost:5173
```

## Production deploy

```bash
# Build frontend
cd frontend && npm run build

# Start backend
pm2 start /var/@TailorResume/ecosystem.config.js
```

nginx config: see `nginx.conf.example`.

## Migration notes

- Copied `core/` modules unchanged from `/var/@Resume-Generator/core/`.
- DB at `data/app.db` was seeded from the legacy DB: `users`, `settings`, `profiles`, `templates` rows preserved; `jobs`, `generated_resumes`, `openai_calls` start empty.
- JWT secret hardcoded in `backend/auth.py` (`TAILORRESUME_JWT_SECRET_2026`).
- Legacy Streamlit app still runs on port 8501 (`tailorresume` PM2 process). This new app uses port 8503.
