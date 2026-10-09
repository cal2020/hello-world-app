"""Judge-visible Markdown: a byte-compatible re-implementation of the authors' renderer, plus a parser.

``render_markdown`` reproduces ``scripts/render_trajectories.py:render_markdown`` at 8584a347 exactly
(including the 80-character truncation of typed text and 0-based ``### Step N`` headings next to 1-based
``step_{N+1}.png`` links). Paper mode uses the *released* Markdown files as-is; this renderer exists to
verify round-trip fidelity and to render standard JSONL inputs the same way the authors did.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

RENDERER_ID = "ah-render-markdown@8584a347"
IMAGE_LINK = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<target>[^)\s]+)\)")


def format_action(action: dict) -> str:
    action_type = action.get("type", "unknown")
    params = action.get("parameters", {})

    if action_type == "click":
        button = params.get("button", "left")
        x, y = params.get("x", "?"), params.get("y", "?")
        n = params.get("num_clicks", 1)
        click_str = f"{'right' if button == 'right' else 'left'}-click"
        suffix = f" x{n}" if n and n > 1 else ""
        return f"{click_str} ({x}, {y}){suffix}"

    if action_type == "type":
        text = params.get("text", "")
        if len(text) > 80:
            text = text[:77] + "..."
        return f'type "{text}"'

    if action_type == "press":
        keys = params.get("keys", [])
        return f"press {' '.join(keys)}"

    if action_type == "hotkey":
        keys = params.get("keys", [])
        return f"hotkey {'+'.join(keys)}"

    if action_type == "scroll":
        direction = params.get("direction", "?")
        amount = params.get("amount", "?")
        x, y = params.get("x", "?"), params.get("y", "?")
        return f"scroll {direction} {amount}px at ({x}, {y})"

    if action_type == "drag":
        sx = params.get("start_x", "?")
        sy = params.get("start_y", "?")
        ex = params.get("end_x", "?")
        ey = params.get("end_y", "?")
        return f"drag ({sx}, {sy}) -> ({ex}, {ey})"

    if action_type in ("key_down", "key_up"):
        key = params.get("key", "?")
        return f"{action_type.replace('_', '')} {key}"

    return action_type


def render_markdown(
    trajectory: dict,
    *,
    include_images: bool = True,
    local_image_id: str | None = None,
    local_image_root: str = "./data/media/images",
) -> str:
    task = trajectory.get("task", {})
    steps = trajectory.get("steps", [])
    lines: list[str] = []

    lines.append("# Trajectory Report")
    lines.append("")

    instruction = task.get("instruction", "")
    lines.append("## Goal")
    lines.append("")
    lines.append(instruction.strip())
    lines.append("")

    lines.append("## Steps")
    lines.append("")
    lines.append(f"Total steps: **{len(steps)}**")
    lines.append("")

    for step in steps:
        step_id = step.get("step_id", "?")
        action = step.get("action", {})
        action_str = format_action(action)
        timestamp_us = step.get("timestamp_us")

        lines.append("---")
        lines.append("")
        lines.append(f"### Step {step_id}")
        lines.append("")

        if include_images:
            if local_image_id is not None:
                try:
                    file_index = int(step_id) + 1
                except (ValueError, TypeError):
                    file_index = step_id
                local_path = f"{local_image_root}/{local_image_id}/step_{file_index}.png"
                lines.append(f"![Step {step_id} screenshot]({local_path})")
                lines.append("")
            else:
                screenshot = step.get("screenshot")
                if screenshot:
                    lines.append(f"![Step {step_id} screenshot]({screenshot})")
                    lines.append("")

        lines.append(f"**Action:** `{action_str}`")
        lines.append("")

        if timestamp_us is not None:
            try:
                ts_ms = int(timestamp_us) / 1000
                lines.append(f"**Timestamp:** {ts_ms:.0f} ms")
            except (ValueError, TypeError):
                pass
            lines.append("")

    return "\n".join(lines)


@dataclass
class MdStep:
    heading_id: str
    image_targets: list[str] = field(default_factory=list)
    action_text: str | None = None
    timestamp_ms: str | None = None
    order: int = 0


@dataclass
class ParsedMarkdown:
    goal: str | None
    declared_total: int | None
    steps: list[MdStep]
    problems: list[str]


def parse_markdown(text: str) -> ParsedMarkdown:
    problems: list[str] = []
    goal_m = re.search(r"^## Goal\n\n(.*?)\n\n## Steps\n", text, flags=re.S | re.M)
    goal = goal_m.group(1) if goal_m else None
    if goal is None:
        problems.append("goal_section_missing")
    tot_m = re.search(r"^Total steps: \*\*(\d+)\*\*$", text, flags=re.M)
    declared = int(tot_m.group(1)) if tot_m else None
    if declared is None:
        problems.append("total_steps_missing")
    steps: list[MdStep] = []
    current: MdStep | None = None
    in_steps = False
    for ln in text.splitlines():
        if ln.startswith("## Steps"):
            in_steps = True
            continue
        if not in_steps:
            continue
        m = re.match(r"^### Step (.+)$", ln)
        if m:
            current = MdStep(heading_id=m.group(1), order=len(steps))
            steps.append(current)
            continue
        if current is None:
            continue
        for im in IMAGE_LINK.finditer(ln):
            current.image_targets.append(im.group("target"))
        am = re.match(r"^\*\*Action:\*\* `(.*)`$", ln)
        if am:
            current.action_text = am.group(1)
        tm = re.match(r"^\*\*Timestamp:\*\* (.+) ms$", ln)
        if tm:
            current.timestamp_ms = tm.group(1)
    if declared is not None and declared != len(steps):
        problems.append(f"declared_total_{declared}_vs_parsed_{len(steps)}")
    return ParsedMarkdown(goal=goal, declared_total=declared, steps=steps, problems=problems)


def image_targets(text: str) -> list[str]:
    return [m.group("target") for m in IMAGE_LINK.finditer(text)]
