"""Golden vectors for HX.store (storage/sqlite.py Store, storage/__init__.py open_store).

Drives the real SQLite ``Store(":memory:")`` with seeded random operation sequences that cover every public
method, including conflicts (revision CAS, stale leases, admission/archive CAS), idempotent creates, duplicate
keys, NOT NULL violations, terminal run statuses, response races, evidence invalidation and malformed
arguments. Records each call's return value (``_common.ints`` normalizes SQLite REAL values) or the exception
class (and the ConflictError code), plus every table's rows after each sequence.

Files: store.json (index, open_store vectors, deviation vectors) and store_<n>.json (sequences).
"""

from __future__ import annotations

import json
import random
import sqlite3

from _common import GOLDEN, ints, write

from hexis_service.storage import open_store
from hexis_service.storage.sqlite import ConflictError, Store

rng = random.Random(4520261006)

TENANTS = ["acme", "globex", "t"]
RUNS = ["r1", "r2", "r3"]
LIDS = ["la_1", "la_2", "la_3", "la_0"]
IIDS = ["ix1", "ix2", "ix3"]
WORKERS = ["w1", "w2"]
HASHES = ["sha256:a", "sha256:b", "sha256:c"]
SKILLS = ["skill-a", "skill-b"]
ENVS = ["sandbox", "production"]
RUN_STATUSES = ["RUNNING", "WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT", "RECONCILING", "COMPLETED", "FAILED", "CANCELLED"]
INTENT_STATUSES = ["PENDING", "DISPATCHING", "SUCCEEDED", "FAILED", "UNKNOWN_EFFECT", "DENIED"]
TABLES = ["schema_migrations", "machine_versions", "machine_lifecycle", "active_machine_versions", "admission_reports",
          "runs", "checkpoints", "run_events", "leases", "action_intents", "action_receipts", "approval_requests",
          "approval_responses", "trace_blobs", "trace_archive_manifests", "update_proposals", "evidence_receipts"]


def canon(x):
    """Inputs are given to Python in sorted key order (golden files are written with sorted keys)."""
    return json.loads(json.dumps(x, sort_keys=True))


class Clock:
    def __init__(self):
        self.t = 1

    def __call__(self):
        r = rng.random()
        if r < 0.5:
            self.t += 1
        elif r < 0.6:
            self.t += 0.5
        return ints(self.t) if rng.random() > 0.05 else rng.choice([0, 1, 3.25, 100])


def pick(pool, odd=0.04):
    """A pool value, or (rarely) an adversarial one."""
    if rng.random() < odd:
        return rng.choice([None, 5, True, "", "é😀", {"k": 1}, [1]])
    return rng.choice(pool)


def jval(depth=0):
    r = rng.random()
    if depth < 3 and r < 0.2:
        return {rng.choice(["a", "b", "c", "z", "é"]): jval(depth + 1) for _ in range(rng.randrange(3))}
    if depth < 3 and r < 0.3:
        return [jval(depth + 1) for _ in range(rng.randrange(3))]
    return rng.choice([None, True, False, 0, 1, -7, 2.5, "x", "", "é😀", 10 ** 12, 0.125])


def deep(n):
    v = []
    for _ in range(n):
        v = [v]
    return v


def checkpoint(rev=None, status=None):
    cp = {"revision": rev if rev is not None else rng.randrange(0, 5),
          "status": status or rng.choice(RUN_STATUSES), "state_id": rng.choice(["S", "T"]), "variables": jval()}
    r = rng.random()
    if r < 0.03:
        cp.pop("status")
    elif r < 0.06:
        cp.pop("revision")
    elif r < 0.08:
        cp["variables"] = deep(70)
    elif r < 0.1:
        cp["status"] = rng.choice([None, 5, {"x": 1}])
    return cp


