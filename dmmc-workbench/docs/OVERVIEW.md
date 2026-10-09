# Overview: what was built, what it is for, and what is missing

A plain-language briefing on the prototype. The detailed references are [ARCHITECTURE.md](ARCHITECTURE.md),
[SIMULATED_INTEGRATIONS.md](SIMULATED_INTEGRATIONS.md), [THREAT_AND_AUTHORITY.md](THREAT_AND_AUTHORITY.md) and
[WEB_BUILD.md](WEB_BUILD.md).

## 1. What was built

A working prototype that keeps security-plan text tied to the system design and the evidence it came from, and
shows which statements and approvals are out of date when the design changes. One Python codebase runs in two ways:

- **Locally:** SQLite, a small web server (`python -m workbench serve`), a command line, and the OPA policy engine
  (a pinned binary whose SHA-256 is verified).
- **In any browser:** the same Python code on Pyodide, with the policies compiled to WebAssembly at build time. This
  version is live at https://cal2020.github.io/hello-world-app/dmmc-workbench/app/. There is no server: each
  visitor's state stays in their own browser.

| Part | What it does |
|---|---|
| Model importer (`importer.py`) | Validates the structure of a JSON system model (ids, names and revisions of components, boundaries and data flows, and that their references resolve) and stores each version as an immutable snapshot with its digest. Permissions and other attributes are stored as given, not validated |
| Evidence intake | Evidence items carry an environment, a status and, for observations, target revisions and an expiry date. One applicability rule decides, each time checks run, whether each item still counts |
| Checks (`checks.py`) | **AC-3:** the model's permissions compared with the enforced OPA policy, which also has 15 independent Rego tests. **AU-12:** every declared audit event type has records with the required fields. **SC-8:** the model must contain a transport-protection assertion (its value is recorded but not checked), and the applicable transport tests must report pass; with no applicable test the result is UNKNOWN. **Inherited controls:** UNKNOWN without provider evidence. Results are PASS, FAIL, UNKNOWN or ERROR |
| Drafter and validator (`drafting.py`) | Writes SSP-style statements in which every fact and gap claim cites its sources (limitation notes need no citation). The validator flags fact or gap claims that are uncited, and any claim that cites something that does not resolve, cites a source the drafter may not use, or uses prohibited or overclaiming wording. Whether a source actually supports a claim is left to the reviewer |
| Review (`review.py`) | Role-based: engineers cannot review. A decision is bound to the exact package digest, can be revoked, and uses optimistic concurrency |
| Staleness and impact (`packages.py`, `impact.py`) | Any change to the model, the evidence set (import, withdrawal or restore), catalog, mappings or policy makes a review STALE and blocks "export as currently reviewed". Evidence passing its expiry date does not by itself make a review STALE; it shows up when the package is rebuilt. The impact report lists what changed and which evidence no longer applies |
| Export (`export.py`) | Markdown SSP excerpt, evidence manifest, change-impact report, and an OSCAL component definition validated against NIST's OSCAL 1.2.3 schema (or clearly marked unvalidated when the validator is not installed) |
| Audit (`db.py`) | Append-only tables and a hash-chained log of every state change and of denied, refused or conflicting attempts (candidate-policy evaluations, acceptance-suite runs, identity switches and imports that fail validation are not logged) |
| AI-policy quarantine (`opa.py`) | A candidate policy (in the demo, fixture files standing in for AI-generated ones) is run against the independent tests with restricted capabilities before anyone considers it. One candidate fails 5 of 15 tests and one that calls `http.send` is rejected at compile |
| Evaluation | 22 acceptance scenarios, unit tests, and a browser end-to-end suite. The static build is reproducible |

## 2. How it works

1. **Import a model version.** It is digested and stored; it never changes afterwards.
2. **Import evidence.** Each item is stored with its digest; import only checks that its envelope is complete.
   Whether an item still counts (status, expiry, environment and target revision) is decided each time checks run,
   against the current model and clock, so evidence can stop applying later.
