"""Recovery on both backends + real multi-process workers on PostgreSQL (brief §5, §11, R12).

* crash injection at every ``FaultInjector`` point, parametrized over ``[sqlite, postgres]``: the
  restarted worker finishes the run with exactly one ERP draft;
* on PostgreSQL, a worker OS process that dies (``os._exit``) at every fault point is recovered by
  another process;
* on PostgreSQL, N >= 4 OS processes (multiprocessing, spawn) race ``run_until_blocked`` /
  ``advance_run`` on the same approved run, sharing one file-backed FakeERP: the run completes exactly
  once, with exactly one ERP draft, no duplicate checkpoints and strictly increasing revisions -
  both with exclusive leases and in a "lease storm" where leases expire after milliseconds so workers
  keep stealing the run from each other mid-step (fencing + revision CAS must hold).
"""

from __future__ import annotations

import multiprocessing as mp
import os
import time
import traceback
from pathlib import Path

import pytest

from hexis_service.demo import fakes
from hexis_service.demo.env import admit_initial, build_env
from hexis_service.tools.broker import FaultInjector, SimulatedCrash

from ..conftest import approve, run_to_approval
from ..integration.test_postgres_store import BACKENDS, backend_url, needs_pg, pg_database


@pytest.fixture(params=BACKENDS)
def store_url(request, tmp_path):
    with backend_url(request.param, tmp_path) as url:
        yield url


@pytest.fixture
def benv(store_url, pkg, clock, tmp_path):
    e = build_env(str(tmp_path / "state"), clock=clock, store_url=store_url)
    assert admit_initial(e, pkg).status == "ADMITTED"
    return e


def _assert_exactly_once(store, erp_count: int, run_id: str) -> None:
    run = store.get_run("acme", run_id)
    cps = store.checkpoints("acme", run_id)
    assert run["status"] == "COMPLETED", run
    assert cps[-1]["outcome"]["terminal"] == "END_VERIFIED_DRAFT"
    revs = [c["revision"] for c in cps]
    assert revs == list(range(len(revs))), revs  # no duplicate / missing revision, strictly increasing
    assert [c["status"] for c in cps].count("COMPLETED") == 1  # completed exactly once
    seqs = [e["sequence"] for e in store.events("acme", run_id)]
    assert seqs == list(range(1, len(seqs) + 1))
    assert erp_count == 1
    creates = [r for r in store.receipts("acme", run_id=run_id)
               if r["tool"] == "erp.create_draft" and r["dispatch_state"] == "SUCCEEDED"]
    assert creates and len({r["external_ref"] for r in creates}) == 1


# ---- crash injection, both backends ------------------------------------------------------------ #
@pytest.mark.parametrize("point", FaultInjector.POINTS)
def test_crash_at_each_point_exactly_one_draft(benv, pkg, clock, point):
    run_id, res = run_to_approval(benv, pkg)
    approve(benv, run_id, res.interaction)
    benv.faults.arm(point)
    with pytest.raises(SimulatedCrash):
        benv.service.run_until_blocked(run_id, benv.principal("user:alice"))
    benv.store.close()  # the crashed worker's connection is gone
    clock.advance(1000)  # ... and its lease expires
    env2 = benv.restart()
    out = env2.service.run_until_blocked(run_id, env2.principal("user:alice"), worker_id="worker-2")
    assert out.status == "COMPLETED" and out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    _assert_exactly_once(env2.store, env2.erp.count("acme"), run_id)


# ---- multi-process on PostgreSQL --------------------------------------------------------------- #
class _OffsetClock:
    """Wall-clock time shifted to start at ``t0`` (the fixture's manual clock), shared across processes."""

    def __init__(self, t0: float, wall0: float):
        self.t0, self.wall0 = t0, wall0

    def __call__(self) -> float:
        return self.t0 + (time.time() - self.wall0)


def _prepare(url: str, workdir: str, pkg, t0: float) -> str:
    from hexis_service.demo.env import ManualClock
    clock = ManualClock(t0)
    env = build_env(workdir, clock=clock, store_url=url)
    assert admit_initial(env, pkg).status == "ADMITTED"
    run_id, res = run_to_approval(env, pkg)
    assert res.status == "WAITING_FOR_APPROVAL"
    approve(env, run_id, res.interaction)
    env.store.close()
    return run_id


