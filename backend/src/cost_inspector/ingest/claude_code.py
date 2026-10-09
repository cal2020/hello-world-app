"""Claude Code session transcripts, converted to AUDR records.

Claude Code saves each session as ``~/.claude/projects/<project>/<session-id>.jsonl``
and each subagent as ``<session-id>/subagents/agent-<id>.jsonl``. Every API response
appears as one ``assistant`` entry per content block; the entries share the request's
``requestId`` and carry its ``usage``. The converter keeps one AUDR model record per
request (model, token counts and time) and estimates its cost at Anthropic list prices
(:mod:`cost_inspector.pricing`). Message content is never copied.

The records then go through the same validation and analysis as any AUDR file.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from .. import pricing
from .issues import Issue, IssueList
from .normalize import decimal_str, parse_event_time

FORMAT = "claude-code"
EMITTER = {"component": "harness", "name": "ai-cost-inspector.claude-code", "version": "1"}
SPEC_VERSION = "1.0.0"
LABEL_MAX = 256
#: KORA Doctor flags runs with more model calls than this (its orchestration rule).
ORCHESTRATION_MIN_CALLS = 5
UNREADABLE_LINES_SHOWN = 20

#: Entry types whose lines are worth parsing; everything else is skipped unread.
_MARKERS = ('"assistant"', '"ai-title"', '"custom-title"', '"cost-state"')
_SNIFF_BYTES = 64 * 1024


def looks_like_transcript(data: bytes) -> bool:
    """True when the file starts like a Claude Code transcript rather than AUDR."""
    head = data[:_SNIFF_BYTES]
    if not head.lstrip().startswith(b"{"):
        return False
    for raw in head.split(b"\n")[:50]:
        line = raw.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue  # a pretty-printed object, or a line longer than the window
        if not isinstance(value, dict) or "spec_version" in value or "record_id" in value:
            return False
        if isinstance(value.get("type"), str) and (
            "sessionId" in value or value["type"] in ("summary", "file-history-snapshot")
        ):
            return True
    return b'"sessionId"' in head and b'"spec_version"' not in head


@dataclass
class _Call:
    key: str
    #: Position of the request's first entry among all requests in the file.
    order: int
    session_id: str
    model: str
    timestamp: str
    event_ms: int
    usage: dict[str, Any]
    sidechain: bool
    agent_id: str | None
    version: str | None
    effort: str | None


@dataclass
class _Tally:
    unreadable: list[int] = field(default_factory=list)
    unpriced_models: dict[str, int] = field(default_factory=dict)
    unpriced_tiers: dict[str, int] = field(default_factory=dict)
    assumed_5m: int = 0
    web_searches: int = 0
    fast: int = 0


@dataclass(frozen=True)
class _CostState:
    """Claude Code's running cost figure, as last saved in the transcript."""

    total_usd: float
    #: Requests logged before it was saved (their ``order`` is below this).
    calls_before: int


@dataclass
class _Transcript:
    calls: dict[str, _Call] = field(default_factory=dict)
    titles: dict[str, str] = field(default_factory=dict)
    cost_states: dict[str, _CostState] = field(default_factory=dict)


@dataclass(frozen=True)
class Conversion:
    #: The AUDR records as JSONL; deterministic for the same transcript content.
    data: bytes
    calls: int
    sessions: int
    notes: list[Issue]


def _entries(text: str, tally: _Tally) -> Iterator[dict[str, Any]]:
    for number, line in enumerate(text.split("\n"), start=1):
        stripped = line.strip()
        if not stripped or not any(marker in stripped for marker in _MARKERS):
            continue
        try:
            value = json.loads(stripped)
        except ValueError:
            tally.unreadable.append(number)
            continue
        if isinstance(value, dict):
            yield value