3. **Build a package.** Deterministic checks run first and produce structured results. The drafter then writes text
   only from those results and permitted, digest-pinned sources.
4. **Validate and fingerprint.** The validator flags claims that have no required citation, cite a source the drafter
   may not use, cite something that does not resolve to a pinned version, or use prohibited or overclaiming wording.
   Whether a source actually supports a claim is left to the reviewer. The package records a manifest of everything
   it depends on.
5. **Review.** A reviewer accepts or rejects; the decision applies to that package digest only.
6. **Detect change.** When the model, evidence set, catalog, mappings or policy change, the review becomes STALE,
   current export is refused, and the impact report guides the re-review. Evidence expiring over time is not
   detected until the package is rebuilt. Impact analysis explains *what* to look at; it never keeps
   an approval alive.

## 3. Value

- **Traceability:** facts and gaps must cite their sources (a model element, an evidence version, a check result, a
  catalog control statement or a curated mapping), and the validator flags any that have no citation, or that cite
  something which does not resolve or is not permitted.
- **No silent drift:** an approval cannot carry over to a changed design.
- **Honest uncertainty:** UNKNOWN is kept apart from PASS, so missing evidence shows up as work to do.
- **AI inside guardrails:** the drafter has no tools and cannot change evidence, review state or policy;
  deterministic checks and people decide. AI-written policy must pass independent tests first.
- **Auditability:** decisions pinned to digests, and a tamper-evident log.

## 4. Use cases

- Keeping SSP / ATO sections current while a model-based design evolves.
- Re-checks when evidence changes: a new evidence item or a status change (such as withdrawal) makes an existing
  review STALE. Expiry is caught only when a package is rebuilt.
- Pre-assessment readiness: seeing what is UNKNOWN or STALE before an assessor does.
- Change-impact review: which controls and approvals a design change touches.
- Trialling AI drafting or AI-written policy safely in a regulated workflow.

## 5. Using it

