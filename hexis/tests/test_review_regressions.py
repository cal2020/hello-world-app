"""Regression tests for defects found by an independent review of this implementation."""
import copy
import unittest

from helpers import Env, compiled_package, loaded, repackage, tiny_package

from hexis_service import app, guards as G, kernel
from hexis_service.broker import SimulatedCrash
from hexis_service.registry import AdmissionRejected
from hexis_service.runtime import RunError
from hexis_service.traces import make_trace, structural_replay
from hexis_service.validator import validate_package
from test_replay_update import SKILL, readback_retry_trace, run_trace
from hexis_service.update import DeterministicAligner, admit_update, propose_update


class TestRegistry(unittest.TestCase):
    def test_promoting_a_successor_does_not_unrevoke(self):
        env = Env(self)
        run_id, cp = env.start()
        env.svc.registry.revoke(env.hash)
        pol = copy.deepcopy(env.pkg["execution_policy"])
        pol["budgets"]["steps"] = 41
        b = repackage(env.pkg, policy=pol)
        env.svc.registry.register_draft(b)
        env.svc.registry.admit(b, "u-reviewer", "local")
        env.svc.registry.promote(app.TENANT, b["artifact_hash"], env.hash)
        self.assertEqual(env.svc.registry.lifecycle(env.hash), "revoked")
        env.approve(run_id, cp)
        self.assertEqual(env.rt.run(run_id, app.REQUESTER)["diagnostic"]["code"], "ARTIFACT_REVOKED")
        self.assertEqual(env.creates(), [])
        with self.assertRaises(AdmissionRejected):
            env.svc.registry.promote(app.TENANT, env.hash, b["artifact_hash"])

    def test_activeness_is_per_tenant(self):
        env = Env(self)
        other = app.Principal("u-x", "T-OTHER", ("procurement_agent",))
        with self.assertRaises(RunError) as ctx:
            env.rt.start_run(env.hash, env.task, other, "x")
        self.assertEqual(ctx.exception.code, "NOT_ACTIVE")

    def test_admit_update_requires_the_proposal_parent(self):
        env = Env(self)
        parent = env.svc.store.get_machine_version(env.hash)[0]
        protected = [run_trace(env, "p-main")[2]]
        dev = readback_retry_trace(env)
        dev2 = copy.deepcopy(dev)
        dev2["header"]["trace_id"] = "dev-2"
        p1 = propose_update(parent, dev, protected, [], [DeterministicAligner()])
        p2 = propose_update(parent, dev2, protected, [], [DeterministicAligner()])
        admit_update(env.svc.registry, app.TENANT, p1, env.hash, protected + [dev], "r")
        c1 = p1.candidate["artifact_hash"]
        with self.assertRaises(AdmissionRejected):
            admit_update(env.svc.registry, app.TENANT, p2, c1, protected + [dev2], "r")
        self.assertEqual(env.svc.registry.active(app.TENANT, SKILL)[0], c1)

    def test_admit_update_replays_the_published_archive(self):
        env = Env(self)
        parent = env.svc.store.get_machine_version(env.hash)[0]
        protected = [run_trace(env, "p-main")[2]]
        p1 = propose_update(parent, readback_retry_trace(env), protected, [], [DeterministicAligner()])
        bogus = make_trace("bogus", SKILL, env.task, [{"kind": "end", "terminal": "END_VERIFIED_DRAFT"}], "x")
        with self.assertRaises(AdmissionRejected):
            admit_update(env.svc.registry, app.TENANT, p1, env.hash, protected + [bogus], "r")
        self.assertEqual(env.svc.registry.active(app.TENANT, SKILL)[0], env.hash)


class TestGuardSoundness(unittest.TestCase):
    def test_integer_against_float_literals(self):
        self.assertEqual(G.disjoint("x > 0.5", "x < 1.5", {"x": "integer"}).result, G.COUNTEREXAMPLE)
        self.assertEqual(G.disjoint("x >= 2.5", "x <= 2.9", {"x": "integer"}).result, G.PROVEN)
        self.assertEqual(G.disjoint("x >= 2.5", "x <= 3.1", {"x": "integer"}).result, G.COUNTEREXAMPLE)

    def test_unenforced_contract_enum_is_not_used_as_a_domain(self):
        states = {"S": {"id": "S", "action": {"kind": "model", "prompt": "", "reads": [], "writes": ["s"]},
                        "transitions": [{"if": 's != "a"', "to": "OK_END"}, {"if": 's != "b"', "to": "FALLBACK"},
                                        {"if": "", "to": "FALLBACK"}]},
                  "OK_END": {"id": "OK_END", "action": {"kind": "end", "terminal": "OK"}, "transitions": []}}
        pkg = loaded(tiny_package(states, [{"name": "s", "type": "string"}],
                                  {"s": {"owner": "model", "enum": ["a", "b"]}}))
        codes = validate_package(pkg).codes()
        self.assertIn("ENUM_NOT_ENFORCED", codes)
        self.assertIn("GUARD_OVERLAP", codes)


