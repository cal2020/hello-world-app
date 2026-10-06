"""Golden vectors for HX.kernel (runtime/kernel.py).

* seeded random walks over the Python-built initial and refined procurement packages (and the small
  kernel-test packages: judge, falsy, field-scoped), from ``initial_checkpoint`` with valid and invalid task
  inputs and from arbitrary ``RunCheckpoint(**fields)``. Each step builds an observation for the current
  state's kind with randomized outputs (valid ones, missing/extra keys, wrong types, bool-for-int, null,
  schema violations, invalid judge labels, field-scope violations, ``failure``, wrong identity, end-state
  admissions, usage that exhausts budgets ...) and records the full KernelResult or the exception;
* ``fill_template``, ``resolve_path`` and ``select_edge`` vectors.

Files: kernel.json (packages, helper vectors, index of walk files) and kernel_walks_<n>.json.
"""

from __future__ import annotations

import copy
import json
import random
import warnings

from _common import GOLDEN, write

from pydantic import ValidationError

from hexis_service.artifacts.efsm import load_machine
from hexis_service.artifacts.package import Contracts, FieldScope, MachinePackage
from hexis_service.demo import procurement_fixture as PF
from hexis_service.demo import reference as R
from hexis_service.demo.env import compile_procurement, load_catalog, skill_source
from hexis_service.runtime import kernel as K
from hexis_service.traces.update import propose_update

warnings.filterwarnings("ignore")
rng = random.Random(20261006)

# --------------------------------------------------------------------------- packages
comp = compile_procurement()
assert comp.status == "validated", comp.attempts
INITIAL = comp.package
prop = propose_update(INITIAL, R.missing_docs_trace(), [], [], load_catalog(), R.FixtureAligner(), skill_source().text)
assert prop.status == "CANDIDATE", prop.diagnostics
REFINED = prop.candidate

END = lambda t: {"id": t, "action": {"kind": "end", "terminal": t}, "transitions": []}  # noqa: E731


def mini_package(states, variables, var_contracts, terminals, term_contracts, initial, task_schema=None,
                 max_steps=20):
    md = {"format": "efsm-v1", "skill_id": "mini", "initial": initial, "fallback": "FALLBACK", "max_steps": max_steps,
          "states": states, "variables": variables, "terminals": terminals}
    cd = {"variables": var_contracts, "terminals": term_contracts, "task_input_schema": task_schema or {"type": "object"}}
    return MachinePackage(machine=load_machine(md), source_manifest=INITIAL.source_manifest,
                          compiler_manifest=INITIAL.compiler_manifest, contracts=Contracts.model_validate(cd),
                          execution_policy=PF.deployment_policy().execution_policy).sealed()


def judge_pkg():
    states = {
        "J": {"id": "J", "action": {"kind": "judge", "prompt": "ok?", "reads": ["x"], "writes": ["label"],
                                    "labels": ["ok", "bad", "abstain"]},
              "transitions": [{"if": "label == 'ok'", "to": "OK"}, {"if": "", "to": "FALLBACK"}]},
        "OK": END("END_OK"), "FALLBACK": END("END_REVIEW")}
    return mini_package(states, [{"name": "x", "type": "string", "init": "v"}, {"name": "label", "type": "string"}],
                        {"x": {"owner": "task", "schema": {"type": "string"}},
                         "label": {"owner": "model", "schema": {"enum": ["ok", "bad", "abstain"]}}},
                        [{"id": "END_OK", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}],
                        {"END_OK": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}, "J")


def falsy_pkg(guard="flag == False and count == 0 and empty(note)"):
    states = {
        "M": {"id": "M", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": ["flag", "count", "note"]},
              "transitions": [{"if": guard, "to": "A"}, {"if": "", "to": "FALLBACK"}]},
        "A": END("END_A"), "FALLBACK": END("END_REVIEW")}
    return mini_package(states, [{"name": "flag", "type": "boolean"}, {"name": "count", "type": "integer"},
                                 {"name": "note", "type": "string"}, {"name": "ghost", "type": "string"}],
                        {"flag": {"owner": "model", "schema": {"type": "boolean"}},
                         "count": {"owner": "model", "schema": {"type": "integer"}},
                         "note": {"owner": "model", "schema": {"type": "string"}},
                         "ghost": {"owner": "model", "schema": {"type": "string"}}},
                        [{"id": "END_A", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}],
                        {"END_A": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}, "M")


