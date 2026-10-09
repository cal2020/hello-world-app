# Roadmap

The path runs from demonstrator to pilot to product. Each phase ends with a decision. The stop conditions at the bottom apply at every phase.

## Phase 0: Discovery

Goal: decide whether to build anything at all.

- [ ] Inventory what existing integrations and traceability features already cover (Cameo / Teamwork Cloud, the requirements tool, the test tool).
- [ ] Observe an engineer reconciling requirements and evidence, and time where effort actually goes.
- [ ] Confirm whether interpreting meaning is a real bottleneck, or whether the gap is data access, identity mapping or process.
- [ ] Identify the deployment constraints: hosted vs. on-premises, data markings, model approval.

**Exit:** a written go/no-go. "Existing tools already cover it" is a valid outcome.

## Phase 1: Pilot-ready

Goal: answer the evaluation question on realistic data.

- [ ] **Live judge adapters** behind the existing `judge()` interface: the judgment model, a conventional LLM, and a rules baseline. Include timeouts, bounded retries, version pinning and full request/response logging.
- [ ] **Real data path:** import one requirements export (for example ReqIF or CSV) and one structured test-results format, with stable IDs and revisions.
- [ ] **Richer criterion model:** ranges, tolerances, units across quantities (time, temperature, voltage), preconditions and operating states, multiple measurements.
- [ ] **Evaluation harness:** 50 distinct labeled cases, with a 20-case tuning set and a 30-case held-out set. Calibrate confidence thresholds on the tuning set only.
- [ ] **Metrics:** median review time, incorrect accepted links (the guardrail), abstentions, latency (p50/p95) and total cost.
- [ ] **Reviewer-bias arm:** the same cases reviewed with and without model suggestions.
- [ ] **Persistent shared audit storage** with real reviewer identity.

**Exit:** proceed only if median review time drops by at least 25% with no increase in incorrect accepted links compared with the best non-model arm. Fifty cases guide the next experiment; they do not establish production assurance.

## Phase 2: Product foundations (single tenant)

- [ ] **Backend service** (for example TypeScript/Node or Python) with PostgreSQL.
- [ ] **Identity:** SSO (SAML/OIDC), role-based access (reviewer, approver, admin, auditor), and attribute-based access for markings such as export control.
- [ ] **Append-only audit ledger:** hash-chained or signed records, retention policies, and export for auditors.
- [ ] **Change detection:** webhooks or polling, so a changed source automatically marks dependent approvals stale and queues re-review.
- [ ] **Controlled write-back:** accepted links pushed to the system of record as trace relationships, with idempotency and conflict handling.
- [ ] **Background jobs** for imports, model calls and re-evaluation.
- [ ] **Observability:** traces, metrics, alerting, and dashboards for model latency and cost.

## Phase 3: SaaS (multi-tenant)

**Platform**
- [ ] Tenant isolation (row-level security or per-tenant schemas), SCIM provisioning, rate limiting, backups and disaster recovery.

**Integrations**
- [ ] Connectors for Cameo / Teamwork Cloud (via the export or API your environment supports, or OSLC), DOORS Next, Jama Connect, Polarion, Jira/Xray, TestRail and qTest.
- [ ] Generic ReqIF and CSV import.

**AI layer**
- [ ] Pluggable judge providers per tenant (hosted models, and self-hosted models for restricted environments), each with version pinning.
- [ ] **Candidate generation:** retrieval (embeddings plus structured filters) to propose which evidence might match which requirement, instead of reviewing pre-paired cases.
- [ ] Per-tenant calibration on labeled data, and drift monitoring when model versions change.
- [ ] Layered prompt-injection defenses: isolate untrusted text and validate outputs. The architecture stays the primary defense.
- [ ] Cost controls: routing, caching, batching and budgets.

**Review experience**
- [ ] Queues, assignment, priorities and service-level targets.
- [ ] Bulk review of high-confidence, all-checks-pass candidates, with sampling for quality control.
- [ ] Side-by-side source viewers with deep links into the original tools.
- [ ] Discrepancy workflows (for example, "report says PASS, number fails" opens an issue).
- [ ] Built-in bias experiments: randomly hide suggestions for a sample of reviews.

**Analytics**
- [ ] Coverage (requirements with verified evidence), stale links, throughput, review time, overturned decisions, and model agreement with reviewers.
- [ ] Exports for compliance packages, such as a verification cross-reference matrix.

## Phase 4: Defense and regulated deployment

- [ ] **Deployment editions:** single-tenant cloud, and on-premises or air-gapped installs (Kubernetes/Helm) for programs that cannot use hosted services.
- [ ] **Compliance:** SOC 2 for commercial customers; FedRAMP and DoD Impact Levels (IL4/IL5), CMMC, and ITAR/EAR handling for defense work. These are multi-month efforts and often decide whether the product can be sold into this market at all.
- [ ] **Data handling:** encryption in transit and at rest, customer-managed keys, data residency, and contractual no-training guarantees from model providers.

## Stop conditions (every phase)

Stop, or change direction, if any of these hold:

- Reviewers accept more bad links when shown model suggestions than without them.
- An existing connector or matching feature already covers the need.
- The model cannot run within the deployment environment's data-handling and access constraints.
- The time saved does not justify the integration and operating cost.
