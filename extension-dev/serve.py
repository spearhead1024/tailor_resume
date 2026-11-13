#!/usr/bin/env python3
"""Dev harness for the TailorResume browser extension — run the side panel in a normal
web page (e.g. VS Code's Simple Browser) instead of packing/installing the extension.

    python3 extension-dev/serve.py            # http://127.0.0.1:8600
    PORT=8700 API=http://127.0.0.1:8503 python3 extension-dev/serve.py

Routes (all same-origin, so the harness can script the "tab" like chrome.scripting does):
  /                 the harness (harness/index.html): a mini browser + the side panel
  /ext/...          the REAL extension files, live from extension/ — edit, then "Reload panel".
                    panel.html gets harness/chrome-shim.js injected before its own scripts.
  /harness/...      harness files;  /pages/...  sample job postings / an application form;  /download/...  test builds (dist/)
  /api/...          proxied to the TailorResume API (default the local backend :8503)
  /proxy?url=...    a real web page fetched server-side and served same-origin (scripts
                    stripped, <base> added) so Fetch from page / Autofill can read it.

Listens on 127.0.0.1 only. Uses only the standard library.
"""
from __future__ import annotations

import http.server
import ipaddress
import os
import re
import socket
import socketserver
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXT = HERE.parent / "extension"
PORT = int(os.environ.get("PORT", "8600"))
API = os.environ.get("API", "http://127.0.0.1:8503").rstrip("/")
MAX_PAGE = 6 * 1024 * 1024
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".zip": "application/zip", ".pdf": "application/pdf"}
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization",
       "proxy-authenticate", "host", "content-length", "accept-encoding"}