def scoped_pkg(schema, issues=None, field_key="field"):
    states = {"R": {"id": "R", "action": {"kind": "model", "prompt": "p", "reads": ["doc", "issues"], "writes": ["doc"]},
                    "transitions": [{"if": "", "to": "A"}]}, "A": END("E")}
    p = mini_package(states, [{"name": "doc", "type": "object", "init": {"a": "x", "locked": 1, "gone": None}},
                              {"name": "issues", "type": "array",
                               "init": issues if issues is not None else [{"field": "a"}]}],
                     {"doc": {"owner": "model", "schema": schema},
                      "issues": {"owner": "tool", "schema": {"type": "array"}}},
                     [{"id": "E", "kind": "unverified"}], {"E": {"category": "unverified"}}, "R")
    c = p.contracts.model_copy(update={"field_scoped_writes": {"R": FieldScope(variable="doc", allowed_fields_from="issues",
                                                                              field_key=field_key)}})
    return p.model_copy(update={"contracts": c}).sealed()


def verified_mini():
    """A user state then a verified terminal with outputs (terminal admission vectors)."""
    states = {"U": {"id": "U", "action": {"kind": "user", "prompt": "p", "reads": [], "writes": ["out"]},
                    "transitions": [{"if": "out == 'v'", "to": "V"}, {"if": "", "to": "N"}]},
              "V": END("END_V"), "N": END("END_N"), "FALLBACK": END("END_R"),
              "X": END("END_UNDECLARED")}
    return mini_package(states, [{"name": "out", "type": "string"}, {"name": "extra", "type": "integer", "init": 3}],
                        {"out": {"owner": "user", "schema": {"type": "string"}},
                         "extra": {"owner": "engine", "schema": {"type": "integer"}}},
                        [{"id": "END_V", "kind": "verified", "output": ["out", "extra"]},
                         {"id": "END_N", "kind": "unverified", "output": ["out"]},
                         {"id": "END_R", "kind": "fallback", "output": []}],
                        {"END_V": {"category": "verified", "verification_scope": "out matches"},
                         "END_N": {"category": "unverified"}, "END_R": {"category": "fallback"}}, "U")


def owner_mix():
    """Ownership, number typing, a contract without a machine variable, and no default edge."""
    states = {"M": {"id": "M", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": ["u", "num", "ghostvar"]},
                    "transitions": [{"if": "u == 'go'", "to": "A"}, {"if": "num > 2", "to": "T", "inc": "loops"}]},
              "T": {"id": "T", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": ["t"]},
                    "transitions": [{"if": "", "to": "A"}]},
              "A": END("END_A"), "FALLBACK": END("END_REVIEW")}
    return mini_package(states, [{"name": "u", "type": "string"}, {"name": "num", "type": "number"},
                                 {"name": "t", "type": "string"}, {"name": "loops", "type": "integer", "init": 0}],
                        {"u": {"owner": "model", "schema": {"type": "string"}},
                         "num": {"owner": "model", "schema": {"type": "number"}},
                         "t": {"owner": "task", "schema": {"type": "string"}},
                         "ghostvar": {"owner": "model", "schema": {"type": ["null", "integer", "string"]}},
                         "loops": {"owner": "engine", "schema": {"type": "integer"}}},
                        [{"id": "END_A", "kind": "unverified"}, {"id": "END_REVIEW", "kind": "fallback"}],
                        {"END_A": {"category": "unverified"}, "END_REVIEW": {"category": "fallback"}}, "M")


PACKAGES = {
    "initial": INITIAL, "refined": REFINED, "judge": judge_pkg(), "falsy": falsy_pkg(),
    "falsy_ghost": falsy_pkg("ghost == 'x'"), "falsy_order": falsy_pkg("count < note"),
    "scoped": scoped_pkg({"type": "object"}), "scoped_nullable": scoped_pkg({"type": ["object", "null"]}),
    "scoped_malformed": scoped_pkg({"type": "object"}, [{"field": "a"}, {"code": "global"}, {"field": ["x"]}, "s", 5]),
    "scoped_key": scoped_pkg({"type": "object"}, [{"name": "locked"}, {"field": "a"}], field_key="name"),
    "scoped_noissues": scoped_pkg({"type": "object"}, []),
    "verified": verified_mini(), "owner_mix": owner_mix(),
}


def pkg_dump(p):
    return json.loads(json.dumps(p.to_json()), parse_float=lambda s: int(float(s)) if float(s).is_integer() else float(s))


# --------------------------------------------------------------------------- recording helpers
def canon(x):
    """Golden files are written with sorted keys, so every input dict is given to Python in sorted key order too
    (dict order is observable: tool-output binds collisions, list(dict), error order)."""
    return json.loads(json.dumps(x, sort_keys=True))


def strip_detail(d):
    return {k: v for k, v in d.items() if k != "errors"}