def events():
    r = rng.random()
    if r < 0.04:
        return [{"no_type": 1}]
    if r < 0.06:
        return None
    if r < 0.08:
        return [{"type": None}]
    if r < 0.1:
        return [{"type": "X", "deep": deep(70)}]
    if r < 0.12:
        return [{"type": "A", "sequence": 99}]
    return [{"type": rng.choice(["A", "TRANSITION", "OBSERVATION"]), "v": jval()} for _ in range(rng.randrange(0, 3))]


def evidence_template():
    recs = []
    for _ in range(rng.randrange(0, 3)):
        rec = {"receipt_id": rng.choice(["ev_{seq}", "ev_x", "e1"]), "run_id": pick(RUNS), "claim": pick(["c", "d"]),
               "verifier": "v", "verifier_version": "1", "subject": {"a": rng.randrange(3)}, "subject_digest": "sd",
               "result": rng.choice(["match", "pass", "mismatch"]), "source_ref": "lid#{seq}",
               "observed_at": rng.choice([1, 2.5, 5])}
        if rng.random() < 0.05:
            rec.pop(rng.choice(list(rec)))
        recs.append(rec)
    return recs


def fill(t, seq):
    if isinstance(t, str):
        return t.replace("{seq}", str(seq))
    if isinstance(t, list):
        return [fill(x, seq) for x in t]
    if isinstance(t, dict):
        return {k: fill(v, seq) for k, v in t.items()}
    return t


def package_json():
    h = pick(HASHES, 0.03)
    p = {"artifact_hash": h, "machine": {"skill_id": pick(SKILLS, 0.03)}, "lineage": {"parent_hash": pick(HASHES + [None])},
         "body": jval()}
    r = rng.random()
    if r < 0.03:
        p.pop("machine")
    elif r < 0.05:
        p["lineage"] = []
    elif r < 0.07:
        p = rng.choice([[], "x", None])
    return p


def traces():
    if rng.random() < 0.04:
        return [["only", "two"]]
    return [[rng.choice(["tr1", "tr2", "tr3"]), "sha", rng.choice(["body1", "body2"])] for _ in range(rng.randrange(3))]


