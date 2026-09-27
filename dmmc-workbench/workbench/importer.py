"""Import adapter: synthetic JSON model exports and evidence artifacts.

Imported descriptions are ASSERTIONS. The adapter parses, type-checks, assigns
stable namespaced identities, keeps the original bytes and their digest, and records
a JSON Pointer for every element so citations resolve against the immutable snapshot.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import config, db
from .identity import Denied, authorize, deny_and_audit
from .util import digest_obj, now, pointer, sha256


class ImportError_(ValueError):
    pass


# Identifiers end up in package ids, URLs and export paths: keep them to a safe alphabet.
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
SAFE_ID = {"bnd:": re.compile(r"^bnd:[A-Za-z0-9._-]{1,64}$"), "cmp:": re.compile(r"^cmp:[A-Za-z0-9._-]{1,64}$"),
           "flow:": re.compile(r"^flow:[A-Za-z0-9._-]{1,64}$")}
MAX_MODEL_BYTES = 1_000_000
MAX_NESTING = 64
MAX_STRING = 2000


def _nesting_depth(raw: bytes) -> int:
    """Max [/{ depth outside JSON strings, in one linear pass (json.loads would recurse first)."""
    depth = best = 0
    in_str = esc = False
    for ch in raw.decode("utf-8", errors="replace"):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
            best = max(best, depth)
        elif ch in "]}":
            depth -= 1
    return best


def _long_strings(obj, path="", out=None):
    out = [] if out is None else out
    if isinstance(obj, str) and len(obj) > MAX_STRING:
        out.append(path or "/")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            _long_strings(v, f"{path}/{k}", out)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _long_strings(v, f"{path}/{i}", out)
    return out


def _require(cond, msg, errors):
    if not cond:
        errors.append(msg)


def validate_model(doc) -> list[str]:
    e: list[str] = []
    if not isinstance(doc, dict):
        return ["model export must be a JSON object"]
    _require(doc.get("contract") == config.MODEL_CONTRACT, "contract must be dmmc-workbench/model-export", e)
    _require(doc.get("contract_version") in config.MODEL_CONTRACT_VERSIONS, "unsupported contract_version", e)
    for k in ("project", "source_id", "revision"):
        v = doc.get(k)
        _require(isinstance(v, str) and v, f"missing string field {k}", e)
        if isinstance(v, str) and v and not SAFE_TOKEN.match(v.replace(":", "-") if k == "source_id" else v):
            e.append(f"{k} must be 1-64 characters from A-Z a-z 0-9 . _ -" + (" :" if k == "source_id" else ""))
    _require(isinstance(doc.get("synthetic"), bool), "synthetic flag must be an explicit boolean", e)
    ids = set()
    for kind, prefix in (("boundaries", "bnd:"), ("elements", "cmp:"), ("flows", "flow:")):
        items = doc.get(kind)
        if not isinstance(items, list):
            e.append(f"{kind} must be a list")
            continue
        for i, it in enumerate(items):
            iid = it.get("id") if isinstance(it, dict) else None
            if not (isinstance(iid, str) and SAFE_ID[prefix].match(iid)):
                e.append(f"{kind}[{i}]: id must be {prefix!r} followed by 1-64 characters from A-Z a-z 0-9 . _ -")
                continue
            if iid in ids:
                e.append(f"duplicate id {iid}")
            ids.add(iid)
            if kind in ("elements", "flows"):
                rev = it.get("revision")
                if not (isinstance(rev, str) and SAFE_TOKEN.match(rev)):
                    e.append(f"{iid}: revision required (1-64 characters from A-Z a-z 0-9 . _ -)")
    bnds = {b.get("id") for b in doc.get("boundaries", []) if isinstance(b, dict)}
    els = {x.get("id") for x in doc.get("elements", []) if isinstance(x, dict)}
    for x in doc.get("elements", []) or []:
        if isinstance(x, dict) and x.get("boundary") not in bnds:
            e.append(f"{x.get('id')}: boundary {x.get('boundary')!r} not defined")
    for f in doc.get("flows", []) or []:
        if isinstance(f, dict):
            for end in ("source", "target"):
                if f.get(end) not in els:
                    e.append(f"{f.get('id')}: {end} {f.get(end)!r} is not a defined element")
    for path in _long_strings(doc)[:5]:
        e.append(f"string at {path} is longer than {MAX_STRING} characters")
    return e


def parse_model(raw: bytes):
    """Bounded parse: size and nesting are checked before json.loads can recurse."""
    if len(raw) > MAX_MODEL_BYTES:
        raise ImportError_(f"model export is larger than {MAX_MODEL_BYTES} bytes")
    if _nesting_depth(raw) > MAX_NESTING:
        raise ImportError_(f"model export nests deeper than {MAX_NESTING} levels")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as ex:
        raise ImportError_(f"not valid JSON: {ex}") from ex
    except RecursionError as ex:
        raise ImportError_("model export nests too deeply") from ex


def import_model(conn, actor: str, raw: bytes, *, op_id: str | None = None) -> dict:
    doc = parse_model(raw)
    errors = validate_model(doc)
    if errors:
        raise ImportError_("; ".join(errors))
    project = doc["project"]
    digest = sha256(raw)
    request = {"digest": digest}
    try:
        authorize(conn, actor, "import_model", project)
    except Denied as d:
        deny_and_audit(conn, d, "import_model", target=project, op_id=op_id)
        raise
    with db.tx(conn):
        prior = db.find_operation(conn, op_id, "import_model", request)
        if prior:
            return prior
        existing = conn.execute("SELECT id FROM snapshots WHERE project=? AND digest=?",
                                (project, digest)).fetchone()
        prev = conn.execute("SELECT current_snapshot_id FROM project_state WHERE project=?", (project,)).fetchone()
        if existing:
            sid = existing["id"]
            created = False
        else:
            seq = db.next_seq(conn, "snapshots")
            sid = f"snap-{seq:03d}-{doc['revision']}-{digest[:8]}"
            conn.execute("INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (sid, seq, project, doc["source_id"], doc["revision"], digest, raw, now(), actor,
                          config.ADAPTER_VERSION, int(doc["synthetic"])))
            bmap = {}
            for i, b in enumerate(doc["boundaries"]):
                bmap[b["id"]] = b
                conn.execute("INSERT INTO boundaries VALUES (?,?,?,?,?)",
                             (sid, b["id"], b.get("name"), b.get("kind"), pointer("boundaries", i)))
            emap = {}
            for i, el in enumerate(doc["elements"]):
                emap[el["id"]] = el
                conn.execute("INSERT INTO elements VALUES (?,?,?,?,?,?,?,?)",
                             (sid, el["id"], el.get("type", "component"), el.get("name"), el["revision"],
                              el.get("boundary"), pointer("elements", i), json.dumps(el)))
            for i, f in enumerate(doc["flows"]):
                crosses = emap[f["source"]].get("boundary") != emap[f["target"]].get("boundary")
                conn.execute("INSERT INTO flows VALUES (?,?,?,?,?,?,?,?)",
                             (sid, f["id"], f["source"], f["target"], f["revision"], int(crosses),
                              pointer("flows", i), json.dumps(f)))
            created = True
        conn.execute("INSERT OR REPLACE INTO project_state VALUES (?,?,?)", (project, sid, now()))
        result = {"snapshot_id": sid, "digest": digest, "created": created, "project": project,
                  "revision": doc["revision"], "previous_snapshot_id": prev["current_snapshot_id"] if prev else None}
        db.record_operation(conn, op_id, "import_model", actor, request, result)
        db.audit(conn, actor, "import_model", "ok", op_id=op_id, target=project,
                 prior_ref=result["previous_snapshot_id"], new_ref=sid,
                 detail={"digest": digest, "created": created, "synthetic": doc["synthetic"]})
    return result


EVIDENCE_REQUIRED = ("evidence_id", "kind", "type", "project", "producer", "collection_method",
                     "collected_at", "environment", "target", "media_type", "synthetic")


def import_evidence(conn, actor: str, meta_path: Path, *, op_id: str | None = None) -> dict:
    meta = json.loads(Path(meta_path).read_text())
    missing = [k for k in EVIDENCE_REQUIRED if k not in meta]
    if missing:
        raise ImportError_(f"evidence metadata missing {missing}")
    if meta["kind"] not in ("assertion", "observation"):
        raise ImportError_("evidence kind must be 'assertion' or 'observation'")
    raw = (Path(meta_path).parent / meta["payload_file"]).read_bytes()
    # The digest covers the envelope (target identity, environment, producer...) AND the payload.
    # Hashing the payload alone let two artifacts about different revisions share an identity.
    digest = evidence_digest(meta, raw)
    request = {"evidence_id": meta["evidence_id"], "digest": digest}
    try:
        authorize(conn, actor, "import_evidence", meta["project"])
    except Denied as d:
        deny_and_audit(conn, d, "import_evidence", target=meta["evidence_id"], op_id=op_id)
        raise
    with db.tx(conn):
        prior = db.find_operation(conn, op_id, "import_evidence", request)
        if prior:
            return prior
        ex = conn.execute("SELECT digest FROM evidence WHERE id=?", (meta["evidence_id"],)).fetchone()
        if ex and ex["digest"] != digest:
            raise ImportError_(f"evidence id {meta['evidence_id']} already exists with different content; "
                               "use a new id for replacement evidence")
        if not ex:
            conn.execute("INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (meta["evidence_id"], meta["project"], digest, raw, meta["media_type"], json.dumps(meta),
                          meta["kind"], meta["type"], int(bool(meta["synthetic"])), now(), actor))
        _set_status(conn, meta["evidence_id"], "active", actor, "imported")
        result = {"evidence_id": meta["evidence_id"], "digest": digest, "created": not ex}
        db.record_operation(conn, op_id, "import_evidence", actor, request, result)
        db.audit(conn, actor, "import_evidence", "ok", op_id=op_id, target=meta["evidence_id"], new_ref=digest)
    return result


def evidence_digest(meta: dict, raw: bytes) -> str:
    return digest_obj({"meta": meta, "payload_sha256": sha256(raw)})


def _set_status(conn, evidence_id, status, actor, reason):
    conn.execute("INSERT INTO evidence_events (evidence_id, status, actor, reason, at) VALUES (?,?,?,?,?)",
                 (evidence_id, status, actor, reason, now()))


def evidence_status(conn, evidence_id) -> str:
    r = conn.execute("SELECT status FROM evidence_events WHERE evidence_id=? ORDER BY seq DESC LIMIT 1",
                     (evidence_id,)).fetchone()
    return r["status"] if r else "unknown"


def set_evidence_status(conn, actor: str, evidence_id: str, status: str, reason: str):
    """Withdraw or restore. Raw bytes and history are always retained."""
    if status not in ("active", "withdrawn"):
        raise ValueError("status must be active or withdrawn")
    ev = conn.execute("SELECT project FROM evidence WHERE id=?", (evidence_id,)).fetchone()
    if ev is None:
        raise ImportError_(f"unknown evidence {evidence_id}")
    try:
        authorize(conn, actor, "withdraw_evidence", ev["project"])
    except Denied as d:
        deny_and_audit(conn, d, f"evidence_{status}", target=evidence_id)
        raise
    with db.tx(conn):
        _set_status(conn, evidence_id, status, actor, reason)
        db.audit(conn, actor, "evidence_" + status, "ok", target=evidence_id, detail={"reason": reason})


def import_evidence_dir(conn, actor, directory: Path) -> list[dict]:
    return [import_evidence(conn, actor, p) for p in sorted(Path(directory).glob("*.meta.json"))]
