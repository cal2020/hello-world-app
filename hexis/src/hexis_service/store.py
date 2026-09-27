"""SQLite store (single-process development adapter).

Tables follow brief section 11.3. Every operational row is tenant-scoped.
Checkpoint commits use a compare-and-swap on ``(run, revision)`` plus the
worker's fencing token, in one transaction with the run events. No
transaction is held open across a model call, human wait or tool call.
A PostgreSQL adapter would implement the same methods; it is not included.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS machine_versions (
  artifact_hash TEXT PRIMARY KEY, skill_id TEXT NOT NULL, package_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL, parent_hash TEXT, created_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS active_machine_versions (
  tenant_id TEXT NOT NULL, skill_id TEXT NOT NULL, artifact_hash TEXT NOT NULL, generation INTEGER NOT NULL,
  archive_manifest_id TEXT, PRIMARY KEY (tenant_id, skill_id));
CREATE TABLE IF NOT EXISTS admission_reports (
  report_id TEXT PRIMARY KEY, artifact_hash TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_hash TEXT NOT NULL, principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, run_id));
CREATE TABLE IF NOT EXISTS checkpoints (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, checkpoint_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS run_events (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
  UNIQUE (tenant_id, run_id, sequence));
CREATE TABLE IF NOT EXISTS observations (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, observation_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS leases (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, owner TEXT NOT NULL, fencing_token INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, run_id));
CREATE TABLE IF NOT EXISTS action_intents (
  tenant_id TEXT NOT NULL, logical_action_id TEXT NOT NULL, run_id TEXT NOT NULL, state_id TEXT NOT NULL,
  revision INTEGER NOT NULL, tool TEXT NOT NULL, tool_version TEXT NOT NULL, args_digest TEXT NOT NULL,
  args_json TEXT NOT NULL, idempotency_key TEXT NOT NULL, business_reference TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, fencing_token INTEGER, external_ref TEXT,
  PRIMARY KEY (tenant_id, logical_action_id), UNIQUE (tenant_id, run_id, state_id, revision));
CREATE TABLE IF NOT EXISTS action_receipts (
  tenant_id TEXT NOT NULL, receipt_id TEXT NOT NULL, logical_action_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  receipt_json TEXT NOT NULL, PRIMARY KEY (tenant_id, receipt_id));
CREATE TABLE IF NOT EXISTS interactions (
  tenant_id TEXT NOT NULL, interaction_id TEXT NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL,
  state_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, request_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, interaction_id), UNIQUE (tenant_id, run_id, state_id, revision));
CREATE TABLE IF NOT EXISTS approval_requests (
  tenant_id TEXT NOT NULL, interaction_id TEXT NOT NULL, request_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, interaction_id));
CREATE TABLE IF NOT EXISTS approval_responses (
  tenant_id TEXT NOT NULL, interaction_id TEXT NOT NULL, response_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, interaction_id));
CREATE TABLE IF NOT EXISTS evidence_receipts (
  tenant_id TEXT NOT NULL, receipt_id TEXT NOT NULL, run_id TEXT NOT NULL, receipt_json TEXT NOT NULL,
  invalidated_reason TEXT, PRIMARY KEY (tenant_id, receipt_id));
CREATE TABLE IF NOT EXISTS trace_blobs (
  trace_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, body BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS trace_archive_manifests (
  manifest_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, manifest_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS update_proposals (
  proposal_id TEXT PRIMARY KEY, parent_hash TEXT NOT NULL, candidate_hash TEXT, status TEXT NOT NULL,
  report_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS request_dedupe (
  tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id));
CREATE TABLE IF NOT EXISTS sequence (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
"""


class ConflictError(RuntimeError):
    """Optimistic concurrency failure (stale revision, lost lease, parent moved)."""


def _j(v: Any) -> str:
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


