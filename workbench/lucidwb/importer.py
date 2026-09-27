"""Source adapter + canonical import.

Rules implemented here (see ARCHITECTURE.md for rationale):
* Identity = (source, project, source-native element ID). Names never participate.
* Revision identifiers are opaque; ordering comes only from declared parent links.
* Only a validated complete snapshot whose parent is the current head, or a delta whose
  parent is the current head, advances the head. Everything else is recorded and
  quarantined/staged with a machine-readable outcome.
* Partial exports are staged views; they never infer deletion of unseen elements.
* Unknown content is preserved in raw bytes and in `unrecognized_json` (per element, relationship, record
  and snapshot), with warnings. Unknown element, relationship and record content is part of the normalized
  digest; unknown top-level (envelope) keys are not, so exporter metadata alone never makes a conflict.
* Field shapes are validated before anything is stored, so malformed input is quarantined, not a 500.
  A body that is not JSON text the store can hold (invalid JSON or UTF-8, an unpaired surrogate escape, or
  nesting deeper than MAX_DEPTH) is refused with 400 before any import is recorded.
* The same revision with byte-identical content is a duplicate even if this adapter normalizes it differently
  from the adapter that stored it. So is the same content re-serialized (whitespace, key order), compared the
  way the adapter that stored it read it.
"""
import json
import math
import re

from . import ADAPTER_VERSION, RECORDS_ADAPTER_VERSION
from .db import audit, enqueue_event
from .util import ApiError, canonical_json, digest, new_id, now, sha256

MODEL_FORMAT = "lwb-synthetic-export/1"
RECORDS_FORMAT = "lwb-external-records/1"
KNOWN_TOP = {"format", "source", "project", "revision", "parent_revision", "kind", "scope", "definitions",
             "elements", "relationships", "deletions"}
KNOWN_EL = {"id", "type", "name", "owner", "properties"}
KNOWN_REL = {"id", "type", "source", "target", "multiplicity"}
KNOWN_RECORDS_TOP = {"format", "source", "project", "revision", "parent_revision", "records"}
KNOWN_RECORD = {"id", "kind", "asset_ref", "text"}
MAX_DEPTH = 100  # nesting levels an export may use; exports need fewer than ten
_SURROGATE = re.compile("[\ud800-\udfff]")  # json.loads keeps a lone surrogate escape such as \ud800 as is
EXPECT = {"non-empty string": lambda v: isinstance(v, str) and v != "",
          "string or null": lambda v: v is None or isinstance(v, str),
          "object or null": lambda v: v is None or isinstance(v, dict),
          "list or null": lambda v: v is None or isinstance(v, list)}


def entity_uid(source, project, native_id):
    return "ent_" + sha256(f"{source}\x1f{project}\x1f{native_id}")[:16]


def rel_uid(source, project, native_id):
    return "rel_" + sha256(f"{source}\x1f{project}\x1frel\x1f{native_id}")[:16]


def peek_project(raw: bytes):
    try:
        doc = json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError) as e:
        raise ApiError(400, "invalid_input", f"Import body is not valid JSON: {e}")
    problem = _unstorable_text(doc)
    if problem:
        raise ApiError(400, "invalid_input", f"Import body cannot be stored: {problem}")
    if not isinstance(doc, dict) or not isinstance(doc.get("project"), str):
        raise ApiError(400, "invalid_input", "Import must be a JSON object with a string 'project'.")
    return doc


def _unstorable_text(doc):
    """JSON the parser accepts but storage cannot hold, refused like unparseable bytes: a string (or key) with an
    unpaired UTF-16 surrogate escape has no UTF-8 form, and nesting beyond MAX_DEPTH would overflow the
    recursion limit when the document is encoded for its digest."""
    stack = [(doc, 1)]
    while stack:  # iterative: nesting depth is bounded only by the parser
        v, depth = stack.pop()
        if depth > MAX_DEPTH:
            return f"nested deeper than {MAX_DEPTH} levels"
        if isinstance(v, dict):
            if any(_SURROGATE.search(k) for k in v):
                return "an object key contains an unpaired UTF-16 surrogate"
            stack.extend((x, depth + 1) for x in v.values())
        elif isinstance(v, list):
            stack.extend((x, depth + 1) for x in v)
        elif isinstance(v, str) and _SURROGATE.search(v):
            return "a string contains an unpaired UTF-16 surrogate"
    return None


# ---------------------------------------------------------------- validation helpers
def _ptr(base, key):
    return f"{base}/" + str(key).replace("~", "~0").replace("/", "~1")


def _check(errors, obj, pointer, fields):
    """Append an invalid_field error for each field whose JSON type is not what storage assumes."""
    ok = True
    for key, expected in fields.items():
        if not EXPECT[expected](obj.get(key)):
            errors.append({"code": "invalid_field", "pointer": _ptr(pointer, key), "expected": expected})
            ok = False
    return ok


def _list(doc, key):
    return doc[key] if isinstance(doc.get(key), list) else []


def _text(v):
    return v if isinstance(v, str) else None


