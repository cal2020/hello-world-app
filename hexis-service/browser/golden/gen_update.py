"""Golden vectors for HX.update (traces/update.py), HX.reference (demo/reference.py) and the wave-4 cross-module
integration (export_run_trace / propose_update / admit / enroll_protected composed over real runs).

Runs the real Python reference. Everything that flows into JS as input is shipped as JSON *text* (operations,
mutated contracts, traces as JSONL) so its key order survives the sorted-key golden files; JS parses it with
``HX.canonical.strict_loads``.

Files:
* update.json: packages (refined as JSON text), the four reference traces (JSONL + digests), the demo's protected
  run traces (JSONL), REQUEST_INPUT_OPS, policy_widening vectors, evaluate_candidate vectors (incl. the demo's
  step 6b) and archive manifests.
* update_apply.json: apply_ops / _validate_ops vectors (curated and random operation lists).
* update_propose_<n>.json: propose_update(...).to_json() for every reference trace x aligner x parent x archive,
  plus scripted-aligner runs over random operation lists.
* update_integration.json: scenario scripts run through gen_runtime's interpreter (build_env over a temporary
  directory, ManualClock(1790000000.25), timer 0.125*n, seq_uuids ids) extended with update/admission operations.

Ids: ``_common.deterministic_uuids()`` gives every run the same id prefix (a second run in a tenant collides), so the
runs use gen_runtime's ``seq_uuids`` (``HX.env.make_seq_ids(1)`` in JS), as the runtime goldens do.
"""

from __future__ import annotations

import copy
import json
import random
import tempfile
from pathlib import Path

from _common import GOLDEN, ints, write

import gen_runtime as GR
from hexis_service.artifacts.package import Contracts, ExecutionPolicy, MachinePackage
from hexis_service.artifacts.registry import admit
from hexis_service.demo import reference as R
from hexis_service.demo.env import load_catalog, skill_source
from hexis_service.demo.procurement_fixture import deployment_policy
from hexis_service.replay.replay import replay
from hexis_service.traces.model import Trace
from hexis_service.traces.normalize import normalize
from hexis_service.traces.update import (MAX_ATTEMPTS, _validate_ops, apply_ops, archive_manifest,
                                         evaluate_candidate, manifest_digest, policy_widening, propose_update)

SKILL_TEXT = skill_source().text
CATALOG = load_catalog()
INITIAL, REFINED = GR.INITIAL, GR.REFINED
PARENTS = {"initial": INITIAL, "refined": REFINED}


