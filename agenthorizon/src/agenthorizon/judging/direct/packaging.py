"""Direct (single-request) multimodal payload construction.

Released behaviour reproduced exactly (``llm_judges/preprocess_compress.py`` and ``llm_judges/utils.py`` at
8584a347): system message = the official ``EVAL_PROMPT``; user content = a ``## Goal`` / ``## Steps`` header,
then for each step in released order its ``format_step_text`` block followed by its screenshot as a JPEG data URL
(``Image.thumbnail`` with LANCZOS into the target box, RGB, quality 60, ``optimize=True``). Every step is kept —
no keyframe selection, OCR, summaries, or truncation.

Preprocessing modes (each is its own configuration id, recorded on every task):

* ``native-512x332`` — S5 protocol: every screenshot fit into 512×332 (the released code's maximum size).
* ``released-auto@<budget>`` — released auto-resolution: largest width in [64, 512] (aspect 1710:1112) whose
  estimated payload fits ``<budget>`` tokens (README "1×" variant used 100000).
* ``released-1126x730`` — released "2.2×" fixed-size variant.
* ``mosaic-2x2-1024x664`` — S5 overflow mode: four consecutive screenshots per 1024×664 row-major grid.
  The release has no mosaic code; cell placement (each frame thumbnailed into its 512×332 cell, centred on
  black), blank padding of an incomplete final grid, the reading-order caption, and the text-then-mosaic
  interleaving are documented engineering choices (``MOSAIC_CHOICES``), not released details.
"""

from __future__ import annotations

import base64
import io
import math
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

import PIL
from PIL import Image

from agenthorizon.util.hashing import digest_json, sha256_bytes, sha256_text

# ---- verbatim ports from llm_judges/utils.py @8584a347 -----------------------------------------------
CHARS_PER_TOKEN = 4
IMAGE_BASE_TOKENS = 85
PIXELS_PER_TOKEN = 170
ASPECT_W, ASPECT_H = 1710, 1112


def estimate_text_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


def estimate_image_tokens(width: int, height: int) -> int:
    return IMAGE_BASE_TOKENS + (width * height) // PIXELS_PER_TOKEN


def load_and_resize_image(path: str | Path, max_width: int = 512, max_height: int = 512, quality: int = 60) -> tuple[bytes, int, int]:
    img = Image.open(path).convert("RGB")
    img.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue(), img.width, img.height


def format_step_text(step: dict, step_idx: int | None = None) -> str:
    if step_idx is None:
        step_idx = step.get("step_id", "?")
    action = step.get("action", {})
    action_type = action.get("type", "unknown")
    params = action.get("parameters", {})
    if action_type == "click":
        button = params.get("button", "left")
        x, y = params.get("x", "?"), params.get("y", "?")
        n = params.get("num_clicks", 1)
        click_str = f"{'right' if button == 'right' else 'left'}-click"
        suffix = f" x{n}" if n and n > 1 else ""
        action_str = f"{click_str} ({x}, {y}){suffix}"
    elif action_type == "type":
        text = params.get("text", "")
        if len(text) > 80:
            text = text[:77] + "..."
        action_str = f'type "{text}"'
    elif action_type == "press":
        action_str = f"press {' '.join(params.get('keys', []))}"
    elif action_type == "hotkey":
        action_str = f"hotkey {'+'.join(params.get('keys', []))}"
    elif action_type == "scroll":
        action_str = (f"scroll {params.get('direction', '?')} {params.get('amount', '?')}px at "
                      f"({params.get('x', '?')}, {params.get('y', '?')})")
    elif action_type == "drag":
        action_str = (f"drag ({params.get('start_x', '?')}, {params.get('start_y', '?')}) -> "
                      f"({params.get('end_x', '?')}, {params.get('end_y', '?')})")
    elif action_type in ("key_down", "key_up"):
        action_str = f"{action_type.replace('_', '')} {params.get('key', '?')}"
    else:
        action_str = action_type
    lines = [f"### Step {step_idx}", f"**Action:** `{action_str}`"]
    timestamp_us = step.get("timestamp_us")
    if timestamp_us is not None:
        try:
            lines.append(f"**Timestamp:** {int(timestamp_us) / 1000:.0f} ms")
        except (ValueError, TypeError):
            pass
    return "\n".join(lines)


