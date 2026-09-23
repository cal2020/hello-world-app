"""Check runner: reviewed, deterministic predicates over the current model + evidence.

Outcomes: PASS, FAIL, UNKNOWN, ERROR (NOT_APPLICABLE only by reviewer justification,
never produced here). A missing input is UNKNOWN, never PASS. An evaluator error is
ERROR and is kept distinct from a missing-evidence gap. A result applies only to its
stated inputs, predicate and versions, which are recorded with it.
"""
from __future__ import annotations

import json

from . import model as M
from . import opa, reference
from .util import digest_obj, new_id, now

ACTIONS = ("read", "write")


def expand_rows(mappings: dict, els: dict, fls: dict) -> list[dict]:
    """Turn curated obligations into (obligation x object) rows for the current model.

    Scope rules are evaluated against the model, so a new boundary-crossing flow adds a
    row (enlarging the denominator) even though no existing claim cites it.
    """
    rows = []
    for ob in mappings["obligations"]:
        sc = ob["scope"]
        targets = []
        if "element" in sc:
            if sc["element"] in els:
                targets.append(("element", sc["element"]))
        elif sc.get("rule") == "boundary-crossing-flows":
            targets += [("flow", fid) for fid, f in fls.items() if f["crosses"]]
        elif sc.get("rule") == "inheritance-claims":
            for eid, e in els.items():
                for claim in (e["data"].get("attributes") or {}).get("inherited_controls") or []:
                    if claim.get("control") == sc["control_id"]:
                        targets.append(("element", eid))
        for kind, oid in targets:
            obj = els[oid] if kind == "element" else fls[oid]
            rows.append({
                "row_id": f"{ob['id']}::{oid}", "obligation_id": ob["id"], "control_id": ob["control_id"],
                "statement_id": ob["statement_id"], "object_kind": kind, "object_id": oid,
                "object_revision": obj["revision"], "object_pointer": obj["pointer"],
                "local_obligation": ob["local_obligation"], "limits": ob.get("limits", ""),
                "params": {k: ({"state": "UNRESOLVED", "value": None} if v is None else
                               {"state": "SET", "value": v}) for k, v in ob.get("params", {}).items()},
                "mapping_state": "curated (reviewed demo mapping set)", "check": ob["check"],
                "_obligation": ob,
            })
    return rows


def _evidence_for(evs, els, fls, clock, *, type_, element=None, flow=None):
    out = []
    for ev in evs:
        if ev["type"] != type_:
            continue
        tgt = ev["meta"].get("target") or {}
        if flow and tgt.get("flow_id") != flow:
            continue
        if element and element not in (tgt.get("element_revisions") or {}):
            continue
        ok, reasons = M.applicability(ev, els, fls, clock=clock)
        out.append({"evidence_id": ev["id"], "digest": ev["digest"], "kind": ev["kind"], "applicable": ok,
                    "reasons": reasons, "status": ev["status"], "_ev": ev})
    return out


def _evidence_state(items):
    app = [i for i in items if i["applicable"]]
    if app:
        results = {i.get("result") for i in app}
        return "CONFLICT" if len(results) > 1 else "CURRENT"
    return "INAPPLICABLE_ONLY" if items else "NONE"


def _clean(items):
    return [{k: v for k, v in i.items() if k != "_ev"} for i in items]


# --- individual checks -------------------------------------------------------

def check_ac3(row, els, fls, evs, ctx):
    el = els[row["object_id"]]
    pol = ctx["policy"]
    detail = {"policy_digest": pol["policy_digest"], "tests_digest": pol["tests_digest"],
              "predicate": "opa check + opa test --fail-on-empty + model/policy decision equality"}
    inputs = [{"model_pointer": el["pointer"], "element_revision": el["revision"]},
              {"policy_digest": pol["policy_digest"]}, {"tests_digest": pol["tests_digest"]}]
    try:
        chk = opa.check(pol["dir"])
        detail["compile"] = chk
        if not chk["ok"]:
            return "ERROR", detail, inputs, "policy bundle failed to compile"
        t = opa.test(pol["dir"])
        detail["tests"] = {k: t[k] for k in ("passed", "failed", "errored", "skipped", "failed_names", "errored_names")}
        if t.get("empty") or t["errored"] or t["exit_code"] not in (0, 2):
            return "ERROR", detail, inputs, "policy test run errored or was empty"
        state, perms = M.value_state(el["data"].get("attributes") or {}, "permissions")
        if state != "PRESENT":
            detail["model_permissions"] = state
            return "UNKNOWN", detail, inputs, None
        policy_files = [f"{pol['dir']}/{f}" for f in pol["files"] if not f.endswith("_test.rego")]
        declared = {(p["role"], p["action"], p["resource"]) for p in perms}
        roles = sorted({p["role"] for p in perms} | {"operator", "maintainer"})
        cases = [{"subject": {"id": "probe", "role": r, "project": ctx["project"], "revoked": False},
                  "action": a, "resource": {"type": "telemetry", "project": ctx["project"], "locked": False}}
                 for r in roles for a in ACTIONS]
        decisions = opa.eval_decisions(policy_files, "data.mtel.authz", cases)
        mismatches = []
        for c, d in zip(cases, decisions):
            key = (c["subject"]["role"], c["action"], "telemetry")
            if bool(d["allow"]) != (key in declared):
                mismatches.append({"role": key[0], "action": key[1],
                                   "model_declares": key in declared, "policy_allows": bool(d["allow"])})
        detail["decision_table"] = [{"role": c["subject"]["role"], "action": c["action"], "allow": d["allow"]}
                                    for c, d in zip(cases, decisions)]
        detail["mismatches"] = mismatches
        if t["failed"]:
            return "FAIL", detail, inputs, None
        return ("FAIL" if mismatches else "PASS"), detail, inputs, None
    except opa.OpaUnavailable as e:
        return "ERROR", detail, inputs, str(e)
    except Exception as e:  # evaluator failure is not a finding about the system
        return "ERROR", detail, inputs, f"{type(e).__name__}: {e}"


