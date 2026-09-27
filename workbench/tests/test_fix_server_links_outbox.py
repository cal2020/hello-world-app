"""Regression tests for server, link and outbox findings (cluster C3). Each test names the finding index it covers."""
import json
import os
import pathlib
import re
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.parse
from unittest import mock

from lucidwb import ai, outbox, server, util
from scripts.client import FIX
from tests.helpers import StackCase

CODE = "gate-test-code"


def strict_json(data):
    """Parse as RFC 8259 JSON: NaN and Infinity are not JSON."""
    def bad(token):
        raise ValueError(f"non-JSON constant {token}")
    return json.loads(data, parse_constant=bad)


class RawHttp:
    def exchange(self, data, wait=0.5):
        """Send raw bytes on one connection. Returns (every byte received, whether the server closed it)."""
        s = socket.create_connection(("127.0.0.1", self.port), timeout=wait)
        out, closed = b"", False
        try:
            s.sendall(data)
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    closed = True
                    break
                out += chunk
        except socket.timeout:
            pass
        except ConnectionResetError:
            closed = True
        finally:
            s.close()
        return out, closed

    @staticmethod
    def statuses(data):
        return [int(m) for m in re.findall(rb"HTTP/1\.[01] (\d{3}) ", data)]


class GateFixes(StackCase, RawHttp):
    def setUp(self):
        os.environ["LWB_ACCESS_CODE"] = CODE  # internal clients (seed, checks, consumer) send it too
        os.environ["LWB_COOKIE_SECURE"] = "0"
        self.addCleanup(os.environ.pop, "LWB_ACCESS_CODE", None)
        self.addCleanup(os.environ.pop, "LWB_COOKIE_SECURE", None)
        patch = mock.patch.object(server, "GUESS_INTERVAL", 0.01)  # keep failed-guess delays short in tests
        patch.start()
        self.addCleanup(patch.stop)
        super().setUp()
        self.port = urllib.parse.urlparse(self.stack.wb_url).port

    # ------------------------------------------------------------ 3
    def test_f03_an_unread_body_is_never_parsed_as_a_request(self):
        inner = b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n"
        post = (b"POST /manage/projects/ehm/imports HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer demo-carol\r\n"
                b"Content-Length: %d\r\n\r\n" % len(inner)) + inner
        # The gate refuses without reading the body; the body is consumed, not answered as a second request.
        data, _ = self.exchange(post)
        self.assertEqual(self.statuses(data), [401])
        # The connection stays usable: a request that follows the body is answered normally.
        data, _ = self.exchange(post + inner)
        self.assertEqual(self.statuses(data), [401, 200])
        # /login (before the gate) no longer reads just the first 4096 bytes of a larger form.
        form = b"code=" + b"a" * 4091 + inner
        data, _ = self.exchange(b"POST /login HTTP/1.1\r\nHost: x\r\n"
                                b"Content-Type: application/x-www-form-urlencoded\r\n"
                                b"Content-Length: %d\r\n\r\n" % len(form) + form)
        self.assertEqual(self.statuses(data), [413])
        # A chunked body cannot be delimited: refused, and the connection is closed.
        chunked = b"%x\r\n%s\r\n0\r\n\r\n" % (len(inner), inner)
        data, closed = self.exchange(b"POST /manage/projects/ehm/imports HTTP/1.1\r\nHost: x\r\n"
                                     b"Transfer-Encoding: chunked\r\n\r\n" + chunked)
        self.assertEqual((self.statuses(data), closed), ([411], True))
        # An oversized body is not read at all: 413, and the connection is closed.
        data, closed = self.exchange(b"POST /manage/projects/ehm/imports HTTP/1.1\r\nHost: x\r\nX-Access-Code: "
                                     + CODE.encode() + b"\r\nAuthorization: Bearer demo-carol\r\n"
                                     b"Content-Length: 6000000\r\n\r\n" + inner)
        self.assertEqual((self.statuses(data), closed), ([413], True))

    # ------------------------------------------------------------ 4
    def test_f04_negative_or_non_numeric_content_length_is_refused(self):
        for value in (b"-1", b"abc", b"1, 2"):
            data, closed = self.exchange(b"POST /login HTTP/1.1\r\nHost: x\r\nContent-Length: " + value +
                                         b"\r\n\r\ncode=x" + b"y" * 1000, wait=2)
            self.assertEqual((self.statuses(data), closed), ([400], True), value)
        data, closed = self.exchange(b"POST /manage/projects/ehm/imports HTTP/1.1\r\nHost: x\r\nX-Access-Code: "
                                     + CODE.encode() + b"\r\nContent-Length: -1\r\n\r\n{}", wait=2)
        self.assertEqual((self.statuses(data), closed), ([400], True))

    # ------------------------------------------------------------ 30
    def test_f30_failed_guesses_are_spaced_across_all_connections(self):
        server.GUESS_INTERVAL = 0.15
        guesses = [b"X-Access-Code: guess-%d" % i for i in range(3)] + [b"Cookie: lwb_access=%d" % i for i in range(3)]
        results, threads = [], []
        for g in guesses:
            req = b"GET /api/whoami HTTP/1.1\r\nHost: x\r\nConnection: close\r\n" + g + b"\r\n\r\n"
            threads.append(threading.Thread(target=lambda r=req: results.append(self.exchange(r, wait=5)[0])))
        t0 = time.monotonic()
        for t in threads:
            t.start()
        # A correct code is answered at once, even while guesses are queued.
        c0 = time.monotonic()
        st, _, _ = self.carol.get("/api/whoami")
        self.assertEqual(st, 200)
        self.assertLess(time.monotonic() - c0, 0.5)
        for t in threads:
            t.join()
        # Six parallel wrong guesses took at least six intervals in total, not one.
        self.assertGreaterEqual(time.monotonic() - t0, 6 * 0.15 - 0.05)
        self.assertEqual(sorted(self.statuses(b"".join(results))), [401] * 6)

    # ------------------------------------------------------------ 31
    def test_f31_non_ascii_codes_are_compared_as_bytes(self):
        for extra in (b"X-Access-Code: \xe9t\xe9", b"Cookie: lwb_access=\xe9"):
            data, _ = self.exchange(b"GET /api/whoami HTTP/1.1\r\nHost: x\r\nConnection: close\r\n" + extra
                                    + b"\r\n\r\n")
            self.assertEqual(self.statuses(data), [401], extra)
        form = b"code=%C3%A9t%C3%A9"
        data, _ = self.exchange(b"POST /login HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: %d\r\n\r\n"
                                % len(form) + form)
        self.assertEqual(self.statuses(data), [401])
        # A configured code outside ASCII (even outside latin-1) works for the internal clients and the login form.
        os.environ["LWB_ACCESS_CODE"] = "Zugang-für-€-2026"
        self.assertEqual(self.carol.get("/api/whoami")[0], 200)
        form = b"code=" + urllib.parse.quote("Zugang-für-€-2026").encode()
        data, _ = self.exchange(b"POST /login HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: %d\r\n\r\n"
                                % len(form) + form)
        self.assertEqual(self.statuses(data), [303])
        # A latin-1 encoded header (Python's default for str header values) is accepted as well.
        os.environ["LWB_ACCESS_CODE"] = "für-demo"
        data, _ = self.exchange(b"GET /api/whoami HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
                                b"Authorization: Bearer demo-bob\r\nX-Access-Code: f\xfcr-demo\r\n\r\n")
        self.assertEqual(self.statuses(data), [200])


