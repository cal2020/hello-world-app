"""Reader for the upstream ``efsm-v1`` machine format.

Field names and meanings follow the upstream schema (Worldbuilder013/HEXIS,
``src/hexis/machine/schema.py`` at 96be271): a machine has ``initial``,
``fallback``, ``states`` (each with exactly one ``action`` and ordered
``transitions``), ``variables`` and ``terminals``; action kinds are ``tool``,
``model``, ``judge``, ``user`` and ``end``; a transition uses ``if`` / ``to`` /
optional ``inc``.

This reader is an independent implementation (no upstream code is imported or
copied). It is stricter than upstream: unknown keys are rejected rather than
ignored, and ``state.id`` must equal its key. Production-only fields live in
the separate MachinePackage (see ``package.py``), never inside ``efsm-v1``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

FORMAT = "efsm-v1"
VAR_TYPES = {"string", "integer", "number", "boolean", "array", "object"}
ACTION_KINDS = {"tool", "model", "judge", "user", "end"}


class MachineFormatError(ValueError):
    def __init__(self, location: str, message: str):
        super().__init__(f"{location}: {message}")
        self.location = location
        self.message = message


def _expect(obj: Any, typ: type | tuple, loc: str) -> Any:
    if typ is int and isinstance(obj, bool):
        raise MachineFormatError(loc, "expected integer, got boolean")
    if not isinstance(obj, typ):
        raise MachineFormatError(loc, f"expected {getattr(typ, '__name__', typ)}, got {type(obj).__name__}")
    return obj


def _keys(obj: dict, allowed: set[str], required: set[str], loc: str) -> None:
    extra = set(obj) - allowed
    if extra:
        raise MachineFormatError(loc, f"unknown field(s) {sorted(extra)}")
    missing = required - set(obj)
    if missing:
        raise MachineFormatError(loc, f"missing field(s) {sorted(missing)}")


def _str_list(obj: Any, loc: str) -> list[str]:
    _expect(obj, list, loc)
    for i, item in enumerate(obj):
        _expect(item, str, f"{loc}[{i}]")
    return list(obj)


@dataclass(frozen=True)
class Variable:
    name: str
    type: str
    init: Any = None
    has_init: bool = False
    init_from: str | None = None
    description: str = ""


@dataclass(frozen=True)
class Action:
    kind: str
    name: str = ""                     # tool
    input: dict = field(default_factory=dict)  # tool input template
    prompt: str = ""
    reads: tuple[str, ...] = ()
    writes: tuple[str, ...] = ()
    binds: dict = field(default_factory=dict)  # tool output key -> variable
    labels: tuple[str, ...] = ()
    phase: str = ""
    introduced: bool = False
    observable: bool = False
    abstain: str = ""                  # judge
    terminal: str = ""                 # end


@dataclass(frozen=True)
class Transition:
    cond: str
    to: str
    inc: str | None = None
    origin: str = ""
    support: int = 0

    @property
    def is_default(self) -> bool:
        return self.cond == ""


@dataclass(frozen=True)
class State:
    id: str
    action: Action
    transitions: tuple[Transition, ...]
    clause: str = ""
    origin: str = ""
    locator: str = ""

    def ordered_transitions(self) -> list[Transition]:
        """Guarded edges in declaration order, then the default edge last."""
        return [t for t in self.transitions if not t.is_default] + [t for t in self.transitions if t.is_default]


@dataclass(frozen=True)
class Terminal:
    id: str
    kind: str = ""
    output: tuple[str, ...] = ()


@dataclass(frozen=True)
class Machine:
    skill_id: str
    initial: str
    fallback: str
    states: dict[str, State]
    variables: tuple[Variable, ...]
    terminals: tuple[Terminal, ...]
    version: str = "0.1.0"
    max_steps: int = 24
    audit_tools: tuple[str, ...] = ()
    raw: dict = field(default_factory=dict, compare=False, repr=False)

    def var(self, name: str) -> Variable | None:
        return next((v for v in self.variables if v.name == name), None)

    def terminal(self, tid: str) -> Terminal | None:
        return next((t for t in self.terminals if t.id == tid), None)

    def edges(self) -> list[tuple[str, Transition]]:
        return [(sid, t) for sid, s in self.states.items() for t in s.transitions]


_VAR_KEYS = {"name", "type", "init", "init_from", "description"}
_ACTION_KEYS = {
    "tool": {"kind", "name", "input", "reads", "writes", "binds", "labels", "phase"},
    "model": {"kind", "prompt", "reads", "writes", "introduced", "observable", "labels"},
    "judge": {"kind", "prompt", "reads", "writes", "labels", "abstain", "examples"},
    "user": {"kind", "prompt", "reads", "writes", "labels"},
    "end": {"kind", "terminal"},
}
_STATE_KEYS = {"id", "clause", "action", "transitions", "origin", "locator"}
_EDGE_KEYS = {"if", "to", "inc", "support", "origin"}
_TERMINAL_KEYS = {"id", "kind", "output"}
_MACHINE_KEYS = {
    "format", "skill_id", "version", "initial", "fallback", "max_steps", "states", "variables",
    "terminals", "prohibitions", "thresholds", "audit_tools", "phase_rules",
}


def _parse_action(obj: Any, loc: str) -> Action:
    _expect(obj, dict, loc)
    kind = obj.get("kind")
    if kind not in ACTION_KINDS:
        raise MachineFormatError(f"{loc}.kind", f"unknown action kind {kind!r}")
    _keys(obj, _ACTION_KEYS[kind], {"kind"}, loc)
    if kind == "end":
        return Action(kind="end", terminal=_expect(obj.get("terminal"), str, f"{loc}.terminal"))
    reads = tuple(_str_list(obj.get("reads", []), f"{loc}.reads"))
    writes = tuple(_str_list(obj.get("writes", []), f"{loc}.writes"))
    labels = tuple(_str_list(obj.get("labels", []), f"{loc}.labels"))
    prompt = _expect(obj.get("prompt", ""), str, f"{loc}.prompt")
    if kind == "tool":
        binds = _expect(obj.get("binds", {}), dict, f"{loc}.binds")
        for k, v in binds.items():
            _expect(v, str, f"{loc}.binds.{k}")
        return Action(
            kind="tool", name=_expect(obj.get("name"), str, f"{loc}.name"),
            input=_expect(obj.get("input", {}), dict, f"{loc}.input"),
            reads=reads, writes=writes, binds=dict(binds), labels=labels,
            phase=_expect(obj.get("phase", ""), str, f"{loc}.phase"),
        )
    if kind == "judge":
        if not labels:
            raise MachineFormatError(f"{loc}.labels", "a judge needs a finite label set")
        abstain = _expect(obj.get("abstain", ""), str, f"{loc}.abstain")
        if not abstain or abstain not in labels:
            raise MachineFormatError(f"{loc}.abstain", "a judge needs an explicit abstain label that is in labels")
        return Action(kind="judge", prompt=prompt, reads=reads, writes=writes, labels=labels, abstain=abstain)
    if kind == "model":
        return Action(
            kind="model", prompt=prompt, reads=reads, writes=writes, labels=labels,
            introduced=_expect(obj.get("introduced", False), bool, f"{loc}.introduced"),
            observable=_expect(obj.get("observable", False), bool, f"{loc}.observable"),
        )
    return Action(kind="user", prompt=prompt, reads=reads, writes=writes, labels=labels)


def parse_machine(obj: Any) -> Machine:
    _expect(obj, dict, "machine")
    if obj.get("format") != FORMAT:
        raise MachineFormatError("machine.format", f"expected {FORMAT!r}, got {obj.get('format')!r}")
    _keys(obj, _MACHINE_KEYS, {"format", "skill_id", "initial", "states"}, "machine")

    variables: list[Variable] = []
    for i, v in enumerate(_expect(obj.get("variables", []), list, "machine.variables")):
        loc = f"machine.variables[{i}]"
        _expect(v, dict, loc)
        _keys(v, _VAR_KEYS, {"name", "type"}, loc)
        if v["type"] not in VAR_TYPES:
            raise MachineFormatError(f"{loc}.type", f"unknown type {v['type']!r}")
        if "init" in v and v.get("init_from") is not None:
            raise MachineFormatError(loc, "give only one of init and init_from")
        variables.append(Variable(
            name=_expect(v["name"], str, f"{loc}.name"), type=v["type"], init=v.get("init"),
            has_init="init" in v, init_from=v.get("init_from"), description=v.get("description", ""),
        ))

    states: dict[str, State] = {}
    for sid, s in _expect(obj["states"], dict, "machine.states").items():
        loc = f"states.{sid}"
        _expect(s, dict, loc)
        _keys(s, _STATE_KEYS, {"id", "action"}, loc)
        if s["id"] != sid:
            raise MachineFormatError(f"{loc}.id", f"state id {s['id']!r} does not match its key")
        edges = []
        for j, t in enumerate(_expect(s.get("transitions", []), list, f"{loc}.transitions")):
            eloc = f"{loc}.transitions[{j}]"
            _expect(t, dict, eloc)
            _keys(t, _EDGE_KEYS, {"to"}, eloc)
            inc = t.get("inc")
            if inc is not None:
                _expect(inc, str, f"{eloc}.inc")
            edges.append(Transition(
                cond=_expect(t.get("if", ""), str, f"{eloc}.if"), to=_expect(t["to"], str, f"{eloc}.to"),
                inc=inc or None, origin=t.get("origin", ""), support=t.get("support", 0),
            ))
        states[sid] = State(
            id=sid, action=_parse_action(s["action"], f"{loc}.action"), transitions=tuple(edges),
            clause=_expect(s.get("clause", ""), str, f"{loc}.clause"), origin=s.get("origin", ""),
            locator=s.get("locator", ""),
        )

    terminals = []
    for i, t in enumerate(_expect(obj.get("terminals", []), list, "machine.terminals")):
        loc = f"machine.terminals[{i}]"
        _expect(t, dict, loc)
        _keys(t, _TERMINAL_KEYS, {"id"}, loc)
        terminals.append(Terminal(id=_expect(t["id"], str, f"{loc}.id"), kind=t.get("kind", ""),
                                  output=tuple(_str_list(t.get("output", []), f"{loc}.output"))))

    max_steps = obj.get("max_steps", 24)
    _expect(max_steps, int, "machine.max_steps")
    return Machine(
        skill_id=_expect(obj["skill_id"], str, "machine.skill_id"),
        initial=_expect(obj["initial"], str, "machine.initial"),
        fallback=_expect(obj.get("fallback", "FALLBACK"), str, "machine.fallback"),
        states=states, variables=tuple(variables), terminals=tuple(terminals),
        version=obj.get("version", "0.1.0"), max_steps=max_steps,
        audit_tools=tuple(_str_list(obj.get("audit_tools", []), "machine.audit_tools")),
        raw=obj,
    )
