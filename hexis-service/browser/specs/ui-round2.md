# UI round 2: sections wired to the live engine

Round 1 delivered the shell, tokens, components (`HXUI` in `app/05_ui.js`), the Overview, section placeholders and
the state graph (`HXUI.graph`). Round 2 replaces the placeholders with working sections, in groups that start as
soon as the engine modules they need are ported and verified:

| group | starts after | files (owned) | needs |
|---|---|---|---|
| **compile-break** | engine wave 2 | `app/20_compile.js/.css`, `app/50_break.js/.css`, `app/52_mutations.js`, `test/e2e/20_compile.e2e.mjs`, `test/e2e/50_break.e2e.mjs` | `HX.compile`, `HX.clauses`, `HX.validate`, `HX.guards`, `HX.pkg`, `HX.diff`; `HX.registry` (admit) once wave 3 lands |
| **run** | engine wave 3 | `app/30_run.js/.css`, `app/31_scenarios.js`, `app/32_inspector.js`, `test/e2e/30_run.e2e.mjs` | `HX.env`, `HX.service`, `HX.broker`, `HX.policy`, `HX.approvals`, `HX.fakes`, `HX.metrics`, `HXUI.graph` |
| **learn** | engine wave 4 (5 for the evaluation panel) | `app/40_learn.js/.css`, `test/e2e/40_learn.e2e.mjs` | `HX.traces`, `HX.normalize`, `HX.replay`, `HX.update`, `HX.reference`, `HX.registry`; `HX.eval` |
| **selftest-tour** | engine wave 5 | `app/60_selftest.js/.css`, `app/62_checks.js`, `app/65_tour.js/.css`, `golden/gen_selftest.py`, `golden/selftest.json`, `app/embed.json`, `test/e2e/60_selftest.e2e.mjs`, `test/e2e/65_tour.e2e.mjs` | everything; `HX.demo` |

Everyone reads `specs/UI.md` (the specification), `app/05_ui.js` and `app/35_graph.js` (the APIs you build on; their
round-1 API notes are in the header comments), and the engine modules and `browser/deviations/*.md` they call.
The JS engine mirrors the Python API in snake_case, so the Python tests in `../tests/` show how each call is
used. Never edit `src/`, `golden/gen_<engine module>.py`, other groups' files, `05_ui.js` or `35_graph.js`. If
you need a change there, describe it in your report's `open_issues`, or add a small helper to your own file.

Build and test against the full engine: `python build.py --out dist-<group>`, then
`HX_PAGE=dist-<group>/hexis-lab.local.html node test/e2e/run.mjs <filter>`. The whole E2E suite must pass at the
end. Look at your section with screenshots at 1280 and 400 in light and dark (Read every PNG) and iterate until
it is polished.

## Shared lab state
The first section that needs an environment calls `HXUI.lab_env()`, which the run group adds to its own file and
registers as `HXUI.lab_env` if `05_ui.js` doesn't provide it. It builds the environment once and stores it in
`HXUI.lab.env`:
* `HX.env.build_env({clock: new HX.env.ManualClock(1790000000.25), ids: HX.util.make_id_source(1), timer})`;
* the timer is a deterministic counter, like the goldens' `0.125*n`, so displayed latencies are reproducible;
* compile with `HX.compile.compile_procurement()` and admit the initial package (`HX.env.admit_initial`).

The resulting run ids and digests then equal the Python reference's for the same sequence of operations. The
Self-test can show this, and the copy may say so.

`HXUI.lab_reset()` drops `HXUI.lab.env`. Every section listens for `lab:reset` and re-renders its at-rest state.

## compile-break
* **Compile**: everything in UI.md §2.
  - Clause spans come from `HX.clauses`.
  - The compile result comes from `HX.compile.compile_procurement()`: attempts with findings and ORDERING_VIOLATION
    counterexample paths, final hash with a parity chip against `HX.data.python_build.initial_artifact_hash`,
    and the coverage table.
  - The "Admit as user:dana" button calls `HX.registry.admit` once that module exists.
  - The section stores the compile result in `HXUI.lab.compile` and emits `lab:changed`.
* **Break it**: everything in UI.md §5.
  - `app/52_mutations.js` is a catalog of named mutations. Each is `{id, title, why, apply(pkg) -> pkg}`,
    taken from `../tests/conformance/test_static_admission.py` and
    `../tests/conformance/test_review_admission_validator.py` (A02, A03, A04, A08, A11, A17 and the review
    findings), re-expressed in JS.
  - Selecting a mutation shows the before/after of the changed element and runs `HX.validate.validate_package`
    live (with skill text and deployment policy). The finding codes must equal the ones the Python test
    expects; cross-check against the wave-2 validator goldens (`golden/validate*.json`) where the same
    mutation appears.
  - The guard playground uses `HX.guards` (parse, typecheck, evaluate3, analyze_disjoint) with the machine's
    variable types.
