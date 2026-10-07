# Deviations: static admission (wave 2): `30_validate`, `32_diff`, `36_compile`

Modules: `src/30_validate.js` (`HX.validate`, port of `artifacts/validate.py`), `src/32_diff.js` (`HX.diff`, port of
`artifacts/diff.py`) and `src/36_compile.js` (`HX.compile`, port of `compiler/compile.py` plus
`demo/env.py::skill_source` and `compile_procurement`).

Parity is proven by `test/30_validate.test.js` and `test/36_compile.test.js` against `golden/validate_conformance.json`,
`validate_random_a.json`, `validate_random_b.json` (from `golden/gen_validate.py`) and `golden/compile.json` (from
`golden/gen_compile.py`). These cover the mutations of `tests/conformance/test_static_admission.py` and
`test_review_admission_validator.py` re-expressed as data, 460 seeded random mutations of the procurement package
(each validated with and without `skill_text` and `deployment_policy`, some under the `sandbox` profile, plus
`package_diff` in both directions), helper-function vectors, the fixture compile run and 35 scripted compiler models.
Every finding's code, severity, location fields, detail and message, every analysis entry, `passed` and
`report_digest` are compared. During development, a further 1,200 random mutations from three other seeds agreed as
well.

Everything not listed here matches Python exactly. The deviations below are conservative or are differences in
message text only.

