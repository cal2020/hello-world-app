"""Direct-judge packaging, limits, and provider transport (synthetic test data; no model calls)."""

from __future__ import annotations

import ast
import base64
import io
import json
import types
from pathlib import Path

import httpx
import pytest
from PIL import Image

from agenthorizon.judging.direct.executor import run_direct_attempt
from agenthorizon.judging.direct.limits import ProviderLimits, limits_for
from agenthorizon.judging.direct.packaging import build_payload
from agenthorizon.judging.direct.providers import AnthropicProvider, GeminiProvider, OpenAICompatibleProvider
from agenthorizon.testing.fake_llm import FakeLLMServer, anthropic_message, gemini_response, openai_response
from agenthorizon.testing.fixture import build_fixture
from agenthorizon.util.hashing import sha256_file

VERDICT = json.dumps({"success": False, "reasoning": "r", "confidence": "high", "mistake_type": "Critical Mistake"})


@pytest.fixture(scope="module")
def fx(tmp_path_factory):
    d = tmp_path_factory.mktemp("fxd")
    s = build_fixture(d, full_size_recordings=1)
    return d, s


def _trajs(d: Path) -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted((d / "sandbox" / "data" / "jsons").glob("*.json"))]


def _image_for(sandbox: Path):
    def f(step: dict) -> Path | None:
        s = step.get("screenshot")
        return (sandbox / s[2:]) if s else None
    return f


def _load_reference(checkout: Path) -> types.SimpleNamespace:
    ns: dict = {}
    exec("import base64, io, json, math, os, re\nfrom pathlib import Path\nfrom PIL import Image\n", ns)
    for rel, names in (("llm_judges/utils.py", {"estimate_text_tokens", "estimate_image_tokens", "load_and_resize_image",
                                                "image_to_base64", "get_screenshot_path", "format_step_text",
                                                "build_instruction_text"}),
                       ("llm_judges/preprocess_compress.py", {"EVAL_PROMPT", "compute_target_resolution", "preprocess_one"})):
        tree = ast.parse((checkout / rel).read_text())
        keep = []
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name in names:
                keep.append(node)
            elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names | {"CHARS_PER_TOKEN",
                                                       "IMAGE_BASE_TOKENS", "PIXELS_PER_TOKEN"} for t in node.targets):
                keep.append(node)
        exec(compile(ast.Module(body=keep, type_ignores=[]), rel, "exec"), ns)
    return types.SimpleNamespace(**ns)


@pytest.mark.reference
@pytest.mark.parametrize("mode,ref_kwargs", [("native-512x332", {"target_width": 512, "target_height": 332}),
                                             ("released-auto@100000", {}), ("released-auto@60000", {})])
def test_payload_byte_identical_to_released_preprocessing(fx, reference_checkout, mode, ref_kwargs):
    d, summary = fx
    ref = _load_reference(reference_checkout)
    from agenthorizon.judging.prompts import official_direct_prompt

    prompt = official_direct_prompt().text
    assert prompt == ref.EVAL_PROMPT
    budget = int(mode.split("@")[1]) if "@" in mode else 100000
    checked = 0
    for traj in _trajs(d)[:6]:
        gold = summary["gold"][traj["trajectory_id"]]
        theirs = ref.preprocess_one(traj, d / "sandbox", budget, local_image_id=gold["original_id"], **ref_kwargs)
        ours = build_payload(traj["trajectory_id"], traj["task"]["instruction"], traj["steps"], _image_for(d / "sandbox"),
                             prompt, mode)
        assert ours.messages == theirs["messages"]  # identical text and identical JPEG bytes
        assert ours.image_resolution == theirs["image_resolution"]
        assert ours.n_images == theirs["num_screenshots"]
        checked += 1
    assert checked == 6


def _solid(path: Path, color, size=(1710, 1112)) -> None:
    Image.new("RGB", size, color).save(path)


