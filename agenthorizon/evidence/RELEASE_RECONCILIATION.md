# Release reconciliation: revised paper partition vs. released artifacts

Status date: 2026-10-09. Machine-readable companions: `SOURCE_LOCK.json`, `DATA_AVAILABILITY.json`,
`REFERENCE_DATA.json`, `EXPERIMENT_INVENTORY.json`.

## 1. What could be read

| Source | Status here | Pinned revision |
|---|---|---|
| S1 paper (arXiv:2610.11050v1) | **inaccessible** — egress proxy denied `arxiv.org`, `export.arxiv.org` (HTTP 403 on CONNECT, policy denial). Web search does not index it yet. | — |
| S2 authors' repository | downloaded (full history: 4 commits; refs `main`, `refs/pull/1/head`; no tags, no other branches) | `8584a347370ab1d92b908732cfabe72b3a23486d` |
| S3 Hugging Face dataset | **inaccessible** — `huggingface.co`, `cdn-lfs.huggingface.co`, `cas-bridge.xethub.hf.co` denied by egress policy | unresolved |
| Harvard Dataverse deposit named in S2 Croissant | **inaccessible** — `dataverse.harvard.edu`, `doi.org` denied | — |
| S4–S8 documents | downloaded via S2 | `8584a347` |
| S9 AgentRewardBench repo / HF data | repo downloaded / HF inaccessible | `05899fcf` |
| S10 OSWorld repo | downloaded (shallow, depth 50) | `b138d348` |

Consequence: every statement below about the paper's *revised* partition comes from the implementation
brief (MP), which attributes it to S1. Those statements are recorded as *described only by MP* and are
used as reconciliation targets, never as data.

## 2. The partition conflict

| Evidence | Partition described |
|---|---|
| S2 `README.md` (Getting the data) | Two label files: `AgentHorizon.jsonl` (605) and `AgentHorizon-Simple.jsonl` (768) |
| S2 `paper/croissant.json` | "partitioned by an open-weight splitter into AgentHorizon (605 items) and AgentHorizon-Simple (768 items)"; "induced by Qwen 3.5 122B-A10B in OpenCode at k=8, threshold >= 7/8" |
| S2 `scripts/aggregate_difficulty.py` | Legacy splitter v2: 8 OpenCode attempts of `Qwen/Qwen3.5-122B-A10B` per trajectory; Easy iff `success_count >= 7`; errors/incomplete are their own states; pairs NOT forced into one bucket |
| S8 `docs/supplementary-results.md` | Names the 605/768 partition the "submitted Qwen-defined partition" and says "the revised paper uses a held-out development set and a pooled three-splitter evaluation partition; these legacy tables remain available as a sensitivity analysis rather than as the current leaderboard" |
| MP §2 (attributing S1) | AH-D 162 / AH 528 / AH-S 683; three splitters (Qwen 3.5 122B-A10B, Inkling, Kimi K2.7 Code) × 8 verdicts = 24; ≤18 correct → AH, otherwise AH-S; invalid verdicts are not correct |

Resolution:

* The paper defines the **target claim** (revised AH/AH-S, AH-D development). The matching executable
  detail — revised membership, the 24 verdicts per item, the dev/eval holdout rule — is **not in any
  released artifact we could read**. S2 has no such file at any commit or ref; S3 could not be listed.
* Exact revised-paper reproduction is therefore **blocked** on the artifact `ah-revised-manifests`
  (and, for reconstruction, `ah-revised-splitter-verdicts`). We do not subtract examples, recreate a
  difficulty split with current models, or relabel legacy scores as revised scores.
* The legacy partition is supported as its own versioned manifest set (`legacy-submitted`), importable
  as soon as S3 is reachable, and clearly labelled legacy in every report and in the UI.
* The revised procedure (3×8, ≤18 → AH) is implemented and boundary-tested (18 vs 19 correct) so that it
  can be executed on real verdicts if they are released; any partition we compute ourselves gets its own
  identity and lineage and is never presented as the official one.

Arithmetic that does hold: 605 + 768 = 1,373 = 162 + 528 + 683, so both partitions cover the full release;
AH + AH-S (revised) = 1,211 items, i.e. the development set is carved out of the same 1,373 items.

## 3. Inferred composition of the legacy files (verification targets)

`REFERENCE_DATA.json → analysis_legacy_composition` searches every (positive, negative) split of each legacy
subset for one that makes all 15 reported positive and negative accuracies exactly achievable at one-decimal
rounding (fixed denominators make this a hard constraint). Exactly one survives per subset:

| Legacy subset | Positives | Negatives | Typed negatives | Untyped |
|---|---:|---:|---:|---:|
| AgentHorizon (605) | 287 | 318 | 313 | 5 |
| AgentHorizon-Simple (768) | 236 | 532 | 531 | 1 |
| Sum | 523 | 850 | 844 | 6 |

The sums reproduce the release totals and the six untyped negatives documented in S6 — an independent
consistency check. These are **inferences to verify** against the label files once readable, not data.

## 4. Scoring-rule conflict between the protocol and the released scorer

