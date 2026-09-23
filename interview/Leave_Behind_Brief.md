# Traceable evidence from system models: a synthetic prototype

Evren Çakır · for discussion with the KBR team · draft for Evren's review (not sent)

**Problem.** Security artifacts generated from system-model data are only useful if each statement can be traced to a current source, and if people can see when a model change makes a statement or a review out of date.

**What the prototype does.** It is a local, offline-capable workbench. Everything in it is synthetic.
- It imports a versioned model (a documented JSON contract, not a Cameo format) and evidence, pinning both by content digest.
- It runs bounded checks for three NIST SP 800-53 statements (AC-3, AU-12, SC-8):
  - OPA policy tests checked against the model's declared permissions,
  - audit-record content,
  - design assertion vs transport-test observation per boundary-crossing flow.
- It drafts SSP-style text in which every factual claim cites a source. A validator flags uncited, unresolvable, not-permitted or prohibited statements (compliance claims, invented CVEs, approval language).
- It records reviewer decisions bound to the exact content and its dependencies.
- When the model changes:
  - older evidence becomes inapplicable,
  - prior review becomes stale,
  - export "as currently reviewed" is refused,
  - an impact report lists the affected rows by stable ID.

**Architecture.** A single Python process with SQLite:
- append-only tables and a hash-chained audit log,
- a pinned OPA binary run as a subprocess,
- the NIST OSCAL 1.2.3 schema for an optional component-definition export,
- an optional, off-by-default model adapter.

The drafter has no tools and no write path. Generated policy is evaluated only in quarantine against tests written from the requirements.

**Evidence (September 23, 2026, synthetic).**
- 22 of 22 acceptance scenarios passed. They cover stale, other-environment and expired evidence, conflicts, revoked reviewers, concurrent review, retry after commit, prompt injection, and invalid OSCAL.
- A seeded bad draft had all 6 failure modes flagged.
- A plausible generated policy failed 5 of 15 independent tests, and the enforcement policy was unchanged.
- On the same 4 scenarios, a template baseline produced 11 unsupported implementation statements; the workbench produced 0.

**Relevance.** From our conversations, DMMC produces assessment, SSP and checklist material from model data, with AI suggesting risks and mitigations. The transferable ideas are source identity, keeping assertions separate from observations, digest-bound review, and change propagation. The same pieces would support an AI-assisted procedure-drafting experiment with SME review.

**Limitations.** No Cameo, Teamwork Cloud or KBR system is connected. Evidence is fictional. Identities are simulated. The AI drafting shown is deterministic, so language-model quality is unmeasured. Control mappings are illustrative, not assessor-validated. The prototype was implemented with an AI coding agent from my specification and verified with the tests above.

**One bounded next experiment.**
- Take one authorized model export and one artifact section.
- Compare AI-assisted drafting against the current template on 16–24 packages, with two reviewers.
- Measure supported-claim rate, unsupported assertions and reviewer time.
- Stop if unsupported assertions rise or reviewer time doesn't fall.