def _text(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None


def _count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _read(text: str, tally: _Tally) -> _Transcript:
    out = _Transcript()
    calls = out.calls
    ai_titles: dict[str, str] = {}
    custom_titles: dict[str, str] = {}
    for entry in _entries(text, tally):
        kind = entry.get("type")
        session = _text(entry.get("sessionId"))
        if kind == "assistant":
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            model = _text(message.get("model"))
            usage = message.get("usage")
            key = _text(entry.get("requestId")) or _text(message.get("id"))
            timestamp = _text(entry.get("timestamp"))
            # "<synthetic>" marks messages Claude Code wrote itself (errors,
            # interruptions): no API call was made.
            if not (model and model != "<synthetic>" and isinstance(usage, dict)):
                continue
            if (
                _count(usage.get("input_tokens")) is None
                and _count(usage.get("output_tokens")) is None
            ):
                continue
            if not (key and session and timestamp):
                continue
            try:
                event_ms = parse_event_time(timestamp)
            except ValueError:
                continue
            # A response is logged once per content block; the last entry is final.
            previous = calls.get(key)
            calls[key] = _Call(
                key=key,
                order=previous.order if previous else len(calls),
                session_id=session,
                model=model,
                timestamp=timestamp,
                event_ms=event_ms,
                usage=usage,
                sidechain=entry.get("isSidechain") is True,
                agent_id=_text(entry.get("agentId")),
                version=_text(entry.get("version")),
                effort=_text(entry.get("effort")),
            )
        elif session and kind == "ai-title" and _text(entry.get("aiTitle")):
            ai_titles[session] = str(_text(entry.get("aiTitle")))
        elif session and kind == "custom-title" and _text(entry.get("customTitle")):
            custom_titles[session] = str(_text(entry.get("customTitle")))
        elif session and kind == "cost-state":
            total = entry.get("totalCostUSD")
            if isinstance(total, (int, float)) and not isinstance(total, bool) and total >= 0:
                out.cost_states[session] = _CostState(float(total), len(calls))
    out.titles = {**ai_titles, **custom_titles}
    return out


def _record_id(event_ms: int, key: str) -> str:
    """A UUIDv7 whose time is the call's and whose random bits come from its request ID."""
    rand = int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:10], "big")
    value = (event_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= ((rand >> 62) & 0xFFF) << 64
    value |= 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


def _token_usage(usage: dict[str, Any], tally: _Tally) -> tuple[dict[str, int], pricing.TokenUsage]:
    """AUDR ``usage.llm`` counters, and the same counts split for pricing."""
    counters: dict[str, int] = {}
    input_tokens = _count(usage.get("input_tokens"))
    output_tokens = _count(usage.get("output_tokens"))
    cache_read = _count(usage.get("cache_read_input_tokens"))
    cache_write = _count(usage.get("cache_creation_input_tokens"))
    details = usage.get("output_tokens_details")
    thinking = _count(details.get("thinking_tokens")) if isinstance(details, dict) else None
    if thinking is not None and output_tokens is not None and thinking > output_tokens:
        thinking = None

    if input_tokens is not None:
        counters["input_tokens"] = input_tokens
    if output_tokens is not None:
        # AUDR counts reasoning separately from output when it is reported.
        counters["output_tokens"] = output_tokens - (thinking or 0)
    if thinking is not None:
        counters["reasoning_tokens"] = thinking
    if cache_read is not None:
        counters["cache_read_tokens"] = cache_read
    if cache_write is not None:
        counters["cache_write_tokens"] = cache_write
    counters["requests"] = 1

    write_5m, write_1h = cache_write or 0, 0
    split = usage.get("cache_creation")
    if isinstance(split, dict):
        five = _count(split.get("ephemeral_5m_input_tokens")) or 0
        hour = _count(split.get("ephemeral_1h_input_tokens")) or 0
        if five + hour == (cache_write or 0):
            write_5m, write_1h = five, hour
        elif cache_write:
            tally.assumed_5m += 1
    elif cache_write:
        tally.assumed_5m += 1
    tokens = pricing.TokenUsage(
        input_tokens=input_tokens or 0,
        output_tokens=counters.get("output_tokens", 0),
        reasoning_tokens=thinking or 0,
        cache_read_tokens=cache_read or 0,
        cache_write_5m_tokens=write_5m,
        cache_write_1h_tokens=write_1h,
    )
    return counters, tokens


def _labels(call: _Call, priced: bool, fast: bool, tier: str | None) -> dict[str, str]:
    labels = {"source": "claude-code", "thread": "subagent" if call.sidechain else "main"}
    if priced:
        labels[pricing.COST_BASIS_LABEL] = pricing.COST_BASIS_ESTIMATE
        labels["price_list"] = pricing.PRICE_LIST
    optional = {
        "claude_code_version": call.version,
        "agent_id": call.agent_id if call.sidechain else None,
        "effort": call.effort,
        "speed": "fast" if fast else None,
        "service_tier": tier if tier not in (None, "standard") else None,
    }
    labels.update({k: v[:LABEL_MAX] for k, v in optional.items() if v})
    return labels


def _model_record(
    call: _Call, step: int, name: str, tally: _Tally
) -> tuple[list[dict[str, Any]], Decimal | None]:
    """The call's AUDR records (the model call, plus web searches) and their estimated cost."""
    usage = call.usage
    counters, tokens = _token_usage(usage, tally)
    fast = usage.get("speed") == "fast"
    us_only = usage.get("inference_geo") == "us"
    tier = _text(usage.get("service_tier"))
    tally.fast += fast

    cost: pricing.CallCost | None = None
    if tier in (None, "standard"):
        cost = pricing.price_call(call.model, tokens, fast=fast, us_only=us_only)
        if cost is None:
            tally.unpriced_models[call.model] = tally.unpriced_models.get(call.model, 0) + 1
    else:
        tally.unpriced_tiers[tier] = tally.unpriced_tiers.get(tier, 0) + 1

    resource: dict[str, Any] = {
        "provider": "anthropic",
        "type": "model",
        "name": call.model,
        "operation": "generation",
        "modality": "text",
    }
    if us_only:
        resource["region"] = "us"
    run = {
        "run_id": call.session_id,
        "name": name,
        "span_id": call.key,
        "step": step,
        "run_type": "agent_run",
    }
    record: dict[str, Any] = {
        "spec_version": SPEC_VERSION,
        "record_id": _record_id(call.event_ms, call.key),
        "emitter": EMITTER,
        "timing": {"event_time": call.timestamp},
        "resource": resource,
        "run": run,
        "attribution": {
            "environment": "development",
            "labels": _labels(call, cost is not None, fast, tier),
        },
        "usage": {"llm": counters},
    }
    if cost is not None:
        breakdown = {
            "total_token_cost": cost.total,
            "input_token_cost": cost.input,
            "output_token_cost": cost.output,
            "cache_read_cost": cost.cache_read,
            "cache_write_cost": cost.cache_write,
        }
        if "reasoning_tokens" in counters:
            breakdown["reasoning_cost"] = cost.reasoning
        record["cost"] = {"total_cost": cost.total, "currency": pricing.CURRENCY, "llm": breakdown}
    records = [record]
    estimate = cost.total if cost is not None else None

    tools = usage.get("server_tool_use")
    searches = _count(tools.get("web_search_requests")) if isinstance(tools, dict) else None
    if searches:
        tally.web_searches += searches
        amount = searches * pricing.WEB_SEARCH_PRICE
        estimate = (estimate or Decimal(0)) + amount
        span = f"{call.key}:web_search"
        records.append(
            {
                "spec_version": SPEC_VERSION,
                "record_id": _record_id(call.event_ms, span),
                "emitter": EMITTER,
                "timing": {"event_time": call.timestamp},
                "resource": {
                    "provider": "anthropic",
                    "type": "tool",
                    "name": "web_search",
                    "operation": "tool_execution",
                },
                "run": {**run, "span_id": span, "parent_span_id": call.key},
                "attribution": {
                    "environment": "development",
                    "labels": _labels(call, True, False, None),
                },
                "usage": {"tool": {"type": "web_search", "call_count": searches}},
                "cost": {
                    "total_cost": amount,
                    "currency": pricing.CURRENCY,
                    "tool": {"type": "web_search", "call_cost": amount},
                },
            }
        )
    return records, estimate


def _session_name(title: str | None, first_ms: int) -> str:
    if title:
        return title
    started = datetime.fromtimestamp(first_ms / 1000, tz=UTC)
    return f"Claude Code session {started.day} {started:%b %Y %H:%M} UTC"


def _dump(value: Any) -> str:
    """Compact JSON that writes ``Decimal`` amounts as exact decimal text."""
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(k)}:{_dump(v)}" for k, v in value.items()) + "}"
    if isinstance(value, Decimal):
        return decimal_str(value)
    return json.dumps(value, ensure_ascii=False)


