"""Golden vectors for HX.policy (tools/policy.py), HX.approvals (approvals/scope.py) and HX.evidence
(evidence/receipts.py): decision tables over every principal x tenant x capability x ceiling x business unit and
approver x initiator x tenant x required role x separation-of-duties combination, PolicyDocument validation,
authentication, revoke sequences with exact policy_version strings, scope/digest vectors and evidence receipt,
validity and scope vectors.
"""

from __future__ import annotations

import copy
import json
import random

from _common import ROOT, write

from pydantic import ValidationError

from hexis_service.approvals.scope import approval_scope, idempotency_key, logical_action_id, scope_digest
from hexis_service.evidence import receipts as EV
from hexis_service.tools.policy import Principal, PolicyService

rng = random.Random(4720261006)
POLICY = json.loads((ROOT / "examples" / "procurement_onboarding" / "policy.json").read_text(encoding="utf-8"))


def canon(x):
    return json.loads(json.dumps(x, sort_keys=True))


def run(fn):
    try:
        return {"ok": fn()}
    except ValidationError as e:
        return {"exc": "ValidationError", "errors": sorted([[x["type"], list(x["loc"])] for x in e.errors()],
                                                           key=lambda x: json.dumps(x))}
    except Exception as e:  # noqa: BLE001
        return {"exc": type(e).__name__, "message": str(e)}


def dec(d):
    return [d.outcome, d.reasons, d.allowed]


def pdump(p):
    return p.model_dump(mode="json")


WEIRD = canon({
    "policy_version": "weird/1+old", "note": "", "approver_role": "procurement_approver",
    "approval_required_capabilities": ["erp:draft:create", "x"],
    "principals": {
        "user:str": {"tenant_id": "acme", "roles": "procurement_approver", "capabilities": "documents:read,erp:draft:create",
                     "business_units": "BU-EMEA"},
        "user:dict": {"tenant_id": "acme", "roles": {"procurement_approver": 1}, "capabilities": {"documents:read": True},
                      "business_units": {"BU-NA": 1}},
        "user:none": {"tenant_id": "acme", "roles": None, "capabilities": None, "business_units": None},
        "user:bare": {"tenant_id": "acme"},
        "user:notenant": {"roles": ["procurement_approver"]},
        "user:inttenant": {"tenant_id": 5, "roles": []},
        "user:numcaps": {"tenant_id": "acme", "roles": [1, True], "capabilities": [1, "documents:read"],
                         "business_units": [None, "BU-NA"]},
        "": {"tenant_id": "", "roles": ["procurement_approver"], "capabilities": [""], "business_units": [""]},
    },
})
NOSOD = canon(dict(copy.deepcopy(POLICY), separation_of_duties=False, policy_version="nosod/1"))
DOCS = {"example": POLICY, "weird": WEIRD, "nosod": NOSOD}

# ---- PolicyDocument validation / authentication -------------------------------------------------- #
doc_cases = []
BAD_DOCS = [
    {}, {"policy_version": "v"}, {"policy_version": "v", "principals": {}, "approver_role": "r"},
    {"policy_version": "v", "principals": {}, "approver_role": "r", "extra": 1},
    {"policy_version": 1, "principals": {}, "approver_role": "r"},
    {"policy_version": "v", "principals": [], "approver_role": "r"},
    {"policy_version": "v", "principals": {"a": []}, "approver_role": "r"},
    {"policy_version": "v", "principals": {"a": {}}, "approver_role": None},
    {"policy_version": "v", "principals": {}, "approver_role": "r", "separation_of_duties": "no"},
    {"policy_version": "v", "principals": {}, "approver_role": "r", "separation_of_duties": "maybe"},
    {"policy_version": "v", "principals": {}, "approver_role": "r", "approval_required_capabilities": "x"},
    {"policy_version": "v", "principals": {}, "approver_role": "r", "approval_required_capabilities": [1]},
    {"policy_version": "v", "principals": {}, "approver_role": "r", "note": None},
    {"policy_version": "v", "principals": {"a": {"x": [1, {"y": None}]}}, "approver_role": "r", "separation_of_duties": 0},
    "x", None, [],
]
for d in [POLICY, WEIRD, NOSOD] + BAD_DOCS:
    d = canon(d)

    def mk(d=d):
        s = PolicyService(d)
        return {"doc": s.doc.model_dump(mode="json"), "version": s.version, "digest": s.digest()}
    doc_cases.append({"doc": d, "result": run(mk)})