def _definition_errors(defs):
    """Definitions are objects all the way down to one property; enums are lists of strings."""
    errors = []
    for section in ("types", "relationshipTypes"):
        if not _check(errors, defs, "/definitions", {section: "object or null"}):
            continue
        for name, d in (defs.get(section) or {}).items():
            pointer = _ptr(f"/definitions/{section}", name)
            if not isinstance(d, dict):
                errors.append({"code": "invalid_field", "pointer": pointer, "expected": "object"})
            elif section == "types" and _check(errors, d, pointer, {"properties": "object or null"}):
                for pname, pd in (d.get("properties") or {}).items():
                    ppointer = _ptr(f"{pointer}/properties", pname)
                    if not isinstance(pd, dict):
                        errors.append({"code": "invalid_field", "pointer": ppointer, "expected": "object"})
                    elif pd.get("enum") is not None and not (
                            isinstance(pd["enum"], list) and all(isinstance(x, str) for x in pd["enum"])):
                        errors.append({"code": "invalid_field", "pointer": f"{ppointer}/enum",
                                       "expected": "list of strings or null"})
    return errors


def _non_finite_numbers(doc):
    """NaN / Infinity are not JSON (RFC 8259), but Python's parser accepts them and turns 1e400 into inf."""
    found, stack = [], [("", doc)]
    while stack:  # iterative: nesting depth is bounded only by the parser
        pointer, v = stack.pop()
        if isinstance(v, float) and not math.isfinite(v):
            found.append(pointer)
        elif isinstance(v, dict):
            stack.extend((_ptr(pointer, k), x) for k, x in v.items())
        elif isinstance(v, list):
            stack.extend((_ptr(pointer, i), x) for i, x in enumerate(v))
    if not found:
        return []
    return [{"code": "non_finite_number", "count": len(found), "pointers": sorted(found)[:20],
             "message": "NaN and Infinity are not valid JSON numbers."}]


# ---------------------------------------------------------------- normalization
def normalize_model(doc, base_definitions=None):
    """Return (normalized, elements, rels, warnings, errors). Pure function of the export document and, for a
    delta or partial export that omits definitions, the definitions of its parent snapshot."""
    warnings, errors = [], []
    for k in doc:
        if k not in KNOWN_TOP:
            warnings.append({"code": "unrecognized_top_level_key", "key": k})
    for key in ("source", "revision", "kind"):
        if not isinstance(doc.get(key), str) or not doc.get(key):
            errors.append({"code": "missing_field", "field": key})
    if doc.get("kind") not in ("snapshot", "delta"):
        errors.append({"code": "invalid_kind", "value": doc.get("kind")})
    scope = doc.get("scope") or {}
    if not isinstance(scope, dict) or scope.get("kind") not in ("complete", "partial"):
        errors.append({"code": "invalid_scope", "value": scope})
    _check(errors, doc, "", {"parent_revision": "string or null", "definitions": "object or null",
                             "elements": "list or null", "relationships": "list or null",
                             "deletions": "list or null"})
    defs = doc.get("definitions") if isinstance(doc.get("definitions"), dict) else {}
    # Lookups use the parent's definitions when the export omits its own; the normalized form (and so the
    # digest) still records only what the export declared.
    effective = defs or base_definitions or {}
    bad_defs = _definition_errors(effective)
    if bad_defs:
        if effective is defs:
            errors += bad_defs
        effective = {}
    types = effective.get("types") or {}
    elements, seen = [], set()
    for i, e in enumerate(_list(doc, "elements")):
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not e["id"]:
            errors.append({"code": "element_without_identity", "index": i})
            continue
        if e["id"] in seen:
            errors.append({"code": "duplicate_identity", "id": e["id"]})
            continue
        seen.add(e["id"])
        if not _check(errors, e, f"/elements/{i}", {"type": "non-empty string", "name": "string or null",
                                                    "owner": "string or null", "properties": "object or null"}):
            continue
        tdef = types.get(e["type"])
        props = e.get("properties") or {}
        known, unrec = {}, {}
        if tdef is None:
            warnings.append({"code": "unknown_element_type", "id": e["id"], "type": e.get("type")})
            unrec["properties"] = props
        else:
            for pk, pv in props.items():
                if pk in (tdef.get("properties") or {}):
                    known[pk] = pv  # missing / null / "" / 0 stay distinct
                else:
                    unrec.setdefault("properties", {})[pk] = pv
                    warnings.append({"code": "unrecognized_property", "id": e["id"], "property": pk})
        for k in e:
            if k not in KNOWN_EL:
                unrec[k] = e[k]
                warnings.append({"code": "unrecognized_element_key", "id": e["id"], "key": k})
        elements.append({"id": e["id"], "type": e.get("type"), "name": e.get("name"), "owner": e.get("owner"),
                         "properties": known, "unrecognized": unrec, "pointer": f"/elements/{i}"})
    rels, rseen = [], set()
    for i, r in enumerate(_list(doc, "relationships")):
        if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not r["id"]:
            errors.append({"code": "relationship_without_identity", "index": i})
            continue
        if r["id"] in rseen:
            errors.append({"code": "duplicate_identity", "id": r["id"]})
            continue
        rseen.add(r["id"])
        if not _check(errors, r, f"/relationships/{i}", {"type": "non-empty string", "source": "string or null",
                                                         "target": "string or null"}):
            continue
        if r["type"] not in (effective.get("relationshipTypes") or {}):
            warnings.append({"code": "unknown_relationship_type", "id": r["id"], "type": r.get("type")})
        rel = {"id": r["id"], "type": r["type"], "source": r.get("source"), "target": r.get("target"),
               "multiplicity": r.get("multiplicity"), "pointer": f"/relationships/{i}"}
        unrec = {k: v for k, v in r.items() if k not in KNOWN_REL}
        for k in unrec:
            warnings.append({"code": "unrecognized_relationship_key", "id": r["id"], "key": k})
        if unrec:  # only when present, so plain relationships keep their digests
            rel["unrecognized"] = unrec
        rels.append(rel)
    deletions = []
    for j, d in enumerate(_list(doc, "deletions")):
        if isinstance(d, str) and d:
            deletions.append(d)
        else:
            errors.append({"code": "invalid_field", "pointer": f"/deletions/{j}", "expected": "non-empty string"})
    if deletions and doc.get("kind") != "delta":
        errors.append({"code": "deletions_only_allowed_in_delta"})
    normalized = {
        "definitions": defs,
        "elements": sorted(({k: v for k, v in e.items() if k != "pointer"} for e in elements), key=lambda x: x["id"]),
        "relationships": sorted(({k: v for k, v in r.items() if k != "pointer"} for r in rels), key=lambda x: x["id"]),
        "deletions": sorted(deletions),
        "scope": scope, "kind": doc.get("kind"), "parent_revision": doc.get("parent_revision"),
    }
    return normalized, elements, rels, warnings, errors


