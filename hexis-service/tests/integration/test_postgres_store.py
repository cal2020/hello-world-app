"""Backend contract suite: the same behaviour on SQLite and PostgreSQL (brief §5, §11.1-11.3, R12).

Every test here is parametrized over ``[sqlite, postgres]``. The postgres variant runs against a fresh
database created per test on the server named by ``HEXIS_TEST_PG_DSN`` (and dropped afterwards); it is
skipped when that variable is unset. Crash injection at every fault point is in
``tests/recovery/test_postgres_recovery.py`` together with the real multi-process test.
"""

from __future__ import annotations

import os
import threading
import uuid
from contextlib import contextmanager
from typing import Iterator
from urllib.parse import urlsplit, urlunsplit

import pytest

from hexis_service.artifacts.registry import admit, enroll_protected
from hexis_service.demo.env import admit_initial, build_env, skill_source
from hexis_service.demo.procurement_fixture import deployment_policy
from hexis_service.runtime.service import RunError
from hexis_service.storage import open_store
from hexis_service.storage.sqlite import SCHEMA_VERSION, ConflictError, Store
from hexis_service.traces.model import export_run_trace

from ..conftest import approve, run_to_approval

PG_DSN = os.environ.get("HEXIS_TEST_PG_DSN", "")
needs_pg = pytest.mark.skipif(not PG_DSN, reason="set HEXIS_TEST_PG_DSN to run the PostgreSQL backend tests")
BACKENDS = ["sqlite", pytest.param("postgres", marks=needs_pg)]
SKILL = "supplier-onboarding-draft"


def _with_db(dsn: str, name: str) -> str:
    parts = urlsplit(dsn)
    return urlunsplit(parts._replace(path="/" + name))


@contextmanager
def pg_database() -> Iterator[str]:
    """A fresh, uniquely named database on the test server; dropped (connections forced off) afterwards."""
    import psycopg
    name = "hexis_test_" + uuid.uuid4().hex[:12]
    admin = psycopg.connect(PG_DSN, autocommit=True)
    try:
        admin.execute(f'CREATE DATABASE "{name}"')
        try:
            yield _with_db(PG_DSN, name)
        finally:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        admin.close()


@contextmanager
def backend_url(backend: str, tmp_path) -> Iterator[str]:
    if backend == "sqlite":
        (tmp_path / "state").mkdir(parents=True, exist_ok=True)
        yield "sqlite:///" + str(tmp_path / "state" / "hexis.db")
    else:
        with pg_database() as url:
            yield url


@pytest.fixture(params=BACKENDS)
def store_url(request, tmp_path) -> Iterator[str]:
    with backend_url(request.param, tmp_path) as url:
        yield url


@pytest.fixture
def raw_env(store_url, clock, tmp_path):
    return build_env(str(tmp_path / "state"), clock=clock, store_url=store_url)


@pytest.fixture
def benv(raw_env, pkg):
    assert admit_initial(raw_env, pkg).status == "ADMITTED"
    return raw_env


# ---- selection / schema ---------------------------------------------------------------------- #
def test_postgres_store_has_exactly_the_sqlite_store_surface():
    import inspect
    pytest.importorskip("psycopg")
    from hexis_service.storage.postgres import PostgresStore

    def surface(cls):
        return {n: list(inspect.signature(getattr(cls, n)).parameters) for n in dir(cls)
                if not n.startswith("_") and callable(getattr(cls, n))}
    assert surface(PostgresStore) == surface(Store)



def test_open_store_selects_backend(tmp_path):
    assert isinstance(open_store(":memory:"), Store)
    assert isinstance(open_store("sqlite://"), Store) and open_store("sqlite:///:memory:").path == ":memory:"
    assert open_store(str(tmp_path / "a.db")).path == str(tmp_path / "a.db")
    assert open_store("sqlite:///" + str(tmp_path / "b.db")).path == str(tmp_path / "b.db")
    with pytest.raises(ValueError):
        open_store("mysql://nope")


@needs_pg
def test_open_store_postgres_url_gives_postgres_store():
    from hexis_service.storage.postgres import PostgresStore
    with pg_database() as url:
        st = open_store(url)
        try:
            assert isinstance(st, PostgresStore)
        finally:
            st.close()


def test_schema_version_recorded_and_migration_idempotent(raw_env):
    st = raw_env.store
    assert st.schema_version() == SCHEMA_VERSION
    again = st.reopen()  # re-running the migrations / DDL on an existing database is a no-op
    assert again.schema_version() == SCHEMA_VERSION
    assert again.qa("SELECT version FROM schema_migrations") == [(SCHEMA_VERSION,)]
    if type(st).__name__ == "PostgresStore":
        from hexis_service.storage.postgres import migrate
        assert migrate(again.db) == []


