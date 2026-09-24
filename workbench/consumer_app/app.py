"""Mock consuming application ("equipment dashboard").

Deliberately independent: imports nothing from `lucidwb`, keeps its own SQLite database,
talks to the workbench only over HTTP with its own service token, and carries its own
expectations file.

Event handling contract:
* The received event ID and its local effect are committed in one transaction.
* A duplicate event ID is acknowledged without repeating the effect.
* Events carry a per-project sequence. An older/equal sequence is acknowledged and ignored
  (no rollback). A gap triggers resynchronization from the workbench's pinned active release.
"""
import hashlib
import json
import os
import pathlib
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent
EXPECT = json.loads((HERE / "expectations.json").read_text())
EXPECT_DIGEST = hashlib.sha256((HERE / "expectations.json").read_bytes()).hexdigest()
WORKBENCH = os.environ.get("LWB_PUBLIC_URL", "http://127.0.0.1:8780")
TOKEN = "demo-svc-consumer"
PROJECT = "ehm"

SCHEMA = """
CREATE TABLE IF NOT EXISTS received_event (event_id TEXT PRIMARY KEY, project TEXT, seq INTEGER, type TEXT,
  handling TEXT, received_at TEXT, deliveries INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS effect (effect_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, kind TEXT,
  detail TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS stream_state (project TEXT PRIMARY KEY, last_seq INTEGER, pinned_release TEXT,
  pinned_revision TEXT, latest_known_head TEXT, gaps_detected INTEGER DEFAULT 0, resyncs INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sensor_view (id TEXT PRIMARY KEY, source_id TEXT, name TEXT, serial TEXT,
  interval_ms REAL, measurand TEXT, gateway TEXT);
CREATE TABLE IF NOT EXISTS identity_map (source_id TEXT PRIMARY KEY, logical_id TEXT);
CREATE TABLE IF NOT EXISTS link_view (link_id TEXT PRIMARY KEY, record_id TEXT, target_uid TEXT, status TEXT);
"""


