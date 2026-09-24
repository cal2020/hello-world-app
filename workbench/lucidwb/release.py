"""Candidate builds, consumer checks, atomic activation and rollback.

A release manifest pins: code version, generator/adapter versions, projection digest,
contract digest and source snapshot(s). Activation moves one pointer row inside a write
transaction; a failed promotion leaves the active release untouched.
"""
import json
import os
import time
import urllib.error
import urllib.request

from jsonschema import Draft202012Validator

from . import ADAPTER_VERSION, GENERATOR_VERSION
from .db import audit, enqueue_event
from .projection import (BLOCKING, check_against_snapshot, contract_diff, generate_contract, instance_diagnostics,
                         projection_digest, validate_openapi, validate_projection_shape)
from .util import ApiError, code_version, digest, new_id, now

CONSUMER_URL = os.environ.get("LWB_CONSUMER_URL", "http://127.0.0.1:8781")
PUBLIC_URL = os.environ.get("LWB_PUBLIC_URL", "http://127.0.0.1:8780")
CHECK_TOKEN = "demo-svc-release-check"


# ---------------------------------------------------------------- projections
def register_projection(c, actor, body):
    errs = validate_projection_shape(body)
    if errs:
        raise ApiError(422, "invalid_projection", "Projection definition rejected.", {"errors": errs})
    pd = projection_digest(body)
    ex = c.execute("SELECT digest FROM projection_definition WHERE projection_id=? AND version=?",
                   (body["projection_id"], body["version"])).fetchone()
    if ex:
        if ex["digest"] == pd:
            return 200, {"projection_id": body["projection_id"], "version": body["version"], "digest": pd,
                         "status": "unchanged"}
        raise ApiError(409, "projection_version_conflict",
                       "This projection version already exists with different content; use a new version.")
    c.execute("INSERT INTO projection_definition VALUES (?,?,?,?,?,?,?,?,?)",
              (body["projection_id"], body["version"], body["project"], json.dumps(body, sort_keys=True), pd,
               "draft", None, None, now()))
    audit(c, actor, body["project"], "projection.register", "draft",
          detail={"projection": f"{body['projection_id']}@{body['version']}", "digest": pd})
    return 201, {"projection_id": body["projection_id"], "version": body["version"], "digest": pd, "status": "draft"}


def review_projection(c, actor, projection_id, version, decision, reason):
    row = c.execute("SELECT * FROM projection_definition WHERE projection_id=? AND version=?",
                    (projection_id, version)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "Resource not found.")
    if decision not in ("approve", "reject"):
        raise ApiError(400, "invalid_input", "decision must be approve|reject")
    if not reason:
        raise ApiError(400, "invalid_input", "A review reason is required.")
    status = "approved" if decision == "approve" else "rejected"
    c.execute("UPDATE projection_definition SET status=?, reviewed_by=?, review_reason=? WHERE projection_id=? AND version=?",
              (status, actor, reason, projection_id, version))
    audit(c, actor, row["project"], "projection.review", status,
          detail={"projection": f"{projection_id}@{version}", "digest": row["digest"], "reason": reason})
    return {"projection_id": projection_id, "version": version, "status": status, "digest": row["digest"]}


# ---------------------------------------------------------------- releases
def load_release(c, release_id):
    r = c.execute("SELECT r.*, p.body_json AS projection_json FROM release r JOIN projection_definition p "
                  "ON p.projection_id=r.projection_id AND p.version=r.projection_version WHERE r.release_id=?",
                  (release_id,)).fetchone()
    if not r:
        raise ApiError(404, "not_found", "Resource not found.")
    return r


def active_release(c, project):
    ptr = c.execute("SELECT * FROM release_pointer WHERE project=?", (project,)).fetchone()
    return load_release(c, ptr["release_id"]) if ptr else None