def header_text(instruction: str, n_steps: int) -> str:
    return f"## Goal\n\n{instruction}\n\n## Steps\n\nTotal steps: **{n_steps}**\n"


def compute_target_resolution(instruction: str, steps: list[dict], n_screenshots: int, eval_prompt: str,
                              max_tokens: int, min_width: int = 64, max_width: int = 512) -> tuple[int, int]:
    """Port of preprocess_compress.compute_target_resolution (screenshot count passed in)."""
    if n_screenshots == 0:
        return max_width, int(max_width * ASPECT_H / ASPECT_W)
    text_parts = [eval_prompt, header_text(instruction, len(steps))]
    for i, step in enumerate(steps):
        text_parts.append(format_step_text(step, i))
    text_tokens = estimate_text_tokens("\n\n".join(text_parts))
    image_budget = max_tokens - text_tokens - 200
    if image_budget <= 0:
        return min_width, int(min_width * ASPECT_H / ASPECT_W)
    per_image = image_budget / n_screenshots
    aspect = ASPECT_H / ASPECT_W
    lo, hi, best = min_width, max_width, min_width
    while lo <= hi:
        mid = (lo + hi) // 2
        if estimate_image_tokens(mid, int(mid * aspect)) <= per_image:
            best, lo = mid, mid + 1
        else:
            hi = mid - 1
    return best, int(best * aspect)


# ---- payloads -------------------------------------------------------------------------------------------
MOSAIC_CHOICES = {
    "cell_box": [512, 332],
    "canvas": [1024, 664],
    "placement": "each frame thumbnailed (LANCZOS) into its 512x332 cell, centred, black background",
    "order": "row-major: top-left, top-right, bottom-left, bottom-right",
    "incomplete_final_grid": "unused cells left black; caption lists only the steps present",
    "caption": "text block before each mosaic naming its steps and the reading order",
    "interleaving": "the four step texts, then the caption, then the mosaic image",
    "encoding": "JPEG quality 60, optimize=True (same encoder settings as the released compression)",
    "status": "engineering choice: S5 describes the mosaic but the release contains no implementation",
}


@dataclass
class PayloadPart:
    kind: str  # text | image
    sha256: str
    detail: dict = field(default_factory=dict)


@dataclass
class DirectPayload:
    example_id: str
    preprocessing_id: str
    params: dict
    messages: list[dict]
    parts: list[PayloadPart]
    n_images: int
    image_resolution: list[int] | None
    token_estimate: int
    approx_request_bytes: int
    pillow_version: str = PIL.__version__
    notes: list[str] = field(default_factory=list)

    @property
    def manifest_digest(self) -> str:
        return digest_json({"pre": self.preprocessing_id, "params": self.params, "parts": [asdict(p) for p in self.parts]})

    def manifest(self) -> dict:
        d = asdict(self)
        d.pop("messages")
        d["manifest_digest"] = self.manifest_digest
        return d


StepImage = Callable[[dict], Path | None]  # step -> local screenshot file (None when the step has no screenshot)


def _jpeg_part(data: bytes) -> dict:
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")}}


