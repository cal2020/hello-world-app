"""Golden vectors for HX.compile (compiler/compile.py): the fixture run (demo/env.py::compile_procurement), scripted
compiler models covering the compile-loop branches, normalize_machine, build_context/prompts_digest and
coverage_markdown.

A scripted model is data: ``steps[attempt-1]`` (the last step repeats) is one of
  {"raw": value}                         draft() returns ``value`` as is
  {"base": "defect"|"clean"|"fixture", "machine_ops": [...], "contracts_ops": [...], "contracts_fn": name}
      machine_dict(defect) / FixtureCompilerModel behaviour, then edit operations (gen_validate.apply_ops), then
      a diagnostics-driven contracts rewrite: "drop_violated" (_Dropper) or "weaken_violated" (_Weakener).
The JS test implements the same script interpreter.
"""

from __future__ import annotations

import copy

from _common import ints, write

from gen_validate import apply_ops

from hexis_service.artifacts.efsm import load_machine
from hexis_service.canonical import digest
from hexis_service.compiler import compile as Cmod
from hexis_service.compiler.clauses import index_clauses
from hexis_service.compiler.compile import (DeploymentPolicy, SkillSource, build_context, compile_skill,
                                            coverage_markdown, normalize_machine, prompts_digest)
from hexis_service.demo.env import compile_procurement, load_catalog, skill_source
from hexis_service.demo.procurement_fixture import (FixtureCompilerModel, contracts_dict, deployment_policy,
                                                    machine_dict)

CATALOG = load_catalog()


class ScriptModel:
    def __init__(self, spec):
        self.spec = spec
        self.model_id = spec.get("model_id", "test:script")
        self.settings = copy.deepcopy(spec.get("settings", {}))
        if "prompt_template_sha256" in spec:
            self.prompt_template_sha256 = spec["prompt_template_sha256"]
        if "prompt_template" in spec:
            self.prompt_template = spec["prompt_template"]
        self.calls = []

    def draft(self, ctx, diags, attempt):
        self.calls.append({"attempt": attempt, "diagnostics": copy.deepcopy(diags)})
        steps = self.spec["steps"]
        step = steps[min(attempt, len(steps)) - 1]
        if "raw" in step:
            return copy.deepcopy(step["raw"])
        base = step.get("base", "defect")
        if base == "fixture":
            out = FixtureCompilerModel().draft(ctx, diags, attempt)
            m, c = out["machine"], out["contracts"]
        else:
            m, c = machine_dict(defect=(base == "defect")), copy.deepcopy(contracts_dict())
        apply_ops(m, step.get("machine_ops", []))
        apply_ops(c, step.get("contracts_ops", []))
        fn = step.get("contracts_fn")
        if fn:
            bad = {d["detail"]["requirement"] for d in diags if d.get("code") == "ORDERING_VIOLATION"}
            if fn == "drop_violated":
                c["ordering"] = [o for o in c["ordering"] if o["id"] not in bad]
            elif fn == "weaken_violated":
                for o in c["ordering"]:
                    if o["id"] in bad:
                        o["requires"] = [o["before"]]
        return {"machine": m, "contracts": c}


def result_json(res):
    rj = res.to_json()
    out = {"result": ints(rj)}
    if res.package is not None:
        out["package"] = ints(res.package.to_json())
    out["has_report"] = res.report is not None
    return out


def run_script(name, spec, source=None, policy_ops=(), max_attempts=3):
    model = ScriptModel(spec)
    src = source or skill_source()
    dpd = apply_ops(deployment_policy().model_dump(mode="json"), list(policy_ops))
    rec = {"name": name, "spec": spec, "max_attempts": max_attempts, "policy_ops": list(policy_ops)}
    if source is not None:
        rec["source"] = source.model_dump(mode="json")
    try:
        res = compile_skill(src, CATALOG, DeploymentPolicy.model_validate(dpd), model, max_attempts=max_attempts)
    except Exception as exc:  # noqa: BLE001
        rec["exc"] = type(exc).__name__
        rec["calls"] = model.calls
        return rec
    rec.update(result_json(res))
    rec["calls"] = ints(model.calls)
    return rec


