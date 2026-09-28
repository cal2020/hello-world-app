# Operations runbooks

All commands assume `--state <dir>` (SQLite `hexis.db` plus the fake ERP `fake_erp.db`) and fixture mode,
unless `--store` / `HEXIS_STORE_URL` selects another store (see [PostgreSQL](#postgresql)).

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `HEXIS_ADMISSION_KEY`, `HEXIS_ADMISSION_KEY_ID` | HMAC key for admission records | Labeled insecure demo key (records carry `key_id: insecure-demo-key`) |
| `ANTHROPIC_API_KEY` (or an `ant auth` profile) | Credentials for `--model anthropic:<id>` | unset (fixture model) |
| `HEXIS_UPSTREAM_DIR` | Enables upstream conformance tests | unset (tests skip) |
| `HEXIS_STORE_URL` (or global `hexisctl --store URL`) | Store backend: `sqlite:///rel.db`, `sqlite:////abs.db`, a path, or `postgresql://...` | SQLite `hexis.db` in `--state` |
| `HEXIS_TEST_PG_DSN` | Enables the PostgreSQL backend tests (a server where the user may `CREATE DATABASE`) | unset (tests skip) |

Keys are never written to packages, traces, fixtures or manifests (`test_secrets_not_in_artifacts`).

## Run stuck in `WAITING_FOR_APPROVAL` / `WAITING_FOR_INPUT`

This is expected state, not an error (CLI exit 5). Use `hexisctl inspect --run R` to see the open
interaction and its `scope_digest`. The approver then submits `{"approval_decision": ..., "scope_digest": ...}`
via `hexisctl resume`. A response is rejected if the approver lacks the role, belongs to another tenant,
is the initiator (separation of duties), echoes a different digest, or arrives after expiry. An expired
approval ends the run `END_UNVERIFIED` (event `APPROVAL_EXPIRED`); start a new run to retry.

## Run in `RECONCILING`

An external write's outcome is unknown: a timeout after dispatch, or a crash between dispatch and
receipt.
- **Reconcilable writes** (`erp.create_draft`) resolve automatically on the next `advance`: the broker
  looks up the idempotency key or business reference, then either records the found draft
  (`certainty: reconciled`) or, once absence is proven, retries with the **same** key under a fresh
  authorization check.
- **Non-idempotent writes** stay in `RECONCILING` until a human checks the external system. Do **not**
  re-run the action by hand. Record the resolution, then cancel or continue the run.

## Worker crash / restart

Restart with the same `--state`. Leases expire after `lease_ttl` (300 s by default). A new worker id
gets a higher fencing token, and the stale worker's commits and dispatches are rejected
(`STALE_LEASE`). In-flight intents are reconciled rather than re-dispatched.

## Cancellation

`cancel_run` blocks all future dispatch immediately (the broker checks `cancel_requested`), reconciles
any in-flight write and **discloses** completed external effects in the result. If a write cannot be
resolved, the run stays `RECONCILING` and is not reported as safely cancelled.

## Promotion (trace-driven update)

0. Enroll accepted run traces into the stored protected archive first:
   `hexisctl enroll --skill <skill_id> --traces traces/ --state ...` (admin only). A trace must be intact,
   eligible and replay against the active version. The stored archive is the only authority on what
   later admissions must replay; an admission cannot drop an enrolled trace. `--negative` enrolls a
   trace into the negative corpus, and it must NOT be representable.
1. `hexisctl update --parent P --trace T --archive protected/ --negative negative/ --out proposals/`
   writes a proposal only.
2. Review `proposal.json`: the diff, `newly_reachable_effects`, gate results, placeholders and affected
   clauses. If the proposal reports **requires_review**, get sign-off from the policy owner.
3. Run `hexisctl admit --package proposals/candidate_package.json --expected-parent <P hash> --archive ...`
   as an `artifact_admin`. Admission re-validates against the operator deployment policy. It replays every
   stored and supplied protected trace itself, checks the negative corpus, and requires the update's
   originating trace to be in the protected set. On `CONFLICT` another update won the race: re-run `update` against the new
   active parent. That reruns every gate.

## Revocation

`registry.revoke(store, hash, admin, reason, now)` records a `revoked` lifecycle entry. New runs are
refused (`ARTIFACT_REVOKED`). In-flight runs reconcile any unresolved write and then stop as `CANCELLED`
with the diagnostic `ARTIFACT_REVOKED` at their next step. The broker also refuses further writes.

## Upgrades

Package versions are immutable, and runs stay pinned to the artifact hash they started with. A changed
prompt, tool schema, catalog or policy produces a new artifact hash and needs a new admission. There is
no hot migration of in-flight runs. The store schema version is recorded in `schema_migrations` by both
backends (currently version 2; see [PostgreSQL](#postgresql) for the migration runner).

## Evidence disputes

`inspect_run` lists every evidence receipt with subject digests, source action receipt, observation time
and any invalidation reason. A verified outcome claims only its `verification_scope`: here, that the
persisted draft (id, version) matches the approved payload digest. It does not claim the supplier's
commercial facts are true.

## PostgreSQL

Use PostgreSQL (16+) whenever more than one worker process serves runs. `storage/postgres.py::PostgresStore`
has the same method surface and semantics as the SQLite store; only the locking differs: per-run writes lock
the run row (`SELECT ... FOR UPDATE`, plus the lease row), the active pointer row is locked and admissions /
archive enrolments of a skill are serialised by a transaction-scoped advisory lock, with the
`(skill_id, version)` key as the final CAS arbiter. Transactions are short and never span a model call, human
wait or remote tool call. Append-only tables are protected by plpgsql triggers (UPDATE, DELETE and TRUNCATE
raise `... is append-only`).

**Install.** `pip install 'hexis-service[postgres]'` (pins `psycopg[binary]==3.2.10`).

**DSN.** Any libpq URL, e.g. `postgresql://hexis:secret@db.internal:5432/hexis?sslmode=verify-full` or a
Unix socket: `postgresql://hexis@/hexis?host=/var/run/postgresql&port=5432`. Select it per command
(`hexisctl --store postgresql://... run ...`), for every command via `HEXIS_STORE_URL`, or in code with
`storage.open_store(url)` / `demo.env.build_env(..., store_url=url)`. `--state` then only holds the fake ERP
file. Keep credentials in the environment or a `.pgpass`/service file, never in packages or traces.

**Migrations.** Versioned SQL files live in `src/hexis_service/storage/migrations/postgres/`
(`0001_init.sql` = schema version 2, the same schema version the SQLite store records). Each file declares
`-- schema-version: N`. `storage.postgres.migrate(conn)` applies pending files in order, each in one
transaction together with its `schema_migrations(version, name, applied_at)` row, under an advisory lock so
concurrently starting workers do not race; re-running is a no-op. `PostgresStore(dsn)` runs it on connect.
To migrate explicitly (e.g. from a deploy job with a DDL-privileged role):

```bash
python -c "import psycopg, os; from hexis_service.storage.postgres import migrate; \
print(migrate(psycopg.connect(os.environ['HEXIS_STORE_URL'], autocommit=True)))"
```

Workers can then connect with `PostgresStore(dsn, migrate_schema=False)` under a role without DDL rights.

**Test suite on PostgreSQL.** Point `HEXIS_TEST_PG_DSN` at a server where the user may create databases; each
test creates a uniquely named database and drops it afterwards (no other database is touched):

```bash
HEXIS_TEST_PG_DSN='postgresql://hexis@/postgres?host=/var/lib/postgresql/hexis-test&port=55432' \
  PYTHONPATH=src python -m pytest -q tests/integration/test_postgres_store.py tests/recovery/test_postgres_recovery.py
```

`tests/integration/test_postgres_store.py` is the backend contract suite, parametrized over
`[sqlite, postgres]`. `tests/recovery/test_postgres_recovery.py` adds crash injection at every fault point on
both backends, worker processes killed at every fault point, and 4 OS processes (multiprocessing, spawn)
racing on one approved run, with both exclusive leases and a millisecond-TTL "lease storm". In every case
the run completes exactly once, with one ERP draft, no duplicate checkpoints and strictly increasing
revisions. Without `HEXIS_TEST_PG_DSN` the postgres variants are skipped. Tests marked `sqlite_only` use raw
SQLite SQL on the store and run only on the default SQLite fixture.
