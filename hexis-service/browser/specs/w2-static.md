# Wave 2 — static admission: `30_validate`, `32_diff`, `36_compile`

Files you own:
* `browser/src/30_validate.js` (`HX.validate`), `browser/src/32_diff.js` (`HX.diff`) and `browser/src/36_compile.js` (`HX.compile`)
* `browser/golden/gen_validate.py`, `gen_compile.py` and their `golden/*.json`
* `browser/test/30_validate.test.js`, `36_compile.test.js`
* `browser/deviations/static.md`

You build on (already ported, read their APIs): `HX.canonical`, `HX.jsonschema`, `HX.guards` (AST contract in
`specs/PORTING.md`), `HX.efsm`, `HX.pkg`, `HX.catalog`, `HX.clauses`, `HX.fixture`.

Python references: `artifacts/validate.py`, `artifacts/diff.py`, `compiler/compile.py` (fixture-model
path: `compile_skill` with any object having `model_id`, `settings`, `draft()`; port `prompts_digest`
including its LLM-template branch for models exposing `prompt_template_sha256`), `compiler/clauses.py`
usage, `demo/env.py::compile_procurement`. Tests: `tests/conformance/test_static_admission.py`,
`tests/conformance/test_review_admission_validator.py`, `tests/unit/test_llm_compiler.py` (only the
compile-loop behavior: malformed drafts, repair, requirement monotonicity).

## HX.validate
Port everything:
* `Finding`, as `{code, message, severity, state, edge, variable, clause, detail}` plus `to_json()` that drops
  empty fields exactly like Python;
* `ValidationReport`, with `errors()`, `passed`, `codes()`, `to_json()` including `report_digest`;
* `VALIDATOR_VERSION`, `template_vars`, `action_reads`, `action_writes`, `successors`, `reachable`, `check_ordering`;
* `selector_problem`, `policy_widening_findings`, `derived_ordering`, `edge_bound`, `validate_package(pkg, catalog,
  profile, {skill_text, deployment_policy})`;
* every helper they use.

Every check, finding code, severity, location field and analysis entry must match Python, including the review
fixes:
* deployment-policy comparison;
* clause re-indexing from the skill text;
* critical clauses derived from text;
* `HASH_MISSING`;
* `ORDERING_SELECTOR_UNKNOWN`;
* counter init checks;
* approval guard strength and bypass;
* the fallback subgraph;
* the `malformed_requirement` detail tag.

Finding **order** must match Python's. Python iterates dicts in insertion order, so use the same iteration
order. Messages must match Python wherever Python's message is deterministic. Messages that embed a Python
`set` repr are not deterministic across runs, so compare those as sets.

## HX.diff
Port `package_diff(old, new, catalog)` exactly.

## HX.compile
Port `COMPILER_VERSION`, `NORMALIZER_VERSION`, `GUARD_GRAMMAR`, `ACTION_KINDS`, `TERMINAL_CATEGORIES`,
`build_context`, `prompts_digest`, `normalize_machine`, `compile_skill(source, catalog, deployment_policy, model,
max_attempts=3)` (with `CompileResult` `{status, package, report, attempts, coverage, review_required}` and its `to_json()`),
`coverage_markdown`, and the requirement-monotonicity helpers. `source` is `{path, text, resources}`, and
`deployment_policy` is the dump shape from `HX.fixture.deployment_policy()`.
Also add `HX.compile.compile_procurement()`, the equivalent of `demo/env.py::compile_procurement`, using
`HX.data` and `HX.fixture`.

## Parity anchors (all must hold)
* `HX.compile.compile_procurement().package.artifact_hash === HX.data.python_build.initial_artifact_hash`. The
  full hashed payload must deep-equal Python's, and the per-attempt statuses and error codes must match
  (attempt 1 invalid with ORDERING_VIOLATION paths, attempt 2 valid).
* Coverage rows and `review_required` deep-equal Python's.
* Validator golden: (a) every mutation used in the two conformance test files above, re-expressed as data in
  the generator; (b) at least 400 seeded random mutations of the procurement package. These include
  retargeted, added, removed and reordered edges, changed guards, removed or added reads and writes, ownership
  changes, deleted states, terminal and evidence edits, ordering edits, interaction and approval-guard edits,
  policy widening, clause text edits and hash tampering. For each, record the error-code multiset, the ordered
  list of `(code, severity, state, edge, variable, clause)`, the analyses `(analysis, state, status)`, and
  `passed`. Run each with and without `skill_text` and `deployment_policy`.
* Compile golden: the fixture run, plus scripted fake compiler models covering the compile-loop branches
  (malformed draft JSON shapes, repair after diagnostics, requirement dropping or weakening rejected, honest
  malformed-requirement repair accepted, normalization idempotence).

## Done when
`node test/run.mjs` passes as a whole and every parity anchor holds.
