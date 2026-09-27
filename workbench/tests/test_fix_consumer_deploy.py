"""Regression tests for the consumer and deployment fixes (cluster C4)."""
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import uuid

from tests.helpers import ROOT, StackCase, Stack
from scripts.client import FIX


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.status, r.read()


class Dockerfile(unittest.TestCase):
    def instructions(self):
        text = re.sub(r"\\\n", " ", (pathlib.Path(ROOT) / "Dockerfile").read_text())
        return [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]

    def test_no_volume_instruction(self):
        # Railway's Dockerfile builder refuses VOLUME; every platform mounts /data at runtime instead.
        self.assertEqual([l for l in self.instructions() if l.split()[0].upper() == "VOLUME"], [])

    def test_build_can_pass_code_version(self):
        ins = self.instructions()
        self.assertTrue(any(re.match(r"ARG\s+LWB_CODE_VERSION\b", l) for l in ins), ins)
        self.assertTrue(any(re.match(r"ENV\s.*\bLWB_CODE_VERSION=\$\{?LWB_CODE_VERSION\b", l) for l in ins), ins)


class ConsumerPort(unittest.TestCase):
    def test_stack_consumer_port_equal_to_workbench_port_does_not_crash(self):
        port = free_port()
        stack = Stack(tempfile.mkdtemp(prefix="lwb-test-"), wb_port=port, consumer_port=port, start_worker=False)
        try:
            self.assertEqual(stack.wb.server_address[1], port)
            self.assertNotEqual(stack.cons.server_address[1], port)
            self.assertEqual(get(stack.consumer_url + "/state")[0], 200)
            self.assertEqual(get(stack.wb_url + "/consumer/state")[0], 200)  # proxy follows the real port
        finally:
            stack.close()

    def test_run_py_reads_consumer_port_and_survives_port_collision(self):
        port = free_port()
        env = {k: v for k, v in os.environ.items()
               if k not in ("LWB_ACCESS_CODE", "LWB_RESET_ON_START", "LWB_SEED_ON_START", "LWB_PORT")}
        env |= {"PORT": str(port), "LWB_CONSUMER_PORT": str(port), "LWB_HOST": "127.0.0.1", "LWB_QUIET": "1",
                "LWB_VAR": tempfile.mkdtemp(prefix="lwb-test-")}
        proc = subprocess.Popen([sys.executable, "scripts/run.py"], cwd=ROOT, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            deadline, up = time.time() + 20, False
            while time.time() < deadline and proc.poll() is None and not up:
                try:
                    up = get(f"http://127.0.0.1:{port}/healthz")[0] == 200
                except OSError:
                    time.sleep(0.1)
            self.assertTrue(up, "workbench never became healthy")
            self.assertEqual(get(f"http://127.0.0.1:{port}/consumer/state")[0], 200)
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
            out = proc.communicate(timeout=20)[0]
        self.assertEqual(proc.returncode, 0, out)
        m = re.search(r"Consumer \(internal\): http://127\.0\.0\.1:(\d+)", out)
        self.assertTrue(m, out)
        self.assertNotIn(int(m.group(1)), (port, 8781))


class ConsumerView(StackCase):
    def test_gap_resync_keeps_link_details_and_revoked_links(self):
        self.release_a()
        run = self.proposals()
        l1 = self.ok(self.accept(self.find_prop(run, "MR-1001", "el-VS101DE")))["link_id"]
        self.deliver_all()
        # Not yet delivered: a second accept, a revoke of the first link, and a model head advance.
        self.ok(self.accept(self.find_prop(run, "MR-1005", "el-TS101")))
        self.ok(self.alice.post(f"/manage/links/{l1}/revoke", {"reason": "wrong sensor"},
                                headers={"Idempotency-Key": str(uuid.uuid4())}))
        self.ok(self.imp("model/B_rename_gateway.json"))
        last = max(self.ok(self.carol.get("/api/projects/ehm/history"))["outbox"], key=lambda e: e["seq"])
        out = self.ok(self.consumer.post("/events", {k: last[k] for k in ("event_id", "project", "seq", "type",
                                                                           "payload")}))
        self.assertEqual(out["handling"], "gap_resync")
        wb = {l["link_id"]: (l["record_id"], l["target_uid"], l["status"])
              for l in self.ok(self.carol.get("/api/projects/ehm/links"))["links"]}
        self.assertEqual(len(wb), 2)
        view = lambda: {l["link_id"]: (l["record_id"], l["target_uid"], l["status"]) for l in self.cstate()["links"]}
        self.assertEqual(view(), wb)
        self.deliver_all()  # the skipped events arrive late and are ignored; the view stays complete
        self.assertEqual(view(), wb)

    def test_records_import_is_not_a_newer_model_head(self):
        self.release_a()
        self.deliver_all()
        st = self.cstate()["stream"]
        self.assertEqual(st["latest_known_head"], st["pinned_revision"])
        doc = json.loads((FIX / "records/cmms_main.json").read_text())
        doc["revision"], doc["parent_revision"] = "m-20260902", "m-20260901"
        self.ok(self.carol.post("/manage/projects/ehm/imports", raw=json.dumps(doc).encode()), 201)
        self.deliver_all()
        st = self.cstate()["stream"]
        self.assertEqual(st["latest_known_head"], st["pinned_revision"])
        # A model head advance is still reported as newer than the pinned release.
        self.ok(self.imp("model/B_rename_gateway.json"))
        self.deliver_all()
        st = self.cstate()["stream"]
        self.assertEqual(st["latest_known_head"], self.heads()["synthmodeler"])
        self.assertNotEqual(st["latest_known_head"], st["pinned_revision"])


if __name__ == "__main__":
    unittest.main()
