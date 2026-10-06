# Deviations: models, clauses, fixture, fakes (wave 1)

Modules: `25_efsm.js` (`HX.efsm`, incl. the pydantic emulation `HX.efsm.pyd`), `26_pkg.js` (`HX.pkg`, `HX.catalog`),
`28_clauses.js` (`HX.clauses`), `34_fixture.js` (`HX.fixture`), `55_fakes.js` (`HX.fakes`, `HX.errors`, `HX.models`).

Everything not listed here matches the Python reference exactly, as proven by `test/25_efsm.test.js`,
`26_pkg.test.js`, `28_clauses.test.js`, `34_fixture.test.js` and `55_fakes.test.js` against the golden files
written by `golden/gen_models.py`, `gen_clauses.py`, `gen_fixture.py` and `gen_fakes.py`. That covers acceptance and
rejection, the pydantic error `type` and `loc` entries (compared as sets, see "Error order"), normalized dumps
including key order, canonical text, hashes, HMAC signatures, clause spans, fake connector outputs, exception class
names, ERP transcripts and fixture-model responses.

Every deviation below is conservative: the port rejects where Python accepts, or it fails closed. None of them
make the port more permissive.

## Numbers (JS has one number type)

| Python | JS port | Why | Test |
|---|---|---|---|
| `int` fields accept integers of any size | integers outside ±(2^53−1), given as numbers or numeric strings, are rejected (`int_unsafe`) | larger values cannot be represented exactly | `25_efsm` "documented deviations", coercion golden ("unsafe") |
| `float` fields accept `inf`, `nan`, `"inf"`, `"NaN"`, `"Infinity"` and overflowing strings such as `"1e400"` | rejected (`finite_number`) | non-finite numbers cannot be canonicalized; Python would fail later when hashing | same tests ("nonfinite") |
| pydantic-core also accepts some irregular integer strings: `"0-1"` → -1, `"0__5"` → 5, `"00-1"`, `"+0-1"` | only the grammar `[+-]?d(_?d)*(\.0+)?` is accepted, after the Unicode-whitespace trim that pydantic applies; everything else is `int_parsing` | the irregular forms come from a pydantic-core leading-zero quirk | coercion golden ("quirk": 3,246 inputs; JS never accepts what Python rejects, and accepted values are equal) |
| integral values of `float` fields (`JudgeAction.error_rate` default `0.0`, thresholds, `budgets.max_spend_usd`, `ModelResponse.cost_usd`) are floats and dump as `0.0` (`1e16` as `1e+16`) | the normalized dump holds the JS number `0` (`10000000000000000`) | `1.0 === 1` in JS | `26_pkg` "float-typed fields", "float fields beyond 2^53" |

Hash consequence of the last row: none for the model APIs. `HX.efsm.pyd.canonical_text(type, dump)`, `Model.digest()` /
`Model.canonical_text()`, `HX.pkg.compute_hash`/`sealed`/`verify_hash`, `HX.efsm.machine_digest` and
`HX.fakes.ModelResponse.digest()` serialize from the model schema, so a value in a float field prints with Python's float
repr (`0.0`, `2.0`, `1e+16`, `9007199254740992.0`). Their output is byte-identical to Python's
`canonical_bytes(model.model_dump(mode="json", by_alias=True))`: the **by-alias** dump (`if`, `schema`), which is what
Python hashes (`Machine.to_json()`, `MachinePackage.hash_payload()`); Python never hashes the non-alias dump
(`cond`, `schema_`). For models without aliases both dumps are the same. Integral float values beyond 2^53 are fine
there (the typed check only requires a finite number in a float field), so `max_spend_usd: "1e16"` normalizes, hashes
and verifies like Python. Tests: `26_pkg` "float-typed fields" (judge `error_rate` default, integral thresholds and
`max_spend_usd`) and "float fields beyond 2^53" (`1e16`, `2^53+1`, `-1e20`, `1e300`, thresholds `1e17`/`2e53`, judge
`error_rate` `1e22`, `Budgets`/`ExecutionPolicy`/`ModelResponse` digests).

