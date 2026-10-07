# Deviations: runtime (wave 3): `50_broker`, `58_service`, `59_metrics`, `68_registry`, `75_env`

Modules: `src/50_broker.js` (`HX.broker`, plus `HX.errors.ToolTimeout`/`ToolFailure`, defined idempotently with the
same shape as `55_fakes`), `src/58_service.js` (`HX.service`), `src/59_metrics.js` (`HX.metrics`),
`src/68_registry.js` (`HX.registry`) and `src/75_env.js` (`HX.env`).

Parity is proven by `golden/gen_runtime.py`, which runs **129 scenario scripts** against the real Python reference
(`build_env` over a temporary directory, `ManualClock(1790000000.25)`, a timer returning `0.125 * n` on its n-th
call, a deterministic uuid source). The JS tests (`test/50_broker.test.js` holds the interpreter; `58_service`,
`68_registry` and `75_env` hold the rest) replay the same scripts and require **deep equality** of every result and
error (status, detail, outcome, checkpoint, interaction, handles, cancellation and admission results, `RunError`
code **and message**, `SimulatedCrash` point, `ConflictError` code) and of every snapshot: the full `inspect_run`
(ids, logical action ids, scope digests, checkpoints, every event including `TIMING`, intents, receipts, evidence),
the digests of all checkpoints, the fake ERP rows/calls/pending faults, the armed fault points, the policy version
and the active/archive pointers.

