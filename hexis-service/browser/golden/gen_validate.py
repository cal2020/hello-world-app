"""Golden vectors for HX.validate (artifacts/validate.py) and HX.diff (artifacts/diff.py).

Every case is a list of JSON edit operations applied to the compiled procurement package dump (the JS test
applies the same operations to ``HX.compile.compile_procurement().package``), then resealed (``mode=reseal``)
or kept with its stale/tampered hash (``mode=keep``). Each case is validated under several variants
(profile, with/without ``skill_text``, with/without ``deployment_policy``) and the full findings, analyses,
``passed`` and ``report_digest`` are recorded.

Files: validate_conformance.json (the mutations of tests/conformance/test_static_admission.py and
test_review_admission_validator.py re-expressed as data, plus helper-function vectors) and validate_random.json
(seeded random mutations, with ``package_diff`` against the base package).

Operations (``path`` is a list of keys / indices):
  ["set", path, value]      d[path] = value (a new dict key is appended)
  ["del", path]             del d[path] (dict key or list index)
  ["ins", path, value]      list.insert(path[-1], value)
  ["app", path, value]      d[path].append(value)
  ["appcopy", src, dst]     d[dst].append(deepcopy(d[src]))
  ["setcopy", src, dst]     d[dst] = deepcopy(d[src])
  ["perm", path, idx]       d[path] = [old[i] for i in idx]
  ["order", path, keys]     d[path] = {k: old[k] for k in keys}
  ["strrep", path, old, new]  d[path] = d[path].replace(old, new)
"""

from __future__ import annotations

import copy
import json
import random
import sys

from _common import ints, write

from hexis_service import guards as G
from hexis_service.artifacts import validate as Vmod
from hexis_service.artifacts.diff import package_diff
from hexis_service.artifacts.package import ExecutionPolicy, MachinePackage, OrderingRequirement
from hexis_service.artifacts.validate import (check_ordering, derived_ordering, edge_bound, policy_widening_findings,
                                              reachable, selector_problem, successors, template_vars, validate_package)
from hexis_service.compiler.clauses import index_clauses, is_critical
from hexis_service.compiler.compile import DeploymentPolicy
from hexis_service.demo.env import compile_procurement, load_catalog, skill_source
from hexis_service.demo.procurement_fixture import deployment_policy
from hexis_service.tools.catalog import ToolCatalog

CATALOG = load_catalog()
COMPILED = compile_procurement(CATALOG)
BASE = COMPILED.package.to_json()
SKILL = skill_source().text
POLICY = deployment_policy().model_dump(mode="json")

VARIANTS = [
    {"profile": "production", "skill": False, "policy": False},
    {"profile": "production", "skill": True, "policy": True},
    {"profile": "production", "skill": True, "policy": False},
    {"profile": "production", "skill": False, "policy": True},
    {"profile": "sandbox", "skill": True, "policy": True},
]


# ---------------------------------------------------------------------------------------------- #
def _walk(d, path):
    for k in path:
        d = d[k]
    return d


def apply_ops(d, ops):
    for op in ops:
        kind = op[0]
        if kind == "set":
            _walk(d, op[1][:-1])[op[1][-1]] = copy.deepcopy(op[2])
        elif kind == "del":
            parent = _walk(d, op[1][:-1])
            if isinstance(parent, list):
                parent.pop(op[1][-1])
            else:
                del parent[op[1][-1]]
        elif kind == "ins":
            _walk(d, op[1][:-1]).insert(op[1][-1], copy.deepcopy(op[2]))
        elif kind == "app":
            _walk(d, op[1]).append(copy.deepcopy(op[2]))
        elif kind == "appcopy":
            _walk(d, op[2]).append(copy.deepcopy(_walk(d, op[1])))
        elif kind == "setcopy":
            _walk(d, op[2][:-1])[op[2][-1]] = copy.deepcopy(_walk(d, op[1]))
        elif kind == "perm":
            old = _walk(d, op[1])
            _walk(d, op[1][:-1])[op[1][-1]] = [old[i] for i in op[2]]
        elif kind == "order":
            old = _walk(d, op[1])
            _walk(d, op[1][:-1])[op[1][-1]] = {k: old[k] for k in op[2]}
        elif kind == "chain":  # ["chain", from_state, n, to_state]: from_state's first edge -> C0 -> ... -> C{n-1} -> to_state
            states = d["machine"]["states"]
            states[op[1]]["transitions"][0]["to"] = "C0"
            for i in range(op[2]):
                states[f"C{i}"] = {"id": f"C{i}", "action": {"kind": "model", "prompt": "p", "reads": [], "writes": []},
                                   "transitions": [{"if": "", "to": f"C{i + 1}" if i + 1 < op[2] else op[3]}]}
        elif kind == "strrep":
            _walk(d, op[1][:-1])[op[1][-1]] = _walk(d, op[1]).replace(op[2], op[3])
        else:
            raise ValueError(kind)
    return d


def exc_name(exc):
    return type(exc).__name__


def build(ops, mode):
    d = apply_ops(copy.deepcopy(BASE), ops)
    try:
        if mode == "reseal":
            d["artifact_hash"] = ""
            return MachinePackage.from_json(d).sealed(), None
        return MachinePackage.from_json(d), None
    except Exception as exc:  # noqa: BLE001
        return None, exc_name(exc)


def run_variant(pkg, v, skill_text, dp, catalog=CATALOG):
    try:
        rep = validate_package(pkg, catalog, v["profile"], skill_text=skill_text if v["skill"] else None,
                               deployment_policy=dp if v["policy"] else None)
    except Exception as exc:  # noqa: BLE001
        return {"exc": exc_name(exc)}
    rj = rep.to_json()
    body = {"findings": rj["findings"], "analyses": rj["analyses"]}
    conv = ints(body)
    out = {"findings": conv["findings"], "analyses": conv["analyses"], "passed": rj["passed"],
           "digest": rj["report_digest"], "codes": sorted(rep.codes())}
    if json.dumps(conv, sort_keys=True) != json.dumps(body, sort_keys=True):
        out["float_ints"] = True  # integral floats converted for transport: digest not comparable
    return out


