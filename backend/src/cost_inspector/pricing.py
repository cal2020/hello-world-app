"""Anthropic API list prices, used to estimate what a Claude call would cost.

Claude Code transcripts record token counts but not cost, so imports from them
are priced here. The prices are the Claude API's first-party list prices in USD
per million tokens, copied from the pricing page on 2026-10-09. Subscriptions,
negotiated rates and partner platforms (Amazon Bedrock, Google Cloud) bill
differently, so every amount computed here is labeled as an estimate.

Rules applied, all from the same page:

- Cache writes are priced by duration (5 minutes or 1 hour); cache reads at the
  model's own rate.
- Fast mode replaces the input and output rates; the cache multipliers apply on
  top of the fast input rate.
- ``inference_geo: "us"`` multiplies every token price by 1.1 on Claude 4.6 and
  later models.
- Claude Haiku 5.5 bills a prompt over 100,000 tokens (input, cache reads and
  cache writes together) at its higher rate card.
- Web search costs $10 per 1,000 searches, on top of tokens.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

PRICE_LIST = "anthropic-2026-10-09"
PRICE_LIST_DATE = "2026-10-09"
PRICE_LIST_DAY = "9 October 2026"
PRICE_LIST_URL = "https://platform.claude.com/docs/en/about-claude/pricing"
CURRENCY = "USD"

#: Records whose cost was computed here carry this label, so the app can show the
#: amount as an estimate rather than as reported cost.
COST_BASIS_LABEL = "cost_basis"
COST_BASIS_ESTIMATE = "list_price_estimate"

MILLION = Decimal(1_000_000)
WEB_SEARCH_PRICE = Decimal("0.01")  # per search
US_ONLY_MULTIPLIER = Decimal("1.1")
HAIKU_5_5_LONG_PROMPT = 100_000

_DATE_SUFFIX = re.compile(r"-\d{8}$")


@dataclass(frozen=True)
class Rates:
    """USD per million tokens."""

    input: Decimal
    cache_write_5m: Decimal
    cache_write_1h: Decimal
    cache_read: Decimal
    output: Decimal

    def scaled(self, factor: Decimal) -> Rates:
        return Rates(*(getattr(self, f) * factor for f in _RATE_FIELDS))


_RATE_FIELDS = ("input", "cache_write_5m", "cache_write_1h", "cache_read", "output")


def _rates(input_: str, write_5m: str, write_1h: str, read: str, output: str) -> Rates:
    return Rates(
        Decimal(input_), Decimal(write_5m), Decimal(write_1h), Decimal(read), Decimal(output)
    )


_FABLE = _rates("10", "12.50", "20", "1", "50")
_FABLE_5_1 = _rates("10", "12.50", "20", "0.25", "50")
_OPUS_4_5_TO_5 = _rates("5", "6.25", "10", "0.50", "25")
_OPUS_4_0 = _rates("15", "18.75", "30", "1.50", "75")
_SONNET_4 = _rates("3", "3.75", "6", "0.30", "15")

#: Standard rates by model ID (without a date suffix).
STANDARD: dict[str, Rates] = {
    "claude-fable-5-1": _FABLE_5_1,
    "claude-mythos-5-1": _FABLE_5_1,
    "claude-fable-5": _FABLE,
    "claude-mythos-5": _FABLE,
    "claude-opus-5-5": _rates("4", "5", "8", "0.20", "20"),
    "claude-opus-5": _OPUS_4_5_TO_5,
    "claude-opus-4-8": _OPUS_4_5_TO_5,
    "claude-opus-4-7": _OPUS_4_5_TO_5,
    "claude-opus-4-6": _OPUS_4_5_TO_5,
    "claude-opus-4-5": _OPUS_4_5_TO_5,
    "claude-opus-4-1": _OPUS_4_0,
    "claude-opus-4": _OPUS_4_0,
    "claude-sonnet-5-5": _rates("2", "2.50", "4", "0.10", "10"),
    "claude-sonnet-5": _rates("2", "2.50", "4", "0.20", "10"),
    "claude-sonnet-4-6": _SONNET_4,
    "claude-sonnet-4-5": _SONNET_4,
    "claude-sonnet-4": _SONNET_4,
    "claude-haiku-5-5": _rates("0.10", "0.125", "0.20", "0.01", "0.50"),
    "claude-haiku-4-5": _rates("1", "1.25", "2", "0.10", "5"),
    "claude-3-5-haiku": _rates("0.80", "1", "1.60", "0.08", "4"),
}

#: Claude Haiku 5.5 for prompts over 100,000 tokens.
HAIKU_5_5_LONG = _rates("0.50", "0.625", "1", "0.05", "2.50")

#: Fast mode input and output rates.
FAST: dict[str, tuple[Decimal, Decimal]] = {
    "claude-opus-5-5": (Decimal("8"), Decimal("40")),
    "claude-opus-5": (Decimal("10"), Decimal("50")),
    "claude-opus-4-8": (Decimal("10"), Decimal("50")),
}

#: Claude 4.6 and later: the models on which US-only inference costs 1.1x.
US_ONLY_PREMIUM = frozenset(
    {
        "claude-fable-5-1",
        "claude-mythos-5-1",
        "claude-fable-5",
        "claude-mythos-5",
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-5-5",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-haiku-5-5",
    }
)


@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int = 0
    #: Output tokens excluding reasoning (thinking) tokens.
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_5m_tokens: int = 0
    cache_write_1h_tokens: int = 0

    @property
    def prompt_tokens(self) -> int:
        return (
            self.input_tokens
            + self.cache_read_tokens
            + self.cache_write_5m_tokens
            + self.cache_write_1h_tokens
        )


@dataclass(frozen=True)
class CallCost:
    """Estimated cost of one call, by AUDR ``cost.llm`` component, in USD."""

    input: Decimal
    output: Decimal
    reasoning: Decimal
    cache_read: Decimal
    cache_write: Decimal

    @property
    def total(self) -> Decimal:
        return self.input + self.output + self.reasoning + self.cache_read + self.cache_write


def model_key(name: str) -> str | None:
    """The price-list key for a first-party model ID, or ``None`` if it isn't listed.

    Accepts dated IDs such as ``claude-haiku-4-5-20251001``. Bedrock and Vertex AI
    IDs (``anthropic.…``, ``…@date``, ``…-v1:0``) are not first-party and stay unpriced.
    """
    base = _DATE_SUFFIX.sub("", name.strip().lower())
    return base if base in STANDARD else None


def rates_for(
    name: str, usage: TokenUsage, *, fast: bool = False, us_only: bool = False
) -> Rates | None:
    key = model_key(name)
    if key is None:
        return None
    rates = STANDARD[key]
    if key == "claude-haiku-5-5" and usage.prompt_tokens > HAIKU_5_5_LONG_PROMPT:
        rates = HAIKU_5_5_LONG
    if fast and key in FAST:
        fast_input, fast_output = FAST[key]
        read_multiplier = rates.cache_read / rates.input
        rates = Rates(
            input=fast_input,
            cache_write_5m=fast_input * Decimal("1.25"),
            cache_write_1h=fast_input * 2,
            cache_read=fast_input * read_multiplier,
            output=fast_output,
        )
    if us_only and key in US_ONLY_PREMIUM:
        rates = rates.scaled(US_ONLY_MULTIPLIER)
    return rates


def price_call(
    name: str, usage: TokenUsage, *, fast: bool = False, us_only: bool = False
) -> CallCost | None:
    """List-price cost of one model call, or ``None`` when the model isn't listed."""
    rates = rates_for(name, usage, fast=fast, us_only=us_only)
    if rates is None:
        return None

    def cost(tokens: int, per_million: Decimal) -> Decimal:
        return tokens * per_million / MILLION

    return CallCost(
        input=cost(usage.input_tokens, rates.input),
        output=cost(usage.output_tokens, rates.output),
        reasoning=cost(usage.reasoning_tokens, rates.output),
        cache_read=cost(usage.cache_read_tokens, rates.cache_read),
        cache_write=cost(usage.cache_write_5m_tokens, rates.cache_write_5m)
        + cost(usage.cache_write_1h_tokens, rates.cache_write_1h),
    )