def normalize_records(doc):
    warnings, errors, out, seen = [], [], [], set()
    for k in doc:
        if k not in KNOWN_RECORDS_TOP:
            warnings.append({"code": "unrecognized_top_level_key", "key": k})
    for key in ("source", "revision"):
        if not isinstance(doc.get(key), str) or not doc.get(key):
            errors.append({"code": "missing_field", "field": key})
    _check(errors, doc, "", {"parent_revision": "string or null", "records": "list or null"})
    for i, r in enumerate(_list(doc, "records")):
        if (not isinstance(r, dict) or not isinstance(r.get("id"), str) or not r["id"]
                or not isinstance(r.get("text"), str)):
            errors.append({"code": "record_without_identity_or_text", "index": i})
            continue
        if r["id"] in seen:
            errors.append({"code": "duplicate_identity", "id": r["id"]})
            continue
        seen.add(r["id"])
        if not _check(errors, r, f"/records/{i}", {"kind": "string or null", "asset_ref": "string or null"}):
            continue
        rec = {"id": r["id"], "kind": r.get("kind") or "record", "asset_ref": r.get("asset_ref"), "text": r["text"]}
        unrec = {k: v for k, v in r.items() if k not in KNOWN_RECORD}
        for k in unrec:
            warnings.append({"code": "unrecognized_record_key", "id": r["id"], "key": k})
        if unrec:  # only when present, so plain records keep their versions
            rec["unrecognized"] = unrec
        out.append(rec)
    normalized = {"records": sorted(out, key=lambda x: x["id"]), "parent_revision": doc.get("parent_revision")}
    return normalized, out, warnings, errors


