#!/usr/bin/env bash
# Put a pushed commit of `main` live on this server, then health-check it — and roll back to the
# previous commit if any step fails. Started by ops/deploy_hook.py when GitHub Actions (CI passed)
# calls the hook; you can also run it by hand:   ops/deploy.sh <full commit sha>
#
#   1. fetch origin/main; the commit must be on it. Already live → done.
#   2. fast-forward only: the server's tracked files must be unchanged and it must have no commits
#      GitHub doesn't have — the deploy never overwrites work done on the server.
#   3. only what changed is rebuilt/restarted:
#        backend/requirements.lock → pip install        frontend/ → build beside the live one, swap
#        backend/                 → restart the backend processes, then /api/health must answer
#        ecosystem.config.js      → pm2 startOrRestart (picks up new/changed apps)
#   4. any failure → reset to the previous commit, put the previous frontend back, restart again.
#
# State for the hook's /deploy-hook/status/<sha>: data/deploy/runs/<sha>.json. Full log of each run:
# data/deploy/logs/. Runs are serialised by a lock, so pushes deploy one after another, in order.
set -uo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"   # pm2/npm/git, also when started with a bare PATH
export HOME="${HOME:-/root}"

REPO="${DEPLOY_REPO:-/var/@TailorResume}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:8503/api/health}"
BACKEND_APPS="${DEPLOY_BACKEND_APPS:-tailorresume-v2 job-sync company-intel vps1-sync}"
HOOK_APP="${DEPLOY_HOOK_APP:-deploy-hook}"
SHA="${1:?usage: deploy.sh <commit sha>}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "not a full commit sha: $SHA" >&2; exit 2; }

DIR="$REPO/data/deploy"
mkdir -p "$DIR/runs" "$DIR/logs"
LOG="$DIR/logs/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}.log"
RUN="$DIR/runs/$SHA.json"
STARTED=$(date -u +%FT%TZ)
STEP=queued

state() {   # state <queued|running|success|failed|rolled_back> <message>
  python3 - "$RUN" "$SHA" "$1" "$STEP" "$2" "$STARTED" "$(basename "$LOG")" <<'EOF'
import json, sys, os, datetime
path, sha, state, step, message, started, log = sys.argv[1:]
done = state in ('success', 'failed', 'rolled_back')
data = {'sha': sha, 'state': state, 'step': step, 'message': message, 'started_at': started,
        'finished_at': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ') if done else None,
        'log': log}
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(data, f)
os.replace(tmp, path)
EOF
}
step() { STEP="$1"; echo "=== $(date -u +%T) $1"; state running "$1"; }

exec >>"$LOG" 2>&1
echo "deploy $SHA — requested $STARTED"
state queued "waiting for an earlier deploy"
exec 9>"$DIR/deploy.lock"
flock 9
cd "$REPO" || { state failed "no repo at $REPO"; exit 1; }

