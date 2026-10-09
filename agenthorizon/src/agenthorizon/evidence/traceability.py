"""TRACEABILITY.csv: every substantive requirement -> source, classification, implementation, artifact, verification,
status. ``check()`` resolves every reference (module symbols, test functions, Playwright test titles, evidence files),
so the matrix cannot cite code or tests that do not exist; tests/test_traceability.py runs it and also requires the
committed CSV to equal a fresh render.

Reference forms: ``src/...py:symbol`` (top-level def/class/assignment), ``tests/...py::test_name``,
``frontend/e2e/<file>.ts::<test title>``, or a repository path (file must exist).
"""

from __future__ import annotations

import ast
import csv
import io
from dataclasses import dataclass, field
from pathlib import Path

from agenthorizon.config import PROJECT_ROOT

CORE, APP, EXT, UNRES = "PAPER CORE", "APPLICATION LAYER", "OPTIONAL EXTENSION", "UNRESOLVED"
E2E = "frontend/e2e/workbench.spec.ts::"
P = "src/agenthorizon/"


@dataclass(frozen=True)
class Req:
    req_id: str
    requirement: str
    source: str
    classification: str
    implementation: tuple[str, ...]
    verification: tuple[str, ...]
    status: str
    artifacts: tuple[str, ...] = field(default=())


def R(req_id, requirement, source, classification, implementation, verification, status, artifacts=()):
    return Req(req_id, requirement, source, classification, tuple(implementation), tuple(verification), status,
               tuple(artifacts))


VERIFIED = "verified"
SYNTH = "verified on synthetic test data (official AgentHorizon data unreachable here)"
FAKES = "verified against local fakes; no live provider call (no credentials or budget)"

