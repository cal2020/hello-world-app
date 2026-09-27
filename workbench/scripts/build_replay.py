"""Record the five-minute walkthrough against a private stack and build a self-contained replay page.

  .venv/bin/python scripts/build_replay.py OUT.html

The page is the real workbench UI (web/index.html, web/app.js, web/style.css) with a fetch shim that answers
every GET from the responses recorded after each step. Nothing runs in the page: write actions answer with a
"this is a recording" error, and a step bar moves between recorded states. Synthetic data only.
"""
import hashlib
import json
import pathlib
import re
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import os  # noqa: E402

os.environ["LWB_QUIET"] = "1"
from lucidwb.stack import Stack  # noqa: E402
from scripts.client import Client  # noqa: E402
from scripts.seed import seed  # noqa: E402

TOKENS = ["demo-alice", "demo-bob", "demo-carol", "demo-dana", "demo-admin"]
KEEP_HEADERS = ("ETag", "Idempotent-Replay", "Idempotency-Key", "Content-Location")


class Recorder:
    def __init__(self, stack):
        self.s = stack
        self.blobs = {}      # sha -> response body
        self.steps = []
        self.log = []

    def blob(self, obj):
        key = hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:16]
        self.blobs[key] = obj
        return key

    def call(self, who, method, path, body=None, raw=None, headers=None, note=None):
        c = Client(self.s.wb_url, who)
        st, out, hdr = c.req(method, path, body=body, raw=raw, headers=headers)
        self.log.append({"who": who, "method": method, "path": path, "status": st, "note": note,
                         "request_headers": {k: v for k, v in (headers or {}).items() if k in ("If-Match", "Idempotency-Key")},
                         "headers": {k: hdr[k] for k in KEEP_HEADERS if k in hdr}, "body": out})
        return st, out, hdr

    def deliver_all(self):
        outs = []
        for _ in range(20):
            o = self.s.app.worker.deliver_pass(force=True)
            if not o:
                break
            outs += o
        return outs

    def crawl(self):
        resp = {}

        def get(token, path):
            st, body, hdr = Client(self.s.wb_url, token).get(path)
            resp[f"{token} {path}" if path in ("/api/whoami", "/api/projects") else path] = {
                "status": st, "headers": {k: hdr[k] for k in KEEP_HEADERS if k in hdr}, "body": self.blob(body)}
            return st, body

        for t in TOKENS:
            get(t, "/api/whoami")
            get(t, "/api/projects")
        for token, project in (("demo-carol", "ehm"), ("demo-dana", "radar")):
            base = f"/api/projects/{project}"
            got = {}
            for name in ("sources", "snapshots", "imports", "releases", "projections", "proposals", "records",
                         "links", "history"):
                got[name] = get(token, f"{base}/{name}")[1]
            snaps = [s["snapshot_id"] for s in (got["snapshots"] or {}).get("snapshots", [])]
            for sid in snaps:
                _, els = get(token, f"{base}/snapshots/{sid}/elements")
                for e in (els or {}).get("elements", []):
                    get(token, f"{base}/entities/{e['entity_uid']}/history")
            for a in snaps:
                for b in snaps:
                    if a != b:
                        get(token, f"{base}/diff?from={a}&to={b}")
            for r in (got["releases"] or {}).get("releases", []):
                get(token, f"/api/releases/{r['release_id']}")
                get(token, f"/api/releases/{r['release_id']}/openapi.json")
            for p in (got["proposals"] or {}).get("proposals", []):
                get(token, f"/api/proposals/{p['proposal_id']}")
        return resp

    def step(self, title, who, look, fn):
        self.log = []
        fn()
        st, cons, _ = Client(self.s.consumer_url, None).get("/state")
        self.steps.append({"title": title, "who": who, "look": look, "actions": self.log,
                           "responses": self.crawl(), "consumer": self.blob(cons)})
        print(f"recorded: {title} ({len(self.log)} actions)")


