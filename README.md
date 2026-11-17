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

**New here?** Clone, run the backend + frontend below, work on a branch, open a pull request.
Merging to `main` runs CI and puts it live on https://tailorresume.duckdns.org within a few
minutes — see [CI/CD](#cicd--push-to-main-and-it-goes-live). Install Python packages from
`backend/requirements.lock` (the exact versions production runs), not `requirements.txt`.

```bash
# Backend
cd backend
.venv/bin/uvicorn main:app --reload --port 8503

# Frontend (with proxy to backend on 8503)
cd frontend
npm run dev   # http://localhost:5173
```

### Browser extension (`extension/`)

One side panel with tabs chosen by role: **Out Bids** and **Easy Bids** (bidder), **Add Jobs**
(job_adder), and all three for admins. Jobs are split by link (`backend/core/easy_apply.py`): a
LinkedIn job link (`/jobs/view/<id>` or `?currentJobId=<id>`) is an **Easy Apply** job, bid from
Easy Bids; every other job applies on the company's site and is bid from Out Bids. **Easy Bids**
follows the LinkedIn tab: whenever it shows another job, the job is read and checked for duplicates
first (same LinkedIn job id, same company + title, same company this month) — nothing is added.
Easy Apply jobs only. **Gen CV** adds the job if it is new (link
`https://www.linkedin.com/jobs/view/<id>/`), then ChatGPT writes the CV and it is saved to Downloads
by itself (`POST /api/resumes/bid/easy`, `add=false` to check, `add=true` on Gen CV). To try changes without packing or installing it:

```bash
python3 extension-dev/serve.py   # http://127.0.0.1:8600 — in VS Code: Ports → 8600 → Simple Browser
```

The harness runs the real `extension/` files beside a mini browser that has sample
job pages, and it can also load real job URLs. Edit a file, then click **↻ Reload panel**.
**Dry run** is on by default: API writes are answered by the harness and never saved.
Publish a new version with `python ops/build_extension.py --changelog "…"` after
bumping `version` in `extension/manifest.json`.

## Production deploy

```bash
# Build frontend
cd frontend && npm run build

# Start backend
pm2 start /var/@TailorResume/ecosystem.config.js
```

nginx config: see `nginx.conf.example`.

### CI/CD — push to `main` and it goes live

```
git push ──► GitHub Actions (.github/workflows/ci-cd.yml)
              ├─ backend:   pip install, compile, import the app
              ├─ frontend:  npm ci, npm run build (type-check)
              ├─ extension: every script parses
              └─ deploy (main only, after all 3 pass)
                   └─► POST https://tailorresume.duckdns.org/deploy-hook   (HMAC-signed)
                         └─► server: ops/deploy.sh <sha>
                               fetch → fast-forward pull → rebuild/restart only what changed
                               → /api/health → done, or roll back to the previous commit
```

- **Python packages**: CI, the server and local dev all install `backend/requirements.lock` (exact
  production versions — `requirements.txt` alone lets pip pick newer releases than production runs).
  Adding/upgrading a package: edit `requirements.txt`, install it, regenerate the lock (see its header).
- **Every branch and pull request** gets the CI checks; only `main` deploys. Work on a branch, open a
  PR, merge when it's green — the merge deploys.
- **What a deploy does** (only for what the push changed): `backend/requirements.lock` → pip install;
  `frontend/` → build into `dist.new` and swap (the site is never half-built); `backend/` → restart
  `tailorresume-v2 job-sync company-intel vps1-sync` and wait for `/api/health`; `ecosystem.config.js`
  → `pm2 startOrRestart`. New DB columns are added by the API itself at start (additive only).
- **Any failure rolls back** to the previous commit and frontend; the Actions run shows
  `rolled_back` / `failed` with the step, and GitHub emails whoever pushed.
- **The server never overwrites work**: it only fast-forwards. If someone edited tracked files on
  the server, or committed there without pushing, the deploy stops and says so — push those
  commits (or discard the edits) and re-run the workflow.
- **Not automatic**: publishing the browser extension (`python ops/build_extension.py …`, after
  bumping its version) and nginx changes.
- **Logs** on the server: `data/deploy/logs/` (last 50 runs), state in `data/deploy/runs/<sha>.json`;
  the hook itself: `pm2 logs deploy-hook`. Deploy by hand: `ops/deploy.sh <full sha>`.
- **Secret**: `/etc/tailorresume/deploy.secret` on the server = repo secret `DEPLOY_SECRET`. To
  rotate: write a new value to both (`gh secret set DEPLOY_SECRET < /etc/tailorresume/deploy.secret`).

### Fonts for CV PDFs

PDFs are made from each profile's uploaded DOCX by LibreOffice, which swaps any font it doesn't
have (e.g. Segoe Print → DejaVu Sans). Templates use Windows fonts, so copy `C:\Windows\Fonts`
from a licensed Windows PC into `Fonts/` on the server (kept out of git: the repo is public and
Microsoft's licence forbids publishing them), then run `sudo ops/install_fonts.sh`.

Lora is installed **italic-only on purpose** (upright files sit in `Fonts/not-installed/`, which the
script skips). Farhan's template asks for upright "Lora", but the PC it is designed on has only
the italic face, so Word shows it italic — and the CVs must look like that.

## Migration notes

- Copied `core/` modules unchanged from `/var/@Resume-Generator/core/`.
- DB at `data/app.db` was seeded from the legacy DB: `users`, `settings`, `profiles`, `templates` rows preserved; `jobs`, `generated_resumes`, `openai_calls` start empty.
- JWT secret hardcoded in `backend/auth.py` (`TAILORRESUME_JWT_SECRET_2026`).
- Legacy Streamlit app still runs on port 8501 (`tailorresume` PM2 process). This new app uses port 8503.
