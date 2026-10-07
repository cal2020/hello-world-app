# Deviations: traces, normalize, replay (wave 3)

Modules: `60_traces.js` (`HX.traces`, port of `traces/model.py`), `62_normalize.js` (`HX.normalize`, port of
`traces/normalize.py`) and `64_replay.js` (`HX.replay`, port of `replay/replay.py`).

Parity is proven by `test/60_traces.test.js`, `62_normalize.test.js` and `64_replay.test.js` against
`golden/traces.json` and `golden/traces_mut_1..4.json` (from `golden/gen_traces.py`, which runs the real Python code):

* 6 traces exported by Python from real runs (happy path with approval, registry conflict, repairs exhausted,
  fallback after invalid model outputs, model unavailable, missing documents on the refined package), the 4
  reference traces plus the C30 stateless trace, and 47 hand-built traces over 7 small packages (UNKNOWN branching,
  binds, phases, observable judge records, seeded counters, guard errors, the 20,000-node search limit, loop counters
  holding Unicode-digit strings written by a tool or seeded through the initial checkpoint);
* 220 curated vectors (every case of `tests/replay/test_replay_update.py` and `test_review_replay_traces.py`
  re-expressed as data, 44 malformed JSONL texts, Python `==` and truthiness corners) and 440 seeded random
  mutations (records dropped, swapped, duplicated and altered; outputs changed; observations and checkpoint digests
  stripped; header edits; merged lids; noise, unknown and denied records; tampering with and without resealing;
  unsealed and partially sealed traces);
* for each vector: `from_jsonl` (integrity errors or exception class), the loaded trace's dump and seal,
  `records_digest`, `header_digest`, the sha256 of `to_jsonl` (byte identity), `integrity_errors(expected)`,
  `normalize` events and dropped records, `eligibility` and `first_step`, and `replay_structural` /
  `replay_recorded` reports (every `to_json()` field) against the initial, refined and C31 "observable" packages
  (2,982 replays, 1,491 eligibility checks), plus the `on_step` call log and the rogue network call (A13);