def _public_host(host: str) -> bool:
    """Only fetch pages on the public internet — never this machine or its network."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


_SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
_CSP_META_RE = re.compile(r"<meta[^>]+http-equiv=[\"']?content-security-policy[^>]*>", re.I)
_BASE_RE = re.compile(r"<base\b[^>]*>", re.I)
_HEAD_RE = re.compile(r"<head\b[^>]*>", re.I)


def _neutralise(html: str, final_url: str) -> str:
    # Keep JSON-LD (data, never executed — the extractor reads it); drop every other script
    # so a third-party page can't run in this origin.
    def keep_ld(m: re.Match) -> str:
        return m.group(0) if re.search(r"type\s*=\s*[\"']?application/ld\+json", m.group(1), re.I) else ""
    html = _SCRIPT_RE.sub(keep_ld, html)
    html = re.sub(r"\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*')", "", html, flags=re.I)   # inline handlers
    html = _CSP_META_RE.sub("", html)
    html = _BASE_RE.sub("", html)
    base = f'<base href="{final_url}">'
    m = _HEAD_RE.search(html)
    return html[:m.end()] + base + html[m.end():] if m else base + html


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ext-dev"
    protocol_version = "HTTP/1.1"

    # One line per request — with its status, so a file that fails to reach the browser
    # shows up here; the browser's User-Agent on page loads (which browser is testing).
    def log_request(self, code="-", size="-"):
        ua = f'  UA="{self.headers.get("User-Agent", "")}"' if re.match(r"^/(\?|$)|^/index\.html", self.path) else ""
        sys.stderr.write(f"{time.strftime('%H:%M:%S')} {code} {self.command} {self.path[:160]}{ua}\n")

    def log_message(self, fmt, *args):  # errors (log_error) and anything else
        sys.stderr.write(f"{time.strftime('%H:%M:%S')} ! {fmt % args}\n")

    # ---- helpers
    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")   # edits show up on reload, always
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _file(self, root: Path, rel: str):
        path = (root / rel).resolve()
        if root.resolve() not in path.parents and path != root.resolve() or not path.is_file():
            return self._send(404, b"not found", "text/plain")
        body = path.read_bytes()
        if path.name == "panel.html" and root == EXT:
            # The shim must define `chrome` before the panel's own scripts run.
            body = body.replace(b"<head>", b'<head>\n  <script src="/harness/chrome-shim.js"></script>', 1)
        self._send(200, body, MIME.get(path.suffix, "application/octet-stream"))

    # ---- routes
    def do_GET(self):
        self._route()

    def do_HEAD(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._route()

    def do_PATCH(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def _route(self):
        u = urllib.parse.urlsplit(self.path)
        p = urllib.parse.unquote(u.path)
        if p.startswith("/api/"):
            return self._api()
        if self.command not in ("GET", "HEAD"):
            return self._send(405, b"method not allowed", "text/plain")
        if p in ("/", "/index.html"):
            return self._file(HERE / "harness", "index.html")
        if p.startswith("/ext/"):
            return self._file(EXT, p[len("/ext/"):])
        if p.startswith("/harness/"):
            return self._file(HERE / "harness", p[len("/harness/"):])
        if p.startswith("/pages/"):
            return self._file(HERE / "pages", p[len("/pages/"):])
        if p.startswith("/download/"):   # a test build of the extension (extension-dev/dist)
            return self._file(HERE / "dist", p[len("/download/"):])
        if p == "/proxy":
            return self._proxy(urllib.parse.parse_qs(u.query).get("url", [""])[0])
        return self._send(404, b"not found", "text/plain")

    def _api(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        req = urllib.request.Request(API + self.path, data=body, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status, data, rh = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            status, data, rh = e.code, e.read(), e.headers
        except Exception as e:  # backend down
            msg = f'{{"detail": "Dev harness: the API at {API} is not reachable ({type(e).__name__})."}}'
            return self._send(502, msg.encode(), "application/json")
        extra = {k: v for k, v in rh.items() if k.lower() in ("content-disposition",)}
        self._send(status, data, rh.get("Content-Type", "application/octet-stream"), extra)

    def _proxy(self, url: str):
        def page(msg: str, status: int = 400):
            html = f"<!doctype html><meta charset=utf-8><body style='font:14px system-ui;padding:24px;color:#333'><h3>Can't load this page in the harness</h3><p>{msg}</p></body>"
            return self._send(status, html.encode(), "text/html; charset=utf-8")
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return page("Only http(s) URLs can be opened.")
        if not _public_host(parts.hostname):
            return page("That address is not a public web site.")
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                final = r.geturl()
                if not _public_host(urllib.parse.urlsplit(final).hostname or ""):
                    return page("The page redirected to an address that is not a public web site.")
                ctype = r.headers.get("Content-Type", "")
                raw = r.read(MAX_PAGE + 1)
        except urllib.error.HTTPError as e:
            return page(f"The site answered HTTP {e.code}. Some boards (LinkedIn, Indeed…) block server-side fetches — use a sample page or test in the real extension.", 502)
        except Exception as e:
            return page(f"Could not fetch it ({type(e).__name__}: {e}).", 502)
        if "html" not in ctype.lower():
            return page(f"Not an HTML page ({ctype or 'unknown type'}).")
        if len(raw) > MAX_PAGE:
            return page("The page is too large.")
        m = re.search(r"charset=([\w-]+)", ctype, re.I)
        html = raw.decode(m.group(1) if m else "utf-8", errors="replace")
        body = _neutralise(html, final).encode("utf-8")
        # The harness reads the final URL (after redirects) from this header.
        # CSP: no page script can run (no source is allowed — not inline, not external), but
        # the harness may still eval the extension's own code into the page ('unsafe-eval'),
        # which is what chrome.scripting does in the real browser.
        self._send(200, body, "text/html; charset=utf-8", {"X-Final-Url": final,
                   "Content-Security-Policy": "script-src 'unsafe-eval'; object-src 'none'; base-uri *"})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    srv = Server(("127.0.0.1", PORT), Handler)
    print(f"Extension dev harness: http://127.0.0.1:{PORT}/   (API → {API})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