def D(**kw):
    return dict(kw)


def scripts():
    machine = machine_dict(defect=False)
    contracts = contracts_dict()
    long_msg = ("é😀|" * 900)
    out = [
        run_script("C21-dropper", {"model_id": "test:dropper", "steps": [D(base="defect", contracts_fn="drop_violated")]}),
        run_script("C21-typo-fixer", {"model_id": "test:typo-fixer", "steps": [
            D(base="clean", contracts_ops=[["strrep", ["ordering", 0, "before"], "tool:", "tool: "]]), D(base="clean")]}),
        run_script("C21-weakener", {"model_id": "test:weakener", "steps": [D(base="defect", contracts_fn="weaken_violated")]}),
        run_script("fixture-behaviour-script", {"steps": [D(base="fixture")]}),
        run_script("valid-first", {"steps": [D(base="clean")]}),
        run_script("always-defect", {"steps": [D(base="defect")]}),
        run_script("always-defect-1", {"steps": [D(base="defect")]}, max_attempts=1),
        run_script("zero-attempts", {"steps": [D(base="clean")]}, max_attempts=0),
        run_script("malformed-twice", {"steps": [{"raw": {"malformed": {"code": "DRAFT_REFUSED", "message": "refused"}}}]},
                   max_attempts=2),
        run_script("malformed-variants", {"steps": [
            {"raw": {"malformed": {"code": None, "message": None}}},
            {"raw": {"malformed": {"code": "", "message": 12.5, "detail": {"requirement": "ordering:ORD-X"}}}},
            {"raw": {"malformed": {"code": 7, "message": ["a", 1, None, True], "detail": "not a dict"}}},
            {"raw": {"malformed": {"message": long_msg}}},
            {"raw": {"malformed": {"code": "X", "message": {"k": "v"}, "detail": {}}}},
            D(base="clean")]}, max_attempts=6),
        run_script("raw-shapes", {"steps": [
            {"raw": [1, 2]}, {"raw": "text"}, {"raw": None}, {"raw": 5}, {"raw": True}, {"raw": 2.5},
            {"raw": {"contracts": {}}}, {"raw": {"machine": machine}}, {"raw": {"machine": {"format": "x"}, "contracts": {}}},
            {"raw": {"machine": [1], "contracts": {}}}, {"raw": {"malformed": "not a dict", "machine": None, "contracts": {}}},
            {"raw": {"machine": {}, "contracts": {}}}, {"raw": {"machine": machine, "contracts": {"variables": 3}}},
            {"raw": {"machine": machine, "contracts": None}},
            D(base="clean")]}, max_attempts=15),
        run_script("malformed-then-valid", {"steps": [{"raw": "oops"}, D(base="clean")]}),
        run_script("malformed-defect-fixed", {"steps": [{"raw": {"malformed": {"code": "DRAFT_TRUNCATED", "message": "cut"}}},
                                                        D(base="defect"), D(base="fixture")]}),
        run_script("coverage-regression", {"steps": [D(base="defect"), D(base="clean", contracts_ops=[
            ["set", ["clause_coverage", "S3.1", "classification"], "unsupported"]])]}),
        run_script("coverage-states-dropped", {"steps": [D(base="defect"), D(base="clean", contracts_ops=[
            ["set", ["clause_coverage", "S4.1", "states"], []]])]}),
        run_script("strengthen-accepted", {"steps": [D(base="defect"), D(base="clean", contracts_ops=[
            ["app", ["ordering", 3, "invalidated_by"], "persisted_draft"],
            ["app", ["terminals", "END_VERIFIED_DRAFT", "evidence", 0, "subject_vars"], "erp_version"]])]}),
        run_script("interaction-weakened", {"steps": [
            D(base="defect", contracts_ops=[["set", ["interactions", "REQUEST_APPROVAL", "required_role"], "procurement_approver"]]),
            D(base="clean")]}),
        run_script("evidence-weakened", {"steps": [D(base="defect"), D(base="clean", contracts_ops=[
            ["del", ["terminals", "END_VERIFIED_DRAFT", "evidence", 0, "subject_vars", 0]]])]}),
        run_script("ordering-removed-later", {"steps": [D(base="defect"), D(base="defect"), D(base="clean", contracts_ops=[
            ["del", ["ordering", 3]]])]}),
        run_script("ordering-changed-before", {"steps": [D(base="defect"), D(base="clean", contracts_ops=[
            ["set", ["ordering", 0, "before"], "state:PERSIST_DRAFT"]])]}),
        run_script("ordering-requires-subset", {"steps": [
            D(base="defect", contracts_ops=[["app", ["ordering", 1, "requires"], "state:REQUEST_APPROVAL"]]),
            D(base="clean")]}),
        run_script("unknown-initial-after-draft", {"steps": [D(base="defect"), D(base="clean", machine_ops=[
            ["set", ["initial"], "NOWHERE"]])]}),
        run_script("unknown-initial-first", {"steps": [D(base="clean", machine_ops=[["set", ["initial"], "NOWHERE"]]),
                                                       D(base="clean")]}),
        run_script("malformed-requirement-approval", {"steps": [
            D(base="clean", contracts_ops=[["set", ["interactions", "REQUEST_APPROVAL", "approves_state"], "NOPE"]]),
            D(base="clean")]}),
        run_script("malformed-requirement-evidence", {"steps": [
            D(base="clean", contracts_ops=[["set", ["terminals", "END_VERIFIED_DRAFT", "evidence", 0, "verifier_tool"],
                                            "draft.validate"]]),
            D(base="clean")]}),
        run_script("own-task-schema-overwritten", {"steps": [D(base="clean", contracts_ops=[
            ["set", ["task_input_schema"], {"type": "object", "required": []}]])]}),
        run_script("template-model", {"model_id": "claude-test-model", "settings": {"provider": "anthropic", "effort": "medium"},
                                      "prompt_template": "compile_v1", "prompt_template_sha256": "abc123",
                                      "steps": [D(base="clean")]}),
        run_script("template-model-empty-sha", {"model_id": "m", "prompt_template": "compile_v1", "prompt_template_sha256": "",
                                                "steps": [D(base="clean")]}),
        run_script("sandbox-profile", {"steps": [D(base="clean", contracts_ops=[["del", ["clause_coverage", "S0.1"]]])]},
                   policy_ops=[["set", ["profile"], "sandbox"]]),
        run_script("narrow-operator", {"steps": [D(base="clean")]},
                   policy_ops=[["set", ["execution_policy", "max_loop_bound"], 1],
                               ["set", ["execution_policy", "budgets", "max_spend_usd"], 3.5]]),
        run_script("unsupported-critical", {"steps": [D(base="clean", contracts_ops=[
            ["set", ["clause_coverage", "S5.1", "classification"], "unsupported"]])]}),
        run_script("non-material-coverage", {"steps": [D(base="clean", contracts_ops=[
            ["set", ["clause_coverage", "S0.1", "classification"], "non_material"],
            ["set", ["clause_coverage", "S2.2", "classification"], "unsupported"]])]}),
        run_script("unnormalized-valid", {"steps": [D(base="clean", machine_ops=[
            ["perm", ["variables"], list(reversed(range(len(machine["variables"]))))],
            ["order", ["states"], list(reversed(list(machine["states"])))]])]}),
    ]
    skill = skill_source()
    src2 = SkillSource(path="other/SKILL.md", text=skill.text + "\n## Extra\n\n- Another **MUST** rule.\n- A plain rule.\n",
                       resources={"z.md": "zz", "a.txt": "é😀", "m": ""})
    out.append(run_script("extra-clauses", {"steps": [D(base="fixture")]}, source=src2))
    src3 = SkillSource(path="", text="# T\n\nOnly one paragraph.\n")
    out.append(run_script("tiny-skill", {"steps": [D(base="clean")]}, source=src3, max_attempts=2))
    return out


