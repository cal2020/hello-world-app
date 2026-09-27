"""Traces, replay modes and trace-driven updates: A12-A18, A31."""
import copy
import socket
import unittest

from helpers import Env, loaded

from hexis_service import app, canonical
from hexis_service.connectors import CallContext, verify_persisted
from hexis_service.store import ConflictError
from hexis_service.traces import (INCOMPLETE, PASS, ExternalCallInReplay, eligibility, export_recorded,
                                  export_run_trace, make_trace, no_external_calls, normalize, recorded_replay,
                                  structural_replay, dumps_jsonl, loads_jsonl)
from hexis_service.update import (DeterministicAligner, FixtureAligner, admit_update, gate_candidate,
                                  propose_update)

SKILL = "supplier-onboarding-draft"


def run_trace(env, trace_id, task=None, decision="approved", fault=None, request_id=None):
    task = task or env.task
    run_id, cp = env.start(task=task, request_id=request_id or trace_id)
    if cp["status"] == "WAITING_FOR_APPROVAL":
        if fault:
            env.erp().inject(fault)
        env.approve(run_id, cp, decision=decision)
        cp = env.rt.run(run_id, app.REQUESTER)
    return run_id, cp, export_run_trace(env.svc.store, app.TENANT, run_id, SKILL, task, trace_id)


def strip(records):
    out = []
    for r in records:
        r = dict(r)
        r.pop("seq", None)
        out.append(r)
    return out


def readback_retry_trace(env):
    """A reviewed development trace in which the operator re-read the draft after a transient failure."""
    task = app.make_task(["DOC-100"], "Northwind Components Ltd", business_unit="BU-NA")
    _, _, t = run_trace(env, "dev-readfail", task=task, fault="read_unavailable")
    recs = strip(t["records"][:-1])
    create = [r for r in recs if r.get("tool") == "erp.create_draft"][0]["output"]
    draft = [r for r in recs if r["kind"] == "model"][-1]["output"]["draft"]
    ctx = CallContext(app.TENANT, "dev", "", "")
    persisted = env.erp().read_draft({"draft_ref": create["draft_ref"]}, ctx)
    ver = verify_persisted({"approved_draft": draft, "persisted": persisted["record"], "draft_ref": create["draft_ref"],
                            "draft_version": create["version"]}, ctx)
    recs += [{"kind": "tool", "tool": "erp.read_draft", "outcome": "certain", "output": persisted},
             {"kind": "tool", "tool": "draft.verify_persisted", "outcome": "certain", "output": ver},
             {"kind": "end", "terminal": "END_VERIFIED_DRAFT"}]
    return make_trace("trace-readback-retry", SKILL, task, recs, source="reviewed-dev-run")


