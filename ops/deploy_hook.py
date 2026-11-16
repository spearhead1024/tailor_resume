"""Deploy hook: GitHub Actions calls this after CI passes on `main`; it starts ops/deploy.sh.

Separate from the API on purpose (own pm2 app, standard library only): if a push breaks the API,
the next push can still deploy the fix. nginx routes https://<site>/deploy-hook here.

  POST /deploy-hook                 body {"sha": "<40 hex>", "ts": <unix seconds>}
                                    header X-Deploy-Signature: sha256=<HMAC-SHA256(body, secret)>
                                    → 202, and ops/deploy.sh <sha> runs detached
  GET  /deploy-hook/status/<sha>    → that deploy's state (no logs: the repo and its Actions logs
                                      are public; full logs stay in data/deploy/logs/)

The secret lives in /etc/tailorresume/deploy.secret (root, 0600) and in the GitHub repo secret
DEPLOY_SECRET. A request is only ever a "deploy origin/main at this commit" — the server pulls the
code from GitHub itself and never runs anything from the request. Requests older than 5 minutes
are refused (no replays).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(os.environ.get("DEPLOY_REPO", Path(__file__).resolve().parent.parent))
SCRIPT = Path(os.environ.get("DEPLOY_SCRIPT", REPO / "ops" / "deploy.sh"))
RUNS = REPO / "data" / "deploy" / "runs"
SECRET_FILE = Path(os.environ.get("DEPLOY_SECRET_FILE", "/etc/tailorresume/deploy.secret"))
PORT = int(os.environ.get("DEPLOY_HOOK_PORT", "8510"))
MAX_AGE = 300
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _secret() -> bytes:
    return SECRET_FILE.read_text().strip().encode()


def _start(sha: str) -> None:
    """Run deploy.sh fully detached (double fork via a backgrounded setsid): pm2 kills a restarted
    app's whole process tree, and a deploy may restart this very hook."""
    subprocess.run(
        ["bash", "-c", 'setsid nohup bash "$0" "$1" </dev/null >/dev/null 2>&1 &', str(SCRIPT), sha],
        check=True, timeout=10,
    )


class Hook(BaseHTTPRequestHandler):
    server_version = "deploy-hook"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/deploy-hook/health":
            return self._send(200, {"ok": True})
        m = re.fullmatch(r"/deploy-hook/status/([0-9a-f]{40})", self.path)
        if not m:
            return self._send(404, {"error": "not found"})
        run = RUNS / f"{m.group(1)}.json"
        if not run.exists():
            return self._send(404, {"state": "unknown"})
        try:
            data = json.loads(run.read_text())
        except Exception:
            return self._send(200, {"state": "running"})     # being rewritten right now
        return self._send(200, data)

    def do_POST(self) -> None:
        if self.path != "/deploy-hook":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 4096:
            return self._send(400, {"error": "bad body"})
        body = self.rfile.read(length)
        sig = self.headers.get("X-Deploy-Signature", "")
        want = "sha256=" + hmac.new(_secret(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, want):
            return self._send(401, {"error": "bad signature"})
        try:
            req = json.loads(body)
            sha, ts = str(req["sha"]), int(req["ts"])
        except Exception:
            return self._send(400, {"error": "bad body"})
        if not SHA_RE.match(sha):
            return self._send(400, {"error": "bad sha"})
        if abs(time.time() - ts) > MAX_AGE:
            return self._send(401, {"error": "request too old"})
        try:
            _start(sha)
        except Exception as exc:
            return self._send(500, {"error": f"could not start the deploy: {exc}"})
        return self._send(202, {"sha": sha, "state": "queued"})

    def log_message(self, fmt: str, *args) -> None:   # pm2 log: one line per request
        sys.stdout.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()


if __name__ == "__main__":
    _secret()     # fail at start, loudly, if the secret file is missing
    RUNS.mkdir(parents=True, exist_ok=True)
    print(f"deploy hook on 127.0.0.1:{PORT} → {SCRIPT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Hook).serve_forever()
