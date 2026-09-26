"""Trusted, versioned tool catalog: names, schemas, side-effect classes, capabilities.

The catalog is data owned by the platform, not by the compiler. Its canonical digest is recorded
in every package's source manifest; a schema change is a new catalog and therefore a new artifact.
"""

from __future__ import annotations

from typing import Literal

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field

from ..canonical import digest

Effect = Literal["read", "pure", "idempotent_write", "reconciliable_write", "non_idempotent_write"]
WRITE_EFFECTS = ("idempotent_write", "reconciliable_write", "non_idempotent_write")


class ToolSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    version: str
    description: str = ""
    input_schema: dict
    output_schema: dict
    effect: Effect
    capability: str
    # Claims this tool is an approved verifier for (e.g. "persisted_draft_matches_approved_payload").
    verifier_claims: list[str] = Field(default_factory=list)
    # Output field naming the external business reference used for reconciliation.
    business_reference_field: str = ""

    @property
    def is_write(self) -> bool:
        return self.effect in WRITE_EFFECTS


class ToolCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    catalog_id: str
    version: str
    tools: dict[str, ToolSpec]

    def digest(self) -> str:
        return digest(self.model_dump(mode="json"))

    def get(self, name: str) -> ToolSpec | None:
        return self.tools.get(name)

    def check_schemas(self) -> list[str]:
        errs = []
        for t in self.tools.values():
            for label, sch in (("input", t.input_schema), ("output", t.output_schema)):
                try:
                    Draft202012Validator.check_schema(sch)
                except Exception as exc:  # noqa: BLE001
                    errs.append(f"{t.name}.{label}_schema invalid: {exc}")
        return errs


def validate_against(schema: dict, value: object) -> list[str]:
    """JSON Schema 2020-12 validation returning readable errors (empty list = valid)."""
    v = Draft202012Validator(schema)
    return [f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
            for e in sorted(v.iter_errors(value), key=lambda e: list(e.absolute_path))]
