"""Write supplemental trajectories in the release layout so they ingest as a SEPARATE dataset version.

The exported dataset is judged and scored by the same core, but never with AgentHorizon denominators: its manifests
come from its own label files (one per native split) and are never official. Only labels that are compatible binary
success labels from experts become label rows; machine-generated labels are exported to a clearly named separate
file only when requested, and failure categories are always absent (``mistake_type`` null — the source did not
annotate AgentHorizon categories). Actions keep their native form (``type: "native"``), screenshots keep their bytes,
and the declared observation timing travels in ``environment.observation_timing``.
"""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path

from agenthorizon.data.markdown import render_markdown
from agenthorizon.supplemental.records import SupRecord
from agenthorizon.util.io import atomic_write_text

NAMESPACE = uuid.UUID("6f3c1c8e-2f8e-4c47-9a63-7b1d2f0a9e51")


def trajectory_id(record_id: str) -> str:
    """Opaque, stable id: the native identifiers stay in provenance, not in judge-visible paths."""
    return str(uuid.uuid5(NAMESPACE, record_id))


def export_standard(records: list[SupRecord], media_root: Path | None, out: Path, *, benchmark: str,
                    include_machine_labels: bool = False) -> dict:
    sb = out / "sandbox" / "data"
    for sub in ("jsons", "markdowns", "media/images"):
        (sb / sub).mkdir(parents=True, exist_ok=True)
    label_rows: dict[str, list[dict]] = {}
    exported, skipped = 0, []
    for r in records:
        if r.kind != "trajectory" or not r.steps or not r.instruction:
            skipped.append({"record_id": r.record_id, "reason": f"{r.kind} without instruction/steps"})
            continue
        tid = trajectory_id(r.record_id)
        media_dir = f"{tid[:8]}"
        steps = []
        for s in r.steps:
            shot = None
            ref = s.observation.get("screenshot_ref")
            if ref and media_root is not None and (Path(media_root) / ref).is_file():
                dst = sb / "media" / "images" / media_dir / f"step_{s.index + 1}.png"
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(Path(media_root) / ref, dst)
                shot = f"./data/media/images/{media_dir}/step_{s.index + 1}.png"
            steps.append({"step_id": s.index, "screenshot": shot,
                          "action": {"type": "native", "parameters": {"code": s.action_text}},
                          **({"thought": s.thought} if s.thought else {})})
        timing = {s.observation.get("timing") for s in r.steps} - {None}
        traj = {"trajectory_id": tid,
                "task": {"instruction": r.instruction, "category": r.native_ids.get("benchmark") or r.native_ids.get("domain")},
                "environment": {"os": r.native_ids.get("platform"), "screen_resolution": None,
                                "observation_timing": timing.pop() if len(timing) == 1 else "pre_action",
                                "source": r.source_id},
                "steps": steps}
        (sb / "jsons" / f"{tid}.json").write_text(json.dumps(traj, indent=1))
        atomic_write_text(sb / "markdowns" / f"{tid}.md", render_markdown(traj))
        exported += 1
        for lab in r.labels:
            usable = lab.binary is not None and (lab.compatible_binary or (include_machine_labels and lab.kind == "machine_evaluator"))
            if not usable or (lab.role not in (None, "primary")):
                continue
            fname = f"{benchmark}-{r.split or 'nosplit'}{'-machine-evaluator' if lab.kind == 'machine_evaluator' else ''}.jsonl"
            label_rows.setdefault(fname, []).append({"trajectory_id": tid, "label": "positive" if lab.binary else "negative",
                                                     "mistake_type": None, "original_id": r.record_id,
                                                     "label_source": lab.kind})
    for fname, rows in label_rows.items():
        (out / fname).write_text("".join(json.dumps(x, sort_keys=True) + "\n" for x in rows))
    (out / "SUPPLEMENTAL_SOURCE.json").write_text(json.dumps({
        "benchmark": benchmark, "exported": exported, "label_files": sorted(label_rows),
        "note": "Separate supplemental dataset: never part of AgentHorizon denominators; categories unavailable."}, indent=1))
    return {"exported": exported, "skipped": len(skipped), "skipped_examples": skipped[:20],
            "label_files": {k: len(v) for k, v in label_rows.items()}}