def _store_script(st) -> list:
    """A deterministic sequence of store operations; returns every observable result."""
    out = []
    cp0 = {"revision": 0, "status": "RUNNING", "x": [1, 2.5, None, "é"]}
    out.append(st.create_run("t", "r1", "sha256:a", "p", "req", cp0, [{"type": "A", "v": 1}], 1.5))
    out.append(st.create_run("t", "r2", "sha256:a", "p", "req", cp0, [], 1.5))
    out.append(st.acquire_lease("t", "r1", "w", 2.0, 10))
    out.append(st.create_intent("t", "r1", "lid1", "S", 0, "tool", "1", {"k": "v"}, "d", "idem", 1, 3.0))
    out.append(st.create_intent("t", "r1", "lid-other", "S", 0, "tool", "1", {}, "d", "idem", 1, 3.0))
    out.append(st.update_intent("t", "lid1", "DISPATCHING", 4.0, bump_attempt=True, require_token=1))
    out.append(st.record_outcome("t", "lid1", "r1", "tool", "1", "d", "idem", "SUCCEEDED", "certain", "X-1",
                                 {"ok": True}, "conn", 5.0, intent_status="SUCCEEDED",
                                 evidence=lambda seq: [{"receipt_id": f"e{seq}", "run_id": "r1", "claim": "c",
                                                        "verifier": "v", "verifier_version": "1", "subject": {"a": 1},
                                                        "subject_digest": "sd", "result": "match",
                                                        "source_ref": f"lid1#{seq}", "observed_at": 5.0}],
                                 require_token=1, expect_status=("DISPATCHING",)))
    out.append(st.record_outcome("t", "lid1", "r1", "tool", "1", "d", "idem", "X", "c", None, None, "conn", 6.0,
                                 intent_status="FAILED", expect_status=("PENDING",)))
    out.append(st.create_interaction("t", "r1", "ix1", "approval", "S", 1, {"s": 1}, "sd", 99.0, 6.0))
    out.append(st.record_response("t", "ix1", "r1", "bob", {"approval_decision": "approved"}, "sd", "rq", 7.0,
                                  events=[{"type": "RESP"}], run_status="RUNNING"))
    out.append(st.record_response("t", "ix1", "r1", "eve", {}, "sd", "rq2", 7.0))
    out.append(st.set_run_status("t", "r1", "WAITING_FOR_INPUT"))
    st.commit_transition("t", "r1", 0, 1, dict(cp0, revision=1, status="COMPLETED"), [{"type": "DONE"}], 8.0)
    out.append(st.set_run_status("t", "r1", "RUNNING"))  # terminal status is never overwritten
    st.invalidate_evidence("t", "e1", "stale", 9.0, run_id="r1")
    st.request_cancel("t", "r1")
    st.put_proposal("p1", "sha256:a", None, "CANDIDATE", {"b": 1}, 1.0)
    st.put_proposal("p1", "sha256:a", "sha256:b", "REJECTED", {"b": 2}, 2.0)
    out += [st.get_run("t", "r1"), st.latest_checkpoint("t", "r1"), st.checkpoints("t", "r1"),
            st.events("t", "r1"), st.intents("t", "r1"), st.intent("t", "lid1"), st.receipts("t", "lid1"),
            st.receipts("t", run_id="r1"), st.interaction("t", "ix1"), st.response("t", "ix1"),
            st.evidence("t", "r1"), st.lease_token("t", "r1"), st.run_by_request("t", "req"),
            st.qa("SELECT * FROM update_proposals")]
    return out


@needs_pg
def test_store_level_results_identical_on_both_backends():
    with pg_database() as url:
        pg = open_store(url)
        try:
            assert _store_script(pg) == _store_script(Store(":memory:"))
        finally:
            pg.close()


# ---- runs -------------------------------------------------------------------------------------- #
def test_full_procurement_run_to_verified_draft_with_approval(benv, pkg):
    run_id, res = run_to_approval(benv, pkg)
    assert res.status == "WAITING_FOR_APPROVAL"
    approve(benv, run_id, res.interaction)
    out = benv.service.run_until_blocked(run_id, benv.principal("user:alice"))
    assert out.status == "COMPLETED" and out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert benv.erp.count("acme") == 1
    revs = [c["revision"] for c in benv.store.checkpoints("acme", run_id)]
    assert revs == list(range(len(revs)))
    seqs = [e["sequence"] for e in benv.store.events("acme", run_id)]
    assert seqs == list(range(1, len(seqs) + 1))
    assert benv.store.get_run("acme", run_id)["status"] == "COMPLETED"
    assert any(e["result"] == "match" for e in benv.store.evidence("acme", run_id))