# ---------------------------------------------------------------- import entry point
def import_export(c, actor, raw: bytes, doc: dict, declared=None):
    """Runs inside the caller's write transaction. Returns (http_status, body, affected).

    `declared` is the export as the source sent it, when `doc` carries a reconciliation override of the
    parent. The normalized digest covers the declared export, so re-sent bytes stay duplicates."""
    fmt = doc.get("format")
    project, source, revision = doc.get("project"), doc.get("source"), doc.get("revision")
    raw_digest = sha256(raw)
    import_id = new_id("imp")
    declared = declared or doc

    if fmt == MODEL_FORMAT:
        normalized, elements, rels, warnings, errors = normalize_model(declared, _base_definitions(c, declared))
        adapter = ADAPTER_VERSION
    elif fmt == RECORDS_FORMAT:
        normalized, records, warnings, errors = normalize_records(declared)
        adapter = RECORDS_ADAPTER_VERSION
    else:
        _record_import(c, import_id, doc, raw, raw_digest, "n/a", "rejected_unsupported_format", None,
                       [{"code": "unsupported_format", "format": _text(fmt)}], actor)
        return 400, _receipt(c, import_id), {}
    kind = doc.get("kind") if fmt == MODEL_FORMAT else "snapshot"
    scope = doc.get("scope") or {"kind": "complete"}

    def done(outcome, status, diags, snapshot_id=None, duplicate_of=None):
        _record_import(c, import_id, doc, raw, raw_digest, adapter, outcome, snapshot_id, diags, actor, duplicate_of)
        audit(c, actor, project, "source.import", outcome, None,
              {"import_id": import_id, "source": _text(source), "revision": _text(revision)})
        return status, _receipt(c, import_id), {"import_id": import_id, "snapshot_id": snapshot_id}

    non_finite = _non_finite_numbers(doc)
    if non_finite:  # checked first: these diagnostics echo no values, so nothing non-JSON is stored or served
        return done("quarantined_invalid", 422, non_finite)
    if errors:
        return done("quarantined_invalid", 422, errors + warnings)
    norm_digest = digest(normalized)

    # A source keeps one format: a records dump must not replace a model head, nor the reverse.
    prior = c.execute("SELECT i.format FROM source_snapshot s JOIN source_import i ON i.import_id=s.import_id "
                      "WHERE s.source=? AND s.project=? LIMIT 1", (source, project)).fetchone()
    if prior and prior["format"] != fmt:
        return done("rejected_format_mismatch", 409,
                    [{"code": "format_mismatch", "source": source, "format": fmt, "source_format": prior["format"],
                      "message": "Source already holds snapshots in another format. Source head unchanged."}]
                    + warnings)

    partial = fmt == MODEL_FORMAT and scope.get("kind") == "partial"
    existing = c.execute("SELECT * FROM source_snapshot WHERE source=? AND project=? AND revision=? "
                         "AND (completeness='partial')=?", (source, project, revision, partial)).fetchone()
    if existing:
        # Identical bytes are the same content even when an earlier adapter normalized them differently, and so is
        # content that normalizes to the stored digest the way that adapter read it.
        stored = existing["normalized_digest"]
        if stored == norm_digest or existing["raw_digest"] == raw_digest or (
                fmt == MODEL_FORMAT and stored == _earlier_digest(existing["adapter_version"], declared)):
            first = existing["import_id"]
            diags = [{"code": "identical_revision_and_content", "original_import_id": first}]
            if stored != norm_digest:
                diags.append({"code": "stored_normalization_differs",
                              "stored_adapter_version": existing["adapter_version"], "adapter_version": adapter,
                              "message": "Same content as the stored revision, which was normalized differently "
                                         "when it was imported. The stored snapshot is unchanged."})
            return done("duplicate_no_change", 200, diags, existing["snapshot_id"], duplicate_of=first)
        return done("quarantined_conflict", 409,
                    [{"code": "source_revision_conflict", "revision": revision,
                      "existing_normalized_digest": existing["normalized_digest"],
                      "incoming_normalized_digest": norm_digest,
                      "message": "Same revision identifier with different content. Source head unchanged."}])

    head = c.execute("SELECT * FROM source_head WHERE source=? AND project=?", (source, project)).fetchone()
    parent = doc.get("parent_revision")
    parent_snap = None
    if parent is not None:
        parent_snap = _snapshot_at(c, source, project, parent)

    if partial:
        if parent_snap is None:
            return done("quarantined_missing_parent", 409,
                        [{"code": "missing_parent", "parent_revision": parent}] + warnings)
        ambiguous = _ambiguous_deletions(c, source, project, None, elements, rels, normalized["deletions"])
        if ambiguous:
            return done("quarantined_invalid", 422, ambiguous + warnings)
        sid, del_warn = _store_model_snapshot(c, doc, import_id, raw_digest, norm_digest, normalized, elements,
                                              rels, warnings, base=parent_snap, status="staged_partial")
        return done("staged_partial", 202, warnings + del_warn + [{
            "code": "partial_scope_not_applied_to_head",
            "message": "Partial export staged. Elements outside the observed scope are NOT inferred deleted; "
                       "source head unchanged."}], sid)

    base_ok = (head is None and parent is None) or (head is not None and parent == head["revision"])
    if kind == "delta" and head is None:
        base_ok = False
    if not base_ok:
        if parent is not None and parent_snap is None:
            return done("quarantined_missing_parent", 409,
                        [{"code": "missing_parent", "parent_revision": parent,
                          "message": "Parent revision unknown; explicit reconciliation required."}] + warnings)
        if head is not None and parent is None:
            return done("quarantined_unbased", 409,
                        [{"code": "unbased_snapshot", "current_head": head["revision"],
                          "message": "Complete snapshot without a parent while a head exists; "
                                     "explicit reconciliation (accept_as_head) required."}] + warnings)
        return done("rejected_stale_base", 409,
                    [{"code": "stale_base", "parent_revision": parent,
                      "current_head": head["revision"] if head else None,
                      "message": "Based on a revision that is not the current head. Not applied as head."}]
                    + warnings)

    del_warn = []
    if fmt == RECORDS_FORMAT:
        sid = _store_record_snapshot(c, doc, import_id, raw_digest, norm_digest, records, warnings)
    else:
        base = _head_snapshot(c, head)
        ambiguous = _ambiguous_deletions(c, source, project, base if kind == "delta" else None, elements, rels,
                                         normalized["deletions"])
        if ambiguous:
            return done("quarantined_invalid", 422, ambiguous + warnings)
        sid, del_warn = _store_model_snapshot(c, doc, import_id, raw_digest, norm_digest, normalized, elements,
                                              rels, warnings, base=base, status="head")
    _advance_head(c, source, project, revision, sid, import_id)
    return done("accepted_head", 201, warnings + del_warn, sid)


def reconcile(c, actor, import_id, action, expected_head):
    """Explicit reconciliation of a quarantined import. `expected_head` guards against races."""
    imp = c.execute("SELECT * FROM source_import WHERE import_id=?", (import_id,)).fetchone()
    if not imp:
        raise ApiError(404, "not_found", "Resource not found.")
    if imp["outcome"] not in ("quarantined_missing_parent", "quarantined_unbased", "rejected_stale_base"):
        raise ApiError(409, "not_reconcilable", f"Import outcome '{imp['outcome']}' cannot be reconciled.")
    if imp["reconciled_by"]:
        raise ApiError(409, "already_reconciled", "Import was already reconciled.",
                       {"reconciled_by": imp["reconciled_by"]})
    head = c.execute("SELECT * FROM source_head WHERE source=? AND project=?",
                     (imp["source"], imp["project"])).fetchone()
    current = head["revision"] if head else None
    if expected_head != current:
        raise ApiError(412, "precondition_failed", "Source head changed.", {"current_head": current})
    declared = doc = json.loads(imp["raw_bytes"])
    if action == "retry":
        pass  # re-evaluate with normal rules (e.g. the missing parent has since arrived)
    elif action == "accept_as_head":
        # A records export is always a complete snapshot (as import_export treats it).
        if doc.get("format") != RECORDS_FORMAT and (
                doc.get("kind") != "snapshot" or (doc.get("scope") or {}).get("kind") != "complete"):
            raise ApiError(409, "not_reconcilable", "Only complete snapshots can be accepted as head explicitly.")
        doc = dict(doc, parent_revision=current)  # removals computed against the current head
    else:
        raise ApiError(400, "invalid_input", "action must be 'retry' or 'accept_as_head'.")
    status, body, affected = import_export(c, actor, imp["raw_bytes"], doc, declared=declared)
    new_id_ = body["import_id"]
    c.execute("UPDATE source_import SET reconciled_by=? WHERE import_id=?", (new_id_, import_id))
    c.execute("UPDATE source_import SET diagnostics_json=? WHERE import_id=?", (json.dumps(
        json.loads(c.execute("SELECT diagnostics_json FROM source_import WHERE import_id=?", (new_id_,))
                   .fetchone()[0]) + [{"code": "reconciliation", "action": action, "of_import": import_id,
                                       "declared_parent": declared.get("parent_revision")}]),
        new_id_))
    return status, _receipt(c, new_id_), affected


