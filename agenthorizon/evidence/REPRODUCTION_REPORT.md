# Reproduction report

Generated 2026-10-09T23:27:58Z by `agenthorizon evidence reproduction` from the files in `evidence/`.

## Verdict

The paper core and the application layer are implemented and tested end to end. **Empirical reproduction of the paper is blocked in the environment that built this repository**:

- the official dataset, the paper and several model providers were unreachable;
- there were no provider credentials and no budget;
- the paper's revised AH-D/AH/AH-S membership is not in any artifact that could be read.

No new model result exists here. No number below is a reproduction of a paper number, and no exact reproduction is claimed for any table.

## Result classes and comparison scope

| Class | Present | Where |
| --- | --- | --- |
| Paper-reported aggregates (reference data, never asserted as results) | 3 supplementary tables, 45 rows, with source locations | `REFERENCE_DATA.json` |
| Rescored author predictions | none: no per-item predictions are released | — |
| New paper-compatible runs | none: blocked (data, credentials, budget) | `EXPERIMENT_REGISTRY.json` |
| Extension runs | none | — |
| Test-fixture runs (synthetic, labelled) | yes: unit/integration tests, the UI suite and the Compose smoke run | `TEST_REPORT.md`, `STACK_SMOKE.json` |

Comparisons in the application are protocol-matched by default. A paper-reported aggregate is only ever shown in a separate reference column.

## Sources

| Source | Status | Revision |
| --- | --- | --- |
| agenthorizon-paper | inaccessible | — |
| agenthorizon-repo | downloaded | 8584a347370a |
| agenthorizon-dataset | inaccessible | — |
| agenthorizon-standard | downloaded | 8584a347370a |
| agenthorizon-eval-protocol | downloaded | 8584a347370a |
| agenthorizon-construction | downloaded | 8584a347370a |
| agenthorizon-taxonomy | downloaded | 8584a347370a |
| agenthorizon-supplementary | downloaded | 8584a347370a |
| agenthorizon-dataverse | inaccessible | — |
| agentrewardbench-repo | downloaded | 05899fcfe52c |
| agentrewardbench-dataset | inaccessible | — |
| osworld-repo | downloaded | b138d3482560 |
| master-prompt | downloaded | — |

## Data acquired

Official AgentHorizon artifacts (`DATA_AVAILABILITY.json`): published_but_unavailable: 9, acquired: 6, not_located: 15, not_applicable: 1.

