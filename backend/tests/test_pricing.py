"""List-price estimates for Claude calls (prices as published on 2026-10-09)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from cost_inspector import pricing
from cost_inspector.pricing import TokenUsage, model_key, price_call

#: Cache-read multiplier of base input, per the pricing page's footnotes.
READ_MULTIPLIER = {
    "claude-fable-5-1": Decimal("0.025"),
    "claude-mythos-5-1": Decimal("0.025"),
    "claude-opus-5-5": Decimal("0.05"),
    "claude-sonnet-5-5": Decimal("0.05"),
}


@pytest.mark.parametrize("model", sorted(pricing.STANDARD))
def test_every_listed_model_follows_the_published_cache_multipliers(model: str) -> None:
    rates = pricing.STANDARD[model]
    assert rates.cache_write_5m == rates.input * Decimal("1.25")
    assert rates.cache_write_1h == rates.input * 2
    assert rates.cache_read == rates.input * READ_MULTIPLIER.get(model, Decimal("0.1"))


def test_haiku_5_5_long_prompt_card_follows_the_same_multipliers() -> None:
    long = pricing.HAIKU_5_5_LONG
    assert (long.cache_write_5m, long.cache_write_1h, long.cache_read) == (
        long.input * Decimal("1.25"),
        long.input * 2,
        long.input * Decimal("0.1"),
    )


@pytest.mark.parametrize(
    ("name", "key"),
    [
        ("claude-opus-5-5", "claude-opus-5-5"),
        ("claude-opus-5", "claude-opus-5"),
        ("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
        ("claude-sonnet-4-20250514", "claude-sonnet-4"),
        ("claude-3-5-haiku-20241022", "claude-3-5-haiku"),
        ("Claude-Opus-4-8", "claude-opus-4-8"),
        ("anthropic.claude-opus-5-5", None),
        ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", None),
        ("claude-opus-4-5@20251101", None),
        ("gpt-5", None),
    ],
)
def test_model_ids_resolve_to_first_party_prices_only(name: str, key: str | None) -> None:
    assert model_key(name) == key


def test_opus_5_5_call_is_priced_per_component() -> None:
    cost = price_call(
        "claude-opus-5-5",
        TokenUsage(
            input_tokens=3,
            output_tokens=380,
            reasoning_tokens=120,
            cache_read_tokens=40_000,
            cache_write_1h_tokens=2_000,
        ),
    )
    assert cost is not None
    assert cost.input == Decimal("0.000012")
    assert cost.output == Decimal("0.0076")
    assert cost.reasoning == Decimal("0.0024")
    assert cost.cache_read == Decimal("0.008")
    assert cost.cache_write == Decimal("0.016")
    assert cost.total == Decimal("0.034012")


def test_five_minute_and_one_hour_writes_have_their_own_rates() -> None:
    cost = price_call(
        "claude-sonnet-4-6",
        TokenUsage(cache_write_5m_tokens=1_000_000, cache_write_1h_tokens=1_000_000),
    )
    assert cost is not None and cost.cache_write == Decimal("3.75") + Decimal("6")


def test_fast_mode_replaces_rates_and_keeps_the_cache_multipliers() -> None:
    usage = TokenUsage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_write_5m_tokens=1_000_000,
        cache_write_1h_tokens=1_000_000,
    )
    cost = price_call("claude-opus-5-5", usage, fast=True)
    assert cost is not None
    assert (cost.input, cost.output, cost.cache_read) == (Decimal(8), Decimal(40), Decimal("0.4"))
    assert cost.cache_write == Decimal(10) + Decimal(16)
    opus_4_8 = price_call("claude-opus-4-8", usage, fast=True)
    assert opus_4_8 is not None and (opus_4_8.input, opus_4_8.cache_read) == (
        Decimal(10),
        Decimal(1),
    )


def test_fast_mode_on_a_model_without_it_bills_standard_rates() -> None:
    usage = TokenUsage(input_tokens=1_000_000)
    assert price_call("claude-opus-4-6", usage, fast=True) == price_call("claude-opus-4-6", usage)


def test_us_only_inference_costs_more_on_claude_4_6_and_later_only() -> None:
    usage = TokenUsage(input_tokens=1_000_000, output_tokens=1_000_000)
    us = price_call("claude-sonnet-4-6", usage, us_only=True)
    assert us is not None and us.total == (Decimal(3) + Decimal(15)) * Decimal("1.1")
    assert price_call("claude-haiku-4-5", usage, us_only=True) == price_call(
        "claude-haiku-4-5", usage
    )
    fast_us = price_call("claude-opus-5-5", usage, fast=True, us_only=True)
    assert fast_us is not None and fast_us.total == Decimal("48") * Decimal("1.1")


def test_haiku_5_5_prices_prompts_over_100k_tokens_at_the_higher_card() -> None:
    at_limit = TokenUsage(input_tokens=20_000, cache_read_tokens=80_000, output_tokens=1_000_000)
    over = TokenUsage(input_tokens=20_000, cache_read_tokens=80_001, output_tokens=1_000_000)
    standard = price_call("claude-haiku-5-5", at_limit)
    long = price_call("claude-haiku-5-5", over)
    assert standard is not None and standard.output == Decimal("0.5")
    assert long is not None and long.output == Decimal("2.5")
    assert long.cache_read == Decimal("80001") * Decimal("0.05") / pricing.MILLION


def test_unknown_models_have_no_price() -> None:
    assert price_call("gpt-5", TokenUsage(input_tokens=10)) is None