# ---------------------------------------------------------------- storage helpers
def _record_import(c, import_id, doc, raw, raw_digest, adapter, outcome, snapshot_id, diags, actor,
                   duplicate_of=None):
    c.execute("INSERT INTO source_import (import_id, source, project, revision, parent_revision, kind, scope_json, "
              "format, raw_digest, raw_bytes, adapter_version, outcome, snapshot_id, diagnostics_json, actor, "
              "received_at, duplicate_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (import_id, _text(doc.get("source")) or "?", doc.get("project"), _text(doc.get("revision")),
               _text(doc.get("parent_revision")),
               _text(doc.get("kind")) or ("records" if doc.get("records") is not None else None),
               json.dumps(doc.get("scope") or {}), _text(doc.get("format")), raw_digest, raw, adapter, outcome,
               snapshot_id, json.dumps(diags), actor, now(), duplicate_of))


def _receipt(c, import_id):
    r = c.execute("SELECT * FROM source_import WHERE import_id=?", (import_id,)).fetchone()
    body = {"import_id": r["import_id"], "outcome": r["outcome"], "source": r["source"], "project": r["project"],
            "revision": r["revision"], "parent_revision": r["parent_revision"], "raw_digest": r["raw_digest"],
            "adapter_version": r["adapter_version"], "snapshot_id": r["snapshot_id"],
            "duplicate_of": r["duplicate_of"], "received_at": r["received_at"],
            "diagnostics": json.loads(r["diagnostics_json"])}
    head = c.execute("SELECT revision, head_seq FROM source_head WHERE source=? AND project=?",
                     (r["source"], r["project"])).fetchone()
    body["source_head_after"] = dict(head) if head else None
    if r["snapshot_id"]:
        body["counts"] = snapshot_counts(c, r["snapshot_id"])
    return body


def snapshot_counts(c, sid):
    q = lambda sql: c.execute(sql, (sid,)).fetchone()[0]
    return {
        "elements_present": q("SELECT COUNT(*) FROM snapshot_element WHERE snapshot_id=? AND state='present'"),
        "elements_deleted": q("SELECT COUNT(*) FROM snapshot_element WHERE snapshot_id=? AND state='deleted'"),
        "relationships_present": q("SELECT COUNT(*) FROM snapshot_relationship WHERE snapshot_id=? AND state='present'"),
        "records": q("SELECT COUNT(*) FROM external_record WHERE snapshot_id=?"),
        "total_logical_entities_in_project": c.execute(
            "SELECT COUNT(*) FROM element_identity WHERE project=(SELECT project FROM source_snapshot "
            "WHERE snapshot_id=?)", (sid,)).fetchone()[0],
        "total_snapshots_in_project": c.execute(
            "SELECT COUNT(*) FROM source_snapshot WHERE project=(SELECT project FROM source_snapshot "
            "WHERE snapshot_id=?)", (sid,)).fetchone()[0],
    }


def _head_snapshot(c, head):
    if head is None:
        return None
    return c.execute("SELECT * FROM source_snapshot WHERE snapshot_id=?", (head["snapshot_id"],)).fetchone()


def _snapshot_at(c, source, project, revision):
    """The snapshot of a revision, preferring the head-eligible one over a staged partial view of it."""
    return c.execute("SELECT * FROM source_snapshot WHERE source=? AND project=? AND revision=? "
                     "ORDER BY completeness='partial' LIMIT 1", (source, project, revision)).fetchone()


def _earlier_digest(stored_adapter, declared):
    """Normalized digest of a model export as adapters before 0.3.1 computed it: they read an export without
    definitions on its own, not against its parent's definitions. None if the stored adapter read it as this
    one does."""
    name, _, version = (stored_adapter or "").rpartition("/")
    try:
        older = tuple(int(x) for x in version.split(".")) < (0, 3, 1)
    except ValueError:
        return None
    if name != ADAPTER_VERSION.rpartition("/")[0] or not older or declared.get("definitions"):
        return None
    return digest(normalize_model(declared)[0])


def _base_definitions(c, doc):
    """A delta or partial export may omit definitions; it is then read against its parent's definitions."""
    scope = doc.get("scope") if isinstance(doc.get("scope"), dict) else {}
    if doc.get("definitions") or not (doc.get("kind") == "delta" or scope.get("kind") == "partial"):
        return None
    source, project, parent = doc.get("source"), doc.get("project"), doc.get("parent_revision")
    if not (isinstance(source, str) and isinstance(parent, str)):
        return None
    snap = _snapshot_at(c, source, project, parent)
    return json.loads(snap["definitions_json"]) if snap else None