Open the live page (first load about 15 MB), or run it locally (README quick start). The five-step story is in the
[README](../README.md#the-five-step-demonstration) and [DEMO_SCRIPT.md](DEMO_SCRIPT.md). The identity menu switches
between simulated users: Bob (engineer), Alice and Carol (reviewers), Sam (security admin) and Mallory (engineer on
another project).

## 6. Parallels

| Area | Comparable work | How this differs |
|---|---|---|
| OSCAL / compliance as code | NIST's OSCAL tooling and open-source and commercial OSCAL-based compliance tools | Starts from the system model and focuses on when a review stops being valid, not only on generating documents |
| Policy as code | OPA / Conftest in CI and admission control | Uses policy to check a design model against a reviewed policy bundle (not shown to be deployed), plus a quarantine for AI-written policy |
| Model-based engineering documentation | Document generation from modelling tools | Adds evidence validity, digest-bound review and invalidation, not just rendering |
| Continuous authorization | Continuous-ATO efforts and compliance-automation products | Same goal of staying current; this is a small, transparent reference design |
| TTP-assistance prototype | — | Snapshots, citations, validator, digest-bound review, audit and the evaluation harness are reusable; the control logic is not ([ARCHITECTURE.md](ARCHITECTURE.md#reuse-with-a-ttp-assistance-prototype)) |

## 7. Limitations (true today)

- **Scope:** three controls, one fictional system, one model format (a JSON contract defined here, not a
  Cameo/SysML export).
- **Identity:** simulated users with no authentication. The local server is for localhost demos only.
- **Validator:** the overclaim rule is a word-pattern check and will miss paraphrases.
- **Audit:** the hash chain detects edits, but an administrator could rebuild it.
- **Evidence dates:** fixture evidence expires on 2027-06-30 unless the clock is pinned (the browser build pins it).
- **Browser build:** it cannot compile Rego, so only policies compiled at build time can be evaluated, and
  `opa check` verdicts are recorded at build time rather than recomputed. First load is about 15 MB. Building a
  package for a very large pasted model is slow, and the time grows much faster than the model does (in measurements
  on one machine, roughly 6 to 8 s with 2,000 permission roles, about 30 s with 4,000 and about 2 minutes with
  8,000).
  One tab at a time; no shared or multi-user state.
- **Local build:** a live model call would hold the database write lock while it waits.
- **Exports (both builds):** export files are written before the export row commits, so a failed commit can leave
  orphan files.
- **Expiry:** evidence passing its expiry date does not mark an existing review STALE; only a rebuild shows it.
- **Authority:** review here is document review. Nothing acts as an assessor or authorizing official.
- **Evaluation:** the cases and expected values were written by the same author as the code; they are engineering
  checks, not independent measurements.

## 8. Not built, mocked or simulated

| Item | Status |
|---|---|
| Cameo / Teamwork Cloud / OSLC | **Not built.** Hand-written JSON stands in for a model export |
| Evidence producers (scanners, test harnesses, log pipelines) | **Simulated** with fixture JSON |
| Identity provider / SSO | **Simulated** with a drop-down |
| Language model | **Optional adapter, not exercised.** A fixed fixture drafter is used; in the browser the live-model button shows a distinct failure |
| NIST SP 800-53 catalog | **Real content, small excerpt** (AC-3, AU-12, SC-8 from Rev 5.2.0); no baselines or profile resolution |
| OSCAL | **Real schema**, but only a component definition is produced; no SSP, assessment-plan or assessment-results models |
| OPA | **Real** (CLI and WebAssembly); no deployed decision service or decision logging |
| Program systems named in [SIMULATED_INTEGRATIONS.md](SIMULATED_INTEGRATIONS.md) | **Not integrated and not characterised** |
| Clock | Pinned to 2026-09-23 15:00 UTC in the browser build so the fixture evidence stays valid |

## 9. Needed before real program use

1. A model adapter for the actual tool export (element IDs, stereotypes/profiles), approved for data release.
2. Real evidence connectors with attributable or signed outputs and target identities that match the model.
3. Real identity and roles from the organization's identity provider, including revocation.
4. The full control catalog and baselines, with organization-defined parameter values.
5. Full OSCAL output (SSP, assessment plan, assessment results) and profile resolution.
6. An approved model provider for the data classification, with prompt and evaluation governance and cost and
   latency budgets; the model call moved out of the database transaction.
7. A stronger claim validator (semantic support checking), kept advisory and calibrated against human labels.
8. Independent evaluation: cases labelled by someone other than the author, and measured reviewer time and
   error-catch rates.

## 10. Toward a robust SaaS product

**Platform:** a real backend service with Postgres and tenant isolation (separate schemas or row-level security);
object storage for snapshots and exports; a job queue for builds, checks and model calls (operation IDs are
already idempotent); OPA as a service with signed bundles and decision logs; a policy editor with compile-on-save.
The browser build can remain as an offline or air-gapped mode.

**Security of the product itself:** SSO (SAML/OIDC), SCIM provisioning, fine-grained per-program roles, encryption
with tenant-managed keys, secrets management, audit logs streamed to write-once storage or a SIEM, and, for
government customers, a FedRAMP or DoD impact-level authorization path with CUI handling.

**Features:** connectors (modelling tools, issue trackers for re-review tasks, CI pipelines posting evidence, cloud
configuration and scanners); more frameworks through OSCAL profiles (for example NIST 800-171 / CMMC, ISO 27001);
review workflow (assignments, notifications, comments, statement diffs, e-signatures); dashboards (coverage,
STALE and UNKNOWN counts, expiring evidence, drift over time); an AI layer limited to approved sources with an
advisory judge and per-tenant evaluation sets; a public API and webhooks; import and export to GRC platforms.

**Operations:** infrastructure as code, staging and production, metrics and tracing, backup and restore, disaster
recovery, rate limits, billing, and keeping the reproducible, hash-pinned builds while adding an SBOM and signed
releases.

**A sensible first increment:** Postgres, real sign-in, one real model adapter and one evidence connector, and a full
OSCAL SSP, piloted on one program before going multi-tenant.
