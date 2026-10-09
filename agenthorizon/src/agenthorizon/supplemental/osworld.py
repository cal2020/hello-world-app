"""OSWorld adapter (S10: xlang-ai/OSWorld, Apache-2.0).

Task definitions (``evaluation_examples/examples/<domain>/<id>.json`` and ``examples_windows``) are imported as
``task_definition`` records: instruction, snapshot, related apps, setup config summary, evaluator function(s), and
split membership (``test_all.json`` / ``test_small.json`` / ``test_nogdrive.json`` / ``test_infeasible.json``). A task
definition is not a trajectory and carries no label.

Trace exports written by the harness (``lib_run_single.py``) are imported offline from
``<results>/<action_space>/<observation_type>/<model>/<domain>/<example_id>/`` (``traj.jsonl``, ``step_<n>_<ts>.png``,
``result.txt``): each screenshot is captured AFTER its step's action executes (``post_action``), and the initial
observation is not saved. The evaluator score in ``result.txt`` is a machine-generated execution check: it is kept
natively, mapped to a binary label only when it is exactly 0 or 1, and flagged as machine-generated so it is never
used for official reproduction. No trace collection is linked from the pinned repository; generating traces needs
the OSWorld virtual-machine environment (an optional, explicitly configured workflow outside this importer).
"""

from __future__ import annotations

import json
from pathlib import Path

from agenthorizon.supplemental.records import SupLabel, SupRecord, SupStep
from agenthorizon.util.hashing import sha256_file

SOURCE_ID = "osworld"
REPO_URL = "https://github.com/xlang-ai/OSWorld"
SPLIT_FILES = ("test_all.json", "test_small.json", "test_nogdrive.json", "test_infeasible.json")


def _evaluator_funcs(ev: dict | None) -> list[str]:
    if not isinstance(ev, dict):
        return []
    f = ev.get("func")
    return [x for x in (f if isinstance(f, list) else [f]) if isinstance(x, str)]


def load_task_definitions(checkout: Path, revision: str) -> tuple[list[SupRecord], dict]:
    ex_root = checkout / "evaluation_examples"
    # Split files list Ubuntu tasks by domain. Windows task files reuse some Ubuntu ids, so membership is keyed by
    # (domain, id) and applies to the Ubuntu set only.
    membership: dict[tuple[str, str], set[str]] = {}
    for fname in SPLIT_FILES:
        p = ex_root / fname
        if p.is_file():
            for domain, ids in json.loads(p.read_text()).items():
                for i in ids:
                    membership.setdefault((domain, i), set()).add(fname.removesuffix(".json"))
    records = []
    for platform, sub in (("ubuntu", "examples"), ("windows", "examples_windows")):
        for p in sorted((ex_root / sub).glob("*/*.json")):
            d = json.loads(p.read_text())
            tid = d.get("id") or p.stem
            funcs = _evaluator_funcs(d.get("evaluator"))
            rel = str(p.relative_to(checkout))
            records.append(SupRecord(
                record_id=f"osworld-task:{platform}/{p.parent.name}/{tid}", source_id=SOURCE_ID, kind="task_definition",
                native_ids={"id": tid, "domain": p.parent.name, "platform": platform, "snapshot": d.get("snapshot")},
                native_schema=f"osworld-task-json@{revision[:8]}", instruction=d.get("instruction"), steps=None, labels=[],
                split=(",".join(sorted(membership.get((p.parent.name, tid), set()))) or None) if platform == "ubuntu" else None,
                groups={"task": f"osworld:{tid}"},
                coverage={"instruction": isinstance(d.get("instruction"), str), "actions": False, "screenshots": False,
                          "evaluator_spec": bool(funcs), "setup_config": bool(d.get("config"))},
                missing=["trajectory (task definitions are not trajectories)", "label"]
                + ([] if platform == "ubuntu" else ["split membership (no split file covers examples_windows)"]),
                provenance={"upstream": REPO_URL, "revision": revision, "license": "Apache-2.0", "path": rel,
                            "sha256": sha256_file(p)},
                flags=(["infeasible_task"] if "infeasible" in funcs else []),
                dedup={"related_apps": d.get("related_apps"), "evaluator_funcs": funcs, "source_url": d.get("source"),
                       "config_steps": [c.get("type") for c in d.get("config") or [] if isinstance(c, dict)]}))
    summary = {"task_definitions": len(records),
               "by_platform": {k: sum(1 for r in records if r.native_ids["platform"] == k) for k in ("ubuntu", "windows")},
               "split_files": {f: sum(1 for r in records if r.split and f.removesuffix('.json') in r.split.split(","))
                               for f in SPLIT_FILES},
               "infeasible": sum(1 for r in records if "infeasible_task" in r.flags)}
    return records, summary