def run(fn):
    try:
        return {"ok": fn()}
    except K.KernelError as e:
        return {"exc": "KernelError", "code": e.code, "message": e.message, "detail": strip_detail(e.detail)}
    except ValidationError as e:
        return {"exc": "ValidationError", "errors": sorted([[x["type"], list(x["loc"])] for x in e.errors()],
                                                           key=lambda x: json.dumps(x))}
    except Exception as e:  # noqa: BLE001
        return {"exc": type(e).__name__, "message": str(e)}


def result_dump(r: K.KernelResult):
    return {"checkpoint": r.checkpoint.model_dump(mode="json"), "events": r.events, "delta": r.delta, "edge": r.edge}


# --------------------------------------------------------------------------- random values
DOC_IDS = ["DOC-W9-10042", "DOC-FORM-10042", "DOC-X", "D1"]
FIELDS = ["legal_name", "supplier_ref", "business_unit", "country", "tax_id", "contact_email", "source_links", "iban"]
WEIRD = [None, True, False, 0, 1, -7, 2.5, "", "x", [], [1], {}, {"a": 1}, "é😀"]


def rand_draft(vars_=None, valid=True):
    vars_ = vars_ or {}
    d = {"legal_name": rng.choice(["Northwind Components GmbH", "Acme", "Ünïcødé AG"]),
         "supplier_ref": vars_.get("supplier_ref", "SUP-10042") if isinstance(vars_.get("supplier_ref"), str) else "SUP-1",
         "business_unit": vars_.get("business_unit") if isinstance(vars_.get("business_unit"), str) else "BU-EMEA",
         "source_links": {"legal_name": rng.choice(DOC_IDS)}}
    for f in ("country", "tax_id", "contact_email"):
        if rng.random() < 0.6:
            d[f] = rng.choice(["DE", "DE123456789", "ap@x.example", "", "GB"])
            d["source_links"][f] = rng.choice(DOC_IDS)
    if not valid:
        m = rng.randrange(9)
        if m == 0:
            d.pop("legal_name")
        elif m == 1:
            d["legal_name"] = ""
        elif m == 2:
            d["iban"] = "DE00"
        elif m == 3:
            d["source_links"]["legal_name"] = 5
        elif m == 4:
            d = rng.choice([None, [], "draft", 3, True])
        elif m == 5:
            d["country"] = 49
        elif m == 6:
            d.pop("source_links")
        elif m == 7:
            d["approved"] = True
        else:
            d["supplier_ref"] = None
    return d


def rand_issues():
    out = []
    for _ in range(rng.randrange(4)):
        r = rng.random()
        if r < 0.7:
            out.append({"field": rng.choice(FIELDS), "code": rng.choice(["missing", "format"]), "message": "m"})
        elif r < 0.8:
            out.append({"code": "global"})
        elif r < 0.9:
            out.append({"field": rng.choice([["x"], 5, None])})
        else:
            out.append(rng.choice(["s", 3, None]))
    return out


def repair_draft(cp_vars):
    """A REPAIR_DRAFT output: mostly in-scope changes, sometimes out of scope."""
    old = cp_vars.get("draft")
    base = copy.deepcopy(old) if isinstance(old, dict) else rand_draft(cp_vars)
    issues = cp_vars.get("validation_issues")
    allowed = [i.get("field") for i in issues if isinstance(i, dict) and isinstance(i.get("field"), str)] \
        if isinstance(issues, list) else []
    m = rng.randrange(10)
    new = copy.deepcopy(base)
    if m <= 3 and allowed:
        f = rng.choice(allowed)
        if f == "source_links":
            new["source_links"] = {"legal_name": "D1"}
        elif f in ("legal_name", "supplier_ref", "business_unit", "country", "tax_id", "contact_email"):
            new[f] = rng.choice(["Fixed Name", "DE999999999", "fix@x.example"])
        elif f == "iban":
            new.pop("iban", None)
    elif m == 4:
        new["legal_name"] = "Changed outside scope"
    elif m == 5:
        new.pop(rng.choice([k for k in new if k in ("country", "tax_id", "contact_email")] or ["country"]), None)
    elif m == 6:
        new["country"] = "FR" if new.get("country") != "FR" else "IT"
    elif m == 7:
        new = rand_draft(cp_vars, valid=False)
    elif m == 8:
        new = rng.choice([None, [], "x"])
    # m == 9: unchanged
    return new


