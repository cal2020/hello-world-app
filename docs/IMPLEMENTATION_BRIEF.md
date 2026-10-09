# Implementation brief: from prototype to product

Procedure Evidence Workbench · prepared 2026-10-09 · baseline commit `498e611` on `claude/ttp-workbench-prototype-3t5kob`

This brief is the plan for taking the prototype to a pilot-ready system and then to a multi-tenant SaaS product. It is written for engineers and coding agents. Each work item has a goal, a design, the files involved, acceptance criteria and what is out of scope. Items are ordered so that each phase leaves the system working, tested and demonstrable.

It also covers using a **local Ollama server on a laptop, reached over Tailscale**, as the first live model provider.

---

## 1. Baseline (what exists today)

| Area | State at `498e611` |
|---|---|
| Runtime | Node 22, `node:http`, `node:sqlite`, no framework. Browser UI in vanilla JS (Vite). A browser-only build runs the same server code in the page (sql.js). |
| Pipeline | Immutable source snapshots → manifest → permitted retrieval → generator → normalization → deterministic checks → candidate version → judgments and decision → export. |
| Generators | `fixture` (deterministic stand-in, one seeded error, **not AI**), `baseline` (template), `anthropic` (written, **never run**). |
| Controls | Decisions bound to candidate digest and manifest hash; transactional acceptance gate; STALE marking; claim-level impact (REASSESS / RECONFIRM); idempotent operations; hash-chained append-only audit. |
| Tests | 20 `node:test` tests, including process-kill crash/retry and restart. 18-case evaluation suite with declared criteria; gate PASS, 0 unsafe outcomes. |
| Simulated or missing | System-model data (hand-written JSON), identities (demo tokens), ingestion, dual review, configurable checks, connectors, multi-tenancy, deployment pipeline. |

Key files: `server/workbench.js` (pipeline, gate, impact, export), `server/checks.js`, `server/sources.js`, `server/ops.js`, `server/audit.js`, `server/evaluation.js`, `server/providers/*`, `server/router.js`, `src/workbench/main.js`.

## 2. Invariants (must not regress in any phase)

These are the product. Every change keeps them, and each has a test.

1. **The model proposes; code decides state.** Generator output never sets status, permissions or computed values. Unknown output fields are stripped and reported.
2. **Decisions bind to exactly what was reviewed.** A decision references the candidate digest and the source-manifest hash. It is valid only while both match. Export re-checks validity in the same transaction.
3. **Nothing is overwritten.** Source revisions, candidate versions, decisions and audit events are retained. Revocation and supersession are new records.
4. **Every displayed citation resolves** to an exact retained passage, or is shown as failing.
5. **Citation existence is separate from support.** A reviewer's judgment is stored separately from the mechanical check.
6. **No silent fallback.** A failed live-model run is recorded as failed. It is never replaced by fixture output.
7. **Every mutation is idempotent** by operation id, and recorded in the audit log, including denials.
8. **Honest labeling.** Simulated components are labeled in the UI, the exports and the evaluation report.

Any item below that would weaken one of these needs an explicit design decision recorded in `docs/decisions/` before implementation.

## 3. Phase overview

| Phase | Goal | Exit criterion |
|---|---|---|
| **0. Pilot-ready** (items 4.1–4.9) | Real model results, real documents, real review discipline, still single-tenant | Live-model evaluation on held-out cases with two independent human reviewers; a pilot customer can load their own documents |
| **1. SaaS foundation** (section 5) | Multi-tenant, deployable, observable, secure by default | Staging and production environments; tenant isolation tests pass; restore drill done |
| **2. Product depth** (section 6) | Scale, configurability, integrations, outputs | A second customer onboarded without code changes |
| **3. Enterprise and government** (section 7) | Assurance, disconnected edition, commercial operations | Disconnected edition installed from a package; audit package exported; billing live |

---

## 4. Phase 0: pilot-ready

### 4.1 Ollama provider over Tailscale

**Goal.** Run the drafting step against real models hosted by Ollama on a laptop, reached privately over Tailscale. This produces the first real model results and is also the seed of the disconnected edition (section 7.4).

