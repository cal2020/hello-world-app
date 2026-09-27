"""Local HTTP adapter for the web UI (stdlib only). Binds to 127.0.0.1 by default.

All pages and actions live in webapp.WebApp; this module only translates HTTP. The
in-browser build (web/worker.js) drives the same WebApp without HTTP.
"""
from __future__ import annotations

from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from .webapp import USERS, WebApp


class H(BaseHTTPRequestHandler):
    app: WebApp = None

    def log_message(self, *a):
        pass

    @property
    def actor(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        a = c["actor"].value if "actor" in c else "bob"
        return a if a in USERS else "bob"

    def _write(self, r):
        for v in (r.location, r.set_actor, *r.headers.values()):
            if v and any(c in str(v) for c in "\r\n"):
                r = type(r)(status=500, body="refused to send a header containing CR/LF", ctype="text/plain")
                break
        b = r.body.encode() if isinstance(r.body, str) else r.body
        self.send_response(r.status)
        if r.location:
            self.send_header("Location", r.location)
        if r.set_actor:
            self.send_header("Set-Cookie", f"actor={r.set_actor}; Path=/; SameSite=Strict")
        self.send_header("Content-Type", r.ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
        for k, v in r.headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._write(self.app.get(self.path, self.actor))

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode("utf-8")).items()}
        referer = urlparse(self.headers.get("Referer") or "/")
        ref = referer.path + (f"?{referer.query}" if referer.query else "")
        self._write(self.app.post(urlparse(self.path).path, form, self.actor, ref))


def serve(host="127.0.0.1", port=8765):
    H.app = WebApp()
    print(f"DMMC workbench on http://{host}:{port}  (simulated identities; local demo only)")
    HTTPServer((host, port), H).serve_forever()
