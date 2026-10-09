# Integration Workbench overview

This document covers what was built, how it works, what is real and what is simulated, how it compares to related work, and what it would take to turn it into a SaaS product. For commands and file layout see `README.md`. Design decisions are in `ARCHITECTURE.md`, hosting in `DEPLOY.md`, measured results in `EVALUATION.md`, and the interview script in `DEMO_SCRIPT.md`.

**Links**

| What | Where |
|---|---|
| Live app (runs in your browser, no server) | https://cal2020.github.io/hello-world-app/integration-workbench/app/ |
| Recorded walkthrough of the five-minute demo | https://cal2020.github.io/hello-world-app/integration-workbench/ |
| Guide (what is real vs. simulated, how to use it) | https://cal2020.github.io/hello-world-app/integration-workbench/guide/ |
| Code | `workbench/` on branch `claude/kbr-interview-prep-s59ic7` |

All data is synthetic. This is not a Cameo, Teamwork Cloud or SysML integration, and it says nothing about KBR's own systems. It explores one integration pattern that was described in conversation.

## The problem it addresses

When an engineering model changes, which APIs, data links and consuming applications are affected? How do you ship a fix without breaking anyone?

## What was built

| Part | What it does | Code |
|---|---|---|
| Model importer | Reads model exports and gives each element a stable identity: source, project and the source's own ID, never the name. Tracks revisions through their declared parent. Conflicting, out-of-order, unbased, invalid or partial imports are quarantined, rejected or staged, never applied to the head. Every import attempt is kept as a receipt. | `lucidwb/importer.py` |
| Contract generator | Turns a reviewed "projection" (an allowlist of the fields a consumer may see) into an OpenAPI 3.1.1 contract. Catches removed fields, unit changes (ms → s) and reversed relationships before release. | `lucidwb/projection.py` |
| Release manager | Builds a candidate. Validates its real HTTP responses against the contract. Asks the consuming app to run its own checks. Switches the live release in one transaction, with rollback. | `lucidwb/release.py` |
| Mock consuming app | An independent "equipment dashboard" with its own code, database and expectations. It deduplicates events, ignores out-of-date ones, and resynchronizes when it detects a gap. | `consumer_app/` |
| Link review | Proposes links between maintenance records and model elements, each with exact quotes that must match the stored source bytes. A person must approve. Approval fails if the model changed after the proposal was made. | `lucidwb/links.py`, `lucidwb/ai.py` |
| Safe retries and delivery | A retried request with the same idempotency key returns the original result instead of repeating the change. Events are written in the same transaction as the change that caused them, and resent until the consumer acknowledges them. | `lucidwb/receipts.py`, `lucidwb/outbox.py` |
| Web UI | Panels for model revisions, releases and contract changes, link review with highlighted evidence, and the full operation history. | `web/` |
| Deployment | The in-browser build (published), the recorded walkthrough (published), and a container with an access-code gate ready for Railway (not deployed). | `browser/`, `scripts/build_replay.py`, `Dockerfile`, `DEPLOY.md` |

## How it works

- **Stack.** The server uses the Python standard library: `http.server`, `sqlite3` and `unittest`. It adds two pinned libraries for independent validation, `jsonschema` and `openapi-spec-validator`. The UI is plain JavaScript with no build step.
- **Identity and history.**
  - Every element version is stored once and never changed. Each snapshot records which version of each element it contains.
  - A rename produces a new version of the same entity.
  - A removal is recorded as `deleted` in that snapshot, while earlier snapshots keep the element.
- **Change detection.** A diff between two snapshots separates three kinds of change:
  - data changes, such as a rename;
  - structural changes, such as a removed field definition;
  - semantic changes, such as a unit change that still passes schema validation. This kind is the one most likely to slip through.
- **Release gate.** A candidate can be activated only when:
  - it has no blocking diagnostics;
  - its latest consumer check passed against real responses;
  - its projection is still approved.

  Activation then moves a single pointer row inside a write transaction. A refused activation leaves the active release untouched.
