"""PostgreSQL schema (SQLAlchemy Core). Applied by Alembic migrations; this module is the single definition.

``public`` holds the judge-visible catalogue, jobs, runs, attempts, events, aggregate score reports, review
annotations, users and audit events. ``private`` holds gold labels, pair/grouping data, and label-derived per-item
score outcomes. Database roles (created by ``agenthorizon bootstrap``):

* ``ah_api``      API server: public read/write; private read (privileged research views, audited reveal)
* ``ah_worker``   judge worker: catalogue read; jobs/runs/attempts/events write; NO access to ``private``
* ``ah_scorer``   trusted worker (ingest/index/score/export): public read/write; private read/write
"""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

metadata = MetaData()
PRIVATE = "private"


def _ts(name: str, **kw) -> Column:
    return Column(name, DateTime(timezone=True), **kw)


def _now(name: str) -> Column:
    return Column(name, DateTime(timezone=True), nullable=False, server_default=func.now())


# ---- identity & audit ------------------------------------------------------------------------------------------
users = Table("users", metadata,
              Column("user_id", String(64), primary_key=True),
              Column("display_name", Text, nullable=False),
              Column("role", String(16), nullable=False),  # operator | researcher | reviewer | viewer
              _now("created_at"),
              Column("disabled", Boolean, nullable=False, server_default="false"))

api_tokens = Table("api_tokens", metadata,
                   Column("token_hash", String(64), primary_key=True),
                   Column("user_id", String(64), ForeignKey("users.user_id"), nullable=False),
                   Column("label", Text),
                   _now("created_at"), _ts("expires_at"), _ts("revoked_at"))

sessions = Table("sessions", metadata,
                 Column("session_hash", String(64), primary_key=True),
                 Column("user_id", String(64), ForeignKey("users.user_id"), nullable=False),
                 _now("created_at"), _ts("expires_at", nullable=False), _ts("revoked_at"))

audit_events = Table("audit_events", metadata,
                     Column("id", BigInteger, primary_key=True, autoincrement=True),
                     _now("at"),
                     Column("actor", String(64)), Column("role", String(16)),
                     Column("action", String(64), nullable=False), Column("target", Text),
                     Column("request_id", String(64)), Column("detail", JSONB, nullable=False, server_default="{}"))

idempotency_keys = Table("idempotency_keys", metadata,
                         Column("key", String(128), primary_key=True),
                         Column("user_id", String(64), nullable=False),
                         Column("route", Text, nullable=False),
                         Column("request_digest", String(64), nullable=False),
                         Column("response", JSONB, nullable=False),
                         Column("status_code", Integer, nullable=False),
                         _now("created_at"))

# ---- catalogue (judge-visible material only) --------------------------------------------------------------------
dataset_versions = Table("dataset_versions", metadata,
                         Column("dataset_version_id", String(200), primary_key=True),
                         Column("benchmark", Text, nullable=False),
                         Column("synthetic", Boolean, nullable=False),
                         Column("info", JSONB, nullable=False),
                         Column("validation", JSONB), Column("reconciliation", JSONB),
                         _now("indexed_at"))

examples = Table("examples", metadata,
                 Column("dataset_version_id", String(200), ForeignKey("dataset_versions.dataset_version_id", ondelete="CASCADE"),
                        nullable=False),
                 Column("example_id", String(128), nullable=False),
                 Column("recording_id", String(128), nullable=False),
                 Column("instruction_id", String(128)),
                 Column("instruction", Text, nullable=False),
                 Column("n_steps", Integer, nullable=False),
                 Column("os", Text), Column("application", Text), Column("domain", Text), Column("length_bin", Text),
                 Column("has_markdown", Boolean, nullable=False, server_default="false"),
                 Column("has_json", Boolean, nullable=False, server_default="false"),
                 Column("media_total", Integer, nullable=False, server_default="0"),
                 Column("media_materialized", Integer, nullable=False, server_default="0"),
                 Column("search_text", Text, nullable=False, server_default=""),
                 Column("meta", JSONB, nullable=False, server_default="{}"),
                 PrimaryKeyConstraint("dataset_version_id", "example_id"))
