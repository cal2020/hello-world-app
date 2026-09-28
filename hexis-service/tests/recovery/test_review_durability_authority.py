"""Regression tests for the durability / authority review findings (round 1)."""

from __future__ import annotations

import pytest

from hexis_service.artifacts.registry import revoke
from hexis_service.demo import fakes
from hexis_service.demo.env import TASK, admit_initial, build_env
from hexis_service.runtime.service import RunError
from hexis_service.storage.sqlite import ConflictError, Store
from hexis_service.tools.broker import SimulatedCrash

from ..conftest import approve, mutate, run_to_approval, step_until_state

ALICE = "user:alice"


def _restart(env, clock):
    clock.advance(1000)  # the crashed worker's lease expires
    return env.restart()


def _persist_intent(env, run_id):
    return [i for i in env.store.intents("acme", run_id) if i["tool"] == "erp.create_draft"][-1]


def _crash_before_erp_commit(env, pkg, clock):
    """Worker dies after DISPATCHING but before the request reaches the ERP (no draft exists)."""
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)

    def dying(args, ctx):
        raise SimulatedCrash("process died before the request reached the ERP")

    env.broker.connectors["erp.create_draft"] = dying
    with pytest.raises(SimulatedCrash):
        env.service.run_until_blocked(run_id, env.principal(ALICE))
    assert env.erp.count("acme") == 0
    assert _persist_intent(env, run_id)["status"] == "DISPATCHING"
    return run_id, _restart(env, clock)


