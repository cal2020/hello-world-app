"""Relationship proposals, evidence validation, review decisions and the protected accept.

Authority boundaries:
* code: identity, evidence resolution, permission and freshness checks, ETags, commit.
* AI/deterministic proposers: candidate triples with quoted evidence only.
* people: accept/reject/no-match; an accepted link is workbench metadata, not a model edit.
"""
import json
import pathlib
import re
import time

from . import ai
from .authz import has
from .db import audit, enqueue_event
from .util import ApiError, digest, new_id, now, sha256

HERE = pathlib.Path(__file__).resolve().parent
VOCAB = json.loads((HERE / "prompts" / "vocabulary.json").read_text())
ALIASES_PATH = HERE.parent / "fixtures" / "curated_aliases.json"
MODEL_SOURCE = "synthmodeler"
SERIAL_PROPS = ("serialNumber", "assetSerial")
DECISIONS = {"accept": "link:approve", "reject": "link:review", "no_match": "link:review",
             "missing_evidence": "link:review", "change_predicate": "link:review"}


def _heads(c, project, record_source):
    m = c.execute("SELECT * FROM source_head WHERE source=? AND project=?", (MODEL_SOURCE, project)).fetchone()
    r = c.execute("SELECT * FROM source_head WHERE source=? AND project=?", (record_source, project)).fetchone()
    return m, r


def _records_from_raw(c, record_snapshot_id):
    """Evidence resolves against the retained raw bytes of the import, not a derived copy."""
    raw = c.execute("SELECT i.raw_bytes FROM source_snapshot s JOIN source_import i ON i.import_id=s.import_id "
                    "WHERE s.snapshot_id=?", (record_snapshot_id,)).fetchone()["raw_bytes"]
    doc = json.loads(raw)
    versions = {r["record_id"]: r["record_version"] for r in c.execute(
        "SELECT record_id, record_version FROM external_record WHERE snapshot_id=?", (record_snapshot_id,))}
    return {r["id"]: dict(r, version=versions.get(r["id"])) for r in doc["records"]}, sha256(raw)


def _elements(c, model_snapshot_id):
    types = set().union(*[set(p["target_types"]) for p in VOCAB["predicates"].values()])
    out = {}
    for r in c.execute("SELECT ei.native_id, ev.* FROM snapshot_element se JOIN element_version ev "
                       "ON ev.version_id=se.version_id JOIN element_identity ei ON ei.entity_uid=se.entity_uid "
                       "WHERE se.snapshot_id=? AND se.state='present'", (model_snapshot_id,)):
        if r["type"] in types:
            out[r["native_id"]] = r
    return out


def _etag(p):
    return '"' + digest({k: p[k] for k in ("proposal_id", "revision", "disposition", "target_version", "predicate",
                                              "evidence_json", "record_version", "model_snapshot_id")})[:32] + '"'