def import_trace_exports(results_root: Path, tasks: dict[str, SupRecord], *, run_label: str) -> tuple[list[SupRecord], dict]:
    """Offline import of harness trace exports. ``tasks`` maps OSWorld task id -> task_definition record."""
    out, skipped = [], []
    for traj in sorted(Path(results_root).glob("*/*/*/*/*/traj.jsonl")):
        d = traj.parent
        action_space, obs_type, model, domain, example_id = d.relative_to(results_root).parts
        task = tasks.get(example_id)
        steps, bad = [], 0
        for n, line in enumerate(traj.read_text(encoding="utf-8").splitlines()):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            shot = row.get("screenshot_file")
            shot_path = d / shot if isinstance(shot, str) else None
            steps.append(SupStep(index=len(steps), action_native=row.get("action"), action_text=str(row.get("action")),
                                 observation={"screenshot_ref": str(shot_path.relative_to(results_root)) if shot_path and shot_path.is_file() else None,
                                              "timing": "post_action",
                                              "sha256": sha256_file(shot_path) if shot_path and shot_path.is_file() else None},
                                 thought=row.get("response") if isinstance(row.get("response"), str) else None,
                                 extra={"step_num": row.get("step_num"), "action_timestamp": row.get("action_timestamp"),
                                        "reward": row.get("reward"), "done": row.get("done"), "line": n + 1}))
        res = d / "result.txt"
        score = None
        if res.is_file():
            try:
                score = float(res.read_text().strip())
            except ValueError:
                score = None
        labels = []
        if score is not None:
            funcs = (task.dedup.get("evaluator_funcs") if task else None) or []
            labels.append(SupLabel("evaluator_score", score, "machine_evaluator", annotator="osworld-evaluator:" + ",".join(funcs),
                                   binary=True if score == 1.0 else False if score == 0.0 else None, compatible_binary=False,
                                   rule="execution-based evaluator score; binary only when exactly 0 or 1; machine-generated, "
                                        "excluded from official reproduction"))
        if task is None:
            skipped.append(example_id)
        missing = ([] if task else ["task definition (instruction)"]) + ([] if res.is_file() else ["result.txt"]) + \
                  ["initial observation (not saved by the harness)"]
        out.append(SupRecord(
            record_id=f"osworld-trace:{run_label}/{model}/{domain}/{example_id}", source_id=SOURCE_ID, kind="trajectory",
            native_ids={"id": example_id, "domain": domain, "model": model, "action_space": action_space,
                        "observation_type": obs_type, "run_label": run_label},
            native_schema="osworld-lib_run_single-traj.jsonl", instruction=task.instruction if task else None, steps=steps,
            labels=labels, split=task.split if task else None,
            groups={"task": f"osworld:{example_id}", "run": f"{run_label}:{model}"},
            coverage={"instruction": task is not None, "actions": bool(steps),
                      "screenshots": bool(steps) and all(s.observation["screenshot_ref"] for s in steps),
                      "evaluator_score": score is not None, "video": (d / "recording.mp4").is_file()},
            missing=missing, provenance={"upstream": "operator-supplied OSWorld trace export", "path": str(d.relative_to(results_root)),
                                         "traj_sha256": sha256_file(traj), "malformed_lines": bad,
                                         "task_definition": task.provenance if task else None},
            flags=["machine_generated_label", "post_action_observations"] + (["malformed_lines"] if bad else [])))
    return out, {"traces": len(out), "without_task_definition": skipped}