Index("ix_examples_search_trgm", examples.c.search_text, postgresql_using="gin",
      postgresql_ops={"search_text": "gin_trgm_ops"})
Index("ix_examples_filters", examples.c.dataset_version_id, examples.c.os, examples.c.application, examples.c.n_steps)

steps = Table("steps", metadata,
              Column("dataset_version_id", String(200), ForeignKey("dataset_versions.dataset_version_id", ondelete="CASCADE"),
                     nullable=False),
              Column("recording_id", String(128), nullable=False),
              Column("idx", Integer, nullable=False),
              Column("step_id", Integer),
              Column("action_type", String(64)),
              Column("action_text", Text), Column("action_text_full", Text),
              Column("action", JSONB),
              Column("asset_key", Text),
              Column("timestamp_us", BigInteger),
              Column("observation_timing", String(32)),
              Column("thought", Text), Column("action_description", Text),
              PrimaryKeyConstraint("dataset_version_id", "recording_id", "idx"))

assets = Table("assets", metadata,
               Column("dataset_version_id", String(200), ForeignKey("dataset_versions.dataset_version_id", ondelete="CASCADE"),
                      nullable=False),
               Column("asset_key", Text, nullable=False),
               Column("sha256", String(64)), Column("status", String(32), nullable=False),
               Column("width", Integer), Column("height", Integer), Column("bytes", BigInteger),
               PrimaryKeyConstraint("dataset_version_id", "asset_key"))
Index("ix_assets_sha", assets.c.sha256)

manifests = Table("manifests", metadata,
                  Column("manifest_id", String(300), primary_key=True),
                  Column("dataset_version_id", String(200), ForeignKey("dataset_versions.dataset_version_id", ondelete="CASCADE"),
                         nullable=False),
                  Column("name", Text, nullable=False), Column("partition", Text, nullable=False),
                  Column("role", Text, nullable=False), Column("official", Boolean, nullable=False),
                  Column("n_items", Integer, nullable=False), Column("digest", String(64), nullable=False),
                  Column("lineage", JSONB, nullable=False, server_default="{}"),
                  Column("notes", JSONB, nullable=False, server_default="[]"))

manifest_members = Table("manifest_members", metadata,
                         Column("manifest_id", String(300), ForeignKey("manifests.manifest_id", ondelete="CASCADE"), nullable=False),
                         Column("example_id", String(128), nullable=False),
                         PrimaryKeyConstraint("manifest_id", "example_id"))
Index("ix_manifest_members_example", manifest_members.c.example_id)

# ---- jobs --------------------------------------------------------------------------------------------------------
jobs = Table("jobs", metadata,
             Column("job_id", BigInteger, primary_key=True, autoincrement=True),
             Column("queue", String(16), nullable=False),  # judge | trusted
             Column("kind", String(32), nullable=False),
             Column("payload", JSONB, nullable=False),
             Column("status", String(16), nullable=False, server_default="queued"),
             Column("priority", Integer, nullable=False, server_default="100"),
             Column("dedupe_key", String(300)),
             Column("lease_owner", String(128)), _ts("lease_expires_at"),
             Column("attempts", Integer, nullable=False, server_default="0"),
             Column("max_attempts", Integer, nullable=False, server_default="3"),
             Column("last_error", Text), Column("result", JSONB),
             Column("cancel_requested", Boolean, nullable=False, server_default="false"),
             Column("created_by", String(64)),
             _now("created_at"), _ts("started_at"), _ts("finished_at"), _now("updated_at"))
