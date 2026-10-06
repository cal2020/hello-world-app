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

write("models_efsm", {"cases": efsm_cases, "deviations": deviation_cases})

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

print(f"efsm: {len(efsm_cases)} cases ({sum(c['py'] == 'ok' for c in efsm_cases)} ok), "
      f"{len(deviation_cases)} deviations; coerce: {sum(len(v) for v in coerce.values())}; "
      f"pkg: {len(pkg_cases)} mutations ({sum(c['py'] == 'ok' for c in pkg_cases)} ok), {len(targeted_cases)} targeted, "
      f"{len(admission)} admission; catalog: {len(cat_cases)} mutations, {len(schema_cases)} schema cases")