**Plain** `HX.canonical.digest(dump)` of a dump that holds an integral value in a float field does **not** match
Python: it prints `0` where Python prints `0.0`, and it throws `CanonicalError` for values beyond 2^53. Use the
model-aware digest for `Machine`, `MachinePackage`, `ExecutionPolicy`, `Budgets`, `DeploymentPolicy` and
`ModelResponse`. Every other model has no float fields, so both digests agree.

`-0` as a number becomes `0` in `int` and `float` fields. This matches `strict_loads`, which reads the JSON text
`-0` as the integer 0. The strings `"-0"` and `"-0.0"` in a float field give `-0.0`, as in Python.

Error types follow the JS number that arrives: a `bool` field answers `bool_parsing` for integers inside the int64
range and `bool_type` outside it and for huge floats, like pydantic; but an integer JS cannot hold exactly is judged by
its rounded value (`-2^63-1` arrives as `-2^63`, so `bool_parsing` where pydantic says `bool_type`). `strict_loads`
refuses such integers in the first place. Test: `25_efsm` coercions (golden `bool_big`).

## Dict order and key safety

| Python | JS port | Why | Test |
|---|---|---|---|
| any string key is accepted in `Machine.states`, `ToolAction.binds`, the top-level keys of `ToolAction.input`, `Contracts.{variables, field_scoped_writes, terminals, interactions, clause_coverage, explained_unreachable}`, `SourceManifest.resources`, `SkillSource.resources` and `ToolCatalog.tools` | integer-like keys (`"0"` … `"4294967294"`) are rejected (`dict_key_integer_like`) | JS objects iterate such keys first. That would change validator finding order, BFS order and normalization order, all of which follow Python's insertion order | `25_efsm` / `26_pkg` "documented deviations" |
| free-form JSON (`dict`/`Any` fields, tool arguments, drafts, documents) keeps insertion order | integer-like keys come first | the same JS object rule; it cannot be fixed with plain objects | not order-tested (no hash impact). It only affects the order of `validate_draft` orphan-link issues for integer-like field names and the key order inside `raw_text` |
| `Machine.var_types()` iterates in variable order | `HX.efsm.var_types()` iterates integer-like variable names (`"0"`, `"17"`) first | the same JS object rule | the Python code only looks names up in it (`types[k]`, an evaluation env); iterate `machine.variables` where order matters |

Representation note (not a behavior change): the typed maps above, and `HX.efsm.var_types()`, are
**null-prototype** objects, so `key in map` and `map[key]` are correct for any key, including `"constructor"`,
`"toString"` and `"__proto__"`. Compare them with `HX.util.deep_equal`, canonical text or
`JSON.parse(JSON.stringify(x))`, not with `assert.deepStrictEqual`. They have no `.hasOwnProperty` method.

## Strings and JSON values

* Lone surrogates, where pydantic rejects them, give pydantic's errors exactly: a string with a lone surrogate in an
  `int`, `float`, `bool` or `Literal` field is `string_unicode` at that field, and one input **key** with a lone
  surrogate fails the whole model with a single `string_unicode` at the model's `loc` (after a `before` validator, no
  other error for that model). Test: `25_efsm` "lone surrogates" (golden `models_efsm.json` `surrogates`).
* Where Python **accepts** lone surrogates, the port rejects them (stricter): in `str` fields and `dict[str, X]` keys
  (`string_unicode`) and inside `dict`/`Any` values (`json_invalid`). Python cannot hash such models (its JSON dump
  raises `UnicodeEncodeError`). When the input has other errors too, the port reports these errors in addition to
  pydantic's (same test).
* `Any` and `dict` field values must be plain JSON (`json_invalid` otherwise): no `undefined`, functions,
  NaN/Infinity or unsafe integers, and nesting depth at most 64. Python accepts arbitrary objects there and fails
  only at canonicalization.