def tool_outputs(state_id, cp_vars, valid):
    if state_id == "READ_INTAKE":
        st = rng.choice(["available", "missing"])
        out = {"status": st,
               "documents": [{"document_id": d, "sha256": "ab" * 4, "content": "Legal name: X"} for d in
                             rng.sample(DOC_IDS, rng.randrange(3))],
               "missing_ids": [] if st == "available" else ["DOC-X"]}
    elif state_id == "LOOKUP_SUPPLIER":
        st = rng.choice(["new", "new", "exists_compatible", "conflict"])
        out = {"status": st, "existing": {} if st == "new" else {"supplier_ref": "SUP-55555", "version": 3}}
    elif state_id == "VALIDATE_DRAFT":
        out = {"status": rng.choice(["pass", "pass", "repairable", "repairable", "fail"]), "issues": rand_issues(),
               "draft_digest": "sha256:" + "%064x" % rng.getrandbits(64)}
    elif state_id == "PERSIST_DRAFT":
        out = {"status": rng.choice(["created", "existing", "created"]), "draft_id": "ERP-%d" % rng.randrange(100),
               "version": rng.randrange(1, 4)}
    elif state_id == "READ_BACK":
        st = rng.choice(["found", "found", "unavailable"])
        out = {"status": st, "draft": cp_vars.get("draft") if st == "found" else None,
               "version": rng.randrange(1, 3) if st == "found" else None}
    elif state_id == "VERIFY_PERSISTED":
        out = {"status": rng.choice(["match", "match", "mismatch"]), "receipt_id": "vr_%x" % rng.getrandbits(40)}
    else:
        out = {}
    if not valid and out:
        m = rng.randrange(12)
        keys = list(out)
        if m == 0:
            out.pop(rng.choice(keys))
        elif m == 1:
            out["approved"] = True  # tool extras are ignored
        elif m == 2:
            out[rng.choice(keys)] = rng.choice(WEIRD)
        elif m == 3:
            out["status"] = "bogus"
        elif m == 4:
            out["status"] = None
        elif m == 5 and "version" in out:
            out["version"] = rng.choice([True, False, 1.5, "1", None, -1])
        elif m == 6:
            # bound name used directly (binds.get(k, k)) -> collides with the bound value
            out[rng.choice(["docs_status", "lookup_status", "validation_status", "persist_status", "readback_status",
                            "verify_status", "documents", "draft_digest"])] = rng.choice(["available", "pass", 1])
        elif m == 7:
            out = {}
        elif m == 8 and "issues" in out:
            out["issues"] = rng.choice([{"field": "x"}, "x", None])
        elif m == 9 and "existing" in out:
            out["existing"] = rng.choice([[], None, "x"])
        elif m == 10 and "draft" in out:
            out["draft"] = rng.choice([[], "x", 3, {"legal_name": "Other"}])
        else:
            out[rng.choice(keys)] = None
    return out


def model_outputs(state_id, cp_vars, valid):
    if state_id == "EXTRACT_DRAFT":
        out = {"draft": rand_draft(cp_vars, valid=valid or rng.random() < 0.3)}
    elif state_id == "REPAIR_DRAFT":
        out = {"draft": repair_draft(cp_vars)}
    else:
        out = {}
    if not valid:
        m = rng.randrange(6)
        if m == 0:
            out["approved"] = True
        elif m == 1:
            out = {}
        elif m == 2:
            out["validation_status"] = "pass"
        elif m == 3 and "draft" in out:
            out["draft"] = None
    return out


def user_outputs(state_id, cp_vars, valid):
    if state_id == "REQUEST_APPROVAL":
        out = {"approval_decision": rng.choice(["approved", "approved", "rejected"])}
    elif state_id == "REQUEST_INPUT":
        out = {"document_ids": rng.sample(DOC_IDS, rng.randrange(1, 3))}
    elif state_id == "U":
        out = {"out": rng.choice(["v", "w"])}
    else:
        out = {}
    if not valid:
        m = rng.randrange(6)
        k = next(iter(out), "x")
        if m == 0:
            out["approved"] = True
        elif m == 1:
            out[k] = rng.choice(WEIRD)
        elif m == 2:
            out = {}
        elif m == 3:
            out[k] = "maybe"
        elif m == 4:
            out["extra"] = 9  # engine-owned
        else:
            out["tenant_id"] = "globex"
    return out


