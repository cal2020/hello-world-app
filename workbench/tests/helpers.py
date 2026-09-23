import os
import sys
import tempfile
import time
import unittest
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("LWB_QUIET", "1")

from lucidwb.stack import Stack  # noqa: E402
from scripts.client import Client  # noqa: E402
from scripts.seed import seed  # noqa: E402


class StackCase(unittest.TestCase):
    """Fresh workbench + consumer (temp databases, ephemeral ports) for every test."""
    worker = False  # tests drive outbox delivery explicitly unless they opt in

    def setUp(self):
        self.var = tempfile.mkdtemp(prefix="lwb-test-")
        self.stack = Stack(self.var, wb_port=0, consumer_port=0, start_worker=self.worker)
        self.carol = Client(self.stack.wb_url, "demo-carol")
        self.alice = Client(self.stack.wb_url, "demo-alice")
        self.bob = Client(self.stack.wb_url, "demo-bob")
        self.dana = Client(self.stack.wb_url, "demo-dana")
        self.admin = Client(self.stack.wb_url, "demo-admin")
        self.svc = Client(self.stack.wb_url, "demo-svc-consumer")
        self.consumer = Client(self.stack.consumer_url, None)
        seed(self.stack.wb_url)

    def tearDown(self):
        self.stack.close()

    # ------------------------------------------------------------ helpers
    def imp(self, rel, who=None, project="ehm", key=None):
        return (who or self.carol).import_fixture(rel, project=project, key=key)

    def ok(self, resp, *codes):
        st, body, _ = resp
        self.assertIn(st, codes or (200, 201), body)
        return body

    def approve(self, version, reason="reviewed in test"):
        self.ok(self.carol.post(f"/manage/projections/equipment-health/{version}/review",
                                {"decision": "approve", "reason": reason}))

    def build(self, version):
        return self.ok(self.carol.post("/manage/projects/ehm/releases",
                                       {"projection_id": "equipment-health", "version": version}), 201)

    def checks(self, rid):
        return self.ok(self.carol.post(f"/manage/releases/{rid}/consumer-checks"))

    def active(self):
        return self.ok(self.carol.get("/api/projects/ehm/releases"))["active_release_id"]

    def activate(self, rid, reason="test activation"):
        return self.carol.post(f"/manage/releases/{rid}/activate",
                               {"expected_active_release_id": self.active(), "reason": reason},
                               headers={"Idempotency-Key": str(uuid.uuid4())})

    def release_a(self):
        self.ok(self.imp("model/A_initial.json"))
        r = self.build("1.0.0")
        self.checks(r["release_id"])
        self.ok(self.activate(r["release_id"]))
        return r["release_id"]

    def heads(self):
        h = self.ok(self.carol.get("/api/projects/ehm/sources"))["heads"]
        return {x["source"]: x["revision"] for x in h}

    def entity(self, sid_native, snapshot=None):
        snaps = self.ok(self.carol.get("/api/projects/ehm/snapshots"))["snapshots"]
        if snapshot is None:
            heads = self.ok(self.carol.get("/api/projects/ehm/sources"))["heads"]
            snapshot = next(h["snapshot_id"] for h in heads if h["source"] == "synthmodeler")
        els = self.ok(self.carol.get(f"/api/projects/ehm/snapshots/{snapshot}/elements"))["elements"]
        return next((e for e in els if e["source_id"] == sid_native), None)

    def proposals(self, method="model", mode="fixture", who=None):
        return self.ok((who or self.alice).post("/manage/projects/ehm/proposal-runs",
                                                {"method": method, "mode": mode}), 201)

    def find_prop(self, run, record_id, target_source_id):
        for p in run["proposals"]:
            if p["record"]["id"] == record_id and (p["target"] or {}).get("source_id") == target_source_id:
                return p
        raise AssertionError(f"no proposal {record_id}->{target_source_id}")

    def accept(self, prop, who=None, key=None, etag=None, expected=None, reason="Serial in record matches."):
        who = who or self.alice
        fr = prop["freshness"]
        body = {"decision": "accept", "reason": reason,
                "expected_model_revision": (expected or fr)["model_head"],
                "expected_record_revision": (expected or fr)["record_head"]}
        return who.post(f"/manage/proposals/{prop['proposal_id']}/decision", body,
                        headers={"If-Match": etag or prop["etag"], "Idempotency-Key": key or str(uuid.uuid4())})

    def deliver_all(self, max_passes=20):
        outs = []
        for _ in range(max_passes):
            o = self.stack.app.worker.deliver_pass(force=True)
            if not o:
                break
            outs += o
        return outs

    def cstate(self):
        return self.ok(self.consumer.get("/state"))
