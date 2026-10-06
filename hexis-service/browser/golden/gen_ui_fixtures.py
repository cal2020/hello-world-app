"""UI development fixtures: Python-built packages and step-by-step run snapshots.

Writes golden/ui_fixtures.json:

{
  "packages": {"initial": <MachinePackage dump>, "refined": <MachinePackage dump>},
  "runs": {
    "<name>": {
      "title": str, "package": "initial" | "refined", "task": {...},
      "snapshots": [
        {"op": "start_run" | "advance_run" | "resume_interaction", "actor": "user:...", "response": {...}?,
         "status": run status after the operation, "state": checkpoint.state_id, "revision": int,
         "terminal": state id of the terminal the run ended in (or null),
         "outcome": {"terminal": terminal id, "category": ...} | null,
         "interaction": {"type": "approval" | "input", "state": ...} | null,
         "events": [event types appended by this operation, TIMING excluded],
         "transitions": [{"from", "to", "edge"} for every TRANSITION event so far, in order]}
      ]
    }
  }
}

Runs (Python RunService API, as in demo/procurement_demo.py and tests/integration/test_runs.py):
  happy_path          initial package; one bounded repair; approval by user:bob; END_VERIFIED_DRAFT
  registry_conflict   initial package; SUP-55555 conflicts in the registry; FALLBACK (END_REVIEW, fallback)
  missing_documents   refined package; WAITING_FOR_INPUT, input supplied, approval by user:bob; verified
  repairs_exhausted   initial package (A10); the repair loop edge is traversed twice; END_UNVERIFIED
  readback_retry      initial package; the fake ERP reports the draft unavailable once, so READ_BACK takes
                      its self-loop edge before verification

These fixtures exist for UI development and tests only. The page never embeds them.
Run from golden/: ../../.venv/bin/python gen_ui_fixtures.py
"""

from __future__ import annotations

from _common import deterministic_uuids, ints, write

from hexis_service.artifacts.registry import admit
from hexis_service.demo import reference as R
from hexis_service.demo.env import (TASK, ManualClock, admit_initial, build_env, compile_procurement, load_catalog,
                                    skill_source)
from hexis_service.demo.procurement_fixture import deployment_policy
from hexis_service.traces.update import propose_update

TENANT = "acme"
_OP = {"n": 0}


def op_ids():
    """A fresh deterministic id block for one API call. The service keeps only ``uuid4().hex[:16]`` (the high
    64 bits) for run and interaction ids, and ``deterministic_uuids`` counts in the low bits, so every call gets
    its own high-bit block: run_0000000000000001, ix_0000000000000002, ... stay unique within one store."""
    _OP["n"] += 1
    return deterministic_uuids(start=_OP["n"] << 64)


