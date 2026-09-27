"""Durable runtime, broker, approvals, evidence and recovery: A05, A06, A10, A19-A29, A32."""
import copy
import json
import unittest

from helpers import Env, compiled_package, repackage

from hexis_service import app, canonical, kernel
from hexis_service.broker import SimulatedCrash, StaleLeaseError
from hexis_service.models import RuleBasedFakeModel, ScriptedFakeModel
from hexis_service.runtime import RunError
from hexis_service.store import ConflictError


def extracted(doc="DOC-100"):
    m = RuleBasedFakeModel()
    with open(app.example_path("documents", doc + ".txt")) as fh:
        return m._extract([{"doc_id": doc, "content": fh.read()}])


class TestHappyPath(unittest.TestCase):
    def test_end_to_end_verified_with_evidence(self):
        env = Env(self)
        run_id, cp = env.start()
        self.assertEqual((cp["status"], cp["state_id"]), ("WAITING_FOR_APPROVAL", "REQUEST_APPROVAL"))
        self.assertEqual(env.creates(), [], "nothing is written before approval")
        env.approve(run_id, cp)
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["outcome"]["terminal"], "END_VERIFIED_DRAFT")
        self.assertEqual(cp["outcome"]["outputs"], {"draft_ref": "D-001", "draft_version": 1})
        rep = env.rt.inspect_run(run_id, app.REQUESTER)
        self.assertEqual(len(rep["evidence"]), 1)
        self.assertIsNone(rep["evidence"][0]["invalidated_reason"])
        self.assertIn("does not establish that extracted commercial facts are true",
                      cp["assurance"]["verification_scope"]["claim"])
        self.assertEqual(env.erp().count(), 1)

    def test_request_deduplication(self):
        env = Env(self)
        run_id, cp = env.start(request_id="same")
        again = env.rt.start_run(env.hash, env.task, app.REQUESTER, "same")
        self.assertEqual(again["run_id"], run_id)
        env.approve(run_id, cp, request_id="dup")
        cp2 = env.rt.resume_interaction(run_id, cp["pending"]["interaction_id"], {"decision": "approved"},
                                        app.APPROVER, "dup")
        self.assertEqual(cp2["run_id"], run_id)


class TestInputs(unittest.TestCase):
    def test_A05_missing_or_ill_typed_input_never_dispatches(self):
        env = Env(self)
        for bad in (lambda t: t["supplier"].pop("proposed_name"),
                    lambda t: t["supplier"].__setitem__("proposed_name", 42),
                    lambda t: t["intake"]["document_refs"][0].__setitem__("doc_id", "../etc/passwd"),
                    lambda t: t["supplier"].__setitem__("business_unit", "")):
            task = copy.deepcopy(env.task)
            bad(task)
            with self.assertRaises(RunError) as ctx:
                env.rt.start_run(env.hash, task, app.REQUESTER, f"bad-{id(bad)}")
            self.assertEqual(ctx.exception.code, "INVALID_INPUT")
        self.assertEqual(env.svc.broker.connectors.calls, [])

    def test_A05_template_resolution_is_strict(self):
        from hexis_service.runtime import resolve_template
        with self.assertRaises(kernel.InputBindingError):
            resolve_template({"x": "${a}"}, {}, ("a",))
        with self.assertRaises(kernel.InputBindingError):
            resolve_template({"x": "${a}"}, {"a": 1}, ())
        with self.assertRaises(kernel.InputBindingError):
            resolve_template({"x": "id-${a}"}, {"a": 1}, ("a",))
        self.assertEqual(resolve_template({"x": "${a}"}, {"a": False}, ("a",)), {"x": False})

    def test_missing_document_asks_once_then_resumes(self):
        env = Env(self)
        task = app.make_task(["DOC-404"], "Northwind Components Ltd")
        run_id, cp = env.start(task=task)
        self.assertEqual(cp["status"], "WAITING_FOR_INPUT")
        with open(app.example_path("documents", "DOC-100.txt"), "rb") as fh:
            sha = canonical.sha256_hex(fh.read())
        cp = env.rt.resume_interaction(run_id, cp["pending"]["interaction_id"],
                                       {"supplemental_refs": [{"doc_id": "DOC-100", "sha256": sha}]},
                                       app.REQUESTER, "input-1")
        cp = env.rt.run(run_id, app.REQUESTER)
        # DOC-404 is still missing, and the machine asks only once
        self.assertEqual(cp["outcome"]["terminal"], "END_UNVERIFIED")
        self.assertEqual(cp["variables"]["input_requests"], 1)


