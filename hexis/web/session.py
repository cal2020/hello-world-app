"""Browser bridge for the HEXIS demo page (runs inside Pyodide in a Web Worker).

Every call returns JSON built from the real runtime objects: checkpoints, events, action receipts
and evidence come from the same code the CLI and tests use. Nothing here fabricates results.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import traceback
import unittest

from hexis_service import app, canonical
from hexis_service.demo import run_demo

DATA = "/tmp/hexis-web"
PRESETS = {
    "clean": (["DOC-100"], "Northwind Components Ltd", "BU-EMEA"),
    "repair": (["DOC-200"], "Contoso Fasteners GmbH", "BU-NA"),
    "injection": (["DOC-666"], "Fabrikam Metals Inc", "BU-NA"),
    "existing": (["DOC-100"], "Existing Widgets plc", "BU-EMEA"),
    "missing": (["DOC-404"], "Northwind Components Ltd", "BU-EMEA"),
}
PRINCIPALS = {"u-approver": app.APPROVER, "u-requester": app.REQUESTER, "u-other": app.OTHER_TENANT_APPROVER}


class S:
    svc = None
    rt = None
    h = None
    run_id = None
    fault = "none"
    clock = None
    n = 0
    compile_report = None


def _boot(fresh: bool) -> None:
    if fresh:
        shutil.rmtree(DATA, ignore_errors=True)
        S.clock = app.FakeClock()
    S.svc = app.build_services(DATA, clock=S.clock)
    S.rt = app.runtime(S.svc)


def reset() -> dict:
    _boot(fresh=True)
    res = app.compile_example()
    S.h = app.admit_and_activate(S.svc, res.package)
    S.run_id = None
    S.compile_report = {"attempts": res.report["attempt_log"], "coverage": res.report["coverage"],
                        "artifact_hash": S.h}
    return {"compile": S.compile_report, "machine": res.package["machine"], "snapshot": snapshot(None)}


def snapshot(cp: dict | None, note: str = "", level: str = "info") -> dict:
    out = {"note": note, "level": level, "erp_drafts": S.svc.broker.connectors.erp.count() if S.svc else 0}
    if S.run_id is None:
        return out
    cp = cp or S.svc.store.latest_checkpoint(app.TENANT, S.run_id)
    rep = S.rt.inspect_run(S.run_id, app.REQUESTER)
    pending = None
    if cp["pending"]:
        inter = S.rt.interaction(app.TENANT, cp["pending"]["interaction_id"])
        pending = {"type": cp["pending"]["type"], "interaction_id": cp["pending"]["interaction_id"],
                   "prompt": inter["prompt"],
                   "args_digest": (inter.get("approval") or {}).get("args_digest"),
                   "draft": cp["variables"].get("draft")}
    visited = [e["from"] for e in rep["events"] if e["type"] == "transition"]
    out.update({
        "run_id": S.run_id, "status": cp["status"], "state_id": cp["state_id"], "revision": cp["revision"],
        "outcome": cp["outcome"], "diagnostic": cp["diagnostic"], "assurance": cp["assurance"],
        "budget": cp["budget"]["used"], "pending": pending, "visited": visited,
        "events": rep["events"], "actions": rep["actions"], "evidence": rep["evidence"],
        "variables": {k: cp["variables"].get(k) for k in ("documents_status", "lookup_status", "validation_status",
                                                          "repair_count", "approval_decision", "erp_status",
                                                          "draft_ref", "readback_status", "verify_status",
                                                          "mismatch_fields") if k in cp["variables"]},
    })
    return out


def start(preset: str, fault: str) -> dict:
    if S.svc is None:
        reset()
    docs, supplier, bu = PRESETS[preset]
    S.n += 1
    S.fault = fault
    run = S.rt.start_run(S.h, app.make_task(docs, supplier, bu), app.REQUESTER, f"web-{S.n}")
    S.run_id = run["run_id"]
    return snapshot(S.rt.run(S.run_id, app.REQUESTER))


def respond(who: str, decision: str) -> dict:
    cp = S.svc.store.latest_checkpoint(app.TENANT, S.run_id)
    if cp["pending"] is None:
        return snapshot(cp, "This run is not waiting for a response.", "warn")
    try:
        if cp["pending"]["type"] == "approval":
            if S.fault != "none" and decision == "approved":
                S.svc.broker.connectors.erp.inject(S.fault)
            S.rt.resume_interaction(S.run_id, cp["pending"]["interaction_id"], {"decision": decision},
                                    PRINCIPALS[who], f"resp-{S.n}-{cp['revision']}-{who}")
        else:
            with open(app.example_path("documents", "DOC-100.txt"), "rb") as fh:
                sha = canonical.sha256_hex(fh.read())
            S.rt.resume_interaction(S.run_id, cp["pending"]["interaction_id"],
                                    {"supplemental_refs": [{"doc_id": "DOC-100", "sha256": sha}]},
                                    PRINCIPALS[who], f"input-{S.n}-{cp['revision']}")
    except Exception as exc:  # refused approvals are shown, not hidden
        return snapshot(None, f"Refused for {who}: {exc}", "bad")
    return snapshot(S.rt.run(S.run_id, app.REQUESTER), f"Response recorded for {who}.", "ok")


def restart() -> dict:
    faults = list(S.svc.broker.connectors.erp.faults)
    S.svc.store.close()
    _boot(fresh=False)
    S.svc.broker.connectors.erp.faults = faults
    return snapshot(None, "Worker restarted: all in-memory objects were dropped and rebuilt from the "
                          "SQLite checkpoint and the ERP file.", "ok")


def demo(scenario: str) -> dict:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rep = run_demo("/tmp/hexis-demo", scenario=scenario, quiet=True)
    return {"lines": rep["transcript"], "steps": rep["steps"]}


def tests() -> dict:
    root = os.path.join(os.path.dirname(app.EXAMPLE_DIR), "..", "tests")
    root = os.path.normpath(root)
    sys.path.insert(0, root)
    suite = unittest.defaultTestLoader.discover(root)
    kept, skipped = unittest.TestSuite(), []

    def walk(s):
        for t in s:
            if isinstance(t, unittest.TestSuite):
                walk(t)
            elif "TestCLI" in t.id():  # needs subprocess, which the browser runtime does not have
                skipped.append(t.id())
            else:
                kept.addTest(t)

    walk(suite)
    buf = io.StringIO()
    result = unittest.TextTestRunner(stream=buf, verbosity=1).run(kept)
    return {"ran": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
            "skipped_in_browser": skipped, "ok": result.wasSuccessful(),
            "output": buf.getvalue()[-6000:]}


def dispatch(message: str) -> str:
    msg = json.loads(message)
    try:
        fn = {"reset": reset, "start": start, "respond": respond, "restart": restart, "demo": demo,
              "tests": tests}[msg["cmd"]]
        return json.dumps({"ok": True, "result": fn(**msg.get("args", {}))}, default=str)
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                           "trace": traceback.format_exc()[-3000:]})
