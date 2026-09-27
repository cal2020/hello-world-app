"""Offline procurement demonstration (brief section 14, "Demonstration narrative").

Everything runs in fixture mode: deterministic compiler model, rule-based fake
extraction model, fake ERP/document store/supplier master, simulated host
principals. No API keys or network. The printed record labels the mode.
"""
from __future__ import annotations

import os
import shutil

from . import app, canonical
from .connectors import CallContext, verify_persisted
from .traces import (dumps_jsonl, eligibility, export_recorded, export_run_trace, make_trace, recorded_replay,
                     structural_replay)
from .update import DeterministicAligner, admit_update, gate_candidate, propose_update

SCENARIOS = ("full", "timeout-after-commit", "shortcut-rejection", "refinement")


class Printer:
    def __init__(self, quiet: bool = False):
        self.quiet = quiet
        self.lines: list[str] = []

    def __call__(self, text: str = "") -> None:
        self.lines.append(text)
        if not self.quiet:
            print(text)

    def h(self, text: str) -> None:
        self("")
        self(f"== {text}")


def _drive_to_approval(rt, h, task, request_id, p):
    run = rt.start_run(h, task, app.REQUESTER, request_id)
    cp = rt.run(run["run_id"], app.REQUESTER)
    return run["run_id"], cp


