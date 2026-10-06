# Wave 2 — `40_kernel`, `45_store`, `47_policy`, `48_approvals` (+ evidence)

Files you own:
* `browser/src/40_kernel.js` (`HX.kernel`), `browser/src/45_store.js` (`HX.store`), `browser/src/47_policy.js` (`HX.policy`) and
  `browser/src/48_approvals.js` (`HX.approvals` and `HX.evidence`)
* `browser/golden/gen_kernel.py`, `gen_store.py`, `gen_policy.py` and their `golden/*.json`
* `browser/test/40_kernel.test.js`, `45_store.test.js`, `47_policy.test.js`, `48_approvals.test.js`
* `browser/deviations/kernel.md`

You build on `HX.canonical`, `HX.jsonschema`, `HX.guards`, `HX.efsm`, `HX.pkg` and `HX.catalog`. For packages
in tests, load the Python-built procurement packages that your generator dumps; do not wait for `HX.compile`.

Python references: `runtime/kernel.py`, `storage/sqlite.py` (the semantics of every public method),
`storage/__init__.py`, `tools/policy.py`, `approvals/scope.py`, `evidence/receipts.py`. Tests:
`tests/unit/test_kernel.py`, `tests/unit/test_review_guards_kernel.py` (kernel parts), and the store, lease, CAS and
evidence behaviors exercised in `tests/recovery/*`, `tests/integration/test_runs.py` and
`tests/integration/test_postgres_store.py` (the backend-contract tests describe the store contract).

## HX.kernel
Port the following:
* `TERMINAL_STATUSES` and `KernelError` (`code`, `message`, `detail`);
* the model shapes as plain objects with all defaults: `Budget`, `Assurance`, `RunCheckpoint`, `Observation`,
  `KernelResult {checkpoint, events, delta, edge}`, with helpers `new_checkpoint(fields)`,
  `new_observation(fields)`, `checkpoint_digest(cp)` and `observation_digest(obs)`;
* `resolve_path`, `initial_checkpoint`, `fill_template`, `validate_declared_outputs`, `select_edge`, `advance`;
* every private helper they need.

Pydantic validation of `RunCheckpoint`/`Observation` (`extra="forbid"`, Literal `kind`/`status`) must be
enforced wherever Python constructs those models from untrusted data.

The kernel must stay pure: no store, no clock, no ids. **Inputs must never be mutated.** Python copies
(`model_copy`, `deepcopy`), so JS must clone too. Prove this with a test that freezes inputs (`Object.freeze`
recursively) before calling `advance`.

## HX.store
`HX.store.Store` is an in-memory implementation with the **same public methods and semantics** as
`storage/sqlite.py::Store`, minus raw SQL (`q1`/`qa`/`tx` are not provided; document this). That means:
* revision CAS in `commit_transition` (ConflictError `REVISION_CONFLICT` / `STALE_LEASE`);
* lease fencing tokens and expiry, and idempotent `create_intent` / `create_interaction`;
* `record_outcome` and receipts sequencing, `record_response` dedupe semantics, and evidence add/invalidate;
* `publish_admission` and `append_archive_manifest` CAS;
* lifecycle, revocation and `is_admitted`, and run status rules including that terminal statuses cannot be
  reopened by `set_run_status`;
* tenant scoping on every query.

Every getter must return **deep copies**, so a caller mutating a result cannot change stored data. Immutable
tables have no update paths. Provide `reopen()`, which returns a new `Store` object over the same underlying
data, to simulate a process restart. Also provide `snapshot()`/`restore(json)`, which serialize the whole
store to and from JSON (the UI uses this to persist a session).

Golden: `gen_store.py` drives the real SQLite `Store` (`:memory:`) with at least 300 seeded random operation
sequences covering every method, including conflicts and edge cases. Record each call's return value or
exception class and code, and normalize SQLite's REAL-to-float effects with `_common.ints`. The JS store must
reproduce them call for call.

## HX.policy, HX.approvals, HX.evidence
Port `Principal`, `Decision`, `PolicyDocument` validation, `PolicyService` (`version`, `digest`,
`authenticate`, `evaluate_dispatch`, `requires_approval`, `can_approve` with the review fixes,
`revoke_capability` with its exact version-suffix scheme), plus `approvals/scope.py` and
`evidence/receipts.py` in full.

Golden: decision tables over every principal, tenant, capability, business unit and role combination; revoke
sequences (with exact `policy_version` strings); scope and digest vectors; and evidence receipt, validity and
scope vectors.

## Kernel golden (gen_kernel.py) — required breadth
* Seeded random walks over the Python-built initial **and** refined procurement packages, at least 1500 steps
  in total, from `initial_checkpoint` with valid and invalid task inputs.
* At each step, build an observation for the current state's kind with randomized outputs. Include valid
  outputs plus missing keys, extra keys (e.g. `approved`), wrong types, bool-for-int, null, schema violations,
  invalid judge labels, field-scope violations on REPAIR_DRAFT, `failure` set, wrong identity (run, state or
  revision), and end-state admissions with valid and invalid evidence, missing outputs and unresolved effects.
* Record either the full `KernelResult`:
  - the checkpoint dump, which must be deep-equal including `assurance.diagnostics`;
  - the events, deep-equal including `observation_digest` and `delta_digest`;
  - the delta and the edge;

  or the `KernelError` code.
* Also record `fill_template`, `resolve_path` and `select_edge` vectors.
* Use only integers and non-integral floats in generated data (`_common.write` enforces this).

## Done when
`node test/run.mjs` passes as a whole and the kernel, store and policy goldens match exactly.
