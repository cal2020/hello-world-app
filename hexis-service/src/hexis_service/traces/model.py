"""Trace records: upstream-compatible JSONL (header line + one record per line) with an extension
block carrying record digests so tampering is detectable (brief §9.2, A31).

Raw traces are immutable; normalization produces a separate view with pointers back to records.
"""

from __future__ import annotations

import json
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..canonical import digest, strict_loads

TRACE_EXT = "hexis-trace/1"


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step: int
    state: str = ""
    clause: str = ""
    action: dict = Field(default_factory=dict)
    output: dict = Field(default_factory=dict)
    vars: dict = Field(default_factory=dict)
    meta: dict = Field(default_factory=dict)

    def body_digest(self) -> str:
        d = self.model_dump(mode="json")
        d["meta"] = {k: v for k, v in d["meta"].items() if k != "digest"}
        return digest(d)


class Trace(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trace_id: str
    task: dict = Field(default_factory=dict)
    verdict: Literal["accepted", "rejected", "unknown"] = "unknown"
    error_step: Optional[int] = None
    source: str = ""
    tenant_id: str = ""
    run_id: str = ""
    artifact_hash: str = ""
    records: list[Record] = Field(default_factory=list)

    def seal(self) -> "Trace":
        recs = []
        for r in self.records:
            r2 = r.model_copy(deep=True)
            r2.meta = {**r2.meta, "digest": r2.body_digest()}
            recs.append(r2)
        return self.model_copy(update={"records": recs})

    def records_digest(self) -> str:
        return digest([r.meta.get("digest", "") for r in self.records])

    def integrity_errors(self, expected_records_digest: Optional[str] = None) -> list[str]:
        errs = []
        for r in self.records:
            if r.meta.get("digest") != r.body_digest():
                errs.append(f"record {r.step}: digest mismatch (tampered or unsealed)")
        if expected_records_digest is not None and expected_records_digest != self.records_digest():
            errs.append("header records_digest mismatch (records added, removed or reordered)")
        return errs

    def to_jsonl(self) -> str:
        head = {"header": True, "task_id": self.task.get("task_id", self.trace_id), "input": self.task.get("input", {}),
                "task": self.task, "verdict": self.verdict,
                "hexis_service": {"format": TRACE_EXT, "trace_id": self.trace_id, "source": self.source,
                                  "tenant_id": self.tenant_id, "run_id": self.run_id,
                                  "artifact_hash": self.artifact_hash, "records_digest": self.records_digest()}}
        if self.error_step is not None:
            head["error_step"] = self.error_step
        lines = [json.dumps(head, sort_keys=True, ensure_ascii=False)]
        lines += [json.dumps(r.model_dump(mode="json"), sort_keys=True, ensure_ascii=False) for r in self.records]
        return "\n".join(lines) + "\n"

    @classmethod
    def from_jsonl(cls, text: str) -> tuple["Trace", list[str]]:
        """Parse and return (trace, integrity_errors). Duplicate keys / NaN are rejected outright."""
        rows = [strict_loads(ln) for ln in text.splitlines() if ln.strip()]
        if not rows:
            raise ValueError("empty trace")
        head, body = rows[0], rows[1:]
        ext = head.get("hexis_service") or {}
        task = head.get("task") if isinstance(head.get("task"), dict) else \
            {k: head[k] for k in ("task_id", "input") if k in head}
        t = cls(trace_id=ext.get("trace_id") or str(head.get("task_id", "trace")), task=task,
                verdict=head.get("verdict", "unknown"), error_step=head.get("error_step"), source=ext.get("source", ""),
                tenant_id=ext.get("tenant_id", ""), run_id=ext.get("run_id", ""),
                artifact_hash=ext.get("artifact_hash", ""), records=[Record(**r) for r in body])
        errs = t.integrity_errors(ext.get("records_digest")) if ext else ["no integrity block (unsealed trace)"]
        return t, errs


def export_run_trace(service, run_id: str, principal, verdict: str = "unknown") -> Trace:
    """Build a trace from a run's recorded observations (complete enough for recorded replay)."""
    tenant = principal.tenant_id
    run = service.store.get_run(tenant, run_id)
    pkg = service.package(run["artifact_hash"])
    cps = service.store.checkpoints(tenant, run_id)
    intents = {i["revision"]: i for i in service.store.intents(tenant, run_id)}
    interactions = {}
    for ev in service.store.events(tenant, run_id):
        if ev["type"] == "INTERACTION_OPEN":
            ix = service.store.interaction(tenant, ev["interaction_id"])
            interactions[ix["revision"]] = ix
    first = service.store.events(tenant, run_id)[0]
    recs: list[Record] = []
    cp_by_rev = {c["revision"]: c for c in cps}
    for ev in service.store.events(tenant, run_id):
        if ev["type"] != "OBSERVATION":
            continue
        obs = ev["observation"]
        st = pkg.machine.states[obs["state_id"]]
        a = st.action
        action: dict[str, Any] = {"kind": a.kind}
        meta: dict[str, Any] = {"revision": obs["revision"], "observation": obs,
                                "writes": list(getattr(a, "writes", []) or []),
                                "checkpoint_digest_before": _cp_digest(cp_by_rev.get(obs["revision"]))}
        after = cp_by_rev.get(obs["revision"] + 1)
        if after is not None:
            meta["checkpoint_digest_after"] = _cp_digest(after)
        if a.kind == "tool":
            it = intents.get(obs["revision"])
            action.update({"name": a.name, "input": it["args"] if it else {}, "phase": a.phase})
            if it:
                meta["logical_action_id"] = it["logical_action_id"]
        elif a.kind in ("model", "judge"):
            action.update({"prompt_digest": digest(a.prompt)})
            meta["observable"] = bool(getattr(a, "observable", False))
        elif a.kind == "user":
            ix = interactions.get(obs["revision"])
            meta["interaction_type"] = ix["type"] if ix else ""
        elif a.kind == "end":
            action["terminal"] = a.terminal
        recs.append(Record(step=len(recs), state=st.id, clause=st.clause, action=action, output=obs["outputs"],
                           meta=meta))
    task = {"task_id": run_id, "input": _task_input(first), "initial_checkpoint": cps[0]}
    return Trace(trace_id=f"trace:{run_id}", task=task, verdict=verdict, source=f"run:{run_id}", tenant_id=tenant,
                 run_id=run_id, artifact_hash=run["artifact_hash"], records=recs).seal()


def _cp_digest(cp: Optional[dict]) -> Optional[str]:
    return digest(cp) if cp else None


def _task_input(first_event: dict) -> dict:
    return {"task_input_digest": first_event.get("task_input_digest")}