Index("ix_jobs_dispatch", jobs.c.queue, jobs.c.status, jobs.c.priority, jobs.c.job_id)
Index("ux_jobs_active_dedupe", jobs.c.dedupe_key, unique=True,
      postgresql_where=jobs.c.status.in_(["queued", "running"]))

workers = Table("workers", metadata,
                Column("worker_id", String(160), primary_key=True),
                Column("queue", String(16), nullable=False),
                Column("info", JSONB, nullable=False, server_default="{}"),  # credential NAMES, harness versions, isolation
                _now("started_at"), _now("last_seen"))

# ---- runs ---------------------------------------------------------------------------------------------------------
runs = Table("runs", metadata,
             Column("run_id", String(64), primary_key=True),
             Column("definition", JSONB, nullable=False),
             Column("dataset_version_id", String(200), nullable=False),
             Column("config_id", Text, nullable=False),
             Column("result_kind", String(32), nullable=False),
             Column("n_tasks", Integer, nullable=False),
             Column("label", Text),
             Column("status", String(16), nullable=False, server_default="created"),
             Column("pause_reason", Text),
             Column("status_history", JSONB, nullable=False, server_default="[]"),
             Column("controls", JSONB, nullable=False, server_default="{}"),
             Column("budget", JSONB, nullable=False, server_default="{}"),
             Column("control_requests", JSONB, nullable=False, server_default="{}"),
             Column("plan", JSONB),
             Column("created_by", String(64)),
             _now("created_at"), _now("updated_at"))

run_attempts = Table("run_attempts", metadata,
                     Column("run_id", String(64), ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False),
                     Column("example_id", String(128), nullable=False),
                     Column("attempt_no", Integer, nullable=False),
                     Column("status", String(32), nullable=False),  # "running" until the record is written
                     Column("outcome_class", String(32)),
                     Column("counts_toward_limit", Boolean),
                     Column("started_at", Text, nullable=False), Column("finished_at", Text),
                     Column("outcome", JSONB), Column("cost", JSONB),
                     Column("worker", String(128)), Column("notes", JSONB, nullable=False, server_default="[]"),
                     PrimaryKeyConstraint("run_id", "example_id", "attempt_no"))

run_finals = Table("run_finals", metadata,
                   Column("run_id", String(64), ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False),
                   Column("example_id", String(128), nullable=False),
                   Column("final", JSONB),  # NULL while superseded by an audited retry pass
                   Column("superseded", JSONB, nullable=False, server_default="[]"),
                   _now("finalized_at"),
                   PrimaryKeyConstraint("run_id", "example_id"))

run_events = Table("run_events", metadata,
                   Column("event_id", BigInteger, primary_key=True, autoincrement=True),
                   Column("run_id", String(64), ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False),
                   Column("seq", BigInteger, nullable=False),
                   _now("at"),
                   Column("type", String(48), nullable=False),
                   Column("data", JSONB, nullable=False, server_default="{}"),
                   UniqueConstraint("run_id", "seq", name="uq_run_events_seq"))

score_reports = Table("score_reports", metadata,
                      Column("score_id", BigInteger, primary_key=True, autoincrement=True),
                      Column("run_id", String(64), ForeignKey("runs.run_id", ondelete="CASCADE")),
                      Column("manifest_id", String(300), nullable=False),
                      Column("dataset_version_id", String(200), nullable=False),
                      Column("scorer_id", String(64), nullable=False),
                      Column("report", JSONB, nullable=False),  # aggregates only; per-item outcomes are private
                      Column("report_digest", String(64), nullable=False),
                      Column("created_by", String(64)),
                      _now("created_at"))

exports = Table("exports", metadata,
                Column("export_id", BigInteger, primary_key=True, autoincrement=True),
                Column("run_id", String(64), ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False),
                Column("path", Text), Column("sha256", String(64)), Column("with_score", Boolean, nullable=False),
                Column("manifest", JSONB), Column("created_by", String(64)), _now("created_at"))