REQUIREMENTS: tuple[Req, ...] = (
    # ---- 1 sources and release verification
    R("R1.1", "Lock paper version, repository commit, dataset revision, file digests, licences, access outcomes",
      "MP §1", CORE, [P + "sources/lock.py:build_lock", P + "sources/lock.py:material_licenses"],
      ["evidence/SOURCE_LOCK.json"], "verified: repository/doc sources locked; paper, dataset, Dataverse recorded "
      "inaccessible with attempts", ["evidence/SOURCE_LOCK.json"]),
    R("R1.2", "Classify every referenced artifact: acquired / published-but-unavailable / not located / n.a.",
      "MP §1, §3", CORE, [P + "sources/availability.py:availability_report", P + "sources/availability.py:ARTIFACTS"],
      ["evidence/DATA_AVAILABILITY.json"], VERIFIED, ["evidence/DATA_AVAILABILITY.json"]),
    R("R1.3", "Locate the revised AH-D/AH/AH-S manifests across branches, tags, refs and dataset revisions",
      "MP §1", UNRES, [P + "sources/probe.py:probe_url", P + "sources/availability.py:classify"],
      ["evidence/RELEASE_RECONCILIATION.md"], "unresolved: not located at any probed ref; dataset host unreachable",
      ["evidence/RELEASE_RECONCILIATION.md"]),
    R("R1.4", "Register the legacy partition as its own manifests; never relabel legacy scores as the paper's",
      "MP §1", CORE, [P + "data/splits.py:LEGACY_LABEL_FILES", P + "data/ingest.py:ingest"],
      ["tests/test_ingest.py::test_local_ingest_is_idempotent_and_complete",
       "tests/test_experiments.py::test_grid_experiment_report_scores_three_manifests_and_caveats_paper_rows"], SYNTH),
    # ---- 2 executable specification
    R("R2.1", "Paper specification record and traceability matrix generated from the running code",
      "MP §2", CORE, [P + "evidence/spec.py:paper_spec", P + "evidence/traceability.py:check"],
      ["tests/test_traceability.py::test_every_reference_resolves",
       "tests/test_traceability.py::test_committed_matrix_and_spec_are_current"], VERIFIED,
      ["evidence/PAPER_SPEC.json", "evidence/TRACEABILITY.csv"]),
    R("R2.2", "Inventory every experiment row, model/interface pairing, packaging, prompt, sampling, serving",
      "MP §2, §7", CORE, [P + "reference/inventory.py:inventory", P + "judging/registry.py:CONFIGS"],
      ["tests/test_experiments.py::test_registry_covers_every_configuration_and_reference_row"],
      "verified against the released supplementary tables; unknown settings recorded as null",
      ["evidence/EXPERIMENT_INVENTORY.json"]),
    R("R2.3", "Keep paper-reported aggregates as reference data with source locations, separate from new results",
      "MP §2, §9", CORE, [P + "reference/tables.py:supplementary_tables", P + "reference/tables.py:construction_accounting"],
      ["evidence/REFERENCE_DATA.json"], VERIFIED, ["evidence/REFERENCE_DATA.json"]),
    R("R2.4", "Reconcile revised membership to the check table (never modify labels to match)",
      "MP §2 (quoting S1)", CORE, [P + "reference/analysis.py:REVISED_CHECK_TABLE", P + "data/validate.py:reconcile"],
      ["evidence/REFERENCE_DATA.json"], "implemented; blocked: revised membership not located (U1)"),
    R("R2.5", "Revised partition rule: 3 splitters x 8 verdicts; <=18 correct -> AH; invalid never correct",
      "MP §2 (quoting S1)", CORE, [P + "data/splits.py:revised_bucket", P + "analysis/partition.py:revised_reconstruction"],
      ["tests/test_experiments.py::test_legacy_partition_reconstruction_from_eight_trials"],
      "implemented and boundary-tested; splitter verdicts not released, Inkling/Kimi identifiers unknown (U4)"),
    R("R2.6", "Legacy partition procedure from the released script (k=8) with its own reconstruction identity",
      "S2 scripts/aggregate_difficulty.py", CORE, [P + "data/splits.py:legacy_difficulty",
                                                    P + "analysis/partition.py:legacy_reconstruction"],
      ["tests/test_experiments.py::test_legacy_partition_reconstruction_from_eight_trials"], SYNTH),
    R("R2.7", "Audit pair/instruction/recording grouping and split separation from released data",
      "MP §2", CORE, [P + "data/grouping.py:label_components", P + "data/grouping.py:overlap_audit"],
      ["tests/test_ingest.py::test_grouping_recovers_pair_components"], SYNTH),
    # ---- 3 ingestion
    R("R3.1", "Idempotent ingestion: discover, lock, inventory, size, download, validate, normalize, index, report",
      "MP §3", CORE, [P + "data/ingest.py:ingest", P + "app/indexer.py:index_dataset_version"],
      ["tests/test_ingest.py::test_local_ingest_is_idempotent_and_complete",
       "tests/test_ingest.py::test_hf_ingest_metadata_then_lazy_media_with_faults"],
      SYNTH + "; HF transfers exercised against a local fake hub"),
    R("R3.2", "Resumable transfers with checksums, bounded concurrency, storage limits",
      "MP §3", CORE, [P + "sources/hf.py:HFDatasetClient", P + "sources/hf.py:verify_file"],
      ["tests/test_ingest.py::test_hf_ingest_metadata_then_lazy_media_with_faults",
       "tests/test_ingest.py::test_storage_limit_refuses_transfer"], SYNTH),
    R("R3.3", "Index all metadata first; materialize media lazily with honest coverage and a full command",
      "MP §3", CORE, [P + "data/materialize.py:materialize_media", P + "data/materialize.py:media_coverage"],
      ["tests/test_ingest.py::test_hf_ingest_metadata_then_lazy_media_with_faults",
       E2E + "coverage, explorer, inspection, pair views"], SYNTH),
    R("R3.4", "Explicit layout adapter (sandbox/data/* vs agenthorizon_md/json) with logged, validated aliases",
      "MP §3", CORE, [P + "data/layout.py:detect_layout", P + "data/layout.py:build_staging_plan"],
      ["tests/test_ingest.py::test_layout_detection",
       "tests/test_leakage.py::test_staged_workspace_holds_only_this_items_evidence"], SYNTH),
    R("R3.5", "Preserve raw records and unknown fields; reversible normalization; Markdown regenerates",
      "MP §3, S4", CORE, [P + "data/standard.py:reconstruct_render_json", P + "data/normalize.py:normalize_example",
                          P + "data/markdown.py:render_markdown"],
      ["tests/test_ingest.py::test_local_ingest_is_idempotent_and_complete"], SYNTH),
    R("R3.6", "Screenshots are timed observations (pre-action in the standard); native step IDs kept",
      "MP §3, S4", CORE, [P + "data/normalize.py:observation_timing", P + "data/normalize.py:TIMINGS"],
      ["tests/test_supplemental.py::test_osworld_trace_export_import_is_post_action_and_machine_labelled",
       "tests/test_supplemental.py::test_arb_trajectories_become_a_separate_scorable_dataset"], SYNTH),
    R("R3.7", "Validate membership, joins, JSON, step order, timestamps, actions, media, hashes, text, reuse, leakage",
      "MP §3", CORE, [P + "data/validate.py:validate_version"],
      ["tests/test_ingest.py::test_local_ingest_is_idempotent_and_complete", "evidence/DATA_VALIDATION.json"], SYNTH,
      ["evidence/DATA_VALIDATION.json"]),
    R("R3.8", "Quarantine invalid records with diagnostics; never drop them silently",
      "MP §3", CORE, [P + "data/validate.py:validate_version"],
      ["tests/test_ingest.py::test_invalid_record_is_quarantined_not_dropped"], SYNTH),
    R("R3.9", "Untyped negatives stay untyped; a missing category is not a missing binary label",
      "MP §3", CORE, [P + "scoring/protocol.py:score"],
      ["tests/test_ingest.py::test_untyped_negative_stays_untyped_and_manifests_score"], SYNTH),
    R("R3.10", "Labels, pair IDs, original IDs and categories only in a scorer-only store",
      "MP §3, §5", CORE, [P + "data/dataset.py:PrivateStore", P + "app/schema.py:GRANTS_SQL"],
      ["tests/test_ingest.py::test_labels_live_only_in_private_store",
       "tests/test_app.py::test_catalogue_responses_never_carry_labels"], VERIFIED),
    R("R3.11", "Classify egress denial and missing artifacts; never fabricate data", "MP §3", CORE,
      [P + "sources/hf.py:describe_failure"], ["tests/test_ingest.py::test_hf_egress_denial_is_classified"], VERIFIED),
    # ---- 4 supplemental data
    R("R4.1", "Source registry and adapter interface for additional corpora", "MP §4", CORE,
      [P + "sources/registry.py:SOURCES", P + "supplemental/records.py:SupRecord"],
      ["tests/test_supplemental.py::test_store_round_trip"], VERIFIED),
    R("R4.2", "AgentRewardBench: label provenance, primary/secondary annotators, splits, Unsure excluded", "MP §4, S9",
      CORE, [P + "supplemental/arb.py:load_repo", P + "supplemental/arb.py:primary_binary_gold",
             P + "supplemental/arb.py:annotation_agreement"],
      ["tests/test_supplemental.py::test_arb_import_matches_release_rules"],
      "verified on the real released annotations (cross-checked against ARB's own helpers); trajectories not "
      "downloadable here (dataset host blocked)", ["evidence/DEDUP_AUDIT.json"]),
    R("R4.3", "Supplemental trajectories become a separate, separately scored dataset version", "MP §4", CORE,
      [P + "supplemental/standard_export.py:export_standard", P + "supplemental/pipeline.py:export_for_judging"],
      ["tests/test_supplemental.py::test_arb_trajectories_become_a_separate_scorable_dataset"],
      "verified on synthetic trajectories in ARB's released format"),
    R("R4.4", "OSWorld: task definitions are not trajectories; trace exports import with flagged machine labels",
      "MP §4, S10", CORE, [P + "supplemental/osworld.py:load_task_definitions",
                           P + "supplemental/osworld.py:import_trace_exports"],
      ["tests/test_supplemental.py::test_osworld_task_definitions_are_not_trajectories",
       "tests/test_supplemental.py::test_osworld_trace_export_import_is_post_action_and_machine_labelled"],
      "task definitions: real (pinned repository); trace exports: synthetic (none linked from the release)"),
    R("R4.5", "Deduplicate by hash and auditable similarity; never auto-merge; flag evaluation overlap",
      "MP §4", CORE, [P + "supplemental/dedup.py:audit"],
      ["tests/test_supplemental.py::test_separation_audit_flags_overlap_and_never_merges"], VERIFIED,
      ["evidence/DEDUP_AUDIT.json"]),
    # ---- 5 blindness boundary
    R("R5.1", "Shared judge contract: raw verdict, parse, status, telemetry, lineage, input digest", "MP §5", CORE,
      [P + "judging/contract.py:AttemptOutcome", P + "judging/contract.py:Telemetry"],
      ["tests/test_runs.py::test_agentic_run_end_to_end_in_sandbox_and_scored"], VERIFIED),
    R("R5.2", "Fresh per-task workspace holding only the item's permitted evidence and prompts", "MP §5", CORE,
      [P + "judging/workspace.py:stage_workspace"],
      ["tests/test_leakage.py::test_staged_workspace_holds_only_this_items_evidence"], VERIFIED),
    R("R5.3", "Runtime boundary: no labels, other tasks, host services, DNS or internet; allowlisted egress only",
      "MP §5, §12", CORE, [P + "judging/isolation/sandbox.py:run_in_sandbox", P + "judging/isolation/egress.py:EgressProxy"],
      ["tests/test_isolation.py::test_probe_cannot_cross_the_boundary",
       "tests/test_isolation.py::test_self_hosted_endpoint_reachable_only_at_its_host_and_port",
       "tests/test_isolation.py::test_missing_mount_source_never_runs_unconfined"], VERIFIED),
    R("R5.4", "Judge-side code cannot reach private material; harness env holds only route credentials", "MP §5",
      CORE, [P + "runs/judges.py:load_secrets"],
      ["tests/test_leakage.py::test_judge_side_code_cannot_name_private_material",
       "tests/test_leakage.py::test_harness_environment_carries_only_route_credentials"], VERIFIED),
    R("R5.5", "Recorded actions and dataset strings are data: never executed, never passed through a shell",
      "MP §7, §12", CORE, [P + "data/markdown.py:format_action"],
      ["tests/test_leakage.py::test_no_shell_execution_anywhere"], VERIFIED),
    R("R5.6", "Output contract with native category spellings preserved via a versioned mapping", "MP §5, S7", CORE,
      [P + "scoring/categories.py:NATIVE_TO_CATEGORY", P + "scoring/categories.py:CATEGORY_MAP_VERSION"],
      ["tests/test_scoring.py::test_fuzzy_category_strings_are_not_matched"], VERIFIED),
    R("R5.7", "Import the authors' prompts at the locked revision, with digests", "MP §5", CORE,
      [P + "judging/prompts.py:official_agentic_prompt", P + "judging/prompts.py:official_direct_prompt"],
      ["evidence/PAPER_SPEC.json"], "verified (digests); comparison with the paper's prompt figure unresolved (U2)"),
    R("R5.8", "Strict Boolean success; binary vs full-contract validity; no coercion; reference parsing rules",
      "MP §5", CORE, [P + "judging/parsing.py:parse_agentic"],
      ["tests/test_parsing.py::test_binary_validity_is_strict", "tests/test_parsing.py::test_string_false_is_never_coerced",
       "tests/test_parsing.py::test_full_contract_validity_is_separate_from_binary",
       "tests/test_parsing.py::test_multiple_objects_follow_reference_and_flag_conflict",
       "tests/test_parsing.py::test_agentic_extractor_matches_released_function",
       "tests/test_parsing.py::test_direct_parser_matches_released_function"], VERIFIED),
    # ---- 6 direct judges
    R("R6.1", "Direct inputs built exactly as the released preprocessing (bytes compared)", "MP §6, S5", CORE,
      [P + "judging/direct/packaging.py:build_payload"],
      ["tests/test_direct.py::test_payload_byte_identical_to_released_preprocessing"], VERIFIED),
    R("R6.2", "2x2 mosaic mode: order, incomplete final grid, originals untouched", "MP §6, S5", CORE,
      [P + "judging/direct/packaging.py:MOSAIC_CHOICES"],
      ["tests/test_direct.py::test_mosaic_row_major_order_padding_and_originals_untouched"],
      "implemented as a documented engineering choice (no released implementation, U7)"),
    R("R6.3", "Check provider limits before sending; never truncate; mark serving incompatibility", "MP §6", CORE,
      [P + "judging/direct/limits.py:check"], ["tests/test_direct.py::test_long_trajectory_never_truncated"], VERIFIED),
    R("R6.4", "Provider adapters (OpenAI-compatible/vLLM, Anthropic, Gemini) with recorded settings and errors",
      "MP §6", CORE, [P + "judging/direct/providers.py:OpenAICompatibleProvider"],
      ["tests/test_direct.py::test_openai_compatible_wire_payload_and_error_mapping",
       "tests/test_direct.py::test_anthropic_extension_request_shape_and_retry_accounting",
       "tests/test_direct.py::test_gemini_request_mirrors_released_conversion"], FAKES),
    R("R6.5", "Self-hosted serving is an optional profile; GPUs never needed to explore data", "MP §6, §10", APP,
      ["compose.yaml"], ["tests/test_packaging.py::test_compose_trust_boundaries"],
      "implemented; GPU profile not executed here"),
    # ---- 7 agentic judges and registry
    R("R7.1", "Five native harness adapters (Codex, Claude Code, Gemini CLI, OpenCode, OpenHands)", "MP §7, S2/S8",
      CORE, [P + "judging/harnesses.py:ADAPTERS", "docker/harnesses/package-lock.json"],
      ["tests/test_agentic_replay.py::test_adapter_end_to_end_with_replay", "evidence/harness_cli"],
      "flags verified against the installed CLIs; end-to-end with replayed outputs in the real sandbox; no live model "
      "run (no credentials or budget)"),
    R("R7.2", "Registry of every paper configuration with supported/unavailable/unverified/blocked and reasons",
      "MP §7", CORE, [P + "judging/registry.py:CONFIGS", P + "judging/doctor.py:diagnose"],
      ["tests/test_experiments.py::test_registry_covers_every_configuration_and_reference_row"],
      "verified; every configuration currently blocked or unverified here", ["evidence/MODEL_CAPABILITIES.json"]),
    R("R7.3", "Capability probes run in the environment that executes runs; credential names only", "MP §7", APP,
      [P + "app/worker.py:handle_doctor"],
      ["tests/test_app.py::test_capability_probe_runs_on_a_judge_worker_and_never_carries_secret_values",
       E2E + "operations console"], VERIFIED),
    R("R7.4", "Transport retries vs judgment attempts; no rerun of valid judgments; immutable selection",
      "MP §7", CORE, [P + "runs/policy.py:POLICIES", P + "runs/policy.py:select"],
      ["tests/test_runs.py::test_attempt_policy_matches_released_runner",
       "tests/test_runs.py::test_policy_sequences_selection_and_no_rerun_of_valid_judgments",
       "tests/test_parsing.py::test_retry_stop_rule_matches_reference"], VERIFIED),
    R("R7.5", "Repeated trials and alternative harnesses are separate experiment identities", "MP §7", CORE,
      [P + "runs/identity.py:RunDefinition"], ["tests/test_experiments.py::test_trials_are_separate_run_identities"],
      VERIFIED),
    # ---- 8 scoring
    R("R8.1", "Fixed denominators; missing/invalid incorrect and reported separately; exact fractions",
      "MP §8, S5", CORE, [P + "scoring/protocol.py:score"],
      ["tests/test_scoring.py::test_hand_fixture_two_positive_two_negative", "tests/test_scoring.py::test_score_oracles",
       "tests/test_scoring.py::test_balanced_accuracy_is_exact_fraction"], VERIFIED),
    R("R8.2", "Reject duplicate, unknown and version-mismatched predictions", "MP §8", CORE,
      [P + "scoring/protocol.py:score"],
      ["tests/test_scoring.py::test_duplicate_unknown_and_version_mismatch_are_rejected",
       "tests/test_scoring.py::test_out_of_manifest_predictions_are_ignored_not_counted"], VERIFIED),
    R("R8.3", "Category recall needs a valid failure verdict and exact category; typed and MT denominators",
      "MP §8", CORE, [P + "scoring/protocol.py:score"],
      ["tests/test_scoring.py::test_category_scoring_requires_valid_failure_and_exact_match"], VERIFIED),
    R("R8.4", "Partial runs: labelled subset score; canonical score counts unfinished items as missing", "MP §8",
      CORE, [P + "scoring/report.py"], ["tests/test_scoring.py::test_selection_subset_is_labelled_and_canonical_counts_missing"],
      VERIFIED),
    R("R8.5", "Cross-check against the authors' scorer and an independent hand fixture", "MP §8", CORE,
      [P + "scoring/reference_compat.py:REFERENCE_ID"],
      ["tests/test_reference_crosscheck.py::test_reference_compat_reproduces_authors_script",
       "tests/test_reference_crosscheck.py::test_protocol_and_reference_agree_on_complete_valid_sets",
       "tests/test_reference_crosscheck.py::test_hand_fixture_divergence_is_documented"], VERIFIED),
    R("R8.6", "Grouped bootstrap over shared recordings/pairs (named extension)", "MP §8", EXT,
      [P + "analysis/bootstrap.py:grouped_bootstrap"], ["tests/test_experiments.py::test_grouped_bootstrap_properties"],
      VERIFIED),
    # ---- 9 reproduction and analysis
    R("R9.1", "Label every result: paper-reported, rescored, new paper-compatible, extension, test fixture",
      "MP §9", CORE, [P + "runs/identity.py:classify_result_kind"],
      ["tests/test_runs.py::test_dry_run_plan_is_honest_about_blocks_cost_and_classification"], VERIFIED),
    R("R9.2", "Commands/jobs for every configuration, report, ablation, trial study, with named blockers",
      "MP §9", CORE, [P + "experiments/registry.py:experiments", P + "experiments/registry.py:status"],
      ["tests/test_experiments.py::test_status_logic_names_every_blocker"],
      "implemented; every experiment blocked here (data, credentials, budget) and says why",
      ["evidence/EXPERIMENT_REGISTRY.json"]),
    R("R9.3", "Length/application/OS/domain slices with fixed per-slice denominators", "MP §9", CORE,
      [P + "analysis/slices.py:slice_scores"], ["tests/test_experiments.py::test_slices_partition_single_valued_dimensions"],
      VERIFIED),
    R("R9.4", "Reports across AH/AH-S/full manifests with paper rows kept separate and caveated", "MP §9", CORE,
      [P + "experiments/report.py:experiment_report"],
      ["tests/test_experiments.py::test_grid_experiment_report_scores_three_manifests_and_caveats_paper_rows"], SYNTH),
    R("R9.5", "Import authors' per-item predictions for rescoring when released", "MP §9", CORE,
      [P + "scoring/predictions.py:load_authors_results_dir"], ["tests/test_reference_crosscheck.py::"
                                                                "test_reference_compat_reproduces_authors_script"],
      "implemented; no per-item predictions are released (U6)"),
    R("R9.6", "Resource and latency summaries with telemetry coverage", "MP §9", CORE,
      [P + "analysis/resources.py:resource_summary"], ["tests/test_runs.py::test_agentic_run_end_to_end_in_sandbox_and_scored"],
      SYNTH),
    R("R9.7", "Engineering smoke selections never become AH-D", "MP §9", CORE,
      [P + "data/splits.py:engineering_smoke_selection"], ["tests/test_cli.py::test_cli_ingest_plan_run_score_export"],
      VERIFIED),
    # ---- 10 architecture and execution
    R("R10.1", "One importable core used by the CLI, API and workers", "MP §10", APP,
      [P + "cli.py:app", P + "app/api/main.py:create_app", P + "app/worker.py:run_worker"],
      ["tests/test_cli.py::test_cli_ingest_plan_run_score_export", "tests/test_app.py::test_run_lifecycle_through_workers"],
      VERIFIED),
    R("R10.2", "PostgreSQL with migrations and per-service roles (judge role cannot read the private schema)",
      "MP §10", APP, [P + "app/schema.py:GRANTS_SQL", P + "app/migrations/versions/0001_initial.py"],
      ["tests/test_app.py::test_catalogue_responses_never_carry_labels"], VERIFIED),
    R("R10.3", "Durable jobs: leases, heartbeats, expired-lease reclaim, deduplication", "MP §10", APP,
      [P + "app/jobs.py:claim", P + "app/jobs.py:enqueue"],
      ["tests/test_app.py::test_job_lease_expiry_reclaim_and_owner_checks"], VERIFIED),
    R("R10.4", "Canonical run identity; resume only an identical definition", "MP §10", CORE,
      [P + "runs/identity.py:RunDefinition"], ["tests/test_runs.py::test_identity_resume_only_identical"], VERIFIED),
    R("R10.5", "Crash, kill, cancel, pause and resume keep attempt history and never duplicate finals",
      "MP §10, §13", CORE, [P + "runs/orchestrator.py:Orchestrator", P + "runs/store.py:FileRunStore",
                            P + "app/runstore.py:PgRunStore"],
      ["tests/test_runs.py::test_crash_recovery_records_interrupted_and_never_duplicates_finals",
       "tests/test_runs.py::test_killed_worker_process_resumes_without_duplicates",
       "tests/test_runs.py::test_cancel_stops_running_attempts_and_resume_completes",
       "tests/test_runs.py::test_pause_lets_running_attempts_finish"], VERIFIED),
    R("R10.6", "Budget reservation; blocked routes pause the run instead of producing mass missing results",
      "MP §12", CORE, [P + "runs/orchestrator.py:RunControls", P + "runs/pricing.py:cost"],
      ["tests/test_runs.py::test_budget_reservation_pauses_and_resume_with_higher_budget",
       "tests/test_runs.py::test_blocked_pauses_run_instead_of_mass_missing",
       "tests/test_runs.py::test_retry_errors_is_explicit_bounded_and_skips_responses"], VERIFIED),
    R("R10.7", "Resumable server-sent event stream", "MP §10", APP, [P + "app/api/runs.py:router"],
      ["tests/test_app.py::test_sse_stream_resumes_from_last_event_id"], VERIFIED),
    R("R10.8", "Typed errors, request IDs, idempotency keys, cursor pagination, explicit authorization", "MP §10",
      APP, [P + "app/api/common.py:idempotent", P + "app/api/common.py:enc_cursor"],
      ["tests/test_app.py::test_run_lifecycle_through_workers",
       "tests/test_app.py::test_catalogue_search_pagination_steps_media"], VERIFIED),
    R("R10.9", "Docker Compose packaging; judge container without Docker socket, capabilities or label volume",
      "MP §10, §12", APP, ["compose.yaml", "docker/Dockerfile", "docker/seccomp-judge.json"],
      ["tests/test_packaging.py::test_compose_trust_boundaries", "tests/test_packaging.py::test_seccomp_profile_derivation"],
      "verified statically; images built and the stack exercised in docker/smoke.sh (see TEST_REPORT.md)"),
    R("R10.10", "Read-only services (API, judge worker) never fetch sources; a missing pinned checkout is an "
      "actionable 409, not a crash", "MP §12", APP, [P + "sources/cache.py:checkout", P + "app/api/runs.py:router"],
      ["tests/test_ingest.py::test_read_only_service_never_fetches_pinned_sources", "docker/smoke.py"], VERIFIED),
    # ---- 11 web application
    R("R11.A", "Data coverage: identity, manifest status, revised vs legacy, media coverage, supplemental sources",
      "MP §11", APP, ["frontend/src/pages/Coverage.tsx"], [E2E + "coverage, explorer, inspection, pair views"], SYNTH),
    R("R11.B", "Trajectory explorer: search, filters, pagination; label filters only in the privileged view",
      "MP §11", APP, ["frontend/src/pages/Explorer.tsx"], [E2E + "coverage, explorer, inspection, pair views",
                                                           E2E + "roles gate navigation and privileged views"], SYNTH),
    R("R11.C", "Trajectory inspection: keyboard and step links, observation timing, on-demand media", "MP §11", APP,
      ["frontend/src/pages/Inspect.tsx", "frontend/src/components/trajectory.tsx"],
      [E2E + "coverage, explorer, inspection, pair views"], SYNTH),
    R("R11.D", "Pair inspection only in an audited privileged view", "MP §11", APP, ["frontend/src/pages/Pair.tsx"],
      [E2E + "coverage, explorer, inspection, pair views"], SYNTH),
    R("R11.E", "Experiment setup with capability checks, input-limit diagnostics, cost forecast, dry run",
      "MP §11", APP, ["frontend/src/pages/RunSetup.tsx", P + "runs/plan.py:preflight"],
      [E2E + "experiment setup to monitor, score, results, export"], SYNTH),
    R("R11.F", "Run monitor with live events and pause/cancel/resume", "MP §11", APP,
      ["frontend/src/pages/RunMonitor.tsx"], [E2E + "experiment setup to monitor, score, results, export"], SYNTH),
    R("R11.G", "Results: class accuracies, denominators, invalid counts, categories, protocol-matched comparison",
      "MP §11", APP, ["frontend/src/pages/Results.tsx"], [E2E + "experiment setup to monitor, score, results, export"],
      SYNTH),
    R("R11.H", "Blind review, separate annotation layer, audited reveal, exports, agreement only when supported",
      "MP §11", APP, ["frontend/src/pages/Review.tsx", P + "app/api/research.py:router"],
      [E2E + "blind review then audited reveal", "tests/test_app.py::test_blind_review_then_audited_reveal"], SYNTH),
    R("R11.P", "Measured performance: warm catalogue p95 < 500 ms; first evidence < 1.5 s; no eager media",
      "MP §11, §13", APP, [P + "testing/perf.py:main"],
      ["evidence/PERFORMANCE.json", E2E + "coverage, explorer, inspection, pair views"],
      "measured on a release-scale synthetic catalogue (real data unreachable)", ["evidence/PERFORMANCE.json"]),
    # ---- 12 operations and security
    R("R12.1", "Roles and server-side permissions; hosted mode requires authentication", "MP §12", APP,
      [P + "app/api/auth.py:PERMISSIONS", P + "app/api/auth.py:require"],
      ["tests/test_app.py::test_auth_roles_csrf_and_audit", E2E + "roles gate navigation and privileged views"],
      VERIFIED),
    R("R12.2", "Credentials never reach the browser, exports, logs or the API/trusted services", "MP §12", APP,
      [P + "runs/export.py:build_bundle", P + "judging/contract.py:redact", "compose.yaml"],
      ["tests/test_app.py::test_capability_probe_runs_on_a_judge_worker_and_never_carries_secret_values",
       "tests/test_packaging.py::test_compose_trust_boundaries"], VERIFIED),
    R("R12.3", "Safe media/artifact path resolution; released text served as plain text", "MP §12", APP,
      [P + "data/layout.py:safe_relative", P + "app/api/catalog.py:released_file"],
      ["tests/test_app.py::test_run_lifecycle_through_workers"], VERIFIED),
    R("R12.4", "No paid run without credentials and an explicit budget; dry runs first", "MP §12", CORE,
      [P + "runs/plan.py:preflight"], ["tests/test_cli.py::test_cli_ingest_plan_run_score_export",
                                        "tests/test_runs.py::test_dry_run_plan_is_honest_about_blocks_cost_and_classification"],
      VERIFIED),
    R("R12.5", "Deterministic exports with configuration, locks, results, scores; secrets scrubbed", "MP §12", APP,
      [P + "runs/export.py:write_tar_gz"], ["tests/test_cli.py::test_cli_ingest_plan_run_score_export"], VERIFIED),
    # ---- 13 required checks that cannot run here
    R("R13.9", "Real model path: a live direct and a live agentic judge on real development examples", "MP §13.9",
      CORE, [P + "runs/judges.py:build_judge"], ["tests/test_runs.py::test_agentic_run_end_to_end_in_sandbox_and_scored",
                                                  "tests/test_runs.py::test_direct_run_end_to_end_against_fake_endpoint_and_scored"],
      "blocked: no provider credentials or budget, no real data here; adapters exercised with replay logs and fakes"),
)


