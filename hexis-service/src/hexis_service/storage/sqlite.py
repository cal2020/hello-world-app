"""SQLite store for single-process development (brief §11.3).

All operational records are tenant-scoped. ``run_events``, ``checkpoints``, ``machine_versions``
and ``action_receipts`` are append-only: triggers reject UPDATE/DELETE. The active-version pointer
is changed only through :meth:`Store.swap_active` (compare-and-swap). Transactions are short and
never span a model call, human wait or remote tool call.

A PostgreSQL adapter for multi-worker deployment is NOT implemented (docs/LIMITATIONS.md).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional

from ..canonical import canonical_bytes

SCHEMA_VERSION = 2
TERMINAL_RUN_STATUSES = ("COMPLETED", "FAILED", "CANCELLED")

_EVIDENCE_DDL = """CREATE TABLE IF NOT EXISTS evidence_receipts(tenant_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  run_id TEXT NOT NULL, claim TEXT NOT NULL, verifier TEXT NOT NULL, verifier_version TEXT NOT NULL, subject TEXT NOT NULL,
  subject_digest TEXT NOT NULL, result TEXT NOT NULL, source_ref TEXT NOT NULL, observed_at REAL NOT NULL,
  invalidated_at REAL, invalidation_reason TEXT, PRIMARY KEY(tenant_id, run_id, receipt_id))"""

DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS machine_versions(artifact_hash TEXT PRIMARY KEY, skill_id TEXT NOT NULL,
  parent_hash TEXT, package TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS machine_lifecycle(artifact_hash TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT, at REAL NOT NULL, PRIMARY KEY(artifact_hash, seq));
CREATE TABLE IF NOT EXISTS active_machine_versions(environment TEXT NOT NULL, skill_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL, archive_version INTEGER NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY(environment, skill_id));
CREATE TABLE IF NOT EXISTS admission_reports(artifact_hash TEXT PRIMARY KEY, record TEXT NOT NULL, report TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_hash TEXT NOT NULL,
  principal TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, PRIMARY KEY(tenant_id, run_id), UNIQUE(tenant_id, request_id));
CREATE TABLE IF NOT EXISTS checkpoints(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS run_events(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(tenant_id, run_id, sequence));
CREATE TABLE IF NOT EXISTS leases(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  token INTEGER NOT NULL, expires_at REAL NOT NULL, PRIMARY KEY(tenant_id, run_id));
CREATE TABLE IF NOT EXISTS action_intents(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, logical_action_id TEXT NOT NULL,
  state_id TEXT NOT NULL, revision INTEGER NOT NULL, tool TEXT NOT NULL, tool_version TEXT NOT NULL,
  args TEXT NOT NULL, args_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL,
  lease_token INTEGER, attempts INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY(tenant_id, logical_action_id), UNIQUE(tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS action_receipts(tenant_id TEXT NOT NULL, logical_action_id TEXT NOT NULL, seq INTEGER NOT NULL,
  run_id TEXT NOT NULL, tool TEXT NOT NULL, tool_version TEXT NOT NULL, args_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, dispatch_state TEXT NOT NULL, certainty TEXT NOT NULL, external_ref TEXT,
  result TEXT, connector TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(tenant_id, logical_action_id, seq));
CREATE TABLE IF NOT EXISTS approval_requests(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
  type TEXT NOT NULL, state_id TEXT NOT NULL, revision INTEGER NOT NULL, scope TEXT NOT NULL, scope_digest TEXT NOT NULL,
  expires_at REAL, status TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(tenant_id, interaction_id),
  UNIQUE(tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS approval_responses(tenant_id TEXT NOT NULL, interaction_id TEXT NOT NULL, run_id TEXT NOT NULL,
  responder TEXT NOT NULL, response TEXT NOT NULL, scope_digest TEXT NOT NULL, request_id TEXT, created_at REAL NOT NULL,
  PRIMARY KEY(tenant_id, interaction_id));
CREATE TABLE IF NOT EXISTS trace_blobs(trace_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, body TEXT NOT NULL,
  created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS trace_archive_manifests(skill_id TEXT NOT NULL, version INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL, manifest TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(skill_id, version));
CREATE TABLE IF NOT EXISTS update_proposals(proposal_id TEXT PRIMARY KEY, parent_hash TEXT NOT NULL,
  candidate_hash TEXT, status TEXT NOT NULL, body TEXT NOT NULL, created_at REAL NOT NULL);
""" + _EVIDENCE_DDL + ";\n"