# ---------------------------------------------------------------- proposal runs
def run_proposals(db, actor, project, method, mode, record_source="cmms"):
    """method: deterministic | model. mode (model only): fixture | live."""
    c = db.read()
    if not has(c, actor, project, "link:review"):
        raise ApiError(403 if has(c, actor, project, "read") else 404,
                       "forbidden" if has(c, actor, project, "read") else "not_found", "Not permitted.")
    mhead, rhead = _heads(c, project, record_source)
    if not mhead or not rhead:
        raise ApiError(409, "no_source_head", "Both a model head and a record head are required.")
    # Permission filtering happens BEFORE retrieval/model access: only this project's snapshots.
    records, raw_digest = _records_from_raw(c, rhead["snapshot_id"])
    elements = _elements(c, mhead["snapshot_id"])
    permitted = {"record_ids": sorted(records), "element_ids": sorted(elements),
                 "model_revision": mhead["revision"], "record_revision": rhead["revision"]}
    run_id = new_id("run")
    meta = {"provider": None, "model": None, "sampling": {}}
    started, t0 = now(), time.time()
    raw_out, status, error = None, "completed", None
    if method == "deterministic":
        candidates = _deterministic(records, elements)
        meta = {"provider": "deterministic", "model": "exact-serial+curated-alias/1", "sampling": {}}
        context_digest = digest(permitted)
    elif method == "model":
        context = {"records": [{"id": r["id"], "kind": r["kind"], "asset_ref": r.get("asset_ref"), "text": r["text"]}
                               for r in records.values()],
                   "elements": [{"id": nid, "type": e["type"], "name": e["name"],
                                 "properties": {k: v for k, v in json.loads(e["properties_json"]).items()
                                                if k in SERIAL_PROPS + ("mountPosition", "measurand", "tag", "site")}}
                                for nid, e in sorted(elements.items())]}
        context_digest = digest({"prompt": ai.PROMPT, "context": context})
        try:
            if mode == "fixture":
                out, meta = ai.fixture_propose(record_source, context)
            elif mode == "live":
                out, meta = ai.live_propose(record_source, context)
            else:
                raise ApiError(400, "invalid_input", "mode must be fixture|live")
            raw_out = json.dumps(out)
            candidates = out.get("proposals", []) if isinstance(out, dict) else []
        except ai.AdapterError as e:
            candidates, status, error = [], "failed", str(e)
    else:
        raise ApiError(400, "invalid_input", "method must be deterministic|model")

    with db.tx() as w:
        w.execute("INSERT INTO proposal_run VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (run_id, project, method, mode if method == "model" else "deterministic", meta.get("provider"),
                   meta.get("model"), json.dumps(meta.get("sampling", {})),
                   ai.PROMPT_VERSION if method == "model" else None, VOCAB["version"], json.dumps(permitted),
                   context_digest, status, error, actor, started, now(), raw_out, None))
        created = []
        if status == "completed":
            groups = {}
            for cand in candidates:
                groups.setdefault(cand.get("record_id"), []).append(cand)
            for cand in candidates:
                created.append(_store_candidate(w, run_id, project, cand, records, elements, mhead, rhead,
                                                record_source, len(groups.get(cand.get("record_id"), [])) > 1))
        stats = {"candidates": len(candidates), "stored": len(created),
                 "valid": sum(1 for p in created if p["validation"] == "valid"),
                 "elapsed_ms": int((time.time() - t0) * 1000), "usage": meta.get("usage")}
        w.execute("UPDATE proposal_run SET stats_json=? WHERE run_id=?", (json.dumps(stats), run_id))
        audit(w, actor, project, "proposal.run", status, detail={"run_id": run_id, "method": method, "error": error})
    return {"run_id": run_id, "status": status, "error": error, "method": method, "provider": meta.get("provider"),
            "model": meta.get("model"), "stats": stats, "proposals": created,
            "label": ("FIXTURE MODE: scripted outputs; not evidence of model quality" if mode == "fixture"
                      and method == "model" else None)}


def _deterministic(records, elements):
    aliases = json.loads(ALIASES_PATH.read_text()) if ALIASES_PATH.exists() else {}
    out = []
    for rid, r in sorted(records.items()):
        if r["kind"] != "maintenance":
            continue
        hits = []
        for nid, e in elements.items():
            props = json.loads(e["properties_json"])
            for sp in SERIAL_PROPS:
                serial = props.get(sp)
                if serial and re.search(r"(?<![A-Za-z0-9-])" + re.escape(serial) + r"(?![A-Za-z0-9-])", r["text"]):
                    hits.append({"record_id": rid, "element_id": nid, "method_detail": f"exact {sp}",
                                 "evidence": [{"record_id": rid, "quote": serial}]})
        alias = aliases.get("aliases", {}).get(r.get("asset_ref") or "")
        if alias and alias in elements:
            hits.append({"record_id": rid, "element_id": alias, "method_detail": "curated alias",
                         "evidence": [{"record_id": rid, "field": "asset_ref", "quote": r["asset_ref"]}]})
        for h in hits:
            out.append(dict(h, predicate="maintenance_record_references_element", contradictions=[], confidence=1.0))
    return out