def _usd(value: float | Decimal) -> str:
    amount = value if isinstance(value, Decimal) else Decimal(repr(value))
    return f"${amount.quantize(Decimal('0.01')):,}"


def convert(data: bytes, *, max_records: int, errors: IssueList) -> Conversion | None:
    """Convert a transcript. Problems that block the import are added to ``errors``."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        errors.add(
            Issue(
                code="invalid_utf8",
                line=data.count(b"\n", 0, exc.start) + 1,
                message="The transcript is not UTF-8 text.",
                hint="Choose the .jsonl file Claude Code wrote, unchanged.",
            )
        )
        return None

    tally = _Tally()
    transcript = _read(text, tally)
    calls = transcript.calls
    if not calls:
        errors.add(
            Issue(
                code="no_api_calls",
                message="No API calls were found in this Claude Code transcript.",
                hint="Choose a session file from ~/.claude/projects/. "
                "A session with no replies yet has nothing to analyze.",
            )
        )
        return None

    by_session: dict[str, list[_Call]] = {}
    for call in calls.values():
        by_session.setdefault(call.session_id, []).append(call)
    records: list[dict[str, Any]] = []
    checks: list[_CostCheck] = []
    for session, group in by_session.items():
        group.sort(key=lambda c: c.event_ms)  # stable: file order breaks ties
        name = _session_name(transcript.titles.get(session), group[0].event_ms)
        state = transcript.cost_states.get(session)
        check = _CostCheck(state.total_usd, len(group)) if state else None
        for step, call in enumerate(group, start=1):
            call_records, estimate = _model_record(call, step, name, tally)
            records.extend(call_records)
            if check and state and call.order < state.calls_before:
                check.add(estimate)
        if check:
            checks.append(check)

    if len(records) > max_records:
        errors.add(
            Issue(
                code="too_many_records",
                message=f"This transcript has {len(calls):,} API calls; "
                f"one import holds at most {max_records:,} records.",
                hint="Import fewer sessions at a time.",
            )
        )
        return None

    notes = _notes(len(calls), by_session, checks, tally)
    body = "".join(_dump(r) + "\n" for r in records).encode("utf-8")
    return Conversion(data=body, calls=len(calls), sessions=len(by_session), notes=notes)


@dataclass
class _CostCheck:
    """One session's own cost figure next to this estimate for the same calls."""

    claude_code_usd: float
    session_calls: int
    calls: int = 0
    estimate: Decimal = Decimal(0)
    unpriced: int = 0

    def add(self, estimate: Decimal | None) -> None:
        self.calls += 1
        if estimate is None:
            self.unpriced += 1
        else:
            self.estimate += estimate


