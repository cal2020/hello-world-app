"""Native harness adapters: Claude Code, Codex, Gemini CLI, OpenCode, OpenHands.

Each adapter runs the real CLI in its own native task loop with its own tools — nothing is re-implemented as a
custom loop. Command lines follow ``scripts/evaluate_trajectories.py:build_cmd`` at 8584a347; every flag was
checked against the installed CLI's ``--help`` (evidence/harness_cli/). Output parsers are ported verbatim from
the same file. Differences from the authors' setup are explicit in ``lineage["deviations"]``.

Credentials are passed per route, only to the harness that needs them, and only via the sandbox environment or
files in the task's private HOME — never inherited from the worker's environment.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from agenthorizon.config import PROJECT_ROOT
from agenthorizon.judging.contract import Telemetry

TOOLS_NPM_BIN = PROJECT_ROOT / "var" / "tools" / "npm" / "node_modules" / ".bin"
TOOLS_UV_BIN = PROJECT_ROOT / "var" / "tools" / "uv" / "bin"
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif")

ROUTE_HOSTS: dict[str, set[str]] = {
    "anthropic": {"api.anthropic.com"},
    "chatgpt_subscription": {"chatgpt.com", "api.openai.com", "auth.openai.com"},
    "openai": {"api.openai.com"},
    "google": {"generativelanguage.googleapis.com"},
    "openrouter": {"openrouter.ai"},
}


@dataclass
class HarnessRun:
    """Everything an adapter needs for one attempt (no labels, no dataset handles)."""

    model: str
    route: str | None
    prompt_text: str  # rendered prompt (TRAJECTORY_ID substituted)
    trajectory_content: str = ""  # empty for the templated official prompt (judge reads files itself)
    effort: str | None = None
    base_url: str | None = None  # vLLM / custom endpoint
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    workspace: str = "/workspace"
    home: str = "/home/judge"


@dataclass
class Invocation:
    argv: list[str]
    env: dict[str, str]
    stdin: bytes | None
    home_files: dict[str, tuple[str, int]]  # path relative to HOME -> (content, mode)
    allowed_hosts: set[str]
    deviations: list[str]


def _resolve(binary: str) -> str | None:
    for d in (TOOLS_NPM_BIN, TOOLS_UV_BIN):
        p = d / binary
        if p.exists():
            return str(p)
    return shutil.which(binary)


def _version(argv: list[str]) -> str | None:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=60, env={"PATH": "/usr/bin:/bin:/opt/node22/bin",
                                                                                    "HOME": "/tmp", "OPENHANDS_SUPPRESS_BANNER": "1"})
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = [ln.strip() for ln in (out.stdout + "\n" + out.stderr).splitlines() if ln.strip()]
    for ln in lines:
        if any(ch.isdigit() for ch in ln) and len(ln) < 80 and "warning" not in ln.lower():
            return ln
    return lines[0] if lines else None


def _route_hosts(route: str | None, base_url: str | None) -> set[str]:
    hosts = set(ROUTE_HOSTS.get(route or "", set()))
    if base_url:
        h = urlparse(base_url).hostname
        if h:
            hosts.add(h)
    return hosts


def base_env(run: HarnessRun) -> dict[str, str]:
    return {
        "PATH": f"{TOOLS_NPM_BIN}:{TOOLS_UV_BIN}:/opt/node22/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME": run.home,
        "TMPDIR": "/tmp",
        "LANG": "C.UTF-8",
        "TERM": "dumb",
        "NO_COLOR": "1",
        "HTTPS_PROXY": "http://127.0.0.1:3128",
        "https_proxy": "http://127.0.0.1:3128",
        "HTTP_PROXY": "http://127.0.0.1:3128",
        "ALL_PROXY": "http://127.0.0.1:3128",
        "NO_PROXY": "",
        "NODE_USE_ENV_PROXY": "1",
        "SSL_CERT_FILE": "/etc/ah/ca-bundle.pem",
        "NODE_EXTRA_CA_CERTS": "/etc/ah/ca-bundle.pem",
        "REQUESTS_CA_BUNDLE": "/etc/ah/ca-bundle.pem",
    }


class HarnessAdapter:
    interface: str = ""
    binary: str = ""
    package: str = ""
    reference_parser: str = ""

    def __init__(self, binary_override: str | None = None):
        self.binary_override = binary_override  # tests/replay only; recorded in lineage as harness_binary

    def binary_path(self) -> str | None:
        return self.binary_override or _resolve(self.binary)

    def version(self) -> str | None:
        p = self.binary_path()
        return _version([p, "--version"]) if p else None

    def required_secrets(self, route: str | None) -> list[str]:
        raise NotImplementedError

    def invocation(self, run: HarnessRun, secrets: dict[str, str]) -> Invocation:
        raise NotImplementedError

    def parse(self, stdout: str, home: Path, run: HarnessRun) -> tuple[str, dict]:
        raise NotImplementedError

    def telemetry(self, meta: dict, home: Path, run: HarnessRun) -> Telemetry:
        raise NotImplementedError


# ---------------------------------------------------------------------------------------- Claude Code
class ClaudeCodeAdapter(HarnessAdapter):
    interface = "claude_code"
    binary = "claude"
    package = "@anthropic-ai/claude-code"
    reference_parser = "claude --output-format json -> .result (evaluate_trajectories.py)"

    def required_secrets(self, route):
        return ["ANTHROPIC_API_KEY"] if route in ("anthropic", None) else []

    def invocation(self, run, secrets):
        argv = [self.binary_path() or "claude", "-p", "--dangerously-skip-permissions"]
        if run.effort:
            argv += ["--effort", run.effort]
        argv += [run.prompt_text, "--model", run.model, "--output-format", "json", "--session-id", run.session_id]
        env = base_env(run)
        env["ANTHROPIC_API_KEY"] = secrets.get("ANTHROPIC_API_KEY", "")
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        env["DISABLE_AUTOUPDATER"] = "1"
        return Invocation(argv, env, run.trajectory_content.encode(), {}, _route_hosts("anthropic", None),
                          ["non-essential traffic and auto-update disabled (blocked by egress policy anyway)",
                           "permissions are bypassed inside a capability-free namespace sandbox (authors: per-experiment sandbox dir)"])

    def _session(self, home: Path, run: HarnessRun) -> Path:
        slug = run.workspace.replace("/", "-")
        return home / ".claude" / "projects" / slug / f"{run.session_id}.jsonl"

    def parse(self, stdout, home, run):
        try:
            cli = json.loads(stdout)
        except json.JSONDecodeError:
            return "", {"cli_output_parse_error": True}
        return cli.get("result", "") or "", {"cli": cli}

    def telemetry(self, meta, home, run):
        cli = meta.get("cli") or {}
        usage = cli.get("usage") or {}
        t = Telemetry(
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            cached_input_tokens=usage.get("cache_read_input_tokens"),
            cost_billed_usd=cli.get("total_cost_usd"),
            turns=cli.get("num_turns"),
            model_reported=next(iter((cli.get("modelUsage") or {}).keys()), None),
            price_source="harness-reported total_cost_usd" if cli.get("total_cost_usd") is not None else None,
        )
        sess = self._session(home, run)
        if sess.is_file():
            tools = images = 0
            for line in sess.read_text(errors="replace").splitlines():
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("type") != "assistant":
                    continue
                for b in (e.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        tools += 1
                        fp = str((b.get("input") or {}).get("file_path", ""))
                        if b.get("name") == "Read" and fp.lower().endswith(IMAGE_SUFFIXES):
                            images += 1
            t.tool_calls, t.images_viewed = tools, images
            t.coverage.update(tool_calls="estimated", images_viewed="estimated")
        return t.finalize()


# ---------------------------------------------------------------------------------------- Codex
def parse_codex_output(raw_output: str) -> tuple[str, dict]:
    """Verbatim port of evaluate_trajectories.py:parse_codex_output @8584a347."""
    TOOL_ITEM_TYPES = {"command_execution", "function_call", "mcp_tool_call"}
    response_text = ""
    metadata: dict = {}
    thinking_chunks: list[str] = []
    turns = 0
    tool_calls = 0
    tool_names: dict[str, int] = {}
    for line in raw_output.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "model" in event and "sandbox" in event:
            metadata["model"] = event.get("model")
            metadata["provider"] = event.get("provider")
            continue
        msg = event.get("msg", {})
        if msg.get("type") == "agent_message":
            response_text = msg.get("message", "")
        if msg.get("type") in ("agent_reasoning", "reasoning"):
            chunk = msg.get("text") or msg.get("message") or ""
            if chunk:
                thinking_chunks.append(chunk)
        if event.get("type") == "item.completed":
            item = event.get("item", {})
            itype = item.get("type")
            if itype == "agent_message":
                response_text = item.get("text", "")
            elif itype in ("reasoning", "agent_reasoning"):
                chunk = item.get("text") or item.get("summary") or ""
                if chunk:
                    thinking_chunks.append(chunk)
            elif itype in TOOL_ITEM_TYPES:
                tool_calls += 1
                name = item.get("name") or (item.get("function") or {}).get("name") or itype
                tool_names[name] = tool_names.get(name, 0) + 1
        if event.get("type") == "turn.completed":
            turns += 1
            usage = event.get("usage", {})
            if usage:
                metadata["usage"] = usage
    if thinking_chunks:
        metadata["thinking"] = "\n\n".join(thinking_chunks)
    metadata["turns"] = turns
    metadata["tool_calls"] = tool_calls
    if tool_names:
        metadata["tool_names_by_count"] = tool_names
    return response_text, metadata


class CodexAdapter(HarnessAdapter):
    interface = "codex"
    binary = "codex"
    package = "@openai/codex"
    reference_parser = "parse_codex_output (verbatim)"

    def required_secrets(self, route):
        return {"chatgpt_subscription": ["CODEX_AUTH_JSON"], "openai": ["OPENAI_API_KEY"],
                "openrouter": ["OPENROUTER_API_KEY"], "vllm": ["VLLM_API_KEY"]}.get(route or "", [])

    def config_toml(self, run: HarnessRun) -> str | None:
        if run.route == "openrouter":
            return ('model_provider = "openrouter"\n\n[model_providers.openrouter]\nname = "OpenRouter"\n'
                    'base_url = "https://openrouter.ai/api/v1"\nenv_key = "OPENROUTER_API_KEY"\nwire_api = "responses"\n')
        if run.route == "vllm":
            return ('model_provider = "ah_vllm"\n\n[model_providers.ah_vllm]\nname = "AgentHorizon vLLM"\n'
                    f'base_url = "{run.base_url}"\nenv_key = "VLLM_API_KEY"\nwire_api = "responses"\n')
        return None

    def invocation(self, run, secrets):
        argv = [self.binary_path() or "codex", "exec", "--json", "--skip-git-repo-check"]
        if run.route == "chatgpt_subscription":
            argv += ["-c", 'model_provider = "openai"']
        if run.effort:
            argv += ["-c", f'model_reasoning_effort = "{run.effort}"']
        argv += ["-m", run.model, run.prompt_text]
        env = base_env(run)
        env["CODEX_HOME"] = f"{run.home}/.codex"
        files: dict[str, tuple[str, int]] = {}
        dev = ["CODEX_HOME confined to the task HOME"]
        cfg = self.config_toml(run)
        if cfg:
            files[".codex/config.toml"] = (cfg, 0o600)
            dev.append("provider defined with wire_api=\"responses\": codex 0.162 rejects the chat wire API the authors' "
                       "0.117-era OpenRouter/vLLM routes likely used (their config.toml is unreleased)")
        if run.route == "chatgpt_subscription" and secrets.get("CODEX_AUTH_JSON"):
            files[".codex/auth.json"] = (secrets["CODEX_AUTH_JSON"], 0o600)
        for k in ("OPENAI_API_KEY", "OPENROUTER_API_KEY", "VLLM_API_KEY"):
            if secrets.get(k):
                env[k] = secrets[k]
        return Invocation(argv, env, run.trajectory_content.encode(), files, _route_hosts(run.route, run.base_url), dev)

    def parse(self, stdout, home, run):
        text, meta = parse_codex_output(stdout)
        return text, {"codex": meta}

    def telemetry(self, meta, home, run):
        m = meta.get("codex") or {}
        usage = m.get("usage") or {}
        names = m.get("tool_names_by_count") or {}
        t = Telemetry(
            input_tokens=usage.get("input_tokens") or usage.get("prompt_tokens"),
            output_tokens=usage.get("output_tokens") or usage.get("completion_tokens"),
            cached_input_tokens=usage.get("cached_input_tokens"),
            reasoning_tokens=usage.get("reasoning_output_tokens"),
            tool_calls=m.get("tool_calls"),
            turns=m.get("turns"),
            model_reported=m.get("model"),
        )
        if "view_image" in names:
            t.images_viewed = names["view_image"]
            t.coverage["images_viewed"] = "estimated"
        return t.finalize()


# ---------------------------------------------------------------------------------------- Gemini CLI
class GeminiCliAdapter(HarnessAdapter):
    interface = "gemini_cli"
    binary = "gemini"
    package = "@google/gemini-cli"
    reference_parser = "gemini --output-format json -> .response (+ session-file fallback)"

    def required_secrets(self, route):
        return ["GEMINI_API_KEY"] if route in ("google", None) else []

    def invocation(self, run, secrets):
        argv = [self.binary_path() or "gemini", "-p", "Respond to the instructions above.", "--model", run.model,
                "--output-format", "json", "--approval-mode", "yolo",
                "--include-directories", f"{run.workspace}/data/media/images"]
        env = base_env(run)
        key = secrets.get("GEMINI_API_KEY", "")
        env.update(GEMINI_API_KEY=key, GOOGLE_API_KEY=key, GEMINI_CLI_TRUST_WORKSPACE="true")
        stdin = (run.prompt_text + "\n\n" + run.trajectory_content).encode()
        return Invocation(argv, env, stdin, {}, _route_hosts("google", None),
                          ["--include-directories points at the staged images inside the workspace (authors: symlink target outside it)"])

    def parse(self, stdout, home, run):
        try:
            cli = json.loads(stdout)
        except json.JSONDecodeError:
            return "", {"cli_output_parse_error": True}
        text = cli.get("response", "") or ""
        meta = {"cli": cli}
        sid = cli.get("session_id") or ""
        if sid:
            chats = list((home / ".gemini" / "tmp").glob(f"*/chats/*{sid.split('-')[0]}*.json*"))
            if chats:
                meta["chat_file"] = str(chats[0])
        return text, meta

    def fallback_text(self, meta: dict) -> str:
        """Port of the authors' session-file fallback when stdout `.response` is unusable."""
        p = meta.get("chat_file")
        if not p or not Path(p).is_file():
            return ""
        final = ""
        txt = Path(p).read_text(errors="replace")
        if p.endswith(".jsonl"):
            for line in txt.splitlines():
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("type") == "gemini" and isinstance(e.get("content"), str) and e["content"].strip():
                    final = e["content"]
        else:
            try:
                d = json.loads(txt)
            except json.JSONDecodeError:
                return ""
            for m in d.get("messages", []):
                if m.get("type") == "gemini" and isinstance(m.get("content"), str) and m["content"].strip():
                    final = m["content"]
        return final

    def telemetry(self, meta, home, run):
        cli = meta.get("cli") or {}
        stats = cli.get("stats") or {}
        models = stats.get("models") or {}
        ti = to = None
        turns = None
        for m in models.values():
            if not isinstance(m, dict):
                continue
            tk = m.get("tokens") or {}
            ti = (ti or 0) + int(tk.get("prompt") or m.get("promptTokenCount") or 0)
            to = (to or 0) + int(tk.get("candidates") or 0) + int(tk.get("thoughts") or 0)
            turns = (turns or 0) + int(((m.get("api") or {}).get("totalRequests")) or 0)
        tools = (stats.get("tools") or {}).get("totalCalls")
        t = Telemetry(input_tokens=ti, output_tokens=to, tool_calls=tools, turns=turns,
                      model_reported=next(iter(models), None))
        return t.finalize()


