# Requirements ledger

Source: *HEXIS Software Implementation Brief* (26 Sep 2026), cited by section (§) and PDF page (p).
Status labels: **verified** = implemented and exercised by a passing test or the demo;
**implemented, not executed** = code exists but no run in this repository exercised it;
**simulated** = only a fixture stands in for the real thing; **not implemented** = open.

## Definition of success (§1, p3)

| ID | Requirement | Where | Evidence | Status |
|---|---|---|---|---|
| REQ-001 | Fresh checkout runs a deterministic demo without keys or services | `hexisctl demo`, `demo.py` | `test_contracts_cli.TestDemo` (two runs, identical transcript) | verified |
| REQ-002 | Same interfaces support a real model via an explicit provider adapter | `models.AnthropicMessagesAdapter` | none (no key/network in this environment) | implemented, not executed |
| REQ-003 | Every accepted transition reproducible from pinned machine, checkpoint, observations | `kernel.py`, `traces.recorded_replay` | `test_replay_update` recorded replay; `test_kernel` A30, property test | verified |
| REQ-004 | Consequential operations pass independent authorization + evidence check right before dispatch | `broker.dispatch`, `ApprovalService.check_for_dispatch` | A20, A21, approver-revocation test | verified |
| REQ-005 | An update breaking a protected trace is rejected; machine and archive unchanged | `update.propose_update/gate_candidate` | A14 | verified |
| REQ-006 | A restart cannot silently repeat a consequential action | intents + leases + reconciliation | A22, crash-injection matrix | verified (fake ERP) |
| REQ-007 | A verified terminal names what was verified and the evidence | `kernel._finish`, `runtime._terminal_check`, terminal `claim` | happy-path test, demo step 5 | verified |
| REQ-008 | Docs/reports separate structural conformance from business correctness | `docs/LIMITATIONS.md`, eval report fields | review | verified (documentation) |

## Build-first scope (§3, p5) and contracts (§6–7)

| ID | Requirement | Where | Evidence | Status |
|---|---|---|---|---|
| REQ-010 | Compatible reader for `efsm-v1` + strict production profile | `machine.py`, `validator.py` | A02, reference package clean | verified (reader is stricter than upstream; see ARCHITECTURE) |
| REQ-011 | Separate versioned `MachinePackage` (`hexis-production-package/1`) with the §6.2 fields | `package.py`, `schemas/machine-package.schema.json` | schema test | verified |
| REQ-012 | Canonical hashing; reject duplicate keys, non-finite numbers, oversize, BOM; hash excludes self/signature/reports | `canonical.py`, `package.hash_payload` | strict-JSON test, tamper test | verified |
| REQ-013 | Signed admission record binding hash to reports | `package.sign_admission`, `registry.admit` | demo, CLI | verified — **dev HMAC key, not production PKI** |
| REQ-014 | Lifecycle draft→validated→admitted→active; revocation blocks new runs; runs pinned | `registry.py`, `runtime.start_run` | A32 | verified |
| REQ-015 | Unset ≠ null ≠ "" ≠ false ≠ 0; no coercion | `jsonschema_lite.py`, `kernel._declared_outputs` | A07, no-coercion test | verified |
| REQ-016 | Variable ownership model/tool/user/engine(/task); binds + write allowlist | contracts, `validator`, `kernel` | ownership test, A06 | verified |
| REQ-017 | JSON-Pointer selectors for nested task input | `kernel.initial_checkpoint` | A05 | verified |
| REQ-018 | Runtime records: checkpoint, event, action receipt, approval request, evidence receipt, normalized event | `store.py`, schemas | schema test | verified |
| REQ-019 | Pure reducer; one transaction per commit; raw observations kept even when validation fails | `kernel.py`, `store.commit_checkpoint` | A30; failed-validation observations stored | verified |
| REQ-020 | Guards: allowlisted parser, typed, bounded, ordered, default last, undefined ⇒ stop | `guards.py`, `kernel.advance` | A03, A09, typing test | verified |
| REQ-021 | Admission: ≤1 default placed last, safe default, disjoint guards, PROVEN/COUNTEREXAMPLE/UNKNOWN | `validator.py` | A08, default-rules test | verified |
| REQ-022 | Model/judge get local instruction + declared reads only; exact schema; judge labels + abstention | `runtime._model_step`, `models.StateRequest` | A06, abstention test | verified |
| REQ-023 | Separate transport retry, output repair (≤1), business repair (≤2), machine loop, run budgets | broker, runtime, contracts, kernel | A10 (0/1/2 boundaries), budget test | verified |
| REQ-024 | Status vs outcome vs assurance metadata; fallback = stop_for_review | `kernel.py`, validator `FALLBACK_MODE` | A06, A29 | verified |

## Compiler and refinement (§8–10)

