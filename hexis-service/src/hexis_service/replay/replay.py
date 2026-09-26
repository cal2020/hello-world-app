"""Replay modes (brief §10). Never collapsed into one "verified" flag.

* ``structural`` - can the machine represent the recorded observable sequence and exact terminal?
  Missing intermediate model/judge values become explicit placeholders (UNKNOWN); guards over
  unknown values branch. Placeholders are listed in the report and are never evidence.
* ``recorded`` - re-run the pure kernel over complete recorded observations; results must match
  the recorded checkpoint digests exactly. Network access is disabled by construction; any
  attempted external call is a hard failure. Missing observations => INCOMPLETE.
* ``sandbox_live`` - fresh model outputs against disposable tools: performed by running the
  RunService against fakes (see evals/); not a replay of a trace.
"""

from __future__ import annotations

import copy
import socket
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional

from .. import guards as G
from ..artifacts.package import MachinePackage
from ..canonical import digest
from ..runtime import kernel as K
from ..traces.model import Trace
from ..traces.normalize import NORMALIZER_VERSION, NormalizedEvent, normalize

REPLAY_VERSION = "hexis-service-replay/1"
MAX_NODES = 20_000


class ExternalCallAttempted(RuntimeError):
    pass


@contextmanager
def no_external_calls() -> Iterator[None]:
    def deny(*a: Any, **k: Any) -> Any:
        raise ExternalCallAttempted("network access attempted during recorded replay")
    saved = (socket.socket.connect, socket.socket.connect_ex, socket.create_connection, socket.getaddrinfo)
    socket.socket.connect = deny  # type: ignore[assignment]
    socket.socket.connect_ex = deny  # type: ignore[assignment]
    socket.create_connection = deny  # type: ignore[assignment]
    socket.getaddrinfo = deny  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.socket.connect, socket.socket.connect_ex, socket.create_connection, socket.getaddrinfo = saved


@dataclass
class ReplayReport:
    mode: str
    trace_id: str
    artifact_hash: str
    status: str  # PASS | FAIL | INCOMPLETE | REJECTED | ERROR
    path: list[str] = field(default_factory=list)
    placeholders: list[dict] = field(default_factory=list)
    divergence: dict = field(default_factory=dict)
    detail: str = ""

    def to_json(self) -> dict:
        return {"mode": self.mode, "trace_id": self.trace_id, "artifact_hash": self.artifact_hash,
                "status": self.status, "path": self.path, "placeholders": self.placeholders,
                "divergence": self.divergence, "detail": self.detail,
                "versions": {"replay": REPLAY_VERSION, "normalizer": NORMALIZER_VERSION}}


def replay(package: MachinePackage, trace: Trace, mode: str, **kw: Any) -> ReplayReport:
    if mode == "structural":
        return replay_structural(package, trace)
    if mode == "recorded":
        return replay_recorded(package, trace, **kw)
    raise ValueError(f"unsupported replay mode {mode!r} (sandbox_live runs through evals/)")


# --------------------------------------------------------------------------- #
def _initial_env(package: MachinePackage, trace: Trace) -> dict:
    icp = trace.task.get("initial_checkpoint")
    if isinstance(icp, dict) and "variables" in icp:
        return copy.deepcopy(icp["variables"])
    inp = trace.task.get("input") or {}
    return K.initial_checkpoint(package, "replay", "replay", inp).variables


def _observable(st) -> bool:
    a = st.action
    return a.kind in ("tool", "user", "end") or (a.kind == "model" and a.observable)


