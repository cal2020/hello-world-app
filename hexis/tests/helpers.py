import copy
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from hexis_service import app  # noqa: E402
from hexis_service.package import build_package, load_package  # noqa: E402

_COMPILED = None


def compiled_package() -> dict:
    """The reference compile (fixture compiler model), computed once per test process."""
    global _COMPILED
    if _COMPILED is None:
        res = app.compile_example()
        assert res.ok, res.report
        _COMPILED = res.package
    return copy.deepcopy(_COMPILED)


def repackage(pkg: dict, machine=None, contracts=None, policy=None, catalog=None) -> dict:
    return build_package(machine if machine is not None else pkg["machine"], pkg["source_manifest"],
                         pkg["compiler_manifest"], catalog if catalog is not None else pkg["tool_catalog"],
                         contracts if contracts is not None else pkg["contracts"],
                         policy if policy is not None else pkg["execution_policy"])


class Env:
    """A fresh data directory with the reference package admitted and active."""

    def __init__(self, testcase: unittest.TestCase, pkg: dict | None = None, model=None, policy_doc=None):
        self.tmp = tempfile.TemporaryDirectory()
        testcase.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        self.clock = app.FakeClock()
        self.model = model
        self.policy_doc = policy_doc
        self.svc = app.build_services(self.dir, model=model, clock=self.clock, policy_doc=policy_doc)
        testcase.addCleanup(self.svc.store.close)
        self.pkg = pkg or compiled_package()
        self.hash = app.admit_and_activate(self.svc, self.pkg)
        self.rt = app.runtime(self.svc)
        self.task = app.load_example_inputs()["task"]

    def restart(self):
        """Simulate a new process: drop every in-memory object, keep the files."""
        faults = list(self.svc.broker.connectors.erp.faults)
        self.svc.store.close()
        self.svc = app.build_services(self.dir, model=self.model, clock=self.clock, policy_doc=self.policy_doc)
        self.svc.broker.connectors.erp.faults = faults
        self.rt = app.runtime(self.svc)

    def start(self, task=None, request_id="r1", principal=None):
        run = self.rt.start_run(self.hash, task or self.task, principal or app.REQUESTER, request_id)
        return run["run_id"], self.rt.run(run["run_id"], app.REQUESTER)

    def approve(self, run_id, cp, decision="approved", request_id=None, principal=None):
        return self.rt.resume_interaction(run_id, cp["pending"]["interaction_id"], {"decision": decision},
                                          principal or app.APPROVER, request_id or f"ap-{run_id}-{cp['revision']}")

    def erp(self):
        return self.svc.broker.connectors.erp

    def creates(self):
        return [c for c in self.erp().calls if c["op"] == "create_draft"]


def tiny_package(states: dict, variables: list, var_contracts: dict, loop_bounds=None, terminals=None) -> dict:
    """A tool-free machine for kernel-level tests."""
    machine = {"format": "efsm-v1", "skill_id": "tiny", "initial": next(iter(states)), "fallback": "FALLBACK",
               "states": {**states, "FALLBACK": {"id": "FALLBACK", "action": {"kind": "end", "terminal": "FALLBACK"},
                                                 "transitions": []}},
               "variables": variables,
               "terminals": terminals or [{"id": "OK", "kind": "unverified"}, {"id": "FALLBACK", "kind": "fallback"}]}
    contracts = {"variables": var_contracts, "loop_bounds": loop_bounds or {}, "terminals": {}}
    policy = {"capability_ceiling": [], "fallback_mode": "stop_for_review", "budgets": {"steps": 50}}
    source = {"clauses": [], "skill_sha256": "0" * 64}
    return build_package(machine, source, {"compiler": "test"}, {"tools": {}}, contracts, policy)


def loaded(pkg):
    return load_package(pkg)
