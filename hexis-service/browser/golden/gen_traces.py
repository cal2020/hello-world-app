"""Golden vectors for HX.traces, HX.normalize and HX.replay (traces/model.py, traces/normalize.py,
replay/replay.py).

Bases:
* traces exported by Python from real runs (deterministic ids, ManualClock(1790000000.25), timer 0.125*n):
  happy path with approval, registry conflict to review, repairs exhausted, fallback after invalid model
  outputs, model unavailable, and missing documents on the refined package (input request, then approval);
* the reference traces (missing_docs, shortcut, forbidden_write, duplicate_write) and the C30 stateless trace;
* small hand-built packages with hand-built traces for the structural search (UNKNOWN branching, counters,
  guard errors, the node budget, binds, judge and user states).

Vectors: curated cases from the Python tests plus seeded random mutations (records dropped, swapped,
duplicated and altered; outputs changed; observations stripped; header edits; merged lids; noise and unknown
records; tampering with and without resealing; unsealed and partially sealed traces; malformed JSONL).

Each vector is JSONL text encoded against a base trace's lines (an int is a base line, a string a literal line)
plus, for in-memory traces, the private seal that overrides the one read from the header. For each vector the
golden records ``from_jsonl`` (integrity errors or exception class), the loaded trace's dump, its ``to_jsonl``
sha256, ``normalize``, ``eligibility``/``first_step`` and ``replay_structural``/``replay_recorded`` against the
relevant packages.

Files: traces.json (packages, bases, curated vectors) and traces_mut_<n>.json (random mutations).
"""

from __future__ import annotations

import copy
import hashlib
import json
import random
import socket
import uuid
import warnings
from contextlib import contextmanager

from _common import GOLDEN, write

from hexis_service.artifacts.efsm import load_machine
from hexis_service.artifacts.package import Contracts, MachinePackage
from hexis_service.artifacts.registry import admit
from hexis_service.canonical import canonical_bytes, digest
from hexis_service.demo import fakes
from hexis_service.demo import procurement_fixture as PF
from hexis_service.demo import reference as R
from hexis_service.demo.env import TASK, ManualClock, admit_initial, build_env, compile_procurement, load_catalog, \
    skill_source
from hexis_service.replay import replay as RP
from hexis_service.traces.model import Record, Trace, export_run_trace
from hexis_service.traces.normalize import eligibility, first_step, normalize
from hexis_service.traces.update import propose_update

warnings.filterwarnings("ignore")
rng = random.Random(60626264)

# --------------------------------------------------------------------------- packages
comp = compile_procurement()
assert comp.status == "validated", comp.attempts
INITIAL = comp.package
_prop = propose_update(INITIAL, R.missing_docs_trace(), [], [], load_catalog(), R.FixtureAligner(),
                       skill_source().text)
assert _prop.status == "CANDIDATE", _prop.diagnostics
REFINED = _prop.candidate


def pkg_dump(p: MachinePackage) -> dict:
    """Package dump with integral floats as ints (the JS port re-applies float typing when hashing)."""
    return json.loads(json.dumps(p.to_json()), parse_float=lambda s: int(float(s)) if float(s).is_integer() else float(s))


def observable_pkg() -> MachinePackage:
    """C31: EXTRACT_DRAFT made observable."""
    md = INITIAL.machine.to_json()
    md["states"]["EXTRACT_DRAFT"]["action"]["observable"] = True
    return MachinePackage(machine=load_machine(md), source_manifest=INITIAL.source_manifest,
                          compiler_manifest=INITIAL.compiler_manifest, contracts=INITIAL.contracts,
                          execution_policy=INITIAL.execution_policy).sealed()


END = lambda t: {"id": t, "action": {"kind": "end", "terminal": t}, "transitions": []}  # noqa: E731


def mini_package(states, variables, var_contracts, terminals, term_contracts, initial, extra=None):
    md = {"format": "efsm-v1", "skill_id": "mini", "initial": initial, "fallback": "FALLBACK", "max_steps": 50,
          "states": states, "variables": variables, "terminals": terminals}
    cd = {"variables": var_contracts, "terminals": term_contracts, "task_input_schema": {"type": "object"}}
    cd.update(extra or {})
    return MachinePackage(machine=load_machine(md), source_manifest=INITIAL.source_manifest,
                          compiler_manifest=INITIAL.compiler_manifest, contracts=Contracts.model_validate(cd),
                          execution_policy=PF.deployment_policy().execution_policy).sealed()


def tool(name, writes, inp=None, phase="", binds=None):
    return {"kind": "tool", "name": name, "input": inp or {}, "writes": writes, "phase": phase, "binds": binds or {}}


def mini_branch():
    """Zero-width model writes x; guards over x branch on UNKNOWN; tools bind outputs; user + judge states."""
    states = {
        "M": {"id": "M", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": ["x"]},
              "transitions": [{"if": "x > 0", "to": "TA"}, {"if": "x == 0", "to": "TB"}, {"if": "", "to": "FALLBACK"}]},
        "TA": {"id": "TA", "action": tool("tool.a", ["st", "val"], phase="read", binds={"status": "st"}),
               "transitions": [{"if": "st == 'ok'", "to": "U"}, {"if": "", "to": "FALLBACK"}]},
        "TB": {"id": "TB", "action": tool("tool.b", ["st"]),
               "transitions": [{"if": "", "to": "J"}]},
        "U": {"id": "U", "action": {"kind": "user", "prompt": "ok?", "reads": [], "writes": ["answer"]},
              "transitions": [{"if": "answer == 'yes'", "to": "J"}, {"if": "", "to": "FALLBACK"}]},
        "J": {"id": "J", "action": {"kind": "judge", "prompt": "fine?", "reads": ["st"], "writes": ["label"],
                                    "labels": ["ok", "bad", "abstain"]},
              "transitions": [{"if": "label == 'ok'", "to": "OK"}, {"if": "label == 'bad'", "to": "BAD"},
                              {"if": "", "to": "FALLBACK"}]},
        "OK": END("END_OK"), "BAD": END("END_BAD"), "FALLBACK": END("END_REVIEW")}
    variables = [{"name": "x", "type": "integer"}, {"name": "st", "type": "string"}, {"name": "val", "type": "string"},
                 {"name": "answer", "type": "string"}, {"name": "label", "type": "string"}]
    vc = {"x": {"owner": "model", "schema": {"type": "integer"}}, "st": {"owner": "tool", "schema": {"type": "string"}},
          "val": {"owner": "tool", "schema": {"type": "string"}},
          "answer": {"owner": "user", "schema": {"type": "string"}},
          "label": {"owner": "model", "schema": {"enum": ["ok", "bad", "abstain"]}}}
    terms = [{"id": "END_OK", "kind": "unverified"}, {"id": "END_BAD", "kind": "unverified"},
             {"id": "END_REVIEW", "kind": "fallback"}]
    tc = {"END_OK": {"category": "unverified"}, "END_BAD": {"category": "unverified"},
          "END_REVIEW": {"category": "fallback"}}
    return mini_package(states, variables, vc, terms, tc, "M",
                        {"interactions": {"U": {"type": "input", "response_schema": {"type": "object"}}}})


def mini_loop(guard="flag == 'a'"):
    """Zero-width model writes ``flag`` inside a counter loop: UNKNOWN guards make the search grow."""
    states = {
        "L": {"id": "L", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": ["flag"]},
              "transitions": [{"if": guard, "to": "L", "inc": "n"}, {"if": "", "to": "T"}]},
        "T": {"id": "T", "action": tool("tool.t", ["st"]), "transitions": [{"if": "", "to": "OK"}]},
        "OK": END("END_OK"), "FALLBACK": END("END_REVIEW")}
    variables = [{"name": "flag", "type": "string"}, {"name": "n", "type": "integer", "init": 0},
                 {"name": "st", "type": "string"}]
    vc = {"flag": {"owner": "model", "schema": {"type": "string"}},
          "n": {"owner": "engine", "schema": {"type": "integer"}}, "st": {"owner": "tool", "schema": {"type": "string"}}}
    terms = [{"id": "END_OK", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}]
    tc = {"END_OK": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}
    return mini_package(states, variables, vc, terms, tc, "L")