# ---- reference resolution ------------------------------------------------------------------------------------
def _top_level_names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def resolve(ref: str, root: Path = PROJECT_ROOT) -> str | None:
    """None when the reference resolves; else a description of what is missing."""
    if "::" in ref:
        rel, name = ref.split("::", 1)
        p = root / rel
        if not p.is_file():
            return f"{ref}: file missing"
        if p.suffix == ".py":
            return None if name in _top_level_names(p) else f"{ref}: test function missing"
        return None if f'test("{name}"' in p.read_text() else f"{ref}: Playwright test title missing"
    rel, sym = (ref.split(".py:", 1)[0] + ".py", ref.split(".py:", 1)[1]) if ".py:" in ref else (ref, "")
    p = root / rel
    if not p.exists():
        return f"{ref}: path missing"
    if sym and sym not in _top_level_names(p):
        return f"{ref}: symbol missing"
    return None


def check(root: Path = PROJECT_ROOT) -> list[str]:
    problems: list[str] = []
    seen: set[str] = set()
    for r in REQUIREMENTS:
        if r.req_id in seen:
            problems.append(f"{r.req_id}: duplicate id")
        seen.add(r.req_id)
        if r.classification not in (CORE, APP, EXT, UNRES):
            problems.append(f"{r.req_id}: bad classification {r.classification!r}")
        if not r.implementation or not r.verification:
            problems.append(f"{r.req_id}: needs an implementation and a verification reference")
        for ref in r.implementation + r.verification + r.artifacts:
            err = resolve(ref, root)
            if err:
                problems.append(f"{r.req_id}: {err}")
    return problems


COLUMNS = ("req_id", "requirement", "source", "classification", "implementation", "artifacts", "verification", "status")


def render_csv() -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(COLUMNS)
    for r in REQUIREMENTS:
        w.writerow([r.req_id, r.requirement, r.source, r.classification, "; ".join(r.implementation),
                    "; ".join(r.artifacts), "; ".join(r.verification), r.status])
    return buf.getvalue()
