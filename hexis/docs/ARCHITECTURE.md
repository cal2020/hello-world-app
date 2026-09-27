# Architecture and trust boundaries

Labels used below (brief section 2): **[paper]** mechanism described in the HEXIS paper,
**[upstream]** behaviour observed in the reference repository at commit `96be271`, **[extension]**
required by the brief and not established by the paper.

```
 SKILL.md + trusted tool catalog + contracts + policy
            │
            ▼
   compiler.py  (clause index, coverage, draft → validate → repair ≤3)      proposal only
            │
            ▼
   validator.py + traces.structural_replay  (admission gates)               no execution of artifact code
            │
            ▼
   registry.py  (immutable version, signed admission, CAS active pointer)   the only path to "active"
            │
            ▼
   runtime.py ──► kernel.py (pure reducer)                                   decides the next state
      │   │
      │   ├─► models.py      state-local generation only; no tools, no machine, no history
      │   └─► broker.py ──► connectors.py                                    fence → policy → approval → dispatch
      │         ▲
      │         └── authority.py (policy, approvals, evidence)                not writable by compiler/updater/model
      ▼
   store.py (checkpoints, events, observations, intents, receipts, approvals, evidence)
            │
            └──► traces.py / update.py  (export, eligibility, replay, refinement proposals)
```

## Component contracts

| Component | Owns | Must not own (enforced by) |
|---|---|---|
| `compiler.py` | states, local prompts, bindings, guards, clause map | credentials, active pointer (never touches the registry) |
| `validator.py` / `registry.py` | static findings, admission record, lifecycle, CAS promotion | task execution (it never runs artifact code; guards are parsed, not evaluated by Python) |
| `kernel.py` | state, transition selection, counters, checkpoint evolution | I/O of any kind (module imports no network, DB or clock) |
| `models.py` | generation/classification for one state | tools, authority fields (kernel rejects extra keys and engine-owned writes) |
| `broker.py` | fenced dispatch, policy/approval check, receipts, reconciliation | trusting model claims (approval comes only from `ApprovalService`) |
| `authority.py` | authenticated approvals, deterministic policy, evidence receipts | untrusted document content as approval |

## Execution semantics (kernel.py)

* One action per state visit. The orchestrator performs the action outside any DB transaction, builds
  a recorded observation, calls `kernel.apply`, and commits checkpoint + event + observation in one
  transaction guarded by the expected revision and the worker's fencing token.
* Guards: declaration order, default last, first enabled wins; guards see the action's outputs and the
  *old* counter; the chosen edge's `inc` applies after selection **[upstream]**. Undefined variables and
  type mismatches raise `GUARD_ERROR` and stop the run — never the default edge **[extension, A09]**.
* Loop bounds are enforced by the engine (`LOOP_BOUND_EXCEEDED`) in addition to guard conditions.
* Invalid model/judge/user output → the fallback state, recorded permanently in
  `assurance.entered_fallback`. In the production profile the fallback is an end state (stop for
  review) and admission rejects any write reachable from it.
* Tool `unknown_effect` → status `RECONCILING`, no transition; the runtime reconciles by business
  reference before any resend.
* Entering an end state is a *request*: required outputs, current evidence (re-read from the ERP) and
  unresolved effects are checked before `COMPLETED`.
* Status and outcome are separate: `status` ∈ READY … CANCELLED; `outcome` = exact terminal id + kind;
  `assurance` = fallback entry, missing evidence, unresolved/disclosed effects, verification scope.

## Guard language (guards.py)

Python-expression syntax parsed with `ast` and interpreted by an allowlist: names, literals,
`and/or/not`, same-type `==`/`!=`, numeric ordering, membership in a literal list, `is_empty(x)`.
Attribute access, subscripts, calls other than `is_empty`, comprehensions, lambdas and arithmetic are
rejected at parse time; length, AST depth and literal sizes are bounded. Disjointness is decided by
exhaustive evaluation over representative domains (booleans, declared enums, integer/string values
compared only against literals); anything else is `UNKNOWN`, which the production profile rejects.

## Durable effects (broker.py, runtime.py)

1. Intent recorded (logical action id, canonical argument digest, idempotency key, business reference).
2. Claimed under a worker lease; the fencing token is checked by the broker *and* at commit.
3. Policy (tenant, capability, business-unit scope) and, for approval-bound tools, an approval bound
   to the logical action id + argument digest + tool version + policy version + evidence values,
   re-checked for expiry and approver authority.
4. Dispatch with the stable idempotency key. Reads get bounded transport retries; a write timeout is
   `unknown_effect`.
5. Receipt stored; verifier results issue an evidence receipt bound to draft ref, version and payload hash.
6. Kernel transition committed.

A write's logical action id is derived from the run, state and argument digest, so re-visiting a
state with identical arguments reuses the same logical action, while a changed draft is a new
intent that needs a new approval.

Crash points can be injected between each boundary (`after_intent`, `after_dispatch_before_receipt`,
`after_receipt_before_commit`, `after_timeout_before_receipt`). The invariant tested is *no silently
duplicated logical effect*, not universal exactly-once delivery.

## Refinement (update.py)

Staged alignment **[paper]**: filter by kind/tool/phase/terminal; prefer the divergent state itself or
states reachable through zero-width states; other compatible states only in the first attempt. New
edges are guarded on enum-typed outputs observed in the trace; a repeat becomes a bounded self-loop
with bound `ceil(1.5 × observed repeats)` **[paper heuristic]** clamped to `max_loop_bound`
**[extension]**. Gates in order: static validation, replay of the new trace, replay of **every**
protected trace, negative corpus, policy diff (no new reachable tools, no removed approval /
ordering / evidence requirement, no raised loop bound, no policy/catalog change). ≤2 attempts.
Acceptance publishes the candidate and the new archive manifest with a CAS on the active pointer.

## Intentional differences from upstream (and their tests)

"Verified" means the behaviour was read in the pinned source by this implementation; "per brief"
means it is taken from the brief's findings table and was not re-verified here.

| Upstream (96be271) | Source | Here | Test |
|---|---|---|---|
| extra JSON keys are ignored (pydantic default; no `extra="forbid"` on machine models) | verified, `machine/schema.py` | rejected (`MachineFormatError`) | `test_static` A02 |
| `init_from` takes only the last path segment | verified, `machine/schema.py:381` | explicit JSON Pointer `selector`; missing input fails | `test_runtime` A05 |
| `fill_template` resolves a missing `${var}` to `None` (whole value) or `""` (inside a string) | verified, `execution/runtime.py:333-339` | unset/undeclared → `InputBindingError`, no dispatch; partial placeholders rejected | A05 |
| runtime selects the first enabled edge even if structural checks flag overlap | per brief | overlapping or unprovable guards block admission | A08 |
| `user` action returns an unsupported-interface error in the sealed runtime | per brief | durable interactions + authenticated approvals | A19 |
| interpreted fallback loop; recovery can reset a local counter | per brief | fallback = stop for review; global monotonic budgets | A06, A10, A29 |
| consecutive same-tool/same-phase calls may be merged | per brief (paper App. B.3) | only an `unknown_effect` record and its reconciliation, for the same logical action id | A16 |