def mini_guard_error():
    """A tool writes a string that a numeric guard compares: evaluate3 raises GuardError."""
    states = {
        "T": {"id": "T", "action": tool("tool.t", ["v"]),
              "transitions": [{"if": "v > 3", "to": "OK"}, {"if": "", "to": "FALLBACK"}]},
        "OK": END("END_OK"), "FALLBACK": END("END_REVIEW")}
    variables = [{"name": "v", "type": "integer"}]
    vc = {"v": {"owner": "tool", "schema": {"type": "integer"}}}
    terms = [{"id": "END_OK", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}]
    tc = {"END_OK": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}
    return mini_package(states, variables, vc, terms, tc, "T")


def mini_counter():
    """A counter seeded from the initial checkpoint; ``inc`` on a non-int value."""
    states = {
        "T": {"id": "T", "action": tool("tool.t", ["v"]),
              "transitions": [{"if": "c < 2", "to": "T", "inc": "c"}, {"if": "", "to": "OK"}]},
        "OK": END("END_OK"), "FALLBACK": END("END_REVIEW")}
    variables = [{"name": "v", "type": "string"}, {"name": "c", "type": "integer", "init": 0}]
    vc = {"v": {"owner": "tool", "schema": {"type": "string"}}, "c": {"owner": "engine", "schema": {"type": "integer"}}}
    terms = [{"id": "END_OK", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}]
    tc = {"END_OK": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}
    return mini_package(states, variables, vc, terms, tc, "T")


def mini_counter_w():
    """An undeclared-init counter written by a tool (Python's int() then sees Unicode digit strings)."""
    states = {
        "T": {"id": "T", "action": tool("tool.t", ["c"]), "transitions": [{"if": "", "to": "OK", "inc": "c"}]},
        "OK": END("END_OK"), "FALLBACK": END("END_REVIEW")}
    variables = [{"name": "c", "type": "string"}]
    vc = {"c": {"owner": "tool", "schema": {}}}
    terms = [{"id": "END_OK", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}]
    tc = {"END_OK": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}
    return mini_package(states, variables, vc, terms, tc, "T")


def mini_counter_init():
    """A task-initialized counter (``init_from``), seeded through the initial checkpoint."""
    states = {
        "T": {"id": "T", "action": tool("tool.t", ["v"]),
              "transitions": [{"if": "", "to": "OK", "inc": "c"}]},
        "OK": END("END_OK"), "FALLBACK": END("END_REVIEW")}
    variables = [{"name": "v", "type": "string"}, {"name": "c", "type": "integer", "init_from": "c"}]
    vc = {"v": {"owner": "tool", "schema": {"type": "string"}}, "c": {"owner": "engine", "schema": {}}}
    terms = [{"id": "END_OK", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}]
    tc = {"END_OK": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}
    return mini_package(states, variables, vc, terms, tc, "T")


PKGS = {"initial": INITIAL, "refined": REFINED, "observable": observable_pkg(), "mini_branch": mini_branch(),
        "mini_loop": mini_loop(), "mini_loop_small": mini_loop("flag == 'a' and n < 3"),
        "mini_guard_error": mini_guard_error(), "mini_counter": mini_counter(), "mini_counter_w": mini_counter_w(),
        "mini_counter_init": mini_counter_init()}


# --------------------------------------------------------------------------- base traces from real runs
class Timer:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return 0.125 * self.n


def new_env(model=None):
    return build_env(clock=ManualClock(1790000000.25), timer=Timer(), model=model)


def approve(env, run_id, ix):
    return env.service.resume_interaction(run_id, ix["interaction_id"],
                                          {"approval_decision": "approved", "scope_digest": ix["scope_digest"]},
                                          env.principal("user:bob"))


@contextmanager
def deterministic_uuids(start: int = 1):
    """uuid4 -> UUID(int=(n << 64) | n): reproducible, and distinct in ``hex[:16]`` (run and interaction ids)."""
    counter = {"n": start}
    real = uuid.uuid4

    def fake():
        n = counter["n"]
        counter["n"] += 1
        return uuid.UUID(int=(n << 64) | n)

    uuid.uuid4 = fake
    try:
        yield counter
    finally:
        uuid.uuid4 = real


RUN_TRACES: dict[str, Trace] = {}
with deterministic_uuids():
    env = new_env()
    assert admit_initial(env, INITIAL).status == "ADMITTED"
    alice = env.principal("user:alice")
    h = env.service.start_run(INITIAL.artifact_hash, TASK, alice)
    r = env.service.run_until_blocked(h.run_id, alice)
    approve(env, h.run_id, r.interaction)
    r = env.service.run_until_blocked(h.run_id, alice)
    assert r.status == "COMPLETED"
    RUN_TRACES["happy"] = export_run_trace(env.service, h.run_id, alice, "accepted")
    h = env.service.start_run(INITIAL.artifact_hash, dict(TASK, supplier_ref="SUP-55555"), alice)
    env.service.run_until_blocked(h.run_id, alice)
    RUN_TRACES["conflict"] = export_run_trace(env.service, h.run_id, alice, "accepted")
    h = env.service.start_run(INITIAL.artifact_hash, dict(TASK, document_ids=["DOC-W9-10042"]), alice)
    r = env.service.run_until_blocked(h.run_id, alice)
    assert r.checkpoint.outcome["terminal"] == "END_UNVERIFIED"
    RUN_TRACES["repairs_exhausted"] = export_run_trace(env.service, h.run_id, alice, "unknown")
    env2 = env.restart(model=fakes.FixtureExtractionModel(invalid_outputs=5))
    h = env2.service.start_run(INITIAL.artifact_hash, TASK, alice)
    r = env2.service.run_until_blocked(h.run_id, alice)
    assert r.checkpoint.outcome["terminal"] == "END_REVIEW"
    RUN_TRACES["fallback"] = export_run_trace(env2.service, h.run_id, alice, "rejected")
    env3 = env.restart(model=fakes.FixtureExtractionModel(unavailable=True))
    h = env3.service.start_run(INITIAL.artifact_hash, TASK, alice)
    env3.service.run_until_blocked(h.run_id, alice)
    RUN_TRACES["unavailable"] = export_run_trace(env3.service, h.run_id, alice)

with deterministic_uuids(1000):
    env = new_env()
    assert admit_initial(env, INITIAL).status == "ADMITTED"
    adm = admit(env.store, REFINED, env.catalog, expected_parent_hash=INITIAL.artifact_hash,
                approver=env.principal("user:dana"), environment="sandbox", deployment_policy=PF.deployment_policy(),
                protected=[R.missing_docs_trace()], negative=[], now=env.clock(), skill_text=skill_source().text)
    assert adm.status == "ADMITTED", adm.reasons
    alice = env.principal("user:alice")
    h = env.service.start_run(REFINED.artifact_hash, dict(TASK, supplier_ref="SUP-40002",
                                                          document_ids=["DOC-LATE-MISSING"]), alice)
    r = env.service.run_until_blocked(h.run_id, alice)
    assert r.status == "WAITING_FOR_INPUT", r.status
    env.service.resume_interaction(h.run_id, r.interaction["interaction_id"], {"document_ids": ["DOC-LATE-40002"]},
                                   alice)
    r = env.service.run_until_blocked(h.run_id, alice)
    approve(env, h.run_id, r.interaction)
    r = env.service.run_until_blocked(h.run_id, alice)
    assert r.status == "COMPLETED"
    RUN_TRACES["refined_missing_docs"] = export_run_trace(env.service, h.run_id, alice, "accepted")


