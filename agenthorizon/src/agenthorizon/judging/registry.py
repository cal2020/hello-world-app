"""Model and judge-configuration registry for every configuration evidenced by the accessible sources.

Rules: a provider model identifier is recorded only when a released artifact states it (``id_evidence``
names the file). Otherwise it stays ``None`` and the configuration cannot run until an operator supplies a
verified identifier. Sampling settings are recorded only when published; unknown values are ``None`` with
``"unknown"`` provenance — never a fabricated default presented as the paper's setting.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

Interface = Literal["codex", "claude_code", "gemini_cli", "opencode", "openhands", "direct"]

INTERFACE_LABELS: dict[str, str] = {
    "codex": "Codex",
    "claude_code": "Claude Code",
    "gemini_cli": "Gemini CLI",
    "opencode": "OpenCode",
    "openhands": "OpenHands",
    "direct": "Direct API",
}
LABEL_TO_INTERFACE = {v: k for k, v in INTERFACE_LABELS.items()}

S2 = "agenthorizon-repo@8584a347"


@dataclass(frozen=True)
class ModelSpec:
    model_key: str
    display_name: str
    vendor: str
    open_weights: bool | None
    vision_input: bool | None
    known_ids: dict[str, str] = field(default_factory=dict)  # route -> provider id (each evidenced)
    id_evidence: dict[str, str] = field(default_factory=dict)  # route -> where it is stated
    evidence: tuple[str, ...] = ()
    notes: str = ""


MODELS: tuple[ModelSpec, ...] = (
    ModelSpec("gpt-5.5", "GPT-5.5", "OpenAI", False, True,
              evidence=(f"{S2}:docs/supplementary-results.md",),
              notes="Run through Codex. The released code shows GPT-5.x via `--platform chatgpt_subscription` but never "
                    "states the exact model identifier; it must be supplied and verified by the operator."),
    ModelSpec("gpt-5.4-mini", "GPT-5.4 mini", "OpenAI", False, True,
              evidence=(f"{S2}:docs/supplementary-results.md", f"{S2}:scripts/generate_results_table.py (key codex_gpt54mini)"),
              notes="Exact identifier not stated in released artifacts."),
    ModelSpec("claude-opus-4.7", "Claude Opus 4.7", "Anthropic", False, True,
              known_ids={"anthropic": "claude-opus-4-7"},
              id_evidence={"anthropic": f"{S2}:scripts/evaluate_trajectories.py usage docstring (`--model claude-opus-4-7 --effort xhigh`)"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("claude-haiku-4.5", "Claude Haiku 4.5", "Anthropic", False, True,
              known_ids={"anthropic": "claude-haiku-4-5"},
              id_evidence={"anthropic": f"{S2}:scripts/compare_runs.py PRICE table key"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("gemini-3.1-pro", "Gemini 3.1 Pro", "Google", False, True,
              known_ids={"google": "gemini-3.1-pro-preview", "openrouter": "google/gemini-3.1-pro-preview"},
              id_evidence={"google": f"{S2}:scripts/evaluate_trajectories.py usage docstring",
                           "openrouter": f"{S2}:scripts/evaluate_trajectories.py _model_slug PRESET_TO_MODEL"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", "Google", False, True,
              known_ids={"google": "gemini-3.1-flash-lite-preview", "openrouter": "google/gemini-3.1-flash-lite-preview"},
              id_evidence={"google": f"{S2}:llm_judges/README.md (evaluate.py --model gemini-3.1-flash-lite-preview)",
                           "openrouter": f"{S2}:scripts/evaluate_trajectories.py _model_slug PRESET_TO_MODEL"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("qwen3.6-27b", "Qwen 3.6 27B", "Qwen", True, True,
              known_ids={"vllm": "Qwen/Qwen3.6-27B", "opencode": "qwen36_vllm/Qwen/Qwen3.6-27B"},
              id_evidence={"vllm": f"{S2}:llm_judges/README.md endpoint table",
                           "opencode": f"{S2}:scripts/evaluate_trajectories.py usage docstring (provider prefix is a local OpenCode config name)"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("qwen3.6-35b-a3b", "Qwen 3.6 35B-A3B", "Qwen", True, True,
              known_ids={"vllm": "Qwen/Qwen3.6-35B-A3B"},
              id_evidence={"vllm": f"{S2}:llm_judges/README.md endpoint table"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("qwen3.5-122b-a10b", "Qwen 3.5 122B-A10B", "Qwen", True, None,
              known_ids={"vllm": "Qwen/Qwen3.5-122B-A10B"},
              id_evidence={"vllm": f"{S2}:scripts/aggregate_difficulty.py SPLITTER_MODEL"},
              evidence=(f"{S2}:docs/supplementary-results.md", f"{S2}:paper/croissant.json", "MP §2"),
              notes="Legacy splitter (OpenCode, k=8, temp 0.6 per aggregate_difficulty.py docstring); one of three revised splitters per MP."),
    ModelSpec("qwen3.5-9b", "Qwen 3.5 9B", "Qwen", True, None,
              known_ids={"vllm": "Qwen/Qwen3.5-9B", "openrouter": "qwen/qwen3.5-9b"},
              id_evidence={"vllm": f"{S2}:llm_judges/README.md endpoint table",
                           "openrouter": f"{S2}:llm_judges/evaluate.py usage docstring"},
              evidence=("MP §7 (direct inventory, attributed to S1)",),
              notes="llm_judges/README.md calls it text-only; vision support unverified."),
    ModelSpec("gemma-4-31b", "Gemma 4 31B", "Google", True, True,
              known_ids={"vllm": "google/gemma-4-31B-it"},
              id_evidence={"vllm": f"{S2}:llm_judges/README.md endpoint table"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("gemma-4-26b-a4b", "Gemma 4 26B-A4B", "Google", True, True,
              known_ids={"vllm": "google/gemma-4-26B-A4B-it"},
              id_evidence={"vllm": f"{S2}:llm_judges/README.md endpoint table"},
              evidence=(f"{S2}:docs/supplementary-results.md",)),
    ModelSpec("inkling", "Inkling", "unknown", None, None,
              evidence=("MP §2 (revised splitter, attributed to S1)",),
              notes="Named only in the brief; no released artifact gives vendor, identifier, or serving route."),
    ModelSpec("kimi-k2.7-code", "Kimi K2.7 Code", "Moonshot (presumed from name; unverified)", None, None,
              evidence=("MP §2 (revised splitter, attributed to S1)",),
              notes="Named only in the brief; identifier and route unverified."),
)
MODELS_BY_KEY = {m.model_key: m for m in MODELS}
NAME_TO_MODEL_KEY = {m.display_name: m.model_key for m in MODELS}


@dataclass(frozen=True)
class JudgeConfig:
    config_id: str
    model_key: str
    interface: str
    route: str | None
    provider_model_id: str | None
    id_evidence: str | None
    sampling: dict = field(default_factory=dict)  # values are None when unpublished
    sampling_evidence: dict = field(default_factory=dict)
    effort: str | None = None
    effort_evidence: str | None = None
    preprocessing: str | None = None  # direct mode only
    prompt_revision: str = "ah-official-agentic@8584a347"
    paper_rows: tuple[str, ...] = ()
    role: str = "judge"  # judge | splitter
    evidence_class: str = "paper_row"  # paper_row | released_example | brief_only
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _cfg(model_key: str, interface: str, route: str | None, *, rows: tuple[str, ...], role: str = "judge",
         evidence_class: str = "paper_row", sampling: dict | None = None, sampling_evidence: dict | None = None,
         effort: str | None = None, effort_evidence: str | None = None, preprocessing: str | None = None,
         prompt_revision: str | None = None, suffix: str = "", notes: str = "") -> JudgeConfig:
    m = MODELS_BY_KEY[model_key]
    id_route = {"opencode": "opencode"}.get(interface) if interface == "opencode" and "opencode" in m.known_ids else route
    pid = m.known_ids.get(id_route or "") if id_route else None
    ev = m.id_evidence.get(id_route or "") if id_route else None
    if pid is None and route in m.known_ids:
        pid, ev = m.known_ids[route], m.id_evidence[route]
    cid = (f"{interface}:{model_key}" + (f":{preprocessing}" if preprocessing else "")
           + (":splitter" if role == "splitter" else "") + suffix)
    return JudgeConfig(
        config_id=cid, model_key=model_key, interface=interface, route=route, provider_model_id=pid, id_evidence=ev,
        sampling=sampling or {"temperature": None, "top_p": None, "max_output_tokens": None},
        sampling_evidence=sampling_evidence or {"all": "unknown (not published in accessible artifacts)"},
        effort=effort, effort_evidence=effort_evidence, preprocessing=preprocessing,
        prompt_revision=prompt_revision or ("ah-official-direct@8584a347" if interface == "direct" else "ah-official-agentic@8584a347"),
        paper_rows=rows, role=role, evidence_class=evidence_class, notes=notes,
    )


def _rows(model: str, interface: str) -> tuple[str, ...]:
    """Row references in S8 tables (resolved against the parsed tables at export time)."""
    return (f"S8.T1[{model}|{interface}]", f"S8.T2[{model}|{interface}]", f"S8.T3[{model}|{interface}]")


CONFIGS: tuple[JudgeConfig, ...] = (
    _cfg("gpt-5.5", "codex", "chatgpt_subscription", rows=_rows("GPT-5.5", "Codex"),
         notes="Route inferred from evaluate_trajectories.py (`GPT-5.x on the user's ChatGPT Plus plan`)."),
    _cfg("gemini-3.1-pro", "gemini_cli", "google", rows=_rows("Gemini 3.1 Pro", "Gemini CLI")),
    _cfg("claude-opus-4.7", "claude_code", "anthropic", rows=_rows("Claude Opus 4.7", "Claude Code"),
         effort="xhigh", effort_evidence=f"{S2}:scripts/evaluate_trajectories.py usage docstring (example invocation; not confirmed for the reported row)"),
    _cfg("qwen3.6-27b", "opencode", "vllm", rows=_rows("Qwen 3.6 27B", "OpenCode")),
    _cfg("gpt-5.4-mini", "codex", "chatgpt_subscription", rows=_rows("GPT-5.4 mini", "Codex")),
    _cfg("qwen3.6-35b-a3b", "opencode", "vllm", rows=_rows("Qwen 3.6 35B-A3B", "OpenCode")),
    _cfg("qwen3.6-27b", "openhands", "vllm", rows=_rows("Qwen 3.6 27B", "OpenHands")),
    _cfg("claude-haiku-4.5", "claude_code", "anthropic", rows=_rows("Claude Haiku 4.5", "Claude Code")),
    _cfg("gemini-3.1-flash-lite", "opencode", None, rows=_rows("Gemini 3.1 Flash Lite", "OpenCode"),
         notes="Serving route for this pairing not stated."),
    _cfg("gemini-3.1-flash-lite", "gemini_cli", "google", rows=_rows("Gemini 3.1 Flash Lite", "Gemini CLI")),
    _cfg("gemini-3.1-flash-lite", "openhands", "google", rows=_rows("Gemini 3.1 Flash Lite", "OpenHands"),
         notes="evaluate_trajectories.py routes google/ and gemini/ models to the Gemini API via LiteLLM for OpenHands."),
    _cfg("gemma-4-26b-a4b", "opencode", "vllm", rows=_rows("Gemma 4 26B-A4B", "OpenCode")),
    _cfg("gemini-3.1-flash-lite", "codex", "openrouter", rows=_rows("Gemini 3.1 Flash Lite", "Codex"),
         notes="generate_results_table.py key codex_gemini_flash_or indicates an OpenRouter route."),
    _cfg("gemma-4-31b", "opencode", "vllm", rows=_rows("Gemma 4 31B", "OpenCode")),
    _cfg("qwen3.5-122b-a10b", "opencode", "vllm", rows=_rows("Qwen 3.5 122B-A10B", "OpenCode"), role="splitter",
         sampling={"temperature": 0.6, "top_p": None, "max_output_tokens": 65536},
         sampling_evidence={"temperature": f"{S2}:scripts/aggregate_difficulty.py docstring (temp=0.6)",
                            "max_output_tokens": f"{S2}:scripts/evaluate_trajectories.py OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"},
         notes="Legacy partition splitter: k=8 attempts, Easy iff >=7/8 correct."),
    # Revised three-splitter procedure (brief only): harness for revised splitting is not stated.
    _cfg("qwen3.5-122b-a10b", "opencode", "vllm", rows=("MP §2",), suffix=":revised", role="splitter", evidence_class="brief_only",
         notes="Revised splitter #1 (8 verdicts/item). Harness assumed unchanged from legacy — unverified."),
    _cfg("inkling", "opencode", None, rows=("MP §2",), suffix=":revised", role="splitter", evidence_class="brief_only",
         notes="Revised splitter #2; interface and identifier unknown — placeholder interface, cannot run."),
    _cfg("kimi-k2.7-code", "opencode", None, rows=("MP §2",), suffix=":revised", role="splitter", evidence_class="brief_only",
         notes="Revised splitter #3; interface and identifier unknown — placeholder interface, cannot run."),
    # Direct (no-harness) configurations.
    _cfg("qwen3.5-9b", "direct", "vllm", rows=("MP §7",), evidence_class="brief_only", preprocessing="native-512x332",
         sampling={"temperature": 0.0, "top_p": None, "max_output_tokens": 2048},
         sampling_evidence={"temperature": f"{S2}:llm_judges/evaluate.py call_openai_compatible default",
                            "max_output_tokens": f"{S2}:llm_judges/evaluate.py (2048 without thinking)"},
         notes="Direct-table membership from the brief; full direct table not accessible."),
    _cfg("gemini-3.1-flash-lite", "direct", "google", rows=(f"{S2}:llm_judges/README.md quick start",),
         evidence_class="released_example", preprocessing="native-512x332",
         sampling={"temperature": 0.0, "top_p": None, "max_output_tokens": 1024},
         sampling_evidence={"temperature": f"{S2}:llm_judges/evaluate.py call_gemini default",
                            "max_output_tokens": f"{S2}:llm_judges/evaluate.py (1024 without thinking budget)"}),
    _cfg("gemini-3.1-pro", "direct", "google", rows=(f"{S2}:llm_judges/README.md quick start",),
         evidence_class="released_example", preprocessing="native-512x332",
         sampling={"temperature": 0.0, "top_p": None, "max_output_tokens": 1024},
         sampling_evidence={"temperature": f"{S2}:llm_judges/evaluate.py call_gemini default",
                            "max_output_tokens": f"{S2}:llm_judges/evaluate.py (1024 without thinking budget)"}),
    _cfg("qwen3.6-27b", "direct", "vllm", rows=(f"{S2}:llm_judges/README.md quick start",),
         evidence_class="released_example", preprocessing="native-512x332",
         sampling={"temperature": 0.0, "top_p": None, "max_output_tokens": 2048},
         sampling_evidence={"temperature": f"{S2}:llm_judges/evaluate.py default",
                            "max_output_tokens": f"{S2}:llm_judges/evaluate.py (2048 without thinking)"}),
    _cfg("gemma-4-31b", "direct", "vllm", rows=(f"{S2}:llm_judges/README.md quick start",),
         evidence_class="released_example", preprocessing="native-512x332",
         sampling={"temperature": 0.0, "top_p": None, "max_output_tokens": 2048},
         sampling_evidence={"temperature": f"{S2}:llm_judges/evaluate.py default",
                            "max_output_tokens": f"{S2}:llm_judges/evaluate.py (2048 without thinking)"}),
)
CONFIGS_BY_ID: dict[str, JudgeConfig] = {c.config_id: c for c in CONFIGS}
assert len(CONFIGS_BY_ID) == len(CONFIGS), "duplicate judge configuration ids"


def get_config(config_id: str) -> JudgeConfig:
    try:
        return CONFIGS_BY_ID[config_id]
    except KeyError as exc:
        raise KeyError(f"unknown judge configuration {config_id!r}") from exc
