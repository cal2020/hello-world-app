"""A strict validator for a documented subset of JSON Schema Draft 2020-12.

Supported keywords: ``type`` (string or list), ``enum``, ``const``,
``properties``, ``required``, ``additionalProperties`` (boolean or schema),
``items``, ``minItems``, ``maxItems``, ``minLength``, ``maxLength``,
``pattern``, ``minimum``, ``maximum``. Unknown keywords are rejected so a
schema cannot silently mean less than it says.

No coercion: ``"true"`` is not a boolean, ``1`` is not ``true``, ``true`` is
not an integer, and a missing property is distinct from ``null`` or ``""``.
"""
from __future__ import annotations

import re
from typing import Any

_KNOWN = {
    "type", "enum", "const", "properties", "required", "additionalProperties", "items",
    "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
    "description", "title", "$schema", "$id",
}


class SchemaError(ValueError):
    pass


def _type_ok(value: Any, t: str) -> bool:
    if t == "null":
        return value is None
    if t == "boolean":
        return isinstance(value, bool)
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "string":
        return isinstance(value, str)
    if t == "array":
        return isinstance(value, list)
    if t == "object":
        return isinstance(value, dict)
    raise SchemaError(f"unknown type {t!r} in schema")


def errors(value: Any, schema: dict, path: str = "$") -> list[str]:
    if not isinstance(schema, dict):
        raise SchemaError(f"schema at {path} is not an object")
    unknown = set(schema) - _KNOWN
    if unknown:
        raise SchemaError(f"unsupported schema keyword(s) {sorted(unknown)} at {path}")
    out: list[str] = []
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, t) for t in types):
            return [f"{path}: expected {'/'.join(types)}, got {type(value).__name__}"]
    if "const" in schema and not _same(value, schema["const"]):
        out.append(f"{path}: must equal {schema['const']!r}")
    if "enum" in schema and not any(_same(value, e) for e in schema["enum"]):
        out.append(f"{path}: {value!r} is not one of {schema['enum']!r}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            out.append(f"{path}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            out.append(f"{path}: longer than {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            out.append(f"{path}: does not match {schema['pattern']!r}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            out.append(f"{path}: below minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            out.append(f"{path}: above maximum {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            out.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            out.append(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                out.extend(errors(item, schema["items"], f"{path}[{i}]"))
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for req in schema.get("required", []):
            if req not in value:
                out.append(f"{path}: missing required property {req!r}")
        addl = schema.get("additionalProperties", True)
        for k, v in value.items():
            if k in props:
                out.extend(errors(v, props[k], f"{path}.{k}"))
            elif addl is False:
                out.append(f"{path}: unexpected property {k!r}")
            elif isinstance(addl, dict):
                out.extend(errors(v, addl, f"{path}.{k}"))
    return out


def _same(a: Any, b: Any) -> bool:
    return type(a) is type(b) and a == b


def validate(value: Any, schema: dict, path: str = "$") -> None:
    errs = errors(value, schema, path)
    if errs:
        raise SchemaError("; ".join(errs))


def var_schema(vtype: str) -> dict:
    return {"type": vtype}