def gen_op(clock):
    m = rng.choice(OPS)
    t, r = pick(TENANTS), pick(RUNS)
    a, kw = [], {}
    if m == "put_version":
        a = [package_json(), pick(["alice", "bob"]), clock()]
    elif m in ("get_version", "lifecycle", "is_revoked", "is_admitted"):
        a = [pick(HASHES)]
    elif m == "add_lifecycle_entry":
        a = [pick(HASHES), pick(["revoked", "admitted", "active", "retired"]), "alice", pick(["", "why", None]), clock()]
    elif m == "add_lifecycle":
        a = ["$db", pick(HASHES), pick(["revoked", "admitted"]), "alice", "r", clock()]
    elif m == "admission_record":
        a = [pick(HASHES + [h + "@sandbox" for h in HASHES])]
    elif m == "publish_admission":
        h = pick(HASHES)
        env = pick(ENVS)
        kw = {"environment": env, "skill_id": pick(SKILLS), "artifact_hash": h,
              "expected_parent_hash": rng.choice(HASHES + [None, None]),
              "gated_archive_version": rng.choice([None, None, 1, 2, 3, True]), "traces": traces(),
              "record": {"artifact_hash": h, "sig": "x"}, "report": {"passed": True, "n": rng.randrange(5)},
              "env_key": str(h) + "@" + str(env), "actor": "alice", "manifest": {"trace_ids": ["tr1"], "note": jval()},
              "now": clock()}
        if rng.random() < 0.05:
            kw["manifest"] = rng.choice([[], "m"])
        if rng.random() < 0.03:
            kw.pop(rng.choice(list(kw)))
    elif m == "append_archive_manifest":
        kw = {"skill_id": pick(SKILLS), "expected_version": rng.choice([None, 1, 2, 3, 4]), "artifact_hash": pick(HASHES),
              "manifest": {"trace_ids": ["tr2"]}, "traces": traces(), "actor": "bob",
              "lifecycle_state": rng.choice(["archive_updated", "retired"]), "lifecycle_reason": "r", "now": clock()}
    elif m == "get_active":
        a = [pick(ENVS), pick(SKILLS)]
    elif m == "create_run":
        a = [t, r, pick(HASHES), pick(["user:alice", "user:bob"]), rng.choice(["", "req1", "req2", None, "req3"]),
             checkpoint(rev=0), events(), clock()]
    elif m == "run_by_request":
        a = [t, rng.choice(["req1", "req2", "", None])]
    elif m in ("list_runs",):
        a = [t]
    elif m in ("get_run", "latest_checkpoint", "checkpoints", "events", "intents", "request_cancel", "lease_token"):
        a = [t, r]
    elif m == "append_events":
        a = [t, r, events(), clock()]
    elif m == "commit_transition":
        a = [t, r, rng.choice([0, 0, 1, 1, 2, 3, None]), rng.choice([None, None, None, None, 1, 2, 3, True]),
             checkpoint(), events(), clock()]
    elif m == "set_run_status":
        a = [t, r, pick(RUN_STATUSES, 0.06)]
    elif m == "acquire_lease":
        a = [t, r, pick(WORKERS), clock(), rng.choice([10, 0.5, 100, 0])]
    elif m == "create_intent":
        a = [t, r, pick(LIDS), "S", rng.choice([0, 1, 2, 1.5, True]), "erp.create_draft", "1", jval(), "sha256:d",
             "idem_" + rng.choice("ab"), rng.choice([None, 1, 2]), clock()]
    elif m == "intent_for_revision":
        a = [t, r, rng.choice([0, 1, 2, 1.5])]
    elif m == "intent":
        a = [t, pick(LIDS)]
    elif m == "update_intent":
        a = [t, pick(LIDS), pick(INTENT_STATUSES, 0.05), clock()]
        if rng.random() < 0.4:
            kw["bump_attempt"] = rng.choice([True, False, 1])
        if rng.random() < 0.3:
            kw["lease_token"] = rng.choice([1, 2, 7])
        if rng.random() < 0.4:
            kw["require_token"] = rng.choice([1, 2, 3])
        if rng.random() < 0.4:
            kw["expect_status"] = rng.sample(INTENT_STATUSES, rng.randrange(0, 3))
        if rng.random() < 0.2:
            kw["run_id"] = r
    elif m in ("record_outcome", "add_receipt"):
        a = [t, pick(LIDS), r, "erp.create_draft", "1", "sha256:d", "idem", pick(["SUCCEEDED", "FAILED", "UNKNOWN", "DENIED"]),
             pick(["certain", "no_effect", "unknown"]), rng.choice([None, "ERP-1", "X-2"]),
             rng.choice([None, {"ok": True}, jval(), [1, 2], 0, ""]), "conn", clock()]
        if m == "record_outcome":
            if rng.random() < 0.5:
                kw["intent_status"] = pick(INTENT_STATUSES)
            if rng.random() < 0.5:
                kw["evidence"] = {"$evidence": evidence_template()}
            if rng.random() < 0.4:
                kw["require_token"] = rng.choice([1, 2, 3])
            if rng.random() < 0.4:
                kw["expect_status"] = rng.sample(INTENT_STATUSES, rng.randrange(0, 3))
    elif m == "receipts":
        a = [t]
        r0 = rng.random()
        if r0 < 0.45:
            kw["run_id"] = r
        elif r0 < 0.85:
            kw["lid"] = pick(LIDS)
        elif r0 < 0.92:
            a.append(pick(LIDS))
        else:
            kw = {"lid": "", "run_id": r}
    elif m == "create_interaction":
        a = [t, r, pick(IIDS), rng.choice(["approval", "input"]), "S", rng.choice([0, 1, 2]), {"scope": jval()},
             "sd_" + rng.choice("ab"), rng.choice([None, 50, 99.5]), clock()]
    elif m == "interaction":
        a = [t, pick(IIDS)]
    elif m == "interaction_for_revision":
        a = [t, r, rng.choice([0, 1, 2])]
    elif m == "set_interaction_status":
        a = [t, pick(IIDS), pick(["OPEN", "EXPIRED", "ANSWERED", "CLOSED"], 0.05)]
    elif m == "record_response":
        a = [t, pick(IIDS), r, pick(["user:bob", "user:eve"]), {"approval_decision": rng.choice(["approved", "rejected"])},
             "sd", rng.choice([None, "rq1", "rq2"]), clock()]
        if rng.random() < 0.5:
            kw["events"] = events()
        if rng.random() < 0.5:
            kw["run_status"] = pick(RUN_STATUSES)
    elif m == "response":
        a = [t, pick(IIDS)]
    elif m == "add_evidence":
        a = [t, fill(rng.choice(evidence_template() or [{"receipt_id": "e1", "run_id": r, "claim": "c", "verifier": "v",
                                                          "verifier_version": "1", "subject": {}, "subject_digest": "s",
                                                          "result": "pass", "source_ref": "x", "observed_at": 2}]), 1)]
    elif m == "evidence":
        a = [t, r]
    elif m == "invalidate_evidence":
        a = [t, rng.choice(["ev_1", "ev_2", "ev_x", "e1"]), pick(["stale", "subject variable changed", None]), clock()]
        if rng.random() < 0.6:
            kw["run_id"] = r
    elif m == "put_trace":
        a = [rng.choice(["tr1", "tr2", "tr3", None]), "sha", pick(["b1", "b2"]), clock()]
    elif m == "trace_body":
        a = [rng.choice(["tr1", "tr2", "tr3"])]
    elif m == "put_proposal":
        a = [rng.choice(["p1", "p2", None]), pick(HASHES, 0.06), rng.choice([None, "sha256:x"]),
             rng.choice(["CANDIDATE", "REJECTED"]), jval(), clock()]
    elif m == "archive":
        a = [pick(SKILLS)]
        if rng.random() < 0.5:
            kw["version"] = rng.choice([1, 2, 3, None])
    elif m == "schema_version":
        a = []
    return {"m": m, "a": ints(canon(a)), "kw": ints(canon(kw))}


