"""PAPER_SPEC.json: the executable specification, assembled from the constants the code actually runs with.

The paper (arXiv:2610.11050v1) was not readable from this environment: arxiv.org is blocked by the egress policy and
no PDF was attached. Values attributed to the paper are therefore the facts quoted in the master prompt and are
labelled ``paper (quoted in MP §n)``; executable detail comes from the authors' repository at the locked commit.
Every element names its source and the symbol that implements it, so the record cannot drift from the code.
"""

from __future__ import annotations

from agenthorizon.util.io import utcnow_iso

SPEC_VERSION = "ah-paper-spec/1"


def _impl(obj) -> str:
    return f"{obj.__module__}:{getattr(obj, '__qualname__', getattr(obj, '__name__', ''))}"


def paper_spec() -> dict:
    from agenthorizon.data import splits
    from agenthorizon.data.standard import ADAPTER_VERSION, KNOWN_ACTION_TYPES, LEAKY_TRAJECTORY_FIELDS
    from agenthorizon.experiments.registry import experiments
    from agenthorizon.judging import prompts as P
    from agenthorizon.judging.direct import packaging
    from agenthorizon.judging.registry import CONFIGS, INTERFACE_LABELS, MODELS
    from agenthorizon.reference.analysis import REVISED_CHECK_TABLE
    from agenthorizon.runs.policy import POLICIES, select
    from agenthorizon.scoring import protocol
    from agenthorizon.scoring.categories import CANONICAL_NATIVE, CATEGORY_MAP_VERSION, NATIVE_TO_CATEGORY
    from agenthorizon.scoring.reference_compat import REFERENCE_ID
    from agenthorizon.sources.cache import load_lock, locked_revision

    lock = load_lock() or {"sources": []}
    by_id = {s["source_id"]: s for s in lock["sources"]}
    rev = locked_revision("agenthorizon-repo") or "unknown"
    s2 = f"github.com/ServiceNow/agenthorizon@{rev[:12]}"
    paper = by_id.get("agenthorizon-paper", {})

    prompts = {}
    for pid, pr in P.registry().items():
        prompts[pid] = {"paper_mode": pr.paper_mode, "source": pr.source, "template_vars": pr.template_vars,
                        "notes": pr.notes}

    exps: dict[str, int] = {}
    for e in experiments():
        exps[e.kind] = exps.get(e.kind, 0) + 1

    unresolved = [
        {"id": "U1", "item": "revised AH-D / AH / AH-S membership",
         "detail": "not located at the locked commit (all refs probed) and the dataset host is unreachable here; legacy "
                   "membership is registered separately and never relabelled", "see": "evidence/DATA_AVAILABILITY.json"},
        {"id": "U2", "item": "paper text, figures and appendix prompt figure",
         "detail": "arxiv.org blocked; paper facts are the master prompt's quotations, cross-checked against the "
                   "repository where it states the same fact", "see": "evidence/SOURCE_LOCK.json"},
        {"id": "U3", "item": "harness instruction file (AGENTS.md) used in the paper runs",
         "detail": "not in the release; paper-mode agentic runs need the operator to register it, extension runs stage the "
                   "public rubric", "see": f"{_impl(P.harness_instructions)}"},
        {"id": "U4", "item": "provider identifiers for Inkling and Kimi K2.7 Code (revised splitters)",
         "detail": "named only in the brief; no released artifact gives vendor, identifier or route",
         "see": "evidence/MODEL_CAPABILITIES.json"},
        {"id": "U5", "item": "sampling settings, serving flags and GPU configuration of the self-hosted runs",
         "detail": "unpublished; recorded as null (unknown), never defaulted", "see": "agenthorizon.judging.registry:CONFIGS"},
        {"id": "U6", "item": "author per-item predictions and telemetry",
         "detail": "not released; aggregates are kept as reference data only", "see": "evidence/REFERENCE_DATA.json"},
        {"id": "U7", "item": "2x2 mosaic implementation", "detail": packaging.MOSAIC_CHOICES["status"],
         "see": _impl(packaging.build_payload)},
    ]

    return {
        "spec_version": SPEC_VERSION,
        "generated_at": utcnow_iso(),
        "paper": {"id": "arXiv:2610.11050v1",
                  "title": "AgentHorizon: Evaluating Agentic Judges for Long-Horizon Computer-Use Tasks",
                  "lock_status": paper.get("status"),
                  "access_attempts": [{k: a.get(k) for k in ("url", "at", "outcome")} for a in paper.get("access_attempts", [])],
                  "how_cited": "values marked 'paper (quoted in MP ...)' come from the master prompt's quotations of the "
                               "paper; they are reconciliation targets, never used to modify labels"},
        "sources": [{"source_id": s["source_id"], "status": s.get("status"), "revision": s.get("resolved_revision"),
                     "kind": s.get("kind")} for s in lock["sources"]],
        "subsets": {
            "revised": {"names": list(splits.REVISED_NAMES), "check_table": REVISED_CHECK_TABLE,
                        "membership_status": "not located", "source": "paper (quoted in MP §2)",
                        "roles": {"AH-D": "development (never in held-out scores)", "AH": "evaluation (challenging)",
                                  "AH-S": "evaluation (simple)"}},
            "legacy": {"label_files": {k: {"manifest": v[0], "name": v[1]} for k, v in splits.LEGACY_LABEL_FILES.items()},
                       "documented_totals": {"legacy-AH": 605, "legacy-AH-S": 768},
                       "source": f"{s2}:README.md and dataset card (quoted in MP §1); docs/supplementary-results.md "
                                 "calls it the legacy partition",
                       "implementation": _impl(splits.Manifest)},
        },
        "partition_procedures": {
            "revised": {"splitter_models": list(splits.REVISED_SPLITTERS),
                        "verdicts_per_model": splits.REVISED_VERDICTS_PER_MODEL,
                        "verdicts_total": splits.REVISED_VERDICTS_PER_MODEL * len(splits.REVISED_SPLITTERS),
                        "rule": f"<= {splits.REVISED_AH_MAX_CORRECT} correct -> AH; more -> AH-S; invalid verdicts are not "
                                "correct", "source": "paper (quoted in MP §2)",
                        "implementation": _impl(splits.revised_bucket),
                        "status": "implemented and boundary-tested; inputs (24 verdicts per item) not released"},
            "legacy": {"k": splits.LEGACY_K, "easy_threshold": splits.LEGACY_EASY_THRESHOLD,
                       "source": f"{s2}:scripts/aggregate_difficulty.py", "implementation": _impl(splits.legacy_difficulty)},
            "reconstructions": "a recomputed partition always gets its own identity (official=False) and lineage",
        },
        "trajectory_standard": {"adapter": ADAPTER_VERSION, "versions_accepted": ["1.0", "1.1"],
                                "action_types": sorted(k for k in KNOWN_ACTION_TYPES if k != "native"),
                                "observation_timing": "pre_action (screenshot precedes the action in the same step)",
                                "judge_view_excludes": sorted(LEAKY_TRAJECTORY_FIELDS),
                                "source": f"{s2}:STANDARD.md (S4); converter writes version 1.1"},
        "judge_output_contract": {"fields": ["success", "reasoning", "confidence", "mistake_type"],
                                  "success": "JSON Boolean; strings, numbers, null and absence are invalid",
                                  "confidence": ["low", "medium", "high"], "mistake_type_on_success": None,
                                  "native_mistake_types": list(CANONICAL_NATIVE.values()),
                                  "category_map": {"version": CATEGORY_MAP_VERSION,
                                                   "native_to_enum": {k: v.value for k, v in NATIVE_TO_CATEGORY.items()}},
                                  "source": f"paper (quoted in MP §5); {s2}:docs/mistake-taxonomy.md (S7)"},
        "scoring": {"scorer_id": protocol.SCORER_ID, "reference_scorer": REFERENCE_ID,
                    "definitions": {"P": "gold positives in the complete manifest", "N": "gold negatives in the complete "
                                    "manifest", "TP": "gold positives with a valid Boolean success=true",
                                    "TN": "gold negatives with a valid Boolean success=false",
                                    "balanced_accuracy": "(TP/P + TN/N) / 2"},
                    "missing_and_invalid": "incorrect for their gold class; never shrink P or N; reported separately",
                    "categories": "exact recall needs a valid failure verdict and the matching category; typed "
                                  "denominators exclude untyped negatives, binary denominators never do",
                    "aggregate_mt": "exact matches / typed negatives (micro-average)",
                    "source": f"paper (quoted in MP §8); {s2}:docs/evaluation-protocol.md (S5)",
                    "implementation": _impl(protocol.score)},
        "attempt_policies": {pid: {**p.to_dict(), "selection": "the last counted attempt is scored; no response -> "
                                   "missing (incorrect)"} for pid, p in POLICIES.items()},
        "attempt_selection_implementation": _impl(select),
        "prompts": prompts,
        "direct_preprocessing": {
            "native-512x332": "S5: every screenshot fit into 512x332 (released maximum size)",
            "released-auto@<budget>": "released auto-resolution: largest width in [64, 512] (aspect 1710:1112) within "
                                      "the image-token budget",
            "released-1126x730": "released fixed-size variant",
            "mosaic-2x2-1024x664": packaging.MOSAIC_CHOICES,
            "never": "no truncation, keyframe selection, OCR or summaries in paper mode; a request a provider cannot "
                     "take whole is a serving incompatibility",
            "implementation": _impl(packaging.build_payload),
        },
        "interfaces": INTERFACE_LABELS,
        "models": [{"model_key": m.model_key, "display_name": m.display_name, "vendor": m.vendor,
                    "known_ids": m.known_ids, "id_evidence": m.id_evidence} for m in MODELS],
        "judge_configurations": [{k: c.to_dict()[k] for k in ("config_id", "model_key", "interface", "route",
                                                              "provider_model_id", "preprocessing", "prompt_revision",
                                                              "paper_rows", "role", "evidence_class")} for c in CONFIGS],
        "experiments": {"registered": sum(exps.values()), "by_kind": exps, "see": "evidence/EXPERIMENT_REGISTRY.json"},
        "unresolved": unresolved,
    }