| ID | Requirement | Where | Evidence | Status |
|---|---|---|---|---|
| REQ-030 | Snapshot/hashed inputs; clause index with exact byte spans; coverage classification | `compiler.py` | A01 | verified |
| REQ-031 | Bounded draft→validate→repair (3); repair may not drop protected clauses | `compile_skill` | A01 (2 attempts), repair-drop test | verified — **fixture compiler model only** |
| REQ-032 | Deterministic normalization, revalidated | `compiler.normalize` | compile path | verified |
| REQ-033 | Mandatory static checks: structure, reachability, dataflow, guards, tools, ordering, evidence, loops (SCC), provenance | `validator.py` | A02, A04, A08, A11, A17, mutation tests | verified |
| REQ-034 | Separate protected / negative / held-out trace sets | `traces.eligibility`, `update`, `heldout/` | A15, negative-corpus test | verified |
| REQ-035 | Normalize without merging distinct writes; keep raw references | `traces.normalize` | A16 | verified |
| REQ-036 | Staged alignment; candidate on a copy; ≤2 attempts, second restrictive | `update.py` | refinement test, A14 | verified — deterministic aligner; **no LLM alignment model** |
| REQ-037 | Gates: static, new trace, all protected traces, negative corpus, policy diff; CAS acceptance | `gate_candidate`, `admit_update`, `registry.promote` | A14, A17, A18 | verified |
| REQ-038 | Three replay modes reported separately; placeholders recorded; recorded replay has no external calls | `traces.py` | A12, A13, A31 | verified (sandbox_live = normal runtime on a fresh data dir; no live model run) |
| REQ-039 | Divergence report fields | `structural_replay` | divergence-report test | verified |

## Durable execution, approvals, evidence, security (§11–13)

| ID | Requirement | Where | Evidence | Status |
|---|---|---|---|---|
| REQ-040 | Intent → lease/fence → fresh checks → dispatch with key → receipt → commit | `runtime._tool_step`, `broker.dispatch` | crash-injection matrix | verified |
| REQ-041 | Effect classes; timeout ⇒ unknown_effect; reconcile before retry; non-idempotent pauses | `broker.py` | timeout test, A23 | verified |
| REQ-042 | Stale worker cannot dispatch or commit | fencing in broker + store | A24 | verified |
| REQ-043 | Cancellation discloses completed/unknown effects | `runtime.cancel_run` | A27 | verified |
| REQ-044 | Storage model tables, tenant-scoped, unique constraints | `store.py` | all runtime tests | verified — **SQLite only; PostgreSQL adapter not implemented** |
| REQ-045 | Approval binds tenant, run, interaction, artifact, logical action, tool/version, arg digest, target, evidence, policy version, approver, decision, expiry | `runtime._request_interaction`, `authority.py` | A19, A20, expiry test | verified |
| REQ-046 | Independent deterministic policy; INDETERMINATE ≠ allow | `PolicyService` | A21, A26 scope test | verified |
| REQ-047 | Evidence receipts tied to subject+version+hash; invalidation; re-check at terminal | `EvidenceService`, `_terminal_check` | A25 | verified |
| REQ-048 | Post-write verification failure keeps external ref, reports mismatch, no re-create | kernel/machine | A28 | verified |
| REQ-049 | Prompt injection, cross-tenant, missing input, trace poisoning, tool spoofing controls | several | A26, cross-tenant test, A05, A15, schema checks on tool output | verified for the listed tests; tool-output **connector identity** binding is not modelled beyond receipt ↔ action id |
| REQ-050 | Secrets never in artifacts/fixtures/logs | `models.py` reads key from env only | review | verified (review) |

## Demonstration, interfaces, evaluation, delivery (§14–18)

| ID | Requirement | Where | Evidence | Status |
|---|---|---|---|---|
| REQ-060 | Supplier-onboarding machine with the §14 states and trusted tools | `examples/procurement_onboarding` | demo | verified (READ_BACK retry is added by refinement, not initial compile) |
| REQ-061 | Demo narrative 1–6 | `demo.py` | `TestDemo` | verified |
| REQ-062 | Python interfaces §15 | `compiler.compile_skill`, `validator.validate_package`, `update.propose_update`, `traces.*_replay`, `update.admit_update`, `Runtime.start_run/advance_run/resume_interaction/cancel_run/inspect_run` | tests | verified (names differ slightly: `admit_update`) |
| REQ-063 | CLI with JSON output and documented exit codes | `cli.py`, `hexisctl` | `TestCLI` | verified |
| REQ-064 | Structured observability events and per-run usage | run events, `inspect_run` | demo step 5 | partially: steps/tool/model calls/fixture tokens recorded; **latency and cost not measured** (cost reported as unknown) |
| REQ-065 | Evaluation: ReAct baseline vs initial vs refined, independent metrics | `evals/run_eval.py` | `evals/report.json` | partially: initial vs refined measured on 10 held-out fixture tasks; **ReAct arm not run** (needs live model) |
| REQ-066 | Upstream baseline, license discrepancy recorded, reuse decision | `docs/SOURCES.md` | — | verified (baseline partially captured, see SOURCES) |
| REQ-067 | LangGraph hosting adapter | — | — | not implemented (optional in brief) |
| REQ-068 | Visual editor, concurrency, nested machines, auto-promotion | — | — | out of scope (deferred by §3) |

## Acceptance matrix cross-reference (§16)

A01 `test_static.TestCompile` · A02–A04, A08, A11, A17 `test_static.TestStructure` · A03 guard safety ·
A05 `test_runtime.TestInputs` · A06 `test_kernel`, `test_runtime.TestModelBoundary` · A07, A09, A30
`test_kernel` · A10 `test_kernel` + `test_runtime` · A12, A13, A16, A31 `test_replay_update.TestReplay` ·
A14, A15, A17, A18 `test_replay_update.TestUpdates` · A19–A21 `test_runtime.TestApprovals` ·
A22–A25, A27, A28 `test_runtime.TestRecovery` · A26, A32 `test_runtime.TestSecurity` · A29
`test_static` + `test_runtime` · mutation tests `test_static.TestMutations`.