def case(name, ops, mode="reseal", variants=(0, 1, 2, 3, 4), skill_edits=(), policy_ops=(), diff=False, catalog_ops=()):
    pkg, err = build(ops, mode)
    rec = {"name": name, "ops": ops, "mode": mode, "variants": list(variants)}
    catalog = CATALOG
    if catalog_ops:
        rec["catalog_ops"] = list(catalog_ops)
        catalog = ToolCatalog.model_validate(apply_ops(CATALOG.model_dump(mode="json"), list(catalog_ops)))
    if skill_edits:
        rec["skill_edits"] = [list(e) for e in skill_edits]
    if policy_ops:
        rec["policy_ops"] = list(policy_ops)
    if err:
        rec["load_error"] = err
        return rec
    rec["hash"] = pkg.artifact_hash
    text = SKILL
    for a, b in skill_edits:
        text = text.replace(a, b)
    dpd = apply_ops(copy.deepcopy(POLICY), list(policy_ops))
    try:
        dp = DeploymentPolicy.model_validate(dpd)
    except Exception as exc:  # noqa: BLE001
        rec["policy_error"] = exc_name(exc)
        return rec
    rec["runs"] = [run_variant(pkg, VARIANTS[i], text, dp, catalog) for i in variants]
    if diff:
        try:
            rec["diff"] = package_diff(MachinePackage.from_json(BASE), pkg, CATALOG)
        except Exception as exc:  # noqa: BLE001
            rec["diff"] = {"exc": exc_name(exc)}
        try:
            rec["diff_rev"] = package_diff(pkg, MachinePackage.from_json(BASE), None)
        except Exception as exc:  # noqa: BLE001
            rec["diff_rev"] = {"exc": exc_name(exc)}
    return rec


S = ["machine", "states"]


def st(sid, *rest):
    return S + [sid, *rest]


