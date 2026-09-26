"""Export the versioned record contracts as JSON Schema (Draft 2020-12) into ``schemas/``.

Run ``python -m hexis_service.schemas_export``; tests fail if the committed files drift.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .artifacts.efsm import Machine
from .artifacts.package import AdmissionRecord, MachinePackage
from .runtime.kernel import Observation, RunCheckpoint
from .tools.catalog import ToolCatalog
from .traces.model import Record, Trace
from .traces.normalize import NormalizedEvent

SCHEMAS = {
    "efsm-v1.machine.schema.json": Machine,
    "machine-package.schema.json": MachinePackage,
    "admission-record.schema.json": AdmissionRecord,
    "run-checkpoint.schema.json": RunCheckpoint,
    "observation.schema.json": Observation,
    "tool-catalog.schema.json": ToolCatalog,
    "trace.schema.json": Trace,
    "trace-record.schema.json": Record,
    "normalized-event.schema.json": NormalizedEvent,
}


def render() -> dict[str, str]:
    out = {}
    for name, model in SCHEMAS.items():
        s = model.model_json_schema(by_alias=True)
        s = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": f"hexis-service/{name}", **s}
        out[name] = json.dumps(s, indent=2, sort_keys=True) + "\n"
    return out


def main(target: str = "schemas") -> None:
    d = Path(target)
    d.mkdir(exist_ok=True)
    for name, text in render().items():
        (d / name).write_text(text)


if __name__ == "__main__":
    main(*sys.argv[1:])
