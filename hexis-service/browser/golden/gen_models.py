"""Golden vectors for HX.efsm (artifacts/efsm.py), HX.pkg (artifacts/package.py) and HX.catalog
(tools/catalog.py).

Inputs whose key ORDER matters are transported as JSON text (``*_json``) because golden files are written
with sorted keys; the JS test parses them with ``HX.canonical.strict_loads`` (order preserving).

Files:
  models_efsm.json     load_machine: hand-written + seeded random/fuzzed machines (accept/reject, pydantic
                       error (type, loc) lists, canonical text and dump of accepted ones), helper outputs.
  models_coerce.json   pydantic lax coercions (str/bool/float -> int, str/int/bool -> float, -> bool) fuzz.
  models_pkg.json      Python-built procurement packages (hash anchors), seeded package mutations
                       (accept/reject, canonical digest, compute_hash, verify_hash), judge/float-typed packages,
                       admission signatures.
  models_catalog.json  catalog digest anchor, catalog mutations, check_schemas.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import random
import re

from _common import ints, write

from pydantic import TypeAdapter, ValidationError

from hexis_service.artifacts import efsm as E
from hexis_service.artifacts import package as P
from hexis_service.canonical import canonical_bytes, digest
from hexis_service.demo import procurement_fixture as PF
from hexis_service.demo import reference as R
from hexis_service.demo.env import compile_procurement, load_catalog, skill_source
from hexis_service.tools.catalog import ToolCatalog
from hexis_service.traces.update import propose_update

rng = random.Random(20261006)
SAFE = 2**53 - 1


def jtext(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def outcome(fn, data) -> dict:
    """Run a pydantic validation and describe the result."""
    try:
        m = fn(data)
    except ValidationError as exc:
        return {"py": "error", "errors": sorted([[e["type"], [x for x in e["loc"]]] for e in exc.errors()],
                                               key=lambda x: (x[0], json.dumps(x[1])))}
    except Exception as exc:  # noqa: BLE001 - TypeError from a validator, ValueError from load_machine
        return {"py": "exception", "exc": type(exc).__name__, "message": str(exc)[:200]}
    dump = m.model_dump(mode="json", by_alias=True)
    return {"py": "ok", "model": m, "dump": dump}


# =============================================================================================== #
# efsm: hand-written cases
# =============================================================================================== #
def base(**kw):
    d = {"format": "efsm-v1", "skill_id": "s", "initial": "A",
         "states": {"A": {"id": "A", "action": {"kind": "end", "terminal": "T"}}}}
    d.update(kw)
    return d


def st(action, **kw):
    s = {"id": "A", "action": action}
    s.update(kw)
    return {"A": s}


J = {"kind": "judge", "prompt": "p", "reads": ["a"], "writes": ["b"], "labels": ["abstain"]}
HAND = {
    "minimal": base(),
    "action non-dict": base(states={"A": {"id": "A", "action": "x"}}),
    "action list": base(states={"A": {"id": "A", "action": ["kind"]}}),
    "action no kind": base(states=st({"terminal": "T"})),
    "action kind bad": base(states=st({"kind": "foo"})),
    "action kind int": base(states=st({"kind": 5})),
    "action kind None": base(states=st({"kind": None})),
    "action kind list": base(states=st({"kind": ["end"]})),
    "end extra": base(states=st({"kind": "end", "terminal": "T", "x": 1})),
    "end missing terminal": base(states=st({"kind": "end"})),
    "tool missing name": base(states=st({"kind": "tool"})),
    "tool full": base(states=st({"kind": "tool", "name": "t", "input": {"a": "${x}", "b": [1, {"c": None}]},
                                 "reads": ["x"], "writes": ["y"], "phase": "p", "labels": ["l"],
                                 "binds": {"status": "y"}})),
    "tool binds non-str": base(states=st({"kind": "tool", "name": "t", "binds": {"s": 1}})),
    "tool input list": base(states=st({"kind": "tool", "name": "t", "input": ["a"]})),
    "model full": base(states=st({"kind": "model", "prompt": "p", "reads": ["a"], "writes": ["b"], "introduced": 1,
                                  "observable": "yes", "labels": []})),
    "model missing prompt": base(states=st({"kind": "model"})),
    "user empty": base(states=st({"kind": "user"})),
    "state non-dict": base(states={"A": 5}),
    "state missing id": base(states={"A": {"action": {"kind": "end", "terminal": "T"}}}),
    "states list": base(states=[1]),
    "states None": base(states=None),
    "states empty": base(states={}),
    "states proto names": base(states={"__proto__": {"id": "__proto__", "action": {"kind": "end", "terminal": "T"}},
                                       "constructor": {"id": "constructor", "action": {"kind": "end", "terminal": "T"},
                                                       "transitions": [{"to": "toString"}]}}),
    "trans if+cond": base(states=st({"kind": "end", "terminal": "T"}, transitions=[{"if": "x", "cond": "y", "to": "B"}])),
    "trans cond only": base(states=st({"kind": "end", "terminal": "T"}, transitions=[{"cond": "y", "to": "B"}])),
    "trans cond bad": base(states=st({"kind": "end", "terminal": "T"}, transitions=[{"cond": 5, "to": "B"}])),
    "trans missing to": base(states=st({"kind": "end", "terminal": "T"}, transitions=[{"if": "x"}])),
    "trans inc None": base(states=st({"kind": "end", "terminal": "T"}, transitions=[{"to": "B", "inc": None}])),
    "trans support str": base(states=st({"kind": "end", "terminal": "T"}, transitions=[{"to": "B", "support": " 7 "}])),
    "trans support float": base(states=st({"kind": "end", "terminal": "T"}, transitions=[{"to": "B", "support": 7.5}])),
    "trans non-dict": base(states=st({"kind": "end", "terminal": "T"}, transitions=["B"])),
    "judge ok": base(states=st(J)),
    "judge prompt+question": base(states=st({**J, "question": "q"})),
    "judge question only": base(states=st({k: v for k, v in {**J, "question": "q"}.items() if k != "prompt"})),
    "judge question bad": base(states=st({k: v for k, v in {**J, "question": 5}.items() if k != "prompt"})),
    "judge no prompt": base(states=st({k: v for k, v in J.items() if k != "prompt"})),
    "judge abstain not in labels": base(states=st({**J, "labels": ["x"]})),
    "judge legacy": base(states=st({**J, "labels": ["abstain", "弃权", "x"]})),
    "judge legacy first": base(states=st({**J, "labels": ["弃权", "abstain"]})),
    "judge legacy only": base(states=st({**J, "labels": ["yes", "弃权"]})),
    "judge empty reads": base(states=st({**J, "reads": []})),
    "judge empty writes": base(states=st({**J, "writes": []})),
    "judge 2 writes": base(states=st({**J, "writes": ["b", "c"]})),
    "judge labels int": base(states=st({**J, "labels": 5})),
    "judge labels true": base(states=st({**J, "labels": True})),
    "judge labels false": base(states=st({**J, "labels": False})),
    "judge labels str": base(states=st({**J, "labels": "abstain"})),
    "judge labels dict": base(states=st({**J, "labels": {"abstain": 1}})),
    "judge labels mixed": base(states=st({**J, "labels": [5, "abstain", ["x"]], "abstain": None})),
    "judge abstain 0": base(states=st({**J, "abstain": 0})),
    "judge abstain empty list": base(states=st({**J, "labels": ["x"], "abstain": []})),
    "judge abstain 5": base(states=st({**J, "abstain": 5})),
    "judge abstain explicit": base(states=st({**J, "labels": ["abstain", "x"], "abstain": "x"})),
    "judge missing reads + bad labels": base(states=st({k: v for k, v in {**J, "labels": ["x"]}.items() if k != "reads"})),
    "judge error_rate int": base(states=st({**J, "error_rate": 1})),
    "judge error_rate str": base(states=st({**J, "error_rate": "0.25"})),
    "judge error_rate bool": base(states=st({**J, "error_rate": True})),
    "judge examples": base(states=st({**J, "examples": [{"label": "x", "z": 1, "a": [1]}, {"q": 1}]})),
    "judge examples extras": base(states=st({**J, "examples": [{"z": {"deep": [None, True]}, "label": "abstain"}]})),
    "judge examples non-dict": base(states=st({**J, "examples": ["x"]})),
    "var init+from": base(variables=[{"name": "v", "init": 0, "init_from": "x"}]),
    "var init False+from": base(variables=[{"name": "v", "init": False, "init_from": "x"}]),
    "var init None+from": base(variables=[{"name": "v", "init": None, "init_from": "x"}]),
    "var init object": base(variables=[{"name": "v", "type": "object", "init": {"b": 1, "a": [0.5, "x"]}}]),
    "var bad type": base(variables=[{"name": "v", "type": "str"}]),
    "var missing name": base(variables=[{"type": "string"}]),
    "var init_from int": base(variables=[{"name": "v", "init_from": 3}]),
    "two errors": base(max_steps="x", version=1),
    "max_steps coerce": base(max_steps="  12 "),
    "max_steps bool": base(max_steps=True),
    "max_steps float": base(max_steps=12.5),
    "format missing": {"skill_id": "s", "initial": "A"},
    "format wrong": base(format="efsm-v2"),
    "format None": base(format=None),
    "not a dict": ["format", "efsm-v1"],
    "prohib no pattern": base(prohibitions=[{"id": "p", "check": "absent"}]),
    "prohib null pattern": base(prohibitions=[{"id": "p", "check": "absent", "pattern": None}]),
    "prohib any pattern": base(prohibitions=[{"id": "p", "check": "regex", "pattern": {"re": "^a", "n": [1, 2.5]}}]),
    "prohib bad check": base(prohibitions=[{"id": "p", "check": "nope", "pattern": 1}]),
    "thresholds int": base(thresholds={"holdout_ratio": 1, "min_support": "3", "acc_thr": True}),
    "thresholds all coerced": base(thresholds={"min_support": False, "holdout_ratio": " 0.5 ", "acc_thr": "1",
                                               "retry_budget": "1_0", "loop_margin": 2, "fallback_rate_target": "1e-1",
                                               "judge_rewrite_max": "7.000", "judge_err_max": 0}),
    "thresholds extra": base(thresholds={"x": 1}),
    "thresholds None": base(thresholds=None),
    "thresholds bad str": base(thresholds={"acc_thr": "high"}),
    "extra top": base(extra=1),
    "audit_tools bad": base(audit_tools="t"),
    "terminals": base(terminals=[{"id": "T", "kind": "verified", "output": ["a"]}, {"id": "U"}]),
    "terminal bad output": base(terminals=[{"id": "T", "output": [1]}]),
    "unicode": base(skill_id="😀 skill é", states={"Ω": {"id": "Ω", "action": {"kind": "end", "terminal": "终"}}},
                    initial="Ω"),
}

# =============================================================================================== #
# efsm: seeded random machines
# =============================================================================================== #
SIDS = ["A", "B", "C", "READ_INTAKE", "S_1", "état", "Ω", "😀", "__proto__", "constructor", "toString", "x y", ""]
VNAMES = ["x", "y", "flag", "count", "items", "label", "draft", "constructor", "__proto__", "é", "hasOwnProperty"]
TOOLS = ["documents.read", "erp.create_draft", "t", "valueOf"]
GUARDS = ["", "", "x == 'a'", "count < 2", "flag and not y", "label in ['a', 'b']", "nonempty(items)"]
WEIRD = [None, True, False, 0, 1, -7, 2.5, "x", "", "3", "yes", [], {}, ["a"], {"k": "v"}, [1, 2], -0.125]


def coerce_int(v: int):
    r = rng.random()
    if r < 0.75:
        return v
    return rng.choice([str(v), f" {v} ", f"{v}.0", True if v == 1 else v, f"+{v}" if v >= 0 else str(v),
                       "1_0" if v == 10 else str(v)])


def coerce_float():
    r = rng.random()
    if r < 0.3:
        return rng.choice([0.25, 0.5, 0.125, 1.5, 0.1, 0.9, 3.75])
    if r < 0.6:
        return rng.choice([0, 1, 2, 10])
    return rng.choice([True, False, "0.5", " 2 ", "1_0.5", ".25", "3", "1e-3"])


def coerce_bool():
    return rng.choice([True, False, True, False, 0, 1, "yes", "off", "T", "false", "1"])


def maybe(d: dict, key: str, val, p: float = 0.5):
    if rng.random() < p:
        d[key] = val


def strs(pool, lo=0, hi=3):
    return [rng.choice(pool) for _ in range(rng.randint(lo, hi))]


def rand_action(tids):
    kind = rng.choice(["tool", "model", "judge", "user", "end", "end"])
    if kind == "tool":
        a = {"kind": "tool", "name": rng.choice(TOOLS)}
        maybe(a, "input", {k: rng.choice(["${" + rng.choice(VNAMES) + "}", "lit", 5, [1, "a"], {"n": None}])
                           for k in strs(["a", "b", "document_ids", "draft"], 0, 3)})
        maybe(a, "reads", strs(VNAMES))
        maybe(a, "writes", strs(VNAMES))
        maybe(a, "phase", rng.choice(["", "read", "write"]))
        maybe(a, "labels", strs(["l1", "l2"]))
        maybe(a, "binds", {k: rng.choice(VNAMES) for k in strs(["status", "draft_id", "constructor"], 0, 2)})
        return a
    if kind == "model":
        a = {"kind": "model", "prompt": rng.choice(["Extract.", "", "é😀"])}
        maybe(a, "reads", strs(VNAMES))
        maybe(a, "writes", strs(VNAMES, 1, 2))
        maybe(a, "introduced", coerce_bool(), 0.3)
        maybe(a, "observable", coerce_bool(), 0.3)
        maybe(a, "labels", strs(["a"]), 0.2)
        return a
    if kind == "judge":
        labels = strs(["ok", "bad", "abstain", "弃权"], 1, 4)
        a = {"kind": "judge", ("prompt" if rng.random() < 0.8 else "question"): "Is it ok?",
             "reads": strs(VNAMES, 1, 2), "writes": [rng.choice(VNAMES)], "labels": labels}
        maybe(a, "abstain", rng.choice(labels + ["", None]), 0.3)
        maybe(a, "examples", [{"label": rng.choice(labels), "input": {"x": 1}} for _ in range(rng.randint(0, 2))], 0.3)
        maybe(a, "error_rate", coerce_float(), 0.4)
        maybe(a, "support", coerce_int(rng.randint(0, 5)), 0.3)
        maybe(a, "introduced", coerce_bool(), 0.2)
        maybe(a, "gold_from", "trace", 0.2)
        return a
    if kind == "user":
        a = {"kind": "user"}
        maybe(a, "prompt", "Approve?")
        maybe(a, "reads", strs(VNAMES))
        maybe(a, "writes", strs(VNAMES, 0, 1))
        maybe(a, "labels", strs(["approved", "rejected"]))
        return a
    return {"kind": "end", "terminal": rng.choice(tids)}


def rand_machine() -> dict:
    sids = rng.sample(SIDS, rng.randint(1, 5))
    tids = ["T1", "T2", "END_REVIEW"]
    states = {}
    for sid in sids:
        s = {"id": sid if rng.random() < 0.9 else rng.choice(SIDS), "action": rand_action(tids)}
        maybe(s, "clause", rng.choice(["S1.1", "", "S0.2"]))
        trans = []
        for _ in range(rng.randint(0, 3)):
            t = {("if" if rng.random() < 0.85 else "cond"): rng.choice(GUARDS), "to": rng.choice(sids + ["NOWHERE"])}
            maybe(t, "inc", rng.choice([None, "count", "x"]), 0.3)
            maybe(t, "support", coerce_int(rng.randint(0, 9)), 0.3)
            maybe(t, "origin", rng.choice(["document", "trace"]), 0.3)
            trans.append(t)
        if trans or rng.random() < 0.5:
            s["transitions"] = trans
        maybe(s, "origin", "document", 0.3)
        maybe(s, "locator", "L1", 0.2)
        states[sid] = s
    m = {"format": "efsm-v1", "skill_id": rng.choice(["skill", "supplier-onboarding-draft", "é"]),
         "initial": rng.choice(sids)}
    maybe(m, "version", rng.choice(["0.1.0", "2"]))
    maybe(m, "fallback", rng.choice(sids + ["FALLBACK"]))
    maybe(m, "max_steps", coerce_int(rng.randint(1, 64)))
    m["states"] = states
    if rng.random() < 0.8:
        vs = []
        for n in rng.sample(VNAMES, rng.randint(0, 4)):
            v = {"name": n}
            maybe(v, "type", rng.choice(E.VarType.__args__))
            r = rng.random()
            if r < 0.3:
                v["init"] = rng.choice([0, "a", [1, 2], {"k": [None]}, False, 0.5])
            elif r < 0.6:
                v["init_from"] = "task.input." + n
            elif r < 0.65:
                v["init"], v["init_from"] = None, "task.input.x"
            vs.append(v)
        m["variables"] = vs
    maybe(m, "terminals", [{"id": t, "kind": rng.choice(["verified", "unverified", "fallback", ""]),
                            "output": strs(VNAMES)} for t in rng.sample(tids, rng.randint(0, 3))], 0.7)
    maybe(m, "prohibitions", [{"id": "P" + str(i), "check": rng.choice(E.Prohibition.model_fields["check"].annotation.__args__),
                               "pattern": rng.choice([None, "^x", ["a", 1], {"tool": "t"}])}
                              for i in range(rng.randint(0, 2))], 0.3)
    if rng.random() < 0.5:
        th = {}
        for f in ("min_support", "retry_budget", "judge_rewrite_max"):
            maybe(th, f, coerce_int(rng.randint(0, 5)), 0.4)
        for f in ("holdout_ratio", "acc_thr", "loop_margin", "fallback_rate_target", "judge_err_max"):
            maybe(th, f, coerce_float(), 0.4)
        m["thresholds"] = th
    maybe(m, "audit_tools", strs(TOOLS), 0.3)
    maybe(m, "phase_rules", "rules", 0.2)
    return m


def paths(obj, prefix=()):
    """All (container path, key) positions in a JSON document."""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append((prefix, k))
            out += paths(v, prefix + (k,))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.append((prefix, i))
            out += paths(v, prefix + (i,))
    return out


def at(obj, path):
    for k in path:
        obj = obj[k]
    return obj


def mutate(doc, n_ops: int, extra_keys=("extra", "bogus", "x_1")) -> list:
    """Apply random mutations in place; return the op list (transportable, replayed by the JS test)."""
    ops = []
    for _ in range(n_ops):
        ps = paths(doc)
        if not ps:
            break
        parent_path, key = rng.choice(ps)
        parent = at(doc, parent_path)
        r = rng.random()
        if r < 0.5:
            val = copy.deepcopy(rng.choice(WEIRD))
            parent[key] = val
            ops.append(["set", list(parent_path) + [key], val])
        elif r < 0.7 and isinstance(parent, dict):
            del parent[key]
            ops.append(["del", list(parent_path) + [key]])
        elif r < 0.85 and isinstance(parent, dict):
            nk = rng.choice(extra_keys)
            parent[nk] = copy.deepcopy(rng.choice(WEIRD))
            ops.append(["set", list(parent_path) + [nk], parent[nk]])
        elif isinstance(parent, list) and parent:
            parent.pop(key)
            ops.append(["pop", list(parent_path) + [key]])
        else:
            val = copy.deepcopy(rng.choice(WEIRD))
            parent[key] = val
            ops.append(["set", list(parent_path) + [key], val])
    return ops


def efsm_case(name, data, fn=E.load_machine):
    r = outcome(fn, data)
    case = {"name": name, "input_json": jtext(data), "py": r["py"]}
    if r["py"] == "ok":
        m = r["model"]
        case["canonical"] = canonical_bytes(r["dump"]).decode("utf-8")
        case["dump_json"] = jtext(ints(r["dump"]))
        case["ordered"] = {sid: [t.to for t in s.ordered_transitions()] for sid, s in m.states.items()}
        case["var_types"] = [[k, v] for k, v in m.var_types().items()]
        names = [v.name for v in m.variables] + ["missing", "constructor"]
        case["vars"] = {n: (m.var(n).model_dump(mode="json") if m.var(n) else None) for n in names}
        tids = [t.id for t in m.terminals] + ["nope", "toString"]
        case["terminals"] = {t: (m.terminal(t).model_dump(mode="json") if m.terminal(t) else None) for t in tids}
    elif r["py"] == "error":
        case["errors"] = r["errors"]
    else:
        case["exc"] = r["exc"]
    return case


efsm_cases = [efsm_case(k, v) for k, v in HAND.items()]
efsm_cases.append(efsm_case("Machine.model_validate without format", {"skill_id": "s", "initial": "A"},
                            E.Machine.model_validate))
for i in range(260):
    m = rand_machine()
    if rng.random() < 0.55:
        mutate(m, rng.randint(1, 3))
    efsm_cases.append(efsm_case(f"random-{i}", m))
for flag in (False, True):
    efsm_cases.append(efsm_case(f"fixture machine_dict(defect={flag})", PF.machine_dict(defect=flag)))

# deliberate JS deviations (Python accepts, the JS port rejects): integer-like map keys, unsafe ints,
# non-finite floats from strings, pydantic's odd int strings
DEVIATIONS = {
    "integer-like state id": base(states={"0": {"id": "0", "action": {"kind": "end", "terminal": "T"}}}, initial="0"),
    "integer-like binds key": base(states=st({"kind": "tool", "name": "t", "binds": {"1": "x"}})),
    "integer-like tool input key": base(states=st({"kind": "tool", "name": "t", "input": {"7": "${x}"}})),
    "unsafe int": base(max_steps=2**53 + 1),
    "unsafe int string": base(max_steps="9007199254740993"),
    "inf float string": base(thresholds={"acc_thr": "inf"}),
    "nan float string": base(thresholds={"acc_thr": "NaN"}),
    "overflow float string": base(thresholds={"acc_thr": "1e400"}),
    "pydantic odd int string": base(max_steps="0-1"),
    "pydantic odd int string 2": base(max_steps="0__5"),
}
deviation_cases = []
for k, v in DEVIATIONS.items():
    r = outcome(E.load_machine, v)
    assert r["py"] == "ok", (k, r)
    deviation_cases.append({"name": k, "input_json": jtext(v)})

# Lone surrogates (JSON-escaped in ``input_ascii``; the JS test reads them with JSON.parse). pydantic reads
# int/float/bool/Literal string input as UTF-8 first (string_unicode at the field), and one lone-surrogate
# KEY fails the whole model with a single string_unicode at the model's loc. Python accepts them in str,
# dict and Any fields and in dict keys; the JS port rejects those (documented).
from hexis_service.compiler.compile import DeploymentPolicy  # noqa: E402
from hexis_service.models.base import ModelRequest, ModelResponse  # noqa: E402

SUR = "x\ud800"
SURROGATE_MODELS = {"efsm.Variable": E.Variable, "efsm.Transition": E.Transition, "efsm.ModelAction": E.ModelAction,
                    "efsm.Machine": E.Machine, "efsm.Prohibition": E.Prohibition, "efsm.Example": E.Example,
                    "efsm.JudgeAction": E.JudgeAction, "efsm.Thresholds": E.Thresholds, "pkg.Budgets": P.Budgets,
                    "pkg.ExecutionPolicy": P.ExecutionPolicy, "pkg.VariableContract": P.VariableContract,
                    "pkg.SourceManifest": P.SourceManifest, "pkg.ClauseCoverage": P.ClauseCoverage,
                    "pkg.DeploymentPolicy": DeploymentPolicy, "fakes.ModelResponse": ModelResponse,
                    "fakes.ModelRequest": ModelRequest}
M0 = {"format": "efsm-v1", "skill_id": "s", "initial": "A"}
SURROGATE_INPUTS = [
    ("efsm.Variable", {"name": "v", "type": SUR}), ("efsm.Variable", {"name": "v", "type": "\udc00"}),
    ("efsm.Variable", {"name": SUR}), ("efsm.Variable", {"name": "v", "init": SUR}),
    ("efsm.Variable", {"name": "v", "init_from": SUR}), ("efsm.Variable", {"name": "v", "init": 1, "init_from": "x", SUR: 1}),
    ("efsm.Transition", {"to": "B", "support": "1\ud800"}), ("efsm.Transition", {"to": SUR}),
    ("efsm.Transition", {"if": SUR, "to": "B"}), ("efsm.Transition", {"cond": SUR, "to": "B"}),
    ("efsm.Transition", {"to": "B", SUR: 1, "if": 5}), ("efsm.Transition", {"to": "B", "support": "\ud800", "inc": 5}),
    ("efsm.ModelAction", {"prompt": "p", "introduced": "1\ud800"}), ("efsm.ModelAction", {"prompt": "p", "observable": SUR,
                                                                                          "introduced": "maybe"}),
    ("efsm.Machine", {**M0, "states": {SUR: {"id": "a", "action": {"kind": "end", "terminal": "T"}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {"kind": SUR, "terminal": "T"}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {"kind": "end", "terminal": "T", SUR: 1}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {"terminal": "T", SUR: 1}}}}),
    ("efsm.Machine", {**M0, "max_steps": "zz", "states": {"A": {"id": "a", SUR: 2, "action": {"kind": "end"}}}}),
    ("efsm.Machine", {**M0, SUR: 1, "max_steps": "zz", "states": {"A": {"id": "a", SUR: 2}}}),
    ("efsm.Machine", {"format": SUR, "skill_id": "s", "initial": "A"}),
    ("efsm.Machine", {**M0, "thresholds": {"acc_thr": "0.\ud800", "min_support": "x"}}),
    ("efsm.Machine", {**M0, "variables": [{"name": "a", "type": "x\udfff"}, {"name": "b", SUR: 0}]}),
    ("efsm.Prohibition", {"id": "p", "check": SUR, "pattern": SUR}), ("efsm.Prohibition", {"id": "p", "check": "absent",
                                                                                           "pattern": SUR}),
    ("efsm.Example", {"label": "l", SUR: 1}), ("efsm.Example", {"label": "l", "x": SUR}), ("efsm.Example", {SUR: 1}),
    ("efsm.Example", {"label": 5, SUR: 1}),
    ("efsm.JudgeAction", {"prompt": "p", "reads": ["a"], "writes": ["b"], "labels": ["abstain"], SUR: 1}),
    ("efsm.JudgeAction", {"question": "p", "reads": ["a"], "writes": ["b"], "labels": ["x"], SUR: 1}),
    ("efsm.JudgeAction", {"prompt": "p", "reads": ["a"], "writes": ["b"], "labels": ["abstain"], "error_rate": SUR,
                          "support": "\ud8001", "introduced": "y\ud800"}),
    ("efsm.Thresholds", {"holdout_ratio": SUR, "judge_rewrite_max": "\udc002"}),
    ("pkg.Budgets", {"max_spend_usd": "1\ud800"}), ("pkg.Budgets", {"max_spend_usd": SUR}), ("pkg.Budgets", {SUR: 1}),
    ("pkg.Budgets", {"max_steps": "zz", SUR: 1}), ("pkg.Budgets", {SUR: 1, "y\udc00": 2}),
    ("pkg.Budgets", {"max_steps": "\ud800", "max_tool_calls": "x"}),
    ("pkg.ExecutionPolicy", {"capability_ceiling": [SUR], "write_workflow": "t\ud800"}),
    ("pkg.ExecutionPolicy", {"capability_ceiling": ["a"], "fallback_mode": SUR, "budgets": {SUR: 1}}),
    ("pkg.ExecutionPolicy", {"budgets": {SUR: 1}, SUR: 2}),
    ("pkg.VariableContract", {"owner": SUR}), ("pkg.VariableContract", {"owner": "tool", "schema": {SUR: 1}}),
    ("pkg.SourceManifest", {"skill_sha256": "a", "tool_catalog_sha256": "b", "resources": {SUR: "x"}}),
    ("pkg.SourceManifest", {"skill_sha256": "a", "tool_catalog_sha256": "b", "resources": {"k": SUR}}),
    ("pkg.ClauseCoverage", {"classification": SUR, "justification": "j", "critical": "\ud800"}),
    ("pkg.DeploymentPolicy", {"execution_policy": {"capability_ceiling": []}, "task_input_schema": {}, "profile": SUR}),
    ("fakes.ModelResponse", {"model_id": "m", "cost_usd": "1\ud800", "input_tokens": "\ud8001"}),
    ("fakes.ModelRequest", {"kind": SUR, "state_id": "s", "prompt": "p", "inputs": {SUR: SUR}, "output_schema": {}}),
    ("fakes.ModelRequest", {"kind": "model", "state_id": "s", "prompt": "p", "inputs": {}, "output_schema": {},
                            "labels": [SUR]}),
    # a TypeError escaping a nested before-validator wins over the lone-surrogate key (pydantic validates fields first)
    ("efsm.State", {"id": "S", "action": {"kind": "judge", "prompt": "q", "reads": ["a"], "writes": ["b"], "labels": True},
                    "\ud800": 1}),
    ("efsm.Machine", {"skill_id": "s", "initial": "i", "\udc00": 1, "states": {"A": {"id": "A", "action": {
        "kind": "judge", "prompt": "q", "reads": ["a"], "writes": ["b"], "labels": True}}}}),
    ("efsm.State", {"id": "S", "action": {"kind": "judge", "prompt": "q", "reads": ["a"], "writes": ["b"], "labels": 5},
                    "x": 1, "\ud800": 1}),
    ("efsm.State", {"id": 5, "action": {"kind": "end"}, "\ud800": 1}),
]
SURROGATE_MODELS["efsm.State"] = E.State
surrogate_cases = []
for name, data in SURROGATE_INPUTS:
    c = {"model": name, "input_ascii": json.dumps(data, ensure_ascii=True)}
    try:
        SURROGATE_MODELS[name].model_validate(data)  # (a JSON dump of such a model would raise)
        c["py"] = "ok"
    except ValidationError as exc:
        c["py"] = "error"
        c["errors"] = sorted([[e["type"], list(e["loc"])] for e in exc.errors()], key=lambda x: (x[0], json.dumps(x[1])))
    except TypeError as exc:  # escapes pydantic from a before-validator
        c["py"] = "exc"
        c["exc"] = type(exc).__name__
    surrogate_cases.append(c)

# A value rejected only by a documented deviation still takes part in validating its container (the JS port's
# error list is a superset of pydantic's): pydantic's errors next to deviation inputs
DEEP = []
for _ in range(70):
    DEEP = [DEEP]
J0 = {"kind": "judge", "prompt": "p", "reads": ["a"], "writes": ["b"], "labels": ["x"]}
SOFT_INPUTS = [
    ("efsm.Variable", {"name": "v", "init": DEEP, "init_from": "x"}),
    ("efsm.Variable", {"name": "v", "init": {"7": DEEP}, "init_from": "x", "type": "nope"}),
    ("efsm.Machine", {**M0, "states": {"7": 5}}),
    ("efsm.Machine", {**M0, "states": {"7": {"id": "a"}, "0": {"id": "b", "action": {"kind": "end", "terminal": "T"}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {"kind": "tool", "name": "t", "binds": {"42": 5}}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {**J0, "error_rate": "inf"}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {**J0, "error_rate": "1e400", "support": "x"}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {**J0, "examples": [{"label": "x", "deep": DEEP}]}}}}),
    ("efsm.Machine", {**M0, "states": {"A": {"id": "a", "action": {"kind": "tool", "name": "t", "input": {"3": "${x}"},
                                                                   "reads": 5}}}}),
    ("efsm.Machine", {**M0, "thresholds": {"acc_thr": "NaN", "min_support": "x"}, "max_steps": "9007199254740993"}),
    ("pkg.Contracts", {"variables": {"0": {"owner": "x"}}, "terminals": {"1": 5}}),
    ("pkg.SourceManifest", {"skill_sha256": "a", "tool_catalog_sha256": 5, "resources": {"0": 1}}),
]
soft_cases = []
for name, data in SOFT_INPUTS:
    r = outcome((SURROGATE_MODELS.get(name) or getattr(P, name.split(".")[1])).model_validate, data)
    assert r["py"] == "error", (name, r)
    soft_cases.append({"model": name, "input_json": jtext(data), "errors": r["errors"]})

write("models_efsm", {"cases": efsm_cases, "deviations": deviation_cases, "surrogates": surrogate_cases,
                      "soft": soft_cases})

# =============================================================================================== #
# lax coercions
# =============================================================================================== #
TI, TF, TB = TypeAdapter(int), TypeAdapter(float), TypeAdapter(bool)
INT_H = re.compile(r"^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$")
RUST_WS = "\t\n\x0b\x0c\r \x85\xa0                　"


def rand_numstr(alpha: str) -> str:
    s = "".join(rng.choice(alpha) for _ in range(rng.randint(1, 8)))
    if rng.random() < 0.2:
        s = rng.choice([" ", "\t", "\n", "\x85", "　", "\x1c", "\x1f", "﻿"]) + s
    if rng.random() < 0.2:
        s = s + rng.choice([" ", "\r\n", " ", "\x1d", "\xa0"])
    return s


def coerce_case(ta, v, kind):
    try:
        out = ta.validate_python(v)
    except ValidationError as exc:
        return {"input": v, "py": "error", "type": exc.errors()[0]["type"]}
    case = {"input": v, "py": "ok"}
    if kind == "float":
        case["value"] = repr(out)
        case["deviation"] = "nonfinite" if out != out or out in (float("inf"), float("-inf")) else None
    elif kind == "int":
        case["value"] = out if abs(out) <= SAFE else str(out)
        dev = None
        if isinstance(v, str) and not INT_H.match(v.strip(RUST_WS)):
            dev = "quirk"
        elif abs(out) > SAFE:
            dev = "unsafe"
        case["deviation"] = dev
    else:
        case["value"] = out
        case["deviation"] = None
    return case


int_inputs = ["3", " 3 ", "+3", "-3", "3_000", "3.0", "3.5", "1e3", "0x10", "", " ", "03", "-0", "+0", "3.", ".0",
              "0.0", "1_0.0", "  -4.000  ", "9" * 30, "_3", "3_", "3__0", "1_000_000", "-_3", "3_.0", "3._0", "3.0_0",
              "0_0", "00", "-00.000", "3.0e0", "1.0_", "+-3", "- 3", "3.0.0", "٣", "３", "0-1", "0__1", "0_-1",
              "9007199254740991", "9007199254740992", "-9007199254740991", "1" + "0" * 4300, "0" * 4301 + "1",
              "\x1c3", "3\x1f", "﻿3", " 3　", True, False, 0, -5, 2.5, -0.5, None, [], {}, "true"]
for _ in range(1500):
    int_inputs.append(rand_numstr("0123456789_.-+ e"))
float_inputs = ["2", " 2.5 ", "inf", "-inf", "nan", "NaN", "Infinity", "1e3", "1_000.5", "", "abc", "0x10", "+.5",
                "5.", "１", "\t2.5\n", "1e400", "-1e400", "1e-400", "2.5\x85", "1__0", "_1", "1_", "1_.5", "1._5",
                "1e1_0", "1.e5", ".e5", "e5", "1e", "1e+", "+-1", "1.5.5", "inFinity", "-iNf", "+nan", "infin",
                "in_f", "1E5", "00.5", "1d", "0.30000000000000004", "5e-324", True, False, 0, 3, -0.75, None, [], "\x1c1"]
for _ in range(1200):
    float_inputs.append(rand_numstr("0123456789_.-+eE"))
for _ in range(100):
    float_inputs.append(rand_numstr("0123456789infaINFA.+-_"))
bool_inputs = ["true", "True", "TRUE", "false", "yes", "no", "on", "off", "y", "n", "t", "f", "1", "0", " true",
               "true ", "", "2", "Yes", "oN", "tRuE", "OFF", "nO", "yess", "İ", True, False, 0, 1, 2, -1, 0.5,
               None, [], {}]
for _ in range(300):
    w = rng.choice(["true", "false", "yes", "no", "on", "off", "y", "n", "t", "f", "1", "0", "x", "tru", "ye"])
    bool_inputs.append("".join(c.upper() if rng.random() < 0.5 else c for c in w))
coerce = {
    "int": [coerce_case(TI, v, "int") for v in int_inputs],
    "float": [coerce_case(TF, v, "float") for v in float_inputs],
    "bool": [coerce_case(TB, v, "bool") for v in bool_inputs],
}


def bool_error(v):
    try:
        TB.validate_python(v)
        return None
    except ValidationError as exc:
        return exc.errors()[0]["type"]


# numbers the golden files cannot carry: (JS expression, Python error type); the JS value is the same number
coerce["bool_big"] = [[expr, bool_error(eval(expr))] for expr in  # noqa: S307 - fixed literals
                      ["2**63", "-(2**63)", "2**64", "-(2**64)", "2**53 + 2", "-(2**53) - 2", "2**62", "1e300", "-1e300",
                       "2.0**63", "2.5e18"]]
# pydantic-core's str->int length limits around 4300 digits (int_parsing_size from jiter's raw parse vs
# int_parsing after cleaning): [prefix, digit, count, suffix, Python result ("ok" or the error type)]
int_size = []
for pre in ["", "-", "+", " ", "\t", "0", "00", "-0", "+0", "0_", "1_", "-1_", "+-", "\u3000"]:
    for dig in "91":
        for n in range(4297, 4304):
            for suf in ["", ".0", ".00", " ", "_1", "_", ".5", "e0", "x", "\n"]:
                v = pre + dig * n + suf
                try:
                    TI.validate_python(v)
                    r = "ok"
                except ValidationError as exc:
                    r = exc.errors()[0]["type"]
                int_size.append([pre, dig, n, suf, r])
coerce["int_size"] = int_size
write("models_coerce", coerce)

# =============================================================================================== #
# packages
# =============================================================================================== #
comp = compile_procurement()
assert comp.status == "validated", comp.attempts
initial = comp.package
prop = propose_update(initial, R.missing_docs_trace(), [], [], load_catalog(), R.FixtureAligner(), skill_source().text)
assert prop.status == "CANDIDATE", prop.diagnostics
refined = prop.candidate


def pkg_record(p: P.MachinePackage) -> dict:
    dump = p.to_json()
    return {"dump_json": jtext(ints(dump)), "artifact_hash": p.artifact_hash, "compute_hash": p.compute_hash(),
            "verify_hash": p.verify_hash(), "canonical_sha": sha(canonical_bytes(dump)),
            "hash_payload_sha": sha(canonical_bytes(p.hash_payload()))}


anchors = {"initial": pkg_record(initial), "refined": pkg_record(refined)}


def pkg_outcome(data) -> dict:
    r = outcome(P.MachinePackage.model_validate, data)
    case = {"py": r["py"]}
    if r["py"] == "ok":
        p = r["model"]
        case.update(canonical_sha=sha(canonical_bytes(r["dump"])), compute_hash=p.compute_hash(),
                    verify_hash=p.verify_hash(), sealed_hash=p.sealed().artifact_hash)
    elif r["py"] == "error":
        case["errors"] = r["errors"]
    else:
        case["exc"] = r["exc"]
    return case


base_dumps = {"initial": initial.to_json(), "refined": refined.to_json()}
pkg_cases = []
for i in range(220):
    which = rng.choice(["initial", "refined"])
    doc = copy.deepcopy(base_dumps[which])
    ops = mutate(doc, rng.randint(1, 3))
    case = pkg_outcome(doc)
    case.update(name=f"mutation-{i}", base=which, ops=ops)
    pkg_cases.append(case)

# benign mutations: typed fields get new values in lax-coercible spellings (mostly accepted, new hashes)
def int_spelling(v: int):
    return rng.choice([v, v, str(v), f" {v} ", f"{v}.0", f"+{v}", True if v == 1 else v, False if v == 0 else v])


def float_spelling(v):
    return rng.choice([v, str(v), f" {v} "]) if isinstance(v, float) else rng.choice([v, str(v), f"{v}.0"])


def bool_spelling(b: bool):
    return rng.choice([b, int(b), "yes" if b else "no", "T" if b else "f", "on" if b else "OFF"])


def typed_positions(doc) -> list:
    out = [(("machine", "max_steps"), "int"), (("execution_policy", "max_loop_bound"), "int"),
           (("execution_policy", "structured_output_repairs"), "int"), (("execution_policy", "transport_retries"), "int"),
           (("execution_policy", "approval_expiry_s"), "int"), (("execution_policy", "write_workflow"), "bool"),
           (("execution_policy", "budgets", "max_spend_usd"), "float"), (("validation_manifest", "passed"), "bool")]
    out += [(("execution_policy", "budgets", k), "int") for k in ("max_steps", "max_tool_calls", "max_model_calls",
                                                                  "max_tokens", "max_elapsed_s")]
    out += [(("machine", "thresholds", k), "int") for k in ("min_support", "retry_budget", "judge_rewrite_max")]
    out += [(("machine", "thresholds", k), "float") for k in ("holdout_ratio", "acc_thr", "loop_margin",
                                                              "fallback_rate_target", "judge_err_max")]
    for sid, s in doc["machine"]["states"].items():
        for i in range(len(s["transitions"])):
            out.append((("machine", "states", sid, "transitions", i, "support"), "int"))
        if s["action"]["kind"] == "model":
            out += [(("machine", "states", sid, "action", k), "bool") for k in ("introduced", "observable")]
    for cid in doc["contracts"]["clause_coverage"]:
        out.append((("contracts", "clause_coverage", cid, "critical"), "bool"))
    for i in range(len(doc["source_manifest"]["clauses"])):
        out += [(("source_manifest", "clauses", i, k), "int") for k in ("start", "end")]
    return out


benign_cases = []
for i in range(120):
    which = rng.choice(["initial", "refined"])
    doc = copy.deepcopy(base_dumps[which])
    ops = []
    for path, kind in rng.sample(typed_positions(doc), rng.randint(1, 4)):
        if kind == "int":
            val = int_spelling(rng.randint(0, 120))
        elif kind == "bool":
            val = bool_spelling(rng.random() < 0.5)
        else:
            val = float_spelling(rng.choice([0, 1, 2, 0.5, 0.25, 7, 1.75]))
        at(doc, path[:-1])[path[-1]] = val
        ops.append(["set", list(path), val])
    case = pkg_outcome(doc)
    case.update(name=f"benign-{i}", base=which, ops=ops)
    benign_cases.append(case)
pkg_cases += benign_cases

# targeted package edits: defaults dropped, coercions, alias spellings, float-typed integral values
TARGETED = []


def edit(name, fn, which="initial"):
    doc = copy.deepcopy(base_dumps[which])
    fn(doc)
    TARGETED.append((name, doc))


edit("drop optional sections", lambda d: [d.pop(k) for k in ("validation_manifest", "lineage", "admission",
                                                               "artifact_hash", "package_schema")])
edit("machine without format", lambda d: d["machine"].pop("format"))
edit("schema_ spelling", lambda d: d["contracts"]["variables"]["draft"].__setitem__(
    "schema_", d["contracts"]["variables"]["draft"].pop("schema")))
edit("schema and schema_", lambda d: d["contracts"]["variables"]["draft"].__setitem__("schema_", {}))
edit("cond spelling", lambda d: d["machine"]["states"]["READ_INTAKE"]["transitions"][0].__setitem__(
    "cond", d["machine"]["states"]["READ_INTAKE"]["transitions"][0].pop("if")))
edit("max_spend_usd integral", lambda d: d["execution_policy"]["budgets"].__setitem__("max_spend_usd", 2))
edit("max_spend_usd str", lambda d: d["execution_policy"]["budgets"].__setitem__("max_spend_usd", " 12 "))
edit("max_spend_usd fraction", lambda d: d["execution_policy"]["budgets"].__setitem__("max_spend_usd", 0.75))
edit("thresholds integral", lambda d: d["machine"].__setitem__("thresholds", {"acc_thr": 1, "loop_margin": 2,
                                                                             "holdout_ratio": "0"}))
edit("judge state", lambda d: d["machine"]["states"].__setitem__("JUDGE", {
    "id": "JUDGE", "action": {"kind": "judge", "question": "ok?", "reads": ["draft"], "writes": ["verify_status"],
                              "labels": ["match", "mismatch", "abstain"]}, "transitions": [{"to": "END_UNVERIFIED"}]}))
edit("judge state error_rate 1", lambda d: d["machine"]["states"].__setitem__("JUDGE", {
    "id": "JUDGE", "action": {"kind": "judge", "prompt": "ok?", "reads": ["draft"], "writes": ["verify_status"],
                              "labels": ["abstain"], "error_rate": 1, "examples": [{"label": "abstain", "w": 2}]}}))
edit("write_workflow str", lambda d: d["execution_policy"].__setitem__("write_workflow", "no"))
edit("budgets bool", lambda d: d["execution_policy"]["budgets"].__setitem__("max_steps", True))
edit("admission record", lambda d: d.__setitem__("admission", {
    "artifact_hash": d["artifact_hash"], "environment": "sandbox", "approver": "user:dana",
    "admitted_at": "2026-09-22T10:00:00+00:00", "validation_report_digest": "sha256:aa", "replay_archive_digest": "sha256:bb",
    "key_id": "dev-hmac-1", "signature": "hmac-sha256:00"}))
edit("admission bad", lambda d: d.__setitem__("admission", {"artifact_hash": "h"}))
edit("lineage parent", lambda d: d["lineage"].__setitem__("parent_hash", "sha256:abc"), "refined")
edit("findings", lambda d: d["validation_manifest"].__setitem__("findings", [{"code": "X", "detail": {"n": 0.5}}]))
edit("package_schema wrong", lambda d: d.__setitem__("package_schema", "hexis-production-package/2"))
edit("clause ref coerced", lambda d: d["source_manifest"]["clauses"][0].__setitem__("start", "59"))
edit("clause ref bad", lambda d: d["source_manifest"]["clauses"][0].__setitem__("end", 1.5))
edit("resources", lambda d: d["source_manifest"].__setitem__("resources", {"b.md": "x", "a.md": "y"}))
edit("explained_unreachable", lambda d: d["contracts"].__setitem__("explained_unreachable", {"FALLBACK": "reserved"}))
edit("contracts missing terminals", lambda d: d["contracts"].pop("terminals"))
edit("ordering bad", lambda d: d["contracts"]["ordering"][0].__setitem__("requires", "tool:x"))
edit("coverage bad classification", lambda d: d["contracts"]["clause_coverage"]["S1.1"].__setitem__("classification", "x"))
edit("interaction bad type", lambda d: d["contracts"]["interactions"]["REQUEST_APPROVAL"].__setitem__("type", "approve"))
edit("artifact hash tampered", lambda d: d.__setitem__("artifact_hash", "sha256:" + "0" * 64))
edit("model_settings nested", lambda d: d["compiler_manifest"].__setitem__("model_settings", {"t": 0.5, "n": [1, {}]}))
targeted_cases = []
for name, doc in TARGETED:
    case = pkg_outcome(doc)
    case.update(name=name, input_json=jtext(doc))
    targeted_cases.append(case)

# admission signatures
REC = {"artifact_hash": initial.artifact_hash, "environment": "sandbox", "approver": "user:dana",
       "admitted_at": "2026-09-22T10:00:00+00:00", "validation_report_digest": "sha256:" + "a" * 64,
       "replay_archive_digest": "sha256:" + "b" * 64, "key_id": "dev-hmac-1"}
KEYS = ["hexis-demo-admission-key-not-for-production", "", "k" * 100, "ключ😀"]
admission = []
for i in range(24):
    rec = dict(REC)
    if i % 3 == 1:
        rec["approver"] = rng.choice(["user:é", "user:😀", "user:dana\n"])
    if i % 4 == 2:
        rec["environment"] = "production"
    key = KEYS[i % len(KEYS)]
    signed = P.sign_admission(P.AdmissionRecord(**rec), key.encode("utf-8"))
    entry = {"record": rec, "key": key, "signature": signed.signature,
             "verify": P.verify_admission(signed, key.encode("utf-8")),
             "verify_wrong_key": P.verify_admission(signed, (key + "x").encode("utf-8")),
             "verify_tampered": P.verify_admission(signed.model_copy(update={"key_id": "other"}), key.encode("utf-8")),
             "verify_unsigned": P.verify_admission(P.AdmissionRecord(**rec), key.encode("utf-8"))}
    admission.append(entry)
binary_key = bytes(range(0, 256, 7))
signed = P.sign_admission(P.AdmissionRecord(**REC), binary_key)
admission_binary = {"record": REC, "key_hex": binary_key.hex(), "signature": signed.signature,
                    "verify": P.verify_admission(signed, binary_key)}
try:
    P.verify_admission(P.AdmissionRecord(**REC, signature="hmac-sha256:é"), b"k")
    nonascii = "returned"
except TypeError:
    nonascii = "TypeError"

# packages carrying integral float fields (typed canonical serialization): Python-sealed hashes
float_pkgs = []
for name, doc in TARGETED:
    if name in ("max_spend_usd integral", "thresholds integral", "judge state", "judge state error_rate 1"):
        p = P.MachinePackage.model_validate(doc).sealed()
        float_pkgs.append({"name": name, "input_json": jtext(doc), "sealed_hash": p.artifact_hash,
                           "canonical_sha": sha(canonical_bytes(p.to_json())),
                           "machine_digest": digest(p.machine.to_json())})

# float fields holding integral values beyond 2^53 (Python floats, printed as "1e+16"): normalization accepts
# them and every hash API must agree with Python (the values arrive as numeric strings)
BIG_FLOAT_EDITS = [
    ("max_spend_usd 1e16", lambda d: d["execution_policy"]["budgets"].__setitem__("max_spend_usd", "1e16")),
    ("max_spend_usd 2^53+1", lambda d: d["execution_policy"]["budgets"].__setitem__("max_spend_usd", "9007199254740993")),
    ("max_spend_usd -1e20", lambda d: d["execution_policy"]["budgets"].__setitem__("max_spend_usd", "-1e20")),
    ("max_spend_usd 1e300", lambda d: d["execution_policy"]["budgets"].__setitem__("max_spend_usd", " 1e300 ")),
    ("thresholds big", lambda d: d["machine"].__setitem__("thresholds", {"acc_thr": "1e17", "loop_margin": "123456789012345678",
                                                                         "judge_err_max": "2e53"})),
    ("judge error_rate 1e22", lambda d: d["machine"]["states"].__setitem__("JUDGE", {
        "id": "JUDGE", "action": {"kind": "judge", "prompt": "ok?", "reads": ["draft"], "writes": ["verify_status"],
                                  "labels": ["abstain"], "error_rate": "1e22"}})),
]
float_big = []
for idx, (name, fn) in enumerate(BIG_FLOAT_EDITS):
    which = ("initial", "refined")[idx % 2]
    doc = copy.deepcopy(base_dumps[which])
    fn(doc)
    p = P.MachinePackage.model_validate(doc)
    s = p.sealed()
    float_big.append({"name": f"{name} ({which})", "input_json": jtext(doc), "compute_hash": p.compute_hash(),
                      "verify_hash": p.verify_hash(), "sealed_hash": s.artifact_hash, "sealed_verify": s.verify_hash(),
                      "canonical_sha": sha(canonical_bytes(p.to_json())), "machine_digest": digest(p.machine.to_json()),
                      "policy_digest": digest(p.execution_policy.model_dump(mode="json"))})
float_big_models = []
for model_name, cls, data in [("Budgets", P.Budgets, {"max_spend_usd": "1e16"}),
                              ("Budgets", P.Budgets, {"max_spend_usd": "9007199254740993"}),
                              ("Budgets", P.Budgets, {"max_spend_usd": "-123456789012345678901234567890"}),
                              ("ExecutionPolicy", P.ExecutionPolicy, {"capability_ceiling": [], "budgets": {"max_spend_usd": "4e18"}}),
                              ("ModelResponse", ModelResponse, {"model_id": "m", "cost_usd": "1e16"}),
                              ("ModelResponse", ModelResponse, {"model_id": "m", "cost_usd": "2.5e15"})]:
    dump = cls.model_validate(data).model_dump(mode="json")
    float_big_models.append({"model": model_name, "input": data, "canonical": canonical_bytes(dump).decode("utf-8"),
                             "digest": digest(dump)})

# error ORDER with integer-like extra keys (JS objects iterate them first): Python's unsorted list
try:
    P.ExecutionPolicy.model_validate({"capability_ceiling": [], "budgets": {"1e3": 1, "7": 2, "b": 3}})
    raise AssertionError("expected errors")
except ValidationError as exc:
    error_order_case = {"input_json": jtext({"capability_ceiling": [], "budgets": {"1e3": 1, "7": 2, "b": 3}}),
                        "errors_in_order": [[e["type"], list(e["loc"])] for e in exc.errors()]}

# other sub-models validated on their own
SUB = [
    ("Contracts", PF.contracts_dict()),
    ("Contracts", {}),
    ("Contracts", {"variables": {"a": {"owner": "x"}}, "terminals": {"T": {"category": "verified",
                                                                         "evidence": [{"claim": "c"}]}}}),
    ("ExecutionPolicy", {"capability_ceiling": [], "budgets": {"max_spend_usd": "2"}}),
    ("ExecutionPolicy", {"capability_ceiling": [], "budgets": {"max_spend_usd": 2, "max_steps": True},
                         "write_workflow": "yes"}),
    ("ExecutionPolicy", {"capability_ceiling": "x"}),
    ("AdmissionRecord", {"artifact_hash": "h"}),
    ("VariableContract", {"owner": "tool", "schema": {}, "schema_": {"a": 1}}),
    ("VariableContract", {"owner": "tool", "schema_": 5}),
    ("VariableContract", {"owner": "tool"}),
    ("DeploymentPolicy", PF.deployment_policy().model_dump(mode="json")),
    ("DeploymentPolicy", {"execution_policy": {"capability_ceiling": ["a"]}}),
]
sub_cases = []
for cls, data in SUB:
    model = {"DeploymentPolicy": __import__("hexis_service.compiler.compile", fromlist=["DeploymentPolicy"]).DeploymentPolicy}\
        .get(cls) or getattr(P, cls)
    r = outcome(model.model_validate, data)
    c = {"model": cls, "input_json": jtext(data), "py": r["py"]}
    if r["py"] == "ok":
        c["canonical"] = canonical_bytes(r["dump"]).decode("utf-8")
        c["dump_json"] = jtext(ints(r["dump"]))
    elif r["py"] == "error":
        c["errors"] = r["errors"]
    sub_cases.append(c)

write("models_pkg", {"anchors": anchors, "base": {k: jtext(ints(v)) for k, v in base_dumps.items()},
                     "mutations": pkg_cases, "targeted": targeted_cases, "float_packages": float_pkgs,
                     "admission": admission, "admission_binary": admission_binary,
                     "admission_nonascii_signature": nonascii, "sub_models": sub_cases,
                     "float_big": float_big, "float_big_models": float_big_models, "error_order": error_order_case,
                     "package_digest_of": [{"value": v, "digest": P.package_digest_of(v)}
                                           for v in [None, {"b": 1, "a": [0.5]}, "x", [1, "é"]]]})

# =============================================================================================== #
# catalog
# =============================================================================================== #
cat_raw = json.loads((PF.EXAMPLES / "tool_catalog.json").read_text())
cat = ToolCatalog.model_validate(cat_raw)
catalog_anchor = {"digest": cat.digest(), "dump_json": jtext(cat.model_dump(mode="json")),
                  "check_schemas": cat.check_schemas()}


def cat_outcome(data) -> dict:
    r = outcome(ToolCatalog.model_validate, data)
    case = {"py": r["py"]}
    if r["py"] == "ok":
        c = r["model"]
        case["digest"] = c.digest()
        case["check_schemas"] = [e.split(" invalid:")[0] for e in c.check_schemas()]
        case["get"] = {n: (c.get(n).model_dump(mode="json") if c.get(n) else None)
                       for n in list(c.tools) + ["missing", "constructor"]}
        case["is_write"] = {n: t.is_write for n, t in c.tools.items()}
    elif r["py"] == "error":
        case["errors"] = r["errors"]
    else:
        case["exc"] = r["exc"]
    return case


cat_cases = []
for i in range(120):
    doc = copy.deepcopy(cat_raw)
    ops = mutate(doc, rng.randint(1, 2))
    case = cat_outcome(doc)
    case.update(name=f"mutation-{i}", ops=ops)
    cat_cases.append(case)

BAD_SCHEMAS = [{"type": "strin"}, {"type": "object", "properties": {"a": {"minLength": -1}}},
               {"required": "a"}, {"properties": 5}, {"type": "string", "pattern": "["}, {"items": 5},
               {"enum": 5}, {"minimum": "x"}, {"additionalProperties": 5}, {"type": ["string", 3]},
               {"maxItems": 1.5}, {"type": "object", "anyOf": []}, {"not": "x"},
               # Draft 2020-12 metaschema rules beyond HX.jsonschema.check_schema (covered by metaschema_gaps)
               {"type": []}, {"type": ["string", "string"]}, {"required": ["a", "a"]}, {"multipleOf": 0},
               {"multipleOf": -2.5}, {"uniqueItems": "yes"}, {"description": 5}, {"title": ["t"]}, {"$comment": 1},
               {"format": 5}, {"examples": 5}, {"deprecated": "x"}, {"readOnly": 1}, {"$id": "#frag"}, {"$id": 5},
               {"$schema": 5}, {"patternProperties": {"[": {}}}, {"patternProperties": []},
               {"patternProperties": {"a": 5}}, {"type": "string", "pattern": "\\p{L}"},
               {"type": "string", "pattern": "(?<n>x)"}, {"pattern": "(?<=a+)b"},
               {"type": "object", "properties": {"a": {"type": "array", "items": {"type": []}}}},
               {"anyOf": [{"type": "string"}, {"required": ["x", "x"]}]}]
# valid for python-jsonschema; the JS subset is stricter (unsupported keyword / regex dialect): allowed deviations
STRICTER_SCHEMAS = [{"type": "integer", "x-custom": [1]}, {"type": "string", "pattern": "(?P<n>x)"},
                    {"type": "string", "pattern": "\\Z"}, {"$defs": {"a": {}}}, {"type": "object", "minProperties": 1}]
schema_cases = []
for i, bad in enumerate(BAD_SCHEMAS):
    doc = copy.deepcopy(cat_raw)
    names = list(doc["tools"])
    tool = names[i % len(names)]
    label = "input_schema" if i % 2 == 0 else "output_schema"
    doc["tools"][tool][label] = bad
    ops = [["set", ["tools", tool, label], bad]]
    if i % 3 == 0:  # a second invalid schema elsewhere
        doc["tools"][names[(i + 1) % len(names)]]["input_schema"] = {"type": "nope"}
        ops.append(["set", ["tools", names[(i + 1) % len(names)], "input_schema"], {"type": "nope"}])
    case = cat_outcome(doc)
    case.update(name=f"schema-{i}", ops=ops)
    schema_cases.append(case)
for i, sch in enumerate(STRICTER_SCHEMAS):
    doc = copy.deepcopy(cat_raw)
    doc["tools"]["erp.read_draft"]["input_schema"] = sch
    case = cat_outcome(doc)
    assert case["check_schemas"] == [], (sch, case)
    case.update(name=f"stricter-{i}", ops=[["set", ["tools", "erp.read_draft", "input_schema"], sch]],
                js_stricter=["erp.read_draft.input_schema"])
    schema_cases.append(case)

write("models_catalog", {"raw_json": jtext(cat_raw), "anchor": catalog_anchor, "mutations": cat_cases,
                         "schemas": schema_cases})

# =============================================================================================== #
# regex acceptance (python-jsonschema's "regex" format = re.compile) and check_schemas fuzz
# =============================================================================================== #
import warnings  # noqa: E402

warnings.simplefilter("ignore")  # re's FutureWarnings ("Possible nested set") are not errors
rrng = random.Random(3_141_592)


def re_kind(p: str):
    """None when re.compile(p) succeeds, else the exception class name ("error" for re.error)."""
    re.purge()
    try:
        re.compile(p)
    except re.error:
        return "error"
    except Exception as exc:  # noqa: BLE001 - OverflowError, ValueError, RecursionError escape check_schema
        return type(exc).__name__
    return None


RE_TOK = (
    ["a", "b", "x", "é", "😀", "0", "1", "-", "]", "}", ",", ":", "=", "!", "<", ">", "#", " ", "\n", "&", "~", "_"]
    + [r"\d", r"\D", r"\w", r"\W", r"\s", r"\S", r"\b", r"\B", r"\A", r"\Z", r"\n", r"\t", r"\r", r"\f", r"\v", r"\a",
       r"\0", r"\00", r"\01", r"\012", r"\07", r"\08", r"\1", r"\2", r"\3", r"\10", r"\11", r"\12", r"\99", r"\100",
       r"\377", r"\400", r"\x41", r"\x4", r"A", r"\u004", r"\U0001F600", r"\U00110000", r"\N{DIGIT ONE}", r"\c",
       r"\cA", r"\e", r"\z", r"\G", r"\p{L}", r"\P{L}", r"\k<n>", r"\u{41}", r"\-", r"\.", r"\*", r"\+", r"\?", r"\(",
       r"\)", r"\[", r"\]", r"\{", r"\}", r"\|", r"\^", r"\$", "\\\\", r"\/", r"\_", "\\ ", r"\'", r'\"', r"\:", r"\#",
       r"\@", "\\é", "\\😀", r"\8", r"\9"]
    + ["(", ")", "(?:", "(?=", "(?!", "(?<=", "(?<!", "(?P<n>", "(?P<m>", "(?P=n)", "(?P=m)", "(?<n>", "(?>", "(?#c)",
       "(?(1)", "(?(n)", "(?(2)", "(?(0)", "(?i)", "(?x)", "(?s)", "(?m)", "(?a)", "(?u)", "(?L)", "(?t)", "(?au)",
       "(?i:", "(?-i:", "(?i-s:", "(?x:", "(?-x:", "(?a:", "(?u:", "(?i-i:", "(?-a:", "(?q)", "(?", "(?P", "(?<",
       "(?P<é>", "(?P<1>", "(?P<n", "(?P=)"]
    + ["[", "[^", "]", "[]", "[^]", "[a-z]", "[z-a]", "[\\d-z]", "[a-\\d]", "[\\w-]", "[-a]", "[a-]", "[\\]]", "[]]",
       "[^]]", "[[:digit:]]", "[a&&b]", "[a--b]", "[a||b]", "[a~~b]", "[\\b]", "[\\cJ]", "[\\8]", "[\\0]", "[\\377]",
       "[\\400]", "[\\x41-\\x5a]", "[\\N{DIGIT ONE}]", "[😀-😃]", "[\\A]", "[\\Z]", "[\\B]"]
    + ["*", "+", "?", "*?", "+?", "??", "*+", "++", "?+", "{2}", "{1,3}", "{,2}", "{2,}", "{,}", "{}", "{a}", "{3,2}",
       "{0}", "{65535}", "{4294967294}", "{4294967295}", "{2147483648}", "{1,4294967295}", "{01}", "{1,a}", "{-1}",
       "{ 1}", "{1}{2}", "{1,2}?", "{1,2}+"]
    + ["^", "$", "|", ".", "||", "(|)"])


def rand_atom(d: int) -> str:
    """Structured (mostly well-formed) regex: groups, lookarounds, backrefs, conditionals, flags."""
    r = rrng.random()
    if d > 2 or r < 0.35:
        if rrng.random() < 0.12:
            return rrng.choice([r"\1", r"\2", "(?P=n)", "(?P=m)"])
        return rrng.choice(["a", "b", "ab", "abc", ".", r"\d", "[xy]", "[^a]", r"\w", "é", "😀", r"\b", "^", "$", "x{2}",
                            "x{1,2}", "a?", "b*", r"\x41", "[a-c]{3}", ""])
    inner = rand_seq(d + 1)
    kind = rrng.choice(["group", "group", "noncap", "named", "la", "nla", "lb", "lb", "nlb", "alt", "alt", "cond", "atomic",
                        "flags", "rep", "rep"])
    if kind == "group":
        return "(" + inner + ")"
    if kind == "noncap":
        return "(?:" + inner + ")"
    if kind == "named":
        return "(?P<" + rrng.choice(["n", "m", "n"]) + ">" + inner + ")"
    if kind == "la":
        return "(?=" + inner + ")"
    if kind == "nla":
        return "(?!" + inner + ")"
    if kind == "lb":
        return "(?<=" + inner + ")"
    if kind == "nlb":
        return "(?<!" + inner + ")"
    if kind == "alt":
        return inner + "|" + rand_seq(d + 1)
    if kind == "cond":
        return "(?(" + rrng.choice(["1", "2", "n", "3"]) + ")" + inner + ("|" + rand_seq(d + 1) if rrng.random() < 0.6 else "") + ")"
    if kind == "atomic":
        return "(?>" + inner + ")"
    if kind == "flags":
        return "(?" + rrng.choice(["i", "s", "m", "x", "a", "u", "-i", "i-s", "-x"]) + ":" + inner + ")"
    return "(" + inner + ")" + rrng.choice(["*", "+", "?", "{2}", "{1,3}", "{2,}", "*?", "{0}", "{3}"])


def rand_seq(d: int) -> str:
    return "".join(rand_atom(d) for _ in range(rrng.randint(1, 2 if d else 3)))


pattern_set = set()
for _ in range(7500):
    pattern_set.add("".join(rrng.choice(RE_TOK) for _ in range(rrng.randint(1, 6))))
structured = set()
while len(structured) < 5500:
    p = rand_seq(0)
    if len(p) <= 48:
        structured.add(p)
pattern_set.update(structured)
TARGETED_RE = [
    # the classes the verifier reported (Python rejects, JS RegExp(u) accepts)
    "[]", "[^]", "[]a", r"\cA", r"\cz", r"[\cJ]", r"\1(a)", r"(a\1)", r"(?<=\1)(a)", "(?<=(ab)|c)x", "(?<=(a)+)x",
    "(?<=(a){2,3})x", "(?<!(ab)|c)x", r"(a+)(?<=\1)", "x{4294967295}", "a{1,4294967295}", "a{4294967296,}",
    "(?<=a(b)c|d)x", r"(?<=\b(a)|b)",
    # accepted by both
    "(?<=[ab]{2})", "(?<=a{2})", "(a)(?<=\\1)", r"(a)(?<=\1\1)", r"(?<=(?:ab|cd))", r"(?<=a|b)", r"(?<=ab|cd)x",
    r"(?<=a(?=bc)b)", "(?:)*", "()*", "(|a)*", "a{2147483648}", "(?=a)+", "x(?<=)", "(?<=a)(?<!b)", "[a-a]",
    r"[\x00-\x7f]", r"(?<=\x41)", r"(?<=[*])", r"\0", r"\00", r"[\0]", "a{4294967294}", "a{0,4294967294}",
    "^SUP-[0-9]{3,10}$", r"^[A-Z]{2}[A-Z0-9]{8,12}$", r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", r"^\d{4}-\d{2}-\d{2}$",
    # look-behind widths, group references and conditionals
    r"(a)(b)(?<=\1\2)", r"(a|bc)(?<=\1)", r"(?<=(a)\1)", r"(?<=(a))\1", r"(?P<n>a)(?<=(?P=n))", r"(?P<n>a+)(?<=(?P=n))",
    r"(a)(?<=(?(1)b|c))", r"(a)(?<=(?(1)b|cd))", r"(?<=(?(1)b|c))(a)", r"(a)(?(1)b|c)", r"(?(1)b|c)(a)", r"(?(1)b|c)",
    r"(a)(?(1)b|c|d)", r"(a)(?(0)b)", r"(?(1a)b)", r"(?P<n>a)(?(n)b|c)", r"(a)(?<=(?(1)bb))", r"(a)(?<=(?(1)b))",
    r"(?<=(?>ab))", r"(?<=(?>a|bc))", r"(?<=a*+)", r"(?<=a{2}+)", r"(?<=a{2}?)", r"(?<=(?i:ab))", r"(?<=\Z)",
    r"(?<=x{70000}{2})", r"(?<=(?:x{70000}){70000})", r"(?<=(?:x{65536}){65536})", r"(?<=(?:x{65535}){65537})",
    r"(?<=(?:x{65535}){65538})", "(?<=" + "(?:a{4294967294})" * 2 + ")", r"(?<=(?:x{4294967294})(?:y{4294967294}){2})",
    # flags
    "(?i)a", "a(?i)", "(?i)(?s)a", "(?i)|(?s)", "a|(?i)b", "(?x) a # c\n(?i)", "(?x)(?i)", "(?#c)(?i)", "(?:)(?i)",
    "(?a)(?u)", "(?au)", "(?a:(?u:x))", "(?u)(?a)", "(?L)", "(?t)", "(?t)a*", "(?t)a", "(?t:a)", "(?-t:a)", "(?-u:a)",
    "(?i-i:a)", "(?i", "(?i-", "(?-", "(?-:a)", "(?i-:a)", "(?x)\\", "(?x)a#\\", "(?x)[ ]", "(?x)a{1, 2}", "(?x)a {2}",
    "(?x: a  b )", "(?-x:a b)", "(?x)(?-x: )", "(?ims)", "(?imsx-:a)",
    # braces and repeats
    "{", "}", "x{", "x{1", "x{1,", "x{,", "x{,}", "{,}", "x{}", "{}", "x{1}{2}", "x{2}?", "x{2}+", "x{2}*", "x**", "x*?*",
    "x{0001}", "x{" + "0" * 4300 + "1}", "x{" + "0" * 4301 + "1}", "x{" + "9" * 30 + "}", "x{1," + "9" * 30 + "}",
    "x{4294967294,4294967293}", "x{3,2}", r"\b*", r"\B+", "^*", "$?", r"\A{2}", r"\Z*", "(?=a)*", "(?!a){2}",
    "(?<=a)*", "(?:^)*", r"(?:\b)+", "(a)\\1*", "(a)\\1{2}",
    # escapes and classes
    r"\x", r"\x4", r"\x4g", r"\u12", r"\U1234567", r"\U0010ffff", r"\U00110000", r"\U7fffffff", r"\U80000000",
    r"\Ua4294967", r"[\Uffffffff]", r"[a-\U80000000]", r"\N", r"\N{", r"\N{DIGIT ONE",
    r"\N{DIGIT ONE}", r"\N{NOT A NAME}", r"[\N{DIGIT ONE}]", r"\08", r"\018", r"\0123", r"\777", r"[\777]", r"[\08]",
    r"[\9]", r"[\x]", r"[a-\x]", r"[\w-a]", r"[a-\w]", r"[\s-]", "[a-]", "[-]", "[--]", "[---]", "[]-a]", "[^-]",
    r"[\]]", "[]]", "[^]]", "[[]", "[[]]", "[a", "[a-", "[\\", "\\", "a\\", "[\\]", "[^", "[^]a]", r"[\b-\d]",
    "[😀-😃]", "[😃-😀]", "[é-é]", r"[\U0001F600-\U0001F603]",
    # groups and names
    "(", ")", "())", "(()", "(?", "(?P", "(?P<", "(?P<n", "(?P<n>", "(?P<n>a", "(?P<n>a)", "(?P<n>a)(?P<n>b)",
    "(?P<1>a)", "(?P<_a1>a)", "(?P<é>a)", "(?P<a b>a)", "(?P=n)", "(?P<n>a)(?P=n)", "(?P<n>(?P=n))", "(?P<n>a)(?P=m)",
    "(?Px)", "(?<n>a)", "(?<", "(?<=", "(?<=a", "(?<!", "(?<x", "(?>", "(?>a)", "(?>a)+", "a*+", "a++", "a?+", "a{1,2}+",
    "(?#", "(?#a", "(?#a)", "(?#a)*", "a(?#c)*", "(?z)", "(?-z:a)", "(?i-z:a)", "(?=", "(?!", "(?:", "(?:a", "a|",
    "|a", "|", "||", "(|)", "a||b",
    # nesting depth (the JS port refuses more than 100 levels; Python raises RecursionError much deeper)
    "(" * 100 + ")" * 100, "(" * 101 + ")" * 101, "(?:" * 100 + "a" + ")" * 100, "(?:" * 101 + "a" + ")" * 101,
    "(?<=" * 100 + ")" * 100, "(" * 600 + ")" * 600, "(?(1)" * 120 + ")" * 120, "(a)" + "(?(1)" * 99 + ")" * 99,
]
pattern_set.update(TARGETED_RE)
NAMED_ESCAPE = re.compile(r"\\N")


def strict_only(p: str) -> bool:
    """Patterns the JS port may reject although Python accepts them (documented): \\N{...} escapes,
    non-ASCII group names and groups nested deeper than 100 levels."""
    if NAMED_ESCAPE.search(p) or re.search(r"\(\?P[<=][^>)]*[^\x00-\x7f]", p) or re.search(r"\(\?\([^)]*[^\x00-\x7f]", p):
        return True
    depth = best = 0
    for ch in p:
        depth += ch == "("
        best = max(best, depth)
        depth -= ch == ")"
    return best > 100


regex_cases = []
for p in sorted(pattern_set):
    regex_cases.append([p, re_kind(p), strict_only(p)])

# python-jsonschema's verdict on a schema carrying the pattern is exactly re.compile's (checked here)
for i, (p, kind, _) in enumerate(regex_cases):
    if i % 7:
        continue
    c = ToolCatalog.model_validate({"catalog_id": "c", "version": "1", "tools": {"t": {
        "name": "t", "version": "1", "input_schema": {"type": "string", "pattern": p},
        "output_schema": {"type": "object", "patternProperties": {p: {}}}, "effect": "read", "capability": "x"}}})
    re.purge()
    names = [e.split(" invalid:")[0] for e in c.check_schemas()]
    assert names == ([] if kind is None else ["t.input_schema", "t.output_schema"]), (p, kind, names)

# random Draft 2020-12 schemas (supported keywords, annotations, a few unsupported ones) with regexes from the
# pool above (half of them valid for Python): Python's check_schemas verdict per tool schema
SCHEMA_PATTERNS_OK = [p for p, k, _ in regex_cases if len(p) < 30 and k is None]
SCHEMA_PATTERNS_BAD = [p for p, k, _ in regex_cases if len(p) < 30 and k is not None]
SCHEMA_PATTERNS = SCHEMA_PATTERNS_OK + rrng.sample(SCHEMA_PATTERNS_BAD, len(SCHEMA_PATTERNS_OK))
SUP_KW = ["type", "enum", "const", "required", "properties", "additionalProperties", "patternProperties", "items",
          "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
          "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "allOf", "anyOf", "oneOf", "not"]
ANN_KW = ["title", "description", "default", "examples", "format", "$comment", "$schema", "$id", "readOnly", "writeOnly",
          "deprecated"]
OTHER_KW = ["$ref", "$defs", "$anchor", "if", "then", "else", "prefixItems", "contains", "dependentRequired",
            "propertyNames", "unevaluatedProperties", "minProperties", "contentMediaType", "x-ext", "nullable"]
JTYPES = ["string", "integer", "number", "boolean", "array", "object", "null"]
ODD_VALUES = [None, True, False, 0, 1, -1, 2, 0.5, -0.5, "", "a", "string", "#", "a#", "a#b", "abc#\n", "abc\n",
              "a#\n\n", "http://x/y#", "urn:x\n", [], ["a"], ["a", "a"], ["a", 1], {}, {"a": {}}, {"a": 5}, [{}], [True],
              ["string", "string"], ["string", "null"]]


def rand_schema(d=0):
    if d > 3 or rrng.random() < 0.15:
        return rrng.choice([True, False, {}, {"type": rrng.choice(JTYPES)}])
    s = {}
    for _ in range(rrng.randint(0, 4)):
        r = rrng.random()
        k = rrng.choice(SUP_KW) if r < 0.75 else rrng.choice(ANN_KW) if r < 0.94 else rrng.choice(OTHER_KW)
        s[k] = schema_value(k, d)
    return s


def schema_value(k, d):
    if rrng.random() < 0.12:
        return copy.deepcopy(rrng.choice(ODD_VALUES))
    if k == "type":
        return rrng.choice(JTYPES) if rrng.random() < 0.6 else rrng.sample(JTYPES, rrng.randint(1, 3))
    if k in ("enum", "examples"):
        return rrng.choice([[], [1, "a"], [None], [{"a": 1}]])
    if k == "required":
        return rrng.sample(["a", "b", "c"], rrng.randint(0, 3))
    if k in ("properties", "$defs"):
        return {kk: rand_schema(d + 1) for kk in rrng.sample(["a", "b", "type", "^x$"], rrng.randint(0, 2))}
    if k == "patternProperties":
        return {rrng.choice(SCHEMA_PATTERNS): rand_schema(d + 1) for _ in range(rrng.randint(0, 2))}
    if k in ("additionalProperties", "items", "not", "if", "then", "else", "contains", "propertyNames",
             "unevaluatedProperties"):
        return rand_schema(d + 1)
    if k in ("allOf", "anyOf", "oneOf", "prefixItems"):
        return [rand_schema(d + 1) for _ in range(rrng.randint(0, 3))]
    if k in ("minItems", "maxItems", "minLength", "maxLength", "minProperties"):
        return rrng.choice([0, 1, 5])
    if k in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"):
        return rrng.choice([0, -3, 2.5])
    if k == "multipleOf":
        return rrng.choice([1, 0.5, 3])
    if k in ("uniqueItems", "readOnly", "writeOnly", "deprecated"):
        return rrng.choice([True, False])
    if k == "pattern":
        return rrng.choice(SCHEMA_PATTERNS)
    if k in ("title", "description", "$comment", "format", "contentMediaType"):
        return "t"
    if k == "$schema":
        return "https://json-schema.org/draft/2020-12/schema"
    if k == "$id":
        return rrng.choice(["http://x/y", "urn:a", "a#", "a#b", "abc#\n", "abc\n", "a#\n\n", "\n#"])
    if k == "$ref":
        return "#/$defs/a"
    if k == "$anchor":
        return rrng.choice(["a1", "1a", "-x"])
    if k == "dependentRequired":
        return {"a": ["b"]}
    return copy.deepcopy(rrng.choice(ODD_VALUES))


schema_fuzz = []
for _ in range(2400):
    s_in, s_out = rand_schema(), rand_schema()
    s_in = s_in if isinstance(s_in, dict) else {"x": s_in}
    s_out = s_out if isinstance(s_out, dict) else {}
    cat_doc = {"catalog_id": "c", "version": "1", "tools": {"t": {
        "name": "t", "version": "1", "input_schema": s_in, "output_schema": s_out, "effect": "read", "capability": "x"}}}
    re.purge()
    names = [e.split(" invalid:")[0] for e in ToolCatalog.model_validate(cat_doc).check_schemas()]
    schema_fuzz.append([jtext(s_in), jtext(s_out), names])

write("models_regex", {"patterns": regex_cases, "schemas": schema_fuzz})
print(f"regex: {len(regex_cases)} patterns ({sum(k is None for _, k, _ in regex_cases)} accepted by Python, "
      f"{sum(s for _, _, s in regex_cases)} may be stricter in JS); {len(schema_fuzz)} catalogs "
      f"({sum(bool(c[2]) for c in schema_fuzz)} with invalid schemas)")

print(f"efsm: {len(efsm_cases)} cases ({sum(c['py'] == 'ok' for c in efsm_cases)} ok), "
      f"{len(deviation_cases)} deviations; coerce: {sum(len(v) for v in coerce.values())}; "
      f"pkg: {len(pkg_cases)} mutations ({sum(c['py'] == 'ok' for c in pkg_cases)} ok), {len(targeted_cases)} targeted, "
      f"{len(admission)} admission; catalog: {len(cat_cases)} mutations, {len(schema_cases)} schema cases")
