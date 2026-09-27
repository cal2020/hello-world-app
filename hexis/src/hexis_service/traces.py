"""Traces: export, integrity, normalization, eligibility and the replay modes (sections 9-10).

Trace file (``hexis-trace/1``, JSON Lines): a header line followed by one
record per observable event. The header carries ``records_sha256`` over the
canonical records, so tampering is detected (A31).

Replay modes (never collapsed into one "verified" flag):
* ``structural`` - can the machine represent the recorded observable sequence
  and exact terminal? Values missing from the trace become recorded
  *placeholders*; they are never evidence of an approval or real effect.
* ``recorded`` - does the kernel reproduce every checkpoint from the recorded
  observations? Runs with network access disabled by construction and
  constructs no broker or model; a missing observation is INCOMPLETE.
* ``sandbox_live`` - fresh model outputs against disposable tools; this is the
  normal runtime pointed at a fresh data directory (see ``evals/``).
"""
from __future__ import annotations

import copy
import socket
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from . import canonical
from . import guards as G
from . import jsonschema_lite as JS
from . import kernel
from .package import LoadedPackage

TRACE_FORMAT = "hexis-trace/1"
PASS, FAIL, INCOMPLETE = "PASS", "FAIL", "INCOMPLETE"
NOISE_KINDS = {"interaction", "heartbeat"}


class ExternalCallInReplay(RuntimeError):
    pass


@contextmanager
def no_external_calls():
    """Hard-fail any socket connection attempted while replaying (A13)."""
    original_connect = socket.socket.connect
    original_create = socket.create_connection

    def refuse(*_a, **_k):
        raise ExternalCallInReplay("network access attempted during recorded replay")

    socket.socket.connect = refuse  # type: ignore[assignment]
    socket.create_connection = refuse  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.socket.connect = original_connect  # type: ignore[assignment]
        socket.create_connection = original_create  # type: ignore[assignment]


# ------------------------------------------------------------- format ---
def make_trace(trace_id: str, skill_id: str, task_input: dict, records: list[dict], source: str,
               labels: dict | None = None) -> dict:
    recs = [{**r, "seq": i} for i, r in enumerate(records)]
    return {"header": {"header": True, "format": TRACE_FORMAT, "trace_id": trace_id, "skill_id": skill_id,
                       "task_input": task_input, "source": source, "labels": labels or {},
                       "records_sha256": canonical.digest(recs)},
            "records": recs}


def dumps_jsonl(trace: dict) -> str:
    lines = [canonical.canonical_bytes(trace["header"]).decode()]
    lines += [canonical.canonical_bytes(r).decode() for r in trace["records"]]
    return "\n".join(lines) + "\n"


def loads_jsonl(text: str) -> dict:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    header = canonical.loads_strict(lines[0])
    if header.get("format") != TRACE_FORMAT or header.get("header") is not True:
        raise ValueError("not a hexis-trace/1 file")
    return {"header": header, "records": [canonical.loads_strict(ln) for ln in lines[1:]]}


def integrity_ok(trace: dict) -> bool:
    return trace["header"].get("records_sha256") == canonical.digest(trace["records"])


def export_run_trace(store, tenant: str, run_id: str, skill_id: str, task_input: dict, trace_id: str) -> dict:
    """Build a trace from a run's recorded observations (tool/model/user/end events only)."""
    obs = store.observations(tenant, run_id)
    cps = {r: store.checkpoint_at(tenant, run_id, r) for r in sorted(obs)}
    records = []
    for rev in sorted(obs):
        o = obs[rev]
        kind = o["kind"]
        if kind in NOISE_KINDS or kind in ("stop", "cancel"):
            continue
        if kind == "tool":
            if o.get("certainty") != "certain":
                records.append({"kind": "tool", "tool": o["tool"], "outcome": o["certainty"], "output": None,
                                "action_id": o.get("action_id"), "ref": {"run_id": run_id, "revision": rev}})
                continue
            records.append({"kind": "tool", "tool": o["tool"], "outcome": "certain", "output": o["result"],
                            "action_id": o.get("action_id"), "ref": {"run_id": run_id, "revision": rev}})
        elif kind in ("model", "judge", "user"):
            records.append({"kind": kind, "state_hint": cps[rev]["state_id"], "output": o.get("outputs"),
                            "ref": {"run_id": run_id, "revision": rev}})
        elif kind == "end":
            after = store.checkpoint_at(tenant, run_id, rev + 1)
            if after and after["status"] == "COMPLETED":
                records.append({"kind": "end", "terminal": after["outcome"]["terminal"],
                                "ref": {"run_id": run_id, "revision": rev}})
    return make_trace(trace_id, skill_id, task_input, records, source=f"runtime:{run_id}")


