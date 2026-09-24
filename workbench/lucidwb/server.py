"""HTTP service: read-only model/contract API under /api, management API under /manage.

Standard library only (http.server). Local demonstration server, not a production web stack.
"""
import hashlib
import hmac
import http.client
import json
import mimetypes
import os
import pathlib
import re
import sys
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import authz, importer, links, projection, receipts, release
from .db import Database, audit
from .outbox import OutboxWorker
from .util import ApiError

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "fixtures"  # synthetic, safe to serve for the demo UI
ROUTES = []
COOKIE = "lwb_access"
LOGIN_PAGE = b"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport"
content="width=device-width,initial-scale=1"><title>Workbench access</title><style>
body{font:16px system-ui,sans-serif;background:#f4f6f8;color:#1b1f24;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:28px;border-radius:10px;box-shadow:0 2px 12px #0002;max-width:360px}
input,button{font:inherit;padding:8px 10px;width:100%;box-sizing:border-box;margin-top:10px}
button{background:#1f5fbf;color:#fff;border:0;border-radius:6px;cursor:pointer}
p{color:#555;font-size:14px}</style></head><body><form method="post" action="/login">
<strong>Integration Workbench (synthetic demo)</strong><p>Enter the access code you were given.</p>
<input type="password" name="code" autofocus autocomplete="current-password" aria-label="Access code">
<button type="submit">Enter</button>__MSG__</form></body></html>"""


def access_code():
    """Deployment gate. Unset = local mode (no gate). Read per request so tests can toggle it."""
    return os.environ.get("LWB_ACCESS_CODE") or None


def _cookie_value(code):
    return hmac.new(code.encode(), b"lwb-access-v1", hashlib.sha256).hexdigest()


def route(method, pattern):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
        return fn
    return deco


class App:
    def __init__(self, db_path, start_worker=True):
        self.db = Database(db_path)
        with self.db.tx() as c:
            authz.seed(c)
        self.worker = OutboxWorker(self.db)
        if start_worker:
            self.worker.start()


class Handler(BaseHTTPRequestHandler):
    app: App = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("LWB_QUIET") != "1":
            sys.stderr.write("[workbench] " + fmt % args + "\n")

    # -------------------------------------------------------------- plumbing
    def _send(self, status, body, headers=None, raw=None, ctype="application/json"):
        data = raw if raw is not None else json.dumps(body, indent=1, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _body_bytes(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 5_000_000:
            raise ApiError(413, "invalid_input", "Body too large.")
        return self.rfile.read(n) if n else b""

    def _json(self):
        raw = self._body_bytes()
        if not raw:
            return {}
        try:
            v = json.loads(raw)
        except ValueError:
            raise ApiError(400, "invalid_input", "Body must be JSON.")
        if not isinstance(v, dict):
            raise ApiError(400, "invalid_input", "Body must be a JSON object.")
        return v

    def _dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        self.query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        path = parsed.path
        if path == "/healthz":
            return self._send(200, {"ok": True})
        if path == "/login":
            return self._login(method)
        if not self._gate_ok():
            if method == "GET" and (path == "/" or path.startswith("/consumer")):
                return self._redirect("/login")
            return self._send(401, {"error": {"code": "access_required", "message": "Access code required."}})
        if method == "GET" and path.startswith("/consumer"):
            return self._consumer_proxy(path)
        if method == "GET" and (path == "/" or path.startswith("/web/")):
            return self._static(path)
        for m, rx, fn in ROUTES:
            if m == method:
                mt = rx.match(path)
                if mt:
                    try:
                        c = self.app.db.read()
                        self.user = authz.authenticate(c, self.headers.get("Authorization"))
                        result = fn(self, *mt.groups())
                        if result is None:  # handler already wrote the response
                            return
                        status, body, headers = (result + (None,))[:3] if isinstance(result, tuple) else (200, result, None)
                        self._send(status, body, headers)
                    except ApiError as e:
                        if path.startswith("/manage/") and getattr(self, "user", None):
                            try:
                                with self.app.db.tx() as w:
                                    audit(w, self.user, None, f"{method} {path}", f"refused:{e.code}",
                                          self.headers.get("Idempotency-Key"), {"status": e.status})
                            except Exception:
                                pass
                        self._send(e.status, e.body())
                    except Exception:
                        traceback.print_exc()
                        self._send(500, {"error": {"code": "internal_error", "message": "Unexpected server error."}})
                    finally:
                        self.user = None
                    return
        self._send(404, {"error": {"code": "not_found", "message": "Resource not found."}})

    def _gate_ok(self):
        code = access_code()
        if not code:
            return True
        hdr = self.headers.get("X-Access-Code") or ""
        if hdr and hmac.compare_digest(hdr, code):
            return True
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE and hmac.compare_digest(v, _cookie_value(code)):
                return True
        return False

    def _redirect(self, where, cookie=None):
        self.send_response(303)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def _login(self, method):
        code = access_code()
        if not code:
            return self._redirect("/")
        if method == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            form = urllib.parse.parse_qs(self.rfile.read(min(n, 4096)).decode(errors="replace"))
            given = (form.get("code") or [""])[0]
            if hmac.compare_digest(given, code):
                secure = "; Secure" if os.environ.get("LWB_COOKIE_SECURE", "1") == "1" else ""
                return self._redirect("/", f"{COOKIE}={_cookie_value(code)}; HttpOnly; SameSite=Strict; Path=/; "
                                           f"Max-Age=43200{secure}")
            import time as _t
            _t.sleep(1.0)  # slow down guessing
            return self._send(401, None, raw=LOGIN_PAGE.replace(b"__MSG__", b"<p style='color:#b00020'>Wrong code.</p>"),
                              ctype="text/html; charset=utf-8")
        return self._send(200, None, raw=LOGIN_PAGE.replace(b"__MSG__", b""), ctype="text/html; charset=utf-8")

    def _consumer_proxy(self, path):
        """Expose the consumer's read-only dashboard through the single public port."""
        from . import release as _rel
        sub = path[len("/consumer"):] or "/"
        if sub not in ("/", "/state"):
            return self._send(404, {"error": {"code": "not_found", "message": "Resource not found."}})
        u = urllib.parse.urlparse(_rel.CONSUMER_URL)
        try:
            conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
            conn.request("GET", sub)
            r = conn.getresponse()
            data = r.read()
            conn.close()
        except OSError:
            return self._send(502, {"error": {"code": "consumer_unreachable", "message": "Consumer app unreachable."}})
        if sub == "/" and path == "/consumer":
            return self._redirect("/consumer/")
        self._send(r.status, None, raw=data, ctype=r.getheader("Content-Type") or "application/octet-stream")

    def _static(self, path):
        root, rel = WEB, ("index.html" if path == "/" else path[len("/web/"):])
        if rel.startswith("fixtures/"):
            root, rel = FIXTURES, rel[len("fixtures/"):]
        f = (root / rel).resolve()
        if not str(f).startswith(str(root.resolve()) + os.sep) or not f.is_file():
            return self._send(404, {"error": {"code": "not_found", "message": "Resource not found."}})
        self._send(200, None, raw=f.read_bytes(), ctype=mimetypes.guess_type(str(f))[0] or "application/octet-stream")

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    # helpers
    @property
    def c(self):
        return self.app.db.read()

    def need(self, project, perm):
        authz.require(self.c, self.user, project, perm)

    def mutate(self, project, operation, body, fn, if_match=None):
        key = self.headers.get("Idempotency-Key")
        fp = receipts.fingerprint(operation, urllib.parse.urlparse(self.path).path, body, if_match)
        status, out, replayed = receipts.execute(self.app.db, self.user, project, key, operation, fp, fn)
        hdrs = {"Idempotent-Replay": "true"} if replayed else {}
        if key:
            hdrs["Idempotency-Key"] = key
        return status, out, hdrs


# ------------------------------------------------------------------ read API
@route("GET", r"/api/whoami")
def whoami(h):
    u = h.c.execute("SELECT user_id, display, kind FROM users WHERE user_id=?", (h.user,)).fetchone()
    return dict(u) | {"grants": authz.grants_for(h.c, h.user), "note": "Simulated local identity; not production auth."}


@route("GET", r"/api/projects")
def projects(h):
    return {"projects": authz.readable_projects(h.c, h.user)}


@route("GET", r"/api/projects/([a-z0-9-]+)/sources")
def sources(h, p):
    h.need(p, "read")
    heads = [dict(r) for r in h.c.execute("SELECT * FROM source_head WHERE project=? ORDER BY source", (p,))]
    hist = [dict(r) for r in h.c.execute("SELECT * FROM head_history WHERE project=? ORDER BY source, head_seq", (p,))]
    return {"heads": heads, "head_history": hist}


@route("GET", r"/api/projects/([a-z0-9-]+)/imports")
def imports(h, p):
    h.need(p, "read")
    rows = h.c.execute("SELECT import_id, source, revision, parent_revision, kind, format, outcome, snapshot_id, "
                       "raw_digest, duplicate_of, reconciled_by, actor, received_at, diagnostics_json FROM source_import "
                       "WHERE project=? ORDER BY received_at", (p,))
    return {"imports": [dict(r, diagnostics=json.loads(r["diagnostics_json"])) for r in rows]}


@route("GET", r"/api/projects/([a-z0-9-]+)/imports/([a-z0-9_]+)")
def import_one(h, p, iid):
    h.need(p, "read")
    r = h.c.execute("SELECT * FROM source_import WHERE import_id=? AND project=?", (iid, p)).fetchone()
    if not r:
        raise ApiError(404, "not_found", "Resource not found.")
    if h.query.get("raw") == "1":
        h._send(200, None, raw=r["raw_bytes"])  # retained bytes, verbatim
        return None
    return importer._receipt(h.c, iid)


@route("GET", r"/api/projects/([a-z0-9-]+)/snapshots")
def snapshots(h, p):
    h.need(p, "read")
    rows = [dict(r) for r in h.c.execute(
        "SELECT snapshot_id, source, revision, parent_revision, kind, completeness, status, raw_digest, "
        "normalized_digest, adapter_version, import_id, created_at, warnings_json FROM source_snapshot WHERE project=? "
        "ORDER BY created_at", (p,))]
    for r in rows:
        r["warnings"] = json.loads(r.pop("warnings_json"))
        r["counts"] = importer.snapshot_counts(h.c, r["snapshot_id"])
    return {"snapshots": rows}


def _snap(h, p, sid):
    h.need(p, "read")  # historical snapshots still require CURRENT read permission
    s = h.c.execute("SELECT * FROM source_snapshot WHERE snapshot_id=? AND project=?", (sid, p)).fetchone()
    if not s:
        raise ApiError(404, "not_found", "Resource not found.")
    return s


@route("GET", r"/api/projects/([a-z0-9-]+)/snapshots/([a-z0-9_]+)/elements")
def snapshot_elements(h, p, sid):
    s = _snap(h, p, sid)
    rows = h.c.execute("SELECT se.entity_uid, se.state, se.observed, ei.native_id, ev.* FROM snapshot_element se "
                       "JOIN element_identity ei ON ei.entity_uid=se.entity_uid JOIN element_version ev "
                       "ON ev.version_id=se.version_id WHERE se.snapshot_id=? ORDER BY ev.type, ei.native_id", (sid,))
    out = []
    for r in rows:
        out.append({"entity_uid": r["entity_uid"], "source_id": r["native_id"], "version_id": r["version_id"],
                    "type": r["type"], "name": r["name"], "owner": r["owner"], "state": r["state"],
                    "properties": json.loads(r["properties_json"]),
                    "unrecognized_keys": sorted(json.loads(r["unrecognized_json"])),
                    "provenance": {"snapshot_id": sid, "revision": s["revision"], "source_pointer": r["source_pointer"],
                                   "content_digest": r["content_digest"]}})
    return {"snapshot_id": sid, "revision": s["revision"], "completeness": s["completeness"], "status": s["status"],
            "definitions": json.loads(s["definitions_json"]), "elements": out}


@route("GET", r"/api/projects/([a-z0-9-]+)/snapshots/([a-z0-9_]+)/relationships")
def snapshot_rels(h, p, sid):
    _snap(h, p, sid)
    rows = h.c.execute("SELECT sr.*, rv.native_id, rv.predicate, rv.source_uid, rv.target_uid, rv.authority, "
                       "a.native_id AS s_native, b.native_id AS t_native FROM snapshot_relationship sr "
                       "JOIN relationship_version rv ON rv.version_id=sr.version_id "
                       "LEFT JOIN element_identity a ON a.entity_uid=rv.source_uid "
                       "LEFT JOIN element_identity b ON b.entity_uid=rv.target_uid WHERE sr.snapshot_id=? "
                       "ORDER BY rv.native_id", (sid,))
    return {"relationships": [dict(r) for r in rows]}


@route("GET", r"/api/projects/([a-z0-9-]+)/diff")
def diff(h, p):
    a, b = h.query.get("from"), h.query.get("to")
    _snap(h, p, a), _snap(h, p, b)
    return importer.diff_snapshots(h.c, a, b)


@route("GET", r"/api/projects/([a-z0-9-]+)/entities/([a-z0-9_]+)/history")
def entity_history(h, p, uid):
    h.need(p, "read")
    ident = h.c.execute("SELECT * FROM element_identity WHERE entity_uid=? AND project=?", (uid, p)).fetchone()
    if not ident:
        raise ApiError(404, "not_found", "Resource not found.")
    rows = h.c.execute("SELECT s.revision, s.snapshot_id, s.status, s.completeness, s.created_at, se.state, ev.version_id, "
                       "ev.name FROM snapshot_element se JOIN source_snapshot s ON s.snapshot_id=se.snapshot_id "
                       "JOIN element_version ev ON ev.version_id=se.version_id WHERE se.entity_uid=? ORDER BY s.created_at",
                       (uid,))
    return {"identity": dict(ident), "history": [dict(r) for r in rows]}


@route("GET", r"/api/projects/([a-z0-9-]+)/records")
def records(h, p):
    h.need(p, "read")
    src = h.query.get("source", "cmms")
    head = h.c.execute("SELECT * FROM source_head WHERE project=? AND source=?", (p, src)).fetchone()
    if not head:
        return {"records": [], "source": src}
    rows = h.c.execute("SELECT * FROM external_record WHERE snapshot_id=? ORDER BY record_id", (head["snapshot_id"],))
    return {"source": src, "revision": head["revision"], "records": [dict(r) for r in rows]}


@route("GET", r"/api/projects/([a-z0-9-]+)/proposals")
def proposals(h, p):
    h.need(p, "read")
    ids = [r["proposal_id"] for r in h.c.execute("SELECT proposal_id FROM link_proposal WHERE project=? "
                                                  "ORDER BY record_id, created_at", (p,))]
    runs = [dict(r) for r in h.c.execute("SELECT run_id, method, mode, provider, model, status, error, prompt_version, "
                                         "vocabulary_version, context_digest, stats_json, started_at FROM proposal_run "
                                         "WHERE project=? ORDER BY started_at", (p,))]
    return {"proposals": [links.proposal_view(h.c, i) for i in ids], "runs": runs}


@route("GET", r"/api/proposals/([a-z0-9_]+)")
def proposal_one(h, pid):
    v = links.proposal_view(h.c, pid)
    h.need(v["project"], "read")
    return 200, v, {"ETag": v["etag"]}


@route("GET", r"/api/projects/([a-z0-9-]+)/links")
def links_list(h, p):
    h.need(p, "read")
    return {"links": [links.link_view(h.c, r) for r in h.c.execute(
        "SELECT * FROM integration_link WHERE project=? ORDER BY created_at", (p,))]}


@route("GET", r"/api/projects/([a-z0-9-]+)/projections")
def projections(h, p):
    h.need(p, "read")
    return {"projections": [dict(r, body=json.loads(r["body_json"])) for r in h.c.execute(
        "SELECT * FROM projection_definition WHERE project=? ORDER BY projection_id, created_at", (p,))]}


@route("GET", r"/api/projects/([a-z0-9-]+)/releases")
def releases(h, p):
    h.need(p, "read")
    act = release.active_release(h.c, p)
    rows = [dict(r) for r in h.c.execute("SELECT release_id, projection_id, projection_version, contract_digest, "
                                         "snapshot_id, status, created_at, created_by FROM release WHERE project=? "
                                         "ORDER BY created_at", (p,))]
    for r in rows:
        r["revision"] = h.c.execute("SELECT revision FROM source_snapshot WHERE snapshot_id=?",
                                    (r["snapshot_id"],)).fetchone()["revision"]
    hist = [dict(r) for r in h.c.execute("SELECT * FROM release_activation WHERE project=? ORDER BY pointer_seq", (p,))]
    sel = projection.source_selection(h.c, act) if act else None
    return {"active_release_id": act["release_id"] if act else None, "active_source": sel, "releases": rows,
            "activation_history": hist}


def _release(h, rid):
    r = release.load_release(h.c, rid)
    h.need(r["project"], "read")
    return r


@route("GET", r"/api/releases/([a-z0-9_]+)")
def release_one(h, rid):
    _release(h, rid)
    return release.release_view(h.c, rid)


@route("GET", r"/api/releases/([a-z0-9_]+)/openapi\.json")
def release_openapi(h, rid):
    r = _release(h, rid)
    return json.loads(h.c.execute("SELECT openapi_json FROM contract_artifact WHERE contract_digest=?",
                                  (r["contract_digest"],)).fetchone()[0])


@route("GET", r"/api/releases/([a-z0-9_]+)/resources/([a-z0-9-]+)")
def rel_list(h, rid, rname):
    r = _release(h, rid)
    return projection.list_page(h.c, r, rname, h.query.get("cursor"), h.query.get("limit", 50))


@route("GET", r"/api/releases/([a-z0-9_]+)/resources/([a-z0-9-]+)/([a-z0-9_]+)")
def rel_item(h, rid, rname, eid):
    r = _release(h, rid)
    return projection.get_item(h.c, r, rname, eid)


def _current(h, p):
    h.need(p, "read")
    act = release.active_release(h.c, p)  # resolved once per request; the response names it
    if not act:
        raise ApiError(404, "not_found", "No active release.")
    return act


@route("GET", r"/api/current/([a-z0-9-]+)/resources/([a-z0-9-]+)")
def cur_list(h, p, rname):
    act = _current(h, p)
    return 200, projection.list_page(h.c, act, rname, h.query.get("cursor"), h.query.get("limit", 50)), {
        "Content-Location": f"/api/releases/{act['release_id']}/resources/{rname}"}


@route("GET", r"/api/current/([a-z0-9-]+)/resources/([a-z0-9-]+)/([a-z0-9_]+)")
def cur_item(h, p, rname, eid):
    act = _current(h, p)
    return projection.get_item(h.c, act, rname, eid)


@route("GET", r"/api/projects/([a-z0-9-]+)/stream-state")
def stream_state(h, p):
    h.need(p, "read")
    s = h.c.execute("SELECT seq FROM stream_seq WHERE project=?", (p,)).fetchone()
    act = release.active_release(h.c, p)
    return {"project": p, "latest_seq": s["seq"] if s else 0, "active_release_id": act["release_id"] if act else None,
            "active_links": [links.link_view(h.c, r)["link_id"] for r in h.c.execute(
                "SELECT * FROM integration_link WHERE project=? AND status='active'", (p,))]}


@route("GET", r"/api/projects/([a-z0-9-]+)/history")
def history(h, p):
    h.need(p, "read")
    audit_rows = [dict(r, detail=json.loads(r["detail_json"])) for r in h.c.execute(
        "SELECT * FROM audit_event WHERE project=? OR (project IS NULL AND actor=?) ORDER BY audit_id DESC LIMIT 200",
        (p, h.user))]
    rec = [dict(r, response=json.loads(r["response_json"])) for r in h.c.execute(
        "SELECT caller, operation_id, operation, fingerprint, state, status_code, response_json, created_at, expires_at "
        "FROM operation_receipt WHERE project=? ORDER BY created_at DESC", (p,))]
    for r in rec:
        r.pop("response_json")
    events = [dict(r, payload=json.loads(r["payload_json"])) for r in h.c.execute(
        "SELECT * FROM outbox_event WHERE project=? ORDER BY seq DESC", (p,))]
    for e in events:
        e.pop("payload_json")
        e["attempts_log"] = [dict(a) for a in h.c.execute(
            "SELECT attempt, at, outcome, detail FROM delivery_attempt WHERE event_id=? ORDER BY attempt", (e["event_id"],))]
    return {"audit": audit_rows, "receipts": rec, "outbox": events,
            "outbox_worker": "paused" if h.app.worker.paused.is_set() else "running"}


# ------------------------------------------------------------------ management API
@route("POST", r"/manage/projects/([a-z0-9-]+)/imports")
def do_import(h, p):
    raw = h._body_bytes()
    doc = importer.peek_project(raw)
    if doc["project"] != p:
        raise ApiError(400, "invalid_input", "Export project does not match the URL.")
    h.need(p, "import")
    return h.mutate(p, "source.import", {"raw_sha256": importer.sha256(raw)},
                    lambda c: importer.import_export(c, h.user, raw, doc))


@route("POST", r"/manage/imports/([a-z0-9_]+)/reconcile")
def do_reconcile(h, iid):
    body = h._json()
    imp = h.c.execute("SELECT project FROM source_import WHERE import_id=?", (iid,)).fetchone()
    if not imp:
        raise ApiError(404, "not_found", "Resource not found.")
    h.need(imp["project"], "import")
    return h.mutate(imp["project"], "source.reconcile", body,
                    lambda c: importer.reconcile(c, h.user, iid, body.get("action"), body.get("expected_head")))


@route("POST", r"/manage/projections")
def do_projection(h):
    body = h._json()
    h.need(str(body.get("project")), "release:manage")
    with h.app.db.tx() as c:
        return release.register_projection(c, h.user, body)


@route("POST", r"/manage/projections/([a-z0-9-]+)/([0-9.]+)/review")
def do_projection_review(h, pid, ver):
    body = h._json()
    row = h.c.execute("SELECT project FROM projection_definition WHERE projection_id=? AND version=?", (pid, ver)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "Resource not found.")
    h.need(row["project"], "projection:review")
    with h.app.db.tx() as c:
        return release.review_projection(c, h.user, pid, ver, body.get("decision"), body.get("reason"))


@route("POST", r"/manage/projects/([a-z0-9-]+)/releases")
def do_build(h, p):
    body = h._json()
    h.need(p, "release:manage")
    with h.app.db.tx() as c:
        return 201, release.build_candidate(c, h.user, p, body.get("projection_id"), body.get("version"),
                                            body.get("snapshot_id"))


@route("POST", r"/manage/releases/([a-z0-9_]+)/consumer-checks")
def do_checks(h, rid):
    r = release.load_release(h.c, rid)
    h.need(r["project"], "release:manage")
    return release.run_consumer_checks(h.app.db, h.user, rid)


@route("POST", r"/manage/releases/([a-z0-9_]+)/activate")
def do_activate(h, rid):
    body = h._json()
    r = release.load_release(h.c, rid)
    h.need(r["project"], "release:manage")

    def fn(c):
        st, out = release.activate(c, h.user, r["project"], rid, body.get("expected_active_release_id"),
                                   body.get("reason"))
        return st, out, {"release_id": rid}
    return h.mutate(r["project"], "release.activate", body, fn)


@route("POST", r"/manage/projects/([a-z0-9-]+)/rollback")
def do_rollback(h, p):
    body = h._json()
    h.need(p, "release:manage")

    def fn(c):
        st, out = release.rollback(c, h.user, p, body.get("expected_active_release_id"), body.get("reason"))
        return st, out, {}
    return h.mutate(p, "release.rollback", body, fn)


@route("POST", r"/manage/projects/([a-z0-9-]+)/proposal-runs")
def do_run(h, p):
    body = h._json()
    h.need(p, "link:review")
    return 201, links.run_proposals(h.app.db, h.user, p, body.get("method"), body.get("mode"),
                                    body.get("record_source", "cmms"))


@route("POST", r"/manage/proposals/([a-z0-9_]+)/decision")
def do_decide(h, pid):
    body = h._json()
    row = h.c.execute("SELECT project FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "Resource not found.")
    if_match = h.headers.get("If-Match")
    key = h.headers.get("Idempotency-Key")
    return h.mutate(row["project"], "proposal.decision", body,
                    lambda c: links.decide(c, h.user, pid, body.get("decision"), if_match, body, key), if_match)


@route("POST", r"/manage/proposals/([a-z0-9_]+)/rebase")
def do_rebase(h, pid):
    row = h.c.execute("SELECT project FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "Resource not found.")
    h.need(row["project"], "link:review")
    if_match = h.headers.get("If-Match")
    return h.mutate(row["project"], "proposal.rebase", {}, lambda c: links.rebase(c, h.user, pid, if_match), if_match)


@route("POST", r"/manage/links/([a-z0-9_]+)/revoke")
def do_revoke(h, lid):
    body = h._json()
    row = h.c.execute("SELECT project FROM integration_link WHERE link_id=?", (lid,)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "Resource not found.")
    h.need(row["project"], "read")
    return h.mutate(row["project"], "link.revoke", body,
                    lambda c: links.revoke_link(c, h.user, lid, body.get("reason"), h.headers.get("Idempotency-Key")))


@route("POST", r"/manage/grants")
def do_grant(h):
    body = h._json()
    p = str(body.get("project"))
    h.need(p, "grants:manage")
    with h.app.db.tx() as c:
        from .util import now
        if body.get("action") == "revoke":
            n = c.execute("UPDATE grants SET revoked_at=? WHERE user_id=? AND project=? AND permission=? AND revoked_at IS NULL",
                          (now(), body.get("user"), p, body.get("permission"))).rowcount
        elif body.get("action") == "grant":
            c.execute("INSERT INTO grants (user_id, project, permission, granted_at) VALUES (?,?,?,?)",
                      (body.get("user"), p, body.get("permission"), now()))
            n = 1
        else:
            raise ApiError(400, "invalid_input", "action must be grant|revoke")
        audit(c, h.user, p, f"grant.{body.get('action')}", "committed", detail=body)
        return {"changed": n}


@route("POST", r"/manage/outbox/deliver")
def do_deliver(h):
    return {"outcomes": h.app.worker.deliver_pass(force=True)}


@route("POST", r"/manage/outbox/(pause|resume)")
def do_pause(h, which):
    (h.app.worker.paused.set if which == "pause" else h.app.worker.paused.clear)()
    return {"outbox_worker": "paused" if h.app.worker.paused.is_set() else "running"}


@route("POST", r"/manage/outbox/([a-z0-9_]+)/redeliver")
def do_redeliver(h, eid):
    ev = h.c.execute("SELECT project FROM outbox_event WHERE event_id=?", (eid,)).fetchone()
    if not ev:
        raise ApiError(404, "not_found", "Resource not found.")
    h.need(ev["project"], "release:manage")
    return {"outcome": h.app.worker.redeliver(eid)}


@route("POST", r"/manage/consumer/faults")
def do_faults(h):
    body = h._json()
    h.need("ehm", "release:manage")
    st, out = release._http_json("POST", release.CONSUMER_URL + "/faults", body=body)
    return st, out


def serve(db_path, host="127.0.0.1", port=8780, start_worker=True):
    Handler.app = App(db_path, start_worker=start_worker)
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("LWB_DB", "var/workbench.db"))
    ap.add_argument("--port", type=int, default=8780)
    a = ap.parse_args()
    pathlib.Path(a.db).parent.mkdir(parents=True, exist_ok=True)
    s = serve(a.db, port=a.port)
    print(f"workbench listening on http://127.0.0.1:{a.port}  (db={a.db})")
    s.serve_forever()
