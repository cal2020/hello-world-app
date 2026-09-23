# Evaluation report (generated)

Generated 2026-09-23 23:32 UTC by `scripts/evaluate.py` at code version `e79d2a8e9f3d` on Python 3.11.15 / Linux. Every number below comes from this run. Synthetic fixtures only. Results are about this prototype's behavior on these cases, not about production reliability, standards conformance, Cameo compatibility or real-model quality.

## 1. Integration correctness (independent negative tests)

Test suite: **36/36 passed**, 0 skipped. Each test drives the real HTTP API of a fresh local stack (workbench server and consumer server on loopback ports inside the test process, separate SQLite files).

| Case | Required outcome (from brief) | Test(s) | Result |
|---|---|---|---|
| IC01 | Exact repeated import | test_IC01_exact_repeated_import_has_no_duplicate_effects | pass |
| IC02 | Rename with stable ID | test_IC02_rename_preserves_identity_and_history | pass |
| IC03 | Similar names, different projects | test_IC03_similar_names_different_projects_no_merge_no_disclosure | pass |
| IC04 | Same revision, different content | test_IC04_same_revision_different_content_is_quarantined | pass |
| IC05 | Partial export omits an element | test_IC05_partial_export_does_not_infer_deletion | pass |
| IC06 | Explicit deletion / complete-scope removal | test_IC06_explicit_deletion_and_complete_scope_removal_keep_history, test_IC06b_complete_snapshot_removal_flags_possible_replacement_without_merging | pass |
| IC07 | Out-of-order revision / missing delta parent | test_IC07_out_of_order_and_missing_parent_never_regress_head | pass |
| IC08 | Unit / predicate-direction change | test_IC08_unit_change_is_semantic_even_when_payload_validates, test_IC08b_relationship_direction_change_is_surfaced | pass |
| IC09 | Missing instance value | test_IC09_missing_instance_value_is_data_not_schema | pass |
| IC10 | Removed required property definition | test_IC10_removed_required_definition_fails_and_active_release_stays | pass |
| IC11 | New field or enum value | test_IC11_new_field_needs_declared_consumer_tests, test_IC11b_new_enum_value_is_checked_against_contract | pass |
| IC12 | Permission change between proposal and commit | test_IC12_permission_revoked_between_proposal_and_commit | pass |
| IC13 | Stale ETag or changed evidence | test_IC13_stale_etag_and_changed_source_require_new_review, test_IC13b_deleted_target_cannot_be_rebased | pass |
| IC14 | Concurrent head update during acceptance | test_IC14_concurrent_head_update_during_acceptance, test_IC14b_two_concurrent_accepts_one_wins | pass |
| IC15 | Same operation key, different request | test_IC15_same_key_different_request_is_rejected | pass |
| IC16 | Lost acknowledgment after commit | test_IC16b_lost_ack_after_consumer_commit_yields_one_effect, test_IC16a_lost_http_ack_retry_returns_prior_result | pass |
| IC17 | Duplicate or older outbox event | test_IC17_duplicate_older_and_gapped_events | pass |
| IC18 | Forged source instructions or invalid citation | test_IC18_forged_instructions_and_invalid_citations_gain_no_authority | pass |
| IC19 | Failed activation and rollback | test_IC19_failed_activation_and_rollback_keep_current_permissions | pass |

Additional tests (11): test_hostile_projection_labels_are_rejected (pass), test_pagination_stays_on_the_selected_release (pass), test_unreviewed_projection_cannot_be_built (pass), test_restart_persists_state_and_delivers_pending_events (pass), test_IC_duplicate_identity_inside_export_is_quarantined (pass), test_ambiguous_candidates_are_flagged_and_resolved_by_review (pass), test_live_mode_failure_is_visible_and_not_replaced_by_fixture (pass), test_null_empty_zero_and_missing_stay_distinct (pass), test_reordered_rows_and_whitespace_are_the_same_revision (pass), test_unrecognized_content_is_preserved_but_not_exposed (pass), test_unrelated_permitted_note_does_not_change_established_links (pass)

## 2. Relationship proposals

Gold labels: `fixtures/eval/gold_links.json` (authored from the record texts; proposers never read it). 12 records: 6 dev (`cmms`), 6 held-out (`cmms-heldout`), including 4 records where the correct answer is *no link*. **This is an MVP engineering set, not a statistically meaningful sample.**

* `deterministic` = exact serial-number match + a curated alias table (the practical baseline).
* `model:fixture` = hand-authored scripted outputs with deliberate faults. It tests the validation and review mechanics. **It says nothing about real model quality** (the author of the script also wrote the gold labels).
* `model:live` = a real Claude call. **Not executed in this run** (no credentials configured); no live-model quality claim is made.

| Split | Method | Recall (gold links found) | False links among valid candidates | Correct no-link | Records flagged ambiguous | Proposals rejected by validation | Citation validity | Predicate correct |
|---|---|---|---|---|---|---|---|---|
| dev | deterministic | 3/5 | 0 | 1/1 | 0 | 0 | 3/3 | 3/3 |
| dev | model:fixture | 5/5 | 1 | 1/1 | 1 | 3 | 11/12 | 5/5 |
| heldout | deterministic | 1/4 | 0 | 2/2 | 0 | 0 | 1/1 | 1/1 |
| heldout | model:fixture | 4/4 | 1 | 1/2 | 0 | 0 | 6/6 | 4/4 |

Per-record outcomes:

* **dev / deterministic**: MR-1001→correct; MR-1002→missed; MR-1003→missed; MR-1004→correct; MR-1005→correct; MR-1006→correct_no_link
* **dev / model:fixture**: MR-1001→correct (invalid: invalid_citation); MR-1002→correct (invalid: unsupported_predicate); MR-1003→correct_plus_competing; MR-1004→correct; MR-1005→correct; MR-1006→correct_no_link (invalid: reference_outside_permitted_set)
* **heldout / deterministic**: MR-2001→correct; MR-2002→missed; MR-2003→missed; MR-2004→missed; MR-2005→correct_no_link; MR-2006→correct_no_link
* **heldout / model:fixture**: MR-2001→correct; MR-2002→correct; MR-2003→correct; MR-2004→correct; MR-2005→false_link; MR-2006→correct_no_link

Not measured: accepted-incorrect links and review time (no human reviewers took part). Reviewer effort proxy = proposals needing a decision, recorded in `eval/results.json`.

## 3. Local timings

Wall-clock on this machine, loopback HTTP, SQLite. Each step was measured on a fresh stack, n runs. These are local development numbers, not a production latency claim.

| Step | n | median ms | max ms |
|---|---|---|---|
| import_A_ms | 5 | 4.6 | 5.5 |
| build_ms | 5 | 59.9 | 73.5 |
| consumer_checks_ms | 5 | 23.0 | 27.8 |
| activate_ms | 5 | 2.6 | 3.1 |
| delivery_ms | 5 | 12.5 | 25.4 |

## 4. Readiness gate

Readiness requires: working consumer, persisted restart/recovery, versioned traceable contracts, visible ambiguity, independent negative tests, rejected stale/unauthorized mutations, reliable local activation/rollback; and zero seeded unauthorized effects, duplicate consumer effects or undetected incompatible activations.

**Gate result for this run: PASS** (covers exactly the cases above).