def normalize_vectors():
    out = []
    for defect in (False, True):
        m = load_machine(machine_dict(defect=defect))
        n = normalize_machine(m)
        out.append({"ops": [], "defect": defect, "normalized": ints(n.to_json()), "state_order": list(n.states),
                    "variable_order": [v.name for v in n.variables],
                    "idempotent": normalize_machine(n).to_json() == n.to_json()})
    variants = [
        [["perm", ["states", "VALIDATE_DRAFT", "transitions"], [2, 0, 1]]],
        [["perm", ["states", "READ_BACK", "transitions"], [2, 1, 0]], ["set", ["initial"], "LOOKUP_SUPPLIER"]],
        [["set", ["initial"], "NOWHERE"]],
        [["set", ["states", "ORPHAN_B"], {"id": "ORPHAN_B", "action": {"kind": "end", "terminal": "END_UNVERIFIED"}}],
         ["set", ["states", "ORPHAN_A"], {"id": "ORPHAN_A", "action": {"kind": "end", "terminal": "END_UNVERIFIED"}}],
         ["set", ["states", "READ_INTAKE", "transitions", 0, "to"], "NOPE"]],
        [["ins", ["states", "READ_INTAKE", "transitions", 0], {"if": "", "to": "FALLBACK"}],
         ["ins", ["states", "READ_INTAKE", "transitions", 0], {"if": "", "to": "END_VERIFIED_DRAFT"}]],
    ]
    for ops in variants:
        md = apply_ops(machine_dict(), ops)
        m = load_machine(md)
        n = normalize_machine(m)
        out.append({"ops": ops, "defect": False, "normalized": ints(n.to_json()), "state_order": list(n.states),
                    "variable_order": [v.name for v in n.variables],
                    "idempotent": normalize_machine(n).to_json() == n.to_json()})
    return out


