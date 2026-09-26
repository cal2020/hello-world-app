# Architecture and trust boundaries

```
 approved SKILL.md ─┐                                     ┌──────────── host (authenticated principal) ─────────────┐
 trusted catalog ───┼─► compiler ──► unadmitted package ──► validate + replay gates ──► registry (admit: CAS, signed)
 deployment policy ─┘   (proposes)                          (static, all protected traces, negative corpus)   │
                                                                                                              ▼
            model adapter ◄── RunService ── pure kernel (advance) ── SQLite store (checkpoints, events, ledger)
            (generate/classify   │  ▲                                     ▲
             only, no tools)     ▼  │ recorded observations               │ receipts, evidence
                             tool broker ── policy service, approvals, fencing, idempotency ──► connectors (fake ERP …)
```

## Component contracts (brief §4)

| Component | Owns | Cannot |
|---|---|---|
| `compiler/` | Proposed states, prompts, bindings, transitions, clause coverage | Admit, activate, grant permissions (it returns an *unadmitted* package) |
| `artifacts/validate.py` + `registry.py` | Static findings, admission record, active pointer (CAS), revocation | Run artifact code (guards are parsed, never `eval`ed) |
| `runtime/kernel.py` | State, edge selection, counters, budgets, terminal admission decision | Do I/O, read a clock, call a model or tool |
| `runtime/service.py` | Prepare/dispatch/reconcile/commit orchestration, interactions, terminal evidence recheck | Let a model pick tools or write authority fields |
| `models/` | State-local generation/classification | See the machine, the history, or tools |
| `tools/broker.py` | Fencing, schema, tenant, capability ∩ policy, approval scope, receipts, reconciliation, evidence issuance | Trust a claimed approval or verification |
| `tools/policy.py` | Principal permissions, BU scope, approver role, separation of duties | Be modified by the compiler or updater |
| `storage/sqlite.py` | Tenant-scoped records; append-only triggers on immutable tables | Edit an admitted version in place |

## Key semantics

**Kernel.** `advance(checkpoint, observation, package)` checks the observation identity (run, state,
revision), validates the declared writes (ownership, JSON Schema, no truthiness, field scope), then picks
the first enabled edge with the default last. The guard sees the new outputs and the *old* counter; the
increment follows selection. It charges a monotonic budget and returns the new checkpoint and events. Guard
errors and unset variables stop with `GUARD_EVALUATION_ERROR`; they never fall through to the default edge.

**Durable step.** A tool state goes through these steps, each atomic in the store:
1. Record the intent (logical action id = hash(run, state, revision, canonical args); the idempotency key
   is derived from it).
2. Lease plus fencing token.
3. The broker rechecks everything.
4. `DISPATCHING`, fenced on the token.
5. Connector call.
6. Receipt (`certain`, `reconciled`, or `unknown`).
7. Kernel commit: checkpoint, events and observation in one transaction, with a revision CAS and a
   lease check.

A crash between any two of these is covered by `test_crash_at_each_boundary_*`.

**Effect classes.** `read`/`pure` get transport retries. `reconciliable_write` looks up the business
reference, then retries with the same key only if the effect is proven absent.
`non_idempotent_write` goes to `RECONCILING` and waits for human resolution, with no retry.

**Approvals.** An approval interaction scope is the digest of:
`{tenant, run, interaction, artifact_hash, logical_action_id, tool@version, args_digest, business reference,
valid evidence receipts, policy_version, required_role, expires_at}`. The approver must echo the digest
they were shown. At dispatch the broker recomputes it, so any change to the arguments, the evidence, the
policy version or the artifact invalidates the approval. Separation of duties, role and tenant are
checked at response time and again at dispatch.

**Evidence.** A verifier tool issues receipts with `subject = {var: digest(value)}` over the state's
reads. Any later write to a subject variable invalidates the receipt. At terminal admission a registered
freshness check re-reads the ERP draft through the broker, and a changed version or payload invalidates
the receipt and blocks the verified terminal (A25).

**Refinement.** The pipeline runs in order:
1. Eligibility on the raw stream. The ordering requirements include invalidation, so "repair then
   approve" counts as a violation. There must be no unsupported success claims, and anything
   ineligible goes to the negative corpus.
2. If the parent already replays the trace, the result is `NO_CHANGE`.
3. The aligner proposes operations, which are validated independently of its rationale.
4. The operations are applied to a deep copy.
5. Gates: policy non-widening, static validation, replay of the new trace, replay of **all** protected
   traces, and the negative corpus. At most 2 attempts; the second is restrictive.
6. Admission is a separate step: admin role, re-validation, parent CAS, and the new archive manifest in
   the same transaction.

## Intentional differences from upstream (pinned `96be2719`)

| Upstream behavior | This implementation | Test |
|---|---|---|
| `True == 1` evaluates true (Python semantics) | Type error; static typing rejects bool/int coercion | `test_intentional_difference_undefined_and_coercion` |
| Tool outputs silently filtered by the `writes` allowlist; missing values become None | Missing declared writes are `OUTPUT_INCOMPLETE`; model/user extra keys are rejected | A05, A06 |
| `init_from` takes the last path segment | Full dot-path and JSON-Pointer resolution | `test_nested_init_from_resolution` |
| Fallback enters an interpreted loop; recovery can reset a local counter | `stop_for_review` required for write workflows; budgets are monotonic | A29, A10 |
| `user` action unsupported in the sealed runtime | Durable, authenticated interactions with expiry and scope binding | A19, A20 |
| Guard mutual exclusion attempted, but priority still wins at runtime | Admission *requires* PROVEN disjointness; UNKNOWN is a rejection | A08 |
| Consecutive same-tool/phase calls can merge | Merge only on the same logical action id | A16 |

Unknown fields are rejected by the `efsm-v1` reader (`extra="forbid"`). All four upstream example
machines still round-trip byte-for-byte.

## Decisions

- **Separate sub-project.** The host repository is an unrelated Vite demo, so there was no
  existing stack to reuse.
- **No vendored upstream code.** The LICENSE (GPLv3) and pyproject (MIT) disagree. This is an
  independent implementation written *after reading* the upstream sources, so it is not a clean-room
  claim.
- **SQLite only.** The kernel has no DB dependency, so a PostgreSQL store could implement the same
  `Store` surface. It has not been written.
- **HMAC admission signatures.** Development signer: `HEXIS_ADMISSION_KEY` from the environment,
  otherwise a labeled insecure demo key. A production deployment needs KMS/PKI.
