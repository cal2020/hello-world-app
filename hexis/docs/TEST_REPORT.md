# Test and evaluation report

Environment: Linux 6.18, Python 3.11.15, standard library only. Fixture mode throughout.

| Command | Result |
|---|---|
| `python3 -m unittest discover -s tests` | **93 tests, OK** (~5 s) |
| `./hexisctl --data <dir> demo procurement-onboarding` | all steps as described in README; `demo_report.json` written; two runs give identical transcripts (`TestDemo`) |
| `python3 evals/run_eval.py` | see below; `evals/report.json` |
| upstream baseline (scratch checkout, `96be271`) | partial: 234 test markers, 4 skipped, no failures shown; summary line not captured (see SOURCES.md) |

Suites: `test_static` (compile, structure, guards, ordering, mutations), `test_kernel` (pure reducer,
bounds, determinism, randomized property walks), `test_runtime` (happy path, inputs, model boundary,
approvals, crash injection at every boundary, reconciliation, stale workers, evidence, cancellation,
security, revocation), `test_replay_update` (replay modes, normalization, eligibility, refinement,
A14/A15/A17/A18), `test_contracts_cli` (schemas vs real artifacts, CLI exit codes, demo),
`test_review_regressions` (below).

## Held-out evaluation (fixture mode, 10 tasks, hand-written oracles)

| Arm | Business success | Procedural conformance | Terminal honesty | Duplicate writes | Tool / model calls |
|---|---|---|---|---|---|
| ReAct baseline | not run (needs a live model) | – | – | – | – |
| Initial machine | 9/10 | 10/10 | 10/10 | 0 | 46 / 8 |
| Refined machine | 10/10 | 10/10 | 10/10 | 0 | 48 / 8 |

The one initial-machine miss (H10) is a transient read-back failure ending honestly at
`END_UNVERIFIED`; the refinement (from a development trace, not from H10) adds a bounded retry.
These numbers are bounded engineering evidence on synthetic tasks; they are not a measure of model
quality and are unrelated to the paper's reported gains.

## Independent review findings (all fixed, each with a regression test)

An adversarial review of the first commit (`aba06d6`) found eight defects. All eleven regression tests
in `test_review_regressions.py` fail when run against that commit's source and pass now.

| # | Defect | Fix |
|---|---|---|
| 1 | promoting a successor reset a revoked version to `admitted` | lifecycle is never demoted; `active` is per-tenant; revoked is terminal |
| 2 | `admit_update` did not check the proposal's parent and fabricated a replay report | parent must equal the expected parent; archive is replayed inside `admit_update` |
| 3 | integer-vs-float guard domains unsound (false PROVEN) | floor/ceil points for non-integer literals |
| 4 | disjointness used a contract enum the runtime did not enforce | domains come from the enforced schema; mismatch is `ENUM_NOT_ENFORCED` |
| 5 | crash after the verifier receipt lost evidence on dedupe | deduplicated outcomes return the issued evidence receipts |
| 6 | structural replay accepted model/user outputs the kernel rejects | same schema/label/ownership checks as the kernel |
| 7 | `start_run` ignored the tenant's active pointer | tenant-scoped activeness check |
| 8 | validator ignored the kernel's implicit fallback edges | implicit edge from model/judge/user states to fallback in all graph checks |
| minor | evidence policy-version invalidation not enforced; dedupe before auth; approval response and checkpoint in separate transactions | enforced at terminal; auth first; single transaction |
