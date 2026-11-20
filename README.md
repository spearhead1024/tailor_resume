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
- **Jobs** — list / create / approve / delete. **Pending** = the review queue of the AI job check
  (`core/job_ai.py`, VPS1's OpenAI screener word for word): a job_adder's job waits there until OpenAI
  reads it — remote / onsite / hybrid / travel / in-person / not stated, software, paid, clearance, main
  stack. *Fit* (explicitly remote) is approved by the check; *Not fit* / *Check* wait for an admin, who
  approves, rejects with a reason the adder sees, or compares it side by side with up to 10 similar jobs
  (same link / company + title / company). Other jobs get only their tech stack; synced VPS1 jobs copy
  VPS1's verdict and tags. Each call is logged with its cost (`openai_calls`); key = `OPENAI_API_KEY` in the
  root `.env`, model `JOB_AI_MODEL` (default gpt-4.1); Settings → AI job check turns it off.
- **Resumes** — generate, edit & fix, PDF preview & export, ATS notes, job application answers, structured data, source profile
- **Profiles** — CRUD, DOCX template upload, technical-skills / work-history / education editing.
  A detected company can be **Excluded** (kept as in the DOCX — not sent to ChatGPT, not rewritten), and
  **CV file name** sets the download's name: `{name} {first} {last} {company} {role} {date}`.
- **Applied** — the applied CVs: tech stack, **Share** (a public link to the PDF for 30 days, no login —
  HMAC-signed, `/api/public/cv/<token>`), **Schedule** (a row on the Interviews board with the profile as
  "Name(REGION)" and the job's stack as Skillset).
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

One side panel (`extension/panel/`), tabs by role: **Out Bids** and **Easy Bids** (bidder), **Add Jobs**
(job_adder), all three for admins. Bidding happens only here — the web app has no Bid tab.

- **Jobs are split by link** (`backend/core/easy_apply.py`): a LinkedIn job link (`/jobs/view/<id>` or
  `?currentJobId=<id>`) is an **Easy Apply** job, bid from Easy Bids; every other job applies on the
  company's site and is bid from Out Bids.
- **Easy Bids** follows the LinkedIn tab and checks the job first (`POST /api/resumes/bid/easy`, `add=false`):
  *New Job · region* (the profile's region), *CV Ready*, *Duplicate* (same posting / company + title / same
  company in any region within 15 days), *Applied* ("Already applied with <profile>" — no buttons).
  **Add + Gen CV** adds it (link `https://www.linkedin.com/jobs/view/<id>/`), ChatGPT writes the CV and it is
  saved to Downloads; **Add Job** adds it only. A posting that applies on the company's site gets **Add Job**
  only, stored with the company's own link (an Out Bids job). A job with a CV stays the current job until
  Mark as Applied / Report / Skip, even when LinkedIn moves the tab ("Still on <company>").
- **Tech Questions**: the application's questions, shared per job; ChatGPT answers them in the chat that
  wrote the CV (`gpt/runner.js` keeps that tab open until the job is done), with the model set in
  ⚙ Settings → ChatGPT models (default **Instant**); the model menu is set back afterwards, so the CVs keep
  theirs (a CV model can be pinned there too). `gpt/driver.js pickModel` finds the item by its name.
- **Newest Jobs** (Easy Bids, `lib/recent.js`): since Oct 2026 LinkedIn sends signed-in members from the
  classic search to its AI search, which has no "Most recent" (`sortBy=DD` is stripped, windows under 24 h
  count as 24 h). The list reads LinkedIn's public job list (`/jobs-guest/jobs/api/seeMoreJobPostings/search`,
  `credentials: 'omit'` — signed out, the LinkedIn host permission Easy Bids already has), which honours
  `f_TPR=r<seconds>`, and sorts it by each card's age. Same company + title in many places = one row. Rows
  open `/jobs/view/<id>/` on the bidder's LinkedIn tab (a new tab if an Easy Apply form is open there).
  Labels from `POST /api/resumes/bid/easy/known` (batch: applied / skipped / on file / closed / duplicate /
  blocked). Auto looks every 2 min, only the minutes since the last look; HTTP 429 pauses it 5 min.
- **⚙ Settings**: Connections (ChatGPT — real background tabs; LinkedIn — the optional host permission),
  which cards each tab shows, LinkedIn's classic job search (`lib/classic.js`; when LinkedIn sends it straight
  back to AI search, it pauses 6 h in every tab — `classicBlocked`), and Update Now.
