"""Wiring for the offline procurement demonstration and tests (fixture mode)."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from ..artifacts.package import MachinePackage
from ..artifacts.registry import admit
from ..compiler.compile import CompileResult, SkillSource, compile_skill
from ..models.base import ModelAdapter
from ..runtime.service import RunService, erp_freshness
from ..storage.sqlite import Store
from ..tools.broker import FaultInjector, ToolBroker
from ..tools.catalog import ToolCatalog
from ..tools.policy import PolicyService
from . import fakes
from .procurement_fixture import EXAMPLES, FixtureCompilerModel, deployment_policy


class ManualClock:
    def __init__(self, t: float = 1_790_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, s: float) -> None:
        self.t += s


def load_catalog() -> ToolCatalog:
    return ToolCatalog.model_validate(json.loads((EXAMPLES / "tool_catalog.json").read_text()))


def load_policy() -> dict:
    return json.loads((EXAMPLES / "policy.json").read_text())


def skill_source() -> SkillSource:
    return SkillSource(path="examples/procurement_onboarding/SKILL.md", text=(EXAMPLES / "SKILL.md").read_text())


def compile_procurement(catalog: Optional[ToolCatalog] = None) -> CompileResult:
    return compile_skill(skill_source(), catalog or load_catalog(), deployment_policy(), FixtureCompilerModel())


@dataclass
class Env:
    store: Store
    catalog: ToolCatalog
    policy: PolicyService
    docs: fakes.DocumentStore
    registry: fakes.SupplierRegistry
    erp: fakes.FakeERP
    faults: FaultInjector
    broker: ToolBroker
    model: ModelAdapter
    service: RunService
    clock: Callable[[], float]

    def principal(self, pid: str):
        return self.policy.authenticate(pid)

    def restart(self, model: Optional[ModelAdapter] = None) -> "Env":
        """Simulate a process restart: new store connection, broker and service over the same files.
        (For ':memory:' stores the connection object is reused, since memory DBs cannot be reopened.)"""
        store = Store(self.store.path) if self.store.path != ":memory:" else self.store
        erp = fakes.FakeERP(self.erp.path) if self.erp.path != ":memory:" else self.erp
        return build_env(store=store, erp=erp, policy=self.policy, clock=self.clock, model=model or self.model,
                         docs=self.docs, registry=self.registry)


def build_env(workdir: Optional[str] = None, *, store: Optional[Store] = None, erp: Optional[fakes.FakeERP] = None,
              policy: Optional[PolicyService] = None, clock: Optional[Callable[[], float]] = None,
              model: Optional[ModelAdapter] = None, docs: Optional[fakes.DocumentStore] = None,
              registry: Optional[fakes.SupplierRegistry] = None) -> Env:
    if workdir:
        Path(workdir).mkdir(parents=True, exist_ok=True)
    store = store or Store(str(Path(workdir) / "hexis.db") if workdir else ":memory:")
    erp = erp or fakes.FakeERP(str(Path(workdir) / "fake_erp.db") if workdir else ":memory:")
    catalog = load_catalog()
    policy = policy or PolicyService(load_policy())
    clock = clock or time.time
    docs = docs or fakes.DocumentStore()
    registry = registry or fakes.SupplierRegistry()
    faults = FaultInjector()
    connectors = {"documents.read": docs.read, "supplier.lookup": registry.lookup, "draft.validate": fakes.validate_draft,
                  "erp.create_draft": erp.create_draft, "erp.read_draft": erp.read_draft,
                  "draft.verify_persisted": fakes.verify_persisted}
    broker = ToolBroker(store, catalog, policy, connectors, {"erp.create_draft": erp.reconcile_create}, clock, faults)
    model = model or fakes.FixtureExtractionModel()
    service = RunService(store, catalog, policy, broker, model, clock=clock, faults=faults,
                         freshness={"persisted_draft_matches_approved_payload": erp_freshness()})
    return Env(store, catalog, policy, docs, registry, erp, faults, broker, model, service, clock)


def admit_initial(env: Env, pkg: MachinePackage, archive: Optional[dict] = None):
    return admit(env.store, pkg, env.catalog, expected_parent_hash=None, approver=env.principal("user:dana"),
                 environment="sandbox", archive_manifest=archive or {"protected": [], "negative": []},
                 now=env.clock(), skill_text=skill_source().text)


TASK = {"supplier_ref": "SUP-10042", "business_unit": "BU-EMEA", "document_ids": ["DOC-W9-10042", "DOC-FORM-10042"],
        "required_fields": ["legal_name", "country", "tax_id", "contact_email"],
        "policy_version": "onboarding-policy/2026-09"}
