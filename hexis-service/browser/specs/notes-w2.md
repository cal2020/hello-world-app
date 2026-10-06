# API notes from engine wave 2 (HX.validate, HX.diff, HX.compile, HX.kernel, HX.store, HX.policy, HX.approvals, HX.evidence)

## static

HX.validate
- `validate_package(pkg, catalog, profile = "production", {skill_text, deployment_policy})`:
  - It accepts raw or normalized dumps and normalizes both the pkg and the catalog first, so an invalid dump throws PackageError or CatalogError.
  - `deployment_policy` can be a DeploymentPolicy dump (anything with `execution_policy`) or an ExecutionPolicy dump.
  - It returns a `ValidationReport` instance with `profile`, `artifact_hash`, `findings` (Finding instances, mutable; compile appends to it) and `analyses` (plain objects).
  - `errors()` is a METHOD, unlike Python's property. `passed` is a getter. `codes()` returns a Set. `to_json()` includes `report_digest`, which equals Python's.
  - It is synchronous and takes about 5 ms per call on the procurement package.
- `new HX.validate.Finding(code, message, [severity], [{state, edge, variable, clause, detail}])`. `.to_json()` drops null, {} and "" but keeps `edge: 0`.
- Other exports:
  - `VALIDATOR_VERSION`, `CRITICAL_MARK`, `SELECTOR_KINDS`, `TEMPLATE_RE`, `MAX_SCC_DEPTH` (900).
  - `template_vars` (Set), `action_reads` / `action_writes` (Set), `successors` (null-proto object), `reachable(m, start)` (Set in BFS order).
  - `check_ordering(pkg, req, states?)` returns a path array or null.
  - `selector_problem`, `policy_widening_findings(pkgPolicy, operatorPolicy)` (ExecutionPolicy dumps), `derived_ordering` (OrderingRequirement dumps), `edge_bound`, `_requires_approved`.
  - Python helpers for reuse: `_py_eq` (Python ==), `_repr` (exact Python repr), `_py_str`, `_py_truthy`, `_pyerr(type, msg)` (an HXError with code = Python class name).
- Python errors that escape validation arrive as HXError with code KeyError, TypeError, AttributeError, RecursionError or UnicodeEncodeError, or as HX.guards.GuardError. Admission and registry callers should treat any throw as a rejection, like Python's crash.

HX.diff
- `package_diff(old, new, catalog?)` normalizes both packages. It returns Python's dict shape: states_added, states_removed, actions_changed, edges_changed, variables, contracts_changed, execution_policy_changed, affected_clauses, newly_reachable_effects.
- It throws HXError KeyError when the package's initial state does not exist.

HX.compile
- Constants: `COMPILER_VERSION`, `NORMALIZER_VERSION`, `GUARD_GRAMMAR`, `ACTION_KINDS`, `TERMINAL_CATEGORIES`.
- `build_context(source, clauses, catalog, policy)` and `prompts_digest(context, model)`. A model with a truthy `prompt_template_sha256` also binds `prompt_template`.
- `normalize_machine(m)` returns a normalized machine dump.
- `compile_skill(source, catalog, deployment_policy, model, max_attempts = 3 | {max_attempts})`:
  - `source` is `{path, text, resources}`.
  - `model` is `{model_id, settings, draft(context, diagnostics, attempt)}`, optionally with `prompt_template` and `prompt_template_sha256`.
  - It returns a `CompileResult`: `{status, package, report, attempts, coverage, review_required}` plus `to_json()`.
    - `package` is a MachinePackage dump or null. On "validated" it carries `validation_manifest` with `report_digest`.
    - `report` is a ValidationReport or null.
    - `attempts[i]` holds `attempt`, `status` ("malformed" / "invalid" / "valid" / "normalization_broke_validity"), `findings` (to_json dicts), `draft_hash`, and `diff_from_previous` from the second draft on.
  - It may throw an HXError KeyError exactly where Python crashes: a draft with an unknown initial state after an earlier draft.
- `coverage_markdown(rows)`.
- Monotonicity helpers: `_coverage_regressions`, `_requirements` (plain object whose keys contain ':'), `_at_least_as_strong`, `_malformed_requirements` (Set), `_requirement_regressions`, `_advance_baseline`, `_coverage_table`.
- `skill_source()` returns `{path: HX.data.skill_path, text: HX.data.skill_md, resources: {}}`.
- `compile_procurement(catalog?)` is the demo/env.py equivalent. It takes about 60 ms and its package hash equals `HX.data.python_build.initial_artifact_hash`.

Golden and tests
- `gen_compile.py` imports `apply_ops` from `gen_validate.py`; both run under `gen_all.py`.
- Golden JSON is written with sorted keys, so the tests compare key order through canonical text and digests, not through deepEqual.

Shared files
- I edited no shared files and ran no git commands.

## kernel

- HX.kernel._schema_errors(schema, value) now returns python-jsonschema's verdict, including Python regex semantics and exact multipleOf. Error messages show the schema's original regexes, not their translations. The texts still differ from Python's.
- HX.kernel._py_regex_to_js(p) returns JS source for new RegExp(src, 'u') with the meaning of Python re.search, or null when p is outside the subset.
- HX.kernel._py_re_search(p, s) returns a boolean, or throws HX.HXError UNSUPPORTED_PATTERN.
- HX.kernel._PY_RE_TABLES holds the CPython \d, \s and \w code point ranges as comma-separated hex. Any module that needs Python regex parity, such as 15_jsonschema or the catalog tool checks, can use these.
- New JS-only error code: HX.HXError 'KEY_ORDER_UNKNOWN'. advance raises it when engine.terminal_admission.receipts, missing or unresolved_effects is a dict with 2 or more keys including an integer-like key. The UI should treat it like the other built-in errors (a failed step).
- validate_declared_outputs can now raise HX.HXError 'IndexError' for a judge action with empty writes. Only a package modified after validation can reach this.
- New golden file golden/kernel_regex.json (~0.96 MB), written by gen_kernel.py.

