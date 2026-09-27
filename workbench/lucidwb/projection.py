"""Projection validation, deterministic OpenAPI/JSON Schema generation, contract diff and
snapshot-pinned response building.

Security boundary: resource names, field names, predicates and conversion rules are
checked against strict patterns/allowlists. Source labels and model-generated text never
become routes, code, SQL identifiers or schema keywords; routes come from one fixed template.
"""
import base64
import json
import math
import re

from . import GENERATOR_VERSION
from .util import ApiError, canonical_json, digest

# Patterns are applied with fullmatch: `$` alone would also accept a trailing newline.
RESOURCE_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
FIELD_RE = re.compile(r"^[a-z][A-Za-z0-9]{0,39}$")
FROM_RE = re.compile(r"^(name|properties\.[A-Za-z][A-Za-z0-9_]{0,39})$")
PREDICATE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,39}$")
PROJECT_RE = re.compile(r"^[a-z0-9-]{1,64}$")  # as in the /manage/projects/{project}/... routes
VERSION_RE = re.compile(r"^(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5})){2}$")
CONTRACT_VERSION_RE = re.compile(r"^(0|[1-9][0-9]{0,3})$")  # canonical: no leading zeros
JSON_TYPES = {"string", "number", "integer", "boolean"}
# Every item carries these keys; no field or relation may take their names.
RESERVED_NAMES = ("id", "sourceId", "versionId")
# Schemas every contract carries. Resource schemas (and their pages) must not take these names.
FIXED_SCHEMAS = ("Ref", "Provenance", "SourceSelection", "Error")
# Declared conversion rules. Anything else is rejected; no expression evaluation.
CONVERSIONS = {
    "s_to_ms": {"from_unit": "s", "to_unit": "ms", "factor": 1000},
    "ms_to_s": {"from_unit": "ms", "to_unit": "s", "factor": 0.001},
}
BLOCKING = {"definition_missing", "definition_invalid", "unit_mismatch", "relation_direction_mismatch",
            "unknown_element_type", "enum_value_outside_contract", "contract_version_reused_with_different_shape",
            "invalid_projection", "instance_value_missing", "unresolved_relation_target",
            "relation_target_type_mismatch", "relation_cardinality_exceeded", "relation_missing"}
