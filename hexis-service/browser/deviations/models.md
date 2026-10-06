# Deviations: models, clauses, fixture, fakes (wave 1)

Modules: `25_efsm.js` (`HX.efsm`, incl. the pydantic emulation `HX.efsm.pyd`), `26_pkg.js` (`HX.pkg`, `HX.catalog`),
`28_clauses.js` (`HX.clauses`), `34_fixture.js` (`HX.fixture`), `55_fakes.js` (`HX.fakes`, `HX.errors`, `HX.models`).

Everything not listed here matches the Python reference exactly, as proven by `test/25_efsm.test.js`,
`26_pkg.test.js`, `28_clauses.test.js`, `34_fixture.test.js` and `55_fakes.test.js` against the golden files
written by `golden/gen_models.py`, `gen_clauses.py`, `gen_fixture.py` and `gen_fakes.py`. That covers acceptance and
rejection, the pydantic error `type` and `loc` lists, normalized dumps including key order, canonical text, hashes,
HMAC signatures, clause spans, fake connector outputs, ERP transcripts and fixture-model responses.

Every deviation below is conservative: the port rejects where Python accepts, or it fails closed. None of them
make the port more permissive.

## Numbers (JS has one number type)

| Python | JS port | Why | Test |
|---|---|---|---|
| `int` fields accept integers of any size | integers outside ±(2^53−1), given as numbers or numeric strings, are rejected (`int_unsafe`) | larger values cannot be represented exactly | `25_efsm` "documented deviations", coercion golden ("unsafe") |
| `float` fields accept `inf`, `nan`, `"inf"`, `"NaN"`, `"Infinity"` and overflowing strings such as `"1e400"` | rejected (`finite_number`) | non-finite numbers cannot be canonicalized; Python would fail later when hashing | same tests ("nonfinite") |
| pydantic-core also accepts some irregular integer strings: `"0-1"` → -1, `"0__5"` → 5, `"00-1"`, `"+0-1"` | only the grammar `[+-]?d(_?d)*(\.0+)?` is accepted, after the Unicode-whitespace trim that pydantic applies; everything else is `int_parsing` | the irregular forms come from a pydantic-core leading-zero quirk | coercion golden ("quirk": 3,246 inputs; JS never accepts what Python rejects, and accepted values are equal) |
| integral values of `float` fields (`JudgeAction.error_rate` default `0.0`, thresholds, `budgets.max_spend_usd`, `ModelResponse.cost_usd`) are floats and dump as `0.0` | the normalized dump holds the JS number `0` | `1.0 === 1` in JS | `26_pkg` "float-typed fields" |

Hash consequence of the last row: none for the model APIs. `HX.efsm.pyd.canonical_text(type, dump)`, `Model.digest()`,
`HX.pkg.compute_hash`/`sealed`/`verify_hash` and `HX.efsm.machine_digest` serialize from the model schema, so a value
in a float field prints with Python's float repr (`0.0`, `2.0`, `1e+16`). Their output is byte-identical to Python's
`canonical_bytes(model.model_dump(mode="json"))`. This has been checked for judge actions with the default
`error_rate`, for integral thresholds and for integral `max_spend_usd`.

**Plain** `HX.canonical.digest(dump)` of a dump that holds an integral value in a float field does **not** match
Python: it prints `0` where Python prints `0.0`. Use the model-aware digest for `Machine`, `MachinePackage`,
`ExecutionPolicy`, `Budgets`, `DeploymentPolicy` and `ModelResponse`. Every other model has no float fields, so both
digests agree.

`-0` as a number becomes `0` in `int` and `float` fields. This matches `strict_loads`, which reads the JSON text
`-0` as the integer 0. The strings `"-0"` and `"-0.0"` in a float field give `-0.0`, as in Python.

## Dict order and key safety

| Python | JS port | Why | Test |
|---|---|---|---|
| any string key is accepted in `Machine.states`, `ToolAction.binds`, the top-level keys of `ToolAction.input`, `Contracts.{variables, field_scoped_writes, terminals, interactions, clause_coverage, explained_unreachable}`, `SourceManifest.resources`, `SkillSource.resources` and `ToolCatalog.tools` | integer-like keys (`"0"` … `"4294967294"`) are rejected (`dict_key_integer_like`) | JS objects iterate such keys first. That would change validator finding order, BFS order and normalization order, all of which follow Python's insertion order | `25_efsm` / `26_pkg` "documented deviations" |
| free-form JSON (`dict`/`Any` fields, tool arguments, drafts, documents) keeps insertion order | integer-like keys come first | the same JS object rule; it cannot be fixed with plain objects | not order-tested (no hash impact). It only affects the order of `validate_draft` orphan-link issues for integer-like field names and the key order inside `raw_text` |

Representation note (not a behavior change): the typed maps above, and `HX.efsm.var_types()`, are
**null-prototype** objects, so `key in map` and `map[key]` are correct for any key, including `"constructor"`,
`"toString"` and `"__proto__"`. Compare them with `HX.util.deep_equal`, canonical text or
`JSON.parse(JSON.stringify(x))`, not with `assert.deepStrictEqual`. They have no `.hasOwnProperty` method.

## Strings and JSON values

* Strings that contain lone surrogates are rejected (`string_unicode`). Python accepts them in `str` fields but
  cannot hash them.
