# API notes from engine wave 1 (for consumers of HX.guards, HX.efsm, HX.pkg, HX.catalog, HX.clauses, HX.fixture, HX.fakes)

## guards (from repair:guards)

- The public API is unchanged: parse, vars_of, typecheck, evaluate, evaluate3, analyze_disjoint, Analysis, UNKNOWN, GuardError and the constants.
- Accepted trees keep the PORTING.md shape; Load contexts stay implicit.
- _parse_raw(expr) now returns trees for every construct Python parses, using Python's ast class names and fields:
  - new node types: NamedExpr, Lambda/arguments/arg, Dict (null keys for **), Set, ListComp/SetComp/GeneratorExp/DictComp/comprehension, Await/Yield/YieldFrom, Attribute, Subscript/Slice, Starred, keyword, JoinedStr/FormattedValue;
  - ctx: "Store" appears only on comprehension and walrus targets;
  - Constant.py_type can also be "bytes" (value = list of byte values) or "complex" (value = the imaginary part);
  - an int literal above 2^53-1 has a BigInt value inside _parse_raw trees only. parse() rejects it.
- Every non-syntax GuardError message is Python's exact text, so 30_validate can rely on typecheck() strings and analyze_disjoint details for GUARD_INVALID and GUARDS_DISJOINTNESS_UNKNOWN messages. The exception is syntax-error texts, which are approximated after the 'guard syntax error: ' prefix.
- Inputs that crash Python's guards functions are GuardError in JS: typecheck returns [msg] and analyze_disjoint returns UNKNOWN 'unparseable guard: ...'.
- The engine needs about 250 KB of JS stack for 200-level nesting. Node, the Chromium main thread and a cold dedicated Worker all have room; with less, the result is GuardError, never RangeError.
- New helpers that tests and the UI may use: guards._py_repr_str (exact Python repr of a str), _py_repr_bytes, _py_repr_imag, _is_printable, _nonprintable_ranges, _tokenize, _decode_str and _is_stack_overflow.
- golden/guards_fuzz.json is new. Parse records now store the tree as compact JSON text in the 'ast' field, and carry 'x' for non-GuardError exceptions and 'nesc' for texts containing \N.
- The orchestrator's WIP commit c2bd8b3 already contains the current src, test and golden files; only deviations/guards.md changed after it. I ran no state-changing git commands.

## models (from repair:models)

For downstream modules (30_validate, 36_compile, 50_broker, 58_service, 75_env) and the UI:

- **New regex API.** HX.catalog.py_regex_check(pattern) returns null, or {kind, message} where kind is 'error' (re.error), 'OverflowError', 'ValueError', 'RecursionError' or 'TypeError'. It answers whether CPython 3.12 re.compile accepts the pattern. HX.catalog.py_regex_error(p) returns only the message; HX.catalog.PY_RE_MAX_NESTING is 100. check_schemas output is unchanged in shape: one '<tool>.<input|output>_schema invalid: …' per bad schema, in tool order. JS-only findings always contain 'unsupported keyword' or 'regular expression'.
- **Hashing.** For any model with float fields (Machine, MachinePackage, ExecutionPolicy, Budgets, DeploymentPolicy, ModelResponse), hash with the model-aware APIs: HX.pkg.X.digest/canonical_text, HX.pkg.compute_hash/sealed/verify_hash, HX.efsm.machine_digest, HX.efsm.pyd.digest(type, dump), or the new HX.fakes.ModelResponse.digest/canonical_text. A plain HX.canonical.digest(dump) prints 0 instead of 0.0, and throws for float values beyond 2^53 (e.g. max_spend_usd '1e16' is valid and hashes as 1e+16). Model digests are over the by_alias dump ('if', 'schema').
- **Validation error lists** (EfsmError/PackageError/CatalogError/ValidationError .errors) are a superset of pydantic's. Extra entries come only from documented deviations: json_invalid, string_unicode, dict_key_integer_like, int_unsafe, finite_number. Compare as sets; order differs only with integer-like keys. Lone surrogates in int/float/bool/Literal fields give string_unicode, and a lone-surrogate input key gives one string_unicode at the model loc (unless a nested before-validator raises TypeError first: then only python_type_error, as pydantic validates fields before reading the keys). Not a superset in two places (models.md): irregular integer strings such as "0-1" (plain int_parsing), and 4300+-character numeric strings pydantic accepts (int_unsafe); numeric strings pydantic rejects for length give its exact type (int_parsing_size vs int_parsing).
- **Python built-in errors** raised by fakes, fixture and clauses are HX.HXError with code = the Python class name: AttributeError, TypeError, KeyError, IndexError, ValueError, ProgrammingError, OverflowError, UnicodeEncodeError, plus the JS-only InterfaceError. Messages match Python's for KeyError, AttributeError, IndexError, ProgrammingError, OverflowError and most TypeErrors.
  - Changed: FixtureCompilerModel.draft now raises HXError AttributeError/TypeError where it used to raise a native TypeError.
  - Changed: index_clauses raises HXError UnicodeEncodeError (clause body with a lone surrogate) and AttributeError (non-string) where it used to raise CanonicalError and a native TypeError.
- **Argument conventions** (Python truthiness everywhere):
  - HX.fixture.machine_dict(x) is the positional call. machine_dict({defect: x}) is the keyword call; a plain object is always the options object, and unknown keys raise TypeError.
  - new HX.fakes.FixtureExtractionModel({gullible, invalid_outputs, unavailable}) is the keyword form; a non-object argument is the positional gullible. Attributes keep the raw values; invalid_outputs uses Python's '> 0' (null or a string raises TypeError on each generate()).
  - new HX.fakes.SupplierRegistry(records) is dict(records or DEFAULT): falsy values select the defaults, and other non-mappings raise TypeError/ValueError.
- **FakeERP parameters:** pass strings (the broker and catalog already do). Lists/dicts raise ProgrammingError, ints wider than 64 bits raise OverflowError, and floats or unsafe ints raise InterfaceError.
- **HX.efsm.var_types()** iterates integer-like variable names first. Use it for lookups only, and iterate machine.variables where order matters.


## Important for 30_validate (from the guards re-verification)

`HX.guards.analyze_disjoint` can return a COUNTEREXAMPLE whose assignment contains an integral number at or above
2^53, either the exact value Python found (e.g. `1e16`) or a deviation #6 representative. Python's validator copies
`an.counterexample` into `analyses[]` and into the GUARDS_OVERLAP finding detail, then digests the report. Because
`HX.canonical` refuses unsafe integers, a literal port would throw CanonicalError where Python returns a report.
The validator must handle this conservatively and never crash. For example, it can report the analysis with the
counterexample value rendered as a string (Python's repr) and record the substitution in deviations/static.md, or
treat the pair as UNKNOWN. In either case the guard pair must still be reported as overlapping or unproven, never
as disjoint. Repro: `analyze_disjoint(['x >= 1e16', 'x == 1e16'], {x: 'integer'})`.

Resolved (engine polish round): `HX.validate` reports such values as decimal digit strings in `analyses[]` and the
GUARDS_OVERLAP detail (deviations/static.md #7; the verdict is unchanged), so the report digests. Any other consumer
that digests `an.counterexample` must do the same or fail closed; see deviations/guards.md #6.
