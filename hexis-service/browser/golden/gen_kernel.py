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

# --------------------------------------------------------------------------- exact multipleOf (python-jsonschema)
# Kernel schema checks (TASK_INPUT_INVALID / OUTPUT_SCHEMA) must give python-jsonschema's verdict for multipleOf:
# int divisor -> instance % dB, float divisor -> int(q) != q, overflow -> Fraction. Verdicts only (texts differ).
from hexis_service.tools.catalog import validate_against  # noqa: E402

mrng = random.Random(77001)
DIVISORS = [0.01, 0.1, 0.5, 0.25, 0.3, 1e-300, 5e-324, 1e-10, 2.5, 1e-9, 1e-7, 3, 1, 2, 7, 1000, 1.5e-300, 2.5e-310]
INSTANCES = [0.07, 0.3, 0.6, 0.7, 1.1, 3, 0, -0.07, 0.5, 1.5e-300, 1e-300, 5e-324, 1e-299, 3e-300, 1234.5,
             4503599627370495.5, 10 ** 15, 2 ** 52 + 1, 9007199254740991, 2.5, 7.5, 12, -6, 0.75, 1.25,
             0.1 + 0.2, 4.35, 19.99, 100.01, 1e-7, 2e-9, 3e-10]
mo_cases = []


def mo_case(schema, value):
    schema, value = canon(schema), canon(value)
    mo_cases.append({"schema": schema, "value": value, "valid": not validate_against(schema, value)})


for d in DIVISORS:
    for x in INSTANCES:
        mo_case({"multipleOf": d}, x)
for _ in range(1500):
    d = mrng.choice(DIVISORS + [mrng.choice([0.01, 0.05, 0.125]) * mrng.randrange(1, 9)])
    x = mrng.choice([round(mrng.uniform(-50, 50), mrng.randrange(0, 4)), mrng.randrange(-100, 100),
                     mrng.choice(INSTANCES) * mrng.choice([1, 2, 3, 10, 0.5])])
    if isinstance(x, float) and (x != x or x in (float("inf"), float("-inf"))):
        x = 0.07
    if isinstance(x, float) and x.is_integer():
        x = int(x) if abs(x) < 2 ** 53 else 0.07
    if isinstance(x, float) and abs(x) >= 2 ** 52:
        x = 0.07
    if isinstance(x, int) and abs(x) >= 2 ** 53:
        x = 0.07
    if isinstance(d, float) and d.is_integer():
        d = int(d)
    mo_case({"multipleOf": d}, x)
NESTED = [
    lambda d: {"type": "object", "properties": {"a": {"type": "number", "multipleOf": d}}},
    lambda d: {"type": "array", "items": {"multipleOf": d}},
    lambda d: {"anyOf": [{"multipleOf": d}, {"type": "string"}]},
    lambda d: {"oneOf": [{"multipleOf": d}, {"multipleOf": 0.5}]},
    lambda d: {"not": {"multipleOf": d}},
    lambda d: {"allOf": [{"minimum": 0}, {"multipleOf": d}]},
    lambda d: {"type": "object", "patternProperties": {"^n": {"multipleOf": d}}, "additionalProperties": {"multipleOf": 0.25}},
    lambda d: {"anyOf": [{"not": {"multipleOf": d}}, {"maximum": -1000}]},
]
for _ in range(600):
    d = mrng.choice([0.01, 0.1, 0.5, 0.3, 3, 1e-300, 5e-324])
    f = mrng.randrange(len(NESTED))
    x = mrng.choice(INSTANCES)
    v = {0: {"a": x}, 1: [x, mrng.choice(INSTANCES)], 6: {"n1": x, "z": mrng.choice(INSTANCES)}}.get(f, x)
    mo_case(NESTED[f](d), v)

MO_STATES = {"U": {"id": "U", "action": {"kind": "user", "prompt": "p", "writes": ["amount"]},
                   "transitions": [{"if": "", "to": "E"}]},
             "E": END("EE"), "FALLBACK": END("ER")}
