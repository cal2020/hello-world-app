"""SQLite persistence. One file; WAL mode; BEGIN IMMEDIATE for every mutation.

Append-only history is enforced by application code, not by the storage engine:
an administrator with file access can still rewrite this database.
"""
import contextlib
import sqlite3
import threading

SCHEMA = r"""
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, display TEXT NOT NULL, token TEXT UNIQUE NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  user_id TEXT NOT NULL, project TEXT NOT NULL, permission TEXT NOT NULL,
  granted_at TEXT NOT NULL, revoked_at TEXT,
  PRIMARY KEY (user_id, project, permission, granted_at)
);

-- Every import attempt, accepted or not. raw_bytes retained verbatim.
CREATE TABLE IF NOT EXISTS source_import (
  import_id TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT NOT NULL, revision TEXT,
  parent_revision TEXT, kind TEXT, scope_json TEXT, format TEXT, raw_digest TEXT NOT NULL,
  raw_bytes BLOB NOT NULL, adapter_version TEXT NOT NULL, outcome TEXT NOT NULL,
  snapshot_id TEXT, diagnostics_json TEXT NOT NULL, actor TEXT NOT NULL, received_at TEXT NOT NULL,
  duplicate_of TEXT, reconciled_by TEXT
);
CREATE TABLE IF NOT EXISTS source_snapshot (
  snapshot_id TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT NOT NULL, revision TEXT NOT NULL,
  parent_revision TEXT, kind TEXT NOT NULL, completeness TEXT NOT NULL, scope_json TEXT NOT NULL,
  raw_digest TEXT NOT NULL, normalized_digest TEXT NOT NULL, adapter_version TEXT NOT NULL,
  status TEXT NOT NULL, definitions_json TEXT NOT NULL, import_id TEXT NOT NULL, created_at TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  UNIQUE (source, project, revision)
);
CREATE TABLE IF NOT EXISTS source_head (
  source TEXT NOT NULL, project TEXT NOT NULL, revision TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  head_seq INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (source, project)
);
CREATE TABLE IF NOT EXISTS head_history (
  source TEXT NOT NULL, project TEXT NOT NULL, head_seq INTEGER NOT NULL, revision TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, import_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (source, project, head_seq)
);
CREATE TABLE IF NOT EXISTS element_identity (
  entity_uid TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT NOT NULL, native_id TEXT NOT NULL,
  first_snapshot_id TEXT NOT NULL, UNIQUE (source, project, native_id)
);
CREATE TABLE IF NOT EXISTS element_version (
  version_id TEXT PRIMARY KEY, entity_uid TEXT NOT NULL, type TEXT NOT NULL, name TEXT, owner TEXT,
  properties_json TEXT NOT NULL, unrecognized_json TEXT NOT NULL, content_digest TEXT NOT NULL,
  source_pointer TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_element (
  snapshot_id TEXT NOT NULL, entity_uid TEXT NOT NULL, version_id TEXT NOT NULL, state TEXT NOT NULL,
  observed INTEGER NOT NULL, PRIMARY KEY (snapshot_id, entity_uid)
);
CREATE TABLE IF NOT EXISTS relationship_version (
  version_id TEXT PRIMARY KEY, rel_uid TEXT NOT NULL, native_id TEXT, predicate TEXT NOT NULL,
  source_uid TEXT NOT NULL, target_uid TEXT NOT NULL, multiplicity TEXT, authority TEXT NOT NULL,
  input_versions_json TEXT NOT NULL, content_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_relationship (
  snapshot_id TEXT NOT NULL, rel_uid TEXT NOT NULL, version_id TEXT NOT NULL, state TEXT NOT NULL,
  endpoint_status TEXT NOT NULL, PRIMARY KEY (snapshot_id, rel_uid)
);
CREATE TABLE IF NOT EXISTS external_record (
  snapshot_id TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL, kind TEXT NOT NULL,
  asset_ref TEXT, text TEXT NOT NULL, PRIMARY KEY (snapshot_id, record_id)
);

CREATE TABLE IF NOT EXISTS projection_definition (
  projection_id TEXT NOT NULL, version TEXT NOT NULL, project TEXT NOT NULL, body_json TEXT NOT NULL,
  digest TEXT NOT NULL, status TEXT NOT NULL, reviewed_by TEXT, review_reason TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (projection_id, version)
);
CREATE TABLE IF NOT EXISTS contract_artifact (
  contract_digest TEXT PRIMARY KEY, contract_id TEXT NOT NULL, contract_version TEXT NOT NULL,
  openapi_json TEXT NOT NULL, generator_version TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS release (
  release_id TEXT PRIMARY KEY, project TEXT NOT NULL, projection_id TEXT NOT NULL, projection_version TEXT NOT NULL,
  projection_digest TEXT NOT NULL, contract_digest TEXT, snapshot_id TEXT NOT NULL, record_snapshot_id TEXT,
  code_version TEXT NOT NULL, generator_version TEXT NOT NULL, status TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consumer_test_run (
  run_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, consumer_id TEXT NOT NULL, consumer_version TEXT NOT NULL,
  expectations_digest TEXT NOT NULL, passed INTEGER NOT NULL, results_json TEXT NOT NULL,
  schema_check_json TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS release_pointer (
  project TEXT PRIMARY KEY, release_id TEXT NOT NULL, pointer_seq INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS release_activation (
  project TEXT NOT NULL, pointer_seq INTEGER NOT NULL, release_id TEXT NOT NULL, previous_release_id TEXT,
  action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, at TEXT NOT NULL, PRIMARY KEY (project, pointer_seq)
);

CREATE TABLE IF NOT EXISTS proposal_run (
  run_id TEXT PRIMARY KEY, project TEXT NOT NULL, method TEXT NOT NULL, mode TEXT NOT NULL,
  provider TEXT, model TEXT, sampling_json TEXT NOT NULL, prompt_version TEXT, vocabulary_version TEXT,
  permitted_inputs_json TEXT NOT NULL, context_digest TEXT, status TEXT NOT NULL, error TEXT,
  actor TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, raw_output TEXT, stats_json TEXT
);
CREATE TABLE IF NOT EXISTS link_proposal (
  proposal_id TEXT PRIMARY KEY, project TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  record_source TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL,
  record_snapshot_id TEXT NOT NULL, target_uid TEXT, target_version TEXT, model_snapshot_id TEXT NOT NULL,
  predicate TEXT NOT NULL, evidence_json TEXT NOT NULL, contradictions_json TEXT NOT NULL,
  input_vector_json TEXT NOT NULL, confidence REAL, validation TEXT NOT NULL, validation_notes_json TEXT NOT NULL,
  disposition TEXT NOT NULL, etag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_decision (
  decision_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, proposal_etag TEXT NOT NULL, actor TEXT NOT NULL,
  decision TEXT NOT NULL, reason TEXT, input_vector_json TEXT NOT NULL, at TEXT NOT NULL,
  revoked_at TEXT, revoked_by TEXT, revoke_reason TEXT
);
CREATE TABLE IF NOT EXISTS integration_link (
  link_id TEXT PRIMARY KEY, project TEXT NOT NULL, proposal_id TEXT NOT NULL, decision_id TEXT NOT NULL,
  record_source TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL, target_uid TEXT NOT NULL,
  target_version TEXT NOT NULL, predicate TEXT NOT NULL, authority TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, status_note TEXT
);

CREATE TABLE IF NOT EXISTS operation_receipt (
  caller TEXT NOT NULL, project TEXT NOT NULL, operation_id TEXT NOT NULL, operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL, state TEXT NOT NULL, status_code INTEGER NOT NULL, response_json TEXT NOT NULL,
  affected_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY (caller, project, operation_id)
);
CREATE TABLE IF NOT EXISTS stream_seq (project TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox_event (
  event_id TEXT PRIMARY KEY, project TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, causal_operation TEXT, created_at TEXT NOT NULL, delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL NOT NULL DEFAULT 0, last_error TEXT,
  UNIQUE (project, seq)
);
CREATE TABLE IF NOT EXISTS delivery_attempt (
  event_id TEXT NOT NULL, attempt INTEGER NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT,
  PRIMARY KEY (event_id, attempt)
);
CREATE TABLE IF NOT EXISTS audit_event (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, project TEXT,
  action TEXT NOT NULL, outcome TEXT NOT NULL, operation_id TEXT, detail_json TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: str):
        self.path = path
        self._local = threading.local()
        with self.connect() as c:
            c.executescript(SCHEMA)

    def connect(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    @contextlib.contextmanager
    def tx(self):
        """Serializable write transaction (BEGIN IMMEDIATE takes the write lock up front)."""
        c = self.connect()
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise

    def read(self):
        return self.connect()


def audit(c, actor, project, action, outcome, operation_id=None, detail=None):
    import json
    from .util import now
    c.execute("INSERT INTO audit_event (at, actor, project, action, outcome, operation_id, detail_json) "
              "VALUES (?,?,?,?,?,?,?)", (now(), actor, project, action, outcome, operation_id,
                                          json.dumps(detail or {}, sort_keys=True)))


def enqueue_event(c, project, type_, payload, causal_operation=None):
    """Write an outbox event in the caller's transaction, with a per-project stream sequence."""
    import json
    from .util import new_id, now
    row = c.execute("SELECT seq FROM stream_seq WHERE project=?", (project,)).fetchone()
    seq = (row["seq"] if row else 0) + 1
    c.execute("INSERT INTO stream_seq (project, seq) VALUES (?,?) ON CONFLICT(project) DO UPDATE SET seq=excluded.seq",
              (project, seq))
    event_id = new_id("evt")
    c.execute("INSERT INTO outbox_event (event_id, project, seq, type, payload_json, causal_operation, created_at) "
              "VALUES (?,?,?,?,?,?,?)", (event_id, project, seq, type_, json.dumps(payload, sort_keys=True),
                                         causal_operation, now()))
    return event_id, seq
