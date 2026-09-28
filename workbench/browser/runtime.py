"""In-process runtime for the browser build (Pyodide, no sockets, no threads).

The workbench and the mock consumer keep their own code, handlers and SQLite files. Instead of listening on
ports, each request is written as raw HTTP bytes into the SAME BaseHTTPRequestHandler classes the servers use,
and the raw response bytes are parsed back, so request parsing, routing, permissions, receipts and error
handling are the production code paths. What changes here:

* Addresses: the workbench is http://workbench.local and the consumer http://consumer.local. The few places
  that make HTTP calls between them (consumer checks, schema checks, event delivery, the consumer's reads,
  the /consumer/ proxy) are pointed at `request()` instead of the network.
* The outbox has no background thread: `tick()` runs a delivery pass (the same OutboxWorker.deliver_pass)
  after every request and on a timer from the page, and respects pause and retry backoff as the thread would.
* State lives in the browser tab's in-memory file system. Reloading the page starts from the seeded baseline.

Nothing here reaches the network. The live-model adapter fails visibly, as it does without credentials.
"""
import http.client
import io
import json
import os
import pathlib
import sys
import urllib.parse

WB = "http://workbench.local"
CONS = "http://consumer.local"


class _Server:
    """Stands in for the listening server: no connection limits apply in-process."""

    def busy(self, *a, **k):
        return True


class _Conn:
    """Stands in for the socket. The consumer's lost-ack fault shuts it down after committing."""

    def __init__(self):
        self.dropped = False

    def shutdown(self, how):
        self.dropped = True

    def close(self):
        pass


def _raw(handler_cls, method, target, headers, body):
    lines = [f"{method} {target} HTTP/1.1", "Host: local"]
    for k, v in (headers or {}).items():
        if k.lower() not in ("host", "content-length", "connection"):
            lines.append(f"{k}: {v}")
    body = body or b""
    if isinstance(body, str):
        body = body.encode()
    lines += [f"Content-Length: {len(body)}", "Connection: close"]
    h = handler_cls.__new__(handler_cls)
    h.rfile = io.BytesIO(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body)
    h.wfile = io.BytesIO()
    h.server = _Server()
    h.connection = h.request = _Conn()
    h.client_address = ("browser", 0)
    h.close_connection = True
    h.handle_one_request()
    if h.connection.dropped:
        raise http.client.RemoteDisconnected("Remote end closed connection without response")
    out = h.wfile.getvalue()
    head, _, data = out.partition(b"\r\n\r\n")
    status_line, *hdr_lines = head.decode("latin-1").split("\r\n")
    status = int(status_line.split(" ", 2)[1])
    hdrs = {}
    for line in hdr_lines:
        k, _, v = line.partition(":")
        hdrs[k.strip()] = v.strip()
    return status, hdrs, data


def request(method, url, headers=None, body=None):
    """One HTTP exchange with the in-process workbench or consumer. Returns (status, headers, body bytes)."""
    u = urllib.parse.urlsplit(url)
    target = u.path + (f"?{u.query}" if u.query else "")
    cls = _consumer.Handler if url.startswith(CONS) else _server.Handler
    return _raw(cls, method.upper(), target or "/", headers, body)


def _json_call(method, url, token=None, body=None):
    hdrs = {"Content-Type": "application/json"}
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    st, _, data = request(method, url, hdrs, json.dumps(body).encode() if body is not None else None)
    try:
        return st, json.loads(data or b"null")
    except ValueError:
        return st, None


_server = _release = _outbox = _consumer = None


def boot(root, code_version="unknown"):
    """Load the app from `root` (the unpacked app bundle), wire it in-process, and seed the baseline."""
    global _server, _release, _outbox, _consumer
    sys.path.insert(0, str(root))
    os.environ.setdefault("LWB_QUIET", "1")
    os.environ["LWB_CODE_VERSION"] = code_version
    from consumer_app import app as consumer
    from lucidwb import outbox, release, server
    _server, _release, _outbox, _consumer = server, release, outbox, consumer

    data = pathlib.Path("/tmp/lwb") if pathlib.Path("/tmp").exists() else pathlib.Path(root) / "var"
    data.mkdir(parents=True, exist_ok=True)
    for f in data.iterdir():  # a fresh baseline on every start
        f.unlink()
    server.Handler.app = server.App(str(data / "workbench.db"), start_worker=False)
    consumer.Handler.store = consumer.Store(str(data / "consumer.db"))

    release.PUBLIC_URL, release.CONSUMER_URL = WB, CONS
    release._http_json = lambda method, url, token=None, body=None, timeout=20: _json_call(method, url, token, body)
    outbox.SUBSCRIBERS[0]["url"] = CONS + "/events"

    def post(url, body, timeout=10):
        st, _, data = request("POST", url, {"Content-Type": "application/json"}, json.dumps(body).encode())
        return st, data.decode(errors="replace")[:300]
    outbox._post = post

    consumer.WORKBENCH = WB
    consumer.http_get = lambda path_or_url, token=consumer.TOKEN: _json_call(
        "GET", path_or_url if path_or_url.startswith("http") else WB + path_or_url, token)

    def consumer_proxy(self, path):
        sub = path[len("/consumer"):] or "/"
        if sub not in ("/", "/state"):
            return self._send(404, {"error": {"code": "not_found", "message": "Resource not found."}})
        st, hdrs, data = request("GET", CONS + sub)
        self._send(st, None, raw=data, ctype=hdrs.get("Content-Type", "application/octet-stream"))
    server.Handler._consumer_proxy = consumer_proxy

    seed(root)
    tick()


def seed(root):
    """Same baseline as scripts/seed.py: projections (1.0.0 approved, later versions as drafts) + CMMS records."""
    fx = pathlib.Path(root) / "fixtures"
    for name in ["equipment-health_1.0.0.json", "equipment-health_1.1.0.json", "equipment-health_1.2.0.json",
                 "equipment-health_2.0.0.json"]:
        st, out = _json_call("POST", WB + "/manage/projections", "demo-carol",
                             json.loads((fx / "projections" / name).read_text()))
        assert st in (200, 201), out
    st, out = _json_call("POST", WB + "/manage/projects/ehm/projections/equipment-health/1.0.0/review", "demo-carol",
                         {"decision": "approve", "reason": "Baseline dashboard projection reviewed with consumer team."})
    assert st == 200, out
    st, _, data = request("POST", WB + "/manage/projects/ehm/imports", {"Authorization": "Bearer demo-carol"},
                          (fx / "records" / "cmms_main.json").read_bytes())
    assert st in (200, 201), data[:300]


def tick():
    """What the background outbox thread would do now: deliver whatever is due, unless paused."""
    for _ in range(20):
        if not _server.Handler.app.worker.deliver_pass():
            break


def handle(method, path, headers_json, body):
    """Entry point for the page: one request from the real UI's fetch() calls."""
    headers = json.loads(headers_json or "{}")
    raw = bytes(body.to_py()) if hasattr(body, "to_py") else (bytes(body) if body else None)
    try:
        st, hdrs, data = request(method, WB + path, headers, raw)
    finally:
        tick()
    return json.dumps({"status": st, "headers": hdrs}), data