| Artifact | Status | Basis |
| --- | --- | --- |
| Paper PDF/HTML arXiv:2610.11050v1 | published_but_unavailable | agenthorizon-paper inaccessible (egress_denied) |
| Authors' evaluation harness repository | acquired | agenthorizon-repo@8584a347370a |
| AgentHorizon.jsonl (legacy AH labels, 605 items) | published_but_unavailable | agenthorizon-dataset inaccessible (egress_denied) |
| AgentHorizon-Simple.jsonl (legacy AH-S labels, 768 items) | published_but_unavailable | agenthorizon-dataset inaccessible (egress_denied) |
| sandbox/data/markdowns/<trajectory_id>.md (judge input) | published_but_unavailable | agenthorizon-dataset inaccessible (egress_denied) |
| sandbox/data/jsons/<trajectory_id>.json (structured trajectories) | published_but_unavailable | agenthorizon-dataset inaccessible (egress_denied) |
| sandbox/data/media/images/<steps_id>/step_N.png (screenshots, ~43 GB advertised) | published_but_unavailable | agenthorizon-dataset inaccessible (egress_denied) |
| Revised AH-D / AH / AH-S membership (162 / 528 / 683) | not_located | Absent from S2 at every commit and ref (main, refs/pull/1/head). S3 unreadable here, so pr |
| Revised splitter verdicts (3 models x 8 verdicts per item) | not_located | no public location found in accessible sources |
| Legacy splitter runs (experiments/.meta/runs_splitter_v2, Qwen 3.5 122B-A10B x 8) | not_located | Explicitly gitignored in S2 (experiments/.gitignore). |
| Full labels file with original_id / paired_id / negative_source / mistake_type | not_located | Scripts read data/standard/agenthorizon_labels.jsonl; whether the S3 label files carry the |
| Standardized trajectories JSONL (data/standard/agenthorizon.jsonl) | not_located | no public location found in accessible sources |
| agenthorizon_labels_anon.jsonl (Dataverse, sha256 ec57ba3e…) | published_but_unavailable | agenthorizon-dataverse inaccessible (egress_denied) |
| agenthorizon_difficulty_anon.jsonl with pair_group_id (Dataverse, sha256 7a4cff47…) | published_but_unavailable | agenthorizon-dataverse inaccessible (egress_denied) |
| AGENTS.md / CLAUDE.md / GEMINI.md judge framework files | not_located | The official prompt tells the judge to use these files; experiments/README.md claims they  |
| experiments/.meta/exp_ids.jsonl run registry | not_located | README says committed; absent at 8584a347. |
| Per-item predictions / run directories for reported configurations | not_located | Kept in an internal EAI data object; not public. |
| results/analysis/*gemini_flash_lite* (historical construction-pool run) | not_located | README lists them as committed; absent at 8584a347 (and outside the 1,373-item release by  |
| Prompt variants P0-P7, prompts/archive/evaluate_trajectory_v0.txt, prompts/meta_judge/* | not_located | no public location found in accessible sources |
| 2x2 mosaic (1024x664) preprocessing implementation | not_located | Protocol describes it; released llm_judges/ code has auto-resolution and fixed-size compre |
| Input-removal ablation membership and configurations | not_located | no public location found in accessible sources |
| Raw delivery JSON (final_delivery_batch.json) and source recordings/videos | not_applicable | Internal annotation deliverables; not part of the public release. No video artifact is lis |
| Reviewer annotations (3-reviewer diagnostic, residual model-based QA records) | not_located | no public location found in accessible sources |
| data/preprocessed/compress and compress_2_2x payloads | not_located | Generated locally by the authors; not committed. |
| Protocol, construction, taxonomy, supplementary, standard documents (S4-S8) | acquired | agenthorizon-repo@8584a347370a |
| Croissant metadata (paper/croissant.json) | acquired | agenthorizon-repo@8584a347370a |

Supplemental sources (real data, kept out of every AgentHorizon denominator):

| Source | Revision | Records | Kinds | Usable binary labels | Licence |
| --- | --- | ---: | --- | ---: | --- |
| agentrewardbench | 05899fcfe52c | 1302 | annotation_only: 1302 | 1301 | absent |
| osworld | b138d3482560 | 418 | task_definition: 418 | 0 | Apache-2.0 |

Separation audit (`DEDUP_AUDIT.json`): 1720 records compared; 26 exact-instruction duplicate groups; 8 possible duplicates flagged for review (never merged); 49 native-ID aliases; 0 supplemental records overlapping AgentHorizon evaluation (no AgentHorizon dataset was available to compare against).

## Split and ID conflicts

Resolved (details in `RELEASE_RECONCILIATION.md`):

- the legacy 605/768 partition is registered as its own manifests (`legacy-AH`, `legacy-AH-S`) and never relabelled as the revised partition;
- the protocol scorer and the released scorer disagree on missing and non-Boolean outputs. The canonical scorer follows the protocol; a separate compatibility scorer reproduces the released script exactly; both are cross-checked;
- the native category spellings (singular/plural *Misunderstanding*) go through a versioned map (`ah-categories-v1`);
- record `version` 1.0 vs 1.1: both accepted and the observed value recorded;
- screenshot naming and timing: 0-based step IDs vs 1-based files, and pre-action observations, both preserved and documented;
- the dataset layout vs the prompt layout: an audited staging adapter maps one onto the other;
- AgentRewardBench primary/secondary annotations follow ARB's own helper functions (cross-checked); OSWorld Windows tasks reuse Ubuntu task IDs and are recorded as aliases.

Unresolved (`PAPER_SPEC.json → unresolved`):

- **revised AH-D / AH / AH-S membership**: not located at the locked commit (all refs probed) and the dataset host is unreachable here; legacy membership is registered separately and never relabelled
- **paper text, figures and appendix prompt figure**: arxiv.org blocked; paper facts are the master prompt's quotations, cross-checked against the repository where it states the same fact
- **harness instruction file (AGENTS.md) used in the paper runs**: not in the release; paper-mode agentic runs need the operator to register it, extension runs stage the public rubric
- **provider identifiers for Inkling and Kimi K2.7 Code (revised splitters)**: named only in the brief; no released artifact gives vendor, identifier or route
- **sampling settings, serving flags and GPU configuration of the self-hosted runs**: unpublished; recorded as null (unknown), never defaulted
- **author per-item predictions and telemetry**: not released; aggregates are kept as reference data only
- **2x2 mosaic implementation**: engineering choice: S5 describes the mosaic but the release contains no implementation

## Models and harnesses

Registered judge configurations: 23; capability status on the build host (`MODEL_CAPABILITIES.json`, 2026-10-09T23:27:46Z): blocked: 23. Most frequent reasons:

- self-hosted endpoint required (operator supplies --base-url and GPU serving) (10)
- no released artifact states the provider model identifier (5)
- credentials missing: GEMINI_API_KEY (5)
- route host unreachable from this environment (egress_denied) (3)
- serving route not stated by any accessible source (3)
- credentials missing: CODEX_AUTH_JSON (2)
- installed '2.1.296 (Claude Code)' is not the verified release 2.1.295 (runs are extension-class) (2)
- credentials missing: ANTHROPIC_API_KEY (2)

Executed live: **none**. The five harness adapters ran end to end inside the real sandbox with replayed harness outputs; the direct providers ran against local fake endpoints that capture the exact wire payloads.

Harness CLIs installed and probed by a judge worker in the Compose stack (`STACK_SMOKE.json → capability_probe`):

- claude_code: 2.1.295 (Claude Code) (installed: True, sandbox: True)
- codex: codex-cli 0.162.1 (installed: True, sandbox: True)
- gemini_cli: 0.63.0 (installed: True, sandbox: True)
- opencode: 1.18.35 (installed: True, sandbox: True)
- openhands: OpenHands CLI 1.16.0 (installed: True, sandbox: True)

## Experiments

41 experiments are registered with executable definitions (`agenthorizon experiments list`):

| Kind | Status counts |
| --- | --- |
| ablation | blocked: 1 |
| development | blocked: 1 |
| direct | blocked: 5 |
| reference_grid | blocked: 15 |
| revised_main | blocked: 14 |
| splitter_legacy | blocked: 1 |
| splitter_revised | blocked: 3 |
| trials | blocked: 1 |

Most frequent blockers:

- ah-markdowns (40)
- ah-jsons (40)
- ah-media (40)
- credentials missing (18)
- selection/membership not located (17)
- ah-legacy-labels-main (16)
- ah-legacy-labels-simple (16)
- self-hosted endpoint required (operator supplies --base-url and GPU serving) (16)
- ah-paper (16)
- ah-revised-manifests (15)

## Deterministic checks on the reference data

- Construction accounting arithmetic: 5/5 identities hold.
- Revised check table identities: 15/15 hold (the table itself is the master prompt's quotation of the paper).
- Aggregate MT definition: Micro-averaging over typed negatives fits every non-splitter row with one model-independent count (n_c in [313]; stdev of per-row implied values 0.78), while the T=850 hypothesis does not (stdev 12.96). The splitter row misses the rounding interval by ~0.1 point, consistent with S8's note that it is affected by its splitter role. Aggregate MT is implemented as exact-type matches over typed negatives; untyped negatives stay in binary denominators only. Inference, not a released definition.
- Legacy composition inference: inferred reconciliation target; verify against released legacy label files when obtainable.

## Requirement coverage

`TRACEABILITY.csv` lists 84 requirements, each with resolvable implementation and verification references. Counts by classification and status:

- APPLICATION LAYER — implemented: 1
- APPLICATION LAYER — measured on a release-scale synthetic catalogue (real data unreachable): 1
- APPLICATION LAYER — verified: 11
- APPLICATION LAYER — verified on synthetic test data (official AgentHorizon data unreachable here): 8
- APPLICATION LAYER — verified statically: 1
- OPTIONAL EXTENSION — verified: 1
- PAPER CORE — blocked: 1
- PAPER CORE — flags verified against the installed CLIs: 1
- PAPER CORE — implemented: 3
- PAPER CORE — implemented and boundary-tested: 1
- PAPER CORE — implemented as a documented engineering choice (no released implementation, U7): 1
- PAPER CORE — task definitions: 1
- PAPER CORE — verified: 33
- PAPER CORE — verified (digests): 1
- PAPER CORE — verified against local fakes: 1
- PAPER CORE — verified against the released supplementary tables: 1
- PAPER CORE — verified on synthetic test data (official AgentHorizon data unreachable here): 14
- PAPER CORE — verified on synthetic trajectories in ARB's released format: 1
- PAPER CORE — verified on the real released annotations (cross-checked against ARB's own helpers): 1
- UNRESOLVED — unresolved: 1

## What would lift each block

1. Network access to huggingface.co: pin the dataset revision (`agenthorizon sources lock`), ingest it, materialize the ~43 GB of advertised media, and run the validation and the legacy reconciliation on real rows.
2. The revised AH-D/AH/AH-S manifests (and, for reconstruction, the 24 splitter verdicts per item) from the authors. Until then, revised-table reproduction stays blocked and legacy scores stay labelled legacy.
3. The harness instruction file (AGENTS.md / CLAUDE.md / GEMINI.md) used in the paper runs, for paper-mode agentic runs.
4. Provider credentials per route plus an explicit budget. For the self-hosted rows: GPU serving (vLLM) and the authors' serving settings, which are unpublished.
5. Provider identifiers for Inkling and Kimi K2.7 Code (revised splitters).
6. Access to arxiv.org, to compare the released prompt with the paper's prompt figure and to read every table and appendix directly rather than through the master prompt's quotations.

## Claims not made

No exact reproduction. No legacy score presented as a revised score. No substituted model, altered prompt, truncated input or leaked answer in any paper-mode path. No invented telemetry: unknown usage stays unknown. No synthetic data presented as benchmark content.