- **Concurrency.** Accepting a link requires:
  - the proposal's current ETag (`If-Match`);
  - the source revisions the approver saw;
  - the approver's current permissions.

  All three are checked inside the write transaction.
- **AI boundary.** Code controls identity, permissions and activation. A model only proposes links. People approve them. Model output cannot set approval, permissions or targets outside the caller's project.
- **Browser build.** The same request handlers run as Python in the visitor's tab, using Pyodide 314.0.7. Each request is written as raw HTTP bytes into the unchanged handler classes, so routing, permission checks, receipts and errors are the server's code paths. Only two things differ:
  - the calls between the workbench and the consumer go to an in-process dispatcher instead of the network;
  - the outbox delivers on a one-second tick and after each request, instead of on a background thread.

## Value

- **Change impact is visible.** You can see which model change broke which consumer, and why.
- **Promotion is safe.** A failed candidate never replaces the working release, and consumers can see how far behind the latest validated model they are.
- **AI use has guardrails.** It shows a credible pattern for using AI on engineering data: quotes must resolve to retained source bytes, instructions planted in a source document gain no authority, and every review is bound to exact revisions.
- **Interview evidence for the three parts of the role.**
  - Architecture: boundaries and tradeoffs, in `ARCHITECTURE.md`.
  - Hands-on engineering: 126 automated tests, plus an independent multi-agent review whose 65 confirmed findings were fixed and re-verified.
  - R&D judgment: a deterministic baseline, honest labeling of the scripted AI path, and recorded limitations.

## Use cases

- **Systems engineering data.** Keep APIs generated from a model stable while the model changes. This is the pattern described for Digital Forge and Lucid Dream, explored here on synthetic data.
- **Operational records.** Link maintenance, test or incident records to model elements, with traceable evidence.
- **Testing consumers before promotion.** Any platform that publishes data to downstream apps needs to catch breaking changes before release.
- **Teaching or demonstration.** Contract testing, idempotency and transactional event delivery, shown on a working system.

## How to use it

1. Open the live app.
2. As **demo-carol** (release manager):
   1. import A;
   2. build from projection 1.0.0;
   3. run the consumer checks;
   4. activate.
3. Run the proposals. Then switch to **demo-alice** (approver) to accept or reject links.
4. As carol, import B and then C. You'll see an approval made before the change rejected as stale, and an incompatible release blocked.
5. Approve projection 1.1.0, then rebuild, retest and activate.
6. Inject the lost-acknowledgment fault: the consumer records one effect for two deliveries. Retrying the activation with the same key returns `Idempotent-Replay: true`.

`DEMO_SCRIPT.md` has the timed version with fallbacks. Locally, run `.venv/bin/python scripts/run.py --reset`, then `scripts/seed.py`.

## Parallels to other work

| Related work | What it shares |
|---|---|
| DMMC / SSP workbench (branch `claude/kbr-interview-prep-5267oa`) | An authoritative model producing generated artifacts. The in-browser Python deployment pattern was reused from it. |
| Procedure / TTP workbench and Evidence Link Bench (branches `claude/ttp-workbench-prototype-3t5kob`, `claude/jev-cameo-integration-x9rfwo`) | "AI proposes, evidence is checked, a person decides." The link review here applies that boundary to model data. |
| HEXIS (branch `claude/implement-these-start-2-p50awq`) | Governed actions, receipts and audit trails. |
| Industry patterns (concepts only; no compatibility is claimed) | Consumer-driven contract testing (as in Pact). Schema registries with compatibility checks. The transactional outbox. Idempotency keys in payment APIs. The identity, version and commit concepts of the OMG Systems Modeling API. |

## What was mocked or simulated

