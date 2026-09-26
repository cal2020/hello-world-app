"""Restricted model adapter interface (brief §7.3).

A model sees only: the state's local instruction, declared readable variables, and the exact output
schema. It has no tool access, no machine, no history, and cannot write authority fields (the kernel
rejects undeclared keys and engine-owned writes).
"""

from __future__ import annotations

from typing import Any, Literal, Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field


class ModelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["model", "judge"]
    state_id: str
    prompt: str
    inputs: dict[str, Any]
    output_schema: dict
    labels: list[str] = Field(default_factory=list)
    repair_feedback: str = ""


class ModelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    output: Optional[dict] = None  # None = could not parse structured output
    raw_text: str = ""
    model_id: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: Optional[float] = None  # unknown stays unknown, never 0


class ModelUnavailable(Exception):
    pass


class ModelAdapter(Protocol):
    model_id: str

    def generate(self, request: ModelRequest) -> ModelResponse: ...


def output_schema_for(writes: list[str], var_schemas: dict[str, dict], labels: Optional[list[str]] = None) -> dict:
    props = {w: (({"enum": labels}) if labels else var_schemas.get(w, {})) for w in writes}
    return {"type": "object", "additionalProperties": False, "required": list(writes), "properties": props}
