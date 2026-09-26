# Limitations

Labels follow the master prompt: **implemented and verified**, **implemented but not executed**,
**simulated**, **proposed / not implemented**, **unknown**.

## Implemented but not executed

- **Claude model adapter** (`models/anthropic_adapter.py`, `--model anthropic:<id>`). The request
  shape and parsing are tested with an injected fake client only. No live API call was made, so there
  is no evidence about live extraction quality, refusal rates, latency or cost.
- **LLM compiler model.** The compiler takes any `CompilerModel`, but only the fixture compiler is
  wired. `hexisctl compile --compiler <other>` exits 2. No prompt for a live compiler model has been
  written or evaluated.

## Simulated

- **All connectors are fakes**: documents, supplier registry, validator, verifier and ERP. The fake
  ERP persists to SQLite, supports idempotency keys and business-reference reconciliation, and injects
  faults. It says nothing about a real ERP's conditional-write support, auth, rate limits or partial
  failures. There is no external ETag or version-conditional write, so the time-of-check/time-of-use
  gap between the broker's recheck and the connector write is **not** closed. It is mitigated only by
  idempotency and read-back verification.
- **Identities are a simulated directory** (`policy.json`, `--as user:x`). This is not production
  authentication.
- **Development traces** come from a scripted reference executor, and **aligners** are deterministic
  fixtures. Their proposals do go through real operation validation and every gate.
- **Evaluation** runs in fixture mode. `evals/results` describes deterministic software behavior on
  7 synthetic held-out tasks, not model quality. The direct-prompting ReAct baseline arm is **not run**.

## Not implemented

- PostgreSQL store, migrations beyond SQLite `CREATE IF NOT EXISTS`, and multi-process worker pools.
  Single-process SQLite with WAL is the only store.
- LangGraph hosting adapter (optional in the brief).
- A metrics exporter, and splitting latency into engine, model, tool and human waiting time. Events are
  recorded, but there is no timing breakdown or cost accounting (cost is unknown, never zero).
- Retention/redaction tooling, encryption at rest, KMS-backed admission signatures (HMAC dev key only),
  and deleting protected traces with an updated coverage record.
- The optional sandbox interpreted fallback. Only `stop_for_review` exists.
- Judge calibration (per-label error, abstention and coverage on held-out data). Judge states are
  supported by the kernel and validator, but the procurement machine uses none, because every branch
  there is deterministic.
- Hot migration of in-flight runs (by design, runs stay pinned to their artifact hash).

## Known semantic gaps / residual risks

- Ordering and approval analysis is graph-based and ignores guard feasibility. It is conservative: it
  can over-report violations but not under-report them. It proves that a required *state* was visited,
  not that it returned a passing result. The broker's approval and evidence rechecks cover that
  independently at runtime.
- Structural replay explores guard branches over UNKNOWN placeholders, bounded at 20,000 nodes.
  Exceeding the bound is reported as INCOMPLETE, never as a pass.
- Replay compatibility on recorded traces does **not** show that a future model will produce correct
  drafts, nor that every clause was interpreted correctly. Clause coverage proves provenance, not the
  correctness of the interpretation.
- The approval target is bound by business reference plus the argument digest. The existing supplier
  record's version is not separately bound.
- Upstream licensing (GPLv3 file vs MIT metadata) is unresolved. It must be settled before any
  upstream code is adopted.