* 69 named scenarios cover every case in the spec: the happy path, restart while waiting, self-approval and the
  approval authentication rules, `timeout_after_commit` / `timeout_before_commit`, a crash at each of the five
  `FaultInjector` points followed by a restart, non-idempotent timeout → RECONCILING → `resolve_effect` (present,
  absent, retired tool, verifier/validator refused), stale-lease fencing (lease, stale commit, stale authorize,
  stale dispatch leaving the ledger untouched, a worker interleaved inside another's dispatch), cancel racing an
  in-flight write, cancel with an unresolvable effect, cancel of a proven-absent write, revocation reconciling then
  stopping, retry budget exhausted, A10, A20 (policy change, changed args, altered stored digest), A21, A25, A26
  (gullible model; document text; cross-tenant), A28, A29, model unavailable, A32, approval expiry, request dedup,
  the business-unit denial (task and tool arguments), spoofed connector output, terminal freshness re-reads after a
  crash and per-attempt freshness nonces, C14/C15/C18/C19, missing documents on the refined package
  (WAITING_FOR_INPUT, resume, approval), the registry-conflict review path, metrics `collect` + Prometheus (mixed
  runs, run/artifact/tenant filters, hostile label values, priced model), admission (initial, every rejection
  reason, CONFLICT, second environment, staging-only admission, forged lifecycle row, forged/unsigned/unparsable/
  mis-bound records, a validly signed record, `revoke`, `enroll_protected` with an empty archive), and the
  archive gates with real traces (`archive_gates`: run traces exported with `HX.traces.export_run_trace`, enrolled,
  re-enrolled, a refined admission missing its originating trace, dropping enrolled traces, a representable negative
  trace, the successful admission, negative/ineligible/incomplete enrolments), `metrics_float_sums` (priced model
  0.1 per call over three approved runs and a timer at 12345.678 + 0.1 n: Python's compensated `sum()` gives
  `0.6000000000000001`), `metrics_integer_keys` (stored TIMING events with states/models/tools `"9"`, `"10"`),
  `approval_integral_clock` / `approval_default_clock` (integral logical clock, including Python's default
  `ManualClock()` value 1790000000.0: `expires_at` is hashed as the float `1790086400.0`) and
  `response_schema_order` (RESPONSE_INVALID messages with several errors and unsorted extra keys, on both packages;
  responses are carried as JSON text so their key order survives the sorted-key golden file).
* Unit vectors in `runtime.json`: `fsum` (309 float lists vs Python 3.12 `sum()`), `schema_order` (schema/value
  pairs vs `validate_against`, including NUL-key paths and `maxItems`/`maxLength` 0), `utc` / `utc_errors` (`datetime.fromtimestamp` values and its ValueError /
  OSError / OverflowError range errors).
* 60 seeded random scenarios (45 operations each, chosen from the live Python state: runs, approvals by any
  principal, resumes, cancels, faults, crashes at random points, restarts with random models, clock jumps, effect
  class changes, capability revocations, ERP edits, resolutions, metrics). Results and snapshots are compared by
  canonical digest there (`gen_runtime.py --full` writes them in full for debugging).

Everything not listed below matches Python exactly.

## Deviations

| # | Area | Python | JS port | Why | Test |
|---|---|---|---|---|---|
| 1 | Connector schema checks in the broker (`authorize` input, `_accept` output, `resolve_effect` output, `resume_interaction` response, `_prepare_tool`) | python-jsonschema verdicts and messages | Verdict: `HX.catalog.validate_against`; when it accepts a value, the verdict of `HX.kernel._schema_errors` (Python `re` semantics, exact `multipleOf`) is applied as well, so a value Python rejects is never accepted. Order: `HX.broker._py_error_order` re-derives the errors in python-jsonschema's order (schema keyword order, stable sort by path, `additionalProperties: false` extras sorted by code point); it is used only when its errors are exactly HX.jsonschema's as a multiset, otherwise HX.jsonschema's list is kept. Paths are sorted like Python's `list(e.absolute_path)` comparison, element by element with a shorter prefix first (also for keys containing NUL). Messages are HX.jsonschema's, which match Python for the subset the catalog and contracts use (including `maxItems: 0` / `maxLength: 0`: "is expected to be empty"); two messages outside it differ (inherited from `15_jsonschema`): `oneOf` matching several branches ("is valid under each of N schemas" vs Python's list of the schemas) and `patternProperties` with `additionalProperties: false` (Python: "'k' does not match any of the regexes: …"). A message that prints an instance containing a dict with integer-like keys (Python's `repr` of the value, e.g. `RESPONSE_INVALID` "… [{'z': 0, '7': 1}] is not one of …") lists those keys in JS order (`{'7': 1, 'z': 0}`): the project-wide free-form JSON key-order rule (models.md, traces.md #7). Such messages are only thrown in `RunError`, never persisted or digested, and the code and verdict are unchanged. Schema keywords outside the subset fail closed (see kernel.md/models.md) | `HX.jsonschema` alone is looser than Python for `multipleOf` and some regexes and orders errors differently | every scenario (`RESPONSE_INVALID`, `INPUT_SCHEMA`, `OUTPUT_SCHEMA` messages compared exactly), `response_schema_order`, "broker: schema errors in python-jsonschema's order" (`schema_order` includes NUL-key paths and `maxItems`/`maxLength` 0), "documented deviation #1: repr of integer-like keys in messages" |
| 2 | Integral floats in `TIMING` events (`latency_s`, `model_s`, `total_s`, `human_wait_s`, `cost_usd`) | stored as `1.0` | stored as `1` (one number type; DEVIATIONS.md). Values compare equal; only the stored canonical text of those event bodies differs. Nothing digests TIMING events (they are excluded from checkpoints and observations). The same holds for stored timestamps and an interaction's stored `scope`/`expires_at`. The one clock value that *is* digested, the approval scope's `expires_at` (`clock() + approval_expiry_s`), is hashed as a float even when integral (`HX.service._scope_digest`), so scope digests match Python exactly **for float clocks** (the annotated type: `ManualClock(start: float)`, `time.time`, every Python test and golden). A Python clock that returns an `int` (e.g. `ManualClock(1790000000)`, outside the annotation) gives an int `expires_at` hashed as `1790086400`, where JS always hashes `1790086400.0`, so such scope digests differ (self-consistent within either implementation; JS cannot tell `1` from `1.0`) | — | goldens are normalized with `_common.ints`; `approval_integral_clock`, `approval_default_clock` |
| 3 | Prometheus sample formatting | `repr(float)` vs `str(int)` by runtime type | decided by the report field: every latency/seconds value, cost and ratio is a float, counts are ints, and a latency `total` over zero samples is the int `0` (Python's `sum([])`) | JS cannot tell `1.0` from `1` | `metrics_*` scenarios (text compared byte for byte), "metrics: percentile, escape_label …" |
| 4 | `is_admitted_in` parsing of the stored record/report | `json.loads` (accepts `NaN`, duplicate keys, integral floats, big ints) | `HX.canonical.strict_loads`; anything it refuses is "not an admission" (`false`) | conservative; a record the canonical parser refuses cannot be a record `admit` wrote | `admission_forged` |
| 5 | Ids | `uuid.uuid4().hex` (global) | an injected id source (`ids`), shared by a restarted Env. Default: 32 random hex digits from `crypto.getRandomValues` (fallback `Math.random`) | no global uuid module; determinism for tests and the UI | all scenarios use `HX.env.make_seq_ids(1)` |
| 6 | `signing_key()` | reads `os.environ` | reads `HX.registry.environ` (`HEXIS_ADMISSION_KEY`, `HEXIS_ADMISSION_KEY_ID`) | no process environment in the browser | "registry: signing key …" |
| 7 | `admit(pkg)` / `register(pkg)` | take a `MachinePackage` | take a dump and normalize it, so an invalid dump throws `PackageError` (Python's type system guarantees a valid model) | same contract as `HX.validate` | `admission` |
| 8 | Per-thread state (`threading.local` step metrics and broker timing buffers) | per thread | one buffer per object (the engine is synchronous). Nested `advance_run` calls (a step started inside another step's dispatch) behave as in Python | single-threaded JS | `stale_worker_unknown_effect` (C12 interleaving) |
| 9 | Malformed-input crashes inside the service (e.g. a `resume_interaction` response that is not a dict, a missing machine state) | `AttributeError`/`KeyError` | `HX.HXError` with that class name as `code` | convention (README) | — |
| 10 | `collect()` report sections (`by_model`, `by_state`, `by_tool`, `per_run`) | dicts in `sorted()` / insertion order | plain objects with the same entries; JS enumerates integer-like keys (`"9"`, `"10"`) first, in numeric order. Values and `render_prometheus` output are exact: the report carries its Python key order in a non-enumerable symbol property and `render_prometheus` follows it (falling back to code-point order for `by_*` when the report was copied, e.g. through JSON); keys added to a section later come after, like a later dict insertion | one object type; the report stays plain JSON | `metrics_integer_keys` |
| 11 | `sum()` over integer-valued items in TIMING events / metrics | Python ints take an exact int path, floats Neumaier-compensated summation | every item is treated as a float (`HX.metrics.py_fsum`, CPython 3.12 `builtin_sum_impl`'s algorithm). Identical for all-float input (what the engine writes) and for integers whose partial sums stay below 2^53; differs only for a mix of Python ints and non-integral floats where int addition rounds (Python does not compensate int items) | JS cannot tell `1` from `1.0` | "metrics: py_fsum …", `metrics_float_sums` |

## Not deviations (verified equal, listed because they are easy to get wrong)

* `admitted_at` (`datetime.fromtimestamp(now, timezone.utc).isoformat()`): microseconds rounded half-even, and the
  same range errors as Python: `ValueError` "year N is out of range" outside years 1..9999, `OSError` "[Errno 75]
  Value too large for defined data type" when the year overflows `gmtime`'s int, `OverflowError` "timestamp out of
  range for platform time_t" beyond ±2^63 s and for ±infinity, and `ValueError` "Invalid value NaN (not a number)"
  for NaN (`runtime.json` `utc_errors`); a non-number is a `TypeError`.
* `SimulatedCrash` (a `BaseException` in Python) extends `HX.HXError`; no handler in the five modules swallows it:
  every `catch` tests the class and rethrows anything else, and `is_admitted_in`'s catch-all rethrows it explicitly.
  Connector timings record `outcome: "error"` for it, like Python's `finally`.
* The crash/restart model: `Env.restart()` reopens the store (`store.reopen()`: a new Store object over the same
  data) and the ERP exactly like Python's `FakeERP(self.erp.path)` (a new instance over the same rows, with no
  pending faults or recorded calls, for a path-backed ERP; the same object for ":memory:"). Monkeypatches on the old
  objects (C15) therefore do not carry over, as in Python's file-backed tests.
* Every review fix is reproduced and covered: stale-lease handling never overwrites in-flight intents (C12),
  receipts reconciled from records (`_unresolved`, dedup repair of an intent left DISPATCHING), evidence re-issued
  after a crash (C15), per-run evidence ids (C18), terminal freshness re-reads with a fresh nonce per attempt (C07),
  no reopening of terminal runs (C11/C17), business-unit checks on the tool arguments (C09), `resolve_effect` (X01),
  per-environment HMAC-verified admission records (X04/X05), archive-version CAS and per-skill archive versions (X03).

## Notes for golden authors

* **Id source.** `_common.deterministic_uuids()` yields `UUID(int=n)`, whose first 16 hex digits are always zero, so
  every run id is `run_0000000000000000` and the second run of a tenant fails with `sqlite3.IntegrityError` in
  Python (the JS store raises the same `IntegrityError`). The runtime goldens therefore patch `uuid.uuid4` with
  `f"{n:016x}{n:016x}"`, which is `HX.env.make_seq_ids(1)` in JS. `HX.util.make_id_source` is fine for a single run.
* **Key order.** Golden files are written with sorted keys. A package dump that went through them loses its
  machine's state insertion order; its `artifact_hash` is unchanged (canonical), but the validator's finding order,
  and so `report_digest` and admission records, change. Embed packages as JSON text (`refined_json`) or rebuild them.