auth = []
for name, doc in DOCS.items():
    svc = PolicyService(doc)
    for pid in list(doc["principals"]) + ["user:nobody", "USER:ALICE", "", 5, None]:
        auth.append({"doc": name, "pid": pid, "result": run(lambda: pdump(svc.authenticate(pid)))})

principal_cases = []
for f in [{"id": "a", "tenant_id": "t"}, {"id": "a", "tenant_id": "t", "roles": ["r1", "r2"]},
          {"id": "a", "tenant_id": "t", "roles": "r"}, {"id": "a", "tenant_id": "t", "roles": [1]},
          {"id": "a", "tenant_id": "t", "roles": None}, {"id": "a"}, {"id": 1, "tenant_id": "t"},
          {"id": "a", "tenant_id": "t", "authenticated_by": "sso"}, {"id": "a", "tenant_id": "t", "x": 1},
          {"id": "a", "tenant_id": "t", "roles": {"r": 1}}, {"id": "a", "tenant_id": "t", "roles": 5}]:
    principal_cases.append({"fields": f, "result": run(lambda: pdump(Principal(**f)))})

# ---- decision tables ------------------------------------------------------------------------------ #
CAPS = ["documents:read", "supplier:read", "draft:validate", "erp:draft:create", "erp:draft:read", "draft:verify",
        "payments:send", ""]
CEILINGS = [CAPS[:6], ["documents:read", "erp:draft:read"], []]
TENANTS = ["acme", "globex", "initech"]
BUS = ["BU-EMEA", "BU-NA", "BU-APAC", None]


def principals_for(name, doc):
    svc = PolicyService(doc)
    out = []
    for pid in doc["principals"]:
        try:
            out.append(pdump(svc.authenticate(pid)))
        except Exception:  # noqa: BLE001
            pass
    out += [{"id": "user:alice", "tenant_id": "globex", "roles": ["procurement_approver"], "authenticated_by": "forged"},
            {"id": "user:nobody", "tenant_id": "acme", "roles": [], "authenticated_by": "simulated-directory"},
            {"id": "user:notenant", "tenant_id": "acme", "roles": [], "authenticated_by": "simulated-directory"},
            {"id": "user:inttenant", "tenant_id": "acme", "roles": [], "authenticated_by": "simulated-directory"}]
    return out


dispatch, approve, PRINS = [], [], {}
for name, doc in DOCS.items():
    svc = PolicyService(doc)
    prins = PRINS[name] = principals_for(name, doc)
    for pi, p in enumerate(prins):
        P = Principal(**p)
        for t in TENANTS:
            for c in CAPS:
                for ci, ceil in enumerate(CEILINGS):
                    for bu in BUS:
                        if name != "example" and rng.random() < 0.7:
                            continue
                        dispatch.append({"doc": name, "p": pi, "tenant": t, "cap": c, "ceiling": ci, "bu": bu,
                                         "result": run(lambda: dec(svc.evaluate_dispatch(P, t, c, ceil, bu)))})
        for init in ["user:alice", "user:bob", p["id"], ""]:
            for t in TENANTS:
                for role in ["", "procurement_approver", "procurement_specialist", "cfo", None]:
                    args = (P, init, t) if role is None else (P, init, t, role)
                    approve.append({"doc": name, "p": pi, "initiator": init, "tenant": t, "role": role,
                                    "result": run(lambda: dec(svc.can_approve(*args)))})
