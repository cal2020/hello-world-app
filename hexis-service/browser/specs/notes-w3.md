# API notes from engine wave 3 (HX.broker, HX.service, HX.metrics, HX.registry, HX.env, HX.traces, HX.normalize, HX.replay)

## runtime

New internal and public helpers:
- HX.metrics.py_fsum(xs): Python 3.12 sum() over floats. Returns the int 0 for []. Use it wherever a Python float sum() is ported.
- HX.service._scope_digest(scope): the approval scope digest with expires_at hashed as a Python float. Any code that recomputes an approval scope digest (UI, update or replay modules) must use it instead of HX.approvals.scope_digest or HX.canonical.digest. Otherwise digests diverge whenever clock() + approval_expiry_s is integral, for example with ManualClock() at 1790000000.0.
- HX.broker._validate_against(schema, value): python-jsonschema verdicts and error order. It is the same function as before; its errors are now reordered like Python's.
- HX.broker._py_error_order(schema, value, js_errs): the reordering step on its own.
- HX.metrics._keys_of(section, sorted): returns a report section's keys in Python's order.

metrics.collect() reports carry a non-enumerable Symbol key order on by_model/by_state/by_tool/per_run, and render_prometheus uses it. UI code that iterates a report section and wants Python's order (for example, integer-like state ids) should use HX.metrics._keys_of(section, true) for by_* and (per_run, false) for per_run, not Object.keys. JSON copies lose the symbol. by_* then falls back to code-point order, which is correct, but per_run falls back to object order.

registry._utc_isoformat, and therefore admit(), now throws HXError with code ValueError, OSError or OverflowError for timestamps outside Python datetime's range.

The golden interpreter in test/50_broker.test.js has new ops:
- "timer" {base, step}: changes the FakeTimer to base + step*n.
- "append_timing" {run, event}: appends a raw TIMING event.
- resume now accepts "response_json" (JSON text, so key order is preserved).

## traces

- HX.traces.from_jsonl, HX.normalize.normalize/eligibility and HX.replay.replay_structural/replay_recorded can now throw HX.HXError with code 'KEY_ORDER_UNKNOWN' (JS-only). This happens for traces whose printed dict values (task_id with no stored trace_id, output.status, meta.logical_action_id, an unrecognized action.kind, record fields in divergence reasons) have integer-like keys. UI and service code that loads or replays user-supplied traces should treat this like a load or replay error: show it, never treat it as PASS. Python-exported traces always store trace_id in the header, so the trace_id case cannot occur for them.
- New helpers in HX.traces: _key_order_lost(keys) is the shared predicate. _py_repr(v) and _py_str(v) are strict and may throw KEY_ORDER_UNKNOWN. _py_repr_msg(v) is lenient and meant only for exception message text.
- New HX.replay._py_int(v) is Python int() with Unicode decimal digits, from CPython 3.12's table. It is used for the structural-replay counter `int(cur or 0) + 1`. HX.kernel._py_int is unchanged and still ASCII-only, as kernel.md documents.
- golden/traces.json has two new keys: `key_order` (Python results for the 5 deviation texts) and `py_int` (695 [string, int|null] pairs). There are also new packages mini_counter_w and mini_counter_init, and new bases counter_w_0..11 and counter_icp_0..11.