MO_PKG = mini_package(MO_STATES, [{"name": "amount", "type": "number"}],
                      {"amount": {"owner": "user", "schema": {"type": "number", "multipleOf": 0.01}}},
                      [{"id": "EE", "kind": "unverified"}, {"id": "ER", "kind": "fallback"}],
                      {"EE": {"category": "unverified"}, "ER": {"category": "fallback"}}, "U",
                      task_schema={"type": "object", "properties": {"amount": {"type": "number", "multipleOf": 0.01}}})
mo_kernel = []
MO_CP = K.initial_checkpoint(MO_PKG, "t", "r", {})
for x in [0.07, 0.25, 19.99, 100.01, 0.3, 4.35, 1.005, 0.015, 7, 1e-300, 1234.5, 0.1 + 0.2]:
    mo_kernel.append({"amount": x,
                      "initial": run(lambda: K.initial_checkpoint(MO_PKG, "t", "r", {"amount": x}).model_dump(mode="json")),
                      "advance": run(lambda: result_dump(K.advance(MO_CP, K.Observation(
                          run_id="r", state_id="U", revision=0, kind="user", outputs={"amount": x}), MO_PKG)))})

# --------------------------------------------------------------------------- Python regex semantics in schemas
# python-jsonschema applies pattern / patternProperties with re.search (Unicode \d \w \s \b, `$` before a final
# "\n", `.` excluding "\n"). The kernel translates schema regexes; JS must give Python's verdict or fail closed.
import re  # noqa: E402

xrng = random.Random(55021)


def re_table(p):
    r, out, start = re.compile(p), [], None
    for c in range(0x110001):
        m = c < 0x110000 and r.fullmatch(chr(c)) is not None
        if m and start is None:
            start = c
        if not m and start is not None:
            out.append("%x" % start if start == c - 1 else "%x-%x" % (start, c - 1))
            start = None
    return ",".join(out)


RE_CHARS = ["a", "b", "z", "A", "_", "0", "7", "-", ".", " ", "\n", "\t", "\r", "é", "İ", "ǅ", "٣", "١", "²", "½", "Ⅻ",
            "ͅ", " ", " ", " ", "\u001c", "\u001f", "\u0085", "﻿", "😀", "Ᲊ", "\U0001e4d0",
            "๐", "ß", "$", "^", "\\", "]", "[", "{", "}", "(", ")", "|", "*", "+", "?", "/", "\x00"]
RE_LIT = ["a", "b", "z", "_", "0", "7", "-", " ", "é", "٣", "😀", ",", ":", "#", "=", "!", "<", ">", "&", "~", "'", '"']
RE_ESC = [r"\d", r"\D", r"\w", r"\W", r"\s", r"\S", r"\b", r"\B", r"\A", r"\Z", r"\.", r"\-", r"\n", r"\t", r"\x41",
          r"é", r"\U0001F600", r"\\", r"\$", r"\^", r"\{", r"\}", r"\]", r"\/", r"\é", r"\ ", r"\#", r"\a", r"\f", r"\v"]
RE_BAD = [r"\1", r"(?i)a", r"a*+", r"(?#c)", r"\N{DIGIT ZERO}", r"\0", r"(?>a)", r"(?P=n)", r"\q", r"(?s).", r"a{2}{3}",
          r"[\w-z]", r"*a", r"(a", r"a)", r"[a", r"\x4", r"a{3,1}", r"(?<=a+)b", r"(?=a)*", r"^*", r"(?P<1>a)", r"\U00110000"]


def rand_class():
    items = []
    for _ in range(xrng.randrange(1, 4)):
        k = xrng.random()
        if k < 0.35:
            items.append(xrng.choice(RE_LIT + ["]", "^", "[", "\\]", "\\\\", "\\-", "\\b", "\\n", "\\x41", "\\u0663"]))
        elif k < 0.6:
            items.append(xrng.choice([r"\d", r"\D", r"\w", r"\W", r"\s", r"\S"]))
        else:
            a, b = sorted([xrng.choice("abz09_AZ"), xrng.choice("abz09_AZ")])
            items.append(xrng.choice([a + "-" + b, "٠-٩", "à-ÿ", "a-", "-"]))
    return "[" + ("^" if xrng.random() < 0.3 else "") + "".join(items) + "]"