odd_dispatch = []
svc = PolicyService(POLICY)
P = svc.authenticate("user:alice")
for c, ceil, bu in [(None, CAPS, "BU-NA"), (5, [5], "BU-NA"), ("documents:read", "documents:read,x", "BU-NA"),
                    ("documents:read", {"documents:read": 1}, "BU-NA"), ("documents:read", None, "BU-NA"),
                    ("documents:read", CAPS, 5), ("documents:read", CAPS, ""), (["x"], CAPS, "BU-NA")]:
    odd_dispatch.append({"cap": c, "ceiling": ceil, "bu": bu,
                         "result": run(lambda: dec(svc.evaluate_dispatch(P, "acme", c, ceil, bu)))})

requires = []
for name, doc in DOCS.items():
    s = PolicyService(doc)
    for c in CAPS + ["x", 5, None]:
        requires.append({"doc": name, "cap": c, "result": run(lambda: s.requires_approval(c))})

# ---- revoke sequences ----------------------------------------------------------------------------- #
revokes = []
for i in range(60):
    name = rng.choice(list(DOCS))
    s = PolicyService(DOCS[name])
    steps = []
    for _ in range(rng.randrange(1, 6)):
        pid = rng.choice(list(DOCS[name]["principals"]) + ["user:nobody"])
        cap = rng.choice(CAPS + ["documents"])
        r = run(lambda: s.revoke_capability(pid, cap))
        steps.append({"pid": pid, "cap": cap, "result": r, "version": s.version, "digest": s.digest(),
                      "principals": s.doc.model_dump(mode="json")["principals"]})
    revokes.append({"doc": name, "steps": steps})

# ---- approvals/scope.py ------------------------------------------------------------------------- #
lids = []
for _ in range(120):
    a = [rng.choice(["r1", "run-é😀", "", 5]), rng.choice(["S", "PERSIST_DRAFT"]), rng.choice([0, 1, 17, 2.5, True, None]),
         rng.choice(["sha256:" + "%064x" % rng.getrandbits(256), "", "d"])]
    lids.append({"args": a, "lid": logical_action_id(*a), "idem": idempotency_key(a[0], logical_action_id(*a))})
scopes = []
for _ in range(80):
    kw = {"tenant_id": rng.choice(["acme", "globex"]), "run_id": "r%d" % rng.randrange(9), "interaction_id": "ix_%x" % rng.getrandbits(32),
          "artifact_hash": "sha256:" + "%064x" % rng.getrandbits(256), "lid": "la_%x" % rng.getrandbits(48),
          "tool": "erp.create_draft", "tool_version": rng.choice(["1", "1.0.0"]),
          "args_digest": "sha256:" + "%064x" % rng.getrandbits(256),
          "business_reference": rng.choice(["SUP-10042", None, {"supplier_ref": "SUP-1", "bu": "BU-NA"}, 5, [1, "a"]]),
          "evidence": [{"receipt_id": "ev_%d" % i, "claim": "c", "subject_digest": "sha256:x"} for i in range(rng.randrange(3))],
          "policy_version": rng.choice(["onboarding-policy/2026-09", "onboarding-policy/2026-09+rev1234abcd"]),
          "required_role": rng.choice(["", "procurement_approver"]), "expires_at": rng.choice([86401, 100.5, None, 0])}
    kw = canon(kw)
    sc = approval_scope(**kw)
    scopes.append({"kw": kw, "scope": sc, "digest": scope_digest(sc)})
scope_errors = []
for kw in [{"tenant_id": "t"}, dict(scopes[0]["kw"], extra=1)]:
    scope_errors.append({"kw": kw, "result": run(lambda: approval_scope(**kw))})