| # | Area | Python | JS port | Why | Test |
|---|---|---|---|---|---|
| 1 | Order of findings that Python emits while iterating a `set`: `DUPLICATE_VARIABLE`, `DUPLICATE_TERMINAL`, `WRITE_OWNERSHIP` (one state's writes) and `NO_ROUTE_TO_STOP` | arbitrary order that changes with the process's string hash seed (`PYTHONHASHSEED`) | first-occurrence order (variable/terminal declaration order, the action's `writes` order, reachability BFS order) | Python has no fixed order, so the port picks a stable one. The set of findings is the same. Because the order is part of `to_json()`, two Python processes can disagree on `report_digest` here as well. | `30_validate` "conformance…" / "seeded random…": runs of these codes are compared as sets, and `report_digest` is compared for every run whose findings are identical to Python's: 1,397 of the 1,405 runs. The other 8 differ only in such an order or in a message from #3. |
| 2 | Recursion depth of the strongly-connected-component search (loop analysis) | recursive Tarjan, which raises `RecursionError` at about 996 nested states minus the caller's stack depth (measured: a 991-state chain still validates from a top-level call) | `HXError` with code `RecursionError` once the search is more than `HX.validate.MAX_SCC_DEPTH` (900) states deep | Python's limit depends on the caller's stack, so the port refuses earlier at a fixed depth. Admission fails closed in both cases. | golden cases `chain-500` (both validate), `chain-950` (Python validates, JS raises: `js_deviation`) and `chain-1100` (both raise). |
| 3 | `GUARD_INVALID` messages for guards with a **syntax error**, and `CATALOG_SCHEMA` messages | CPython's parser text and python-jsonschema's text | approximated (see `deviations/guards.md` "Messages" and `deviations/models.md` "Catalog check_schemas") | inherited from `HX.guards` and `HX.catalog` | the tests compare these messages only up to `guard syntax error` and up to ` invalid: `. Every other field is compared, and `report_digest` is not compared for such runs. |
| 4 | `compile_skill`: the `DRAFT_SCHEMA` diagnostic of a draft that pydantic rejects | `str(ValidationError)[:2000]` ("1 validation error for Machine …") | `EfsmError` / `PackageError` message text | pydantic's error rendering is not ported. The code, the attempt status and the control flow are identical. `DRAFT_SCHEMA` messages that come from other exceptions are exact: `KeyError` (`'machine'`), the `TypeError`s of subscripting a non-dict draft (`list indices must be integers or slices, not str`, `'NoneType' object is not subscriptable`, …) and `load_machine`'s `not an efsm-v1 machine (format=None)`. | `36_compile` "scripted compiler models…" (`raw-shapes`, `malformed-then-valid`) |
| 5 | Integral float values in a disjointness `counterexample` | `{"x": 2.0}` prints as `2.0` in `report_digest` | prints as `2` | the general number deviation (`DEVIATIONS.md`). None of the 1,405 golden runs has one. | the generator marks such runs `float_ints` and skips their digest comparison. |
| 6 | `COUNTER_INIT` (and any other check of an `Any`-typed value that tells `int` from an integral `float`, e.g. `Variable.init`) | `init: 0.0` is a float, so a loop counter initialised to `0.0` fails `COUNTER_INIT` | a JS number cannot carry the difference: `JSON.parse("0.0")` is `0`, so a dump built with plain `JSON.parse` (a hand-built dump, a future live-compiler draft) **passes** where Python fails | the general number deviation (`DEVIATIONS.md`). Parity therefore **relies on every package and draft being parsed with `HX.canonical.strict_loads`**, which refuses the literal `0.0` (`CanonicalError`); a package that Python sealed with `init: 0.0` fails `HASH_MISMATCH` in JS (its canonical text differs). Callers must not feed `JSON.parse` output to the validator. | `30_validate` "documented deviation #6: integral-float counter init relies on strict_loads" |

## Not deviations (verified equal, listed because JS makes them easy to get wrong)

* **Finding order** follows Python's dict insertion order everywhere else, including for states that were reordered
  (golden `states-reordered` and the random `order` operation). Python `set`s that are sorted before use are sorted
  by code point.
* **Messages** reproduce Python's f-strings exactly: `{x!r}` uses Python's `repr` (exact `str` repr from
  `HX.guards._py_repr_str`), while `{x}` uses `str()`. For example, a string `enum` prints unquoted in
  `JUDGE_LABELS_SCHEMA`, `critical=True`/`False` prints as a Python bool, and `max_spend_usd` prints as a Python float
  (`100.0`, `None`).
* **Python errors that escape `validate_package`** are reproduced with the same class, as `HXError` codes:
  `KeyError` (an approval edge guard that reads an undeclared variable, or `check_ordering` from a missing state),
  `TypeError` (an unhashable or non-iterable `enum`, task `required` or catalog `required`), `AttributeError` (a
  non-dict truthy catalog `output_schema.properties`), `UnicodeEncodeError` (a `skill_text` with a lone surrogate, at
  the point where Python hashes it) and `HX.guards.GuardError` (`edge_bound` on an invalid guard of a counter edge
  inside a cycle, golden `loop-edge-invalid-guard`). `package_diff` raises `KeyError` for a package whose initial
  state does not exist, and so `compile_skill` raises it when such a draft follows an earlier draft (golden
  `unknown-initial-after-draft`, `unknown-initial-first`).
* **Python truthiness and equality** are reproduced where the reference relies on them: `enum or []`,
  `properties or {}`, `t.inc` (an empty string is no counter), `1 == 1.0 == True` in `package_diff` and in the
  requirement-monotonicity comparisons (`response_schema`), and slicing `skill_text[c.start:c.end]` by code point
  with Python's handling of negative and out-of-range bounds.
* **`compile_skill`** reproduces the malformed-draft branch (`str(code or "DRAFT_MALFORMED")`, `str(message)[:2000]`
  by code point, `detail` only when it is a dict), the diagnostics fed to each attempt, the coverage and requirement
  baselines, `diff_from_previous`, `normalize_machine`, the validation manifest, the coverage table and
  `review_required`. `compile_procurement().package` is byte-identical to Python's package (same `artifact_hash`
  `HX.data.python_build.initial_artifact_hash`, same dump, same state order).

## API shape (not semantics)

* `validate_package(pkg, catalog, profile = "production", {skill_text, deployment_policy})` accepts raw or
  normalized dumps and normalizes them first, so an invalid dump raises `PackageError`/`CatalogError` (Python takes
  already-validated models). `deployment_policy` may be a DeploymentPolicy dump (anything with `execution_policy`) or an
  ExecutionPolicy dump, as with Python's `getattr(dp, "execution_policy", dp)`.
* `ValidationReport.errors()` is a method (a property in Python). `passed` is a getter. `codes()` returns a `Set` in
  insertion order (Python: an unordered `set`).
* `reachable()` returns a `Set` in BFS order, `successors()` a null-prototype object, and `derived_ordering()`
  OrderingRequirement dumps.
* `new Finding(code, message, [severity], [{severity, state, edge, variable, clause, detail}])` mirrors the Python
  dataclass with keyword arguments.
* `compile_skill(source, catalog, deployment_policy, model, max_attempts = 3)`: `max_attempts` may also be passed as
  `{max_attempts}`. `CompileResult.package` is a normalized MachinePackage dump or `null`. `report` is a
  `ValidationReport` or `null`.
