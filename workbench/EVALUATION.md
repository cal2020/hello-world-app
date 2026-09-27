# Evaluation report (generated)

Generated 2026-09-27 08:12 UTC by `scripts/evaluate.py` at code version `4a3446f8df14` on Python 3.11.15 / Linux. Every number below comes from this run. Synthetic fixtures only. Results are about this prototype's behavior on these cases, not about production reliability, standards conformance, Cameo compatibility or real-model quality.

## 1. Integration correctness (independent negative tests)

Test suite: **120/120 passed**, 0 skipped. Most tests drive the real HTTP API of a fresh local stack (workbench server and consumer server on loopback ports inside the test process, separate SQLite files); the others check files such as the Dockerfile and the docs, or upgrade an old database file directly. No test calls a model API.

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

Additional tests (95): test_internal_checks_and_delivery_work_behind_the_gate (pass), test_login_cookie_grants_access_and_wrong_code_does_not (pass), test_without_code_everything_but_healthz_is_refused (pass), test_run_py_reads_consumer_port_and_survives_port_collision (pass), test_stack_consumer_port_equal_to_workbench_port_does_not_crash (pass), test_gap_resync_keeps_link_details_and_revoked_links (pass), test_records_import_is_not_a_newer_model_head (pass), test_build_can_pass_code_version (pass), test_no_volume_instruction (pass), test_f27_demo_script_steps_are_done_by_an_identity_allowed_to_do_them (pass), test_f28_docs_do_not_deny_the_container_deployment (pass), test_f45_docker_host_option_publishes_on_loopback_only (pass), test_f49_docs_hard_code_no_test_count (pass), test_f50_model_output_boundary_names_every_field_the_validator_keeps (pass), test_f51_relation_mapping_is_part_of_the_contract_and_field_mapping_is_not (pass), test_f52_428_is_cited_from_rfc_6585 (pass), test_f53_consumer_is_documented_as_part_of_the_workbench_process (pass), test_f54_demo_script_claims_no_model_capability (pass), test_f55_each_dated_verification_list_describes_the_image_of_its_date (pass), test_f52_only_the_exact_current_etag_matches (pass), test_f29_gold_counts_and_live_status_come_from_the_run (pass), test_f63_valid_proposals_about_unlabeled_records_are_false_links (pass), test_f59_ic14_fails_when_an_accept_commits_on_a_stale_head (pass), test_f60_the_suite_never_calls_a_live_model_even_when_one_is_configured (pass), test_f00_delta_without_definitions_uses_parent_definitions (pass), test_f01_empty_property_definition_does_not_break_diff (pass), test_f12_resending_bytes_accepted_by_reconciliation_is_a_duplicate (pass), test_f13_unbased_records_import_can_be_accepted_as_head (pass), test_f14_structured_multiplicity_is_stored_json_encoded (pass), test_f14_wrongly_typed_fields_are_quarantined_and_recorded (pass), test_f15_element_without_type_is_quarantined (pass), test_f16_diff_reports_type_owner_unrecognized_and_json_type_changes (pass), test_f17_staged_partial_does_not_block_the_complete_revision (pass), test_f18_source_format_cannot_change (pass), test_f19_unknown_relationship_record_and_top_level_content_is_kept_and_flagged (pass), test_f25_non_finite_numbers_are_quarantined (pass), test_f38_deletions_are_validated_and_reported_in_the_receipt (pass), test_f39_deletion_id_shared_by_element_and_relationship_is_ambiguous (pass), test_old_database_is_upgraded_in_place (pass), test_f07_old_projection_key_is_upgraded_in_place (pass), test_f07_projection_versions_are_scoped_per_project (pass), test_f08_blocked_build_does_not_claim_its_contract_version (pass), test_f08_contract_version_reuse_is_checked_per_project (pass), test_f20_identifiers_and_versions_must_match_exactly (pass), test_f21_relation_names_cannot_shadow_identity_or_fields (pass), test_f22_relation_refs_must_have_the_target_resource_type (pass), test_f23_cardinality_one_with_several_targets_is_blocking (pass), test_f24_resource_names_cannot_collide_with_generated_schemas (pass), test_f40_malformed_projection_members_are_rejected_not_500 (pass), test_f41_build_reports_unusable_source_definitions (pass), test_f42_non_integer_limit_is_400 (pass), test_f43_missing_required_relation_is_blocking (pass), test_f44_reordered_type_and_enum_are_the_same_shape (pass), test_f26_example_manifests_name_a_committed_revision_of_this_code (pass), test_upgraded_consumer_db_backfills_the_pinned_source (pass), test_a_full_queue_refuses_the_login_form_and_redirects_page_loads (pass), test_busy_requests_are_never_closed_to_make_room (pass), test_idle_and_slow_connections_do_not_lock_out_others (pass), test_wrong_guesses_do_not_hold_connections (pass), test_f12_resending_bytes_normalized_differently_before_an_upgrade_is_a_duplicate (pass), test_f14_out_of_range_numbers_and_unstorable_text_are_not_500 (pass), test_a_refused_stale_login_cookie_opens_the_login_page (pass), test_f03_an_unread_body_is_never_parsed_as_a_request (pass), test_f04_negative_or_non_numeric_content_length_is_refused (pass), test_f30_failed_guesses_are_spaced_across_all_connections (pass), test_f31_non_ascii_codes_are_compared_as_bytes (pass), test_f05_outbox_controls_are_scoped_to_a_project_and_audited (pass), test_f06_a_grant_revoked_while_waiting_for_the_write_lock_is_honored (pass), test_f10_backoff_does_not_overflow_and_other_projects_still_deliver (pass), test_f11_the_same_link_cannot_be_active_twice (pass), test_f25_nan_is_never_served_and_fails_the_schema_check (pass), test_f26_code_version_comes_from_the_deploy_environment (pass), test_f32_grants_are_validated (pass), test_f33_a_pending_event_cannot_be_redelivered_out_of_order (pass), test_f34_now_reads_the_clock_once (pass), test_f35_f36_backlog_timeout_and_connection_cap (pass), test_f56_record_kind_and_a_quote_from_the_subject_record_are_required (pass), test_f57_a_changed_predicate_is_revalidated (pass), test_f61_any_live_adapter_failure_is_recorded_on_the_run (pass), test_f62_a_stale_proposal_can_still_be_closed (pass), test_f64_a_numeric_serial_does_not_break_the_deterministic_run (pass), test_f46_refresh_after_a_mutation_during_a_running_refresh_shows_that_mutation (pass), test_f47_register_and_approve_selects_the_new_version_for_build (pass), test_f48_expired_gate_login_goes_to_login_page_and_dashboard_says_so (pass), test_hostile_projection_labels_are_rejected (pass), test_pagination_stays_on_the_selected_release (pass), test_unreviewed_projection_cannot_be_built (pass), test_restart_persists_state_and_delivers_pending_events (pass), test_IC_duplicate_identity_inside_export_is_quarantined (pass), test_ambiguous_candidates_are_flagged_and_resolved_by_review (pass), test_live_mode_failure_is_visible_and_not_replaced_by_fixture (pass), test_null_empty_zero_and_missing_stay_distinct (pass), test_reordered_rows_and_whitespace_are_the_same_revision (pass), test_unrecognized_content_is_preserved_but_not_exposed (pass), test_unrelated_permitted_note_does_not_change_established_links (pass)