def _race_worker(url: str, workdir: str, run_id: str, worker_id: str, t0: float, wall0: float, ttl: float,
                 mode: str, barrier, results) -> None:
    out = {"worker": worker_id, "codes": [], "statuses": [], "details": [], "revisions": [], "unexpected": []}
    try:
        from hexis_service.runtime.service import RunError
        env = build_env(workdir, clock=_OffsetClock(t0, wall0), store_url=url)  # shares workdir/fake_erp.db
        env.service.lease_ttl = ttl
        alice = env.principal("user:alice")
        barrier.wait(timeout=60)
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if mode == "advance":
                    res = env.service.advance_run(run_id, alice, worker_id=worker_id)
                else:
                    res = env.service.run_until_blocked(run_id, alice, worker_id=worker_id)
                out["statuses"].append(res.status)
                out["details"].append(res.detail)
                out["revisions"].append(res.checkpoint.revision)
                if res.status not in ("RUNNING",):
                    break
            except RunError as exc:
                out["codes"].append(exc.code)
                time.sleep(0.002)
            except Exception as exc:  # noqa: BLE001 - reported to the parent, which decides
                out["unexpected"].append(f"{type(exc).__name__}: {exc}")
                time.sleep(0.002)
        env.store.close()
    except Exception:  # noqa: BLE001
        out["unexpected"].append(traceback.format_exc())
    results.put(out)


def _race(url: str, workdir: str, run_id: str, t0: float, n: int, ttl: float, mode: str) -> list[dict]:
    ctx = mp.get_context("spawn")
    barrier, results = ctx.Barrier(n), ctx.Queue()
    wall0 = time.time() + 1.0
    procs = [ctx.Process(target=_race_worker, args=(url, workdir, run_id, f"proc-{i}", t0, wall0, ttl, mode,
                                                    barrier, results)) for i in range(n)]
    for p in procs:
        p.start()
    outs = [results.get(timeout=180) for _ in procs]
    for p in procs:
        p.join(timeout=30)
        assert p.exitcode == 0
    return outs


@needs_pg
@pytest.mark.parametrize("mode,ttl", [("run_until_blocked", 300.0), ("advance", 300.0),
                                      ("run_until_blocked", 0.005), ("advance", 0.005)],
                         ids=["exclusive-run_until_blocked", "exclusive-advance", "lease-storm-run_until_blocked",
                              "lease-storm-advance"])
def test_multiprocess_workers_complete_run_exactly_once(pkg, clock, tmp_path, mode, ttl):
    n = 4
    workdir = str(tmp_path / "shared")
    with pg_database() as url:
        run_id = _prepare(url, workdir, pkg, clock())
        outs = _race(url, workdir, run_id, clock() + 1000, n, ttl, mode)  # preparer lease expired
        from hexis_service.storage import open_store
        st = open_store(url)
        try:
            erp = fakes.FakeERP(str(Path(workdir) / "fake_erp.db"))
            _assert_exactly_once(st, erp.count("acme"), run_id)
            assert all(not o["unexpected"] for o in outs), [o["unexpected"] for o in outs]
            allowed = {"LEASE_HELD", "STALE_LEASE", "REVISION_CONFLICT"}
            assert all(set(o["codes"]) <= allowed for o in outs), [o["codes"] for o in outs]
            for o in outs:  # each worker only ever observes revisions moving forward
                assert o["revisions"] == sorted(o["revisions"]), o
            # every worker ends up seeing the finished run; exactly one checkpoint completed it
            # (a "run finished" answer may carry the run status read just before the final commit, so the
            # last answer is judged by its checkpoint, which is always the terminal one)
            assert all(o["revisions"] and o["revisions"][-1] == len(st.checkpoints("acme", run_id)) - 1
                       for o in outs), outs
            if ttl >= 300:  # exclusive leases: only the lease holder ever stepped the run
                steppers = [o for o in outs if any(d != "run finished" for d in o["details"])]
                assert len(steppers) == 1, outs
        finally:
            st.close()


def _crash_worker(url: str, workdir: str, run_id: str, t0: float, point: str) -> None:
    from hexis_service.demo.env import ManualClock
    env = build_env(workdir, clock=ManualClock(t0), store_url=url)
    env.faults.arm(point)
    try:
        env.service.run_until_blocked(run_id, env.principal("user:alice"), worker_id="doomed")
    except SimulatedCrash:
        os._exit(17)  # die without closing anything, mid-run
    os._exit(0)


@needs_pg
@pytest.mark.parametrize("point", FaultInjector.POINTS)
def test_worker_process_killed_at_each_point_is_recovered(pkg, clock, tmp_path, point):
    workdir = str(tmp_path / "shared")
    with pg_database() as url:
        run_id = _prepare(url, workdir, pkg, clock())
        p = mp.get_context("spawn").Process(target=_crash_worker, args=(url, workdir, run_id, clock() + 1000, point))
        p.start()
        p.join(timeout=120)
        assert p.exitcode == 17
        clock.advance(2000)  # the dead worker's lease expires
        env = build_env(workdir, clock=clock, store_url=url)
        out = env.service.run_until_blocked(run_id, env.principal("user:alice"), worker_id="rescuer")
        assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
        _assert_exactly_once(env.store, env.erp.count("acme"), run_id)
        env.store.close()