class ServerLinksOutboxFixes(StackCase, RawHttp):
    def setUp(self):
        super().setUp()
        self.port = urllib.parse.urlparse(self.stack.wb_url).port

    def decide(self, prop, decision, who=None, reason="Reviewed in test."):
        """Decide on a proposal as the client currently sees it (fresh ETag and heads)."""
        cur = self.ok((who or self.alice).get(f"/api/proposals/{prop['proposal_id']}"))
        body = {"decision": decision, "reason": reason, "expected_model_revision": cur["freshness"]["model_head"],
                "expected_record_revision": cur["freshness"]["record_head"]}
        return (who or self.alice).post(f"/manage/proposals/{prop['proposal_id']}/decision", body,
                                        headers={"If-Match": cur["etag"]})

    def fixture_outputs(self, proposals):
        d = tempfile.mkdtemp(prefix="lwb-fixture-")
        with open(os.path.join(d, "cmms.json"), "w") as f:
            json.dump({"proposals": proposals}, f)
        patch = mock.patch.object(ai, "FIXTURE_DIR", pathlib.Path(d))
        patch.start()
        self.addCleanup(patch.stop)

    # ------------------------------------------------------------ 5
    def test_f05_outbox_controls_are_scoped_to_a_project_and_audited(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/radar_project.json", who=self.dana, project="radar"))
        for path in ("/manage/outbox/pause", "/manage/outbox/resume", "/manage/outbox/deliver"):
            self.assertEqual(self.carol.post(path)[0], 404, path)  # the global controls are gone
        for who, status in ((self.dana, 404), (self.bob, 403), (self.svc, 403)):
            for action in ("pause", "resume", "deliver"):
                st, _, _ = who.post(f"/manage/projects/ehm/outbox/{action}")
                self.assertEqual(st, status, (who.token, action))
        # dana's forced delivery touches radar only; ehm events stay pending and are not disclosed.
        outs = self.ok(self.dana.post("/manage/projects/radar/outbox/deliver"))["outcomes"]
        self.assertTrue(outs)
        radar_ids = {e["event_id"] for e in self.ok(self.dana.get("/api/projects/radar/history"))["outbox"]}
        self.assertTrue({o["event_id"] for o in outs} <= radar_ids)
        pending = [e for e in self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"] if not e["delivered_at"]]
        self.assertTrue(pending)
        # carol pauses ehm: the worker's own pass skips it; a forced delivery still works.
        self.assertEqual(self.ok(self.carol.post("/manage/projects/ehm/outbox/pause"))["outbox_worker"], "paused")
        self.assertEqual([o for o in self.stack.app.worker.deliver_pass() if o["event_id"] not in radar_ids], [])
        outs = self.ok(self.carol.post("/manage/projects/ehm/outbox/deliver"))["outcomes"]
        self.assertEqual([o["seq"] for o in outs], [min(e["seq"] for e in pending)])
        hist = self.ok(self.carol.get("/api/projects/ehm/history"))
        self.assertEqual(hist["outbox_worker"], "paused")
        self.assertEqual(self.ok(self.carol.post("/manage/projects/ehm/outbox/resume"))["outbox_worker"], "running")
        actions = [(a["actor"], a["action"]) for a in self.ok(self.carol.get("/api/projects/ehm/history"))["audit"]]
        for entry in (("carol", "outbox.pause"), ("carol", "outbox.deliver"), ("carol", "outbox.resume")):
            self.assertIn(entry, actions)

    # ------------------------------------------------------------ 6
    def race(self, perm, send):
        """Revoke carol's `perm` on ehm while her request, already past the early check, waits for the write lock."""
        db = self.stack.app.db
        entered, orig, out = threading.Event(), db.tx, {}

        def tx():
            entered.set()
            return orig()
        lock = sqlite3.connect(db.path, isolation_level=None)
        lock.execute("BEGIN IMMEDIATE")
        lock.execute("UPDATE grants SET revoked_at='2026-01-01T00:00:00.000Z' WHERE user_id='carol' AND project='ehm' "
                     "AND permission=? AND revoked_at IS NULL", (perm,))
        db.tx = tx
        t = threading.Thread(target=lambda: out.setdefault("r", send()))
        try:
            t.start()
            self.assertTrue(entered.wait(10))
            time.sleep(0.2)  # the request now waits for BEGIN IMMEDIATE
        finally:
            del db.tx
            lock.execute("COMMIT")
            lock.close()
        t.join(30)
        return out["r"]

    def test_f06_a_grant_revoked_while_waiting_for_the_write_lock_is_honored(self):
        a = self.release_a()
        self.ok(self.imp("model/B_rename_gateway.json"))
        b = self.build("1.0.0")
        self.checks(b["release_id"])
        st, body, _ = self.race("release:manage", lambda: self.activate(b["release_id"]))
        self.assertEqual((st, body["error"]["code"]), (403, "forbidden"))
        self.assertEqual(self.ok(self.bob.get("/api/projects/ehm/releases"))["active_release_id"], a)
        self.ok(self.admin.post("/manage/grants", {"action": "grant", "user": "carol", "project": "ehm",
                                                   "permission": "release:manage"}))
        n = len(self.ok(self.bob.get("/api/projects/ehm/releases"))["releases"])
        st, body, _ = self.race("release:manage", lambda: self.carol.post(
            "/manage/projects/ehm/releases", {"projection_id": "equipment-health", "version": "1.0.0"}))
        self.assertEqual((st, body["error"]["code"]), (403, "forbidden"))
        self.assertEqual(len(self.ok(self.bob.get("/api/projects/ehm/releases"))["releases"]), n)

    # ------------------------------------------------------------ 10
    def test_f10_backoff_does_not_overflow_and_other_projects_still_deliver(self):
        self.ok(self.imp("model/A_initial.json"))
        self.ok(self.imp("model/radar_project.json", who=self.dana, project="radar"))
        c = self.stack.app.db.read()
        c.execute("UPDATE outbox_event SET attempts=1024 WHERE project='ehm'")
        first = c.execute("SELECT event_id FROM outbox_event WHERE project='ehm' ORDER BY seq LIMIT 1").fetchone()[0]
        url = outbox.SUBSCRIBERS[0]["url"]
        outbox.SUBSCRIBERS[0]["url"] = "http://127.0.0.1:1/events"  # nothing listens: every attempt fails
        try:
            outs = {o["event_id"]: o for o in self.stack.app.worker.deliver_pass(force=True)}
        finally:
            outbox.SUBSCRIBERS[0]["url"] = url
        self.assertEqual((outs[first]["attempt"], outs[first]["outcome"]), (1025, "no_acknowledgment"))
        self.assertTrue(any(o["outcome"] == "no_subscriber" for o in outs.values()))  # radar was delivered
        ev = c.execute("SELECT attempts, next_attempt_at FROM outbox_event WHERE event_id=?", (first,)).fetchone()
        self.assertEqual(ev["attempts"], 1025)
        self.assertLessEqual(ev["next_attempt_at"], time.time() + 10.5)
        self.assertIsNotNone(c.execute("SELECT 1 FROM delivery_attempt WHERE event_id=? AND attempt=1025",
                                       (first,)).fetchone())

    # ------------------------------------------------------------ 11
    def test_f11_the_same_link_cannot_be_active_twice(self):
        self.ok(self.imp("model/A_initial.json"))
        p1 = self.find_prop(self.proposals(), "MR-1001", "el-VS101DE")
        p2 = self.find_prop(self.proposals(method="deterministic"), "MR-1001", "el-VS101DE")
        first = self.ok(self.accept(p1))
        st, body, _ = self.accept(p2)
        self.assertEqual((st, body["error"]["code"], body["error"]["details"]["link_id"]),
                         (409, "already_linked", first["link_id"]))
        links = self.ok(self.alice.get("/api/projects/ehm/links"))["links"]
        self.assertEqual([l["link_id"] for l in links], [first["link_id"]])
        # Only an ACTIVE link blocks: after a revocation the relationship can be accepted again.
        self.ok(self.alice.post(f"/manage/links/{first['link_id']}/revoke", {"reason": "wrong record"}))
        self.ok(self.accept(p2))

    # ------------------------------------------------------------ 25
    def test_f25_nan_is_never_served_and_fails_the_schema_check(self):
        a = self.release_a()
        c = self.stack.app.db.read()
        vid = c.execute("SELECT ev.version_id FROM element_version ev JOIN element_identity ei ON "
                        "ei.entity_uid=ev.entity_uid WHERE ei.native_id='el-VS101DE'").fetchone()[0]
        # A NaN stored by an earlier version (the importer now refuses non-finite numbers).
        c.execute("UPDATE element_version SET properties_json=replace(properties_json, '\"sampleInterval\": 500', "
                  "'\"sampleInterval\": NaN') WHERE version_id=?", (vid,))
        data, _ = self.exchange(b"GET /api/current/ehm/resources/sensors HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
                                b"Authorization: Bearer demo-svc-consumer\r\n\r\n")
        head, _, body = data.partition(b"\r\n\r\n")
        self.assertEqual(strict_json(body)["error"]["code"], "non_json_value")  # valid JSON, and an error
        self.assertEqual(self.statuses(head), [500])
        run = self.checks(a)["consumer_test_runs"][-1]
        self.assertFalse(run["schema_check"]["passed"])
        # New non-finite values are not taken in: request bodies are strict JSON, and a model's NaN confidence
        # is dropped rather than stored.
        st, body, _ = self.carol.post("/manage/projections", raw=b'{"project": "ehm", "x": NaN}')
        self.assertEqual((st, body["error"]["code"]), (400, "invalid_input"))
        self.fixture_outputs([{"record_id": "MR-1001", "element_id": "el-VS101DE", "confidence": float("nan"),
                               "predicate": "maintenance_record_references_element", "contradictions": [],
                               "evidence": [{"record_id": "MR-1001", "quote": "Replaced vibration sensor VS-4471"}]}])
        self.assertIsNone(self.proposals()["proposals"][0]["confidence"])
        data, _ = self.exchange(b"GET /api/projects/ehm/proposals HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
                                b"Authorization: Bearer demo-alice\r\n\r\n")
        self.assertEqual(len(strict_json(data.partition(b"\r\n\r\n")[2])["proposals"]), 1)

    # ------------------------------------------------------------ 26
    def test_f26_code_version_comes_from_the_deploy_environment(self):
        env = {k: v for k, v in os.environ.items() if k not in ("LWB_CODE_VERSION", "RAILWAY_GIT_COMMIT_SHA")}
        with mock.patch.dict(os.environ, env, clear=True):
            local = util.code_version()
            cwd = os.getcwd()
            os.chdir(tempfile.gettempdir())  # the version is of this code, not of the current directory
            try:
                self.assertEqual(util.code_version(), local)
            finally:
                os.chdir(cwd)
            os.environ["RAILWAY_GIT_COMMIT_SHA"] = "0123456789abcdef0123456789abcdef01234567"
            self.assertEqual(util.code_version(), "0123456789ab")
            os.environ["LWB_CODE_VERSION"] = "build-42"
            self.assertEqual(util.code_version(), "build-42")
            self.ok(self.imp("model/A_initial.json"))
            self.assertEqual(self.build("1.0.0")["manifest"]["code_version"], "build-42")

    # ------------------------------------------------------------ 32
    def test_f32_grants_are_validated(self):
        def grant(user, perm, project="ehm", action="grant", who=None):
            body = {"action": action, "user": user, "project": project, "permission": perm}
            return (who or self.admin).post("/manage/grants", {k: v for k, v in body.items() if v is not None})
        for user, perm in (("mallory", "read"), ("alice", "link:aprove"), (None, "read"), ("alice", None)):
            st, body, _ = grant(user, perm)
            self.assertEqual((st, body["error"]["code"]), (400, "invalid_input"), (user, perm))
        st, body, _ = grant("admin", "read")  # a grant manager cannot hand itself operational rights
        self.assertEqual((st, body["error"]["code"]), (403, "forbidden"))
        self.assertEqual(self.admin.get("/api/projects/ehm/links")[0], 404)
        self.assertEqual(self.ok(grant("alice", "read"))["changed"], 0)  # already held
        self.assertEqual(self.ok(grant("bob", "link:review"))["changed"], 1)
        self.assertEqual(self.ok(grant("bob", "link:review", action="revoke"))["changed"], 1)
        self.assertEqual(self.ok(grant("admin", "grants:manage", action="revoke"))["changed"], 1)  # giving up is fine

    # ------------------------------------------------------------ 33
    def test_f33_a_pending_event_cannot_be_redelivered_out_of_order(self):
        self.ok(self.imp("model/A_initial.json"))
        pending = [e for e in self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"] if not e["delivered_at"]]
        last = max(pending, key=lambda e: e["seq"])
        st, body, _ = self.carol.post(f"/manage/outbox/{last['event_id']}/redeliver")
        self.assertEqual((st, body["error"]["code"]), (409, "not_yet_delivered"))
        self.assertIsNone(self.stack.app.worker.redeliver(last["event_id"]))
        hist = {e["event_id"]: e for e in self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"]}
        self.assertIsNone(hist[last["event_id"]]["delivered_at"])
        self.deliver_all()
        self.assertEqual(self.ok(self.carol.post(f"/manage/outbox/{last['event_id']}/redeliver"))["outcome"]["outcome"],
                         "acknowledged")

    # ------------------------------------------------------------ 34
    def test_f34_now_reads_the_clock_once(self):
        ticks = iter([1000.9995, 1001.0004, 1001.0004])

        class Clock:
            strftime = staticmethod(time.strftime)

            @staticmethod
            def time():
                return next(ticks)

            @staticmethod
            def gmtime(t=None):
                return time.gmtime(next(ticks) if t is None else t)
        with mock.patch.object(util, "time", Clock):
            self.assertEqual(util.now(), "1970-01-01T00:16:40.999Z")

    # ------------------------------------------------------------ 35, 36
    def test_f35_f36_backlog_timeout_and_connection_cap(self):
        self.assertGreaterEqual(self.stack.wb.request_queue_size, 128)
        self.assertGreaterEqual(self.stack.cons.request_queue_size, 128)
        self.assertTrue(server.Handler.timeout and server.Handler.timeout <= 60)
        # A connection that never finishes its request is closed after the timeout.
        with mock.patch.object(server.Handler, "timeout", 0.3):
            data, closed = self.exchange(b"GET /api/whoami HTTP/1.1\r\nHost: x\r\n", wait=3)
        self.assertEqual((data, closed), (b"", True))
        # Open connections are capped, so stalled clients cannot use up threads. (Repair round: past the cap the
        # longest-waiting idle connection is closed to make room instead of refusing the new connection, which
        # let idle sockets lock everyone out; tests/test_fix_repairs.py covers that.)
        self.stack.wb.max_connections = 4
        idle = [socket.create_connection(("127.0.0.1", self.port), timeout=3) for _ in range(8)]
        try:
            self.assertEqual([s.recv(1) for s in idle[:4]], [b""] * 4)  # the four oldest were closed
            self.assertLessEqual(len(self.stack.wb._open), 4)
            self.assertEqual(self.statuses(self.exchange(
                b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")[0]), [200])
        finally:
            for s in idle:
                s.close()
        self.assertEqual(self.ok(self.carol.get("/api/whoami"))["user_id"], "carol")

    # ------------------------------------------------------------ 56
    def test_f56_record_kind_and_a_quote_from_the_subject_record_are_required(self):
        self.ok(self.imp("model/A_initial.json"))
        pred = "maintenance_record_references_element"
        self.fixture_outputs([
            {"record_id": "N-1", "element_id": "el-VS101DE", "predicate": pred, "contradictions": [], "confidence": 0.9,
             "evidence": [{"record_id": "N-1", "quote": "On P-101 the DE vibration sensor is serial VS-4471"}]},
            {"record_id": "MR-1006", "element_id": "el-VS101NDE", "predicate": pred, "contradictions": [],
             "confidence": 0.9, "evidence": [{"record_id": "N-1", "quote": "the NDE sensor is VS-4472"}]},
            {"record_id": "MR-1001", "element_id": "el-VS101DE", "predicate": pred, "contradictions": [],
             "confidence": 0.9, "evidence": [{"record_id": "MR-1001", "quote": "Replaced vibration sensor VS-4471"}]},
        ])
        run = self.proposals()
        note = self.find_prop(run, "N-1", "el-VS101DE")
        other = self.find_prop(run, "MR-1006", "el-VS101NDE")
        self.assertEqual(note["validation"], "record_kind_not_allowed")
        self.assertEqual(other["validation"], "missing_subject_evidence")
        self.assertEqual(self.find_prop(run, "MR-1001", "el-VS101DE")["validation"], "valid")
        for p in (note, other):
            st, body, _ = self.accept(p)
            self.assertEqual((st, body["error"]["code"]), (409, "not_acceptable"))
        self.assertEqual(self.ok(self.alice.get("/api/projects/ehm/links"))["links"], [])

    # ------------------------------------------------------------ 57
    def test_f57_a_changed_predicate_is_revalidated(self):
        self.ok(self.imp("model/A_initial.json"))
        p = self.find_prop(self.proposals(), "MR-1002", "el-P101")
        self.assertEqual(p["validation"], "unsupported_predicate")
        st, body, _ = self.alice.post(f"/manage/proposals/{p['proposal_id']}/decision",
                                      {"decision": "change_predicate", "reason": "Use the vocabulary predicate.",
                                       "new_predicate": "maintenance_record_references_element",
                                       "expected_model_revision": p["freshness"]["model_head"],
                                       "expected_record_revision": p["freshness"]["record_head"]},
                                      headers={"If-Match": p["etag"]})
        self.assertEqual(st, 200, body)
        child = self.ok(self.alice.get(f"/api/proposals/{body['replacement_proposal_id']}"))
        self.assertEqual((child["predicate"], child["validation"]), ("maintenance_record_references_element", "valid"))
        codes = [n["code"] for n in child["validation_notes"]]
        self.assertNotIn("predicate_needs_vocabulary_review", codes)
        self.assertIn("reviewer_predicate_change", codes)
        self.assertEqual(self.ok(self.accept(child))["authority"], "reviewer_accepted")

    # ------------------------------------------------------------ 61
    def stub_anthropic(self, create):
        stub = types.ModuleType("anthropic")
        for name in ("APIError", "APIConnectionError", "AuthenticationError", "RateLimitError", "APIStatusError"):
            setattr(stub, name, type(name, (Exception,), {}))
        stub.Anthropic = lambda: types.SimpleNamespace(messages=types.SimpleNamespace(create=create))
        patch = mock.patch.dict(sys.modules, {"anthropic": stub})
        patch.start()
        self.addCleanup(patch.stop)

    def test_f61_any_live_adapter_failure_is_recorded_on_the_run(self):
        self.ok(self.imp("model/A_initial.json"))

        def no_credentials(**kw):
            raise TypeError("Could not resolve authentication method.")

        def no_usage(**kw):  # an unexpected response shape, after the call itself succeeded
            return types.SimpleNamespace(stop_reason="end_turn", model="stub",
                                         content=[types.SimpleNamespace(type="text", text='{"proposals": []}')])
        for create, kind in ((no_credentials, "TypeError"), (no_usage, "AttributeError")):
            self.stub_anthropic(create)
            run = self.ok(self.alice.post("/manage/projects/ehm/proposal-runs",
                                          {"method": "model", "mode": "live"}), 201)
            self.assertEqual(run["status"], "failed")
            self.assertIn(kind, run["error"])
        runs = self.ok(self.alice.get("/api/projects/ehm/proposals"))["runs"]
        self.assertEqual([(r["mode"], r["status"]) for r in runs], [("live", "failed")] * 2)

    # ------------------------------------------------------------ 62
    def test_f62_a_stale_proposal_can_still_be_closed(self):
        self.ok(self.imp("model/A_initial.json"))
        run = self.proposals()
        ts = self.find_prop(run, "MR-1005", "el-TS101")
        vs = self.find_prop(run, "MR-1001", "el-VS101DE")
        self.ok(self.imp("model/B_rename_gateway.json"))
        self.ok(self.imp("model/delta_delete_temperature_sensor.json"))
        body = self.ok(self.decide(ts, "reject", reason="wrong sensor"))
        self.assertEqual(body["disposition"], "rejected")
        self.assertIn("target_deleted_or_absent", body["stale_inputs"])
        # An accept on stale inputs still marks the proposal for review; it can then be closed.
        st, body, _ = self.decide(vs, "accept")
        self.assertEqual((st, body["error"]["code"]), (409, "stale_dependency"))
        self.assertEqual(self.ok(self.decide(vs, "no_match"))["disposition"], "no_match")
        st, body, _ = self.decide(vs, "reject")
        self.assertEqual((st, body["error"]["code"]), (409, "already_decided"))
        self.assertEqual(self.ok(self.alice.get("/api/projects/ehm/links"))["links"], [])

    # ------------------------------------------------------------ 64
    def test_f64_a_numeric_serial_does_not_break_the_deterministic_run(self):
        doc = json.loads((FIX / "model/A_initial.json").read_text())
        next(e for e in doc["elements"] if e["id"] == "el-TS101")["properties"]["serialNumber"] = 2210
        body = self.ok(self.carol.post("/manage/projects/ehm/imports", raw=json.dumps(doc).encode()), 201)
        self.assertEqual(body["outcome"], "accepted_head")
        run = self.proposals(method="deterministic")
        self.assertEqual(run["status"], "completed")
        self.find_prop(run, "MR-1001", "el-VS101DE")  # string serials still match


if __name__ == "__main__":
    unittest.main()
