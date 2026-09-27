"""Static admission checks for a MachinePackage (brief section 8, "Mandatory static checks").

Every finding carries a stable code, a severity and an exact location
(``state:<id>``, ``edge:<state>[<index>]``, ``variable:<name>``,
``clause:<id>``, ``terminal:<id>``). Any ``error`` blocks admission.
Guard disjointness results are reported as PROVEN / COUNTEREXAMPLE /
UNKNOWN; in the production profile UNKNOWN is an error, never a proof.
"""
from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field, asdict
from typing import Iterable

from . import guards as G
from .machine import Machine
from .package import LoadedPackage, WRITE_EFFECTS, OWNERS

VALIDATOR_VERSION = "hexis_service.validator/1"
PLACEHOLDER = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")
ANY_PLACEHOLDER = re.compile(r"\$\{([^}]*)\}")


@dataclass
class Finding:
    code: str
    location: str
    message: str
    severity: str = "error"
    detail: dict = field(default_factory=dict)


@dataclass
class ValidationReport:
    profile: str
    findings: list[Finding]
    guard_analysis: list[dict]
    validator_version: str = VALIDATOR_VERSION

    @property
    def ok(self) -> bool:
        return not any(f.severity == "error" for f in self.findings)

    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    def codes(self) -> set[str]:
        return {f.code for f in self.findings}

    def to_dict(self) -> dict:
        return {"profile": self.profile, "ok": self.ok, "validator_version": self.validator_version,
                "findings": [asdict(f) for f in self.findings], "guard_analysis": self.guard_analysis}


# ---------------------------------------------------------------- graph ---
def successors(m: Machine, sid: str, removed: set[str] | frozenset = frozenset()) -> list[str]:
    """Declared targets plus the kernel's implicit edge to the fallback state, which any
    model/judge/user state takes on invalid output."""
    s = m.states.get(sid)
    if not s:
        return []
    out = [t.to for t in s.transitions if t.to in m.states and t.to not in removed]
    if s.action.kind in ("model", "judge", "user") and m.fallback in m.states and m.fallback not in removed \
            and m.fallback not in out:
        out.append(m.fallback)
    return out


def reachable(m: Machine, start: str, removed: set[str] | frozenset = frozenset()) -> set[str]:
    if start not in m.states or start in removed:
        return set()
    seen, q = {start}, deque([start])
    while q:
        for n in successors(m, q.popleft(), removed):
            if n not in seen:
                seen.add(n)
                q.append(n)
    return seen


def find_path(m: Machine, start: str, goal: str, removed: set[str]) -> list[str] | None:
    if start in removed or start not in m.states:
        return None
    prev: dict[str, str | None] = {start: None}
    q = deque([start])
    while q:
        cur = q.popleft()
        if cur == goal:
            path = []
            while cur is not None:
                path.append(cur)
                cur = prev[cur]
            return list(reversed(path))
        for n in successors(m, cur, removed):
            if n not in prev:
                prev[n] = cur
                q.append(n)
    return None


