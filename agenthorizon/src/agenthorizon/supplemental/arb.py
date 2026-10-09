"""AgentRewardBench adapter (S9: McGill-NLP/agent-reward-bench, annotations in the pinned repository).

What the pinned repository provides (imported here): expert annotations (``agent_reward_bench/data/annotations.csv``:
annotator, benchmark, task_id, model_name, exp_name, trajectory_success, trajectory_side_effect,
trajectory_optimality, trajectory_looping), the dev/test split per task (``data/splits.csv``), and per-benchmark task
metadata. The trajectories themselves (goals, actions, screenshots, accessibility trees) are distributed only through
the Hugging Face dataset; without it every record is ``annotation_only`` and the missing material is listed.

Label provenance follows the release's scorer (``scripts/score_judgments.py``): the first annotation seen for a
(benchmark, model, task) trajectory is the *primary* annotation, later ones *secondary*
(``judge/utils.py:infer_annotator_type``); ``Unsure`` is excluded (``is_unsure``); splits are looked up after
``normalize_task_id`` (removing ``.resized`` / ``.improved``). Only ``trajectory_success`` has an AgentHorizon-compatible
meaning (binary task success). ARB's side-effect / optimality / looping annotations use a different rubric and are
kept as native fields; AgentHorizon failure-category scores are therefore unavailable for this source.
"""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

from agenthorizon.supplemental.records import SupLabel, SupRecord, SupStep
from agenthorizon.util.hashing import sha256_file

SOURCE_ID = "agentrewardbench"
REPO_URL = "https://github.com/McGill-NLP/agent-reward-bench"
DATASET_URL = "https://huggingface.co/datasets/McGill-NLP/agent-reward-bench"
NATIVE_FIELDS = ("trajectory_success", "trajectory_side_effect", "trajectory_optimality", "trajectory_looping")
SUCCESS_MAP = {"Successful": True, "Unsuccessful": False}
TASK_META_FILES = ("webarena.csv", "visualwebarena.csv", "assistantbench.csv", "workarena.csv")


def normalize_task_id(task_id: str) -> str:
    for remove in (".resized", ".improved"):
        task_id = task_id.replace(remove, "")
    return task_id


