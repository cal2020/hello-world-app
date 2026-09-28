-- schema-version: 2
-- Initial PostgreSQL schema. Equivalent to the SQLite store's schema version 2 (storage/sqlite.py DDL):
-- same tables, same column order, same tenant-scoped primary keys / unique constraints, and the same
-- append-only tables (enforced here by plpgsql triggers). Every statement is idempotent so a re-run is
-- harmless; the runner (storage.postgres.migrate) additionally records the version in schema_migrations.

CREATE TABLE IF NOT EXISTS machine_versions(artifact_hash TEXT PRIMARY KEY, skill_id TEXT NOT NULL,
  parent_hash TEXT, package TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS machine_lifecycle(artifact_hash TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT, at DOUBLE PRECISION NOT NULL, PRIMARY KEY(artifact_hash, seq));
CREATE TABLE IF NOT EXISTS active_machine_versions(environment TEXT NOT NULL, skill_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL, archive_version INTEGER NOT NULL, updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY(environment, skill_id));
CREATE TABLE IF NOT EXISTS admission_reports(artifact_hash TEXT PRIMARY KEY, record TEXT NOT NULL, report TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_hash TEXT NOT NULL,
  principal TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at DOUBLE PRECISION NOT NULL, PRIMARY KEY(tenant_id, run_id), UNIQUE(tenant_id, request_id));
CREATE TABLE IF NOT EXISTS checkpoints(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL, PRIMARY KEY(tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS run_events(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY(tenant_id, run_id, sequence));
CREATE TABLE IF NOT EXISTS leases(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  token INTEGER NOT NULL, expires_at DOUBLE PRECISION NOT NULL, PRIMARY KEY(tenant_id, run_id));
CREATE TABLE IF NOT EXISTS action_intents(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
  logical_action_id TEXT NOT NULL, state_id TEXT NOT NULL, revision INTEGER NOT NULL, tool TEXT NOT NULL,
  tool_version TEXT NOT NULL, args TEXT NOT NULL, args_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL, lease_token INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  created_at DOUBLE PRECISION NOT NULL, updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY(tenant_id, logical_action_id), UNIQUE(tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS action_receipts(tenant_id TEXT NOT NULL, logical_action_id TEXT NOT NULL,
  seq INTEGER NOT NULL, run_id TEXT NOT NULL, tool TEXT NOT NULL, tool_version TEXT NOT NULL,
  args_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL, dispatch_state TEXT NOT NULL, certainty TEXT NOT NULL,
  external_ref TEXT, result TEXT, connector TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY(tenant_id, logical_action_id, seq));
CREATE TABLE IF NOT EXISTS approval_requests(tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL, type TEXT NOT NULL, state_id TEXT NOT NULL, revision INTEGER NOT NULL,
  scope TEXT NOT NULL, scope_digest TEXT NOT NULL, expires_at DOUBLE PRECISION, status TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL, PRIMARY KEY(tenant_id, interaction_id), UNIQUE(tenant_id, run_id, revision));
CREATE TABLE IF NOT EXISTS approval_responses(tenant_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
  run_id TEXT NOT NULL, responder TEXT NOT NULL, response TEXT NOT NULL, scope_digest TEXT NOT NULL,
  request_id TEXT, created_at DOUBLE PRECISION NOT NULL, PRIMARY KEY(tenant_id, interaction_id));
CREATE TABLE IF NOT EXISTS trace_blobs(trace_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, body TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS trace_archive_manifests(skill_id TEXT NOT NULL, version INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL, manifest TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY(skill_id, version));
CREATE TABLE IF NOT EXISTS update_proposals(proposal_id TEXT PRIMARY KEY, parent_hash TEXT NOT NULL,
  candidate_hash TEXT, status TEXT NOT NULL, body TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS evidence_receipts(tenant_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  run_id TEXT NOT NULL, claim TEXT NOT NULL, verifier TEXT NOT NULL, verifier_version TEXT NOT NULL,
  subject TEXT NOT NULL, subject_digest TEXT NOT NULL, result TEXT NOT NULL, source_ref TEXT NOT NULL,
  observed_at DOUBLE PRECISION NOT NULL, invalidated_at DOUBLE PRECISION, invalidation_reason TEXT,
  PRIMARY KEY(tenant_id, run_id, receipt_id));

-- Append-only protection (same tables as storage/sqlite.py IMMUTABLE): UPDATE, DELETE and TRUNCATE raise.
CREATE OR REPLACE FUNCTION hexis_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['machine_versions', 'checkpoints', 'run_events', 'action_receipts', 'trace_blobs',
                           'trace_archive_manifests', 'approval_responses', 'machine_lifecycle', 'admission_reports']
  LOOP
    EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
                   'FOR EACH ROW EXECUTE FUNCTION hexis_append_only()', t || '_append_only', t);
    EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON %I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION hexis_append_only()', t || '_no_truncate', t);
  END LOOP;
END
$$;