## 2. Relationship proposals

Gold labels: `fixtures/eval/gold_links.json` (authored from the record texts; proposers never read it). 12 records: 6 dev (`cmms`), 6 heldout (`cmms-heldout`), including 3 records where the correct answer is *no link*. **This is an MVP engineering set, not a statistically meaningful sample.**

* `deterministic` = exact serial-number match + a curated alias table (the practical baseline).
* `model:fixture` = hand-authored scripted outputs with deliberate faults. It tests the validation and review mechanics. **It says nothing about real model quality** (the author of the script also wrote the gold labels).
* `model:live` = a real Claude call. **Not run**: `LWB_EVAL_LIVE=1` was not set, so no model API was called and no live-model quality claim is made.

| Split | Method | Recall (gold links found) | False links among valid candidates | Correct no-link | Records flagged ambiguous | Proposals rejected by validation | Citation validity | Predicate correct |
|---|---|---|---|---|---|---|---|---|
| dev | deterministic | 3/5 | 0 | 1/1 | 0 | 0 | 3/3 | 3/3 |
| dev | model:fixture | 5/5 | 1 | 1/1 | 1 | 3 | 11/12 | 5/5 |
| heldout | deterministic | 1/4 | 0 | 2/2 | 0 | 0 | 1/1 | 1/1 |
| heldout | model:fixture | 4/4 | 1 | 1/2 | 0 | 0 | 6/6 | 4/4 |

False links also count valid proposals about records outside the gold set (such as notes); those records appear below as `unlabeled_false_link` or `unlabeled_no_valid_link`.

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
| import_A_ms | 5 | 6.5 | 8.7 |
| build_ms | 5 | 68.0 | 80.3 |
| consumer_checks_ms | 5 | 31.0 | 33.7 |
| activate_ms | 5 | 3.4 | 3.6 |
| delivery_ms | 5 | 17.3 | 27.8 |

## 4. Readiness gate

Readiness requires: working consumer, persisted restart/recovery, versioned traceable contracts, visible ambiguity, independent negative tests, rejected stale/unauthorized mutations, reliable local activation/rollback; and zero seeded unauthorized effects, duplicate consumer effects or undetected incompatible activations.

**Gate result for this run: PASS** (covers exactly the cases above).