# ---------------------------------------------------------- normalize ---
def normalize(trace: dict) -> tuple[list[dict], list[dict]]:
    """Return (normalized events, ignored records with reasons).

    Distinct writes, approvals, failures and verifications are never merged just because
    the tool name matches. The only merge: an ``unknown_effect`` record immediately followed
    by the record that resolved *the same logical action id* (reconciliation) becomes one
    logical operation that keeps both raw record references."""
    events, ignored = [], []
    for r in trace["records"]:
        if r.get("kind") in NOISE_KINDS or r.get("role") == "noise":
            ignored.append({"seq": r["seq"], "reason": "recognized orchestration noise"})
            continue
        ev = {"raw_seq": r["seq"], "raw_seqs": [r["seq"]], "kind": r["kind"], "tool": r.get("tool"),
              "phase": r.get("phase", ""), "output": r.get("output"), "outcome": r.get("outcome", "certain"),
              "terminal": r.get("terminal"), "state_hint": r.get("state_hint"), "action_id": r.get("action_id")}
        prev = events[-1] if events else None
        if (prev and ev["kind"] == "tool" and prev["kind"] == "tool" and prev["outcome"] == "unknown_effect"
                and ev["action_id"] and ev["action_id"] == prev["action_id"]):
            ev["raw_seqs"] = prev["raw_seqs"] + [r["seq"]]
            ev["raw_seq"] = prev["raw_seq"]
            ev["reconciled"] = True
            events[-1] = ev
            continue
        events.append(ev)
    return events, ignored


# -------------------------------------------------------- eligibility ---
@dataclass
class Eligibility:
    verdict: str                    # protected | negative | incomplete
    reasons: list[str] = field(default_factory=list)


def eligibility(trace: dict, pkg: LoadedPackage) -> Eligibility:
    """Machine-independent check against declared skill constraints. A correct final answer
    reached through a forbidden action is negative, not protected (A15)."""
    if not integrity_ok(trace):
        return Eligibility("incomplete", ["records_sha256 does not match (tampered or truncated)"])
    events, _ = normalize(trace)
    if not events or events[-1]["kind"] != "end":
        return Eligibility("incomplete", ["trace has no terminal event"])
    reasons: list[str] = []
    validated_pass = approved = False
    wrote_since_verify = False
    verified = False
    for e in events:
        if e["kind"] == "tool":
            if e["tool"] not in pkg.catalog:
                reasons.append(f"event {e['raw_seq']}: tool {e['tool']!r} is not in the trusted catalog")
                continue
            if e["outcome"] != "certain" or e["output"] is None:
                continue
            spec = pkg.catalog[e["tool"]]
            if e["tool"] == "draft.validate":
                validated_pass = e["output"].get("status") == "pass"
                approved = False
            if spec.is_write:
                if spec.name in pkg.contracts.get("approval_required_tools", []) and not (validated_pass and approved):
                    reasons.append(f"event {e['raw_seq']}: {spec.name} without a passing validation and approval")
                wrote_since_verify = True
                verified = False
            if spec.verifier:
                verified = e["output"].get("status") == "match"
                wrote_since_verify = False
        elif e["kind"] == "model" and e.get("state_hint") in ("EXTRACT_DRAFT", "REPAIR_DRAFT"):
            validated_pass = approved = False
        elif e["kind"] == "user":
            out = e["output"] or {}
            if out.get("approval_decision") == "approved":
                approved = True
    term = pkg.machine.terminal(events[-1]["terminal"])
    if term and term.kind == "verified" and (not verified or wrote_since_verify):
        reasons.append("verified terminal without a current verifier result")
    return Eligibility("negative" if reasons else "protected", reasons)