class TestModelBoundary(unittest.TestCase):
    def test_A06_model_extra_privileged_fields_go_to_review(self):
        draft = extracted()
        model = ScriptedFakeModel({"EXTRACT_DRAFT": [{"draft": draft, "approval_decision": "approved"},
                                                     {"draft": draft, "approval_decision": "approved"}]})
        env = Env(self, model=model)
        run_id, cp = env.start()
        self.assertEqual(cp["outcome"]["terminal"], "FALLBACK")
        self.assertTrue(cp["assurance"]["entered_fallback"])
        self.assertNotIn("approval_decision", cp["variables"])
        self.assertEqual(model.calls.count("EXTRACT_DRAFT"), 2, "one structured-output repair, then stop")
        self.assertEqual(env.creates(), [])

    def test_structured_output_repair_succeeds_once(self):
        draft = extracted()
        model = ScriptedFakeModel({"EXTRACT_DRAFT": [{"draft": {"legal_name": 1}}, {"draft": draft}]})
        env = Env(self, model=model)
        _, cp = env.start()
        self.assertEqual(cp["state_id"], "REQUEST_APPROVAL")
        self.assertEqual(cp["budget"]["used"]["model_calls"], 2)

    def test_model_unavailable_is_visible_and_stops_for_review(self):
        from hexis_service.models import ModelUnavailable
        env = Env(self, model=ScriptedFakeModel({"EXTRACT_DRAFT": [ModelUnavailable("provider down")]}))
        _, cp = env.start()
        self.assertEqual(cp["outcome"]["terminal"], "FALLBACK")
        obs = [o for o in env.svc.store.observations(app.TENANT, cp["run_id"]).values() if o["kind"] == "model"]
        self.assertIn("provider down", obs[0]["model_error"])

    def test_A10_repair_loop_bound_and_budget(self):
        draft = extracted()
        bad = dict(draft, country="Great Britain")
        model = ScriptedFakeModel({"EXTRACT_DRAFT": [{"draft": bad}],
                                   "REPAIR_DRAFT": [{"draft": bad}, {"draft": bad}, {"draft": bad}]})
        env = Env(self, model=model)
        run_id, cp = env.start()
        self.assertEqual(cp["outcome"]["terminal"], "END_UNVERIFIED")
        self.assertEqual(cp["variables"]["repair_count"], 2)
        self.assertEqual(model.calls.count("REPAIR_DRAFT"), 2)
        # repair that works on the second attempt passes validation
        good_env = Env(self, model=ScriptedFakeModel({"EXTRACT_DRAFT": [{"draft": bad}],
                                                      "REPAIR_DRAFT": [{"draft": bad}, {"draft": draft}]}))
        _, cp = good_env.start()
        self.assertEqual((cp["state_id"], cp["variables"]["repair_count"]), ("REQUEST_APPROVAL", 2))

    def test_A10_run_budget_is_global_and_monotonic(self):
        pkg = compiled_package()
        pol = copy.deepcopy(pkg["execution_policy"])
        pol["budgets"]["model_calls"] = 1
        env = Env(self, pkg=repackage(pkg, policy=pol),
                  model=ScriptedFakeModel({"EXTRACT_DRAFT": [{"draft": {}}]}, delegate=RuleBasedFakeModel()))
        _, cp = env.start()
        self.assertEqual(cp["diagnostic"]["code"], "BUDGET_EXHAUSTED")
        used = [env.svc.store.checkpoint_at(app.TENANT, cp["run_id"], r)["budget"]["used"]["steps"]
                for r in range(cp["revision"] + 1)]
        self.assertEqual(used, sorted(used))

    def test_repair_path_with_rule_based_model(self):
        env = Env(self)
        run_id, cp = env.start(task=app.make_task(["DOC-200"], "Contoso Fasteners GmbH"))
        self.assertEqual(cp["state_id"], "REQUEST_APPROVAL")
        self.assertEqual(cp["variables"]["draft"]["country"], "DE")
        self.assertEqual(cp["variables"]["repair_count"], 1)