* E2E:
  - compile shows 2 attempts and an equal hash;
  - each mutation produces its expected codes;
  - the guard playground's disjointness result for VALIDATE_DRAFT's guards;
  - a malicious guard is rejected without execution.

## run
The Run workbench, everything in UI.md §3.
* `app/31_scenarios.js` defines the scenarios as data, built from `HX.data.task` and the Python tests' variants:
  - clean intake;
  - missing documents (refined machine; disabled with a reason until the refined package is admitted);
  - registry conflict (`SUP-55555`);
  - repairs exhausted (A10);
  - prompt-injection document with the gullible model (A26);
  - custom JSON.
* `app/32_inspector.js` holds the inspector tabs.
* Controls map one to one onto engine calls:
  - `start_run`, `advance_run`, `run_until_blocked`;
  - `env.restart()` (the lab keeps the new env);
  - `cancel_run`, `resume_interaction`;
  - `env.clock.advance`;
  - FaultInjector arm and ERP `inject`;
  - `policy.revoke_capability`;
  - ERP out-of-band modification and tamper, exactly as the A25/A28 tests do them.

  Every call is wrapped. An `HX.HXError` shows its `code` and message inline in the control's result area,
  never as an uncaught error. A `SimulatedCrash` shows as "worker crashed at <point>" with a Restart worker
  call to action.
* The graph (`HXUI.graph.create`) is fed from the run's TRANSITION events on every step.
* The approval panel binds to the interaction scope, as UI.md describes, including the negative demos
  (self-approval refused, mallory not authorized, tampered scope digest refused).
* E2E:
  - the happy path to END_VERIFIED_DRAFT with an approval by bob;
  - self-approval refused with a code;
  - restart while waiting, then resume;
  - timeout_after_commit gives exactly one ERP draft and RECONCILED events;
  - a crash at each FaultInjector point, then restart, then completion;
  - cancel;
  - registry conflict gives END_REVIEW;
  - missing documents (after the learn group admits the refined machine, or by admitting it in the test
    through the engine API);
  - no console errors anywhere.

## learn
Everything in UI.md §4, plus an **Evaluate** panel:
* `HX.eval.run_eval()` on the held-out tasks, initial vs trace-refined: the summary table, the strictly
  held-out table, the per-task table with dev-overlap flags, and the "not run: direct prompting baseline
  (needs a live model)" note.
* Show the timing ("ran 2 × N tasks in X ms in this page").

The section uses the protected runs from the Run workbench when there are any. Otherwise it seeds the archive
as the demo does (a verified run and a registry-conflict run), saying so in the copy.
* E2E:
  - enroll;
  - propose with the missing-docs trace gives CANDIDATE with every gate passing;
  - admit gives ADMITTED, and the active pointer moves;
  - racing two updates gives one ADMITTED and one CONFLICT;
  - the shortcut is EXCLUDED, its candidate's gates fail with an ORDERING_VIOLATION path, and the active
    version is unchanged;
  - the evaluation table renders with business_success for both arms.

## selftest-tour
* **Self-test**: everything in UI.md §6.
  - `golden/gen_selftest.py` writes `golden/selftest.json`: a sample of the Python golden vectors, under
    1.5 MB, embedded via `app/embed.json` as `selftest`. It includes canonical floats and digests, guard
    evaluations, kernel steps, two runtime transcripts and the demo summary.
  - `app/62_checks.js` holds in-browser acceptance checks mirroring A01–A32, one or more per A-number,
    named like the Python tests (e.g. `A20 · changed arguments invalidate approval`). Each runs against a
    fresh env and asserts what the Python test asserts.
  - Results stream into a table in chunks via `setTimeout` (the UI stays responsive), with total counts and
    durations. The section also lists the engine namespaces present.
* **Guided tour** (`app/65_tour.js`): the Overview's "Start" uses `HX.demo.create()`. Each step:
  - shows its narration lines;
  - navigates to the section where the step's effect is visible, and mirrors the demo's env into the lab
    (`HXUI.lab.env = d.ctx.env`, so the Run and Learn sections show the demo's runs);
  - offers Next and Back-to-overview.

  Step 6b leaves the active version unchanged, and the tour says so with the hash.
* E2E:
  - the self-test runs to completion with 0 failures at both widths;
  - the tour runs all steps and the final summary matches `HX.data`-independent expectations (the
    proposal is CANDIDATE then ADMITTED, the shortcut is EXCLUDED, one ERP draft).