def rand_regex(depth=0):
    seq = []
    for _ in range(xrng.randrange(1, 4)):
        k = xrng.random()
        if k < 0.3:
            atom = xrng.choice(RE_LIT)
        elif k < 0.55:
            atom = xrng.choice(RE_ESC)
        elif k < 0.67:
            atom = rand_class()
        elif k < 0.75:
            atom = xrng.choice([".", "^", "$", "{", "{}", "{x"])
        elif k < 0.9 and depth < 2:
            inner = rand_regex(depth + 1)
            if xrng.random() < 0.3:
                inner += "|" + rand_regex(depth + 1)
            atom = xrng.choice(["(", "(?:", "(?=", "(?!", "(?P<g%d>" % xrng.randrange(1000)]) + inner + ")"
            if xrng.random() < 0.1:
                atom = xrng.choice(["(?<=", "(?<!"]) + xrng.choice(["a", "\\d", "[ab]", "é", "\\n"]) + ")"
        else:
            atom = xrng.choice(RE_LIT)
        if xrng.random() < 0.35:
            atom += xrng.choice(["*", "+", "?", "{2}", "{1,3}", "{,2}", "{2,}", "{,}", "{0}"]) + xrng.choice(["", "", "?"])
        seq.append(atom)
    if xrng.random() < 0.05:
        seq.append(xrng.choice(RE_BAD))
    return "".join(seq)


def rand_text():
    return "".join(xrng.choice(RE_CHARS) for _ in range(xrng.randrange(0, 6))) + xrng.choice(["", "", "\n", "\n\n", "x\n"])


def re_result(p, s):
    try:
        return re.search(p, s) is not None
    except re.error:
        return "error"
    except Exception as e:  # noqa: BLE001
        return type(e).__name__


CURATED = [(r"^SUP-[0-9]{3,10}$", ["SUP-123", "SUP-123\n", "SUP-123\n\n", "SUP-12", "xSUP-1234"]),
           (r"^\w+$", ["é", "İ", "١٢", "٣", "abc_9", "a-b", "²", "½", "Ⅻ", "ǅ", "ͅ", "\U0001e4d0", "Ᲊ", ""]),
           (r"^\d+$", ["٣", "123", "²", "１２", "\U0001d7ce", "1\n"]),
           (r"^\s+$", [" ", "\u001c", "\u0085", "﻿", " ", " ", "​", "᠎"]),
           (r"^DROP$", ["DROP", "DROP\n", "DROP\r", "DROP "]),
           (r"^a.c$", ["abc", "a\nc", "a\rc", "a c", "a😀c"]),
           (r"\bfoo\b", ["foo", "éfoo", "foo٣", "a foo b", "_foo"]),
           (r"\B", ["", "a", " ", "ab"]), (r"\b", ["", "a", " "]),
           (r"a\Z", ["a", "a\n"]), (r"\Aa", ["a", "ba"]), (r"x{,2}y", ["xxy", "y"]), (r"a{", ["a{", "a"]),
           (r"[\W\d]", ["a", "٣", "-"]), (r"[^\w]", ["é", "-"]), (r"[]a]", ["]", "a", "b"]), (r"[^]a]", ["]", "b"]),
           (r"(?P<n>a)b", ["ab"]), (r"(?<=a)b", ["ab", "b"]), (r"[\b]", ["\b", "b"]), (r"\é", ["é"]),
           (r"^amount_[a-z]+$", ["amount_x", "amount_x\n", "amount_X"])]
re_vectors = []
for p, texts in CURATED:
    for s in texts:
        re_vectors.append({"p": p, "s": s, "r": re_result(p, s)})
for p in RE_BAD:
    re_vectors.append({"p": p, "s": "aaa", "r": re_result(p, "aaa")})
for _ in range(2500):
    p = rand_regex()
    for _ in range(3):
        s = rand_text()
        re_vectors.append({"p": p, "s": s, "r": re_result(p, s)})


def schema_result(schema, value):
    try:
        return not validate_against(schema, value)
    except re.error:
        return "error"
    except Exception as e:  # noqa: BLE001
        return type(e).__name__