| Behaviour | S5 protocol / S8 / MP | `scripts/analyze_eval_results.py` @8584a347 |
|---|---|---|
| Non-Boolean `success` (e.g. `"false"`) | invalid → incorrect for its gold class | `bool(data["success"])` — the string `"false"` becomes a *positive* prediction |
| Missing output | counts as incorrect; denominator fixed | silently absent from every denominator |
| Parse error (no `success` key / bad JSON) | incorrect | counted in a separate tally, excluded from accuracy |
| Failure-type score | exact type **and** `success=false` | "by mistake type" = binary rejection rate per gold type; no exact-type recall |
| Primary metric | balanced accuracy | accuracy / precision / recall / F1 (balanced accuracy only in `compare_runs.py`) |

Resolution: the canonical scorer implements the protocol (fixed denominators, strict JSON Boolean).
A separate `reference_compat` scorer reproduces `compute_metrics` exactly and is cross-checked byte-for-byte
against the authors' script; the two agree on complete, valid prediction sets and diverge — by design and
with a tested hand fixture — on missing and non-Boolean outputs. Aggregate MT is defined as exact-type
matches over typed negatives, the only definition consistent with S8 (`analysis_aggregate_mt_definition`:
implied legacy-AH typed count 313 for every non-splitter row; the T=850 alternative is inconsistent).

## 5. Vocabulary and schema conflicts

* **Misunderstanding label spelling.** Rubric/judge schema: `Misunderstanding of the Instruction`.
  `make_clean_split.py` says the labels-file vocabulary is plural (`…Instructions`); `analyze_eval_results.py`
  and `results_to_submission.py` normalise plural→singular; `generate_results_table.py` looks up the plural key
  and would print "-" for singular data. Resolution: versioned category map `ah-categories-v1` accepting both
  exact spellings, no fuzzy matching; native strings are preserved alongside the enum.
* **Record `version` field.** STANDARD.md is titled v1.1 but its schema table says the field is always
  `"1.0"`; the converter writes `"1.1"`. Resolution: adapters accept both and record the observed value.
* **Screenshot naming.** README says `media/images/<steps_id>/step_N.png`; scripts use the label's
  `original_id` as the directory with 1-based `step_{step_id+1}.png` for 0-based `step_id`. Markdown shows
  `### Step {step_id}` (0-based) next to `step_{step_id+1}.png`. The prompt says each step "ends with" its
  screenshot link, but the renderer places the screenshot *before* the action (pre-action observation).
  Resolution: both IDs preserved; display numbering documented; observation timing = pre-action.
* **Typed text truncation.** The Markdown renderer truncates `type` text to 80 characters; the JSON keeps
  the full text. Paper mode reproduces the Markdown exactly; the workbench shows full text.

## 6. Layout conflict

| Released dataset (S3 README) | Official prompt | experiments/README.md template |
|---|---|---|
| `sandbox/data/markdowns/`, `sandbox/data/jsons/`, `sandbox/data/media/images/` | `./agenthorizon_md/`, `./agenthorizon_json/`, `./data/media/images/` | `sandbox/agenthorizon_md/`, `sandbox/agenthorizon_json/`, `sandbox/data/media/images` (symlink) |

Resolution: an explicit, tested layout adapter stages the released layout under the prompt's names per task
and audits every rewritten path (none are needed for images: `./data/media/images` matches).

## 7. Missing harness instruction files

The prompt instructs judges to read `AGENTS.md / CLAUDE.md / GEMINI.md`. experiments/README.md says they are
committed under `.meta/template/sandbox/`; they are absent at `8584a347`. They may ship in S3's `sandbox/`
(unverifiable). Paper-mode agentic runs require them; until located, agentic paper runs are marked
`blocked: harness instruction file not located`. We do not substitute another repository's agent
instructions. An explicitly-labelled extension may stage the S7 rubric text instead.

## 8. Direct-judge preprocessing conflict

S5 specifies 512×332 frames and a 2×2 row-major 1024×664 mosaic for serving-limit overflow. Released code
(`llm_judges/preprocess_compress.py`) instead binary-searches the largest width ≤512 (aspect 1710:1112) that
fits a token budget (README: 100k for the "1×" variant; argument default 60k) and offers a fixed 1126×730
"2.2×" variant; no mosaic code exists. Resolution: `native-512x332` follows S5 + the released resize/encode
calls (LANCZOS thumbnail, JPEG q60); `mosaic-2x2-1024x664` implements S5 with documented engineering choices
for the unresolved details (blank padding of the final grid, caption stating reading order); the released
auto-resolution and 2.2× variants are registered as separate, named preprocessing configurations.

## 9. Isolation scope

The authors' sandbox is per *experiment*: every judge process runs with all trajectory files readable in its
working directory. Two examples sharing a recording expose the paired instruction to a judge that searches.
This implementation stages one task per fresh workspace (stricter); the difference is recorded on every run.

## 10. Count evolution inside S2

Commit `b9b9fb9` replaced construction-pool counts (852 deliverables, 1,704 tasks; 426 pairs) with
425 pairs → 1,700 candidates → 1,373 released (523 positive, 850 negative). `split_agenthorizon.py`'s docstring
gives two different descriptions of its edge components (sizes 3+1 on top of 424 size-4 pairs vs. a size-7
triangle and a size-1 lone positive on top of 423); the Croissant description says "425 size-4 paired groups"
with "one positive and one negative" per pair. These describe the 1,700-item construction pool, not the
1,373-item release; grouping in the release is audited from data (blocked until S3 is readable) rather than
assumed.