## Validators

* `JudgeAction` with a non-iterable truthy `labels` (`5`, `true`): Python's before-validator raises `TypeError`,
  which escapes pydantic. JS raises `EfsmError` with an error of type `python_type_error`. Both reject.
* Error **messages** follow pydantic's wording but are not identical. Error `type` and `loc` match pydantic, including
  aliases (`question`, `cond`, `schema_`) and discriminated-union tags in `loc`.
* When an input hits a documented deviation (a value Python accepts: non-JSON `Any`/`dict` data, a lone surrogate in a
  `str` field or map key, an integer-like key of a typed map, an integer beyond 2^53, a non-finite float), the port
  reports the deviation's error (`json_invalid`, `string_unicode`, `dict_key_integer_like`, `int_unsafe`,
  `finite_number`) **in addition to** every pydantic error: such a value still takes part in validating its container,
  so the map value is still validated and the model validators pydantic runs still run (e.g. `Variable` with a
  non-JSON `init` and an `init_from` reports `json_invalid` and pydantic's `value_error`). The error list is a superset
  of pydantic's. One exception: pydantic's irregular integer strings (`"0-1"`, see Numbers) are a plain `int_parsing`,
  so a model validator of the same model does not run. Test: `25_efsm` "values rejected only by a documented
  deviation" (golden `soft`).
* Error **order**: the same entries, but when an input dict has integer-like keys (`"7"`), JS objects iterate them
  first, so their errors come first (e.g. `ExecutionPolicy.budgets {"1e3": 1, "7": 2}`: Python lists
  `extra_forbidden @ budgets.1e3` then `budgets.7`, JS the reverse). The original key order is gone once the input is
  a JS object, so this cannot be fixed. Tests compare error lists as sorted sets.
* Non-alias dumps (`model_dump()` without `by_alias`, which spells `schema_` and `cond`) are not provided. Python only
  compares such dumps for equality, and the spelling does not change the result.

## Admission signatures

* `verify_admission` with a non-ASCII `signature`: Python's `hmac.compare_digest` raises `TypeError`. JS returns
  `false` (fail closed). Test: `26_pkg` "admission signatures".

## Catalog `check_schemas`

* There is one entry per invalid schema, in tool order, as in Python. The text after `invalid:` differs.
* `HX.jsonschema.check_schema` supports a subset of Draft 2020-12. Schemas that use keywords outside the subset are
  reported as invalid even though python-jsonschema accepts them. This is stricter.
* `HX.catalog.metaschema_gaps` adds the metaschema rules that the shared `check_schema` does not enforce, so
  `check_schemas` is never more lenient than Python:
  * empty or duplicate `type` arrays and duplicate `required` entries;
  * `multipleOf > 0` and boolean `uniqueItems`;
  * string `title`, `description`, `$comment`, `format` and `$schema`;
  * `$id` matching the metaschema pattern `^[^#]*#?$` under `re.search`, where `$` also matches before a final `\n`
    (`"abc#\n"` is valid, as in Python);
  * array `examples`; boolean `deprecated`, `readOnly` and `writeOnly`;
  * `patternProperties` must be an object; its keys and every `pattern` must be valid Python regexes.
* **Regexes** (`format: "regex"` in the metaschema, which python-jsonschema checks with `re.compile`):
  `HX.catalog.py_regex_check(p)` is a port of CPython 3.12's `re/_parser.py` `parse()` plus the checks
  `re/_compiler.py` makes on the parsed tree (fixed-width look-behind, "looks too much behind", template flag) and
  `fix_flags`. It returns `null` or `{kind, message}`, where `kind` is the Python exception class (`error` for
  `re.error`, `OverflowError` for repeat bounds >= 4294967295 or `\U` values above 2^31-1, `ValueError` for digit
  strings beyond 4300 digits or `(?a)(?u)`). It reproduces empty classes (`[]`, `[^]`), `\c` escapes, references to
  undefined or still-open groups, references inside a look-behind to its own groups, variable look-behind widths
  (also through groups, alternations, repeats, conditionals and references), repeat-bound overflow, flags, verbose
  mode, conditionals, atomic groups and possessive repeats. A schema regex is accepted only if this check passes
  **and** the JS engine compiles it with the `u` flag (the port validates values with that dialect), so JS never
  accepts a regex Python rejects. Stricter than Python (documented, rejected by the port):
  * `\N{NAME}` escapes (no Unicode name database in the port; JS `u` regexes refuse `\N` anyway);
  * group names outside ASCII identifiers (Python: any `str.isidentifier()`; JS refuses `(?P<…>)` anyway);
  * groups nested deeper than `HX.catalog.PY_RE_MAX_NESTING` (100) levels. Python raises `RecursionError` at about
    489 levels minus the caller's stack depth (about 8 frames per enclosing schema level: 87 levels for a pattern 63
    schema levels deep under a 300-frame caller), so the port refuses deep nesting early instead of emulating a
    context-dependent limit;
  * regexes Python accepts that JS cannot compile with the `u` flag, such as `(?P<n>x)`, `\Z`, `(?i)`, `\_`, `{,2}`,
    possessive `a*+` or `[[:digit:]]`.

  Tests: `26_pkg` "Python re acceptance" (12,157 patterns: `kind` equals CPython's for every pattern outside the
  stricter classes), "check_schemas is never more lenient" (every pattern as `pattern` and as a `patternProperties`
  key), "random Draft 2020-12 schemas" (2,400 schemas with Python's verdicts) and the catalog cases including
  `stricter-*`. A differential run of 1.05 million further random and structural patterns against CPython found no
  difference outside `\N{…}`.

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
* `SupplierRegistry(records)` is `dict(records or DEFAULT_REGISTRY)` with Python truthiness (`0`, `""`, `[]`, `false`
  select the defaults) and Python's `dict()` errors for other values (`TypeError` "'int' object is not iterable",
  `ValueError` "dictionary update sequence element #0 has length 1; 2 is required", ...).
