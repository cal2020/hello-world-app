// SQLite persistence via Node's built-in node:sqlite (no native dependency).
// Immutability and append-only rules are enforced with triggers. These protect
// against application bugs, not against someone with direct database access.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  revision_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL,
  access_label TEXT NOT NULL,
  effective_from TEXT,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (source_id, revision_seq),
  UNIQUE (source_id, revision)
);

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  latest_version_id TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  config_json TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  context_json TEXT,
  output_json TEXT,
  stripped_json TEXT,
  error TEXT,
  usage_json TEXT,
  latency_ms INTEGER,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS candidate_versions (
  version_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  parent_version_id TEXT,
  run_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  state TEXT NOT NULL,
  edit_note TEXT,
  UNIQUE (candidate_id, version_no)
);

CREATE TABLE IF NOT EXISTS support_judgments (
  judgment_id TEXT PRIMARY KEY,
  claim_digest TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  support TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_decisions (
  decision_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS exports (
  export_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  decision_id TEXT,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  op_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  operation TEXT NOT NULL,
  op_id TEXT,
  subject TEXT,
  prior_ref TEXT,
  new_ref TEXT,
  result TEXT NOT NULL,
  details_json TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  eval_run_id TEXT PRIMARY KEY,
  suite_version TEXT NOT NULL,
  criteria_hash TEXT NOT NULL,
  code_revision TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS eval_results (
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  split TEXT NOT NULL,
  repeat_idx INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  expectations_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  grader TEXT NOT NULL,
  unresolved_json TEXT,
  executed_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_no_update BEFORE UPDATE ON source_snapshots
BEGIN SELECT RAISE(ABORT, 'source snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_no_delete BEFORE DELETE ON source_snapshots
BEGIN SELECT RAISE(ABORT, 'source snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS version_content_immutable
BEFORE UPDATE OF content_json, digest, manifest_hash, source_manifest_json, checks_json ON candidate_versions
BEGIN SELECT RAISE(ABORT, 'candidate version content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS decision_no_delete BEFORE DELETE ON review_decisions
BEGIN SELECT RAISE(ABORT, 'review decisions are retained'); END;
`

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

// Runs fn inside BEGIN IMMEDIATE so the read-check-write sequence of a review
// decision or export cannot interleave with a source import.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : fallback
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
}