def _ambiguous_deletions(c, source, project, base, elements, rels, deletions):
    """Element and relationship IDs are separate namespaces, but deletions are one flat list. A deletion ID
    that names both a present element and a present relationship is refused rather than applied to both."""
    def in_base(table, column, uid):
        return base is not None and c.execute(
            f"SELECT 1 FROM {table} WHERE snapshot_id=? AND {column}=? AND state='present'",
            (base["snapshot_id"], uid)).fetchone() is not None
    el_ids, rel_ids = {e["id"] for e in elements}, {r["id"] for r in rels}
    out = []
    for native in deletions:
        if ((native in el_ids or in_base("snapshot_element", "entity_uid", entity_uid(source, project, native)))
                and (native in rel_ids or in_base("snapshot_relationship", "rel_uid", rel_uid(source, project, native)))):
            out.append({"code": "ambiguous_deletion_id", "id": native,
                        "message": "ID names both an element and a relationship; deletion not applied."})
    return out


def _advance_head(c, source, project, revision, sid, import_id):
    row = c.execute("SELECT head_seq FROM source_head WHERE source=? AND project=?", (source, project)).fetchone()
    seq = (row["head_seq"] if row else 0) + 1
    c.execute("INSERT INTO source_head (source, project, revision, snapshot_id, head_seq, updated_at) "
              "VALUES (?,?,?,?,?,?) ON CONFLICT(source, project) DO UPDATE SET revision=excluded.revision, "
              "snapshot_id=excluded.snapshot_id, head_seq=excluded.head_seq, updated_at=excluded.updated_at",
              (source, project, revision, sid, seq, now()))
    c.execute("INSERT INTO head_history VALUES (?,?,?,?,?,?,?)", (source, project, seq, revision, sid, import_id, now()))
    enqueue_event(c, project, "source.head_advanced",
                  {"source": source, "project": project, "revision": revision, "snapshot_id": sid,
                   "head_seq": seq}, import_id)


def _store_record_snapshot(c, doc, import_id, raw_digest, norm_digest, records, warnings):
    sid = new_id("snap")
    c.execute("INSERT INTO source_snapshot (snapshot_id, source, project, revision, parent_revision, kind, completeness, "
              "scope_json, raw_digest, normalized_digest, adapter_version, status, definitions_json, import_id, "
              "created_at, warnings_json, unrecognized_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (sid, doc["source"], doc["project"], doc["revision"], doc.get("parent_revision"), "records", "complete",
               json.dumps({"kind": "complete"}), raw_digest, norm_digest, RECORDS_ADAPTER_VERSION, "head", "{}",
               import_id, now(), json.dumps(warnings),
               json.dumps({k: v for k, v in doc.items() if k not in KNOWN_RECORDS_TOP}, sort_keys=True)))
    for r in records:
        c.execute("INSERT INTO external_record VALUES (?,?,?,?,?,?,?)",
                  (sid, r["id"], "rv_" + digest(r)[:16], r["kind"], r["asset_ref"], r["text"],
                   json.dumps(r.get("unrecognized") or {}, sort_keys=True)))
    return sid


