"""PostgreSQL store for multi-worker deployment (brief §5, §11.1-11.3).

:class:`PostgresStore` has exactly the public method surface and semantics of
:class:`storage.sqlite.Store`; the runtime, broker, registry, traces, demo and CLI work unchanged on
either backend (select one with :func:`storage.open_store`).

Concurrency. SQLite serialises every writer with ``BEGIN IMMEDIATE``; here several OS processes
write concurrently, so every check-then-write happens under an explicit lock inside one short
``READ COMMITTED`` transaction:

* per-run writes (lease acquisition, fencing checks, revision CAS, intents, receipts, responses,
  events) first lock the run's ``runs`` row with ``SELECT ... FOR UPDATE``; the lease row is also
  locked ``FOR UPDATE``. Two workers can therefore never both see the same lease / revision and win;
* the active pointer is locked ``FOR UPDATE``; admissions / archive enrolments of one skill are
  serialised by a transaction-scoped advisory lock on the skill id (the pointer row may not exist
  yet), and the ``(skill_id, version)`` primary key of ``trace_archive_manifests`` is the final CAS
  arbiter (a unique violation is reported as CONFLICT, never as a second winner);
* per-artifact lifecycle sequence numbers are allocated under an advisory lock on the artifact hash.

No transaction is held across a model call, human wait or remote tool call: every method opens and
commits its own transaction. Append-only tables are protected by plpgsql triggers (migration
``0001_init.sql``); the schema is versioned in ``schema_migrations`` by :func:`migrate`.
"""

from __future__ import annotations

import json
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import psycopg
from psycopg import errors as pg_errors

from .sqlite import TERMINAL_RUN_STATUSES, ConflictError, _j

MIGRATIONS_DIR = Path(__file__).parent / "migrations" / "postgres"
_MIGRATION_LOCK = 0x4E7153  # advisory lock key serialising concurrent migrators
_VERSION_RE = re.compile(r"^--\s*schema-version:\s*(\d+)\s*$", re.MULTILINE)


def _migration_files() -> list[tuple[int, str, str]]:
    out = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        sql = f.read_text()
        m = _VERSION_RE.search(sql)
        if not m:
            raise ValueError(f"migration {f.name} lacks a '-- schema-version: N' header")
        out.append((int(m.group(1)), f.stem, sql))
    versions = [v for v, _, _ in out]
    if versions != sorted(set(versions)):
        raise ValueError(f"migration versions must be unique and increasing: {versions}")
    return out


def migrate(conn: psycopg.Connection) -> list[int]:
    """Apply every pending migration in ``migrations/postgres`` in order, each in one transaction with
    its ``schema_migrations`` record. Concurrent migrators are serialised by an advisory lock; re-running
    is a no-op. Returns the versions applied by this call."""
    applied: list[int] = []
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (_MIGRATION_LOCK,))
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, "
                     "applied_at DOUBLE PRECISION NOT NULL)")
        done = {v for (v,) in conn.execute("SELECT version FROM schema_migrations").fetchall()}
        for version, name, sql in _migration_files():
            if version in done:
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO schema_migrations VALUES(%s,%s,%s)", (version, name, time.time()))
            applied.append(version)
    return applied


def _pg(sql: str) -> str:
    """SQLite-style ``?`` placeholders -> psycopg ``%s`` (no statement here contains a literal ``?``/``%``)."""
    return sql.replace("?", "%s")


class _Tx:
    """A transaction handle with the ``execute(sql, args)`` shape of a ``sqlite3.Connection``."""

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def execute(self, sql: str, args: tuple = ()) -> psycopg.Cursor:
        return self.conn.execute(_pg(sql), args)


