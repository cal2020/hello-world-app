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

1. `hexisctl update --parent P --trace T --archive protected/ --negative negative/ --out proposals/`
   writes a proposal only.
2. Review `proposal.json`: the diff, `newly_reachable_effects`, gate results, placeholders and affected
   clauses. If the proposal reports **requires_review**, get sign-off from the policy owner.
3. Run `hexisctl admit --package proposals/candidate_package.json --expected-parent <P hash> --archive ...`
   as an `artifact_admin`. On `CONFLICT` another update won the race: re-run `update` against the new
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