def ts():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Store:
    def __init__(self, path):
        self.path = path
        self.local = threading.local()
        self.lock = threading.Lock()  # one event at a time
        self.faults = {"drop_ack_after_commit": 0}
        self.conn().executescript(SCHEMA)

    def conn(self):
        c = getattr(self.local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            self.local.c = c
        return c


def http_get(path_or_url, token=TOKEN):
    url = path_or_url if path_or_url.startswith("http") else WORKBENCH + path_or_url
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if os.environ.get("LWB_ACCESS_CODE"):  # deployment gate in front of the workbench
        req.add_header("X-Access-Code", os.environ["LWB_ACCESS_CODE"])
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except ValueError:
            return e.code, None


def fetch_all(base, resource):
    items, url = [], f"{base}/resources/{resource}?limit=2"
    while url:
        st, body = http_get(url)
        if st != 200:
            raise RuntimeError(f"GET {url} -> {st}")
        items += body["items"]
        url = (WORKBENCH + body["next"]) if body.get("next") else None
    return items, body


# ---------------------------------------------------------------- verification
def verify(store, base_url):
    """Run every profile against the candidate's real HTTP responses."""
    profiles = []
    c = store.conn()
    known_ids = {r["source_id"]: r["logical_id"] for r in c.execute("SELECT * FROM identity_map")}
    cache = {}
    for pname, prof in EXPECT["profiles"].items():
        checks = []

        def check(name, ok, detail=""):
            checks.append({"check": name, "passed": bool(ok), "detail": detail})

        for rname, rexp in prof["resources"].items():
            try:
                if rname not in cache:
                    cache[rname] = fetch_all(base_url, rname)
                items, page = cache[rname]
            except RuntimeError as e:
                check(f"{rname}: fetch", False, str(e))
                continue
            check(f"{rname}: fetch", True, f"{len(items)} items from release {page['releaseId']} "
                                           f"(revision {page['source']['revision']})")
            for it in items:
                sid = it.get("sourceId")
                missing = [f for f in rexp.get("required", []) if f not in it]
                if missing:
                    check(f"{rname}/{sid}: required fields", False, f"missing {missing}")
                if "allowed_fields" in rexp:
                    extra = sorted(set(it) - set(rexp["allowed_fields"]))
                    if extra:
                        check(f"{rname}/{sid}: no unknown fields", False, f"unexpected {extra}")
                for f, (lo, hi) in rexp.get("numeric_ranges", {}).items():
                    v = it.get(f)
                    if isinstance(v, (int, float)) and not (lo <= v <= hi):
                        check(f"{rname}/{sid}: {f} plausible", False, f"{v} outside [{lo}, {hi}] - unit problem?")
                for f, allowed in rexp.get("enums", {}).items():
                    if f in it and it[f] not in allowed:
                        check(f"{rname}/{sid}: {f} renderable", False, f"'{it[f]}' not in {allowed}")
                for relf, target_res in rexp.get("relations", {}).items():
                    ref = it.get(relf)
                    if ref:
                        if target_res not in cache:
                            cache[target_res] = fetch_all(base_url, target_res)
                        ids = {x["id"] for x in cache[target_res][0]}
                        if ref.get("id") not in ids:
                            check(f"{rname}/{sid}: {relf} resolves to {target_res}", False, str(ref))
                if prof.get("identity_stability") and sid in known_ids and known_ids[sid] != it.get("id"):
                    check(f"{rname}/{sid}: identity stable", False, f"was {known_ids[sid]}, now {it.get('id')}")
            if not any(ch["check"].startswith(f"{rname}/") and not ch["passed"] for ch in checks):
                check(f"{rname}: all item expectations", True, f"{len(items)} items")
            if rexp.get("units"):
                st, oa = http_get(base_url + "/openapi.json")
                sname = "".join(w.capitalize() for w in rname.split("-"))
                props = (oa or {}).get("components", {}).get("schemas", {}).get(sname, {}).get("properties", {})
                for f, unit in rexp["units"].items():
                    got = props.get(f, {}).get("x-unit")
                    check(f"{rname}: contract declares {f} in {unit}", got == unit, f"x-unit={got}")
        if prof.get("permission_checks"):
            st, _ = http_get(base_url + "/resources/sensors", token=None)
            check("unauthenticated request refused", st == 401, f"HTTP {st}")
            st, _ = http_get(base_url.rsplit("/", 1)[0] + "/rel_doesnotexist/resources/sensors")
            check("unknown release is 404", st == 404, f"HTTP {st}")
        profiles.append({"profile": pname, "passed": all(ch["passed"] for ch in checks), "checks": checks})
    return {"consumer_id": EXPECT["consumer_id"], "consumer_version": EXPECT["consumer_version"],
            "expectations_digest": EXPECT_DIGEST, "passed": all(p["passed"] for p in profiles), "profiles": profiles}


# ---------------------------------------------------------------- event handling
def _resync_payload(release_id):
    base = f"{WORKBENCH}/api/releases/{release_id}"
    sensors, page = fetch_all(base, "sensors")
    return sensors, page


def handle_event(store, ev):
    """Returns (response_body, drop_ack). All effects for one event commit atomically."""
    with store.lock:
        c = store.conn()
        dup = c.execute("SELECT handling FROM received_event WHERE event_id=?", (ev["event_id"],)).fetchone()
        if dup:
            c.execute("UPDATE received_event SET deliveries=deliveries+1 WHERE event_id=?", (ev["event_id"],))
            return {"ack": ev["event_id"], "duplicate": True, "effect_repeated": False}, False
        st = c.execute("SELECT * FROM stream_state WHERE project=?", (ev["project"],)).fetchone()
        last = st["last_seq"] if st else 0
        prefetch, handling = None, None
        if ev["seq"] <= last:
            handling = "stale_ignored"
        elif ev["seq"] > last + 1:
            handling = "gap_resync"
            s, state = http_get(f"/api/projects/{ev['project']}/stream-state")
            prefetch = ("resync", state, _resync_payload(state["active_release_id"]) if state.get("active_release_id")
                        else None)
        else:
            handling = "applied"
            if ev["type"] == "release.activated":
                prefetch = ("release", None, _resync_payload(ev["payload"]["release_id"]))
        c.execute("BEGIN IMMEDIATE")
        try:
            c.execute("INSERT INTO received_event (event_id, project, seq, type, handling, received_at) VALUES (?,?,?,?,?,?)",
                      (ev["event_id"], ev["project"], ev["seq"], ev["type"], handling, ts()))
            if not st:
                c.execute("INSERT INTO stream_state (project, last_seq) VALUES (?, 0)", (ev["project"],))
            if handling == "applied":
                _apply(c, ev, prefetch)
                c.execute("UPDATE stream_state SET last_seq=? WHERE project=?", (ev["seq"], ev["project"]))
            elif handling == "gap_resync":
                _, state, payload = prefetch
                if payload:
                    _replace_sensors(c, payload[0], payload[1])
                c.execute("DELETE FROM link_view")
                for lid in state.get("active_links", []):
                    c.execute("INSERT OR REPLACE INTO link_view VALUES (?,?,?,?)", (lid, None, None, "active"))
                c.execute("UPDATE stream_state SET last_seq=?, gaps_detected=gaps_detected+1, resyncs=resyncs+1 "
                          "WHERE project=?", (max(state["latest_seq"], ev["seq"]), ev["project"]))
                c.execute("INSERT INTO effect (event_id, kind, detail, at) VALUES (?,?,?,?)",
                          (ev["event_id"], "resync_from_pinned_release",
                           json.dumps({"release_id": state.get("active_release_id"), "expected_seq": last + 1,
                                       "got_seq": ev["seq"]}), ts()))
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise
        drop = False
        if store.faults["drop_ack_after_commit"] > 0:
            store.faults["drop_ack_after_commit"] -= 1
            drop = True
        return {"ack": ev["event_id"], "handling": handling}, drop


def _replace_sensors(c, sensors, page):
    c.execute("DELETE FROM sensor_view")
    for s in sensors:
        c.execute("INSERT INTO sensor_view VALUES (?,?,?,?,?,?,?)",
                  (s["id"], s["sourceId"], s.get("name"), s.get("serialNumber"), s.get("sampleIntervalMs"),
                   s.get("measurand"), (s.get("gateway") or {}).get("sourceId")))
        c.execute("INSERT OR IGNORE INTO identity_map VALUES (?,?)", (s["sourceId"], s["id"]))
    c.execute("UPDATE stream_state SET pinned_release=?, pinned_revision=?, latest_known_head=? WHERE project=?",
              (page["releaseId"], page["source"]["revision"], page["source"]["headRevision"], page["project"]))


def _apply(c, ev, prefetch):
    t, p = ev["type"], ev["payload"]
    if t == "release.activated":
        _replace_sensors(c, *prefetch[2])
        detail = {"release_id": p["release_id"], "action": p.get("action")}
    elif t == "link.accepted":
        c.execute("INSERT OR REPLACE INTO link_view VALUES (?,?,?,?)", (p["link_id"], p["record_id"], p["target_uid"],
                                                                         "active"))
        detail = {"link_id": p["link_id"]}
    elif t == "link.revoked":
        c.execute("UPDATE link_view SET status='revoked' WHERE link_id=?", (p["link_id"],))
        detail = {"link_id": p["link_id"]}
    elif t == "source.head_advanced":
        c.execute("UPDATE stream_state SET latest_known_head=? WHERE project=?", (p["revision"], ev["project"]))
        detail = {"revision": p["revision"]}
    else:
        detail = {"ignored_type": t}
    c.execute("INSERT INTO effect (event_id, kind, detail, at) VALUES (?,?,?,?)",
              (ev["event_id"], t, json.dumps(detail), ts()))


def state(store):
    c = store.conn()
    st = c.execute("SELECT * FROM stream_state WHERE project=?", (PROJECT,)).fetchone()
    return {"consumer_id": EXPECT["consumer_id"], "consumer_version": EXPECT["consumer_version"],
            "stream": dict(st) if st else None,
            "sensors": [dict(r) for r in c.execute("SELECT * FROM sensor_view ORDER BY source_id")],
            "links": [dict(r) for r in c.execute("SELECT * FROM link_view")],
            "received_events": [dict(r) for r in c.execute("SELECT * FROM received_event ORDER BY seq, received_at")],
            "effects": [dict(r) for r in c.execute("SELECT * FROM effect ORDER BY effect_id")],
            "effect_count_by_event": {r[0]: r[1] for r in c.execute("SELECT event_id, COUNT(*) FROM effect GROUP BY event_id")},
            "faults": store.faults}


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    store: Store = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("LWB_QUIET") != "1":
            import sys
            sys.stderr.write("[consumer] " + fmt % args + "\n")

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, indent=1).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/state":
            return self._send(200, state(self.store))
        if self.path == "/":
            return self._send(200, (HERE / "dashboard.html").read_bytes(), "text/html")
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        body = self._json()
        if self.path == "/events":
            out, drop = handle_event(self.store, body)
            if drop:
                # Simulated lost acknowledgment: the effect is committed, but the sender never hears back.
                self.close_connection = True
                self.connection.shutdown(2)
                return
            return self._send(200, out)
        if self.path == "/verify":
            return self._send(200, verify(self.store, body["base_url"]))
        if self.path == "/faults":
            for k in self.store.faults:
                if k in body:
                    self.store.faults[k] = int(body[k])
            return self._send(200, {"faults": self.store.faults})
        self._send(404, {"error": "not_found"})


def serve(db_path, host="127.0.0.1", port=8781):
    Handler.store = Store(db_path)
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="var/consumer.db")
    ap.add_argument("--port", type=int, default=8781)
    a = ap.parse_args()
    pathlib.Path(a.db).parent.mkdir(parents=True, exist_ok=True)
    s = serve(a.db, port=a.port)
    print(f"consumer listening on http://127.0.0.1:{a.port}")
    s.serve_forever()