IMMUTABLE = ("machine_versions", "checkpoints", "run_events", "action_receipts", "trace_blobs",
             "trace_archive_manifests", "approval_responses", "machine_lifecycle", "admission_reports")


def _j(v: Any) -> str:
    return canonical_bytes(v).decode("utf-8")


class ConflictError(Exception):
    pass


class Store:
    def __init__(self, path: str = ":memory:"):
        self.path = path
        self._lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL" if path != ":memory:" else "PRAGMA journal_mode=MEMORY")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(DDL)
        for t in IMMUTABLE:
            self.db.execute(f"CREATE TRIGGER IF NOT EXISTS {t}_no_update BEFORE UPDATE ON {t} "
                            f"BEGIN SELECT RAISE(ABORT, '{t} is append-only'); END")
            self.db.execute(f"CREATE TRIGGER IF NOT EXISTS {t}_no_delete BEFORE DELETE ON {t} "
                            f"BEGIN SELECT RAISE(ABORT, '{t} is append-only'); END")
        self._migrate()
        self.db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(?)", (SCHEMA_VERSION,))

    def _migrate(self) -> None:
        # v2: evidence receipts are keyed per run (a verifier's id is not run-scoped, and two runs that adopt
        # the same external draft must each keep their own evidence).
        sql = self.db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='evidence_receipts'").fetchone()
        if sql and "PRIMARY KEY(tenant_id, receipt_id)" in sql[0]:
            with self.tx() as db:
                db.execute("ALTER TABLE evidence_receipts RENAME TO evidence_receipts_v1")
                db.execute(_EVIDENCE_DDL)
                db.execute("INSERT INTO evidence_receipts SELECT * FROM evidence_receipts_v1")
                db.execute("DROP TABLE evidence_receipts_v1")

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield self.db
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def q1(self, sql: str, args: tuple = ()) -> Optional[tuple]:
        with self._lock:
            return self.db.execute(sql, args).fetchone()

    def qa(self, sql: str, args: tuple = ()) -> list[tuple]:
        with self._lock:
            return self.db.execute(sql, args).fetchall()

    # ---- artifact registry --------------------------------------------------------------- #
    def put_version(self, package_json: dict, actor: str, now: float) -> None:
        h = package_json["artifact_hash"]
        with self.tx() as db:
            if db.execute("SELECT 1 FROM machine_versions WHERE artifact_hash=?", (h,)).fetchone():
                return
            db.execute("INSERT INTO machine_versions VALUES(?,?,?,?,?)",
                       (h, package_json["machine"]["skill_id"], package_json["lineage"].get("parent_hash"),
                        _j(package_json), now))
            db.execute("INSERT INTO machine_lifecycle VALUES(?,?,?,?,?,?)", (h, 1, "validated", actor, "", now))

    def get_version(self, artifact_hash: str) -> Optional[dict]:
        r = self.q1("SELECT package FROM machine_versions WHERE artifact_hash=?", (artifact_hash,))
        return json.loads(r[0]) if r else None

    def lifecycle(self, artifact_hash: str) -> list[dict]:
        return [{"seq": s, "state": st, "actor": a, "reason": r, "at": at} for s, st, a, r, at in
                self.qa("SELECT seq, state, actor, reason, at FROM machine_lifecycle WHERE artifact_hash=? "
                        "ORDER BY seq", (artifact_hash,))]

    def add_lifecycle(self, db: sqlite3.Connection, artifact_hash: str, state: str, actor: str, reason: str,
                      now: float) -> None:
        seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM machine_lifecycle WHERE artifact_hash=?",
                         (artifact_hash,)).fetchone()[0]
        db.execute("INSERT INTO machine_lifecycle VALUES(?,?,?,?,?,?)", (artifact_hash, seq, state, actor, reason, now))

    def is_revoked(self, artifact_hash: str) -> bool:
        return self.q1("SELECT 1 FROM machine_lifecycle WHERE artifact_hash=? AND state='revoked'",
                       (artifact_hash,)) is not None

    def is_admitted(self, artifact_hash: str) -> bool:
        return self.q1("SELECT 1 FROM machine_lifecycle WHERE artifact_hash=? AND state='admitted'",
                       (artifact_hash,)) is not None

    def get_active(self, environment: str, skill_id: str) -> Optional[tuple[str, int]]:
        r = self.q1("SELECT artifact_hash, archive_version FROM active_machine_versions WHERE environment=? AND "
                    "skill_id=?", (environment, skill_id))
        return (r[0], r[1]) if r else None

    # ---- runs / checkpoints / events -------------------------------------------------------- #
    def create_run(self, tenant_id: str, run_id: str, artifact_hash: str, principal: str, request_id: str,
                   checkpoint: dict, events: list[dict], now: float) -> bool:
        with self.tx() as db:
            if request_id and db.execute("SELECT 1 FROM runs WHERE tenant_id=? AND request_id=?",
                                         (tenant_id, request_id)).fetchone():
                return False
            db.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,0,?)",
                       (tenant_id, run_id, artifact_hash, principal, checkpoint["status"], request_id or None, now))
            db.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?)", (tenant_id, run_id, 0, _j(checkpoint), now))
            self._append_events(db, tenant_id, run_id, events, now)
        return True

    def run_by_request(self, tenant_id: str, request_id: str) -> Optional[str]:
        r = self.q1("SELECT run_id FROM runs WHERE tenant_id=? AND request_id=?", (tenant_id, request_id))
        return r[0] if r else None

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

    def _append_events(self, db: sqlite3.Connection, tenant_id: str, run_id: str, events: list[dict],
                       now: float) -> None:
        seq = db.execute("SELECT COALESCE(MAX(sequence),0) FROM run_events WHERE tenant_id=? AND run_id=?",
                         (tenant_id, run_id)).fetchone()[0]
        for e in events:
            seq += 1
            db.execute("INSERT INTO run_events VALUES(?,?,?,?,?,?)", (tenant_id, run_id, seq, e["type"], _j(e), now))

    def append_events(self, tenant_id: str, run_id: str, events: list[dict], now: float) -> None:
        with self.tx() as db:
            self._append_events(db, tenant_id, run_id, events, now)

    def events(self, tenant_id: str, run_id: str) -> list[dict]:
        return [{"sequence": s, **json.loads(b)} for s, b in
                self.qa("SELECT sequence, body FROM run_events WHERE tenant_id=? AND run_id=? ORDER BY sequence",
                        (tenant_id, run_id))]

    def commit_transition(self, tenant_id: str, run_id: str, expected_revision: int, lease_token: Optional[int],
                          checkpoint: dict, events: list[dict], now: float) -> None:
        """Atomically: fencing check, revision CAS, checkpoint insert, events, run status."""
        with self.tx() as db:
            if lease_token is not None:
                r = db.execute("SELECT token FROM leases WHERE tenant_id=? AND run_id=?", (tenant_id, run_id)).fetchone()
                if not r or r[0] != lease_token:
                    raise ConflictError("STALE_LEASE: worker no longer owns this run")
            cur = db.execute("SELECT MAX(revision) FROM checkpoints WHERE tenant_id=? AND run_id=?",
                             (tenant_id, run_id)).fetchone()[0]
            if cur != expected_revision:
                raise ConflictError(f"REVISION_CONFLICT: expected {expected_revision}, found {cur}")
            db.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?)",
                       (tenant_id, run_id, checkpoint["revision"], _j(checkpoint), now))
            self._append_events(db, tenant_id, run_id, events, now)
            db.execute("UPDATE runs SET status=? WHERE tenant_id=? AND run_id=?", (checkpoint["status"], tenant_id,
                                                                                    run_id))
            if checkpoint["status"] in TERMINAL_RUN_STATUSES:
                # A finished run can never be reopened by a late answer to a still-open interaction.
                db.execute("UPDATE approval_requests SET status='CLOSED' WHERE tenant_id=? AND run_id=? AND "
                           "status='OPEN'", (tenant_id, run_id))

    def set_run_status(self, tenant_id: str, run_id: str, status: str) -> bool:
        """Set a non-terminal run status. Never overwrites a terminal status (returns False)."""
        with self.tx() as db:
            return self._set_run_status(db, tenant_id, run_id, status)

    def _set_run_status(self, db: sqlite3.Connection, tenant_id: str, run_id: str, status: str) -> bool:
        placeholders = ",".join("?" * len(TERMINAL_RUN_STATUSES))
        cur = db.execute(f"UPDATE runs SET status=? WHERE tenant_id=? AND run_id=? AND status NOT IN ({placeholders})",
                         (status, tenant_id, run_id, *TERMINAL_RUN_STATUSES))
        return cur.rowcount > 0

    def request_cancel(self, tenant_id: str, run_id: str) -> None:
        with self.tx() as db:
            db.execute("UPDATE runs SET cancel_requested=1 WHERE tenant_id=? AND run_id=?", (tenant_id, run_id))

    # ---- leases (fencing) ------------------------------------------------------------------- #
    def acquire_lease(self, tenant_id: str, run_id: str, worker_id: str, now: float, ttl: float) -> Optional[int]:
        with self.tx() as db:
            r = db.execute("SELECT worker_id, token, expires_at FROM leases WHERE tenant_id=? AND run_id=?",
                           (tenant_id, run_id)).fetchone()
            if r and r[0] != worker_id and r[2] > now:
                return None
            token = (r[1] if r else 0) + 1
            db.execute("INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?)", (tenant_id, run_id, worker_id, token, now + ttl))
            return token

    def lease_token(self, tenant_id: str, run_id: str) -> Optional[int]:
        r = self.q1("SELECT token FROM leases WHERE tenant_id=? AND run_id=?", (tenant_id, run_id))
        return r[0] if r else None

    # ---- action ledger ---------------------------------------------------------------------- #
    def create_intent(self, tenant_id: str, run_id: str, lid: str, state_id: str, revision: int, tool: str,
                      version: str, args: Any, args_digest: str, idem: str, lease_token: Optional[int],
                      now: float) -> dict:
        with self.tx() as db:
            r = db.execute("SELECT logical_action_id FROM action_intents WHERE tenant_id=? AND run_id=? AND revision=?",
                           (tenant_id, run_id, revision)).fetchone()
            if r is None:
                db.execute("INSERT INTO action_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
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

    def _fence_ok(self, db: sqlite3.Connection, tenant_id: str, lid: str, token: int,
                  run_id: Optional[str]) -> bool:
        if run_id is None:
            r = db.execute("SELECT run_id FROM action_intents WHERE tenant_id=? AND logical_action_id=?",
                           (tenant_id, lid)).fetchone()
            if not r:
                return False
            run_id = r[0]
        r = db.execute("SELECT token FROM leases WHERE tenant_id=? AND run_id=?", (tenant_id, run_id)).fetchone()
        return bool(r) and r[0] == token

    def _update_intent(self, db: sqlite3.Connection, tenant_id: str, lid: str, status: str, now: float,
                       bump_attempt: bool, lease_token: Optional[int], expect_status: Optional[tuple]) -> bool:
        sql = ("UPDATE action_intents SET status=?, updated_at=?, attempts=attempts+?, "
               "lease_token=COALESCE(?, lease_token) WHERE tenant_id=? AND logical_action_id=?")
        args: tuple = (status, now, 1 if bump_attempt else 0, lease_token, tenant_id, lid)
        if expect_status is not None:
            sql += f" AND status IN ({','.join('?' * len(expect_status))})"
            args += tuple(expect_status)
        return db.execute(sql, args).rowcount > 0

    def update_intent(self, tenant_id: str, lid: str, status: str, now: float, bump_attempt: bool = False,
                      lease_token: Optional[int] = None, require_token: Optional[int] = None,
                      expect_status: Optional[tuple] = None, run_id: Optional[str] = None) -> bool:
        """Update an intent's status. ``require_token`` fences on the run's current lease (raises
        ``STALE_LEASE``); ``expect_status`` makes the update conditional on the stored status (returns
        False when it did not match). ``run_id`` lets the fence apply to an action with no intent row."""
        with self.tx() as db:
            if require_token is not None and not self._fence_ok(db, tenant_id, lid, require_token, run_id):
                raise ConflictError("STALE_LEASE: dispatch fenced off")
            return self._update_intent(db, tenant_id, lid, status, now, bump_attempt, lease_token, expect_status)

    def record_outcome(self, tenant_id: str, lid: str, run_id: str, tool: str, version: str, args_digest: str,
                       idem: str, dispatch_state: str, certainty: str, external_ref: Optional[str], result: Any,
                       connector: str, now: float, *, intent_status: Optional[str] = None,
                       evidence: Optional[Callable[[int], list[dict]]] = None, require_token: Optional[int] = None,
                       expect_status: Optional[tuple] = None) -> Optional[int]:
        """Atomically append an action receipt, move the intent to ``intent_status`` and issue the
        evidence receipts derived from it (``evidence(seq)``), so a crash can never leave a receipt
        without its intent status or evidence. Returns the receipt seq, or None (writing nothing)
        when the lease fence or the expected intent status no longer holds."""
        with self.tx() as db:
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
            return self._add_receipt(db, tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state,
                                     certainty, external_ref, result, connector, now)

    def _add_receipt(self, db: sqlite3.Connection, tenant_id: str, lid: str, run_id: str, tool: str, version: str,
                     args_digest: str, idem: str, dispatch_state: str, certainty: str, external_ref: Optional[str],
                     result: Any, connector: str, now: float) -> int:
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
            if not db.execute("SELECT 1 FROM approval_requests WHERE tenant_id=? AND run_id=? AND revision=?",
                              (tenant_id, run_id, revision)).fetchone():
                db.execute("INSERT INTO approval_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)",
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
            db.execute("UPDATE approval_requests SET status=? WHERE tenant_id=? AND interaction_id=?",
                       (status, tenant_id, iid))

    def record_response(self, tenant_id: str, iid: str, run_id: str, responder: str, response: dict,
                        scope_digest: str, request_id: str, now: float, events: Optional[list[dict]] = None,
                        run_status: Optional[str] = None) -> bool:
        """Record the single response to an OPEN interaction, plus its events and the run status, in one
        transaction. Returns False (writing nothing) if another response won or the interaction is closed."""
        with self.tx() as db:
            if db.execute("SELECT 1 FROM approval_responses WHERE tenant_id=? AND interaction_id=?",
                          (tenant_id, iid)).fetchone():
                return False
            st = db.execute("SELECT status FROM approval_requests WHERE tenant_id=? AND interaction_id=?",
                            (tenant_id, iid)).fetchone()
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

    def _add_evidence(self, db: sqlite3.Connection, tenant_id: str, rec: dict) -> None:
        db.execute("INSERT OR IGNORE INTO evidence_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
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
            db.execute("INSERT OR IGNORE INTO trace_blobs VALUES(?,?,?,?)", (trace_id, sha, body, now))

    def put_proposal(self, pid: str, parent: str, cand: Optional[str], status: str, body: dict, now: float) -> None:
        with self.tx() as db:
            db.execute("INSERT OR REPLACE INTO update_proposals VALUES(?,?,?,?,?,?)",
                       (pid, parent, cand, status, _j(body), now))

    def archive(self, skill_id: str, version: Optional[int] = None) -> Optional[dict]:
        if version is None:
            r = self.q1("SELECT manifest FROM trace_archive_manifests WHERE skill_id=? ORDER BY version DESC LIMIT 1",
                        (skill_id,))
        else:
            r = self.q1("SELECT manifest FROM trace_archive_manifests WHERE skill_id=? AND version=?",
                        (skill_id, version))
        return json.loads(r[0]) if r else None