SCHEMA_FORMS = [
    lambda p: {"type": "string", "pattern": p},
    lambda p: {"type": "string", "not": {"pattern": p}},
    lambda p: {"type": "object", "patternProperties": {p: {"type": "number"}}},
    lambda p: {"type": "object", "patternProperties": {p: {"type": "number"}}, "additionalProperties": False},
    lambda p: {"not": {"type": "object", "patternProperties": {p: {"type": "string"}}}},
    lambda p: {"anyOf": [{"pattern": p}, {"type": "integer"}]},
    lambda p: {"oneOf": [{"pattern": p}, {"pattern": "^a"}]},
    lambda p: {"type": "object", "patternProperties": {p: {"multipleOf": 0.01}, "^a": {"type": "number"}}},
    lambda p: {"type": "object", "patternProperties": {p: {"type": "number"}, "(?:" + p + ")": {"minimum": 5}}},
]
schema_vectors = [
    {"schema": {"type": "object", "patternProperties": {"^\\w+$": {"type": "number"}}}, "value": {"é": "x"}},
    {"schema": {"not": {"pattern": "^\\d+$"}}, "value": "٣"},
    {"schema": {"type": "object", "patternProperties": {"^amount_[a-z]+$": {"type": "number"}}}, "value": {"amount_x\n": "lots"}},
    {"schema": {"type": "string", "not": {"pattern": "^DROP$"}}, "value": "DROP\n"},
    {"schema": {"type": "object", "patternProperties": {"a": {"type": "number"}, "\\x61": {"minimum": 5}}}, "value": {"a": 3}},
    {"schema": {"pattern": 5}, "value": "x"}, {"schema": {"pattern": 5}, "value": 1},
]
for _ in range(1500):
    p = rand_regex() if xrng.random() < 0.8 else xrng.choice([c[0] for c in CURATED])
    form = xrng.randrange(len(SCHEMA_FORMS))
    s = rand_text()
    value = {s: xrng.choice([1, "x", 2.5, 7])} if form in (2, 3, 4, 7, 8) else xrng.choice([s, s, s, 3])
    schema_vectors.append({"schema": SCHEMA_FORMS[form](p), "value": value})
for v in schema_vectors:
    v["valid"] = schema_result(v["schema"], v["value"])

# kernel-level repros: TASK_INPUT_INVALID / OUTPUT_SCHEMA with Python regex semantics
RX_STATES = {"U": {"id": "U", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": ["code"]},
                   "transitions": [{"if": "", "to": "E"}]},
             "E": END("EE"), "FALLBACK": END("ER")}
RX_PKG = mini_package(RX_STATES, [{"name": "code", "type": "string"}],
                      {"code": {"owner": "model", "schema": {"type": "string", "not": {"pattern": "^DROP$"}}}},
                      [{"id": "EE", "kind": "unverified"}, {"id": "ER", "kind": "fallback"}],
                      {"EE": {"category": "unverified"}, "ER": {"category": "fallback"}}, "U",
                      task_schema={"type": "object", "patternProperties": {"^amount_[a-z]+$": {"type": "number"},
                                                                           "^\\w+$": {"type": "integer"}}})
RX_CP = K.initial_checkpoint(RX_PKG, "t", "r", {})
rx_kernel = []
for ti in [{"amount_x\n": "lots"}, {"amount_x": 3}, {"é": 2.5}, {"é": 2}, {"٣": "x"}, {"a-b": "x"}]:
    rx_kernel.append({"task_input": ti, "result": run(lambda: K.initial_checkpoint(RX_PKG, "t", "r", ti).model_dump(mode="json"))})
for code in ["DROP", "DROP\n", "DROP\n\n", "drop", "DROP\r"]:
    rx_kernel.append({"code": code, "result": run(lambda: result_dump(K.advance(RX_CP, K.Observation(
        run_id="r", state_id="U", revision=0, kind="model", outputs={"code": code}), RX_PKG)))})

# int() (inc counters, usage): the whitespace CPython strips
INT_CPS = [c for c in list(range(0, 0x3001)) + [0xfeff, 0x180e, 0x200b, 0x2060, 0x10000, 0x1d7ce]
           if not 0xd800 <= c < 0xe000]
