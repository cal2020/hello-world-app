# AgentHorizon workbench

An implementation of **AgentHorizon: Evaluating Agentic Judges for Long-Horizon Computer-Use Tasks**
(arXiv:2610.11050v1). It has two layers:

- **Paper core.** The released data representation and validation, direct and agentic judging with the five native
  harnesses (Claude Code, Codex, Gemini CLI, OpenCode, OpenHands) inside a per-task sandbox, the fixed-denominator
  scorer (cross-checked against the authors' scorer), every paper experiment configuration and the analyses.
- **Application layer.** A FastAPI + PostgreSQL service with durable jobs, a React research workbench (data
  coverage, trajectory explorer and inspector, pair view, experiment setup, run monitor, results, blind review,
  operations), and Docker Compose packaging. These are engineering additions, not part of the paper.

**Status in the environment that built it.** The official dataset host, arXiv, and several model providers were
unreachable, and there were no credentials or budget. So no official AgentHorizon trajectory was ingested, no
live judge ran, and **no result here reproduces a paper number**. Every score in `evidence/` comes from a synthetic
test fixture and is labelled that way. Real supplemental data *was* imported: the AgentRewardBench expert
annotations and the OSWorld task definitions. See [What is verified](#what-is-verified) and
`evidence/REPRODUCTION_REPORT.md`.

## Quick start

### Local single-user mode

Requires Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/), PostgreSQL server binaries (`initdb`), and Node 22
(for the UI build).

```bash
uv sync                                   # Python deps from uv.lock
uv run agenthorizon bootstrap             # var/ dirs, local PostgreSQL (socket only), migrations, operator token
uv run agenthorizon dev                   # API + UI on http://127.0.0.1:8765, one judge and one trusted worker
```

Log in with the printed token; `bootstrap` also prints a `#login=` link.

### Docker Compose (multi-user)

```bash
cp .env.example .env                      # set four DB passwords (openssl rand -hex 24); credentials optional
docker compose up -d --build
docker compose run --rm admin users add alice --role operator      # token printed once
```

`OPERATIONS.md` covers trust boundaries, judge isolation inside containers, credentials, cost policy,
disk/network/GPU, licensing, backup/restore and recovery.

## Runbook

Every command below is implemented with these exact options (`agenthorizon <command> --help`). Values in angle
brackets are operator inputs, explained in the table that follows the commands.

```bash
agenthorizon bootstrap
agenthorizon sources lock --master-prompt <path to the implementation brief>   # writes evidence/SOURCE_LOCK.json
agenthorizon sources checkout agenthorizon-repo          # pinned 8584a347370ab1d92b908732cfabe72b3a23486d
agenthorizon data ingest --source agenthorizon --revision <DATASET_REVISION> --media none
agenthorizon data validate --dataset-version agenthorizon@<DATASET_REVISION>+n1
agenthorizon media materialize --dataset-version agenthorizon@<DATASET_REVISION>+n1
agenthorizon judges list
agenthorizon judges doctor
agenthorizon run --dataset-version agenthorizon@<DATASET_REVISION>+n1 --judge claude_code:claude-opus-4.7 \
    --manifest agenthorizon@<DATASET_REVISION>+n1:legacy-AH --smoke 5 --dry-run
agenthorizon run --dataset-version agenthorizon@<DATASET_REVISION>+n1 --judge claude_code:claude-opus-4.7 \
    --manifest agenthorizon@<DATASET_REVISION>+n1:legacy-AH --smoke 5 --budget-usd <BUDGET>      # development pilot
agenthorizon score --run <RUN_ID> --manifest agenthorizon@<DATASET_REVISION>+n1:legacy-AH --output score.json
agenthorizon export --run <RUN_ID> --output bundle.tar.gz --with-score
agenthorizon experiments list                             # 41 registered experiments, each with its blockers
agenthorizon experiments plan grid:claude_code:claude-opus-4.7
agenthorizon experiments report grid:claude_code:claude-opus-4.7 --output report.json --markdown report.md
agenthorizon supplemental import agentrewardbench          # real annotations from the pinned repository
agenthorizon supplemental import osworld                   # task definitions (not trajectories)
agenthorizon supplemental audit
agenthorizon dev
```

| Input | What it is | Where it comes from |
| --- | --- | --- |
| `<DATASET_REVISION>` | commit of `huggingface.co/datasets/ServiceNow/AgentHorizon` to pin | `agenthorizon sources lock`, run on a network that reaches huggingface.co. **Unresolved here:** the host was unreachable, so no revision could be pinned. The dataset version id is then `agenthorizon@<revision>+n1`. |
| `<RUN_ID>` | content-derived run identity (`run-` + 20 hex digits) | printed by `run`; `agenthorizon runs list` |
| `<BUDGET>` | explicit USD ceiling for a paid run | operator decision; no paid run starts without it |
| `<path to the implementation brief>` | the master prompt, so its digest is locked | operator file |

Manifests that exist after an official ingest: `<dv>:full-release`, `<dv>:legacy-AH`, `<dv>:legacy-AH-S`. The
revised AH-D/AH/AH-S manifests could not be located, so they are absent.

A worked example that runs here, entirely on the synthetic fixture with no network or credentials. The ids are
real; the fake endpoint returns a fixed verdict and is test-only.

```bash
agenthorizon fixture build --out /tmp/fx
agenthorizon data ingest --source local --local-dir /tmp/fx --media all     # -> fixture-synthetic@local-12e2b585e02e+n1
agenthorizon data validate --dataset-version fixture-synthetic@local-12e2b585e02e+n1
python -m agenthorizon.testing.fake_llm --port 8080 &                        # TEST ONLY endpoint
agenthorizon run --dataset-version fixture-synthetic@local-12e2b585e02e+n1 --judge direct:qwen3.6-27b:native-512x332 \
    --manifest fixture-synthetic@local-12e2b585e02e+n1:full-release --smoke 4 --base-url http://127.0.0.1:8080/v1
agenthorizon score --run <RUN_ID printed above>
```

## Where to look

| What | Where |
| --- | --- |
| Trajectories | UI → Trajectories (search, filters) → an example (timeline, screenshot viewer with zoom, keyboard `j/k`, `?step=` links) |
| Data coverage, revised vs legacy, supplemental sources | UI → Data coverage |
| Experiment setup, run monitor, results, review | UI → Experiments, Review |
| Specification and requirement traceability | `evidence/PAPER_SPEC.json`, `evidence/TRACEABILITY.csv` (every requirement's implementation and test references resolve, checked by `tests/test_traceability.py`) |
| Sources, availability, release reconciliation | `evidence/SOURCE_LOCK.json`, `evidence/DATA_AVAILABILITY.json`, `evidence/RELEASE_RECONCILIATION.md` |
| Data validation | `evidence/DATA_VALIDATION.json` |
| Model/harness capabilities | `evidence/MODEL_CAPABILITIES.json` (live: UI → Operations → Refresh capability report) |
| Experiments and paper reference data | `evidence/EXPERIMENT_REGISTRY.json`, `evidence/EXPERIMENT_INVENTORY.json`, `evidence/REFERENCE_DATA.json` |
| Supplemental separation audit | `evidence/DEDUP_AUDIT.json` |
| Tests, performance, container smoke test, screenshots | `evidence/TEST_REPORT.md`, `evidence/PERFORMANCE.json`, `evidence/STACK_SMOKE.json`, `evidence/screenshots/` |
| Fidelity and limitations | `evidence/REPRODUCTION_REPORT.md`, `OPERATIONS.md §11–12` |

## What is verified

- **Scorer**: hand-calculated fixture (2 positive, 2 negative, one missing, one string verdict → 50% balanced
  accuracy), score oracles, ID/denominator rules, exact category scoring, and agreement with the authors'
  `analyze_eval_results` on identical inputs (`tests/test_scoring.py`, `tests/test_reference_crosscheck.py`).
- **Judge inputs**: direct payloads are byte-identical to the released preprocessing. Parsers and the retry rules
  match the released functions, which are executed in isolation.
- **Blindness**: a probe inside the real sandbox cannot read labels, other tasks or the host, cannot reach the
  network except through the allowlist, and holds zero capabilities (`tests/test_isolation.py`). The same holds
  inside the judge container (`evidence/STACK_SMOKE.json`).
- **Runs**: crash, kill, cancel, pause, resume and budget behaviour, with no duplicate finals (`tests/test_runs.py`).
- **Application**: the API and workers on PostgreSQL (`tests/test_app.py`) and the full UI flows at desktop and mobile
  widths (Playwright, `frontend/e2e`).

Not verified here: any live model run, any official AgentHorizon item, and any paper number.

## Development

```bash
uv run pytest -q                       # full suite (PostgreSQL tests provision a temporary local cluster)
uv run ruff check src tests
cd frontend && npm ci && npm run build && npx playwright test   # needs AH_E2E from `python -m agenthorizon.testing.e2e_server`
python3 docker/smoke.py --out evidence/STACK_SMOKE.json        # Compose stack, after `docker compose build`
```

Layout: `src/agenthorizon/` (core library, API in `app/`), `frontend/` (React workbench), `tests/`, `docker/`
(images, seccomp profile, harness locks, smoke test), `evidence/` (generated reports: `agenthorizon evidence --help`).