def test_mosaic_row_major_order_padding_and_originals_untouched(tmp_path):
    colors = [(250, 0, 0), (0, 250, 0), (0, 0, 250), (250, 250, 0), (0, 250, 250)]
    steps = []
    for i, c in enumerate(colors):
        p = tmp_path / f"s{i}.png"
        _solid(p, c)
        steps.append({"step_id": i, "screenshot": str(p), "action": {"type": "click", "parameters": {"x": 1, "y": 2, "button": "left"}},
                      "timestamp_us": i * 1000})
    before = [sha256_file(Path(s["screenshot"])) for s in steps]
    pl = build_payload("ex", "Do the thing", steps, lambda s: Path(s["screenshot"]), "SYSTEM", "mosaic-2x2-1024x664")
    assert pl.n_images == 2 and pl.image_resolution == [1024, 664]
    imgs = [Image.open(io.BytesIO(base64.b64decode(c["image_url"]["url"].split(",", 1)[1])))
            for c in pl.messages[1]["content"] if c["type"] == "image_url"]
    assert all(im.size == (1024, 664) for im in imgs)
    centres = [(256, 166), (768, 166), (256, 498), (768, 498)]

    def near(a, b):
        return all(abs(x - y) < 30 for x, y in zip(a, b, strict=True))

    for cell, col in enumerate(colors[:4]):
        assert near(imgs[0].getpixel(centres[cell]), col), (cell, imgs[0].getpixel(centres[cell]))
    assert near(imgs[1].getpixel(centres[0]), colors[4])
    assert all(near(imgs[1].getpixel(centres[k]), (0, 0, 0)) for k in (1, 2, 3))  # incomplete grid padded black
    texts = [c["text"] for c in pl.messages[1]["content"] if c["type"] == "text"]
    assert [t for t in texts if t.startswith("### Step")] == [f"### Step {i}\n**Action:** `left-click (1, 2)`\n**Timestamp:** {i} ms" for i in range(5)]
    assert any("row-major" in t for t in texts)
    assert [sha256_file(Path(s["screenshot"])) for s in steps] == before


class _NeverCalled:
    route = "vllm"

    def call(self, *a, **k):
        raise AssertionError("provider must not be called when the payload exceeds a known limit")


def test_long_trajectory_never_truncated(fx, tmp_path):
    d, _ = fx
    long = next(t for t in _trajs(d) if len(t["steps"]) > 300)
    pl = build_payload(long["trajectory_id"], long["task"]["instruction"], long["steps"], _image_for(d / "sandbox"),
                       "SYSTEM", "native-512x332")
    assert pl.n_images == len(long["steps"]) == 320
    assert sum(1 for c in pl.messages[1]["content"] if c["type"] == "text" and c["text"].startswith("### Step")) == 320
    lim = ProviderLimits("vllm", "m", max_images=100, sources={"max_images": "operator override"})
    out = run_direct_attempt(_NeverCalled(), pl, "m", {}, run_dir=tmp_path, task_dir=tmp_path / "t", limits=lim)
    assert out.status == "serving_incompatible" and "images" in out.error
    mosaic = build_payload(long["trajectory_id"], long["task"]["instruction"], long["steps"], _image_for(d / "sandbox"),
                           "SYSTEM", "mosaic-2x2-1024x664")
    assert mosaic.n_images == 80  # every frame present, packed four per image


def test_openai_compatible_wire_payload_and_error_mapping(fx, tmp_path):
    d, _ = fx
    traj = _trajs(d)[0]
    pl = build_payload(traj["trajectory_id"], traj["task"]["instruction"], traj["steps"], _image_for(d / "sandbox"), "SYSTEM",
                       "native-512x332")
    seen: list[dict] = []
    script = [httpx.Response(429, json={"error": {"metadata": {"retry_after": 0}}}),
              httpx.Response(200, json=openai_response(VERDICT))]

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(json.loads(req.content))
        return script.pop(0)

    prov = OpenAICompatibleProvider("vllm", "https://vllm.test/v1", "k", transport=httpx.MockTransport(handler))
    out = run_direct_attempt(prov, pl, "Qwen/Qwen3.6-27B", {"temperature": 0, "max_output_tokens": 2048},
                             run_dir=tmp_path, task_dir=tmp_path / "t", limits=limits_for("vllm", "Qwen/Qwen3.6-27B"),
                             sleep=lambda s: None)
    assert out.status == "completed" and out.verdict.binary_valid and out.verdict.success is False
    assert [r["kind"] for r in out.transport_retries] == ["rate_limit"]
    body = seen[-1]
    assert body["temperature"] == 0 and body["max_tokens"] == 2048 and body["messages"][0]["content"] == "SYSTEM"
    imgs = [c for c in body["messages"][1]["content"] if c["type"] == "image_url"]
    assert len(imgs) == len(traj["steps"])
    for c in imgs:  # what was actually sent decodes to images within the 512x332 box
        im = Image.open(io.BytesIO(base64.b64decode(c["image_url"]["url"].split(",", 1)[1])))
        assert im.format == "JPEG" and im.width <= 512 and im.height <= 332
    for status, expected in ((500, "transport_failed"), (413, "serving_incompatible"), (401, "blocked")):
        prov = OpenAICompatibleProvider("vllm", "https://vllm.test/v1", "k",
                                        transport=httpx.MockTransport(lambda r, s=status: httpx.Response(s, text="err")))
        o = run_direct_attempt(prov, pl, "m", {}, run_dir=tmp_path, task_dir=tmp_path / f"t{status}",
                               limits=limits_for("vllm", "m"), sleep=lambda s: None)
        assert o.status == expected, (status, o.status)


