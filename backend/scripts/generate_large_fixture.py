"""Generate a synthetic AUDR file at the import limit, for performance measurement.

    uv run python scripts/generate_large_fixture.py OUT.jsonl [--records 10000] [--runs 5]

Deterministic (seeded). Every value is synthetic. Not used by the test suite.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import UTC, datetime, timedelta
from pathlib import Path

MODELS = [
    ("anthropic", "claude-sonnet-4-5"),
    ("anthropic", "claude-haiku-4-5"),
    ("openai", "gpt-5-mini"),
]
STEPS = ["classify-intent", "draft-reply", "validate-format", "summarize", "extract-fields", "plan"]
TOOLS = ["kb_search", "crm_lookup", "web_fetch"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("--records", type=int, default=10_000)
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()
    rng = random.Random(4821)  # noqa: S311 - deterministic synthetic data, not security
    start = datetime(2026, 10, 6, 8, 0, tzinfo=UTC)
    per_run = args.records // args.runs
    lines = []
    for run in range(args.runs):
        clock = start + timedelta(hours=run)
        run_id = f"run-perf-{run:04d}"
        for step in range(1, per_run + 1):
            duration = rng.randint(80, 2400)
            clock += timedelta(milliseconds=duration + 15)
            is_tool = step % 4 == 0
            record = {
                "spec_version": "1.0.0",
                "record_id": f"01KPERF{run:03d}{step:016d}",
                "emitter": {
                    "component": "harness" if is_tool else "router",
                    "name": "perf",
                    "version": "1",
                },
                "timing": {
                    "event_time": clock.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    "duration_ms": duration,
                },
                "run": {
                    "run_id": run_id,
                    "name": f"Synthetic load run {run}",
                    "span_id": f"s{step}",
                    "step": step,
                    "run_type": "agent_run",
                },
                "attribution": {"environment": "test", "labels": {"step": rng.choice(STEPS)}},
            }
            if is_tool:
                record["resource"] = {
                    "provider": "self-hosted",
                    "type": "tool",
                    "name": rng.choice(TOOLS),
                    "operation": "tool_execution",
                }
                record["usage"] = {"tool": {"type": "invocation", "call_count": 1}}
                if rng.random() < 0.7:
                    record["cost"] = {"total_cost": 0.001, "currency": "USD"}
            else:
                provider, model = rng.choice(MODELS)
                inp = rng.choice([400, 800, 1200, 1800, 3200, 5200])
                out = rng.choice([40, 60, 120, 400, 900])
                record["resource"] = {
                    "provider": provider,
                    "type": "model",
                    "name": model,
                    "operation": "generation",
                    "modality": "text",
                }
                record["usage"] = {
                    "llm": {"input_tokens": inp, "output_tokens": out, "requests": 1}
                }
                total = round((inp * 3 + out * 15) / 1_000_000, 6)
                record["cost"] = {"total_cost": total, "currency": "USD"}
            lines.append(json.dumps(record, separators=(",", ":")))
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(lines)} records, {args.out.stat().st_size:,} bytes to {args.out}")


if __name__ == "__main__":
    main()