def _store_model_snapshot(c, doc, import_id, raw_digest, norm_digest, normalized, elements, rels, warnings, base,
                          status):
    source, project = doc["source"], doc["project"]
    sid = new_id("snap")
    kind = doc["kind"]
    completeness = "partial" if (doc.get("scope") or {}).get("kind") == "partial" else (
        "delta" if kind == "delta" else "complete")
    defs = doc.get("definitions") or {}
    if (kind == "delta" or completeness == "partial") and base is not None and not defs:
        defs = json.loads(base["definitions_json"])  # same definitions normalize_model read it against
    c.execute("INSERT INTO source_snapshot (snapshot_id, source, project, revision, parent_revision, kind, completeness, "
              "scope_json, raw_digest, normalized_digest, adapter_version, status, definitions_json, import_id, "
              "created_at, warnings_json, unrecognized_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (sid, source, project, doc["revision"], doc.get("parent_revision"), kind, completeness,
               json.dumps(doc.get("scope") or {}), raw_digest, norm_digest, ADAPTER_VERSION, status,
               json.dumps(defs, sort_keys=True), import_id, now(), json.dumps(warnings),
               json.dumps({k: v for k, v in doc.items() if k not in KNOWN_TOP}, sort_keys=True)))

    base_members = {}
    base_rels = {}
    if base is not None:
        for r in c.execute("SELECT entity_uid, version_id, state FROM snapshot_element WHERE snapshot_id=?",
                           (base["snapshot_id"],)):
            base_members[r["entity_uid"]] = (r["version_id"], r["state"])
        for r in c.execute("SELECT rel_uid, version_id, state FROM snapshot_relationship WHERE snapshot_id=?",
                           (base["snapshot_id"],)):
            base_rels[r["rel_uid"]] = (r["version_id"], r["state"])

    members = {}  # uid -> (version_id, state, observed)
    if completeness in ("delta",) or completeness == "partial":
        if completeness == "delta":
            members = {u: (v, s, 0) for u, (v, s) in base_members.items()}
    for e in elements:
        uid = entity_uid(source, project, e["id"])
        c.execute("INSERT OR IGNORE INTO element_identity VALUES (?,?,?,?,?)", (uid, source, project, e["id"], sid))
        content = {k: e[k] for k in ("type", "name", "owner", "properties", "unrecognized")}
        cdig = digest(content)
        vid = "ev_" + sha256(uid + cdig)[:20]
        # Content-addressed: an identical version may exist. Any other constraint failure must raise.
        c.execute("INSERT INTO element_version VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(version_id) DO NOTHING",
                  (vid, uid, e["type"], e["name"], e["owner"], json.dumps(e["properties"], sort_keys=True),
                   json.dumps(e["unrecognized"], sort_keys=True), cdig, f"{import_id}#{e['pointer']}"))
        members[uid] = (vid, "present", 1)
    if completeness == "complete":
        # Complete scope: anything present in the base but not observed is a detected removal.
        for u, (v, s) in base_members.items():
            if u not in members:
                members[u] = (v, "deleted", 0)
    del_warn = []
    for native in normalized["deletions"]:
        uid = entity_uid(source, project, native)
        if uid in members:
            members[uid] = (members[uid][0], "deleted", 1)
        elif rel_uid(source, project, native) not in base_rels:
            del_warn.append({"code": "deletion_of_unknown_id", "id": native})
    for uid, (vid, state, observed) in members.items():
        c.execute("INSERT INTO snapshot_element VALUES (?,?,?,?,?)", (sid, uid, vid, state, observed))

    # Relationships
    rmembers = {}
    if completeness == "delta":
        rmembers = {u: (v, s) for u, (v, s) in base_rels.items()}
    uid_of = lambda native: entity_uid(source, project, native) if native else None
    for r in rels:
        ruid = rel_uid(source, project, r["id"])
        s_uid, t_uid = uid_of(r["source"]), uid_of(r["target"])
        content = {"predicate": r["type"], "source": s_uid, "target": t_uid, "multiplicity": r["multiplicity"]}
        if r.get("unrecognized"):
            content["unrecognized"] = r["unrecognized"]
        cdig = digest(content)
        vid = "rv_" + sha256(ruid + cdig)[:20]
        mult = r["multiplicity"]
        if mult is not None and not isinstance(mult, str):
            mult = json.dumps(mult, sort_keys=True)  # a structured or numeric one (of any size) is stored as JSON text
        c.execute("INSERT INTO relationship_version VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(version_id) DO NOTHING",
                  (vid, ruid, r["id"], r["type"], s_uid or "", t_uid or "", mult, "source",
                   json.dumps({"import_id": import_id, "pointer": r["pointer"]}), cdig,
                   json.dumps(r.get("unrecognized") or {}, sort_keys=True)))
        rmembers[ruid] = (vid, "present")
    if completeness == "complete":
        for u, (v, s) in base_rels.items():
            if u not in rmembers:
                rmembers[u] = (v, "deleted")
    for native in normalized["deletions"]:
        ruid = rel_uid(source, project, native)
        if ruid in rmembers:
            rmembers[ruid] = (rmembers[ruid][0], "deleted")
    for ruid, (vid, state) in rmembers.items():
        rv = c.execute("SELECT source_uid, target_uid FROM relationship_version WHERE version_id=?", (vid,)).fetchone()
        status_ = "resolved"
        if state == "present":
            for end in (rv["source_uid"], rv["target_uid"]):
                m = members.get(end)
                if m is None:
                    known = c.execute("SELECT 1 FROM element_identity WHERE entity_uid=?", (end,)).fetchone()
                    status_ = "unresolved_outside_scope" if (known and completeness == "partial") else "unresolved"
                elif m[1] == "deleted":
                    status_ = "dangling_deleted_endpoint"
        c.execute("INSERT INTO snapshot_relationship VALUES (?,?,?,?,?)", (sid, ruid, vid, state, status_))
    if del_warn:
        w = json.loads(c.execute("SELECT warnings_json FROM source_snapshot WHERE snapshot_id=?", (sid,)).fetchone()[0])
        c.execute("UPDATE source_snapshot SET warnings_json=? WHERE snapshot_id=?", (json.dumps(w + del_warn), sid))
    return sid, del_warn


# ---------------------------------------------------------------- change detection
def _obj(v):
    return v if isinstance(v, dict) else {}


def _json_differs(a, b, k):
    # Compared as JSON, not with Python ==, so 0 -> false or 1 -> 1.0 is still a change.
    return (k in a) != (k in b) or canonical_json(a.get(k)) != canonical_json(b.get(k))


