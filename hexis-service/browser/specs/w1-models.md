# Wave 1 — models, clauses, procurement fixture, fakes

Files you own:
* `browser/src/25_efsm.js` (`HX.efsm`), `browser/src/26_pkg.js` (`HX.pkg` and `HX.catalog`),
  `browser/src/28_clauses.js` (`HX.clauses`), `browser/src/34_fixture.js` (`HX.fixture`), `browser/src/55_fakes.js` (`HX.fakes`)
* `browser/golden/gen_models.py`, `gen_clauses.py`, `gen_fixture.py`, `gen_fakes.py` and their `golden/*.json`
* `browser/test/25_efsm.test.js`, `26_pkg.test.js`, `28_clauses.test.js`, `34_fixture.test.js`, `55_fakes.test.js`
* `browser/deviations/models.md`

Python references: `artifacts/efsm.py`, `artifacts/package.py`, `tools/catalog.py`, `compiler/clauses.py`,
`demo/procurement_fixture.py`, `demo/fakes.py`, `tools/errors.py`. Read the current versions.

## HX.efsm (artifacts/efsm.py)
* `load_machine(obj)` returns a **normalized** machine. It is a new object with every model field present,
  with defaults filled exactly like `Machine.model_validate(obj).model_dump(mode="json", by_alias=True)`, so
  `HX.canonical.digest(load_machine(x)) === digest(Python dump)`.
* Validation must reject exactly what pydantic rejects:
  - unknown fields (`extra="forbid"`) and wrong types, with pydantic's lax coercions where they apply. Note
    which coercions pydantic performs (e.g. int to str? no) by testing them in the generator.
  - the `kind` discriminator;
  - the judge validators (abstain label, non-empty reads/writes, exactly one write) and the alias `question`;
  - the `init`/`init_from` xor rule;
  - `format == "efsm-v1"`.

  Raise `HX.efsm.EfsmError` (with a useful message).
* Helpers mirroring the model methods: `ordered_transitions(state)`, `var(machine, name)`,
  `var_types(machine)`, `terminal(machine, id)`, `to_json(machine)` (identity on normalized data), plus
  the constants `FALLBACK`, `ABSTAIN`, `LEGACY_ABSTAIN` and `ABSTAIN_LABELS`.
* Integral float fields (`error_rate` default `0.0`, any integral threshold) canonicalize differently in JS:
  document the hash consequence in `deviations/models.md`. Also decide and document what happens to
  integer-like state ids (see PORTING.md, dict order).

## HX.pkg and HX.catalog (artifacts/package.py, tools/catalog.py)
* `normalize_package(obj)` gives the full `MachinePackage` dump shape with every nested model (SourceManifest,
  ClauseRef, CompilerManifest, VariableContract with alias `schema`, EvidenceRequirement, TerminalContract,
  OrderingRequirement, InteractionContract, ClauseCoverage, FieldScope, Contracts, Budgets, ExecutionPolicy,
  ValidationManifest, Lineage, AdmissionRecord) normalized and validated like pydantic (`extra="forbid"`,
  Literal values).
* Also port: `PACKAGE_SCHEMA`, `HASHED_FIELDS`, `hash_payload(pkg)`, `compute_hash(pkg)`, `sealed(pkg)`
  (returns a copy), `verify_hash(pkg)`, `sign_admission(rec, key)`, `verify_admission(rec, key)` (HMAC over the
  canonical record without `signature`, prefixed `hmac-sha256:`), `package_digest_of`.
* `HX.catalog.load_catalog(obj)` (ToolCatalog/ToolSpec with defaults), `digest(catalog)`, `get(catalog,
  name)`, `is_write(spec)`, `WRITE_EFFECTS`, `check_schemas(catalog)` (via `HX.jsonschema.check_schema`),
  `validate_against` (re-export of `HX.jsonschema.validate_against`).
* Parity anchors (all must hold):
  - `digest(load_catalog(HX.data.tool_catalog)) === HX.data.python_build.catalog_digest`;
  - for the Python-built initial and refined procurement packages (dump them in the generator), JS
    `compute_hash(normalize_package(dump)) === dump.artifact_hash`;
  - `sign_admission`/`verify_admission` agree with Python on fixed records and keys.

## HX.clauses (compiler/clauses.py)
`index_clauses(text)` reproduces Python's clause list exactly: ids, headings, text, **code-point** `start`/`end`
and sha256. This covers `str.splitlines(keepends=True)` semantics (all Python line separators), list-item and
paragraph rules, and the title special case. Also port `is_critical` and `CRITICAL_MARK`. The golden set
must include the real `SKILL.md` and at least 40 synthetic documents. Cover emoji and astral characters
before clauses, CRLF, lone `\r`, ` `, form feeds, nested lists, numbered items, indented items, headings
of every level, empty documents and documents with no headings.

## HX.fixture (demo/procurement_fixture.py)
Port `CAPABILITIES`, `TASK_INPUT_SCHEMA`, `DRAFT_SCHEMA`, `EXTRACT_PROMPT`, `REPAIR_PROMPT`, `VARIABLES` (as data),
`deployment_policy(environment)` (the `DeploymentPolicy` dump: `{environment, execution_policy, task_input_schema,
profile}` with every ExecutionPolicy/Budgets default), `machine_dict({defect})`, `contracts_dict()` and
`FixtureCompilerModel` (`model_id`, `settings`, `draft(context, diagnostics, attempt)`). Golden: the exact
Python outputs, deep-equal.

## HX.fakes (demo/fakes.py, tools/errors.py)
Port these:
* `ToolTimeout` and `ToolFailure` (export them from `HX.fakes` and also as `HX.errors.ToolTimeout` /
  `HX.errors.ToolFailure`);
* `DEFAULT_DOCUMENTS` and `DEFAULT_REGISTRY` (tuple keys become `"tenant|ref"` strings internally; document
  this);
* `DocumentStore`, `SupplierRegistry`, `draft_digest`, `validate_draft` (Python regex semantics: `re.match`,
  `$`, `\s`), `verify_persisted`;
* `FakeERP` (in memory: `inject`, `count`, `create_draft` with idempotency and the fault semantics,
  `reconcile_create`, `read_draft`, `modify_out_of_band`, `tamper_payload`, `calls`, and the `D-%04d` id
  scheme);
* `FixtureExtractionModel` (`gullible`, `invalid_outputs` and `unavailable` behaviors, token estimates,
  `requests` log), returning `HX.models`-shaped responses: a `ModelResponse` dump `{output, raw_text,
  model_id, input_tokens, output_tokens, cost_usd}` and `ModelUnavailable`. Put `ModelRequest`/`ModelResponse`
  helpers and `ModelUnavailable` in `HX.fakes` too, and note in `deviations/models.md` that `models/base.py`
  is folded in here.
* Golden: drive the Python functions with at least 300 generated drafts and documents: valid and invalid
  emails and tax ids (including trailing-newline cases), missing fields, sanctioned countries and orphan
  source links. Also record ERP operation sequences with faults and the extraction model's outputs for
  EXTRACT_DRAFT and REPAIR_DRAFT requests in each mode.

## Done when
All five test files pass, the whole `node test/run.mjs` passes, and every parity anchor holds.