def build():
    clock = ManualClock(1790000000.25)
    comp = compile_procurement()
    assert comp.status == "validated", comp.attempts
    initial = comp.package
    dev = R.missing_docs_trace()
    prop = propose_update(initial, dev, [], [], load_catalog(), R.FixtureAligner(), skill_source().text)
    assert prop.status == "CANDIDATE", prop.diagnostics
    refined = prop.candidate

    env = build_env(clock=clock)  # in-memory store and fake ERP
    assert admit_initial(env, initial).status == "ADMITTED"
    adm = admit(env.store, refined, env.catalog, expected_parent_hash=initial.artifact_hash,
                approver=env.principal("user:dana"), environment="sandbox", deployment_policy=deployment_policy(),
                protected=[dev], negative=[], now=clock(), skill_text=skill_source().text)
    assert adm.status == "ADMITTED", adm
    packages = {"initial": initial, "refined": refined}

    def recorder(run_id: str, pkg):
        seen = {"n": 0}
        snaps: list[dict] = []

        def snap(op: str, res, actor: str, response=None) -> dict:
            events = env.store.events(TENANT, run_id)
            new = [e["type"] for e in events[seen["n"]:] if e["type"] != "TIMING"]
            seen["n"] = len(events)
            run = env.store.get_run(TENANT, run_id)
            cp = env.service._cp(TENANT, run_id)
            status = res.status if res is not None else run["status"]
            outcome = cp.outcome
            ix = res.interaction if res is not None else None
            s = {
                "op": op, "actor": actor, "status": status, "run_status": run["status"], "state": cp.state_id,
                "revision": cp.revision,
                "terminal": cp.state_id if outcome else None,
                "outcome": {"terminal": outcome["terminal"], "category": outcome["category"]} if outcome else None,
                "interaction": ({"type": ix["type"], "state": ix["state_id"]} if ix else None),
                "events": new,
                "transitions": [{"from": e["from"], "to": e["to"], "edge": e["edge"]["index"]}
                                for e in events if e["type"] == "TRANSITION"],
            }
            if response is not None:
                s["response"] = response
            snaps.append(s)
            return s
        return snap, snaps

    def run(name: str, title: str, pkg_name: str, task: dict, script) -> dict:
        pkg = packages[pkg_name]
        alice = env.principal("user:alice")
        with op_ids():
            h = env.service.start_run(pkg.artifact_hash, task, alice)
        snap, snaps = recorder(h.run_id, pkg)
        snap("start_run", None, "user:alice")
        script(h.run_id, snap)
        last = snaps[-1]
        assert last["run_status"] in ("COMPLETED", "FAILED", "CANCELLED"), (name, last)
        return {"title": title, "package": pkg_name, "task": task, "snapshots": snaps}

    def step_until_blocked(run_id: str, snap, limit: int = 60):
        alice = env.principal("user:alice")
        for _ in range(limit):
            with op_ids():
                res = env.service.advance_run(run_id, alice)
            s = snap("advance_run", res, "user:alice")
            if s["status"] != "RUNNING":
                return res
        raise AssertionError("run did not block")

    def approve(run_id: str, snap, res, who: str = "user:bob"):
        ix = res.interaction
        assert res.status == "WAITING_FOR_APPROVAL", res.status
        with op_ids():
            r = env.service.resume_interaction(run_id, ix["interaction_id"],
                                               {"approval_decision": "approved", "scope_digest": ix["scope_digest"]},
                                               env.principal(who))
        snap("resume_interaction", r, who, {"approval_decision": "approved"})
        return r

    def happy(run_id, snap):
        res = step_until_blocked(run_id, snap)
        r = approve(run_id, snap, res)
        if r.status == "RUNNING":
            step_until_blocked(run_id, snap)

    def until_done(run_id, snap):
        step_until_blocked(run_id, snap)

    def missing(run_id, snap):
        res = step_until_blocked(run_id, snap)
        assert res.status == "WAITING_FOR_INPUT", res.status
        response = {"document_ids": ["DOC-LATE-40002"]}
        with op_ids():
            r = env.service.resume_interaction(run_id, res.interaction["interaction_id"], response,
                                               env.principal("user:alice"))
        snap("resume_interaction", r, "user:alice", response)
        res = step_until_blocked(run_id, snap) if r.status == "RUNNING" else r
        r = approve(run_id, snap, res)
        if r.status == "RUNNING":
            step_until_blocked(run_id, snap)

    def readback(run_id, snap):
        res = step_until_blocked(run_id, snap)
        env.erp.inject("read_unavailable")
        r = approve(run_id, snap, res)
        if r.status == "RUNNING":
            step_until_blocked(run_id, snap)

    runs = {
        "happy_path": run("happy_path", "Clean intake, approved by user:bob", "initial", dict(TASK), happy),
        "registry_conflict": run("registry_conflict", "Registry conflict ends in review", "initial",
                                 dict(TASK, supplier_ref="SUP-55555"), until_done),
        "missing_documents": run("missing_documents", "Missing documents on the refined machine", "refined",
                                 dict(TASK, supplier_ref="SUP-40002", document_ids=["DOC-LATE-MISSING"]), missing),
        "repairs_exhausted": run("repairs_exhausted", "Repairs exhausted ends unverified", "initial",
                                 dict(TASK, document_ids=["DOC-W9-10042"]), until_done),
        "readback_retry": run("readback_retry", "Read-back retried once, then verified", "initial", dict(TASK),
                              readback),
    }
    return {"packages": {k: ints(p.to_json()) for k, p in packages.items()}, "runs": ints(runs)}


def check(data: dict) -> None:
    """Pin the shape the UI tests rely on, so a reference change shows up here first."""
    r = data["runs"]
    hp = r["happy_path"]["snapshots"]
    assert hp[-1]["terminal"] == "END_VERIFIED_DRAFT" and hp[-1]["outcome"]["category"] == "verified"
    assert any(s["status"] == "WAITING_FOR_APPROVAL" for s in hp)
    rc = r["registry_conflict"]["snapshots"][-1]
    assert rc["terminal"] == "FALLBACK" and rc["outcome"] == {"terminal": "END_REVIEW", "category": "fallback"}
    md = r["missing_documents"]["snapshots"]
    assert any(s["status"] == "WAITING_FOR_INPUT" for s in md)
    assert md[-1]["terminal"] == "END_VERIFIED_DRAFT"
    ex = r["repairs_exhausted"]["snapshots"][-1]
    assert ex["terminal"] == "END_UNVERIFIED"
    assert sum(1 for t in ex["transitions"] if (t["from"], t["edge"]) == ("VALIDATE_DRAFT", 1)) == 2
    rb = r["readback_retry"]["snapshots"][-1]
    assert rb["terminal"] == "END_VERIFIED_DRAFT"
    assert any((t["from"], t["to"]) == ("READ_BACK", "READ_BACK") for t in rb["transitions"])


if __name__ == "__main__":
    with deterministic_uuids():
        data = build()
    check(data)
    p = write("ui_fixtures", data)
    for name, run in data["runs"].items():
        last = run["snapshots"][-1]
        print(f"{name}: {len(run['snapshots'])} snapshots, {len(last['transitions'])} transitions, "
              f"ends {last['run_status']} at {last['state']}")
    print("wrote", p)