OPS = ["put_version", "get_version", "lifecycle", "add_lifecycle_entry", "add_lifecycle", "is_revoked", "is_admitted",
       "admission_record", "publish_admission", "publish_admission", "append_archive_manifest", "get_active",
       "create_run", "create_run", "create_run", "run_by_request", "list_runs", "get_run", "latest_checkpoint",
       "checkpoints", "append_events", "events", "commit_transition", "commit_transition", "commit_transition",
       "set_run_status", "request_cancel", "acquire_lease", "acquire_lease", "lease_token", "create_intent",
       "create_intent", "intent_for_revision", "intent", "intents", "update_intent", "update_intent", "record_outcome",
       "record_outcome", "record_outcome", "add_receipt", "receipts", "receipts", "create_interaction",
       "create_interaction", "interaction", "interaction_for_revision", "set_interaction_status", "record_response",
       "record_response", "response", "add_evidence", "evidence", "evidence", "invalidate_evidence", "put_trace",
       "trace_body", "put_proposal", "archive", "schema_version"]


def call(st, op):
    a = [st.db if x == "$db" else x for x in op["a"]] if op["m"] == "add_lifecycle" else list(op["a"])
    kw = dict(op["kw"])
    if "evidence" in kw and isinstance(kw["evidence"], dict) and "$evidence" in kw["evidence"]:
        tmpl = kw["evidence"]["$evidence"]
        kw["evidence"] = lambda seq: [fill(x, seq) for x in tmpl]
    if "expect_status" in kw and isinstance(kw["expect_status"], list):
        kw["expect_status"] = tuple(kw["expect_status"])
    if op["m"] in ("publish_admission", "append_archive_manifest") and isinstance(kw.get("traces"), list):
        kw["traces"] = [tuple(x) for x in kw["traces"]]
    try:
        res = getattr(st, op["m"])(*a, **kw)
        return {"r": ints(list(res) if isinstance(res, tuple) else res)}
    except ConflictError as e:
        return {"e": "ConflictError", "code": str(e).split(":")[0], "message": str(e)}
    except sqlite3.Error as e:
        return {"e": type(e).__name__, "message": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"e": type(e).__name__, "message": str(e)}