int_vectors = {"cps": INT_CPS, "accepted": []}  # accepted: [form, cp, int value]; every other (form, cp) raises
for c in INT_CPS:
    for form, s in enumerate([chr(c) + "8", "8" + chr(c), chr(c)]):
        try:
            int_vectors["accepted"].append([form, c, int(s)])
        except ValueError:
            pass

# judge with empty writes: the package model refuses it, so the action is emptied after construction; Python's
# validate_declared_outputs then reaches delta[writes[0]] (IndexError)
JE_PKG = judge_pkg().model_copy(deep=True)
JE_PKG.machine.states["J"].action.writes = []
judge_empty = {"package_build": run(lambda: mini_package(
    {"J": {"id": "J", "action": {"kind": "judge", "prompt": "q", "reads": [], "writes": [], "labels": ["ok"]},
           "transitions": [{"if": "", "to": "E"}]}, "E": END("EE"), "FALLBACK": END("ER")},
    [], {}, [{"id": "EE", "kind": "unverified"}, {"id": "ER", "kind": "fallback"}],
    {"EE": {"category": "unverified"}, "ER": {"category": "fallback"}}, "J") and "built"),
    "validate": run(lambda: K.validate_declared_outputs(JE_PKG, "J", K.Observation(
        run_id="r", state_id="J", revision=0, kind="judge", outputs={}), {}))}

write("kernel_regex", {
    "tables": {k: re_table(p) for k, p in (("d", r"\d"), ("s", r"\s"), ("w", r"\w"))},
    "regex": re_vectors, "schemas": schema_vectors,
    "kernel": {"package": pkg_dump(RX_PKG), "cases": rx_kernel},
    "int": int_vectors, "judge_empty_writes": judge_empty,
})
print("kernel_regex:", len(re_vectors), "regex vectors,", len(schema_vectors), "schema vectors,", len(int_vectors["accepted"]), "accepted int vectors")

# budget / inc counters near the JS-safe integer range: Python's ints are unbounded; the JS port fails closed with
# KernelError BUDGET_OVERFLOW / COUNTER_OVERFLOW exactly where Python returns a checkpoint carrying an unsafe value
SAFE_INT = 2**53 - 1


def _unsafe(v):
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return abs(v) > SAFE_INT
    if isinstance(v, dict):
        return any(_unsafe(x) for x in v.values())
    if isinstance(v, (list, tuple)):
        return any(_unsafe(x) for x in v)
    return False


def budget_case(state, kind, budget, usage, variables=None, outputs=None, failure=None, engine=None):
    p = PACKAGES["owner_mix"]
    case = {"state": state, "kind": kind, "budget": {k: str(v) for k, v in budget.items()},
            "usage": usage, "variables": variables or {}, "outputs": outputs or {}, "failure": failure,
            "engine": engine or {}}

    def go():
        cp = K.RunCheckpoint(tenant_id="t", run_id="r", artifact_hash=p.artifact_hash, state_id=state,
                             variables=copy.deepcopy(variables or {}), budget=K.Budget(**budget))
        obs = K.Observation(run_id="r", state_id=state, revision=0, kind=kind, outputs=copy.deepcopy(outputs or {}),
                            usage=usage, engine=copy.deepcopy(engine or {}),
                            **({"failure": failure} if failure is not None else {}))
        r = K.advance(cp, obs, p)
        d = result_dump(r)
        if _unsafe(d):
            cpd = d["checkpoint"]
            return {"unsafe": True, "status": cpd["status"], "state_id": cpd["state_id"],
                    "budget": {k: str(v) for k, v in cpd["budget"].items()},
                    "unsafe_budget": sorted(k for k, v in cpd["budget"].items() if _unsafe(v)),
                    "unsafe_variables": sorted(k for k, v in cpd["variables"].items() if _unsafe(v)),
                    "codes": [x["code"] for x in cpd["assurance"]["diagnostics"]]}
        return d
    case["result"] = run(go)
    return case