def c30_trace() -> Trace:
    task = dict(TASK)
    x = R.ReferenceExecutor()
    d = x.tool("documents.read", {"document_ids": task["document_ids"]})
    lk = x.tool("supplier.lookup", {"supplier_ref": task["supplier_ref"], "business_unit": task["business_unit"]})
    draft = x.model_step("EXTRACT_DRAFT", {"documents": d["documents"], "supplier_ref": task["supplier_ref"],
                                           "business_unit": task["business_unit"],
                                           "required_fields": task["required_fields"],
                                           "existing_supplier": lk["existing"]})["draft"]
    v = x.tool("draft.validate", {"draft": draft, "required_fields": task["required_fields"],
                                  "policy_version": task["policy_version"]})
    x.user("approval", {"approval_decision": "approved"})
    x.user("input", {"supplier_ref": "SUP-OTHER"})
    x.happy_tail(draft, v["draft_digest"], "SUP-OTHER")
    return x.trace("c30", task)


def mk(trace_id, records, task=None, verdict="accepted", **kw):
    recs = [Record(step=i, **r) for i, r in enumerate(records)]
    return Trace(trace_id=trace_id, task=task if task is not None else {"task_id": trace_id, "input": {}},
                 verdict=verdict, records=recs, source="hand", **kw).seal()


def T(name, out, **meta):
    return {"action": {"kind": "tool", "name": name, "input": {}}, "output": out, "meta": meta}


def E(term):
    return {"action": {"kind": "end", "terminal": term}}


MINI_TRACES = {
    "mb_a_ok": ("mini_branch", mk("mb_a_ok", [T("tool.a", {"status": "ok", "val": "v"}),
                                              {"action": {"kind": "user"}, "output": {"answer": "yes"}}, E("END_OK")])),
    "mb_a_review": ("mini_branch", mk("mb_a_review", [T("tool.a", {"status": "bad"}), E("END_REVIEW")])),
    "mb_b_bad": ("mini_branch", mk("mb_b_bad", [T("tool.b", {"st": "x"}), E("END_BAD")])),
    "mb_user_missing": ("mini_branch", mk("mb_user_missing", [T("tool.a", {"status": "ok"}),
                                                              {"action": {"kind": "user"}, "output": {}},
                                                              E("END_OK")])),
    "mb_phase_mismatch": ("mini_branch", mk("mb_phase_mismatch", [
        {"action": {"kind": "tool", "name": "tool.a", "phase": "write"}, "output": {"status": "ok"}}, E("END_REVIEW")])),
    "mb_wrong_tool": ("mini_branch", mk("mb_wrong_tool", [T("tool.c", {}), E("END_OK")])),
    "mb_observable_judge": ("mini_branch", mk("mb_observable_judge", [
        T("tool.b", {"st": "x"}), {"action": {"kind": "judge"}, "output": {"label": "ok"}, "meta": {"observable": True}},
        E("END_OK")])),
    "mb_no_terminal": ("mini_branch", mk("mb_no_terminal", [T("tool.a", {"status": "ok"})])),
    "mb_extra_after_end": ("mini_branch", mk("mb_extra_after_end", [T("tool.b", {}), E("END_OK"), E("END_OK")])),
    "mb_x_seeded": ("mini_branch", mk("mb_x_seeded", [T("tool.b", {}), E("END_OK")],
                                      task={"task_id": "s", "initial_checkpoint": {"variables": {"x": 0}}})),
    "mb_x_seeded_pos": ("mini_branch", mk("mb_x_seeded_pos", [T("tool.b", {}), E("END_OK")],
                                          task={"task_id": "s", "initial_checkpoint": {"variables": {"x": 5}}})),
    "mb_vars_not_dict": ("mini_branch", mk("mb_vars_not_dict", [E("END_OK")],
                                           task={"initial_checkpoint": {"variables": [1, 2]}})),
    "loop_explodes": ("mini_loop", mk("loop_explodes", [E("END_REVIEW")])),
    "loop_small_ok": ("mini_loop_small", mk("loop_small_ok", [T("tool.t", {"st": "a"}), E("END_OK")])),
    "loop_small_fail": ("mini_loop_small", mk("loop_small_fail", [T("tool.t", {}), T("tool.t", {}), E("END_OK")])),
    "guard_error": ("mini_guard_error", mk("guard_error", [T("tool.t", {"v": "abc"}), E("END_OK")])),
    "guard_ok": ("mini_guard_error", mk("guard_ok", [T("tool.t", {"v": 7}), E("END_OK")])),
    "guard_missing": ("mini_guard_error", mk("guard_missing", [T("tool.t", {}), E("END_OK")])),
    "counter_ok": ("mini_counter", mk("counter_ok", [T("tool.t", {"v": "a"})] * 3 + [E("END_OK")])),
    "counter_seed_bad": ("mini_counter", mk("counter_seed_bad", [T("tool.t", {"v": "a"}), E("END_OK")],
                                            task={"initial_checkpoint": {"variables": {"c": 1}}})),
    "counter_seed_true": ("mini_counter", mk("counter_seed_true", [T("tool.t", {"v": "a"})] * 2 + [E("END_OK")],
                                             task={"initial_checkpoint": {"variables": {"c": False}}})),
    "counter_seed_str": ("mini_counter", mk("counter_seed_str", [T("tool.t", {"v": "a"}), E("END_OK")],
                                            task={"initial_checkpoint": {"variables": {"c": "0"}}})),
    "counter_input": ("mini_counter", mk("counter_input", [T("tool.t", {"v": "a"})] * 3 + [E("END_OK")],
                                         task={"input": {"z": 1}})),
}
# Python's int() accepts Unicode decimal digits (and "_" between digits, surrounding Unicode whitespace)
UNICODE_COUNTERS = ["\u0663", "\uff11", "\U0001D7D9", "\u0661_\u0662", " \u0663\u3000", "-\u0667", "\u0663x", "\u00b2",
                    "\u2160", "\u0663__\u0663", "\U0001E959\U0001E950", "\u0e53\u0e53\u0e53"]
for _i, _c in enumerate(UNICODE_COUNTERS):
    MINI_TRACES[f"counter_w_{_i}"] = ("mini_counter_w", mk(f"counter_w_{_i}", [T("tool.t", {"c": _c}), E("END_OK")]))
    MINI_TRACES[f"counter_icp_{_i}"] = ("mini_counter_init", mk(
        f"counter_icp_{_i}", [T("tool.t", {"v": "a"}), E("END_OK")],
        task={"input": {"c": 0}, "initial_checkpoint": {"variables": {"c": _c}}}))

REF_TRACES = {"missing_docs": R.missing_docs_trace(), "shortcut": R.shortcut_trace(),
              "forbidden_write": R.forbidden_write_trace(), "duplicate_write": R.duplicate_write_trace(),
              "c30": c30_trace()}

BASES: dict[str, Trace] = {**RUN_TRACES, **REF_TRACES, **{k: v[1] for k, v in MINI_TRACES.items()}}
BASE_PKGS = {k: (["initial", "refined"] + (["observable"] if k in RUN_TRACES else [])) for k in {**RUN_TRACES, **REF_TRACES}}
BASE_PKGS.update({k: [v[0]] for k, v in MINI_TRACES.items()})
BASE_LINES = {k: t.to_jsonl().split("\n")[:-1] for k, t in BASES.items()}


# --------------------------------------------------------------------------- recording
def exc_info(e: BaseException) -> dict:
    out = {"exc": type(e).__name__}
    if hasattr(e, "code") and isinstance(getattr(e, "code"), str):
        out["code"] = e.code
    return out


def run(fn):
    try:
        return {"ok": fn()}
    except Exception as e:  # noqa: BLE001
        return exc_info(e)


