"""Dataset-version validation and reconciliation.

Reports contain aggregate counts and example ids only (no per-item labels), so they can be shown on the data
coverage screen. Checks that cannot be evaluated (e.g. media not materialized) say so explicitly.
"""

from __future__ import annotations

import json
import uuid
from collections import Counter, defaultdict
from pathlib import Path

from agenthorizon.data.normalize import length_bin
from agenthorizon.data.standard import KNOWN_ACTION_TYPES
from agenthorizon.reference.analysis import REVISED_CHECK_TABLE
from agenthorizon.util.io import atomic_write_json, read_jsonl, utcnow_iso

RELEASE_TARGETS = {"examples": 1373, "positive": 523, "negative": 850, "typed_negative": 844, "untyped_negative": 6}
LEGACY_TARGETS = {  # inferred in REFERENCE_DATA.json → analysis_legacy_composition (verification targets)
    "legacy-AH": {"n": 605, "positive": 287, "negative": 318, "typed_negative": 313, "untyped_negative": 5},
    "legacy-AH-S": {"n": 768, "positive": 236, "negative": 532, "typed_negative": 531, "untyped_negative": 1},
}
CROISSANT_LABEL_DIGEST = "ec57ba3ef6687993c27129d140a8275eb642478c23d824717bd6bba6ff168e81"


class Checks:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, check_id: str, severity: str, ok: bool | None, detail: str, count: int | None = None,
            examples: list | None = None, data: dict | None = None) -> None:
        status = "not_evaluable" if ok is None else ("pass" if ok else ("fail" if severity == "error" else "warn"))
        self.items.append({"check": check_id, "severity": severity, "status": status, "detail": detail,
                           "count": count, "examples": (examples or [])[:10], "data": data or {}})

    def summary(self) -> dict:
        return {"error_count": sum(1 for c in self.items if c["status"] == "fail"),
                "warning_count": sum(1 for c in self.items if c["status"] == "warn"),
                "not_evaluable": sum(1 for c in self.items if c["status"] == "not_evaluable")}


def _is_uuid4(s: str) -> bool:
    try:
        return uuid.UUID(s).version == 4 and str(uuid.UUID(s)) == s.lower()
    except ValueError:
        return False


