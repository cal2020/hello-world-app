# Wave 3 — traces: `60_traces`, `62_normalize`, `64_replay`

Files you own:
* `browser/src/60_traces.js` (`HX.traces`: `TRACE_EXT`, `new_record`, `new_trace`, `seal`, `records_digest`,
  `header_digest`, `integrity_errors`, `to_jsonl`, `from_jsonl`, `export_run_trace`, and the trace model validation)
* `browser/src/62_normalize.js` (`HX.normalize`: `NORMALIZER_VERSION`, `NOISE_KINDS`, `normalize`, `eligibility`,
  `first_step`, `NormalizedEvent` shape)
* `browser/src/64_replay.js` (`HX.replay`: `REPLAY_VERSION`, `MAX_NODES`, `ExternalCallAttempted`,
  `no_external_calls`, `ReplayReport` shape, `replay`, `replay_structural`, `replay_recorded`)
* `browser/golden/gen_traces.py` + `golden/traces*.json`, `browser/test/60_traces.test.js`, `62_normalize.test.js`,
  `64_replay.test.js`, `browser/deviations/traces.md`

Python references: `traces/model.py`, `traces/normalize.py`, `replay/replay.py` (current versions, including the
review fixes: the header digest is covered by integrity, the seal is a private attribute that is not
serialized, unsealed traces are rejected, observation/record binding, merge rules, placeholders for missing
model outputs, `INCOMPLETE` semantics). Tests: `tests/replay/test_replay_update.py`,
`tests/replay/test_review_replay_traces.py`.

Already ported: canonical, jsonschema, guards, efsm, pkg, clauses, validate, compile, fixture, kernel, store,
policy, approvals, fakes. `HX.service`/`HX.env` are being ported **in parallel** (`export_run_trace` needs them).
Reference them only inside function bodies. Your goldens use traces produced by **Python**, while JS
`export_run_trace` parity is verified in Wave 4.

## Notes
* Trace JSONL text must be byte-identical to Python's `to_jsonl` (`json.dumps(sort_keys=True,
  ensure_ascii=False)` with default separators `", "` and `": "`). Implement a Python-compatible
  `json.dumps` (`sort_keys=True`, default separators) in your module, or as `HX.traces.py_json_dumps`.
* Python's private `_seal` attribute (the digests captured at seal or load time) needs an equivalent that is not
  part of the serialized trace: use a non-enumerable property or a WeakMap.
* `no_external_calls()` in the browser must temporarily replace `globalThis.fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource` and `navigator.sendBeacon` (where present) with functions that throw
  `ExternalCallAttempted`, and restore them in a `finally`. In Node, also cover `fetch` (the `node:net`
  equivalent is not reachable from engine scripts).

## Golden (gen_traces.py)
* Python-exported traces from real runs (happy path, conflict to review, repairs exhausted, fallback,
  missing documents on the refined package).
* The reference traces (`missing_docs_trace`, `shortcut_trace`, `forbidden_write_trace`,
  `duplicate_write_trace`).
* At least 300 seeded mutations of those traces: records dropped, swapped, duplicated and altered; outputs
  changed; observations stripped; header fields edited; merged lids; noise records; unknown kinds; tampering
  with and without resealing; unsealed traces.

For each, record:
* `to_jsonl` text and `from_jsonl` integrity errors;
* `normalize` events and dropped records;
* `eligibility` violations;
* `replay_structural` and `replay_recorded` reports (deep-equal `to_json()`), against both the initial and
  refined packages where relevant.

## Done when
`node test/run.mjs` passes as a whole and every trace vector matches exactly.
