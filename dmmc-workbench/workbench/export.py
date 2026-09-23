"""Export service: Markdown SSP excerpt, JSON evidence manifest, change-impact report,
and an OPTIONAL bounded OSCAL Component Definition that is only labelled OSCAL if it
passes the pinned JSON Schema and our referential-integrity checks.

"Current" exports require REVIEWED_FOR_DEMO, fresh dependencies, a non-revoked
decision and a reviewer whose authority is still current, all verified in one
transaction. "Historical" exports are always labelled with their status at export.
A downloaded file cannot be withdrawn later; the header says what it covered.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from . import config, db, drafting, impact, packages, reference
from . import model as M
from .identity import Denied, authorize, deny_and_audit
from .util import digest_obj, new_id, now, short

NS = "urn:x-dmmc-workbench:demo"


class ExportRefused(Exception):
    pass


def _u(*parts) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "dmmc-workbench:" + ":".join(parts)))


def _header(p, st, mode, manifest, export_id):
    ev = manifest["dependencies"]["evidence"]
    return {
        "notice": "SYNTHETIC DEMONSTRATION ARTIFACT. Partial excerpt prepared for expert review. Not an official "
                  "System Security Plan or Security Assessment Report, not an assessment result, and not an "
                  "authorization decision.",
        "export_id": export_id, "package_id": p["id"], "package_digest": p["package_digest"],
        "created_at": now(), "export_mode": mode, "status_at_export": st["effective_state"],
        "status_reasons": st["reasons"],
        "evidence_scope": [f"{e['id']}@{short(e['digest'])} ({e['status']})" for e in ev],
        "model_snapshot": manifest["dependencies"]["snapshot"],
        "drafter_mode": manifest["drafter"]["mode"],
    }


def render_markdown(conn, p, st, header, decisions) -> str:
    draft = json.loads(p["draft_json"])
    rows = json.loads(p["rows_json"])
    L = [f"# Draft SSP excerpt — {p['project']} ({header['status_at_export']})", ""]
    L += [f"> {header['notice']}", ""]
    L += ["| Field | Value |", "|---|---|"]
    for k in ("export_id", "package_id", "package_digest", "created_at", "export_mode", "status_at_export", "drafter_mode"):
        L.append(f"| {k} | `{header[k]}` |")
    L.append(f"| model snapshot | `{header['model_snapshot']['id']}` revision {header['model_snapshot']['revision']} |")
    L.append(f"| evidence scope | {', '.join(header['evidence_scope'])} |")
    if header["status_reasons"]:
        L.append(f"| status reasons | {'; '.join(header['status_reasons'])} |")
    L += ["", "## Obligation matrix", "",
          "| Row | Control stmt | Object (rev) | Evidence state | Check result | Gaps |", "|---|---|---|---|---|---|"]
    for r in rows:
        L.append(f"| {r['row_id']} | {r['statement_id']} | {r['object_id']} ({r['object_revision']}) | "
                 f"{r['evidence_state']} | **{r['result']}** | {len(r['gaps'])} |")
    cov = sum(1 for r in rows if r["evidence_state"] == "CURRENT")
    L += ["", f"{cov} of {len(rows)} selected demo obligation rows have current applicable evidence. "
          "This is not a compliance percentage.", ""]
    cites = {}

    def cref(c):
        if c not in cites:
            cites[c] = f"c{len(cites) + 1}"
        return cites[c]

    for s in draft["sections"]:
        L += [f"## {s['title']}", ""]
        for c in s["claims"]:
            v = c.get("validation", {})
            flag = "" if v.get("status") in ("CITATIONS_RESOLVE", "NO_CITATION_REQUIRED") else f" ⚠ **{v.get('status')}**"
            refs = " ".join(f"[{cref(x)}]" for x in c.get("cites", []))
            L.append(f"- **[{c['kind'].upper()}]** {c['text']} {refs}{flag}")
        L.append("")
    if draft.get("risks"):
        L += ["## Proposed risks and mitigations (hypotheses, not findings)", ""]
        for rk in draft["risks"]:
            refs = " ".join(f"[{cref(x)}]" for x in rk.get("triggering", []))
            L.append(f"- **Hypothesis:** {rk['hypothesis']} {refs}\n  - Assumptions: {'; '.join(rk['assumptions'])}"
                     f"\n  - Proposed mitigation: {rk['proposed_mitigation']}")
        L.append("")
    if draft.get("questions"):
        L += ["## Questions for a qualified reviewer", ""]
        for q in draft["questions"]:
            L.append(f"- {q['text']} " + " ".join(f"[{cref(x)}]" for x in q.get("cites", [])))
        L.append("")
    L += ["## Review record (document review only)", ""]
    if not decisions:
        L.append("- No review decision.")
    for d in decisions:
        L.append(f"- `{d['id']}` {d['decision']} by {d['actor']} at {d['created_at']}: {d['reason']}"
                 + (f" — REVOKED by {d['revoked']['actor']}: {d['revoked']['reason']}" if d["revoked"] else "")
                 + f" (bound to package digest `{short(d['package_digest'])}`; acknowledged gap rows: {len(d['limitations'])})")
    L += ["", "## Citations (immutable versions)", ""]
    for c, n in cites.items():
        try:
            val = drafting.resolve_citation(conn, c)
            shown = json.dumps(val)[:140] if not isinstance(val, str) else val.replace("\n", " ")[:140]
            L.append(f"- [{n}] `{c[:110]}` → {shown}")
        except Exception as e:
            L.append(f"- [{n}] `{c[:110]}` → UNRESOLVED ({e})")
    return "\n".join(L) + "\n"


def oscal_component_definition(conn, p, header) -> tuple[dict, dict]:
    rows = json.loads(p["rows_json"])
    manifest = json.loads(p["manifest_json"])
    cat_d, cat = reference.get(conn, "catalog")
    snap = M.snapshot(conn, p["snapshot_id"])
    els, fls = M.elements(conn, p["snapshot_id"]), M.flows(conn, p["snapshot_id"])
    src = cat["excerpt_of"]["upstream_url"]
    res_uuid = _u(p["id"], "catalog-resource")
    comps = {}
    for r in rows:
        oid = r["object_id"]
        if oid not in comps:
            if r["object_kind"] == "element":
                e = els[oid]
                title, desc, typ = f"{e['name']} (synthetic)", e["data"].get("description", "") or "Synthetic component.", "software"
            else:
                f = fls[oid]
                title, desc, typ = f"Flow {oid} (synthetic)", f"Synthetic data flow carrying {f['data'].get('data')}.", "interconnection"
            comps[oid] = {"uuid": _u(p["id"], oid), "type": typ, "title": title,
                          "description": desc + " Fictional demonstration data.",
                          "props": [{"name": "model-id", "ns": NS, "value": oid},
                                    {"name": "model-revision", "ns": NS, "value": r["object_revision"]}],
                          "control-implementations": [{"uuid": _u(p["id"], oid, "ci"), "source": src,
                                                       "description": "Demo implementation statements drafted for review. "
                                                                      "Check results apply only to local demo predicates.",
                                                       "implemented-requirements": []}]}
        comps[oid]["control-implementations"][0]["implemented-requirements"].append({
            "uuid": _u(p["id"], r["row_id"]), "control-id": r["control_id"],
            "description": f"Local demo obligation: {r['local_obligation']} Check result: {r['result']} "
                           f"(predicate-bounded; not a statement of control effectiveness). "
                           + (f"Open gaps: {' | '.join(r['gaps'])}" if r["gaps"] else "No open gaps recorded by the check."),
            "props": [{"name": "check-result", "ns": NS, "value": r["result"]},
                      {"name": "evidence-state", "ns": NS, "value": r["evidence_state"]},
                      {"name": "statement-id", "ns": NS, "value": r["statement_id"]}],
            "links": [{"href": f"#{res_uuid}", "rel": "reference"}],
        })
    doc = {"component-definition": {
        "uuid": _u(p["id"], p["package_digest"]),
        "metadata": {"title": f"Synthetic component definition for {p['project']} ({p['id']})",
                     "last-modified": header["created_at"],
                     "version": p["package_digest"][:12], "oscal-version": config.OSCAL_VERSION,
                     "remarks": header["notice"] + f" Status at export: {header['status_at_export']}."},
        "components": list(comps.values()),
        "back-matter": {"resources": [{"uuid": res_uuid, "title": cat["excerpt_of"]["title"],
                                       "rlinks": [{"href": src, "hashes": [{"algorithm": "SHA-256",
                                                                            "value": cat["excerpt_of"]["upstream_sha256"]}]}]}]},
    }}
    return doc, validate_oscal(doc, cat)


def validate_oscal(doc: dict, cat: dict) -> dict:
    rep = {"schema": f"OSCAL component definition JSON Schema v{config.OSCAL_VERSION}",
           "schema_file_sha256": None, "schema_valid": None, "schema_errors": [], "reference_errors": []}
    from .util import sha256
    raw = config.OSCAL_SCHEMA_PATH.read_bytes()
    rep["schema_file_sha256"] = sha256(raw)
    try:
        import jsonschema
        import regex  # OSCAL patterns use \\p{L}/\\p{N} classes that Python's `re` cannot compile
    except ImportError as e:
        rep["schema_valid"] = None
        rep["schema_errors"].append(f"{e.name} not installed; validation NOT RUN")
    else:
        def pattern(validator, patrn, instance, schema):
            if validator.is_type(instance, "string") and not regex.search(patrn, instance):
                yield jsonschema.ValidationError(f"{instance!r} does not match {patrn!r}")
        Validator = jsonschema.validators.extend(jsonschema.Draft7Validator, {"pattern": pattern})
        v = Validator(json.loads(raw))
        errs = sorted(v.iter_errors(doc), key=lambda e: list(e.path))
        rep["schema_valid"] = not errs
        rep["schema_errors"] = [f"{'/'.join(map(str, e.path))}: {e.message[:200]}" for e in errs[:20]]
    cd = doc["component-definition"]
    uuids = []
    known_controls = set(cat["_index"])
    res = {r["uuid"] for r in cd.get("back-matter", {}).get("resources", [])}
    for c in cd["components"]:
        uuids.append(c["uuid"])
        for ci in c["control-implementations"]:
            uuids.append(ci["uuid"])
            for ir in ci["implemented-requirements"]:
                uuids.append(ir["uuid"])
                if ir["control-id"] not in known_controls:
                    rep["reference_errors"].append(f"unknown control-id {ir['control-id']}")
                for ln in ir.get("links", []):
                    if ln["href"].startswith("#") and ln["href"][1:] not in res:
                        rep["reference_errors"].append(f"broken link {ln['href']}")
    if len(uuids) != len(set(uuids)):
        rep["reference_errors"].append("duplicate uuids")
    rep["valid_oscal_claim"] = bool(rep["schema_valid"]) and not rep["reference_errors"]
    rep["meaning"] = ("Structural conformance and reference integrity only. Says nothing about whether the "
                      "statements are true.")
    return rep


def export_package(conn, actor: str, package_id: str, *, mode: str = "current", op_id: str | None = None,
                   include_oscal: bool = True, out_root: Path | None = None) -> dict:
    if mode not in ("current", "historical"):
        raise ValueError("mode must be current or historical")
    p = packages.get(conn, package_id)
    action = "export_current" if mode == "current" else "export_historical"
    request = {"package_id": package_id, "mode": mode}
    try:
        authorize(conn, actor, action, p["project"])
    except Denied as d:
        deny_and_audit(conn, d, action, target=package_id, op_id=op_id)
        raise
    try:
        with db.tx(conn):
            prior = db.find_operation(conn, op_id, "export", request)
            if prior:
                return prior
            st = packages.status(conn, package_id)
            if mode == "current" and st["effective_state"] != "REVIEWED_FOR_DEMO":
                raise ExportRefused(f"cannot export as currently reviewed: state is {st['effective_state']}"
                                    + (f" ({'; '.join(st['reasons'])})" if st["reasons"] else ""))
            manifest = json.loads(p["manifest_json"])
            export_id = new_id("exp")
            header = _header(p, st, mode, manifest, export_id)
            if mode == "historical":
                header["notice"] = "HISTORICAL EXPORT. " + header["notice"]
            decs = packages.decisions(conn, package_id)
            out = (out_root or config.exports_dir()) / package_id / export_id
            out.mkdir(parents=True, exist_ok=True)
            files = {}
            (out / "ssp-excerpt.md").write_text(render_markdown(conn, p, st, header, decs))
            files["ssp-excerpt.md"] = "markdown draft"
            rows = json.loads(p["rows_json"])
            ev_manifest = {"header": header, "run_manifest": manifest,
                           "rows": [{k: r[k] for k in ("row_id", "control_id", "statement_id", "object_id",
                                                        "object_revision", "result", "evidence_state", "gaps",
                                                        "check_run_id", "inputs", "tool_version", "params")}
                                    for r in rows],
                           "validation": json.loads(p["validation_json"]),
                           "review_decisions": [{k: d[k] for k in ("id", "actor", "actor_role", "decision", "reason",
                                                                   "package_digest", "dependency_digest", "created_at",
                                                                   "revoked", "limitations")} for d in decs]}
            (out / "evidence-manifest.json").write_text(json.dumps(ev_manifest, indent=2, default=str))
            files["evidence-manifest.json"] = "structured evidence manifest"
            prev = conn.execute("""SELECT id FROM snapshots WHERE project=? AND seq < (SELECT seq FROM snapshots WHERE id=?)
                                   ORDER BY seq DESC LIMIT 1""", (p["project"], p["snapshot_id"])).fetchone()
            if prev:
                prior_pkg = conn.execute("SELECT id FROM packages WHERE snapshot_id=? ORDER BY seq DESC LIMIT 1",
                                         (prev["id"],)).fetchone()
                rep = impact.impact_report(conn, p["project"], prev["id"], p["snapshot_id"],
                                           prior_pkg["id"] if prior_pkg else None)
                (out / "change-impact.json").write_text(json.dumps(rep, indent=2))
                files["change-impact.json"] = "change impact report"
            if include_oscal:
                doc, rep = oscal_component_definition(conn, p, header)
                (out / "oscal-validation-report.json").write_text(json.dumps(rep, indent=2))
                files["oscal-validation-report.json"] = "OSCAL validation report"
                if rep["valid_oscal_claim"]:
                    (out / "oscal-component-definition.json").write_text(json.dumps(doc, indent=2))
                    files["oscal-component-definition.json"] = f"OSCAL {config.OSCAL_VERSION} component definition (schema + references checked)"
                else:
                    (out / "component-definition.UNVALIDATED.json").write_text(json.dumps(doc, indent=2))
                    files["component-definition.UNVALIDATED.json"] = "NOT claimed as valid OSCAL; see validation report"
            conn.execute("INSERT INTO exports VALUES (?,?,?,?,?,?,?,?)",
                         (export_id, package_id, mode, st["effective_state"], now(), actor, str(out), json.dumps(files)))
            result = {"export_id": export_id, "path": str(out), "files": files, "status_at_export": st["effective_state"]}
            db.record_operation(conn, op_id, "export", actor, request, result)
            db.audit(conn, actor, action, "ok", op_id=op_id, target=package_id, new_ref=export_id,
                     detail={"status_at_export": st["effective_state"], "files": sorted(files)})
        return result
    except ExportRefused as e:
        db.audit(conn, actor, action, "refused", op_id=op_id, target=package_id, detail={"why": str(e)})
        raise
