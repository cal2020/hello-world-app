# UI selftest-tour notes

HXUI.tour = {NEEDS, start(), next(), end(), active(), demo(), status()}. Status values are running | ready | done | error | changed | unavailable. start() no longer fails silently: with modules missing it shows #tour[data-status=unavailable] with HXUI.unavailable(missing) and a Close button, and returns false. While a tour is active it brings the guide back and focuses it instead of discarding it. #tour-restart ('Run the demo again') is the primary action in the error and changed states; #tour-expand opens the collapsed done bar. Bus events: 'tour:step' {id, index, status}, 'tour:learn' {step:'6a', proposal, admission, gates, refined_hash, parent_hash, prop, adm} and {step:'6b', shortcut:{eligibility, static_gate_passed, negative_gate_passed}, active_after, active_unchanged}, and 'tour:end' {}. The same learn payloads are pushed to HXUI.lab.log as {source:'tour', kind:'learn', ...}. Change detection: after each step the tour fingerprints the shared env: the status, checkpoint revision and cancel flag of each demo run, the approval request, the run count, ERP drafts, the clock, the active version, and whether lab.env is still the demo's env. It re-checks on lab:changed, on section:shown, and 30 ms and 400 ms after any click or Enter outside the guide, plus before Next. The Overview marks (data-status, aria-current='step', and a visible span.tour-ov-mark chip inside .ov-step-title) and the #ov-demo-start label ('Continue guided demo' / 'Show the demo's summary', restored on end) are set by the tour. Checks: a check may return {note, digest}, and run() then sets r.digest. P1–P3 return their full digests, which the Detail column renders with HXUI.digest(short 19).

## Open issues

Other groups need to make these changes (I did not touch their files):
1) Run group (app/30_run.js): disable the mutating controls (Step, Cancel, Restart worker, Approve/Reject, +1 h/+25 h) on runs where scenario === 'tour' while HXUI.tour.active() and HXUI.tour.status() is not 'ended', with the reason 'The guided demo is narrating this run. End the demo or let it finish first.' Answering an approval also emits no lab event today. The tour works around this by checking after clicks, but emitting HXUI.lab_changed('runs') after each drive action would be cleaner.
2) Learn group (app/40_learn.js): listen to 'tour:learn' (or read HXUI.lab.log entries with source 'tour'), then show the tour's 6a proposal and admission as 'Last proposal' and in the Admit panel, and the 6b shortcut outcome. Until that lands, the 6a/6b copy no longer says 'Shown in Learn' for those panels. It points only at the active version and the protected archive, and says Learn's own tools run against the now-active refined machine and so report their own results (the done screenshot still shows Learn's own 'NO_CHANGE · A18 setup').
3) Overview owner (app/10_overview.js): replace DEMO_NEEDS with HXUI.tour.NEEDS (it lacks demo, normalize and replay), so Start is aria-disabled with its reason in partial builds. Today the tour shows its own unavailable panel instead, and the tour e2e accepts either outcome. Please also own the step-status text and the Start label, using 'tour:step'/'tour:end'. The tour now inserts span.tour-ov-mark chips into .ov-step-title and relabels #ov-demo-start .hx-btn-label as an interim hook, and re-applies them when the Overview is shown.
Notes on the review items:
- A09's display name still differs from the Python test name, as documented in round 1 because of 10_shell's 'undefined' text filter. The Python name is still in the Detail column.
- 'Ran N checks' now counts pass+fail and states the skips. When skips outnumber passes, the headline turns neutral with the info icon.
- The final ERP count in the env is 2: one draft from the clean intake plus one from the refined machine's run in 6a. The spec's 'one ERP draft' is the step 4/5 count, which the e2e now asserts as exactly 1. The summary row reads s.run.erp_drafts (1).
- Tone rule (documented in the 65_tour.js header): a status chip takes the tone of its own value. Refusals, exclusions and UNCHANGED are neutral. Where a step demonstrates a safeguard, an ok 'As expected' or crit 'Not expected' chip follows. All status chips are upper-case mono.
- Step 3's REFUSED chip requires a refusal code from the approval rules (NOT_AUTHORIZED, SEPARATION_OF_DUTIES, SOD_VIOLATION or SELF_APPROVAL). Any other code shows that code with 'Not expected'.
- The engine-output details opens only at a width of 900px or more, and starts closed at narrow widths.
- The golden-sample chip is neutral.
- Group tables use table-layout:fixed at 900px and up, with the Result column at 8rem and the Time column at 5.5rem, so the Detail column lines up across groups. Below that the tables keep the auto layout so folding still works.

## Final check problems

[
 {
  "severity": "minor",
  "what": "The Learn contradiction is only partly fixed. At step 6a the guide now explains that Learn's own Propose and Admit report their own results, which was the allowed fallback. But in the expanded finished state (on Learn), the summary shows Refinement proposal CANDIDATE and admission ADMITTED, while Learn's summary directly below still reads LAST PROPOSAL NO_CHANGE ('A18 setup') and 'Nothing admitted from this section yet'. The caveat appears only inside the collapsed 'Step 6b' details, so a viewer at rest sees two opposite answers again. 40_learn.js does not consume 'tour:learn' or the HXUI.lab.log entries the tour now publishes.",
  "where": "dist-final-selftest-tour, finished state at 1280 on Learn: /tmp/claude-0/ui-selftest-tour/final/done-1280.png. Code: app/65_tour.js summary_el (rows proposal/admission, tour-sum-foot)",
  "fix_hint": "Add the where_for caveat to the summary foot or to the proposal and admission notes, for example 'Learn's own Propose runs against the now-refined machine, so it reports NO_CHANGE.'. Keep the open_issue that asks the learn group to show the 'tour:learn' payload as the last proposal and admission."
 },
 {
  "severity": "minor",
  "what": "The collapsed one-line 'Guided demo finished' bar shows 'Back to overview' even when the viewer is already on the Overview. The button does nothing there.",
  "where": "/tmp/claude-0/ui-selftest-tour/final/overview-done-1280.png; app/65_tour.js paint_inner (P.back is never hidden)",
  "fix_hint": "Hide #tour-back when HXUI.current() === 'overview', and repaint on section:shown (which already happens for the done state)."
 }
]