**Network setup (laptop side).**
- Ollama listens on `127.0.0.1:11434` by default. Do not expose it to the internet, and do not use Tailscale Funnel (Funnel publishes to the public internet, and Ollama has no authentication).
- Choose one way to make it reachable inside the tailnet only:
  - **Preferred:** `tailscale serve --bg --https=443 http://127.0.0.1:11434`. Ollama stays on loopback, and Tailscale terminates HTTPS on the laptop's MagicDNS name, for example `https://<laptop>.<tailnet>.ts.net`.
  - **Alternative:** set `OLLAMA_HOST=<laptop tailscale IP>:11434`, so Ollama binds to the Tailscale interface only, not `0.0.0.0`.
- Add a Tailscale ACL so only tagged machines can reach the laptop's Ollama port. For example, allow `tag:workbench-dev` and `tag:workbench-ci` to the laptop's port, and nothing else.
- Some Ollama versions check the request `Host` header or `Origin`. If requests through `tailscale serve` are refused, set `OLLAMA_ORIGINS` to the MagicDNS origin. Verify this against the installed Ollama version.

**Network setup (caller side).** The process that calls Ollama must be on the tailnet.
- **Developer machine:** join the tailnet, then run the workbench or `npm run eval` locally.
- **CI:** use the Tailscale GitHub Action with an ephemeral, tagged auth key (`tag:workbench-ci`) stored as a repository secret. The job joins the tailnet, runs the evaluation and leaves.
- **Claude Code cloud sessions:** these containers are not on the tailnet and cannot reach the laptop. Run live evaluations from a tailnet machine, or from CI. Do not open the laptop to the public internet to work around this.

**Configuration (environment variables).**

| Variable | Example | Meaning |
|---|---|---|
| `OLLAMA_BASE_URL` | `https://laptop.tailnet-name.ts.net` | Base URL; no trailing slash |
| `OLLAMA_MODELS` | `modelA:tag,modelB:tag` | Comma-separated models to offer and evaluate |
| `OLLAMA_TIMEOUT_MS` | `180000` | Per-request timeout. Allow for cold model loads. |
| `OLLAMA_NUM_CTX` | `16384` | Context window to request; must fit the prompt |
| `OLLAMA_KEEP_ALIVE` | `10m` | How long Ollama keeps the model loaded |

