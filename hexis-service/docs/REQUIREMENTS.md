# Scope contract and requirements ledger

## Scope contract

| Item | Decision |
|---|---|
| Target user / problem | Engineering lead and operators who need model-assisted procurement workflows with enforceable control flow, approvals, evidence and recovery |
| Sources | `HEXIS_Software_Implementation_Brief.pdf` (26 Sep 2026, 26 pp.): implementation requirements. `Universal_Implementation_Master_Prompt.pdf` (26 Sep 2026, 9 pp.): delivery workflow (not product requirements) |
| Mode | IMPLEMENT_AND_DEMONSTRATE (master-prompt default; both files attached with no other instruction) |
| End-to-end behavior | Compile the supplier-onboarding skill → admit → run → durable approval → broker-mediated ERP draft write → read back → verifier receipt → evidence-bound verified terminal; trace refinement accepted/rejected atomically |
| Exclusions | Visual editing, multi-agent UI, concurrent/nested states, hot migration, automatic promotion to production, model-authored shell, real enterprise writes (brief §3 "defer") |
| Stack | Python 3.12, Pydantic 2 (strict models, `extra="forbid"`), jsonschema (Draft 2020-12), SQLite, pytest + hypothesis, `uv.lock`. Put in a sub-project, because the host repository is an unrelated Vite demo app |
| Assumptions | Fixture mode is acceptable for the offline demo; identities are simulated; the HMAC admission key is a development signer; the KBR interview handoff (master prompt §11) is **not** activated, because nothing supplied connects this work to KBR |
| Risky boundaries | ERP write (approval-gated, idempotent, reconcilable), approvals (scope digest), trace-driven updates (gates + CAS), upstream license |
| Completion commands | `hexisctl demo procurement-onboarding`, `pytest`, `python evals/run_eval.py` |

## Ledger

Status: **V** = implemented and verified by a test or demo in this repository. **P** = partial (the
limitation is named). **S** = simulated (fixture only). **N** = not implemented. "Brief" refers to printed
section numbers.