ENUM_VALUE_OK = {
    "string": lambda v: isinstance(v, str),
    "number": lambda v: (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and math.isfinite(v)),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


def schema_name(rname):
    return "".join(w.capitalize() for w in rname.split("-"))


def _fullmatch(rx, v):
    return isinstance(v, str) and rx.fullmatch(v) is not None


def _field_errors(where, f):
    errs = []
    if not _fullmatch(FROM_RE, f.get("from")):
        errs.append(f"{where}: 'from' must be 'name' or 'properties.<identifier>'")
    types = f.get("type") if isinstance(f.get("type"), list) else [f.get("type")]
    if not (types and all(isinstance(t, str) and (t in JSON_TYPES or t == "null") for t in types)
            and len(set(types)) == len(types)):
        errs.append(f"{where}: unsupported type {f.get('type')}")
    elif f.get("enum") is not None:
        enum = f["enum"]
        # null is implied by a nullable type (see generate_contract), so it is not listed here.
        if not (isinstance(enum, list) and enum
                and all(any(ENUM_VALUE_OK[t](v) for t in types if t != "null") for v in enum)
                and len({canonical_json(v) for v in enum}) == len(enum)):
            errs.append(f"{where}: enum must be a non-empty list of distinct values of the declared type")
    if "convert" in f and not (isinstance(f["convert"], dict) and isinstance(f["convert"].get("rule"), str)
                               and f["convert"]["rule"] in CONVERSIONS):
        errs.append(f"{where}: conversion rule not in allowlist {sorted(CONVERSIONS)}")
    if f.get("unit") is not None and not isinstance(f["unit"], str):
        errs.append(f"{where}: unit must be a string")
    if f.get("required") is not None and not isinstance(f["required"], bool):
        errs.append(f"{where}: required must be true or false")
    return errs


def validate_projection_shape(p):
    errs = []
    if not isinstance(p, dict):
        return ["projection must be an object"]
    for k in ("projection_id", "version", "project", "contract", "resources"):
        if k not in p:
            errs.append(f"missing '{k}'")
    if errs:
        return errs
    if not _fullmatch(RESOURCE_RE, p["projection_id"]):
        errs.append("projection_id must match " + RESOURCE_RE.pattern)
    if not _fullmatch(VERSION_RE, p["version"]):
        errs.append("version must be MAJOR.MINOR.PATCH (digits, no leading zeros)")
    if not _fullmatch(PROJECT_RE, p["project"]):
        errs.append("project must match " + PROJECT_RE.pattern)
    c = p["contract"]
    cver = c.get("version") if isinstance(c, dict) else None
    if isinstance(cver, int) and not isinstance(cver, bool):
        cver = str(cver)  # served as its decimal string
    if not (isinstance(c, dict) and _fullmatch(RESOURCE_RE, c.get("id")) and _fullmatch(CONTRACT_VERSION_RE, cver)):
        errs.append("contract must have id (resource pattern) and numeric version (no leading zeros)")
    if not isinstance(p["resources"], dict):
        return errs + ["resources must be an object"]
    taken = set(FIXED_SCHEMAS)
    for rname, r in p["resources"].items():
        if not _fullmatch(RESOURCE_RE, rname):
            errs.append(f"resource name '{rname}' rejected")
            continue
        # Each resource adds <Name> and <Name>Page to components.schemas; a clash would overwrite a schema.
        sname = schema_name(rname)
        if sname in taken or sname + "Page" in taken:
            errs.append(f"resource name '{rname}' collides with a generated schema name ({sname})")
        taken |= {sname, sname + "Page"}
        if not isinstance(r, dict):
            errs.append(f"{rname}: resource must be an object")
            continue
        if not isinstance(r.get("element_type"), str):
            errs.append(f"{rname}: element_type required")
        fields = {} if r.get("fields") is None else r["fields"]
        relations = {} if r.get("relations") is None else r["relations"]
        if not isinstance(fields, dict):
            errs.append(f"{rname}: fields must be an object")
            fields = {}
        if not isinstance(relations, dict):
            errs.append(f"{rname}: relations must be an object")
            relations = {}
        for fname, f in fields.items():
            if not _fullmatch(FIELD_RE, fname) or fname in RESERVED_NAMES:
                errs.append(f"{rname}.{fname}: field name rejected")
            if not isinstance(f, dict):
                errs.append(f"{rname}.{fname}: field must be an object")
                continue
            errs += _field_errors(f"{rname}.{fname}", f)
        for relname, rel in relations.items():
            # A relation value is written after the identity keys and fields, so a shared name would replace them.
            if not _fullmatch(FIELD_RE, relname) or relname in RESERVED_NAMES or relname in fields:
                errs.append(f"{rname}.{relname}: relation name rejected (reserved, or also a field name)")
            if not isinstance(rel, dict):
                errs.append(f"{rname}.{relname}: relation must be an object")
                continue
            if rel.get("direction") not in ("outgoing", "incoming"):
                errs.append(f"{rname}.{relname}: direction must be outgoing|incoming")
            if not _fullmatch(PREDICATE_RE, rel.get("predicate")):
                errs.append(f"{rname}.{relname}: predicate rejected")
            if not (isinstance(rel.get("target_resource"), str) and rel["target_resource"] in p["resources"]):
                errs.append(f"{rname}.{relname}: target_resource must be a projected resource")
            if rel.get("cardinality", "one") not in ("one", "many"):
                errs.append(f"{rname}.{relname}: cardinality must be one|many")
            if rel.get("required") is not None and not isinstance(rel["required"], bool):
                errs.append(f"{rname}.{relname}: required must be true or false")
    return errs


# ---------------------------------------------------------------- generation
def generate_contract(p):
    """OpenAPI 3.1.1 document derived only from the projection's exposed shape.

    Deliberately excludes the projection's source mappings (`from`, `convert`) so that
    a remapping that preserves the consumer-visible shape does not change the contract.
    """
    cid, cver = p["contract"]["id"], str(p["contract"]["version"])
    schemas = {
        "Ref": {"type": "object", "additionalProperties": False, "required": ["id", "sourceId"],
                "properties": {"id": {"type": "string"}, "sourceId": {"type": "string"}}},
        "Provenance": {
            "type": "object", "additionalProperties": False,
            "required": ["snapshotId", "sourceRevision", "elementVersionId", "sourcePointer", "conversions"],
            "properties": {"snapshotId": {"type": "string"}, "sourceRevision": {"type": "string"},
                           "elementVersionId": {"type": "string"}, "sourcePointer": {"type": "string"},
                           "conversions": {"type": "array", "items": {"type": "object"}},
                           "missingValues": {"type": "array", "items": {"type": "string"}}}},
        "SourceSelection": {
            "type": "object", "additionalProperties": False,
            "required": ["snapshotId", "revision", "headRevision", "isCurrentHead", "headsBehind"],
            "properties": {"snapshotId": {"type": "string"}, "revision": {"type": "string"},
                           "headRevision": {"type": ["string", "null"]}, "isCurrentHead": {"type": "boolean"},
                           "headsBehind": {"type": "integer"}}},
        "Error": {"type": "object", "required": ["error"], "properties": {"error": {
            "type": "object", "required": ["code", "message"],
            "properties": {"code": {"type": "string"}, "message": {"type": "string"}, "details": {"type": "object"}}}}},
    }
    paths = {}
    for rname in sorted(p["resources"]):
        r = p["resources"][rname]
        sname = schema_name(rname)
        props = {"id": {"type": "string", "description": "Stable logical identity (namespaced source ID)."},
                 "sourceId": {"type": "string"}, "versionId": {"type": "string"},
                 "_provenance": {"$ref": "#/components/schemas/Provenance"}}
        required = ["id", "sourceId", "versionId", "_provenance"]
        for fname in sorted(r.get("fields") or {}):
            f = r["fields"][fname]
            s = {"type": f["type"]}
            if f.get("enum"):
                s["enum"] = list(f["enum"]) + ([None] if isinstance(f["type"], list) and "null" in f["type"] else [])
            if f.get("unit"):
                s["x-unit"] = f["unit"]
                s["description"] = f"Unit: {f['unit']}"
            props[fname] = s
            if f.get("required"):
                required.append(fname)
        for relname in sorted(r.get("relations") or {}):
            rel = r["relations"][relname]
            ref = {"$ref": "#/components/schemas/Ref"}
            s = ref if rel.get("cardinality", "one") == "one" else {"type": "array", "items": ref}
            props[relname] = {"allOf": [s]} if rel.get("cardinality", "one") == "one" else s
            props[relname]["x-relation"] = {"predicate": rel["predicate"], "direction": rel["direction"],
                                            "targetResource": rel["target_resource"]}
            if rel.get("required"):
                required.append(relname)
        schemas[sname] = {"type": "object", "additionalProperties": False, "required": sorted(required),
                          "properties": props}
        schemas[sname + "Page"] = {
            "type": "object", "additionalProperties": False,
            "required": ["project", "releaseId", "contract", "source", "items", "next"],
            "properties": {"project": {"type": "string"}, "releaseId": {"type": "string"},
                           "contract": {"type": "object"}, "source": {"$ref": "#/components/schemas/SourceSelection"},
                           "items": {"type": "array", "items": {"$ref": f"#/components/schemas/{sname}"}},
                           "next": {"type": ["string", "null"]}}}
        err = {"description": "Error", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}}
        paths[f"/releases/{{releaseId}}/resources/{rname}"] = {"get": {
            "operationId": f"list_{sname}", "parameters": [
                {"name": "releaseId", "in": "path", "required": True, "schema": {"type": "string"}},
                {"name": "cursor", "in": "query", "required": False, "schema": {"type": "string"}},
                {"name": "limit", "in": "query", "required": False, "schema": {"type": "integer", "minimum": 1, "maximum": 100}}],
            "responses": {"200": {"description": "Snapshot-pinned page",
                                  "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{sname}Page"}}}},
                          "404": err}}}
        paths[f"/releases/{{releaseId}}/resources/{rname}/{{entityId}}"] = {"get": {
            "operationId": f"get_{sname}", "parameters": [
                {"name": "releaseId", "in": "path", "required": True, "schema": {"type": "string"}},
                {"name": "entityId", "in": "path", "required": True, "schema": {"type": "string"}}],
            "responses": {"200": {"description": "One item", "content": {"application/json": {"schema": {
                "$ref": f"#/components/schemas/{sname}"}}}}, "404": err}}}
    return {
        "openapi": "3.1.1",
        "jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema",
        "info": {"title": f"{cid} (generated)", "version": cver,
                 "x-lwb": {"contractId": cid, "generator": GENERATOR_VERSION,
                           "note": "Generated from a reviewed projection over synthetic data."}},
        "servers": [{"url": "/api"}],
        "security": [{"bearer": []}],
        "paths": paths,
        "components": {"schemas": schemas, "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}}},
    }


def validate_openapi(doc):
    from openapi_spec_validator import validate
    try:
        validate(doc)
        return []
    except Exception as e:  # validator raises typed errors; message is enough for diagnostics
        return [str(e).splitlines()[0][:300]]


def _obj(v):
    return v if isinstance(v, dict) else {}


def _distinct(values):
    """Distinct values in canonical JSON order; source values need not be hashable."""
    return [json.loads(k) for k in sorted({canonical_json(v).decode() for v in values})]


def check_against_snapshot(c, p, snapshot_id):
    """Projection vs source definitions + instance data. Returns diagnostics (dicts)."""
    snap = c.execute("SELECT * FROM source_snapshot WHERE snapshot_id=?", (snapshot_id,)).fetchone()
    # Sections may be null, and snapshots stored before import validation may hold any JSON.
    defs = _obj(json.loads(snap["definitions_json"]))
    types, rtypes = _obj(defs.get("types")), _obj(defs.get("relationshipTypes"))
    diags = []
    for rname, r in sorted(p["resources"].items()):
        et = r["element_type"]
        if not isinstance(types.get(et), dict):
            diags.append({"code": "unknown_element_type", "class": "structural", "resource": rname, "type": et})
            continue
        tprops = _obj(types[et].get("properties"))
        for fname, f in sorted((r.get("fields") or {}).items()):
            if f["from"] == "name":
                continue
            prop = f["from"].split(".", 1)[1]
            d = tprops.get(prop)
            if d is None:
                diags.append({"code": "definition_missing", "class": "structural", "resource": rname, "field": fname,
                              "source_property": f"{et}.{prop}",
                              "fix": "Map the field to an existing property (new projection version) or release a "
                                     "new contract version that drops it; consumers must be retested."})
                continue
            if not isinstance(d, dict):
                diags.append({"code": "definition_invalid", "class": "structural", "resource": rname, "field": fname,
                              "source_property": f"{et}.{prop}",
                              "message": "Source property definition is not an object."})
                continue
            src_unit, want = d.get("unit"), f.get("unit")
            conv = CONVERSIONS.get((f.get("convert") or {}).get("rule"))
            eff = conv["to_unit"] if conv and conv["from_unit"] == src_unit else src_unit
            if conv and conv["from_unit"] != src_unit:
                diags.append({"code": "unit_mismatch", "class": "semantic", "resource": rname, "field": fname,
                              "source_unit": src_unit, "conversion": f["convert"]["rule"],
                              "message": "Declared conversion does not apply to the source unit."})
            elif want != eff:
                diags.append({"code": "unit_mismatch", "class": "semantic", "resource": rname, "field": fname,
                              "source_unit": src_unit, "contract_unit": want,
                              "message": "Payload type still validates, but values would change meaning. "
                                         "Declare a reviewed conversion rule."})
            src_enum = d["enum"] if isinstance(d.get("enum"), list) else []
            extra = [v for v in src_enum if v not in f["enum"]] if f.get("enum") else []
            if extra:
                diags.append({"code": "enum_value_outside_contract", "class": "semantic", "resource": rname,
                              "field": fname, "values": _distinct(extra)})
        for relname, rel in sorted((r.get("relations") or {}).items()):
            rt = rtypes.get(rel["predicate"])
            tgt_type = p["resources"][rel["target_resource"]]["element_type"]
            if not isinstance(rt, dict):
                diags.append({"code": "definition_missing", "class": "structural", "resource": rname,
                              "relation": relname, "predicate": rel["predicate"]})
                continue
            exp = (et, tgt_type) if rel["direction"] == "outgoing" else (tgt_type, et)
            if (rt.get("from"), rt.get("to")) not in (exp, ("*", exp[1])):
                diags.append({"code": "relation_direction_mismatch", "class": "semantic", "resource": rname,
                              "relation": relname, "predicate": rel["predicate"],
                              "expected": f"{exp[0]}->{exp[1]}", "source": f"{rt.get('from')}->{rt.get('to')}"})
    return diags


# ---------------------------------------------------------------- serving
def _items(c, release, rname):
    p = json.loads(release["projection_json"])
    r = p["resources"][rname]
    sid = release["snapshot_id"]
    snap = c.execute("SELECT revision FROM source_snapshot WHERE snapshot_id=?", (sid,)).fetchone()
    rows = c.execute(
        "SELECT se.entity_uid, ev.*, ei.native_id FROM snapshot_element se "
        "JOIN element_version ev ON ev.version_id=se.version_id "
        "JOIN element_identity ei ON ei.entity_uid=se.entity_uid "
        "WHERE se.snapshot_id=? AND se.state='present' AND ev.type=? ORDER BY se.entity_uid", (sid, r["element_type"]))
    rels = {}
    # Ordered by the source's relationship ID, so the served order (and any first match) is reproducible.
    for rr in c.execute("SELECT rv.predicate, rv.source_uid, rv.target_uid, sr.endpoint_status FROM snapshot_relationship sr "
                        "JOIN relationship_version rv ON rv.version_id=sr.version_id "
                        "WHERE sr.snapshot_id=? AND sr.state='present' ORDER BY rv.native_id, sr.rel_uid", (sid,)):
        rels.setdefault(rr["predicate"], []).append(rr)
    native = {x["entity_uid"]: (x["native_id"], x["type"]) for x in c.execute(
        "SELECT se.entity_uid, ei.native_id, ev.type FROM snapshot_element se JOIN element_identity ei "
        "ON ei.entity_uid=se.entity_uid JOIN element_version ev ON ev.version_id=se.version_id "
        "WHERE se.snapshot_id=? AND se.state='present'", (sid,))}
    out, diags = [], []
    for row in rows:
        props = json.loads(row["properties_json"])
        item = {"id": row["entity_uid"], "sourceId": row["native_id"], "versionId": row["version_id"]}
        prov = {"snapshotId": sid, "sourceRevision": snap["revision"], "elementVersionId": row["version_id"],
                "sourcePointer": row["source_pointer"], "conversions": []}
        missing = []
        for fname, f in sorted((r.get("fields") or {}).items()):
            if f["from"] == "name":
                present, val = row["name"] is not None, row["name"]
            else:
                key = f["from"].split(".", 1)[1]
                present, val = key in props, props.get(key)
            if not present:
                missing.append(fname)
                if f.get("required"):
                    diags.append({"code": "instance_value_missing", "class": "data", "resource": rname,
                                  "entity": row["native_id"], "field": fname,
                                  "fix": "Correct the source element value; the definition is intact, so no "
                                         "contract or projection change is implied."})
                continue
            conv = CONVERSIONS.get((f.get("convert") or {}).get("rule"))
            if conv and isinstance(val, (int, float)) and not isinstance(val, bool):
                newv = round(val * conv["factor"], 9)
                newv = int(newv) if float(newv).is_integer() else newv
                prov["conversions"].append({"field": fname, "rule": f["convert"]["rule"], "input": val,
                                            "output": newv, "declared_in": f"{p['projection_id']}@{p['version']}"})
                val = newv
            item[fname] = val
        for relname, rel in sorted((r.get("relations") or {}).items()):
            want = p["resources"][rel["target_resource"]]["element_type"]
            matches, dropped = [], False
            for rr in rels.get(rel["predicate"], []):
                mine, other = (rr["source_uid"], rr["target_uid"]) if rel["direction"] == "outgoing" else (
                    rr["target_uid"], rr["source_uid"])
                if mine != row["entity_uid"]:
                    continue
                if other not in native:
                    dropped = True
                    diags.append({"code": "unresolved_relation_target", "class": "data", "resource": rname,
                                  "entity": row["native_id"], "relation": relname})
                elif native[other][1] != want:
                    # The contract says the ref resolves under targetResource; this endpoint would 404 there.
                    dropped = True
                    diags.append({"code": "relation_target_type_mismatch", "class": "data", "resource": rname,
                                  "entity": row["native_id"], "relation": relname, "target": native[other][0],
                                  "target_type": native[other][1], "expected_type": want})
                else:
                    matches.append({"id": other, "sourceId": native[other][0]})
            if rel.get("cardinality", "one") == "one":
                targets = sorted({m["sourceId"] for m in matches})
                if len(targets) > 1:
                    diags.append({"code": "relation_cardinality_exceeded", "class": "data", "resource": rname,
                                  "entity": row["native_id"], "relation": relname, "targets": targets,
                                  "fix": "The contract serves one target. Correct the source relationships, or "
                                         "release a contract version with cardinality 'many'."})
                if matches:
                    item[relname] = matches[0]
                else:
                    missing.append(relname)
                    if rel.get("required") and not dropped:  # a dropped endpoint is reported above
                        diags.append({"code": "relation_missing", "class": "data", "resource": rname,
                                      "entity": row["native_id"], "relation": relname,
                                      "fix": "Add the relationship in the source model, or make the relation "
                                             "optional in a new contract version."})
            else:
                item[relname] = matches
        if missing:
            prov["missingValues"] = missing
        item["_provenance"] = prov
        out.append(item)
    return out, diags


def source_selection(c, release):
    snap = c.execute("SELECT * FROM source_snapshot WHERE snapshot_id=?", (release["snapshot_id"],)).fetchone()
    head = c.execute("SELECT * FROM source_head WHERE source=? AND project=?", (snap["source"], snap["project"])).fetchone()
    pinned_seq = c.execute("SELECT head_seq FROM head_history WHERE source=? AND project=? AND snapshot_id=?",
                           (snap["source"], snap["project"], snap["snapshot_id"])).fetchone()
    behind = (head["head_seq"] - pinned_seq["head_seq"]) if (head and pinned_seq) else 0
    return {"snapshotId": snap["snapshot_id"], "revision": snap["revision"],
            "headRevision": head["revision"] if head else None,
            "isCurrentHead": bool(head and head["snapshot_id"] == snap["snapshot_id"]), "headsBehind": behind}


def list_page(c, release, rname, cursor=None, limit=50):
    p = json.loads(release["projection_json"])
    if rname not in p["resources"]:
        raise ApiError(404, "not_found", "Resource not found.")
    items, _ = _items(c, release, rname)
    after = None
    if cursor:
        try:
            after = base64.urlsafe_b64decode(cursor.encode()).decode()
        except Exception:
            raise ApiError(400, "invalid_input", "Invalid cursor.")
    if after:
        items = [i for i in items if i["id"] > after]
    try:
        limit = max(1, min(int(limit or 50), 100))
    except ValueError:
        raise ApiError(400, "invalid_input", "limit must be an integer from 1 to 100.")
    page, more = items[:limit], len(items) > limit
    nxt = None
    if more:
        cur = base64.urlsafe_b64encode(page[-1]["id"].encode()).decode()
        nxt = f"/api/releases/{release['release_id']}/resources/{rname}?limit={limit}&cursor={cur}"
    return {"project": release["project"], "releaseId": release["release_id"],
            "contract": {"id": p["contract"]["id"], "version": str(p["contract"]["version"]),
                         "digest": release["contract_digest"]},
            "source": source_selection(c, release), "items": page, "next": nxt}


def get_item(c, release, rname, entity_id):
    p = json.loads(release["projection_json"])
    if rname not in p["resources"]:
        raise ApiError(404, "not_found", "Resource not found.")
    items, _ = _items(c, release, rname)
    for i in items:
        if i["id"] == entity_id:
            return i
    raise ApiError(404, "not_found", "Resource not found.")


def instance_diagnostics(c, release):
    p = json.loads(release["projection_json"])
    out = []
    for rname in sorted(p["resources"]):
        out += _items(c, release, rname)[1]
    return out


# ---------------------------------------------------------------- contract diff
def _resource_schemas(doc):
    """Item schema names, read from the item routes rather than guessed from schema names."""
    return {op["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].rsplit("/", 1)[1]
            for path, op in doc["paths"].items() if path.endswith("/{entityId}")}


def _as_set(v):
    """`type` arrays and `enum` lists are sets in JSON Schema: their order carries no meaning."""
    return None if v is None else {canonical_json(x) for x in (v if isinstance(v, list) else [v])}


def contract_shape_digest(doc):
    """Digest of a contract with `type` arrays and `enum` lists in canonical order, so reordering them is not
    a new consumer-visible shape. (The contract digest itself stays the digest of the exact document.)"""
    def canon(v):
        if isinstance(v, dict):
            return {k: sorted(map(canon, w), key=canonical_json) if k in ("type", "enum") and isinstance(w, list)
                    else canon(w) for k, w in v.items()}
        return [canon(x) for x in v] if isinstance(v, list) else v
    return digest(canon(doc))


def contract_diff(old, new):
    """Compare two generated contracts. Classifies structural vs semantic changes. This is a
    heuristic over our own generator's output, not a general OpenAPI diff."""
    if old is None:
        return {"baseline": None, "changes": [{"change": "initial_contract", "class": "additive"}]}
    out = []
    os_, ns = old["components"]["schemas"], new["components"]["schemas"]
    for name in sorted(_resource_schemas(old) | _resource_schemas(new)):
        a, b = os_.get(name), ns.get(name)
        if a and not b:
            out.append({"change": "resource_removed", "class": "breaking", "schema": name}); continue
        if b and not a:
            out.append({"change": "resource_added", "class": "additive", "schema": name}); continue
        ap, bp = a["properties"], b["properties"]
        ar, br = set(a.get("required", [])), set(b.get("required", []))
        for f in sorted(set(ap) | set(bp)):
            if f not in bp:
                out.append({"change": "field_removed", "class": "breaking", "schema": name, "field": f})
            elif f not in ap:
                out.append({"change": "field_added", "class": "additive (test strict consumers)" if f not in br
                            else "breaking", "schema": name, "field": f, "required": f in br})
            else:
                x, y = ap[f], bp[f]
                if _as_set(x.get("type")) != _as_set(y.get("type")):
                    out.append({"change": "type_changed", "class": "breaking", "schema": name, "field": f})
                if x.get("x-unit") != y.get("x-unit"):
                    out.append({"change": "unit_changed", "class": "semantic", "schema": name, "field": f,
                                "from": x.get("x-unit"), "to": y.get("x-unit")})
                if _as_set(x.get("enum")) != _as_set(y.get("enum")):
                    out.append({"change": "enum_changed", "class": "semantic", "schema": name, "field": f})
                if x.get("x-relation") != y.get("x-relation"):
                    out.append({"change": "relation_semantics_changed", "class": "semantic", "schema": name, "field": f})
                if (f in ar) != (f in br):
                    out.append({"change": "required_changed", "class": "breaking" if f in br else "relaxed",
                                "schema": name, "field": f})
    return {"baseline": old["info"]["version"], "changes": out}


def projection_digest(p):
    return digest(p)
