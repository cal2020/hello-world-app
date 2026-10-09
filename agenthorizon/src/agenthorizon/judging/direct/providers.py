"""Direct provider adapters.

Released providers (``llm_judges/evaluate.py`` @8584a347):
* ``openai_compatible`` — OpenRouter and self-hosted vLLM: POST ``/chat/completions`` with
  ``{model, messages, temperature, max_tokens}`` (+ ``reasoning.effort``, ``chat_template_kwargs``), as released.
* ``gemini`` — ``google-genai`` SDK; the system text is prepended as the first user part, as released.
* ``codex_direct`` — Codex CLI with ``--image`` attachments and ``--output-schema``, run in the task sandbox.

Extension provider (not used by any released configuration):
* ``anthropic`` — official ``anthropic`` SDK (Messages API) with SDK retries disabled so every transport retry is
  recorded by the executor. Opus 4.7+ reject sampling parameters, so ``temperature`` is omitted for them.

Errors are normalised: ``RateLimited`` / ``TransportError`` (retryable, do not consume a judgment attempt),
``ServingIncompatible`` (payload exceeds a serving limit — never truncated), ``ProviderError`` (fatal for the attempt).
"""

from __future__ import annotations

import base64
import json
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from agenthorizon.judging.direct.packaging import DirectPayload
from agenthorizon.util.hashing import digest_json, sha256_bytes


