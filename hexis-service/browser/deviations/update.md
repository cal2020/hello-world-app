# Deviations: update, reference, cross-module integration (wave 4)

Modules: `src/66_update.js` (`HX.update`, port of `traces/update.py`) and `src/70_reference.js` (`HX.reference`, port
of `demo/reference.py`).

Parity is proven by `golden/gen_update.py`, which runs the real Python reference, and three test files:

* `test/66_update.test.js` checks the following against `golden/update.json`, `update_apply.json` and `update_propose_1.json`:
  * **Anchor 1.** `propose_update(initial, missing_docs_trace(), [], [], …, FixtureAligner, skill_text)` has the same `to_json()`
    as Python, and its candidate hash equals `HX.data.python_build.refined_artifact_hash`. The whole candidate dump is
    equal too, including the machine's state order.
  * The `propose_update(...).to_json()` grid: 6 traces (the 4 reference traces and the demo's 2 protected run traces) ×
    4 aligners × 2 parents (initial, refined) × 5 archives. The archives are empty; the demo's protected runs; those
    runs plus the missing-documents trace; the shortcut trace as negative; and both.
  * 220 runs with scripted aligners that return random or mutated operation lists, over one or two attempts. They
    cover `op_errors`, construction failures, the restrictive second attempt and gate failures.
  * 385 `_validate_ops` / `apply_ops` vectors. 55 are curated: every operation kind valid and invalid, every
    `_validate_ops` error path, bad and negative indices, positions, unknown states and variables, duplicate states,
    `match`/`ignore` semantics, coverage edits, non-dict operations, non-str keys and non-mapping states and edges.
    330 are random. Each vector records the error list or the Python exception class and message, and the package
    hash, lineage, state order and `policy_widening` of the result. It also records the operation objects after
    `apply_ops`, to check aliasing.
  * 265 `policy_widening` vectors: 260 seeded random mutations of the execution policy and contracts, plus the X10 cases.
  * 70 `evaluate_candidate` gate sets and the demo's step 6b (**anchor 3**: the shortcut is EXCLUDED, and the candidate's
    gates hold the `ORDERING_VIOLATION` counterexample path and `negative_corpus.now_representable`).
  * `archive_manifest` / `manifest_digest`.
* `test/70_reference.test.js` checks **anchor 2**: every reference trace's `to_jsonl()` is byte-identical, its
  records and header digests match, and so do its normalized events. It also checks `TOOL_WRITES`, `REQUEST_INPUT_OPS`
  including Python's key order, the aligners' ids and proposals, and the `ReferenceExecutor` bookkeeping.
* `test/69_integration.test.js` runs 3 scenario scripts (`int_exports`, `int_demo`, `int_admit`, 120 operations)
  through the runtime interpreter of `test/50_broker.test.js`. The setup is `HX.env.build_env`, `ManualClock(1790000000.25)`,
  a timer of `0.125*n` and `HX.env.make_seq_ids(1)`. The interpreter is extended with the update and admission operations,
  and every result, error and snapshot must equal Python's. The scripts cover:
  * `export_run_trace` byte identity for runs that end approved, in registry-conflict review, with repairs exhausted,
    with invalid outputs, with the model unavailable, after a timeout after commit, on the refined package with
    missing documents (supplied, and missed twice), and for a run still waiting, with three verdicts;
  * structural and recorded replay of those exports;
  * `propose_update` over exported traces;
  * `HX.registry.admit` with non-empty archives: a breaking candidate (with and without its originating trace),
    policy widening, a missing originating trace, a dropped enrolled trace, a representable negative trace, a
    manifest mismatch, a lineage parent mismatch, the legitimate refinement, a stale parent (CAS `CONFLICT`) and a
    shortcut candidate. The active and archive pointers are compared after each admission;
  * `HX.registry.enroll_protected` with eligible traces (run exports, re-enrolment) and ineligible ones (shortcut,
    forbidden write, duplicate write, a non-admin), as protected and as negative traces.

During development, a further 10,000 random operation lists from two other seeds agreed exactly: every
`_validate_ops` result (including exception class and message), every `apply_ops` hash, state order and
`policy_widening` result, and every exception class and message other than pydantic's. Everything not listed below
matches Python exactly.

