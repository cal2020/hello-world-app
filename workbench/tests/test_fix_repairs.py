"""Regression tests for the repair round: findings still open, and regressions introduced by the cluster fixes."""
import json
import os
import re
import socket
import sqlite3
import threading
import time
import unittest
import urllib.parse
from unittest import mock

from lucidwb import server
from lucidwb.importer import normalize_model
from lucidwb.util import digest
from scripts.client import FIX, Client
from tests import test_fix_ui as ui
from tests.helpers import StackCase

CODE = "repair-test-code"


def fixture(rel):
    return json.loads((FIX / rel).read_text())


def statuses(data):
    return [int(m) for m in re.findall(rb"HTTP/1\.[01] (\d{3}) ", data)]


class GateAvailability(StackCase):
    """The connection cap and the guess throttle must not let an unauthenticated client lock everyone out."""
    CAP = 16

    def setUp(self):
        os.environ["LWB_ACCESS_CODE"] = CODE  # internal clients (seed, checks, consumer) send it too
        os.environ["LWB_COOKIE_SECURE"] = "0"
        self.addCleanup(os.environ.pop, "LWB_ACCESS_CODE", None)
        self.addCleanup(os.environ.pop, "LWB_COOKIE_SECURE", None)
        for patch in (mock.patch.object(server.Server, "max_connections", self.CAP),  # before the server is built
                      mock.patch.object(server, "GUESSES", server._GuessThrottle())):  # no queue left by other tests
            patch.start()
            self.addCleanup(patch.stop)
        super().setUp()
        self.port = urllib.parse.urlparse(self.stack.wb_url).port
        self.socks = []
        self.addCleanup(lambda: [s.close() for s in self.socks])

    def connect(self, data=b""):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.socks.append(s)
        if data:
            s.sendall(data)
        return s

    def exchange(self, data, wait=3):
        s = self.connect(data)
        s.settimeout(wait)
        out = b""
        try:
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                out += chunk
        except (socket.timeout, ConnectionResetError):
            pass
        return out

    def quick(self, fn):
        t0 = time.monotonic()
        result = fn()
        self.assertLess(time.monotonic() - t0, 1.5)
        return result

    def healthz(self):
        return statuses(self.exchange(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))

    def guess(self, i, path=b"/api/whoami"):
        return self.connect(b"GET " + path + b" HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-Access-Code: wrong-%d"
                            b"\r\n\r\n" % i)

    def test_idle_and_slow_connections_do_not_lock_out_others(self):
        idle = [self.connect() for _ in range(self.CAP)]
        for _ in range(self.CAP // 2):
            self.connect(b"GET /api/whoami HTTP/1.1\r\nHost: x\r\n")  # a request that never finishes
        time.sleep(0.3)
        self.assertEqual(self.quick(self.healthz), [200])
        self.assertEqual(self.quick(lambda: self.carol.get("/api/whoami"))[0], 200)
        # Room was made by closing the connections that had waited longest; the cap still holds.
        self.assertEqual(idle[0].recv(1), b"")
        self.assertLessEqual(len(self.stack.wb._open), self.CAP)

    def test_wrong_guesses_do_not_hold_connections(self):
        """A burst of wrong codes, then a steady stream, with no response ever read: correct-code users and
        /healthz are still answered at once."""
        stop, socks = threading.Event(), []

        def attack():
            for i in range(3 * self.CAP):
                socks.append(self.guess(i))
            while not stop.wait(0.05):
                socks.append(self.guess(len(socks)))
        with mock.patch.object(server, "GUESS_INTERVAL", 0.5):
            attacker = threading.Thread(target=attack)
            t0 = time.monotonic()
            attacker.start()
            try:
                time.sleep(0.5)
                for _ in range(4):
                    self.assertEqual(self.quick(lambda: self.carol.get("/api/whoami"))[0], 200)
                    self.assertEqual(self.quick(self.healthz), [200])
                    time.sleep(0.2)
            finally:
                stop.set()
                attacker.join()
            seconds = time.monotonic() - t0
            answers = []
            for s in socks:
                s.settimeout(8)
                data = b""
                while True:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                answers.append(data)
        got = [statuses(a) for a in answers]
        # At most GUESS_QUEUE wrong guesses waited for their turn at once (and one turn comes per interval); the
        # rest were refused at once with 429 (or, not yet read when the cap was reached, closed to make room).
        self.assertLessEqual(got.count([401]), server.GUESS_QUEUE + seconds / 0.5 + 1)
        self.assertEqual(got.count([429]) + got.count([401]) + got.count([]), len(socks))
        self.assertGreater(got.count([429]), len(socks) // 2)
        refused = next(a for a in answers if statuses(a) == [429])
        self.assertIn(b"Retry-After: ", refused)
        self.assertIn(b'"too_many_guesses"', refused)

    def test_a_full_queue_refuses_the_login_form_and_redirects_page_loads(self):
        with mock.patch.object(server, "GUESS_QUEUE", 1, create=True), \
                mock.patch.object(server, "GUESS_INTERVAL", 1.0):
            self.guess(0)  # waits for its turn and fills the queue
            time.sleep(0.2)
            form = b"code=wrong"
            login = self.quick(lambda: self.exchange(
                b"POST /login HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: %d\r\n\r\n" % len(form) + form))
            self.assertEqual(statuses(login), [429])
            self.assertIn(b"Too many wrong codes", login)
            page = self.quick(lambda: self.exchange(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
                                                    b"Cookie: lwb_access=stale\r\n\r\n"))
            self.assertEqual(statuses(page), [303])
            self.assertIn(b"Location: /login", page)
            self.assertEqual(self.quick(lambda: self.carol.get("/api/whoami"))[0], 200)

    def test_busy_requests_are_never_closed_to_make_room(self):
        release, entered = threading.Event(), threading.Semaphore(0)

        def hold_route(h):
            entered.release()
            release.wait(10)
            return {"held": True}
        server.ROUTES.append(("GET", re.compile("^/api/test-hold$"), hold_route))
        self.addCleanup(server.ROUTES.pop)
        self.addCleanup(release.set)
        hold = (b"GET /api/test-hold HTTP/1.1\r\nHost: x\r\nConnection: close\r\nAuthorization: Bearer demo-carol\r\n"
                b"X-Access-Code: " + CODE.encode() + b"\r\n\r\n")
        held = self.connect(hold)
        self.assertTrue(entered.acquire(timeout=3))
        for _ in range(self.CAP):
            self.connect()
        time.sleep(0.2)
        self.assertEqual(self.quick(self.healthz), [200])  # an idle connection made room, not the held request
        release.set()
        held.settimeout(5)
        self.assertEqual(statuses(held.recv(65536)), [200])
        # Only when every connection is busy is a new one refused.
        release.clear()
        for _ in range(self.CAP):
            self.connect(hold)
        for _ in range(self.CAP):
            self.assertTrue(entered.acquire(timeout=3))
        self.assertEqual(self.healthz(), [])
        release.set()
        deadline = time.monotonic() + 3
        while self.healthz() != [200] and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.healthz(), [200])


@unittest.skipUnless(ui.NODE and os.path.isdir(ui.PLAYWRIGHT), "needs node and the Playwright package")
class UiGate(StackCase):
    run_ui = ui.UiFixes.run_ui

    def test_a_refused_stale_login_cookie_opens_the_login_page(self):
        """A cookie from an older access code is a wrong code; answered 429 (queue full), the UI still logs in again."""
        os.environ["LWB_ACCESS_CODE"] = CODE
        os.environ["LWB_COOKIE_SECURE"] = "0"
        self.addCleanup(os.environ.pop, "LWB_ACCESS_CODE", None)
        self.addCleanup(os.environ.pop, "LWB_COOKIE_SECURE", None)
        with mock.patch.object(server, "GUESS_QUEUE", 0):  # every wrong code is refused at once
            out = self.run_ui(r"""
async function scenario(ctx, page) {
  await page.fill('input[name="code"]', "%s");
  await Promise.all([page.waitForURL(BASE + "/"), page.click('button[type="submit"]')]);
  await idle(page);
  await ctx.addCookies([{ name: "lwb_access", value: "0".repeat(64), url: BASE }]);
  const refused = page.waitForResponse((r) => r.status() === 429);
  await page.click("#refresh");
  out.status = (await refused).status();
  await page.waitForURL("**/login", { timeout: 5000 }).catch(() => {});
  out.path = new URL(page.url()).pathname;
}
""".replace("%s", CODE))
        self.assertEqual(out, {"status": 429, "path": "/login"})

class ConsumerUpgrade(StackCase):
    def test_upgraded_consumer_db_backfills_the_pinned_source(self):
        """A consumer.db from before pinned_source existed still tracks new model heads (and ignores CMMS heads)."""
        self.release_a()
        self.deliver_all()
        self.assertEqual(self.cstate()["stream"]["pinned_source"], "synthmodeler")
        self.stack.close()
        db = sqlite3.connect(os.path.join(self.var, "consumer.db"))
        db.execute("ALTER TABLE stream_state DROP COLUMN pinned_source")  # the previous version's schema
        db.commit()
        db.close()
        from lucidwb.stack import Stack
        self.stack = Stack(self.var, wb_port=0, consumer_port=0, start_worker=False)
        self.carol = Client(self.stack.wb_url, "demo-carol")
        self.consumer = Client(self.stack.consumer_url, None)
        self.assertIsNone(self.cstate()["stream"]["pinned_source"])
        self.ok(self.imp("model/B_rename_gateway.json"))
        self.deliver_all()
        stream = self.cstate()["stream"]
        self.assertEqual((stream["pinned_revision"], stream["latest_known_head"], stream["pinned_source"]),
                         ("7c1e9a", "f02b44", "synthmodeler"))
        records = fixture("records/cmms_main.json")
        records["revision"], records["parent_revision"] = "m-20260902", "m-20260901"
        self.ok(self.carol.post("/manage/projects/ehm/imports", raw=json.dumps(records).encode()))
        self.deliver_all()
        self.assertEqual(self.cstate()["stream"]["latest_known_head"], "f02b44")


class ImporterRepairs(StackCase):
    def post(self, doc=None, raw=None):
        return self.carol.post("/manage/projects/ehm/imports", raw=raw or json.dumps(doc).encode())

    def import_rows(self):
        return len(self.ok(self.carol.get("/api/projects/ehm/imports"))["imports"])

    def test_f14_out_of_range_numbers_and_unstorable_text_are_not_500(self):
        parent = None
        for i, value in enumerate((10 ** 30, 2 ** 63, -(10 ** 25))):
            doc = fixture("model/A_initial.json")
            if parent:
                doc["revision"], doc["parent_revision"] = f"mult-{i}", parent
            doc["relationships"][0]["multiplicity"] = value
            body = self.ok(self.post(doc), 201)
            parent = body["revision"]
            with self.stack.app.db.tx() as c:
                stored = c.execute("SELECT rv.multiplicity FROM relationship_version rv JOIN snapshot_relationship sr "
                                   "ON sr.version_id=rv.version_id WHERE sr.snapshot_id=? AND rv.native_id=?",
                                   (body["snapshot_id"], doc["relationships"][0]["id"])).fetchone()[0]
            self.assertEqual(json.loads(stored), value)
        # Text the store cannot hold is refused like unparseable bytes: 400, never a 500.
        rows = self.import_rows()
        name = fixture("model/A_initial.json")
        name["elements"][0]["name"] = "Pump\ud800"
        key = fixture("model/A_initial.json")
        key["elements"][0]["properties"]["serial\udc00"] = "x"
        revision = fixture("model/A_initial.json")
        revision["revision"] = "r\ud800"
        raw = json.dumps(fixture("model/A_initial.json")).encode()
        deep = [raw[:-1] + b', "extra": ' + b"[" * n + b"]" * n + b"}" for n in (150, 976, 5000)]
        for body in [json.dumps(d).encode() for d in (name, key, revision)] + deep:
            st, out, _ = self.post(raw=body)
            self.assertEqual((st, out["error"]["code"]), (400, "invalid_input"), out)
        self.assertEqual(self.import_rows(), rows)

    def test_f12_resending_bytes_normalized_differently_before_an_upgrade_is_a_duplicate(self):
        self.ok(self.imp("model/A_initial.json"))
        el = next(e for e in fixture("model/A_initial.json")["elements"] if e["id"] == "el-VS101DE")
        el["properties"]["sampleInterval"] = 250
        delta = {"format": "lwb-synthetic-export/1", "source": "synthmodeler", "project": "ehm",
                 "revision": "d-nodefs", "parent_revision": "7c1e9a", "kind": "delta", "scope": {"kind": "complete"},
                 "elements": [el]}
        raw = json.dumps(delta).encode()
        self.ok(self.post(raw=raw), 201)
        # What the previous adapter stored: the delta normalized without its parent's definitions.
        with self.stack.app.db.tx() as c:
            c.execute("UPDATE source_snapshot SET normalized_digest=?, adapter_version=? WHERE revision='d-nodefs'",
                      (digest(normalize_model(delta)[0]), "lwb-synthetic-export-adapter/0.3.0"))
        body = self.ok(self.post(raw=raw), 200)
        self.assertEqual(body["outcome"], "duplicate_no_change")
        note = next(d for d in body["diagnostics"] if d["code"] == "stored_normalization_differs")
        self.assertEqual(note["stored_adapter_version"], "lwb-synthetic-export-adapter/0.3.0")
        # Different bytes under the same revision are still a conflict.
        el["properties"]["sampleInterval"] = 125
        st, body, _ = self.post(delta)
        self.assertEqual((st, body["outcome"]), (409, "quarantined_conflict"))


if __name__ == "__main__":
    unittest.main()