def _read_csv(p: Path) -> list[dict]:
    with p.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_repo(checkout: Path, revision: str, license_status: str | None) -> tuple[list[SupRecord], dict]:
    data = checkout / "agent_reward_bench" / "data"
    ann_path = data / "annotations.csv"
    annotations = _read_csv(ann_path)
    splits = {r["task_id"]: r for r in _read_csv(data / "splits.csv")}
    task_meta: dict[str, dict] = {}
    for fname in TASK_META_FILES:
        p = data / fname
        if p.is_file():
            for row in _read_csv(p):
                key = row.get("task_name") or row.get("task_id")
                if key:
                    task_meta[key] = {"file": fname, **row}
    prov_base = {"upstream": REPO_URL, "revision": revision, "license": license_status or "unknown (no licence file)",
                 "path": "agent_reward_bench/data/annotations.csv", "sha256": sha256_file(ann_path)}
    seen: set[tuple[str, str, str]] = set()
    by_traj: dict[tuple[str, str, str], dict] = {}
    for line_no, a in enumerate(annotations, start=2):
        key = (a["benchmark"], a["model_name"], a["task_id"])
        role = "secondary" if key in seen else "primary"
        seen.add(key)
        rec = by_traj.setdefault(key, {"rows": [], "lines": []})
        rec["rows"].append((role, a))
        rec["lines"].append(line_no)
    records = []
    unmapped_split = 0
    for (bench, model, task_id), v in sorted(by_traj.items()):
        labels = []
        for role, a in v["rows"]:
            for fld in NATIVE_FIELDS:
                val = a.get(fld)
                is_success = fld == "trajectory_success"
                labels.append(SupLabel(fld, val, "expert_annotation", annotator=(a.get("annotator_name") or "").strip() or None,
                                       role=role, binary=SUCCESS_MAP.get(val) if is_success else None,
                                       compatible_binary=is_success and val in SUCCESS_MAP,
                                       rule="ARB primary/secondary by first occurrence; Unsure excluded" if is_success
                                       else "native ARB rubric field (not an AgentHorizon category)"))
        ntid = normalize_task_id(task_id)
        sp = splits.get(ntid)
        if sp is None:
            unmapped_split += 1
        meta = task_meta.get(ntid) or task_meta.get(ntid.split(".", 1)[-1]) or {}
        records.append(SupRecord(
            record_id=f"arb:{bench}/{model}/{task_id}", source_id=SOURCE_ID, kind="annotation_only",
            native_ids={"benchmark": bench, "model_name": model, "task_id": task_id, "exp_name": v["rows"][0][1].get("exp_name"),
                        "normalized_task_id": ntid, "split_benchmark": sp.get("benchmark") if sp else None},
            native_schema="arb-annotations-csv@" + revision[:8], instruction=None, steps=None, labels=labels,
            split=sp.get("split") if sp else None,
            groups={"task": f"{bench}:{ntid}", "trajectory": f"{bench}:{model}:{task_id}"},
            coverage={"instruction": False, "actions": False, "screenshots": False, "axtree": False,
                      "expert_success_label": any(lab.compatible_binary for lab in labels), "task_metadata": bool(meta)},
            missing=["goal text", "actions", "screenshots", "accessibility trees"] + ([] if meta else ["task metadata"]),
            provenance={**prov_base, "lines": v["lines"], "task_metadata": meta.get("file"),
                        "trajectory_location": f"{DATASET_URL} (cleaned/{bench}/{model}/…/{task_id}.json)"},
            flags=[]))
    alias = checkout / "apps" / "annotations.csv"
    aliases = []
    if alias.is_file():
        aliases.append({"path": "apps/annotations.csv", "sha256": sha256_file(alias),
                        "identical_to_primary_copy": sha256_file(alias) == prov_base["sha256"]})
    summary = {"annotation_rows": len(annotations), "trajectories": len(records),
               "multi_annotated": sum(1 for v in by_traj.values() if len(v["rows"]) > 1),
               "split_unmapped": unmapped_split, "alias_files": aliases,
               "benchmarks": dict(Counter(k[0] for k in by_traj)), "agents": dict(Counter(k[1] for k in by_traj))}
    return records, summary


def primary_binary_gold(records: list[dict | SupRecord]) -> dict[str, bool]:
    """ARB's evaluation gold: the primary annotation's success label, excluding Unsure."""
    out = {}
    for r in records:
        d = r.to_dict() if isinstance(r, SupRecord) else r
        for lab in d["labels"]:
            if lab["field"] == "trajectory_success" and lab["role"] == "primary" and lab["compatible_binary"]:
                out[d["record_id"]] = lab["binary"]
    return out