def tables(st):
    return {t: ints([list(r) for r in st.qa(f"SELECT * FROM {t}")]) for t in TABLES}


sequences = []
nops = 0
for i in range(340):
    st = Store(":memory:")
    clock = Clock()
    seq = {"ops": []}
    for _ in range(rng.randrange(12, 34)):
        op = gen_op(clock)
        op["out"] = call(st, op)
        seq["ops"].append(op)
        nops += 1
    seq["tables"] = tables(st)
    sequences.append(seq)

# A scripted sequence (tests/integration/test_postgres_store.py::_store_script) for readability.
script = []


def scripted():
    st = Store(":memory:")
    ops = []

    def do(m, *a, **kw):
        op = {"m": m, "a": canon(list(a)), "kw": canon(kw)}
        op["out"] = call(st, op)
        ops.append(op)

    cp0 = {"revision": 0, "status": "RUNNING", "x": [1, 2.5, None, "é"]}
    do("create_run", "t", "r1", "sha256:a", "p", "req", cp0, [{"type": "A", "v": 1}], 1.5)
    do("create_run", "t", "r2", "sha256:a", "p", "req", cp0, [], 1.5)
    do("acquire_lease", "t", "r1", "w", 2, 10)
    do("create_intent", "t", "r1", "lid1", "S", 0, "tool", "1", {"k": "v"}, "d", "idem", 1, 3)
    do("create_intent", "t", "r1", "lid-other", "S", 0, "tool", "1", {}, "d", "idem", 1, 3)
    do("update_intent", "t", "lid1", "DISPATCHING", 4, bump_attempt=True, require_token=1)
    do("record_outcome", "t", "lid1", "r1", "tool", "1", "d", "idem", "SUCCEEDED", "certain", "X-1", {"ok": True}, "conn", 5,
       intent_status="SUCCEEDED", evidence={"$evidence": [{"receipt_id": "e{seq}", "run_id": "r1", "claim": "c",
                                                           "verifier": "v", "verifier_version": "1", "subject": {"a": 1},
                                                           "subject_digest": "sd", "result": "match",
                                                           "source_ref": "lid1#{seq}", "observed_at": 5}]},
       require_token=1, expect_status=["DISPATCHING"])
    do("record_outcome", "t", "lid1", "r1", "tool", "1", "d", "idem", "X", "c", None, None, "conn", 6,
       intent_status="FAILED", expect_status=["PENDING"])
    do("create_interaction", "t", "r1", "ix1", "approval", "S", 1, {"s": 1}, "sd", 99, 6)
    do("record_response", "t", "ix1", "r1", "bob", {"approval_decision": "approved"}, "sd", "rq", 7,
       events=[{"type": "RESP"}], run_status="RUNNING")
    do("record_response", "t", "ix1", "r1", "eve", {}, "sd", "rq2", 7)
    do("set_run_status", "t", "r1", "WAITING_FOR_INPUT")
    do("commit_transition", "t", "r1", 0, 1, dict(cp0, revision=1, status="COMPLETED"), [{"type": "DONE"}], 8)
    do("set_run_status", "t", "r1", "RUNNING")
    do("invalidate_evidence", "t", "e1", "stale", 9, run_id="r1")
    do("request_cancel", "t", "r1")
    do("put_proposal", "p1", "sha256:a", None, "CANDIDATE", {"b": 1}, 1)
    do("put_proposal", "p1", "sha256:a", "sha256:b", "REJECTED", {"b": 2}, 2)
    for m, a, kw in [("get_run", ["t", "r1"], {}), ("latest_checkpoint", ["t", "r1"], {}), ("checkpoints", ["t", "r1"], {}),
                     ("events", ["t", "r1"], {}), ("intents", ["t", "r1"], {}), ("intent", ["t", "lid1"], {}),
                     ("receipts", ["t", "lid1"], {}), ("receipts", ["t"], {"run_id": "r1"}),
                     ("interaction", ["t", "ix1"], {}), ("response", ["t", "ix1"], {}), ("evidence", ["t", "r1"], {}),
                     ("lease_token", ["t", "r1"], {}), ("run_by_request", ["t", "req"], {})]:
        do(m, *a, **kw)
    return {"ops": ops, "tables": tables(st)}