class PostgresStore:
    def __init__(self, dsn: str, *, migrate_schema: bool = True):
        self.dsn = self.path = dsn
        self._lock = threading.RLock()
        self.db = psycopg.connect(dsn, autocommit=True)
        if migrate_schema:
            migrate(self.db)

    def schema_version(self) -> int:
        return self.q1("SELECT MAX(version) FROM schema_migrations")[0]

    def reopen(self) -> "PostgresStore":
        return PostgresStore(self.dsn)

    def close(self) -> None:
        with self._lock:
            self.db.close()

    @contextmanager
    def tx(self) -> Iterator[_Tx]:
        with self._lock:
            with self.db.transaction():
                yield _Tx(self.db)

    def q1(self, sql: str, args: tuple = ()) -> Optional[tuple]:
        with self._lock:
            return self.db.execute(_pg(sql), args).fetchone()

    def qa(self, sql: str, args: tuple = ()) -> list[tuple]:
        with self._lock:
            return self.db.execute(_pg(sql), args).fetchall()

    # ---- locking helpers -------------------------------------------------------------------- #
    @staticmethod
    def _lock_run(db: _Tx, tenant_id: str, run_id: str) -> Optional[tuple]:
        return db.execute("SELECT status FROM runs WHERE tenant_id=? AND run_id=? FOR UPDATE",
                          (tenant_id, run_id)).fetchone()

    @staticmethod
    def _advisory(db: _Tx, key: str) -> None:
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (key,))

    # ---- artifact registry --------------------------------------------------------------- #
    def put_version(self, package_json: dict, actor: str, now: float) -> None:
        h = package_json["artifact_hash"]
        with self.tx() as db:
            self._advisory(db, "lifecycle:" + h)
            inserted = db.execute("INSERT INTO machine_versions VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING "
                                  "RETURNING artifact_hash",
                                  (h, package_json["machine"]["skill_id"], package_json["lineage"].get("parent_hash"),
                                   _j(package_json), now)).fetchone()
            if inserted is None:
                return
            db.execute("INSERT INTO machine_lifecycle VALUES(?,?,?,?,?,?)", (h, 1, "validated", actor, "", now))

    def get_version(self, artifact_hash: str) -> Optional[dict]:
        r = self.q1("SELECT package FROM machine_versions WHERE artifact_hash=?", (artifact_hash,))
        return json.loads(r[0]) if r else None

    def lifecycle(self, artifact_hash: str) -> list[dict]:
        return [{"seq": s, "state": st, "actor": a, "reason": r, "at": at} for s, st, a, r, at in
                self.qa("SELECT seq, state, actor, reason, at FROM machine_lifecycle WHERE artifact_hash=? "
                        "ORDER BY seq", (artifact_hash,))]

    def add_lifecycle(self, db: _Tx, artifact_hash: str, state: str, actor: str, reason: str, now: float) -> None:
        self._advisory(db, "lifecycle:" + artifact_hash)
        seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM machine_lifecycle WHERE artifact_hash=?",
                         (artifact_hash,)).fetchone()[0]
        db.execute("INSERT INTO machine_lifecycle VALUES(?,?,?,?,?,?)", (artifact_hash, seq, state, actor, reason, now))

    def add_lifecycle_entry(self, artifact_hash: str, state: str, actor: str, reason: str, now: float) -> None:
        with self.tx() as db:
            self.add_lifecycle(db, artifact_hash, state, actor, reason, now)

    def is_revoked(self, artifact_hash: str) -> bool:
        return self.q1("SELECT 1 FROM machine_lifecycle WHERE artifact_hash=? AND state='revoked'",
                       (artifact_hash,)) is not None

    def is_admitted(self, artifact_hash: str) -> bool:
        return self.q1("SELECT 1 FROM machine_lifecycle WHERE artifact_hash=? AND state='admitted'",
                       (artifact_hash,)) is not None

    def admission_record(self, key: str) -> Optional[tuple[str, str]]:
        r = self.q1("SELECT record, report FROM admission_reports WHERE artifact_hash=?", (key,))
        return (r[0], r[1]) if r else None

    def publish_admission(self, *, environment: str, skill_id: str, artifact_hash: str,
                          expected_parent_hash: Optional[str], gated_archive_version: Optional[int],
                          traces: list[tuple[str, str, str]], record: dict, report: dict, env_key: str, actor: str,
                          manifest: dict, now: float) -> dict:
        """See :meth:`storage.sqlite.Store.publish_admission` (identical semantics)."""
        try:
            with self.tx() as db:
                self._advisory(db, "archive:" + skill_id)
                row = db.execute("SELECT artifact_hash FROM active_machine_versions WHERE environment=? AND "
                                 "skill_id=? FOR UPDATE", (environment, skill_id)).fetchone()
                current = row[0] if row else None
                if current != expected_parent_hash:
                    return {"status": "CONFLICT", "conflict": "active", "current": current}
                latest = db.execute("SELECT MAX(version) FROM trace_archive_manifests WHERE skill_id=?",
                                    (skill_id,)).fetchone()[0]
                if latest != gated_archive_version:
                    return {"status": "CONFLICT", "conflict": "archive", "current": current}
                version = (latest or 0) + 1
                for tid, sha, body in traces:
                    db.execute("INSERT INTO trace_blobs VALUES(?,?,?,?) ON CONFLICT DO NOTHING", (tid, sha, body, now))
                for key in (artifact_hash, env_key):
                    db.execute("INSERT INTO admission_reports VALUES(?,?,?) ON CONFLICT DO NOTHING",
                               (key, _j(record), _j(report)))
                self.add_lifecycle(db, artifact_hash, "admitted", actor, environment, now)
                self.add_lifecycle(db, artifact_hash, "active", actor, environment, now)
                db.execute("INSERT INTO trace_archive_manifests VALUES(?,?,?,?,?)",
                           (skill_id, version, artifact_hash,
                            _j({**manifest, "version": version, "artifact_hash": artifact_hash}), now))
                if current is None:
                    won = db.execute("INSERT INTO active_machine_versions VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING "
                                     "RETURNING skill_id", (environment, skill_id, artifact_hash, version, now)
                                     ).fetchone()
                else:
                    won = db.execute("UPDATE active_machine_versions SET artifact_hash=?, archive_version=?, "
                                     "updated_at=? WHERE environment=? AND skill_id=? AND artifact_hash=? "
                                     "RETURNING skill_id",
                                     (artifact_hash, version, now, environment, skill_id, current)).fetchone()
                if won is None:
                    raise _CasLost()
        except (_CasLost, pg_errors.UniqueViolation):
            row = self.get_active(environment, skill_id)
            return {"status": "CONFLICT", "conflict": "active" if (row[0] if row else None) != expected_parent_hash
                    else "archive", "current": row[0] if row else None}
        return {"status": "ADMITTED", "version": version}

    def append_archive_manifest(self, *, skill_id: str, expected_version: Optional[int], artifact_hash: str,
                                manifest: dict, traces: list[tuple[str, str, str]], actor: str, lifecycle_state: str,
                                lifecycle_reason: str, now: float) -> dict:
        """See :meth:`storage.sqlite.Store.append_archive_manifest` (identical semantics)."""
        try:
            with self.tx() as db:
                self._advisory(db, "archive:" + skill_id)
                latest = db.execute("SELECT MAX(version) FROM trace_archive_manifests WHERE skill_id=?",
                                    (skill_id,)).fetchone()[0]
                if latest != expected_version:
                    return {"status": "CONFLICT"}
                version = (latest or 0) + 1
                for tid, sha, body in traces:
                    db.execute("INSERT INTO trace_blobs VALUES(?,?,?,?) ON CONFLICT DO NOTHING", (tid, sha, body, now))
                db.execute("INSERT INTO trace_archive_manifests VALUES(?,?,?,?,?)",
                           (skill_id, version, artifact_hash,
                            _j({**manifest, "version": version, "artifact_hash": artifact_hash}), now))
                db.execute("UPDATE active_machine_versions SET archive_version=? WHERE skill_id=? AND artifact_hash=?",
                           (version, skill_id, artifact_hash))
                self.add_lifecycle(db, artifact_hash, lifecycle_state, actor, lifecycle_reason, now)
        except pg_errors.UniqueViolation:
            return {"status": "CONFLICT"}
        return {"status": "ADMITTED", "version": version}

    def get_active(self, environment: str, skill_id: str) -> Optional[tuple[str, int]]:
        r = self.q1("SELECT artifact_hash, archive_version FROM active_machine_versions WHERE environment=? AND "
                    "skill_id=?", (environment, skill_id))
        return (r[0], r[1]) if r else None

    # ---- runs / checkpoints / events -------------------------------------------------------- #
    def create_run(self, tenant_id: str, run_id: str, artifact_hash: str, principal: str, request_id: str,
                   checkpoint: dict, events: list[dict], now: float) -> bool:
        try:
            with self.tx() as db:
                if request_id and db.execute("SELECT 1 FROM runs WHERE tenant_id=? AND request_id=?",
                                             (tenant_id, request_id)).fetchone():
                    return False
                db.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,0,?)",
                           (tenant_id, run_id, artifact_hash, principal, checkpoint["status"], request_id or None, now))
                db.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?)", (tenant_id, run_id, 0, _j(checkpoint), now))
                self._append_events(db, tenant_id, run_id, events, now)
        except pg_errors.UniqueViolation:
            if request_id and self.run_by_request(tenant_id, request_id):
                return False  # lost a concurrent race on the same request id
            raise
        return True

    def run_by_request(self, tenant_id: str, request_id: str) -> Optional[str]:
        r = self.q1("SELECT run_id FROM runs WHERE tenant_id=? AND request_id=?", (tenant_id, request_id))
        return r[0] if r else None

    def list_runs(self, tenant_id: str) -> list[str]:
        """Run ids of one tenant in creation order (never another tenant's)."""
        return [r[0] for r in self.qa("SELECT run_id FROM runs WHERE tenant_id=? ORDER BY created_at, run_id",
                                      (tenant_id,))]

    def get_run(self, tenant_id: str, run_id: str) -> Optional[dict]:
        r = self.q1("SELECT artifact_hash, principal, status, cancel_requested, created_at FROM runs WHERE "
                    "tenant_id=? AND run_id=?", (tenant_id, run_id))
        if not r:
            return None
        return {"tenant_id": tenant_id, "run_id": run_id, "artifact_hash": r[0], "principal": r[1], "status": r[2],
                "cancel_requested": bool(r[3]), "created_at": r[4]}

    def latest_checkpoint(self, tenant_id: str, run_id: str) -> Optional[dict]:
        r = self.q1("SELECT body FROM checkpoints WHERE tenant_id=? AND run_id=? ORDER BY revision DESC LIMIT 1",
                    (tenant_id, run_id))
        return json.loads(r[0]) if r else None

    def checkpoints(self, tenant_id: str, run_id: str) -> list[dict]:
        return [json.loads(b) for (b,) in self.qa("SELECT body FROM checkpoints WHERE tenant_id=? AND run_id=? "
                                                  "ORDER BY revision", (tenant_id, run_id))]

    def _append_events(self, db: _Tx, tenant_id: str, run_id: str, events: list[dict], now: float) -> None:
        # callers hold the run row lock, so the sequence cannot be allocated twice
        seq = db.execute("SELECT COALESCE(MAX(sequence),0) FROM run_events WHERE tenant_id=? AND run_id=?",
                         (tenant_id, run_id)).fetchone()[0]
        for e in events:
            seq += 1
            db.execute("INSERT INTO run_events VALUES(?,?,?,?,?,?)", (tenant_id, run_id, seq, e["type"], _j(e), now))

    def append_events(self, tenant_id: str, run_id: str, events: list[dict], now: float) -> None:
        with self.tx() as db:
            self._lock_run(db, tenant_id, run_id)
            self._append_events(db, tenant_id, run_id, events, now)

    def events(self, tenant_id: str, run_id: str) -> list[dict]:
        return [{"sequence": s, **json.loads(b)} for s, b in
                self.qa("SELECT sequence, body FROM run_events WHERE tenant_id=? AND run_id=? ORDER BY sequence",
                        (tenant_id, run_id))]

    def commit_transition(self, tenant_id: str, run_id: str, expected_revision: int, lease_token: Optional[int],
                          checkpoint: dict, events: list[dict], now: float) -> None:
        """Atomically (under the run row lock): fencing check, revision CAS, checkpoint insert, events,
        run status."""
        try:
            with self.tx() as db:
                self._lock_run(db, tenant_id, run_id)
                if lease_token is not None:
                    r = db.execute("SELECT token FROM leases WHERE tenant_id=? AND run_id=? FOR UPDATE",
                                   (tenant_id, run_id)).fetchone()
                    if not r or r[0] != lease_token:
                        raise ConflictError("STALE_LEASE: worker no longer owns this run")
                cur = db.execute("SELECT MAX(revision) FROM checkpoints WHERE tenant_id=? AND run_id=?",
                                 (tenant_id, run_id)).fetchone()[0]
                if cur != expected_revision:
                    raise ConflictError(f"REVISION_CONFLICT: expected {expected_revision}, found {cur}")
                db.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?)",
                           (tenant_id, run_id, checkpoint["revision"], _j(checkpoint), now))
                self._append_events(db, tenant_id, run_id, events, now)
                db.execute("UPDATE runs SET status=? WHERE tenant_id=? AND run_id=?",
                           (checkpoint["status"], tenant_id, run_id))
                if checkpoint["status"] in TERMINAL_RUN_STATUSES:
                    db.execute("UPDATE approval_requests SET status='CLOSED' WHERE tenant_id=? AND run_id=? AND "
                               "status='OPEN'", (tenant_id, run_id))
        except pg_errors.UniqueViolation as exc:  # defence in depth: the primary key is the last CAS arbiter
            raise ConflictError(f"REVISION_CONFLICT: revision {checkpoint['revision']} already committed") from exc

    def set_run_status(self, tenant_id: str, run_id: str, status: str) -> bool:
        """Set a non-terminal run status. Never overwrites a terminal status (returns False)."""
        with self.tx() as db:
            return self._set_run_status(db, tenant_id, run_id, status)

    def _set_run_status(self, db: _Tx, tenant_id: str, run_id: str, status: str) -> bool:
        placeholders = ",".join("?" * len(TERMINAL_RUN_STATUSES))
        cur = db.execute(f"UPDATE runs SET status=? WHERE tenant_id=? AND run_id=? AND status NOT IN ({placeholders})",
                         (status, tenant_id, run_id, *TERMINAL_RUN_STATUSES))
        return cur.rowcount > 0

    def request_cancel(self, tenant_id: str, run_id: str) -> None:
        with self.tx() as db:
            db.execute("UPDATE runs SET cancel_requested=1 WHERE tenant_id=? AND run_id=?", (tenant_id, run_id))

    # ---- leases (fencing) ------------------------------------------------------------------- #
    def acquire_lease(self, tenant_id: str, run_id: str, worker_id: str, now: float, ttl: float) -> Optional[int]:
        while True:
            with self.tx() as db:
                self._lock_run(db, tenant_id, run_id)
                r = db.execute("SELECT worker_id, token, expires_at FROM leases WHERE tenant_id=? AND run_id=? "
                               "FOR UPDATE", (tenant_id, run_id)).fetchone()
                if r is None:
                    # no row to lock yet (e.g. a run row that does not exist): the primary key arbitrates
                    ok = db.execute("INSERT INTO leases VALUES(?,?,?,1,?) ON CONFLICT DO NOTHING RETURNING token",
                                    (tenant_id, run_id, worker_id, now + ttl)).fetchone()
                    if ok is None:
                        continue  # another worker created it first: re-evaluate against its row
                    return 1
                if r[0] != worker_id and r[2] > now:
                    return None
                token = r[1] + 1
                db.execute("UPDATE leases SET worker_id=?, token=?, expires_at=? WHERE tenant_id=? AND run_id=?",
                           (worker_id, token, now + ttl, tenant_id, run_id))
                return token

    def lease_token(self, tenant_id: str, run_id: str) -> Optional[int]:
        r = self.q1("SELECT token FROM leases WHERE tenant_id=? AND run_id=?", (tenant_id, run_id))
        return r[0] if r else None

    # ---- action ledger ---------------------------------------------------------------------- #
    def create_intent(self, tenant_id: str, run_id: str, lid: str, state_id: str, revision: int, tool: str,
                      version: str, args: Any, args_digest: str, idem: str, lease_token: Optional[int],
                      now: float) -> dict:
        with self.tx() as db:
            self._lock_run(db, tenant_id, run_id)
            r = db.execute("SELECT logical_action_id FROM action_intents WHERE tenant_id=? AND run_id=? AND revision=?",
                           (tenant_id, run_id, revision)).fetchone()
            if r is None:
                db.execute("INSERT INTO action_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT DO NOTHING",
                           (tenant_id, run_id, lid, state_id, revision, tool, version, _j(args), args_digest, idem,
                            "PENDING", lease_token, now, now))
        return self.intent_for_revision(tenant_id, run_id, revision)  # type: ignore[return-value]

    def _intent_row(self, r: tuple) -> dict:
        keys = ("tenant_id", "run_id", "logical_action_id", "state_id", "revision", "tool", "tool_version", "args",
                "args_digest", "idempotency_key", "status", "lease_token", "attempts", "created_at", "updated_at")
        d = dict(zip(keys, r))
        d["args"] = json.loads(d["args"])
        return d

    def intent_for_revision(self, tenant_id: str, run_id: str, revision: int) -> Optional[dict]:
        r = self.q1("SELECT * FROM action_intents WHERE tenant_id=? AND run_id=? AND revision=?",
                    (tenant_id, run_id, revision))
        return self._intent_row(r) if r else None

    def intent(self, tenant_id: str, lid: str) -> Optional[dict]:
        r = self.q1("SELECT * FROM action_intents WHERE tenant_id=? AND logical_action_id=?", (tenant_id, lid))
        return self._intent_row(r) if r else None

    def intents(self, tenant_id: str, run_id: str) -> list[dict]:
        return [self._intent_row(r) for r in self.qa("SELECT * FROM action_intents WHERE tenant_id=? AND run_id=? "
                                                     "ORDER BY revision", (tenant_id, run_id))]

    def _lock_for_action(self, db: _Tx, tenant_id: str, lid: str, run_id: Optional[str]) -> Optional[str]:
        """Lock the run owning action ``lid`` (or ``run_id``); returns that run id (None if unknown)."""
        if run_id is None:
            r = db.execute("SELECT run_id FROM action_intents WHERE tenant_id=? AND logical_action_id=?",
                           (tenant_id, lid)).fetchone()
            run_id = r[0] if r else None
        if run_id is not None:
            self._lock_run(db, tenant_id, run_id)
        return run_id

    def _fence_ok(self, db: _Tx, tenant_id: str, lid: str, token: int, run_id: Optional[str]) -> bool:
        if run_id is None:
            r = db.execute("SELECT run_id FROM action_intents WHERE tenant_id=? AND logical_action_id=?",
                           (tenant_id, lid)).fetchone()
            if not r:
                return False
            run_id = r[0]
        r = db.execute("SELECT token FROM leases WHERE tenant_id=? AND run_id=? FOR UPDATE",
                       (tenant_id, run_id)).fetchone()
        return bool(r) and r[0] == token

    def _update_intent(self, db: _Tx, tenant_id: str, lid: str, status: str, now: float, bump_attempt: bool,
                       lease_token: Optional[int], expect_status: Optional[tuple]) -> bool:
        sql = ("UPDATE action_intents SET status=?, updated_at=?, attempts=attempts+?::integer, "
               "lease_token=COALESCE(?::integer, lease_token) WHERE tenant_id=? AND logical_action_id=?")
        args: tuple = (status, now, 1 if bump_attempt else 0, lease_token, tenant_id, lid)
        if expect_status is not None:
            sql += f" AND status IN ({','.join('?' * len(expect_status))})"
            args += tuple(expect_status)
        return db.execute(sql, args).rowcount > 0

    def update_intent(self, tenant_id: str, lid: str, status: str, now: float, bump_attempt: bool = False,
                      lease_token: Optional[int] = None, require_token: Optional[int] = None,
                      expect_status: Optional[tuple] = None, run_id: Optional[str] = None) -> bool:
        """See :meth:`storage.sqlite.Store.update_intent`."""
        with self.tx() as db:
            run_id = self._lock_for_action(db, tenant_id, lid, run_id)
            if require_token is not None and not self._fence_ok(db, tenant_id, lid, require_token, run_id):
                raise ConflictError("STALE_LEASE: dispatch fenced off")
            return self._update_intent(db, tenant_id, lid, status, now, bump_attempt, lease_token, expect_status)

    def record_outcome(self, tenant_id: str, lid: str, run_id: str, tool: str, version: str, args_digest: str,
                       idem: str, dispatch_state: str, certainty: str, external_ref: Optional[str], result: Any,
                       connector: str, now: float, *, intent_status: Optional[str] = None,
                       evidence: Optional[Callable[[int], list[dict]]] = None, require_token: Optional[int] = None,
                       expect_status: Optional[tuple] = None) -> Optional[int]:
        """See :meth:`storage.sqlite.Store.record_outcome`."""
        with self.tx() as db:
            self._lock_run(db, tenant_id, run_id)
            if require_token is not None and not self._fence_ok(db, tenant_id, lid, require_token, run_id):
                return None
            if intent_status is not None:
                changed = self._update_intent(db, tenant_id, lid, intent_status, now, False, None, expect_status)
                if expect_status is not None and not changed:
                    return None
            seq = self._add_receipt(db, tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state,
                                    certainty, external_ref, result, connector, now)
            for rec in (evidence(seq) if evidence else []):
                self._add_evidence(db, tenant_id, rec)
            return seq

    def add_receipt(self, tenant_id: str, lid: str, run_id: str, tool: str, version: str, args_digest: str, idem: str,
                    dispatch_state: str, certainty: str, external_ref: Optional[str], result: Any, connector: str,
                    now: float) -> int:
        with self.tx() as db:
            self._lock_run(db, tenant_id, run_id)
            return self._add_receipt(db, tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state,
                                     certainty, external_ref, result, connector, now)

    def _add_receipt(self, db: _Tx, tenant_id: str, lid: str, run_id: str, tool: str, version: str,
                     args_digest: str, idem: str, dispatch_state: str, certainty: str, external_ref: Optional[str],
                     result: Any, connector: str, now: float) -> int:
        self._advisory(db, f"receipt:{tenant_id}:{lid}")
        seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM action_receipts WHERE tenant_id=? AND "
                         "logical_action_id=?", (tenant_id, lid)).fetchone()[0]
        db.execute("INSERT INTO action_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (tenant_id, lid, seq, run_id, tool, version, args_digest, idem, dispatch_state, certainty,
                    external_ref, _j(result) if result is not None else None, connector, now))
        return seq

    def receipts(self, tenant_id: str, lid: Optional[str] = None, run_id: Optional[str] = None) -> list[dict]:
        keys = ("tenant_id", "logical_action_id", "seq", "run_id", "tool", "tool_version", "args_digest",
                "idempotency_key", "dispatch_state", "certainty", "external_ref", "result", "connector", "created_at")
        if lid:
            rows = self.qa("SELECT * FROM action_receipts WHERE tenant_id=? AND logical_action_id=? ORDER BY seq",
                           (tenant_id, lid))
        else:
            rows = self.qa("SELECT * FROM action_receipts WHERE tenant_id=? AND run_id=? ORDER BY created_at, seq",
                           (tenant_id, run_id))
        out = []
        for r in rows:
            d = dict(zip(keys, r))
            d["result"] = json.loads(d["result"]) if d["result"] else None
            out.append(d)
        return out

    # ---- interactions ----------------------------------------------------------------------- #
    def create_interaction(self, tenant_id: str, run_id: str, iid: str, typ: str, state_id: str, revision: int,
                           scope: dict, scope_digest: str, expires_at: Optional[float], now: float) -> dict:
        with self.tx() as db:
            self._lock_run(db, tenant_id, run_id)
            if not db.execute("SELECT 1 FROM approval_requests WHERE tenant_id=? AND run_id=? AND revision=?",
                              (tenant_id, run_id, revision)).fetchone():
                db.execute("INSERT INTO approval_requests VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                           (tenant_id, run_id, iid, typ, state_id, revision, _j(scope), scope_digest, expires_at,
                            "OPEN", now))
        return self.interaction_for_revision(tenant_id, run_id, revision)  # type: ignore[return-value]

    def _ix(self, r: tuple) -> dict:
        keys = ("tenant_id", "run_id", "interaction_id", "type", "state_id", "revision", "scope", "scope_digest",
                "expires_at", "status", "created_at")
        d = dict(zip(keys, r))
        d["scope"] = json.loads(d["scope"])
        return d

    def interaction(self, tenant_id: str, iid: str) -> Optional[dict]:
        r = self.q1("SELECT * FROM approval_requests WHERE tenant_id=? AND interaction_id=?", (tenant_id, iid))
        return self._ix(r) if r else None

    def interaction_for_revision(self, tenant_id: str, run_id: str, revision: int) -> Optional[dict]:
        r = self.q1("SELECT * FROM approval_requests WHERE tenant_id=? AND run_id=? AND revision=?",
                    (tenant_id, run_id, revision))
        return self._ix(r) if r else None

    def set_interaction_status(self, tenant_id: str, iid: str, status: str) -> None:
        with self.tx() as db:
            r = db.execute("SELECT run_id FROM approval_requests WHERE tenant_id=? AND interaction_id=?",
                           (tenant_id, iid)).fetchone()
            if r:
                self._lock_run(db, tenant_id, r[0])
            db.execute("UPDATE approval_requests SET status=? WHERE tenant_id=? AND interaction_id=?",
                       (status, tenant_id, iid))

    def record_response(self, tenant_id: str, iid: str, run_id: str, responder: str, response: dict,
                        scope_digest: str, request_id: str, now: float, events: Optional[list[dict]] = None,
                        run_status: Optional[str] = None) -> bool:
        """See :meth:`storage.sqlite.Store.record_response` (the run row lock serialises responders)."""
        try:
            with self.tx() as db:
                self._lock_run(db, tenant_id, run_id)
                if db.execute("SELECT 1 FROM approval_responses WHERE tenant_id=? AND interaction_id=?",
                              (tenant_id, iid)).fetchone():
                    return False
                st = db.execute("SELECT status FROM approval_requests WHERE tenant_id=? AND interaction_id=? "
                                "FOR UPDATE", (tenant_id, iid)).fetchone()
                if st is not None and st[0] != "OPEN":
                    return False
                db.execute("INSERT INTO approval_responses VALUES(?,?,?,?,?,?,?,?)",
                           (tenant_id, iid, run_id, responder, _j(response), scope_digest, request_id, now))
                db.execute("UPDATE approval_requests SET status='ANSWERED' WHERE tenant_id=? AND interaction_id=?",
                           (tenant_id, iid))
                if events:
                    self._append_events(db, tenant_id, run_id, events, now)
                if run_status is not None:
                    self._set_run_status(db, tenant_id, run_id, run_status)
                return True
        except pg_errors.UniqueViolation:
            return False  # a concurrent responder (e.g. under a different run id) won

    def response(self, tenant_id: str, iid: str) -> Optional[dict]:
        r = self.q1("SELECT responder, response, scope_digest, request_id, created_at FROM approval_responses WHERE "
                    "tenant_id=? AND interaction_id=?", (tenant_id, iid))
        if not r:
            return None
        return {"responder": r[0], "response": json.loads(r[1]), "scope_digest": r[2], "request_id": r[3],
                "created_at": r[4]}

    # ---- evidence --------------------------------------------------------------------------- #
    def add_evidence(self, tenant_id: str, rec: dict) -> None:
        """Idempotent per (tenant, run, receipt id)."""
        with self.tx() as db:
            self._add_evidence(db, tenant_id, rec)

    def _add_evidence(self, db: _Tx, tenant_id: str, rec: dict) -> None:
        db.execute("INSERT INTO evidence_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT DO NOTHING",
                   (tenant_id, rec["receipt_id"], rec["run_id"], rec["claim"], rec["verifier"],
                    rec["verifier_version"], _j(rec["subject"]), rec["subject_digest"], rec["result"],
                    rec["source_ref"], rec["observed_at"]))

    def evidence(self, tenant_id: str, run_id: str) -> list[dict]:
        keys = ("tenant_id", "receipt_id", "run_id", "claim", "verifier", "verifier_version", "subject",
                "subject_digest", "result", "source_ref", "observed_at", "invalidated_at", "invalidation_reason")
        out = []
        for r in self.qa("SELECT * FROM evidence_receipts WHERE tenant_id=? AND run_id=? ORDER BY observed_at",
                         (tenant_id, run_id)):
            d = dict(zip(keys, r))
            d["subject"] = json.loads(d["subject"])
            out.append(d)
        return out

    def invalidate_evidence(self, tenant_id: str, receipt_id: str, reason: str, now: float,
                            run_id: Optional[str] = None) -> None:
        """Invalidate a receipt. Pass ``run_id`` to scope it to one run (receipt ids are unique per run)."""
        with self.tx() as db:
            sql = ("UPDATE evidence_receipts SET invalidated_at=?, invalidation_reason=? WHERE tenant_id=? AND "
                   "receipt_id=? AND invalidated_at IS NULL")
            args: tuple = (now, reason, tenant_id, receipt_id)
            if run_id is not None:
                sql += " AND run_id=?"
                args += (run_id,)
            db.execute(sql, args)

    # ---- traces / proposals ----------------------------------------------------------------- #
    def put_trace(self, trace_id: str, sha: str, body: str, now: float) -> None:
        with self.tx() as db:
            db.execute("INSERT INTO trace_blobs VALUES(?,?,?,?) ON CONFLICT DO NOTHING", (trace_id, sha, body, now))

    def trace_body(self, trace_id: str) -> Optional[str]:
        r = self.q1("SELECT body FROM trace_blobs WHERE trace_id=?", (trace_id,))
        return r[0] if r else None

    def put_proposal(self, pid: str, parent: str, cand: Optional[str], status: str, body: dict, now: float) -> None:
        with self.tx() as db:
            db.execute("INSERT INTO update_proposals VALUES(?,?,?,?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET "
                       "parent_hash=EXCLUDED.parent_hash, candidate_hash=EXCLUDED.candidate_hash, "
                       "status=EXCLUDED.status, body=EXCLUDED.body, created_at=EXCLUDED.created_at",
                       (pid, parent, cand, status, _j(body), now))

    def archive(self, skill_id: str, version: Optional[int] = None) -> Optional[dict]:
        if version is None:
            r = self.q1("SELECT manifest FROM trace_archive_manifests WHERE skill_id=? ORDER BY version DESC LIMIT 1",
                        (skill_id,))
        else:
            r = self.q1("SELECT manifest FROM trace_archive_manifests WHERE skill_id=? AND version=?",
                        (skill_id, version))
        return json.loads(r[0]) if r else None


class _CasLost(Exception):
    """Internal: the active-pointer CAS lost to a concurrent publisher (rolls the transaction back)."""