B0 = {"steps": 0, "tool_calls": 0, "model_calls": 0, "tokens": 0, "output_repairs": 0}
budget_cases = []
for field in ("tokens", "tool_calls", "model_calls", "output_repairs"):
    for start, use in ((9007199254740000, 9007199254740991), (SAFE_INT, 2), (SAFE_INT - 1, 1), (SAFE_INT, 0),
                       (-SAFE_INT, -1), (-SAFE_INT, 1), (5, SAFE_INT - 5), (0, SAFE_INT)):
        b = dict(B0, **{field: start})
        u = {field: use}
        budget_cases.append(budget_case("M", "model", b, u, outputs={"u": "go", "num": 1, "ghostvar": None}))
        budget_cases.append(budget_case("M", "model", b, u, outputs={"u": "go", "num": 1, "ghostvar": None}, failure="f"))
        budget_cases.append(budget_case("M", "model", b, u, outputs={"u": 5, "num": 1, "ghostvar": None}))  # OUTPUT_TYPE is raised first
        budget_cases.append(budget_case("A", "end", b, u))
for start in (SAFE_INT, SAFE_INT - 1, 0, -SAFE_INT):
    budget_cases.append(budget_case("M", "model", dict(B0, steps=start), {}, outputs={"u": "go", "num": 1, "ghostvar": None}))
    budget_cases.append(budget_case("A", "end", dict(B0, steps=start), {}))
for loops in (SAFE_INT, SAFE_INT - 1, str(SAFE_INT), -SAFE_INT, 3):
    budget_cases.append(budget_case("M", "model", B0, {}, variables={"loops": loops}, outputs={"u": "no", "num": 5, "ghostvar": None}))
    budget_cases.append(budget_case("M", "model", dict(B0, tokens=SAFE_INT), {"tokens": 1},
                                    variables={"loops": loops}, outputs={"u": "no", "num": 5, "ghostvar": None}))

# terminal admission lists from dicts whose insertion order JS cannot recover (integer-like keys): the port raises
# KEY_ORDER_UNKNOWN only where Python returns such a list; earlier Python errors surface with Python's class
ADM_UNRESOLVED = [{"z": 1, "7": 2}, {"z": 1}, [], ["a"], None, True]
ADM_RECEIPTS = [None, True, ["r"], {"z": 1, "7": 2}, {"z": 1}, "MISSING"]
ADM_MISSING = ["MISSING", True, {"b": 1, "9": 2}, ["m"]]
admission_cases = []
VP = PACKAGES["verified"]
for state in ("X", "V", "FALLBACK"):
    for unres in ADM_UNRESOLVED:
        for rec in ADM_RECEIPTS:
            for miss in ADM_MISSING:
                for ev in (True, False):
                    adm = {"evidence_valid": ev, "unresolved_effects": unres}
                    if rec != "MISSING":
                        adm["receipts"] = rec
                    if miss != "MISSING":
                        adm["missing"] = miss
                    if unres is None:
                        del adm["unresolved_effects"]

                    def go(adm=adm, state=state):
                        cp = K.RunCheckpoint(tenant_id="t", run_id="r", artifact_hash=VP.artifact_hash, state_id=state,
                                             variables={"out": "v", "extra": 3})
                        obs = K.Observation(run_id="r", state_id=state, revision=0, kind="end",
                                            engine={"terminal_admission": copy.deepcopy(adm)})
                        return result_dump(K.advance(cp, obs, VP))
                    admission_cases.append({"state": state, "admission": adm, "result": run(go)})

write("kernel_followups", {"package": "owner_mix", "budget": budget_cases,
                           "admission_package": "verified", "admission": admission_cases})
print("kernel_followups:", len(budget_cases), "budget cases,",
      sum(1 for c in budget_cases if c["result"].get("ok", {}).get("unsafe")), "unsafe,",
      len(admission_cases), "admission cases")

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
    "multiple_of": {"cases": mo_cases, "package": pkg_dump(MO_PKG), "kernel": mo_kernel},
})
print("kernel golden:", len(walks), "walks,", total_steps, "steps,", len(INDEX["walk_files"]), "walk files")
for f in sorted(GOLDEN.glob("kernel*.json")):
    print(" ", f.name, f.stat().st_size)
