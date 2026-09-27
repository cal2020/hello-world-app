# Limitations

## What a pass here does and does not establish

| Claim | Established by this build? |
|---|---|
| The admitted machine's guards are well-typed, disjoint and default-last; reads are definitely assigned; writes are owned; mandatory steps cannot be bypassed on the graph | yes, for the checks listed in `validator.py` (conservative graph analysis; guard feasibility is not used to prune paths) |
| The kernel reproduces recorded runs exactly | yes (recorded replay) |
| The machine can represent the protected traces | yes (structural replay) — this is compatibility with recorded paths, **not** proof of future correctness |
| No duplicate ERP draft after crashes/timeouts | yes **against the fake ERP**, whose reconciliation-by-reference contract is assumed; a real ERP must provide it |
| Extracted supplier facts are correct | **no**. The validator checks that each field cites a verbatim quote from a supplied document; it does not check that the quote supports the value (e.g. `country: DE` citing `Country: Germany` passes). Held-out oracles measure extraction on 3 fixture documents only |
| Live model quality, cost, latency | **no**. Only fixture models were run; cost is reported as unknown |
| Every natural-language requirement was extracted | **no**. Coverage classification comes from a recorded fixture; missing or ambiguous requirements stay invisible (the paper's stated limitation) |
| Production authentication, signatures, secrets management | **no**. Principals are simulated; admission signatures use a local HMAC key unless `HEXIS_ADMISSION_KEY` is set |

## Implementation gaps

* **Compiler and alignment models are fixtures.** `FixtureCompilerModel` replays recorded drafts and
  `DeterministicAligner` has no model. The live `AnthropicMessagesAdapter` exists for state-local
  generation only and was never executed; there is no live compiler-model adapter.
* **ReAct baseline arm not run** (requires a live model). The eval compares initial vs refined machine only.
* **SQLite only.** No PostgreSQL adapter, no multi-worker scheduler, no lease expiry/heartbeat
  (a new lease simply fences out the old one).
* **Policy model is small**: roles → capabilities, tenant business units, approver role, self-approval
  ban, expiry. No transaction limits, segregation-of-duties matrices or external policy engine.
* **Guard disjointness** is proved only for booleans, declared enums and integer/string variables
  compared against literals; `number` variables and variable-to-variable comparisons are `UNKNOWN`
  and therefore rejected in production.
* **Aligner** can add a guarded edge to an existing compatible state or a bounded self-loop; it does
  not create new states or new generation states (the paper's "input gate").
* **Evidence invalidation** is checked at terminal admission by re-reading the ERP record; there is no
  background invalidation on source-document change, and approvals are invalidated by digest mismatch
  rather than by an explicit event.
* **Trace eligibility** rules are specific to this skill's approval/verification constraints
  (`traces.eligibility`); a general rule language is not implemented.
* **Observability**: events carry the fake clock; no latency histograms, token cost or spend budgets.
* **Upstream baseline** is partial (see SOURCES.md); the upstream example was not run.
* The paper was not read directly; paper-attributed mechanisms rely on the brief's summary.