class TestEvidenceAfterCrash(unittest.TestCase):
    def test_crash_after_verifier_receipt_keeps_evidence(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        token = env.svc.store.acquire_lease(app.TENANT, run_id, "w")
        cp = env.svc.store.latest_checkpoint(app.TENANT, run_id)
        while cp["state_id"] != "VERIFY_PERSISTED":
            cp = env.rt.advance_run(run_id, cp["revision"], app.REQUESTER, token)
        env.svc.broker.crash_points.add("after_receipt_before_commit")
        with self.assertRaises(SimulatedCrash):
            env.rt.advance_run(run_id, cp["revision"], app.REQUESTER, token)
        env.restart()
        self.assertEqual(env.rt.run(run_id, app.REQUESTER)["outcome"]["terminal"], "END_VERIFIED_DRAFT")

    def test_policy_change_invalidates_evidence_at_terminal(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        token = env.svc.store.acquire_lease(app.TENANT, run_id, "w")
        cp = env.svc.store.latest_checkpoint(app.TENANT, run_id)
        while cp["state_id"] != "END_VERIFIED_DRAFT":
            cp = env.rt.advance_run(run_id, cp["revision"], app.REQUESTER, token)
        env.svc.policy.doc["policy_version"] = "onboarding-policy/2026-10"
        cp = env.rt.advance_run(run_id, cp["revision"], app.REQUESTER, token)
        self.assertEqual(cp["diagnostic"]["code"], "TERMINAL_REJECTED")


class TestReplaySoundness(unittest.TestCase):
    def test_structural_replay_rejects_outputs_the_kernel_would_reject(self):
        env = Env(self)
        _, _, t = run_trace(env, "t")
        recs = [dict(r) for r in t["records"]]
        for r in recs:
            r.pop("seq")
            if r["kind"] == "model":
                r["output"] = {"draft": {"legal_name": 7}}
        r = structural_replay(env.rt.pkg(env.hash), make_trace("bad", SKILL, env.task, recs, "x"))
        self.assertEqual(r.result, "FAIL")
        self.assertIn("errors", r.detail)


class TestImplicitFallbackEdges(unittest.TestCase):
    def test_non_end_fallback_cannot_bypass_ordering(self):
        pkg = compiled_package()
        m = copy.deepcopy(pkg["machine"])
        m["states"]["REVIEW"] = {"id": "REVIEW", "action": {"kind": "end", "terminal": "FALLBACK"}, "transitions": []}
        m["states"]["FALLBACK"] = {"id": "FALLBACK", "action": {"kind": "user", "prompt": "review", "reads": [],
                                   "writes": ["approval_decision"], "labels": []},
                                   "transitions": [{"if": "", "to": "REQUEST_APPROVAL"}]}
        for st in m["states"].values():  # reachable only through the kernel's implicit fallback edge
            for e in st["transitions"]:
                if e["to"] == "FALLBACK":
                    e["to"] = "REVIEW"
        codes = validate_package(loaded(repackage(pkg, machine=m))).codes()
        self.assertIn("ORDERING_BYPASS", codes)


class TestAtomicApproval(unittest.TestCase):
    def test_conflicting_commit_does_not_strand_the_approval(self):
        env = Env(self)
        run_id, cp = env.start()
        orig = env.svc.store.commit_checkpoint
        calls = {"n": 0}

        def flaky(*a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                from hexis_service.store import ConflictError
                raise ConflictError("simulated concurrent commit")
            return orig(*a, **k)

        env.svc.store.commit_checkpoint = flaky
        from hexis_service.store import ConflictError
        with self.assertRaises(ConflictError):
            env.approve(run_id, cp, request_id="a1")
        self.assertEqual(env.svc.store.q("SELECT COUNT(*) FROM approval_responses")[0][0], 0)
        env.approve(run_id, cp, request_id="a2")
        self.assertEqual(env.rt.run(run_id, app.REQUESTER)["outcome"]["terminal"], "END_VERIFIED_DRAFT")


if __name__ == "__main__":
    unittest.main()