def replay_structural(package: MachinePackage, trace: Trace) -> ReplayReport:
    rep = ReplayReport("structural", trace.trace_id, package.artifact_hash, "FAIL")
    errs = trace.integrity_errors()
    if errs:
        rep.status, rep.detail = "REJECTED", "; ".join(errs[:3])
        return rep
    events, _ = normalize(trace)
    if not events or events[-1].kind != "terminal":
        rep.status, rep.detail = "INCOMPLETE", "trace has no terminal event"
        return rep
    m = package.machine
    try:
        env0 = _initial_env(package, trace)
    except K.KernelError as exc:
        rep.status, rep.detail = "INCOMPLETE", f"cannot reconstruct initial variables: {exc.message}"
        return rep
    best: dict = {"idx": -1}
    nodes = 0
    seen: set = set()
    # DFS stack: (state, event index, env, path, placeholders, previous anchor)
    stack = [(m.initial, 0, env0, [], [], None)]
    while stack:
        sid, idx, env, path, ph, anchor = stack.pop()
        nodes += 1
        if nodes > MAX_NODES:
            rep.status, rep.detail = "INCOMPLETE", f"search exceeded {MAX_NODES} nodes; not a pass"
            return rep
        key = (sid, idx, digest({k: (repr(v) if v is G.UNKNOWN else v) for k, v in env.items()}))
        if key in seen:
            continue
        seen.add(key)
        st = m.states[sid]
        a = st.action
        path = path + [sid]
        ev: Optional[NormalizedEvent] = events[idx] if idx < len(events) else None

        def diverge(expected: Any, why: str) -> None:
            if idx > best["idx"]:
                best.update({"idx": idx, "state": sid, "expected": expected, "why": why, "previous_anchor": anchor,
                             "path": path[-12:],
                             "guard_values": {k: (None if v is G.UNKNOWN else v) for k, v in env.items()
                                              if k in {n for t in st.transitions if t.cond
                                                       for n in G.vars_of(t.cond)}}})

        env = dict(env)
        if a.kind == "end":
            if ev is not None and ev.kind == "terminal" and ev.terminal == a.terminal and idx == len(events) - 1:
                rep.status, rep.path, rep.placeholders = "PASS", path, ph
                return rep
            diverge(ev.model_dump() if ev else None, f"machine ends at {a.terminal}")
            continue
        if _observable(st):
            if ev is None:
                diverge(None, "trace exhausted before a terminal")
                continue
            if a.kind == "tool":
                if ev.kind != "tool" or ev.tool != a.name or (a.phase and ev.phase and a.phase != ev.phase):
                    diverge(ev.model_dump(), f"state expects tool {a.name}")
                    continue
                bound = {a.binds.get(k, k): v for k, v in ev.outputs.items()}
                for w in a.writes:
                    if w in bound:
                        env[w] = bound[w]
                    else:
                        env[w] = G.UNKNOWN
                        ph = ph + [{"state": sid, "variable": w, "reason": "tool output missing from trace"}]
            elif a.kind == "user":
                if ev.kind != "user":
                    diverge(ev.model_dump(), "state expects a user interaction")
                    continue
                for w in a.writes:
                    if w in ev.outputs:
                        env[w] = ev.outputs[w]
                    else:
                        env[w] = G.UNKNOWN
                        ph = ph + [{"state": sid, "variable": w, "reason": "user response missing"}]
            else:
                if ev.kind != "model_output":
                    diverge(ev.model_dump(), "state expects an observable model output")
                    continue
                for w in a.writes:
                    env[w] = ev.outputs.get(w, G.UNKNOWN)
            nidx, anchor = idx + 1, f"{sid}@{idx}"
        else:  # zero-width model/judge
            for w in a.writes:
                env[w] = G.UNKNOWN
                ph = ph + [{"state": sid, "variable": w, "reason": "zero-width state: value not in trace"}]
            nidx = idx
        branches = []
        for t in st.ordered_transitions():
            if not t.cond:
                branches.append(t)
                break
            try:
                v = G.evaluate3(t.cond, env)
            except G.GuardError as exc:
                diverge(ev.model_dump() if ev else None, f"guard error: {exc}")
                branches = []
                break
            if v is True:
                branches.append(t)
                break
            if v is None:
                branches.append(t)
        for t in reversed(branches):
            e2 = env
            if t.inc:
                e2 = dict(env)
                cur = e2.get(t.inc)
                e2[t.inc] = G.UNKNOWN if cur is G.UNKNOWN else int(cur or 0) + 1
            stack.append((t.to, nidx, e2, path, ph, anchor))
    rep.divergence = {"trace_id": trace.trace_id, "event_index": best.get("idx"),
                      "previous_anchor": best.get("previous_anchor"), "expected_event": best.get("expected"),
                      "actual_state": best.get("state"), "reason": best.get("why"),
                      "guard_values": best.get("guard_values"), "path": best.get("path")}
    rep.detail = f"no machine path represents the trace (diverged at event {best.get('idx')})"
    return rep


# --------------------------------------------------------------------------- #
def replay_recorded(package: MachinePackage, trace: Trace,
                    on_step: Optional[Callable[[K.RunCheckpoint, K.Observation], None]] = None) -> ReplayReport:
    rep = ReplayReport("recorded", trace.trace_id, package.artifact_hash, "FAIL")
    errs = trace.integrity_errors()
    if errs:
        rep.status, rep.detail = "REJECTED", "; ".join(errs[:3])
        return rep
    icp = trace.task.get("initial_checkpoint")
    if not isinstance(icp, dict):
        rep.status, rep.detail = "INCOMPLETE", "trace has no initial checkpoint"
        return rep
    if icp.get("artifact_hash") != package.artifact_hash:
        rep.status, rep.detail = "FAIL", "trace was recorded against a different artifact"
        return rep
    try:
        with no_external_calls():
            cp = K.RunCheckpoint.model_validate(icp)
            path = [cp.state_id]
            for r in trace.records:
                obs_d = r.meta.get("observation")
                if not isinstance(obs_d, dict):
                    rep.status, rep.detail = "INCOMPLETE", f"record {r.step} has no recorded observation"
                    rep.path = path
                    return rep
                obs = K.Observation.model_validate(obs_d)
                if r.meta.get("checkpoint_digest_before") and digest(cp.model_dump(mode="json")) != \
                        r.meta["checkpoint_digest_before"]:
                    rep.divergence = {"record": r.step, "reason": "checkpoint before step differs from recording"}
                    rep.detail = "state evolution diverged"
                    return rep
                if on_step is not None:
                    on_step(cp, obs)
                res = K.advance(cp, obs, package)
                cp = res.checkpoint
                path.append(cp.state_id)
                after = r.meta.get("checkpoint_digest_after")
                if after and digest(cp.model_dump(mode="json")) != after:
                    rep.divergence = {"record": r.step, "reason": "checkpoint after step differs from recording",
                                      "state": r.state}
                    rep.detail = "transition decision or state evolution diverged"
                    rep.path = path
                    return rep
    except ExternalCallAttempted as exc:
        rep.status, rep.detail = "ERROR", f"EXTERNAL_CALL_ATTEMPTED: {exc}"
        return rep
    except K.KernelError as exc:
        rep.status, rep.detail = "FAIL", f"{exc.code}: {exc.message}"
        return rep
    rep.status, rep.path = ("PASS" if cp.status in K.TERMINAL_STATUSES else "INCOMPLETE"), path
    rep.detail = f"final status {cp.status}, outcome {cp.outcome and cp.outcome.get('terminal')}"
    return rep