def mini_model_outputs(pkg_name, state_id, cp_vars, valid):
    if pkg_name == "judge":
        out = {"label": rng.choice(["ok", "bad", "abstain"])}
        if not valid:
            out = rng.choice([{"label": "definitely"}, {"label": "ok", "approved": True}, {}, {"label": None},
                              {"label": 1}, {"label": ["ok"]}, {"label": "OK"}])
        return out
    if pkg_name.startswith("falsy"):
        out = {"flag": rng.choice([False, True]), "count": rng.choice([0, 1, 2]), "note": rng.choice(["", "n"])}
        if not valid:
            k = rng.choice(list(out))
            out[k] = rng.choice(WEIRD + ["false", 0, 1.5])
        return out
    if pkg_name == "owner_mix":
        if state_id == "T":
            return {"t": "task-owned"} if valid else {}
        out = {"u": rng.choice(["go", "stop", "go", 1, None]), "num": rng.choice([1, 2.5, 3, 3, True, "x", None, -0.5]),
               "ghostvar": rng.choice([1, None, "g", None])}
        if not valid:
            out[rng.choice(list(out))] = rng.choice(WEIRD)
        return out
    if pkg_name.startswith("scoped"):
        old = cp_vars.get("doc")
        base = copy.deepcopy(old) if isinstance(old, dict) else {}
        r = rng.randrange(12)
        if r == 0:
            base["a"] = "y"
        elif r == 1:
            base["locked"] = rng.choice([2, True, 1.5, "1", None])
        elif r == 2:
            base.pop("gone", None)
        elif r == 3:
            base["injected"] = None
        elif r == 4:
            base = None
        elif r == 5:
            base = rng.choice([[], "x"])
        elif r == 6:
            base["a"] = {"nested": [1, 2.5]}
        elif r == 7:
            base.pop("a", None)
        elif r == 8:
            base["gone"] = 0
        elif r == 9:
            base = {"a": "y", "locked": 1, "gone": None}
        # 10, 11 unchanged
        return {"doc": base}
    return {}


ADMISSIONS = [
    {}, {"terminal_admission": {"evidence_valid": True, "receipts": ["ev_1"], "unresolved_effects": []}},
    {"terminal_admission": {"evidence_valid": True, "receipts": ["ev_1", "ev_2"]}},
    {"terminal_admission": {"evidence_valid": True, "receipts": [], "unresolved_effects": ["la_1:erp.create_draft:UNKNOWN"]}},
    {"terminal_admission": {"evidence_valid": False, "missing": ["persisted_draft_matches_approved_payload"]}},
    {"terminal_admission": {"evidence_valid": False}},
    {"terminal_admission": {"evidence_valid": 1, "receipts": "ab"}},
    {"terminal_admission": {"evidence_valid": "yes", "unresolved_effects": "xy"}},
    {"terminal_admission": {"evidence_valid": [], "missing": {"j": 1, "k": 2}}},
    {"terminal_admission": {"evidence_valid": True, "unresolved_effects": {"la": 1}}},
    {"terminal_admission": {"evidence_valid": True, "unresolved_effects": 5}},
    {"terminal_admission": {"evidence_valid": False, "missing": None}},
    {"terminal_admission": {"evidence_valid": True, "receipts": None}},
    {"terminal_admission": {"evidence_valid": True, "receipts": [{"id": 1}, 2, None]}},
    {"terminal_admission": "x"}, {"terminal_admission": None}, {"terminal_admission": [1]},
    {"terminal_admission": {"evidence_valid": True, "receipts": ["ev"], "unresolved_effects": [], "other": 1},
     "fallback": "noted"},
    {"terminal_admission": {"evidence_valid": False, "missing": []}},
]

USAGES = [{}, {}, {}, {"tool_calls": 1}, {"model_calls": 1, "tokens": 1200}, {"tokens": 60000}, {"tool_calls": 30},
          {"model_calls": 11}, {"output_repairs": 2}, {"tokens": "5"}, {"tokens": True}, {"tool_calls": -3},
          {"other": 4}, {"model_calls": "2", "tokens": 100001}]
BAD_USAGES = [{"tokens": "x"}, {"tokens": 1.5}, {"tokens": None}, {"tokens": [1]}, "u", [1]]