* `FixtureExtractionModel({gullible, invalid_outputs, unavailable})` is the keyword call (an unknown key raises
  `TypeError` like Python) and a non-object argument is the positional `gullible`. The values are kept as given and
  used like Python's attributes: `gullible`/`unavailable` by truthiness, `invalid_outputs > 0` by Python comparison
  (`true` counts as 1, `null` or a string raises `TypeError` on each call). Test: `55_fakes` "FixtureExtractionModel
  arguments" (golden `model_args`) and the registry cases.
* `FakeERP` is in memory, while Python's is SQLite.
  * A `FakeERP(path)` with `path !== ":memory:"` shares its rows with every other instance opened on the same path in
    this JS realm, like reopening the SQLite file. Faults and calls stay per instance.
  * `erp.reopen()` reproduces `Env.restart`. `FakeERP.reset_storage(path)` forgets the rows (tests).
  * `reconcile_create` returns the first match in SQLite's scan order over the `(tenant_id, idempotency_key)` index,
    i.e. by idempotency key and then by insertion. This was checked against SQLite 3.45 query plans and golden
    transcripts.
  * SQL parameters are bound like Python's sqlite3 into the TEXT columns, after the whole parameter tuple is built
    (so a missing argument is a `KeyError` before any binding error). Strings, `null`, booleans and safe integers
    become their TEXT form. Python's errors are reproduced with the same class name (`HXError.code`) and message:
    lists and dicts raise `ProgrammingError` ("Error binding parameter N: type 'dict' is not supported", N counted
    per statement as in the Python SQL), integers wider than 64 bits raise `OverflowError` ("Python int too large to
    convert to SQLite INTEGER"), and strings with lone surrogates raise `UnicodeEncodeError`.
  * Stricter than Python (documented): Python's sqlite3 stores floats, and integers beyond +/-(2^53-1) that fit in 64
    bits, as SQLite text. The port raises `HXError("InterfaceError")` for them (it cannot reproduce SQLite's
    REAL-to-TEXT formatting, and such integers are not exact in JS). `-2^63-1` is `-2^63` as a JS number, so the port
    raises `InterfaceError` where Python raises `OverflowError`; both reject.
  * `create_draft` digests its arguments first. Integers beyond +/-(2^53-1) anywhere in the arguments raise
    `CanonicalError` there (the general number deviation above). Python's digest accepts them; Python then stores them
    inside `draft`, or raises `OverflowError` when binding one wider than 64 bits as `supplier_ref`/`draft_digest`.
  * Tests: `55_fakes` "FakeERP SQL parameter binding" (golden `erp_bind`, `erp_big_ints`).
* Python built-in errors that the fakes raise on malformed input (`KeyError`, `TypeError`, `AttributeError`,
  `IndexError`, `ProgrammingError`, `OverflowError`, `UnicodeEncodeError`) are `HX.HXError` with that class name as
  `code`. The messages match Python's for `KeyError`, `AttributeError`, `IndexError`, `ProgrammingError`,
  `OverflowError` and the `DocumentStore`/binding `TypeError`s; other messages are approximate.
* `FixtureExtractionModel` REPAIR_DRAFT with a non-dict `draft`: Python's `dict(x)` also accepts a list of pairs.
  JS raises `TypeError`. Only schema-validated dict drafts reach it in the flow.
* `FixtureExtractionModel.generate(request)` validates `request` as a `ModelRequest`, which is what constructing the
  Python request does, and logs the normalized request in `requests`.
* `DocumentStore` follows Python on malformed collections: `docs` that is not a dict raises `AttributeError` (`.get`,
  before the tenant lookup), and a tenant collection is used with Python's `in` and `[]`: a list matches elements with
  Python `==` and takes int/bool indices (negative from the end; `IndexError` out of range), a string matches
  substrings by code point and then fails to index (`TypeError`), other values are not iterable (`TypeError`), and
  content that is not a string is not a buffer (`TypeError`). Falsy `docs` (`0`, `[]`, `""`) select the defaults.
  Tests: `55_fakes` "DocumentStore with malformed collections" (golden `documents`, `documents_escaped`).

## Clauses (compiler/clauses.py)

* No deviation. Errors mirror Python's classes as `HX.HXError` codes: a clause **body** with a lone surrogate raises
  `UnicodeEncodeError` (Python hashes `body.encode("utf-8")`; a heading or blank line with one is fine, as in Python),
  and a non-string text raises `AttributeError` ("'NoneType' object has no attribute 'splitlines'"). Test:
  `28_clauses` (golden `errors`).

## Fixture

* `machine_dict()` and `contracts_dict()` return fresh deep copies on every call. In Python, the variable and contract
  dicts are shared with `VARIABLES`. Values are identical.
* `machine_dict(x)` is the positional call and `machine_dict({defect: x})` the keyword call; `x` is tested with Python
  truthiness (`[]`, `{}`, `""`, `0`, `null` are false). A plain-object argument is always the keyword-options object,
  so `machine_dict({...})` mirrors Python's `machine_dict(**{...})`: an unknown key raises `TypeError` ("unexpected
  keyword argument"). Python's positional `machine_dict({"defect": False})` (a truthy dict) has no JS spelling.
* `FixtureCompilerModel.draft(context, diagnostics, attempt)` iterates `diagnostics` like Python (a dict yields its
  keys, a string its characters) and stops at the first `ORDERING_VIOLATION`; a non-dict item before that raises
  `AttributeError` and a non-iterable raises `TypeError` (`HX.HXError` codes, Python's messages).
  Tests: `34_fixture` "Python truthiness and iteration" (golden `machine_dict_truthiness`, `diagnostics_iteration`).
* `FixtureCompilerModel.settings` is a per-instance object (a shared class attribute in Python).
