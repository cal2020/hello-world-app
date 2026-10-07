# Deviations: demo narrative and evaluation (wave 5): `80_demo`, `90_eval`

Modules: `src/80_demo.js` (`HX.demo`, a stepwise port of `demo/procurement_demo.py::run_demo`) and `src/90_eval.js`
(`HX.eval`, port of `evals/run_eval.py`).

Parity is proven by two generators that run the real Python code, and two test files:

* `golden/gen_demo.py` runs `run_demo` for the scenarios `full`, `timeout-after-commit` (the CLI's two choices) and
  `no-fault` (any other name: no fault is injected, and Python prints no step-4 heading but still approves and
  runs). Setup: `procurement_demo.ManualClock` starts at 1790000000.25, `time.perf_counter` returns `0.125 * n` on its
  n-th call (`build_env` reads it at call time and `Env.restart` carries it over), gen_runtime's `seq_uuids`, and a
  temporary `out_dir`. It records the `say` lines (flat and grouped by their `== N. ...` heading), the summary,
  every file written outside `state/` (JSON parsed and normalized with `_common.ints`, `.jsonl`/`.md` as text) and
  the number of timer and id draws.
* `test/80_demo.test.js` steps through `HX.demo.create(...)` with the same clock, timer and ids and requires, per
  scenario: the lines grouped by heading equal Python's, the flat lines equal Python's, the summary (returned and
  as `summary.json`) equals Python's, every artifact equals Python's (14 files: JSON deep-equal, JSONL/Markdown byte
  for byte, each file written by exactly one step), and the timer (100 / 100 / 98) and id (8) draw counts equal
  Python's. The only normalization is the final line (below).
* `golden/gen_eval.py` imports `evals/run_eval.py` and runs its `main()` (not a subprocess) under the same clock,
  timer and id patches, with `run_eval.HERE` pointed at a temporary task file and `git rev-parse` answered with a
  fixed commit, for 9 task sets: the held-out set; without the overlapping task; only the overlapping task (the
  report raises `KeyError: 'business_success'` after `results.json` is written); reversed; an 8-task set whose
  ratios are exact binary ties for `.2f` (5/8, 1/8, 8.5); and 4 seeded random sets (perturbed suppliers, documents,
  expectations, oracle fields, responses, duplicate ids), one of which raises `KeyError: 'responses'` inside
  `run_task`. It also records 212 `dev_overlap` vectors (4 development traces × curated and random tasks, including
  `KeyError` cases) and 61 `summarize` vectors.
* `test/90_eval.test.js` requires `run_eval()` to deep-equal Python's `results.json` minus `environment` (every
  per-task row, both summaries per arm, `dev_overlap`, `task_set_digest`, the artifact hashes), the same timer and
  id draw counts, the same exception class and message where Python raises, and `report_markdown` to equal
  Python's `report.md` line for line (with the commit line rendered from the same fixed commit; see #8).

Performance (Node 22 on this machine): `run_all()` of the full demo takes about 110 ms warm (270 ms on the first
call in a fresh realm); `run_eval()` of the held-out set (2 × 7 runs) about 180 ms (210 ms first call).

## Deviations