# ------------------------------------------------------ structural replay ---
@dataclass
class ReplayReport:
    mode: str
    trace_id: str
    result: str
    detail: dict = field(default_factory=dict)
    placeholders: list[dict] = field(default_factory=list)
    path: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.result == PASS

    def to_dict(self) -> dict:
        return {"mode": self.mode, "trace_id": self.trace_id, "result": self.result, "detail": self.detail,
                "placeholders": self.placeholders, "path": self.path}


def _placeholder(schema: dict) -> Any:
    t = schema.get("type")
    if "enum" in schema:
        return schema["enum"][0]
    return {"string": "<placeholder>", "integer": 0, "number": 0, "boolean": False, "array": [],
            "object": {}}.get(t if isinstance(t, str) else "object", None)


def structural_replay(pkg: LoadedPackage, trace: dict) -> ReplayReport:
    tid = trace["header"]["trace_id"]
    if not integrity_ok(trace):
        return ReplayReport("structural", tid, INCOMPLETE, {"reason": "records_sha256 mismatch"})
    events, _ = normalize(trace)
    m = pkg.machine
    try:
        cp = kernel.initial_checkpoint(pkg, "replay", "replay", trace["header"]["task_input"])
    except kernel.InputBindingError as exc:
        return ReplayReport("structural", tid, INCOMPLETE, {"reason": f"task input: {exc}"})
    env = cp["variables"]
    state_id, i, anchor = m.initial, 0, None
    path, placeholders = [], []
    limit = 4 * max(m.max_steps, len(events) + 1)

    def diverge(expected: str, extra: dict | None = None) -> ReplayReport:
        state = m.states.get(state_id)
        guard_vars = {}
        if state:
            for t in state.transitions:
                if t.cond:
                    for n in G.names(t.cond):
                        guard_vars[n] = env.get(n, "<unset>")
        return ReplayReport("structural", tid, FAIL, {
            "event_index": i, "raw_seq": events[i]["raw_seq"] if i < len(events) else None,
            "previous_anchor": anchor, "expected": expected, "actual_state": state_id,
            "guard_values": guard_vars, **(extra or {})}, placeholders, path)

    for _ in range(limit):
        path.append(state_id)
        st = m.states[state_id]
        act = st.action
        ev = events[i] if i < len(events) else None
        if act.kind == "end":
            if ev is None:
                return ReplayReport("structural", tid, INCOMPLETE, {"reason": "trace ended before terminal"},
                                    placeholders, path)
            if ev["kind"] != "end" or ev["terminal"] != act.terminal:
                return diverge(f"{ev['kind']}:{ev.get('terminal') or ev.get('tool')}",
                               {"machine_terminal": act.terminal})
            if i != len(events) - 1:
                return diverge("end of trace", {"trailing_events": len(events) - 1 - i})
            return ReplayReport("structural", tid, PASS, {"terminal": act.terminal}, placeholders, path)
        zero_width = (act.kind == "judge") or (act.kind == "model" and not act.observable)
        if zero_width:
            for w in act.writes:
                val = _placeholder(pkg.var_schema(w))
                env[w] = val
                placeholders.append({"state": state_id, "variable": w, "value": val})
        else:
            if ev is None:
                return ReplayReport("structural", tid, INCOMPLETE, {"reason": f"trace ended at {state_id}"},
                                    placeholders, path)
            if ev["kind"] != act.kind or (act.kind == "tool" and (ev["tool"] != act.name or ev["phase"] != act.phase)):
                return diverge(f"{ev['kind']}:{ev.get('tool') or ev.get('terminal') or ev.get('state_hint')}",
                               {"machine_expects": f"{act.kind}:{act.name or state_id}"})
            if act.kind == "tool":
                if ev["outcome"] != "certain" or ev["output"] is None:
                    return ReplayReport("structural", tid, INCOMPLETE,
                                        {"reason": f"event {ev['raw_seq']} has no certain tool output"}, placeholders,
                                        path)
                errs = JS.errors(ev["output"], pkg.catalog[act.name].output_schema)
                if errs:
                    return diverge("schema-valid tool output", {"errors": errs})
                for k, var in act.binds.items():
                    env[var] = copy.deepcopy(ev["output"][k])
            else:
                out = ev["output"] or {}
                for w in act.writes:
                    if w in out:
                        env[w] = copy.deepcopy(out[w])
                    else:
                        val = _placeholder(pkg.var_schema(w))
                        env[w] = val
                        placeholders.append({"state": state_id, "variable": w, "value": val,
                                             "note": "not evidence of a real approval or effect"})
            anchor = state_id
            i += 1
        chosen = None
        for t in st.ordered_transitions():
            if t.is_default:
                chosen = t
                break
            try:
                if G.evaluate(t.cond, env):
                    chosen = t
                    break
            except G.GuardError as exc:
                return diverge("guard evaluation", {"guard_error": str(exc)})
        if chosen is None:
            return diverge("an enabled transition")
        if chosen.inc:
            bound = pkg.contracts.get("loop_bounds", {}).get(chosen.inc)
            if bound is None or env.get(chosen.inc, 0) + 1 > bound:
                return diverge("loop within bound", {"counter": chosen.inc})
            env[chosen.inc] = env.get(chosen.inc, 0) + 1
        state_id = chosen.to
    return ReplayReport("structural", tid, FAIL, {"reason": "replay step limit exceeded"}, placeholders, path)