def build_candidate(c, actor, project, projection_id, version, snapshot_id=None):
    prow = c.execute("SELECT * FROM projection_definition WHERE projection_id=? AND version=? AND project=?",
                     (projection_id, version, project)).fetchone()
    if not prow:
        raise ApiError(404, "not_found", "Projection not found.")
    if prow["status"] != "approved":
        raise ApiError(409, "projection_not_reviewed", "Only an approved projection can be built.",
                       {"status": prow["status"]})
    p = json.loads(prow["body_json"])
    if snapshot_id is None:
        head = c.execute("SELECT snapshot_id FROM source_head WHERE project=? AND source='synthmodeler'",
                         (project,)).fetchone()
        if not head:
            raise ApiError(409, "no_source_head", "No validated source head to build from.")
        snapshot_id = head["snapshot_id"]
    snap = c.execute("SELECT * FROM source_snapshot WHERE snapshot_id=? AND project=?", (snapshot_id, project)).fetchone()
    if not snap or snap["status"] != "head":
        raise ApiError(409, "snapshot_not_buildable", "Only snapshots that were accepted as a head can be released.")
    rec = c.execute("SELECT snapshot_id FROM source_head WHERE project=? AND source='cmms'", (project,)).fetchone()

    diags = check_against_snapshot(c, p, snapshot_id)
    contract = generate_contract(p)
    cdig = digest(contract)
    for msg in validate_openapi(contract):
        diags.append({"code": "invalid_projection", "class": "structural", "message": f"OpenAPI validation: {msg}"})
    same_ver = c.execute("SELECT contract_digest FROM contract_artifact WHERE contract_id=? AND contract_version=?",
                         (p["contract"]["id"], str(p["contract"]["version"]))).fetchall()
    if any(r["contract_digest"] != cdig for r in same_ver):
        diags.append({"code": "contract_version_reused_with_different_shape", "class": "structural",
                      "message": "Consumer-visible shape changed without a new contract version."})
    c.execute("INSERT OR IGNORE INTO contract_artifact VALUES (?,?,?,?,?,?)",
              (cdig, p["contract"]["id"], str(p["contract"]["version"]), json.dumps(contract, sort_keys=True),
               GENERATOR_VERSION, now()))
    rid = new_id("rel")
    manifest = {
        "release_id": rid, "project": project, "code_version": code_version(),
        "generator_version": GENERATOR_VERSION, "adapter_version": ADAPTER_VERSION,
        "projection": {"id": projection_id, "version": version, "digest": prow["digest"]},
        "contract": {"id": p["contract"]["id"], "version": str(p["contract"]["version"]), "digest": cdig},
        "source_snapshots": [{"source": snap["source"], "revision": snap["revision"], "snapshot_id": snapshot_id,
                              "normalized_digest": snap["normalized_digest"]}],
        "record_snapshot_id": rec["snapshot_id"] if rec else None,
    }
    c.execute("INSERT INTO release VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (rid, project, projection_id, version, prow["digest"], cdig, snapshot_id,
               rec["snapshot_id"] if rec else None, manifest["code_version"], GENERATOR_VERSION, "candidate", "[]",
               json.dumps(manifest, sort_keys=True), digest(manifest), actor, now()))
    rel = load_release(c, rid)
    # A missing definition explains every missing value of that field; report the root cause once.
    undefined = {(d.get("resource"), d.get("field")) for d in diags if d["code"] == "definition_missing"}
    diags += [d for d in instance_diagnostics(c, rel) if (d.get("resource"), d.get("field")) not in undefined]
    blocking = [d for d in diags if d["code"] in BLOCKING]
    status = "blocked_generation" if blocking else "candidate"
    c.execute("UPDATE release SET status=?, diagnostics_json=? WHERE release_id=?", (status, json.dumps(diags), rid))
    audit(c, actor, project, "release.build", status, detail={"release_id": rid, "blocking": len(blocking)})
    return release_view(c, rid)