| # | Area | Python | JS port | Why | Test |
|---|---|---|---|---|---|
| 1 | Output of `run_demo` | writes files under `out_dir` (and SQLite files under `out_dir/state/`), prints lines via `say` | returns the same information as data: `lines`, per-step `{id, title, lines, facts, artifacts}`, `summary`. JSON artifacts are parsed values (Python's `json.dumps(indent=2, sort_keys=True, default=str)` text is not reproduced), `.jsonl`/`.md` artifacts are Python's exact text. There is no `state/` directory | no file system in the browser; the spec asks for data | `80_demo` (every file compared) |
| 2 | Final line | `== done. Artifacts in {out}/ ==` | `== done ==` | there is no out dir | `80_demo` (normalized) |
| 3 | Store and fake ERP backend | SQLite files under `out_dir/state`; `Env.restart()` opens a new `Store` and a new `FakeERP` over the same files | in memory (`build_env` without a workdir); `Env.restart()` reopens the store over the same data (`store.reopen()`, deviations/kernel.md) and keeps the same ERP object (Python's `":memory:"` rule). Observable behaviour is identical: no fault is pending and no call is inspected across the restart in the narrative | the browser has no files, and path-backed JS stores would keep rows in the realm across demos | `80_demo` (all three scenarios equal Python's file-backed run) |
| 4 | Ids and clock defaults | `uuid.uuid4()` (random); `ManualClock()` starts at 1790000000.0 | `ids` defaults to `HX.env.make_seq_ids(1)`, `clock_start` to 1790000000.25 (both overridable); `timer` defaults to the engine's real monotonic timer as in Python | a reproducible narrative for the guided tour; 1790000000.25 is the goldens' clock. With an integral clock the approval scope digest still matches Python (`HX.service._scope_digest`, deviations/runtime.md #2) | `80_demo`, `90_eval` |
| 5 | Step 3's `except Exception` around the self-approval | catches every `Exception` | catches `HX.HXError` (Python-class exceptions, including `RunError`) except `SimulatedCrash` (a `BaseException` in Python); a native JS error is an engine bug and propagates | fail closed: a JS bug must not be narrated as a refusal | — (the refusal path is covered by every scenario) |
| 6 | JS-only additions | — | `steps[i].title` (step 4 is titled "Approve and resume (no fault injected)" when the scenario injects no fault, since Python prints no heading), `facts` per step, `ctx`, `HX.demo.run_demo({...})` | the UI's guided tour needs structured data | `80_demo` |
| 7 | `run_eval` output | `main()` writes `results.json` and `report.md` and prints the report; `environment` = `{python, platform, git_commit, command}` | `run_eval()` returns the result dict; `report_markdown(result)` returns the report text (`report_lines` the lines). `environment` = `{runtime: "browser", engine: HX.VERSION}`. The evaluation env is in memory instead of a temporary SQLite directory (#3); `ids` defaults to `make_seq_ids(1)` and `clock_start` to 1790000000.25 (#4). An exception that Python raises while building the report after writing `results.json` is raised by `report_markdown`, not by `run_eval` | no files or interpreter; the spec asks for this shape | `90_eval` (`only_overlap`) |
| 8 | Report commit line | ``Mode: …. Commit `<sha[:12]>`. Tasks: N. Repeats: 1 (deterministic).`` | ``… Engine `hexis-browser/1`. …`` for a browser result; Python's exact line when `result.environment.git_commit` is a string (e.g. a Python `results.json` loaded into the page) | there is no commit in the browser | `90_eval` (both forms, every variant) |
| 9 | Report number formatting | `.2f` when `isinstance(s0[k], float)`, else `str` | `.2f` for the ratio metrics `HX.eval.RATIO_METRICS` (business_success, procedural_conformance, terminal_honesty, fallback_rate, failure_fallback_rate, mean_steps), `str` for the counts (duplicate_writes, human_interactions, model_calls, tasks). `HX.eval.fmt2` reproduces Python's `.2f` exactly, including round-half-even on exact binary ties (odd multiples of 1/8: 0.125 → `0.12`, 4.625 → `4.62`, 7.875 → `7.88`), where JS `toFixed` rounds away from zero | JS cannot tell `1.0` from `1`; in Python these keys are always floats (`sum(...) / n`) and the counts always ints, so the outcome is identical for every result `run_eval` produces. A hand-made result with an integral float count would print differently | `90_eval` (`eighths`, random sets with 8 tasks, "fmt2 …") |
| 10 | Task ids | any hashable value (`t["id"]` is a dict key) | must be strings: `run_eval` throws `TypeError` otherwise | a JS object key is always a string and integer-like keys lose insertion order; the report takes the overlap list's order from the task rows (first occurrence of each id), which equals Python's dict order for every string id, including integer-like ones | "documented deviation: non-str task ids …" |
| 11 | Integral floats in rows/summaries | `0.0`, `1.0`, `8.0` | `0`, `1`, `8` (DEVIATIONS.md) | one number type | goldens normalized with `_common.ints` |

`HX.eval.dev_overlap` follows Python's `set`/`sorted` semantics for the document ids (`1 == True` hashing,
`TypeError` for unhashable or mixed-type ids, code-point order) and Python's `KeyError`/`AttributeError` for
malformed tasks; `list()` of a dict with integer-like keys raises the JS-only `KEY_ORDER_UNKNOWN`
(deviations/traces.md #7), which cannot occur for list-valued `document_ids`.

## Notes for golden authors

* **Ids.** The spec asked for `_common.deterministic_uuids()`, but under it every run id is `run_0000000000000000`
  and the demo's second run (and the evaluation's second task) fails with `sqlite3.IntegrityError`
  (deviations/runtime.md, "Notes for golden authors"). Both generators therefore use gen_runtime's `seq_uuids`
  (`f"{n:016x}{n:016x}"`, `HX.env.make_seq_ids(1)` in JS).
* The two fault scenarios differ only in the summary's `scenario`; `gen_demo.py` asserts this.
