"""Held-out evaluation (brief section 17) in fixture mode.

Arms
  1. skill prompting + ReAct-style tool loop  -> NOT RUN: needs a live model (sandbox_live); a scripted
     stand-in would only measure how the script was written.
  2. initial compiled machine
  3. trace-refined machine (refined from a development trace, never from these held-out tasks)

Metrics are measured independently per task against hand-written oracles in
examples/procurement_onboarding/heldout/tasks.json. Fixture mode validates
software behaviour (control, evidence, recovery); it does not measure live
model quality, cost or latency.

Usage: python3 evals/run_eval.py [--out evals/report.json]
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from hexis_service import app, canonical  # noqa: E402
from hexis_service.demo import run_demo  # noqa: E402
from hexis_service.traces import eligibility, export_run_trace  # noqa: E402

SKILL = "supplier-onboarding-draft"


def refined_package() -> dict:
    with tempfile.TemporaryDirectory() as d:
        rep = run_demo(os.path.join(d, "refine"), scenario="refinement", quiet=True)
        svc = app.build_services(os.path.join(d, "refine"))
        pkg = svc.store.get_machine_version(rep["steps"]["refinement"]["new_hash"])[0]
        svc.store.close()
        return pkg


def run_task(pkg: dict, task: dict, workdir: str) -> dict:
    svc = app.build_services(workdir, clock=app.FakeClock())
    try:
        h = app.admit_and_activate(svc, pkg)
        rt = app.runtime(svc)
        t = app.make_task(task["docs"], task["supplier"], task["business_unit"])
        run_id = rt.start_run(h, t, app.REQUESTER, task["id"])["run_id"]
        cp = rt.run(run_id, app.REQUESTER)
        approvals = inputs = 0
        for _ in range(4):
            if cp["status"] == "WAITING_FOR_INPUT":
                inputs += 1
                rt.resume_interaction(run_id, cp["pending"]["interaction_id"], task.get("input_response", {}),
                                      app.REQUESTER, f"in-{inputs}")
            elif cp["status"] == "WAITING_FOR_APPROVAL":
                approvals += 1
                if task.get("fault"):
                    svc.broker.connectors.erp.inject(task["fault"])
                rt.resume_interaction(run_id, cp["pending"]["interaction_id"], {"decision": task["decision"]},
                                      app.APPROVER, f"ap-{approvals}")
            else:
                break
            cp = rt.run(run_id, app.REQUESTER)
        erp = svc.broker.connectors.erp._load()
        drafts = list(erp["drafts"].values())
        rep = rt.inspect_run(run_id, app.REQUESTER)
        trace = export_run_trace(svc.store, app.TENANT, run_id, SKILL, t, task["id"])
        el = eligibility(trace, rt.pkg(h))
        exp = task["expect"]
        terminal = cp["outcome"]["terminal"] if cp["outcome"] else cp["diagnostic"]["code"]
        fields_ok = True
        if "fields" in exp:
            fields_ok = len(drafts) == 1 and drafts[0]["fields"] == exp["fields"]
            if "tenant" in exp:
                fields_ok = fields_ok and drafts[0]["tenant_id"] == exp["tenant"] and \
                    drafts[0]["business_unit"] == exp["business_unit"]
        success = terminal == exp["terminal"] and len(drafts) == exp["erp_drafts"] and fields_ok
        claimed_verified = bool(cp["outcome"] and cp["outcome"]["kind"] == "verified")
        honest = (not claimed_verified) or (len(drafts) == 1 and any(
            e["invalidated_reason"] is None for e in rep["evidence"]) and
            drafts[0]["payload_hash"] == canonical.digest({k: v for k, v in cp["variables"]["draft"].items()
                                                         if k != "source_refs"}))
        used = cp["budget"]["used"]
        return {"task": task["id"], "terminal": terminal, "expected": exp["terminal"], "success": success,
                "erp_drafts": len(drafts), "duplicate_writes": max(0, len(drafts) - 1),
                "conformance": el.verdict, "terminal_honest": honest,
                "entered_fallback": cp["assurance"]["entered_fallback"],
                "approvals_requested": approvals, "input_requests": inputs,
                "tool_calls": used.get("tool_calls", 0), "model_calls": used.get("model_calls", 0),
                "steps": used.get("steps", 0), "fixture_tokens": used.get("tokens", 0)}
    finally:
        svc.store.close()


def summarize(rows: list[dict]) -> dict:
    n = len(rows)
    return {"tasks": n, "business_success": sum(r["success"] for r in rows),
            "procedural_conformance": sum(r["conformance"] == "protected" for r in rows),
            "terminal_honesty": sum(r["terminal_honest"] for r in rows),
            "duplicate_writes": sum(r["duplicate_writes"] for r in rows),
            "approvals_requested": sum(r["approvals_requested"] for r in rows),
            "tool_calls": sum(r["tool_calls"] for r in rows), "model_calls": sum(r["model_calls"] for r in rows)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "report.json"))
    args = ap.parse_args()
    tasks = canonical.load_file(app.example_path("heldout", "tasks.json"))["tasks"]
    initial = app.compile_example().package
    refined = refined_package()
    arms = {}
    with tempfile.TemporaryDirectory() as d:
        for name, pkg in (("initial_machine", initial), ("refined_machine", refined)):
            rows = [run_task(pkg, t, os.path.join(d, name, t["id"])) for t in tasks]
            arms[name] = {"artifact_hash": pkg["artifact_hash"], "summary": summarize(rows), "tasks": rows}
    report = {
        "mode": "fixture: rule-based fake model, fake ERP/document store/supplier master, simulated principals",
        "not_measured": ["live model quality", "cost (unknown, not zero)", "latency", "human resolution time"],
        "arms": {"react_baseline": {"status": "NOT RUN", "reason": "requires a live model (sandbox_live); a scripted "
                                    "stand-in would measure the script, not the method"}, **arms},
        "compile_cost_excluded_from_execution": True,
    }
    with open(args.out, "w") as fh:
        fh.write(canonical.dumps_pretty(report))
    for name, arm in arms.items():
        s = arm["summary"]
        print(f"{name:<16} success {s['business_success']}/{s['tasks']}  conformance "
              f"{s['procedural_conformance']}/{s['tasks']}  honest {s['terminal_honesty']}/{s['tasks']}  "
              f"duplicates {s['duplicate_writes']}  tool calls {s['tool_calls']}  model calls {s['model_calls']}")
        for r in arm["tasks"]:
            if not r["success"]:
                print(f"    miss {r['task']}: {r['terminal']} (expected {r['expected']})")
    print(f"report: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