def make_obs_fields(pkg_name, pkg, cp, valid):
    st = pkg.machine.states.get(cp.state_id)
    kind = st.action.kind if st else rng.choice(["tool", "model", "user", "end", "judge"])
    v = cp.variables
    if kind == "tool":
        outputs = tool_outputs(cp.state_id, v, valid)
    elif kind in ("model", "judge"):
        outputs = (mini_model_outputs(pkg_name, cp.state_id, v, valid) if pkg_name not in ("initial", "refined")
                   else model_outputs(cp.state_id, v, valid))
    elif kind == "user":
        outputs = user_outputs(cp.state_id, v, valid)
    else:
        outputs = {} if rng.random() < 0.9 else {"x": 1}
    f = {"run_id": cp.run_id, "state_id": cp.state_id, "revision": cp.revision, "kind": kind, "outputs": outputs}
    if rng.random() < 0.3:
        f["usage"] = copy.deepcopy(rng.choice(USAGES))
    if rng.random() < 0.2:
        f["actor"] = rng.choice(["model:fixture", "user:bob", "tool:erp.create_draft", "é"])
    if rng.random() < 0.2:
        f["receipt_ref"] = "la_%x#1" % rng.getrandbits(24)
    if kind == "end":
        f["engine"] = copy.deepcopy(rng.choice(ADMISSIONS))
    elif rng.random() < 0.05:
        f["engine"] = {"fallback": {"why": "x"}}
    if not valid:
        m = rng.randrange(16)
        if m == 0:
            f["failure"] = rng.choice(["output repair exhausted", "tool error: timeout", "é"])
        elif m == 1:
            f["run_id"] = "other-run"
        elif m == 2:
            f["state_id"] = rng.choice(list(pkg.machine.states))
        elif m == 3:
            f["revision"] = cp.revision + rng.choice([-1, 1, 5])
        elif m == 4:
            f["kind"] = rng.choice([k for k in ("tool", "model", "judge", "user", "end") if k != kind])
        elif m == 5:
            f["kind"] = rng.choice(["robot", "", None])
        elif m == 6:
            f["approved"] = True
        elif m == 7:
            f["usage"] = copy.deepcopy(rng.choice(BAD_USAGES))
        elif m == 8:
            f["outputs"] = rng.choice([[], "x", None])
        elif m == 9:
            f["revision"] = rng.choice(["%d" % cp.revision, True if cp.revision == 1 else cp.revision, 1.5, "x"])
        elif m == 10:
            f["record_schema"] = rng.choice(["hexis-observation/2", "hexis-observation/1"])
        elif m == 11:
            f.pop(rng.choice(["run_id", "state_id", "revision", "kind"]))
        elif m == 12:
            f["failure"] = ""
        elif m == 13:
            f["engine"] = rng.choice([[], "x"])
        elif m == 14:
            f["failure"] = 5
        else:
            f["usage"] = {"tokens": 10 ** 6}
    return canon(f)


def task_input(valid=True):
    t = {"supplier_ref": rng.choice(["SUP-10042", "SUP-55555", "SUP-40002", "SUP-123"]),
         "business_unit": rng.choice(["BU-EMEA", "BU-NA"]),
         "document_ids": rng.sample(DOC_IDS, rng.randrange(0, 3)),
         "required_fields": rng.sample(["legal_name", "country", "tax_id", "contact_email"], rng.randrange(0, 4)),
         "policy_version": "onboarding-policy/2026-09"}
    if not valid:
        m = rng.randrange(9)
        if m == 0:
            t.pop(rng.choice(list(t)))
        elif m == 1:
            t["supplier_ref"] = rng.choice(["SUP-1", "sup-10042", "SUP-12345678901", "XSUP-123"])
        elif m == 2:
            t["extra"] = 1
        elif m == 3:
            t["document_ids"] = rng.choice(["DOC", ["D"] * 21, [1]])
        elif m == 4:
            t["business_unit"] = ""
        elif m == 5:
            t["required_fields"] = None
        elif m == 6:
            t = rng.choice([[], "x", None])
        elif m == 7:
            t["policy_version"] = 7
        else:
            t["supplier_ref"] = 10042
    return canon(t)


def rand_variables(pkg):
    out = {}
    for var in pkg.machine.variables:
        if rng.random() < 0.15:
            continue
        t = var.type
        if rng.random() < 0.08:
            out[var.name] = rng.choice(WEIRD)
        elif t == "string":
            out[var.name] = rng.choice(["pass", "repairable", "available", "found", "match", "approved", "new", "x",
                                        "SUP-10042"])
        elif t == "integer":
            out[var.name] = rng.choice([0, 1, 2, 3])
        elif t == "array":
            out[var.name] = rng.choice([[], rand_issues(), ["DOC-X"]])
        elif t == "object":
            out[var.name] = rng.choice([{}, rand_draft(), {"a": 1}])
        else:
            out[var.name] = rng.choice([True, False])
    if "validation_issues" in out and rng.random() < 0.5:
        out["validation_issues"] = [{"field": f} for f in rng.sample(FIELDS, 2)]
    return out