# ---------------------------------------------------------------------------------------------- #
# conformance mutations (tests/conformance/test_static_admission.py, test_review_admission_validator.py)
def conformance():
    out = [case("base", [])]
    # A02
    out += [
        case("A02-unknown-target", [["set", st("LOOKUP_SUPPLIER", "transitions", 1, "to"), "NOPE"]]),
        case("A02-unknown-tool", [["set", st("READ_INTAKE", "action", "name"), "shell.exec"]]),
        case("A02-unknown-variable", [["app", st("EXTRACT_DRAFT", "action", "reads"), "ghost"]]),
        case("A02-unknown-terminal", [["set", st("END_UNVERIFIED", "action", "terminal"), "END_MYSTERY"]]),
        case("A02-duplicate-variable", [["appcopy", ["machine", "variables", 0], ["machine", "variables"]]]),
        case("A02-unknown-initial", [["set", ["machine", "initial"], "NOWHERE"]]),
    ]
    marker = "/tmp/hexis-golden/pwned"
    for i, g in enumerate(["__import__('os').system('touch {marker}') == 0", "draft.__class__ == 'x'",
                           "open('{marker}', 'w') == 1", "[x for x in validation_issues] == []", "lambda: 1",
                           "not " * 20 + "(validation_status == 'pass')"]):
        out.append(case(f"A03-malicious-guard-{i}", [["set", st("VALIDATE_DRAFT", "transitions", 0, "if"),
                                                      g.format(marker=marker)]]))
    out.append(case("A04-definite-assignment", [["ins", st("READ_INTAKE", "transitions", 1),
                                                 {"if": "docs_status == 'missing'", "to": "EXTRACT_DRAFT"}]]))
    out.append(case("A08-overlap", [["set", st("VALIDATE_DRAFT", "transitions", 1, "if"),
                                     "validation_status in ['pass', 'repairable'] and repair_count < 2"]]))
    out.append(case("A08-unknown", [["set", st("VALIDATE_DRAFT", "transitions", 1, "if"),
                                     "validation_status == 'repairable' and repair_count < readback_count"]]))
    out.append(case("A11-cycle", [["set", st("VERIFY_PERSISTED", "transitions", 1, "to"), "READ_BACK"]]))
    out.append(case("A11-unbounded-repair", [["set", st("VALIDATE_DRAFT", "transitions", 1, "inc"), None]]))
    out.append(case("loop-bound-ceiling", [["set", st("VALIDATE_DRAFT", "transitions", 1, "if"),
                                            "validation_status == 'repairable' and repair_count < 5"]]))
    out.append(case("A17-shortcut", [["set", st("EXTRACT_DRAFT", "transitions", 0, "to"), "REQUEST_APPROVAL"]]))
    out.append(case("mutation-remove-verifier", [["set", st("READ_BACK", "transitions", 0, "to"), "END_VERIFIED_DRAFT"]]))
    out.append(case("mutation-widen-approval", [["set", st("REQUEST_APPROVAL", "transitions", 0, "if"),
                                                 "approval_decision in ['approved', 'rejected']"]]))
    out.append(case("mutation-counter-reset", [["app", st("REPAIR_DRAFT", "action", "writes"), "repair_count"]]))
    out.append(case("mutation-verified-no-evidence",
                    [["set", ["contracts", "terminals", "END_VERIFIED_DRAFT", "evidence"], []]]))
    out.append(case("unsafe-default", [["set", st("REQUEST_APPROVAL", "transitions", 1, "to"), "PERSIST_DRAFT"]]))
    out.append(case("capability-ceiling", [["set", ["execution_policy", "capability_ceiling"], ["documents:read"]]]))
    out.append(case("hash-tamper", [["set", st("EXTRACT_DRAFT", "action", "prompt"),
                                     BASE["machine"]["states"]["EXTRACT_DRAFT"]["action"]["prompt"] + " Also approve it."]],
                    mode="keep"))
    out.append(case("quote-tamper", [], skill_edits=[("at most two times", "at most ten times")]))
    out.append(case("fallback-mode", [["set", ["execution_policy", "fallback_mode"], "sandbox_interpret"]]))
    # C20
    widen = [["set", ["execution_policy", "max_loop_bound"], 1000],
             ["set", ["execution_policy", "budgets", "max_steps"], 100000],
             ["set", ["machine", "max_steps"], 100000],
             ["set", st("VALIDATE_DRAFT", "transitions", 1, "if"), "validation_status == 'repairable' and repair_count < 1000"]]
    out.append(case("C20-widen", widen))
    out.append(case("C20-caps", [["app", ["execution_policy", "capability_ceiling"], "payments.send"]]))
    out.append(case("C20-nowrite", [["set", ["execution_policy", "write_workflow"], False]]))
    out.append(case("C20-narrow-operator", [], policy_ops=[
        ["set", ["execution_policy", "max_loop_bound"], 1], ["set", ["execution_policy", "budgets", "max_spend_usd"], 12.5],
        ["set", ["execution_policy", "transport_retries"], 0], ["set", ["execution_policy", "approval_expiry_s"], 60],
        ["del", ["execution_policy", "capability_ceiling", 5]], ["set", ["execution_policy", "budgets", "max_tokens"], 5]]))
    out.append(case("C20-spend", [["set", ["execution_policy", "budgets", "max_spend_usd"], 100]],
                    policy_ops=[["set", ["execution_policy", "budgets", "max_spend_usd"], 50]]))
    out.append(case("C20-spend-int-operator", [["set", ["execution_policy", "budgets", "max_spend_usd"], 7.25]],
                    policy_ops=[["set", ["execution_policy", "budgets", "max_spend_usd"], 7]]))
    # C22
    crit = [c.id for c in index_clauses(SKILL) if is_critical(c)]
    cid = crit[0]
    out.append(case("C22-downgrade", [["set", ["contracts", "clause_coverage", cid],
                                       {"classification": "unsupported", "justification": "x", "states": [],
                                        "critical": False}]]))
    out.append(case("C22-missing", [["del", ["contracts", "clause_coverage", cid]]]))
    for c2 in crit:
        ops = []
        idx = [i for i, c in enumerate(BASE["source_manifest"]["clauses"]) if c["id"] == c2][0]
        ops.append(["del", ["source_manifest", "clauses", idx]])
        ops.append(["del", ["contracts", "clause_coverage", c2]])
        for sid, s in BASE["machine"]["states"].items():
            if s.get("clause") == c2:
                ops.append(["set", st(sid, "clause"), ""])
        for i, o in enumerate(BASE["contracts"]["ordering"]):
            if o.get("clause") == c2:
                ops.append(["set", ["contracts", "ordering", i, "clause"], ""])
        out.append(case(f"C22-drop-from-manifest-{c2}", ops))
    # C23
    out.append(case("C23-fallback-subgraph", [
        ["set", ["execution_policy", "write_workflow"], False],
        ["set", ["execution_policy", "fallback_mode"], "sandbox_interpret"],
        ["setcopy", st("PERSIST_DRAFT"), st("FB_WRITE")],
        ["set", st("FB_WRITE", "id"), "FB_WRITE"],
        ["set", st("FB_WRITE", "transitions"), [{"if": "", "to": "FB_LOOP"}]],
        ["set", st("FB_LOOP"), {"id": "FB_LOOP", "action": {"kind": "model", "prompt": "again",
                                                             "reads": ["approval_decision"], "writes": ["draft"]},
                                "transitions": [{"if": "", "to": "FB_WRITE"}]}],
        ["set", ["machine", "fallback"], "FB_WRITE"],
        ["set", ["contracts", "explained_unreachable", "FB_LOOP"], "reserved"]]))
    # C24
    rc = [i for i, v in enumerate(BASE["machine"]["variables"]) if v["name"] == "repair_count"][0]
    for bad in (-1000, 1.5, "0", True, None, 1, [0], {"a": 0}, "x'y\"z\u0000é\U0001f600"):
        out.append(case(f"C24-counter-init-{json.dumps(bad)}", [["set", ["machine", "variables", rc, "init"], bad]]))
    # C26
    out.append(case("C26-unsealed", [["set", ["artifact_hash"], ""]], mode="keep"))
    # C27
    u2 = [["strrep", ["contracts", "ordering", i, "before"], "tool:", "tool: "]
          for i in range(len(BASE["contracts"]["ordering"]))]
    out.append(case("C27-space-selector", u2))
    out.append(case("C27-unknown-kind", [["set", ["contracts", "ordering", 0, "requires"], ["phase:validate"]]]))
    # X02
    out.append(case("X02-disjunctive", [["set", st("REQUEST_APPROVAL", "transitions", 0, "if"),
                                         "approval_decision == 'approved' or repair_count >= 1"]]))
    out.append(case("X02-bypass", [
        ["set", st("NOOP"), {"id": "NOOP", "action": {"kind": "model", "prompt": "noop", "reads": [], "writes": []},
                             "transitions": [{"if": "", "to": "PERSIST_DRAFT"}]}],
        ["set", st("REQUEST_APPROVAL", "transitions", -1, "to"), "NOOP"]]))
    # codes the random corpus rarely reaches
    out.append(case("end-with-edges", [["app", st("END_UNVERIFIED", "transitions"), {"if": "", "to": "FALLBACK"}]]))
    out.append(case("unknown-fallback", [["set", ["machine", "fallback"], "NOPE"]]))
    out.append(case("fallback-not-end", [["set", ["machine", "fallback"], "READ_BACK"]]))
    out.append(case("fallback-terminal-category", [["set", ["contracts", "terminals", "END_REVIEW", "category"], "unverified"]]))
    out.append(case("catalog-mismatch", [], catalog_ops=[["set", ["tools", "documents.read", "description"], "changed"]]))
    out.append(case("catalog-schema", [], catalog_ops=[["set", ["tools", "erp.read_draft", "input_schema", "type"], 5]]))
    out.append(case("catalog-missing-tools", [], catalog_ops=[["del", ["tools", "draft.verify_persisted"]],
                                                               ["del", ["tools", "erp.create_draft"]]]))
    out.append(case("catalog-effect-write", [], catalog_ops=[["set", ["tools", "documents.read", "effect"], "idempotent_write"]]))
    out.append(case("catalog-required-odd", [], catalog_ops=[["set", ["tools", "erp.read_draft", "input_schema", "required"],
                                                              ["draft_id", "zzz"]]]))
    out.append(case("tool-input-template-types", [["set", st("READ_BACK", "action", "input", "draft_id"),
                                                   "id-${erp_draft_id}-${draft}-${repair_count}-${ghost}"]]))
    out.append(case("judge-labels", [["set", st("EXTRACT_DRAFT", "action"), {
        "kind": "judge", "prompt": "q", "reads": ["documents"], "writes": ["validation_status"],
        "labels": ["pass", "fail", "abstain"]}]]))
    out.append(case("judge-labels-equal", [["set", st("EXTRACT_DRAFT", "action"), {
        "kind": "judge", "prompt": "q", "reads": ["documents"], "writes": ["validation_status"],
        "labels": ["repairable", "pass", "fail", "pass"], "abstain": "fail"}]]))
    for i, enum in enumerate(ENUMS + [[{"a": 1}], "approved"]):
        out.append(case(f"approval-enum-{i}", [["set", ["contracts", "variables", "approval_decision", "schema", "enum"], enum]],
                        variants=(0, 1)))
        out.append(case(f"judge-enum-{i}", [["set", st("EXTRACT_DRAFT", "action"), {
            "kind": "judge", "prompt": "q", "reads": ["documents"], "writes": ["validation_status"],
            "labels": ["approved", "rejected", "abstain"]}],
            ["set", ["contracts", "variables", "validation_status", "schema", "enum"], enum]], variants=(0,)))
    out.append(case("approval-guard-undeclared", [["set", st("REQUEST_APPROVAL", "transitions", 0, "if"),
                                                   "approval_decision == 'approved' and ghost == 1"]]))
    out.append(case("loop-edge-invalid-guard", [["set", st("READ_BACK", "transitions", 1, "if"), "readback_count < "]]))
    out.append(case("task-required-odd", [["set", ["contracts", "task_input_schema", "required"], "supplier_ref"]]))
    out.append(case("skill-extra-clauses", [], skill_edits=[("## Intake", "## Intake\n\nNew clause **MUST** hold.\n\nAnother one."),
                                                           ("at most two times", "at most two times ")]))
    # recursion depth of the SCC search (Python: RecursionError near 996 nested calls; JS: fixed limit 900)
    out.append(case("chain-500", [["chain", "EXTRACT_DRAFT", 500, "VALIDATE_DRAFT"]], variants=(0,)))
    dev = case("chain-950", [["chain", "EXTRACT_DRAFT", 950, "VALIDATE_DRAFT"]], variants=(0,))
    dev["js_deviation"] = "RecursionError"
    out.append(dev)
    out.append(case("chain-1100", [["chain", "EXTRACT_DRAFT", 1100, "VALIDATE_DRAFT"]], variants=(0,)))
    out.append(case("states-reordered", [["order", S, list(reversed(list(BASE["machine"]["states"])))]]))
    return out