def check_au12(row, els, fls, evs, ctx):
    el = els[row["object_id"]]
    required = row["_obligation"].get("required_fields", [])
    state, types = M.value_state(el["data"].get("attributes") or {}, "audit_events")
    items = _evidence_for(evs, els, fls, ctx["clock"], type_="audit-sample", element=row["object_id"])
    inputs = [{"model_pointer": el["pointer"] + "/attributes/audit_events", "element_revision": el["revision"]}] + \
             [{"evidence_id": i["evidence_id"], "digest": i["digest"]} for i in items if i["applicable"]]
    detail = {"required_fields": required, "declared_event_types": types if state == "PRESENT" else state,
              "predicate": "each declared event type has >=1 record and every record of those types has all required fields"}
    if state != "PRESENT":
        detail["evidence"] = _clean(items)
        return "UNKNOWN", detail, inputs, None
    for i in items:
        if not i["applicable"]:
            continue
        try:
            recs = json.loads(i["_ev"]["raw"])["records"]
        except Exception as e:
            i["result"] = "ERROR"
            i["error"] = f"unparseable evidence payload: {e}"
            continue
        problems = []
        for t in types:
            of_type = [r for r in recs if r.get("action") == t]
            if not of_type:
                problems.append(f"no record for event type {t}")
            for n, r in enumerate(of_type):
                miss = [f for f in required if r.get(f) in (None, "")]
                if miss:
                    problems.append(f"{t} record {n} missing {miss}")
        i["result"] = "FAIL" if problems else "PASS"
        i["problems"] = problems
    detail["evidence"] = _clean(items)
    return _combine(items, detail, inputs)


def _combine(items, detail, inputs):
    app = [i for i in items if i["applicable"]]
    errs = [i for i in app if i.get("result") == "ERROR"]
    if errs:
        return "ERROR", detail, inputs, "; ".join(i["error"] for i in errs)
    if not app:
        return "UNKNOWN", detail, inputs, None
    results = {i["result"] for i in app}
    if len(results) > 1:
        detail["conflict"] = "applicable evidence disagrees; reviewer must resolve"
        return "UNKNOWN", detail, inputs, None
    return results.pop(), detail, inputs, None


def check_sc8(row, els, fls, evs, ctx):
    f = fls[row["object_id"]]
    tstate, transport = M.value_state(f["data"].get("attributes") or {}, "transport")
    pstate, prot = M.value_state(transport or {}, "protection") if tstate == "PRESENT" else (tstate, None)
    design = {"state": pstate, "value": prot, "pointer": f["pointer"] + "/attributes/transport",
              "kind": "design assertion (imported model attribute)"}
    items = _evidence_for(evs, els, fls, ctx["clock"], type_="transport-test", flow=row["object_id"])
    for i in items:
        if not i["applicable"]:
            continue
        try:
            rep = json.loads(i["_ev"]["raw"])
            i["result"] = {"pass": "PASS", "fail": "FAIL"}.get(rep.get("result"), "ERROR")
            if i["result"] == "ERROR":
                i["error"] = f"unrecognised report result {rep.get('result')!r}"
        except Exception as e:
            i["result"] = "ERROR"
            i["error"] = f"unparseable evidence payload: {e}"
    inputs = [{"model_pointer": design["pointer"], "flow_revision": f["revision"]}] + \
             [{"evidence_id": i["evidence_id"], "digest": i["digest"]} for i in items if i["applicable"]]
    detail = {"design": design, "evidence": _clean(items),
              "predicate": "design assertion present AND applicable observation(s) agree on pass"}
    result, detail, inputs, err = _combine(items, detail, inputs)
    if result == "PASS" and pstate != "PRESENT":
        detail["note"] = "observation present but no design transport assertion"
        return "UNKNOWN", detail, inputs, None
    return result, detail, inputs, err