- **Data.** A fictional equipment-health system: pumps, sensors, a gateway, a telemetry service and requirements. It comes in versions A through E plus edge cases, with 12 fictional maintenance records and some engineering notes. The input format (`lwb-synthetic-export/1`) is invented, not a real Cameo export.
- **The consuming app.** It's a mock. Its checks, deduplication and gap handling are real code, and tests cover them.
- **The AI in the demo.** It's scripted: "fixture mode" replays hand-written outputs, including deliberate faults. It tests the validation and review mechanics, not model quality.
- **Identities.** Fixed demo tokens (carol, alice, bob, dana, admin and two service identities), not real authentication. The permission checks behind them are real and enforced.
- **The browser build.** Data lives only in the tab and resets on reload. The workbench and consumer run in one tab instead of on separate servers.

## What wasn't built or run

- **Real connectors.** There is no Cameo, Teamwork Cloud, SysML v2 API or OSLC connector.
- **The live AI adapter.** It uses the official Anthropic SDK but has never been called. No credentials were available, and the package is not installed by default. Real link quality and review time are unmeasured.
- **A shared, persistent instance.** The Railway deploy is prepared but not done. The access-code gate is a shared code, not user authentication.
- **Government hosting and compliance.** No FedRAMP, NIST, ATO, GovCloud or disconnected-environment work is claimed.
- **Known limits of the prototype:**
  - single instance on SQLite;
  - append-only history enforced by application code, not by storage;
  - multiplicity stored but not enforced;
  - unit conversion limited to an allowlist (s ↔ ms);
  - partial exports staged for viewing but never merged into the head.

## What still needs doing for the current scope

1. **Railway.** Deploy if one shared, persistent instance is wanted. The steps are in `DEPLOY.md` and take about 5 minutes in the Railway dashboard.
2. **Live AI evaluation.** Run it with an API key (`LWB_EVAL_LIVE=1 .venv/bin/python scripts/evaluate.py`), and add human reviewers to measure precision, recall and review time.
3. **Merge.** Merge this branch into `master` if it should live there.

## Roadmap to a robust SaaS application

**Phase 1: platform foundations**
- **Database.** Postgres with row-level tenant isolation, replacing SQLite.
- **Identity.** Real sign-in (OIDC/SAML), single sign-on, user provisioning (SCIM), and role-based access per project.
- **Event delivery.** A real message broker fed by the existing outbox, with stateless API servers that scale horizontally and separate background workers.
- **Audit.** A tamper-evident audit log (write-once storage or a hash-chained ledger table).
- **Operations.** Metrics, tracing and alerting, plus backups with tested restores.

**Phase 2: real integrations**
- **Source connectors.** A plugin interface, starting with one verified Cameo / Teamwork Cloud or SysML v2 API connector built against real versions, identity conventions and access rules.
- **Consumer registry.** Downstream teams register their apps and their own expectations. Every candidate release is tested against all of them.
- **CI gate.** A GitHub Action or CLI that runs the compatibility gate on pull requests to model or projection repositories.
- **Notifications.** Webhooks and Slack or Teams alerts when a release is blocked or a consumer falls behind.

**Phase 3: AI and analysis**
- **Live AI.** Link proposals measured against a held-out evaluation set with human labels, with metrics per model, and cost and rate limits per tenant.
- **Impact reports.** "Which consumers and links does this model change affect?" as a report available before an import is applied.
- **More relationship types.** Plus a reviewer queue with assignment and response-time targets.

**Phase 4: enterprise and government readiness**
- **Administration.** An admin console with usage, billing and self-service onboarding.
- **Compliance.** FedRAMP-aligned controls and a GovCloud deployment. A disconnected or on-premises edition; the in-browser build already shows the app can run without a server.
- **Data controls.** Encryption keys per tenant, data residency, retention policies, and exportable audit evidence for ATO packages.

**Suggested first step:** one real source connector plus a registry of real consumers. That tests the core claim, catching breaking model changes before consumers see them, on real data.
