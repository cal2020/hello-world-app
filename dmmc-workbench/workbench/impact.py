"""Change impact between two snapshots, keyed by STABLE ids (not array positions).

The report lists KNOWN affected dependency paths. It does not claim completeness:
review invalidation is conservative and does not depend on this analysis being right.
"""
from __future__ import annotations

import json

from . import checks, reference
from . import model as M


def _diff_fields(a, b, prefix=""):
    out = []
    keys = set(a) | set(b) if isinstance(a, dict) and isinstance(b, dict) else set()
    if not keys:
        return [prefix or "/"] if a != b else []
    for k in sorted(keys):
        if k not in a or k not in b:
            out.append(f"{prefix}/{k}")
        elif isinstance(a[k], dict) and isinstance(b[k], dict):
            out += _diff_fields(a[k], b[k], f"{prefix}/{k}")
        elif a[k] != b[k]:
            out.append(f"{prefix}/{k}")
    return out


def diff(conn, old_sid: str, new_sid: str) -> dict:
    changes = []
    for kind, loader in (("element", M.elements), ("flow", M.flows)):
        a, b = loader(conn, old_sid), loader(conn, new_sid)
        for i in sorted(set(a) | set(b)):
            if i not in a:
                changes.append({"kind": kind, "id": i, "change": "added", "new_revision": b[i]["revision"],
                                "crosses_boundary": bool(b[i].get("crosses")) if kind == "flow" else None})
            elif i not in b:
                changes.append({"kind": kind, "id": i, "change": "removed", "old_revision": a[i]["revision"]})
            else:
                fields = _diff_fields(a[i]["data"], b[i]["data"])
                if fields:
                    changes.append({"kind": kind, "id": i, "change": "changed", "fields": fields,
                                    "old_revision": a[i]["revision"], "new_revision": b[i]["revision"]})
    ba, bb = M.boundaries(conn, old_sid), M.boundaries(conn, new_sid)
    for i in sorted(set(ba) ^ set(bb)):
        changes.append({"kind": "boundary", "id": i, "change": "added" if i in bb else "removed"})
    return {"from": old_sid, "to": new_sid, "changes": changes}


def impact_report(conn, project: str, old_sid: str, new_sid: str, prior_package_id: str | None = None) -> dict:
    d = diff(conn, old_sid, new_sid)
    _, maps = reference.get(conn, "mappings")
    old_rows = {r["row_id"]: r for r in checks.expand_rows(maps, M.elements(conn, old_sid), M.flows(conn, old_sid))}
    new_rows = {r["row_id"]: r for r in checks.expand_rows(maps, M.elements(conn, new_sid), M.flows(conn, new_sid))}
    changed_ids = {c["id"] for c in d["changes"]}
    # A row is affected if its object changed, or if an endpoint of its flow changed.
    fls_new = M.flows(conn, new_sid)
    affected = []
    for rid, r in new_rows.items():
        why = []
        if r["object_id"] in changed_ids:
            why.append(f"{r['object_id']} changed")
        if r["object_kind"] == "flow":
            f = fls_new[r["object_id"]]
            for end in (f["source"], f["target"]):
                if end in changed_ids:
                    why.append(f"endpoint {end} changed")
        if rid not in old_rows:
            why.append("NEW ROW: scope rule now selects this object (review scope enlarged)")
        if why:
            affected.append({"row_id": rid, "why": why})
    removed_rows = [rid for rid in old_rows if rid not in new_rows]
    evidence = []
    els_old, fls_old = M.elements(conn, old_sid), M.flows(conn, old_sid)
    els_new = M.elements(conn, new_sid)
    for ev in M.all_evidence(conn, project):
        was, _ = M.applicability(ev, els_old, fls_old)
        now_ok, reasons = M.applicability(ev, els_new, fls_new)
        if was and not now_ok:
            evidence.append({"evidence_id": ev["id"], "change": "no longer applicable", "reasons": reasons})
    draft_sections = []
    if prior_package_id:
        from . import packages
        p = packages.get(conn, prior_package_id)
        draft = json.loads(p["draft_json"])
        old_doc = json.loads(M.snapshot(conn, old_sid)["raw"])
        ptr_to_id = {}
        for coll in ("elements", "flows", "boundaries"):
            for i, it in enumerate(old_doc[coll]):
                ptr_to_id[f"/{coll}/{i}"] = it["id"]
        for s in draft["sections"]:
            hit = set()
            for c in s["claims"]:
                for cite in c.get("cites", []):
                    if cite.startswith("model:"):
                        ptr = cite.split("#", 1)[1]
                        base = "/".join(ptr.split("/")[:3])
                        if ptr_to_id.get(base) in changed_ids:
                            hit.add(ptr_to_id[base])
            if s.get("row_id") in {a["row_id"] for a in affected}:
                hit.add("row affected")
            if hit:
                draft_sections.append({"section_id": s["id"], "because": sorted(hit)})
    return {
        **d,
        "affected_rows": affected,
        "removed_rows": removed_rows,
        "new_scope_rows": [a["row_id"] for a in affected if any(w.startswith("NEW ROW") for w in a["why"])],
        "evidence_applicability_changes": evidence,
        "draft_sections_citing_changed_objects": draft_sections,
        "review_effect": "All prior reviews for this project are STALE: the dependency manifest changed. "
                         "Invalidation does not depend on this impact list being complete.",
        "completeness": "Known dependency paths only (stable-id citations, row scopes, evidence targets). "
                        "Not claimed to be the complete impact set.",
    }