# ---- C07 / C13: terminal freshness must re-read after a crash --------------------------------- #
def test_C07_C13_terminal_freshness_rereads_after_crash(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    cp = step_until_state(env, run_id, "END_VERIFIED_DRAFT")
    draft_id = cp.variables["erp_draft_id"]
    env.faults.arm("before_commit")
    with pytest.raises(SimulatedCrash):
        env.service.advance_run(run_id, env.principal(ALICE))  # freshness read happened, commit did not
    env.erp.modify_out_of_band("acme", draft_id, {"tax_id": "DE999999999"})
    env2 = _restart(env, clock)
    out = env2.service.run_until_blocked(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert not (out.status == "COMPLETED" and out.checkpoint.outcome["category"] == "verified")
    assert "persisted draft changed" in str(out.checkpoint.assurance.diagnostics)
    readback = {i["logical_action_id"] for i in env2.store.intents("acme", run_id) if i["tool"] == "erp.read_draft"}
    freshness_reads = {r["logical_action_id"] for r in env2.store.receipts("acme", run_id=run_id)
                       if r["tool"] == "erp.read_draft" and r["logical_action_id"] not in readback}
    assert len(freshness_reads) == 2  # the pre-crash read was not reused


def test_C07_freshness_reads_are_never_deduplicated(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    out = env.service.run_until_blocked(run_id, env.principal(ALICE))
    assert out.status == "COMPLETED"
    n = len([r for r in env.store.receipts("acme", run_id=run_id) if r["tool"] == "erp.read_draft"])
    run = env.store.get_run("acme", run_id)
    cp = env.service._cp("acme", run_id)
    check = env.service.freshness["persisted_draft_matches_approved_payload"]
    cp_end = cp.model_copy(update={"state_id": "END_VERIFIED_DRAFT", "revision": cp.revision - 1})
    for _ in range(2):
        assert check(env.service, run, cp_end, env.service.package(cp.artifact_hash), env.principal(ALICE)) == (True, "")
    assert len([r for r in env.store.receipts("acme", run_id=run_id) if r["tool"] == "erp.read_draft"]) == n + 2


# ---- C08: package cannot replace the policy's approver role --------------------------------- #
def test_C08_package_required_role_only_narrows(env):
    carol = env.principal("user:carol")  # procurement_specialist, NOT procurement_approver
    bob = env.principal("user:bob")
    assert not env.policy.can_approve(carol, ALICE, "acme", "procurement_specialist").allowed
    assert env.policy.can_approve(bob, ALICE, "acme", "procurement_approver").allowed
    assert env.policy.can_approve(bob, ALICE, "acme", "").allowed
    # an additional package role narrows: bob lacks procurement_specialist
    assert not env.policy.can_approve(bob, ALICE, "acme", "procurement_specialist").allowed


def test_C08_non_approver_cannot_approve_via_package_role(pkg, clock, tmp_path):
    def fn(md, cd):
        cd["interactions"]["REQUEST_APPROVAL"]["required_role"] = "procurement_specialist"

    p2 = mutate(pkg, fn)
    env = build_env(str(tmp_path / "s2"), clock=clock)
    if admit_initial(env, p2).status != "ADMITTED":
        pytest.skip("admission already rejects the widened approval contract")
    run_id, res = run_to_approval(env, p2)
    assert res.status == "WAITING_FOR_APPROVAL"
    with pytest.raises(RunError) as e:
        approve(env, run_id, res.interaction, who="user:carol")
    assert e.value.code == "NOT_AUTHORIZED"
    assert env.erp.count("acme") == 0


# ---- C09: business unit written to the ERP must be the policy-checked one ----------------------- #
class _ForeignBUModel(fakes.FixtureExtractionModel):
    def generate(self, req):
        r = super().generate(req)
        if req.state_id in ("EXTRACT_DRAFT", "REPAIR_DRAFT") and isinstance(r.output, dict) and "draft" in r.output:
            r.output["draft"]["business_unit"] = "BU-APAC"  # alice is not scoped to BU-APAC
        return r


def test_C09_broker_checks_business_unit_in_tool_arguments(env, pkg):
    env = env.restart(model=_ForeignBUModel())
    run_id, out = run_to_approval(env, pkg)
    if out.status == "WAITING_FOR_APPROVAL":
        approve(env, run_id, out.interaction)
        out = env.service.run_until_blocked(run_id, env.principal(ALICE))
    assert out.status == "FAILED"
    assert env.erp.count("acme") == 0
    assert any("BU-APAC" in d["message"] for d in out.checkpoint.assurance.diagnostics)


# ---- C10 / C16: proven-absent write under cancel / revoke is resolved as no-effect ------------- #
def test_C10_C16_cancel_resolves_proven_absent_write(env, pkg, clock):
    run_id, env2 = _crash_before_erp_commit(env, pkg, clock)
    cr = env2.service.cancel_run(run_id, None, env2.principal(ALICE))
    assert cr.status == "CANCELLED" and cr.unresolved == [] and cr.disclosed_effects == []
    it = _persist_intent(env2, run_id)
    assert it["status"] == "ABANDONED"
    rec = env2.store.receipts("acme", it["logical_action_id"])
    assert rec[-1]["dispatch_state"] == "ABANDONED" and rec[-1]["certainty"] == "no_effect"
    assert env2.service.advance_run(run_id, env2.principal(ALICE), worker_id="canceller").status == "CANCELLED"
    assert env2.erp.count("acme") == 0


def test_C16_revocation_reconciles_then_stops_cancelled(env, pkg, clock):
    run_id, env2 = _crash_before_erp_commit(env, pkg, clock)
    revoke(env2.store, pkg.artifact_hash, env2.principal("user:dana"), "defect found", env2.clock())
    out = env2.service.advance_run(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert out.status == "CANCELLED"
    assert out.checkpoint.assurance.unresolved_effects == []
    assert out.checkpoint.assurance.diagnostics[-1]["code"] == "ARTIFACT_REVOKED"
    assert env2.erp.count("acme") == 0


def test_C16_retry_budget_exhausted_then_cancel_completes(env, pkg, clock):
    run_id, env2 = _crash_before_erp_commit(env, pkg, clock)
    lid = _persist_intent(env2, run_id)["logical_action_id"]
    for _ in range(5):  # exhaust the retry budget for the uncertain write
        env2.store.update_intent("acme", lid, "DISPATCHING", env2.clock(), bump_attempt=True)
    out = env2.service.advance_run(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert out.status == "RECONCILING"
    cr = env2.service.cancel_run(run_id, None, env2.principal(ALICE), worker_id="worker-2")
    assert cr.status == "CANCELLED" and cr.unresolved == []


# ---- C11 / C17: a cancelled run is never reopened by a late interaction response -------------- #
def test_C11_C17_answer_after_cancel_is_rejected(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    cr = env.service.cancel_run(run_id, None, env.principal(ALICE), worker_id="worker-1")
    assert cr.status == "CANCELLED"
    assert env.store.interaction("acme", res.interaction["interaction_id"])["status"] != "OPEN"
    with pytest.raises(RunError):
        approve(env, run_id, res.interaction)
    assert env.store.get_run("acme", run_id)["status"] == "CANCELLED"
    assert env.store.response("acme", res.interaction["interaction_id"]) is None


def test_C11_terminal_run_status_is_never_overwritten(env, pkg):
    run_id, _ = run_to_approval(env, pkg)
    env.service.cancel_run(run_id, None, env.principal(ALICE), worker_id="worker-1")
    assert env.store.set_run_status("acme", run_id, "RUNNING") is False
    assert env.store.get_run("acme", run_id)["status"] == "CANCELLED"


# ---- C12: a fenced-off worker never overwrites an in-flight intent ----------------------------- #
def test_C12_stale_worker_cannot_overwrite_unknown_effect(env, pkg, clock):
    env.catalog.tools["erp.create_draft"].effect = "non_idempotent_write"
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)  # positioned at PERSIST_DRAFT; worker-1 holds the lease
    real = env.broker.dispatch
    seen = {"n": 0}

    def interleaved(**kw):
        seen["n"] += 1
        if seen["n"] == 1:  # worker A holds a PENDING snapshot; worker B runs a full step meanwhile
            clock.advance(env.service.lease_ttl + 1)
            env.erp.inject("timeout_after_commit")
            b = env.service.advance_run(run_id, env.principal(ALICE), worker_id="worker-2")
            assert b.status == "RECONCILING"
            assert _persist_intent(env, run_id)["status"] == "UNKNOWN_EFFECT"
        return real(**kw)

    env.broker.dispatch = interleaved
    try:  # worker A is fenced off, or sees the fresh UNKNOWN_EFFECT status and pauses for reconciliation
        a = env.service.advance_run(run_id, env.principal(ALICE), worker_id="worker-1")
        assert a.status == "RECONCILING"
    except RunError as exc:
        assert exc.code == "STALE_LEASE"
    env.broker.dispatch = real
    assert _persist_intent(env, run_id)["status"] == "UNKNOWN_EFFECT"
    assert not any(r["dispatch_state"] == "DENIED" for r in env.store.receipts("acme", run_id=run_id))
    clock.advance(env.service.lease_ttl + 1)
    c = env.service.advance_run(run_id, env.principal(ALICE), worker_id="worker-3")
    assert c.status == "RECONCILING"
    assert [op for op, _ in env.erp.calls].count("create") == 1
    assert env.service._unresolved("acme", run_id)


def test_C12_stale_denial_does_not_touch_ledger(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    cp = env.service._cp("acme", run_id)
    prep = env.service._prepare_tool(cp, env.service.package(cp.artifact_hash), cp.state_id, cp.revision)
    t1 = env.store.acquire_lease("acme", run_id, "worker-1", clock(), 10)
    intent = env.store.create_intent("acme", run_id, prep["lid"], cp.state_id, cp.revision, prep["spec"].name,
                                     prep["spec"].version, prep["args"], prep["args_digest"], prep["idem"], t1,
                                     clock())
    clock.advance(11)
    env.store.acquire_lease("acme", run_id, "worker-2", clock(), 10)
    r = env.broker.dispatch(intent=intent, principal=env.principal(ALICE), package=env.service.package(cp.artifact_hash),
                            business_unit="BU-EMEA", approval_check=lambda: (True, ""), lease_token=t1,
                            subject_values={})
    assert r.status == "DENIED" and r.reason.startswith("STALE_LEASE")
    assert env.store.intent_for_revision("acme", run_id, cp.revision)["status"] == "PENDING"
    assert env.store.receipts("acme", prep["lid"]) == []


def test_C12_stale_stop_raises_run_error_not_conflict(env, pkg, clock):
    run_id, _ = run_to_approval(env, pkg)
    run = env.store.get_run("acme", run_id)
    cp = env.service._cp("acme", run_id)
    with pytest.raises(RunError) as e:
        env.service._stop(run, cp, 999, "FAILED", "X", "y")
    assert e.value.code == "STALE_LEASE"
    assert not isinstance(e.value, ConflictError)


# ---- C14: receipt and intent status are consistent after a crash ------------------------------ #
def test_C14_crash_between_receipt_and_intent_update(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    real = env.store.update_intent
    state = {"n": 0}

    def crashy(tenant, lid, status, *a, **k):
        if status == "SUCCEEDED" and state["n"] == 0:
            state["n"] = 1
            raise SimulatedCrash("process died after receipt insert, before intent update")
        return real(tenant, lid, status, *a, **k)

    env.store.update_intent = crashy
    try:
        env.service.run_until_blocked(run_id, env.principal(ALICE))
    except SimulatedCrash:
        pass
    env2 = _restart(env, clock)
    out = env2.service.run_until_blocked(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert out.status == "COMPLETED" and out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert out.checkpoint.assurance.unresolved_effects == []
    assert env2.erp.count("acme") == 1


def test_C14_dedup_repairs_intent_left_dispatching(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.faults.arm("after_receipt")
    with pytest.raises(SimulatedCrash):
        env.service.run_until_blocked(run_id, env.principal(ALICE))
    lid = _persist_intent(env, run_id)["logical_action_id"]
    env.store.update_intent("acme", lid, "DISPATCHING", clock())  # legacy partial write: receipt, no status
    env2 = _restart(env, clock)
    out = env2.service.run_until_blocked(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert out.status == "COMPLETED" and out.checkpoint.outcome["category"] == "verified"
    assert _persist_intent(env2, run_id)["status"] == "SUCCEEDED"
    assert env2.erp.count("acme") == 1


# ---- C15: verifier evidence survives a crash after its receipt -------------------------------- #
def test_C15_crash_after_verifier_receipt_keeps_evidence(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    step_until_state(env, run_id, "VERIFY_PERSISTED")
    env.faults.arm("after_receipt")
    with pytest.raises(SimulatedCrash):
        env.service.run_until_blocked(run_id, env.principal(ALICE))
    env2 = _restart(env, clock)
    out = env2.service.run_until_blocked(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert out.status == "COMPLETED" and out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"


def test_C15_missing_evidence_is_rederived_from_succeeded_receipt(env, pkg, clock, monkeypatch):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    step_until_state(env, run_id, "VERIFY_PERSISTED")
    monkeypatch.setattr(env.store, "_add_evidence", lambda db, tenant, rec: None)  # evidence write lost
    env.faults.arm("before_commit")
    with pytest.raises(SimulatedCrash):
        env.service.advance_run(run_id, env.principal(ALICE))
    assert not [e for e in env.store.evidence("acme", run_id) if e["verifier"] == "draft.verify_persisted"]
    env2 = _restart(env, clock)  # a new Store instance over the same file (the patch does not carry over)
    out = env2.service.run_until_blocked(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert out.status == "COMPLETED" and out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"


# ---- C18: evidence receipt ids are scoped per run --------------------------------------------- #
def test_C18_second_run_adopting_same_draft_keeps_its_evidence(env, pkg):
    run1, res = run_to_approval(env, pkg)
    approve(env, run1, res.interaction)
    o1 = env.service.run_until_blocked(run1, env.principal(ALICE))
    assert o1.status == "COMPLETED"
    run2, res2 = run_to_approval(env, pkg)
    approve(env, run2, res2.interaction)
    env.erp.inject("timeout_before_commit")
    o2 = env.service.run_until_blocked(run2, env.principal(ALICE))
    assert o2.checkpoint.variables["erp_draft_id"] == o1.checkpoint.variables["erp_draft_id"]
    assert o2.status == "COMPLETED" and o2.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert any(e["verifier"] == "draft.verify_persisted" for e in env.store.evidence("acme", run2))
    # invalidating run2's receipt does not touch run1's receipt with the same id
    rid = o2.checkpoint.variables["verification_receipt"]
    env.store.invalidate_evidence("acme", rid, "test", env.clock(), run_id=run2)
    assert [e["invalidated_at"] for e in env.store.evidence("acme", run1) if e["receipt_id"] == rid] == [None]


def test_C18_store_migrates_v1_evidence_key(tmp_path):
    import sqlite3
    path = str(tmp_path / "old.db")
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE evidence_receipts(tenant_id TEXT NOT NULL, receipt_id TEXT NOT NULL, run_id TEXT NOT "
               "NULL, claim TEXT NOT NULL, verifier TEXT NOT NULL, verifier_version TEXT NOT NULL, subject TEXT NOT "
               "NULL, subject_digest TEXT NOT NULL, result TEXT NOT NULL, source_ref TEXT NOT NULL, observed_at REAL "
               "NOT NULL, invalidated_at REAL, invalidation_reason TEXT, PRIMARY KEY(tenant_id, receipt_id))")
    db.execute("INSERT INTO evidence_receipts VALUES('t','r','run1','c','v','1','{}','d','match','s',1,NULL,NULL)")
    db.commit()
    db.close()
    st = Store(path)
    rec = {"receipt_id": "r", "run_id": "run2", "claim": "c", "verifier": "v", "verifier_version": "1", "subject": {},
           "subject_digest": "d", "result": "match", "source_ref": "s", "observed_at": 2}
    st.add_evidence("t", rec)
    assert len(st.evidence("t", "run1")) == 1 and len(st.evidence("t", "run2")) == 1


# ---- C19: a response that lost the race is not reported as answered ---------------------------- #
def test_C19_losing_concurrent_response_is_rejected(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    ix = res.interaction
    real = env.store.record_response
    state = {"n": 0}

    def racing(*a, **k):
        if state["n"] == 0:
            state["n"] = 1
            approve(env, run_id, ix)  # tab 1 wins the race
        return real(*a, **k)

    env.store.record_response = racing
    with pytest.raises(RunError) as e:
        env.service.resume_interaction(run_id, ix["interaction_id"],
                                       {"approval_decision": "rejected", "scope_digest": ix["scope_digest"]},
                                       env.principal("user:bob"), request_id="tab-2")
    assert e.value.code == "ALREADY_ANSWERED"
    answered = [ev for ev in env.store.events("acme", run_id) if ev["type"] == "INTERACTION_ANSWERED"]
    assert len(answered) == 1
    assert env.store.response("acme", ix["interaction_id"])["response"]["approval_decision"] == "approved"


# ---- X00: a write whose tool left the catalog is still disclosed ------------------------------ #
def test_X00_cancel_discloses_write_of_retired_tool(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.faults.arm("after_remote_call")
    with pytest.raises(SimulatedCrash):
        env.service.run_until_blocked(run_id, env.principal(ALICE))
    assert env.erp.count("acme") == 1
    env2 = _restart(env, clock)
    del env2.catalog.tools["erp.create_draft"]
    cr = env2.service.cancel_run(run_id, None, env2.principal(ALICE))
    assert cr.status == "RECONCILING"
    assert cr.unresolved and "erp.create_draft" in cr.unresolved[0]


# ---- X01: human resolution of a non-idempotent write ----------------------------------------- #
def _non_idempotent_reconciling(env, pkg):
    env.catalog.tools["erp.create_draft"].effect = "non_idempotent_write"
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.erp.inject("timeout_after_commit")
    out = env.service.run_until_blocked(run_id, env.principal(ALICE))
    assert out.status == "RECONCILING"
    return run_id, _persist_intent(env, run_id)["logical_action_id"]


def test_X01_resolution_present_lets_run_continue(env, pkg):
    run_id, lid = _non_idempotent_reconciling(env, pkg)
    with pytest.raises(RunError) as e:
        env.service.resolve_effect(run_id, lid, "present", env.principal(ALICE), output={})
    assert e.value.code == "NOT_AUTHORIZED"
    draft = env.erp.read_draft({"draft_id": "D-0001"}, {"tenant_id": "acme"})
    assert draft["status"] == "found"
    env.service.resolve_effect(run_id, lid, "present", env.principal("user:bob"),
                               output={"status": "created", "draft_id": "D-0001", "version": 1}, note="seen in ERP")
    out = env.service.run_until_blocked(run_id, env.principal(ALICE))
    assert out.status == "COMPLETED" and out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert [op for op, _ in env.erp.calls].count("create") == 1


def test_X01_resolution_absent_lets_cancel_finish(env, pkg, clock):
    run_id, lid = _non_idempotent_reconciling(env, pkg)
    env.service.resolve_effect(run_id, lid, "absent", env.principal("user:bob"), note="checked: nothing there")
    clock.advance(1000)
    cr = env.service.cancel_run(run_id, None, env.principal(ALICE))
    assert cr.status == "CANCELLED" and cr.unresolved == []


# ---- X01 (round 2): only writes may be resolved by a human ------------------------------------ #
def _crash_in(env, run_id, tool):
    env.faults.arm("after_remote_call")
    with pytest.raises(SimulatedCrash):
        env.service.advance_run(run_id, env.principal(ALICE))
    it = [i for i in env.store.intents("acme", run_id) if i["tool"] == tool][-1]
    assert it["status"] == "DISPATCHING"
    return it["logical_action_id"]


def test_X01_verifier_result_cannot_be_forged_by_resolution(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    step_until_state(env, run_id, "VERIFY_PERSISTED")
    lid = _crash_in(env, run_id, "draft.verify_persisted")
    for outcome, output in (("present", {"status": "match", "receipt_id": "vr_FORGED"}), ("absent", None)):
        with pytest.raises(RunError) as e:
            env.service.resolve_effect(run_id, lid, outcome, env.principal("user:bob"), output=output)
        assert e.value.code == "NOT_A_WRITE"
    env2 = _restart(env, clock)
    out = env2.service.run_until_blocked(run_id, env2.principal(ALICE), worker_id="worker-2")
    assert out.status == "COMPLETED"
    assert all(ev["receipt_id"] != "vr_FORGED" for ev in env2.store.evidence("acme", run_id))


def test_X01_validator_result_cannot_be_forged_by_resolution(env, pkg):
    p = env.principal(ALICE)
    run_id = env.service.start_run(pkg.artifact_hash, TASK, p).run_id
    step_until_state(env, run_id, "VALIDATE_DRAFT")
    lid = _crash_in(env, run_id, "draft.validate")
    draft = env.store.intent("acme", lid)["args"]["draft"]
    with pytest.raises(RunError) as e:
        env.service.resolve_effect(run_id, lid, "present", env.principal("user:bob"),
                                   output={"status": "pass", "issues": [], "draft_digest": fakes.draft_digest(draft)})
    assert e.value.code == "NOT_A_WRITE"
    assert env.store.intent("acme", lid)["status"] == "DISPATCHING"


def test_X01_retired_tool_may_only_be_resolved_absent(env, pkg, clock):
    run_id, lid = _non_idempotent_reconciling(env, pkg)
    del env.catalog.tools["erp.create_draft"]
    with pytest.raises(RunError) as e:
        env.service.resolve_effect(run_id, lid, "present", env.principal("user:bob"),
                                   output={"status": "created", "draft_id": "D-0001", "version": 1})
    assert e.value.code == "UNKNOWN_TOOL"
    assert env.service.resolve_effect(run_id, lid, "absent", env.principal("user:bob"))["status"] == "ABANDONED"
