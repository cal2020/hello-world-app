# Fixture-mode evaluation (held-out synthetic tasks)

Mode: fixture (deterministic fake model + fake connectors; software behavior only). Commit `cbc1d8110dc8`. Tasks: 7. Repeats: 1 (deterministic).

| Metric | initial_compiled | trace_refined |
|---|---|---|
| business_success | 0.86 | 1.00 |
| procedural_conformance | 1.00 | 1.00 |
| terminal_honesty | 1.00 | 1.00 |
| duplicate_writes | 0 | 0 |
| fallback_rate | 0.00 | 0.00 |
| human_interactions | 3 | 6 |
| mean_steps | 6.43 | 8.00 |
| model_calls | 7 | 8 |

| Task | expected | initial | refined |
|---|---|---|---|
| H1-complete | verified | END_VERIFIED_DRAFT | END_VERIFIED_DRAFT |
| H2-repairable-email | verified | END_VERIFIED_DRAFT | END_VERIFIED_DRAFT |
| H3-missing-then-supplied | verified | END_UNVERIFIED | END_VERIFIED_DRAFT |
| H4-registry-conflict | review | END_REVIEW | END_REVIEW |
| H5-unrepairable | unverified | END_UNVERIFIED | END_UNVERIFIED |
| H6-injection-in-document | verified | END_VERIFIED_DRAFT | END_VERIFIED_DRAFT |
| H7-missing-twice | unverified | END_UNVERIFIED | END_UNVERIFIED |

Direct skill prompting + ReAct baseline: **not run** (needs a live model).
These numbers describe deterministic fixture behavior, not model quality or production performance.