# ---------------------------------------------------------------------------------------------- #
# helper-function vectors
GUARD_POOL = [
    "docs_status == 'available'", "docs_status == 'missing'", "validation_status == 'pass'",
    "validation_status in ['pass', 'repairable']", "validation_status == 'repairable' and repair_count < 2",
    "repair_count < 5", "repair_count <= 1", "readback_count < 2 and readback_status == 'unavailable'",
    "approval_decision == 'approved'", "approval_decision != 'rejected'",
    "approval_decision == 'approved' or repair_count >= 1", "not (approval_decision == 'rejected')",
    "nonempty(documents)", "empty(missing_document_ids)", "lookup_status in ['new', 'exists_compatible']",
    "persist_status in ['created', 'existing']", "verify_status == 'match'", "repair_count < readback_count",
    "ghost == 1", "x.y == 1", "__import__('os')", "validation_status == 1", "repair_count < 2.5",
    "repair_count < True", "erp_version > 3", "persisted_version >= 0 and persisted_version < 10",
    "approval_decision == 'approved' and repair_count < 2", "True", "draft_digest == 'x' and not empty(draft)",
    "readback_status == 'found' or readback_status == 'unavailable'", "repair_count < -1", "repair_count <= 0",
    "'approved' == approval_decision", "approval_decision == 'approved' and approval_decision == 'approved'",
    "repair_count < 2 and repair_count <= 7", "repair_count < 2.0", "repair_count < 1e1", "2 > repair_count",
    "repair_count < 'a'", "approval_decision in ['approved']", "approval_decision", "not approval_decision",
    "approval_decision == 'Approved'", "approval_decision == \"approved\" and draft_digest != ''",
    "readback_count <= 3 and readback_count < 9", "repair_count<2", "(repair_count < 2)",
    "repair_count < 2 < 3", "validation_status == 'pass' and validation_status == 'fail'",
]
COUNTERS = ["repair_count", "readback_count", "approval_decision", "ghost", ""]


