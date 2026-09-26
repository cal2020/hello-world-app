"""Offline procurement demonstration (brief §14 narrative). FIXTURE MODE throughout: fake model,
fake connectors, simulated identities. It demonstrates control, evidence, human interaction and
recovery behavior of this software -- not live model quality or real ERP semantics.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Callable

from ..artifacts.registry import admit
from ..compiler.compile import coverage_markdown
from ..traces.model import export_run_trace
from ..traces.update import apply_ops, archive_manifest, evaluate_candidate, propose_update
from . import reference as R
from .env import TASK, ManualClock, admit_initial, build_env, compile_procurement, skill_source


def _w(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data, indent=2, sort_keys=True, default=str) + "\n")


def _approve(env, run_id: str, ix: dict, who: str = "user:bob"):
    return env.service.resume_interaction(run_id, ix["interaction_id"],
                                          {"approval_decision": "approved", "scope_digest": ix["scope_digest"]},
                                          env.principal(who))


def run_demo(out_dir: str = "build/demo", scenario: str = "full", say: Callable[[str], None] = print) -> dict:
    out = Path(out_dir)
    if out.exists():
        shutil.rmtree(out)  # reset: the demo always starts from a documented empty state
    out.mkdir(parents=True)
    state = out / "state"
    summary: dict = {"mode": "fixture", "scenario": scenario, "steps": {}}
    clock = ManualClock()

    # 1. Compile ------------------------------------------------------------------------------ #
    say("== 1. Compile the supplier-onboarding skill (fixture compiler model) ==")
    comp = compile_procurement()
    for a in comp.attempts:
        codes = sorted({f["code"] for f in a["findings"]})
        say(f"   attempt {a['attempt']}: {a['status']} {codes if codes else ''}")
    pkg = comp.package
    _w(out / "initial_package.json", pkg.to_json())
    _w(out / "machine.initial.json", pkg.machine.to_json())
    _w(out / "compile_report.json", comp.to_json())
    _w(out / "coverage.md", "# Clause coverage (initial compile)\n\n" + coverage_markdown(comp.coverage) + "\n")
    say(f"   artifact {pkg.artifact_hash[:23]}… ; clauses needing review: {comp.review_required}")
    summary["steps"]["compile"] = {"status": comp.status, "attempts": len(comp.attempts),
                                   "artifact_hash": pkg.artifact_hash, "review_required": comp.review_required}

    env = build_env(str(state), clock=clock)
    adm = admit_initial(env, pkg)
    say(f"   admission by user:dana: {adm.status} (archive v{adm.archive_version})")

    # 2. Clean intake through extraction/validation, pause for approval ----------------------- #
    say("== 2. Run a clean intake: extraction, validation (one bounded repair), pause for approval ==")
    alice = env.principal("user:alice")
    h = env.service.start_run(pkg.artifact_hash, TASK, alice, request_id="demo-run-1")
    res = env.service.run_until_blocked(h.run_id, alice)
    ix = res.interaction
    say(f"   run {h.run_id}: {res.status}; approval scope {ix['scope_digest'][:23]}… binds "
        f"{ix['scope']['tool']} args {ix['scope']['args_digest'][:19]}…")

    # 3. Restart the worker, resume on authenticated approval --------------------------------- #
    say("== 3. Restart the worker process; resume from persisted state with an authenticated approval ==")
    env = env.restart()
    try:
        env.service.resume_interaction(h.run_id, ix["interaction_id"],
                                       {"approval_decision": "approved", "scope_digest": ix["scope_digest"]}, alice)
    except Exception as exc:  # noqa: BLE001
        say(f"   initiator self-approval refused: {exc}")
    # 4. Timeout after the ERP commits ---------------------------------------------------------- #
    if scenario in ("full", "timeout-after-commit"):
        env.erp.inject("timeout_after_commit")
        say("== 4. Fault injected: the fake ERP commits, then the call times out ==")
    _approve(env, h.run_id, ix)
    res = env.service.run_until_blocked(h.run_id, alice)
    rep = env.service.inspect_run(h.run_id, alice)
    recon = [e for e in rep["events"] if e["type"] in ("EFFECT_UNKNOWN", "RECONCILED")]
    for e in recon:
        say(f"   {e['type']}: {e.get('status', '')} {e.get('reason', '')}")
    say(f"   ERP drafts for tenant acme: {env.erp.count('acme')} (no duplicate)")

    # 5. Evidence-linked record ------------------------------------------------------------------ #
    say("== 5. Final evidence-linked execution record ==")
    say(f"   status {res.status}; outcome {res.checkpoint.outcome['terminal'] if res.checkpoint.outcome else None}")
    say(f"   verification scope: {res.checkpoint.assurance.verification_scope}")
    _w(out / "execution_record.json", {k: rep[k] for k in ("run", "outcome", "assurance", "path", "action_intents",
                                                             "action_receipts", "evidence")})
    summary["steps"]["run"] = {"run_id": h.run_id, "status": res.status, "outcome": res.checkpoint.outcome,
                               "erp_drafts": env.erp.count("acme"), "reconciliation_events": [e["type"] for e in recon]}

    # Seed the protected archive with run traces (verified path + registry-conflict review path)
    t_main = export_run_trace(env.service, h.run_id, alice, "accepted")
    h2 = env.service.start_run(pkg.artifact_hash, dict(TASK, supplier_ref="SUP-55555"), alice)
    r2 = env.service.run_until_blocked(h2.run_id, alice)
    t_conflict = export_run_trace(env.service, h2.run_id, alice, "accepted")
    say(f"   second run (registry conflict) ended {r2.checkpoint.outcome['terminal']} ({r2.checkpoint.outcome['category']})")
    protected, negative = [t_main, t_conflict], []
    for t in protected:
        _w(out / "traces" / (t.trace_id.replace(":", "_") + ".jsonl"), t.to_jsonl())

    # 6a. Accept a legitimate trace-driven refinement ------------------------------------------ #
    say("== 6a. Trace-driven refinement: documents missing → request input once ==")
    dev = R.missing_docs_trace()
    _w(out / "traces" / "dev_missing_docs.jsonl", dev.to_jsonl())
    prop = propose_update(pkg, dev, protected, negative, env.catalog, R.FixtureAligner(), skill_source().text)
    say(f"   proposal: {prop.status}; gates: "
        f"{ {k: v['passed'] for k, v in prop.gates.items() if isinstance(v, dict)} }")
    _w(out / "update_proposal.missing_docs.json", prop.to_json())
    refined = prop.candidate
    adm2 = admit(env.store, refined, env.catalog, expected_parent_hash=pkg.artifact_hash,
                 approver=env.principal("user:dana"), environment="sandbox",
                 archive_manifest=archive_manifest(protected + [dev], negative), now=clock(),
                 skill_text=skill_source().text)
    say(f"   admission (CAS on parent {pkg.artifact_hash[7:19]}): {adm2.status}")
    _w(out / "refined_package.json", refined.to_json())
    _w(out / "machine.refined.json", refined.machine.to_json())
    _w(out / "update_diff.json", prop.diff)
    protected = protected + [dev]
    # exercise the refined machine live on the new situation
    h3 = env.service.start_run(refined.artifact_hash, dict(TASK, supplier_ref="SUP-40002",
                                                           document_ids=["DOC-LATE-MISSING"]), alice)
    r3 = env.service.run_until_blocked(h3.run_id, alice)
    say(f"   refined machine, missing documents: {r3.status}")
    r3 = env.service.resume_interaction(h3.run_id, r3.interaction["interaction_id"],
                                        {"document_ids": ["DOC-LATE-40002"]}, alice)
    r3 = env.service.run_until_blocked(h3.run_id, alice)
    r3 = _approve(env, h3.run_id, r3.interaction)
    r3 = env.service.run_until_blocked(h3.run_id, alice)
    say(f"   after input + approval: {r3.status} {r3.checkpoint.outcome['terminal']}")
    summary["steps"]["refine"] = {"proposal": prop.status, "admission": adm2.status, "refined_hash":
                                  refined.artifact_hash, "refined_run": r3.checkpoint.outcome}

    # 6b. Reject a shortcut that skips validation --------------------------------------------- #
    say("== 6b. Proposed shortcut: repair → approval without re-validation ==")
    active_before = env.store.get_active("sandbox", refined.machine.skill_id)
    sc = R.shortcut_trace()
    p_sc = propose_update(refined, sc, protected, negative, env.catalog, R.ShortcutAligner(), skill_source().text)
    say(f"   trace eligibility: {p_sc.status} - {p_sc.diagnostics}")
    negative = negative + [sc]
    cand = apply_ops(refined, R.ShortcutAligner().propose({}))
    gates = evaluate_candidate(refined, cand, sc, protected, negative, env.catalog, skill_source().text)
    viol = [f for f in gates["static_validation"]["findings"] if f["code"] == "ORDERING_VIOLATION"]
    for f in viol:
        say(f"   static gate: {f['message']}\n      counterexample path: {' → '.join(f['detail']['path'])}")
    say(f"   negative-corpus gate passed: {gates['negative_corpus']['passed']} "
        f"(now representable: {gates['negative_corpus']['now_representable']})")
    active_after = env.store.get_active("sandbox", refined.machine.skill_id)
    say(f"   active version unchanged: {active_before == active_after} ({active_after[0][:23]}…, archive "
        f"v{active_after[1]})")
    _w(out / "shortcut_rejection.json", {"eligibility": p_sc.to_json(), "candidate_gates": gates,
                                         "active_before": active_before, "active_after": active_after})
    summary["steps"]["shortcut"] = {"eligibility": p_sc.status, "static_gate_passed": gates["static_validation"]
                                    ["passed"], "negative_gate_passed": gates["negative_corpus"]["passed"],
                                    "active_unchanged": active_before == active_after}
    _w(out / "summary.json", summary)
    say(f"== done. Artifacts in {out}/ ==")
    return summary