def custom_start(pkg_name, pkg):
    states = list(pkg.machine.states)
    f = {"tenant_id": "acme", "run_id": "run-%d" % rng.randrange(1000), "artifact_hash": pkg.artifact_hash,
         "state_id": rng.choice(states), "revision": rng.randrange(0, 6), "variables": rand_variables(pkg)}
    lim = pkg.execution_policy.budgets
    if rng.random() < 0.5:
        f["budget"] = {"steps": rng.choice([0, 3, min(lim.max_steps, pkg.machine.max_steps) - 1,
                                            min(lim.max_steps, pkg.machine.max_steps)]),
                       "tool_calls": rng.choice([0, lim.max_tool_calls]), "tokens": rng.choice([0, lim.max_tokens - 5])}
    if rng.random() < 0.1:
        f["status"] = rng.choice(["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_APPROVAL", "RECONCILING", "READY"])
    if rng.random() < 0.1:
        f["assurance"] = {"entered_fallback": True, "fallback_reason": "x", "diagnostics": [{"code": "OLD"}],
                          "missing_evidence": ["m"]}
    m = rng.randrange(30)
    if m == 0:
        f["artifact_hash"] = "sha256:" + "0" * 64
    elif m == 1:
        f["state_id"] = "NOWHERE"
    elif m == 2:
        f["status"] = "DONE"
    elif m == 3:
        f["extra"] = 1
    elif m == 4:
        f["variables"] = []
    elif m == 5:
        f["revision"] = "2"
    elif m == 6:
        f["budget"] = {"steps": "x"}
    elif m == 7:
        f["evidence_refs"] = [1]
    elif m == 8:
        f.pop("tenant_id")
    return canon(f)


# --------------------------------------------------------------------------- walks
walks = []
total_steps = 0


def walk(pkg_name, max_steps=30):
    global total_steps
    pkg = PACKAGES[pkg_name]
    w = {"pkg": pkg_name, "steps": []}
    if pkg_name in ("initial", "refined") and rng.random() < 0.6:
        ti = task_input(valid=rng.random() < 0.8)
        tenant, run_id = rng.choice(["acme", "globex"]), "run-%d" % rng.randrange(1000)
        w["start"] = {"kind": "initial", "tenant_id": tenant, "run_id": run_id, "task_input": ti}
        r = run(lambda: K.initial_checkpoint(pkg, tenant, run_id, ti))
    elif pkg_name not in ("initial", "refined") and rng.random() < 0.5:
        w["start"] = {"kind": "initial", "tenant_id": "t", "run_id": "r", "task_input": {}}
        r = run(lambda: K.initial_checkpoint(pkg, "t", "r", {}))
    else:
        fields = custom_start(pkg_name, pkg)
        w["start"] = {"kind": "checkpoint", "fields": fields}
        r = run(lambda: K.RunCheckpoint(**fields))
    if "ok" in r:
        cp = r["ok"]
        w["start_result"] = {"ok": cp.model_dump(mode="json")}
    else:
        w["start_result"] = r
        walks.append(w)
        return
    finished_probe = False
    streak, prev_exc = 0, None
    for _ in range(max_steps):
        valid = rng.random() < 0.72
        fields = make_obs_fields(pkg_name, pkg, cp, valid)
        step = {"obs": fields}
        o = run(lambda: K.Observation(**fields))
        if "exc" in o:
            step["result"] = o
        else:
            obs = o["ok"]
            res = run(lambda: K.advance(cp, obs, pkg))
            if "ok" in res:
                step["result"] = {"ok": result_dump(res["ok"])}
                cp = res["ok"].checkpoint
            else:
                step["result"] = res
        w["steps"].append(step)
        total_steps += 1
        if "exc" in step["result"]:
            streak = streak + 1 if prev_exc == step["result"].get("code", step["result"]["exc"]) else 1
            prev_exc = step["result"].get("code", step["result"]["exc"])
            if streak >= 3:
                break
        else:
            streak, prev_exc = 0, None
        if cp.status in K.TERMINAL_STATUSES:
            if finished_probe or rng.random() < 0.5:
                break
            finished_probe = True
    walks.append(w)


for i in range(170):
    walk("initial")
for i in range(130):
    walk("refined")
for name in ("judge", "falsy", "falsy_ghost", "falsy_order", "scoped", "scoped_nullable", "scoped_malformed",
             "scoped_key", "scoped_noissues", "verified", "owner_mix"):
    for i in range(30 if name in ("judge", "owner_mix", "verified") else 14):
        walk(name, max_steps=4)

assert total_steps >= 1500, total_steps

# --------------------------------------------------------------------------- helper vectors
fill = []
VALUES = {"s": "text", "i": 42, "f": 2.5, "neg": -3, "b": False, "t": True, "n": None, "l": [1, "a"], "d": {"k": "v"},
          "e": "", "big": 10 ** 15, "small": 1e-7, "huge": 1.5e-300, "uni": "é😀", "_x": "u", "X9": 9}
