# API notes from engine wave 5 (HX.demo, HX.eval)

HX.demo (src/80_demo.js):
- `HX.demo.create({scenario='full', clock_start=1790000000.25, ids, timer, say})` returns a Demo.
- `d.steps` is always 7 entries: [{id, title}] for ids 1, 2, 3, 4, 5, 6a, 6b.
- `d.next()` returns {id, title, lines, facts, artifacts} and throws HXError 'StopIteration' when the demo is done.
- `d.run_all()` returns the summary.
- Other properties: `d.done`, `d.cursor`, `d.results`, `d.lines` (all lines so far), `d.artifacts` (all files so far, snapshots), `d.summary` (null until done).
- `HX.demo.run_demo(opts)` returns {summary, lines, artifacts, steps} in one call. `HX.demo.SCENARIOS` is ['full', 'timeout-after-commit']; any other name runs without a fault.
- Step 4 has no heading line when no fault is injected (Python prints none), but it still approves and runs.
- One line in step 6b (each static-gate entry) contains '\n'.
- `d.ctx` holds live engine objects; treat it as read-only. Keys: env (the restarted Env after step 3; use it for the tour's HXUI.lab.env = d.ctx.env), pkg, comp, adm, alice, run_ids {main, conflict, refined}, ix, protected (traces), negative, dev, prop, refined, adm2, enr, sc, p_sc, cand, gates, active_before, active_after, summary.
- Each demo builds its own in-memory env, so two demos never share state.

Useful facts per step:
- 1: compile_status, attempts[{attempt, status, codes}], artifact_hash, review_required, admission, archive_version.
- 2: run_id, status, interaction_id, scope_digest, tool, args_digest.
- 3: self_approval_refused, detail, sod_outcome, sod_reasons.
- 4: fault_injected, status, erp_drafts, reconciliation_events.
- 5: status, terminal, verification_scope, conflict_run_id, conflict_terminal, conflict_category, protected_trace_ids, enrollment, archive_version.
- 6a: proposal, gates {name: passed}, admission, parent_hash, refined_hash, refined_run_id, refined_first_status, refined_status, refined_terminal.
- 6b: eligibility, diagnostics, static_gate_passed, violations[{message, path}], negative_gate_passed, now_representable, active_before, active_after, active_unchanged.

HX.eval (src/90_eval.js):
- `HX.eval.run_eval({tasks = HX.data.heldout_tasks.tasks, clock_start, ids, timer})` returns Python's result dict.
  - `tasks` may also be the {tasks: [...]} file object.
  - `ids` defaults to make_seq_ids(1).
  - `environment` is {runtime: 'browser', engine}.
  - It runs synchronously in about 200 ms. Wrap it in a setTimeout so the UI can paint first.
  - For the 'ran 2 x N tasks' copy, N = result.arms.initial_compiled.summary.tasks.
- `HX.eval.report_markdown(result)` returns the report.md text; `report_lines(result)` returns the lines. It can throw KeyError when no task is strictly held out (as Python does).
- Exports: dev_overlap(task, dev_trace), run_task(env, pkg_dump, task), summarize(rows), fmt2(v) (Python '.2f'), RATIO_METRICS (format these with fmt2 and the counts with plain integers), MODE, NOTE, NOT_RUN.
- Errors are HXError with Python class codes (KeyError, TypeError, AttributeError). A malformed task (e.g. an input-requesting task without responses) throws KeyError 'responses', as Python does.

Golden: generators gen_demo.py and gen_eval.py; golden files demo.json (575 KB) and eval.json (304 KB). Both use seq_uuids, not deterministic_uuids.

I edited no shared files and ran no state-changing git commands. The bundle builds with both new modules (checked with build.py --out to a scratch directory).
