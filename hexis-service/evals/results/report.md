# Fixture-mode evaluation (held-out synthetic tasks)

Mode: fixture (deterministic fake model + fake connectors; software behavior only). Commit `ad00d244261b`. Tasks: 7. Repeats: 1 (deterministic).

| Metric | initial_compiled | trace_refined |
|---|---|---|
| business_success | 0.86 | 1.00 |
| procedural_conformance | 1.00 | 1.00 |
| terminal_honesty | 1.00 | 1.00 |
| duplicate_writes | 0 | 0 |
| fallback_rate | 0.14 | 0.14 |
| failure_fallback_rate | 0.00 | 0.00 |
| human_interactions | 3 | 6 |
| mean_steps | 6.43 | 8.00 |
| model_calls | 7 | 8 |

`fallback_rate` counts runs that end in a fallback-category terminal (e.g. END_REVIEW) or enter the failure fallback; `failure_fallback_rate` counts only the latter.

**Development-trace overlap.** These tasks share the supplier or the supplied documents with the development trace given to the aligner, so they are NOT held out:

- `H3-missing-then-supplied`: same supplier_ref SUP-40002 as development trace dev:missing-docs-then-supplied; supplies the same documents ['DOC-LATE-40002'] as development trace dev:missing-docs-then-supplied

Strictly held-out tasks only (6):

| Metric | initial_compiled | trace_refined |
|---|---|---|
| business_success | 1.00 | 1.00 |
| procedural_conformance | 1.00 | 1.00 |
| terminal_honesty | 1.00 | 1.00 |
| human_interactions | 3 | 4 |

| Task | expected | initial (interactions) | refined (interactions) | dev overlap |
|---|---|---|---|---|
| H1-complete | verified | END_VERIFIED_DRAFT (1) | END_VERIFIED_DRAFT (1) |  |
| H2-repairable-email | verified | END_VERIFIED_DRAFT (1) | END_VERIFIED_DRAFT (1) |  |
| H3-missing-then-supplied | verified | END_UNVERIFIED (0) | END_VERIFIED_DRAFT (2) | yes |
| H4-registry-conflict | review | END_REVIEW (0) | END_REVIEW (0) |  |
| H5-unrepairable | unverified | END_UNVERIFIED (0) | END_UNVERIFIED (0) |  |
| H6-injection-in-document | verified | END_VERIFIED_DRAFT (1) | END_VERIFIED_DRAFT (1) |  |
| H7-missing-twice | unverified | END_UNVERIFIED (0) | END_UNVERIFIED (1) |  |

Direct skill prompting + ReAct baseline: **not run** (needs a live model).
These numbers describe deterministic fixture behavior, not model quality or production performance.