def main():
    fixture = compile_procurement(CATALOG)
    src = skill_source()
    ctx = build_context(src, index_clauses(src.text), CATALOG, deployment_policy())

    class T:
        model_id = "m"
        settings: dict = {}
        prompt_template = "compile_v1"
        prompt_template_sha256 = "sha256:abc"

    class T2:
        prompt_template_sha256 = "x"

    fx = result_json(fixture)
    fx["state_order"] = list(fixture.package.machine.states)
    fx["machine_digest"] = digest(fixture.package.machine.to_json())
    fx["coverage_markdown"] = coverage_markdown(fixture.coverage)
    write("compile", {
        "constants": {"COMPILER_VERSION": Cmod.COMPILER_VERSION, "NORMALIZER_VERSION": Cmod.NORMALIZER_VERSION,
                      "GUARD_GRAMMAR": Cmod.GUARD_GRAMMAR, "ACTION_KINDS": list(Cmod.ACTION_KINDS),
                      "TERMINAL_CATEGORIES": list(Cmod.TERMINAL_CATEGORIES)},
        "fixture": fx,
        "context": ctx, "context_digest": digest(ctx),
        "prompts_digest": {"fixture": prompts_digest(ctx, FixtureCompilerModel()), "template": prompts_digest(ctx, T()),
                           "template_no_name": prompts_digest(ctx, T2())},
        "markdown": coverage_markdown([{"clause": "S1", "critical": True, "text": "a|b " + "x" * 100, "classification": "c",
                                        "states": ["A", "B"]},
                                       {"clause": "S2", "critical": False, "text": "😀" * 90, "classification": "d",
                                        "states": []},
                                       {"clause": "S3", "critical": False, "text": "😀" * 91 + "|", "classification": "d",
                                        "states": ["X"]}]),
        "normalize": normalize_vectors(),
        "scripts": scripts(),
    })


if __name__ == "__main__":
    main()