# ---------------------------------------------------------------------------------------- OpenCode
def parse_opencode_output(raw_output: str) -> tuple[str, dict]:
    """Verbatim port of evaluate_trajectories.py:parse_opencode_output @8584a347."""
    response_text = ""
    metadata: dict = {}
    thinking_chunks: list[str] = []
    total_cost = 0.0
    in_tok = out_tok = 0
    turns = 0
    tool_calls = 0
    tool_names: dict[str, int] = {}
    for line in raw_output.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        part = event.get("part", {}) if isinstance(event.get("part"), dict) else {}
        if etype == "text":
            response_text = part.get("text", "")
        elif etype == "reasoning":
            chunk = part.get("text") or part.get("content") or ""
            if chunk:
                thinking_chunks.append(chunk)
        elif etype == "step_finish":
            turns += 1
            total_cost += float(part.get("cost") or 0.0)
            tokens = part.get("tokens") or {}
            in_tok += int(tokens.get("input") or 0)
            out_tok += int(tokens.get("output") or 0)
        elif etype == "tool_use":
            tool_calls += 1
            name = event.get("tool") or part.get("tool") or "tool"
            tool_names[name] = tool_names.get(name, 0) + 1
    metadata["cost_usd"] = total_cost or None
    metadata["tokens"] = {"input": in_tok, "output": out_tok} if (in_tok or out_tok) else None
    metadata["usage"] = {"input_tokens": in_tok, "output_tokens": out_tok}
    metadata["turns"] = turns
    metadata["tool_calls"] = tool_calls
    if tool_names:
        metadata["tool_names_by_count"] = tool_names
    if thinking_chunks:
        metadata["thinking"] = "\n\n".join(thinking_chunks)
    return response_text, metadata


