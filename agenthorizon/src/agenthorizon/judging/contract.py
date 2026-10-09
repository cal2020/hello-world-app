"""Shared judge-adapter contract.

Each evaluation receives only permitted task evidence and returns: the raw response, the parsed verdict, an
execution status, telemetry, and lineage. Telemetry counters are nullable with an explicit coverage flag:
"no telemetry" is never recorded as zero activity. Transport retries (same judgment re-sent after a transport
failure) are recorded inside an attempt; a fresh judgment is a new attempt with its own number.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Literal, Protocol

from agenthorizon.judging.parsing import Verdict

AttemptStatus = Literal[
    "completed",  # a response was obtained (it may still be an invalid verdict)
    "transport_failed",  # provider/transport errors exhausted the transport-retry budget
    "timed_out",
    "process_failed",  # harness exited non-zero
    "cancelled",
    "serving_incompatible",  # the configuration cannot represent this item faithfully (no truncation)
    "blocked",  # missing credential / identifier / instruction file / isolation backend
]

TELEMETRY_FIELDS = ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "tool_calls",
                    "images_viewed", "turns", "wall_time_s", "cost_billed_usd", "cost_estimated_usd")


@dataclass
class Telemetry:
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_input_tokens: int | None = None
    reasoning_tokens: int | None = None
    tool_calls: int | None = None
    images_viewed: int | None = None
    turns: int | None = None
    wall_time_s: float | None = None
    cost_billed_usd: float | None = None
    cost_estimated_usd: float | None = None
    currency: str = "USD"
    price_source: str | None = None
    model_reported: str | None = None
    coverage: dict[str, str] = field(default_factory=dict)  # field -> reported | estimated | unavailable

    def finalize(self) -> Telemetry:
        for f in TELEMETRY_FIELDS:
            self.coverage.setdefault(f, "unavailable" if getattr(self, f) is None else "reported")
        return self

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ArtifactRef:
    path: str  # relative to the run directory
    sha256: str
    bytes: int


@dataclass
class AttemptOutcome:
    status: AttemptStatus
    response_text: str | None = None
    verdict: Verdict | None = None
    telemetry: Telemetry = field(default_factory=Telemetry)
    transport_retries: list[dict] = field(default_factory=list)
    artifacts: dict[str, ArtifactRef] = field(default_factory=dict)
    error: str | None = None
    lineage: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["verdict"] = self.verdict.to_dict() if self.verdict else None
        return d


@dataclass
class CapabilityReport:
    config_id: str
    interface: str
    checks: dict[str, dict]  # name -> {ok: bool|None, detail}
    status: Literal["supported", "unavailable", "unverified", "blocked"]
    reasons: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


class JudgeAdapter(Protocol):
    interface: str

    def capability(self, config, secrets: dict[str, str]) -> CapabilityReport: ...


_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"AIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{16,}"),
    re.compile(r"hf_[A-Za-z0-9]{20,}"),
]


def redact(text: str, secrets: dict[str, str] | None = None) -> str:
    """Remove secret values (exact) and common key shapes from logs before they are stored."""
    out = text
    for v in (secrets or {}).values():
        if v and len(v) >= 6:
            out = out.replace(v, "[REDACTED]")
    for pat in _SECRET_PATTERNS:
        out = pat.sub(lambda m: (m.group(1) if m.groups() else "") + "[REDACTED]", out)
    return out