class TestApprovals(unittest.TestCase):
    def test_A19_restart_while_waiting_then_resume(self):
        env = Env(self)
        run_id, cp = env.start()
        env.restart()
        waiting = env.svc.store.latest_checkpoint(app.TENANT, run_id)
        self.assertEqual(waiting["status"], "WAITING_FOR_APPROVAL")
        env.approve(run_id, waiting)
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["outcome"]["terminal"], "END_VERIFIED_DRAFT")

    def test_unauthorized_approvers_are_refused(self):
        env = Env(self)
        run_id, cp = env.start()
        with self.assertRaises(PermissionError):
            env.approve(run_id, cp, principal=app.REQUESTER)
        with self.assertRaises(RunError):
            env.approve(run_id, cp, principal=app.OTHER_TENANT_APPROVER)
        unauth = app.Principal("u-approver", app.TENANT, ("procurement_approver",), authenticated=False)
        with self.assertRaises(RunError):
            env.approve(run_id, cp, principal=unauth)
        with self.assertRaises(PermissionError):
            env.approve(run_id, cp, decision="true")
        self.assertEqual(env.svc.store.latest_checkpoint(app.TENANT, run_id)["status"], "WAITING_FOR_APPROVAL")

    def test_rejection_and_expiry_stop_without_write(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp, decision="rejected")
        self.assertEqual(env.rt.run(run_id, app.REQUESTER)["outcome"]["terminal"], "END_UNVERIFIED")
        run2, cp2 = env.start(request_id="r2")
        env.clock.advance(2 * 86400)
        env.approve(run2, cp2)
        cp2 = env.rt.run(run2, app.REQUESTER)
        self.assertEqual(cp2["variables"]["approval_decision"], "expired")
        self.assertEqual(cp2["outcome"]["terminal"], "END_UNVERIFIED")
        self.assertEqual(env.creates(), [])

    def _approved_but_not_dispatched(self, env):
        run_id, cp = env.start()
        env.approve(run_id, cp)
        cp = env.svc.store.latest_checkpoint(app.TENANT, run_id)
        self.assertEqual(cp["state_id"], "PERSIST_DRAFT")
        return run_id, cp

    def test_A20_changed_arguments_invalidate_approval(self):
        env = Env(self)
        run_id, cp = self._approved_but_not_dispatched(env)
        changed = copy.deepcopy(cp)
        changed["variables"]["draft"]["contact_email"] = "attacker@evil.example"
        changed["revision"] += 1
        with env.svc.store.tx() as c:
            env.svc.store.commit_checkpoint(c, cp, changed, None, {"kind": "test-tamper"})
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["diagnostic"]["code"], "POLICY_DENIED")
        self.assertIn("no valid approval", cp["diagnostic"]["message"])
        self.assertEqual(env.creates(), [])

    def test_A20_policy_version_change_invalidates_approval(self):
        env = Env(self)
        run_id, _ = self._approved_but_not_dispatched(env)
        env.svc.policy.doc["policy_version"] = "onboarding-policy/2026-10"
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["diagnostic"]["code"], "POLICY_DENIED")
        self.assertIn("policy version changed", cp["diagnostic"]["message"])
        self.assertEqual(env.creates(), [])

    def test_A21_permission_revoked_immediately_before_dispatch(self):
        env = Env(self)
        run_id, _ = self._approved_but_not_dispatched(env)
        env.svc.policy.revoke("u-requester", "erp:draft:write")
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["diagnostic"]["code"], "POLICY_DENIED")
        self.assertEqual(env.creates(), [])

    def test_approver_authority_revoked_before_dispatch(self):
        env = Env(self)
        run_id, _ = self._approved_but_not_dispatched(env)
        env.svc.policy.revoke("u-approver", "approve:erp.create_draft")
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertIn("approver authority", cp["diagnostic"]["message"])


