"""Generate the synthetic AUDR demo files shipped with AI Cost Inspector.

    uv run python scripts/generate_demo_data.py          # rewrite the files
    uv run python scripts/generate_demo_data.py --table  # print the cost tables

Every value is synthetic. Costs are computed exactly (Decimal) from the
illustrative per-million-token rates in RATES, which are NOT provider prices.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

OUT = Path(__file__).resolve().parents[1] / "src" / "cost_inspector" / "demo"
EMITTER_VERSION = "0.1.0"
EMITTER_NAME = "ai-cost-inspector-demo"
M = Decimal(1_000_000)

# Illustrative synthetic rates per 1M tokens: (currency, input, output, cache_read, reasoning).
RATES: dict[str, tuple[str, Decimal, Decimal, Decimal, Decimal]] = {
    "claude-sonnet-4-5": ("USD", Decimal(3), Decimal(15), Decimal("0.30"), Decimal(15)),
    "claude-haiku-4-5": ("USD", Decimal(1), Decimal(5), Decimal("0.10"), Decimal(5)),
    "gpt-5": ("USD", Decimal("1.25"), Decimal(10), Decimal("0.125"), Decimal(10)),
    "gpt-5-mini": ("USD", Decimal("0.25"), Decimal(2), Decimal("0.025"), Decimal(2)),
    "mistral-large-2411": ("EUR", Decimal(2), Decimal(6), Decimal(0), Decimal(6)),
    "llama-3.1-8b-instruct": ("USD", Decimal(0), Decimal(0), Decimal(0), Decimal(0)),
}
PROVIDERS = {
    "claude-sonnet-4-5": "anthropic",
    "claude-haiku-4-5": "anthropic",
    "gpt-5": "openai",
    "gpt-5-mini": "openai",
    "mistral-large-2411": "mistral",
    "llama-3.1-8b-instruct": "self-hosted",
}
# Synthetic per-call tool charges (USD). None = the emitter asserted no cost.
TOOL_COSTS: dict[str, Decimal | None] = {
    "crm_lookup": Decimal("0.001"),
    "kb_search": Decimal("0.002"),
    "reply_format_validator": Decimal(0),
    "agent_loop": Decimal(0),
    "web_fetch": None,
}


def _num(value: Decimal) -> float | int:
    """JSON number with the exact decimal spelling (shortest float repr round-trips)."""
    if value == value.to_integral_value():
        return int(value)
    as_float = float(value)
    assert Decimal(repr(as_float)) == value, value
    return as_float


class RunBuilder:
    def __init__(self, tag: str, run_id: str, name: str, start: datetime, feature: str) -> None:
        self.tag, self.run_id, self.name, self.feature = tag, run_id, name, feature
        self.clock = start
        self.records: list[dict[str, Any]] = []
        self.rows: list[tuple[int, str, str, str, str]] = []
        self.last_model_span: str | None = None

    def _base(
        self, step: int, span: str, component: str, duration_ms: int, labels: dict[str, str]
    ) -> dict[str, Any]:
        self.clock += timedelta(milliseconds=duration_ms + 40)
        return {
            "spec_version": "1.0.0",
            "record_id": f"01K6T4821{self.tag}".ljust(24, "0") + f"{step:02d}",
            "emitter": {"component": component, "name": EMITTER_NAME, "version": EMITTER_VERSION},
            "timing": {
                "event_time": self.clock.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "duration_ms": duration_ms,
            },
            "run": {
                "run_id": self.run_id,
                "name": self.name,
                "span_id": span,
                "step": step,
                "run_type": "agent_run",
            },
            "attribution": {
                "environment": "development",
                "labels": {"feature": self.feature, **labels, "dataset": "synthetic-demo"},
            },
        }

    def model(
        self,
        step: int,
        model: str,
        purpose: str,
        duration_ms: int,
        *,
        inp: int,
        out: int,
        cache_read: int = 0,
        reasoning: int = 0,
        cost: bool = True,
    ) -> None:
        span = f"model-{step}"
        record = self._base(step, span, "router", duration_ms, {"step": purpose})
        record["resource"] = {
            "provider": PROVIDERS[model],
            "type": "model",
            "name": model,
            "operation": "generation",
            "modality": "text",
        }
        llm: dict[str, int] = {"input_tokens": inp, "output_tokens": out, "requests": 1}
        if cache_read:
            llm["cache_read_tokens"] = cache_read
        if reasoning:
            llm["reasoning_tokens"] = reasoning
        record["usage"] = {"llm": llm}
        currency, r_in, r_out, r_cache, r_reason = RATES[model]
        parts = {
            "input_token_cost": inp * r_in / M,
            "output_token_cost": out * r_out / M,
            "cache_read_cost": cache_read * r_cache / M,
            "reasoning_cost": reasoning * r_reason / M,
        }
        total = sum(parts.values(), Decimal(0))
        shown = "not reported"
        if cost:
            breakdown: dict[str, float | int] = {"total_token_cost": _num(total)}
            for key, value in parts.items():
                if value or key in ("input_token_cost", "output_token_cost"):
                    breakdown[key] = _num(value)
            record["cost"] = {"total_cost": _num(total), "currency": currency, "llm": breakdown}
            shown = f"{currency} {total.normalize():f}"
        self.records.append(record)
        self.rows.append(
            (
                step,
                f"model `{model}`",
                purpose,
                f"{inp}/{out}"
                + (f" (+{cache_read} cache read)" if cache_read else "")
                + (f" (+{reasoning} reasoning)" if reasoning else ""),
                shown,
            )
        )
        self.last_model_span = span

    def tool(
        self,
        step: int,
        tool: str,
        purpose: str,
        duration_ms: int,
        *,
        operation: str = "tool_execution",
        tool_type: str = "invocation",
        outcome: str | None = None,
    ) -> None:
        record = self._base(step, f"tool-{step}", "harness", duration_ms, {"step": purpose})
        if self.last_model_span:
            record["run"]["parent_span_id"] = self.last_model_span
        if outcome:
            record["run"]["outcome"] = outcome
        record["resource"] = {
            "provider": "self-hosted",
            "type": "tool",
            "name": tool,
            "operation": operation,
        }
        record["usage"] = {"tool": {"type": tool_type, "call_count": 1}}
        charge = TOOL_COSTS[tool]
        shown = "not reported"
        if charge is not None:
            record["cost"] = {
                "total_cost": _num(charge),
                "currency": "USD",
                "tool": {"type": tool_type, "call_cost": _num(charge)},
            }
            shown = f"USD {charge.normalize():f}"
        self.records.append(record)
        self.rows.append((step, f"tool `{tool}`", purpose, "—", shown))


def build() -> dict[str, list[RunBuilder]]:
    t0 = datetime(2026, 10, 6, 9, 0, 0, tzinfo=UTC)
    before = RunBuilder(
        "BEF",
        "run-demo-ticket-4821-before",
        "Resolve billing ticket T-4821 (baseline)",
        t0,
        "billing-support",
    )
    before.model(1, "claude-sonnet-4-5", "classify-intent", 920, inp=1800, out=60)
    before.model(2, "claude-sonnet-4-5", "classify-intent", 880, inp=1800, out=60)
    before.tool(3, "crm_lookup", "lookup-account", 210, tool_type="api")
    before.model(4, "claude-sonnet-4-5", "draft-reply", 2410, inp=5200, out=900, cache_read=2400)
    before.tool(
        5, "kb_search", "search-help-center", 330, operation="retrieval", tool_type="retrieval"
    )
    before.model(6, "claude-sonnet-4-5", "validate-reply-format", 760, inp=1400, out=40)
    before.model(7, "claude-sonnet-4-5", "validate-reply-format", 740, inp=1400, out=40)
    before.model(8, "claude-sonnet-4-5", "classify-intent", 900, inp=1800, out=60)
    before.model(9, "claude-sonnet-4-5", "summarize-for-crm", 1320, inp=3000, out=400)
    before.model(10, "claude-sonnet-4-5", "final-answer", 2050, inp=2600, out=700, reasoning=300)
    before.tool(11, "agent_loop", "run-summary", 120, outcome="resolved")

    after = RunBuilder(
        "AFT",
        "run-demo-ticket-4821-after",
        "Resolve billing ticket T-4821 (after changes)",
        t0 + timedelta(hours=3),
        "billing-support",
    )
    after.model(1, "claude-haiku-4-5", "classify-intent", 410, inp=1800, out=60)
    after.tool(2, "crm_lookup", "lookup-account", 205, tool_type="api")
    after.model(3, "claude-sonnet-4-5", "draft-reply", 2380, inp=5200, out=900, cache_read=2400)
    after.tool(
        4, "kb_search", "search-help-center", 320, operation="retrieval", tool_type="retrieval"
    )
    after.tool(5, "reply_format_validator", "validate-reply-format", 12)
    after.model(6, "claude-sonnet-4-5", "summarize-for-crm", 1290, inp=3000, out=400)
    after.model(7, "claude-sonnet-4-5", "final-answer", 2010, inp=2600, out=700, reasoning=300)
    after.tool(8, "agent_loop", "run-summary", 110, outcome="resolved")

    t1 = datetime(2026, 10, 6, 2, 0, 0, tzinfo=UTC)
    eu = RunBuilder(
        "DEU", "run-demo-digest-eu-0001", "Nightly digest (EU workspace)", t1, "nightly-digest"
    )
    eu.model(1, "mistral-large-2411", "compose-digest", 1850, inp=2000, out=500)
    eu.tool(2, "web_fetch", "fetch-sources", 640)
    eu.model(3, "gpt-5-mini", "extract-highlights", 700, inp=1200, out=200)
    eu.model(4, "llama-3.1-8b-instruct", "tag-topics", 380, inp=900, out=150)
    us = RunBuilder(
        "DUS",
        "run-demo-digest-us-0001",
        "Nightly digest (US workspace)",
        t1 + timedelta(minutes=30),
        "nightly-digest",
    )
    us.model(1, "gpt-5-mini", "extract-highlights", 690, inp=1200, out=200)
    us.model(2, "gpt-5", "compose-digest", 1400, inp=1500, out=300, cost=False)
    us.tool(3, "web_fetch", "fetch-sources", 610)
    return {
        "support-agent-before.jsonl": [before],
        "support-agent-after.jsonl": [after],
        "nightly-digest-partial-telemetry.jsonl": [eu, us],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--table", action="store_true", help="print markdown cost tables")
    args = parser.parse_args()
    files = build()
    for filename, runs in files.items():
        if args.table:
            for run in runs:
                print(f"\n**{run.name}** (`{run.run_id}`, file `{filename}`)\n")
                print("| Step | Call | Purpose label | Tokens in/out | Reported cost |")
                print("| ---: | --- | --- | --- | --- |")
                for step, call, purpose, tokens, cost in run.rows:
                    print(f"| {step} | {call} | {purpose} | {tokens} | {cost} |")
            continue
        lines = [json.dumps(r, separators=(",", ":")) for run in runs for r in run.records]
        (OUT / filename).write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"wrote {OUT / filename} ({len(lines)} records)")


if __name__ == "__main__":
    main()
