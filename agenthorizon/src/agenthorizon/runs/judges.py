"""Bridge from a run definition to one judge attempt (agentic harness or direct API), plus per-item estimates.

Judges receive only the dataset version's judge-visible store and the media store; this module never imports the
private label store. Secrets come from the process environment by *name*; their values are never written into
definitions, lineage, or artifacts (the executors redact them from captured output).
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from agenthorizon.data.dataset import DatasetVersion
from agenthorizon.data.layout import asset_key_for_ref
from agenthorizon.data.materialize import current_assets
from agenthorizon.data.media import LocalMediaStore
from agenthorizon.judging.agentic import run_agentic_attempt
from agenthorizon.judging.contract import AttemptOutcome, Telemetry
from agenthorizon.judging.direct.executor import run_direct_attempt
from agenthorizon.judging.direct.limits import limits_for
from agenthorizon.judging.direct.packaging import (
    build_payload,
    estimate_image_tokens,
    estimate_text_tokens,
    format_step_text,
    header_text,
)
from agenthorizon.judging.harnesses import ADAPTERS, HarnessAdapter, HarnessRun
from agenthorizon.judging.prompts import (
    PromptRevision,
    harness_instructions,
    official_agentic_prompt,
    official_direct_prompt,
    rubric_extension_instructions,
)
from agenthorizon.judging.registry import INTERFACE_LABELS, MODELS_BY_KEY, get_config
from agenthorizon.judging.workspace import StagingError, stage_workspace
from agenthorizon.runs.identity import RunDefinition
from agenthorizon.runs.pricing import cost, price_for
from agenthorizon.util.hashing import sha256_file

ROUTE_SECRETS: dict[str, list[str]] = {
    "anthropic": ["ANTHROPIC_API_KEY"],
    "google": ["GEMINI_API_KEY"],
    "openrouter": ["OPENROUTER_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
    "vllm": ["VLLM_API_KEY"],
    "chatgpt_subscription": ["CODEX_AUTH_JSON"],
}
OPTIONAL_SECRETS = {"VLLM_API_KEY"}  # a vLLM server may run without auth
SECRET_ALIASES = {"GOOGLE_GENERATIVE_AI_API_KEY": "GEMINI_API_KEY"}


class JudgeSetupError(RuntimeError):
    """The configuration cannot run here (credential, identifier, binary, instruction file): a run-level block."""


def required_secret_names(interface: str, route: str | None) -> list[str]:
    if interface == "direct":
        return list(ROUTE_SECRETS.get(route or "", []))
    return list(ADAPTERS[interface].required_secrets(route))


def load_secrets(names: list[str], environ: dict | None = None) -> tuple[dict[str, str], list[str]]:
    """Values from the environment. ``CODEX_AUTH_JSON`` may name a file holding the auth JSON."""
    env = os.environ if environ is None else environ
    out, missing = {}, []
    for n in names:
        v = env.get(n) or env.get(next((k for k, a in SECRET_ALIASES.items() if a == n), ""), "")
        if n == "CODEX_AUTH_JSON" and v and not v.lstrip().startswith("{") and Path(v).is_file():
            v = Path(v).read_text()
        if v:
            out[n] = v
        elif n not in OPTIONAL_SECRETS:
            missing.append(n)
    for alias, target in SECRET_ALIASES.items():  # adapters that use a provider-specific variable name
        if target in out:
            out.setdefault(alias, out[target])
    return out, missing


def harness_model_string(interface: str, route: str | None, provider_model_id: str) -> tuple[str, list[str]]:
    """The model string the harness CLI expects. OpenCode addresses a self-hosted model as <provider>/<model>,
    where the provider is a name in the generated opencode.json."""
    if interface == "opencode" and route == "vllm" and provider_model_id.count("/") < 2:
        return f"ah_vllm/{provider_model_id}", ["OpenCode local provider alias 'ah_vllm' (configuration name only)"]
    return provider_model_id, []


def binary_identity(path: str | None) -> dict:
    if not path:
        return {"path": None, "sha256": None}
    real = os.path.realpath(path)
    return {"path": real, "sha256": sha256_file(Path(real)) if os.path.isfile(real) else None}


# ---- prompts ------------------------------------------------------------------------------------------------
def prompt_by_id(prompt_id: str) -> PromptRevision:
    for fn in (official_agentic_prompt, official_direct_prompt):
        p = fn()
        if p.prompt_id == prompt_id:
            return p
    raise JudgeSetupError(f"unknown prompt revision {prompt_id}")


def instructions_from(spec: dict | None) -> PromptRevision | None:
    if spec is None:
        return None
    if spec["prompt_id"].startswith("ext-rubric-as-agents-md@"):
        p = rubric_extension_instructions()
    elif spec["prompt_id"].startswith("operator-harness-instructions@"):
        p = harness_instructions(Path(spec["source"]["path"]))
        if p is None:
            raise JudgeSetupError(f"operator instruction file {spec['source']['path']} is not readable")
    else:
        raise JudgeSetupError(f"unknown instruction revision {spec['prompt_id']}")
    if p.sha256 != spec["sha256"]:
        raise JudgeSetupError(f"instruction file changed since the run was defined ({spec['prompt_id']})")
    return p


# ---- per-item estimates ---------------------------------------------------------------------------------------
_PRIOR_CACHE: dict | None = None


def authors_token_prior(model_key: str, interface: str) -> dict | None:
    """Mean input/output tokens per trajectory reported by the authors for this model/harness (S8.T1)."""
    global _PRIOR_CACHE
    if _PRIOR_CACHE is None:
        try:
            from agenthorizon.reference.tables import supplementary_tables
            t1 = next(t for t in supplementary_tables() if t["table_id"] == "S8.T1")
            _PRIOR_CACHE = {"table": t1["provenance"], "rows": t1["rows"]}
        except Exception:  # source checkout unavailable: no prior
            _PRIOR_CACHE = {"table": None, "rows": []}
    m = MODELS_BY_KEY.get(model_key)
    label = INTERFACE_LABELS.get(interface)
    for r in _PRIOR_CACHE["rows"]:
        if m and r["model"] == m.display_name and r["interface"] == label and r.get("mean_input_tokens"):
            return {"mean_input_tokens": r["mean_input_tokens"], "mean_output_tokens": r["mean_output_tokens"],
                    "source": f"S8.T1 line {r['line']} ({_PRIOR_CACHE['table']['path']}@{_PRIOR_CACHE['table']['revision'][:8]})"}
    return None


def step_count(dv: DatasetVersion, example_id: str) -> int:
    ex = dv.example(example_id)
    return int(ex.get("n_steps") or len(dv.steps(ex["recording_id"])))


def estimate_items(definition: RunDefinition, dv: DatasetVersion, price_override: dict | None = None) -> dict:
    """Forecast tokens and cost per item, with the assumptions spelled out."""
    j = definition.judge
    price = price_for(j["route"], j["provider_model_id"], price_override)
    ids = definition.example_ids
    steps = {eid: step_count(dv, eid) for eid in ids}
    items = []
    assumptions = ["all input tokens priced at the base input rate (provider caching would lower the bill)"]
    if j["interface"] == "direct":
        pre = (definition.preprocessing or {}).get("preprocessing_id", "native-512x332")
        prompt = prompt_by_id(definition.prompt["prompt_id"]).text
        out_cap = (j.get("sampling") or {}).get("max_output_tokens")
        per_image = {"native-512x332": estimate_image_tokens(512, 332), "released-1126x730": estimate_image_tokens(1126, 730),
                     "mosaic-2x2-1024x664": estimate_image_tokens(1024, 664)}.get(pre)
        assumptions += [f"input tokens from the released area-based estimator ({pre}); images at the box size (upper bound)",
                        f"output tokens at the configured cap ({out_cap}) — an upper bound"]
        for eid in ids:
            rj = dv.released_json(eid) or {}
            instr = (rj.get("task") or {}).get("instruction", "")
            st = rj.get("steps") or []
            n_img = sum(1 for s in st if s.get("screenshot"))
            text = estimate_text_tokens(prompt) + estimate_text_tokens(header_text(instr, len(st)))
            text += sum(estimate_text_tokens(format_step_text(s, i)) for i, s in enumerate(st))
            if pre.startswith("released-auto@"):
                tin = int(pre.split("@")[1])
            elif pre == "mosaic-2x2-1024x664":
                tin = text + -(-n_img // 4) * per_image
            else:
                tin = text + n_img * (per_image or 0)
            items.append({"example_id": eid, "steps": steps[eid], "input_tokens": tin, "output_tokens": out_cap,
                          "cost_usd": cost(price, tin, out_cap)})
        basis = "released token estimator on the actual payload structure"
    else:
        prior = authors_token_prior(j["model_key"], j["interface"])
        mean_steps = (sum(steps.values()) / len(steps)) if steps else 0
        all_steps = [step_count(dv, e["example_id"]) for e in dv.examples()]
        dv_mean = sum(all_steps) / len(all_steps) if all_steps else 1
        if prior:
            basis = f"authors' mean tokens per trajectory ({prior['source']}), scaled by item steps / dataset mean steps"
            assumptions.append(f"token use scales linearly with step count (dataset mean {dv_mean:.1f} steps)")
            for eid in ids:
                f = steps[eid] / dv_mean if dv_mean else 1.0
                tin, tout = int(prior["mean_input_tokens"] * f), int(prior["mean_output_tokens"] * f)
                items.append({"example_id": eid, "steps": steps[eid], "input_tokens": tin, "output_tokens": tout,
                              "cost_usd": cost(price, tin, tout)})
        else:
            basis = "LOWER BOUND: every Markdown token and every screenshot read once at original resolution"
            assumptions.append("no authors' token prior for this model/harness; multi-turn harnesses re-send context, "
                               "so real usage is typically several times this bound")
            for eid in ids:
                md = dv.released_markdown(eid) or ""
                tin = estimate_text_tokens(md) + steps[eid] * estimate_image_tokens(1710, 1112)
                items.append({"example_id": eid, "steps": steps[eid], "input_tokens": tin, "output_tokens": None,
                              "cost_usd": cost(price, tin, 0), "lower_bound": True})
        assumptions.append(f"selection mean {mean_steps:.1f} steps")
    known = [i["cost_usd"] for i in items if i["cost_usd"] is not None]
    return {"basis": basis, "assumptions": assumptions, "price": price.to_dict() if price else None,
            "n_items": len(items), "items_with_cost": len(known),
            "total_cost_usd": round(sum(known), 4) if len(known) == len(items) and items else None,
            "total_input_tokens": sum(i["input_tokens"] or 0 for i in items),
            "per_attempt_max_usd": max(known) if known else None, "items": items,
            "note": "Forecast only — not a billed amount. Retries (up to the policy's attempt cap) can add cost."}


# ---- judges ------------------------------------------------------------------------------------------------------
class _MediaResolver:
    def __init__(self, dv: DatasetVersion, media: LocalMediaStore):
        self.assets = current_assets(dv)
        self.media = media
        self.missing: list[str] = []

    def __call__(self, step: dict) -> Path | None:
        s = step.get("screenshot")
        if not s:
            return None
        key = asset_key_for_ref(s)
        a = self.assets.get(key) if key else None
        if not a or a.get("status") != "materialized" or not a.get("sha256") or not self.media.has(a["sha256"]):
            self.missing.append(s)
            return None
        return self.media.path(a["sha256"])


class AgenticJudge:
    def __init__(self, definition: RunDefinition, dv: DatasetVersion, media: LocalMediaStore, secrets: dict[str, str], *,
                 adapter: HarnessAdapter | None = None, isolation: str | None = None,
                 extra_tool_dirs: list[str] | None = None, staging_secret: bytes = b"", sleep=None):
        self.d, self.dv, self.media, self.secrets = definition, dv, media, secrets
        j = definition.judge
        self.adapter = adapter or type(ADAPTERS[j["interface"]])()
        self.prompt = prompt_by_id(definition.prompt["prompt_id"])
        if self.prompt.sha256 != definition.prompt["sha256"]:
            raise JudgeSetupError("prompt text changed since the run was defined")
        self.instructions = instructions_from(definition.instructions)
        self.isolation = isolation or definition.execution["isolation"]
        self.extra_tool_dirs = extra_tool_dirs
        self.staging_secret = staging_secret
        self.sleep = sleep

    def attempt(self, example_id: str, attempt_no: int, task_dir: Path, run_dir: Path,
                cancel: threading.Event) -> AttemptOutcome:
        j, pol = self.d.judge, self.d.attempt_policy
        try:
            staged = stage_workspace(self.dv, self.media, example_id, task_dir, prompt=self.prompt,
                                     instructions=self.instructions, mode=self.d.staging_mode, secret=self.staging_secret)
        except StagingError as exc:
            return AttemptOutcome("blocked", error=f"staging failed: {exc}", telemetry=Telemetry().finalize())
        if staged.missing_media:
            return AttemptOutcome("blocked", error=f"{len(staged.missing_media)} screenshots not materialized; "
                                  "materialize media before judging (never judged on partial evidence)",
                                  telemetry=Telemetry().finalize(), lineage={"missing_media": staged.missing_media[:20]})
        run = HarnessRun(model=j["harness_model"], route=j["route"], prompt_text=self.prompt.render(TRAJECTORY_ID=example_id),
                         effort=j.get("effort"), base_url=j.get("base_url"))
        kw = {}
        if self.sleep is not None:
            kw["sleep"] = self.sleep
        return run_agentic_attempt(self.adapter, run, staged, self.secrets, run_dir=run_dir, isolation=self.isolation,
                                   timeout_s=self.d.execution["timeout_s"], cancel=cancel,
                                   max_rate_limit_retries=pol["rate_limit_resends_per_attempt"],
                                   rate_limit_wait_s=pol["rate_limit_wait_s"] or 300.0,
                                   extra_tool_dirs=self.extra_tool_dirs, **kw)


class DirectJudge:
    def __init__(self, definition: RunDefinition, dv: DatasetVersion, media: LocalMediaStore, secrets: dict[str, str], *,
                 provider=None, sleep=None):
        self.d, self.dv, self.media, self.secrets = definition, dv, media, secrets
        self.prompt = prompt_by_id(definition.prompt["prompt_id"])
        if self.prompt.sha256 != definition.prompt["sha256"]:
            raise JudgeSetupError("prompt text changed since the run was defined")
        self._provider = provider
        self.sleep = sleep
        j = definition.judge
        self.limits = limits_for(j["route"], j["provider_model_id"], definition.execution.get("limit_overrides"))

    def provider(self, task_dir: Path):
        if self._provider is not None:
            return self._provider
        from agenthorizon.judging.direct import providers as P

        j = self.d.judge
        route = j["route"]
        if route == "anthropic":
            return P.AnthropicProvider(self.secrets["ANTHROPIC_API_KEY"])
        if route == "google":
            return P.GeminiProvider(self.secrets["GEMINI_API_KEY"])
        if route == "vllm":
            if not j.get("base_url"):
                raise JudgeSetupError("a vLLM route needs an operator-supplied base URL")
            return P.OpenAICompatibleProvider("vllm", j["base_url"], self.secrets.get("VLLM_API_KEY") or "EMPTY")
        if route == "openrouter":
            return P.OpenAICompatibleProvider("openrouter", "https://openrouter.ai/api/v1", self.secrets["OPENROUTER_API_KEY"])
        if route == "chatgpt_subscription":
            return P.CodexDirectProvider(task_dir, self.secrets, effort=j.get("effort"))
        raise JudgeSetupError(f"no direct provider for route {route!r}")

    def attempt(self, example_id: str, attempt_no: int, task_dir: Path, run_dir: Path,
                cancel: threading.Event) -> AttemptOutcome:
        rj = self.dv.released_json(example_id)
        if rj is None:
            return AttemptOutcome("blocked", error="released JSON not available for this item", telemetry=Telemetry().finalize())
        resolver = _MediaResolver(self.dv, self.media)
        steps = rj.get("steps") or []
        files = [resolver(s) for s in steps]
        if resolver.missing:
            return AttemptOutcome("blocked", error=f"{len(resolver.missing)} screenshots not materialized",
                                  telemetry=Telemetry().finalize(), lineage={"missing_media": resolver.missing[:20]})
        by_step = {id(s): f for s, f in zip(steps, files, strict=True)}
        pre = (self.d.preprocessing or {}).get("preprocessing_id", "native-512x332")
        payload = build_payload(example_id, (rj.get("task") or {}).get("instruction", ""), steps,
                                lambda s: by_step[id(s)], self.prompt.text, pre)
        try:
            provider = self.provider(task_dir)
        except (JudgeSetupError, KeyError) as exc:
            return AttemptOutcome("blocked", error=f"provider setup failed: {exc}", telemetry=Telemetry().finalize())
        kw = {}
        if self.sleep is not None:
            kw["sleep"] = self.sleep
        j = self.d.judge
        sampling = {k: v for k, v in (j.get("sampling") or {}).items() if v is not None}
        return run_direct_attempt(provider, payload, j["provider_model_id"], sampling, run_dir=run_dir, task_dir=task_dir,
                                  limits=self.limits, max_rate_limit_resends=self.d.attempt_policy["rate_limit_resends_per_attempt"],
                                  cancel=cancel, **kw)


def build_judge(definition: RunDefinition, dv: DatasetVersion, media: LocalMediaStore, secrets: dict[str, str], **kw):
    if definition.judge["interface"] == "direct":
        return DirectJudge(definition, dv, media, secrets, **kw)
    return AgenticJudge(definition, dv, media, secrets, **kw)


def config_display(config_id: str) -> str:
    c = get_config(config_id)
    m = MODELS_BY_KEY[c.model_key]
    return f"{m.display_name} · {INTERFACE_LABELS[c.interface]}" + (f" · {c.preprocessing}" if c.preprocessing else "")