def release_view(c, rid):
    r = load_release(c, rid)
    act = active_release(c, r["project"])
    old = json.loads(c.execute("SELECT openapi_json FROM contract_artifact WHERE contract_digest=?",
                               (act["contract_digest"],)).fetchone()[0]) if act else None
    new = json.loads(c.execute("SELECT openapi_json FROM contract_artifact WHERE contract_digest=?",
                               (r["contract_digest"],)).fetchone()[0])
    runs = [dict(x, results=json.loads(x["results_json"]), schema_check=json.loads(x["schema_check_json"]))
            for x in c.execute("SELECT * FROM consumer_test_run WHERE release_id=? ORDER BY started_at", (rid,))]
    for x in runs:
        x.pop("results_json"); x.pop("schema_check_json")
    from .importer import diff_snapshots
    return {
        "release_id": rid, "project": r["project"], "status": r["status"],
        "is_active": bool(act and act["release_id"] == rid),
        "manifest": json.loads(r["manifest_json"]), "manifest_digest": r["manifest_digest"],
        "diagnostics": json.loads(r["diagnostics_json"]),
        "contract_diff_vs_active": contract_diff(old, new) if (not act or act["release_id"] != rid) else None,
        "source_diff_vs_active": diff_snapshots(c, act["snapshot_id"], r["snapshot_id"])
        if act and act["snapshot_id"] != r["snapshot_id"] else None,
        "active_release_id": act["release_id"] if act else None,
        "consumer_test_runs": runs, "created_by": r["created_by"], "created_at": r["created_at"],
    }


def _http_json(method, url, token=None, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if os.environ.get("LWB_ACCESS_CODE"):
        req.add_header("X-Access-Code", os.environ["LWB_ACCESS_CODE"])
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except ValueError:
            return e.code, None


def schema_check(rid, contract, resources):
    """Fetch the candidate's actual HTTP responses and validate them against the generated schemas."""
    results = []
    for rname in resources:
        sname = "".join(w.capitalize() for w in rname.split("-"))
        root = {"$schema": "https://json-schema.org/draft/2020-12/schema",
                "$ref": f"#/components/schemas/{sname}Page", "components": contract["components"]}
        v = Draft202012Validator(root)
        url = f"{PUBLIC_URL}/api/releases/{rid}/resources/{rname}?limit=3"
        pages, errors = 0, []
        while url:
            st, body = _http_json("GET", url, CHECK_TOKEN)
            pages += 1
            if st != 200:
                errors.append(f"HTTP {st} for {url}")
                break
            errors += [f"{'/'.join(map(str, e.absolute_path))}: {e.message}" for e in v.iter_errors(body)][:10]
            url = PUBLIC_URL + body["next"] if body.get("next") else None
        results.append({"resource": rname, "pages": pages, "valid": not errors, "errors": errors[:10]})
    return {"passed": all(r["valid"] for r in results), "resources": results,
            "note": "Structural validation only (JSON Schema 2020-12 via jsonschema 4.23.0). Does not prove units, "
                    "relationship meaning, or permissions."}


def run_consumer_checks(db, actor, rid):
    """No DB write lock is held while HTTP calls run (the consumer reads this server)."""
    c = db.read()
    r = load_release(c, rid)
    contract = json.loads(c.execute("SELECT openapi_json FROM contract_artifact WHERE contract_digest=?",
                                    (r["contract_digest"],)).fetchone()[0])
    resources = sorted(json.loads(r["projection_json"])["resources"])
    started = now()
    t0 = time.time()
    sc = schema_check(rid, contract, resources)
    st, cons = _http_json("POST", f"{CONSUMER_URL}/verify", body={
        "release_id": rid, "base_url": f"{PUBLIC_URL}/api/releases/{rid}"}, timeout=60)
    if st != 200 or not isinstance(cons, dict):
        cons = {"consumer_id": "unreachable", "consumer_version": "n/a", "expectations_digest": "n/a",
                "passed": False, "profiles": [], "error": f"consumer verify HTTP {st}"}
    passed = bool(cons.get("passed")) and sc["passed"]
    with db.tx() as w:
        run_id = new_id("ctr")
        w.execute("INSERT INTO consumer_test_run VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (run_id, rid, cons.get("consumer_id"), cons.get("consumer_version"),
                   cons.get("expectations_digest"), int(passed), json.dumps(cons), json.dumps(sc), started, now()))
        cur = w.execute("SELECT status FROM release WHERE release_id=?", (rid,)).fetchone()["status"]
        if cur in ("candidate", "tested_pass", "tested_fail"):
            w.execute("UPDATE release SET status=? WHERE release_id=?", ("tested_pass" if passed else "tested_fail", rid))
        audit(w, actor, r["project"], "release.consumer_checks", "pass" if passed else "fail",
              detail={"release_id": rid, "run_id": run_id, "elapsed_ms": int((time.time() - t0) * 1000)})
    return release_view(db.read(), rid)