class TransportError(Exception):
    def __init__(self, message: str, *, status: int | None = None, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class RateLimited(TransportError):
    pass


class ServingIncompatible(Exception):
    pass


class ProviderError(Exception):
    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class ProviderResponse:
    text: str
    model_reported: str | None
    usage: dict
    thinking: str | None = None
    stop_reason: str | None = None
    request_sha256: str | None = None
    request_bytes: int | None = None
    raw_meta: dict = field(default_factory=dict)


def _context_overflow(msg: str) -> bool:
    m = msg.lower()
    return any(s in m for s in ("context length", "context_length", "maximum context", "too long", "too many images",
                                "request too large", "payload too large", "exceeds the limit"))


class OpenAICompatibleProvider:
    def __init__(self, route: str, base_url: str, api_key: str, *, timeout: float = 600.0,
                 transport: httpx.BaseTransport | None = None):
        self.route = route
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or "EMPTY"
        self.client = httpx.Client(timeout=timeout, transport=transport)

    def call(self, payload: DirectPayload, model: str, sampling: dict) -> ProviderResponse:
        body: dict = {"model": model, "messages": payload.messages,
                      "temperature": sampling.get("temperature", 0),
                      "max_tokens": sampling.get("max_output_tokens") or 2048}
        if sampling.get("reasoning_effort"):
            body["reasoning"] = {"effort": sampling["reasoning_effort"]}
        if sampling.get("enable_thinking") is not None:
            body["chat_template_kwargs"] = {"enable_thinking": sampling["enable_thinking"]}
        raw = json.dumps(body).encode()
        try:
            r = self.client.post(f"{self.base_url}/chat/completions", content=raw,
                                 headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        except httpx.TimeoutException as exc:
            raise TransportError(f"timeout: {exc}") from exc
        except httpx.HTTPError as exc:
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc
        if r.status_code == 429:
            try:
                ra = ((r.json().get("error") or {}).get("metadata") or {}).get("retry_after")
            except ValueError:
                ra = None
            raise RateLimited("rate limited (429)", status=429, retry_after=float(ra or r.headers.get("retry-after") or 60))
        if r.status_code >= 500:
            raise TransportError(f"HTTP {r.status_code}: {r.text[:200]}", status=r.status_code)
        if r.status_code == 413 or (r.status_code == 400 and _context_overflow(r.text)):
            raise ServingIncompatible(f"HTTP {r.status_code}: {r.text[:300]}")
        if r.status_code != 200:
            raise ProviderError(f"HTTP {r.status_code}: {r.text[:300]}", status=r.status_code)
        data = r.json()
        msg = data["choices"][0]["message"]
        return ProviderResponse(text=msg.get("content") or "", model_reported=data.get("model"), usage=data.get("usage") or {},
                                thinking=msg.get("reasoning"), stop_reason=data["choices"][0].get("finish_reason"),
                                request_sha256=sha256_bytes(raw), request_bytes=len(raw),
                                raw_meta={"endpoint_host": httpx.URL(self.base_url).host})


def _decode_data_url(url: str) -> tuple[str, bytes] | None:
    if not url.startswith("data:image/"):
        return None
    header, b64 = url.split(",", 1)
    return header[5:].split(";")[0], base64.b64decode(b64)


class GeminiProvider:
    route = "google"

    def __init__(self, api_key: str, *, base_url: str | None = None):
        from google import genai
        from google.genai import types

        self.types = types
        opts = types.HttpOptions(base_url=base_url) if base_url else None
        self.client = genai.Client(api_key=api_key, http_options=opts)

    def call(self, payload: DirectPayload, model: str, sampling: dict) -> ProviderResponse:
        types = self.types
        system_text, parts = "", []
        for msg in payload.messages:
            if msg["role"] == "system":
                system_text = msg["content"] if isinstance(msg["content"], str) else system_text
                continue
            for item in msg["content"] if isinstance(msg["content"], list) else [{"type": "text", "text": msg["content"]}]:
                if item.get("type") == "text":
                    parts.append(types.Part.from_text(text=item["text"]))
                elif item.get("type") == "image_url":
                    dec = _decode_data_url(item["image_url"]["url"])
                    if dec:
                        parts.append(types.Part.from_bytes(data=dec[1], mime_type=dec[0]))
        if system_text:
            parts.insert(0, types.Part.from_text(text=system_text + "\n\n"))
        budget = sampling.get("thinking_budget")
        cfg = {"temperature": sampling.get("temperature", 0),
               "max_output_tokens": sampling.get("max_output_tokens") or (16384 if budget not in (None, 0) else 1024)}
        if budget not in (None, 0):
            cfg["thinking_config"] = types.ThinkingConfig(include_thoughts=True, thinking_budget=budget)
        from google.genai import errors as gerr

        try:
            resp = self.client.models.generate_content(model=model, contents=[types.Content(role="user", parts=parts)],
                                                       config=types.GenerateContentConfig(**cfg))
        except gerr.APIError as exc:
            code = getattr(exc, "code", None)
            if code == 429:
                raise RateLimited(f"Gemini 429: {exc}", status=429, retry_after=60) from exc
            if code and code >= 500:
                raise TransportError(f"Gemini {code}: {exc}", status=code) from exc
            if code in (400, 413) and _context_overflow(str(exc)):
                raise ServingIncompatible(str(exc)) from exc
            raise ProviderError(f"Gemini {code}: {exc}", status=code) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc
        answer, thoughts = [], []
        for cand in resp.candidates or []:
            for part in (cand.content.parts or []) if cand.content else []:
                if getattr(part, "text", None):
                    (thoughts if getattr(part, "thought", False) else answer).append(part.text)
        um = resp.usage_metadata
        usage = {"prompt_tokens": getattr(um, "prompt_token_count", None), "completion_tokens": getattr(um, "candidates_token_count", None),
                 "thoughts_tokens": getattr(um, "thoughts_token_count", None)} if um else {}
        canonical = {"model": model, "config": {k: v for k, v in cfg.items() if k != "thinking_config"},
                     "parts": [pp.sha256 for pp in payload.parts]}
        return ProviderResponse(text="".join(answer) or (resp.text or ""), model_reported=getattr(resp, "model_version", None) or model,
                                usage=usage, thinking="".join(thoughts) or None, request_sha256=digest_json(canonical))


class AnthropicProvider:
    """EXTENSION provider (official SDK). Not part of any released AgentHorizon configuration."""

    route = "anthropic"
    NO_SAMPLING_MODELS = ("claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-fable")

    def __init__(self, api_key: str, *, base_url: str | None = None, timeout: float = 600.0):
        import anthropic

        self.sdk = anthropic
        kw: dict = {"api_key": api_key, "max_retries": 0, "timeout": timeout}
        if base_url:
            kw["base_url"] = base_url
        self.client = anthropic.Anthropic(**kw)

    def call(self, payload: DirectPayload, model: str, sampling: dict) -> ProviderResponse:
        anthropic = self.sdk
        system = next((m["content"] for m in payload.messages if m["role"] == "system"), None)
        blocks = []
        for m in payload.messages:
            if m["role"] != "user":
                continue
            for item in m["content"]:
                if item["type"] == "text":
                    blocks.append({"type": "text", "text": item["text"]})
                elif item["type"] == "image_url":
                    dec = _decode_data_url(item["image_url"]["url"])
                    if dec:
                        blocks.append({"type": "image", "source": {"type": "base64", "media_type": dec[0],
                                                                    "data": base64.standard_b64encode(dec[1]).decode()}})
        kw: dict = {"model": model, "max_tokens": sampling.get("max_output_tokens") or 16000,
                    "messages": [{"role": "user", "content": blocks}]}
        if system:
            kw["system"] = system
        if sampling.get("temperature") is not None and not model.startswith(self.NO_SAMPLING_MODELS):
            kw["temperature"] = sampling["temperature"]
        if sampling.get("thinking") == "adaptive":
            kw["thinking"] = {"type": "adaptive"}
        if sampling.get("effort"):
            kw["output_config"] = {"effort": sampling["effort"]}
        try:
            msg = self.client.messages.create(**kw)
        except anthropic.RateLimitError as exc:
            ra = exc.response.headers.get("retry-after") if getattr(exc, "response", None) is not None else None
            raise RateLimited(f"429: {exc.message}", status=429, retry_after=float(ra or 60)) from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code == 413 or (exc.status_code == 400 and _context_overflow(str(exc.message))):
                raise ServingIncompatible(f"{exc.status_code}: {exc.message}") from exc
            if exc.status_code >= 500:  # includes 529 overloaded
                raise TransportError(f"{exc.status_code}: {exc.message}", status=exc.status_code) from exc
            raise ProviderError(f"{exc.status_code}: {exc.message}", status=exc.status_code) from exc
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as exc:
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        u = msg.usage
        usage = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
                 "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", None)}
        canonical = {k: v for k, v in kw.items() if k != "messages"}
        canonical["parts"] = [p.sha256 for p in payload.parts]
        return ProviderResponse(text=text, model_reported=msg.model, usage=usage, stop_reason=msg.stop_reason,
                                request_sha256=digest_json(canonical), raw_meta={"request_id": getattr(msg, "_request_id", None)})


