"""Golden vectors for HX.fixture (demo/procurement_fixture.py): constants, deployment_policy, machine_dict,
contracts_dict and FixtureCompilerModel.draft, plus their normalized/canonical forms."""

from __future__ import annotations

from _common import ints, write

from pydantic import ValidationError

from hexis_service.artifacts.efsm import load_machine
from hexis_service.artifacts.package import Contracts
from hexis_service.canonical import canonical_bytes, digest
from hexis_service.demo import procurement_fixture as PF

policies = {}
for env in ("sandbox", "production", "", "é😀"):
    dp = PF.deployment_policy(env)
    dump = dp.model_dump(mode="json")
    policies[env] = {"dump": ints(dump), "digest": digest(dump),
                     "task_input_schema_digest": digest(dp.task_input_schema)}
default_policy = PF.deployment_policy().model_dump(mode="json")
try:
    PF.deployment_policy(None)
    none_env = "accepted"
except ValidationError as exc:
    none_env = [[e["type"], list(e["loc"])] for e in exc.errors()]

drafts = []
model = PF.FixtureCompilerModel()
for diags in ([], [{"code": "ORDERING_VIOLATION"}], [{"code": "X"}, {"code": "ORDERING_VIOLATION"}],
              [{"message": "no code"}], [{"code": "ORDERING_VIOLATION"}, "not a dict"],
              [{"code": "ordering_violation"}], [{"code": None}]):
    out = model.draft({"clauses": []}, diags, 1)
    drafts.append({"diagnostics": diags, "defect": out["machine"]["states"]["REPAIR_DRAFT"]["transitions"][0]["to"]
                   == "REQUEST_APPROVAL", "draft": out})
try:
    model.draft({}, ["not a dict"], 1)
    bad_diag = "accepted"
except AttributeError:
    bad_diag = "AttributeError"


def repair_edge(fn):
    """Where the REPAIR_DRAFT edge goes, or the exception class name and message."""
    try:
        out = fn()
    except Exception as exc:  # noqa: BLE001
        return {"exc": type(exc).__name__, "message": str(exc)}
    m = out["machine"] if "machine" in out else out
    return {"to": m["states"]["REPAIR_DRAFT"]["transitions"][0]["to"]}


# Python truthiness of non-boolean arguments. JS machine_dict(x) is the positional call for a non-dict x; a plain
# object is always the keyword-options object, so machine_dict({...}) mirrors machine_dict(**{...}).
TRUTHY = [[], [1], "", "x", 0, 1, 2, -1, 0.5, None, True, False, [[]], [0]]
positional = [{"arg": a, "result": repair_edge(lambda: PF.machine_dict(a))} for a in TRUTHY]
keyword = [{"kwargs": kw, "result": repair_edge(lambda: PF.machine_dict(**kw))}
           for kw in [{}, {"defect": []}, {"defect": [1]}, {"defect": {}}, {"defect": {"a": 1}}, {"defect": ""},
                      {"defect": "x"}, {"defect": 0}, {"defect": 1}, {"defect": None}, {"defect": True},
                      {"defect": False}, {"x": 1}, {"defect": True, "x": 1}]]
diagnostics_iter = [{"diagnostics": d, "result": repair_edge(lambda: model.draft({}, d, 1))}
                    for d in [{}, {"a": 1}, {"code": "ORDERING_VIOLATION"}, "", "ab", 1, None, True, 0.5, [], [[]],
                              [{"code": "ORDERING_VIOLATION"}, 5], [5, {"code": "ORDERING_VIOLATION"}],
                              [{"code": "X"}, "s", {"code": "ORDERING_VIOLATION"}], [{}, {"code": "ORDERING_VIOLATION"}]]]

machines = {}
for flag in (False, True):
    raw = PF.machine_dict(defect=flag)
    m = load_machine(raw)
    machines[str(flag).lower()] = {"raw": raw, "canonical": canonical_bytes(m.to_json()).decode("utf-8"),
                                   "digest": digest(m.to_json()), "state_order": list(raw["states"]),
                                   "variable_order": [v["name"] for v in raw["variables"]]}
contracts = Contracts.model_validate(PF.contracts_dict())
cd = PF.contracts_dict()
contract_orders = {k: list(v) for k, v in cd.items() if isinstance(v, dict)}

write("fixture", {
    "CAPABILITIES": PF.CAPABILITIES, "TASK_INPUT_SCHEMA": PF.TASK_INPUT_SCHEMA, "DRAFT_SCHEMA": PF.DRAFT_SCHEMA,
    "EXTRACT_PROMPT": PF.EXTRACT_PROMPT, "REPAIR_PROMPT": PF.REPAIR_PROMPT,
    "VARIABLES": [list(v) for v in PF.VARIABLES],
    "deployment_policy": policies, "deployment_policy_default": ints(default_policy),
    "deployment_policy_none": none_env,
    "machine_dict": machines, "contracts_dict": PF.contracts_dict(), "contracts_key_orders": contract_orders,
    "contracts_canonical": canonical_bytes(contracts.model_dump(mode="json", by_alias=True)).decode("utf-8"),
    "compiler_model": {"model_id": model.model_id, "settings": model.settings, "drafts": drafts,
                       "bad_diagnostic": bad_diag, "diagnostics_iteration": diagnostics_iter},
    "machine_dict_truthiness": {"positional": positional, "keyword": keyword},
})
print(f"fixture: {len(policies)} policies, {len(drafts)} drafts")