## Deviations

| # | Area | Python | JS port | Why | Test |
|---|---|---|---|---|---|
| 1 | Text of `"candidate construction failed: {exc}"` (an `op_errors` entry of `propose_update`) when `apply_ops` fails pydantic validation | `str(ValidationError)`: pydantic's multi-line rendering ("1 validation error for Machine …") | the `EfsmError` / `PackageError` message | pydantic's error rendering is not ported (same as deviations/static.md #4). The status, the attempt bookkeeping and every other message are exact: `KeyError`, `IndexError`, `TypeError` and `AttributeError` texts are Python's | `66_update` compares such entries up to the prefix (`U.relax`); the apply vectors compare the exception class (`ValidationError`) |
| 2 | Operations that put a non-str key into a typed map (`add_state` with `id: 5` or `true`, `set_coverage` with `clause: 7`, `add_variable` with `name: 1.5`, an interaction for such a state) | the dict holds the int/bool/float key; pydantic refuses it later (`string_type`) | the value is kept in a side table under Python's hash semantics (`1 == True`, so later operations find it by the same key) and never under a JS string spelling of the key. `apply_ops` then raises `ValidationError` (`EfsmError` for the machine, `PackageError` for the contracts) with a synthetic message, where Python reports pydantic's error list | a JS object would turn `true` into the valid state id `"true"`: more permissive than Python. The exception class and the point where it is raised (after the lineage, machine before contracts) are Python's | apply vectors with non-str ids/clauses; "documented deviations" (#2) |
| 3 | `repr()` of an operation dict (at any depth) with two or more keys of which one is integer-like (`{"op": "match", …, "7": 1}`) in an operation error message (`match references unknown state/event: {o}`, `… references unknown state: {o}`, `unknown operation {kind!r}`) | prints the keys in insertion order | `HX.HXError` `KEY_ORDER_UNKNOWN` from `_validate_ops` (and so from `propose_update`) | a JS object enumerates integer-like keys first and cannot give back the insertion order (same rule as deviations/traces.md #7). Messages that do not print such a dict are unaffected | "documented deviations" (#3) |
| 4 | Exceptions inside `apply_ops` in `propose_update` | `except Exception` turns any exception into an `op_errors` entry | only Python-class exceptions (`HX.HXError`, which includes the model errors) become op errors. A native JS error (`RangeError`, `TypeError` from a bug) propagates | such an error is an engine failure, not a property of the candidate. Raising is fail-closed: no proposal, no candidate | "documented deviations" (#4) |
| 5 | Integral float operands (`"position": 1.0`, `"index": 1.0`, `"event_index": 1.0`) | `TypeError` (a float is not an index) | cannot be represented: JSON operations must be parsed with `HX.canonical.strict_loads`, which refuses `1.0`. A JS aligner that returns the number `1` means the int | the general number deviation (DEVIATIONS.md) | non-integral floats (`0.5`) are covered by the apply vectors |
| 6 | Integer-like string names (`"5"`, `"7"`, `"0"`): state ids added by `add_state`, variable names added by `add_variable` (the `Contracts.variables` key), clause ids of `set_coverage`, and `contracts.clause_coverage` keys of a candidate given to `policy_widening` | accepted by `Machine` / `Contracts`: `apply_ops` builds a sealed candidate (e.g. `add_variable` `"7"` gives `sha256:22fd90ad…`), `policy_widening` returns findings | refused by `HX.efsm` / `HX.pkg` (`dict_key_integer_like`): `apply_ops` and `policy_widening` raise (`ValidationError` for a state id, `PackageError` for a contracts key), and `propose_update` turns that into an attempt with `op_errors` "candidate construction failed: …", so `REJECTED` | inherited from deviations/models.md row "any string key is accepted in `Machine.states`, … `Contracts.{variables, …, clause_coverage, …}`" (JS key order) | `66_update` "documented deviation #6: integer-like names are refused" |

## Not deviations (verified equal, listed because JS makes them easy to get wrong)

* **Python semantics of operations.** These all follow Python:
  * `dict.get`, and `[]` with Python's `KeyError` (repr text), `IndexError` (negative indices from the end; "list
    index out of range") and `TypeError` texts;
  * `{**x}` of a non-mapping ("'list' object is not a mapping");
  * the evaluation order of assignments (`a[k] = v` evaluates `v` first, so a missing `contract`/`to`/`coverage`
    raises before the target is looked up);
  * the eagerly evaluated default position of `add_edge` (`len([t for t in trans if t.get("if")])` runs even when
    `position` is given, so a non-dict transition raises `AttributeError`);
  * `list.insert` clamping (negative and out-of-range positions) and `__index__` (`True` is 1, `0.5` and `"1"` raise
    "cannot be interpreted as an integer");
  * hashing for `in`/set membership (`TypeError: unhashable type: 'list'`, `1 == True`);
  * truthiness of `rationale`, `reason`, `interaction`, `trace_ids` and an `add_state` op's `state`;
  * `==` with `1 == True` in matching and in every `policy_widening` comparison;
  * `str()` and `repr()` in messages;
  * lazy evaluation in the `match` compatibility test (`action.get` is reached only for tool, user and terminal
    events).
* **Aliasing.** `apply_ops` deep-copies the parent's machine and contracts but inserts the operations' own objects,
  as Python does. A new state's `transitions` list is the operation's list, so a later `add_edge` from that state
  changes the operation object, and `attempts[].operations` shows the change in both languages. The aligners return
  shallow copies of the `REQUEST_INPUT_OPS` entries (Python's `dict(o)`), so nested objects are shared with the
  module constant, as in Python.
* **`policy_widening`**: dumps are compared with Python `==`, so dict order is ignored, list order is not, and
  `{"minimum": 1} == {"minimum": True}`. Lateral coverage moves count as downgrades, and the "remapped away from
  states" list is sorted by code point.
* **Gate order and shapes**: `policy_non_widening`, `static_validation`, `new_trace_replay`, `protected_replay`,
  `negative_corpus`, then `passed`. The attempt entries have the same key order (`attempt`, `restrictive`,
  `operations`, `op_errors`, `candidate_hash`, `gates`), and the diagnostics fed to the next attempt are Python's.

## API shape (not semantics)

* Packages are MachinePackage dumps, raw or normalized. Every entry point normalizes them (`HX.pkg.normalize_package`),
  so an invalid dump raises `PackageError`, where Python's type system guarantees a model. `apply_ops` returns a
  sealed, normalized dump, and `UpdateProposal.candidate` is that dump or `null`.
* `UpdateProposal(status, parent_hash, trace_id, {candidate, diff, gates, attempts, diagnostics, negative_additions,
  requires_review})` is a class with `to_json()` (and `toJSON()`). Like Python, `to_json()` returns the proposal's
  own objects, not copies.
* The aligner context holds fresh copies of the machine dump, the events and the clauses in every attempt (Python
  dumps them anew per attempt). `dropped` (the very list `normalize` returned), `divergence` and `diagnostics` are
  shared objects, as in Python, so an aligner that mutates `ctx.dropped` in one attempt sees the change in the next
  (`66_update` "aligner context: dropped is shared across attempts like Python").
* `HX.update._validate_ops`, `_hkey` (Python hashing key), `_item` (Python `x[k]`), `_is_validation_error` and
  `_COVERAGE_RANK` are exported for tests and the UI.
* `HX.reference.ReferenceExecutor.ctx` is a plain object (Python's `ToolContext` is a dict subclass), and
  `last` holds the latest output per tool. The aligner classes carry `model_id` both as a static and as an instance
  property.

## Notes for golden authors

* **Ids.** The integration scripts and the demo's protected runs are generated under gen_runtime's `seq_uuids` (the
  n-th id is `f"{n:016x}{n:016x}"`, which is `HX.env.make_seq_ids(1)` in JS), not under `_common.deterministic_uuids()`.
  The latter gives every run the id `run_0000000000000000`, so the demo's second run collides (deviations/runtime.md,
  "Notes for golden authors").
* Operations, mutated contracts and policies are shipped as JSON text, and traces as JSONL. Their key order survives
  the sorted-key golden files, and JS parses them with `strict_loads`. The policy-widening vectors ship only the
  top-level contract entries that changed; the test rebuilds the candidate from the parent's dump.
