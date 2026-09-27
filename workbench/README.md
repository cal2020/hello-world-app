# Model/API integration workbench (Lucid Dream–style prototype)

A small local application that:

1. imports a **synthetic** engineering-model export and keeps element identity and revision history,
2. generates a bounded **OpenAPI 3.1.1 / JSON Schema 2020-12** contract from a reviewed projection,
3. serves that contract over HTTP to a separate mock **consumer** and runs the consumer's own checks against real responses,
4. proposes links between maintenance records and model elements, with exact quoted evidence (deterministic baseline, scripted "fixture model", optional live Claude call), and requires a person to review them,
5. shows what happens when the model changes: identity is preserved on rename, stale approvals are rejected, incompatible candidates are blocked, the active release keeps serving, and a tested replacement is promoted without losing history.

> **What this is not.** Synthetic data only. It is not a Cameo/Teamwork Cloud integration and not a SysML or OMG Systems Modeling API implementation. It says nothing about KBR's Lucid Dream or Digital Forge, beyond exploring an integration pattern that was described in conversation. Identities are simulated demo tokens, not production authentication. The only hosting path is one demo container behind a shared access code (`DEPLOY.md`; Railway is the chosen platform). Nothing here has been deployed to, or assessed for, GovCloud or a disconnected environment.

## Run it

```sh
cd workbench
./scripts/setup.sh                       # pinned deps into .venv (jsonschema, openapi-spec-validator)
.venv/bin/python scripts/run.py --reset  # workbench :8780 + consumer :8781 (one process), fresh databases
.venv/bin/python scripts/seed.py         # projections + CMMS records (model A is imported in the demo)
```

* Workbench UI: <http://127.0.0.1:8780/>. Use the identity switcher, which is labeled as simulated.
* Consumer dashboard: <http://127.0.0.1:8781/>, also proxied at <http://127.0.0.1:8780/consumer/>
* Scripted five-minute flow: `.venv/bin/python scripts/demo.py --pause`. Press Enter to advance each step. `--self-host` runs against a private temporary stack.
* Tests: `.venv/bin/python -m unittest discover -s tests -t .` Most tests start a fresh stack on ephemeral ports. The browser tests in `tests/test_fix_ui.py` need `node` and the Playwright package (`LWB_PLAYWRIGHT`), and are skipped without them. No test calls a model API.
* Evaluation report: `.venv/bin/python scripts/evaluate.py`, which runs the full suite and rewrites `EVALUATION.md` and `eval/results.json`.
* Optional live model: `.venv/bin/pip install -r requirements-live.txt`, then set `ANTHROPIC_API_KEY` (optionally `LWB_MODEL`, default `claude-opus-5`). Then choose "Run proposals: live" in the UI, or run `LWB_EVAL_LIVE=1 .venv/bin/python scripts/evaluate.py`, which adds `model:live` runs (billed API calls) to the report. The test suite stays offline either way. A live failure is recorded on the run and shown. The workbench never falls back to fixture data silently.

To host it (one container, access-code gate; Railway, Fly.io, Render or any Docker host), see `DEPLOY.md`.

Reset means stopping `run.py` and starting it again with `--reset`. Local state lives in `workbench/var/` and is gitignored. A database written by an earlier version of the code is upgraded in place when the workbench starts.

## Layout

| Path | What |
|---|---|
| `lucidwb/importer.py` | Source adapter: normalization, identity, head/parent rules, quarantine, partial staging, deltas and tombstones, snapshot diff |
| `lucidwb/projection.py` | Projection validation (allowlists), deterministic contract generation, snapshot-pinned serving, contract diff |
| `lucidwb/release.py` | Candidate builds, release manifests, schema checks, consumer checks, atomic activation and rollback |
| `lucidwb/links.py`, `lucidwb/ai.py` | Proposal runs, evidence resolution against retained raw bytes, review decisions, the protected accept (ETag + dependency checks), rebase |
| `lucidwb/receipts.py` | Caller/project-scoped idempotency receipts, written in the same transaction as the effect |
| `lucidwb/outbox.py` | Transactional outbox worker (ordered per project, retries with backoff, pause per project) |
| `lucidwb/authz.py` | Simulated identities and project-scoped grants |
| `lucidwb/server.py` | Read API (`/api`), management API (`/manage`), optional access-code gate, consumer dashboard proxy (`/consumer/`) |
| `lucidwb/db.py` | SQLite schema and the in-place upgrade of databases written by earlier versions |
| `consumer_app/` | Independent mock consumer: own code (it does not import `lucidwb`), own DB, own expectations, deduplicating event handler, gap resync. It talks to the workbench only over HTTP, but runs as a second HTTP server in the same process |
| `web/` | Workbench UI (vanilla JS) |
| `fixtures/` | Synthetic model exports A–E and edge cases, CMMS records, projections, scripted model outputs, gold labels |
| `examples/` | Generated OpenAPI contract, release manifest, blocked-release view, response sample, recorded demo transcript, screenshots |
| `tests/` | Integration cases (`test_integration.py`, IC-xx), the access gate (`test_deploy.py`), and regression tests for review findings (`test_fix_*.py`) |
| `ARCHITECTURE.md` | Design note, including version dimensions, authority boundaries, known semantic loss and deployment assumptions |
| `DEMO_SCRIPT.md` | Five-minute interview script |
| `DEPLOY.md` | Container, access gate, environment variables and platform steps |
| `EVALUATION.md` | Generated evaluation report (actual results) |

## Stack choice

The repository previously held only a static Vite greeting-card page, which is left untouched. There was no backend, persistence or tests to reuse, so the workbench is a separate module:

* **Python 3.11 standard library.** `http.server`, `sqlite3`, `hashlib` and `unittest` mean one process, no broker, no graph or vector database, and no cloud account.
* **Two pinned third-party libraries,** used only for independent validation: `jsonschema` checks responses against the generated schemas, and `openapi-spec-validator` checks the generated document.
* **Vanilla JS UI,** so there is no build step.

One startup path (`scripts/run.py`, which the container entrypoint also runs) starts both the workbench and the consumer.

## Where things stand

* **Tested:** the full automated suite. `EVALUATION.md` records how many tests ran and passed in its run, and which test covers each case in the brief's integration table. The scripted demo reproduces the five-minute flow.
* **Not measured:** real-model link quality. Fixture mode only exercises the mechanics. The live adapter has not been run: the `anthropic` package is not installed in the build environment, and `EVALUATION.md` records whether a live run was requested. Review time has not been measured because no people have reviewed yet.
