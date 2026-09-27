# HEXIS production extension (offline prototype)

An implementation of the *HEXIS Software Implementation Brief* (26 Sep 2026): compile an approved skill
into a versioned extended finite state machine (`efsm-v1`), admit it only after static checks, run it
through a pure transition kernel with durable checkpoints, route every external effect through a policy-
and approval-enforcing broker, and accept trace-driven refinements only after replay of every protected
trace.

The HEXIS method itself is from the paper *HEXIS: Compiling Skills into Extended Finite State Machines*
(arXiv:2609.30123) and its reference repository. **This directory contains no upstream code** (see
[docs/SOURCES.md](docs/SOURCES.md) for the license discrepancy that motivated this).

Everything here runs in **fixture mode**: a deterministic compiler model, a rule-based fake extraction
model, a fake ERP / document store / supplier master and simulated host principals. It demonstrates
control, evidence, approval and recovery behaviour. It does not measure live model quality.

## Requirements

Python 3.11+ and nothing else. No third-party packages, API keys or network. (There is nothing to lock:
the dependency set is the Python standard library.)

## Run it

```sh
cd hexis
./hexisctl --data .hexis-data/demo demo procurement-onboarding      # the full narrative, ~1 s
python3 -m unittest discover -s tests                               # 93 tests
python3 evals/run_eval.py                                           # held-out fixture evaluation
```

The demo walks through the brief's section 14 narrative:

1. compile `SKILL.md` (the first draft is rejected for overlapping guards, then repaired) and print
   the clause-to-state coverage;
2. run a clean intake through extraction and validation;
3. pause for approval, **restart the worker** (a new process state), refuse a self-approval, resume;
4. inject a **timeout after the fake ERP commits**; the run goes to `RECONCILING`, finds the draft by
   business reference, and continues — one draft, no duplicate;
5. print the evidence-linked execution record (transitions, action receipts, evidence receipt and
   the exact verification scope) and a network-disabled **recorded replay** of the run;
6. propose a **shortcut that skips validation**: the trace is classified negative, the gates reject the
   proposal (`ORDERING_BYPASS`, `READ_NOT_ASSIGNED`, ...) and the active version is unchanged;
7. (extra) a transient read-back failure ends honestly at `END_UNVERIFIED`; a reviewed development
   trace drives a **refinement** that adds a bounded retry (bound from the paper's ~1.5x heuristic,
   clamped to the operator ceiling); it replays the whole protected archive, is admitted by
   compare-and-swap, and the same fault now reaches `END_VERIFIED_DRAFT`.

Scenarios: `--scenario full | timeout-after-commit | shortcut-rejection | refinement`.
The transcript and a JSON report are written to `<data>/demo_report.json`.

### Step by step with the CLI

```sh
./hexisctl compile  --skill examples/procurement_onboarding/SKILL.md --out build/package.json
./hexisctl validate --package build/package.json
./hexisctl --data .hexis-data/s admit --package build/package.json
./hexisctl --data .hexis-data/s run   --package build/package.json --input examples/procurement_onboarding/task.json
#   -> exit 10: WAITING_FOR_APPROVAL ... interaction int-...
echo '{"decision":"approved"}' > /tmp/ok.json
./hexisctl --data .hexis-data/s resume  --run RUN_ID --interaction INT_ID --response /tmp/ok.json   # as u-approver
./hexisctl --data .hexis-data/s inspect --run RUN_ID
./hexisctl --data .hexis-data/s continue --run RUN_ID      # advance an existing run (after a crash / to reconcile)
./hexisctl replay --package build/package.json --archive TRACES_DIR --mode structural
./hexisctl update --parent build/package.json --trace new.jsonl --archive TRACES_DIR --out proposals/
```

Exit codes: `0` success, `2` invalid input, `3` validation/admission rejected (or refused action),
`4` runtime failure, `10` waiting for input or approval (an expected state). Add `--json` for
structured output. `--as u-requester|u-approver|u-other` picks a *simulated* principal.
Reset: delete the `--data` directory.

## Layout

```
src/hexis_service/
  canonical.py        strict JSON input, canonical serialization, digests
  machine.py          efsm-v1 reader (upstream field names; stricter: unknown keys rejected)
  package.py          MachinePackage hexis-production-package/1, hash payload, admission signature
  guards.py           allowlisted guard language: parse, typecheck, evaluate, disjointness proof
  jsonschema_lite.py  strict JSON Schema 2020-12 subset (no coercion)
  validator.py        admission checks: structure, reachability, dataflow, ownership, guards,
                      tool contracts, ordering, evidence, loops, provenance, fallback policy
  kernel.py           pure transition reducer (no I/O, clock or randomness)
  compiler.py         clause index with byte spans, coverage, bounded draft/validate/repair loop
  store.py            SQLite store: checkpoints (CAS), events, observations, leases, intents, receipts
  authority.py        principals, deterministic policy, approvals, evidence receipts
  broker.py           fenced, policy- and approval-checked dispatch; reconciliation
  connectors.py       fake ERP (persistent, fault injection), documents, supplier master, validator, verifier
  models.py           model adapters: rule-based fake, scripted fake, Anthropic provider adapter
  runtime.py          durable orchestration: start/advance/resume/cancel/inspect
  registry.py         immutable versions, lifecycle, CAS promotion, revocation
  traces.py           trace format, integrity, normalization, eligibility, structural/recorded replay
  update.py           alignment, candidate on a copy, all-gates acceptance, atomic admission
  demo.py, cli.py, app.py
schemas/              JSON Schemas for package, catalog, checkpoint, event, approval, evidence, trace
examples/procurement_onboarding/
  SKILL.md, tool_catalog.json, contracts.json, execution_policy.json, deployment_policy.json,
  machine.efsm.json (compiler target), compiler_fixture.json, documents/, task.json, heldout/tasks.json
tests/                static, kernel, runtime/recovery/security, replay/update, contracts/CLI/demo
evals/run_eval.py     held-out evaluation (initial vs refined machine; ReAct arm not run)
docs/                 architecture, requirements ledger, sources, limitations, operations, security, test report
```

## What to read next

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — trust boundaries, execution semantics, differences from upstream
* [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — requirements ledger with status and tests (acceptance matrix A01–A32)
* [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — what this does **not** establish
* [docs/TEST_REPORT.md](docs/TEST_REPORT.md) — exact commands, environment and results