def build_payload(example_id: str, instruction: str, steps: list[dict], image_for: StepImage, eval_prompt: str,
                  preprocessing_id: str) -> DirectPayload:
    """``steps`` are released-JSON step dicts (in order); ``image_for`` resolves each step's screenshot file."""
    files = [image_for(s) for s in steps]
    n_shots = sum(1 for f in files if f is not None)
    params: dict = {}
    if preprocessing_id == "native-512x332":
        tw, th = 512, 332
    elif preprocessing_id == "released-1126x730":
        tw, th = 1126, 730
    elif preprocessing_id.startswith("released-auto@"):
        budget = int(preprocessing_id.split("@", 1)[1])
        tw, th = compute_target_resolution(instruction, steps, n_shots, eval_prompt, budget)
        params["max_tokens_budget"] = budget
    elif preprocessing_id == "mosaic-2x2-1024x664":
        return _build_mosaic(example_id, instruction, steps, files, eval_prompt)
    else:
        raise ValueError(f"unknown preprocessing {preprocessing_id!r}")
    params["target_box"] = [tw, th]
    header = header_text(instruction, len(steps))
    content: list[dict] = [{"type": "text", "text": header}]
    parts = [PayloadPart("text", sha256_text(header), {"role": "header"})]
    tokens = estimate_text_tokens(eval_prompt) + estimate_text_tokens(header)
    total_bytes = len(eval_prompt) + len(header)
    for i, (step, f) in enumerate(zip(steps, files, strict=True)):
        st = format_step_text(step, i)
        content.append({"type": "text", "text": st})
        parts.append(PayloadPart("text", sha256_text(st), {"step_index": i}))
        tokens += estimate_text_tokens(st)
        total_bytes += len(st)
        if f is None:
            continue
        data, w, h = load_and_resize_image(f, tw, th, quality=60)
        content.append(_jpeg_part(data))
        parts.append(PayloadPart("image", sha256_bytes(data), {"step_index": i, "width": w, "height": h, "bytes": len(data)}))
        tokens += estimate_image_tokens(w, h)
        total_bytes += math.ceil(len(data) * 4 / 3) + 40
    messages = [{"role": "system", "content": eval_prompt}, {"role": "user", "content": content}]
    return DirectPayload(example_id, preprocessing_id, params, messages, parts, n_shots, [tw, th], tokens, total_bytes)


def _build_mosaic(example_id: str, instruction: str, steps: list[dict], files: list[Path | None], eval_prompt: str) -> DirectPayload:
    header = header_text(instruction, len(steps))
    content: list[dict] = [{"type": "text", "text": header}]
    parts = [PayloadPart("text", sha256_text(header), {"role": "header"})]
    tokens = estimate_text_tokens(eval_prompt) + estimate_text_tokens(header)
    total_bytes = len(eval_prompt) + len(header)
    shot_idx = [i for i, f in enumerate(files) if f is not None]
    groups = [shot_idx[k : k + 4] for k in range(0, len(shot_idx), 4)]
    emitted_text_upto = -1
    n_images = 0
    for g in groups:
        for i in range(emitted_text_upto + 1, g[-1] + 1):
            st = format_step_text(steps[i], i)
            content.append({"type": "text", "text": st})
            parts.append(PayloadPart("text", sha256_text(st), {"step_index": i}))
            tokens += estimate_text_tokens(st)
            total_bytes += len(st)
        emitted_text_upto = g[-1]
        canvas = Image.new("RGB", (1024, 664), (0, 0, 0))
        for cell, i in enumerate(g):
            img = Image.open(files[i]).convert("RGB")
            img.thumbnail((512, 332), Image.Resampling.LANCZOS)
            cx, cy = (cell % 2) * 512, (cell // 2) * 332
            canvas.paste(img, (cx + (512 - img.width) // 2, cy + (332 - img.height) // 2))
        buf = io.BytesIO()
        canvas.save(buf, format="JPEG", quality=60, optimize=True)
        data = buf.getvalue()
        positions = ["top-left", "top-right", "bottom-left", "bottom-right"]
        caption = ("The next image is a 2x2 grid of the screenshots for steps "
                   + ", ".join(f"{i} ({positions[c]})" for c, i in enumerate(g))
                   + ", read in row-major order (left to right, then top to bottom).")
        content.append({"type": "text", "text": caption})
        parts.append(PayloadPart("text", sha256_text(caption), {"role": "mosaic_caption", "steps": g}))
        content.append(_jpeg_part(data))
        parts.append(PayloadPart("image", sha256_bytes(data), {"steps": g, "width": 1024, "height": 664, "bytes": len(data)}))
        tokens += estimate_text_tokens(caption) + estimate_image_tokens(1024, 664)
        total_bytes += len(caption) + math.ceil(len(data) * 4 / 3) + 40
        n_images += 1
    for i in range(emitted_text_upto + 1, len(steps)):
        st = format_step_text(steps[i], i)
        content.append({"type": "text", "text": st})
        parts.append(PayloadPart("text", sha256_text(st), {"step_index": i}))
        tokens += estimate_text_tokens(st)
    messages = [{"role": "system", "content": eval_prompt}, {"role": "user", "content": content}]
    return DirectPayload(example_id, "mosaic-2x2-1024x664", {"choices": MOSAIC_CHOICES}, messages, parts, n_images,
                         [1024, 664], tokens, total_bytes, notes=["mosaic implementation details are engineering choices"])
