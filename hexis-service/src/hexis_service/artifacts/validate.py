"""Static admission checks for production packages (brief §8 "Mandatory static checks", §7.2, §7.4).

Every finding carries a code and an exact location (state / edge index / variable / clause).
``profile="production"`` treats every finding of severity ``error`` as blocking; the ``sandbox``
profile downgrades provenance-only findings to warnings but never relaxes guard, ownership,
ordering, loop or tool-contract checks.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Iterable, Optional

from .. import guards as G
from ..canonical import digest, sha256_hex
from ..tools.catalog import ToolCatalog, WRITE_EFFECTS
from .efsm import Machine, State
from .package import MachinePackage, OrderingRequirement

VALIDATOR_VERSION = "hexis-service-validator/1"
_TEMPLATE_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


@dataclass
class Finding:
    code: str
    message: str
    severity: str = "error"
    state: Optional[str] = None
    edge: Optional[int] = None
    variable: Optional[str] = None
    clause: Optional[str] = None
    detail: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v not in (None, {}, "")}


@dataclass
class ValidationReport:
    profile: str
    artifact_hash: str
    findings: list[Finding]
    analyses: list[dict]

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def passed(self) -> bool:
        return not self.errors

    def codes(self) -> set[str]:
        return {f.code for f in self.errors}

    def to_json(self) -> dict:
        body = {"validator": VALIDATOR_VERSION, "profile": self.profile, "artifact_hash": self.artifact_hash,
                "passed": self.passed, "findings": [f.to_json() for f in self.findings], "analyses": self.analyses}
        body["report_digest"] = digest({k: v for k, v in body.items() if k != "report_digest"})
        return body


def template_vars(obj: object) -> set[str]:
    out: set[str] = set()
    if isinstance(obj, str):
        out.update(_TEMPLATE_RE.findall(obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            out |= template_vars(v)
    elif isinstance(obj, list):
        for v in obj:
            out |= template_vars(v)
    return out


def action_reads(st: State) -> set[str]:
    a = st.action
    reads = set(getattr(a, "reads", []) or [])
    if a.kind == "tool":
        reads |= template_vars(a.input)
    return reads


def action_writes(st: State) -> set[str]:
    return set(getattr(st.action, "writes", []) or [])


def successors(m: Machine) -> dict[str, list[str]]:
    return {sid: [t.to for t in st.ordered_transitions()] for sid, st in m.states.items()}


def reachable(m: Machine, start: str) -> set[str]:
    succ = successors(m)
    seen, q = {start}, deque([start])
    while q:
        s = q.popleft()
        for t in succ.get(s, []):
            if t in m.states and t not in seen:
                seen.add(t)
                q.append(t)
    return seen


def _sccs(nodes: list[str], succ: dict[str, list[str]]) -> list[list[str]]:
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on: set[str] = set()
    out: list[list[str]] = []
    counter = [0]

    def strong(v: str) -> None:  # iterative Tarjan would be overkill for machine sizes here
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        for w in succ.get(v, []):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            out.append(comp)

    for n in nodes:
        if n not in index:
            strong(n)
    return out


def _matches(sel: str, sid: str, st: State, pkg: MachinePackage) -> bool:
    kind, _, val = sel.partition(":")
    a = st.action
    if kind == "state":
        return sid == val
    if kind == "tool":
        return a.kind == "tool" and a.name == val
    if kind == "terminal":
        return a.kind == "end" and a.terminal == val
    if kind == "user":
        ic = pkg.contracts.interactions.get(sid)
        return a.kind == "user" and ic is not None and ic.type == val
    return False


def check_ordering(pkg: MachinePackage, req: OrderingRequirement, states: Optional[Iterable[str]] = None
                   ) -> Optional[list[str]]:
    """Return a counterexample path violating ``req`` or ``None``. Guard feasibility is ignored
    (conservative: may over-report, never under-reports graph paths)."""
    m = pkg.machine
    inval = set(req.invalidated_by)
    allowed = set(states) if states is not None else set(m.states)
    start = (m.initial, False)
    parent: dict[tuple[str, bool], Optional[tuple[str, bool]]] = {start: None}
    q = deque([start])
    while q:
        sid, flag = q.popleft()
        st = m.states[sid]
        if any(_matches(b, sid, st, pkg) for b in [req.before]) and not flag:
            path, cur = [], (sid, flag)
            while cur is not None:
                path.append(cur[0])
                cur = parent[cur]
            return list(reversed(path))
        if any(_matches(r, sid, st, pkg) for r in req.requires):
            nflag = True
        elif action_writes(st) & inval:
            nflag = False
        else:
            nflag = flag
        for t in st.ordered_transitions():
            if t.to in m.states and t.to in allowed:
                nxt = (t.to, nflag)
                if nxt not in parent:
                    parent[nxt] = (sid, flag)
                    q.append(nxt)
    return None


def derived_ordering(pkg: MachinePackage) -> list[OrderingRequirement]:
    """Requirements implied by terminal evidence and approval contracts."""
    m = pkg.machine
    out: list[OrderingRequirement] = []
    for tid, tc in pkg.contracts.terminals.items():
        for ev in tc.evidence:
            out.append(OrderingRequirement(id=f"derived:evidence:{tid}:{ev.claim}", requires=[f"tool:{ev.verifier_tool}"],
                                           before=f"terminal:{tid}", invalidated_by=list(ev.subject_vars)))
    for sid, ic in pkg.contracts.interactions.items():
        if ic.type == "approval" and ic.approves_state in m.states:
            target = m.states[ic.approves_state]
            out.append(OrderingRequirement(id=f"derived:approval:{sid}", requires=[f"state:{sid}"],
                                           before=f"state:{ic.approves_state}",
                                           invalidated_by=sorted(action_reads(target))))
    return out


def _top_conjuncts(expr: str) -> list:
    import ast
    body = G.parse(expr).body
    if isinstance(body, ast.BoolOp) and isinstance(body.op, ast.And):
        return list(body.values)
    return [body]


def edge_bound(expr: str, counter: str) -> Optional[int]:
    """If ``expr`` has a top-level conjunct ``counter < K`` / ``counter <= K``, return the number of
    times the edge can be taken with an increment of one from zero."""
    import ast
    if not expr:
        return None
    for c in _top_conjuncts(expr):
        if isinstance(c, ast.Compare) and len(c.ops) == 1 and isinstance(c.left, ast.Name) \
                and c.left.id == counter and isinstance(c.comparators[0], ast.Constant):
            k = c.comparators[0].value
            if isinstance(k, bool) or not isinstance(k, int):
                continue
            if isinstance(c.ops[0], ast.Lt):
                return max(k, 0)
            if isinstance(c.ops[0], ast.LtE):
                return max(k + 1, 0)
    return None


def validate_package(pkg: MachinePackage, catalog: ToolCatalog, profile: str = "production",
                     skill_text: Optional[str] = None) -> ValidationReport:
    F: list[Finding] = []
    analyses: list[dict] = []
    m = pkg.machine
    C = pkg.contracts
    P = pkg.execution_policy
    types = m.var_types()

    def err(code: str, msg: str, **kw) -> None:
        F.append(Finding(code, msg, **kw))

    # ---- integrity -------------------------------------------------------------------------- #
    if pkg.artifact_hash and not pkg.verify_hash():
        err("HASH_MISMATCH", "artifact_hash does not match the canonical hash payload")
    if pkg.source_manifest.tool_catalog_sha256 != catalog.digest():
        err("CATALOG_MISMATCH", "package was compiled against a different tool catalog digest")
    for e in catalog.check_schemas():
        err("CATALOG_SCHEMA", e)

    # ---- structure ------------------------------------------------------------------------- #
    for sid, st in m.states.items():
        if sid != st.id:
            err("STATE_ID_MISMATCH", f"state key {sid!r} != id {st.id!r}", state=sid)
    names = [v.name for v in m.variables]
    for n in {n for n in names if names.count(n) > 1}:
        err("DUPLICATE_VARIABLE", f"variable {n!r} declared more than once", variable=n)
    tids = [t.id for t in m.terminals]
    for t in {t for t in tids if tids.count(t) > 1}:
        err("DUPLICATE_TERMINAL", f"terminal {t!r} declared more than once")
    if m.initial not in m.states:
        err("UNKNOWN_INITIAL", f"initial state {m.initial!r} does not exist", state=m.initial)
        return ValidationReport(profile, pkg.artifact_hash, F, analyses)
    if m.fallback not in m.states:
        err("UNKNOWN_FALLBACK", f"fallback state {m.fallback!r} does not exist", state=m.fallback)
    for v in names:
        if v not in C.variables:
            err("VARIABLE_CONTRACT_MISSING", f"variable {v!r} has no ownership contract", variable=v)
    for v in C.variables:
        if v not in types:
            err("UNKNOWN_VARIABLE", f"contract names undeclared variable {v!r}", variable=v)
    for t in m.terminals:
        tc = C.terminals.get(t.id)
        if tc is None:
            err("TERMINAL_CONTRACT_MISSING", f"terminal {t.id!r} has no contract")
        elif t.kind and t.kind != tc.category:
            err("TERMINAL_CATEGORY_MISMATCH", f"terminal {t.id!r} kind {t.kind!r} != contract {tc.category!r}")
        for o in t.output:
            if o not in types:
                err("UNKNOWN_VARIABLE", f"terminal {t.id!r} outputs undeclared {o!r}", variable=o)
    for tid in C.terminals:
        if tid not in tids:
            err("UNKNOWN_TERMINAL", f"terminal contract for undeclared terminal {tid!r}")

    ceiling = set(P.capability_ceiling)
    owner = {k: v.owner for k, v in C.variables.items()}
    counters_written_by_inc: set[str] = set()

    for sid, st in m.states.items():
        a = st.action
        for v in sorted(action_reads(st) | action_writes(st)):
            if v not in types:
                err("UNKNOWN_VARIABLE", f"state {sid} references undeclared variable {v!r}", state=sid, variable=v)
        if a.kind == "end":
            if a.terminal not in tids:
                err("UNKNOWN_TERMINAL", f"state {sid} ends in undeclared terminal {a.terminal!r}", state=sid)
            if st.transitions:
                err("TERMINAL_HAS_EDGES", f"end state {sid} has outgoing transitions", state=sid)
            continue
        if not st.transitions:
            err("NO_TRANSITIONS", f"non-terminal state {sid} has no outgoing transitions", state=sid)
        expected_owner = {"model": "model", "judge": "model", "tool": "tool", "user": "user"}[a.kind]
        for w in action_writes(st):
            if w in owner and owner[w] != expected_owner:
                err("WRITE_OWNERSHIP", f"{a.kind} state {sid} writes {w!r} owned by {owner[w]}", state=sid, variable=w)
        if a.kind == "judge":
            w = a.writes[0]
            enum = (C.variables.get(w).schema_ if w in C.variables else {}).get("enum")
            if types.get(w) != "string":
                err("JUDGE_LABEL_TYPE", f"judge {sid} label variable {w!r} must be a string", state=sid, variable=w)
            if enum is not None and set(a.labels) != set(enum):
                err("JUDGE_LABELS_SCHEMA", f"judge {sid} labels {a.labels} differ from schema enum {enum}", state=sid)
        if a.kind == "user":
            ic = C.interactions.get(sid)
            if ic is None:
                err("INTERACTION_CONTRACT_MISSING", f"user state {sid} has no interaction contract", state=sid)
            elif ic.type == "approval" and ic.approves_state not in m.states:
                err("UNKNOWN_STATE", f"approval {sid} approves unknown state {ic.approves_state!r}", state=sid)
        if a.kind == "tool":
            spec = catalog.get(a.name)
            if spec is None:
                err("UNKNOWN_TOOL", f"state {sid} calls unregistered tool {a.name!r}", state=sid)
                continue
            if spec.capability not in ceiling:
                err("CAPABILITY_EXCEEDS_CEILING", f"tool {a.name} needs {spec.capability!r} outside package ceiling",
                    state=sid)
            out_props = set((spec.output_schema.get("properties") or {}).keys())
            in_props = spec.input_schema.get("properties") or {}
            for k, target in a.binds.items():
                if k not in out_props:
                    err("BIND_UNKNOWN_OUTPUT", f"{sid} binds unknown output key {k!r} of {a.name}", state=sid)
                if target not in a.writes:
                    err("BIND_TARGET_NOT_WRITTEN", f"{sid} binds {k!r} to {target!r} not in writes", state=sid,
                        variable=target)
            producible = {a.binds.get(k, k) for k in out_props}
            for w in a.writes:
                if w not in producible:
                    err("WRITE_NOT_PRODUCED", f"{sid} declares write {w!r} that {a.name} cannot produce",
                        state=sid, variable=w)
            for k in spec.input_schema.get("required", []):
                if k not in a.input:
                    err("TOOL_INPUT_MISSING", f"{sid} omits required input {k!r} of {a.name}", state=sid)
            if spec.input_schema.get("additionalProperties") is False:
                for k in a.input:
                    if k not in in_props:
                        err("TOOL_INPUT_UNKNOWN", f"{sid} passes unknown input {k!r} to {a.name}", state=sid)
            for k, tmpl in a.input.items():
                if isinstance(tmpl, str) and _TEMPLATE_RE.fullmatch(tmpl) is None and _TEMPLATE_RE.search(tmpl):
                    for v in _TEMPLATE_RE.findall(tmpl):
                        if types.get(v) not in ("string", "integer", "number"):
                            err("TEMPLATE_TYPE", f"{sid} interpolates non-scalar {v!r} into a string", state=sid,
                                variable=v)
        for i, t in enumerate(st.transitions):
            if t.to not in m.states:
                err("UNKNOWN_TARGET", f"{sid} edge {i} targets unknown state {t.to!r}", state=sid, edge=i)
            if t.inc:
                counters_written_by_inc.add(t.inc)
                if types.get(t.inc) != "integer":
                    err("COUNTER_TYPE", f"{sid} edge {i} increments non-integer {t.inc!r}", state=sid, edge=i)
                if owner.get(t.inc) != "engine":
                    err("COUNTER_OWNERSHIP", f"counter {t.inc!r} must be engine-owned", state=sid, variable=t.inc)

    for v, o in owner.items():
        if o == "engine":
            var = m.var(v)
            if var is not None and var.init_from:
                err("ENGINE_FROM_TASK", f"engine-owned {v!r} cannot be initialised from task input", variable=v)

    # ---- guards ---------------------------------------------------------------------------- #
    for sid, st in m.states.items():
        if st.action.kind == "end":
            continue
        defaults = [i for i, t in enumerate(st.transitions) if not t.cond]
        if len(defaults) > 1:
            err("MULTIPLE_DEFAULTS", f"{sid} has {len(defaults)} default edges", state=sid)
        if not defaults:
            err("NO_DEFAULT", f"{sid} has no default edge (every nonterminal state needs a safe default)", state=sid)
        elif defaults[-1] != len(st.transitions) - 1:
            err("DEFAULT_NOT_LAST", f"{sid} default edge is not last in serialized order", state=sid, edge=defaults[-1])
        guarded = [(i, t.cond) for i, t in enumerate(st.transitions) if t.cond]
        for i, g in guarded:
            for e in G.typecheck(g, types):
                err("GUARD_INVALID", f"{sid} edge {i}: {e}", state=sid, edge=i, detail={"guard": g})
        if guarded and defaults:
            dt = m.states.get(st.transitions[defaults[-1]].to)
            if dt is not None and dt.action.kind == "tool":
                spec = catalog.get(dt.action.name)
                if spec is not None and spec.effect in WRITE_EFFECTS:
                    err("UNSAFE_DEFAULT", f"{sid} default edge falls through to consequential write {dt.id}",
                        state=sid, edge=defaults[-1])
        if len(guarded) >= 2 and not any(f.state == sid and f.code == "GUARD_INVALID" for f in F):
            an = G.analyze_disjoint([g for _, g in guarded], types)
            analyses.append({"state": sid, "analysis": "disjointness", "status": an.status, "detail": an.detail,
                             "counterexample": an.counterexample})
            if an.status == "COUNTEREXAMPLE":
                err("GUARDS_OVERLAP", f"{sid}: guarded edges {[guarded[i][0] for i in an.edges]} overlap",
                    state=sid, detail={"counterexample": an.counterexample})
            elif an.status == "UNKNOWN":
                err("GUARDS_DISJOINTNESS_UNKNOWN", f"{sid}: disjointness not proven ({an.detail})", state=sid)

    # ---- reachability ---------------------------------------------------------------------- #
    reach = reachable(m, m.initial)
    for sid in m.states:
        if sid not in reach and sid not in C.explained_unreachable and sid != m.fallback:
            err("DEAD_STATE", f"state {sid} is unreachable from {m.initial}", state=sid)
    ends = {sid for sid, st in m.states.items() if st.action.kind == "end"}
    pred: dict[str, set[str]] = {s: set() for s in m.states}
    for sid, st in m.states.items():
        for t in st.transitions:
            if t.to in pred:
                pred[t.to].add(sid)
    can_stop, q = set(ends), deque(ends)
    while q:
        s = q.popleft()
        for p in pred[s]:
            if p not in can_stop:
                can_stop.add(p)
                q.append(p)
    for sid in reach - can_stop:
        err("NO_ROUTE_TO_STOP", f"state {sid} cannot reach any terminal", state=sid)

    # ---- dataflow: definite assignment ----------------------------------------------------- #
    required_task = set(C.task_input_schema.get("required", []))
    a0 = set()
    for v in m.variables:
        if v.init is not None:
            a0.add(v.name)
        elif v.init_from and v.init_from.split(".")[-1] in required_task:
            a0.add(v.name)
        elif v.init_from:
            F.append(Finding("OPTIONAL_TASK_INPUT", f"{v.name!r} comes from optional task field", "warning",
                             variable=v.name))
    universe = set(types)
    IN = {s: (set(a0) if s == m.initial else set(universe)) for s in reach}
    OUT = {s: IN[s] | action_writes(m.states[s]) for s in reach}
    changed = True
    while changed:
        changed = False
        for s in reach:
            if s == m.initial:
                new_in = set(a0)  # first entry sees only a0; OUT sets only grow, so re-entry cannot shrink it
            else:
                new_in = set(universe)
                for p in (p for p in pred[s] if p in reach):
                    new_in &= OUT[p]
            new_out = new_in | action_writes(m.states[s])
            if new_in != IN[s] or new_out != OUT[s]:
                IN[s], OUT[s], changed = new_in, new_out, True
    for s in sorted(reach):
        st = m.states[s]
        for v in sorted(action_reads(st) - IN[s]):
            if v in types:
                err("READ_BEFORE_WRITE", f"{s} reads {v!r} which is not assigned on every path", state=s, variable=v)
        for i, t in enumerate(st.transitions):
            if t.cond:
                try:
                    gv = G.vars_of(t.cond)
                except G.GuardError:
                    continue
                for v in sorted(gv - OUT[s]):
                    if v in types:
                        err("GUARD_READ_BEFORE_WRITE", f"{s} edge {i} guard reads unassigned {v!r}", state=s,
                            edge=i, variable=v)
        if st.action.kind == "end":
            term = m.terminal(st.action.terminal)
            for o in (term.output if term else []):
                if o not in IN[s]:
                    err("TERMINAL_OUTPUT_UNASSIGNED", f"{s} terminal output {o!r} not assigned on every path",
                        state=s, variable=o)

    # ---- loops ----------------------------------------------------------------------------- #
    succ_r = {s: [t.to for t in m.states[s].transitions if t.to in reach] for s in reach}
    for comp in _sccs(sorted(reach), succ_r):
        cs = set(comp)
        if len(comp) == 1 and comp[0] not in succ_r.get(comp[0], []):
            continue
        # remove bounded edges; remainder must be acyclic
        rest: dict[str, list[str]] = {s: [] for s in comp}
        bounds = []
        for s in comp:
            for i, t in enumerate(m.states[s].transitions):
                if t.to not in cs:
                    continue
                b = edge_bound(t.cond, t.inc) if t.inc else None
                if b is not None and owner.get(t.inc) == "engine":
                    if b > P.max_loop_bound:
                        err("LOOP_BOUND_EXCEEDS_CEILING", f"{s} edge {i} allows {b} iterations > ceiling "
                            f"{P.max_loop_bound}", state=s, edge=i)
                    bounds.append({"state": s, "edge": i, "counter": t.inc, "bound": b})
                    continue
                rest[s].append(t.to)
        cyc = [c for c in _sccs(comp, rest) if len(c) > 1 or c[0] in rest.get(c[0], [])]
        analyses.append({"analysis": "loop", "component": sorted(comp), "bounded_edges": bounds,
                         "status": "PROVEN" if not cyc else "COUNTEREXAMPLE"})
        for c in cyc:
            err("LOOP_UNBOUNDED", f"cycle through {sorted(c)} avoids every counter-bounded edge", state=sorted(c)[0],
                detail={"cycle_states": sorted(c)})

    # ---- ordering / evidence --------------------------------------------------------------- #
    for req in list(C.ordering) + derived_ordering(pkg):
        path = check_ordering(pkg, req, reach)
        if path is not None:
            err("ORDERING_VIOLATION", f"requirement {req.id}: path reaches {req.before} without "
                f"{' or '.join(req.requires)} (after last change to {req.invalidated_by or 'nothing'})",
                state=path[-1], clause=req.clause or None, detail={"path": path, "requirement": req.id})
    for sid, ic in C.interactions.items():
        st = m.states.get(sid)
        if ic.type != "approval" or st is None or st.action.kind != "user" or not st.action.writes:
            continue
        dvar = st.action.writes[0]
        enum = (C.variables.get(dvar).schema_ if dvar in C.variables else {}).get("enum") or []
        for i, t in enumerate(st.transitions):
            if t.to != ic.approves_state:
                continue
            weak = []
            for val in [v for v in enum if v != "approved"] + ["\u0000other"]:
                env = {**{v: 0 for v in types}, dvar: val}
                try:
                    if not t.cond or G.evaluate(t.cond, {k: env[k] for k in G.vars_of(t.cond)} if t.cond else {}):
                        weak.append(val)
                except G.GuardError:
                    weak.append(val)
            if weak:
                err("APPROVAL_GUARD_WEAK", f"{sid} edge {i} enters {ic.approves_state} for decision values "
                    f"{weak}; only 'approved' may", state=sid, edge=i)
    for tid, tc in C.terminals.items():
        if tc.category == "verified":
            if not tc.evidence:
                err("VERIFIED_WITHOUT_EVIDENCE", f"verified terminal {tid!r} declares no evidence requirement")
            for ev in tc.evidence:
                spec = catalog.get(ev.verifier_tool)
                if spec is None or ev.claim not in spec.verifier_claims:
                    err("UNAPPROVED_VERIFIER", f"{ev.verifier_tool!r} is not an approved verifier for {ev.claim!r}")
                for v in ev.subject_vars:
                    if v not in types:
                        err("UNKNOWN_VARIABLE", f"evidence subject {v!r} undeclared", variable=v)

    # ---- fallback / policy ----------------------------------------------------------------- #
    if P.write_workflow and P.fallback_mode != "stop_for_review":
        err("FALLBACK_MODE", "write workflows require fallback_mode = stop_for_review")
    fb = m.states.get(m.fallback)
    if fb is not None and P.fallback_mode == "stop_for_review":
        if fb.action.kind != "end":
            err("FALLBACK_NOT_REVIEW", "fallback state must be a review end state under stop_for_review",
                state=m.fallback)
        elif C.terminals.get(fb.action.terminal) and C.terminals[fb.action.terminal].category != "fallback":
            err("FALLBACK_NOT_REVIEW", "fallback terminal must have category 'fallback'", state=m.fallback)
    if m.max_steps > P.budgets.max_steps:
        err("BUDGET_EXCEEDS_POLICY", f"machine max_steps {m.max_steps} > policy {P.budgets.max_steps}")

    # ---- provenance ------------------------------------------------------------------------ #
    prov_sev = "error" if profile == "production" else "warning"
    clauses = {c.id: c for c in pkg.source_manifest.clauses}
    for c in clauses.values():
        if sha256_hex(c.text) != c.sha256:
            F.append(Finding("CLAUSE_HASH", f"clause {c.id} text does not match its hash", prov_sev, clause=c.id))
        if skill_text is not None and skill_text[c.start:c.end] != c.text:
            F.append(Finding("CLAUSE_QUOTE_MISMATCH", f"clause {c.id} text does not match source bytes", prov_sev,
                             clause=c.id))
    if skill_text is not None and sha256_hex(skill_text) != pkg.source_manifest.skill_sha256:
        F.append(Finding("SKILL_HASH", "skill source does not match the recorded hash", prov_sev))
    for sid, st in m.states.items():
        if st.clause and st.clause not in clauses:
            F.append(Finding("UNKNOWN_CLAUSE", f"{sid} references unknown clause {st.clause!r}", prov_sev, state=sid,
                             clause=st.clause))
    for cid, cov in C.clause_coverage.items():
        if cid not in clauses:
            F.append(Finding("UNKNOWN_CLAUSE", f"coverage for unknown clause {cid!r}", prov_sev, clause=cid))
        for s in cov.states:
            if s not in m.states:
                err("UNKNOWN_STATE", f"clause {cid} maps to unknown state {s!r}", clause=cid)
        if cov.critical and cov.classification == "unsupported":
            err("CRITICAL_CLAUSE_UNSUPPORTED", f"safety-critical clause {cid} is unsupported", clause=cid)
        if cov.classification == "executable_control" and not cov.states:
            err("COVERAGE_WITHOUT_STATES", f"clause {cid} claims executable control but maps to no state", clause=cid)
    for cid in clauses:
        if cid not in C.clause_coverage:
            F.append(Finding("CLAUSE_UNCLASSIFIED", f"clause {cid} has no coverage classification", prov_sev,
                             clause=cid))
    return ValidationReport(profile, pkg.artifact_hash, F, analyses)