**Design.**
1. Refactor the prompt and output schema out of `server/providers/anthropic.js` into `server/providers/shared.js`: `SYSTEM`, `buildPrompt(ctx)`, `OUTPUT_SCHEMA`. Both live providers then use the same prompt and schema, so results are comparable.
2. Add `server/providers/ollama.js`:
   - `ollamaAvailable()`: true if `OLLAMA_BASE_URL` is set.
   - `listOllamaModels()`: `GET /api/tags`. Returns name, digest, family, parameter size and quantization for each model. Cache for 60 seconds.
   - `generateOllama(ctx, { model })`: `POST /api/chat` with:
     - `model`;
     - `messages: [{role:'system', content: SYSTEM}, {role:'user', content: buildPrompt(ctx)}]`;
     - `format: OUTPUT_SCHEMA` (Ollama's structured-output support constrains the reply to the schema);
     - `stream: false`;
     - `options: { temperature: 0, seed: <fixed per run>, num_ctx }`;
     - `keep_alive`.
   - Parse `message.content` as JSON. Raise typed errors: `PROVIDER_UNAVAILABLE` (network, DNS, timeout), `PROVIDER_MODEL_MISSING` (404 or unknown model), `PROVIDER_BAD_OUTPUT` (invalid JSON), `PROVIDER_TRUNCATED` (`done_reason` is `length`).
   - Return usage: `prompt_eval_count` as input tokens, `eval_count` as output tokens, and `total_duration` and `load_duration` converted from nanoseconds to milliseconds.
   - Verify field names against the installed Ollama version's API documentation before relying on them.
3. In `server/workbench.js`:
   - Add `ollama` to `runConfig()` with `mode: 'LIVE_MODEL'`, `provider: 'ollama'`, `model`, **`modelDigest`** (from `/api/tags`), `promptVersion: 'shared-draft-v1'`, and `sampling: { temperature: 0, seed, numCtx }`.
   - The model digest goes into the configuration hash, so pulling a new build of the same tag creates a new configuration.
   - Wire `generateOllama` into the generation phase of `startRun()`. Failure semantics are the same as for `anthropic`: the run is FAILED, no version is created, and nothing is substituted.
4. In `server/router.js`, add `GET /api/providers`, which returns availability for each provider and the Ollama model list (names and digests only).
5. In the UI generator picker, list one option per available Ollama model, labeled "Local model (Ollama): <name>". Show the model and a short digest on the run, the version chip and the export. Keep the live-model options hidden in the hosted browser build.
6. **Cost.** Ollama runs have no per-token price. Record tokens and wall time, and report "local compute, no API cost" rather than zero cost.
7. **Prompt injection.** No change in behavior: source text stays data, output is normalized, and the checks still apply. Add one evaluation case per live model that confirms injected text does not produce an acceptance.

**Files.** `server/providers/shared.js` (new), `server/providers/ollama.js` (new), `server/providers/anthropic.js`, `server/workbench.js`, `server/router.js`, `src/workbench/main.js`, `README.md`, `docs/OLLAMA.md` (new, covering the setup steps above).

**Tests.**
- Unit tests with a local stub HTTP server that mimics `/api/tags` and `/api/chat`. Cover a valid reply, invalid JSON, a truncated reply, a timeout and an unknown model.
- A test that a failed Ollama run creates no version and is labeled LIVE_MODEL FAILED.
- A test that changing the model digest changes the configuration hash.

**Acceptance.**
- With the tailnet reachable, the full demo path runs with an Ollama model in the UI.
- The run shows the model name and digest, token counts and latency.
- With the laptop asleep, generation fails within the timeout with `PROVIDER_UNAVAILABLE`, visibly, and no version is created.

**Out of scope.** Streaming partial drafts to the UI, and tool use or agents.

### 4.2 Live-model evaluation and human labeling

**Goal.** Turn "does the AI help?" into measured evidence.

**Design.**
1. Extend `server/evaluation.js` so configurations are data, not code. A suite run takes a list of configurations: `fixture-sim-v1`, `baseline-template-v1`, one entry per Ollama model, and `anthropic` when a key is set. Each has a configuration hash, and live configurations record the model digest.
2. **Repeats.** Run each live configuration on each case at least 3 times with different seeds. Report the mean and range, and keep repeats separate from distinct cases in the denominators.
3. **New automatic metrics per draft:**
   - invalid citation rate;
   - fact claims with no evidence;
   - gap and conflict disclosure versus what the code checks found;
   - requirement coverage;
   - schema failures;
   - latency;
   - tokens.
4. **Blind human labeling.** Add a labeling screen, reachable only by reviewers, that shows one claim, its cited passage and the source revision, without the model name or any automatic score. Labels: supports, does not support, contradicts, insufficient, plus a free-text note. Two reviewers label each claim independently. Disagreements are recorded before any discussion, then reconciled with a third label.
5. **Report.** `npm run eval -- --live` writes `docs/EVALUATION_REPORT.md` with:
   - one column per configuration;
   - human-adjudicated unsupported-claim rate with its denominator;
   - inter-reviewer agreement, as raw agreement and Cohen's kappa;
   - review minutes per draft, from timestamps on the labeling screen.
6. **Criteria declared in advance.** Before the first held-out live run, write the stop/go thresholds into `fixtures/eval/criteria.json` and commit them. Suggested starting points, to be agreed with the subject-matter experts:
   - zero unsafe acceptances;
   - human-adjudicated unsupported claims no higher than an agreed rate;
   - gap disclosure better than the template baseline.
7. **Expand the case set** from 18 to 40–60 cases, with a third held-out split that nobody looks at until the final run.

**Acceptance.** One committed report with real Ollama results on held-out cases, labeled by two people, with agreement statistics. The live-model columns show model digests.

**Out of scope.** Using an LLM as a judge. If added later, its scores are advisory only and must be calibrated against the human labels.

### 4.3 Dual review and separation of duties

**Goal.** Make review discipline enforceable, not just recorded.

**Design.**
- Store judgments per reviewer. The effective judgment for a claim requires agreement from the configured number of reviewers (default 2). A disagreement blocks acceptance until a third reviewer resolves it.
- **Separation of duties:** a user who created or edited a version cannot record the acceptance on it. Enforce this in `decide()`.
- Project policy object: `{ requiredReviewers, allowSelfAccept: false, bulkJudgmentAllowed }`, stored per project and recorded in the decision.
- Remove the demo-shortcut bulk judgment in non-demo projects.

**Files.** `server/workbench.js`, `server/db.js` (migration), `src/workbench/main.js`, tests.

**Acceptance.** Tests prove four things:
- one reviewer is not enough;
- an editor cannot accept their own edit;
- a disagreement blocks acceptance;
- a resolved disagreement shows all three judgments in history.

### 4.4 Document ingestion

**Goal.** Load real documents instead of hand-written JSON.

**Design.**
- Accept PDF, DOCX, Markdown and plain text. Store the original file by content hash. Extract text with page and paragraph positions.
- Segment the text into passages with stable locators (`page:3/para:4`, or a heading path), and keep character offsets into the extracted text.
- Structured fields such as `maxCalibrationAgeDays` come from an explicit mapping step: either a reviewer confirms values the model suggested, or a per-document-type template supplies them. Extracted values are never trusted silently.
- Re-ingesting a new revision of the same document maps passages to the old ones by text similarity, so the impact view can report "changed" versus "unchanged" passages across revisions.
- Scanned PDFs need OCR. Treat OCR text as lower confidence and flag it in the evidence panel.

**Libraries.** Choose Node libraries for PDF and DOCX extraction, pin them, and record their licenses. Keep extraction in a separate worker, because parsers are a common source of crashes and vulnerabilities.

**Acceptance.** A real (non-sensitive) public document goes through import → passages → citation → change impact. Re-importing an edited copy shows the correct changed and unchanged passages.

### 4.5 Relevance-filtered staleness

**Goal.** Stop marking every open version stale when an unrelated source arrives.

**Design.**
- Each version records its dependency scope: the source ids it cites, the source ids each computed check reads, and the document types its checks consume (for example, any calibration certificate).
- An import marks a version stale only if the new or revised source is in its scope.
- Keep a project setting `staleness: 'conservative' | 'scoped'`, defaulting to conservative until the pilot shows scoped mode is safe.
- Decision validity still uses the full manifest hash in conservative mode. In scoped mode it uses a hash of the scoped manifest, recorded on the decision.

**Acceptance.** Importing an unrelated source leaves a REVIEWED_FOR_DEMO version valid in scoped mode, and still stales it in conservative mode. Importing a new calibration certificate always stales calibration-dependent versions (existing case H03).

### 4.6 Configurable check packs

**Goal.** Replace the scenario-specific checks with rules a project can configure.

**Design.**
- Keep the generic checks in code: citation resolution, required evidence, schema, hypotheses used as support, instruction-like text.
- Move domain rules (calibration currency, serial consistency, required observations) into versioned check packs.
- Each rule declares its inputs (document types and fields), its output (pass, fail or unknown, with a message) and its severity.
- Rule language: start with a small declarative JSON format interpreted in code. Move to OPA/Rego (section 6.3) when rules need more expressiveness.
- Every check pack ships with its own test cases. A pack version is recorded on each run and in the configuration hash.

**Acceptance.** The current PSK-7 checks run as a pack, all tests pass unchanged, and a second pack for a different invented scenario works without code changes.

### 4.7 Real authentication

**Goal.** Replace demo tokens with real sign-in.

**Design.**
- OIDC sign-in (Microsoft Entra ID first, since the audience uses Teams), using authorization-code flow with PKCE.
- Server-side sessions in an HttpOnly, Secure, SameSite cookie, with CSRF protection on mutating routes.
- Map identity-provider groups to the existing roles (viewer, author, reviewer) plus a new admin role.
- Keep demo tokens behind an explicit `DEMO_MODE=1` flag, and show a banner when it is on.

**Acceptance.** Sign-in works against a test tenant. Authors cannot accept. Session expiry and logout work. The audit log records the identity-provider subject.

### 4.8 First connector (discovery first)

**Goal.** Import real system-model data, but only after confirming what the customer has.

**Design.**
- **Discovery:** ask the customer which modeling tool versions, repository products (for example Teamwork Cloud) and interfaces (REST API, OSLC, export formats) are installed and permitted. Verify against official vendor documentation. Do not assume any interface.
- **Build the adapter behind the existing snapshot interface.** An export becomes a source snapshot with stable element ids and the model revision, and the original export file is kept for provenance.
- Until access exists, support a file-based import of a customer-provided export.

**Acceptance.** A customer-provided export imports, and its elements can be cited. A model revision change produces a correct impact report.

### 4.9 Pilot operations

- **Backups.** Nightly SQLite backup with a restore test, until Phase 1 moves to Postgres.
- **Demo and pilot separation.** Separate databases and URLs. Demo stages never run against pilot data.
- **Pilot runbook.** How to onboard documents, assign reviewers and read the evaluation report.

---

## 5. Phase 1: SaaS foundation

### 5.1 Multi-tenancy and data model

- Move from SQLite to **Postgres**. Every table gets `tenant_id` and `project_id`. Enforce row-level security policies keyed on a session variable set per request, and test that one tenant cannot read another's rows.
- **Migrations** use a versioned migration tool, with forward-only migrations and a rollback plan for each.
- **Immutability** moves from SQLite triggers to Postgres triggers plus revoked UPDATE and DELETE privileges for the application role on append-only tables.
- **Map current tables** one to one. Change `audit_events` to per-tenant hash chains, so each tenant's chain can be verified and exported on its own.

### 5.2 Object storage

- Store original source files and exports in object storage (S3, or S3 in GovCloud for government customers), keyed by content hash, under a per-tenant prefix.
- Encrypt with a per-tenant key in KMS.
- Signed URLs for downloads, with short expiry.

### 5.3 Background jobs

- Ingestion, generation, evaluation and exports run as jobs on a durable queue (SQS with workers, or Temporal).
- Keep the operation-id idempotency: a job carries the operation id, and the result is committed with it.
- Retries with backoff for provider errors. A job that fails after its last retry marks the run FAILED. It never substitutes output.
- UI progress through polling or server-sent events.

### 5.4 Deployment and delivery

- **Packaging.** Containers with a non-root user, read-only filesystem, health checks and resource limits.
- **Runtime.** Start on a managed container service (ECS Fargate or similar). Move to Kubernetes only if customers require it.
- **Infrastructure as code** (Terraform) for networks, database, storage, queues, secrets and DNS.
- **CI/CD.** Lint, unit tests and the evaluation suite on every pull request. The demo gate (0 unsafe outcomes) is a required check. Deploy to staging automatically and to production with approval.
- **Supply chain.** Pinned dependencies, a software bill of materials, image scanning and signed images.
- **Policy as code** for infrastructure checks, using tools such as Checkov and OPA.

### 5.5 Observability

- Structured JSON logs with a request id and operation id. Never log source text or secrets.
- Traces across HTTP, jobs and model calls. Metrics for latency, error rate, queue depth, model tokens and cost, and evaluation gate status.
- **Alerts:** provider unavailable, failed jobs, an audit chain verification failure, cross-tenant access denials.

### 5.6 Security baseline

- TLS everywhere.
- Secrets in a managed secret store.
- Content Security Policy on the UI.
- Rate limits per user and tenant.
- Input size limits on uploads.
- Dependency and container scanning in CI.
- Periodic penetration test.
- Threat model document kept with the code.

### 5.7 Resilience

- Point-in-time recovery for Postgres, and versioning on object storage.
- Documented recovery time and recovery point objectives.
- A restore drill before the first production tenant.

**Phase 1 acceptance.**
- Staging and production exist and are created from code.
- Tenant isolation tests pass.
- A restore drill succeeds.
- All Phase 0 tests and evaluation gates run in CI.

---

## 6. Phase 2: product depth

### 6.1 Retrieval at scale

- Replace "send every permitted passage" with **hybrid retrieval**: keyword search plus vector search, with access-label filters applied before ranking.
- Embeddings can come from an embedding model in Ollama (`/api/embed`) for local and disconnected use, or from a hosted embedding provider. Record the embedding model and digest in the run configuration.
- Store vectors in Postgres with pgvector.
- The run still records exactly which passages the model saw.
- Evaluate retrieval separately, measuring recall of the passages the human-labeled answers needed.

### 6.2 Provider abstraction and gating

- One provider interface for Ollama, the Anthropic API, Bedrock and on-premises endpoints, all using the shared prompt and schema.
- A project can only select a configuration (model, digest, prompt version, check pack) that has a passing evaluation report on file. Changing any part creates a new configuration that needs its own evaluation.

### 6.3 Rules engine

- Move check packs to **OPA/Rego**, compiled to WebAssembly so the browser build can run the same rules.
- Rule packs are versioned, signed and tested in CI.

### 6.4 Dependency graph

- Element-level links: requirement → model element → claim → step.
- Impact analysis walks the graph, and the UI shows a claim-to-source map.
- Scoped staleness (4.5) uses the graph instead of source ids alone.

### 6.5 Review workflow

- Assignments and review queues with due dates.
- Notifications through email, Teams and Slack.
- Electronic signatures for customers that need them, recorded with the decision.

### 6.6 Outputs

- DOCX and PDF exports with an embedded evidence appendix and a visible review-status banner.
- OSCAL export for security-documentation customers.
- Every export records its content hash and the decision it relied on.

### 6.7 Public API and webhooks

- Versioned REST API with OpenAPI documentation and API keys scoped by tenant and role.
- Webhooks for events such as a version becoming stale, an acceptance being recorded or an export being produced.

---

## 7. Phase 3: enterprise and government

### 7.1 Integrations

Integrations with Cameo and Teamwork Cloud, DOORS and Jama, Jira, SharePoint and Confluence. Each one is built only after confirming the customer's real interfaces (section 4.8).

### 7.2 Audit assurance

- Write-once storage for audit exports (S3 Object Lock).
- Signed audit events, with periodic anchoring of the chain head.
- Exportable audit packages for assessors.

### 7.3 Compliance path

- Encryption with customer-managed keys, data residency options and a GovCloud deployment.
- Prepare for FedRAMP or DoD Impact Level controls with an assessor.
- Nothing in this brief claims compliance today.

### 7.4 Disconnected and on-premises edition

- A packaged deployment (containers plus an installer) with no outbound dependencies.
- Ollama, or another local inference server, as the model provider. This is where item 4.1 pays off: the same provider code serves the disconnected edition.
- Offline license file, and update bundles signed and imported manually.
- The evaluation suite runs inside the installation, so customers can re-verify a model before enabling it.

### 7.5 Commercial operations

- Usage metering: generations, reviewed documents and storage.
- Billing, an admin console, SLAs and support tooling.

---

## 8. Cross-cutting requirements

**Testing.**
- Every invariant in section 2 has a test.
- Every new provider has stub-server tests.
- Every migration has an up test and a data-preservation test.
- The evaluation suite is a required CI check.

**Documentation.**
- Each phase updates `README.md`, `docs/ARCHITECTURE.md` and `docs/GAPS.md`.
- Design decisions are recorded in `docs/decisions/` (one file per decision: context, options, choice, consequences).

**Data handling.**
- Pilot and demo use synthetic or customer-approved data only.
- No customer data in logs, screenshots, evaluation fixtures or prompts sent to providers the customer has not approved.

**Honesty.**
- Labels for simulated components stay in the product until the component is replaced.
- Reports state denominators, repeats and what was not measured.

## 9. Open decisions for the owner

1. **Which Ollama models to evaluate first, and the laptop's MagicDNS name.** The brief assumes 2–3 models of different sizes.
2. **Whether to add the Anthropic API as a reference provider** in the evaluation (needs an API key and a budget).
3. **The stop/go thresholds** for the live evaluation, agreed with the subject-matter experts before the held-out run.
4. **First pilot customer and document type**, which decides the first check pack and connector.
5. **Hosting target for Phase 1:** commercial cloud first, or GovCloud from the start.
6. **Identity provider for the pilot** (Entra ID assumed).

## 10. Risks

| Risk | Mitigation |
|---|---|
| The laptop is asleep or off the tailnet during an evaluation | Timeouts, explicit `PROVIDER_UNAVAILABLE`, rerun from CI with an ephemeral tailnet key |
| Local models produce poor citations | That's a valid finding; the checks catch mechanical failures and the report states it |
| Ollama is exposed beyond the tailnet by mistake | `tailscale serve` (tailnet only), never Funnel; an ACL restricted to tagged machines |
| A model tag is updated under the same name | Model digest in the configuration hash |
| Reviewer fatigue from conservative staleness | Scoped staleness (4.5) behind a project setting |
| Parser vulnerabilities in ingestion | Isolated worker, pinned libraries, size limits |
| Overclaiming in demos or sales | Invariant 8, and reports that state what was not measured |

## 11. Suggested order of work

1. 4.1 Ollama provider, with stub tests, then the first real runs from a tailnet machine.
2. 4.2 Live evaluation with blind dual labeling, then commit the report.
3. 4.3 Dual review and separation of duties.
4. 4.4 Ingestion and 4.6 check packs, in parallel.
5. 4.5 Scoped staleness, 4.7 authentication, 4.8 connector discovery.
6. Phase 1, starting with the Postgres move and CI gates.