# ------------------------------------------------------- recorded replay ---
def export_recorded(store, tenant: str, run_id: str, task_input: dict) -> dict:
    obs = store.observations(tenant, run_id)
    cps = {}
    r = 0
    while True:
        c = store.checkpoint_at(tenant, run_id, r)
        if c is None:
            break
        cps[str(r)] = canonical.digest(c)
        r += 1
    first = store.checkpoint_at(tenant, run_id, 0)
    return {"format": "hexis-recorded/1", "tenant_id": tenant, "run_id": run_id,
            "artifact_hash": first["artifact_hash"], "task_input": task_input,
            "observations": {str(k): v for k, v in sorted(obs.items())}, "checkpoint_digests": cps}


def recorded_replay(pkg: LoadedPackage, recorded: dict) -> ReplayReport:
    rid = recorded["run_id"]
    if recorded["artifact_hash"] != pkg.artifact_hash:
        return ReplayReport("recorded", rid, FAIL, {"reason": "recorded run is pinned to a different artifact"})
    with no_external_calls():
        cp = kernel.initial_checkpoint(pkg, recorded["tenant_id"], rid, recorded["task_input"])
        digests = recorded["checkpoint_digests"]
        if canonical.digest(cp) != digests.get("0"):
            return ReplayReport("recorded", rid, FAIL, {"revision": 0, "reason": "initial checkpoint differs"})
        path = [cp["state_id"]]
        while str(cp["revision"] + 1) in digests:
            obs = recorded["observations"].get(str(cp["revision"]))
            if obs is None:
                return ReplayReport("recorded", rid, INCOMPLETE,
                                    {"revision": cp["revision"], "reason": "missing recorded observation"}, path=path)
            cp = kernel.apply(cp, obs, pkg).checkpoint
            path.append(cp["state_id"])
            if canonical.digest(cp) != digests[str(cp["revision"])]:
                return ReplayReport("recorded", rid, FAIL, {"revision": cp["revision"],
                                                            "reason": "reproduced checkpoint differs"}, path=path)
    return ReplayReport("recorded", rid, PASS, {"revisions": cp["revision"], "final_status": cp["status"],
                                                "outcome": cp["outcome"]}, path=path)
