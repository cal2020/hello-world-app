"""Pre-request serving-limit checks for direct judges.

Only limits with a stated source are filled in; everything else is ``None`` and reported as *unverified* rather
than guessed. Operators can supply verified values per run (e.g. a vLLM server's ``--limit-mm-per-prompt`` and
``--max-model-len``). A payload that violates a known limit is never truncated: the caller may switch to the
protocol's mosaic packaging, and otherwise the item is ``serving_incompatible``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

MB = 1024 * 1024


@dataclass
class ProviderLimits:
    route: str
    model: str | None = None
    max_images: int | None = None
    max_request_bytes: int | None = None
    context_tokens: int | None = None
    supports_images: bool | None = None
    sources: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


KNOWN: dict[tuple[str, str | None], ProviderLimits] = {
    ("anthropic", "claude-opus-4-7"): ProviderLimits(
        "anthropic", "claude-opus-4-7", max_request_bytes=32 * MB, context_tokens=1_000_000, supports_images=True,
        sources={"max_request_bytes": "claude-api skill: 32 MB request limit (413 request_too_large)",
                 "context_tokens": "claude-api skill model table (cached 2026-10-06)"}),
    ("anthropic", "claude-haiku-4-5"): ProviderLimits(
        "anthropic", "claude-haiku-4-5", max_request_bytes=32 * MB, context_tokens=200_000, supports_images=True,
        sources={"max_request_bytes": "claude-api skill: 32 MB request limit (413 request_too_large)",
                 "context_tokens": "claude-api skill model table (cached 2026-10-06)"}),
}


def limits_for(route: str, model: str | None, overrides: dict | None = None) -> ProviderLimits:
    base = KNOWN.get((route, model)) or KNOWN.get((route, None)) or ProviderLimits(route, model)
    lim = ProviderLimits(**{**base.to_dict(), "sources": dict(base.sources)})
    for k, v in (overrides or {}).items():
        if hasattr(lim, k) and k not in ("route", "model", "sources"):
            setattr(lim, k, v)
            lim.sources[k] = "operator override"
    return lim


def check(payload_images: int, payload_bytes: int, token_estimate: int, lim: ProviderLimits) -> dict:
    violations, unverified = [], []
    for name, value, limit in (("images", payload_images, lim.max_images),
                               ("request_bytes", payload_bytes, lim.max_request_bytes),
                               ("context_tokens_estimate", token_estimate, lim.context_tokens)):
        if limit is None:
            unverified.append(name)
        elif value > limit:
            violations.append({"limit": name, "value": value, "max": limit})
    if lim.supports_images is False and payload_images:
        violations.append({"limit": "supports_images", "value": payload_images, "max": 0})
    return {"fits": not violations, "violations": violations, "unverified": unverified,
            "note": "token counts use the released area-based estimator, not a provider tokenizer"}
