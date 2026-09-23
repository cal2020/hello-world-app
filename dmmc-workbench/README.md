# DMMC model-to-evidence workbench (synthetic prototype)

A small, locally runnable application that turns a **synthetic** system model into a traceable
cybersecurity evidence package. Trace an element or data flow → a selected NIST SP 800-53 control
statement → a local demo obligation → a bounded executable check → its evidence → a draft SSP
paragraph. Change the model and the workbench marks affected material, makes prior review STALE,
and refuses to export it as currently reviewed.

> **What this is not.** Nothing here is an SSP, an assessment, a control-effectiveness finding or an
> authorization decision. All model data and evidence are fictional. The model format is a documented
> synthetic JSON contract, **not** a Cameo/SysML interchange format. No Cameo, Teamwork Cloud, OSLC or
> KBR system is connected. See [docs/SIMULATED_INTEGRATIONS.md](docs/SIMULATED_INTEGRATIONS.md).

## Quick start (offline after setup)

```bash
cd dmmc-workbench
./scripts/fetch_opa.sh                       # pinned OPA 1.20.0, SHA-256 verified -> .tools/opa
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # optional: OSCAL schema validation
export DMMC_NOW=2026-09-23T15:00:00Z         # optional: pin the clock for a deterministic demo
.venv/bin/python -m workbench demo           # reset + the five-step demo, printed
.venv/bin/python -m workbench serve          # UI at http://127.0.0.1:8765 (simulated identities)
.venv/bin/python -m workbench eval           # 22 acceptance cases + baseline comparison -> reports/
.venv/bin/python -m unittest tests.test_workbench
```

The core runs on the Python 3.11 standard library. Without `jsonschema`/`regex`, the OSCAL export
reports "validation NOT RUN" and writes `component-definition.UNVALIDATED.json` instead of claiming OSCAL.
Without OPA, policy checks return `ERROR`, never `PASS`.

## The five-step demonstration

| Step | Action | Observable result |
|---|---|---|
| 1 | Import model A + evidence set A, build package | 4 obligation rows; 3 of 4 rows have current applicable evidence; AC-3/AU-12/SC-8 portal PASS; inherited SC-8 UNKNOWN |
| 2 | Withdraw the portal→API transport test, rebuild | SC-8 portal→API UNKNOWN; design assertion still PRESENT; gap explains why; previous package STALE |
| 3 | Restore, rebuild, review as `alice` | ACCEPT bound to the exact package digest, gap rows recorded as acknowledged limitations, export succeeds |
| 4 | Import model B | Prior review STALE; "export as currently reviewed" refused; impact report: API changed, provider gateway + flow added, new SC-8 row, two evidence items no longer applicable |
| 5 | Import evidence set B, rebuild, review, export | 5 rows; AC-3 FAIL (model and reviewed policy disagree about write roles); provider flow SC-8 UNKNOWN (no test); exports + schema-valid OSCAL component definition |

Recorded CLI run: [sample-exports/demo-cli-transcript.txt](sample-exports/demo-cli-transcript.txt).
Screenshots: [docs/screenshots/](docs/screenshots/). Evaluation: [reports/evaluation_report.md](reports/evaluation_report.md).

## Layout

| Path | Purpose |
|---|---|
| `workbench/importer.py` | Import adapter: contract validation, stable ids, raw bytes + digests, JSON Pointers |
| `workbench/checks.py` | Check runner: AC-3 (OPA), AU-12 (record content), SC-8 (design vs observation), inheritance |
| `workbench/opa.py` | Local OPA runner; quarantined candidate evaluation with restricted capabilities |
| `workbench/drafting.py` | Fixture / seeded / live / baseline drafters; citation resolver; claim validator |
| `workbench/packages.py` | Immutable packages, dependency manifest, freshness and review state |
| `workbench/review.py` | Decisions bound to digests, optimistic concurrency, revocation |
| `workbench/impact.py` | Stable-id diff, affected rows, scope expansion, evidence applicability changes |
| `workbench/export.py` | Markdown SSP excerpt, evidence manifest, impact report, OSCAL component definition + validation |
| `workbench/identity.py` | The workbench's own authorization (separate from the target policy) |
| `workbench/db.py` | SQLite schema, append-only triggers, idempotent operations, hash-chained audit |
| `fixtures/` | Synthetic models A/B, evidence sets, curated mappings, target Rego + independent tests, candidates |
| `fixtures/catalog/` | Verbatim excerpt (AC-3, AU-12, SC-8) of NIST's OSCAL SP 800-53 Rev 5.2.0 catalog, upstream SHA-256 pinned |
| `schemas/` | NIST OSCAL 1.2.3 component-definition JSON Schema (unmodified release asset) |
| `eval/` | Acceptance cases, expected values, baseline comparison |

Docs: [architecture](docs/ARCHITECTURE.md) · [threat and authority boundaries](docs/THREAT_AND_AUTHORITY.md) ·
[model export contract](docs/MODEL_EXPORT_CONTRACT.md) · [simulated integrations](docs/SIMULATED_INTEGRATIONS.md) ·
[five-minute script](docs/DEMO_SCRIPT.md).

## Provenance of this code

This prototype was generated in one AI-assisted coding session (September 23, 2026) from a written brief.
It has not been deployed or used by anyone else, and it has not been reviewed by a security assessor.