def test_worker_restart_resumes_same_backend(benv, pkg, clock):
    run_id, res = run_to_approval(benv, pkg)
    env2 = benv.restart()
    assert type(env2.store) is type(benv.store) and env2.store is not benv.store
    approve(env2, run_id, res.interaction)
    clock.advance(1000)  # the first worker's lease expires
    out = env2.service.run_until_blocked(run_id, env2.principal("user:alice"), worker_id="worker-2")
    assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert env2.erp.count("acme") == 1


# ---- fencing / CAS ----------------------------------------------------------------------------- #
def test_lease_fencing_and_revision_cas(benv, pkg, clock):
    run_id, _ = run_to_approval(benv, pkg)
    clock.advance(1000)  # worker-1's lease (from run_to_approval) expires
    st = benv.store
    t1 = st.acquire_lease("acme", run_id, "w1", clock(), 30)
    assert t1 is not None
    assert st.acquire_lease("acme", run_id, "w2", clock(), 30) is None  # held and unexpired
    with pytest.raises(RunError) as e:
        benv.service.advance_run(run_id, benv.principal("user:alice"), worker_id="w2")
    assert e.value.code == "LEASE_HELD"
    clock.advance(31)
    t2 = st.acquire_lease("acme", run_id, "w2", clock(), 30)
    assert t2 == t1 + 1 and st.lease_token("acme", run_id) == t2
    cp = st.latest_checkpoint("acme", run_id)
    nxt = dict(cp, revision=cp["revision"] + 1)
    with pytest.raises(ConflictError, match="STALE_LEASE"):
        st.commit_transition("acme", run_id, cp["revision"], t1, nxt, [{"type": "X"}], clock())
    with pytest.raises(ConflictError, match="REVISION_CONFLICT"):
        st.commit_transition("acme", run_id, cp["revision"] - 1, t2, nxt, [{"type": "X"}], clock())
    st.commit_transition("acme", run_id, cp["revision"], t2, nxt, [{"type": "X"}], clock())
    with pytest.raises(ConflictError, match="REVISION_CONFLICT"):  # the same CAS cannot win twice
        st.commit_transition("acme", run_id, cp["revision"], t2, nxt, [{"type": "X"}], clock())
    assert st.latest_checkpoint("acme", run_id)["revision"] == cp["revision"] + 1
    # the fenced-off worker's dispatch transition is refused too
    lid = st.intents("acme", run_id)[-1]["logical_action_id"] if st.intents("acme", run_id) else "none"
    with pytest.raises(ConflictError, match="STALE_LEASE"):
        st.update_intent("acme", lid, "DISPATCHING", clock(), require_token=t1, run_id=run_id)