def J(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def exc_rec(exc) -> dict:
    return {"error": type(exc).__name__, "message": str(exc)}


# ---------------------------------------------------------------------------------------------------------------- #
# aligners
# ---------------------------------------------------------------------------------------------------------------- #
class VariantAligner(R.FixtureAligner):
    """tests/replay/test_replay_update.py::test_A18: a competing refinement with a different prompt."""

    def propose(self, ctx):
        ops = super().propose(ctx)
        for o in ops:
            if o["op"] == "add_state":
                o["state"] = {**o["state"], "action": {**o["state"]["action"], "prompt": "Please re-send ids."}}
        return ops


class ScriptAligner:
    """Returns the operations of attempt n (the last script for later attempts), parsed fresh each call."""

    model_id = "script:aligner/1"

    def __init__(self, texts):
        self.texts = texts

    def propose(self, ctx):
        return json.loads(self.texts[min(ctx["attempt"], len(self.texts)) - 1])


ALIGNERS = {"fixture": R.FixtureAligner, "shortcut": R.ShortcutAligner, "breaking": R.BreakingAligner,
            "mismatch": R.MismatchAligner, "variant": VariantAligner}


def fake_context(parent):
    """Context under which the fixture/variant aligners propose REQUEST_INPUT_OPS."""
    return {"events": [{"kind": "user", "outputs": {"document_ids": []}}], "machine": parent.machine.to_json()}


# ---------------------------------------------------------------------------------------------------------------- #
# integration interpreter (gen_runtime's do() plus update / admission operations)
# ---------------------------------------------------------------------------------------------------------------- #
def pkg_of(ctx, name):
    return ctx.cands[name] if name in ctx.cands else GR.PKGS[name]


def traces_of(ctx, names):
    return [t for n in (names or []) for t in ctx.traces[n]]


def do_upd(ctx, op):
    k = op["op"]
    e = ctx.env
    if k == "ref_traces":
        ctx.traces.update({"missing": [R.missing_docs_trace()], "shortcut": [R.shortcut_trace()],
                           "forbidden": [R.forbidden_write_trace()], "duplicate": [R.duplicate_write_trace()]})
        return [t.to_jsonl() for n in ("missing", "shortcut", "forbidden", "duplicate") for t in ctx.traces[n]], None, False
    if k == "candidate":
        parent = pkg_of(ctx, op["parent"])
        al = ALIGNERS[op["aligner"]]()
        cand = apply_ops(parent, al.propose(fake_context(parent)), op.get("trace_ids"))
        if "policy" in op:
            d = cand.to_json()
            d["execution_policy"] = {**d["execution_policy"], **op["policy"]}
            d["artifact_hash"] = ""
            cand = MachinePackage.from_json(d).sealed()
        ctx.cands[op["name"]] = cand
        return {"hash": cand.artifact_hash, "lineage": cand.lineage.model_dump(mode="json")}, None, False
    if k == "propose":
        t = ctx.traces[op["trace"]][op.get("index", 0)]
        prop = propose_update(pkg_of(ctx, op["parent"]), t, traces_of(ctx, op.get("protected")),
                              traces_of(ctx, op.get("negative")), e.catalog, ALIGNERS[op["aligner"]](),
                              SKILL_TEXT if op.get("skill_text", True) else None)
        if prop.candidate is not None and "save" in op:
            ctx.cands[op["save"]] = prop.candidate
        return prop.to_json(), None, False
    if k == "evaluate":
        gates = evaluate_candidate(pkg_of(ctx, op["parent"]), pkg_of(ctx, op["cand"]), ctx.traces[op["trace"]][0],
                                   traces_of(ctx, op.get("protected")), traces_of(ctx, op.get("negative")), e.catalog,
                                   SKILL_TEXT)
        return gates, None, False
    if k == "admit_cand":
        kw = {}
        if "manifest" in op:
            kw["archive_manifest"] = archive_manifest(traces_of(ctx, op["manifest"][0]), traces_of(ctx, op["manifest"][1]))
        a = admit(e.store, pkg_of(ctx, op["pkg"]), e.catalog,
                  expected_parent_hash=pkg_of(ctx, op["parent"]).artifact_hash if op.get("parent") else None,
                  approver=ctx.p(op.get("as", "user:dana")), environment="sandbox", deployment_policy=deployment_policy(),
                  protected=traces_of(ctx, op.get("protected")), negative=traces_of(ctx, op.get("negative")),
                  now=ctx.clock(), skill_text=SKILL_TEXT, **kw)
        return GR.enc_adm(a), None, True
    if k == "start_cand":
        from hexis_service.demo.env import TASK
        h = e.service.start_run(pkg_of(ctx, op["pkg"]).artifact_hash, dict(TASK, **op.get("task", {})),
                                ctx.p(op.get("as", "user:alice")))
        ctx.runs[op["run"]] = h.run_id
        return GR.enc_handle(h), op["run"], True
    if k == "replay_saved":
        return [replay(pkg_of(ctx, op["pkg"]), t, op["mode"]).to_json() for t in ctx.traces[op["traces"]]], None, False
    if k == "manifest":
        return {"manifest": archive_manifest(traces_of(ctx, op["protected"]), traces_of(ctx, op["negative"])),
                "digest": manifest_digest(traces_of(ctx, op["protected"]), traces_of(ctx, op["negative"]))}, None, False
    return GR.do(ctx, op)


def run_script(name, ops):
    with tempfile.TemporaryDirectory() as tmp, GR.seq_uuids():
        ctx = GR.Ctx(Path(tmp))
        ctx.cands = {}
        transcript = []
        for i, op in enumerate(ops):
            entry = {}
            try:
                res, run, take = do_upd(ctx, op)
                entry["result"] = ints(res)
            except (Exception, GR.SimulatedCrash) as exc:  # noqa: BLE001
                entry["error"] = GR.enc_error(exc)
                run, take = op.get("run"), True
            if take and ctx.env is not None:
                sn = GR.snap(ctx, run if run is not None else op.get("run"))
                if i == len(ops) - 1 or "error" in entry or op["op"] in ("admit_cand", "enroll_traces"):
                    entry["snap"] = sn
                else:
                    entry["snap_digest"] = GR.digest(sn)
            transcript.append(entry)
        return {"name": name, "ops": ops, "transcript": transcript}, ctx


ENV, START, RUN, APPROVE = GR.ENV, GR.START, GR.RUN, GR.APPROVE
DEV_ID = "dev:missing-docs-then-supplied"
MISSING_TASK = {"supplier_ref": "SUP-40002", "document_ids": ["DOC-LATE-MISSING"]}

INT_DEMO = [
    ENV, dict(START, request_id="demo-run-1"), RUN, {"op": "restart"}, dict(APPROVE, **{"as": "user:alice"}),
    {"op": "inject", "fault": "timeout_after_commit"}, APPROVE, RUN,
    dict(START, run="r2", task={"supplier_ref": "SUP-55555"}), dict(RUN, run="r2"),
    {"op": "export", "runs": ["r1", "r2"], "save": "prot"},
    {"op": "enroll_traces", "traces": ["prot"]},
    {"op": "ref_traces"},
    {"op": "propose", "save": "refined_p", "parent": "initial", "trace": "missing", "protected": ["prot"],
     "aligner": "fixture"},
    {"op": "admit_cand", "pkg": "refined_p", "parent": "initial", "protected": ["prot", "missing"]},
    {"op": "start_cand", "run": "r3", "pkg": "refined_p", "task": MISSING_TASK},
    dict(RUN, run="r3"), {"op": "resume", "run": "r3", "as": "user:alice", "response": {"document_ids": ["DOC-LATE-40002"]}},
    dict(RUN, run="r3"), dict(APPROVE, run="r3"), dict(RUN, run="r3"),
    {"op": "export", "runs": ["r3"], "save": "late"},
    {"op": "propose", "parent": "refined_p", "trace": "shortcut", "protected": ["prot", "missing"], "aligner": "shortcut"},
    {"op": "candidate", "name": "sc_cand", "parent": "refined_p", "aligner": "shortcut"},
    {"op": "evaluate", "parent": "refined_p", "cand": "sc_cand", "trace": "shortcut", "protected": ["prot", "missing"],
     "negative": ["shortcut"]},
    {"op": "admit_cand", "pkg": "sc_cand", "parent": "refined_p", "protected": ["prot", "missing"], "negative": ["shortcut"]},
    {"op": "enroll_traces", "traces": ["shortcut"]}, {"op": "enroll_traces", "traces": ["forbidden"]},
    {"op": "enroll_traces", "traces": ["shortcut"], "negative": True},
    {"op": "enroll_traces", "traces": ["forbidden"], "negative": True},
    {"op": "enroll_traces", "traces": ["late"]}, {"op": "enroll_traces", "traces": ["late"]},
    {"op": "enroll_traces", "traces": ["duplicate"]}, {"op": "enroll_traces", "traces": ["duplicate"], "negative": True},
    {"op": "enroll_traces", "traces": ["missing", "late"], "as": "user:alice"},
    {"op": "propose", "parent": "refined_p", "trace": "late", "protected": ["prot", "missing"], "aligner": "fixture"},
    {"op": "manifest", "protected": ["prot", "missing", "late"], "negative": ["shortcut", "forbidden"]},
]

INT_ADMIT = [
    ENV, START, RUN, APPROVE, RUN, dict(START, run="r2", task={"supplier_ref": "SUP-55555"}), dict(RUN, run="r2"),
    {"op": "export", "runs": ["r1", "r2"], "save": "prot"},
    {"op": "enroll_traces", "traces": ["prot"]},
    {"op": "ref_traces"},
    {"op": "candidate", "name": "breaking", "parent": "initial", "aligner": "breaking", "trace_ids": [DEV_ID]},
    {"op": "admit_cand", "pkg": "breaking", "parent": "initial", "protected": ["prot", "missing"]},
    {"op": "candidate", "name": "breaking_bare", "parent": "initial", "aligner": "breaking"},
    {"op": "admit_cand", "pkg": "breaking_bare", "parent": "initial", "protected": ["prot"]},
    {"op": "candidate", "name": "refined_c", "parent": "initial", "aligner": "fixture", "trace_ids": [DEV_ID]},
    {"op": "candidate", "name": "refined_wide", "parent": "initial", "aligner": "fixture", "trace_ids": [DEV_ID],
     "policy": {"max_loop_bound": 1000, "capability_ceiling": ["documents:read", "supplier:read", "draft:validate",
                                                               "erp:draft:create", "erp:draft:read", "draft:verify",
                                                               "erp:supplier:activate"]}},
    {"op": "admit_cand", "pkg": "refined_wide", "parent": "initial", "protected": ["prot", "missing"]},
    {"op": "admit_cand", "pkg": "refined_c", "parent": "initial", "protected": ["prot"]},
    {"op": "admit_cand", "pkg": "refined_c", "parent": "initial", "protected": ["missing"]},
    {"op": "admit_cand", "pkg": "refined_c", "parent": "initial", "protected": ["prot", "missing"], "negative": ["missing"]},
    {"op": "admit_cand", "pkg": "refined_c", "parent": "initial", "protected": ["prot", "missing"],
     "manifest": [["prot"], []]},
    {"op": "admit_cand", "pkg": "refined_c", "parent": None, "protected": ["prot", "missing"]},
    {"op": "candidate", "name": "variant_c", "parent": "initial", "aligner": "variant", "trace_ids": [DEV_ID]},
    {"op": "admit_cand", "pkg": "refined_c", "parent": "initial", "protected": ["prot", "missing"], "negative": ["shortcut"],
     "manifest": [["prot", "missing"], ["shortcut"]]},
    {"op": "admit_cand", "pkg": "variant_c", "parent": "initial", "protected": ["prot", "missing"], "negative": ["shortcut"]},
    {"op": "admit_cand", "pkg": "variant_c", "parent": "refined_c", "protected": ["prot", "missing"],
     "negative": ["shortcut"]},
    {"op": "admit_cand", "pkg": "variant_c", "parent": "initial", "protected": ["prot", "missing"]},
    {"op": "admit_cand", "pkg": "refined_c", "parent": "initial", "protected": ["prot", "missing"], "negative": ["shortcut"]},
    {"op": "propose", "parent": "refined_c", "trace": "missing", "protected": ["prot", "missing"], "aligner": "variant"},
    {"op": "propose", "parent": "initial", "trace": "missing", "protected": ["prot"], "aligner": "breaking"},
    {"op": "propose", "parent": "initial", "trace": "missing", "protected": ["prot"], "aligner": "mismatch"},
    {"op": "propose", "parent": "initial", "trace": "forbidden", "protected": ["prot"], "aligner": "fixture"},
    {"op": "propose", "parent": "initial", "trace": "duplicate", "protected": ["prot"], "aligner": "fixture"},
    {"op": "propose", "parent": "refined_c", "trace": "prot", "index": 1, "protected": ["prot"], "aligner": "fixture",
     "skill_text": False},
    {"op": "candidate", "name": "variant_r", "parent": "refined_c", "aligner": "shortcut", "trace_ids": ["x"]},
    {"op": "admit_cand", "pkg": "variant_r", "parent": "refined_c", "protected": ["prot", "missing"],
     "negative": ["shortcut"]},
    {"op": "replay_saved", "traces": "prot", "pkg": "refined_c", "mode": "recorded"},
]

INT_EXPORTS = [
    ENV, START, RUN, APPROVE, RUN,
    dict(START, run="r2", task={"supplier_ref": "SUP-55555"}), dict(RUN, run="r2"),
    dict(START, run="r3", task={"document_ids": ["DOC-W9-10042"]}), dict(RUN, run="r3"),
    {"op": "restart", "model": {"invalid_outputs": 5}}, dict(START, run="r4"), dict(RUN, run="r4"),
    {"op": "restart", "model": {"unavailable": True}}, dict(START, run="r5"), dict(RUN, run="r5"),
    {"op": "restart", "model": {}},
    {"op": "admit_raw", "pkg": "refined"},
    dict(START, run="r6", pkg="refined", task=MISSING_TASK), dict(RUN, run="r6"),
    {"op": "resume", "run": "r6", "as": "user:alice", "response": {"document_ids": ["DOC-LATE-40002"]}},
    dict(RUN, run="r6"), dict(APPROVE, run="r6"), dict(RUN, run="r6"),
    dict(START, run="r7"), dict(RUN, run="r7"),
    dict(START, run="r8", pkg="refined", task=MISSING_TASK), dict(RUN, run="r8"),
    {"op": "resume", "run": "r8", "as": "user:alice", "response": {"document_ids": ["DOC-LATE-MISSING"]}},
    dict(RUN, run="r8"),
    {"op": "inject", "fault": "timeout_after_commit"}, dict(START, run="r9"), dict(RUN, run="r9"),
    dict(APPROVE, run="r9"), dict(RUN, run="r9"),
    {"op": "export", "runs": ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"], "save": "all"},
    {"op": "export", "runs": ["r1"], "save": "rej", "verdict": "rejected"},
    {"op": "export", "runs": ["r2"], "save": "unk", "verdict": "unknown"},
    {"op": "replay_saved", "traces": "all", "pkg": "initial", "mode": "structural"},
    {"op": "replay_saved", "traces": "all", "pkg": "initial", "mode": "recorded"},
    {"op": "replay_saved", "traces": "all", "pkg": "refined", "mode": "structural"},
    {"op": "replay_saved", "traces": "rej", "pkg": "initial", "mode": "structural"},
    {"op": "ref_traces"},
    {"op": "propose", "parent": "initial", "trace": "all", "index": 5, "protected": ["all"], "aligner": "fixture"},
    {"op": "propose", "parent": "initial", "trace": "rej", "protected": ["all"], "aligner": "fixture"},
    {"op": "propose", "parent": "initial", "trace": "all", "index": 7, "protected": [], "aligner": "fixture"},
    {"op": "manifest", "protected": ["all"], "negative": ["rej", "unk"]},
]

INTEGRATION = {"int_demo": INT_DEMO, "int_admit": INT_ADMIT, "int_exports": INT_EXPORTS}


# ---------------------------------------------------------------------------------------------------------------- #
# random operations
# ---------------------------------------------------------------------------------------------------------------- #
STATES = list(INITIAL.machine.states)
CLAUSES = list(INITIAL.contracts.clause_coverage)
SIDS = STATES + ["REQUEST_INPUT", "NEW_A", "NEW_B"]
WEIRD = [None, 5, -1, True, False, 0.5, "", "zzz", [], ["a"], {}, {"a": 1}]
ACTIONS = [
    {"kind": "user", "prompt": "p", "reads": ["missing_document_ids"], "writes": ["document_ids"]},
    {"kind": "user", "prompt": "Need ids", "writes": ["document_ids"]},
    {"kind": "tool", "name": "documents.read", "input": {"document_ids": "{document_ids}"}, "writes": ["docs_status"]},
    {"kind": "tool", "name": "erp.delete_supplier", "writes": ["x"]},
    {"kind": "end", "terminal": "END_UNVERIFIED"},
    {"kind": "model", "prompt": "think", "writes": ["draft"]},
    {"kind": "bogus"},
]
COVERAGES = [
    {"classification": "executable_control", "justification": "j", "states": ["READ_INTAKE", "REQUEST_INPUT"],
     "critical": False},
    {"classification": "executable_control", "justification": "j", "states": ["READ_INTAKE"], "critical": True},
    {"classification": "non_material", "justification": "j", "states": [], "critical": False},
    {"classification": "unsupported", "justification": "j"},
    {"classification": "external_precondition", "justification": "j", "states": []},
    {"classification": "state_local_knowledge", "justification": "j", "states": ["EXTRACT_DRAFT"]},
    {"classification": "magic", "justification": "j"},
    {"justification": "missing class"},
]


def pick(rng, good, p_weird=0.08):
    return copy.deepcopy(rng.choice(WEIRD)) if rng.random() < p_weird else copy.deepcopy(good)


def put(rng, d, key, good, p_missing=0.06, p_weird=0.08):
    r = rng.random()
    if r < p_missing:
        return
    d[key] = copy.deepcopy(rng.choice(WEIRD)) if r < p_missing + p_weird else copy.deepcopy(good)


def rand_sid(rng):
    return pick(rng, rng.choice(SIDS), 0.07)


def rand_op(rng) -> object:
    r = rng.random()
    if r < 0.02:
        return copy.deepcopy(rng.choice(["add_state", ["op"], 5, None]))
    kind = rng.choice(["add_variable", "add_state", "add_edge", "add_edge", "retarget_edge", "retarget_edge",
                       "set_coverage", "match", "match", "ignore", "frobnicate", None])
    o: dict = {}
    if rng.random() > 0.03:
        o["op"] = kind
    if kind == "add_variable":
        put(rng, o, "rationale", "bound a loop")
        put(rng, o, "variable", {"name": rng.choice(["input_requests", "extra_var", "docs_status"]),
                                 "type": rng.choice(["integer", "string", "boolean", "weird"]),
                                 "init": rng.choice([0, None, "a"]), "init_from": None})
        put(rng, o, "contract", {"owner": rng.choice(["engine", "model", "nobody"]),
                                 "schema": rng.choice([{"type": "integer", "minimum": 0}, {"type": "string"}, {}])})
    elif kind == "add_state":
        put(rng, o, "clause", rng.choice(CLAUSES))
        put(rng, o, "rationale", "trace shows it")
        st = {}
        put(rng, st, "id", rng.choice(SIDS), 0.04, 0.05)
        put(rng, st, "clause", "S1.2", 0.3, 0.02)
        put(rng, st, "action", rng.choice(ACTIONS), 0.05, 0.05)
        if rng.random() < 0.8:
            st["transitions"] = [{"if": rng.choice(["", "docs_status == 'missing'"]), "to": rand_sid(rng)}
                                 for _ in range(rng.randint(0, 2))]
        o["state"] = pick(rng, st, 0.04)
        if rng.random() < 0.5:
            o["interaction"] = rng.choice([
                {"type": "input", "response_schema": {"type": "object"}}, {"type": "approval", "approves_state": "X"},
                {"type": "weird"}, None, {}])
    elif kind == "add_edge":
        put(rng, o, "from", rand_sid(rng), 0.04)
        if rng.random() < 0.5:
            o["position"] = rng.choice([0, 1, 2, -1, -9, 99, True, 0.5, "1", None])
        if rng.random() < 0.4:
            o["event_index"] = rng.randint(0, 9)
        put(rng, o, "rationale", "route it")
        edge = {}
        put(rng, edge, "if", rng.choice(["", "docs_status == 'missing' and input_requests < 1",
                                         "docs_status == 'missing'", "nonsense ==", "lookup_status == 'conflict'"]),
            0.1, 0.03)
        put(rng, edge, "to", rand_sid(rng), 0.1, 0.0)
        if rng.random() < 0.3:
            edge["inc"] = rng.choice(["input_requests", "repair_count", None])
        o["edge"] = pick(rng, edge, 0.04)
        if rng.random() < 0.1:
            o["to"] = rand_sid(rng)
    elif kind == "retarget_edge":
        put(rng, o, "from", rand_sid(rng), 0.04)
        put(rng, o, "index", rng.choice([0, 1, 2, -1, -5, 7, True]), 0.05, 0.06)
        put(rng, o, "to", rand_sid(rng), 0.05, 0.0)
        put(rng, o, "rationale", "shorter")
    elif kind == "set_coverage":
        put(rng, o, "clause", rng.choice(CLAUSES + ["S9.9"]), 0.04)
        put(rng, o, "coverage", rng.choice(COVERAGES), 0.04, 0.05)
    elif kind == "match":
        put(rng, o, "event_index", rng.choice([0, 1, 2, 3, 4, 5, 8, 9, 12, 30, -1, -3, -40, True]), 0.05, 0.06)
        put(rng, o, "state", rand_sid(rng), 0.05, 0.0)
        if rng.random() < 0.2:
            o["similarity"] = 0.75
    elif kind == "ignore":
        put(rng, o, "event_index", rng.randint(0, 9))
        if rng.random() < 0.6:
            o["reason"] = rng.choice(["noise", "", None, "duplicate record"])
    return o


def mutate_request_input(rng):
    ops = copy.deepcopy(R.REQUEST_INPUT_OPS)
    for _ in range(rng.randint(1, 3)):
        r = rng.random()
        if r < 0.25 and ops:
            ops.pop(rng.randrange(len(ops)))
        elif r < 0.45:
            ops.insert(rng.randint(0, len(ops)), rand_op(rng))
        elif r < 0.7 and ops:
            o = rng.choice(ops)
            if isinstance(o, dict) and o:
                k = rng.choice(list(o))
                if rng.random() < 0.5:
                    del o[k]
                else:
                    o[k] = copy.deepcopy(rng.choice(WEIRD + SIDS[:3]))
        elif r < 0.85:
            for o in ops:
                if isinstance(o, dict) and o.get("op") == "add_edge":
                    o["position"] = rng.choice([0, 1, 2, -1, 9])
                    if isinstance(o.get("edge"), dict):
                        o["edge"]["to"] = rng.choice(SIDS)
        else:
            ops = ops[:] + [{"op": "retarget_edge", "from": rng.choice(SIDS), "index": rng.choice([0, 1, -1, 3]),
                             "to": rng.choice(SIDS), "rationale": "r"}]
    return ops


def rand_ops(rng):
    if rng.random() < 0.4:
        return mutate_request_input(rng)
    return [rand_op(rng) for _ in range(rng.randint(1, 5))]


# ---------------------------------------------------------------------------------------------------------------- #
# vectors
# ---------------------------------------------------------------------------------------------------------------- #
def apply_vectors(events_by_trace):
    rng = random.Random(6601)
    out = []
    curated = [
        R.REQUEST_INPUT_OPS,
        R.ShortcutAligner().propose({}),
        R.BreakingAligner().propose({}),
        R.MismatchAligner().propose({}),
        [],
        [{"op": "add_state", "rationale": "dup", "state": {"id": "READ_INTAKE", "action": {"kind": "end", "terminal": "END_UNVERIFIED"}}}],
        [{"op": "add_state", "rationale": "x", "state": {"id": "Z", "action": {"kind": "tool", "name": "nope.tool"}}}],
        [{"op": "add_edge", "from": "NOWHERE", "edge": {"to": "READ_INTAKE"}, "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "edge": {"to": "NOWHERE"}, "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "to": "END_UNVERIFIED", "edge": {}, "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "edge": {"to": "END_UNVERIFIED", "if": "docs_status == 'x'"}}],
        [{"op": "retarget_edge", "from": "REPAIR_DRAFT", "index": 9, "to": "REQUEST_APPROVAL", "rationale": "x"}],
        [{"op": "retarget_edge", "from": "REPAIR_DRAFT", "index": -1, "to": "REQUEST_APPROVAL", "rationale": "x"}],
        [{"op": "retarget_edge", "from": "REPAIR_DRAFT", "index": "0", "to": "REQUEST_APPROVAL", "rationale": "x"}],
        [{"op": "retarget_edge", "from": "REPAIR_DRAFT", "to": "REQUEST_APPROVAL", "rationale": "x"}],
        [{"op": "match", "event_index": 99, "state": "READ_INTAKE"}],
        [{"op": "match", "event_index": -1, "state": "END_VERIFIED_DRAFT"}],
        [{"op": "match", "event_index": 0, "state": "NOWHERE"}],
        [{"op": "match", "event_index": True, "state": "REQUEST_APPROVAL"}],
        [{"op": "match", "event_index": "1", "state": "READ_INTAKE"}],
        [{"op": "match", "event_index": 0.5, "state": "READ_INTAKE"}],
        [{"op": "match", "event_index": 0, "state": ["READ_INTAKE"]}],
        [{"op": "ignore", "event_index": 3}],
        [{"op": "ignore", "event_index": 3, "reason": "noise"}],
        [{"op": "rename_state", "from": "A", "to": "B"}],
        [{"op": None}], [{}], ["add_state"], [5],
        [{"op": "add_variable", "rationale": "x", "variable": {"name": "v", "type": "integer", "init": 0},
          "contract": {"owner": "engine", "schema": {"type": "integer"}}}],
        [{"op": "add_variable", "variable": {"name": "v", "type": "integer"}, "contract": {"owner": "engine"}}],
        [{"op": "add_variable", "rationale": "x", "variable": {"name": "v"}}],
        [{"op": "add_variable", "rationale": "x", "contract": {"owner": "engine"}}],
        [{"op": "add_variable", "rationale": "x", "variable": {"name": 5}, "contract": {"owner": "engine"}}],
        [{"op": "set_coverage", "clause": "S1.2", "coverage": COVERAGES[0]}],
        [{"op": "set_coverage", "clause": "S9.9", "coverage": COVERAGES[2]}],
        [{"op": "set_coverage", "clause": "S3.1", "coverage": COVERAGES[2]}],
        [{"op": "set_coverage", "clause": 7, "coverage": COVERAGES[2]}],
        [{"op": "set_coverage", "clause": "S1.2", "coverage": COVERAGES[6]}],
        [{"op": "add_state", "rationale": "x", "state": {"id": 5, "action": {"kind": "end", "terminal": "END_UNVERIFIED"}}},
         {"op": "add_edge", "from": 5, "edge": {"to": "READ_INTAKE"}, "rationale": "x"}],
        [{"op": "add_state", "rationale": "x", "state": {"id": True, "action": {"kind": "user"}}},
         {"op": "match", "event_index": 1, "state": 1}],
        [{"op": "add_state", "rationale": "x", "state": {"id": ["L"], "action": {"kind": "user"}}}],
        [{"op": "add_state", "rationale": "x", "state": "READ_INTAKE"}],
        [{"op": "add_state", "rationale": "x", "state": {"action": {"kind": "user"}}}],
        [{"op": "add_state", "rationale": "x", "state": {"id": "Q", "action": "user"}}],
        [{"op": "add_state", "rationale": "x", "state": {"id": "Q", "action": {"kind": "user"}, "transitions": "abc"}},
         {"op": "add_edge", "from": "Q", "edge": {"to": "READ_INTAKE"}, "rationale": "x"}],
        [{"op": "add_state", "rationale": "x", "state": {"id": "Q", "action": {"kind": "user"}, "transitions": [5]}},
         {"op": "add_edge", "from": "Q", "edge": {"to": "READ_INTAKE"}, "rationale": "x"}],
        [{"op": "add_state", "rationale": "x", "state": {"id": "Q", "action": {"kind": "user"}, "transitions": {}}},
         {"op": "add_edge", "from": "Q", "edge": {"to": "READ_INTAKE"}, "rationale": "x"}],
        [{"op": "add_state", "rationale": "x", "state": {"id": "Q", "action": {"kind": "user"}, "transitions": [["x"]]}},
         {"op": "retarget_edge", "from": "Q", "index": 0, "to": "READ_INTAKE", "rationale": "x"}],
        [{"op": "add_state", "rationale": "x", "state": {"id": "Q", "action": {"kind": "user"}, "transitions": ["s"]}},
         {"op": "retarget_edge", "from": "Q", "index": 0, "to": "READ_INTAKE", "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "edge": ["to"], "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "position": None, "edge": {"to": "END_UNVERIFIED"}, "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "position": 0.5, "edge": {"to": "END_UNVERIFIED"}, "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "position": -9, "edge": {"to": "END_UNVERIFIED", "if": "docs_status == 'x'"},
          "rationale": "x"}],
        [{"op": "add_edge", "from": "READ_INTAKE", "position": 99, "edge": {"to": "END_UNVERIFIED", "if": "docs_status == 'x'"},
          "rationale": "x"}],
    ]
    lists = [("curated", c) for c in curated] + [("random", rand_ops(rng)) for _ in range(330)]
    for i, (kind, ops) in enumerate(lists):
        parent = "initial" if i % 3 else "refined"
        trace = ["missing", "duplicate", "shortcut"][i % 3 if kind == "random" else 0]
        text = J(ops)
        rec = {"kind": kind, "parent": parent, "trace": trace, "ops_json": text,
               "trace_ids": [] if i % 4 == 0 else (["t:1", "t:2"] if i % 4 == 1 else None)}
        try:
            rec["validate"] = {"errors": _validate_ops(PARENTS[parent], json.loads(text), events_by_trace[trace], CATALOG)}
        except Exception as exc:  # noqa: BLE001
            rec["validate"] = exc_rec(exc)
        ops2 = json.loads(text)
        try:
            cand = apply_ops(PARENTS[parent], ops2, rec["trace_ids"])
            rec["apply"] = {"hash": cand.artifact_hash, "lineage": cand.lineage.model_dump(mode="json"),
                            "states": list(cand.machine.states), "widening": policy_widening(PARENTS[parent], cand)}
            rec["ops_after_json"] = J(ops2)
        except Exception as exc:  # noqa: BLE001
            rec["apply"] = exc_rec(exc)
        out.append(rec)
    return out


def mutate_policy(rng, cd, ep):
    r = rng.random()
    b = ep["budgets"]
    if r < 0.25:
        m = rng.randrange(9)
        if m == 0:
            ep["capability_ceiling"].append("erp:supplier:activate")
        elif m == 1:
            ep["capability_ceiling"].pop(rng.randrange(len(ep["capability_ceiling"])))
        elif m == 2:
            ep["capability_ceiling"].reverse()
        elif m == 3:
            ep["fallback_mode"] = rng.choice(["stop_for_review", "sandbox_interpret"])
        elif m == 4:
            b[rng.choice(list(b))] = rng.choice([1, 40, 100000, 5.5])
        elif m == 5:
            ep[rng.choice(["structured_output_repairs", "transport_retries", "approval_expiry_s", "max_loop_bound"])] = \
                rng.choice([0, 1, 2, 3, 86400, 1000])
        elif m == 6:
            ep["write_workflow"] = rng.choice([True, False, 1])
        elif m == 7:
            b["max_spend_usd"] = rng.choice([None, 5, 0.25])
        else:
            ep["max_loop_bound"] = ep["max_loop_bound"]
        return
    if r < 0.35:
        o = cd["ordering"]
        m = rng.randrange(6)
        if m == 0 and o:
            o.pop(rng.randrange(len(o)))
        elif m == 1:
            o.reverse()
        elif m == 2 and o:
            rng.choice(o)["requires"].append("state:READ_INTAKE")
        elif m == 3:
            o.append({"id": "ORD-NEW", "requires": ["state:VALIDATE_DRAFT"], "before": "state:PERSIST_DRAFT"})
        elif m == 4 and o:
            rng.choice(o)["clause"] = "S9.9"
        elif o:
            rng.choice(o)["invalidated_by"] = ["draft"]
        return
    if r < 0.45:
        t = cd["terminals"]
        m = rng.randrange(5)
        k = rng.choice(list(t))
        if m == 0:
            t[k]["category"] = rng.choice(["verified", "unverified", "fallback"])
        elif m == 1:
            t[k]["evidence"] = []
        elif m == 2:
            t[k]["verification_scope"] = "narrower"
        elif m == 3:
            t["END_NEW"] = {"category": "unverified"}
        else:
            t[k]["evidence"] = list(reversed(t[k].get("evidence", [])))
        return
    if r < 0.55:
        ix = cd["interactions"]
        m = rng.randrange(6)
        if m == 0 and ix:
            ix.pop(rng.choice(list(ix)))
        elif m == 1 and ix:
            ix[rng.choice(list(ix))]["required_role"] = "anyone"
        elif m == 2 and ix:
            ix[rng.choice(list(ix))]["response_schema"] = {"type": "object"}
        elif m == 3:
            ix["NEW_IX"] = {"type": "input", "response_schema": {"type": "object", "minProperties": 1}}
        elif m == 4 and ix:
            k = rng.choice(list(ix))
            ix[k] = dict(reversed(list(ix[k].items())))
        elif ix:
            k = rng.choice(list(ix))
            ix[k]["approves_state"] = ix[k].get("approves_state", "")
        return
    if r < 0.65:
        v = cd["variables"]
        m = rng.randrange(6)
        k = rng.choice(list(v))
        if m == 0:
            v.pop(k)
        elif m == 1:
            v[k]["owner"] = rng.choice(["engine", "model", "tool", "user", "task"])
        elif m == 2:
            v[k]["schema"] = {"type": "string", "maxLength": 5}
        elif m == 3:
            v["new_var"] = {"owner": "engine", "schema": {"type": "integer"}}
        elif m == 4:
            sch = v[k].setdefault("schema", {})
            sch["minimum"] = rng.choice([0, 1, True, False, 0.5])
        else:
            v[k] = dict(reversed(list(v[k].items())))
        return
    if r < 0.7:
        f = cd["field_scoped_writes"]
        m = rng.randrange(3)
        if m == 0 and f:
            f.pop(rng.choice(list(f)))
        elif m == 1 and f:
            f[rng.choice(list(f))]["field_key"] = "name"
        else:
            f["NEW_STATE"] = {"variable": "draft", "allowed_fields_from": "validation_issues"}
        return
    if r < 0.78:
        s = cd["task_input_schema"]
        m = rng.randrange(5)
        if m == 0:
            s["minProperties"] = rng.choice([1, True])
        elif m == 1:
            s["additionalProperties"] = rng.choice([True, False, 0])
        elif m == 2:
            s["required"] = list(reversed(s.get("required", [])))
        elif m == 3:
            s.pop("properties", None)
        else:
            cd["task_input_schema"] = dict(reversed(list(s.items())))
        return
    cc = cd["clause_coverage"]
    m = rng.randrange(8)
    k = rng.choice(list(cc))
    if m == 0:
        cc.pop(k)
    elif m == 1:
        cc[k]["classification"] = rng.choice(["executable_control", "state_local_knowledge", "external_precondition",
                                              "unsupported", "non_material"])
    elif m == 2:
        cc[k]["critical"] = not cc[k].get("critical", False)
    elif m == 3:
        cc[k]["states"] = list(reversed(cc[k].get("states", [])))
    elif m == 4:
        cc[k]["states"] = cc[k].get("states", [])[1:]
    elif m == 5:
        cc[k]["states"] = cc[k].get("states", []) + [rng.choice(STATES)]
    elif m == 6:
        cc["S9.9"] = {"classification": "non_material", "justification": "new"}
    else:
        cc[k]["states"] = rng.sample(STATES, rng.randint(0, 3))
        cc[k]["classification"] = "executable_control"


def changed_top(parent, cd):
    """The top-level contract entries whose JSON text (incl. key order) differs from the parent's; JS rebuilds the
    candidate's contracts as the parent's dump with these entries replaced (top-level keys never change order)."""
    base = ints(parent.contracts.model_dump(mode="json", by_alias=True))
    assert list(base) == list(cd)
    return {k: v for k, v in cd.items() if J(v) != J(base[k])}


def widening_vectors():
    rng = random.Random(6602)
    out = []
    while len(out) < 260:
        pname = "initial" if len(out) % 2 == 0 else "refined"
        parent = PARENTS[pname]
        cd = ints(copy.deepcopy(parent.contracts.model_dump(mode="json", by_alias=True)))
        ep = ints(copy.deepcopy(parent.execution_policy.model_dump(mode="json")))
        for _ in range(rng.choice([0, 1, 1, 1, 2, 2, 3])):
            mutate_policy(rng, cd, ep)
        try:
            cand = MachinePackage(machine=parent.machine, source_manifest=parent.source_manifest,
                                  compiler_manifest=parent.compiler_manifest, contracts=Contracts.model_validate(cd),
                                  execution_policy=ExecutionPolicy.model_validate(ep), lineage=parent.lineage).sealed()
        except Exception:  # noqa: BLE001
            continue
        out.append({"parent": pname, "contracts_json": J(changed_top(parent, cd)), "policy_json": J(ep),
                    "findings": policy_widening(parent, cand)})
    # tests/replay/test_review_replay_traces.py X10
    for clause, cov in [("S0.1", COVERAGES[2]), ("S4.1", {"classification": "executable_control", "justification": "x",
                                                         "states": ["REQUEST_APPROVAL"], "critical": False}),
                        ("S3.1", {"classification": "executable_control", "justification": "x",
                                  "states": ["END_UNVERIFIED"], "critical": True}),
                        ("S2.1", {"classification": "unsupported", "justification": "x", "states": [], "critical": False}),
                        ("S1.2", {"classification": "executable_control", "justification": "x", "states": ["READ_INTAKE"],
                                  "critical": False})]:
        cand = apply_ops(INITIAL, [{"op": "set_coverage", "clause": clause, "coverage": cov}])
        cd = ints(cand.contracts.model_dump(mode="json", by_alias=True))
        ep = ints(cand.execution_policy.model_dump(mode="json"))
        out.append({"parent": "initial", "contracts_json": J(changed_top(INITIAL, cd)), "policy_json": J(ep), "x10": clause,
                    "findings": policy_widening(INITIAL, cand)})
    return out


def main():
    # ---- integration scenarios (also the source of the demo's protected run traces) ------------------------- #
    scen = []
    demo_ctx = None
    for name, ops in INTEGRATION.items():
        sc, ctx = run_script(name, ops)
        scen.append(sc)
        if name == "int_demo":
            demo_ctx = ctx
    write("update_integration", {"scenarios": scen})
    PROT = demo_ctx.traces["prot"]

    # ---- reference traces ---------------------------------------------------------------------------------------- #
    refs = {"missing": R.missing_docs_trace(), "shortcut": R.shortcut_trace(), "forbidden": R.forbidden_write_trace(),
            "duplicate": R.duplicate_write_trace()}
    ref_out = {}
    for n, t in refs.items():
        ev, dropped = normalize(t)
        ref_out[n] = {"trace_id": t.trace_id, "jsonl": t.to_jsonl(), "records_digest": t.records_digest(),
                      "header_digest": t.header_digest(), "integrity": t.integrity_errors(),
                      "events": [e.model_dump() for e in ev], "dropped": dropped}
    events_by_trace = {n: normalize(t)[0] for n, t in refs.items()}
    traces = dict(refs, main=PROT[0], conflict=PROT[1])

    # ---- propose_update grid ------------------------------------------------------------------------------------- #
    sc = refs["shortcut"]
    dev = refs["missing"]
    archives = {"empty": ([], []), "protected": (PROT, []), "protected_dev": (PROT + [dev], []), "negative": ([], [sc]),
                "protected_dev_negative": (PROT + [dev], [sc])}
    grid = []
    for pname, parent in PARENTS.items():
        for tname in ("missing", "shortcut", "forbidden", "duplicate", "main", "conflict"):
            for aname in ("fixture", "shortcut", "breaking", "mismatch"):
                for arch, (prot, neg) in archives.items():
                    st = (arch != "negative")
                    prop = propose_update(parent, traces[tname], prot, neg, CATALOG, ALIGNERS[aname](),
                                          SKILL_TEXT if st else None)
                    grid.append({"parent": pname, "trace": tname, "aligner": aname, "archive": arch, "skill_text": st,
                                 "result": ints(prop.to_json())})
    # scripted aligners over random operation lists (two attempts each)
    rng = random.Random(6603)
    scripted = []
    for i in range(220):
        texts = [J(rand_ops(rng) if rng.random() < 0.7 else copy.deepcopy(R.REQUEST_INPUT_OPS))
                 for _ in range(rng.choice([1, 2, 2]))]
        pname = "initial" if i % 4 else "refined"
        tname = rng.choice(["missing"] * 6 + ["duplicate", "conflict"])
        arch = rng.choice(list(archives))
        prot, neg = archives[arch]
        try:
            res = ints(propose_update(PARENTS[pname], traces[tname], prot, neg, CATALOG, ScriptAligner(texts),
                                      SKILL_TEXT).to_json())
        except Exception as exc:  # noqa: BLE001
            res = exc_rec(exc)
        scripted.append({"parent": pname, "trace": tname, "archive": arch, "scripts": texts, "result": res})
    # anchor 1
    anchor1 = propose_update(INITIAL, dev, [], [], CATALOG, R.FixtureAligner(), SKILL_TEXT)
    files = []
    cur, size = [], 0
    for rec in grid + [dict(s, scripted=True) for s in scripted]:
        n = len(json.dumps(rec))
        if cur and size + n > 1_500_000:
            files.append(cur)
            cur, size = [], 0
        cur.append(rec)
        size += n
    if cur:
        files.append(cur)
    for i, recs in enumerate(files, 1):
        write(f"update_propose_{i}", {"vectors": recs})
    for p in sorted(GOLDEN.glob("update_propose_*.json")):
        if int(p.stem.split("_")[-1]) > len(files):
            p.unlink()

    # ---- evaluate_candidate (incl. the demo's step 6b) ----------------------------------------------------------- #
    evals = []
    sc_cand = apply_ops(REFINED, R.ShortcutAligner().propose({}))
    no_approval = sc_cand.model_copy(deep=True)
    no_approval.contracts.interactions.pop("REQUEST_APPROVAL")
    no_approval = no_approval.sealed()
    breaking = apply_ops(INITIAL, R.BreakingAligner().propose({}))
    initial_sc = apply_ops(INITIAL, R.ShortcutAligner().propose({}))
    cands = {"shortcut_on_refined": (REFINED, sc_cand), "no_approval": (INITIAL, no_approval),
             "breaking": (INITIAL, breaking), "refined": (INITIAL, REFINED), "shortcut_on_initial": (INITIAL, initial_sc)}
    for cname, (parent, cand) in cands.items():
        for tname in ("shortcut", "missing"):
            for arch, (prot, neg) in archives.items():
                for st in (True, False):
                    if not st and arch not in ("protected_dev_negative", "empty"):
                        continue
                    g = evaluate_candidate(parent, cand, traces[tname], prot, neg, CATALOG, SKILL_TEXT if st else None)
                    evals.append({"cand": cname, "trace": tname, "archive": arch, "skill_text": st, "gates": ints(g)})
    demo_6b = {"proposal": propose_update(REFINED, sc, PROT + [dev], [], CATALOG, R.ShortcutAligner(), SKILL_TEXT).to_json(),
               "gates": evaluate_candidate(REFINED, sc_cand, sc, PROT + [dev], [sc], CATALOG, SKILL_TEXT)}

    # ---- archive manifests --------------------------------------------------------------------------------------- #
    man = []
    combos = [([], []), (PROT, []), ([], [sc]), (PROT + [dev], [sc, refs["forbidden"]]), ([dev, dev], [dev]),
              (list(refs.values()), list(reversed(list(refs.values()))))]
    for prot, neg in combos:
        man.append({"protected": [t.trace_id for t in prot], "negative": [t.trace_id for t in neg],
                    "manifest": archive_manifest(prot, neg), "digest": manifest_digest(prot, neg)})

    write("update_apply", {"apply": apply_vectors(events_by_trace)})
    write("update", {
        "max_attempts": MAX_ATTEMPTS,
        "initial_hash": INITIAL.artifact_hash, "refined_hash": REFINED.artifact_hash,
        "refined_json": J(REFINED.to_json()),
        "anchor1": {"result": anchor1.to_json(), "candidate_json": J(anchor1.candidate.to_json())},
        "reference": ref_out, "protected_jsonl": [t.to_jsonl() for t in PROT],
        "request_input_ops_json": J(R.REQUEST_INPUT_OPS), "tool_writes": R.TOOL_WRITES,
        "model_ids": {k: v.model_id for k, v in ALIGNERS.items()},
        "aligner_outputs": {k: J(v().propose(fake_context(INITIAL))) for k, v in ALIGNERS.items()},
        "aligner_outputs_refined": {k: J(v().propose(fake_context(REFINED))) for k, v in ALIGNERS.items()},
        "widening": widening_vectors(),
        "evaluate": evals, "demo_6b": ints(demo_6b), "manifests": man,
        "files": len(files),
    })
    print(f"{len(grid)} grid + {len(scripted)} scripted proposals in {len(files)} files; {len(evals)} evaluations")


if __name__ == "__main__":
    main()