class TestRecovery(unittest.TestCase):
    def _run_with_crash(self, point):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        env.svc.broker.crash_points.add(point)
        with self.assertRaises(SimulatedCrash):
            env.rt.run(run_id, app.REQUESTER)
        env.restart()
        cp = env.rt.run(run_id, app.REQUESTER)
        return env, cp

    def test_A22_crash_after_remote_commit_before_ack(self):
        env, cp = self._run_with_crash("after_dispatch_before_receipt")
        self.assertEqual(cp["outcome"]["terminal"], "END_VERIFIED_DRAFT")
        self.assertEqual(env.erp().count(), 1)
        intent = [a for a in env.rt.inspect_run(cp["run_id"], app.REQUESTER)["actions"] if a["tool"] == "erp.create_draft"]
        self.assertEqual(len(intent), 1)

    def test_crash_injection_at_every_boundary(self):
        for point in ("after_intent", "after_dispatch_before_receipt", "after_receipt_before_commit",
                      "after_timeout_before_receipt"):
            with self.subTest(point=point):
                env = Env(self)
                run_id, cp = env.start()
                env.approve(run_id, cp)
                if point == "after_timeout_before_receipt":
                    env.erp().inject("timeout_after_commit")
                env.svc.broker.crash_points.add(point)
                with self.assertRaises(SimulatedCrash):
                    env.rt.run(run_id, app.REQUESTER)
                env.restart()
                cp = env.rt.run(run_id, app.REQUESTER)
                self.assertEqual(cp["outcome"]["terminal"], "END_VERIFIED_DRAFT")
                self.assertEqual(env.erp().count(), 1, "no silently duplicated logical effect")

    def test_timeout_after_commit_reconciles_same_draft(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        env.erp().inject("timeout_after_commit")
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["outcome"]["terminal"], "END_VERIFIED_DRAFT")
        self.assertEqual(env.erp().count(), 1)
        self.assertEqual(len(env.creates()), 1, "reconciled by business reference, not resent")
        types = [e["type"] for e in env.svc.store.events(app.TENANT, run_id)]
        self.assertIn("reconciling", types)

    def test_A23_non_idempotent_timeout_pauses_without_blind_retry(self):
        pkg = compiled_package()
        cat = copy.deepcopy(pkg["tool_catalog"])
        cat["tools"]["erp.create_draft"]["effect"] = "non_idempotent_write"
        env = Env(self, pkg=repackage(pkg, catalog=cat))
        run_id, cp = env.start()
        env.approve(run_id, cp)
        env.erp().inject("timeout_after_commit")
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["status"], "RECONCILING")
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["status"], "RECONCILING")
        self.assertEqual(len(env.creates()), 1)

    def test_A24_stale_worker_cannot_dispatch_or_commit(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        cp = env.svc.store.latest_checkpoint(app.TENANT, run_id)
        old = env.svc.store.acquire_lease(app.TENANT, run_id, "worker-old")
        env.svc.store.acquire_lease(app.TENANT, run_id, "worker-new")
        with self.assertRaises(StaleLeaseError):
            env.rt.advance_run(run_id, cp["revision"], app.REQUESTER, old)
        self.assertEqual(env.creates(), [])
        with self.assertRaises(ConflictError):
            env.rt.advance_run(run_id, cp["revision"] - 1, app.REQUESTER, old)

    def test_A25_evidence_invalidated_when_subject_changes(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        token = env.svc.store.acquire_lease(app.TENANT, run_id, "w")
        cp = env.svc.store.latest_checkpoint(app.TENANT, run_id)
        while cp["state_id"] != "END_VERIFIED_DRAFT":
            cp = env.rt.advance_run(run_id, cp["revision"], app.REQUESTER, token)
        env.erp().modify_out_of_band("D-001", "contact_email", "changed@northwind.example")
        cp = env.rt.advance_run(run_id, cp["revision"], app.REQUESTER, token)
        self.assertEqual(cp["status"], "FAILED")
        self.assertEqual(cp["diagnostic"]["code"], "TERMINAL_REJECTED")
        ev = env.svc.evidence.for_run(app.TENANT, run_id)[0]
        self.assertIn("subject changed", ev["invalidated_reason"])

    def test_A27_cancel_during_uncertain_write_discloses_effect(self):
        pkg = compiled_package()
        cat = copy.deepcopy(pkg["tool_catalog"])
        cat["tools"]["erp.create_draft"]["effect"] = "non_idempotent_write"
        env = Env(self, pkg=repackage(pkg, catalog=cat))
        run_id, cp = env.start()
        env.approve(run_id, cp)
        env.erp().inject("timeout_after_commit")
        cp = env.rt.run(run_id, app.REQUESTER)
        res = env.rt.cancel_run(run_id, cp["revision"], app.REQUESTER)
        self.assertTrue(res["cancelled"])
        self.assertFalse(res["safely_cancelled"], "an unresolved write is not reported as a safe cancel")
        # reconcilable connector: the completed effect is found and disclosed
        env2 = Env(self)
        run2, cp2 = env2.start()
        env2.approve(run2, cp2)
        env2.erp().inject("timeout_after_commit")
        env2.svc.broker.crash_points.add("after_timeout_before_receipt")
        with self.assertRaises(SimulatedCrash):
            env2.rt.run(run2, app.REQUESTER)
        cp2 = env2.svc.store.latest_checkpoint(app.TENANT, run2)
        res2 = env2.rt.cancel_run(run2, cp2["revision"], app.REQUESTER)
        self.assertEqual(res2["disclosed_effects"][0]["effect"], "completed")
        self.assertEqual(res2["disclosed_effects"][0]["external_ref"], "D-001")
        self.assertEqual(env2.svc.store.latest_checkpoint(app.TENANT, run2)["status"], "CANCELLED")
        self.assertEqual(env2.rt.run(run2, app.REQUESTER)["status"], "CANCELLED")
        self.assertEqual(len(env2.creates()), 1)

    def test_A28_post_write_verification_failure(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        env.erp().inject("persist_wrong_value")
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["outcome"]["terminal"], "END_UNVERIFIED")
        self.assertEqual(cp["variables"]["verify_status"], "mismatch")
        self.assertIn("address", cp["variables"]["mismatch_fields"])
        self.assertEqual(cp["variables"]["draft_ref"], "D-001", "external reference preserved")
        self.assertEqual(env.erp().count(), 1)

    def test_read_back_unavailable_is_honest_failure(self):
        env = Env(self)
        run_id, cp = env.start()
        env.approve(run_id, cp)
        env.erp().inject("read_unavailable")
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["outcome"]["kind"], "unverified")
        self.assertEqual(cp["evidence"], [])


class TestSecurity(unittest.TestCase):
    def test_A26_prompt_injection_in_supplier_document(self):
        env = Env(self)
        run_id, cp = env.start(task=app.make_task(["DOC-666"], "Fabrikam Metals Inc"))
        self.assertEqual(cp["status"], "WAITING_FOR_APPROVAL", "approval is not skipped")
        self.assertEqual(env.creates(), [])
        self.assertNotIn("T-OTHER", json.dumps(cp["variables"]["draft"]))
        with self.assertRaises(RunError):
            env.approve(run_id, cp, principal=app.OTHER_TENANT_APPROVER)

    def test_A26_model_cannot_redirect_tenant_or_business_unit(self):
        draft = dict(extracted("DOC-666"), tenant_id="T-OTHER")
        env = Env(self, model=ScriptedFakeModel({"EXTRACT_DRAFT": [{"draft": draft}, {"draft": draft}]}))
        _, cp = env.start(task=app.make_task(["DOC-666"], "Fabrikam Metals Inc"))
        self.assertEqual(cp["outcome"]["terminal"], "FALLBACK")
        env2 = Env(self)
        task = app.make_task(["DOC-100"], "Northwind Components Ltd", business_unit="BU-ALL")
        _, cp2 = env2.start(task=task)
        # out-of-scope business unit: the broker's policy check denies the first scoped tool call
        self.assertEqual(cp2["diagnostic"]["code"], "POLICY_DENIED")
        self.assertIn("outside tenant scope", cp2["diagnostic"]["message"])
        self.assertEqual(env2.creates(), [])

    def test_cross_tenant_access_is_not_found(self):
        env = Env(self)
        run_id, _ = env.start()
        with self.assertRaises(RunError) as ctx:
            env.rt.inspect_run(run_id, app.OTHER_TENANT_APPROVER)
        self.assertEqual(ctx.exception.code, "NOT_FOUND")

    def test_A32_revoked_artifact(self):
        env = Env(self)
        run_id, cp = env.start()
        env.svc.registry.revoke(env.hash)
        with self.assertRaises(RunError) as ctx:
            env.rt.start_run(env.hash, env.task, app.REQUESTER, "after-revoke")
        self.assertEqual(ctx.exception.code, "NOT_ACTIVE")
        env.approve(run_id, cp)
        cp = env.rt.run(run_id, app.REQUESTER)
        self.assertEqual(cp["diagnostic"]["code"], "ARTIFACT_REVOKED")
        self.assertEqual(env.creates(), [])


if __name__ == "__main__":
    unittest.main()