CODEX_OUTPUT_SCHEMA = {  # llm_judges/evaluate.py _CODEX_OUTPUT_SCHEMA @8584a347
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "reasoning": {"type": "string"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "mistake_type": {"anyOf": [{"type": "null"}, {"type": "string", "enum": [
            "Critical Mistake", "Bad Side Effect", "Misunderstanding of the Instruction"]}]},
    },
    "required": ["success", "reasoning", "confidence", "mistake_type"],
    "additionalProperties": False,
}


class CodexDirectProvider:
    """Codex CLI as a direct judge (released ``call_codex``), executed inside the per-task namespace sandbox."""

    route = "chatgpt_subscription"

    def __init__(self, task_dir: Path, secrets: dict[str, str], *, effort: str | None = None, binary: str | None = None,
                 timeout_s: int = 1200):
        self.task_dir, self.secrets, self.effort, self.timeout_s = task_dir, secrets, effort, timeout_s
        from agenthorizon.judging.harnesses import CodexAdapter

        self.binary = binary or CodexAdapter().binary_path() or "codex"

    def call(self, payload: DirectPayload, model: str, sampling: dict) -> ProviderResponse:
        from agenthorizon.judging.agentic import tool_dirs
        from agenthorizon.judging.harnesses import ROUTE_HOSTS, HarnessRun, base_env
        from agenthorizon.judging.isolation.egress import default_upstream_proxy
        from agenthorizon.judging.isolation.sandbox import SandboxSpec, run_in_sandbox

        ws = self.task_dir / "workspace"
        if ws.exists():
            shutil.rmtree(ws)
        ws.mkdir(parents=True)
        texts, images = [], []
        for m in payload.messages:
            content = m["content"]
            if isinstance(content, str):
                texts.append(content)
                continue
            for item in content:
                if item["type"] == "text":
                    texts.append(item["text"])
                else:
                    dec = _decode_data_url(item["image_url"]["url"])
                    if dec:
                        ext = "jpg" if "jpeg" in dec[0] else "png"
                        p = ws / f"img_{len(images):03d}.{ext}"
                        p.write_bytes(dec[1])
                        images.append(f"/workspace/{p.name}")
        (ws / "schema.json").write_text(json.dumps(CODEX_OUTPUT_SCHEMA))
        argv = [self.binary, "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
                "--output-schema", "/workspace/schema.json", "-o", "/out/output.txt", "-m", model,
                "-c", 'model_provider = "openai"']
        if self.effort:
            argv += ["-c", f'model_reasoning_effort = "{self.effort}"']
        for ip in images:
            argv += ["--image", ip]
        argv.append("-")
        run = HarnessRun(model=model, route=self.route, prompt_text="")
        env = base_env(run)
        env["CODEX_HOME"] = "/home/judge/.codex"
        home = self.task_dir / "home" / ".codex"
        home.mkdir(parents=True, exist_ok=True)
        if self.secrets.get("CODEX_AUTH_JSON"):
            (home / "auth.json").write_text(self.secrets["CODEX_AUTH_JSON"])
            os.chmod(home / "auth.json", 0o600)
        prompt = "\n\n".join(texts)
        res = run_in_sandbox(SandboxSpec(task_dir=self.task_dir, argv=argv, env=env, allowed_hosts=ROUTE_HOSTS[self.route],
                                         readonly_inputs=["."], tool_dirs=tool_dirs(), timeout_s=self.timeout_s,
                                         stdin=prompt.encode(), upstream_proxy=default_upstream_proxy()))
        if res.timed_out:
            raise TransportError(f"codex exec timed out after {self.timeout_s}s")
        if res.exit_code != 0:
            raise ProviderError(f"codex exec exit {res.exit_code}: {res.stderr()[-400:]}")
        out = self.task_dir / "out" / "output.txt"
        if not out.is_file():
            raise ProviderError("codex exec produced no output-last-message file")
        canonical = {"argv": argv[:-1], "prompt_sha256": sha256_bytes(prompt.encode()), "images": len(images)}
        return ProviderResponse(text=out.read_text().strip(), model_reported=model, usage={},
                                request_sha256=digest_json(canonical), raw_meta={"n_images": len(images)})