def _store_candidate(w, run_id, project, cand, records, elements, mhead, rhead, record_source, ambiguous):
    notes, validation = [], "valid"
    allowed_keys = {"record_id", "element_id", "predicate", "evidence", "contradictions", "confidence",
                    "method_detail", "rationale"}
    for k in sorted(set(cand) - allowed_keys):
        notes.append({"code": "ignored_model_field", "field": k,
                      "message": "Model output cannot set approval, permissions or destinations."})
    rid = cand.get("record_id")
    rec = records.get(rid)
    if rec is None:
        validation = "reference_outside_permitted_set"
        notes.append({"code": "unknown_record", "record_id": str(rid)[:64]})
    target = cand.get("element_id")
    el = elements.get(target) if target else None
    if target and el is None:
        validation = "reference_outside_permitted_set"
        notes.append({"code": "target_not_in_permitted_elements", "element_ref": str(target)[:64]})
    pred = cand.get("predicate")
    if pred not in VOCAB["predicates"]:
        if validation == "valid":
            validation = "unsupported_predicate"
        notes.append({"code": "predicate_needs_vocabulary_review", "predicate": str(pred)[:80]})
    evidence = []
    for ev in cand.get("evidence") or []:
        src = records.get(ev.get("record_id"))
        field = ev.get("field", "text")
        quote = ev.get("quote") or ""
        text = (src or {}).get(field) or ""
        pos = text.find(quote) if (src and quote) else -1
        if pos < 0:
            evidence.append({"record_id": ev.get("record_id"), "field": field, "quote": quote, "valid": False})
            if validation == "valid":
                validation = "invalid_citation"
            notes.append({"code": "citation_not_found_in_source_bytes", "record_id": ev.get("record_id")})
        else:
            evidence.append({"record_id": src["id"], "record_version": src["version"], "field": field,
                             "start": pos, "end": pos + len(quote), "quote": quote, "quote_sha256": sha256(quote),
                             "valid": True})
    if not evidence and validation == "valid":
        validation = "missing_evidence"
    if target is None and validation == "valid":
        validation = "no_match_suggested"
    if ambiguous:
        notes.append({"code": "competing_candidates_for_record", "record_id": rid,
                      "message": "More than one target proposed for this record; reviewer must resolve."})
    pid = new_id("prop")
    row = {
        "proposal_id": pid, "project": project, "run_id": run_id, "revision": 1, "record_source": record_source,
        "record_id": rid if rec else str(rid)[:64], "record_version": rec["version"] if rec else "n/a",
        "record_snapshot_id": rhead["snapshot_id"], "target_uid": el["entity_uid"] if el else None,
        "target_version": el["version_id"] if el else None, "model_snapshot_id": mhead["snapshot_id"],
        "predicate": str(pred)[:80], "evidence_json": json.dumps(evidence),
        "contradictions_json": json.dumps([str(x)[:300] for x in (cand.get("contradictions") or [])]),
        "input_vector_json": json.dumps({"model_revision": mhead["revision"], "model_snapshot_id": mhead["snapshot_id"],
                                         "record_revision": rhead["revision"], "record_snapshot_id": rhead["snapshot_id"],
                                         "target_version": el["version_id"] if el else None,
                                         "record_version": rec["version"] if rec else None,
                                         "evidence_versions": sorted({e.get("record_version") for e in evidence
                                                                      if e.get("record_version")})}),
        "confidence": cand.get("confidence") if isinstance(cand.get("confidence"), (int, float)) else None,
        "validation": validation, "validation_notes_json": json.dumps(notes),
        "disposition": "unresolved", "created_at": now(), "updated_at": now(),
    }
    row["etag"] = _etag(row)
    cols = list(row)
    w.execute(f"INSERT INTO link_proposal ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
              [row[k] for k in cols])
    return proposal_view(w, pid)


# ---------------------------------------------------------------- views
def freshness(c, p):
    mhead, rhead = _heads(c, p["project"], p["record_source"])
    out = {"model_head": mhead["revision"] if mhead else None, "record_head": rhead["revision"] if rhead else None}
    iv = json.loads(p["input_vector_json"])
    issues = []
    if mhead and mhead["revision"] != iv["model_revision"]:
        issues.append("model_revision_changed")
        if p["target_uid"]:
            cur = c.execute("SELECT version_id, state FROM snapshot_element WHERE snapshot_id=? AND entity_uid=?",
                            (mhead["snapshot_id"], p["target_uid"])).fetchone()
            if cur is None or cur["state"] == "deleted":
                issues.append("target_deleted_or_absent")
            elif cur["version_id"] != p["target_version"]:
                issues.append("target_version_changed")
    if rhead and rhead["revision"] != iv["record_revision"]:
        issues.append("record_revision_changed")
    out["issues"] = issues
    out["status"] = "current" if not issues else "stale"
    return out


