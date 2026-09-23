# Threat and authority-boundary note

| Layer | Owns | Cannot do | Enforced by | Verified by |
|---|---|---|---|---|
| Import adapter | Parsing, contract checks, ids, raw bytes, digests, pointers | Turn an imported description into an observation | `importer.validate_model`, evidence `kind` field | unit tests; E03–E05 |
| Canonical model | Snapshots, elements, flows, boundaries, revisions | Merge or reinterpret entities silently | Snapshot rows are append-only | trigger; E20 |
| Mapping service | Curated obligations with pinned control ids/params | Select a baseline, fill parameters, accept unknown ids | `reference.validate_mappings` | E07 |
| Check runner | Pinned predicates, OPA bundle, evidence applicability | Report PASS on missing input; turn evaluator errors into gaps | `checks.py` outcome rules | E02, E06, E17, E21 |
| Drafting adapter | Proposed narratives, questions, risk hypotheses | Change permissions, evidence, review state or policies (it has no tools or write path) | Architecture: drafter returns JSON only; validator | E15, E22 |
| Review service | Identified decisions, reasons, revocation | Accept a client/model "approved" flag; move a decision onto new text | Digest + dependency + head checks in one IMMEDIATE transaction | E10, E12, E13, E18 |
| Export service | Consistent snapshot, labels, validation report | Export STALE/revoked/unreviewed content as current; label unvalidated JSON as OSCAL | Status check inside transaction; `valid_oscal_claim` gate | E09, E12, E19 |
| Workbench authz | Role × project × revocation for every mutating call | Be bypassed by the UI | `identity.authorize` in each service; denials audited | E14 |

## Threats considered

| Threat | Mitigation in the prototype | Residual |
|---|---|---|
| Stale evidence reused (old revision, other environment, expired) | Applicability rules with reasons shown to reviewer | Relies on truthful envelope metadata; envelope is hashed but not signed |
| Evidence relabelled to a different target | Digest covers envelope + payload (found and fixed during this build: first version hashed payload only) | No producer signature |
| Prompt injection in source documents | Sources are data; drafter has no tools; approval language flagged; review needs an identified human | A live model could still write persuasive wrong text; only validator + reviewer stand between |
| Model-generated Rego replacing enforcement | Candidates only run in a temp dir with restricted capabilities (no `http.send`, `net.*`, `opa.runtime`) and an empty environment; reviewed bundle digest checked before/after | No OS sandbox (seccomp/containers); timeouts only |
| Reviewer approves then loses authority | Status re-checks reviewer revocation at read and export time | Revocation is a DB flag, not an IdP event |
| Concurrent reviewers | Optimistic head check + `BEGIN IMMEDIATE` | Single SQLite file; not a distributed lock |
| Lost acknowledgement / retries | Operation ids return committed result; reuse with different request is a conflict | Clients must send op ids (the UI does not) |
| Audit tampering | Append-only triggers + hash chain | A DB administrator can rewrite everything |
| Local UI abuse | Binds 127.0.0.1, CSRF token, SameSite cookie, CSP | No authentication, no TLS: demo only |

## Out of scope

Classified or CUI data, real identity providers, deployment hardening, FedRAMP/NIST compliance claims,
ATO/ATT readiness, disconnected-environment accreditation. An offline fixture run shows local
reproducibility, not suitability for any program environment.
