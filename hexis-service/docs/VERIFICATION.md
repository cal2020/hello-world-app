# Verification report

Everything below was executed on 26 Sep 2026 in the Claude Code cloud container (Linux, Python 3.12.3
via `uv`). The environment and commits are recorded so the results can be reproduced.

## Fresh-checkout run (commit `f23c6ba`)

A clean `git clone` of branch `claude/new-session-773av8`, installing only from the lockfile:

```bash
cd hexis-service
uv sync --frozen --extra dev
.venv/bin/python -m pytest                     # 101 passed, 12 skipped in 8.34s
HEXIS_UPSTREAM_DIR=<upstream@96be2719> PYTHONPATH=<upstream>/src .venv/bin/python -m pytest
                                               # 113 passed in 8.43s
.venv/bin/ruff check src tests evals           # All checks passed!
.venv/bin/hexisctl demo procurement-onboarding # exit 0; artifacts in build/demo/
```

The 12 skipped tests are the upstream-conformance tests. They skip only when no upstream checkout is
supplied. Compiled artifact hashes were identical across the development environment and the fresh
clone: initial `sha256:4ba77a16…`, refined `sha256:5b6503fd…`.

## Acceptance matrix (brief §16)

Each ID has at least one named test (`pytest -k test_A07` and so on). All pass.

| IDs | File |
|---|---|
| A01–A04, A08, A11, A17 (static), mutation tests | `tests/conformance/test_static_admission.py` |
| A05–A07, A09, A10, A30 (kernel + hypothesis properties) | `tests/unit/test_kernel.py` |
| A05, A10, A19–A21, A25, A28, A29, A32 | `tests/integration/test_runs.py` |
| A22–A24, A27, crash injection at 5 boundaries | `tests/recovery/test_recovery.py` |
| A12–A18, A30 (recorded), A31 | `tests/replay/test_replay_update.py` |
| A26 and isolation/spoofing | `tests/security/test_security.py` |
| Adapter, CLI exit codes, one-command demo | `tests/unit/test_adapters_cli.py` |
| Upstream format and guard conformance | `tests/conformance/test_upstream_compat.py` |

**Property tests** (hypothesis) cover:
- deterministic transitions under random validation-status sequences
- monotonic counters, with repair entries capped at 2
- stable canonical serialization over random JSON
- soundness of the disjointness proof

**Mutation tests** check that each of these changes is detected by the relevant gate:
- removing the verifier (derived evidence ordering)
- widening the approval guard (`APPROVAL_GUARD_WEAK`)
- letting a model reset a counter (`WRITE_OWNERSHIP`)
- altering a stored approval digest (broker `APPROVAL_INVALID`)
- a verified terminal without evidence

**Crash injection** is parametrized over `after_intent`, `before_dispatch`, `after_remote_call`,
`after_receipt` and `before_commit`. Every point recovers to `END_VERIFIED_DRAFT` with exactly one ERP
draft.

Two findings from writing the tests were fixed in the code or tests before commit, not hidden:
- The property test caught its own fake repair writing outside the field scope. That is the contract
  working as designed; the test fixture was corrected.
- The evaluation harness mapped the "review" oracle to the wrong category name, and that was corrected.

## Upstream baseline

`Worldbuilder013/HEXIS@96be2719`: **230 passed, 4 skipped** (skips need the OpenCode binary). Details
are in [SOURCES.md](SOURCES.md).

## Evaluation (fixture mode, commit `f23c6ba`)

`python evals/run_eval.py` → `evals/results/report.md`. It runs 7 held-out synthetic tasks with 1
deterministic repeat.

| Metric | initial compiled | trace refined |
|---|---|---|
| business success (independent oracle) | 0.86 | 1.00 |
| procedural conformance | 1.00 | 1.00 |
| terminal honesty | 1.00 | 1.00 |
| duplicate writes | 0 | 0 |
| human interactions | 3 | 6 |

- The only difference is `H3-missing-then-supplied`, the case the refinement added.
- The refined arm needs more human interactions: the extra approvals come from runs that now complete
  instead of stopping.
- The ReAct baseline arm was **not run** (it needs a live model).
- These are fixture-behavior numbers, not model-quality or production claims, and not a comparison with
  the paper's reported results.

## Not verified

- No live model call.
- No real ERP or enterprise system.
- No PostgreSQL or multi-process workers.
- No performance or latency measurement.

See [LIMITATIONS.md](LIMITATIONS.md).
