"""Fixture-mode evaluation: initial vs trace-refined machine on held-out synthetic tasks.

What this measures: software behavior (procedural conformance, terminal honesty, recovery, human
burden, engine step counts) with a deterministic fake model and fake connectors. What it does NOT
measure: live model quality, cost, latency, or the paper's reported gains. The direct-prompting
ReAct baseline arm requires a live model and is reported as NOT RUN.

Usage: python evals/run_eval.py [--out evals/results]
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

from hexis_service.canonical import digest
from hexis_service.demo import reference as R
from hexis_service.demo.env import TASK, ManualClock, admit_initial, build_env, compile_procurement, skill_source
from hexis_service.artifacts.registry import admit
from hexis_service.traces.model import export_run_trace
from hexis_service.traces.normalize import eligibility
from hexis_service.traces.update import archive_manifest, propose_update

HERE = Path(__file__).resolve().parent


def run_task(env, pkg, task):
    alice, bob = env.principal("user:alice"), env.principal("user:bob")
    inp = {**{k: TASK[k] for k in ("required_fields", "policy_version")}, **task["input"]}
    h = env.service.start_run(pkg.artifact_hash, inp, alice)
    res = env.service.run_until_blocked(h.run_id, alice)
    interactions = 0
    while res.status in ("WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT") and interactions < 6:
        interactions += 1
        ix = res.interaction or env.store.interaction_for_revision("acme", h.run_id, res.checkpoint.revision)
        if ix["type"] == "approval":
            env.service.resume_interaction(h.run_id, ix["interaction_id"], {"approval_decision": "approved",
                                           "scope_digest": ix["scope_digest"]}, bob)
        else:
            env.service.resume_interaction(h.run_id, ix["interaction_id"], task["responses"]["input"], alice)
        res = env.service.run_until_blocked(h.run_id, alice)
    cp = res.checkpoint
    trace = export_run_trace(env.service, h.run_id, alice)
    outcome = cp.outcome or {}
    cat = outcome.get("category", "none")
    expect = task["oracle"]["expect"]
    persisted = None
    if outcome.get("outputs", {}).get("erp_draft_id"):
        persisted = env.erp.read_draft({"draft_id": outcome["outputs"]["erp_draft_id"]}, {"tenant_id": "acme"})["draft"]
    fields_ok = persisted is not None and all(persisted.get(k) == v for k, v in task["oracle"]["fields"].items())
    creates = [r for r in env.store.receipts("acme", run_id=h.run_id) if r["tool"] == "erp.create_draft"
               and r["dispatch_state"] == "SUCCEEDED"]
    return {
        "task": task["id"], "status": res.status, "terminal": outcome.get("terminal"), "category": cat,
        "expected": expect,
        "business_success": (cat == "verified" and fields_ok) if expect == "verified"
        else (cat == {"review": "fallback"}.get(expect, expect)),
        "extraction_correct": fields_ok if expect == "verified" else None,
        "procedural_conformance": not eligibility(trace, env.service.package(cp.artifact_hash)),
        "terminal_honest": cat != "verified" or fields_ok,
        "duplicate_writes": max(0, len({r["external_ref"] for r in creates}) - 1),
        "entered_fallback": cp.assurance.entered_fallback,
        "human_interactions": interactions,
        "steps": cp.budget.steps, "tool_calls": cp.budget.tool_calls, "model_calls": cp.budget.model_calls,
        "tokens_fixture_estimate": cp.budget.tokens,
    }


def summarize(rows):
    n = len(rows)
    agg = lambda k: sum(1 for r in rows if r[k]) / n  # noqa: E731
    return {"tasks": n, "business_success": agg("business_success"), "procedural_conformance":
            agg("procedural_conformance"), "terminal_honesty": agg("terminal_honest"),
            "duplicate_writes": sum(r["duplicate_writes"] for r in rows), "fallback_rate": agg("entered_fallback"),
            "human_interactions": sum(r["human_interactions"] for r in rows),
            "mean_steps": sum(r["steps"] for r in rows) / n, "model_calls": sum(r["model_calls"] for r in rows)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "results"))
    args = ap.parse_args()
    tasks = json.loads((HERE / "heldout_tasks.json").read_text())["tasks"]
    initial = compile_procurement().package
    with tempfile.TemporaryDirectory() as tmp:
        env = build_env(tmp, clock=ManualClock())
        admit_initial(env, initial)
        dev = R.missing_docs_trace()  # development trace (not a held-out task)
        prop = propose_update(initial, dev, [], [], env.catalog, R.FixtureAligner(), skill_source().text)
        refined = prop.candidate
        admit(env.store, refined, env.catalog, expected_parent_hash=initial.artifact_hash,
              approver=env.principal("user:dana"), environment="sandbox",
              archive_manifest=archive_manifest([dev], []), now=env.clock(), skill_text=skill_source().text)
        arms = {"initial_compiled": [run_task(env, initial, t) for t in tasks],
                "trace_refined": [run_task(env, refined, t) for t in tasks]}
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=HERE).stdout.strip()
    result = {
        "mode": "fixture (deterministic fake model + fake connectors; software behavior only)",
        "environment": {"python": sys.version.split()[0], "platform": platform.platform(), "git_commit": commit,
                        "command": "python evals/run_eval.py"},
        "artifacts": {"initial": initial.artifact_hash, "refined": refined.artifact_hash},
        "task_set_digest": digest(tasks),
        "arms": {k: {"summary": summarize(v), "rows": v} for k, v in arms.items()},
        "not_run": {"direct_skill_prompting_react": "requires a live model adapter and credentials; not executed"},
        "repeats": 1, "note": "Deterministic fixtures: repeated runs are identical and are not independent samples.",
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    lines = ["# Fixture-mode evaluation (held-out synthetic tasks)", "",
             f"Mode: {result['mode']}. Commit `{commit[:12]}`. Tasks: {len(tasks)}. Repeats: 1 (deterministic).", "",
             "| Metric | initial_compiled | trace_refined |", "|---|---|---|"]
    s0, s1 = result["arms"]["initial_compiled"]["summary"], result["arms"]["trace_refined"]["summary"]
    for k in ("business_success", "procedural_conformance", "terminal_honesty", "duplicate_writes", "fallback_rate",
              "human_interactions", "mean_steps", "model_calls"):
        fmt = (lambda v: f"{v:.2f}") if isinstance(s0[k], float) else str
        lines.append(f"| {k} | {fmt(s0[k])} | {fmt(s1[k])} |")
    lines += ["", "| Task | expected | initial | refined |", "|---|---|---|---|"]
    for a, b in zip(arms["initial_compiled"], arms["trace_refined"]):
        lines.append(f"| {a['task']} | {a['expected']} | {a['terminal']} | {b['terminal']} |")
    lines += ["", "Direct skill prompting + ReAct baseline: **not run** (needs a live model).",
              "These numbers describe deterministic fixture behavior, not model quality or production performance."]
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
