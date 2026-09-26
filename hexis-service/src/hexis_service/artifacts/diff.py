"""Structural diff between two machine packages (brief §9.4 "Candidate diffs must show")."""

from __future__ import annotations

from ..tools.catalog import ToolCatalog, WRITE_EFFECTS
from .package import MachinePackage
from .validate import reachable


def _edges(pkg: MachinePackage) -> dict[tuple, dict]:
    out = {}
    for sid, st in pkg.machine.states.items():
        for i, t in enumerate(st.transitions):
            out[(sid, i)] = {"if": t.cond, "to": t.to, "inc": t.inc}
    return out


def package_diff(old: MachinePackage, new: MachinePackage, catalog: ToolCatalog | None = None) -> dict:
    om, nm = old.machine, new.machine
    added_states = sorted(set(nm.states) - set(om.states))
    removed_states = sorted(set(om.states) - set(nm.states))
    changed_actions = []
    for sid in sorted(set(om.states) & set(nm.states)):
        a, b = om.states[sid].action.model_dump(mode="json"), nm.states[sid].action.model_dump(mode="json")
        if a != b:
            changed_actions.append({"state": sid, "fields": sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))})
    oe = {sid: [(t.cond, t.to, t.inc) for t in st.transitions] for sid, st in om.states.items()}
    ne = {sid: [(t.cond, t.to, t.inc) for t in st.transitions] for sid, st in nm.states.items()}
    edge_changes = []
    for sid in sorted(set(oe) | set(ne)):
        before, after = oe.get(sid, []), ne.get(sid, [])
        if before != after:
            edge_changes.append({"state": sid,
                                 "added": [dict(zip(("if", "to", "inc"), e)) for e in after if e not in before],
                                 "removed": [dict(zip(("if", "to", "inc"), e)) for e in before if e not in after],
                                 "order_changed": sorted(before, key=str) == sorted(after, key=str)})
    ov, nv = {v.name: v.model_dump() for v in om.variables}, {v.name: v.model_dump() for v in nm.variables}
    var_changes = {"added": sorted(set(nv) - set(ov)), "removed": sorted(set(ov) - set(nv)),
                   "changed": sorted(k for k in set(ov) & set(nv) if ov[k] != nv[k])}
    oc, nc = old.contracts.model_dump(mode="json"), new.contracts.model_dump(mode="json")
    contract_changes = sorted(k for k in set(oc) | set(nc) if oc.get(k) != nc.get(k))
    policy_changed = old.execution_policy.model_dump() != new.execution_policy.model_dump()
    clauses = sorted({nm.states[s].clause for s in added_states if nm.states[s].clause}
                     | {nm.states[e["state"]].clause for e in edge_changes if e["state"] in nm.states
                        and nm.states[e["state"]].clause})
    newly_reachable_effects = []
    if catalog is not None:
        def effects(pkg: MachinePackage) -> set[str]:
            r = reachable(pkg.machine, pkg.machine.initial)
            out = set()
            for s in r:
                a = pkg.machine.states[s].action
                if a.kind == "tool":
                    spec = catalog.get(a.name)
                    if spec is not None and spec.effect in WRITE_EFFECTS:
                        out.add(f"{s}:{a.name}")
            return out
        newly_reachable_effects = sorted(effects(new) - effects(old))
    return {"states_added": added_states, "states_removed": removed_states, "actions_changed": changed_actions,
            "edges_changed": edge_changes, "variables": var_changes, "contracts_changed": contract_changes,
            "execution_policy_changed": policy_changed, "affected_clauses": clauses,
            "newly_reachable_effects": newly_reachable_effects}