def opencode_images_viewed(raw_output: str) -> int:
    n = 0
    for line in raw_output.splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") != "tool_use":
            continue
        part = e.get("part") or {}
        inp = ((part.get("state") or {}).get("input") or {})
        fp = str(inp.get("filePath") or inp.get("file_path") or inp.get("path") or "")
        if fp.lower().endswith(IMAGE_SUFFIXES):
            n += 1
    return n


class OpenCodeAdapter(HarnessAdapter):
    interface = "opencode"
    binary = "opencode"
    package = "opencode-ai"
    reference_parser = "parse_opencode_output (verbatim)"

    def required_secrets(self, route):
        return {"openrouter": ["OPENROUTER_API_KEY"], "google": ["GOOGLE_GENERATIVE_AI_API_KEY"],
                "vllm": ["VLLM_API_KEY"]}.get(route or "", [])

    def config_json(self, run: HarnessRun) -> dict:
        cfg: dict = {"$schema": "https://opencode.ai/config.json", "autoupdate": False}
        if run.route == "vllm":
            provider, _, model_id = run.model.partition("/")
            cfg["provider"] = {provider: {
                "npm": "@ai-sdk/openai-compatible",
                "name": f"AgentHorizon vLLM ({provider})",
                "options": {"baseURL": run.base_url, "apiKey": "{env:VLLM_API_KEY}"},
                "models": {model_id: {"name": model_id, "limit": {"context": 262144, "output": 65536}}},
            }}
        return cfg

    def invocation(self, run, secrets):
        argv = [self.binary_path() or "opencode", "run", "--format", "json", "-m", run.model, run.prompt_text]
        env = base_env(run)
        env["OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"] = "65536"
        for k in ("OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "VLLM_API_KEY"):
            if secrets.get(k):
                env[k] = secrets[k]
        files = {".config/opencode/opencode.json": (json.dumps(self.config_json(run), indent=2), 0o600)}
        dev = ["opencode.json generated per task (authors' ~/.config/opencode/opencode.json is unreleased); "
               "output limit 65536 mirrors OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"]
        if run.route == "vllm":
            dev.append("the @ai-sdk/openai-compatible provider package must be pre-provisioned in the read-only tool "
                       "cache (no package-registry egress is allowed)")
        return Invocation(argv, env, run.trajectory_content.encode(), files, _route_hosts(run.route, run.base_url), dev)

    def parse(self, stdout, home, run):
        text, meta = parse_opencode_output(stdout)
        meta["images_viewed"] = opencode_images_viewed(stdout)
        return text, {"opencode": meta}

    def telemetry(self, meta, home, run):
        m = meta.get("opencode") or {}
        usage = m.get("usage") or {}
        t = Telemetry(input_tokens=usage.get("input_tokens"), output_tokens=usage.get("output_tokens"),
                      tool_calls=m.get("tool_calls"), turns=m.get("turns"), cost_billed_usd=m.get("cost_usd"),
                      images_viewed=m.get("images_viewed"),
                      price_source="harness-reported step cost" if m.get("cost_usd") else None)
        t.coverage["images_viewed"] = "estimated"
        return t.finalize()


# ---------------------------------------------------------------------------------------- OpenHands
def parse_openhands_output(raw_output: str) -> tuple[str, dict]:
    """Port of evaluate_trajectories.py:parse_openhands_output @8584a347 (``--JSON Event--`` stream), with a
    fallback for plain JSONL lines emitted by newer CLIs. The authors' char/4 token *estimate* is not ported:
    unknown usage stays unknown."""
    response_text = ""
    metadata: dict = {}
    turns = 0
    tool_calls = 0
    tool_names: dict[str, int] = {}
    chunks = raw_output.split("--JSON Event--") if "--JSON Event--" in raw_output else raw_output.splitlines()
    for chunk in chunks:
        chunk = chunk.strip()
        brace_start = chunk.find("{")
        if brace_start == -1:
            continue
        depth = 0
        json_str = ""
        for i in range(brace_start, len(chunk)):
            if chunk[i] == "{":
                depth += 1
            elif chunk[i] == "}":
                depth -= 1
            if depth == 0:
                json_str = chunk[brace_start : i + 1]
                break
        if not json_str:
            continue
        try:
            event = json.loads(json_str)
        except json.JSONDecodeError:
            continue
        src = event.get("source")
        if src == "agent":
            turns += 1
            if event.get("tool_call") is not None or event.get("action"):
                tool_calls += 1
                name = event.get("tool_name") or "action"
                tool_names[name] = tool_names.get(name, 0) + 1
        if src == "agent" and event.get("llm_message"):
            for part in event["llm_message"].get("content", []):
                if part.get("type") == "text":
                    response_text = part.get("text", "")
        if src == "agent":
            action = event.get("action") or {}
            if isinstance(action, dict) and action.get("kind") == "FinishAction":
                msg = action.get("message") or ""
                if msg:
                    response_text = msg
    metadata["turns"] = turns
    metadata["tool_calls"] = tool_calls
    if tool_names:
        metadata["tool_names_by_count"] = tool_names
    return response_text, metadata


class OpenHandsAdapter(HarnessAdapter):
    interface = "openhands"
    binary = "openhands"
    package = "openhands (PyPI, CLI)"
    reference_parser = "parse_openhands_output (ported; token estimate dropped)"

    def required_secrets(self, route):
        return {"google": ["GEMINI_API_KEY"], "openrouter": ["OPENROUTER_API_KEY"], "vllm": ["VLLM_API_KEY"]}.get(route or "", [])

    def invocation(self, run, secrets):
        combined = run.prompt_text + "\n\n" + run.trajectory_content
        argv = [self.binary_path() or "openhands", "--headless", "--override-with-envs", "--json", "-t", combined]
        env = base_env(run)
        env["OPENHANDS_SUPPRESS_BANNER"] = "1"
        if run.route == "google":
            env["LLM_API_KEY"] = secrets.get("GEMINI_API_KEY", "")
            env["LLM_MODEL"] = run.model if run.model.startswith("gemini/") else f"gemini/{run.model.split('/')[-1]}"
        elif run.route == "openrouter":
            env["LLM_API_KEY"] = secrets.get("OPENROUTER_API_KEY", "")
            env["LLM_MODEL"] = run.model if run.model.startswith("openrouter/") else f"openrouter/{run.model}"
            env["LLM_BASE_URL"] = "https://openrouter.ai/api/v1"
        elif run.route == "vllm":
            env["LLM_API_KEY"] = secrets.get("VLLM_API_KEY", "")
            env["LLM_MODEL"] = run.model if run.model.startswith("openai/") else f"openai/{run.model}"
            env["LLM_BASE_URL"] = run.base_url or ""
        return Invocation(argv, env, None, {}, _route_hosts(run.route, run.base_url),
                          ["vLLM LLM_MODEL uses the LiteLLM openai/ prefix (authors' launcher env for vLLM is unreleased)"])

    def parse(self, stdout, home, run):
        text, meta = parse_openhands_output(stdout)
        return text, {"openhands": meta}

    def telemetry(self, meta, home, run):
        m = meta.get("openhands") or {}
        return Telemetry(tool_calls=m.get("tool_calls"), turns=m.get("turns")).finalize()


ADAPTERS: dict[str, HarnessAdapter] = {a.interface: a for a in (ClaudeCodeAdapter(), CodexAdapter(), GeminiCliAdapter(),
                                                                OpenCodeAdapter(), OpenHandsAdapter())}
