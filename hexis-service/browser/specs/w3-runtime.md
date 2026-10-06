# Wave 3 — runtime: `50_broker`, `58_service`, `68_registry`, `75_env` (+ `HX.metrics`)

Files you own:
* `browser/src/50_broker.js` (`HX.broker`: `ToolBroker`, `FaultInjector`, `SimulatedCrash`, `BrokerResult`, `args_digest`)
* `browser/src/58_service.js` (`HX.service`: `RunService`, `RunError`, `RunHandle`, `StepResult`, `CancellationResult`,
  `erp_freshness`, `subject_digest_values`)
* `browser/src/59_metrics.js` (`HX.metrics`: port of `metrics.py` `collect` + JSON/Prometheus renderers)
* `browser/src/68_registry.js` (`HX.registry`: `ADMIN_ROLE`, `signing_key`, `AdmissionResult`, `register`, `admit`,
  `enroll_protected`, `revoke`, `is_admitted_in`)
* `browser/src/75_env.js` (`HX.env`: `ManualClock`, `Env`, `build_env`, `load_catalog`, `load_policy`, `skill_source`,
  `compile_procurement`, `admit_initial`, `TASK`)
* `browser/golden/gen_runtime.py` + `golden/runtime*.json`, `browser/test/50_broker.test.js`, `58_service.test.js`,
  `68_registry.test.js`, `75_env.test.js`, `browser/deviations/runtime.md`

Python references: `tools/broker.py`, `runtime/service.py` (including timing instrumentation and `resolve_effect`),
`metrics.py`, `artifacts/registry.py`, `demo/env.py`. The tests in `tests/integration/test_runs.py`,
`tests/recovery/test_recovery.py`, `tests/recovery/test_review_durability_authority.py`,
`tests/security/test_security.py`, `tests/integration/test_metrics.py` and
`tests/conformance/test_review_admission_validator.py` (admission/enrolment parts) are the behavioral
specification.

Already ported (use, don't edit): canonical, jsonschema, guards, efsm, pkg/catalog, clauses, validate, diff,
compile, fixture, kernel, store, policy, approvals/evidence, fakes. `HX.replay`, `HX.normalize` and `HX.traces` are
being ported **in parallel** by another agent. `registry.admit`'s archive gates and `enroll_protected` call
them, so reference them only inside function bodies. For empty archives, `admit` must not need them, so the
runtime tests can admit without replay.

## Requirements
* The same public API, statuses, codes, events and side effects as Python, including every review fix:
  - stale-lease handling never overwrites in-flight intents;
  - receipts are reconciled from records;
  - evidence is re-issued after a crash;
  - per-run evidence ids;
  - terminal freshness re-reads;
  - no reopening of terminal runs;
  - business-unit checks on the actual write;
  - `resolve_effect`;
  - per-environment admission records verified with HMAC.
* Python's `uuid.uuid4().hex` becomes an injectable id source (`HX.util.make_id_source`), and `time.perf_counter`
  becomes an injectable `timer`. `build_env` accepts `{clock, timer, ids, model, docs, registry, erp, store}` like
  Python. `Env.restart(model)` returns a new Env over `store.reopen()` and the same ERP object (simulating a
  process restart).
* `SimulatedCrash` must propagate out of every API that Python lets it escape from. It extends `HX.HXError`, but
  catch-all handlers in the port must rethrow it, as Python's `BaseException` does.

## Golden transcripts (gen_runtime.py) — the core parity proof
Run each scenario in Python under `_common.deterministic_uuids()`, with `ManualClock(1790000000.25)`. Keep
times non-integral so JSON digests match. Use a fake timer that returns `0.125 * n` on its n-th call. Record a
transcript of every API call and its result:
* the status, detail and outcome, or the `RunError`/`SimulatedCrash` code or point;
* the full `inspect_run` after each step, normalized with `_common.ints`;
* the ERP drafts, the policy version and the active/archive pointers.

The JS test replays the same script with the same id source, clock and timer, and requires **deep equality**:
ids, logical action ids, scope digests, checkpoints, events (including TIMING) and receipts.

Scenarios (at least these):
* the happy path with approval;
* a restart while waiting;
* self-approval refused;
* the approval authentication rules;
* `timeout_after_commit`, `timeout_before_commit`;
* a crash at each `FaultInjector` point followed by a restart;
* non-idempotent timeout leading to RECONCILING, then `resolve_effect`;
* stale-lease fencing;
* cancel racing an in-flight write;
* cancel with an unresolvable effect;
* A10 (repairs exhausted), A20 (policy change after approval, changed args, altered stored digest),
  A21 (revoke before dispatch), A25 (out-of-band modification), A26 (gullible injection; cross-tenant),
  A28 (tamper), A29 (invalid outputs leading to fallback), model unavailable, A32 (revocation), approval expiry,
  request dedup, the business-unit scope denial, spoofed connector output;
* missing documents on the refined package (WAITING_FOR_INPUT, then resume);
* metrics `collect` and the Prometheus output after a mixed set of runs;
* admission: initial `admit`, environment checks, `is_admitted_in` with a forged or missing record, `revoke`;
* `enroll_protected` with an empty archive.

## Done when
`node test/run.mjs` passes as a whole and every transcript matches exactly.