def diff_snapshots(c, old_sid, new_sid):
    """Classify changes between two model snapshots: data, structural (definitions) and semantic."""
    def members(sid):
        out = {}
        for r in c.execute("SELECT se.entity_uid, se.state, ev.*, ei.native_id FROM snapshot_element se "
                           "JOIN element_version ev ON ev.version_id=se.version_id "
                           "JOIN element_identity ei ON ei.entity_uid=se.entity_uid WHERE se.snapshot_id=?", (sid,)):
            out[r["entity_uid"]] = r
        return out

    def rels(sid):
        return {r["rel_uid"]: r for r in c.execute(
            "SELECT sr.rel_uid, sr.state, sr.endpoint_status, rv.* FROM snapshot_relationship sr "
            "JOIN relationship_version rv ON rv.version_id=sr.version_id WHERE sr.snapshot_id=?", (sid,))}

    old, new = members(old_sid), members(new_sid)
    out = {"data": [], "structural": [], "semantic": [], "identity_review": [], "relationships": []}
    removed_now = []
    for uid, n in new.items():
        o = old.get(uid)
        if o is None or o["state"] == "deleted":
            if n["state"] == "present":
                out["data"].append({"change": "element_added", "entity_uid": uid, "source_id": n["native_id"],
                                    "name": n["name"]})
            continue
        if n["state"] == "deleted":
            out["data"].append({"change": "element_deleted", "entity_uid": uid, "source_id": n["native_id"],
                                "name": o["name"]})
            removed_now.append(n)
            continue
        if o["version_id"] == n["version_id"]:
            continue
        if o["name"] != n["name"]:
            out["data"].append({"change": "renamed_identity_preserved", "entity_uid": uid,
                                "source_id": n["native_id"], "from": o["name"], "to": n["name"]})
        for col in ("type", "owner"):  # a reclassified element can leave a projected resource
            if o[col] != n[col]:
                out["data"].append({"change": f"{col}_changed", "entity_uid": uid, "source_id": n["native_id"],
                                    "from": o[col], "to": n[col]})
        op, np_ = json.loads(o["properties_json"]), json.loads(n["properties_json"])
        for k in sorted(set(op) | set(np_)):
            if _json_differs(op, np_, k):
                out["data"].append({"change": "property_value", "entity_uid": uid, "source_id": n["native_id"],
                                    "property": k, "from": op.get(k, "<missing>"), "to": np_.get(k, "<missing>")})
        ou, nu = json.loads(o["unrecognized_json"]), json.loads(n["unrecognized_json"])
        changed = sorted(k for k in set(ou) | set(nu) if _json_differs(ou, nu, k))
        if changed:
            out["data"].append({"change": "unrecognized_content_changed", "entity_uid": uid,
                                "source_id": n["native_id"], "keys": changed})
    for uid, o in old.items():
        if uid not in new and o["state"] == "present":
            out["data"].append({"change": "not_observed", "entity_uid": uid, "source_id": o["native_id"]})
    # Possible replacements: a new identity of the same type/owner appears while one disappears. Never merged.
    added = [new[d["entity_uid"]] for d in out["data"] if d["change"] == "element_added"]
    for gone in removed_now:
        for a in added:
            if a["type"] == gone["type"] and a["owner"] == gone["owner"]:
                out["identity_review"].append({
                    "change": "possible_replacement_not_merged", "removed": gone["native_id"],
                    "added": a["native_id"],
                    "message": "New source ID with same type/owner as a removed element. Identities are kept "
                               "separate; links to the removed element need re-review."})

    od = json.loads(c.execute("SELECT definitions_json FROM source_snapshot WHERE snapshot_id=?", (old_sid,)).fetchone()[0])
    nd = json.loads(c.execute("SELECT definitions_json FROM source_snapshot WHERE snapshot_id=?", (new_sid,)).fetchone()[0])
    ot, nt = _obj(od.get("types")), _obj(nd.get("types"))
    for tname in sorted(set(ot) | set(nt)):
        if tname not in nt:
            out["structural"].append({"change": "type_removed", "type": tname})
            continue
        if tname not in ot:
            out["structural"].append({"change": "type_added", "type": tname})
            continue
        op, np_ = _obj(_obj(ot[tname]).get("properties")), _obj(_obj(nt[tname]).get("properties"))
        for p in sorted(set(op) | set(np_)):
            # Presence is tested with `in`: a definition without attributes ({}) is still a definition.
            if p not in np_:
                out["structural"].append({"change": "property_definition_removed", "type": tname, "property": p})
            elif p not in op:
                out["structural"].append({"change": "property_definition_added", "type": tname, "property": p})
            else:
                a, b = _obj(op[p]), _obj(np_[p])
                if a.get("type") != b.get("type"):
                    out["structural"].append({"change": "property_type_changed", "type": tname, "property": p,
                                              "from": a.get("type"), "to": b.get("type")})
                if a.get("unit") != b.get("unit"):
                    out["semantic"].append({"change": "unit_changed", "type": tname, "property": p,
                                            "from": a.get("unit"), "to": b.get("unit"),
                                            "note": "JSON type unchanged; meaning of values changed."})
                if a.get("enum") != b.get("enum"):
                    out["semantic"].append({"change": "enum_changed", "type": tname, "property": p,
                                            "added": sorted(set(b.get("enum") or []) - set(a.get("enum") or [])),
                                            "removed": sorted(set(a.get("enum") or []) - set(b.get("enum") or []))})
    orl, nrl = _obj(od.get("relationshipTypes")), _obj(nd.get("relationshipTypes"))
    for rname in sorted(set(orl) | set(nrl)):
        a, b = _obj(orl.get(rname)), _obj(nrl.get(rname))
        if rname not in nrl:
            out["structural"].append({"change": "relationship_type_removed", "predicate": rname})
        elif rname not in orl:
            out["structural"].append({"change": "relationship_type_added", "predicate": rname})
        elif (a.get("from"), a.get("to")) != (b.get("from"), b.get("to")):
            out["semantic"].append({"change": "relationship_direction_changed", "predicate": rname,
                                    "from": f"{a.get('from')}->{a.get('to')}", "to": f"{b.get('from')}->{b.get('to')}"})
    orr, nrr = rels(old_sid), rels(new_sid)
    for ruid, n in nrr.items():
        o = orr.get(ruid)
        if (o is None or o["state"] == "deleted") and n["state"] == "present":
            out["relationships"].append({"change": "relationship_added", "id": n["native_id"],
                                         "endpoint_status": n["endpoint_status"]})
        elif o is not None and o["state"] == "present" and n["state"] == "deleted":
            out["relationships"].append({"change": "relationship_deleted", "id": n["native_id"]})
        elif o is not None and o["version_id"] != n["version_id"]:
            out["relationships"].append({"change": "relationship_changed", "id": n["native_id"]})
        if n["state"] == "present" and n["endpoint_status"] != "resolved":
            out["relationships"].append({"change": "endpoint_issue", "id": n["native_id"],
                                         "endpoint_status": n["endpoint_status"]})
    return out