def helpers():
    pkg = MachinePackage.from_json(BASE)
    eb = []
    for g in GUARD_POOL + ["", "repair_count < ", "validation_status =="]:
        for c in COUNTERS:
            try:
                eb.append([g, c, edge_bound(g, c)])
            except G.GuardError:
                eb.append([g, c, {"exc": "GuardError"}])
    ra = []
    for g in GUARD_POOL + ["", "approval_decision =="]:
        ra.append([g, Vmod._requires_approved(g, "approval_decision")])
    tv_inputs = ["${a}", "x ${a} ${b_1} ${1x} ${ a } $${c}", {"k": ["${d}", {"z": "${e}${e}"}], "n": 3},
                 ["${f}", None, True, 1.5], "${Ünï}", "${_}", "${a", "$ {a}", "${a}${b}", {"${k}": "v"}]
    tv = [[x, sorted(template_vars(x))] for x in tv_inputs]
    sels = ["tool:draft.validate", "tool: draft.validate", "tool:shell.exec", "state:READ_INTAKE", "state:NOPE",
            "state:", "terminal:END_VERIFIED_DRAFT", "terminal:END_X", "user:approval", "user:input", "phase:x",
            "nocolon", "", ":x", "tool:draft.validate ", "tool: x", "state:READ_INTAKE:extra",
            "terminal:END_REVIEW", "user:approval\n", "STATE:READ_INTAKE"]
    sp = [[s, selector_problem(s, pkg, CATALOG)] for s in sels]
    rng = random.Random(7)
    pw = []
    fields = ["max_loop_bound", "structured_output_repairs", "transport_retries", "approval_expiry_s"]
    bfields = ["max_steps", "max_tool_calls", "max_model_calls", "max_tokens", "max_elapsed_s"]
    caps = ["a", "b", "c", "d:x", "é"]
    for _ in range(150):
        def pol():
            d = {"capability_ceiling": rng.sample(caps, rng.randint(0, len(caps))),
                 "fallback_mode": rng.choice(["stop_for_review", "sandbox_interpret"]),
                 "write_workflow": rng.random() < 0.5, "budgets": {}}
            for f in fields:
                if rng.random() < 0.5:
                    d[f] = rng.randint(0, 5)
            for f in bfields:
                if rng.random() < 0.5:
                    d["budgets"][f] = rng.randint(0, 5)
            if rng.random() < 0.6:
                d["budgets"]["max_spend_usd"] = rng.choice([None, 0, 1, 2.5, 10, 0.1, 1e-7, 123456.789])
            return d
        a, b = pol(), pol()
        pw.append([a, b, policy_widening_findings(ExecutionPolicy.model_validate(a), ExecutionPolicy.model_validate(b))])
    m = pkg.machine
    derived = [o.model_dump() for o in derived_ordering(pkg)]
    succ = successors(m)
    reach = {s: sorted(reachable(m, s)) for s in list(m.states) + ["NOPE"]}
    co = []
    for o in list(pkg.contracts.ordering) + derived_ordering(pkg):
        co.append([o.model_dump(), check_ordering(pkg, o), check_ordering(pkg, o, ["READ_INTAKE", "LOOKUP_SUPPLIER"])])
    extra = [OrderingRequirement(id="x1", requires=["state:REPAIR_DRAFT"], before="state:VALIDATE_DRAFT"),
             OrderingRequirement(id="x2", requires=["terminal:END_UNVERIFIED"], before="tool:erp.read_draft",
                                 invalidated_by=["draft"]),
             OrderingRequirement(id="x3", requires=["user:approval"], before="terminal:END_REVIEW"),
             OrderingRequirement(id="x4", requires=[], before="state:FALLBACK")]
    for o in extra:
        co.append([o.model_dump(), check_ordering(pkg, o), check_ordering(pkg, o, list(m.states)[::2])])
    return {"edge_bound": eb, "requires_approved": ra, "template_vars": tv, "selector_problem": sp,
            "policy_widening": ints(pw), "derived_ordering": derived, "successors": succ, "reachable": reach,
            "check_ordering": co}


# ---------------------------------------------------------------------------------------------- #
# random mutations
OWNERS = ["model", "tool", "user", "engine", "task"]
SELECTORS = ["tool:draft.validate", "tool: draft.validate", "tool:erp.create_draft", "tool:erp.read_draft",
             "tool:shell.exec", "state:READ_INTAKE", "state:VALIDATE_DRAFT", "state:NOPE", "state:", "phase:x",
             "terminal:END_VERIFIED_DRAFT", "terminal:END_UNVERIFIED", "terminal:END_X", "user:approval",
             "user:input", "state:REPAIR_DRAFT", "tool:draft.verify_persisted", "tool:documents.read"]
APPROVAL_GUARDS = ["approval_decision == 'approved'", "approval_decision in ['approved', 'rejected']",
                   "approval_decision != 'rejected'", "approval_decision == 'approved' or repair_count >= 1",
                   "approval_decision == 'approved' and repair_count < 2", "not (approval_decision == 'rejected')",
                   "approval_decision == 'approved' and approval_decision != 'x'", "'approved' == approval_decision",
                   "approval_decision in ['approved']", "", "approval_decision == 1", "ghost == 'approved'",
                   "approval_decision == 'approved' and ghost == 1", "x.y == 1", "approval_decision",
                   "approval_decision == 'Approved'"]
ENUMS = [["approved", "rejected"], ["approved"], [], ["approved", "rejected", "later"], "ab", ["approved", 1],
         ["approved", None, True], ["rejected"], {"approved": 1, "no": 2}, [["x"]], 5, None]


