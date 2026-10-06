# Deviations: kernel, store, policy, approvals/evidence (wave 2)

Modules: `40_kernel.js` (`HX.kernel`), `45_store.js` (`HX.store`), `47_policy.js` (`HX.policy`) and
`48_approvals.js` (`HX.approvals`, `HX.evidence`).

Everything not listed here matches the Python reference exactly, as proven against the real Python code by
`test/40_kernel.test.js`, `45_store.test.js`, `47_policy.test.js` and `48_approvals.test.js` with the golden files
written by `golden/gen_kernel.py`, `gen_store.py` and `gen_policy.py`:

* kernel: 1,800+ random-walk steps over the Python-built initial and refined procurement packages and 11 small
  kernel-test packages. Each step compares the full `KernelResult` (checkpoint dump including
  `assurance.diagnostics` and its messages, events including `observation_digest` and `delta_digest`, delta, edge)
  or the error: the `KernelError` code, detail and message, the pydantic error `type`/`loc` set, or the Python
  exception class. It also covers `fill_template`, `resolve_path` and `select_edge` vectors;
* store: 341 operation sequences (7,600+ calls covering every public method) on the real SQLite `Store(":memory:")`.
  Each call's return value or exception class (and `ConflictError` code and message) is compared, and after each
  sequence every table row by row in rowid order;
* policy/approvals/evidence: 4,060 dispatch decisions, 1,560 approval decisions, document validation,
  authentication, 60 revoke sequences with exact `policy_version` strings, and scope, digest and receipt vectors.

Every behavioral deviation below is conservative: the port rejects or fails closed where Python accepts (sometimes with
a different error class where Python also rejects). The only exceptions are not about validation: `reopen()` of an open `:memory:` store (a new object over the same data, as the
spec requires, instead of `self`) and the Python-only two-code-point surrogate pair in `logical_action_id` (see the
approvals section), which a JS string cannot represent.

## Kernel (`runtime/kernel.py`)

