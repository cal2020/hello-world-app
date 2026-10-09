"""Prices and pre-run cost forecasts. Every price carries its source and retrieval date; unknown stays unknown.

Forecasts are estimates with stated assumptions, never billed amounts:

* direct judges — input tokens from the released area-based estimator on the actual payload geometry (an upper
  bound per image when pixel dimensions are not yet known), output tokens at the configured output cap;
* agentic judges — the authors' reported mean input/output tokens per trajectory for the same model/harness row
  (S8.T1), scaled by the item's step count relative to the dataset-version mean; when no row matches, only an
  evidence-read *lower bound* (every text token and image once) is shown.

All input tokens are priced at the base input rate (caching would lower the bill). A self-hosted route has no API
charge but a non-zero, unestimated GPU cost; a subscription route is not metered per token.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md"
AUTHORS_PRICE_TABLE = "agenthorizon-repo@8584a347:scripts/compare_runs.py PRICE (\"Rough USD pricing ... Used only for cost fallback\")"


@dataclass(frozen=True)
class Price:
    route: str
    model: str
    input_per_mtok: float | None
    output_per_mtok: float | None
    cache_read_per_mtok: float | None = None
    cache_write_5m_per_mtok: float | None = None
    cache_write_1h_per_mtok: float | None = None
    currency: str = "USD"
    status: str = "official"  # official | authors_rough | operator
    source: str = ""
    retrieved: str = ""
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


PRICES: dict[tuple[str, str], Price] = {
    (p.route, p.model): p
    for p in (
        Price("anthropic", "claude-opus-4-7", 5.00, 25.00, 0.50, 6.25, 10.00, source=ANTHROPIC_PRICING_URL,
              retrieved="2026-10-09",
              notes="The authors' rough fallback table lists $15/$75 for this model; the official list price is used."),
        Price("anthropic", "claude-haiku-4-5", 1.00, 5.00, 0.10, 1.25, 2.00, source=ANTHROPIC_PRICING_URL,
              retrieved="2026-10-09"),
        Price("google", "gemini-3.1-pro-preview", 1.25, 10.00, status="authors_rough", source=AUTHORS_PRICE_TABLE,
              retrieved="2026-06-09 (file commit date)",
              notes="Official Gemini pricing page unreachable from this environment (egress policy); unverified."),
        Price("google", "gemini-3.1-flash-lite-preview", 0.10, 0.40, status="authors_rough", source=AUTHORS_PRICE_TABLE,
              retrieved="2026-06-09 (file commit date)",
              notes="Official Gemini pricing page unreachable from this environment (egress policy); unverified."),
    )
}

UNMETERED_ROUTES = {
    "vllm": "self-hosted: no API charge; GPU operating cost is real but not estimated here",
    "chatgpt_subscription": "ChatGPT subscription: not metered per token; usage counts against plan limits",
}


def price_for(route: str | None, model: str | None, override: dict | None = None) -> Price | None:
    if override:
        return Price(route or "?", model or "?", override.get("input_per_mtok"), override.get("output_per_mtok"),
                     override.get("cache_read_per_mtok"), status="operator", source=override.get("source", "operator"),
                     retrieved=override.get("retrieved", ""), notes="operator-supplied price")
    if not route or not model:
        return None
    bare = model.split("/", 1)[1] if route in ("openrouter",) and "/" in model else model
    return PRICES.get((route, model)) or PRICES.get(("google" if route == "openrouter" else route, bare))


def cost(price: Price | None, input_tokens: int | None, output_tokens: int | None,
         cached_input_tokens: int | None = None) -> float | None:
    """Token-based estimate. ``input_tokens`` counts every prompt token; ``cached_input_tokens`` is the subset read
    from cache (billed at the cache-read rate when known). Cache-write premiums are not modelled."""
    if price is None or price.input_per_mtok is None or price.output_per_mtok is None:
        return None
    if input_tokens is None or output_tokens is None:
        return None
    cached = min(cached_input_tokens or 0, input_tokens)
    rate_cached = price.cache_read_per_mtok if price.cache_read_per_mtok is not None else price.input_per_mtok
    return ((input_tokens - cached) * price.input_per_mtok + cached * rate_cached
            + output_tokens * price.output_per_mtok) / 1e6


def route_cost_basis(route: str | None, price: Price | None) -> dict:
    if route in UNMETERED_ROUTES:
        return {"metered": False, "note": UNMETERED_ROUTES[route]}
    if price is None:
        return {"metered": True, "price_known": False,
                "note": "no verified price for this route/model; supply an operator price to enforce a USD budget"}
    return {"metered": True, "price_known": True, "price": price.to_dict()}