class Gen:
    def __init__(self, rng):
        self.rng = rng

    def pick(self, xs):
        return self.rng.choice(list(xs))

    def mutation(self, d):
        r = self.rng
        m, c = d["machine"], d["contracts"]
        sids = list(m["states"])
        nonend = [s for s in sids if m["states"][s]["action"]["kind"] != "end"]
        with_edges = [s for s in sids if m["states"][s]["transitions"]]
        vars_ = [v["name"] for v in m["variables"]]
        kind = r.choice(["retarget", "add_edge", "remove_edge", "reorder_edges", "guard", "guard", "reads", "writes",
                         "owner", "delete_state", "terminal", "evidence", "ordering", "ordering", "interaction",
                         "approval_guard", "approval_guard", "policy", "policy", "clause", "coverage", "hash",
                         "variable", "initial", "tool", "explained", "max_steps", "inc", "state_clause", "judge",
                         "user_state", "add_state", "state_order", "state_id", "approval_enum"])
        target_states = sids + ["NOPE"]
        if kind == "retarget" and with_edges:
            s = self.pick(with_edges)
            i = r.randrange(len(m["states"][s]["transitions"]))
            return [["set", st(s, "transitions", i, "to"), self.pick(target_states)]]
        if kind == "add_edge" and nonend:
            s = self.pick(nonend)
            n = len(m["states"][s]["transitions"])
            e = {"if": self.pick(GUARD_POOL + [""]), "to": self.pick(target_states)}
            if r.random() < 0.3:
                e["inc"] = self.pick(["repair_count", "readback_count", "docs_status", "ghost", "erp_version"])
            return [["ins", st(s, "transitions", r.randint(0, n)), e]]
        if kind == "remove_edge" and with_edges:
            s = self.pick(with_edges)
            return [["del", st(s, "transitions", r.randrange(len(m["states"][s]["transitions"])))]]
        if kind == "reorder_edges" and with_edges:
            s = self.pick(with_edges)
            idx = list(range(len(m["states"][s]["transitions"])))
            r.shuffle(idx)
            return [["perm", st(s, "transitions"), idx]]
        if kind == "guard" and with_edges:
            s = self.pick(with_edges)
            i = r.randrange(len(m["states"][s]["transitions"]))
            return [["set", st(s, "transitions", i, "if"), self.pick(GUARD_POOL + ["", "validation_status =="])]]
        if kind in ("reads", "writes"):
            cands = [s for s in sids if kind in m["states"][s]["action"]]
            if cands:
                s = self.pick(cands)
                lst = m["states"][s]["action"][kind]
                a = m["states"][s]["action"]
                if lst and r.random() < 0.5 and not (a["kind"] == "judge"):
                    return [["del", st(s, "action", kind, r.randrange(len(lst)))]]
                return [["app", st(s, "action", kind), self.pick(vars_ + ["ghost", "repair_count", "approval_decision"])]]
        if kind == "owner":
            v = self.pick(list(c["variables"]))
            return [["set", ["contracts", "variables", v, "owner"], self.pick(OWNERS)]]
        if kind == "delete_state" and len(sids) > 2:
            return [["del", st(self.pick(sids))]]
        if kind == "terminal":
            k = r.randrange(6)
            if k == 0 and m["terminals"]:
                i = r.randrange(len(m["terminals"]))
                return [["set", ["machine", "terminals", i, "kind"], self.pick(["", "verified", "unverified", "fallback", "odd"])]]
            if k == 1 and m["terminals"]:
                i = r.randrange(len(m["terminals"]))
                return [["app", ["machine", "terminals", i, "output"], self.pick(vars_ + ["ghost"])]]
            if k == 2 and c["terminals"]:
                t = self.pick(list(c["terminals"]))
                return [["set", ["contracts", "terminals", t, "category"], self.pick(["verified", "unverified", "fallback"])]]
            if k == 3 and c["terminals"]:
                return [["del", ["contracts", "terminals", self.pick(list(c["terminals"]))]]]
            if k == 4:
                return [["app", ["machine", "terminals"], {"id": self.pick(["END_X", "END_REVIEW"]), "kind": "", "output": []}]]
            return [["set", ["contracts", "terminals", "END_Y"], {"category": self.pick(["verified", "fallback"]), "evidence": []}]]
        if kind == "evidence" and "END_VERIFIED_DRAFT" in c["terminals"]:
            ev = c["terminals"]["END_VERIFIED_DRAFT"]["evidence"]
            base = ["contracts", "terminals", "END_VERIFIED_DRAFT", "evidence"]
            k = r.randrange(5)
            if k == 0 or not ev:
                return [["set", base, [] if ev else [{"claim": "persisted_draft_matches_approved_payload",
                                                      "verifier_tool": "draft.verify_persisted",
                                                      "subject_vars": ["draft_digest"]}]]]
            if k == 1:
                return [["set", base + [0, "verifier_tool"], self.pick(["draft.validate", "shell.exec", "erp.read_draft"])]]
            if k == 2:
                return [["set", base + [0, "claim"], self.pick(["draft_satisfies_onboarding_policy", "made_up"])]]
            if k == 3:
                return [["app", base + [0, "subject_vars"], self.pick(vars_ + ["ghost"])]]
            if ev[0]["subject_vars"]:
                return [["del", base + [0, "subject_vars", r.randrange(len(ev[0]["subject_vars"]))]]]
        if kind == "ordering":
            o = c["ordering"]
            k = r.randrange(7)
            if o and k == 0:
                return [["set", ["contracts", "ordering", r.randrange(len(o)), "before"], self.pick(SELECTORS)]]
            if o and k == 1:
                return [["set", ["contracts", "ordering", r.randrange(len(o)), "requires"],
                         r.sample(SELECTORS, r.randint(0, 2))]]
            if o and k == 2:
                return [["app", ["contracts", "ordering", r.randrange(len(o)), "invalidated_by"], self.pick(vars_)]]
            if o and k == 3:
                i = r.randrange(len(o))
                if o[i]["invalidated_by"]:
                    return [["set", ["contracts", "ordering", i, "invalidated_by"], []]]
            if o and k == 4:
                return [["del", ["contracts", "ordering", r.randrange(len(o))]]]
            if o and k == 5:
                return [["set", ["contracts", "ordering", r.randrange(len(o)), "clause"], self.pick(["", "S9.9", "S1.1"])]]
            return [["app", ["contracts", "ordering"], {"id": f"ORD-R{r.randrange(100)}", "requires": r.sample(SELECTORS, r.randint(0, 2)),
                                                        "before": self.pick(SELECTORS),
                                                        "invalidated_by": r.sample(vars_, r.randint(0, 2)),
                                                        "clause": self.pick(["", "S3.1"])}]]
        if kind == "interaction":
            if c["interactions"]:
                s = self.pick(list(c["interactions"]))
                k = r.randrange(4)
                if k == 0:
                    return [["set", ["contracts", "interactions", s, "type"], self.pick(["input", "approval"])]]
                if k == 1:
                    return [["set", ["contracts", "interactions", s, "approves_state"], self.pick(target_states + [""])]]
                if k == 2:
                    return [["del", ["contracts", "interactions", s]]]
                return [["set", ["contracts", "interactions", s, "required_role"], "procurement_approver"]]
            return [["set", ["contracts", "interactions", "REQUEST_APPROVAL"],
                     {"type": "approval", "approves_state": "PERSIST_DRAFT"}]]
        if kind == "approval_guard" and "REQUEST_APPROVAL" in m["states"] and m["states"]["REQUEST_APPROVAL"]["transitions"]:
            n = len(m["states"]["REQUEST_APPROVAL"]["transitions"])
            return [["set", st("REQUEST_APPROVAL", "transitions", r.randrange(n), "if"), self.pick(APPROVAL_GUARDS)]]
        if kind == "approval_enum" and "approval_decision" in c["variables"]:
            return [["set", ["contracts", "variables", "approval_decision", "schema", "enum"], self.pick(ENUMS)]]
        if kind == "policy":
            ep = ["execution_policy"]
            k = r.randrange(8)
            if k == 0:
                return [["app", ep + ["capability_ceiling"], self.pick(["payments.send", "documents:read"])]]
            if k == 1 and d["execution_policy"]["capability_ceiling"]:
                return [["del", ep + ["capability_ceiling", r.randrange(len(d["execution_policy"]["capability_ceiling"]))]]]
            if k == 2:
                return [["set", ep + ["fallback_mode"], self.pick(["stop_for_review", "sandbox_interpret"])]]
            if k == 3:
                return [["set", ep + ["write_workflow"], r.random() < 0.3]]
            if k == 4:
                return [["set", ep + [self.pick(["max_loop_bound", "structured_output_repairs", "transport_retries",
                                                  "approval_expiry_s"])], r.choice([0, 1, 2, 3, 5, 1000, 100000])]]
            if k == 5:
                return [["set", ep + ["budgets", self.pick(["max_steps", "max_tool_calls", "max_model_calls", "max_tokens",
                                                            "max_elapsed_s"])], r.choice([0, 10, 40, 64, 100000, 10 ** 7])]]
            if k == 6:
                return [["set", ep + ["budgets", "max_spend_usd"], r.choice([None, 0, 5, 12.5, 1000000, 0.25])]]
            return [["set", ep + ["max_loop_bound"], r.choice([1, 2, 3, 4, 10])]]
        if kind == "clause":
            cl = d["source_manifest"]["clauses"]
            if cl:
                i = r.randrange(len(cl))
                k = r.randrange(6)
                base = ["source_manifest", "clauses", i]
                if k == 0:
                    return [["set", base + ["text"], cl[i]["text"] + " edited"]]
                if k == 1:
                    return [["set", base + ["start"], cl[i]["start"] + r.choice([-1, 1, -100000, 5])]]
                if k == 2:
                    return [["set", base + ["end"], r.choice([cl[i]["end"] + 1, -1, 10 ** 6, 0])]]
                if k == 3:
                    return [["del", base]]
                if k == 4:
                    return [["set", base + ["sha256"], "0" * 64]]
                return [["set", base + ["text"], cl[i]["text"] + " **MUST**"]]
        if kind == "coverage":
            cc = c["clause_coverage"]
            k = r.randrange(5)
            if cc and k == 0:
                return [["set", ["contracts", "clause_coverage", self.pick(list(cc)), "classification"],
                         self.pick(["executable_control", "state_local_knowledge", "external_precondition", "unsupported",
                                    "non_material"])]]
            if cc and k == 1:
                key = self.pick(list(cc))
                return [["set", ["contracts", "clause_coverage", key, "critical"], not cc[key]["critical"]]]
            if cc and k == 2:
                return [["set", ["contracts", "clause_coverage", self.pick(list(cc)), "states"],
                         r.sample(target_states, r.randint(0, 2))]]
            if cc and k == 3:
                return [["del", ["contracts", "clause_coverage", self.pick(list(cc))]]]
            return [["set", ["contracts", "clause_coverage", "S9.9"], {"classification": "unsupported", "justification": "j",
                                                                       "critical": r.random() < 0.5}]]
        if kind == "hash":
            return "HASH"
        if kind == "variable":
            k = r.randrange(6)
            i = r.randrange(len(m["variables"])) if m["variables"] else None
            if i is None:
                return None
            if k == 0:
                return [["set", ["machine", "variables", i, "init"], r.choice([0, -1, 1.5, "0", True, None, 3])],
                        ["set", ["machine", "variables", i, "init_from"], None]]
            if k == 1:
                return [["set", ["machine", "variables", i, "init_from"], self.pick(["task.input.supplier_ref", "task.input.extra",
                                                                                     "x"])],
                        ["set", ["machine", "variables", i, "init"], None]]
            if k == 2:
                return [["set", ["machine", "variables", i, "type"], self.pick(["string", "integer", "number", "boolean", "array",
                                                                                "object"])]]
            if k == 3:
                return [["appcopy", ["machine", "variables", i], ["machine", "variables"]]]
            if k == 4:
                return [["del", ["machine", "variables", i]]]
            return [["app", ["machine", "variables"], {"name": self.pick(["fresh", "ghost"]), "type": "integer", "init": 0}]]
        if kind == "initial":
            if r.random() < 0.5:
                return [["set", ["machine", "initial"], self.pick(target_states)]]
            return [["set", ["machine", "fallback"], self.pick(target_states)]]
        if kind == "tool":
            tools = [s for s in sids if m["states"][s]["action"]["kind"] == "tool"]
            if tools:
                s = self.pick(tools)
                k = r.randrange(5)
                if k == 0:
                    return [["set", st(s, "action", "name"), self.pick(list(CATALOG.tools) + ["shell.exec"])]]
                if k == 1:
                    return [["set", st(s, "action", "binds", self.pick(["status", "nope", "draft_id"])), self.pick(vars_ + ["ghost"])]]
                if k == 2:
                    return [["set", st(s, "action", "input", self.pick(["extra", "draft"])),
                             self.pick(["${draft}", "pre-${draft}", "${a}${b}", "x ${repair_count}", "${documents} y", 3])]]
                if k == 3 and m["states"][s]["action"]["input"]:
                    return [["del", st(s, "action", "input", self.pick(list(m["states"][s]["action"]["input"])))]]
                return [["set", st(s, "action", "binds"), {}]]
        if kind == "explained":
            return [["set", ["contracts", "explained_unreachable", self.pick(target_states)], "reason"]]
        if kind == "max_steps":
            return [["set", ["machine", "max_steps"], r.choice([1, 24, 40, 41, 1000])]]
        if kind == "inc" and with_edges:
            s = self.pick(with_edges)
            i = r.randrange(len(m["states"][s]["transitions"]))
            return [["set", st(s, "transitions", i, "inc"), self.pick([None, "", "repair_count", "readback_count", "docs_status",
                                                                       "ghost"])]]
        if kind == "state_clause":
            return [["set", st(self.pick(sids), "clause"), self.pick(["", "S9.9", "S1.1", "S3.1"])]]
        if kind == "judge" and "EXTRACT_DRAFT" in m["states"]:
            return [["set", st("EXTRACT_DRAFT", "action"), {
                "kind": "judge", "prompt": "q", "reads": ["documents"], "writes": [self.pick(["validation_status", "repair_count",
                                                                                             "approval_decision", "ghost"])],
                "labels": self.pick([["pass", "repairable", "fail", "abstain"], ["pass", "repairable", "fail"],
                                     ["abstain", "pass"]])}]]
        edged = [x for x in nonend if m["states"][x]["transitions"]]
        if kind == "user_state":
            ops = [["set", st("ASK"), {"id": "ASK", "action": {"kind": "user", "prompt": "more?", "writes": ["document_ids"]},
                                       "transitions": [{"if": "", "to": self.pick(target_states)}]}]]
            if edged:
                ops.append(["set", st(self.pick(edged), "transitions", 0, "to"), "ASK"])
            return ops
        if kind == "add_state" and edged:
            src = self.pick(nonend)
            return [["setcopy", st(src), st("COPY_" + src)], ["set", st("COPY_" + src, "id"), "COPY_" + src],
                    ["set", st(self.pick(edged), "transitions", 0, "to"), "COPY_" + src]]
        if kind == "state_order":
            order = list(sids)
            r.shuffle(order)
            return [["order", S, order]]
        if kind == "state_id":
            return [["set", st(self.pick(sids), "id"), self.pick(sids + ["OTHER"])]]
        return None