class Store:
    def __init__(self, path: str):
        self.path = path
        self._local = threading.local()
        self._conn().executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, isolation_level=None, timeout=10)
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA journal_mode=WAL") if self.path != ":memory:" else None
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        conn = self._conn()
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise

    def q(self, sql: str, args: tuple = ()) -> list[tuple]:
        return self._conn().execute(sql, args).fetchall()

    def next_seq(self, c: sqlite3.Connection, name: str) -> int:
        row = c.execute("SELECT value FROM sequence WHERE name=?", (name,)).fetchone()
        val = (row[0] if row else 0) + 1
        c.execute("INSERT INTO sequence(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                  (name, val))
        return val

    # ------------------------------------------------------------ dedupe ---
    def dedupe_get(self, tenant: str, request_id: str) -> Any | None:
        rows = self.q("SELECT result_json FROM request_dedupe WHERE tenant_id=? AND request_id=?", (tenant, request_id))
        return json.loads(rows[0][0]) if rows else None

    def dedupe_put(self, c: sqlite3.Connection, tenant: str, request_id: str, result: Any) -> None:
        c.execute("INSERT OR IGNORE INTO request_dedupe VALUES(?,?,?)", (tenant, request_id, _j(result)))

    # --------------------------------------------------------- artifacts ---
    def put_machine_version(self, pkg: dict, lifecycle: str) -> None:
        with self.tx() as c:
            exists = c.execute("SELECT lifecycle FROM machine_versions WHERE artifact_hash=?",
                               (pkg["artifact_hash"],)).fetchone()
            if exists:
                return  # immutable: never edited in place
            c.execute("INSERT INTO machine_versions VALUES(?,?,?,?,?,?)",
                      (pkg["artifact_hash"], pkg["machine"]["skill_id"], _j(pkg), lifecycle,
                       pkg["lineage"].get("parent_hash"), self.next_seq(c, "machine")))

    def set_lifecycle(self, c: sqlite3.Connection, artifact_hash: str, lifecycle: str) -> None:
        c.execute("UPDATE machine_versions SET lifecycle=? WHERE artifact_hash=?", (lifecycle, artifact_hash))

    def get_machine_version(self, artifact_hash: str) -> tuple[dict, str] | None:
        rows = self.q("SELECT package_json, lifecycle FROM machine_versions WHERE artifact_hash=?", (artifact_hash,))
        return (json.loads(rows[0][0]), rows[0][1]) if rows else None

    def get_active(self, tenant: str, skill_id: str) -> tuple[str, int, str | None] | None:
        rows = self.q("SELECT artifact_hash, generation, archive_manifest_id FROM active_machine_versions "
                      "WHERE tenant_id=? AND skill_id=?", (tenant, skill_id))
        return rows[0] if rows else None

    # --------------------------------------------------------------- runs ---
    def create_run(self, c: sqlite3.Connection, cp: dict, principal_id: str, created_at: str) -> None:
        c.execute("INSERT INTO runs VALUES(?,?,?,?,?)",
                  (cp["tenant_id"], cp["run_id"], cp["artifact_hash"], principal_id, created_at))
        c.execute("INSERT INTO checkpoints VALUES(?,?,?,?)", (cp["tenant_id"], cp["run_id"], 0, _j(cp)))

    def get_run(self, tenant: str, run_id: str) -> tuple | None:
        rows = self.q("SELECT tenant_id, run_id, artifact_hash, principal_id, created_at FROM runs "
                      "WHERE tenant_id=? AND run_id=?", (tenant, run_id))
        return rows[0] if rows else None

    def latest_checkpoint(self, tenant: str, run_id: str) -> dict | None:
        rows = self.q("SELECT checkpoint_json FROM checkpoints WHERE tenant_id=? AND run_id=? "
                      "ORDER BY revision DESC LIMIT 1", (tenant, run_id))
        return json.loads(rows[0][0]) if rows else None

    def checkpoint_at(self, tenant: str, run_id: str, revision: int) -> dict | None:
        rows = self.q("SELECT checkpoint_json FROM checkpoints WHERE tenant_id=? AND run_id=? AND revision=?",
                      (tenant, run_id, revision))
        return json.loads(rows[0][0]) if rows else None

    def append_events(self, c: sqlite3.Connection, tenant: str, run_id: str, events: list[dict]) -> None:
        row = c.execute("SELECT COALESCE(MAX(sequence),0) FROM run_events WHERE tenant_id=? AND run_id=?",
                        (tenant, run_id)).fetchone()
        seq = row[0]
        for e in events:
            seq += 1
            c.execute("INSERT INTO run_events VALUES(?,?,?,?)", (tenant, run_id, seq, _j({**e, "sequence": seq})))

    def events(self, tenant: str, run_id: str) -> list[dict]:
        return [json.loads(r[0]) for r in self.q(
            "SELECT event_json FROM run_events WHERE tenant_id=? AND run_id=? ORDER BY sequence", (tenant, run_id))]

    def commit_checkpoint(self, c: sqlite3.Connection, prev: dict, new: dict, fencing_token: int | None,
                          observation: dict | None) -> None:
        tenant, run = prev["tenant_id"], prev["run_id"]
        latest = c.execute("SELECT MAX(revision) FROM checkpoints WHERE tenant_id=? AND run_id=?",
                           (tenant, run)).fetchone()[0]
        if latest != prev["revision"]:
            raise ConflictError(f"stale revision {prev['revision']} (latest {latest})")
        if fencing_token is not None:
            lease = c.execute("SELECT fencing_token FROM leases WHERE tenant_id=? AND run_id=?", (tenant, run)).fetchone()
            if not lease or lease[0] != fencing_token:
                raise ConflictError("worker lease lost (fencing token is stale)")
        if new["revision"] != prev["revision"] + 1:
            raise ConflictError("new checkpoint must increment the revision by one")
        c.execute("INSERT INTO checkpoints VALUES(?,?,?,?)", (tenant, run, new["revision"], _j(new)))
        if observation is not None:
            c.execute("INSERT INTO observations VALUES(?,?,?,?)", (tenant, run, prev["revision"], _j(observation)))

    def observations(self, tenant: str, run_id: str) -> dict[int, dict]:
        return {r[0]: json.loads(r[1]) for r in self.q(
            "SELECT revision, observation_json FROM observations WHERE tenant_id=? AND run_id=?", (tenant, run_id))}

    # ------------------------------------------------------------- leases ---
    def acquire_lease(self, tenant: str, run_id: str, owner: str) -> int:
        with self.tx() as c:
            row = c.execute("SELECT fencing_token FROM leases WHERE tenant_id=? AND run_id=?", (tenant, run_id)).fetchone()
            token = (row[0] if row else 0) + 1
            c.execute("INSERT INTO leases VALUES(?,?,?,?) ON CONFLICT(tenant_id, run_id) DO UPDATE SET "
                      "owner=excluded.owner, fencing_token=excluded.fencing_token", (tenant, run_id, owner, token))
            return token

    def current_token(self, tenant: str, run_id: str) -> int | None:
        rows = self.q("SELECT fencing_token FROM leases WHERE tenant_id=? AND run_id=?", (tenant, run_id))
        return rows[0][0] if rows else None

    # ------------------------------------------------------------ intents ---
    def get_intent_for_visit(self, tenant: str, run_id: str, state_id: str, revision: int) -> dict | None:
        rows = self.q("SELECT * FROM action_intents WHERE tenant_id=? AND run_id=? AND state_id=? AND revision=?",
                      (tenant, run_id, state_id, revision))
        return self._intent(rows[0]) if rows else None

    def get_intent(self, tenant: str, logical_action_id: str) -> dict | None:
        rows = self.q("SELECT * FROM action_intents WHERE tenant_id=? AND logical_action_id=?", (tenant, logical_action_id))
        return self._intent(rows[0]) if rows else None

    def run_intents(self, tenant: str, run_id: str) -> list[dict]:
        return [self._intent(r) for r in self.q(
            "SELECT * FROM action_intents WHERE tenant_id=? AND run_id=? ORDER BY revision", (tenant, run_id))]

    _INTENT_COLS = ("tenant_id", "logical_action_id", "run_id", "state_id", "revision", "tool", "tool_version",
                    "args_digest", "args_json", "idempotency_key", "business_reference", "status", "attempts",
                    "fencing_token", "external_ref")

    def _intent(self, row: tuple) -> dict:
        d = dict(zip(self._INTENT_COLS, row))
        d["args"] = json.loads(d.pop("args_json"))
        return d

    def insert_intent(self, intent: dict) -> None:
        with self.tx() as c:
            c.execute("INSERT INTO action_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                intent["tenant_id"], intent["logical_action_id"], intent["run_id"], intent["state_id"],
                intent["revision"], intent["tool"], intent["tool_version"], intent["args_digest"], _j(intent["args"]),
                intent["idempotency_key"], intent["business_reference"], "pending", 0, None, None))

    def update_intent(self, tenant: str, logical_action_id: str, **fields: Any) -> None:
        with self.tx() as c:
            sets = ", ".join(f"{k}=?" for k in fields)
            c.execute(f"UPDATE action_intents SET {sets} WHERE tenant_id=? AND logical_action_id=?",
                      (*fields.values(), tenant, logical_action_id))

    def add_receipt(self, tenant: str, receipt: dict) -> None:
        with self.tx() as c:
            c.execute("INSERT INTO action_receipts VALUES(?,?,?,?,?)", (tenant, receipt["receipt_id"],
                      receipt["logical_action_id"], receipt["attempt"], _j(receipt)))

    def receipts(self, tenant: str, logical_action_id: str | None = None, run_id: str | None = None) -> list[dict]:
        rows = self.q("SELECT receipt_json FROM action_receipts WHERE tenant_id=? ORDER BY rowid", (tenant,))
        out = [json.loads(r[0]) for r in rows]
        if logical_action_id:
            out = [r for r in out if r["logical_action_id"] == logical_action_id]
        if run_id:
            out = [r for r in out if r.get("run_id") == run_id]
        return out