finish() { state "$1" "$2"; echo "=== $1: $2"; ls -1t "$DIR"/logs/*.log 2>/dev/null | tail -n +51 | xargs -r rm -f; }
fail() { finish failed "$1"; exit 1; }

# ---- 1. is it on main, is it already live ----------------------------------------------------
step fetch
git fetch --quiet origin main || fail "git fetch failed"
git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null || fail "commit is not on origin/main"
if git merge-base --is-ancestor "$SHA" HEAD; then
  finish success "already live (server is at $(git rev-parse --short HEAD))"; exit 0
fi

# ---- 2. fast-forward only ----------------------------------------------------------------------
step pull
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "server checkout is not on main"
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "server has uncommitted changes to tracked files: $(git diff --name-only HEAD | head -5 | tr '\n' ' ')"
fi
PREV=$(git rev-parse HEAD)
git merge --ff-only --quiet "$SHA" || fail "server main has commits GitHub doesn't — push them from the server first"
CHANGED=$(git diff --name-only "$PREV" "$SHA")
echo "changed files:"; sed 's/^/  /' <<<"$CHANGED"
has() { grep -qE "$1" <<<"$CHANGED"; }

SWAPPED=0
health() {   # the API answers, and every backend process is still online after a few seconds
  local ok=0
  for _ in $(seq 1 30); do curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done
  [ $ok = 1 ] || { echo "health check: $HEALTH_URL did not answer"; return 1; }
  sleep 8
  pm2 jlist | python3 -c "
import json, sys
want = set(sys.argv[1].split())
bad = [p['name'] for p in json.load(sys.stdin) if p['name'] in want and p['pm2_env']['status'] != 'online']
print('not online:', bad) if bad else None
sys.exit(1 if bad else 0)" "$BACKEND_APPS"
}

apply() {    # build/restart what CHANGED touches, for the commit now checked out
  if has '^backend/requirements\.lock$'; then
    step "install backend packages"
    backend/.venv/bin/pip install -q -r backend/requirements.lock || return 1
  fi
  if has '^backend/'; then
    step "check backend"
    backend/.venv/bin/python -m compileall -q backend/main.py backend/auth.py backend/schemas.py backend/core backend/routers >/dev/null || return 1
  fi
  if has '^frontend/'; then
    step "build frontend"
    if has '^frontend/package(-lock)?\.json$' || [ ! -d frontend/node_modules ]; then
      (cd frontend && npm ci --no-audit --no-fund --loglevel=error) || return 1
    fi
    # Built beside the live one, then swapped: the site is never served half-built.
    (cd frontend && rm -rf dist.new && npx tsc -b && npx vite build --outDir dist.new --emptyOutDir) || return 1
    rm -rf frontend/dist.old
    mv frontend/dist frontend/dist.old && mv frontend/dist.new frontend/dist && SWAPPED=1
  fi
  if has '^ecosystem\.config\.js$'; then
    step "restart (pm2 config changed)"
    pm2 startOrRestart ecosystem.config.js --update-env >/dev/null && pm2 save >/dev/null || return 1
    step "health check"; health || return 1
  elif has '^backend/'; then
    step "restart backend"
    pm2 restart $BACKEND_APPS --update-env >/dev/null || return 1
    step "health check"; health || return 1
  fi
  return 0
}

if apply; then
  rm -rf frontend/dist.old
  finish success "live — $(git log -1 --format='%h %s' | cut -c1-120)"
  # Last, and only now: restarting the hook can't cut this run short (it runs detached).
  if has '^ops/deploy_hook\.py$'; then pm2 restart "$HOOK_APP" >/dev/null 2>&1 || true; fi
  exit 0
fi

# ---- 4. roll back -------------------------------------------------------------------------------
FAILED_STEP="$STEP"
echo "=== step '$FAILED_STEP' failed — rolling back to $PREV"
STEP="rollback"; state running "step '$FAILED_STEP' failed — rolling back"
git reset --hard --quiet "$PREV"
if [ "$SWAPPED" = 1 ] && [ -d frontend/dist.old ]; then
  rm -rf frontend/dist && mv frontend/dist.old frontend/dist
fi
rm -rf frontend/dist.new
if has '^backend/requirements\.lock$'; then backend/.venv/bin/pip install -q -r backend/requirements.lock || true; fi
if has '^ecosystem\.config\.js$'; then pm2 startOrRestart ecosystem.config.js --update-env >/dev/null; pm2 save >/dev/null
elif has '^backend/'; then pm2 restart $BACKEND_APPS --update-env >/dev/null; fi
if has '^backend/|^ecosystem\.config\.js$'; then health || { STEP="$FAILED_STEP"; fail "step '$FAILED_STEP' failed AND the rollback is unhealthy — check the server (log: $(basename "$LOG"))"; }; fi
STEP="$FAILED_STEP"
finish rolled_back "step '$FAILED_STEP' failed — rolled back to $(git rev-parse --short HEAD); the site runs the previous version"
exit 1