def sccs(nodes: Iterable[str], succ) -> list[list[str]]:
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on: set[str] = set()
    out: list[list[str]] = []
    counter = [0]

    def strong(v: str) -> None:
        # iterative Tarjan to avoid recursion limits on large machines
        work = [(v, iter(succ(v)))]
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        while work:
            node, it = work[-1]
            advanced = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on.add(w)
                    work.append((w, iter(succ(w))))
                    advanced = True
                    break
                if w in on:
                    low[node] = min(low[node], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            if low[node] == index[node]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == node:
                        break
                out.append(comp)

    for n in nodes:
        if n not in index:
            strong(n)
    return out


def template_vars(template) -> list[str]:
    """Placeholder names in a tool input template. Only whole-value ``${var}`` is allowed."""
    found: list[str] = []

    def walk(v):
        if isinstance(v, str):
            for name in ANY_PLACEHOLDER.findall(v):
                found.append(name)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(template)
    return found


def _partial_placeholders(template) -> list[str]:
    bad: list[str] = []

    def walk(v):
        if isinstance(v, str):
            if ANY_PLACEHOLDER.search(v) and not PLACEHOLDER.match(v):
                bad.append(v)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(template)
    return bad


# ------------------------------------------------------------ validator ---
def validate_package(pkg: LoadedPackage, profile: str = "production") -> ValidationReport:
    m = pkg.machine
    F: list[Finding] = []
    analysis: list[dict] = []
    add = lambda code, loc, msg, sev="error", **d: F.append(Finding(code, loc, msg, sev, d))  # noqa: E731
    contracts = pkg.contracts
    policy = pkg.policy
    var_types = pkg.var_types()
    var_contracts = contracts.get("variables", {})
    terminal_contracts = contracts.get("terminals", {})
    loop_bounds = contracts.get("loop_bounds", {})
    clause_ids = {c["id"] for c in pkg.raw["source_manifest"].get("clauses", [])}

    # ---- structure
    names_seen: set[str] = set()
    for v in m.variables:
        if v.name in names_seen:
            add("DUPLICATE_VARIABLE", f"variable:{v.name}", "variable declared twice")
        names_seen.add(v.name)
    tids = [t.id for t in m.terminals]
    for t in set(x for x in tids if tids.count(x) > 1):
        add("DUPLICATE_TERMINAL", f"terminal:{t}", "terminal declared twice")
    if m.initial not in m.states:
        add("UNKNOWN_STATE", "machine.initial", f"initial state {m.initial!r} does not exist")
    if m.fallback not in m.states:
        add("UNKNOWN_STATE", "machine.fallback", f"fallback state {m.fallback!r} does not exist")
    for sid, s in m.states.items():
        for i, t in enumerate(s.transitions):
            if t.to not in m.states:
                add("UNKNOWN_STATE", f"edge:{sid}[{i}]", f"transition target {t.to!r} does not exist")
        if s.action.kind == "end":
            if s.transitions:
                add("TERMINAL_HAS_EDGES", f"state:{sid}", "end states must have no outgoing transitions")
            if m.terminal(s.action.terminal) is None:
                add("UNKNOWN_TERMINAL", f"state:{sid}", f"terminal {s.action.terminal!r} is not declared")
        elif not s.transitions:
            add("NO_TRANSITIONS", f"state:{sid}", "non-terminal state has no outgoing transitions")
        for name in list(s.action.reads) + list(s.action.writes):
            if name not in var_types:
                add("UNKNOWN_VARIABLE", f"state:{sid}", f"variable {name!r} is not declared")
        if s.clause and s.clause not in clause_ids:
            add("UNKNOWN_CLAUSE", f"state:{sid}", f"clause {s.clause!r} does not resolve to the source index")
        if s.action.kind == "tool" and s.action.name not in pkg.catalog:
            add("UNKNOWN_TOOL", f"state:{sid}", f"tool {s.action.name!r} is not in the trusted catalog")
    for t in m.terminals:
        for o in t.output:
            if o not in var_types:
                add("UNKNOWN_VARIABLE", f"terminal:{t.id}", f"terminal output {o!r} is not declared")

    if any(f.code in ("UNKNOWN_STATE",) for f in F) and m.initial not in m.states:
        return ValidationReport(profile, F, analysis)

    # ---- reachability
    reach = reachable(m, m.initial)
    for sid in m.states:
        if sid not in reach and sid != m.fallback:
            add("UNREACHABLE_STATE", f"state:{sid}", "state is not reachable from the initial state")
    ends = {sid for sid, s in m.states.items() if s.action.kind == "end"}
    for sid in reach:
        if not (reachable(m, sid) & ends):
            add("NO_STOP_ROUTE", f"state:{sid}", "no route from this state to any terminal")

    # ---- ownership contracts
    for v in m.variables:
        vc = var_contracts.get(v.name)
        if vc is None:
            if profile == "production":
                add("MISSING_VARIABLE_CONTRACT", f"variable:{v.name}", "no ownership contract declared")
            continue
        if vc.get("owner") not in OWNERS:
            add("BAD_OWNER", f"variable:{v.name}", f"owner {vc.get('owner')!r} is not one of {sorted(OWNERS)}")
        if "enum" in vc and vc["enum"] != pkg.var_schema(v.name).get("enum"):
            add("ENUM_NOT_ENFORCED", f"variable:{v.name}", "contract enum differs from the enforced schema enum")
        if v.init_from and vc.get("owner") != "task":
            add("BAD_OWNER", f"variable:{v.name}", "init_from variables must be task-owned")
    expected_owner = {"model": "model", "judge": "model", "tool": "tool", "user": "user"}
    for sid, s in m.states.items():
        want = expected_owner.get(s.action.kind)
        for w in s.action.writes:
            owner = var_contracts.get(w, {}).get("owner")
            if want and owner and owner != want:
                add("WRITE_OWNERSHIP", f"state:{sid}",
                    f"{s.action.kind} state writes {w!r} owned by {owner!r}", variable=w)
        for i, t in enumerate(s.transitions):
            if t.inc:
                if var_contracts.get(t.inc, {}).get("owner") != "engine" or var_types.get(t.inc) != "integer":
                    add("BAD_COUNTER", f"edge:{sid}[{i}]", f"inc target {t.inc!r} must be an engine-owned integer")
                if t.inc not in loop_bounds:
                    add("UNBOUNDED_COUNTER", f"edge:{sid}[{i}]", f"counter {t.inc!r} has no declared loop bound")

    # ---- judge label contract
    for sid, s in m.states.items():
        if s.action.kind == "judge":
            if len(s.action.writes) != 1:
                add("JUDGE_OUTPUT", f"state:{sid}", "a judge writes exactly one label variable")
            else:
                enum = pkg.enums().get(s.action.writes[0])
                if enum is None or set(enum) != set(s.action.labels):
                    add("JUDGE_OUTPUT", f"state:{sid}", "judge output variable enum must equal its label set")

    # ---- dataflow (definite assignment over reachable graph)
    init = {v.name for v in m.variables if v.has_init or v.init_from}
    all_vars = set(var_types)
    IN: dict[str, set[str]] = {sid: set(all_vars) for sid in reach}
    if m.initial in reach:
        IN[m.initial] = set(init)
    preds: dict[str, list[str]] = {sid: [] for sid in reach}
    for sid in reach:
        for n in successors(m, sid):
            if n in preds:
                preds[n].append(sid)
    out = lambda sid: IN[sid] | set(m.states[sid].action.writes)  # noqa: E731
    changed = True
    while changed:
        changed = False
        for sid in reach:
            ps = [out(p) for p in preds[sid]]
            new = set.intersection(*ps) if ps else set(all_vars)
            if sid == m.initial:
                new = new & init if ps else set(init)
            if new != IN[sid]:
                IN[sid] = new
                changed = True
    for sid in reach:
        s = m.states[sid]
        for r in s.action.reads:
            if r in var_types and r not in IN[sid]:
                path_note = [p for p in preds[sid] if r not in out(p)]
                add("READ_NOT_ASSIGNED", f"state:{sid}", f"read {r!r} is not assigned on every incoming path",
                    variable=r, unassigned_predecessors=sorted(path_note))
        if s.action.kind == "tool":
            for bad in _partial_placeholders(s.action.input):
                add("TEMPLATE_PARTIAL", f"state:{sid}", f"placeholder must be the whole value, got {bad!r}")
            for name in template_vars(s.action.input):
                if name not in s.action.reads:
                    add("TEMPLATE_VAR_UNDECLARED", f"state:{sid}", f"template variable {name!r} is not in reads")
        if s.action.kind == "end":
            term = m.terminal(s.action.terminal)
            for o in (term.output if term else ()):
                if o not in IN[sid]:
                    add("TERMINAL_OUTPUT_UNASSIGNED", f"state:{sid}", f"terminal output {o!r} may be unassigned")
        for i, t in enumerate(s.transitions):
            if not t.cond:
                continue
            try:
                used = G.names(t.cond)
            except G.GuardError:
                continue
            for name in used:
                if name in var_types and name not in out(sid):
                    add("GUARD_READ_NOT_ASSIGNED", f"edge:{sid}[{i}]", f"guard reads {name!r} which may be unassigned")

    # ---- guards
    enums = pkg.enums()
    for sid, s in m.states.items():
        defaults = [i for i, t in enumerate(s.transitions) if t.is_default]
        if len(defaults) > 1:
            add("MULTIPLE_DEFAULTS", f"state:{sid}", "more than one unconditional default edge")
        if defaults and defaults[-1] != len(s.transitions) - 1:
            add("DEFAULT_NOT_LAST", f"state:{sid}", "the default edge must be serialized last")
        if s.action.kind != "end" and s.transitions and not defaults:
            add("DEFAULT_MISSING", f"state:{sid}", "non-terminal state has no safe default edge")
        guarded = []
        for i, t in enumerate(s.transitions):
            if t.is_default:
                continue
            try:
                G.typecheck(t.cond, var_types)
                guarded.append((i, t.cond))
            except G.GuardError as exc:
                add("GUARD_INVALID", f"edge:{sid}[{i}]", str(exc), guard=t.cond)
        for a in range(len(guarded)):
            for b in range(a + 1, len(guarded)):
                (ia, ga), (ib, gb) = guarded[a], guarded[b]
                res = G.disjoint(ga, gb, var_types, enums)
                analysis.append({"state": sid, "edges": [ia, ib], "result": res.result, "detail": res.detail,
                                 "witness": res.witness})
                if res.result == G.COUNTEREXAMPLE:
                    add("GUARD_OVERLAP", f"state:{sid}", f"edges {ia} and {ib} can both be enabled",
                        witness=res.witness)
                elif res.result == G.UNKNOWN:
                    add("GUARD_ANALYSIS_UNKNOWN", f"state:{sid}", f"cannot prove edges {ia} and {ib} disjoint: "
                        f"{res.detail}", severity="error" if profile == "production" else "warning")

    # ---- tool contracts
    ceiling = set(policy.get("capability_ceiling", []))
    for sid, s in m.states.items():
        if s.action.kind != "tool" or s.action.name not in pkg.catalog:
            continue
        spec = pkg.catalog[s.action.name]
        if spec.capability not in ceiling:
            add("CAPABILITY_EXCEEDS_CEILING", f"state:{sid}", f"{spec.name} needs {spec.capability!r}")
        out_props = spec.output_schema.get("properties", {})
        for key, var in s.action.binds.items():
            if key not in out_props:
                add("BIND_UNKNOWN_OUTPUT", f"state:{sid}", f"bind source {key!r} is not a {spec.name} output")
            if var not in s.action.writes:
                add("BIND_NOT_WRITTEN", f"state:{sid}", f"bind target {var!r} is not in writes")
        for w in s.action.writes:
            if w not in s.action.binds.values():
                add("WRITE_WITHOUT_BIND", f"state:{sid}", f"write {w!r} has no output binding")
        in_schema = spec.input_schema
        for req in in_schema.get("required", []):
            if req not in s.action.input:
                add("TOOL_INPUT_MISSING", f"state:{sid}", f"required input {req!r} missing from template")
        if in_schema.get("additionalProperties") is False:
            for k in s.action.input:
                if k not in in_schema.get("properties", {}):
                    add("TOOL_INPUT_UNKNOWN", f"state:{sid}", f"input {k!r} is not accepted by {spec.name}")

    # ---- ordering (mandatory predecessors cannot be bypassed)
    for rule in contracts.get("ordering", []):
        target = rule["state"]
        for before in rule["before"]:
            if target not in m.states or before not in m.states:
                add("ORDERING_UNRESOLVED", f"rule:{rule.get('id')}", f"{before}->{target} references a missing state")
                continue
            path = find_path(m, m.initial, target, {before})
            if path:
                add("ORDERING_BYPASS", f"rule:{rule.get('id')}",
                    f"{target} is reachable without passing {before}", path=path, clause=rule.get("clause"))
    # Any state calling a write tool must be covered by an ordering rule naming approval.
    approval_states = {sid for sid, s in m.states.items() if s.action.kind == "user" and "approval" in s.action.labels}
    for sid, s in m.states.items():
        if s.action.kind == "tool" and s.action.name in pkg.catalog and pkg.catalog[s.action.name].effect in WRITE_EFFECTS:
            if s.action.name in contracts.get("approval_required_tools", []):
                path = find_path(m, m.initial, sid, approval_states)
                if path:
                    add("WRITE_WITHOUT_APPROVAL", f"state:{sid}", "write reachable without an approval state",
                        path=path)

    # ---- evidence
    verifier_tools = {n for n, t in pkg.catalog.items() if t.verifier}
    for sid, s in m.states.items():
        if s.action.kind != "end":
            continue
        term = m.terminal(s.action.terminal)
        if not term or term.kind != "verified":
            continue
        req = terminal_contracts.get(term.id, {}).get("required_evidence", [])
        if not req:
            add("VERIFIED_WITHOUT_EVIDENCE", f"terminal:{term.id}", "verified terminal declares no required evidence")
            continue
        for tool in req:
            if tool not in verifier_tools:
                add("EVIDENCE_NOT_VERIFIER", f"terminal:{term.id}", f"{tool!r} is not an approved verifier")
                continue
            vstates = {x for x, st in m.states.items() if st.action.kind == "tool" and st.action.name == tool}
            path = find_path(m, m.initial, sid, vstates)
            if path:
                add("EVIDENCE_BYPASS", f"terminal:{term.id}", f"reachable without running {tool}", path=path)
            for wid, ws in m.states.items():
                if ws.action.kind == "tool" and ws.action.name in pkg.catalog and pkg.catalog[ws.action.name].is_write:
                    stale = find_path(m, wid, sid, vstates - {wid})
                    if stale and wid in reach:
                        add("EVIDENCE_STALE_PATH", f"terminal:{term.id}",
                            f"write {wid} can reach the verified terminal without re-verification", path=stale)

    # ---- loops
    ceiling_bound = policy.get("max_loop_bound")
    for counter, bound in loop_bounds.items():
        if not isinstance(bound, int) or isinstance(bound, bool) or bound < 0:
            add("BAD_LOOP_BOUND", f"variable:{counter}", "loop bound must be a non-negative integer")
        elif ceiling_bound is not None and bound > ceiling_bound:
            add("LOOP_BOUND_ABOVE_CEILING", f"variable:{counter}", f"bound {bound} exceeds operator ceiling {ceiling_bound}")
    for comp in sccs(list(reach), lambda v: [n for n in successors(m, v) if n in reach]):
        cs = set(comp)
        self_loop = len(comp) == 1 and comp[0] in successors(m, comp[0])
        if len(comp) < 2 and not self_loop:
            continue

        def succ_unbounded(v: str) -> list[str]:
            out = [t.to for t in m.states[v].transitions if t.to in cs and not (t.inc and t.inc in loop_bounds)]
            if m.fallback in cs and m.fallback in successors(m, v) and m.fallback not in out:
                out.append(m.fallback)  # implicit fallback edge carries no counter
            return out

        for inner in sccs(comp, succ_unbounded):
            inner_self = len(inner) == 1 and inner[0] in succ_unbounded(inner[0])
            if len(inner) > 1 or inner_self:
                add("UNBOUNDED_CYCLE", f"state:{sorted(inner)[0]}",
                    "cycle has no bounded counter increment on every loop", states=sorted(inner))

    # ---- provenance and coverage
    for clause in pkg.raw["source_manifest"].get("clauses", []):
        cov = clause.get("coverage", {})
        if clause.get("critical") and cov.get("classification") == "unsupported":
            add("CRITICAL_CLAUSE_UNSUPPORTED", f"clause:{clause['id']}", "safety-critical clause is not executable")
        if clause.get("critical") and cov.get("classification") == "executable_control":
            covered = any(st.clause == clause["id"] for st in m.states.values()) or any(
                r.get("clause") == clause["id"] for r in contracts.get("ordering", []))
            if not covered:
                add("CLAUSE_COVERAGE_LOST", f"clause:{clause['id']}", "protected clause is not covered by any state or rule")

    # ---- fallback policy
    if profile == "production":
        if policy.get("fallback_mode") != "stop_for_review":
            add("FALLBACK_MODE", "execution_policy.fallback_mode", "production write workflows require stop_for_review")
        if m.fallback in m.states:
            for x in reachable(m, m.fallback):
                st = m.states[x]
                if st.action.kind == "tool" and st.action.name in pkg.catalog and pkg.catalog[st.action.name].is_write:
                    add("FALLBACK_WRITES", f"state:{x}", "a write is reachable from the fallback state")

    return ValidationReport(profile, F, analysis)