TEMPLATES = ["${s}", "${i}", "${b}", "${n}", "${l}", "${d}", "${e}", "id=${s}", "${s}-${i}", "${i}${f}", "${f}", "a${neg}b",
             "${missing}", "x=${missing}", "${b}!", "pre ${n}", "${l} list", "${d}.", "${big}/${small}", "${huge}",
             "${uni}", "${_x}${X9}", "${ s}", "${1a}", "$s", "${s", "${s}}", "{s}", "$${s}", "${s}\n", "${s}\n\n",
             "\n${s}", "${s} ", "${t}", "${S}", "${é}", "${s}${missing}${b}", "${b}${missing}",
             {"a": "${s}", "b": ["${i}", {"c": "${b}"}], "d": 5, "e": None, "f": "${n}"},
             {"draft_id": "${erp_draft_id}"}, ["${l}", "${d}", "${f}", 1.25, True],
             {"q": "id=${missing}"}, {"x": "${b}"}, [], {}, 7, None, 3.75, True, {"__proto__": "${s}", "constructor": 1}]
for t in TEMPLATES:
    fill.append({"template": t, "result": run(lambda: K.fill_template(t, VALUES))})
for _ in range(300):
    names = list(VALUES) + ["missing", "zz"]

    def rt(depth=0):
        r = rng.random()
        if depth < 3 and r < 0.2:
            return [rt(depth + 1) for _ in range(rng.randrange(3))]
        if depth < 3 and r < 0.35:
            return {rng.choice(["a", "b", "c", "0", "10"]): rt(depth + 1) for _ in range(rng.randrange(3))}
        if r < 0.85:
            parts = []
            for _ in range(rng.randrange(1, 4)):
                parts.append(rng.choice(["${%s}" % rng.choice(names), "txt", " ", "$", "{", "\n"]))
            return "".join(parts)
        return rng.choice([1, 2.5, None, False, "plain"])
    t = canon(rt())
    fill.append({"template": t, "result": run(lambda: K.fill_template(t, VALUES))})

resolve = []
TI = {"a": {"b": {"c": 3}, "l": [1, 2]}, "a/b": {"c": 4}, "a~b": 5, "": {"": 6}, "n": None, "x.y": 7, "f": False,
      "supplier_ref": "SUP-1", "~1": 8, "é": {"😀": 9}}
for path in ["task.input.a.b.c", "task.input.a.b", "task.input.a", "task.input", "task.input.", "task.input.a.l.0",
             "task.input.n", "task.input.f", "task.input.x.y", "task.input.supplier_ref", "task.input.zz",
             "task.inputs.a", "task.a", "input.a", "a.b", "", "task", "task.input.a.b.c.d", "/a/b/c", "/a~1b/c",
             "/a~0b", "/", "//", "/a", "/a/l/0", "/n", "/~01", "/~1", "/é/😀", "task.input.é.😀", "/zz",
             "task.input..", "TASK.input.a"]:
    resolve.append({"task_input": TI, "path": path, "result": run(lambda: list(K.resolve_path(TI, path)))})
for ti in [[], "x", None, 5, {"a": [{"b": 1}]}]:
    for path in ["task.input.a", "/a", "/a/0/b", "task.input.a.0.b"]:
        resolve.append({"task_input": ti, "path": path, "result": run(lambda: list(K.resolve_path(ti, path)))})
resolve.append({"task_input": TI, "path": 5, "result": run(lambda: list(K.resolve_path(TI, 5)))})

select = []
for _ in range(500):
    name = rng.choice(list(PACKAGES))
    pkg = PACKAGES[name]
    sid = rng.choice(list(pkg.machine.states))
    env = rand_variables(pkg)
    for k in list(env):
        if rng.random() < 0.1:
            env[k] = rng.choice(WEIRD)
    env = canon(env)
    select.append({"pkg": name, "state": sid, "variables": env,
                   "result": run(lambda: list(K.select_edge(pkg, sid, env)))})

INDEX = {"walk_files": []}
chunk, size, n = [], 0, 0


def flush():
    global chunk, size, n
    if chunk:
        n += 1
        name = "kernel_walks_%d" % n
        write(name, {"walks": chunk})
        INDEX["walk_files"].append(name)
    chunk, size = [], 0


for w in walks:
    s = len(json.dumps(w))
    if size + s > 950_000:
        flush()
    chunk.append(w)
    size += s
flush()

write("kernel", {
    "packages": {k: pkg_dump(p) for k, p in PACKAGES.items()},
    "artifact_hashes": {k: p.artifact_hash for k, p in PACKAGES.items()},
    "walk_files": INDEX["walk_files"], "total_steps": total_steps,
    "fill_template": fill, "resolve_path": resolve, "select_edge": select,
    "terminal_statuses": list(K.TERMINAL_STATUSES),
})
print("kernel golden:", len(walks), "walks,", total_steps, "steps,", len(INDEX["walk_files"]), "walk files")
for f in sorted(GOLDEN.glob("kernel*.json")):
    print(" ", f.name, f.stat().st_size)