def pack(v):
    """Small values in full; large ones by canonical digest (+ length) to keep golden files small."""
    try:
        text = canonical_bytes(v).decode()
    except Exception:  # noqa: BLE001
        return {"v": v}
    if len(text) <= 2500:
        return {"v": v}
    return {"d": digest(v), "n": len(text)}


def report(rep):
    j = rep.to_json()
    out = {k: j[k] for k in ("mode", "trace_id", "artifact_hash", "status", "detail", "placeholders", "versions")}
    out["path"] = pack(j["path"])
    out["divergence"] = pack(j["divergence"])
    return out


def encode(text: str, base: str) -> dict:
    """Encode ``text`` against the lines of a base trace."""
    lines = BASE_LINES[base]
    index = {ln: i for i, ln in enumerate(lines)}
    if text.endswith("\n"):
        body, end = text[:-1], "\n"
    else:
        body, end = text, ""
    items = [index.get(ln, ln) for ln in body.split("\n")] if body or end else []
    return {"base": base, "lines": items, "end": end}


def decode(enc: dict) -> str:
    lines = BASE_LINES[enc["base"]]
    return "\n".join(lines[x] if isinstance(x, int) else x for x in enc["lines"]) + enc["end"]


def results(t: Trace, errs: list, pkgs: list[str]) -> dict:
    out = {"errors": errs, "dump": pack(t.model_dump(mode="json")), "seal": dict(t._seal),
           "records_digest": run(t.records_digest), "header_digest": run(t.header_digest),
           "jsonl_sha": run(lambda: hashlib.sha256(t.to_jsonl().encode()).hexdigest())}
    out["integrity_expected"] = {x: t.integrity_errors(x) for x in ("", "sha256:bogus")}
    nr = run(lambda: normalize(t))
    out["normalize"] = ({"events": pack([e.model_dump(mode="json") for e in nr["ok"][0]]), "dropped": nr["ok"][1],
                         "n": len(nr["ok"][0])} if "ok" in nr else nr)
    out["pkgs"] = {}
    for name in pkgs:
        p = PKGS[name]
        el = run(lambda: eligibility(t, p))
        res = {"eligibility": el, "first_step": first_step(el["ok"]) if "ok" in el else None}
        s = run(lambda: RP.replay(p, t, "structural"))
        res["structural"] = {"ok": report(s["ok"])} if "ok" in s else s
        rr = run(lambda: RP.replay(p, t, "recorded"))
        res["recorded"] = {"ok": report(rr["ok"])} if "ok" in rr else rr
        out["pkgs"][name] = res
    return out


def text_vector(name, text, base, pkgs=None, note=""):
    enc = encode(text, base)
    assert decode(enc) == text
    v = {"name": name, "note": note, "text": enc}
    try:
        t, errs = Trace.from_jsonl(text)
    except Exception as e:  # noqa: BLE001
        v["load"] = exc_info(e)
        return v
    v["load"] = {"ok": True}
    v.update(results(t, errs, pkgs if pkgs is not None else BASE_PKGS[base]))
    return v


def memory_vector(name, t: Trace, base, pkgs=None, note=""):
    """An in-memory trace: JSONL of its fields plus the private seal it carries."""
    text = t.to_jsonl()
    seal = dict(t._seal)
    t2, _ = Trace.from_jsonl(text)
    assert t2.model_dump() == t.model_dump()
    t2._seal = dict(seal)
    v = {"name": name, "note": note, "text": encode(text, base), "set_seal": seal, "load": {"ok": True}}
    v.update(results(t2, t2.integrity_errors(), pkgs if pkgs is not None else BASE_PKGS[base]))
    return v


# --------------------------------------------------------------------------- curated vectors
def step_of(t, state):
    return next(i for i, r in enumerate(t.records) if r.state == state)


curated = []
for k, t in BASES.items():
    curated.append(text_vector(f"base:{k}", t.to_jsonl(), k))
    curated.append(memory_vector(f"base-memory:{k}", t, k))

H = RUN_TRACES["happy"]
HL = H.to_jsonl()
curated.append(text_vector("A31 approved->rejected", HL.replace('"approved"', '"rejected"', 1), "happy"))
t = H.model_copy(deep=True)
t.records[3].meta.pop("observation")
curated.append(memory_vector("A31 stripped observation resealed", t.seal(), "happy"))
t = H.model_copy(deep=True)
for r in t.records:
    if r.action.get("kind") == "user":
        r.output = {}
curated.append(memory_vector("A12 user output stripped", t.seal(), "happy"))
lines = HL.splitlines()
idx = step_of(H, "REPAIR_DRAFT")
curated.append(text_vector("C29 deleted record", "\n".join(lines[:idx + 1] + lines[idx + 2:]) + "\n", "happy"))
t = H.model_copy(deep=True)
del t.records[idx]
curated.append(memory_vector("C29 in-memory removal keeps the seal", t, "happy"))
t = H.model_copy(deep=True)
i = step_of(t, "EXTRACT_DRAFT")
t.records[i].meta["observable"] = True
t.records[i].output = {}
curated.append(memory_vector("C31 missing observable output", t.seal(), "happy", ["observable", "initial"]))
for kind in ("orchestration", "log", "tool_call", "heartbeat"):
    recs = [r.model_copy(deep=True) for r in H.records]
    recs.insert(1, Record(step=1000, action={"kind": kind, "name": "erp.create_draft", "input": {"supplier_ref": "EVIL"}},
                          output={"status": "created", "draft_id": "D-9"}))
    curated.append(memory_vector(f"X06 hidden write in {kind}", H.model_copy(update={"records": recs}, deep=True).seal(),
                                 "happy"))
for kind in ("heartbeat", "noop", "log", "orchestration"):
    recs = [r.model_copy(deep=True) for r in H.records]
    recs.insert(1, Record(step=1000, action={"kind": kind}))
    curated.append(memory_vector(f"X06 plain noise {kind}", H.model_copy(update={"records": recs}, deep=True).seal(),
                                 "happy"))
t = H.model_copy(deep=True)
i = step_of(t, "PERSIST_DRAFT")
t.records[i].output = {**t.records[i].output, "draft_id": "D-FORGED"}
curated.append(memory_vector("X07 forged output resealed", t.seal(), "happy"))
t = H.model_copy(deep=True)
for r in t.records:
    r.meta.pop("checkpoint_digest_before", None)
    r.meta.pop("checkpoint_digest_after", None)
v = step_of(t, "VERIFY_PERSISTED")
t.records[v].meta["observation"]["outputs"]["status"] = "mismatch"
t.records[-1].meta["observation"]["state_id"] = "END_UNVERIFIED"
curated.append(memory_vector("X07 no checkpoint digests", t.seal(), "happy"))
t = H.model_copy(deep=True)
for r in t.records:
    r.meta.pop("checkpoint_digest_after", None)
curated.append(memory_vector("X07 only digests before", t.seal(), "happy"))


def edit_header(t, fn):
    lines = t.to_jsonl().splitlines()
    head = json.loads(lines[0])
    fn(head)
    return "\n".join([json.dumps(head, sort_keys=True)] + lines[1:]) + "\n"


curated.append(text_vector("X08 verdict flipped", edit_header(H, lambda h: h.update(verdict="rejected")), "happy"))


def _seed(h):
    h["task"]["initial_checkpoint"]["variables"]["repair_count"] = -10


