# UI learn notes

All changes are in app/40_learn.js and app/40_learn.css, plus the test.

- **Stale check:** proposal_view sets dataset.now on #ln-proposal to admitted, stale or parent. It is stale only when the active hash differs from both the parent and the candidate. When admitted it shows the ok chip #ln-proposal-admitted and verdict text that matches.
- **Attempts:** the attempt count moved into the result head (#ln-proposal-attempts), so the facts grid is 3 columns.
- **Summary strip:** the eval note reads "initial → refined, all N tasks (K overlaps the dev trace)", and a second line #ln-sum-heldout shows "strictly held out (n): a → b". Below the narrow container width the eval item spans both columns.
- **Per-task table:** the Task column no longer wraps. When folded, CSS on .ln-tasks-table puts each fold item on its own row and hides the separators.
- **CONFLICT text:**
  - Race row: "...rebase onto the new parent and rerun all gates."
  - Admission verdict: the same sentence plus a pointer to the Before/After box.
  - The engine's raw reason is in a title attribute.
- **EXCLUDED:** the copy now reads "Would be added to the negative corpus (this section does not store it)".
- **Race button:** also disabled when the active version is refined, with the existing reason text.
- **Stable ids:**
  - Archive and race digests, normal and folded copies: ln-arch-digest-i, ln-arch-digest-fold-i, ln-race-cand-first/second, ln-race-cand-fold-first/second.
  - Evaluation digests: ln-eval-initial, ln-eval-refined, ln-eval-taskset.
  - Admission digests: ln-admission-candidate, ln-admission-parent, ln-admission-signature.
  - Before/after cells: <pointer id>-before / -after.
  - Summaries: ln-prop-graph-toggle, ln-sc-graph-toggle.
  - The folded digest columns use fold renderers, so the folded copy button works.
- **REJECTED:** drops the diagnostic that only repeats the verdict. Anything left goes under "Engine diagnostics".
- **Shortcut panel:**
  - Step 3 has the gates chip in its own heading row. gates_table(no_title) no longer renders a header row; gates_chip() is shared.
  - The lead copy no longer uses parentheses around the chain.
- **Propose form:** the trace explanation is now the select's hint, so #ln-trace-why is gone.
- **Graphs:** candidate_graph(pkg, {highlight}|{path}, id, summary, title) has a short summary and the full title on the graph. The shortcut draws its path with view.update({current, visited: path_edges(...)}).
  - Views register with the panel being painted, and paint_all destroys them before each repaint.
  - An open disclosure opens again after a repaint (open_graphs set).
- **Static-validation message:** plain_lists() turns Python list reprs into plain text in the UI only; the engine text is unchanged.
- **Errors:** err_of() shows e.msg for HX errors.
- **act():** captures S and drops a queued call when Reset lab replaced S. do_admit throws HXError NO_CANDIDATE when there is no proposal.
- **Evaluate panel:**
  - The not-run block is built from result.not_run, falling back to HX.eval.NOT_RUN, and keeps the "needs a live model" wording plus the engine's reason.
  - The arm count comes from Object.keys(res.arms).length.
  - The mode chip #ln-eval-mode comes from result.mode.
- **Live regions:** #ln-live is removed, and pending() paragraphs no longer have role=status.
- **initial_package():** uses lab.compile.package only when lab.compile.status === 'validated'.
- **Summary without HX.eval:** paint_summary checks engine_missing before reading the evaluation, so it no longer crashes when HX.eval is absent.

## Open issues

1. Shell owner (app/05_ui.js), not changed by me:
   - HXUI.ENGINE_MODULES has no eval entry, so namespace_status('HX.eval') can never report 'failed'. Suggested entry: {prefix:'90', ns:['eval'], ref:'evals/run_eval.py', label:'eval'}.
   - Table fold_copy() clones cells without listeners or ids. A cloned button in a folded row is focusable but does nothing. I avoided this in Learn with fold renderers; a general fix belongs in fold_line (for example, render the cell again instead of cloning it).
2. Test coverage gaps:
   - The whole-section unavailable state (a build without HX.update/HX.registry) and the get_env fallback when 30_run.js is absent are still checked only by hand. The E2E runner tests one page, so a build-variant test needs its own build step; I did not add one.
   - The evaluation-unavailable panel is now covered in the page by removing HX.eval.
3. Static-validation message: the engine's "(after last change to ['draft'])" mirrors Python on purpose. The UI now shows "draft" via plain_lists(); the engine text and its golden data are unchanged.
4. Shortcut graph: the counterexample is drawn with update({current: last state, visited}), so the legend says "current state" for the path's last state (PERSIST_DRAFT). The graph API has no separate "counterexample end" mark.
5. Repainting still rebuilds every panel after any action. Open graph disclosures now stay open, and their views are destroyed and redrawn instead of leaking.