| Python | JS port | Why | Test |
|---|---|---|---|
| `advance(checkpoint, obs, package)` takes pydantic model instances | it takes the model **dumps** (`new_checkpoint`/`new_observation`/`RunCheckpoint.model_validate`, a previous `KernelResult.checkpoint`) and a normalized package dump (`HX.pkg.normalize_package`). It does not re-validate them | the same contract: Python's type system guarantees validated models. Validation happens where Python constructs the models from untrusted data | `40_kernel` walks (every step builds the observation with `new_observation`) |
| `Any` fields (`variables`, `outputs`, `engine`, `outcome`, `diagnostics`) accept lone-surrogate strings, integers beyond 2^53 and other non-JSON values (Python fails later when hashing) | `ValidationError` (`json_invalid` / `string_unicode`) when the checkpoint or observation is constructed | such values cannot be canonicalized (`obs.digest()`, `delta_digest`, checkpoint digests) | `40_kernel` "documented deviations" |
| integral floats (`1.0`) are distinct from ints: `OUTPUT_TYPE` for an integer variable, a field-scope change `1` to `1.0` | cannot be represented. `HX.canonical.strict_loads` refuses integral float literals, so parsed input never carries one. **Callers must parse untrusted JSON (model output, task input, responses) with `strict_loads`, not `JSON.parse`** | one number type (DEVIATIONS.md) | `40_kernel` "documented deviations" |
| free-form JSON objects keep insertion order: observation `outputs`, templates | integer-like keys (`"7"`) iterate first. When several outputs fail, the first error can name a different key (e.g. `WRITE_OWNERSHIP` for `'7'` instead of `'t'`), and `fill_template` can report a different failing variable first. The result is otherwise identical (`delta_digest` is canonical) | JS object key order; it cannot be fixed with plain objects (same as models.md) | `40_kernel` "documented deviations" |
| `list(x)` of a terminal-admission `receipts`, `missing` or `unresolved_effects` that is a dict (malformed host data; normally a list) gives the keys in insertion order, which become `outcome.evidence_receipts`, `evidence_refs` and `assurance.missing_evidence` / `unresolved_effects` (and so the checkpoint digest) | a dict with two or more keys of which one is integer-like (`{"z": 1, "7": 2}`) raises `HX.HXError` `KEY_ORDER_UNKNOWN` (JS-only code) instead of returning a list in a possibly different order; any other dict gives Python's list | a JS object cannot give back that insertion order | `40_kernel` "documented deviations" (item 7) |
| `int(x)` for an `inc` counter or a `usage` value accepts Unicode decimal digits and arbitrary size | ASCII digit strings (with `_`) only, within ±(2^53−1). Otherwise `ValueError`. The surrounding whitespace stripped is exactly CPython's (`\t\n\v\f\r`, space, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000); U+001C–U+001F and U+FEFF are refused like Python | engine counters are always small ints; Unicode digit tables are not shipped | `40_kernel` "int() of counters strips exactly CPython's whitespace" (every code point up to U+3000 and others, as prefix, suffix and alone, against Python's `int()`) |
| `multipleOf` in task input and output schemas: python-jsonschema is exact (int divisor: `instance % dB`; float divisor: `int(q) != q`; overflow: `Fraction`), so `0.07` is not a multiple of `0.01` | **matched**: the kernel does not use `HX.catalog.validate_against` alone for a schema that uses `multipleOf`. `HX.kernel._schema_errors` validates the schema with `multipleOf` (and every `anyOf`/`oneOf`/`not` that contains one) removed, then adds Python's exact `multipleOf` errors and decides those combinators itself. `HX.jsonschema` itself is looser (any value within 1e-9 of a multiple passes: `validate_against({multipleOf: 0.1}, 0.3)` is `[]`, Python rejects); that is a `15_jsonschema` issue, so **other callers of `HX.catalog.validate_against` (catalog tool input/output checks) still accept such values** until it is fixed there | the kernel's TASK_INPUT_INVALID / OUTPUT_SCHEMA verdicts must be Python's | `40_kernel` "schema checks use python-jsonschema's exact multipleOf" (2,676 Python verdicts incl. nested/combinator schemas, and kernel results for `initial_checkpoint` / `advance`) |
| task input and output schemas are checked by python-jsonschema: `pattern` and `patternProperties` use `re.search`, where `$` also matches before a final `"\n"`, `.` matches everything but `"\n"`, and `\d`, `\w`, `\s`, `\b` use CPython's Unicode tables | **matched** for the regex subset below: `HX.kernel._schema_errors` translates every schema regex into a JS `u` regex with Python's meaning (`$` -> `(?=\n?$)`, `.` -> `[^\n]`, `\d`/`\w`/`\s` and their negations, also inside classes, as CPython 3.12's code point tables (Unicode 15.0, embedded as `HX.kernel._PY_RE_TABLES`), `\b`/`\B` with Python's word class (and `\B` never matching in an empty string), `\A`, `\Z`, `\x`/`\u`/`\U` escapes, `{,n}`, literal `{`, `(?P<name>…)`, look-arounds, also repeated). The verdict then equals Python's under `not`, `anyOf`/`oneOf` and for `patternProperties` keys too. **Fail closed**: a schema containing any regex outside the subset (flags such as `(?i)`, back references, `\N{…}`, octal/`\0` escapes, `(?#…)`, atomic groups, possessive repeats, non-ASCII group names, a non-string `pattern`, repeat counts above 100,000, or a regex `HX.catalog.py_regex_check` refuses) gives the single error `<root>: unsupported pattern …`, so `TASK_INPUT_INVALID` / `OUTPUT_SCHEMA` for every value. Where Python's `re` refuses the regex it raises `re.error` (when the regex is reached); the port gives that same verdict code instead. `HX.jsonschema` itself (and so other callers of `HX.catalog.validate_against`, e.g. catalog tool input/output checks) still uses plain JS regexes, which differ in both directions; that is a `15_jsonschema` issue | the kernel's verdicts must be Python's | `40_kernel` "schema regexes have Python re.search semantics" (the class tables against Python's; 6,500+ `re.search` results of curated and random regexes over texts with `\n`, Unicode digits/letters/spaces; 1,350+ python-jsonschema verdicts with `pattern`, `not`, `anyOf`/`oneOf`, `patternProperties` (incl. two regexes with the same translation) and `multipleOf`; kernel results for `initial_checkpoint` / `advance`). A separate 60,000-vector fuzz run found no mismatch |
| messages | identical, including `assurance.diagnostics` messages (guard errors use `HX.guards` messages), **except** `OUTPUT_SCHEMA` / `TASK_INPUT_INVALID`, which embed jsonschema texts (`detail.errors` and the message differ; the code, `detail.variable` and the valid/invalid verdict do not, apart from the fail-closed regexes in the row above), and `FIELD_SCOPE_VIOLATION` "not canonical JSON: …" texts | `HX.jsonschema` words its errors differently | `40_kernel` walks (messages compared for every other code) |

`KernelError.message` is Python's `exc.message` (without the `CODE: ` prefix); `String(err)` is Python's `str(exc)`.
Python built-in exceptions that escape the reference on malformed input are `HX.HXError` with the class name as
`code` (`KeyError`, `TypeError`, `AttributeError`, `ValueError`); pydantic errors are `HX.kernel.ValidationError`
(`.errors` = `{type, loc, msg}` entries). The walks compare these classes too, for example `AttributeError` for a
non-dict `terminal_admission`, `TypeError` for `list(None)`, `KeyError` for a contract variable missing from
the machine, and `IndexError` for a judge action whose `writes` is empty (which the package model refuses, so it is
reachable only with a package changed after validation; Python fails at `delta[writes[0]]`).

## Store (`storage/sqlite.py`)

| Python | JS port | Why | Test |
|---|---|---|---|
| raw SQL: `q1`, `qa`, `tx`, the `db` connection | not provided. JS-only readers instead: `tables()` (raw rows), `proposals()` (`update_proposals`, which Python only reads with SQL), `snapshot()` / `restore(json)` / `Store.restore(json)` | no SQL engine in the browser | `45_store` "every Python public method …", "snapshot()/restore(json) …" |
| `add_lifecycle(db, …)` takes a connection | the first argument is ignored. The call joins the current transaction when one is open | same | `45_store` sequences (`add_lifecycle` ops) |
| `reopen()` is `Store(self.path) if self.path != ":memory:" else self` | the same for a closed `:memory:` store (returns itself), for `""` (a new, empty private database, also after `close()`) and for a file path (a new Store over that path's rows, also after `close()`). **Deviation:** an open `:memory:` store returns a new `Store` object over the same data (spec: simulated process restart), where Python returns `self`. A file path (`new Store("x.db")`) shares its rows with every Store opened on that path in this JS realm; `Store.reset_storage(path)` forgets them | the browser has no files; the spec asks for a restart over the same in-memory data | `45_store` "reopen() shares data …" (Python's `reopen` vectors in `store.json`) |
| `close()` closes the connection | marks this Store object closed (`ProgrammingError` "Cannot operate on a closed database." afterwards). Other objects over the same data keep working | per-connection, like SQLite | same |
| SQLite column affinity coerces bound values: a float into a TEXT column is stored as its text form, a numeric string into an INTEGER/REAL column becomes a number, and integers up to 64 bits are stored | `InterfaceError` (JS-only class) for non-integral floats in TEXT columns, strings in INTEGER/REAL columns, non-finite numbers and integers beyond ±(2^53−1). Ints and bools in TEXT columns are converted to text like SQLite (`5` -> `"5"`, `True` -> `"1"`). Lists/dicts raise `ProgrammingError` and lone surrogates raise `UnicodeEncodeError`, like Python | SQLite's REAL-to-TEXT formatting and numeric-text parsing are not reproduced, and big integers are not exact in JS | `45_store` "store deviation: values SQLite coerces …" (Python results recorded in `store.json` `deviations`) |
| JSON columns hold `canonical_bytes(v)` | the same canonical text, from `HX.canonical`: an integral value in a float field is written as `1`, not `1.0` (`admission_record` returns this text), and integers beyond 2^53 raise `CanonicalError` | the general number deviation (DEVIATIONS.md). Getters parse the text, so values compare equal | `45_store` sequences (tables compared byte for byte for the generated data) |
| tuples | arrays: `get_active` -> `[hash, version]`, `admission_record` -> `[record, report]` | JS has no tuples | `45_store` sequences |

Emulated exactly (proven by the sequences):
* every method is one transaction (all writes are undone on any exception);
* PRIMARY KEY / UNIQUE constraints, where NULLs are distinct and a nullable TEXT primary key accepts NULL;
* NOT NULL constraints, and the conflict modes: plain INSERT raises `IntegrityError`, `INSERT OR IGNORE` skips the
  row (also on NOT NULL violations), and `INSERT OR REPLACE` deletes the conflicting rows (on NOT NULL it raises
  `IntegrityError`);
* the revision CAS and the lease fence in `commit_transition` (`ConflictError` with the code `REVISION_CONFLICT` /
  `STALE_LEASE` and Python's exact message);
* `update_intent` / `record_outcome` fencing and `expect_status`, and idempotent `create_intent` /
  `create_interaction`;
* `record_response` dedupe, and receipts and lifecycle sequencing;
* the admission and archive CAS;
* terminal statuses that `set_run_status` never overwrites, and OPEN interactions closed on a terminal commit;
* tenant scoping;
* `ORDER BY` tie-breaking as SQLite's index scans produce it: receipts by run order by `(created_at, seq,
  logical_action_id)`, evidence by `(observed_at, receipt_id)`;
* `events()` letting a body key `sequence` override the column value;
* `None` never matching in lookups;
* Python `==` for fetched values (`token == True`).

Getters always return fresh objects (JSON columns are parsed per call), so mutating a result never changes
stored data, and append-only tables have no update path (`_update` refuses them).

## Policy (`tools/policy.py`)

* No behavioral deviation. Principal directory entries are free-form dicts and are used with Python semantics:
  `in` on a str entry is a substring test, on a dict it is key membership, and on `None` it raises `TypeError`; a
  missing `tenant_id` raises `KeyError`; `tuple("abc")` gives roles `a`, `b`, `c`. The golden "weird" document
  covers these.
* Shapes: `Principal(fields)` returns a frozen plain object (`roles` is an array; a non-sequence gives pydantic's
  `tuple_type`). `Decision` is a class with `outcome`, `reasons`, the `allowed` getter and `toJSON()`.
  `PolicyService.version` is a getter.
* Errors: `PermissionError` (unknown principal), `KeyError`, `TypeError` and `AttributeError` are `HX.HXError` codes;
  pydantic errors are `HX.policy.ValidationError`.

## Approvals and evidence (`approvals/scope.py`, `evidence/receipts.py`)

| Python | JS port | Why | Test |
|---|---|---|---|
| `subject_of(values, names)` accepts any hashable name (an int name gives an int-keyed dict) | `TypeError` for non-str names | JS object keys are strings, and Python cannot canonicalize such a subject either (`make_receipt` would fail) | `48_approvals` "evidence deviations …" |
| `evidence_scope` sorts receipt ids of any one comparable type | `TypeError` when two or more valid receipts have non-str ids | receipt ids are always strings; mixed-type sorting fails in Python too | same |

`logical_action_id` / `idempotency_key` raise `UnicodeEncodeError` (an `HX.HXError` with that code and Python's exact
message, e.g. `'utf-8' codec can't encode character '\ud800' in position 1: surrogates not allowed` or `… characters in
position 7-8 …`) for lone surrogates, like Python's `sha256_hex` (proven by the `lid_errors` vectors in `policy.json`).
A high surrogate followed by a low one is a single character in a JS string, so the Python-only string
`"\ud800\udc00"` (two code points, which `json.loads` never produces) hashes as U+10000 in JS.

`approval_scope` takes its keyword-only arguments as one options object and raises `TypeError` for missing or
unexpected keys, like Python. `logical_action_id` / `idempotency_key` interpolate non-str values with Python's
`str()` (`True`, `None`, `2.5`).
