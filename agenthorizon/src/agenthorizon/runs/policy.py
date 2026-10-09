"""Attempt policies and the scored-attempt selection rule (immutable and versioned).

Both reference policies mirror the released runners at 8584a347:

agentic (``scripts/evaluate_trajectories.py:evaluate_one``)
    up to 3 judgment attempts. A fresh attempt starts only when a completed response yields no parsed object with a
    ``success`` key *and* is not a short truncation (< 200 characters, no "success", no "{" — the runner bails out
    instead of retrying those). A non-zero exit, a timeout, or more than 10 rate-limit waits ends the item with no
    result file, i.e. *missing* (the eleventh rate-limited run ends it: ``if rate_limit_retries > 10``).
direct (``llm_judges/evaluate.py:evaluate_one``)
    up to 3 attempts. A fresh attempt starts after a non-rate-limit API error or a response without a ``success``
    key. A fifth rate-limited call inside one attempt ends the item as missing (``while rate_limit_retries < 5``).

A parsed ``success`` key ends the task whatever its value: a valid unsuccessful judgment is never re-run.
Infrastructure interruptions (operator cancellation, a worker that died mid-attempt) and run-level blocks (missing
credential, unknown model) are recorded in the history but are not judgments: they neither count toward the attempt
cap nor finalize the task.

Selection rule ``final-attempt/1``: the scored record is the task's last counted attempt. If that attempt produced
response text, its parse is scored (possibly invalid); otherwise the item is missing — exactly what the reference's
result-file semantics produce.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from agenthorizon.judging.contract import AttemptOutcome

OutcomeClass = Literal[
    "verdict",  # response parsed to an object with a ``success`` key (any value)
    "unparseable",  # response obtained, no ``success`` key
    "short_truncation",  # response obtained, short and JSON-free (agentic runner bails out)
    "transport_failed",
    "rate_limited",
    "process_failed",
    "timed_out",
    "serving_incompatible",
    "blocked",
    "cancelled",
    "interrupted",
    "reopened",  # marker written by an explicit, audited retry-errors pass
]
RESPONSE_CLASSES = frozenset({"verdict", "unparseable", "short_truncation"})
INFRASTRUCTURE_CLASSES = frozenset({"cancelled", "interrupted", "blocked", "reopened"})


@dataclass(frozen=True)
class AttemptPolicy:
    policy_id: str
    family: str  # agentic | direct
    max_attempts: int
    retry_on: tuple[str, ...]
    short_truncation_guard: bool
    rate_limit_resends_per_attempt: int  # re-sends after a rate-limited call; one more rate limit ends the attempt
    rate_limit_wait_s: float | None  # None: provider hint (direct); agentic reference waits a fixed 300 s
    selection_rule: str = "final-attempt/1"
    error_redispatch_passes: int = 1  # explicit, audited operator action; see orchestrator.retry_errors
    source: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


POLICIES: dict[str, AttemptPolicy] = {
    p.policy_id: p
    for p in (
        AttemptPolicy("ah-reference-agentic/1", "agentic", 3, ("unparseable",), True, 10, 300.0,
                      source="scripts/evaluate_trajectories.py:evaluate_one @8584a347"),
        AttemptPolicy("ah-reference-direct/1", "direct", 3, ("unparseable", "transport_failed"), False, 4, None,
                      source="llm_judges/evaluate.py:evaluate_one @8584a347"),
    )
}


def default_policy(interface: str) -> AttemptPolicy:
    return POLICIES["ah-reference-direct/1" if interface == "direct" else "ah-reference-agentic/1"]


def looks_truncated(text: str) -> bool:
    """The released runner's short-truncation test (applied after the parse fails)."""
    t = text or ""
    return len(t.strip()) < 200 and "success" not in t.lower() and "{" not in t


def classify(outcome: AttemptOutcome, policy: AttemptPolicy) -> OutcomeClass:
    s = outcome.status
    if s == "completed":
        v = outcome.verdict
        if v is not None and v.has_success_key:
            return "verdict"
        if policy.short_truncation_guard and looks_truncated(outcome.response_text or ""):
            return "short_truncation"
        return "unparseable"
    return s  # type: ignore[return-value]


@dataclass(frozen=True)
class Decision:
    action: Literal["attempt", "finalize", "hold"]
    reason: str


def decide(policy: AttemptPolicy, classes: list[str]) -> Decision:
    """Next step for a task given the outcome classes of its attempts so far (in order)."""
    if not classes:
        return Decision("attempt", "no attempts yet")
    last = classes[-1]
    counted = [c for c in classes if c not in INFRASTRUCTURE_CLASSES]
    if last == "blocked":
        return Decision("hold", "run-level block (credential, identifier or isolation); resolve and resume")
    if last in ("cancelled", "interrupted"):
        if counted and _final(policy, counted):
            return Decision("finalize", f"already final before the {last} attempt")
        return Decision("attempt", f"resume after {last}")
    if _final(policy, counted):
        return Decision("finalize", f"{last} is final under {policy.policy_id}")
    return Decision("attempt", f"{last}: fresh attempt {len(counted) + 1}/{policy.max_attempts}")


def _final(policy: AttemptPolicy, counted: list[str]) -> bool:
    last = counted[-1]
    if last in ("verdict", "short_truncation"):
        return True
    if last in policy.retry_on:
        return len(counted) >= policy.max_attempts
    return True  # execution errors end the item (missing), as in the reference


def select(policy: AttemptPolicy, attempts: list[tuple[int, str]]) -> tuple[int | None, bool]:
    """(attempt_no, has_response) of the scored attempt under ``policy.selection_rule``."""
    if policy.selection_rule != "final-attempt/1":
        raise ValueError(f"unknown selection rule {policy.selection_rule}")
    counted = [(n, c) for n, c in attempts if c not in INFRASTRUCTURE_CLASSES]
    if not counted:
        return None, False
    n, c = counted[-1]
    return n, c in RESPONSE_CLASSES