def validate_version(root: Path, private_root: Path, ctx: dict) -> dict:
    c = Checks()
    examples = [e.to_dict() if hasattr(e, "to_dict") else e for e in ctx["examples"]]
    by_id = {e["example_id"]: e for e in examples}
    gold: dict = ctx.get("gold", {})
    raw = root / "raw"
    md_ids = {p.stem for p in (raw / "sandbox" / "data" / "markdowns").glob("*.md")}
    js_ids = {p.stem for p in (raw / "sandbox" / "data" / "jsons").glob("*.json")}
    quarantined = sorted(p.stem for p in (root / "quarantine").glob("*.json")) if (root / "quarantine").is_dir() else []

    # membership & uniqueness
    c.add("markdown_json_pairing", "error", md_ids == js_ids,
          f"{len(md_ids)} Markdown vs {len(js_ids)} JSON trajectory files", len(md_ids ^ js_ids), sorted(md_ids ^ js_ids))
    non_uuid = sorted(i for i in by_id if not _is_uuid4(i))
    c.add("opaque_uuid4_ids", "warning", not non_uuid, "trajectory ids should be opaque UUID v4", len(non_uuid), non_uuid)
    c.add("quarantine", "error", not quarantined, "records failing schema/JSON validation (kept in quarantine/)",
          len(quarantined), quarantined)

    # label join coverage
    labeled = set(gold)
    orphan_labels = sorted(labeled - set(by_id) - set(quarantined))
    orphan_traj = sorted(set(by_id) - labeled)
    c.add("label_join_coverage", "error", not orphan_traj and bool(by_id),
          f"{len(set(by_id) & labeled)}/{len(by_id)} examples have gold labels", len(orphan_traj), orphan_traj)
    c.add("orphan_labels", "error", not orphan_labels, "label rows without a trajectory", len(orphan_labels), orphan_labels)
    conflicts = ctx.get("label_conflicts", [])
    c.add("label_file_conflicts", "error", not conflicts, "examples listed in more than one label file", len(conflicts),
          [x["example_id"] for x in conflicts])
    per_file = {f: {"rows": len(ids), "joined": len(set(ids) & set(by_id))} for f, ids in ctx.get("membership", {}).items()}

    # schema issues carried from parsing
    issue_counts: Counter = Counter()
    issue_examples: dict[str, list] = defaultdict(list)
    for e in examples:
        for i in e["issues"]:
            key = i.split(":")[0]
            issue_counts[key] += 1
            issue_examples[key].append(e["example_id"])
    leaky = {k: v for k, v in issue_counts.items() if k in ("label_correlated_fields_present", "source_identifiers_present",
                                                            "instruction_original_present")}
    c.add("judge_view_label_correlated_fields", "error", not leaky,
          "judge-visible JSON must not carry label/pairing fields (milestones, metadata, source ids)", sum(leaky.values()),
          [x for k in leaky for x in issue_examples[k]], {"by_field": leaky})
    versions = Counter(e["schema_version_observed"] for e in examples)
    shapes = Counter(e["schema_shape"] for e in examples)
    c.add("schema_version_observed", "info", True, "record version field as released", data={"versions": dict(versions),
                                                                                           "shapes": dict(shapes)})

    # steps
    step_problems: Counter = Counter()
    step_problem_examples: dict[str, list] = defaultdict(list)
    action_types: Counter = Counter()
    unknown_actions: Counter = Counter()
    ts_nonmono = 0
    for rid, steps in ctx["steps_by_rec"].items():
        ids = [s.step_id for s in steps]
        if ids != list(range(len(steps))):
            step_problems["step_ids_not_0_to_n-1"] += 1
            step_problem_examples["step_ids_not_0_to_n-1"].append(rid)
        if len(set(map(repr, ids))) != len(ids):
            step_problems["duplicate_step_ids"] += 1
            step_problem_examples["duplicate_step_ids"].append(rid)
        ts = [s.timestamp_us for s in steps if s.timestamp_us is not None]
        if any(b < a for a, b in zip(ts, ts[1:], strict=False)):
            ts_nonmono += 1
        if len(ts) != len(steps):
            step_problems["timestamps_missing"] += 1
        for s in steps:
            action_types[s.action_type] += 1
            if s.action_type not in KNOWN_ACTION_TYPES:
                unknown_actions[s.action_type] += 1
            for i in s.issues:
                if i.startswith("action_params"):
                    step_problems[i.split(":")[0]] += 1
    c.add("step_order_and_ids", "error", not step_problems.get("step_ids_not_0_to_n-1") and not step_problems.get("duplicate_step_ids"),
          "native step_id must be 0..n-1 in released order without duplicates",
          step_problems.get("step_ids_not_0_to_n-1", 0) + step_problems.get("duplicate_step_ids", 0),
          step_problem_examples["step_ids_not_0_to_n-1"] + step_problem_examples["duplicate_step_ids"])
    c.add("timestamps_monotonic_us", "warning", ts_nonmono == 0, "timestamp_us (microseconds from start) non-decreasing",
          ts_nonmono)
    c.add("action_types", "warning", not unknown_actions, "unrecognised action types are preserved verbatim",
          sum(unknown_actions.values()), data={"counts": dict(action_types), "unrecognised": dict(unknown_actions),
                                               "param_issues": {k: v for k, v in step_problems.items() if k.startswith("action")}})

    # media
    assets = {r["asset_key"]: r for _, r in read_jsonl(root / "normalized" / "assets.jsonl")}
    missing_release = sorted(k for k, r in assets.items() if r["status"] == "missing_from_release")
    corrupt = sorted(k for k, r in assets.items() if r["status"] == "corrupt")
    materialized = [r for r in assets.values() if r["status"] == "materialized"]
    unsafe_refs = 0
    for steps in ctx["steps_by_rec"].values():
        for s in steps:
            if s.screenshot_ref and s.asset_key is None:
                unsafe_refs += 1
    c.add("screenshot_links_resolvable", "error", not missing_release and unsafe_refs == 0,
          "every screenshot reference is a safe working-directory-relative path present in the release listing",
          len(missing_release) + unsafe_refs, missing_release)
    c.add("images_readable", "error", None if not materialized else not corrupt,
          f"{len(materialized)} materialized images decoded" if materialized else "no media materialized; not evaluable",
          len(corrupt), corrupt)
    hash_bad = []
    for r in materialized:
        exp = r.get("expected_digest")
        if exp and exp[0] == "sha256" and exp[1] != r["sha256"]:
            hash_bad.append(r["asset_key"])
    c.add("media_hash_integrity", "error", None if not materialized else not hash_bad,
          "materialized bytes match the release listing digests", len(hash_bad), hash_bad)
    dims = Counter((r.get("width"), r.get("height")) for r in materialized)
    c.add("image_dimensions", "info", True, "dimension distribution of materialized screenshots",
          data={"top": [{"w": w, "h": h, "n": n} for (w, h), n in dims.most_common(10)]})

    # instruction fidelity / Markdown round trip
    mdc = [e["source_files"].get("markdown_check") for e in examples if e["source_files"].get("markdown_check")]
    not_ident = [e["example_id"] for e in examples if (e["source_files"].get("markdown_check") or {}).get("regenerated_byte_identical") is False]
    goal_bad = [e["example_id"] for e in examples if (e["source_files"].get("markdown_check") or {}).get("goal_matches_instruction") is False]
    c.add("markdown_regenerates_byte_identical", "warning", not not_ident,
          f"re-rendering the JSON with the authors' renderer reproduces the released Markdown ({len(mdc) - len(not_ident)}/{len(mdc)})",
          len(not_ident), not_ident)
    c.add("instruction_text_fidelity", "error", not goal_bad, "Markdown goal equals JSON instruction (stripped)",
          len(goal_bad), goal_bad)

    # recording / instruction reuse
    rec_use = Counter(e["recording_id"] for e in examples)
    ins_use = Counter(e["instruction_id"] for e in examples)
    over = [r for r, n in rec_use.items() if n > 2]
    same_label_shared = []
    if gold:
        by_rec = defaultdict(list)
        for e in examples:
            by_rec[e["recording_id"]].append(e["example_id"])
        for rid, ids in by_rec.items():
            labs = [gold[i]["label"] for i in ids if i in gold]
            if labs.count("positive") > 1:
                same_label_shared.append(rid)
    c.add("recording_reuse_pattern", "warning", not over and not same_label_shared,
          "a recording is expected to serve at most one positive and its swapped negative(s)",
          len(over) + len(same_label_shared), over + same_label_shared,
          {"examples_per_recording": dict(sorted(Counter(rec_use.values()).items())),
           "examples_per_instruction_text": dict(sorted(Counter(ins_use.values()).items()))})

    # leakage: private identifiers in judge-visible files
    leaks_paired, leaks_other_ids, orig_in_paths = [], [], 0
    all_ids = set(by_id)
    for e in examples:
        g = gold.get(e["example_id"])
        texts = []
        for k in ("markdown", "json"):
            rel = e["source_files"].get(k)
            if rel:
                texts.append((raw / rel["path"]).read_text(encoding="utf-8", errors="replace"))
        blob = "\n".join(texts)
        if g and g.get("paired_id") and g["paired_id"] in blob:
            leaks_paired.append(e["example_id"])
        if g and g.get("original_id") and g["original_id"] in blob:
            orig_in_paths += 1
        others = [x for x in all_ids if x != e["example_id"] and x in blob]
        if others:
            leaks_other_ids.append(e["example_id"])
    c.add("leakage_paired_id_in_judge_inputs", "error", None if not gold else not leaks_paired,
          "the paired (instruction-source) deliverable id must not appear in judge-visible files", len(leaks_paired), leaks_paired)
    c.add("leakage_other_example_ids_in_judge_inputs", "error", not leaks_other_ids,
          "judge-visible files must not reference other examples", len(leaks_other_ids), leaks_other_ids)
    c.add("recording_owner_id_in_media_paths", "info", True,
          "count of examples whose judge-visible media paths contain the recording owner's deliverable id. "
          "Expected under the released layout; both examples sharing a recording carry the same id, so it does not "
          "reveal the label in single-task isolation. Use opaque-paths staging to remove it.",
          orig_in_paths)

    # counts
    counts = {
        "examples": len(examples),
        "by_label": dict(Counter(gold[i]["label"] for i in by_id if i in gold)),
        "by_failure_category_status": dict(Counter((gold[i].get("category") or f"({gold[i]['category_status']})")
                                                   for i in by_id if i in gold and gold[i]["label"] == "negative")),
        "by_os": dict(Counter(str(e["environment"].get("os")) for e in examples)),
        "by_domain": dict(Counter(str(e["task_meta"].get("task_type")) for e in examples)),
        "by_length_bin": dict(Counter(length_bin(e["n_steps"]) for e in examples)),
        "applications_top": Counter(a for e in examples for a in (e["task_meta"].get("applications") or [])).most_common(25),
        "distinct_application_sets": len({tuple(sorted(e["task_meta"].get("applications") or [])) for e in examples}),
        "steps": {"total": sum(e["n_steps"] for e in examples),
                  "max": max((e["n_steps"] for e in examples), default=0),
                  "mean": round(sum(e["n_steps"] for e in examples) / len(examples), 2) if examples else None,
                  "over_300": sum(1 for e in examples if e["n_steps"] > 300)},
        "label_files": per_file,
    }
    report = {"generated_at": utcnow_iso(), "checks": c.items, "counts": counts, **c.summary()}
    atomic_write_json(root / "reports" / "validation.json", report)
    return {**c.summary(), "checks": len(c.items)}