curated.append(text_vector("X08 counter seeded in header", edit_header(H, _seed), "happy"))
t = H.model_copy(deep=True)
t.task["initial_checkpoint"]["variables"]["repair_count"] = -10
curated.append(memory_vector("X08 counter seeded resealed", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.task["initial_checkpoint"]["variables"]["repair_count"] = True
curated.append(memory_vector("X08 counter seeded True resealed", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.task["initial_checkpoint"]["variables"]["repair_count"] = False
curated.append(memory_vector("X08 counter seeded False resealed (== 0)", t.seal(), "happy"))
recs = [r.model_copy(deep=True) for r in H.records]
idx = step_of(H, "PERSIST_DRAFT")
w2 = recs[idx].model_copy(deep=True)
w2.action["input"] = {"supplier_ref": "SUP-EVIL", "draft": {"x": 1}}
w2.output = {"status": "created", "draft_id": "D-0999", "version": 1}
new = recs[:idx + 1] + [w2] + recs[idx + 1:]
for i, r in enumerate(new):
    r.step = i
curated.append(memory_vector("X09 same lid distinct writes", H.model_copy(update={"records": new}, deep=True).seal(),
                             "happy"))
D = REF_TRACES["duplicate_write"]
t = D.model_copy(deep=True)
t.records[1].meta["logical_action_id"] = t.records[0].meta["logical_action_id"]
t.records[1].action["input"] = t.records[0].action["input"]
curated.append(memory_vector("A16 same logical operation merges", t.seal(), "duplicate_write"))
t2 = t.model_copy(deep=True)
t2.records.insert(1, Record(step=99, action={"kind": "model"}, output={"draft": {}}, meta={"observable": False}))
curated.append(memory_vector("X09 merge does not skip records", t2.seal(), "duplicate_write"))
t3 = t.model_copy(deep=True)
t3.records[1].action["input"] = json.loads(json.dumps(t3.records[0].action["input"]).replace('"SUP-1"', 'true'))
t3.records[0].action["input"] = json.loads(json.dumps(t3.records[0].action["input"]).replace('"SUP-1"', '1'))
curated.append(memory_vector("A16 merge compares inputs with Python == (1 == True)", t3.seal(), "duplicate_write"))
t = H.model_copy(deep=True)
t._seal = {}
curated.append(memory_vector("unsealed", t, "happy"))
t = H.model_copy(deep=True)
t._seal = {"records_digest": H.records_digest()}
curated.append(memory_vector("records digest only (header unsealed)", t, "happy"))
t = H.model_copy(deep=True)
t._seal = {"header_digest": H.header_digest()}
curated.append(memory_vector("header digest only", t, "happy"))
t = H.model_copy(deep=True)
t.records[2].meta["broker_status"] = "DENIED"
curated.append(memory_vector("broker denial", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.verdict, t.error_step = "rejected", 4
curated.append(memory_vector("rejected verdict with error step", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.verdict = "rejected"
curated.append(memory_vector("rejected verdict, no error step", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.task["initial_checkpoint"]["artifact_hash"] = "sha256:other"
curated.append(memory_vector("recorded against another artifact", t.seal(), "happy"))
t = H.model_copy(deep=True)
del t.task["initial_checkpoint"]
curated.append(memory_vector("no initial checkpoint", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.task["initial_checkpoint"] = {"variables": {}}
curated.append(memory_vector("initial checkpoint fails RunCheckpoint validation", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].meta["observation"] = {"run_id": "x"}
curated.append(memory_vector("observation fails Observation validation", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[-1].action["terminal"] = "END_UNVERIFIED"
curated.append(memory_vector("terminal relabelled", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].action["name"] = "documents.write"
curated.append(memory_vector("tool relabelled", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].state = "LOOKUP_SUPPLIER"
curated.append(memory_vector("record state relabelled", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[1].action["kind"] = "model"
curated.append(memory_vector("record kind relabelled", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[1].output = {**t.records[1].output, "status": True}
t.records[1].meta["observation"]["outputs"]["status"] = 1
curated.append(memory_vector("record output == observation outputs under Python == (True == 1)", t.seal(), "happy"))
t = H.model_copy(deep=True)
for r in t.records:
    r.state = ""
curated.append(memory_vector("stateless happy", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].meta["writes"] = 5
curated.append(memory_vector("writes not iterable", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].meta["writes"] = [["x"]]
t.records[1].meta["writes"] = "documents"
curated.append(memory_vector("writes unhashable / string", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[-1].action["terminal"] = ["END_VERIFIED_DRAFT"]
curated.append(memory_vector("terminal unhashable", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].action["labels"] = "ab"
t.records[1].action["labels"] = {"x": 1, "y": 2}
curated.append(memory_vector("tool labels from str and dict", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].action["labels"] = [1]
curated.append(memory_vector("tool labels not strings", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].action["labels"] = 7
curated.append(memory_vector("tool labels not iterable", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].action["phase"] = None
curated.append(memory_vector("tool phase None", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].output = {**t.records[0].output, "status": None}
curated.append(memory_vector("status None -> 'None'", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].output = {**t.records[0].output, "status": {"a": [1, 2.5, True]}}
curated.append(memory_vector("status dict -> repr", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].meta["logical_action_id"] = 17
curated.append(memory_vector("lid int", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[3].action["kind"] = 5
t.records[5].action["kind"] = None
curated.append(memory_vector("kinds not strings", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[3].action["kind"] = ["model"]
curated.append(memory_vector("kind list", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[6].meta["interaction_type"] = 3
curated.append(memory_vector("interaction_type not str", t.seal(), "happy"))
for nm in ("happy", "conflict", "refined_missing_docs"):
    base = RUN_TRACES[nm]
    t = base.model_copy(deep=True)
    t.trace_id = "trace:\u2028line\x85sep"
    curated.append(text_vector(f"line separators inside a value ({nm})", t.seal().to_jsonl(), nm))
t = H.model_copy(deep=True)
t.records[0].output = {**t.records[0].output, "note": "caf\u00e9 \u00ff \U0001f600 \x7f \x1f \"q\" \\ \t"}
curated.append(memory_vector("unicode and escapes in json.dumps", t.seal(), "happy"))
t = H.model_copy(deep=True)
t.records[0].output = {**t.records[0].output, "ratio": 0.1, "big": 1e-7, "neg": -2.5e-300}
curated.append(memory_vector("floats in json.dumps", t.seal(), "happy"))

# the rogue on_step and the on_step call log (JS replays them with its own callbacks)
calls = []
rep = RP.replay(INITIAL, H, "recorded", on_step=lambda cp, obs: calls.append([cp.state_id, cp.revision, obs.state_id,
                                                                              obs.kind]))
on_step = {"calls": calls, "report": report(rep)}


def rogue(cp, obs):
    socket.create_connection(("example.com", 443), timeout=1)


rogue_rep = report(RP.replay(INITIAL, H, "recorded", on_step=rogue))
mode_errors = {m: run(lambda: RP.replay(INITIAL, H, m)) for m in ("sandbox_live", "bogus", "")}

# malformed JSONL
garbage = [
    ("empty", ""), ("whitespace only", " \n\t\n\u3000\n"), ("not json", HL.split("\n")[0] + "\n{oops\n"),
    ("NaN", HL.split("\n")[0] + '\n{"step": NaN}\n'), ("duplicate key", HL.split("\n")[0] + '\n{"step": 0, "step": 1}\n'),
    ("header is a list", "[1, 2]\n"), ("header is a string", '"x"\n'), ("header is null", "null\n"),
    ("record is a list", HL.split("\n")[0] + "\n[1]\n"), ("record extra field", HL.split("\n")[0] + '\n{"step": 0, "bogus": 1}\n'),
    ("record step str", HL.split("\n")[0] + '\n{"step": "3"}\n'), ("record step float", HL.split("\n")[0] + '\n{"step": 1.5}\n'),
    ("record step bool", HL.split("\n")[0] + '\n{"step": true}\n'), ("record no step", HL.split("\n")[0] + '\n{}\n'),
    ("record output list", HL.split("\n")[0] + '\n{"step": 0, "output": []}\n'),
    ("record state int", HL.split("\n")[0] + '\n{"step": 0, "state": 4}\n'),
    ("minimal header", '{"header": true}\n'), ("minimal header task_id int", '{"task_id": 7}\n'),
    ("task_id dict", '{"task_id": {"a": [1, 2.5, null, true]}}\n'), ("task_id float", '{"task_id": 2.5}\n'),
    ("task_id None", '{"task_id": null}\n'), ("ext list", '{"hexis_service": [1]}\n'),
    ("ext string", '{"hexis_service": "x"}\n'), ("ext empty", '{"hexis_service": {}}\n'),
    ("ext falsy 0", '{"hexis_service": 0}\n'), ("ext trace_id empty", '{"hexis_service": {"trace_id": ""}, "task_id": "t"}\n'),
    ("ext source int", '{"hexis_service": {"source": 1}}\n'), ("ext digests not str", '{"hexis_service": {"records_digest": 1, "header_digest": null}}\n'),
    ("verdict bogus", '{"verdict": "maybe"}\n'), ("error_step str", '{"error_step": "4"}\n'),
    ("error_step float", '{"error_step": 4.5}\n'), ("task list", '{"task": [1], "task_id": "x", "input": {"a": 1}}\n'),
    ("task null input", '{"task": null, "input": 5}\n'), ("crlf", HL.replace("\n", "\r\n")), ("cr only", HL.replace("\n", "\r")),
    ("no final newline", HL[:-1]), ("blank lines", HL.replace("\n", "\n\n \t\n")),
    ("form feed separators", HL.replace("\n", "\x0c")), ("vt + fs separators", HL.replace("\n", "\x0b\x1c")),
    ("trailing spaces", HL.replace("\n", "   \n")), ("bom", "\ufeff" + HL),
    ("unicode ws line", HL.replace("\n", "\n\u2000\u00a0\n", 1)),
    ("lone surrogate escape", HL.split("\n")[0] + '\n{"step": 0, "state": "\\ud800"}\n'),
    ("integral float literal", HL.split("\n")[0] + '\n{"step": 0, "output": {"x": 1.0}}\n'),
]
for nm, text in garbage:
    vec = text_vector("malformed: " + nm, text, "happy")
    if nm == "integral float literal":
        # Python loads it (1.0 stays a float); the JS port refuses integral float literals (DEVIATIONS.md).
        vec = {"name": vec["name"], "note": "", "text": vec["text"], "js_deviation": "integral float literal",
               "python_load": vec["load"], "python_errors": vec.get("errors")}
    curated.append(vec)

# --------------------------------------------------------------------------- key order (JS deviation)
# Python's str()/repr() of a dict prints its keys in insertion order; a JS object enumerates integer-like keys
# first, so the port raises KEY_ORDER_UNKNOWN wherever such a dict would be printed into a field (Python's results
# are recorded for the documentation). Texts are written with unsorted keys and sealed by Python.
def _reseal_header(text):
    """Recompute the header's ext digests of ``text`` (keeping its key order and an empty ext trace_id)."""
    lines = text.split("\n")
    t, _ = Trace.from_jsonl(text)
    head = json.loads(lines[0])
    head["hexis_service"]["records_digest"] = t.records_digest()
    head["hexis_service"]["header_digest"] = t.header_digest()
    out = "\n".join([json.dumps(head, ensure_ascii=False)] + lines[1:])
    assert Trace.from_jsonl(out)[1] == [], Trace.from_jsonl(out)[1]
    return out


def _kv(text, old, new_):
    assert old in text, old
    return text.replace(old, new_, 1)


def _with_record(text, after_step, rec):
    """Insert a raw record line (Python-sealed body digest) after the record of ``after_step``."""
    lines = text.split("\n")
    r = Record(**rec)
    rec = {**rec, "meta": {**rec.get("meta", {}), "digest": r.body_digest()}}
    i = next(j for j, ln in enumerate(lines) if j and ln and json.loads(ln)["step"] == after_step)
    return "\n".join(lines[:i + 1] + [json.dumps(rec, ensure_ascii=False)] + lines[i + 1:])


MBL = BASES["mb_a_ok"].to_jsonl()
UNS = '{"b": 1, "1": 2}'
key_order = []
_head = json.loads(MBL.split("\n")[0])
_head["task_id"] = json.loads(UNS)
_head["hexis_service"]["trace_id"] = ""
_tid_text = "\n".join([json.dumps(_head, ensure_ascii=False)] + MBL.split("\n")[1:])
key_order.append(("from_jsonl", "task_id dict with an integer-like key, empty ext trace_id",
                  _reseal_header(_tid_text)))
_head["task_id"] = {"9": 1, "10": 2}
_tid_text = "\n".join([json.dumps(_head, ensure_ascii=False, sort_keys=True)] + MBL.split("\n")[1:])
key_order.append(("from_jsonl", "task_id dict with integer-like keys (sorted text, '10' < '9')",
                  _reseal_header(_tid_text)))
_rec_line = next(ln for ln in MBL.split("\n")[1:] if ln and '"tool.a"' in ln)
_r = json.loads(_rec_line)
_r["output"]["status"] = json.loads(UNS)
_r["meta"]["digest"] = Record(**{k: v for k, v in _r.items() if k != "meta"}, meta={k: v for k, v in _r["meta"].items()
                                                                                    if k != "digest"}).body_digest()
_st_text = _reseal_header(MBL.replace(_rec_line, json.dumps(_r, ensure_ascii=False), 1))
key_order.append(("normalize", "tool output status dict (event outcome)", _st_text))
_r = json.loads(_rec_line)
_r["meta"]["logical_action_id"] = json.loads(UNS)
_r["meta"]["digest"] = Record(**{k: v for k, v in _r.items() if k != "meta"}, meta={k: v for k, v in _r["meta"].items()
                                                                                    if k != "digest"}).body_digest()
key_order.append(("normalize", "logical_action_id dict (event role)",
                  _reseal_header(MBL.replace(_rec_line, json.dumps(_r, ensure_ascii=False), 1))))
key_order.append(("normalize", "unrecognized kind dict (dropped reason, UNRECOGNIZED_RECORD requirement)",
                  _reseal_header(_with_record(MBL, 0, {"step": 50, "action": {"kind": json.loads(UNS)}}))))
# eligibility's str(status) never prints a dict into a value: a non-str status is never positive, even a dict with
# integer-like keys (no KEY_ORDER_UNKNOWN)
eligibility_status = []
_happy = RUN_TRACES["happy"]
_vtools = {ev.verifier_tool for tc in INITIAL.contracts.terminals.values() for ev in tc.evidence}
_vi = max(i for i, r in enumerate(_happy.records) if r.action.get("name") in _vtools)
for _st in [{"b": 1, "1": 2}, {"10": 1, "9": 2}, ["pass"], 1, None, True, "pass", "match", "PASS", {"pass": 1}, 2.5]:
    _recs = [r.model_copy(deep=True) for r in _happy.records]
    _recs[_vi].output["status"] = copy.deepcopy(_st)
    _t = _happy.model_copy(update={"records": _recs})
    eligibility_status.append({"status_json": json.dumps(_st), "base": "happy", "record_index": _vi,
                               "python": {p: run(lambda: eligibility(_t, PKGS[p])) for p in ("initial", "refined")}})
# from_jsonl with a dict task_id whose insertion order JS cannot recover: errors Python raises later in the same
# constructor call (bad records, invalid header fields) come first; only a trace Python builds is KEY_ORDER_UNKNOWN
from_jsonl_order = []
_ok_rec = MBL.split("\n")[1]
for _hd, _recs in [('{"task_id": {"10": 1, "9": 2}, "hexis_service": {}}', ['{"step": "0b1"}']),
                   ('{"task_id": {"b": 1, "1": 2}}', ['{"step": 0, "action": 5}']),
                   ('{"task_id": {"b": 1, "1": 2}}', ['[1]']),
                   ('{"task_id": {"b": 1, "1": 2}, "verdict": 5}', [_ok_rec]),
                   ('{"task_id": {"b": 1, "1": 2}, "hexis_service": {"source": []}}', []),
                   ('{"task_id": {"b": 1, "1": 2}}', [_ok_rec]),
                   ('{"task_id": {"b": 1, "1": 2}}', []),
                   ('{"task_id": {"b": 1, "1": 2}, "hexis_service": {"trace_id": "T"}}', ['{"step": "0b1"}']),
                   ('{"task_id": {"b": 1, "1": 2}, "hexis_service": {"trace_id": "T"}}', [])]:
    _text = "\n".join([_hd] + _recs)
    _r = run(lambda: Trace.from_jsonl(_text))
    if "ok" in _r:
        _r = {"ok": {"trace_id": _r["ok"][0].trace_id, "errors": _r["ok"][1]}}
    from_jsonl_order.append({"text": _text, "python": _r})
key_order_vectors = []
for where, nm, text in key_order:
    pk = ["mini_branch"]
    t, errs = Trace.from_jsonl(text)
    vec = {"name": "key order: " + nm, "where": where, "text": text, "pkgs": pk,
           "python": {"trace_id": t.trace_id, "errors": errs, "header_digest": t.header_digest(),
                      "normalize": run(lambda: [[e.model_dump(mode="json") for e in normalize(t)[0]], normalize(t)[1]]),
                      "replays": {p: {m: run(lambda: report(RP.replay(PKGS[p], t, m)))
                                      for m in ("structural", "recorded")} for p in pk}}}
    vec["python"]["eligibility"] = run(lambda: eligibility(t, PKGS["mini_branch"]))
    key_order_vectors.append(vec)

# Python int() of counter strings (structural replay's ``int(cur or 0) + 1``): every Unicode decimal digit and
# mixed forms
_digits = [chr(c) for c in range(0x110000) if not 0xD800 <= c < 0xE000 and chr(c).isdecimal()]
_ints = _digits + ["\u0661_\u0662", "\u0663__\u0663", "_\u0663", "\u0663_", " \u0663\u3000", "+\uff11\uff10", "-\u0667",
                   "\u2212\u0667", "\u00b2", "\u2160", "\u0663x", "\ufeff\u0663", "\u0663 \u0663", "\u0661" * 15,
                   "".join(_digits[i] for i in range(0, 160, 10))]
py_int_cases = []
for _s in _ints:
    try:
        py_int_cases.append([_s, int(_s)])
    except ValueError:
        py_int_cases.append([_s, None])

# --------------------------------------------------------------------------- random mutations
MUT_BASES = list(RUN_TRACES) + list(REF_TRACES)


def rec_idx(n):
    return rng.randrange(1, n) if n > 1 else None


def alter_obj(obj):
    """A random edit of a record object parsed from JSON."""
    choice = rng.randrange(14)
    out = obj.setdefault("output", {}) if isinstance(obj.get("output"), dict) else obj
    meta = obj.get("meta") if isinstance(obj.get("meta"), dict) else obj.setdefault("meta", {})
    act = obj.get("action") if isinstance(obj.get("action"), dict) else obj.setdefault("action", {})
    if choice == 0:
        out["status"] = rng.choice(["mismatch", "created", "pass", "repairable", "ok", 1, None])
    elif choice == 1:
        obj["output"] = {}
    elif choice == 2:
        obj["state"] = rng.choice(["", "READ_INTAKE", "VALIDATE_DRAFT", "PERSIST_DRAFT", "NOPE"])
    elif choice == 3:
        act["name"] = rng.choice(["documents.read", "erp.create_draft", "draft.validate", "x"])
    elif choice == 4:
        act["kind"] = rng.choice(["tool", "model", "judge", "user", "end", "noop", "log", "weird", ""])
    elif choice == 5:
        meta.pop("observation", None)
    elif choice == 6:
        meta["writes"] = rng.choice([[], ["persist_status"], ["approval_decision"], ["draft"], "draft"])
    elif choice == 7:
        obj["step"] = rng.choice([0, 1, 7, 99, -1])
    elif choice == 8:
        meta["logical_action_id"] = rng.choice(["la_1", "", None])
    elif choice == 9:
        meta.pop("checkpoint_digest_before", None)
    elif choice == 10:
        meta["observable"] = rng.choice([True, False, 1, 0, "yes"])
    elif choice == 11:
        act["terminal"] = rng.choice(["END_VERIFIED_DRAFT", "END_UNVERIFIED", "END_REVIEW", "END_X"])
    elif choice == 12:
        if isinstance(meta.get("observation"), dict):
            o = meta["observation"]
            k = rng.choice(["state_id", "kind", "revision", "outputs"])
            o[k] = {"state_id": "READ_INTAKE", "kind": "tool", "revision": 99, "outputs": {}}[k]
    else:
        meta["interaction_type"] = rng.choice(["approval", "input", ""])
    return obj


def alter_head(h):
    choice = rng.randrange(12)
    if not isinstance(h.get("task"), dict):
        h["task"] = {}
    ext = h.get("hexis_service") if isinstance(h.get("hexis_service"), dict) else {}
    if choice == 0:
        h["verdict"] = rng.choice(["accepted", "rejected", "unknown"])
    elif choice == 1:
        h["error_step"] = rng.choice([0, 3, None])
    elif choice == 2:
        h["task"]["input"] = rng.choice([{}, {"supplier_ref": "SUP-1"}, {"x": 1}])
    elif choice == 3 and isinstance(h["task"].get("initial_checkpoint"), dict):
        h["task"]["initial_checkpoint"]["variables"]["repair_count"] = rng.choice([1, -10, 0])
    elif choice == 4:
        ext["source"] = "forged"
    elif choice == 5:
        ext["trace_id"] = rng.choice(["trace:other", ""])
    elif choice == 6:
        h.pop("hexis_service", None)
    elif choice == 7:
        ext.pop("header_digest", None)
    elif choice == 8:
        ext["records_digest"] = rng.choice([1, None, "sha256:0"])
    elif choice == 9:
        h["task"].pop("initial_checkpoint", None)
    elif choice == 10:
        h.pop("task", None)
    else:
        ext["artifact_hash"] = "sha256:forged"
    return h


def dumps_random(obj):
    if rng.random() < 0.7:
        return json.dumps(obj, sort_keys=True, ensure_ascii=False)
    return json.dumps(obj, ensure_ascii=rng.random() < 0.5, separators=(",", ":"))


def text_mutation(base):
    items = list(range(len(BASE_LINES[base])))
    ops = []
    for _ in range(rng.randint(1, 3)):
        n = len(items)
        op = rng.choice(["drop", "swap", "dup", "alter", "alter", "head", "head", "blank"])
        i = rec_idx(n)
        if op in ("drop", "dup", "alter", "swap") and i is None:
            op = "head"
        line = lambda x: BASE_LINES[base][x] if isinstance(x, int) else x  # noqa: E731
        if op == "drop":
            items.pop(i)
        elif op == "swap":
            j = rec_idx(n)
            items[i], items[j] = items[j], items[i]
        elif op == "dup":
            items.insert(i, items[i])
        elif op == "alter":
            if not line(items[i]).strip():
                continue
            items[i] = dumps_random(alter_obj(json.loads(line(items[i]))))
        elif op == "head":
            if not line(items[0]).strip():
                continue
            items[0] = dumps_random(alter_head(json.loads(line(items[0]))))
        else:
            items.insert(rng.randrange(1, n + 1), rng.choice(["", "  ", "\t"]))
        ops.append(op)
    lines = BASE_LINES[base]
    text = "\n".join(lines[x] if isinstance(x, int) else x for x in items) + "\n"
    if rng.random() < 0.4:
        try:
            text = Trace.from_jsonl(text)[0].seal().to_jsonl()
            ops.append("resealed")
        except Exception:  # noqa: BLE001
            pass
    return text, ops


def memory_mutation(base):
    t = BASES[base].model_copy(deep=True)
    ops = []
    for _ in range(rng.randint(1, 3)):
        n = len(t.records)
        op = rng.choice(["strip_obs", "strip_cp", "output", "merge_lid", "noise", "unknown", "denied", "verdict",
                         "seed", "stateless", "terminal", "tool", "user_out", "observable", "obs_edit", "delete",
                         "renumber", "labels", "itype", "writes", "icp", "input", "reorder", "insert_copy"])
        i = rng.randrange(n) if n else 0
        r = t.records[i] if n else None
        if r is None and op not in ("noise", "unknown", "verdict", "seed", "icp"):
            op = "verdict"
        if op == "strip_obs":
            r.meta.pop("observation", None)
        elif op == "strip_cp":
            for x in t.records:
                x.meta.pop(rng.choice(["checkpoint_digest_before", "checkpoint_digest_after"]), None)
        elif op == "output":
            r.output = rng.choice([{}, {**r.output, "status": "match"}, {**r.output, "extra": 1},
                                   {k: v for k, v in list(r.output.items())[1:]}])
        elif op == "merge_lid":
            if i + 1 < n:
                t.records[i + 1].meta["logical_action_id"] = r.meta.get("logical_action_id", "la_m")
                r.meta.setdefault("logical_action_id", "la_m")
                if rng.random() < 0.7:
                    t.records[i + 1].action = copy.deepcopy(r.action)
        elif op == "noise":
            kind = rng.choice(["heartbeat", "noop", "log", "orchestration"])
            extra = rng.choice([{}, {"name": "erp.create_draft"}, {"terminal": "END_VERIFIED_DRAFT"}, {"input": {}}])
            out = rng.choice([{}, {}, {"x": 1}])
            meta = rng.choice([{}, {}, {"writes": ["x"]}, {"writes": []}])
            t.records.insert(rng.randrange(n + 1), Record(step=rng.choice([500, 1000]), action={"kind": kind, **extra},
                                                          output=out, meta=meta))
        elif op == "unknown":
            t.records.insert(rng.randrange(n + 1), Record(step=777, action={"kind": rng.choice(["tool_call", "?", ""])}))
        elif op == "denied":
            r.meta["broker_status"] = rng.choice(["DENIED", "ALLOWED"])
        elif op == "verdict":
            t.verdict = rng.choice(["accepted", "rejected", "unknown"])
            t.error_step = rng.choice([None, 0, 2])
        elif op == "seed":
            icp = t.task.get("initial_checkpoint")
            if isinstance(icp, dict):
                icp["variables"]["repair_count"] = rng.choice([1, -10, 0, True])
            else:
                t.task["input"] = rng.choice([{}, {"supplier_ref": 5}, {"document_ids": "x"}])
        elif op == "stateless":
            for x in t.records:
                x.state = ""
        elif op == "terminal":
            t.records[-1].action["terminal"] = rng.choice(["END_UNVERIFIED", "END_REVIEW", "END_VERIFIED_DRAFT", "X"])
        elif op == "tool":
            r.action["name"] = rng.choice(["erp.create_draft", "draft.verify_persisted", "documents.read", "zz"])
        elif op == "user_out":
            for x in t.records:
                if x.action.get("kind") == "user":
                    x.output = rng.choice([{}, {"approval_decision": "rejected"}, {"document_ids": []}])
        elif op == "observable":
            for x in t.records:
                if x.action.get("kind") in ("model", "judge"):
                    x.meta["observable"] = rng.choice([True, False])
                    if rng.random() < 0.3:
                        x.output = {}
        elif op == "obs_edit":
            o = r.meta.get("observation")
            if isinstance(o, dict):
                k = rng.choice(["state_id", "kind", "outputs", "revision", "failure"])
                o[k] = {"state_id": "READ_BACK", "kind": "end", "outputs": {"x": 1}, "revision": 42,
                        "failure": "boom"}[k]
        elif op == "delete":
            del t.records[i]
        elif op == "renumber":
            for j, x in enumerate(t.records):
                x.step = j * 2
        elif op == "labels":
            r.action["labels"] = rng.choice([["a"], [], "xy", {"k": 1}])
        elif op == "itype":
            r.meta["interaction_type"] = rng.choice(["approval", "input", ""])
        elif op == "writes":
            r.meta["writes"] = rng.choice([[], ["draft"], ["approval_decision"], ["supplier_ref"], "ab"])
        elif op == "icp":
            icp = t.task.get("initial_checkpoint")
            if isinstance(icp, dict):
                k = rng.choice(["state_id", "revision", "artifact_hash", "variables"])
                icp[k] = {"state_id": "READ_BACK", "revision": 3, "artifact_hash": "sha256:x",
                          "variables": {**icp["variables"], "supplier_ref": "SUP-X"}}[k]
            else:
                t.task["initial_checkpoint"] = {"variables": {}}
        elif op == "input":
            if r.action.get("kind") == "tool":
                r.action["input"] = {"changed": True}
        elif op == "reorder":
            if n > 2:
                j = rng.randrange(n)
                t.records[i], t.records[j] = t.records[j], t.records[i]
        elif op == "insert_copy":
            t.records.insert(i, r.model_copy(deep=True))
        ops.append(op)
    mode = rng.choice(["seal", "seal", "seal", "keep", "unsealed", "partial_r", "partial_h"])
    if mode == "seal":
        t = t.seal()
    elif mode == "unsealed":
        t._seal = {}
    elif mode == "partial_r":
        t = t.seal()
        t._seal.pop("header_digest")
    elif mode == "partial_h":
        t = t.seal()
        t._seal.pop("records_digest")
    return t, ops + ["seal:" + mode]


N_MUT = 440
muts = []
for k in range(N_MUT):
    base = rng.choice(MUT_BASES)
    if rng.random() < 0.45:
        text, ops = text_mutation(base)
        muts.append(text_vector(f"mut{k}:text:{base}", text, base, note=",".join(ops)))
    else:
        t, ops = memory_mutation(base)
        muts.append(memory_vector(f"mut{k}:memory:{base}", t, base, note=",".join(ops)))

# --------------------------------------------------------------------------- write
main = {
    "versions": {"trace_ext": "hexis-trace/1", "normalizer": "hexis-service-trace-normalizer/1",
                 "replay": RP.REPLAY_VERSION, "max_nodes": RP.MAX_NODES},
    "packages": {k: pkg_dump(p) for k, p in PKGS.items()},
    "package_hashes": {k: p.artifact_hash for k, p in PKGS.items()},
    "bases": {k: {"jsonl": t.to_jsonl(), "pkgs": BASE_PKGS[k]} for k, t in BASES.items()},
    "on_step": on_step, "rogue": rogue_rep, "mode_errors": mode_errors, "key_order": key_order_vectors, "eligibility_status": eligibility_status, "from_jsonl_order": from_jsonl_order, "py_int": py_int_cases,
    "curated": curated,
}
write("traces", main)
CHUNK = 110
files = []
for c in range(0, len(muts), CHUNK):
    name = f"traces_mut_{c // CHUNK + 1}"
    write(name, {"vectors": muts[c:c + CHUNK]})
    files.append(name)
main["mutation_files"] = files
write("traces", main)
sizes = {p.name: p.stat().st_size for p in GOLDEN.glob("traces*.json")}
print("curated", len(curated), "mutations", len(muts), sizes)
statuses = {}
for v in curated + muts:
    for pk, res in v.get("pkgs", {}).items():
        for mode in ("structural", "recorded"):
            s = res[mode].get("ok", {}).get("status", res[mode].get("exc"))
            statuses[(mode, s)] = statuses.get((mode, s), 0) + 1
print(sorted(statuses.items()))