def test_anthropic_extension_request_shape_and_retry_accounting(fx, tmp_path):
    d, _ = fx
    traj = _trajs(d)[1]
    pl = build_payload(traj["trajectory_id"], traj["task"]["instruction"], traj["steps"], _image_for(d / "sandbox"), "SYSTEM",
                       "native-512x332")
    with FakeLLMServer() as srv:
        srv.script = [(429, {"retry-after": "0"}, {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}),
                      (200, {}, anthropic_message(VERDICT))]
        prov = AnthropicProvider("sk-ant-test", base_url=srv.url)
        out = run_direct_attempt(prov, pl, "claude-opus-4-7", {"temperature": 0, "max_output_tokens": 4000},
                                 run_dir=tmp_path, task_dir=tmp_path / "t", limits=limits_for("anthropic", "claude-opus-4-7"),
                                 sleep=lambda s: None)
        assert out.status == "completed" and out.verdict.success is False
        assert len(srv.requests) == 2  # SDK retries disabled: our executor made (and recorded) the retry
        assert [r["kind"] for r in out.transport_retries] == ["rate_limit"]
        body = srv.requests[-1]["body"]
        assert srv.requests[-1]["path"].endswith("/v1/messages")
        assert body["system"] == "SYSTEM" and "temperature" not in body  # Opus 4.7 rejects sampling params
        blocks = body["messages"][0]["content"]
        assert sum(1 for b in blocks if b["type"] == "image") == len(traj["steps"])
        assert all(b["source"]["media_type"] == "image/jpeg" for b in blocks if b["type"] == "image")
        srv.script = [(529, {}, {"type": "error", "error": {"type": "overloaded_error", "message": "overloaded"}})]
        o2 = run_direct_attempt(prov, pl, "claude-opus-4-7", {}, run_dir=tmp_path, task_dir=tmp_path / "t2",
                                limits=limits_for("anthropic", "claude-opus-4-7"), sleep=lambda s: None)
        assert o2.status == "transport_failed" and o2.transport_retries[0]["status"] == 529


def test_gemini_request_mirrors_released_conversion(fx, tmp_path):
    d, _ = fx
    traj = _trajs(d)[2]
    pl = build_payload(traj["trajectory_id"], traj["task"]["instruction"], traj["steps"], _image_for(d / "sandbox"), "SYSTEM",
                       "native-512x332")
    with FakeLLMServer() as srv:
        srv.default = (200, {}, gemini_response(VERDICT))
        prov = GeminiProvider("AIzaTEST", base_url=srv.url)
        out = run_direct_attempt(prov, pl, "gemini-3.1-flash-lite-preview", {"temperature": 0}, run_dir=tmp_path,
                                 task_dir=tmp_path / "t", limits=limits_for("google", "gemini-3.1-flash-lite-preview"))
        assert out.status == "completed" and out.verdict.success is False, out.error
        req = srv.requests[-1]
        assert ":generateContent" in req["path"]
        parts = req["body"]["contents"][0]["parts"]
        assert parts[0]["text"] == "SYSTEM\n\n"  # released code prepends the system text as the first part
        inline = [p for p in parts if "inlineData" in p or "inline_data" in p]
        assert len(inline) == len(traj["steps"])
        cfg = req["body"].get("generationConfig") or req["body"].get("generation_config")
        assert cfg["temperature"] == 0 and cfg["maxOutputTokens"] == 1024