class TestReplay(unittest.TestCase):
    def setUp(self):
        self.env = Env(self)
        self.pkg = self.env.rt.pkg(self.env.hash)

    def test_structural_replay_of_runtime_traces(self):
        _, _, t = run_trace(self.env, "t-main", fault="timeout_after_commit")
        r = structural_replay(self.pkg, t)
        self.assertEqual(r.result, PASS, r.detail)
        roundtrip = loads_jsonl(dumps_jsonl(t))
        self.assertEqual(structural_replay(self.pkg, roundtrip).result, PASS)

    def test_recorded_replay_reproduces_every_checkpoint(self):
        run_id, cp, _ = run_trace(self.env, "t-rec", fault="timeout_after_commit")
        rec = export_recorded(self.env.svc.store, app.TENANT, run_id, self.env.task)
        calls_before = list(self.env.svc.broker.connectors.calls)
        r1, r2 = recorded_replay(self.pkg, rec), recorded_replay(self.pkg, rec)
        self.assertEqual(r1.result, PASS, r1.detail)
        self.assertEqual(r1.to_dict(), r2.to_dict(), "A30: replay is idempotent")
        self.assertEqual(r1.detail["outcome"]["terminal"], "END_VERIFIED_DRAFT")
        self.assertEqual(self.env.svc.broker.connectors.calls, calls_before, "no connector invoked")

    def test_A12_structural_placeholder_is_marked_and_creates_no_approval(self):
        _, _, t = run_trace(self.env, "t-ph")
        recs = strip(t["records"])
        for r in recs:
            if r["kind"] == "user":
                r["output"] = {}
        t2 = make_trace("t-ph-missing", SKILL, self.env.task, recs, source="partial-log")
        r = structural_replay(self.pkg, t2)
        self.assertTrue(r.placeholders)
        self.assertIn("not evidence", r.placeholders[0]["note"])
        n = self.env.svc.store.q("SELECT COUNT(*) FROM approval_responses")[0][0]
        self.assertEqual(n, 1, "only the real approval exists; replay created none")

    def test_A13_recorded_replay_blocks_network_and_marks_missing_observations(self):
        with no_external_calls():
            with self.assertRaises(ExternalCallInReplay):
                socket.create_connection(("example.com", 443), timeout=1)
        run_id, _, _ = run_trace(self.env, "t-13")
        rec = export_recorded(self.env.svc.store, app.TENANT, run_id, self.env.task)
        del rec["observations"]["6"]
        self.assertEqual(recorded_replay(self.pkg, rec).result, INCOMPLETE)

    def test_A31_tampered_or_incomplete_trace(self):
        _, _, t = run_trace(self.env, "t-31")
        bad = copy.deepcopy(t)
        bad["records"][3]["output"]["status"] = "pass"
        bad["records"][1]["output"]["status"] = "new"
        bad["records"][0]["output"]["documents"] = []
        self.assertEqual(structural_replay(self.pkg, bad).result, INCOMPLETE)
        self.assertEqual(eligibility(bad, self.pkg).verdict, "incomplete")
        truncated = make_trace("t-trunc", SKILL, self.env.task, strip(t["records"][:-1]), source="x")
        self.assertEqual(eligibility(truncated, self.pkg).verdict, "incomplete")
        self.assertEqual(structural_replay(self.pkg, truncated).result, INCOMPLETE)

    def test_A16_two_distinct_writes_are_not_merged(self):
        recs = [{"kind": "tool", "tool": "erp.create_draft", "outcome": "certain", "action_id": "a1",
                 "output": {"status": "created", "draft_ref": "D-1", "version": 1}},
                {"kind": "tool", "tool": "erp.create_draft", "outcome": "certain", "action_id": "a2",
                 "output": {"status": "created", "draft_ref": "D-2", "version": 1}},
                {"kind": "end", "terminal": "END_UNVERIFIED"}]
        events, _ = normalize(make_trace("t16", SKILL, {}, recs, "x"))
        self.assertEqual(len([e for e in events if e["tool"] == "erp.create_draft"]), 2)
        recs[0]["outcome"], recs[0]["output"], recs[1]["action_id"] = "unknown_effect", None, "a1"
        events, _ = normalize(make_trace("t16b", SKILL, {}, recs, "x"))
        merged = [e for e in events if e["tool"] == "erp.create_draft"]
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["raw_seqs"], [0, 1], "reconciled operation keeps both raw references")