def random_cases(n, seed):
    rng = random.Random(seed)
    gen = Gen(rng)
    out = []
    while len(out) < n:
        d = copy.deepcopy(BASE)
        ops = []
        mode = "reseal"
        for _ in range(rng.choice([1, 1, 2, 2, 3])):
            try:
                mops = gen.mutation(d)
            except (IndexError, KeyError):
                mops = None
            if mops == "HASH":
                mode = "keep"
                k = rng.randrange(3)
                if k == 0:
                    mops = [["set", ["artifact_hash"], "sha256:" + "0" * 64]]
                elif k == 1:
                    mops = [["set", ["artifact_hash"], ""]]
                else:
                    mops = []  # stale hash after the other mutations
            if not mops:
                continue
            try:
                apply_ops(d, mops)
            except (IndexError, KeyError, TypeError):
                continue
            ops += mops
        if not ops and mode == "reseal":
            continue
        variants = [0, 1] + ([4] if rng.random() < 0.15 else []) + ([2] if rng.random() < 0.1 else [])
        out.append(case(f"random-{seed}-{len(out)}", ops, mode=mode, variants=variants, diff=True))
    return out


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 460
    conf = conformance()
    write("validate_conformance", {"base_hash": BASE["artifact_hash"], "variants": VARIANTS, "cases": conf,
                                   "helpers": helpers(), "validator_version": Vmod.VALIDATOR_VERSION})
    rnd = random_cases(n, 20261006)
    half = len(rnd) // 2
    write("validate_random_a", {"base_hash": BASE["artifact_hash"], "variants": VARIANTS, "cases": rnd[:half]})
    write("validate_random_b", {"base_hash": BASE["artifact_hash"], "variants": VARIANTS, "cases": rnd[half:]})
    loaded = [c for c in rnd if "runs" in c]
    print(f"conformance: {len(conf)} cases; random: {len(rnd)} cases ({len(loaded)} loadable, "
          f"{sum(1 for c in rnd if 'load_error' in c)} rejected by pydantic)")