sequences.insert(0, scripted())

# Deviations: values SQLite coerces by column affinity that the JS port refuses (InterfaceError).
deviations = []
for m, a in [("create_run", ["t", "r1", "h", 2.5, "", {"status": "RUNNING"}, [], 1]),
             ("create_run", ["t", "r1", "h", "p", "", {"status": "RUNNING"}, [], "5"]),
             ("intent_for_revision", ["t", "r1", "1"]),
             ("put_trace", ["tr", "sha", 0.5, 1]),
             ("acquire_lease", ["t", "r1", "w", 1, "10"])]:
    st = Store(":memory:")
    op = {"m": m, "a": a, "kw": {}}
    deviations.append({"op": op, "python": call(st, op)})

opens = []
import hexis_service.storage.sqlite as SQ  # noqa: E402


class _PathOnly:
    def __init__(self, path=":memory:"):
        self.path = path


_real = SQ.Store
SQ.Store = _PathOnly  # open_store imports Store at call time: record the path without touching the filesystem
try:
    for u in [":memory:", "sqlite://", "sqlite:", "sqlite:///:memory:", "sqlite://:memory:", "sqlite:///rel.db",
              "sqlite:////abs/x.db", "sqlite:rel.db", "sqlite://host/x.db", "mysql://nope", "plain/path.db", "x.db"]:
        try:
            opens.append({"url": u, "path": open_store(u).path})
        except ValueError as e:
            opens.append({"url": u, "exc": "ValueError", "message": str(e)})
finally:
    SQ.Store = _real

# reopen(): '' (a private temporary database) reopens empty, ':memory:' returns self (open or closed), a file path
# reopens the same rows even after close(). "FILE" stands for a fresh file in a temporary directory.
import os  # noqa: E402
import tempfile  # noqa: E402


def _body(st, tid):
    try:
        return {"ok": st.trace_body(tid)}
    except Exception as e:  # noqa: BLE001
        return {"e": type(e).__name__, "message": str(e)}


reopens = []
with tempfile.TemporaryDirectory() as tmp:
    for i, (path, close_first) in enumerate([("", False), ("", True), (":memory:", False), (":memory:", True),
                                              ("FILE", False), ("FILE", True)]):
        real = os.path.join(tmp, "r%d.db" % i) if path == "FILE" else path
        a = Store(real)
        a.put_trace("x", "s", "b", 1)
        if close_first:
            a.close()
        b = a.reopen()
        reopens.append({"path": path, "close_first": close_first, "same_object": b is a,
                        "reopened_body": _body(b, "x"), "original_body": _body(a, "x")})
        b.close()
        a.close()

files, chunk, size = [], [], 0


def flush():
    global chunk, size
    if chunk:
        name = "store_%d" % (len(files) + 1)
        write(name, {"sequences": chunk})
        files.append(name)
    chunk, size = [], 0


for s in sequences:
    n = len(json.dumps(s))
    if size + n > 900_000:
        flush()
    chunk.append(s)
    size += n
flush()

write("store", {"files": files, "n_sequences": len(sequences), "n_ops": nops, "tables": TABLES,
                "open_store": opens, "reopen": reopens, "deviations": deviations, "schema_version": Store(":memory:").schema_version()})
print("store golden:", len(sequences), "sequences,", nops, "ops,", files)
for f in sorted(GOLDEN.glob("store*.json")):
    print(" ", f.name, f.stat().st_size)
