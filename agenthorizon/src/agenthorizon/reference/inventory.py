"""Model / interface / experiment inventory (EXPERIMENT_INVENTORY.json)."""

from __future__ import annotations

from dataclasses import asdict

from agenthorizon.judging.registry import CONFIGS, INTERFACE_LABELS, LABEL_TO_INTERFACE, MODELS, NAME_TO_MODEL_KEY
from agenthorizon.util.io import utcnow_iso

# Experiments the brief attributes to the paper but whose rows/configurations are not readable here.
UNREADABLE_PAPER_EXPERIMENTS = [
    {"experiment_id": "paper:revised-main", "description": "Revised headline results on AH and AH-S (AH-D development reported separately)",
     "requires": ["ah-paper", "ah-revised-manifests", "ah-markdowns", "ah-media"], "status": "blocked",
     "reason": "Paper table rows unreadable (S1 inaccessible) and revised manifests not located."},
    {"experiment_id": "paper:direct-table", "description": "Direct multimodal (no-harness) judge table",
     "requires": ["ah-paper"], "status": "blocked", "reason": "Rows unknown; only Qwen 3.5 9B is named (MP §7)."},
    {"experiment_id": "paper:additional-harness-table", "description": "Additional model x harness pairings",
     "requires": ["ah-paper"], "status": "partially_known", "reason": "S8 legacy grids list 15 pairings; revised table unreadable."},
    {"experiment_id": "paper:input-removal-ablations", "description": "Input-removal ablations on their stated examples",
     "requires": ["ah-paper", "ah-ablation-membership"], "status": "blocked", "reason": "Membership and removed-field controls not located."},
    {"experiment_id": "paper:partition-sensitivity", "description": "Legacy vs revised partition sensitivity",
     "requires": ["ah-legacy-labels-main", "ah-revised-manifests", "ah-revised-splitter-verdicts"], "status": "blocked",
     "reason": "Revised membership and splitter verdicts not located; legacy labels unreadable here."},
    {"experiment_id": "paper:repeated-trials", "description": "Repeated-trial variance (if reported)", "requires": ["ah-paper"],
     "status": "unknown", "reason": "Cannot determine from accessible sources."},
]


def inventory(tables: list[dict]) -> dict:
    by_id = {t["table_id"]: t for t in tables}
    configs_by_pair = {}
    for c in CONFIGS:
        if c.evidence_class == "paper_row":
            configs_by_pair[(c.model_key, c.interface)] = c.config_id

    experiments = []
    for tid, subset, manifest in (("S8.T1", "AH-legacy", "legacy:AgentHorizon.jsonl"),
                                  ("S8.T2", "AH-S-legacy", "legacy:AgentHorizon-Simple.jsonl"),
                                  ("S8.T3", "full-release-MT", "release:all-1373")):
        t = by_id[tid]
        for r in t["rows"]:
            mkey = NAME_TO_MODEL_KEY.get(r["model"])
            iface = LABEL_TO_INTERFACE.get(r["interface"])
            cid = configs_by_pair.get((mkey, iface))
            telemetry = {}
            for k in ("mean_input_tokens", "mean_output_tokens", "mean_tool_calls", "mean_images_viewed"):
                if k in r:
                    telemetry[k] = "reported" if r[k] is not None else "not reported (—)"
            experiments.append({
                "experiment_id": f"{subset}:{cid or f'{mkey}@{iface}'}",
                "reference_table": tid,
                "reference_line": r["line"],
                "subset": subset,
                "scoring_manifest": manifest,
                "config_id": cid,
                "model": r["model"],
                "interface": r["interface"],
                "model_qualifier": r.get("model_qualifier"),
                "telemetry_reported": telemetry,
                "result_classes": {"paper_reported_aggregate": "captured", "rescored_author_predictions": "unavailable (predictions not located)",
                                   "new_paper_compatible_run": "not run (blocked: data/credentials/budget)"},
            })
    return {
        "generated_at": utcnow_iso(),
        "models": [asdict(m) for m in MODELS],
        "interfaces": INTERFACE_LABELS,
        "configurations": [c.to_dict() for c in CONFIGS],
        "experiments_from_reference_tables": experiments,
        "experiments_not_readable": UNREADABLE_PAPER_EXPERIMENTS,
        "notes": [
            "S8 tables use the legacy submitted partition; they are reference aggregates, not revised-paper rows.",
            "A configuration with provider_model_id=null cannot be executed until an operator supplies a verified identifier.",
            "Running a current substitute model creates a new experiment, never the original paper row.",
        ],
    }