# ---- evidence/receipts.py ----------------------------------------------------------------------- #
VALUES = [{"erp_draft_id": "ERP-1", "persisted_version": 2, "persisted_draft": {"a": 1}, "draft_digest": "sha256:d"},
          {"erp_draft_id": "ERP-1", "persisted_version": 3, "persisted_draft": {"a": 1}, "draft_digest": "sha256:d"},
          {"erp_draft_id": "ERP-1", "persisted_version": 2, "persisted_draft": {"a": 1, "b": None}},
          {"erp_draft_id": None, "persisted_version": 2.5, "persisted_draft": [1, "é😀"], "draft_digest": False}, {}]
NAMES = ["erp_draft_id", "persisted_version", "persisted_draft", "draft_digest"]
subjects = []
for v in VALUES:
    for k in range(5):
        names = rng.sample(NAMES + ["ghost"], rng.randrange(0, 5))
        subjects.append({"values": v, "names": names, "subject": EV.subject_of(v, names)})
receipts = []
recs = []
for _ in range(60):
    v = rng.choice(VALUES)
    names = rng.sample(NAMES, rng.randrange(1, 5))
    subj = EV.subject_of(v, names)
    args = [rng.choice(["r1", "r2"]), rng.choice(["persisted_draft_matches_approved_payload", "other"]),
            "draft.verify_persisted", rng.choice(["1", "2"]), subj, rng.choice(["match", "pass", "mismatch", "fail"]),
            "la_x#%d" % rng.randrange(3), rng.choice([5, 12.25, 1700000000])]
    rid = rng.choice([None, None, "", "vr_custom"])
    rec = EV.make_receipt(*args, receipt_id=rid) if rid is not None else EV.make_receipt(*args)
    if rng.random() < 0.2:
        rec["invalidated_at"] = rng.choice([None, 7.5])
    receipts.append({"args": args, "receipt_id": rid, "receipt": rec})
    recs.append(rec)
validity = []
for _ in range(80):
    rs = rng.sample(recs, rng.randrange(0, 6))
    v = rng.choice(VALUES)
    claim = rng.choice([None, "persisted_draft_matches_approved_payload", "other", "nope"])
    validity.append({"receipts": rs, "values": v, "claim": claim,
                     "current": [EV.is_current(r, v) for r in rs],
                     "valid": [r["receipt_id"] for r in (EV.valid_positive(rs, v, claim) if claim else EV.valid_positive(rs, v))],
                     "scope": EV.evidence_scope(rs, v)})

# lone surrogates: sha256_hex(str) raises UnicodeEncodeError (exact message)
lid_errors = []
for a in [["a\ud800", "s", 1, "d"], ["r", "\udc00", 0, "d"], ["r", "s", 0, "x\udfff\ud800y"], ["\ud83d", "S", None, ""],
          ["r\u00e9\U0001F600", "s", 2.5, "\udc00\udc01\udc02"], [["a\ud800"], "s", 1, "d"], [{"\udc00": 1}, "s", True, "d"]]:
    lid_errors.append({"fn": "logical_action_id", "args_json": json.dumps(a), "result": run(lambda: logical_action_id(*a))})
for a in [["\udc00", "x"], ["t", "la_\ud800"], ["\U0001F600\ud800x", "y"], ["ok", "\udfff\udbff"], [5, "x"]]:
    lid_errors.append({"fn": "idempotency_key", "args_json": json.dumps(a), "result": run(lambda: idempotency_key(*a))})

write("policy_dispatch", {"dispatch": dispatch})
write("policy", {
    "docs": DOCS, "principals": PRINS, "doc_cases": doc_cases, "auth": auth, "principal_cases": principal_cases, "ceilings": CEILINGS,
    "odd_dispatch": odd_dispatch, "approve": approve, "requires": requires, "revokes": revokes,
    "lids": lids, "scopes": scopes, "scope_errors": scope_errors, "lid_errors": lid_errors, "subjects": subjects, "receipts": receipts,
    "validity": validity, "positive_results": list(EV.POSITIVE_RESULTS),
})
print("policy golden:", len(dispatch), "dispatch,", len(approve), "approve,", len(revokes), "revoke sequences,",
      len(scopes), "scopes,", len(receipts), "receipts,", len(validity), "validity vectors")