def proposal_view(c, pid):
    p = c.execute("SELECT * FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
    if not p:
        raise ApiError(404, "not_found", "Resource not found.")
    tgt = None
    if p["target_uid"]:
        t = c.execute("SELECT ei.native_id, ev.name, ev.type FROM element_identity ei JOIN element_version ev "
                      "ON ev.version_id=? WHERE ei.entity_uid=?", (p["target_version"], p["target_uid"])).fetchone()
        tgt = {"entity_uid": p["target_uid"], "source_id": t["native_id"], "name_at_proposal": t["name"],
               "type": t["type"], "version_id": p["target_version"]}
    run = c.execute("SELECT method, mode, provider, model FROM proposal_run WHERE run_id=?", (p["run_id"],)).fetchone()
    decisions = [dict(d) for d in c.execute("SELECT decision_id, actor, decision, reason, at, revoked_at FROM "
                                            "review_decision WHERE proposal_id=? ORDER BY at", (pid,))]
    return {"proposal_id": pid, "project": p["project"], "revision": p["revision"], "etag": p["etag"],
            "record": {"source": p["record_source"], "id": p["record_id"], "version": p["record_version"]},
            "target": tgt, "predicate": p["predicate"], "evidence": json.loads(p["evidence_json"]),
            "contradictions": json.loads(p["contradictions_json"]), "confidence": p["confidence"],
            "method": dict(run) if run else None, "run_id": p["run_id"],
            "input_vector": json.loads(p["input_vector_json"]), "validation": p["validation"],
            "validation_notes": json.loads(p["validation_notes_json"]), "disposition": p["disposition"],
            "freshness": freshness(c, p), "decisions": decisions, "created_at": p["created_at"]}


def link_view(c, link):
    mhead = c.execute("SELECT * FROM source_head WHERE source=? AND project=?", (MODEL_SOURCE, link["project"])).fetchone()
    cur = c.execute("SELECT version_id, state FROM snapshot_element WHERE snapshot_id=? AND entity_uid=?",
                    (mhead["snapshot_id"], link["target_uid"])).fetchone() if mhead else None
    tgt = c.execute("SELECT native_id FROM element_identity WHERE entity_uid=?", (link["target_uid"],)).fetchone()
    status = link["status"]
    current = "target_present"
    if cur is None or cur["state"] == "deleted":
        current = "target_deleted_in_current_source"
    elif cur["version_id"] != link["target_version"]:
        current = "target_changed_since_review"
    return dict(link) | {"target_source_id": tgt["native_id"], "current_target_status": current,
                         "authority": link["authority"], "status": status}


# ---------------------------------------------------------------- decisions (protected mutations)
def decide(c, actor, pid, decision, if_match, body, operation_id):
    """Runs inside the receipt transaction. Every check below reads current state."""
    if decision not in DECISIONS:
        raise ApiError(400, "invalid_input", f"decision must be one of {sorted(DECISIONS)}")
    p = c.execute("SELECT * FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
    if not p:
        raise ApiError(404, "not_found", "Resource not found.")
    perm = DECISIONS[decision]
    if not has(c, actor, p["project"], "read") and not has(c, actor, p["project"], perm):
        raise ApiError(404, "not_found", "Resource not found.")
    if not has(c, actor, p["project"], perm):
        raise ApiError(403, "forbidden", f"Current authority lacks '{perm}'.", {"permission": perm})
    if not if_match:
        raise ApiError(428, "precondition_required", "If-Match with the proposal's current ETag is required.")
    if if_match != p["etag"]:
        raise ApiError(412, "precondition_failed", "Proposal changed since it was read.", {"current_etag": p["etag"]})
    if p["disposition"] != "unresolved":
        raise ApiError(409, "already_decided", "Proposal is not open for review.", {"disposition": p["disposition"]})
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise ApiError(400, "invalid_input", "A concise decision reason is required.")
    fr = freshness(c, p)
    exp_m, exp_r = body.get("expected_model_revision"), body.get("expected_record_revision")
    if decision == "accept":
        if p["validation"] != "valid":
            raise ApiError(409, "not_acceptable", "Proposal failed validation and cannot be accepted.",
                           {"validation": p["validation"]})
        if exp_m is None or exp_r is None:
            raise ApiError(400, "invalid_input", "expected_model_revision and expected_record_revision are required.")
    if fr["status"] == "stale":
        # Committed side effect: the proposal is marked stale so it cannot be approved by accident later.
        c.execute("UPDATE link_proposal SET disposition='stale_needs_review', updated_at=? WHERE proposal_id=?",
                  (now(), pid))
        np = c.execute("SELECT * FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
        c.execute("UPDATE link_proposal SET etag=? WHERE proposal_id=?", (_etag(np), pid))
        audit(c, actor, p["project"], f"proposal.{decision}", "rejected_stale_dependency", operation_id,
              {"proposal_id": pid, "issues": fr["issues"]})
        return 409, {"error": {"code": "stale_dependency",
                               "message": "Source revisions changed after this proposal was created. Nothing was "
                                          "linked; rebase the proposal and review again.",
                               "details": {"proposal_id": pid, "issues": fr["issues"],
                                           "proposal_inputs": json.loads(p["input_vector_json"]),
                                           "current": {"model_revision": fr["model_head"],
                                                       "record_revision": fr["record_head"]}}}}, {"proposal_id": pid}
    if exp_m is not None and (exp_m != fr["model_head"] or exp_r != fr["record_head"]):
        raise ApiError(409, "stale_dependency", "The caller's view of source revisions is out of date.",
                       {"current": {"model_revision": fr["model_head"], "record_revision": fr["record_head"]}})
    iv = json.loads(p["input_vector_json"])
    did = new_id("dec")
    c.execute("INSERT INTO review_decision VALUES (?,?,?,?,?,?,?,?,?,?,?)",
              (did, pid, p["etag"], actor, decision, reason, json.dumps(iv), now(), None, None, None))
    new_disp = {"accept": "accepted", "reject": "rejected", "no_match": "no_match",
                "missing_evidence": "missing_evidence", "change_predicate": "predicate_changed"}[decision]
    c.execute("UPDATE link_proposal SET disposition=?, updated_at=? WHERE proposal_id=?", (new_disp, now(), pid))
    np = c.execute("SELECT * FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
    c.execute("UPDATE link_proposal SET etag=? WHERE proposal_id=?", (_etag(np), pid))
    result = {"proposal_id": pid, "decision_id": did, "disposition": new_disp}
    affected = {"proposal_id": pid, "decision_id": did}
    if decision == "accept":
        lid = new_id("lnk")
        c.execute("INSERT INTO integration_link VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (lid, p["project"], pid, did, p["record_source"], p["record_id"], p["record_version"],
                   p["target_uid"], p["target_version"], p["predicate"], "reviewer_accepted", "active", now(), None))
        eid, seq = enqueue_event(c, p["project"], "link.accepted",
                                 {"link_id": lid, "record_id": p["record_id"], "target_uid": p["target_uid"],
                                  "predicate": p["predicate"], "decision_id": did}, operation_id)
        result |= {"link_id": lid, "authority": "reviewer_accepted", "event": {"event_id": eid, "seq": seq}}
        affected["link_id"] = lid
    elif decision == "change_predicate":
        newp = body.get("new_predicate")
        if newp not in VOCAB["predicates"]:
            raise ApiError(400, "invalid_input", "new_predicate must be in the controlled vocabulary.")
        child = _clone(c, p, predicate=newp, run_note="reviewer_predicate_change")
        result["replacement_proposal_id"] = child
    audit(c, actor, p["project"], f"proposal.{decision}", "committed", operation_id, result)
    return 200, result, affected


def _clone(c, p, run_note, **changes):
    row = dict(p)
    row.update(changes)
    row["proposal_id"] = new_id("prop")
    row["revision"] = p["revision"] + 1
    row["disposition"] = "unresolved"
    notes = json.loads(p["validation_notes_json"]) + [{"code": run_note, "derived_from": p["proposal_id"]}]
    row["validation_notes_json"] = json.dumps(notes)
    row["created_at"] = row["updated_at"] = now()
    row["etag"] = _etag(row)
    cols = list(row)
    c.execute(f"INSERT INTO link_proposal ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", [row[k] for k in cols])
    return row["proposal_id"]


def rebase(c, actor, pid, if_match):
    """Re-bind a stale proposal to current heads. Re-validates evidence; requires a fresh review."""
    p = c.execute("SELECT * FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
    if not p:
        raise ApiError(404, "not_found", "Resource not found.")
    if not has(c, actor, p["project"], "link:review"):
        raise ApiError(403, "forbidden", "Current authority lacks 'link:review'.")
    if if_match != p["etag"]:
        raise ApiError(412, "precondition_failed", "Proposal changed since it was read.", {"current_etag": p["etag"]})
    if p["disposition"] not in ("unresolved", "stale_needs_review"):
        raise ApiError(409, "already_decided", "Only open or stale proposals can be rebased.")
    mhead, rhead = _heads(c, p["project"], p["record_source"])
    records, _ = _records_from_raw(c, rhead["snapshot_id"])
    notes = []
    tv = None
    if p["target_uid"]:
        cur = c.execute("SELECT version_id, state FROM snapshot_element WHERE snapshot_id=? AND entity_uid=?",
                        (mhead["snapshot_id"], p["target_uid"])).fetchone()
        if cur is None or cur["state"] == "deleted":
            raise ApiError(409, "target_deleted", "Target element is deleted in the current source; the proposal "
                                                  "cannot be rebased. Consider a new proposal for a replacement.")
        tv = cur["version_id"]
    evidence, validation = [], p["validation"]
    for ev in json.loads(p["evidence_json"]):
        src = records.get(ev.get("record_id"))
        text = (src or {}).get(ev.get("field", "text")) or ""
        pos = text.find(ev.get("quote") or "\x00") if src else -1
        if pos < 0:
            validation = "invalid_citation"
            evidence.append(dict(ev, valid=False))
        else:
            evidence.append(dict(ev, record_version=src["version"], start=pos, end=pos + len(ev["quote"]), valid=True))
    rec = records.get(p["record_id"])
    iv = {"model_revision": mhead["revision"], "model_snapshot_id": mhead["snapshot_id"],
          "record_revision": rhead["revision"], "record_snapshot_id": rhead["snapshot_id"], "target_version": tv,
          "record_version": rec["version"] if rec else None,
          "evidence_versions": sorted({e.get("record_version") for e in evidence if e.get("record_version")})}
    child = _clone(c, p, run_note="rebased_to_current_heads", target_version=tv, model_snapshot_id=mhead["snapshot_id"],
                   record_snapshot_id=rhead["snapshot_id"], record_version=rec["version"] if rec else "n/a",
                   evidence_json=json.dumps(evidence), input_vector_json=json.dumps(iv), validation=validation)
    c.execute("UPDATE link_proposal SET disposition='superseded', updated_at=? WHERE proposal_id=?", (now(), pid))
    np = c.execute("SELECT * FROM link_proposal WHERE proposal_id=?", (pid,)).fetchone()
    c.execute("UPDATE link_proposal SET etag=? WHERE proposal_id=?", (_etag(np), pid))
    audit(c, actor, p["project"], "proposal.rebase", "committed", detail={"from": pid, "to": child})
    return 201, {"superseded": pid, "proposal_id": child}, {"proposal_id": child}


def revoke_link(c, actor, lid, reason, operation_id):
    link = c.execute("SELECT * FROM integration_link WHERE link_id=?", (lid,)).fetchone()
    if not link:
        raise ApiError(404, "not_found", "Resource not found.")
    if not has(c, actor, link["project"], "link:approve"):
        raise ApiError(403, "forbidden", "Current authority lacks 'link:approve'.")
    if link["status"] != "active":
        raise ApiError(409, "not_active", "Link is not active.")
    if not reason:
        raise ApiError(400, "invalid_input", "A reason is required.")
    c.execute("UPDATE integration_link SET status='revoked', status_note=? WHERE link_id=?", (reason, lid))
    c.execute("UPDATE review_decision SET revoked_at=?, revoked_by=?, revoke_reason=? WHERE decision_id=?",
              (now(), actor, reason, link["decision_id"]))
    eid, seq = enqueue_event(c, link["project"], "link.revoked", {"link_id": lid, "reason": reason}, operation_id)
    audit(c, actor, link["project"], "link.revoke", "committed", operation_id, {"link_id": lid})
    return 200, {"link_id": lid, "status": "revoked", "event": {"event_id": eid, "seq": seq}}, {"link_id": lid}
