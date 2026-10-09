"""Adapters for the AgentHorizon trajectory standard (STANDARD.md, S4) and its released projections.

Three raw shapes are accepted, each detected explicitly and recorded on the normalized record:

* ``standard-full``: a JSONL row of the standard (``version``, ``trajectory_id``, ``source``, ``task``,
  ``environment``, ``steps``, ``milestones``). STANDARD.md documents ``version`` as always "1.0" while the
  released converter writes "1.1"; both are accepted and the observed value is kept.
* ``render-json``: the blind projection written by ``scripts/render_trajectories.py:render_json``
  (``trajectory_id``, ``task``, ``environment``, ``steps``) — the released ``sandbox/data/jsons`` form.
* label rows (separate file): ``trajectory_id``, ``label`` plus optional scorer-only fields.

Unknown top-level, task, step, and action fields are preserved verbatim under ``unknown_fields`` so the
normalized form round-trips back to the raw record.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any

ADAPTER_VERSION = "ah-standard-adapter/1"

KNOWN_ACTION_TYPES = {
    "click": {"x", "y", "button", "num_clicks"},
    "type": {"text"},
    "press": {"keys"},
    "hotkey": {"keys"},
    "scroll": {"x", "y", "direction", "amount"},
    "drag": {"start_x", "start_y", "end_x", "end_y"},
    "move": {"x", "y"},
    "key_down": {"key"},
    "key_up": {"key"},
    "wait": {"duration_s"},
    "native": {"code"},  # supplemental sources (browser/OS actions kept verbatim); never in AgentHorizon data
}
REQUIRED_ACTION_PARAMS = {
    "click": {"x", "y", "button"},
    "type": {"text"},
    "press": {"keys"},
    "hotkey": {"keys"},
    "scroll": {"x", "y", "direction", "amount"},
    "drag": {"start_x", "start_y", "end_x", "end_y"},
    "move": {"x", "y"},
    "key_down": {"key"},
    "key_up": {"key"},
    "wait": {"duration_s"},
    "native": {"code"},
}

TOP_LEVEL_FULL = {"version", "trajectory_id", "source", "task", "environment", "steps", "milestones"}
TOP_LEVEL_RENDER = {"trajectory_id", "task", "environment", "steps"}
TASK_FIELDS = {"instruction", "persona", "category", "subcategory", "task_type", "applications"}
STEP_FIELDS = {"step_id", "screenshot", "action", "thought", "action_description", "timestamp_us"}
# Fields that must never reach a judge: they encode pairing or ground truth (STANDARD.md "intentionally omitted").
LEAKY_TRAJECTORY_FIELDS = {"label", "metadata", "instruction_original", "original_id", "milestones", "original_file"}

LABEL_FIELDS = {
    "trajectory_id", "label", "original_id", "trajectory_scenario", "trajectory_type", "paired_id",
    "negative_source", "mistake_type",
}


class SchemaError(ValueError):
    def __init__(self, code: str, message: str, *, path: str | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.path = path


@dataclass
class RawStep:
    index: int
    step_id: Any
    screenshot: str | None
    action_type: str
    action_params: dict
    action_raw: dict
    thought: str | None
    action_description: str | None
    timestamp_us: Any
    unknown_fields: dict = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)


@dataclass
class RawTrajectory:
    shape: str  # standard-full | render-json
    trajectory_id: str
    version: str | None
    instruction: str
    task: dict
    environment: dict | None
    steps: list[RawStep]
    source: dict | None
    milestones: list | None
    unknown_fields: dict
    raw: dict
    issues: list[str] = field(default_factory=list)


def detect_shape(obj: dict) -> str:
    keys = set(obj)
    if "version" in keys or "source" in keys or "milestones" in keys:
        return "standard-full"
    if TOP_LEVEL_RENDER & keys == TOP_LEVEL_RENDER - {"environment"} or TOP_LEVEL_RENDER <= keys:
        return "render-json"
    if {"task", "steps"} <= keys:
        return "render-json"
    raise SchemaError("unknown_shape", f"cannot recognise trajectory record with keys {sorted(keys)}")


def parse_step(i: int, s: Any) -> RawStep:
    if not isinstance(s, dict):
        raise SchemaError("step_not_object", f"step #{i} is {type(s).__name__}")
    issues: list[str] = []
    action = s.get("action")
    if not isinstance(action, dict):
        issues.append("action_missing")
        action = {}
    a_type = action.get("type")
    params = action.get("parameters") if isinstance(action.get("parameters"), dict) else {}
    if not isinstance(a_type, str):
        issues.append("action_type_missing")
        a_type = "unknown"
    elif a_type not in KNOWN_ACTION_TYPES:
        issues.append(f"action_type_unrecognised:{a_type}")
    else:
        missing = REQUIRED_ACTION_PARAMS[a_type] - set(params)
        if missing:
            issues.append(f"action_params_missing:{','.join(sorted(missing))}")
        extra = set(params) - KNOWN_ACTION_TYPES[a_type]
        if extra:
            issues.append(f"action_params_extra:{','.join(sorted(extra))}")
    if "step_id" not in s:
        issues.append("step_id_missing")
    return RawStep(
        index=i,
        step_id=s.get("step_id"),
        screenshot=s.get("screenshot"),
        action_type=a_type,
        action_params=copy.deepcopy(params),
        action_raw=copy.deepcopy(action),
        thought=s.get("thought"),
        action_description=s.get("action_description"),
        timestamp_us=s.get("timestamp_us"),
        unknown_fields={k: v for k, v in s.items() if k not in STEP_FIELDS},
        issues=issues,
    )


def parse_trajectory(obj: Any) -> RawTrajectory:
    if not isinstance(obj, dict):
        raise SchemaError("record_not_object", f"expected object, got {type(obj).__name__}")
    shape = detect_shape(obj)
    tid = obj.get("trajectory_id")
    if not isinstance(tid, str) or not tid:
        raise SchemaError("trajectory_id_missing", "trajectory_id must be a non-empty string")
    task = obj.get("task")
    if not isinstance(task, dict):
        raise SchemaError("task_missing", f"{tid}: task must be an object")
    instruction = task.get("instruction")
    if not isinstance(instruction, str):
        raise SchemaError("instruction_missing", f"{tid}: task.instruction must be a string")
    steps_raw = obj.get("steps")
    if not isinstance(steps_raw, list):
        raise SchemaError("steps_missing", f"{tid}: steps must be a list")
    steps = [parse_step(i, s) for i, s in enumerate(steps_raw)]
    known = TOP_LEVEL_FULL if shape == "standard-full" else TOP_LEVEL_RENDER
    unknown = {k: v for k, v in obj.items() if k not in known}
    issues = []
    leaky = sorted(set(obj) & LEAKY_TRAJECTORY_FIELDS)
    if leaky:
        issues.append(f"label_correlated_fields_present:{','.join(leaky)}")
    src = obj.get("source")
    if isinstance(src, dict) and ("original_id" in src or "original_file" in src):
        issues.append("source_identifiers_present")
    if isinstance(task, dict) and "instruction_original" in task:
        issues.append("instruction_original_present")
    version = obj.get("version")
    if shape == "standard-full" and version not in ("1.0", "1.1"):
        issues.append(f"version_unrecognised:{version!r}")
    return RawTrajectory(
        shape=shape,
        trajectory_id=tid,
        version=version if isinstance(version, str) else None,
        instruction=instruction,
        task={k: copy.deepcopy(v) for k, v in task.items()},
        environment=copy.deepcopy(obj.get("environment")) if isinstance(obj.get("environment"), dict) else None,
        steps=steps,
        source=copy.deepcopy(src) if isinstance(src, dict) else None,
        milestones=copy.deepcopy(obj.get("milestones")) if isinstance(obj.get("milestones"), list) else None,
        unknown_fields=unknown,
        raw=obj,
        issues=issues,
    )


@dataclass
class RawLabel:
    trajectory_id: str
    label: str
    mistake_type_native: str | None
    original_id: str | None
    paired_id: str | None
    negative_source: str | None
    trajectory_scenario: str | None
    trajectory_type: str | None
    unknown_fields: dict
    raw: dict
    issues: list[str] = field(default_factory=list)


def parse_label(obj: Any) -> RawLabel:
    if not isinstance(obj, dict):
        raise SchemaError("label_not_object", f"expected object, got {type(obj).__name__}")
    tid = obj.get("trajectory_id")
    if not isinstance(tid, str) or not tid:
        raise SchemaError("label_trajectory_id_missing", "trajectory_id must be a non-empty string")
    label = obj.get("label")
    if label not in ("positive", "negative"):
        raise SchemaError("label_value_invalid", f"{tid}: label must be 'positive' or 'negative', got {label!r}")
    issues = []
    mt = obj.get("mistake_type")
    if mt is not None and not isinstance(mt, str):
        issues.append(f"mistake_type_not_string:{type(mt).__name__}")
        mt = str(mt)
    if label == "positive" and mt:
        issues.append("mistake_type_on_positive")
    return RawLabel(
        trajectory_id=tid,
        label=label,
        mistake_type_native=mt if mt else None,
        original_id=obj.get("original_id"),
        paired_id=obj.get("paired_id"),
        negative_source=obj.get("negative_source"),
        trajectory_scenario=obj.get("trajectory_scenario"),
        trajectory_type=obj.get("trajectory_type"),
        unknown_fields={k: v for k, v in obj.items() if k not in LABEL_FIELDS},
        raw=obj,
        issues=issues,
    )


def reconstruct_render_json(t: RawTrajectory) -> dict:
    """Inverse of parsing for the render-json shape (round-trip fidelity check)."""
    out: dict = {"trajectory_id": t.trajectory_id, "task": t.task}
    if t.environment is not None:
        out["environment"] = t.environment
    steps = []
    for s in t.steps:
        d = {}
        raw_step = t.raw["steps"][s.index]
        for k in raw_step:  # preserve key order of the source
            d[k] = raw_step[k]
        steps.append(d)
    out["steps"] = steps
    out.update(t.unknown_fields)
    return out
