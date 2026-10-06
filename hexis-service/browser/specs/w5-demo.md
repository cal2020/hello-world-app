# Wave 5 — the narrative and the evaluation: `80_demo`, `90_eval`

Everything else in the engine is ported and verified. Read `browser/deviations/*.md` first.

## Agent "demo" owns
* `browser/src/80_demo.js` (`HX.demo`): a stepwise port of `demo/procurement_demo.py::run_demo`, for the lab's
  guided tour. Python writes files and calls `say()`. The JS port returns the same information as data:
  ```
  const d = HX.demo.create({scenario = "full", clock_start = 1790000000.25, ids, timer})
  d.steps            // [{id: "1", title}, {id: "2"}, {id: "3"}, {id: "4"}, {id: "5"}, {id: "6a"}, {id: "6b"}]
  d.next()           // runs the next step -> {id, title, lines: [say lines], facts: {...}, artifacts: {name: data}}
  d.run_all()        // runs the remaining steps and returns the summary dict
  d.done, d.summary, d.ctx   // ctx: {env, pkg, refined, run_ids, protected, negative, ...} for the UI to inspect
  ```
  Step boundaries follow the `say("== N. ...")` headings. Step 4 still approves and runs when the scenario
  injects no fault, as in Python. `artifacts` holds every file Python writes, keyed by the relative path
  (`initial_package.json`, `traces/<id>.jsonl`, `coverage.md`, …). JSON files are parsed values. `.jsonl` and
  `.md` files are exact text. The final `== done. Artifacts in … ==` line becomes `== done ==`.
  Python's `env.restart()` is `Env.restart()` in JS (same store data via `reopen()`, same ERP object).
* `browser/src/90_eval.js` (`HX.eval`): port `evals/run_eval.py`:
  - `dev_overlap`, `run_task` and `summarize`;
  - `run_eval({tasks = HX.data.heldout_tasks, clock_start = 1790000000.25, ids, timer})`, returning the
    `result` dict. Its `environment` is `{runtime: "browser", engine: HX.VERSION}` instead of Python's
    interpreter, platform and commit;
  - `report_markdown(result)`, which produces the same lines as Python's `report.md`.

  Python decides between `.2f` and `str` formatting by `isinstance(v, float)`. JS cannot tell `1.0` from `1`,
  so format the ratio metrics (business_success, procedural_conformance, terminal_honesty, fallback_rate,
  failure_fallback_rate, mean_steps) as `.2f` and the counts as integers. Document this in the deviations
  note, and make sure the output equals Python's report for the golden run.
* `browser/golden/gen_demo.py`, `gen_eval.py`, `golden/demo*.json`, `golden/eval*.json`,
  `browser/test/80_demo.test.js`, `90_eval.test.js`, `browser/deviations/demo.md`.

## Golden
Run Python's `run_demo` for scenarios `full` and `timeout-after-commit` (and any other scenario the function
supports) under:
* `_common.deterministic_uuids()`;
* `procurement_demo.ManualClock` monkeypatched to start at `1790000000.25`;
* `time.perf_counter` patched to the `0.125*n` fake timer, wherever the service takes its default timer
  (check how `build_env` wires it);
* a temporary `out_dir`.

Record:
* the `say` lines, grouped by step heading;
* the returned summary;
* every written file: JSON parsed and normalized with `_common.ints`, other files as text.

Run `evals/run_eval.py`'s logic with the same patches (import its functions; don't shell out) and record the
result (without `environment`) and the report lines (without the commit line).

## Parity (all must hold)
* For each scenario, the JS step lines, artifacts and summary deep-equal Python's. Normalize only the out-dir
  path text and the done line.
* `HX.eval.run_eval()` deep-equals Python's result (minus `environment`), including every per-task row and
  `task_set_digest`. `report_markdown` equals Python's report lines, except the commit line.
* Performance: `run_all()` and `run_eval()` each finish in under 3 s in Node on this machine (they will run in
  the browser). Report the timings.

## Done when
`node test/run.mjs` passes as a whole and every parity item holds.
