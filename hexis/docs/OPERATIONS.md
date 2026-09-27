# Operations runbooks (prototype)

State lives in the `--data` directory: `hexis.sqlite3` (runtime and registry) and `fake_erp.json`
(the simulated remote system). Delete the directory to reset.

## A run is WAITING_FOR_APPROVAL
`hexisctl --data D inspect --run RUN` shows the interaction id; the approval request (arguments digest,
target, evidence, expiry) is in `inspect_run()["approvals"]`. Resume with an authorized approver:
`echo '{"decision":"approved"}' > ok.json && hexisctl --data D resume --run RUN --interaction INT --response ok.json`.
No worker needs to stay alive while waiting.

## A run is RECONCILING
An external write returned an uncertain outcome. `hexisctl --data D continue --run RUN` (or `Runtime.run`) retries
reconciliation: reconcilable writes are looked up by business reference, and resent with the same
idempotency key only if the connector proves absence. Non-idempotent writes stay in RECONCILING:
resolve manually against the target system, then either cancel (`Runtime.cancel_run`, which records
the disclosed effect) or supply a reconciled result through a reviewed operator procedure (not
automated here). Never delete the intent row.

## A worker crashed
Start any worker against the same data directory: `hexisctl --data D continue --run RUN`. The latest checkpoint, the intent
ledger and the receipts determine what happens; in-flight writes are reconciled before any resend.

## Upgrading the machine
1. `hexisctl update --parent CURRENT.json --trace NEW.jsonl --archive PROTECTED_DIR` → proposal file.
2. Review the diff (added edges, loop bounds, newly reachable tools — must be empty without policy review).
3. Admit and promote with the expected parent (`update.admit_update` / `hexisctl admit
   --expected-parent`). A moved parent raises a conflict: rebase and rerun every gate.
In-flight runs stay pinned to their artifact hash; they are never migrated.

## Revoking a version
`Registry.revoke(hash)`. New runs are refused (`NOT_ACTIVE`). In-flight runs stop at their next step
with `ARTIFACT_REVOKED`; a run in RECONCILING still reconciles first so a completed write is disclosed.
Promote a replacement version separately.

## Deleting a protected trace
Record the change in the archive manifest; the replay coverage claim of later admissions shrinks
accordingly. Do not claim all previously accepted traces were checked.

## Live model mode (not exercised)
Construct `AnthropicMessagesAdapter(model_id=...)` explicitly and pass it to `app.build_services`.
The key is read from `ANTHROPIC_API_KEY`; failures raise `ModelUnavailable` and are visible in the
run's observations — they never fall back to fixture output.