* Python's `int()` of 695 counter strings (every Unicode decimal digit and mixed forms) and 5 Python-sealed texts
  whose dicts have integer-like keys (`key_order`, deviation #7).

Everything not listed here matches Python exactly. Every behavioral deviation below is conservative (the port raises
or refuses where Python would return a result; it never returns a different status, path, digest or verdict).

| # | Area | Python | JS port | Why | Test |
|---|---|---|---|---|---|
| 1 | Integral float literals in trace JSONL (`{"x": 1.0}`, also an exponent form such as `5.99e307`) | loaded (a float) | `CanonicalError` from `strict_loads`, at parse time: where Python goes on and fails later on the same text (e.g. `AttributeError` for a header field of the wrong type), the class therefore differs; both refuse | the general number deviation (DEVIATIONS.md) | `60_traces` "integral float literals are refused" (golden `js_deviation` vector) |
| 2 | Values in `Record`/`Trace` dict fields (`action`, `output`, `vars`, `meta`, `task`) | any Python object, lone-surrogate strings, integers beyond 2^53 (hashing fails later) | `ValidationError` (`json_invalid` / `string_unicode`) when the record or trace is constructed; `py_json_dumps` raises `CanonicalError` for such values | they cannot be canonicalized or serialized exactly | `64_replay` "documented deviations" (3, 4) |
| 3 | `list(labels)` of a tool record whose `labels` is a dict with two or more keys, one of them integer-like (`{"b": 1, "7": 2}`) | the keys in insertion order | `HX.HXError` `KEY_ORDER_UNKNOWN` | a JS object cannot give back that insertion order (same rule as `HX.kernel`) | `64_replay` "documented deviations" (2) |
| 4 | A structural-replay loop counter `int(cur or 0) + 1` beyond 2^53−1 (reachable only through an undeclared or task-initialized counter seeded near 2^53, e.g. `2**53 - 1` or a 16-digit string) | keeps counting | `HX.HXError` `ValueError` (the replay raises instead of reporting) | the value cannot be represented exactly; the visited-set key would throw later anyway | `64_replay` "documented deviations" (1), "counter int() accepts Unicode decimal digits" |
| 5 | `no_external_calls()` | patches `socket.connect`/`connect_ex`/`create_connection`/`getaddrinfo` | `no_external_calls(fn)` replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` (where present) and `navigator.sendBeacon` with functions that throw `ExternalCallAttempted`, restoring them in a `finally`. If a present API cannot be replaced (non-configurable, frozen `navigator`), it throws `ExternalCallAttempted` before running `fn`, so recorded replay reports `ERROR` | browser network surface; engine scripts cannot reach `node:net` | `64_replay` "on_step sees every step …", "documented deviations" (5) |
| 6 | Message text of `replay_structural` "cannot reconstruct initial variables: …" when the task input fails the task schema, and of `replay_recorded` "OUTPUT_SCHEMA: …" / "TASK_INPUT_INVALID: …" | python-jsonschema texts | `HX.kernel` texts (deviations/kernel.md) | inherited | the test compares these details up to the jsonschema text (13 of 2,886 golden reports); status, path, placeholders and divergence are compared exactly |
| 7 | Python `str()`/`repr()` of a dict (at any depth) with two or more keys of which one is integer-like (`{"b": 1, "1": 2}`, also `{"10": 1, "9": 2}` in sorted JSONL), wherever it is printed into a value: `from_jsonl`'s `trace_id = str(task_id)` (header without a stored `trace_id`), normalize's event `outcome = str(output.status)` and `role = f"lid:{logical_action_id}"`, the dropped reason `unrecognized kind {kind!r}`, eligibility's `UNRECOGNIZED_RECORD` requirement `kind {kind!r}` and the replay details and divergence reasons that print record values | prints the keys in insertion order (the text then flows into `trace_id`, the header digest, `to_jsonl` bytes, event digests and `divergence.expected_event`) | `HX.HXError` `KEY_ORDER_UNKNOWN` from the call (`from_jsonl`, `normalize`, `eligibility`, `replay_structural`, `replay_recorded`); a header that stores the trace_id loads with Python's digests. Only where the text would reach a value: `from_jsonl` raises it after the records and the `Trace` model are validated, so a bad record or header field gives Python's `ValidationError` / `TypeError` first; eligibility's verifier check `str(status) not in POSITIVE_RESULTS` never prints (a non-str status is never positive), so it returns Python's `UNSUPPORTED_SUCCESS_CLAIM` | a JS object enumerates integer-like keys first and cannot give back the insertion order, so any text would be wrong (a Python-sealed trace was rejected as tampered; event outcomes differed). Same rule as #3 and `HX.kernel`. The tool-output bind map (`{binds.get(k, k): v}`) raises the same error when two outputs, one of them integer-like, bind the same variable (only reachable with an integer-like variable name, since integer-like `binds` keys are refused by `HX.efsm`). Exception message texts (`KeyError`, `TypeError` of an unknown keyword, `ValueError` of a replay mode) still print such dicts, in JS order | `64_replay` "str()/repr() of a dict with integer-like keys raises KEY_ORDER_UNKNOWN" (golden `key_order`: 5 Python-sealed texts with Python's trace_id, digests, events, eligibility and reports); `60_traces` "from_jsonl: KEY_ORDER_UNKNOWN for str(task_id) only where Python builds the trace …" (golden `from_jsonl_order`); `62_normalize` "eligibility: a non-str verifier status is never positive …" (golden `eligibility_status`) |
| 8 | Message texts of loader errors when both sides refuse the input (exception classes match): `CanonicalError` for bad JSON (`invalid JSON: Unterminated string starting at: line 1 column 12 (char 11)`, `Unexpected UTF-8 BOM`, `Expecting value`), NaN/Infinity (`non-finite number NaN is not allowed`) | `json` module texts | `HX.canonical.strict_loads` texts (`unterminated string at char N`, `unexpected character …`, `non-finite number is not allowed`) | message text need not match (PORTING.md); the classes and the error order are compared for every malformed vector | `60_traces` "every vector …" (44 malformed texts, class compared) |

## Not deviations (verified equal, listed because JS makes them easy to get wrong)

* **JSONL bytes**: `to_jsonl` reproduces `json.dumps(sort_keys=True, ensure_ascii=False)` with the default `", "` /
  `": "` separators, Python float repr, code-point key order and Python's string escapes (raw U+2028, U+0085,
  DEL and non-ASCII; `\u001f` for C0 controls). `from_jsonl` splits with Python's `str.splitlines` (so a raw
  U+2028/U+0085 inside a value breaks the line and the load fails, as in Python) and skips lines that are blank under
  Python's `str.strip`. CRLF, CR-only, form feed and VT/FS separated texts load like Python.
* **from_jsonl errors** keep Python's classes and order: `ValueError` "empty trace", `CanonicalError` for bad JSON,
  duplicate keys or NaN, `AttributeError` for a non-dict header or a truthy non-dict `hexis_service` block,
  `TypeError` for a non-mapping record (raised before the header is validated, as Python evaluates the records
  argument first), and `ValidationError` for pydantic failures (lax `int` coercion of `"3"` and `true`, `1.5`
  refused). `str(task_id)` uses Python's `str()` (`{'a': [1, 2.5, None, True]}`), except for dicts with
  integer-like keys (#7).
* **Seal**: the seal read from the header keeps only string digests; a missing, empty or falsy block gives an
  unsealed trace. `integrity_errors(expected)` treats `""` as an override, like Python's `is not None`.
* **Python semantics in normalize/eligibility/replay**: `==` with `1 == True` (merge inputs, record output vs
  observation outputs, counter seeds such as `False == 0`), truthiness of `observable`, `writes`,
  `logical_action_id` and `inc`, `str()` of statuses (`None`, dicts without integer-like keys, #7), `repr()` in
  reasons (same caveat), `int()` of structural-replay loop counters (ints, floats, bools, strings with `_`, CPython's
  surrounding whitespace and **Unicode decimal digits** such as `'٣'`, `'１'`, `'𝟙'`, `'١_٢'`, from CPython 3.12's
  Unicode 15.0 digit table; checked for every decimal digit against Python's `int()`), `set()` of `writes`
  (`TypeError` for non-iterables and unhashable elements, a string iterates its characters), `in` on a set of
  verified terminals (`TypeError` for a list terminal), pydantic validation of `NormalizedEvent` (a non-string tool,
  phase, interaction type or label raises `ValidationError`), the lazily evaluated guard-variable set in
  `guard_values` (a `GuardError` from `vars_of` escapes exactly when Python's does), the visited set, the DFS order
  and the 20,000-node limit.

## API shape (not semantics)

* Traces and records are plain objects with exactly the model fields; Python methods are functions taking the
  trace first (`records_digest(t)`, `header_digest(t)`, `integrity_errors(t, expected)`, `to_jsonl(t)`,
  `body_digest(r)`), `Trace.from_jsonl` is `from_jsonl(text)` returning `[trace, errors]`, `Trace(...)` /
  `Record(...)` are `new_trace(fields)` / `new_record(fields)` (unsealed).
* The private `_seal` lives in a WeakMap: `get_seal(t)` reads it and `_set_seal(t, seal)` mirrors an assignment to
  `t._seal`. `model_copy(t, {update, deep})` carries the seal. Any other copy (`deep_clone`, `structuredClone`, JSON
  round trip, Python's `copy.deepcopy` equivalent) is unsealed and therefore rejected by every consumer, where
  Python's `copy.deepcopy` would keep the seal (fail closed).
* `seal(t)` and `model_copy(t, {update})` return independent data; Python's `model_copy(update=...)` is shallow, so
  the sealed copy shares `task` (and the unsealed records' dicts) with the original.
* `replay_recorded(pkg, t, {on_step})` passes the checkpoint and observation **dumps** to `on_step` (Python passes
  the pydantic models); an unknown option raises `TypeError` like an unexpected keyword. `ReplayReport` is a class with
  `to_json()` (and `toJSON()`).
* Structural replay keys the visited set on canonical text instead of its SHA-256 digest (equal iff the digests are
  equal); environments are null-prototype maps holding `HX.guards.UNKNOWN`.
* `export_run_trace(service, run_id, principal, verdict)` uses `service.store` and `service.package(hash)` (a
  normalized package dump), like Python; byte parity with Python's export is verified in wave 4.
