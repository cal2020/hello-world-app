"""Wiring for the offline procurement demonstration (fixture mode)."""
from __future__ import annotations

import os
import time

from . import canonical
from .authority import ApprovalService, EvidenceService, PolicyService, Principal
from .broker import ToolBroker
from .compiler import FixtureCompilerModel, compile_skill
from .connectors import ConnectorSet, DocumentStore, FakeERP, SupplierMaster, make_validator
from .models import ModelAdapter, RuleBasedFakeModel
from .registry import Registry
from .runtime import Runtime, Services
from .store import Store

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLE_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "examples", "procurement_onboarding"))
TENANT = "T-ACME"

# Simulated host principals (labelled: not production authentication).
REQUESTER = Principal("u-requester", TENANT, ("procurement_agent",))
APPROVER = Principal("u-approver", TENANT, ("procurement_approver",))
OTHER_TENANT_APPROVER = Principal("u-other", "T-OTHER", ("procurement_approver",))

SUPPLIER_MASTER = [
    {"tenant_id": TENANT, "supplier_id": "S-0001", "name": "Existing Widgets plc", "business_unit": "BU-EMEA"},
    {"tenant_id": TENANT, "supplier_id": "S-0002", "name": "Conflicted Parts SA", "business_unit": "BU-NA"},
]


class FakeClock:
    def __init__(self, start: float = 1_790_000_000.0):
        self.now = start

    def __call__(self) -> float:
        self.now += 1.0
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def example_path(*parts: str) -> str:
    return os.path.join(EXAMPLE_DIR, *parts)


def load_example_inputs() -> dict:
    return {name: canonical.load_file(example_path(f"{name}.json"))
            for name in ("tool_catalog", "contracts", "execution_policy", "deployment_policy", "task")}


def compile_example(profile: str = "production"):
    inp = load_example_inputs()
    return compile_skill(example_path("SKILL.md"), inp["tool_catalog"], inp["contracts"], inp["execution_policy"],
                         FixtureCompilerModel(example_path("compiler_fixture.json")), profile=profile)


def build_services(data_dir: str, model: ModelAdapter | None = None, clock=None,
                   policy_doc: dict | None = None) -> Services:
    os.makedirs(data_dir, exist_ok=True)
    clock = clock or time.time
    store = Store(os.path.join(data_dir, "hexis.sqlite3"))
    policy = PolicyService(policy_doc or canonical.load_file(example_path("deployment_policy.json")))
    approvals = ApprovalService(store, policy)
    evidence = EvidenceService(store)
    connectors = ConnectorSet(
        erp=FakeERP(os.path.join(data_dir, "fake_erp.json")),
        documents=DocumentStore(example_path("documents"), {TENANT: ["DOC-100", "DOC-200", "DOC-666"]}),
        suppliers=SupplierMaster(SUPPLIER_MASTER),
        validator=make_validator(policy.doc),
    )
    broker = ToolBroker(store, policy, approvals, evidence, connectors, clock=clock)
    return Services(store=store, registry=Registry(store), policy=policy, approvals=approvals, evidence=evidence,
                    broker=broker, model=model or RuleBasedFakeModel(), clock=clock)


def admit_and_activate(services: Services, pkg: dict, replay_report: dict | None = None) -> str:
    services.registry.register_draft(pkg)
    services.registry.admit(pkg, approver="svc-admission", environment="local-offline", replay_report=replay_report)
    current = services.registry.active(TENANT, pkg["machine"]["skill_id"])
    services.registry.promote(TENANT, pkg["artifact_hash"], current[0] if current else None)
    return pkg["artifact_hash"]


def make_task(doc_ids: list[str], supplier: str, business_unit: str = "BU-EMEA",
              policy_version: str = "onboarding-policy/2026-09") -> dict:
    refs = []
    for d in doc_ids:
        path = example_path("documents", d + ".txt")
        sha = "0" * 64
        if os.path.exists(path):
            with open(path, "rb") as fh:
                sha = canonical.sha256_hex(fh.read())
        refs.append({"doc_id": d, "sha256": sha})
    return {"intake": {"document_refs": refs},
            "supplier": {"proposed_name": supplier, "business_unit": business_unit},
            "policy_version": policy_version}


def runtime(services: Services) -> Runtime:
    return Runtime(services)