| ID | Source | Requirement (observable) | Implementation | Test / oracle | Status |
|---|---|---|---|---|---|
| REQ-001 | Brief §1 DoS-1 | Fresh checkout runs a deterministic demo without keys or services | `demo/procurement_demo.py`, `hexisctl demo` | `test_one_command_offline_demo` | V |
| REQ-002 | §1 DoS-2 | The same interfaces support a real model via an explicit provider adapter | `models/anthropic_adapter.py`, `--model anthropic:<id>` | `test_anthropic_adapter_*` (fake client) | P: not executed live |
| REQ-003 | §1 DoS-3, §7.1 | Every transition is reproducible from the pinned machine, checkpoint and observations | `runtime/kernel.py` (pure), `replay_recorded` | `test_A30_*` (property + recorded) | V |
| REQ-004 | §1 DoS-4, §12.2 | Consequential tool ops pass independent authorization and evidence checks immediately before dispatch | `tools/broker.py::authorize`, `RunService._approval_check` | A20, A21, `test_mutation_altered_stored_approval_digest_denied` | V |
| REQ-005 | §1 DoS-5, §9.5 | An update breaking a protected trace is rejected; the machine and archive are unchanged | `traces/update.py`, `artifacts/registry.py` | A14 | V |
| REQ-006 | §1 DoS-6, §11 | A restart cannot silently repeat a consequential action | action ledger, fencing, reconcile | A22, `test_crash_at_each_boundary_*` (5 points) | V |
| REQ-007 | §1 DoS-7, §12.3 | A verified terminal names exactly what was verified, with its evidence | `TerminalContract.verification_scope`, receipts | `test_happy_path_verified_with_scoped_evidence` | V |
| REQ-008 | §1 DoS-8, §10 | Reports distinguish structural conformance from business correctness | replay modes; `evals/run_eval.py` metrics | A12; eval report columns | V |
| REQ-009 | §2 | Upstream inspected at the pinned commit; baseline run; license discrepancy recorded | `docs/SOURCES.md` | upstream suite 230 passed / 4 skipped; `test_upstream_compat.py` | V |
| REQ-010 | §2 table | Strict input binding: missing inputs fail explicitly, never None/"" | `kernel.fill_template` | A05 | V |
| REQ-011 | §2 table | Disable interpreted fallback for writes; independent monotonic budgets recovery can't reset | `ExecutionPolicy.fallback_mode`, `FALLBACK_MODE` check, `Budget` | A10, A29, `test_write_workflow_requires_stop_for_review` | V |
| REQ-012 | §2, §7.2 | Allowlisted guard AST; undefined vars are errors; type + resource limits | `guards.py` | A03, A09, `test_bool_int_coercion_*` | V |
| REQ-013 | §2, §7.2 | Disjoint guarded branches, default last, PROVEN/COUNTEREXAMPLE/UNKNOWN | `guards.analyze_disjoint`, validator | A08, `test_guard_disjointness_analysis_is_sound` | V |
| REQ-014 | §6.1 | Compatible `efsm-v1` reader; extensions live in a separate package | `artifacts/efsm.py`, `artifacts/package.py` | `test_upstream_example_machines_round_trip` (4 machines) | V |
| REQ-015 | §6.2 | `MachinePackage` with explicit hash payload, lifecycle, signed admission | `package.py`, `registry.py` | `test_hash_and_quote_tamper_detected`, A32 | V (HMAC dev signer) |
| REQ-016 | §6.2 | Reject duplicate keys, non-finite numbers, bad encodings; canonical hashing | `canonical.py` | A02 dup-keys, `test_canonical_serialization_stable` | V |
| REQ-017 | §6.3 | Distinct unset/null/""/false/0; ownership; write allowlist; unexpected keys rejected | `kernel.validate_declared_outputs`, `WRITE_OWNERSHIP` | A06, A07 | V |
| REQ-018 | §6.3 | Nested JSON-Pointer-style selectors | `kernel.resolve_path` | `test_nested_init_from_resolution` | V |
| REQ-019 | §6.4 | Versioned RunCheckpoint, RuntimeEvent, ActionReceipt, ApprovalRequest, EvidenceReceipt, NormalizedEvent | models + `schemas/*.json` | `test_committed_schemas_match_models` | V |
| REQ-020 | §7.1 | Reducer has no I/O; delta + edge + counter + event + checkpoint commit in one transaction; raw observations kept on failure | `kernel.advance`, `Store.commit_transition`, `OBSERVATION_REJECTED` | A13, `test_A24_*` | V |
| REQ-021 | §7.3 | Model sees only its local prompt, reads and schema; judge labels + abstention | `models/base.py`, `RunService._model_step` | A06 | V |
| REQ-022 | §7.4 | Separate transport retry / output repair / business repair / loop / run budget; boundary 0,1,2 | `_model_step`, broker, `edge_bound`, `Budget` | A10 (parametrized 0/1/2) | V |
| REQ-023 | §7.4 | SCC loop analysis; learned bounds clamped to an operator ceiling | `validate.py` loops | A11, `test_learned_loop_bound_clamped_to_operator_ceiling` | V |
| REQ-024 | §7.5 | Status separate from outcome; fallback recorded permanently; stop_for_review | `RunCheckpoint.status/outcome/assurance` | A29 | V |
| REQ-025 | §8 | Bounded compile pipeline: snapshot, clause spans, coverage, repair (≤3), no requirement dropping, normalization | `compiler/` | A01, `test_normalization_preserves_behavior` | V (fixture compiler model) |
| REQ-026 | §8 static checks | Structure, reachability, dataflow, guards, tool contracts, ordering, evidence, loops, provenance | `artifacts/validate.py` | A02, A04, A08, A11, A17, mutation tests | V |
| REQ-027 | §9.1 | Protected / negative / held-out sets kept separate; an honest failure can be protected | `traces/update.py`, `evals/heldout_tasks.json` | A15; conflict→review trace in the protected archive | V |
| REQ-028 | §9.2 | Normalization preserves consequential events; merge only one logical operation | `traces/normalize.py` | A16 | V |
| REQ-029 | §9.3 | Staged alignment; proposals validated independently of rationale | `_validate_ops` | `test_mismatched_semantic_match_rejected_*` | P: fixture aligners; no alignment model |
| REQ-030 | §9.4 | Candidate on a copy; diff shows states, edges, contracts, clauses, new effects; no widening | `apply_ops`, `package_diff`, `policy_widening` | A17 (approval removal) | V |
| REQ-031 | §9.5 | ≤2 attempts (the second restrictive); replay new + all protected; atomic CAS publish; losers rebase | `propose_update`, `admit` | A14, A18 | V |
| REQ-032 | §10 | Three modes exposed; placeholders reported; recorded mode blocks the network; INCOMPLETE ≠ pass; divergence report | `replay/replay.py` | A12, A13, A31 | P: `sandbox_live` = the eval runner in fixture mode |
| REQ-033 | §11.1 | Intent → lease → recheck → dispatch w/ key → receipt → commit; effect classes; UNKNOWN_EFFECT | `service._tool_step`, `broker` | A22, A23, timeout tests | V |
| REQ-034 | §11.2 | Monotonic revisions, fencing at the store and broker, cancellation reconciles and discloses | leases, `cancel_run` | A24, A27 | V |
| REQ-035 | §11.3 | The listed tables, tenant-scoped, append-only immutables, active pointer via admission only | `storage/sqlite.py` | `test_immutable_records_cannot_be_rewritten` | V (SQLite only) |
| REQ-036 | §12.1 | Durable interactions; approval binds the full scope; rechecked at dispatch | `approvals/scope.py`, `_user_step` | A19, A20, `test_approval_authentication_rules`, expiry | V |
| REQ-037 | §12.1 | LangGraph adapter runs the same conformance suite | none | none | N (optional; not needed) |
| REQ-038 | §12.2 | Deterministic policy; INDETERMINATE ⇒ deny; compiler cannot modify policy | `tools/policy.py` | A21, business-unit test | V |
| REQ-039 | §12.3 | Receipts bound to subject versions; invalidation on change; re-check before terminal | `evidence/receipts.py`, `erp_freshness` | A25, A28 | V |
| REQ-040 | §13 | Injection, spoofing, cross-tenant, coercion, secrets controls | broker, kernel, store | A26, `tests/security/*` | V |
| REQ-041 | §14 | Procurement demo: states, tools, narrative steps 1–6 | `demo/` | `test_one_command_offline_demo` | S (fake ERP) |
| REQ-042 | §15 | Python API names, CLI commands, JSON output, exit codes (waiting ≠ error) | `RunService`, `cli/main.py` | `test_cli_*` | V |
| REQ-043 | §15 | Observability: structured events for all listed happenings; per-model/state/tool metrics | `run_events`, `Budget` | inspected in `execution_record.json` | P: no metrics exporter or latency split |
| REQ-044 | §16 | A01–A32, property, mutation and crash-injection tests | `tests/` | 101 pass (+12 upstream) | V |
| REQ-045 | §17 | Baseline vs initial vs refined; held-out; separate metrics; honest labels | `evals/run_eval.py` | `evals/results/report.md` | P: ReAct baseline not run (needs a live model) |
| REQ-046 | §18 | Deliverables: source, lockfile, schemas, skill/coverage/machines/diff, demo, traces, reports, docs | repo | this ledger | P: no PostgreSQL migrations |
| REQ-047 | §5 | PostgreSQL adapter for multi-worker | none | none | N |
| REQ-048 | §5 | Keys only in the environment / secret store | adapter via SDK env; `HEXIS_ADMISSION_KEY` | `test_secrets_not_in_artifacts` | V |
