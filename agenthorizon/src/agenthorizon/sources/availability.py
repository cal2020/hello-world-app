"""Artifact availability classification (DATA_AVAILABILITY.json).

Each artifact the paper, README, Croissant metadata, scripts, or brief refers to is classified as:

* ``acquired``                     bytes in hand at a pinned revision
* ``published_but_unavailable``    publicly published, but retrieval from this environment failed
* ``not_located``                  referenced somewhere, but no public location was found
* ``not_applicable``               not part of the released benchmark by design

Status is computed from the source lock and local ingestion state, so it updates when access changes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

from agenthorizon.util.io import utcnow_iso


@dataclass
class Artifact:
    artifact_id: str
    name: str
    benchmark: str
    referenced_by: list[str]
    location: str | None
    depends_on_source: str | None
    needed_for: list[str]
    status_if_source_ok: str = "acquired"
    fixed_status: str | None = None  # for not_located / not_applicable artifacts
    detail: str = ""
    local_check: str | None = None  # relative path under var/ proving acquisition
    extra: dict = field(default_factory=dict)


S2 = "agenthorizon-repo"
S3 = "agenthorizon-dataset"

ARTIFACTS: list[Artifact] = [
    Artifact("ah-paper", "Paper PDF/HTML arXiv:2610.11050v1", "AgentHorizon", ["MP"], "https://arxiv.org/pdf/2610.11050v1",
             "agenthorizon-paper", ["specification", "tables", "figures", "prompt figure", "ablation membership"],
             status_if_source_ok="acquired", detail="Probe only; when reachable, retrieve and digest the versioned PDF."),
    Artifact("ah-repo", "Authors' evaluation harness repository", "AgentHorizon", ["MP", "S3 README"],
             "https://github.com/ServiceNow/agenthorizon", S2, ["executable reference", "prompt", "scorer cross-check"]),
    Artifact("ah-legacy-labels-main", "AgentHorizon.jsonl (legacy AH labels, 605 items)", "AgentHorizon", ["S2:README.md"],
             "hf://datasets/ServiceNow/AgentHorizon/AgentHorizon.jsonl", S3, ["legacy scoring", "legacy reconciliation"],
             status_if_source_ok="published_but_unavailable", local_check="datasets/agenthorizon"),
    Artifact("ah-legacy-labels-simple", "AgentHorizon-Simple.jsonl (legacy AH-S labels, 768 items)", "AgentHorizon",
             ["S2:README.md"], "hf://datasets/ServiceNow/AgentHorizon/AgentHorizon-Simple.jsonl", S3,
             ["legacy scoring", "legacy reconciliation"], status_if_source_ok="published_but_unavailable", local_check="datasets/agenthorizon"),
    Artifact("ah-markdowns", "sandbox/data/markdowns/<trajectory_id>.md (judge input)", "AgentHorizon", ["S2:README.md"],
             "hf://datasets/ServiceNow/AgentHorizon/sandbox/data/markdowns/", S3, ["judging", "exploration"],
             status_if_source_ok="published_but_unavailable", local_check="datasets/agenthorizon"),
    Artifact("ah-jsons", "sandbox/data/jsons/<trajectory_id>.json (structured trajectories)", "AgentHorizon", ["S2:README.md"],
             "hf://datasets/ServiceNow/AgentHorizon/sandbox/data/jsons/", S3, ["normalization", "exploration"],
             status_if_source_ok="published_but_unavailable", local_check="datasets/agenthorizon"),
    Artifact("ah-media", "sandbox/data/media/images/<steps_id>/step_N.png (screenshots, ~43 GB advertised)", "AgentHorizon",
             ["S2:README.md", "MP §3"], "hf://datasets/ServiceNow/AgentHorizon/sandbox/data/media/images/", S3,
             ["judging", "inspection"], status_if_source_ok="published_but_unavailable", local_check="media"),
    Artifact("ah-revised-manifests", "Revised AH-D / AH / AH-S membership (162 / 528 / 683)", "AgentHorizon", ["MP §1-2 (attributed to S1)"],
             None, None, ["revised headline reproduction"], fixed_status="not_located",
             detail="Absent from S2 at every commit and ref (main, refs/pull/1/head). S3 unreadable here, so presence on "
                    "the dataset's branches/tags/revisions is unverified, not disproven."),
    Artifact("ah-revised-splitter-verdicts", "Revised splitter verdicts (3 models x 8 verdicts per item)", "AgentHorizon",
             ["MP §2"], None, None, ["partition reconstruction"], fixed_status="not_located"),
    Artifact("ah-legacy-splitter-runs", "Legacy splitter runs (experiments/.meta/runs_splitter_v2, Qwen 3.5 122B-A10B x 8)",
             "AgentHorizon", ["S2:scripts/aggregate_difficulty.py"], None, None, ["legacy partition reconstruction"],
             fixed_status="not_located", detail="Explicitly gitignored in S2 (experiments/.gitignore)."),
    Artifact("ah-full-labels", "Full labels file with original_id / paired_id / negative_source / mistake_type", "AgentHorizon",
             ["S2:STANDARD.md", "S2:scripts/*.py (data/standard/agenthorizon_labels.jsonl)"], None, S3,
             ["pair grouping", "failure-category scoring", "leakage audit"], fixed_status="not_located",
             detail="Scripts read data/standard/agenthorizon_labels.jsonl; whether the S3 label files carry these fields is unverified."),
    Artifact("ah-standard-jsonl", "Standardized trajectories JSONL (data/standard/agenthorizon.jsonl)", "AgentHorizon",
             ["S2:scripts/*.py"], None, None, ["pair recovery from screenshot directories"], fixed_status="not_located"),
    Artifact("ah-dataverse-labels", "agenthorizon_labels_anon.jsonl (Dataverse, sha256 ec57ba3e…)", "AgentHorizon",
             ["S2:paper/croissant.json"], "doi:10.7910/DVN/J9KNWR", "agenthorizon-dataverse", ["label digest cross-check"],
             status_if_source_ok="published_but_unavailable",
             detail="Croissant URLs carry an anonymous-review access key; the persistent DOI is the public route."),
    Artifact("ah-dataverse-difficulty", "agenthorizon_difficulty_anon.jsonl with pair_group_id (Dataverse, sha256 7a4cff47…)",
             "AgentHorizon", ["S2:paper/croissant.json"], "doi:10.7910/DVN/J9KNWR", "agenthorizon-dataverse",
             ["legacy bucket import", "pair grouping"], status_if_source_ok="published_but_unavailable"),
    Artifact("ah-harness-instructions", "AGENTS.md / CLAUDE.md / GEMINI.md judge framework files", "AgentHorizon",
             ["S2:prompts/evaluate_trajectory.txt", "S2:experiments/README.md"], None, None, ["paper-faithful agentic judging"],
             fixed_status="not_located",
             detail="The official prompt tells the judge to use these files; experiments/README.md claims they are committed under "
                    ".meta/template/sandbox/, but they are absent at 8584a347. Possibly inside S3's sandbox/ (unverified)."),
    Artifact("ah-run-registry", "experiments/.meta/exp_ids.jsonl run registry", "AgentHorizon", ["S2:experiments/README.md"],
             None, None, ["run provenance"], fixed_status="not_located", detail="README says committed; absent at 8584a347."),
    Artifact("ah-predictions", "Per-item predictions / run directories for reported configurations", "AgentHorizon",
             ["S2:experiments/README.md (EAI mirror)"], None, None, ["independent rescoring of author predictions"],
             fixed_status="not_located", detail="Kept in an internal EAI data object; not public."),
    Artifact("ah-committed-results", "results/analysis/*gemini_flash_lite* (historical construction-pool run)", "AgentHorizon",
             ["S2:llm_judges/README.md"], None, None, ["historical comparison"], fixed_status="not_located",
             detail="README lists them as committed; absent at 8584a347 (and outside the 1,373-item release by the README's own note)."),
    Artifact("ah-prompt-variants", "Prompt variants P0-P7, prompts/archive/evaluate_trajectory_v0.txt, prompts/meta_judge/*",
             "AgentHorizon", ["S2:scripts/compare_runs.py", "S2:scripts/evaluate_trajectories.py", "S2:scripts/make_clean_split.py"],
             None, None, ["prompt ablations"], fixed_status="not_located"),
    Artifact("ah-mosaic-code", "2x2 mosaic (1024x664) preprocessing implementation", "AgentHorizon", ["S5"], None, None,
             ["direct judging beyond serving limits"], fixed_status="not_located",
             detail="Protocol describes it; released llm_judges/ code has auto-resolution and fixed-size compression only."),
    Artifact("ah-ablation-membership", "Input-removal ablation membership and configurations", "AgentHorizon", ["MP §9"],
             None, None, ["ablation reproduction"], fixed_status="not_located"),
    Artifact("ah-raw-delivery", "Raw delivery JSON (final_delivery_batch.json) and source recordings/videos", "AgentHorizon",
             ["S2:scripts/README.md"], None, None, ["re-derivation from raw"], fixed_status="not_applicable",
             detail="Internal annotation deliverables; not part of the public release. No video artifact is listed anywhere."),
    Artifact("ah-review-records", "Reviewer annotations (3-reviewer diagnostic, residual model-based QA records)", "AgentHorizon",
             ["S6"], None, None, ["agreement analysis"], fixed_status="not_located"),
    Artifact("ah-preprocessed-payloads", "data/preprocessed/compress and compress_2_2x payloads", "AgentHorizon",
             ["S2:llm_judges/README.md"], None, None, ["direct-judge payload digest comparison"], fixed_status="not_located",
             detail="Generated locally by the authors; not committed."),
    Artifact("ah-docs", "Protocol, construction, taxonomy, supplementary, standard documents (S4-S8)", "AgentHorizon",
             ["MP"], "S2 docs/", S2, ["specification", "reference tables"]),
    Artifact("ah-croissant", "Croissant metadata (paper/croissant.json)", "AgentHorizon", ["S2:README.md"], "S2", S2, ["provenance"]),
    Artifact("arb-annotations", "AgentRewardBench expert annotations (annotations.csv)", "AgentRewardBench", ["S9"],
             "S9 repo agent_reward_bench/data/annotations.csv", "agentrewardbench-repo", ["supplemental label exploration"]),
    Artifact("arb-splits-tasks", "AgentRewardBench splits.csv and per-benchmark task CSVs", "AgentRewardBench", ["S9"],
             "S9 repo agent_reward_bench/data/", "agentrewardbench-repo", ["supplemental split preservation"]),
    Artifact("arb-trajectories", "AgentRewardBench cleaned trajectories, screenshots, judgments (HF)", "AgentRewardBench", ["S9"],
             "hf://datasets/McGill-NLP/agent-reward-bench", "agentrewardbench-dataset", ["supplemental judging"],
             status_if_source_ok="published_but_unavailable"),
    Artifact("osworld-tasks", "OSWorld task definitions and evaluator configs (evaluation_examples/)", "OSWorld", ["S10"],
             "S10 repo evaluation_examples/", "osworld-repo", ["supplemental task exploration"]),
    Artifact("osworld-traces", "OSWorld agent trace exports (traj.jsonl + step screenshots + result.txt)", "OSWorld", ["S10"],
             None, None, ["supplemental trace import"], fixed_status="not_located",
             detail="The repository defines the export format but ships no traces; no verified linked trace release was located."),
]


def classify(artifacts: list[Artifact], lock: dict | None, var_dir: Path) -> list[dict]:
    status_by_source = {s["source_id"]: s for s in (lock or {}).get("sources", [])}
    out = []
    for a in artifacts:
        rec = asdict(a)
        rec.pop("status_if_source_ok")
        rec.pop("fixed_status")
        if a.fixed_status:
            status = a.fixed_status
            basis = a.detail or "no public location found in accessible sources"
        else:
            src = status_by_source.get(a.depends_on_source or "")
            src_status = (src or {}).get("status")
            if src_status == "downloaded":
                status, basis = "acquired", f"{a.depends_on_source}@{(src or {}).get('resolved_revision', '')[:12]}"
            elif src_status == "inspected":
                local = var_dir / a.local_check if a.local_check else None
                status = "acquired" if local and local.exists() and any(local.iterdir()) else "published_but_unavailable"
                basis = "source metadata readable; local materialization " + ("present" if status == "acquired" else "pending")
            else:
                status = "published_but_unavailable"
                attempts = (src or {}).get("access_attempts", [])
                reason = attempts[-1]["outcome"] if attempts else "not attempted"
                basis = f"{a.depends_on_source} {src_status or 'unknown'} ({reason})"
        rec["status"] = status
        rec["basis"] = basis
        out.append(rec)
    return out


def availability_report(lock: dict | None, var_dir: Path) -> dict:
    items = classify(ARTIFACTS, lock, var_dir)
    counts: dict[str, int] = {}
    for i in items:
        counts[i["status"]] = counts.get(i["status"], 0) + 1
    return {"generated_at": utcnow_iso(), "lock_generated_at": (lock or {}).get("generated_at"), "counts": counts, "artifacts": items}
