"""Crash injection and uncertain effects: A22, A23, A24, A27 + every dispatch boundary."""

from __future__ import annotations

import pytest

from hexis_service.storage.sqlite import ConflictError
from hexis_service.tools.broker import FaultInjector, SimulatedCrash

from ..conftest import approve, run_to_approval


def _restart_and_finish(env, clock, run_id):
    clock.advance(1000)  # the crashed worker's lease expires
    env2 = env.restart()
    out = env2.service.run_until_blocked(run_id, env2.principal("user:alice"), worker_id="worker-2")
    return env2, out


@pytest.mark.parametrize("point", FaultInjector.POINTS)
def test_crash_at_each_boundary_never_duplicates_the_write(env, pkg, clock, point):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)  # now positioned at PERSIST_DRAFT
    env.faults.arm(point)
    with pytest.raises(SimulatedCrash):
        env.service.run_until_blocked(run_id, env.principal("user:alice"))
    env2, out = _restart_and_finish(env, clock, run_id)
    assert out.status == "COMPLETED" and out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert env2.erp.count("acme") == 1
    creates = [r for r in env2.store.receipts("acme", run_id=run_id)
               if r["tool"] == "erp.create_draft" and r["dispatch_state"] == "SUCCEEDED"]
    assert len({r["external_ref"] for r in creates}) == 1


def test_A22_crash_after_remote_commit_reconciles(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.faults.arm("after_remote_call")
    with pytest.raises(SimulatedCrash):
        env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert env.erp.count("acme") == 1
    env2, out = _restart_and_finish(env, clock, run_id)
    assert env2.erp.count("acme") == 1
    rec = [r for r in env2.store.receipts("acme", run_id=run_id) if r["tool"] == "erp.create_draft"]
    assert [r["certainty"] for r in rec] == ["reconciled"]


def test_timeout_after_commit_reconciles_same_draft(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.erp.inject("timeout_after_commit")
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert env.erp.count("acme") == 1
    kinds = [e["type"] for e in env.store.events("acme", run_id)]
    assert "EFFECT_UNKNOWN" in kinds and "RECONCILED" in kinds


def test_timeout_before_commit_retries_same_key_after_proving_absence(env, pkg):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.erp.inject("timeout_before_commit")
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    keys = [k for op, k in env.erp.calls if op == "create"]
    assert len(keys) == 2 and keys[0] == keys[1]  # same idempotency key
    assert env.erp.count("acme") == 1


def test_A23_non_idempotent_timeout_pauses_without_blind_retry(env, pkg):
    env.catalog.tools["erp.create_draft"].effect = "non_idempotent_write"
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.erp.inject("timeout_after_commit")
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.status == "RECONCILING"
    again = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert again.status == "RECONCILING"
    assert [op for op, _ in env.erp.calls].count("create") == 1  # never blindly repeated


def test_A24_stale_worker_fenced_off(env, pkg, clock):
    run_id, _ = run_to_approval(env, pkg)
    t1 = env.store.acquire_lease("acme", run_id, "worker-1", clock(), 10)
    assert env.store.acquire_lease("acme", run_id, "worker-2", clock(), 10) is None  # held
    clock.advance(11)
    t2 = env.store.acquire_lease("acme", run_id, "worker-2", clock(), 10)
    assert t2 == t1 + 1
    cp = env.store.latest_checkpoint("acme", run_id)
    with pytest.raises(ConflictError, match="STALE_LEASE"):
        env.store.commit_transition("acme", run_id, cp["revision"], t1, {**cp, "revision": cp["revision"] + 1}, [],
                                    clock())
    intent = {"tenant_id": "acme", "run_id": run_id, "logical_action_id": "la_x", "tool": "erp.read_draft",
              "tool_version": "1.0.0", "args": {"draft_id": "D-1"}, "args_digest": "d", "idempotency_key": "k"}
    ok, why = env.broker.authorize(intent=intent, spec=env.catalog.get("erp.read_draft"),
                                   principal=env.principal("user:alice"), package=pkg, business_unit="BU-EMEA",
                                   approval_check=lambda: (True, ""), lease_token=t1)
    assert (ok, why) == (False, "STALE_LEASE")


def test_A27_cancel_races_in_flight_write(env, pkg, clock):
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.faults.arm("after_remote_call")
    with pytest.raises(SimulatedCrash):
        env.service.run_until_blocked(run_id, env.principal("user:alice"))
    clock.advance(1000)
    env2 = env.restart()
    cr = env2.service.cancel_run(run_id, None, env2.principal("user:alice"))
    assert cr.status == "CANCELLED"
    assert len(cr.disclosed_effects) == 1 and cr.disclosed_effects[0]["external_ref"].startswith("D-")
    assert cr.unresolved == []
    out = env2.service.advance_run(run_id, env2.principal("user:alice"), worker_id="worker-3")
    assert out.status == "CANCELLED"
    assert env2.erp.count("acme") == 1


def test_cancel_with_unresolvable_effect_is_not_reported_safe(env, pkg, clock):
    env.catalog.tools["erp.create_draft"].effect = "non_idempotent_write"
    run_id, res = run_to_approval(env, pkg)
    approve(env, run_id, res.interaction)
    env.erp.inject("timeout_after_commit")
    env.service.run_until_blocked(run_id, env.principal("user:alice"))
    cr = env.service.cancel_run(run_id, None, env.principal("user:alice"))
    assert cr.status == "CANCEL_REQUESTED" and cr.unresolved  # worker still holds the lease
    clock.advance(1000)
    cr = env.service.cancel_run(run_id, None, env.principal("user:alice"))
    assert cr.status == "RECONCILING" and cr.unresolved and cr.unresolved[0].endswith("UNKNOWN_EFFECT")