def check_inheritance(row, els, fls, evs, ctx):
    el = els[row["object_id"]]
    claims = [c for c in (el["data"].get("attributes") or {}).get("inherited_controls") or []
              if c.get("control") == row["control_id"]]
    items = _evidence_for(evs, els, fls, ctx["clock"], type_="provider-attestation", element=row["object_id"])
    for i in items:
        if i["applicable"]:
            i["result"] = "PASS"
    detail = {"claims": claims, "evidence": _clean(items),
              "predicate": "applicable provider attestation naming the provider and covered component"}
    inputs = [{"model_pointer": el["pointer"] + "/attributes/inherited_controls", "element_revision": el["revision"]}]
    if not any(i["applicable"] for i in items):
        detail["note"] = "inheritance claimed in the model; no provider/scope evidence. Left unresolved."
        return "UNKNOWN", detail, inputs, None
    return "PASS", detail, inputs, None


CHECKS = {"ac3_policy_matches_model": check_ac3, "au12_record_content": check_au12,
          "sc8_transport_evidence": check_sc8, "inheritance_support": check_inheritance}


def gaps_for(row) -> list[str]:
    g = []
    d = row["detail"]
    if row["result"] == "UNKNOWN":
        if d.get("conflict"):
            g.append("Conflicting applicable evidence; reviewer must resolve which applies.")
        elif row["evidence_state"] in ("NONE", "INAPPLICABLE_ONLY") and row["check"] in ("au12_record_content",
                                                                                         "sc8_transport_evidence"):
            g.append("No current applicable observation." +
                     (" Existing evidence is inapplicable: " + "; ".join(
                         f"{e['evidence_id']}: {', '.join(e['reasons'])}" for e in d.get("evidence", [])
                         if not e["applicable"]) if row["evidence_state"] == "INAPPLICABLE_ONLY" else ""))
        if d.get("note"):
            g.append(d["note"])
        if isinstance(d.get("design"), dict) and d["design"]["state"] != "PRESENT":
            g.append(f"Design transport assertion is {d['design']['state']}.")
    if row["result"] == "FAIL":
        for m in d.get("mismatches", []):
            g.append(f"Model {'declares' if m['model_declares'] else 'does not declare'} {m['role']} {m['action']}; "
                     f"reviewed policy {'allows' if m['policy_allows'] else 'denies'} it.")
        for e in d.get("evidence", []):
            for p in e.get("problems", []) or []:
                g.append(f"{e['evidence_id']}: {p}")
            if e.get("result") == "FAIL" and not e.get("problems"):
                g.append(f"{e['evidence_id']}: observation reports fail.")
        if d.get("tests", {}).get("failed"):
            g.append(f"Independent policy tests failed: {d['tests']['failed_names']}")
    if row["result"] == "ERROR":
        g.append(f"Check could not be evaluated: {row['error']}")
    for pid, p in row["params"].items():
        if p["state"] == "UNRESOLVED":
            g.append(f"Parameter {pid} is organization-defined and unresolved; a qualified reviewer must set it.")
    return g


def run_checks(conn, project: str, snapshot_id: str, *, clock: str | None = None) -> tuple[str, list[dict]]:
    """Evaluate every row for the snapshot. Persists one check_run per row (append-only)."""
    _, mappings = reference.get(conn, "mappings")
    _, pol = reference.get(conn, "policy")
    els, fls = M.elements(conn, snapshot_id), M.flows(conn, snapshot_id)
    evs = M.all_evidence(conn, project)
    ctx = {"policy": pol, "project": project, "clock": clock or now()}
    batch = new_id("batch")
    tool = f"opa {opa.version()}"
    out = []
    for row in expand_rows(mappings, els, fls):
        fn = CHECKS[row["check"]]
        result, detail, inputs, err = fn(row, els, fls, evs, ctx)
        row.update(result=result, detail=detail, error=err, inputs=inputs, tool_version=tool,
                   evidence_state=_evidence_state(detail.get("evidence", [])) if "evidence" in detail
                   else ("CURRENT" if result in ("PASS", "FAIL") else "NONE"))
        row["gaps"] = gaps_for(row)
        run_id = new_id("chk")
        row["check_run_id"] = run_id
        ob = row.pop("_obligation")
        conn.execute("INSERT INTO check_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (run_id, batch, snapshot_id, row["row_id"], ob["id"], row["object_id"], row["control_id"],
                      row["statement_id"], result, json.dumps(detail), json.dumps(inputs), digest_obj(inputs),
                      tool, err, now()))
        out.append(row)
    return batch, out


def coverage(rows: list[dict]) -> dict:
    total = len(rows)
    current = sum(1 for r in rows if r["evidence_state"] == "CURRENT")
    by = {}
    for r in rows:
        by[r["result"]] = by.get(r["result"], 0) + 1
    return {"rows": total, "with_current_evidence": current, "results": by,
            "statement": f"{current} of {total} selected demo obligation rows have current applicable evidence"}
