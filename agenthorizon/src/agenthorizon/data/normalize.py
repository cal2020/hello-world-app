"""Normalization of released trajectories into examples, recordings, and steps.

* ``EvaluationExample`` = one judging item (instruction + recording), keyed by the released opaque
  ``trajectory_id``. It carries only permitted (non-label) fields.
* ``Recording`` = the ordered steps + screenshots. Swapped negatives intentionally reuse the recording of
  a positive; identical step sequences collapse to one recording, so shared media is stored once.
* Steps keep the native ``step_id`` (0-based in the standard), the released display label
  (``Step {step_id}``), and the screenshot reference. Screenshots are *pre-action observations* (S4): the
  image in step k shows the screen before action k executes; post-action evidence for action k is the
  screenshot of step k+1 when it exists.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from agenthorizon.data.layout import asset_key_for_ref
from agenthorizon.data.markdown import format_action
from agenthorizon.data.standard import ADAPTER_VERSION, RawTrajectory
from agenthorizon.util.hashing import digest_json, sha256_text

NORMALIZER_VERSION = "ah-normalize/1"
OBSERVATION_TIMING = "pre_action"


def instruction_id(text: str) -> str:
    return "ins-" + sha256_text(text)[:16]


def _int_or_none(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


@dataclass
class NormStep:
    index: int
    step_id: Any
    display_label: str
    action_type: str
    action: dict
    action_text: str  # exactly as the released Markdown renders it (typed text truncated at 80 chars)
    action_text_full: str
    screenshot_ref: str | None
    asset_key: str | None  # "<media_dir>/<file>" under the images root, when the reference is local
    observation_timing: str
    timestamp_us: int | None
    thought: str | None
    action_description: str | None
    unknown_fields: dict = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)


@dataclass
class NormRecording:
    recording_id: str
    media_dirs: list[str]
    steps_digest: str
    n_steps: int
    first_timestamp_us: int | None
    last_timestamp_us: int | None
    action_type_counts: dict[str, int]


@dataclass
class NormExample:
    example_id: str
    dataset_version_id: str
    instruction: str
    instruction_id: str
    recording_id: str
    environment: dict
    task_meta: dict
    n_steps: int
    duration_ms: float | None
    schema_shape: str
    schema_version_observed: str | None
    adapter_version: str
    normalizer_version: str
    source_files: dict
    unknown_fields: dict = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _full_action_text(action: dict) -> str:
    if action.get("type") == "type":
        return f'type "{action.get("parameters", {}).get("text", "")}"'
    return format_action(action)


def normalize_steps(t: RawTrajectory) -> list[NormStep]:
    steps: list[NormStep] = []
    for s in t.steps:
        ref = s.screenshot if isinstance(s.screenshot, str) and s.screenshot else None
        asset_key = asset_key_for_ref(ref)
        action = {"type": s.action_type, "parameters": s.action_params}
        steps.append(NormStep(
            index=s.index,
            step_id=s.step_id,
            display_label=f"Step {s.step_id if s.step_id is not None else '?'}",
            action_type=s.action_type,
            action=s.action_raw,
            action_text=format_action(action),
            action_text_full=_full_action_text(action),
            screenshot_ref=ref,
            asset_key=asset_key,
            observation_timing=OBSERVATION_TIMING,
            timestamp_us=_int_or_none(s.timestamp_us),
            thought=s.thought,
            action_description=s.action_description,
            unknown_fields=s.unknown_fields,
            issues=list(s.issues),
        ))
    return steps


def recording_for(steps: list[NormStep]) -> NormRecording:
    fingerprint = [
        {"step_id": s.step_id, "action": s.action, "screenshot": s.asset_key or s.screenshot_ref,
         "timestamp_us": s.timestamp_us}
        for s in steps
    ]
    digest = digest_json(fingerprint)
    media_dirs: list[str] = []
    for s in steps:
        if s.asset_key:
            d = s.asset_key.split("/", 1)[0]
            if d not in media_dirs:
                media_dirs.append(d)
    ts = [s.timestamp_us for s in steps if s.timestamp_us is not None]
    counts: dict[str, int] = {}
    for s in steps:
        counts[s.action_type] = counts.get(s.action_type, 0) + 1
    return NormRecording(
        recording_id="rec-" + digest[:16],
        media_dirs=media_dirs,
        steps_digest=digest,
        n_steps=len(steps),
        first_timestamp_us=ts[0] if ts else None,
        last_timestamp_us=ts[-1] if ts else None,
        action_type_counts=dict(sorted(counts.items())),
    )


def normalize_example(t: RawTrajectory, dataset_version_id: str, source_files: dict) -> tuple[NormExample, NormRecording, list[NormStep]]:
    steps = normalize_steps(t)
    rec = recording_for(steps)
    env = t.environment or {}
    task_meta = {k: t.task.get(k) for k in ("category", "subcategory", "task_type", "applications", "persona") if k in t.task}
    task_unknown = {k: v for k, v in t.task.items() if k not in {"instruction", "category", "subcategory", "task_type",
                                                                   "applications", "persona"}}
    duration = None
    if rec.first_timestamp_us is not None and rec.last_timestamp_us is not None:
        duration = (rec.last_timestamp_us - rec.first_timestamp_us) / 1000.0
    unknown = dict(t.unknown_fields)
    if task_unknown:
        unknown["task"] = task_unknown
    ex = NormExample(
        example_id=t.trajectory_id,
        dataset_version_id=dataset_version_id,
        instruction=t.instruction,
        instruction_id=instruction_id(t.instruction),
        recording_id=rec.recording_id,
        environment={"os": env.get("os"), "screen_resolution": env.get("screen_resolution")},
        task_meta=task_meta,
        n_steps=len(steps),
        duration_ms=duration,
        schema_shape=t.shape,
        schema_version_observed=t.version,
        adapter_version=ADAPTER_VERSION,
        normalizer_version=NORMALIZER_VERSION,
        source_files=source_files,
        unknown_fields=unknown,
        issues=list(t.issues),
    )
    return ex, rec, steps


def domain_of(ex: NormExample | dict) -> str | None:
    meta = ex.task_meta if isinstance(ex, NormExample) else ex.get("task_meta", {})
    v = meta.get("task_type")
    return v if isinstance(v, str) else None


def length_bin(n_steps: int) -> str:
    for hi, name in ((50, "1-50"), (100, "51-100"), (150, "101-150"), (200, "151-200"), (300, "201-300")):
        if n_steps <= hi:
            return name
    return "301+"
