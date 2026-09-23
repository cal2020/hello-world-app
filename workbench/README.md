# Model/API integration workbench (Lucid Dream–style prototype)

A small local application that:

1. imports a **synthetic** engineering-model export and keeps element identity and revision history,
2. generates a bounded **OpenAPI 3.1.1 / JSON Schema 2020-12** contract from a reviewed projection,
3. serves that contract over HTTP to a separate mock **consumer** and runs the consumer's own checks against real responses,
4. proposes links between maintenance records and model elements, with exact quoted evidence (deterministic baseline, scripted "fixture model", optional live Claude call), and requires a person to review them,
5. shows what happens when the model changes: identity is preserved on rename, stale approvals are rejected, incompatible candidates are blocked, the active release keeps serving, and a tested replacement is promoted without losing history.

> **What this is not.** Synthetic data only. It is not a Cameo/Teamwork Cloud integration and not a SysML or OMG Systems Modeling API implementation. It says nothing about KBR's Lucid Dream or Digital Forge, beyond exploring an integration pattern that was described in conversation. Identities are simulated demo tokens, not production authentication. Nothing here was deployed to a cloud, GovCloud or disconnected environment.

## Run it

```sh
cd workbench
./scripts/setup.sh                       # pinned deps into .venv (jsonschema, openapi-spec-validator)
.venv/bin/python scripts/run.py --reset  # workbench :8780 + consumer :8781, fresh databases
.venv/bin/python scripts/seed.py         # projections + CMMS records (model A is imported in the demo)
```

* Workbench UI: <http://127.0.0.1:8780/>. Use the identity switcher, which is labeled as simulated.
* Consumer dashboard: <http://127.0.0.1:8781/>
* Scripted five-minute flow: `.venv/bin/python scripts/demo.py --pause`. Press Enter to advance each step. `--self-host` runs against a private temporary stack.
* Tests: `.venv/bin/python -m unittest discover -s tests -t .` (36 tests, each on a fresh stack)
* Evaluation report: `.venv/bin/python scripts/evaluate.py`, which rewrites `EVALUATION.md` and `eval/results.json`.
* Optional live model: `.venv/bin/pip install -r requirements-live.txt`, then set `ANTHROPIC_API_KEY` (optionally `LWB_MODEL`, default `claude-opus-5`). Then choose "Run proposals: live" in the UI or set `LWB_EVAL_LIVE=1`. A live failure is recorded on the run and shown. The workbench never falls back to fixture data silently.

Reset means stopping `run.py` and starting it again with `--reset`. Local state lives in `workbench/var/` and is gitignored.

## Layout

| Path | What |
|---|---|
| `lucidwb/importer.py` | Source adapter: normalization, identity, head/parent rules, quarantine, partial staging, deltas and tombstones, snapshot diff |
| `lucidwb/projection.py` | Projection validation (allowlists), deterministic contract generation, snapshot-pinned serving, contract diff |
| `lucidwb/release.py` | Candidate builds, release manifests, schema checks, consumer checks, atomic activation and rollback |
| `lucidwb/links.py`, `lucidwb/ai.py` | Proposal runs, evidence resolution against retained raw bytes, review decisions, the protected accept (ETag + dependency checks), rebase |
| `lucidwb/receipts.py` | Caller/project-scoped idempotency receipts, written in the same transaction as the effect |
| `lucidwb/outbox.py` | Transactional outbox worker (ordered per project, retries with backoff) |
| `lucidwb/authz.py` | Simulated identities and project-scoped grants |
| `lucidwb/server.py` | Read API (`/api`) and management API (`/manage`) |
| `consumer_app/` | Independent mock consumer: own DB, own expectations, deduplicating event handler, gap resync |
| `web/` | Workbench UI (vanilla JS) |
| `fixtures/` | Synthetic model exports A–E and edge cases, CMMS records, projections, scripted model outputs, gold labels |
| `examples/` | Generated OpenAPI contract, release manifest, blocked-release view, response sample, recorded demo transcript, screenshots |
| `ARCHITECTURE.md` | Design note, including version dimensions, authority boundaries, known semantic loss and deployment assumptions |
| `DEMO_SCRIPT.md` | Five-minute interview script |
| `EVALUATION.md` | Generated evaluation report (actual results) |

## Stack choice

The repository previously held only a static Vite greeting-card page, which is left untouched. There was no backend, persistence or tests to reuse, so the workbench is a separate module:

* **Python 3.11 standard library.** `http.server`, `sqlite3`, `hashlib` and `unittest` mean one process, no broker, no graph or vector database, and no cloud account.
* **Two pinned third-party libraries,** used only for independent validation: `jsonschema` checks responses against the generated schemas, and `openapi-spec-validator` checks the generated document.
* **Vanilla JS UI,** so there is no build step.

One local startup path runs both the workbench and the consumer.

## Where things stand

* **Tested:** all 36 automated tests pass. They cover every case in the brief's integration table (see `EVALUATION.md`), and the scripted demo reproduces the five-minute flow.
* **Not measured:** real-model link quality. Fixture mode only exercises the mechanics, and the live adapter has not been run in this environment because no credentials are configured. Review time has not been measured because no people have reviewed yet.
