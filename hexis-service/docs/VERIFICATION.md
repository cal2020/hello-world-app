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

`python evals/run_eval.py` → `evals/results/report.md`. It runs 7 synthetic tasks with 1
deterministic repeat. **Only 6 of them are held out:** `H3-missing-then-supplied` is the development
trace's own case (same supplier `SUP-40002`, same supplied document `DOC-LATE-40002`) that the aligner
was given to derive the refinement. The runner detects this overlap and reports the strictly held-out
subset separately.

| Metric | initial compiled | trace refined |
|---|---|---|
| business success, all 7 tasks (independent oracle) | 0.86 | 1.00 |
| business success, 6 strictly held-out tasks | 1.00 | 1.00 |
| procedural conformance | 1.00 | 1.00 |
| terminal honesty | 1.00 | 1.00 |
| duplicate writes | 0 | 0 |
| fallback rate (fallback-category terminal or failure fallback) | 0.14 | 0.14 |
| failure fallback rate | 0.00 | 0.00 |
| human interactions | 3 | 6 |

- The whole business-success gain (0.86 → 1.00) comes from `H3`, which is the development trace, not a
  held-out task. On the strictly held-out tasks there is **no measured gain**.
- Two tasks differ between arms: `H3` (END_UNVERIFIED with 0 interactions → END_VERIFIED_DRAFT with 2:
  one input request and one approval) and `H7-missing-twice` (END_UNVERIFIED in both arms, but 0 → 1
  interaction: the refined machine asks for input once, then still stops unverified).
- So the refined arm's 3 extra interactions are 2 input requests and 1 approval; only the `H3` ones lead
  to a completed run.
- `H4-registry-conflict` ends at `END_REVIEW`, a fallback-category terminal, in both arms (the 0.14
  fallback rate). No run entered the failure fallback.
- The ReAct baseline arm was **not run** (it needs a live model).
- These are fixture-behavior numbers, not model-quality or production claims, and not a comparison with
  the paper's reported results.

## Not verified

- No live model call.
- No real ERP or enterprise system.
- No PostgreSQL or multi-process workers.
- No performance or latency measurement.

See [LIMITATIONS.md](LIMITATIONS.md).

## Adversarial review round (27-28 Sep 2026)

Method:
1. A 108-agent review workflow ran one reviewer per subsystem. Two independent skeptics per finding then
   tried to refute each claim, using their own reproduction scripts.
2. 51 findings were raised. 36 were confirmed by both skeptics, 13 were contested and 2 were refuted.
3. Five fixers each worked in an isolated git worktree, with a regression test required for every fix.
   An independent verifier re-ran the original reproductions against each fix branch, and a second fix
   round ran wherever the verifier rejected the first.
4. The merged result, and the one partial C28 item the verifier left open (the first update could omit
   accepted traces that were never stored), were closed on the main branch. That closure is
   `registry.enroll_protected`, plus the rule that an update's originating trace must be protected.

The confirmed defects included:
- a stale fenced-off worker overwriting an in-flight write's intent, which enabled a duplicate
  non-idempotent write (critical)
- the approver role taken from the package instead of host policy
- admission trusting a caller-supplied `replay_passed` flag and the package's own execution policy
- terminal freshness checks reusing a pre-crash read
- guard disjointness reported PROVEN for overlapping `in` or large-constant guards
- trace header fields outside the integrity digest

Each has a regression test in `tests/*/test_review_*.py`.

After the merge: `pytest` gives **217 passed, 12 skipped**, and **229 passed** with the pinned upstream
checkout. `ruff` is clean, and `hexisctl demo procurement-onboarding` exits 0. The counts at the top of
this file are from the pre-review commit `f23c6ba`.