def activate(c, actor, project, rid, expected_active, reason, action="activate"):
    r = load_release(c, rid)
    if r["project"] != project:
        raise ApiError(404, "not_found", "Resource not found.")
    ptr = c.execute("SELECT * FROM release_pointer WHERE project=?", (project,)).fetchone()
    current = ptr["release_id"] if ptr else None
    if expected_active != current:
        raise ApiError(412, "precondition_failed", "Active release changed.", {"active_release_id": current})
    if current == rid:
        raise ApiError(409, "already_active", "Release is already active.")
    last = c.execute("SELECT passed, run_id FROM consumer_test_run WHERE release_id=? ORDER BY started_at DESC LIMIT 1",
                     (rid,)).fetchone()
    blocking = [d for d in json.loads(r["diagnostics_json"]) if d["code"] in BLOCKING]
    prow = c.execute("SELECT status FROM projection_definition WHERE projection_id=? AND version=?",
                     (r["projection_id"], r["projection_version"])).fetchone()
    problems = []
    if blocking:
        problems.append({"code": "blocking_diagnostics", "count": len(blocking)})
    if not last:
        problems.append({"code": "consumer_checks_not_run"})
    elif not last["passed"]:
        problems.append({"code": "consumer_checks_failed", "run_id": last["run_id"]})
    if prow["status"] != "approved":
        problems.append({"code": "projection_no_longer_approved"})
    if problems:
        audit(c, actor, project, f"release.{action}", "refused", detail={"release_id": rid, "problems": problems})
        return 409, {"error": {"code": "activation_blocked", "message": "Release cannot be activated; the active "
                               "release is unchanged.", "details": {"problems": problems,
                                                                    "active_release_id": current}}}
    seq = (ptr["pointer_seq"] if ptr else 0) + 1
    c.execute("INSERT INTO release_pointer VALUES (?,?,?,?) ON CONFLICT(project) DO UPDATE SET "
              "release_id=excluded.release_id, pointer_seq=excluded.pointer_seq, updated_at=excluded.updated_at",
              (project, rid, seq, now()))
    c.execute("INSERT INTO release_activation VALUES (?,?,?,?,?,?,?,?)",
              (project, seq, rid, current, action, actor, reason, now()))
    if r["status"] == "tested_pass":
        c.execute("UPDATE release SET status='activated_once' WHERE release_id=?", (rid,))
    snap = c.execute("SELECT revision FROM source_snapshot WHERE snapshot_id=?", (r["snapshot_id"],)).fetchone()
    eid, eseq = enqueue_event(c, project, "release.activated",
                              {"release_id": rid, "previous_release_id": current, "pointer_seq": seq,
                               "snapshot_id": r["snapshot_id"], "revision": snap["revision"], "action": action,
                               "contract_digest": r["contract_digest"]}, rid)
    audit(c, actor, project, f"release.{action}", "committed",
          detail={"release_id": rid, "previous": current, "pointer_seq": seq, "event_id": eid})
    return 200, {"project": project, "active_release_id": rid, "previous_release_id": current, "pointer_seq": seq,
                 "event": {"event_id": eid, "seq": eseq}, "tested_by_run": last["run_id"]}


def rollback(c, actor, project, expected_active, reason):
    ptr = c.execute("SELECT * FROM release_pointer WHERE project=?", (project,)).fetchone()
    if not ptr:
        raise ApiError(409, "nothing_to_roll_back", "No active release.")
    hist = c.execute("SELECT previous_release_id FROM release_activation WHERE project=? AND pointer_seq=?",
                     (project, ptr["pointer_seq"])).fetchone()
    target = hist["previous_release_id"] if hist else None
    if not target:
        raise ApiError(409, "nothing_to_roll_back", "No previously active release recorded.")
    return activate(c, actor, project, target, expected_active, reason or "rollback", action="rollback")
