"""SQLite persistence: schema, transactions, idempotent operations and the audit chain.

Facts, decisions and events live here. Draft text and model context are views that
can be regenerated; review decisions and audit events are append-only at the
application level (triggers below). A database administrator can still bypass
triggers, so this is tamper-evidence for the demo, not tamper-proofing.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager

from . import config
from .util import canonical, digest_obj, now, sha256

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, display TEXT NOT NULL, role TEXT NOT NULL, project TEXT NOT NULL,
  revoked_at TEXT, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS operations (
  op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, request_digest TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reference_data (
  kind TEXT PRIMARY KEY, digest TEXT NOT NULL, content_json TEXT NOT NULL, loaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project TEXT NOT NULL, source_id TEXT NOT NULL,
  revision TEXT NOT NULL, digest TEXT NOT NULL, raw BLOB NOT NULL, imported_at TEXT NOT NULL,
  imported_by TEXT NOT NULL, adapter_version TEXT NOT NULL, synthetic INTEGER NOT NULL,
  UNIQUE(project, digest)
);
CREATE TABLE IF NOT EXISTS project_state (
  project TEXT PRIMARY KEY, current_snapshot_id TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS elements (
  snapshot_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, name TEXT, revision TEXT NOT NULL,
  boundary TEXT, pointer TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS flows (
  snapshot_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
  revision TEXT NOT NULL, crosses INTEGER NOT NULL, pointer TEXT NOT NULL, data_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS boundaries (
  snapshot_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT, kind TEXT, pointer TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, digest TEXT NOT NULL, raw BLOB NOT NULL,
  media_type TEXT NOT NULL, meta_json TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL,
  synthetic INTEGER NOT NULL, imported_at TEXT NOT NULL, imported_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, evidence_id TEXT NOT NULL, status TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, row_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL, object_id TEXT NOT NULL, control_id TEXT NOT NULL,
  statement_id TEXT NOT NULL, result TEXT NOT NULL, detail_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL, inputs_digest TEXT NOT NULL, tool_version TEXT, error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  parent_id TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, drafter_mode TEXT NOT NULL,
  draft_json TEXT NOT NULL, validation_json TEXT NOT NULL, rows_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL, dependency_digest TEXT NOT NULL, package_digest TEXT NOT NULL,
  batch_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, package_id TEXT NOT NULL, package_digest TEXT NOT NULL,
  dependency_digest TEXT NOT NULL, actor TEXT NOT NULL, actor_role TEXT NOT NULL,
  decision TEXT NOT NULL, reason TEXT NOT NULL, limitations_json TEXT NOT NULL,
  prior_decision_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decision_revocations (
  decision_id TEXT PRIMARY KEY, actor TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY, package_id TEXT NOT NULL, mode TEXT NOT NULL, status_at_export TEXT NOT NULL,
  created_at TEXT NOT NULL, actor TEXT NOT NULL, path TEXT NOT NULL, files_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  operation TEXT NOT NULL, op_id TEXT, target TEXT, prior_ref TEXT, new_ref TEXT,
  outcome TEXT NOT NULL, detail_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
"""

APPEND_ONLY = ["audit_events", "review_decisions", "decision_revocations", "snapshots", "evidence",
               "packages", "check_runs", "evidence_events", "exports"]


def connect(path=None) -> sqlite3.Connection:
    p = path or config.db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=10, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    for t in APPEND_ONLY:
        conn.execute(f"""CREATE TRIGGER IF NOT EXISTS {t}_no_update BEFORE UPDATE ON {t}
                         BEGIN SELECT RAISE(ABORT, '{t} is append-only'); END""")
        conn.execute(f"""CREATE TRIGGER IF NOT EXISTS {t}_no_delete BEFORE DELETE ON {t}
                         BEGIN SELECT RAISE(ABORT, '{t} is append-only'); END""")
    return conn


@contextmanager
def tx(conn: sqlite3.Connection):
    """BEGIN IMMEDIATE takes the write lock up front so check-then-write is atomic."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


class OperationConflict(Exception):
    """Same operation id reused for a different request."""


def find_operation(conn, op_id: str | None, kind: str, request: dict):
    """Return the committed result for a retried operation, or None if it is new."""
    if not op_id:
        return None
    row = conn.execute("SELECT * FROM operations WHERE op_id=?", (op_id,)).fetchone()
    if row is None:
        return None
    if row["kind"] != kind or row["request_digest"] != digest_obj(request):
        raise OperationConflict(f"operation id {op_id} was already used for a different request")
    return json.loads(row["result_json"])


def record_operation(conn, op_id: str | None, kind: str, actor: str, request: dict, result: dict):
    if not op_id:
        return
    conn.execute("INSERT INTO operations VALUES (?,?,?,?,?,?)",
                 (op_id, kind, actor, digest_obj(request), json.dumps(result), now()))


def audit(conn, actor: str, operation: str, outcome: str, *, op_id=None, target=None,
          prior_ref=None, new_ref=None, detail=None):
    """Append a hash-chained audit event. Call inside the same transaction as the effect."""
    last = conn.execute("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1").fetchone()
    prev = last["hash"] if last else "0" * 64
    at = now()
    body = {"at": at, "actor": actor, "operation": operation, "op_id": op_id, "target": target,
            "prior_ref": prior_ref, "new_ref": new_ref, "outcome": outcome, "detail": detail or {}}
    h = sha256(prev.encode() + canonical(body))
    conn.execute("""INSERT INTO audit_events (at, actor, operation, op_id, target, prior_ref, new_ref,
                    outcome, detail_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                 (at, actor, operation, op_id, target, prior_ref, new_ref, outcome,
                  json.dumps(detail or {}), prev, h))


def verify_audit_chain(conn) -> dict:
    prev = "0" * 64
    n = 0
    for r in conn.execute("SELECT * FROM audit_events ORDER BY seq"):
        body = {"at": r["at"], "actor": r["actor"], "operation": r["operation"], "op_id": r["op_id"],
                "target": r["target"], "prior_ref": r["prior_ref"], "new_ref": r["new_ref"],
                "outcome": r["outcome"], "detail": json.loads(r["detail_json"])}
        if r["prev_hash"] != prev or sha256(prev.encode() + canonical(body)) != r["hash"]:
            return {"ok": False, "events": n, "broken_at_seq": r["seq"]}
        prev = r["hash"]
        n += 1
    return {"ok": True, "events": n, "head": prev}


def next_seq(conn, table: str) -> int:
    r = conn.execute(f"SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM {table}").fetchone()
    return r["n"]