class TestUpdates(unittest.TestCase):
    def setUp(self):
        self.env = Env(self)
        self.parent = self.env.svc.store.get_machine_version(self.env.hash)[0]
        self.pkg = loaded(self.parent)
        self.protected = [run_trace(self.env, "p-main")[2],
                          run_trace(self.env, "p-rejected", decision="rejected")[2],
                          run_trace(self.env, "p-existing", task=app.make_task(["DOC-100"], "Existing Widgets plc"))[2]]

    def test_refinement_adds_bounded_retry_and_is_admitted_atomically(self):
        dev = readback_retry_trace(self.env)
        self.assertEqual(eligibility(dev, self.pkg).verdict, "protected")
        prop = propose_update(self.parent, dev, self.protected, [], [DeterministicAligner()])
        self.assertEqual(prop.status, "candidate_ready", prop.attempts)
        self.assertEqual(prop.diff["newly_reachable_tools"], [])
        self.assertEqual(prop.diff["loop_bounds"]["after"]["read_back_retries"], 2)
        self.assertEqual(prop.attempts[-1]["protected_replayed"], 3)
        self.assertEqual(self.parent["artifact_hash"], self.env.hash, "parent untouched")
        res = admit_update(self.env.svc.registry, app.TENANT, prop, self.env.hash, self.protected + [dev], "u-reviewer")
        self.assertEqual(res["generation"], 2)
        active = self.env.svc.registry.active(app.TENANT, SKILL)
        self.assertEqual(active[0], prop.candidate["artifact_hash"])
        self.assertEqual(len(active[2]["traces"]), 4)

    def test_A14_candidate_breaking_an_archived_trace_is_rejected_atomically(self):
        old = app.make_task(["DOC-100"], "Northwind Components Ltd", policy_version="onboarding-policy/2025-01")
        _, cp, archived = run_trace(self.env, "p-policy-fail", task=old)
        self.assertEqual(cp["outcome"]["terminal"], "END_UNVERIFIED")
        protected = self.protected + [archived]
        recs = strip(archived["records"])
        recs[-1] = {"kind": "end", "terminal": "FALLBACK"}
        new = make_trace("n-policy-fail-review", SKILL, old, recs, source="dev")
        aligner = FixtureAligner([{"add_edges": [{"state": "VALIDATE_DRAFT", "position": "before_default",
                                                  "edge": {"if": 'validation_status == "fail"', "to": "FALLBACK"}}],
                                   "rationale": "route policy failures to review"}])
        before = (self.env.svc.registry.active(app.TENANT, SKILL), canonical.digest(self.parent))
        prop = propose_update(self.parent, new, protected, [], [aligner, DeterministicAligner()])
        self.assertEqual(prop.status, "rejected")
        self.assertIn("breaks 1 protected trace", prop.attempts[0]["result"])
        self.assertEqual(prop.attempts[0]["broken"][0]["trace_id"], "p-policy-fail")
        self.assertEqual(prop.attempts[1]["result"], "no safe proposal")
        self.assertEqual(before, (self.env.svc.registry.active(app.TENANT, SKILL), canonical.digest(self.parent)))

    def test_A15_correct_answer_through_forbidden_action_is_negative(self):
        shortcut = make_trace("n-shortcut", SKILL, self.env.task,
                              strip([r for r in self.protected[0]["records"] if r.get("tool") != "draft.validate"]),
                              source="operator-log")
        el = eligibility(shortcut, self.pkg)
        self.assertEqual(el.verdict, "negative")
        prop = propose_update(self.parent, shortcut, self.protected, [], [DeterministicAligner()])
        self.assertEqual(prop.status, "excluded")
        self.assertIn("without a passing validation and approval", prop.eligibility["reasons"][0])

    def test_A17_gate_rejects_shortcut_proposal(self):
        shortcut = make_trace("n-shortcut", SKILL, self.env.task,
                              strip([r for r in self.protected[0]["records"] if r.get("tool") != "draft.validate"]),
                              source="operator-log")
        rec = {}
        cand = gate_candidate(self.parent, self.pkg,
                              {"retarget_default": [{"state": "EXTRACT_DRAFT", "to": "REQUEST_APPROVAL"}]},
                              shortcut, self.protected, [], rec)
        self.assertIsNone(cand)
        self.assertIn("ORDERING_BYPASS", {f["code"] for f in rec["findings"]})

    def test_negative_corpus_blocks_candidates_that_represent_prohibited_traces(self):
        dev = readback_retry_trace(self.env)
        forbidden = copy.deepcopy(dev)
        forbidden["header"]["trace_id"] = "neg-retry"
        prop = propose_update(self.parent, dev, self.protected, [forbidden], [DeterministicAligner()])
        self.assertEqual(prop.status, "rejected")
        self.assertIn("newly represents prohibited", prop.attempts[0]["result"])

    def test_A18_two_updates_race_from_the_same_parent(self):
        dev = readback_retry_trace(self.env)
        dev2 = copy.deepcopy(dev)
        dev2["header"]["trace_id"] = "trace-readback-retry-2"
        p1 = propose_update(self.parent, dev, self.protected, [], [DeterministicAligner()])
        p2 = propose_update(self.parent, dev2, self.protected, [], [DeterministicAligner()])
        admit_update(self.env.svc.registry, app.TENANT, p1, self.env.hash, self.protected + [dev], "u-reviewer")
        with self.assertRaises(ConflictError):
            admit_update(self.env.svc.registry, app.TENANT, p2, self.env.hash, self.protected + [dev2], "u-reviewer")
        self.assertEqual(self.env.svc.registry.active(app.TENANT, SKILL)[0], p1.candidate["artifact_hash"])

    def test_policy_diff_blocks_capability_widening(self):
        from hexis_service.update import apply_ops, policy_diff
        ops = {"add_edges": [{"state": "LOOKUP_SUPPLIER", "position": "before_default",
                              "edge": {"if": 'lookup_status == "existing_in_scope"', "to": "PERSIST_DRAFT"}}]}
        cand = loaded(apply_ops(self.parent, ops, "x"))
        self.assertEqual(policy_diff(self.pkg, cand), [])  # same tools; but ordering gate catches it
        rec = {}
        self.assertIsNone(gate_candidate(self.parent, self.pkg, ops, self.protected[0], self.protected, [], rec))
        self.assertIn("WRITE_WITHOUT_APPROVAL", {f["code"] for f in rec["findings"]})

    def test_structural_replay_divergence_report(self):
        recs = strip(self.protected[0]["records"])
        recs.insert(3, {"kind": "tool", "tool": "supplier.lookup", "outcome": "certain",
                        "output": {"status": "new", "record": {}}})
        r = structural_replay(self.pkg, make_trace("t-div", SKILL, self.env.task, recs, "x"))
        self.assertEqual(r.result, "FAIL")
        for key in ("event_index", "previous_anchor", "expected", "actual_state", "guard_values"):
            self.assertIn(key, r.detail)
        self.assertTrue(r.path)


if __name__ == "__main__":
    unittest.main()
