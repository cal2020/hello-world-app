from __future__ import annotations

import copy
import functools

import pytest

from hexis_service.artifacts.efsm import load_machine
from hexis_service.artifacts.package import Contracts, MachinePackage
from hexis_service.demo import procurement_fixture as PF
from hexis_service.demo.env import TASK, ManualClock, admit_initial, build_env, compile_procurement, load_catalog


@functools.lru_cache(maxsize=1)
def _compiled():
    res = compile_procurement()
    assert res.status == "validated", res.attempts
    return res


@pytest.fixture
def compiled():
    return _compiled()


@pytest.fixture
def pkg(compiled) -> MachinePackage:
    return compiled.package.model_copy(deep=True)


@pytest.fixture
def catalog():
    return load_catalog()


@pytest.fixture
def clock():
    return ManualClock()


@pytest.fixture
def env(pkg, clock, tmp_path):
    e = build_env(str(tmp_path / "state"), clock=clock)
    assert admit_initial(e, pkg).status == "ADMITTED"
    return e


def mutate(pkg: MachinePackage, fn) -> MachinePackage:
    """Apply ``fn(machine_dict, contracts_dict)`` to copies and return a sealed package."""
    md = copy.deepcopy(pkg.machine.to_json())
    cd = copy.deepcopy(pkg.contracts.model_dump(mode="json", by_alias=True))
    fn(md, cd)
    return MachinePackage(machine=load_machine(md), source_manifest=pkg.source_manifest,
                          compiler_manifest=pkg.compiler_manifest, contracts=Contracts.model_validate(cd),
                          execution_policy=pkg.execution_policy, lineage=pkg.lineage).sealed()


def run_to_approval(env, pkg, task=None, who="user:alice"):
    p = env.principal(who)
    h = env.service.start_run(pkg.artifact_hash, task or TASK, p)
    res = env.service.run_until_blocked(h.run_id, p)
    return h.run_id, res


def approve(env, run_id, ix, who="user:bob"):
    return env.service.resume_interaction(run_id, ix["interaction_id"],
                                          {"approval_decision": "approved", "scope_digest": ix["scope_digest"]},
                                          env.principal(who))


def step_until_state(env, run_id, state, who="user:alice", limit=50):
    p = env.principal(who)
    for _ in range(limit):
        cp = env.service._cp(p.tenant_id, run_id)
        if cp.state_id == state or cp.status != "RUNNING":
            return cp
        env.service.advance_run(run_id, p)
    raise AssertionError("state not reached")


def mini_package(states: dict, variables: list, var_contracts: dict, terminals: list, term_contracts: dict,
                 initial: str, task_schema=None) -> MachinePackage:
    """A small package for kernel-level tests (bypasses compile; tests call the kernel directly)."""
    base = _compiled().package
    md = {"format": "efsm-v1", "skill_id": "mini", "initial": initial, "fallback": "FALLBACK", "max_steps": 20,
          "states": states, "variables": variables, "terminals": terminals}
    cd = {"variables": var_contracts, "terminals": term_contracts,
          "task_input_schema": task_schema or {"type": "object"}}
    return MachinePackage(machine=load_machine(md), source_manifest=base.source_manifest,
                          compiler_manifest=base.compiler_manifest, contracts=Contracts.model_validate(cd),
                          execution_policy=PF.deployment_policy().execution_policy).sealed()
