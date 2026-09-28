"""Live-model compiler adapter (brief §8 steps 4-7) on the official ``anthropic`` SDK.

``LLMCompilerModel`` implements :class:`~hexis_service.compiler.compile.CompilerModel`. It proposes a
draft; it never admits. Its output goes through the same strict parse, schema validation, static
validator, bounded repair, normalization and admission gates as the fixture compiler's.

* The model id is always explicit (no silent default).
* Credentials come only from the SDK's own environment resolution (``ANTHROPIC_API_KEY`` /
  ``ANTHROPIC_AUTH_TOKEN`` / ``ant auth`` profile); they never enter prompts, manifests or drafts.
* The prompt is a versioned template under ``compiler/prompts/`` filled ONLY with the context
  :func:`build_context` provides, the efsm-v1 / Contracts JSON Schemas and the previous attempt's
  validator diagnostics. Its digest is recorded in ``compiler_manifest.prompts_sha256``.
* Streaming (``messages.stream`` + ``get_final_message()``) because compiled machines are large; no
  assistant prefill. ``output_config.format`` is NOT used: the efsm-v1 schema is recursive and uses
  constructs structured outputs does not support, so the output is parsed and validated locally.
* Refusal, ``max_tokens`` truncation, non-JSON, duplicate keys and schema-invalid drafts are returned as
  ``{"malformed": {...}}`` so ``compile_skill`` records a malformed attempt with a diagnostic for the
  next attempt (bounded by ``max_attempts``) instead of crashing.

IMPLEMENTED, NOT EXECUTED LIVE in this repository: unit tests use an injected fake client.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from importlib import resources
from typing import Any, Optional

from ..artifacts.efsm import Machine, load_machine
from ..artifacts.package import Contracts
from ..canonical import CanonicalError, sha256_hex, strict_loads

PROMPT_TEMPLATE = "compile_v1"
_PLACEHOLDER = re.compile(r"\{\{([A-Z_]+)\}\}")


class CompilerModelUnavailable(RuntimeError):
    """The SDK, credentials or the provider endpoint are unavailable (not a malformed draft)."""


@lru_cache(maxsize=None)
def load_prompt_template(version: str = PROMPT_TEMPLATE) -> tuple[str, str, str]:
    """Return ``(system, user_template, sha256)``; the digest covers both files and their names."""
    base = resources.files(__package__).joinpath("prompts")
    system = base.joinpath(f"{version}.system.md").read_text(encoding="utf-8")
    user = base.joinpath(f"{version}.user.md").read_text(encoding="utf-8")
    digest = sha256_hex(json.dumps({"version": version, f"{version}.system.md": system,
                                    f"{version}.user.md": user}, sort_keys=True, ensure_ascii=False))
    return system, user, digest


def _data(value: Any) -> str:
    """JSON-encode a data block; ``<``/``>`` are escaped so document text cannot close a tagged block."""
    return (json.dumps(value, indent=1, sort_keys=True, ensure_ascii=False)
            .replace("<", "\\u003c").replace(">", "\\u003e"))


@lru_cache(maxsize=1)
def _schemas() -> tuple[str, str]:
    return (_data(Machine.model_json_schema(by_alias=True)), _data(Contracts.model_json_schema(by_alias=True)))


def render_prompt(context: dict, diagnostics: list[dict], attempt: int,
                  version: str = PROMPT_TEMPLATE) -> tuple[str, str]:
    """Fill the template in a single pass (substituted data is never re-scanned for placeholders)."""
    system, user, _ = load_prompt_template(version)
    machine_schema, contracts_schema = _schemas()
    values = {
        "ATTEMPT": str(int(attempt)),
        "CLAUSES": _data(context["clauses"]),
        "TOOLS": _data(context["tools"]),
        "GUARD_GRAMMAR": str(context["guard_grammar"]),
        "ACTION_KINDS": _data(list(context["action_kinds"])),
        "TERMINAL_CATEGORIES": _data(list(context["terminal_categories"])),
        "TASK_INPUT_SCHEMA": _data(context["task_input_schema"]),
        "CAPABILITY_CEILING": _data(list(context["capability_ceiling"])),
        "MAX_LOOP_BOUND": str(int(context["max_loop_bound"])),
        "MACHINE_SCHEMA": machine_schema,
        "CONTRACTS_SCHEMA": contracts_schema,
        "DIAGNOSTICS": _data(list(diagnostics)),
    }
    missing = sorted(set(_PLACEHOLDER.findall(user)) - set(values))
    if missing:
        raise ValueError(f"prompt template {version} has unknown placeholders {missing}")
    return system, _PLACEHOLDER.sub(lambda m: values[m.group(1)], user)


def _malformed(code: str, message: str, **detail: Any) -> dict:
    out: dict = {"code": code, "message": message[:2000]}
    if detail:
        out["detail"] = detail
    return {"malformed": out}


def _strip_outer_fence(text: str) -> str:
    """Accept exactly one outer ```json fence around the whole reply; anything else is parsed as-is."""
    t = text.strip()
    m = re.fullmatch(r"```(?:json)?\n(.*)\n```", t, flags=re.DOTALL)
    return m.group(1) if m else t


def parse_draft(text: str) -> dict:
    """Strictly parse and validate a reply. Returns ``{"machine", "contracts"}`` or ``{"malformed": ...}``."""
    try:
        obj = strict_loads(_strip_outer_fence(text))
    except CanonicalError as exc:
        return _malformed("DRAFT_NOT_JSON", f"reply is not strict JSON: {exc}")
    if not isinstance(obj, dict) or set(obj) != {"machine", "contracts"}:
        keys = sorted(obj) if isinstance(obj, dict) else type(obj).__name__
        return _malformed("DRAFT_SCHEMA", f"reply must be an object with exactly the keys 'machine' and "
                                          f"'contracts' (got {keys})")
    try:
        load_machine(obj["machine"])
    except Exception as exc:  # noqa: BLE001 - schema failures are diagnostics
        return _malformed("DRAFT_SCHEMA", f"machine is not a valid efsm-v1 machine: {exc}")
    try:
        Contracts.model_validate(obj["contracts"])
    except Exception as exc:  # noqa: BLE001
        return _malformed("DRAFT_SCHEMA", f"contracts are invalid: {exc}")
    return {"machine": obj["machine"], "contracts": obj["contracts"]}


def _default_client(timeout_s: float) -> Any:
    try:
        import anthropic  # optional dependency: hexis-service[anthropic]
    except ImportError as exc:
        raise CompilerModelUnavailable("the 'anthropic' SDK is not installed (pip install "
                                       "'hexis-service[anthropic]')") from exc
    try:
        client = anthropic.Anthropic(timeout=timeout_s)
    except Exception as exc:  # noqa: BLE001 - e.g. a broken credentials profile
        raise CompilerModelUnavailable(f"could not configure the Anthropic client: {type(exc).__name__}") from exc
    if not (getattr(client, "api_key", None) or getattr(client, "auth_token", None)
            or getattr(client, "credentials", None)):
        raise CompilerModelUnavailable("no Anthropic credentials resolved from the environment "
                                       "(set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or run 'ant auth login')")
    return client


class LLMCompilerModel:
    def __init__(self, model_id: str, *, client: Any = None, max_tokens: int = 64000,
                 effort: Optional[str] = "high", timeout_s: float = 900.0,
                 prompt_template: str = PROMPT_TEMPLATE):
        if not model_id or not model_id.strip():
            raise ValueError("model_id must be explicit")
        self.model_id, self.max_tokens, self.effort = model_id, int(max_tokens), effort
        self.prompt_template = prompt_template
        _, _, self.prompt_template_sha256 = load_prompt_template(prompt_template)
        self.settings = {"provider": "anthropic", "max_tokens": self.max_tokens, "effort": effort,
                         "streaming": True, "prompt_template": prompt_template,
                         "prompt_template_sha256": self.prompt_template_sha256}
        self.client = client if client is not None else _default_client(timeout_s)
        self.usage: list[dict] = []

    def request(self, context: dict, diagnostics: list[dict], attempt: int) -> dict:
        system, user = render_prompt(context, diagnostics, attempt, self.prompt_template)
        kw: dict = {"model": self.model_id, "max_tokens": self.max_tokens, "system": system,
                    "messages": [{"role": "user", "content": user}]}  # single user turn: no prefill
        if self.effort:
            kw["output_config"] = {"effort": self.effort}
        return kw

    def draft(self, context: dict, diagnostics: list[dict], attempt: int) -> dict:
        kw = self.request(context, diagnostics, attempt)
        try:
            with self.client.messages.stream(**kw) as stream:
                msg = stream.get_final_message()
        except Exception as exc:  # noqa: BLE001 - classify: SDK/transport errors are not drafts
            if _is_sdk_error(exc):
                raise CompilerModelUnavailable(f"compiler model call failed: {type(exc).__name__}: {exc}") from exc
            raise
        usage = getattr(msg, "usage", None)
        self.usage.append({"attempt": attempt, "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
                           "output_tokens": int(getattr(usage, "output_tokens", 0) or 0)})
        stop = getattr(msg, "stop_reason", None)
        if stop == "refusal":
            return _malformed("DRAFT_REFUSED", "the model refused to produce a draft (stop_reason=refusal)")
        if stop == "max_tokens":
            return _malformed("DRAFT_TRUNCATED", f"the draft was truncated at max_tokens={self.max_tokens}; "
                                                 "produce a more compact machine")
        text = "".join(getattr(b, "text", "") for b in getattr(msg, "content", []) or []
                       if getattr(b, "type", "") == "text")
        if not text.strip():
            return _malformed("DRAFT_EMPTY", f"the reply contained no text (stop_reason={stop})")
        return parse_draft(text)


def _is_sdk_error(exc: Exception) -> bool:
    try:
        import anthropic
    except ImportError:  # pragma: no cover
        return False
    return isinstance(exc, anthropic.AnthropicError)
