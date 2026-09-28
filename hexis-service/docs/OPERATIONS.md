# Operations runbooks

All commands assume `--state <dir>` (SQLite `hexis.db` plus the fake ERP `fake_erp.db`) and fixture mode.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `HEXIS_ADMISSION_KEY`, `HEXIS_ADMISSION_KEY_ID` | HMAC key for admission records | Labeled insecure demo key (records carry `key_id: insecure-demo-key`) |
| `ANTHROPIC_API_KEY` (or an `ant auth` profile) | Credentials for `--model anthropic:<id>` | unset (fixture model) |
| `HEXIS_UPSTREAM_DIR` | Enables upstream conformance tests | unset (tests skip) |

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
no hot migration of in-flight runs. The store schema version is recorded in `schema_migrations`; no
migrations beyond version 1 exist yet.

## Evidence disputes

`inspect_run` lists every evidence receipt with subject digests, source action receipt, observation time
and any invalidation reason. A verified outcome claims only its `verification_scope`: here, that the
persisted draft (id, version) matches the approved payload digest. It does not claim the supplier's
commercial facts are true.

## Metrics

Every `advance_run` step that acquires the run lease appends one `TIMING` run event (schema
`hexis-timing/1`) **after** its commit. Timing is observability data only: it is never part of an
observation, a checkpoint or a trace, so recorded replay and checkpoint digests do not depend on it.
Two clocks are kept apart:

- `timer` (monotonic, default `time.perf_counter`, injectable through `RunService`, `ToolBroker` and
  `build_env(timer=...)`) measures latency.
- `clock` (logical time) still drives expiry, leases and **human wait** (interaction opened -> answered,
  from the stored `created_at` of the interaction and the response).

Per step the event records: `state`, `revision`, `kind`, `status`; `model_s` (every model attempt,
including output repairs and transport retries, with `model_id`, tokens, `cost_usd` and outcome
`accepted|rejected|unavailable`); `tool_s` (every connector or reconciler call, `op`
`dispatch|redispatch|reconcile`, attempt, outcome `ok|timeout|failure|error`, including the terminal
freshness read); `engine_s` = total step time minus model and tool time (prepare, `kernel.advance`, commit
and bookkeeping); `human_wait_s` (on the step that consumes the answer, or on expiry);
`retries`; `validation_failures` (`MODEL_OUTPUT_REJECTED`, `OBSERVATION_REJECTED`); `fallback`; and the
uncertain effects raised and resolved in the step. A step that raises (lease lost, simulated crash) writes
no `TIMING` event; a crash between the commit and the append loses only that step's timing.

`hexisctl metrics [--run RUN_ID] [--artifact HASH] [--format json|prometheus] --state DIR --as PRINCIPAL`
aggregates the events of **the principal's tenant only** (a run id of another tenant is `NOT_FOUND`,
exit 2) into:

- `by_model`, `by_state`, `by_tool`: count; latency p50/p95/max/total (nearest rank); tokens; `cost_usd`;
  retries; validation failures; fallback visits, entries and frequency; uncertain effects
  raised/resolved/outstanding. `by_state` also has the human-wait distribution and the engine/model/tool
  split. Uncertain effects come from the action ledger (`EFFECT_UNKNOWN` / `RECONCILIATION_REQUIRED`
  events, then intent and receipt status), so a human resolution (`RunService.resolve_effect`) counts as resolved.
- `per_run`: `engine_s`, `model_s`, `tool_s`, `human_wait_s`, steps, tokens, cost; plus `totals`.

**Cost.** `cost_usd` is `null` whenever any contributing call did not report a cost (the fixture model
and every connector call). It is never reported as 0. In Prometheus output an unknown cost is omitted and
`hexis_<dim>_cost_known` is `0`.

**Prometheus.** `--format prometheus` prints the text exposition format (`# HELP`/`# TYPE` before each
family, escaped label values): `hexis_{model,state,tool}_latency_seconds` (summary with `quantile`
0.5/0.95, `_sum`, `_count`), `..._calls_total`, `..._tokens_total{direction}`, `..._retries_total`,
`..._validation_failures_total`, `..._fallback_ratio`, `..._uncertain_effects{phase}`,
`hexis_state_human_wait_seconds_total`, `hexis_run_seconds{run,component}` and
`hexis_seconds_total{component}`. It is a snapshot to scrape through a file or sidecar; there is no HTTP
endpoint. Per-run series have unbounded cardinality, so filter with `--run` or `--artifact` on large stores.
