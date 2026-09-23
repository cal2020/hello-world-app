"""Pinned reference data: control catalog excerpt, curated mappings, reviewed policy bundle.

Each is loaded with a content digest. Changing any of them changes the dependency
manifest, which makes existing reviews STALE.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import config, db
from .util import digest_obj, now, sha256


class ReferenceError_(ValueError):
    pass


def _walk_parts(parts):
    for p in parts or []:
        yield p
        yield from _walk_parts(p.get("parts"))


def statement_ids(control: dict) -> set[str]:
    return {p["id"] for p in _walk_parts(control.get("parts")) if p.get("name") in ("statement", "item")}


def load_catalog(path: Path = None) -> dict:
    raw = (path or config.CATALOG_PATH).read_bytes()
    cat = json.loads(raw)
    cat["_digest"] = sha256(raw)
    cat["_index"] = {c["id"]: c for c in cat["controls"]}
    return cat


def validate_mappings(mappings: dict, catalog: dict) -> list[str]:
    """Unknown control IDs, statements or parameters are rejected, never guessed."""
    errors = []
    for ob in mappings["obligations"]:
        c = catalog["_index"].get(ob["control_id"])
        if c is None:
            errors.append(f"{ob['id']}: unknown control id {ob['control_id']!r} in pinned catalog")
            continue
        if ob["statement_id"] not in statement_ids(c):
            errors.append(f"{ob['id']}: unknown statement id {ob['statement_id']!r} for {ob['control_id']}")
        known_params = {p["id"] for p in c.get("params", [])}
        for pid in ob.get("params", {}):
            if pid not in known_params:
                errors.append(f"{ob['id']}: unknown parameter {pid!r} for {ob['control_id']}")
    return errors


def load_mappings(catalog: dict, path: Path = None) -> dict:
    raw = (path or config.MAPPINGS_PATH).read_bytes()
    m = json.loads(raw)
    errs = validate_mappings(m, catalog)
    if errs:
        raise ReferenceError_("; ".join(errs))
    m["_digest"] = sha256(raw)
    return m


def policy_bundle(policy_dir: Path = None) -> dict:
    d = policy_dir or config.POLICY_DIR
    files = {p.name: p.read_bytes() for p in sorted(d.glob("*.rego"))}
    policy = {k: v for k, v in files.items() if not k.endswith("_test.rego")}
    tests = {k: v for k, v in files.items() if k.endswith("_test.rego")}
    return {
        "dir": str(d),
        "policy_digest": digest_obj({k: sha256(v) for k, v in policy.items()}),
        "tests_digest": digest_obj({k: sha256(v) for k, v in tests.items()}),
        "requirements_digest": sha256((d / "requirements.md").read_bytes()) if (d / "requirements.md").exists() else None,
        "files": sorted(files),
    }


def install(conn, *, catalog_path=None, mappings_path=None, policy_dir=None):
    """Load reference data into the DB (idempotent). Returns the digests."""
    cat = load_catalog(catalog_path)
    maps = load_mappings(cat, mappings_path)
    pol = policy_bundle(policy_dir)
    rows = {
        "catalog": (cat["_digest"], {k: v for k, v in cat.items() if not k.startswith("_")}),
        "mappings": (maps["_digest"], {k: v for k, v in maps.items() if not k.startswith("_")}),
        "policy": (digest_obj([pol["policy_digest"], pol["tests_digest"]]), pol),
    }
    with db.tx(conn):
        for kind, (dg, content) in rows.items():
            cur = conn.execute("SELECT digest FROM reference_data WHERE kind=?", (kind,)).fetchone()
            if cur is None or cur["digest"] != dg:
                conn.execute("INSERT OR REPLACE INTO reference_data VALUES (?,?,?,?)",
                             (kind, dg, json.dumps(content), now()))
                db.audit(conn, "system", f"load_{kind}", "ok", new_ref=dg,
                         prior_ref=cur["digest"] if cur else None)
    return {k: v[0] for k, v in rows.items()}


def get(conn, kind: str) -> tuple[str, dict]:
    r = conn.execute("SELECT * FROM reference_data WHERE kind=?", (kind,)).fetchone()
    if r is None:
        raise ReferenceError_(f"reference data {kind!r} not loaded; run `python -m workbench reset`")
    content = json.loads(r["content_json"])
    if kind == "catalog":
        content["_index"] = {c["id"]: c for c in content["controls"]}
    return r["digest"], content


def statement_text(control: dict, statement_id: str) -> str:
    for p in _walk_parts(control.get("parts")):
        if p.get("id") == statement_id:
            texts = [p.get("prose", "")] + [
                f"{(q.get('props') or [{}])[0].get('value', '')} {q.get('prose', '')}".strip()
                for q in p.get("parts", []) or []]
            return "\n".join(t for t in texts if t)
    return ""