def annotation_agreement(records: list[dict | SupRecord]) -> dict:
    """Primary vs secondary exact agreement per native field over every released annotation pair.

    The release's own agreement figure is computed only over annotations that also have a judgment file for the
    chosen judge (score_judgments.py skips the rest), so its denominator can be smaller than this one."""
    pairs: dict[str, list[tuple[str, str]]] = {f: [] for f in NATIVE_FIELDS}
    same_annotator = 0
    n_pairs = 0
    for r in records:
        d = r.to_dict() if isinstance(r, SupRecord) else r
        prim = {lab["field"]: lab for lab in d["labels"] if lab["role"] == "primary"}
        secs = [lab for lab in d["labels"] if lab["role"] == "secondary"]
        if not secs:
            continue
        sec_by_field: dict[str, dict] = {}
        for lab in secs:
            sec_by_field[lab["field"]] = lab  # the last secondary wins, as in create_annotator_pairs
        if prim.get("trajectory_success", {}).get("annotator") == sec_by_field.get("trajectory_success", {}).get("annotator"):
            same_annotator += 1  # kept (the release does not drop these); reported for transparency
        n_pairs += 1
        for f in NATIVE_FIELDS:
            if f in prim and f in sec_by_field:
                pairs[f].append((str(prim[f]["value_native"]).strip(), str(sec_by_field[f]["value_native"]).strip()))
    out = {}
    for f, ps in pairs.items():
        valid = [(a, b) for a, b in ps if a != "Unsure" and b != "Unsure"]
        agree = sum(1 for a, b in valid if a == b)
        out[f] = {"pairs": len(valid), "agree": agree, "rate": (agree / len(valid)) if valid else None,
                  "excluded_unsure": len(ps) - len(valid)}
    return {"pairs": n_pairs, "pairs_with_same_annotator_name": same_annotator, "by_field": out,
            "note": "Exact-match agreement between the primary and the last secondary annotation of each trajectory "
                    "(create_annotator_pairs), over all released pairs; pairs with an 'Unsure' side are excluded. "
                    "These are AgentRewardBench's annotators, not reviews made in this workbench."}


def parse_cleaned_trajectory(obj: dict, rel_path: str) -> tuple[str, list[SupStep], dict]:
    """A cleaned ARB trajectory JSON (``Trajectory.to_dict`` + ``steps``) -> goal, steps, metadata.

    BrowserGym records each step's observation before the agent acts, so screenshots are ``pre_action``."""
    goal = obj.get("goal")
    if not isinstance(goal, str):
        raise ValueError(f"{rel_path}: goal missing")
    steps = []
    for i, s in enumerate(obj.get("steps") or []):
        action = s.get("action")
        steps.append(SupStep(index=i, action_native=action, action_text=str(action) if action is not None else "(no action)",
                             observation={"screenshot_ref": s.get("screenshot_path"), "timing": "pre_action",
                                          "url": s.get("url"), "has_axtree": bool(s.get("axtree"))},
                             thought=s.get("reasoning"),
                             extra={"last_action_error": s.get("last_action_error"), "num": s.get("num")}))
    meta = {k: obj.get(k) for k in ("benchmark", "agent", "model", "valid", "experiment", "seed")}
    return goal, steps, meta


def attach_trajectories(records: list[SupRecord], cleaned_root: Path) -> dict:
    """Upgrade annotation-only records with released trajectories found under ``cleaned/`` (when available)."""
    by_key = {(r.native_ids["benchmark"], r.native_ids["model_name"], r.native_ids["task_id"]): r for r in records}
    found = parsed = failed = 0
    for p in sorted(Path(cleaned_root).rglob("*.json")):
        rel = str(p.relative_to(cleaned_root))
        parts = Path(rel).parts
        if len(parts) < 3:
            continue
        bench, agent, task_id = parts[0], parts[1], p.stem
        rec = by_key.get((bench, agent, task_id))
        if rec is None:
            continue
        found += 1
        try:
            goal, steps, meta = parse_cleaned_trajectory(json.loads(p.read_text()), rel)
        except (ValueError, json.JSONDecodeError) as exc:
            failed += 1
            rec.flags.append(f"trajectory_parse_failed:{exc}"[:200])
            continue
        parsed += 1
        rec.kind, rec.instruction, rec.steps = "trajectory", goal, steps
        rec.native_schema += "+arb-cleaned-json"
        rec.coverage.update(instruction=True, actions=True, screenshots=all(s.observation["screenshot_ref"] for s in steps),
                            axtree=any(s.observation["has_axtree"] for s in steps))
        rec.missing = [m for m in rec.missing if m not in ("goal text", "actions", "screenshots", "accessibility trees")]
        rec.provenance["trajectory_file"] = {"path": rel, "sha256": sha256_file(p)}
        rec.provenance["trajectory_meta"] = meta
    return {"files_matched": found, "parsed": parsed, "failed": failed}