def run_demo(data_dir: str, scenario: str = "full", quiet: bool = False) -> dict:
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario!r}; choose from {SCENARIOS}")
    if os.path.exists(data_dir):
        shutil.rmtree(data_dir)
    os.makedirs(data_dir)
    p = Printer(quiet)
    report: dict = {"mode": "fixture (deterministic models and connectors; not a measure of live model quality)",
                    "scenario": scenario, "steps": {}}
    clock = app.FakeClock()

    # 1. compile -------------------------------------------------------------------------------
    p.h("1. Compile SKILL.md into an EFSM (fixture compiler model)")
    result = app.compile_example()
    for a in result.report["attempt_log"]:
        codes = ", ".join(f"{f['code']}@{f['location']}" for f in a["findings"]) or "no findings"
        p(f"  draft attempt {a['attempt']}: {'valid' if a['ok'] else 'rejected'} ({codes})")
    p("  clause coverage:")
    for c in result.report["coverage"]:
        p(f"    {c['clause']:<34} {c['classification']:<22} {'critical' if c['critical'] else '        '} "
          f"{', '.join(c['states']) or '-'}")
    pkg = result.package
    p(f"  unadmitted package {pkg['artifact_hash']}")
    with open(os.path.join(data_dir, "package.initial.json"), "w") as fh:
        fh.write(canonical.dumps_pretty(pkg))
    report["steps"]["compile"] = {"ok": result.ok, "attempts": result.report["attempts"],
                                  "artifact_hash": pkg["artifact_hash"]}

    svc = app.build_services(data_dir, clock=clock)
    h = app.admit_and_activate(svc, pkg)
    p(f"  admitted and activated (signature key: {svc.registry.admission(h)['key_id']})")
    rt = app.runtime(svc)
    protected: list[dict] = []
    task = app.load_example_inputs()["task"]

    if scenario in ("full", "timeout-after-commit"):
        # 2-3. clean intake, pause for approval, restart, resume ---------------------------------
        p.h("2. Run a clean intake through extraction and validation")
        run_id, cp = _drive_to_approval(rt, h, task, "demo-main", p)
        p(f"  run {run_id}: status={cp['status']} state={cp['state_id']} "
          f"validation={cp['variables'].get('validation_status')}")
        p.h("3. Pause for approval, restart the worker, resume")
        svc.store.close()
        svc = app.build_services(data_dir, clock=clock)  # a fresh process: nothing held in memory
        rt = app.runtime(svc)
        waiting = svc.store.latest_checkpoint(app.TENANT, run_id)
        inter = rt.interaction(app.TENANT, waiting["pending"]["interaction_id"])
        p(f"  new worker sees {waiting['status']} for interaction {inter['interaction_id']} "
          f"(args digest {inter['approval']['args_digest'][:23]}...)")
        try:
            rt.resume_interaction(run_id, inter["interaction_id"], {"decision": "approved"}, app.REQUESTER, "self")
        except Exception as exc:  # the initiator cannot approve their own action
            p(f"  self-approval refused: {exc}")
        # 4. timeout after commit -----------------------------------------------------------------
        p.h("4. Inject a timeout after the fake ERP commits; reconcile without duplicating")
        svc.broker.connectors.erp.inject("timeout_after_commit")
        rt.resume_interaction(run_id, inter["interaction_id"], {"decision": "approved"}, app.APPROVER, "approve-1")
        cp = rt.run(run_id, app.REQUESTER)
        rec_events = [e for e in svc.store.events(app.TENANT, run_id) if e["type"] == "reconciling"]
        p(f"  reconciling events: {len(rec_events)}; ERP drafts stored: {svc.broker.connectors.erp.count()}")
        p(f"  run status={cp['status']} outcome={cp['outcome'] and cp['outcome']['terminal']}")
        # 5. evidence-linked record ---------------------------------------------------------------
        p.h("5. Evidence-linked execution record")
        rep = rt.inspect_run(run_id, app.REQUESTER)
        for e in rep["events"]:
            if e["type"] == "transition":
                p(f"    r{e['revision']:<3} {e['from']:<18} -> {e['to']:<20} {e['guard'] or '(default)'}")
            elif e["type"] != "run_started":
                p(f"    r{e.get('revision', 0):<3} {e['type']}" + (f" {e.get('terminal')}" if e.get("terminal") else ""))
        for a in rep["actions"]:
            if a["tool"] == "erp.create_draft":
                p(f"  ERP action {a['logical_action_id']}: status={a['status']} attempts={a['attempts']} "
                  f"external_ref={a['external_ref']}")
                for r in a["receipts"]:
                    p(f"    receipt {r['receipt_id']}: {r['dispatch_state']} / {r['certainty']}")
        for ev in rep["evidence"]:
            p(f"  evidence {ev['receipt_id']}: {ev['verifier']} on {ev['subject']['draft_ref']} "
              f"v{ev['subject']['version']} ({ev['claim']}); invalidated={ev['invalidated_reason']}")
        if cp["assurance"]["verification_scope"]:
            p(f"  verification scope: {cp['assurance']['verification_scope']['claim']}")
        report["steps"]["main_run"] = {"run_id": run_id, "status": cp["status"], "outcome": cp["outcome"],
                                       "erp_drafts": svc.broker.connectors.erp.count(),
                                       "reconciliations": len(rec_events)}
        trace = export_run_trace(svc.store, app.TENANT, run_id, "supplier-onboarding-draft", task, "trace-main")
        protected.append(trace)
        rec = export_recorded(svc.store, app.TENANT, run_id, task)
        rr = recorded_replay(rt.pkg(h), rec)
        p(f"  recorded replay (network disabled): {rr.result} over {rr.detail.get('revisions')} revisions")
        report["steps"]["recorded_replay"] = rr.to_dict()
        with open(os.path.join(data_dir, "trace-main.jsonl"), "w") as fh:
            fh.write(dumps_jsonl(trace))

    if scenario in ("full", "shortcut-rejection", "refinement"):
        # build a small protected archive: repair path and an honest unverified outcome
        t2 = app.make_task(["DOC-200"], "Contoso Fasteners GmbH")
        r2, cp2 = _drive_to_approval(rt, h, t2, "demo-repair", p)
        rt.resume_interaction(r2, cp2["pending"]["interaction_id"], {"decision": "rejected"}, app.APPROVER, "rej-2")
        cp2 = rt.run(r2, app.REQUESTER)
        protected.append(export_run_trace(svc.store, app.TENANT, r2, "supplier-onboarding-draft", t2, "trace-rejected"))
        t3 = app.make_task(["DOC-100"], "Existing Widgets plc")
        r3 = rt.start_run(h, t3, app.REQUESTER, "demo-existing")["run_id"]
        cp3 = rt.run(r3, app.REQUESTER)
        protected.append(export_run_trace(svc.store, app.TENANT, r3, "supplier-onboarding-draft", t3, "trace-existing"))
        p.h("Protected archive")
        for t in protected:
            el = eligibility(t, rt.pkg(h))
            p(f"  {t['header']['trace_id']:<16} {len(t['records'])} events, terminal "
              f"{t['records'][-1].get('terminal')}, eligibility={el.verdict}")

    if scenario in ("full", "shortcut-rejection"):
        # 6. shortcut rejection ------------------------------------------------------------------
        p.h("6. Propose a trace-driven shortcut that skips validation")
        good = protected[0] if protected[0]["header"]["trace_id"] == "trace-main" else None
        base_task = task
        if good is None:
            r, c = _drive_to_approval(rt, h, task, "demo-main-b", p)
            rt.resume_interaction(r, c["pending"]["interaction_id"], {"decision": "approved"}, app.APPROVER, "ap-b")
            rt.run(r, app.REQUESTER)
            good = export_run_trace(svc.store, app.TENANT, r, "supplier-onboarding-draft", task, "trace-main")
            protected.insert(0, good)
        recs = [dict(r) for r in good["records"] if r.get("tool") != "draft.validate"]
        for r in recs:
            r.pop("seq", None)
        shortcut = make_trace("trace-shortcut", "supplier-onboarding-draft", base_task, recs, source="operator-log")
        el = eligibility(shortcut, rt.pkg(h))
        p(f"  independent eligibility check: {el.verdict} ({'; '.join(el.reasons)})")
        prop = propose_update(svc.store.get_machine_version(h)[0], shortcut, protected, [],
                              [DeterministicAligner()])
        p(f"  propose_update: {prop.status} (the trace never reaches the aligner)")
        # Independently of eligibility, show that the gates reject the shortcut an alignment model might propose.
        before = svc.registry.active(app.TENANT, "supplier-onboarding-draft")
        parent_raw = svc.store.get_machine_version(h)[0]
        ops = {"retarget_default": [{"state": "EXTRACT_DRAFT", "to": "REQUEST_APPROVAL"}],
               "rationale": "operator log goes from extraction straight to approval"}
        rec: dict = {"attempt": 0, "aligner": "fixture-alignment-model", "restrictive": False}
        gate_candidate(parent_raw, rt.pkg(h), ops, shortcut, protected, [], rec)
        attempts = [rec]
        restrictive = DeterministicAligner().propose(rt.pkg(h), shortcut, structural_replay(rt.pkg(h), shortcut).detail,
                                                     restrictive=True)
        attempts.append({"attempt": 1, "aligner": DeterministicAligner.name, "restrictive": True,
                         "result": "no safe proposal" if restrictive is None else "proposal produced"})
        for a in attempts:
            p(f"  gate attempt {a['attempt']} ({a['aligner']}, restrictive={a['restrictive']}): {a['result']}")
            for f in a.get("findings", [])[:6]:
                p(f"      {f['code']} {f['location']}: {f['message']}")
        after = svc.registry.active(app.TENANT, "supplier-onboarding-draft")
        p(f"  active version unchanged: {before[0] == after[0]} "
          f"(generation {after[1]})")
        report["steps"]["shortcut"] = {"eligibility": el.verdict, "status": prop.status,
                                       "active_unchanged": before[0] == after[0],
                                       "codes": sorted({f["code"] for a in attempts for f in a.get("findings", [])})}

    if scenario in ("full", "refinement"):
        p.h("7. Trace-driven refinement: transient ERP read failure")
        t4 = app.make_task(["DOC-100"], "Northwind Components Ltd", business_unit="BU-NA")
        r4, c4 = _drive_to_approval(rt, h, t4, "demo-readfail", p)
        svc.broker.connectors.erp.inject("read_unavailable")
        rt.resume_interaction(r4, c4["pending"]["interaction_id"], {"decision": "approved"}, app.APPROVER, "ap-4")
        c4 = rt.run(r4, app.REQUESTER)
        p(f"  initial machine: {c4['status']} at {c4['outcome']['terminal']} (honest unverified outcome)")
        # A reviewed development trace in which the operator simply read the draft again.
        dev = export_run_trace(svc.store, app.TENANT, r4, "supplier-onboarding-draft", t4, "trace-readback-retry")
        recs = [dict(r) for r in dev["records"][:-1]]
        persisted = svc.broker.connectors.erp.read_draft(
            {"draft_ref": [r for r in recs if r.get("tool") == "erp.create_draft"][0]["output"]["draft_ref"]},
            CallContext(app.TENANT, "dev", "", ""))
        draft = [r for r in recs if r["kind"] == "model"][-1]["output"]["draft"]
        create = [r for r in recs if r.get("tool") == "erp.create_draft"][0]["output"]
        ver = verify_persisted({"approved_draft": draft, "persisted": persisted["record"],
                                "draft_ref": create["draft_ref"], "draft_version": create["version"]},
                               CallContext(app.TENANT, "dev", "", ""))
        recs += [{"kind": "tool", "tool": "erp.read_draft", "outcome": "certain", "output": persisted},
                 {"kind": "tool", "tool": "draft.verify_persisted", "outcome": "certain", "output": ver},
                 {"kind": "end", "terminal": "END_VERIFIED_DRAFT"}]
        for r in recs:
            r.pop("seq", None)
        dev = make_trace("trace-readback-retry", "supplier-onboarding-draft", t4, recs, source="reviewed-dev-run")
        prop = propose_update(svc.store.get_machine_version(h)[0], dev, protected, [], [DeterministicAligner()])
        for a in prop.attempts:
            p(f"  attempt {a['attempt']}: {a['result']}")
            if a.get("proposal"):
                p(f"      rationale: {a['proposal']['rationale']}")
        if prop.status == "candidate_ready":
            for sid, ch in prop.diff["changed_edges"].items():
                p(f"  diff {sid}: +{[e for e in ch['after'] if e not in ch['before']]}")
            res = admit_update(svc.registry, app.TENANT, prop, h, protected + [dev], approver="u-reviewer")
            new_h = prop.candidate["artifact_hash"]
            p(f"  admitted {new_h} as generation {res['generation']} (CAS against {h[:19]}...)")
            try:
                admit_update(svc.registry, app.TENANT, prop, h, protected + [dev], approver="u-reviewer")
            except Exception as exc:
                p(f"  a second promotion against the old parent is refused: {type(exc).__name__}")
            t5 = app.make_task(["DOC-100"], "Northwind Components Ltd", business_unit="BU-NA")
            r5, c5 = _drive_to_approval(rt, new_h, t5, "demo-readfail-2", p)
            svc.broker.connectors.erp.inject("read_unavailable")
            rt.resume_interaction(r5, c5["pending"]["interaction_id"], {"decision": "approved"}, app.APPROVER, "ap-5")
            c5 = rt.run(r5, app.REQUESTER)
            p(f"  refined machine, same fault: {c5['status']} at {c5['outcome']['terminal']}")
            report["steps"]["refinement"] = {"status": prop.status, "new_hash": new_h,
                                             "rerun_outcome": c5["outcome"]["terminal"]}
        else:
            report["steps"]["refinement"] = {"status": prop.status}

    report["transcript"] = p.lines
    with open(os.path.join(data_dir, "demo_report.json"), "w") as fh:
        fh.write(canonical.dumps_pretty(report))
    p("")
    p(f"report written to {os.path.join(data_dir, 'demo_report.json')}")
    return report