* `Any` and `dict` field values must be plain JSON (`json_invalid` otherwise): no `undefined`, functions,
  NaN/Infinity or unsafe integers, and nesting depth at most 64. Python accepts arbitrary objects there and fails
  only at canonicalization.

## Validators

* `JudgeAction` with a non-iterable truthy `labels` (`5`, `true`): Python's before-validator raises `TypeError`,
  which escapes pydantic. JS raises `EfsmError` with an error of type `python_type_error`. Both reject.
* Error **messages** follow pydantic's wording but are not identical. Error `type` and `loc` match pydantic, including
  aliases (`question`, `cond`, `schema_`) and discriminated-union tags in `loc`.
* Non-alias dumps (`model_dump()` without `by_alias`, which spells `schema_` and `cond`) are not provided. Python only
  compares such dumps for equality, and the spelling does not change the result.

## Admission signatures

* `verify_admission` with a non-ASCII `signature`: Python's `hmac.compare_digest` raises `TypeError`. JS returns
  `false` (fail closed). Test: `26_pkg` "admission signatures".

## Catalog `check_schemas`

* There is one entry per invalid schema, in tool order, as in Python. The text after `invalid:` differs.
* `HX.jsonschema.check_schema` supports a subset of Draft 2020-12. Schemas that use keywords outside the subset, or
  regex syntax outside the common subset of Python `re` and JS `RegExp` (`u` flag), such as `(?P<n>)`, `\Z` or
  `(?i)`, are reported as invalid even though python-jsonschema accepts them. This is stricter.
* `HX.catalog.metaschema_gaps` adds the metaschema rules that the shared `check_schema` does not enforce, so
  `check_schemas` is never more lenient than Python:
  * empty or duplicate `type` arrays and duplicate `required` entries;
  * `multipleOf > 0` and boolean `uniqueItems`;
  * string `title`, `description`, `$comment`, `format` and `$schema`; `$id` without a fragment;
  * array `examples`; boolean `deprecated`, `readOnly` and `writeOnly`;
  * `patternProperties` must be an object with valid regex keys;
  * JS-only regex syntax (`\p{…}`, `(?<name>`, `\k<…>`, `\u{…}`, variable-width lookbehind).

  Test: `26_pkg` catalog cases, including `stricter-*`.

## models/base.py, tools/errors.py

* `models/base.py` is folded into `HX.fakes`. `ModelRequest`, `ModelResponse` (as `.model_validate` handles),
  `ModelUnavailable` and `output_schema_for` are also exported on `HX.models`.
* `ToolTimeout` and `ToolFailure` live on `HX.errors` and are re-exported on `HX.fakes`. They are defined
  idempotently (`HX.errors.X = HX.errors.X || class …`), so `50_broker` may define or use them first. Their `code`s
  are `TOOL_TIMEOUT`, `TOOL_FAILURE` and `MODEL_UNAVAILABLE`, which Python does not have. `.message` equals Python's
  `str(exc)`.

## Fakes (demo/fakes.py)

* `DEFAULT_REGISTRY` tuple keys `(tenant, ref)` become `"tenant|ref"` strings, split at the first `|`.
  `SupplierRegistry.records` is a `Map` keyed that way. The constructor also accepts `[[tenant, ref], record]`
  entries. A tenant id that contains `|` never matches a record.
* `SupplierRegistry.lookup` returns a **copy** of the stored record, where Python returns the stored dict itself.
  The result is the same, and the copy keeps registry state from aliasing into run variables.
* `FakeERP` is in memory, while Python's is SQLite.
  * A `FakeERP(path)` with `path !== ":memory:"` shares its rows with every other instance opened on the same path in
    this JS realm, like reopening the SQLite file. Faults and calls stay per instance.
  * `erp.reopen()` reproduces `Env.restart`. `FakeERP.reset_storage(path)` forgets the rows (tests).
  * `reconcile_create` returns the first match in SQLite's scan order over the `(tenant_id, idempotency_key)` index,
    i.e. by idempotency key and then by insertion. This was checked against SQLite 3.45 query plans and golden
    transcripts.
  * SQL parameters may be strings, `null`, safe integers or booleans (TEXT affinity). Floats, lists and dicts raise
    `HXError("InterfaceError")`, which is stricter: Python's sqlite3 would store floats as text. The catalog schemas
    and the broker pass strings only.
* Python built-in errors that the fakes raise on malformed input (`KeyError`, `TypeError`, `AttributeError`) are
  `HX.HXError` with that class name as `code`. `KeyError` messages match (`'key'`); the others are approximate.
* `FixtureExtractionModel` REPAIR_DRAFT with a non-dict `draft`: Python's `dict(x)` also accepts a list of pairs.
  JS raises `TypeError`. Only schema-validated dict drafts reach it in the flow.
* `FixtureExtractionModel.generate(request)` validates `request` as a `ModelRequest`, which is what constructing the
  Python request does, and logs the normalized request in `requests`.
* `DocumentStore` documents for a tenant must be a dict of `document_id -> str`.

## Fixture

* `machine_dict()` and `contracts_dict()` return fresh deep copies on every call. In Python, the variable and contract
  dicts are shared with `VARIABLES`. Values are identical.
* `machine_dict` accepts `true`/`false` or `{defect}`.
* `FixtureCompilerModel.settings` is a per-instance object (a shared class attribute in Python).