def _cost_check_note(checks: list[_CostCheck], sessions: int) -> Issue:
    figure = sum(c.claude_code_usd for c in checks)
    estimate = sum((c.estimate for c in checks), Decimal(0))
    before = sum(c.calls for c in checks)
    total = sum(c.session_calls for c in checks)
    if sessions == 1:
        subject = "this session"
    elif len(checks) == sessions:
        subject = "these sessions"
    elif len(checks) == 1:
        subject = "the one session that records it"
    else:
        subject = f"the {len(checks):,} sessions that record it"
    its = "its" if len(checks) == 1 else "their"
    when = f", saved after {before:,} of {its} {total:,} calls," if before != total else ""
    unpriced = sum(c.unpriced for c in checks)
    caveat = f" ({unpriced:,} of those calls have no list price here)" if unpriced else ""
    return Issue(
        code="claude_code_cost",
        severity="info",
        message=f"Claude Code's own cost figure for {subject}{when} is {_usd(figure)}; "
        f"this estimate for the same calls is {_usd(estimate)}{caveat}. Claude Code also "
        "counts calls its transcript doesn't list, such as context compaction and session titles.",
    )


def _notes(
    calls: int, sessions: dict[str, list[_Call]], checks: list[_CostCheck], tally: _Tally
) -> list[Issue]:
    count = len(sessions)
    where = "1 session" if count == 1 else f"{count:,} sessions"
    notes = [
        Issue(
            code="claude_code_transcript",
            severity="info",
            message=f"Read as a Claude Code transcript: {calls:,} API "
            f"{'call' if calls == 1 else 'calls'} in {where}. Only model names, token counts "
            "and times were read; the conversation itself is not stored.",
        ),
        Issue(
            code="estimated_cost",
            severity="info",
            message="Costs are estimates: each call's tokens priced at Anthropic API list prices "
            f"as of {pricing.PRICE_LIST_DAY}. Claude subscriptions don't bill per token, and the "
            "transcript doesn't record what was charged.",
            hint=f"Prices: {pricing.PRICE_LIST_URL}",
        ),
    ]
    if checks:
        notes.append(_cost_check_note(checks, count))
    if any(len(group) > ORCHESTRATION_MIN_CALLS for group in sessions.values()):
        notes.append(
            Issue(
                code="analyzer_fit",
                severity="info",
                message="KORA Doctor's rules were written for agent runs. In a long interactive "
                "session its orchestration rule flags every call after the fourth, so read those "
                "candidates as a measure of session length rather than as waste.",
            )
        )
    if tally.unpriced_models:
        n = sum(tally.unpriced_models.values())
        names = ", ".join(sorted(tally.unpriced_models))
        notes.append(
            Issue(
                code="unpriced_models",
                severity="warning",
                message=f"{n:,} {'call uses a model' if n == 1 else 'calls use models'} this price "
                f"list doesn't cover ({names}); {'its' if n == 1 else 'their'} cost is unknown, "
                "not zero.",
                hint="Model IDs from Amazon Bedrock or Google Cloud are billed by those "
                "platforms at their own prices.",
            )
        )
    if tally.unpriced_tiers:
        n = sum(tally.unpriced_tiers.values())
        tiers = ", ".join(sorted(tally.unpriced_tiers))
        notes.append(
            Issue(
                code="unpriced_service_tier",
                severity="warning",
                message=f"{n:,} {'call ran' if n == 1 else 'calls ran'} on the {tiers} service "
                f"tier, which this estimate doesn't price; {'its' if n == 1 else 'their'} cost is "
                "unknown.",
            )
        )
    if tally.assumed_5m:
        n = tally.assumed_5m
        notes.append(
            Issue(
                code="assumed_cache_duration",
                severity="info",
                message=f"{n:,} {'call doesn' if n == 1 else 'calls don'}'t say how long "
                f"{'its' if n == 1 else 'their'} cache writes last; those writes are priced as "
                "5-minute writes, the API default.",
            )
        )
    if tally.fast:
        notes.append(
            Issue(
                code="fast_mode",
                severity="info",
                message=f"{tally.fast:,} {'call' if tally.fast == 1 else 'calls'} ran in fast "
                f"mode and {'is' if tally.fast == 1 else 'are'} priced at fast-mode rates.",
            )
        )
    if tally.web_searches:
        n = tally.web_searches
        notes.append(
            Issue(
                code="web_searches",
                severity="info",
                message=f"{n:,} web {'search is' if n == 1 else 'searches are'} listed as tool "
                "calls at $10 per 1,000 searches.",
            )
        )
    if tally.unreadable:
        n = len(tally.unreadable)
        notes.append(
            Issue(
                code="unreadable_lines",
                severity="warning",
                message=f"{n:,} {'line' if n == 1 else 'lines'} couldn't be read and "
                f"{'was' if n == 1 else 'were'} skipped.",
                hint="A transcript that is still being written can end with a partial line.",
                lines=tuple(tally.unreadable[:UNREADABLE_LINES_SHOWN]),
            )
        )
    return notes