def main(out_path):
    var = tempfile.mkdtemp(prefix="lwb-replay-")
    s = Stack(var, wb_port=0, consumer_port=0, start_worker=False)
    R = Recorder(s)
    fix = lambda rel: (ROOT / "fixtures" / rel).read_bytes()  # noqa: E731
    ctx = {}
    try:
        def s0():
            seed(s.wb_url)
            R.deliver_all()
        R.step("Starting point", "carol",
               "Projection 1.0.0 is reviewed and the maintenance records are loaded. No model has been imported yet.", s0)

        def s1():
            R.call("demo-carol", "POST", "/manage/projects/ehm/imports", raw=fix("model/A_initial.json"),
                   headers={"Idempotency-Key": "replay-import-a"}, note="Import model A")
            st, rel, _ = R.call("demo-carol", "POST", "/manage/projects/ehm/releases",
                                {"projection_id": "equipment-health", "version": "1.0.0"}, note="Build candidate from projection 1.0.0")
            ctx["rel_a"] = rel["release_id"]
            R.call("demo-carol", "POST", f"/manage/releases/{rel['release_id']}/consumer-checks", note="Run consumer checks")
            R.call("demo-carol", "POST", f"/manage/releases/{rel['release_id']}/activate",
                   {"expected_active_release_id": None, "reason": "initial release"},
                   headers={"Idempotency-Key": "replay-activate-a"}, note="Activate")
            R.deliver_all()
        R.step("Import model A and publish it", "carol",
               "Model explorer: import accepted_head, 12 elements. Release panel: the candidate passed its checks and is "
               "active. Consumer panel below: pinned to revision 7c1e9a.", s1)

        def s2():
            R.call("demo-carol", "POST", "/manage/projects/ehm/imports", raw=fix("model/A_initial.json"),
                   headers={"Idempotency-Key": "replay-import-a-again"}, note="Import model A again")
            R.deliver_all()
        R.step("Send the same model again", "carol",
               "Import receipts: the second import is duplicate_no_change and points at the first. Counts are identical "
               "and no new event was queued.", s2)

        def s3():
            R.call("demo-alice", "POST", "/manage/projects/ehm/proposal-runs", {"method": "deterministic"},
                   note="Run proposals: deterministic baseline")
            st, fx, _ = R.call("demo-alice", "POST", "/manage/projects/ehm/proposal-runs",
                               {"method": "model", "mode": "fixture"}, note="Run proposals: fixture model (scripted outputs)")
            props = fx["proposals"]
            de = next(p for p in props if p["record"]["id"] == "MR-1003" and p["target"]["source_id"] == "el-VS101DE")
            nde = next(p for p in props if p["record"]["id"] == "MR-1003" and p["target"]["source_id"] == "el-VS101NDE")
            ctx["gw"] = next(p for p in props if p["record"]["id"] == "MR-1004" and p["target"])
            R.call("demo-alice", "POST", f"/manage/proposals/{de['proposal_id']}/decision",
                   {"decision": "reject", "reason": "N-2 says the NDE unit was recalibrated."},
                   headers={"If-Match": de["etag"], "Idempotency-Key": "replay-reject-de"}, note="Reject MR-1003 → DE sensor")
            fr = nde["freshness"]
            R.call("demo-alice", "POST", f"/manage/proposals/{nde['proposal_id']}/decision",
                   {"decision": "accept", "reason": "N-2: NDE unit, serial ending 4472.",
                    "expected_model_revision": fr["model_head"], "expected_record_revision": fr["record_head"]},
                   headers={"If-Match": nde["etag"], "Idempotency-Key": "replay-accept-nde"}, note="Accept MR-1003 → NDE sensor")
            R.deliver_all()
        R.step("Review proposed links", "carol → alice",
               "Relationship review: the FIXTURE MODE label, a struck-through made-up quote, the forged note N-3 that "
               "gains no authority, and two competing candidates for MR-1003. One link is now reviewer_accepted.", s3)

        def s4():
            R.call("demo-carol", "POST", "/manage/projects/ehm/imports", raw=fix("model/B_rename_gateway.json"),
                   headers={"Idempotency-Key": "replay-import-b"}, note="Import model B (gateway renamed)")
            gw = ctx["gw"]
            R.call("demo-alice", "POST", f"/manage/proposals/{gw['proposal_id']}/decision",
                   {"decision": "accept", "reason": "Edge gateway north = GW1",
                    "expected_model_revision": gw["freshness"]["model_head"],
                    "expected_record_revision": gw["freshness"]["record_head"]},
                   headers={"If-Match": gw["etag"], "Idempotency-Key": "replay-accept-gw"},
                   note="Accept MR-1004 using the view from before model B (expected: refused)")
            R.call("demo-carol", "POST", "/manage/projects/ehm/imports", raw=fix("model/C_remove_serial_field.json"),
                   headers={"Idempotency-Key": "replay-import-c"}, note="Import model C (serialNumber removed)")
            st, rel, _ = R.call("demo-carol", "POST", "/manage/projects/ehm/releases",
                                {"projection_id": "equipment-health", "version": "1.0.0"}, note="Build candidate on C")
            R.call("demo-carol", "POST", f"/manage/releases/{rel['release_id']}/consumer-checks", note="Run consumer checks")
            R.call("demo-carol", "POST", f"/manage/releases/{rel['release_id']}/activate",
                   {"expected_active_release_id": ctx["rel_a"], "reason": "try C"},
                   headers={"Idempotency-Key": "replay-activate-c-blocked"}, note="Try to activate (expected: refused)")
            R.deliver_all()
        R.step("Change the model", "carol → alice → carol",
               "Model B keeps the gateway's identity. The old approval is refused (409 stale_dependency). The C candidate "
               "is blocked_generation and activation is refused; the release panel shows the consumer still on A, "
               "2 versions behind.", s4)

        def s5():
            R.call("demo-carol", "POST", "/manage/projects/ehm/projections/equipment-health/1.1.0/review",
                   {"decision": "approve", "reason": "Map serialNumber to renamed assetSerial; shape unchanged."},
                   note="Approve projection 1.1.0")
            st, rel, _ = R.call("demo-carol", "POST", "/manage/projects/ehm/releases",
                                {"projection_id": "equipment-health", "version": "1.1.0"}, note="Build candidate from 1.1.0")
            ctx["rel_d"] = rel["release_id"]
            R.call("demo-carol", "POST", f"/manage/releases/{rel['release_id']}/consumer-checks", note="Run consumer checks")
            R.deliver_all()
        R.step("Fix it without changing the API", "carol",
               "Open the newest release: its contract diff against the active release is empty and it passed its checks. "
               "It is not active yet.", s5)

        def s6():
            R.deliver_all()
            R.call("demo-carol", "POST", "/manage/projects/ehm/outbox/pause", note="Outbox: pause")
            R.call("demo-carol", "POST", "/manage/consumer/faults", {"drop_ack_after_commit": 1},
                   note="Inject lost-ack fault")
            body = {"expected_active_release_id": ctx["rel_a"], "reason": "C with compatible projection"}
            R.call("demo-carol", "POST", f"/manage/releases/{ctx['rel_d']}/activate", body,
                   headers={"Idempotency-Key": "replay-activate-d"}, note="Activate")
            R.call("demo-carol", "POST", "/manage/projects/ehm/outbox/deliver", note="Outbox: deliver now (ack lost)")
            R.call("demo-carol", "POST", "/manage/projects/ehm/outbox/deliver", note="Outbox: deliver now (retry)")
            R.call("demo-carol", "POST", "/manage/projects/ehm/outbox/resume", note="Outbox: resume")
            R.call("demo-carol", "POST", f"/manage/releases/{ctx['rel_d']}/activate", body,
                   headers={"Idempotency-Key": "replay-activate-d"}, note="Retry the activation with the same key")
            R.deliver_all()
        R.step("Survive a lost acknowledgment", "carol",
               "Consumer panel: the activation event was delivered twice but has one effect. Operation history: attempt 1 "
               "no_acknowledgment, attempt 2 acknowledged. The retried activation came back with Idempotent-Replay: true.", s6)
    finally:
        s.close()

    data = {"steps": R.steps, "blobs": R.blobs}
    build_page(data, pathlib.Path(out_path))


def build_page(data, out):
    web = ROOT / "web"
    index = (web / "index.html").read_text()
    body = index[index.index("<body>") + len("<body>"):index.index('<script src="/web/app.js">')]
    style = (web / "style.css").read_text()
    app = (web / "app.js").read_text()
    shell = (ROOT / "scripts" / "replay_shell.html").read_text()
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    page = (shell.replace("/*__APP_CSS__*/", style)
                 .replace("<!--__APP_BODY__-->", body)
                 .replace("/*__DATA__*/null", payload)
                 .replace("/*__APP_JS__*/", app.replace("</script", "<\\/script")))
    out.write_text(page)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(data['steps'])} steps, {len(data['blobs'])} unique responses)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "replay.html")