# ---- human review (a separate annotation layer; never modifies gold) ---------------------------------------------
annotations = Table("annotations", metadata,
                    Column("annotation_id", BigInteger, primary_key=True, autoincrement=True),
                    Column("dataset_version_id", String(200), nullable=False),
                    Column("example_id", String(128), nullable=False),
                    Column("reviewer", String(64), nullable=False),
                    Column("phase", String(16), nullable=False),  # blind | post_reveal
                    Column("success", Boolean),
                    Column("mistake_type_native", Text),
                    Column("rationale", Text, nullable=False),
                    Column("evidence_steps", JSONB, nullable=False, server_default="[]"),
                    Column("proposed_correction", JSONB),  # e.g. {"label": ..., "why": ...}; gold is never edited
                    Column("rubric_revision", Text, nullable=False),
                    Column("supersedes", BigInteger),
                    _now("created_at"))
Index("ix_annotations_item", annotations.c.dataset_version_id, annotations.c.example_id)

reveals = Table("reveals", metadata,
                Column("dataset_version_id", String(200), nullable=False),
                Column("example_id", String(128), nullable=False),
                Column("reviewer", String(64), nullable=False),
                _now("revealed_at"),
                PrimaryKeyConstraint("dataset_version_id", "example_id", "reviewer"))

# ---- private ---------------------------------------------------------------------------------------------------
gold_labels = Table("gold_labels", metadata,
                    Column("dataset_version_id", String(200), nullable=False),
                    Column("example_id", String(128), nullable=False),
                    Column("label", String(16), nullable=False),
                    Column("mistake_type_native", Text), Column("category", Text),
                    Column("original_id", Text), Column("paired_id", Text),
                    Column("row", JSONB, nullable=False, server_default="{}"),
                    PrimaryKeyConstraint("dataset_version_id", "example_id"),
                    schema=PRIVATE)

grouping = Table("grouping", metadata,
                 Column("dataset_version_id", String(200), nullable=False),
                 Column("example_id", String(128), nullable=False),
                 Column("component_id", Text), Column("content_component_id", Text),
                 Column("recording_id", Text), Column("instruction_id", Text),
                 Column("row", JSONB, nullable=False, server_default="{}"),
                 PrimaryKeyConstraint("dataset_version_id", "example_id"),
                 schema=PRIVATE)

score_item_outcomes = Table("score_item_outcomes", metadata,
                            Column("score_id", BigInteger, nullable=False),
                            Column("example_id", String(128), nullable=False),
                            Column("outcome", String(64), nullable=False),
                            PrimaryKeyConstraint("score_id", "example_id"),
                            schema=PRIVATE)

PUBLIC_WORKER_WRITE = ("jobs", "runs", "run_attempts", "run_finals", "run_events", "audit_events", "workers")
ROLE_NAMES = ("ah_api", "ah_worker", "ah_scorer")

GRANTS_SQL = """
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ah_api') THEN
    GRANT USAGE ON SCHEMA public TO ah_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ah_api;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ah_api;
    GRANT USAGE ON SCHEMA private TO ah_api;
    GRANT SELECT ON ALL TABLES IN SCHEMA private TO ah_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ah_worker') THEN
    GRANT USAGE ON SCHEMA public TO ah_worker;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ah_worker;
    GRANT INSERT, UPDATE ON jobs, runs, run_attempts, run_finals, run_events, audit_events, workers TO ah_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ah_worker;
    REVOKE ALL ON SCHEMA private FROM ah_worker;
    REVOKE SELECT ON users, api_tokens, sessions, idempotency_keys FROM ah_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ah_scorer') THEN
    GRANT USAGE ON SCHEMA public TO ah_scorer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ah_scorer;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ah_scorer;
    GRANT USAGE ON SCHEMA private TO ah_scorer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA private TO ah_scorer;
    REVOKE SELECT ON api_tokens, sessions FROM ah_scorer;
  END IF;
END $$;
"""