def test_concurrent_commit_transition_only_one_wins(benv, pkg, clock):
    """Several connections race the same revision CAS: exactly one commits."""
    run_id, _ = run_to_approval(benv, pkg)
    tok = benv.store.acquire_lease("acme", run_id, "w", clock(), 300)
    cp = benv.store.latest_checkpoint("acme", run_id)
    stores = [benv.store.reopen() for _ in range(4)]
    barrier, wins, losses = threading.Barrier(len(stores)), [], []

    def go(st, i):
        barrier.wait()
        try:
            st.commit_transition("acme", run_id, cp["revision"], tok, dict(cp, revision=cp["revision"] + 1),
                                 [{"type": "X", "i": i}], clock())
            wins.append(i)
        except ConflictError as exc:
            losses.append(str(exc))

    ts = [threading.Thread(target=go, args=(st, i)) for i, st in enumerate(stores)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(wins) == 1 and len(losses) == 3 and all("REVISION_CONFLICT" in m for m in losses)
    assert [e["i"] for e in benv.store.events("acme", run_id) if e["type"] == "X"] == wins


def test_concurrent_lease_acquisition_single_owner(benv, pkg, clock):
    run_id, _ = run_to_approval(benv, pkg)
    clock.advance(1000)
    stores = [benv.store.reopen() for _ in range(4)]
    barrier, got = threading.Barrier(len(stores)), {}

    def go(st, i):
        barrier.wait()
        got[i] = st.acquire_lease("acme", run_id, f"w{i}", clock(), 300)

    ts = [threading.Thread(target=go, args=(st, i)) for i, st in enumerate(stores)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    winners = [i for i, tok in got.items() if tok is not None]
    assert len(winners) == 1 and benv.store.lease_token("acme", run_id) == got[winners[0]]


# ---- immutability ------------------------------------------------------------------------------ #
@pytest.mark.parametrize("sql", ["UPDATE run_events SET body='{}'", "DELETE FROM checkpoints",
                                 "UPDATE machine_versions SET package='{}'", "DELETE FROM action_receipts",
                                 "UPDATE trace_archive_manifests SET manifest='{}'", "DELETE FROM admission_reports",
                                 "UPDATE machine_lifecycle SET state='revoked'", "DELETE FROM approval_responses",
                                 "DELETE FROM trace_blobs"])
def test_immutability_triggers_reject_update_delete(benv, pkg, sql):
    run_id, res = run_to_approval(benv, pkg)
    approve(benv, run_id, res.interaction)
    benv.service.run_until_blocked(run_id, benv.principal("user:alice"))
    benv.store.put_trace("t-imm", "sha", "body", 1.0)
    before = (benv.store.events("acme", run_id), benv.store.checkpoints("acme", run_id),
              benv.store.receipts("acme", run_id=run_id), benv.store.lifecycle(pkg.artifact_hash))
    with pytest.raises(Exception, match="append-only"):
        with benv.store.tx() as db:
            db.execute(sql)
    after = (benv.store.events("acme", run_id), benv.store.checkpoints("acme", run_id),
             benv.store.receipts("acme", run_id=run_id), benv.store.lifecycle(pkg.artifact_hash))
    assert before == after and benv.store.trace_body("t-imm") == "body"


# ---- admission / archive CAS ------------------------------------------------------------------ #
def _admit(env, store, pkg, parent):
    return admit(store, pkg, env.catalog, expected_parent_hash=parent, approver=env.principal("user:dana"),
                 environment="sandbox", deployment_policy=deployment_policy(), protected=[], negative=[],
                 now=env.clock(), skill_text=skill_source().text)


def test_admission_cas_race_one_admitted_one_conflict(raw_env, pkg):
    stores = [raw_env.store.reopen(), raw_env.store.reopen()]
    barrier, out = threading.Barrier(2), {}
    orig = [st.publish_admission for st in stores]

    def go(i):
        st = stores[i]

        def synced(**kw):  # both publishers reach the atomic publish step together
            barrier.wait()
            return orig[i](**kw)
        st.publish_admission = synced
        out[i] = _admit(raw_env, st, pkg, None)

    ts = [threading.Thread(target=go, args=(i,)) for i in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(r.status for r in out.values()) == ["ADMITTED", "CONFLICT"], [r.reasons for r in out.values()]
    winner = next(r for r in out.values() if r.status == "ADMITTED")
    assert raw_env.store.get_active("sandbox", SKILL) == (pkg.artifact_hash, winner.archive_version)
    assert [e["state"] for e in raw_env.store.lifecycle(pkg.artifact_hash)] == ["validated", "admitted", "active"]
    assert raw_env.store.archive(SKILL)["version"] == 1


def test_publish_admission_cas_conflicts(benv, pkg):
    st = benv.store
    kw = dict(environment="sandbox", skill_id=SKILL, artifact_hash="sha256:x", traces=[], record={}, report={},
              env_key="sha256:x@sandbox", actor="dana", manifest={"protected": [], "negative": []}, now=2.0)
    r = st.publish_admission(expected_parent_hash=None, gated_archive_version=1, **kw)
    assert r == {"status": "CONFLICT", "conflict": "active", "current": pkg.artifact_hash}
    r = st.publish_admission(expected_parent_hash=pkg.artifact_hash, gated_archive_version=None, **kw)
    assert r == {"status": "CONFLICT", "conflict": "archive", "current": pkg.artifact_hash}
    assert st.get_active("sandbox", SKILL) == (pkg.artifact_hash, 1) and st.admission_record("sha256:x") is None
    r = st.publish_admission(expected_parent_hash=pkg.artifact_hash, gated_archive_version=1, **kw)
    assert r == {"status": "ADMITTED", "version": 2}
    assert st.get_active("sandbox", SKILL) == ("sha256:x", 2) and st.admission_record("sha256:x@sandbox")


def test_enroll_protected_cas(benv, pkg):
    alice = benv.principal("user:alice")
    run_id, res = run_to_approval(benv, pkg)
    approve(benv, run_id, res.interaction)
    benv.service.run_until_blocked(run_id, alice)
    trace = export_run_trace(benv.service, run_id, alice, "accepted")
    st = benv.store
    # a concurrent enrolment moved the archive between our read and our publish -> CONFLICT, nothing written
    manifest = {"protected": [], "negative": [], "held_out": "x"}
    assert st.append_archive_manifest(skill_id=SKILL, expected_version=0, artifact_hash=pkg.artifact_hash,
                                      manifest=manifest, traces=[], actor="dana", lifecycle_state="archive_enrolled:x",
                                      lifecycle_reason="", now=1.0) == {"status": "CONFLICT"}
    assert st.archive(SKILL)["version"] == 1
    real, calls = st.append_archive_manifest, []

    def racing(**kw):  # another enrolment wins just before ours publishes
        if not calls:
            calls.append(1)
            real(**dict(kw, traces=[], lifecycle_state="archive_enrolled:other"))
        return real(**kw)
    st.append_archive_manifest = racing
    try:
        r = enroll_protected(st, SKILL, [trace], actor=benv.principal("user:dana"), environment="sandbox",
                             now=benv.clock())
    finally:
        del st.append_archive_manifest
    assert r.status == "CONFLICT" and st.archive(SKILL)["version"] == 2
    r = enroll_protected(st, SKILL, [trace], actor=benv.principal("user:dana"), environment="sandbox",
                         now=benv.clock())
    assert r.status == "ADMITTED" and r.archive_version == 3
    assert st.get_active("sandbox", SKILL) == (pkg.artifact_hash, 3)
    assert [e["trace_id"] for e in st.archive(SKILL)["protected"]] == [trace.trace_id]
    assert st.trace_body(trace.trace_id) == trace.to_jsonl()


# ---- tenant isolation -------------------------------------------------------------------------- #
def test_tenant_isolation(benv, pkg):
    run_id, res = run_to_approval(benv, pkg)
    mallory = benv.principal("user:mallory")  # tenant globex
    for call in (lambda: benv.service.inspect_run(run_id, mallory),
                 lambda: benv.service.advance_run(run_id, mallory),
                 lambda: benv.service.resume_interaction(run_id, res.interaction["interaction_id"],
                                                         {"approval_decision": "approved",
                                                          "scope_digest": res.interaction["scope_digest"]}, mallory)):
        with pytest.raises(RunError):
            call()
    st = benv.store
    assert st.get_run("globex", run_id) is None and st.events("globex", run_id) == []
    assert st.checkpoints("globex", run_id) == [] and st.intents("globex", run_id) == []
    assert st.interaction("globex", res.interaction["interaction_id"]) is None
    # keys are tenant-scoped: the same run id and request id may exist in another tenant
    cp = st.latest_checkpoint("acme", run_id)
    assert st.create_run("globex", run_id, pkg.artifact_hash, "user:mallory", "req-1", cp, [{"type": "C"}], 1.0)
    assert st.create_run("acme", "run_other", pkg.artifact_hash, "user:alice", "req-1", cp, [{"type": "C"}], 1.0)
    assert not st.create_run("acme", "run_dup", pkg.artifact_hash, "user:alice", "req-1", cp, [], 1.0)
    assert st.run_by_request("globex", "req-1") == run_id and st.run_by_request("acme", "req-1") == "run_other"
    assert [e["type"] for e in st.events("globex", run_id)] == ["C"]
    assert st.get_run("acme", run_id)["principal"] == "user:alice"


def test_cli_store_flag_and_env_var(store_url, tmp_path, monkeypatch):
    from hexis_service.cli.main import main
    ex = __import__("pathlib").Path(__file__).resolve().parents[2] / "examples" / "procurement_onboarding"
    out = tmp_path / "pkg.json"
    assert main(["compile", "--skill", str(ex / "SKILL.md"), "--out", str(out)]) == 0
    state = tmp_path / "cli-state"
    assert main(["--store", store_url, "admit", "--package", str(out), "--state", str(state)]) == 0
    st = open_store(store_url)
    assert st.get_active("sandbox", SKILL) is not None
    monkeypatch.setenv("HEXIS_STORE_URL", store_url)
    # already admitted with no expected parent -> CONFLICT through the env-var-selected store
    assert main(["admit", "--package", str(out), "--state", str(state)]) == 3
    assert not (state / "hexis.db").exists()  # --store overrides the default SQLite file in --state
