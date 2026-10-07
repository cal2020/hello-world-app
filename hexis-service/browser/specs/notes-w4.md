# API notes from engine wave 4 (HX.update, HX.reference)

HX.update API:
- MAX_ATTEMPTS.
- UpdateProposal: a class with to_json()/toJSON(). Its candidate is a sealed normalized MachinePackage dump or null.
- apply_ops(parent, ops, trace_ids = null) returns a sealed normalized dump. It throws HXError KeyError/IndexError/TypeError/AttributeError, or EfsmError/PackageError for pydantic failures.
- policy_widening(parent, cand) returns an array of strings.
- evaluate_candidate(parent, cand, trace, protected, negative, catalog, skill_text = null) returns a gates dict with keys policy_non_widening, static_validation, new_trace_replay, protected_replay, negative_corpus and passed.
- propose_update(parent, trace, protected, negative, catalog, aligner, skill_text = null).
- archive_manifest(protected, negative) and manifest_digest(...).
- _validate_ops(parent, ops, events, catalog).
- Helpers: _hkey, _item, _is_validation_error, _COVERAGE_RANK, HELD_OUT_NOTE.

Input handling:
- Packages may be raw or normalized dumps. They are normalized on entry, so an invalid one throws PackageError.
- An aligner is any object with model_id and propose(context) returning ops. The context holds fresh copies of machine, events, dropped and clauses. divergence and diagnostics are shared, as in Python.

KEY_ORDER_UNKNOWN: propose_update and _validate_ops can throw it, as can any trace function. UI code should treat it, and any throw, as a failed proposal and never as a candidate.

HX.reference:
- TOOL_WRITES and REQUEST_INPUT_OPS. REQUEST_INPUT_OPS is a shared mutable constant in Python's key order; do not mutate it.
- ReferenceExecutor(tenant = "acme") with tool, model_step, user, end, happy_tail and trace. ctx is a plain object.
- missing_docs_trace(), shortcut_trace(), forbidden_write_trace() and duplicate_write_trace(). Each returns a fresh sealed trace and builds its own fakes, so each takes a few ms.
- FixtureAligner, ShortcutAligner, BreakingAligner and MismatchAligner. model_id is both static and per instance.

HX.registry already uses HX.update.archive_manifest when present; the manifest is identical to its fallback.

Performance (Node):
- propose_update of the fixture refinement takes about 30 ms.
- compile_procurement takes about 65 ms.
- The whole golden grid of 460 proposals takes about 4 s.

The demo-ready sequence for w5 is in golden/gen_update.py INT_DEMO and test/69_integration.test.js do_upd. It covers protected runs, enroll, propose, admit_cand, the refined live run, the shortcut proposal and evaluation, and enrolment.

Test helpers on globalThis.UPD (from 66_update.test.js):
- fixtures(): the initial package, the JS-built refined package, reference and protected traces, archives and catalog.
- ALIGNERS (including VariantAligner), ScriptAligner and fake_context.
- same(got, want, label): canonical comparison with the documented relaxations.
- exc_class.

69_integration reuses globalThis.RT_RUNTIME.do_op and first_diff from 50_broker.test.js.