def reconcile(root: Path, private_root: Path, ctx: dict) -> dict:
    gold: dict = ctx.get("gold", {})
    examples = {e.example_id for e in ctx["examples"]}
    results = []

    def comp(ids) -> dict:
        labs = [gold[i] for i in ids if i in gold]
        pos = sum(1 for g in labs if g["label"] == "positive")
        neg = [g for g in labs if g["label"] == "negative"]
        typed = sum(1 for g in neg if g.get("category"))
        return {"n": len(list(ids)), "positive": pos, "negative": len(neg), "typed_negative": typed,
                "untyped_negative": len(neg) - typed}

    if ctx.get("synthetic"):
        results.append({"check": "release_totals", "status": "not_applicable", "detail": "synthetic fixture"})
    else:
        got = comp(examples)
        tgt = RELEASE_TARGETS
        results.append({"check": "release_totals", "status": "pass" if (got["n"], got["positive"], got["negative"],
                        got["typed_negative"], got["untyped_negative"]) == (tgt["examples"], tgt["positive"], tgt["negative"],
                        tgt["typed_negative"], tgt["untyped_negative"]) else "fail",
                        "observed": got, "target": tgt, "target_source": "S6 docs/benchmark-construction.md + MP check table"})
        for fname, mid in (("AgentHorizon.jsonl", "legacy-AH"), ("AgentHorizon-Simple.jsonl", "legacy-AH-S")):
            ids = ctx.get("membership", {}).get(fname)
            if ids is None:
                results.append({"check": f"{mid}_composition", "status": "not_applicable", "detail": f"{fname} not in release"})
                continue
            got = comp(ids)
            tgt = LEGACY_TARGETS[mid]
            results.append({"check": f"{mid}_composition", "status": "pass" if got == tgt else "fail", "observed": got,
                            "target": tgt, "target_source": "REFERENCE_DATA.json analysis_legacy_composition (inferred)"})
    results.append({"check": "revised_partition_counts", "status": "not_applicable",
                    "detail": "revised AH-D/AH/AH-S manifests not located; check table recorded in REFERENCE_DATA.json",
                    "target": REVISED_CHECK_TABLE["rows"]})
    label_files = json.loads((private_root / "label_files.json").read_text()) if (private_root / "label_files.json").is_file() else []
    match = [lf["name"] for lf in label_files if lf["sha256"] == CROISSANT_LABEL_DIGEST]
    results.append({"check": "croissant_declared_label_digest", "status": "pass" if match else "not_applicable",
                    "detail": "a released label file matches the Dataverse agenthorizon_labels_anon.jsonl digest" if match
                    else "no released label file has the Croissant-declared digest (different file set)"})
    out = {"generated_at": utcnow_iso(), "checks": results,
           "failures": sum(1 for r in results if r["status"] == "fail")}
    atomic_write_json(root / "reports" / "reconciliation.json", out)
    return {"failures": out["failures"], "checks": len(results)}
