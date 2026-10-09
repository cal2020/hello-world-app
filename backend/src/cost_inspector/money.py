"""Decimal-safe money arithmetic.

Costs come from the original JSON text as ``Decimal`` and are never routed
through binary floating point. Totals are kept per currency and never
combined across currencies. A call without a reported cost is *unknown*: it is
counted separately and contributes nothing to any total. A cost the importer
estimated at list prices (Claude Code transcripts) counts as known, and
``estimated_calls`` says how many of the known costs are such estimates.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from typing import Any, Literal, Protocol

from .ingest.normalize import decimal_str

PERCENT_PLACES = Decimal("0.01")


class HasCost(Protocol):
    @property
    def cost_total(self) -> Decimal | None: ...

    @property
    def cost_currency(self) -> str | None: ...


CostBasis = Literal["none", "reported", "estimated", "mixed"]


@dataclass(frozen=True)
class Spend:
    by_currency: dict[str, Decimal]
    known_calls: int
    unknown_calls: int
    #: Known costs that are list-price estimates rather than reported amounts.
    estimated_calls: int = 0

    @property
    def total_calls(self) -> int:
        return self.known_calls + self.unknown_calls

    @property
    def complete(self) -> bool:
        return self.unknown_calls == 0 and self.total_calls > 0

    @property
    def basis(self) -> CostBasis:
        if self.known_calls == 0:
            return "none"
        if self.estimated_calls == 0:
            return "reported"
        return "estimated" if self.estimated_calls == self.known_calls else "mixed"

    def to_json(self) -> dict[str, Any]:
        return {
            "by_currency": money_list(self.by_currency),
            "known_calls": self.known_calls,
            "unknown_calls": self.unknown_calls,
            "total_calls": self.total_calls,
            "complete": self.complete,
            "estimated_calls": self.estimated_calls,
            "basis": self.basis,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Spend:
        return cls(
            by_currency={m["currency"]: Decimal(m["amount"]) for m in data["by_currency"]},
            known_calls=int(data["known_calls"]),
            unknown_calls=int(data["unknown_calls"]),
            estimated_calls=int(data.get("estimated_calls", 0)),
        )


def money_list(amounts: dict[str, Decimal]) -> list[dict[str, str]]:
    return [
        {"currency": currency, "amount": decimal_str(amount)}
        for currency, amount in sorted(amounts.items())
    ]


def summarize_spend(calls: Iterable[HasCost]) -> Spend:
    totals: dict[str, Decimal] = {}
    known = unknown = estimated = 0
    for call in calls:
        if call.cost_total is None or call.cost_currency is None:
            unknown += 1
            continue
        known += 1
        estimated += bool(getattr(call, "cost_is_estimate", False))
        totals[call.cost_currency] = totals.get(call.cost_currency, Decimal(0)) + call.cost_total
    return Spend(dict(sorted(totals.items())), known, unknown, estimated)


def percent_change(baseline: Decimal, candidate: Decimal) -> Decimal | None:
    """Percentage change from ``baseline`` to ``candidate``, rounded half-even to 0.01.

    Returns ``None`` when the baseline is zero: the change is undefined, and
    callers report the absolute change only.
    """
    if baseline == 0:
        return None
    with localcontext() as ctx:
        ctx.prec = 60
        return ((candidate - baseline) / baseline * 100).quantize(
            PERCENT_PLACES, rounding=ROUND_HALF_EVEN
        )


def scale(amount: Decimal, ratio: Decimal) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 60
        return amount * ratio
