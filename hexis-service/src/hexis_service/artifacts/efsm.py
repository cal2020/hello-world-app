"""Reader for the upstream ``efsm-v1`` interchange format.

Written against the field names and semantics observed in Worldbuilder013/HEXIS at commit
96be2719ee79fc5071dc7eb2aeed816dc03aaa6c (``src/hexis/machine/schema.py``). No upstream code is
copied here; see docs/SOURCES.md for the license note.

Every field upstream defines is accepted so upstream artifacts load, but unknown fields are
rejected (``extra="forbid"``): production extensions live in :mod:`hexis_service.artifacts.package`,
never as silent additions to ``efsm-v1``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Union

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

FALLBACK = "FALLBACK"
ABSTAIN = "abstain"
LEGACY_ABSTAIN = "弃权"  # upstream's earlier abstain label
ABSTAIN_LABELS = (ABSTAIN, LEGACY_ABSTAIN)

VarType = Literal["string", "integer", "number", "boolean", "array", "object"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Variable(_Strict):
    name: str
    type: VarType = "string"
    # Upstream semantics: init=None means "no literal initial value" (unset), not an explicit null.
    init: Optional[Any] = None
    init_from: Optional[str] = None

    @model_validator(mode="after")
    def _init_xor(self) -> "Variable":
        if self.init is not None and self.init_from is not None:
            raise ValueError(f"variable {self.name}: give only one of init and init_from")
        return self


class ToolAction(_Strict):
    kind: Literal["tool"] = "tool"
    name: str
    input: dict = Field(default_factory=dict)
    reads: list[str] = Field(default_factory=list)
    writes: list[str] = Field(default_factory=list)
    phase: str = ""
    labels: list[str] = Field(default_factory=list)
    binds: dict[str, str] = Field(default_factory=dict)


class ModelAction(_Strict):
    kind: Literal["model"] = "model"
    prompt: str
    reads: list[str] = Field(default_factory=list)
    writes: list[str] = Field(default_factory=list)
    introduced: bool = False
    observable: bool = False
    labels: list[str] = Field(default_factory=list)


class Example(BaseModel):
    model_config = ConfigDict(extra="allow")
    label: str


class JudgeAction(_Strict):
    kind: Literal["judge"] = "judge"
    prompt: str = Field(validation_alias=AliasChoices("prompt", "question"))
    reads: list[str]
    writes: list[str]
    labels: list[str]
    abstain: str = ABSTAIN
    examples: list[Example] = Field(default_factory=list)
    error_rate: float = 0.0
    support: int = 0
    introduced: bool = False
    gold_from: str = ""

    @model_validator(mode="before")
    @classmethod
    def _default_abstain(cls, data: Any) -> Any:
        if isinstance(data, dict) and not data.get("abstain"):
            labels = list(data.get("labels") or ())
            found = next((lab for lab in reversed(labels) if lab in ABSTAIN_LABELS), "")
            data = {**data, "abstain": found or ABSTAIN}
        return data

    @model_validator(mode="after")
    def _checks(self) -> "JudgeAction":
        if self.abstain not in self.labels:
            raise ValueError(f"judge abstain label {self.abstain!r} must be in labels")
        if not self.reads or not self.writes:
            raise ValueError("a judge action needs non-empty reads and writes")
        if len(self.writes) != 1:
            raise ValueError("a judge action writes exactly one label variable")
        return self


class UserAction(_Strict):
    kind: Literal["user"] = "user"
    prompt: str = ""
    reads: list[str] = Field(default_factory=list)
    writes: list[str] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)


class EndAction(_Strict):
    kind: Literal["end"] = "end"
    terminal: str


Action = Annotated[Union[ToolAction, ModelAction, JudgeAction, UserAction, EndAction], Field(discriminator="kind")]


class Transition(_Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    cond: str = Field(default="", alias="if")
    to: str
    inc: Optional[str] = None
    support: int = 0
    origin: str = ""


class State(_Strict):
    id: str
    clause: str = ""
    action: Action
    transitions: list[Transition] = Field(default_factory=list)
    origin: str = ""
    locator: str = ""

    def ordered_transitions(self) -> list[Transition]:
        """Upstream priority: guarded edges in declaration order, then the default edge."""
        return [t for t in self.transitions if t.cond] + [t for t in self.transitions if not t.cond]


class Terminal(_Strict):
    id: str
    kind: str = ""
    output: list[str] = Field(default_factory=list)


class Prohibition(_Strict):
    id: str
    check: Literal["absent", "present", "regex", "forbid_action", "require_before"]
    pattern: Any


class Thresholds(_Strict):
    min_support: int = 2
    holdout_ratio: float = 0.2
    acc_thr: float = 0.9
    retry_budget: int = 3
    loop_margin: float = 1.5
    fallback_rate_target: float = 0.15
    judge_rewrite_max: int = 2
    judge_err_max: float = 0.2


class Machine(_Strict):
    format: Literal["efsm-v1"] = "efsm-v1"
    skill_id: str
    version: str = "0.1.0"
    initial: str
    fallback: str = FALLBACK
    max_steps: int = 24
    states: dict[str, State] = Field(default_factory=dict)
    variables: list[Variable] = Field(default_factory=list)
    terminals: list[Terminal] = Field(default_factory=list)
    prohibitions: list[Prohibition] = Field(default_factory=list)
    thresholds: Thresholds = Field(default_factory=Thresholds)
    audit_tools: list[str] = Field(default_factory=list)
    phase_rules: str = ""

    def var(self, name: str) -> Optional[Variable]:
        return next((v for v in self.variables if v.name == name), None)

    def var_types(self) -> dict[str, str]:
        return {v.name: v.type for v in self.variables}

    def terminal(self, tid: str) -> Optional[Terminal]:
        return next((t for t in self.terminals if t.id == tid), None)

    def to_json(self) -> dict:
        """Serialize using upstream key names (``if`` for guards); transition order is preserved."""
        return self.model_dump(mode="json", by_alias=True)


def load_machine(data: dict) -> Machine:
    if not isinstance(data, dict) or data.get("format") != "efsm-v1":
        raise ValueError(f"not an efsm-v1 machine (format={data.get('format') if isinstance(data, dict) else None!r})")
    return Machine.model_validate(data)
