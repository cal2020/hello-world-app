# hexis-service

A production-extension layer for **HEXIS-style compiled skills**: it turns an approved natural-language
skill plus a trusted tool catalog into a versioned extended finite state machine (EFSM), admits it through
static and replay gates, executes it with a deterministic kernel, and routes every external effect through
an independent broker with approvals, evidence receipts, idempotency and crash recovery. Trace-driven
refinements are proposed on copies and admitted atomically, or not at all.

Built from `HEXIS_Software_Implementation_Brief.pdf` (26 Sep 2026) using the workflow in
`Universal_Implementation_Master_Prompt.pdf`. It reads the upstream `efsm-v1` format
(Worldbuilder013/HEXIS @ `96be2719`) but **vendors no upstream code** (see [docs/SOURCES.md](docs/SOURCES.md)
for the license discrepancy).

> **Everything runs in FIXTURE MODE by default**: a deterministic fake model, fake connectors (documents,
> supplier registry, ERP) and simulated identities. That validates software behavior. It does **not**
> measure live model quality, real ERP semantics or production authentication. See
> [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Quick start (offline, no API keys)

```bash
cd hexis-service
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e ".[dev]"   # or: pip install -e ".[dev]"
.venv/bin/hexisctl demo procurement-onboarding          # one-command demo -> build/demo/
.venv/bin/python -m pytest                               # 101 passed, 12 skipped (upstream conformance)
.venv/bin/python evals/run_eval.py                       # fixture-mode eval -> evals/results/
```

The demo follows the brief's §14 narrative. It resets `build/demo/` and then:

1. Compiles the skill. The fixture compiler's first draft skips re-validation after repair; the ordering
   gate rejects it with a counterexample path, and the bounded repair fixes it. It then writes
   `coverage.md`, which maps every clause to its states.
2. Runs a clean intake through extraction, one bounded repair and validation, then pauses for approval.
3. Restarts the worker. The initiator's self-approval is refused (separation of duties). The run then
   resumes on an authenticated approver's response.
4. Injects a timeout after the fake ERP commits. The broker reconciles by business reference, leaving
   one draft and no duplicate.
5. Writes an evidence-linked record (`execution_record.json`). The verified terminal names its exact
   scope and receipt.
6. Refinement, in two halves:
   - a. Accepts a trace-driven refinement (missing documents lead to one input request), replays every
     protected trace, and admits it with a compare-and-swap on the parent.
   - b. Proposes a *repair → approval* shortcut that skips re-validation. The trace is excluded, the
     candidate fails the ordering and negative-corpus gates, and the active version is unchanged.

## CLI (`hexisctl`)

```bash
hexisctl compile  --skill examples/procurement_onboarding/SKILL.md --out build/package.json
hexisctl validate --package build/package.json --skill examples/procurement_onboarding/SKILL.md
hexisctl admit    --package build/package.json --state build/state            # as user:dana (artifact_admin)
hexisctl run      --package build/package.json --input examples/procurement_onboarding/task.json --state build/state
hexisctl resume   --run RUN_ID --interaction IX_ID --response resp.json --state build/state   # as user:bob
hexisctl inspect  --run RUN_ID --state build/state
hexisctl replay   --package build/package.json --archive build/demo/traces --mode structural|recorded
hexisctl update   --parent build/package.json --trace build/demo/traces/dev_missing_docs.jsonl --out proposals/
hexisctl demo procurement-onboarding --scenario timeout-after-commit
```

`--json` gives structured output. Exit codes: `0` success, `2` invalid input, `3` validation or gate
rejection, `4` runtime failure, `5` expected waiting state (approval, input or reconciliation). `update`
only writes a proposal; deployment is the separate `admit` step, which requires the admin role and the
expected parent. `resp.json` for an approval is `{"approval_decision": "approved", "scope_digest": "<digest
printed by run>"}`.

A live model can be plugged in with `--model anthropic:<model-id>` (install the `.[anthropic]` extra; the
SDK resolves credentials from the environment). This path is implemented and unit-tested with a fake
client. It was **not executed live**.

## Layout

```
src/hexis_service/
  canonical.py      strict JSON intake, canonical serialization, hashing
  guards.py         allowlisted guard parser, static typing, strict + 3-valued evaluation, disjointness analysis
  artifacts/        efsm-v1 reader, production package, static validator, diff, registry (admission/revocation)
  compiler/         clause indexing with byte spans, bounded draft→validate→repair→normalize pipeline
  runtime/          pure kernel (advance), RunService orchestration (prepare/dispatch/reconcile/commit)
  tools/            trusted catalog, policy service, broker (fencing, approval recheck, idempotency, reconcile)
  approvals/        approval scope binding;  evidence/  subject/version-bound receipts
  traces/           trace format with digests, normalization, eligibility, refinement (propose_update)
  replay/           structural and recorded replay with a no-network guard
  storage/          SQLite store (tenant-scoped, append-only triggers, revision CAS, leases)
  models/           restricted model interface, Claude adapter (official SDK)
  demo/             procurement fixture compiler, fakes, reference traces, aligners, demo narrative
  cli/              hexisctl
schemas/            JSON Schema 2020-12 exports of every record contract (drift-tested)
examples/procurement_onboarding/   SKILL.md, tool_catalog.json, policy.json, task.json
tests/{unit,conformance,integration,replay,security,recovery}/   acceptance matrix A01–A32 + properties/mutations
evals/              held-out synthetic tasks, fixture-mode runner, committed results
docs/               requirements ledger, architecture, sources, limitations, operations, verification
```

## Documentation

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): scope contract and requirements ledger (source → code → test → status)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, trust boundaries, semantics, intentional differences from upstream
- [docs/VERIFICATION.md](docs/VERIFICATION.md): exactly what was run, where, and the results
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md): implemented vs. simulated vs. not implemented
- [docs/OPERATIONS.md](docs/OPERATIONS.md): recovery, reconciliation, promotion, revocation and key runbooks
- [docs/SOURCES.md](docs/SOURCES.md): reference register, upstream baseline, license note
