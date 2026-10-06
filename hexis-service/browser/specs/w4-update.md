# Wave 4 — refinement: `66_update`, `70_reference` and cross-module parity

Already ported (use, don't edit): everything in `src/` up to `64_replay` and `75_env`, including `HX.traces`,
`HX.normalize`, `HX.replay`, `HX.registry`, `HX.service`, `HX.metrics` and `HX.env`. Read their deviation
notes in `browser/deviations/` before starting.

## Agent "update" owns
* `browser/src/66_update.js` (`HX.update`). Port `traces/update.py` in full:
  - `MAX_ATTEMPTS`;
  - the `UpdateProposal` shape with `to_json()`;
  - `apply_ops(parent, ops, trace_ids)`, `policy_widening(parent, cand)`,
    `evaluate_candidate(parent, cand, trace, protected, negative, catalog, skill_text)` and
    `propose_update(parent, trace, protected, negative, catalog, aligner, skill_text)`;
  - `archive_manifest(protected, negative)`, `manifest_digest(protected, negative)`;
  - every private helper (`_validate_ops` and so on), with the same op vocabulary, error strings, gate names,
    gate JSON shapes and attempt bookkeeping. An aligner is any object with `model_id` and
    `propose(context) -> ops`.
* `browser/src/70_reference.js` (`HX.reference`). Port `demo/reference.py` in full:
  - `TOOL_WRITES`, `ReferenceExecutor`;
  - `missing_docs_trace()`, `shortcut_trace()`, `forbidden_write_trace()`, `duplicate_write_trace()`;
  - `REQUEST_INPUT_OPS`;
  - `FixtureAligner`, `ShortcutAligner`, `BreakingAligner`, `MismatchAligner`.

  It uses `HX.fakes` and `HX.traces` exactly as Python uses `fakes` and `traces.model`.
* `browser/golden/gen_update.py` and `golden/update*.json`, plus `browser/test/66_update.test.js`,
  `70_reference.test.js`, `69_integration.test.js` and `browser/deviations/update.md`.

## Parity anchors (all must hold)
1. `HX.update.propose_update(initial, HX.reference.missing_docs_trace(), [], [], catalog, new FixtureAligner(),
   skill_text)`:
   - `candidate.artifact_hash === HX.data.python_build.refined_artifact_hash`;
   - the whole `to_json()` deep-equals Python's, including diff, gates, attempts and diagnostics.
2. Each reference trace's `to_jsonl()` is byte-identical to Python's, and its header and records digests match.
3. The demo's step 6b (shortcut):
   - `propose_update(refined, shortcut_trace(), protected, [], …, ShortcutAligner)` deep-equals Python's
     (status EXCLUDED with the same diagnostics);
   - `evaluate_candidate(refined, apply_ops(refined, ShortcutAligner.propose({})), …)` gates deep-equal
     Python's, including the ORDERING_VIOLATION counterexample path and `negative_corpus.now_representable`.

## Golden (gen_update.py)
* Every reference trace times every aligner (Fixture, Shortcut, Breaking, Mismatch), against the initial and
  the refined parent, with these protected/negative archive combinations:
  - empty;
  - the demo's protected runs (export them from Python runs under `_common.deterministic_uuids()` with
    `ManualClock(1790000000.25)` and timer `0.125*n`, and dump them as JSONL so JS loads the identical traces);
  - the shortcut trace as negative.

  Record `to_json()`.
* `apply_ops` vectors:
  - every op kind valid and invalid (each `_validate_ops` error path);
  - bad indices, unknown states and variables, duplicate states;
  - `match` and `ignore` semantics;
  - coverage edits.

  Record the resulting package hash or the error list.
* At least 200 seeded random mutations of a candidate's execution policy and contracts for
  `policy_widening`, recording the findings lists.
* `archive_manifest` and `manifest_digest` for several archives.

## Cross-module parity (`69_integration.test.js`)
Wave 3 verified `HX.traces`, `HX.replay`, `HX.service` and `HX.registry` separately. This wave proves they agree
with Python when composed. Extend `gen_update.py`, or add `gen_integration.py`, to run these in Python under
deterministic ids, clock `1790000000.25` and timer `0.125*n`:
* For each runtime scenario that ends terminal (happy path, conflict to review, repairs exhausted, fallback,
  missing documents on the refined package): `export_run_trace(service, run_id, principal, verdict)`. The JS
  `HX.traces.export_run_trace` output must be byte-identical (`to_jsonl`) after replaying the same scenario
  script through `HX.env.build_env` with the same id source, clock and timer.
* `HX.registry.admit` with non-empty archives (protected and negative traces from above), including:
  - a candidate that breaks a protected trace (the BreakingAligner candidate);
  - a stale parent (CAS conflict);
  - a policy-widening candidate;
  - the legitimate refinement.

  The AdmissionResult must deep-equal Python's, as must the active and archive pointers afterwards.
* `HX.registry.enroll_protected` with eligible and ineligible traces (the shortcut and the forbidden write).
  The results and archive versions must deep-equal Python's.

## Done when
`node test/run.mjs` passes as a whole, all three parity anchors hold, and every integration vector matches.