- The layout is one fluid column (centred past 600px), so it works from Chrome's narrowest side panel up.
- **Opening the panel** picks the tab from the page you're on: an empty tab → Out Bids (the latest job
  opens in it), LinkedIn → Easy Bids, any other site → Add Jobs (Out Bids for a bidder without it).
- **CVs save to Downloads by themselves** as "<Profile> Resume.pdf" (a name valid on Windows / macOS /
  Linux; the same CV replaces the old file — `lib/save-file.js`), or by the profile's CV file name template. If the browser's "Ask where to save each
  file" setting is on, every save shows a dialog; the panel detects it and links to the setting. A Gen CV
  still waiting for its CV survives closing the panel (session storage).
- **✕** (top right, every screen) closes the panel — `chrome.sidePanel.close()` in the side panel, or the
  tab / window it was opened in — for browsers that draw no close button of their own.
- **Out Bids works on a set of 2 jobs** (panel `fillWin`, server `core/cv_queue.AHEAD = 2`): the one on
  screen + the next one, their CVs written one after another. Mark as Applied / Report / Skip →
  that job's chat is deleted (in the open ChatGPT tab), the set's next job comes up, and the
  NEWEST queue job not in the set joins it. The set is kept per profile, so new jobs at the top of the queue
  never make the bidder jump. Two ChatGPT tabs work at once (`gpt/runner.js` "placing tabs"): the job on
  screen's sits in the bidder's window — the ONE ChatGPT tab they see — and the next job's is written in a
  minimized window of its own; the panel reports the job on screen (`gpt('focus')`) and the tabs swap
  windows (`chrome.tabs.move`, the page stays alive). Answers go first, in the job's own chat without a
  reload; chats are deleted in place. **One chat per job**: every task carries the chat it must be on
  (`expect`) — the driver sends nothing on any other page, reports only that chat, and the server never
  lets one chat belong to two jobs (`cv_queue.foreign_chat`). Easy Bids has no queue: only the job on screen.
- **ChatGPT project per profile** (`profile.gpt_project_url`, ⚙ Settings → Use This Tab, `PUT /api/gpt/project`):
  the bidders share one ChatGPT account whose memory mixed profiles up; chats start inside the profile's
  project (create it with "Project-only" memory). Also: the CV prompt names the candidate and fences out
  memory, and the server refuses a CV whose companies aren't the profile's (written again in a new chat).

**Easy vs Out in the web app**: Jobs and Applied show a small LinkedIn *Easy Apply* badge on Easy Apply
jobs and an Easy / Out filter; Metrics shows how many applies and jobs added were Easy Apply (`E n`).
**One day everywhere**: Metrics, Applied and Jobs count a day as 5pm GMT+9 → 5pm GMT+9, and Metrics'
week is Mon–Sun. Metrics files an apply under the day it was applied and includes VPS1 (mirrored applies,
synced jobs), so its GRAND TOTALs equal the Applied tab (applied) and the Jobs tab (jobs added) for every day.

To try changes without packing or installing it:

```bash
python3 extension-dev/serve.py   # http://127.0.0.1:8600 — in VS Code: Ports → 8600 → Simple Browser
```

The harness runs the real `extension/` files beside a mini browser that has sample
job pages, and it can also load real job URLs. Edit a file, then click **↻ Reload panel**.
**Dry run** is on by default: API writes are answered by the harness and never saved.
Publish a new version with `python ops/build_extension.py --changelog "…"` after
bumping `version` in `extension/manifest.json`.

**Updates on bidders' PCs** ("Load unpacked" — Chrome never updates those): the one-time Windows setup
`/api/extension/install-windows.cmd` adds a scheduled task that fetches a new version into
`%LOCALAPPDATA%\TailorResume\extension` every minute; the extension restarts into it
(`extension/lib/self-update.js`). The panel shows "Version X is out" with **Update Now** (also in
⚙ Settings → Extension): it restarts the moment the new files land, without waiting for the 10-minute self-check.

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
