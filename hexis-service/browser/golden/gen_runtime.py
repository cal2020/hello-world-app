"""Golden transcripts for the runtime port: HX.broker, HX.service, HX.metrics, HX.registry, HX.env.

Each scenario is a script of operations (plain JSON) that this generator executes against the real Python
reference (``demo/env.py::build_env`` over a temporary directory, ``ManualClock(1790000000.25)``, a fake timer that
returns ``0.125 * n`` on its n-th call, and a deterministic uuid source). For every operation the transcript records
the API result (status/detail/outcome/checkpoint/interaction, handles, cancellation and admission results, the
``RunError`` / ``SimulatedCrash`` / ``ConflictError`` code) and, after state-changing operations, a snapshot:
the full ``inspect_run`` of the run involved (normalized with ``_common.ints``), the digests of all its
checkpoints, the fake ERP rows/calls/faults, the armed fault points, the policy version and the active/archive
pointers. ``test/58_service.test.js`` replays the same scripts in JS and requires deep equality.

Id source: ``deterministic_uuids()`` makes every ``uuid4().hex[:16]`` equal ("0000000000000000"), so a second run in
the same tenant collides (sqlite3.IntegrityError, in Python too). The scenarios therefore patch ``uuid.uuid4`` with
``seq_uuids``: the n-th call returns ``f"{n:016x}{n:016x}"``, which is ``HX.env.make_seq_ids(1)`` in JS.

Files: runtime.json (packages, hashes, the scenario index) and runtime_<n>.json (scenario transcripts). The refined
package is stored as JSON *text* (``refined_json``): golden files are written with sorted keys, which would lose the
machine's state insertion order, and the validator's finding order (so ``report_digest``) depends on it.
"""

from __future__ import annotations

import copy
import json
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path

from _common import GOLDEN, ints, write

from hexis_service import metrics as M
from hexis_service.approvals.scope import approval_scope  # noqa: F401  (documentation of what the service binds)
from hexis_service.artifacts.package import AdmissionRecord, MachinePackage, sign_admission
from hexis_service.artifacts.registry import (enroll_protected, is_admitted_in, register, revoke, signing_key,
                                              admit)
from hexis_service.artifacts.validate import validate_package
from hexis_service.canonical import digest
from hexis_service.demo import fakes
from hexis_service.demo import reference as R
from hexis_service.demo.env import TASK, ManualClock, admit_initial, build_env, compile_procurement, load_catalog
from hexis_service.demo.env import skill_source
from hexis_service.demo.procurement_fixture import deployment_policy
from hexis_service.models.base import ModelResponse
from hexis_service.runtime.service import RunError
from hexis_service.storage.sqlite import ConflictError
from hexis_service.tools.broker import SimulatedCrash
from hexis_service.traces.update import archive_manifest, propose_update

SKILL = "supplier-onboarding-draft"
N_RANDOM = 60
CLOCK0 = 1790000000.25

COMP = compile_procurement()
assert COMP.status == "validated"
INITIAL = COMP.package
_prop = propose_update(INITIAL, R.missing_docs_trace(), [], [], load_catalog(), R.FixtureAligner(), skill_source().text)
assert _prop.status == "CANDIDATE"
REFINED = _prop.candidate
DEV = R.missing_docs_trace()


# ---------------------------------------------------------------------------------------------------------------- #
# package variants (re-expressed in JS by the test: JSON edits of the dump, then sealed())
# ---------------------------------------------------------------------------------------------------------------- #
def _reseal(pkg, fn):
    d = copy.deepcopy(pkg.to_json())
    fn(d)
    d["artifact_hash"] = ""
    return MachinePackage.from_json(d).sealed()


def _other(d):
    d["machine"]["states"]["EXTRACT_DRAFT"]["action"]["prompt"] = "changed"


def _wide(d):
    d["execution_policy"]["max_loop_bound"] = 1000
    d["execution_policy"]["budgets"]["max_steps"] = 100000
    d["machine"]["max_steps"] = 100000
    d["machine"]["states"]["VALIDATE_DRAFT"]["transitions"][1]["if"] = \
        "validation_status == 'repairable' and repair_count < 1000"


def _specialist(d):
    d["contracts"]["interactions"]["REQUEST_APPROVAL"]["required_role"] = "procurement_specialist"


PKGS = {
    "initial": INITIAL,
    "refined": REFINED,
    "other": _reseal(INITIAL, _other),
    "wide": _reseal(INITIAL, _wide),
    "specialist": _reseal(INITIAL, _specialist),
    "unsealed": INITIAL.model_copy(update={"artifact_hash": ""}),
}


# ---------------------------------------------------------------------------------------------------------------- #
# deterministic sources
# ---------------------------------------------------------------------------------------------------------------- #
@contextmanager
def seq_uuids(start: int = 1):
    counter = {"n": start}
    real = uuid.uuid4

    def fake():
        n = counter["n"]
        counter["n"] += 1
        return uuid.UUID(hex=f"{n:016x}{n:016x}")

    uuid.uuid4 = fake
    try:
        yield counter
    finally:
        uuid.uuid4 = real


class FakeTimer:
    def __init__(self):
        self.n = 0
        self.base, self.step = 0.0, 0.125

    def __call__(self) -> float:
        self.n += 1
        return self.base + self.step * self.n


class CostModel:
    """Wraps the fixture model and reports a cost for every answered call."""

    def __init__(self, inner, cost):
        self.inner, self.cost = inner, cost
        self.model_id = inner.model_id

    def generate(self, request):
        resp = self.inner.generate(request)
        return ModelResponse(**{**resp.model_dump(), "cost_usd": self.cost})


class ForeignBUModel(fakes.FixtureExtractionModel):
    def generate(self, req):
        r = super().generate(req)
        if req.state_id in ("EXTRACT_DRAFT", "REPAIR_DRAFT") and isinstance(r.output, dict) and "draft" in r.output:
            r.output["draft"]["business_unit"] = "BU-APAC"
        return r


def make_model(spec):
    if spec is None:
        return None
    spec = dict(spec)
    kind = spec.pop("kind", "fixture")
    cost = spec.pop("cost", None)
    if kind == "foreign_bu":
        m = ForeignBUModel(**spec)
    else:
        m = fakes.FixtureExtractionModel(**spec)
    return CostModel(m, cost) if cost is not None else m


# ---------------------------------------------------------------------------------------------------------------- #
# result encoding
# ---------------------------------------------------------------------------------------------------------------- #
def enc_error(exc):
    if isinstance(exc, RunError):
        return {"error": "RunError", "code": exc.code, "message": exc.message}
    if isinstance(exc, SimulatedCrash):
        return {"error": "SimulatedCrash", "code": str(exc)}
    if isinstance(exc, ConflictError):
        return {"error": "ConflictError", "code": str(exc).split(":")[0], "message": str(exc)}
    return {"error": type(exc).__name__}


def enc_step(r):
    return {"status": r.status, "detail": r.detail, "checkpoint": r.checkpoint.model_dump(mode="json"),
            "interaction": r.interaction}


def enc_handle(h):
    return {"run_id": h.run_id, "tenant_id": h.tenant_id, "artifact_hash": h.artifact_hash, "status": h.status,
            "revision": h.revision}


def enc_cancel(c):
    return {"status": c.status, "disclosed_effects": c.disclosed_effects, "unresolved": c.unresolved}


def enc_adm(a):
    return {"status": a.status, "artifact_hash": a.artifact_hash, "reasons": a.reasons, "record": a.record,
            "archive_version": a.archive_version}


def enc_broker(r):
    return {"status": r.status, "output": r.output, "reason": r.reason, "receipt_ref": r.receipt_ref,
            "certainty": r.certainty, "evidence": r.evidence}


# ---------------------------------------------------------------------------------------------------------------- #
# the interpreter
# ---------------------------------------------------------------------------------------------------------------- #
class Ctx:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.clock = ManualClock(CLOCK0)
        self.timer = FakeTimer()
        self.envs: dict = {}
        self.env = None
        self.runs: dict = {}
        self.ix: dict = {}
        self.tokens: dict = {}
        self.side: list = []
        self.traces: dict = {"dev": [DEV]}

    def p(self, who):
        return self.env.principal(who)

    def run_id(self, name):
        return self.runs[name]


def persist_intent(env, run_id, tool="erp.create_draft"):
    return [i for i in env.store.intents("acme", run_id) if i["tool"] == tool][-1]


def erp_rows(erp):
    return [list(r) for r in erp.db.execute(
        "SELECT tenant_id, draft_id, supplier_ref, draft_digest, idempotency_key, args_digest, payload, version "
        "FROM erp_drafts ORDER BY rowid")]


def snap(ctx: Ctx, run=None):
    e = ctx.env
    out = {"erp": erp_rows(e.erp), "erp_calls": [list(c) for c in e.erp.calls], "erp_faults": list(e.erp.faults),
           "armed": sorted(e.faults.armed), "policy_version": e.policy.version,
           "active": e.store.get_active("sandbox", SKILL), "archive": e.store.archive(SKILL)}
    if run is not None and run in ctx.runs:
        rid = ctx.runs[run]
        run_row = e.store.get_run("acme", rid)
        if run_row is not None:
            out["inspect"] = e.service.inspect_run(rid, e.principal("user:alice"))
            out["checkpoints"] = [digest(c) for c in e.store.checkpoints("acme", rid)]
    return ints(out)


def admit_raw(ctx: Ctx, pkg: MachinePackage):
    """Admit ``pkg`` without archive gates (the refined package's originating trace needs HX.traces): validation,
    signed record and the atomic publish, exactly as admit() does them."""
    e = ctx.env
    rep = validate_package(pkg, e.catalog, "production", skill_text=skill_source().text,
                           deployment_policy=deployment_policy())
    assert rep.passed, [f.code for f in rep.errors]
    rj = rep.to_json()
    key_id, key = signing_key()
    from datetime import datetime, timezone
    now = ctx.clock()
    man = archive_manifest([], [])
    rec = sign_admission(AdmissionRecord(
        artifact_hash=pkg.artifact_hash, environment="sandbox", approver="user:dana",
        admitted_at=datetime.fromtimestamp(now, timezone.utc).isoformat(), validation_report_digest=rj["report_digest"],
        replay_archive_digest=digest(man), key_id=key_id), key)
    register(e.store, pkg, "user:dana", now)
    active = e.store.get_active("sandbox", pkg.machine.skill_id)
    cur = e.store.archive(pkg.machine.skill_id) or {}
    return e.store.publish_admission(
        environment="sandbox", skill_id=pkg.machine.skill_id, artifact_hash=pkg.artifact_hash,
        expected_parent_hash=active[0] if active else None, gated_archive_version=cur.get("version"), traces=[],
        record=rec.model_dump(mode="json"), report=rj, env_key=f"{pkg.artifact_hash}@sandbox", actor="user:dana",
        manifest=man, now=now)


def do(ctx: Ctx, op: dict):
    """Execute one operation; return (result, run_name_for_snapshot or None, take_snapshot)."""
    k = op["op"]
    e = ctx.env
    svc = e.service if e else None
    if k == "env":
        e = build_env(str(ctx.tmp / op["dir"]), clock=ctx.clock, timer=ctx.timer, model=make_model(op.get("model")))
        ctx.envs[op.get("name", "main")] = e
        ctx.env = e
        if op.get("admit", True):
            return enc_adm(admit_initial(e, INITIAL)), None, True
        return None, None, True
    if k == "use_env":
        ctx.env = ctx.envs[op["name"]]
        return None, None, False
    if k == "restart":
        ctx.env = e.restart(model=make_model(op.get("model")))
        ctx.envs[op.get("name", "main")] = ctx.env
        return None, None, True
    if k == "start":
        task = dict(TASK, **op.get("task", {}))
        h = svc.start_run(PKGS[op.get("pkg", "initial")].artifact_hash, task, ctx.p(op.get("as", "user:alice")),
                          request_id=op.get("request_id", ""))
        ctx.runs[op["run"]] = h.run_id
        return enc_handle(h), op["run"], True
    if k in ("run", "advance"):
        rid = ctx.run_id(op["run"])
        kw = {}
        if "worker" in op:
            kw["worker_id"] = op["worker"]
        if k == "run":
            r = svc.run_until_blocked(rid, ctx.p(op.get("as", "user:alice")), **kw)
        else:
            if "expected_revision" in op:
                kw["expected_revision"] = op["expected_revision"]
            r = svc.advance_run(rid, ctx.p(op.get("as", "user:alice")), **kw)
        if r.interaction:
            ctx.ix[op["run"]] = r.interaction
        return enc_step(r), op["run"], True
    if k in ("approve", "resume"):
        rid = ctx.run_id(op["run"])
        ix = ctx.ix[op["run"]]
        if k == "approve":
            scope = ix["scope_digest"] if op.get("scope", "ok") == "ok" else op["scope"]
            resp = {"approval_decision": op.get("decision", "approved"), "scope_digest": scope}
        else:  # response_json: JSON text, so the key order survives the sorted-key golden file
            resp = json.loads(op["response_json"]) if "response_json" in op else op["response"]
        r = svc.resume_interaction(rid, ix["interaction_id"], resp, ctx.p(op.get("as", "user:bob")),
                                   request_id=op.get("request_id", ""))
        if r.interaction:
            ctx.ix[op["run"]] = r.interaction
        return enc_step(r), op["run"], True
    if k == "cancel":
        kw = {"worker_id": op["worker"]} if "worker" in op else {}
        c = svc.cancel_run(ctx.run_id(op["run"]), op.get("expected_revision"), ctx.p(op.get("as", "user:alice")), **kw)
        return enc_cancel(c), op["run"], True
    if k == "resolve":
        rid = ctx.run_id(op["run"])
        lid = op.get("lid") or persist_intent(e, rid, op.get("tool", "erp.create_draft"))["logical_action_id"]
        kw = {}
        if "output" in op:
            kw["output"] = op["output"]
        if "note" in op:
            kw["note"] = op["note"]
        return svc.resolve_effect(rid, lid, op["outcome"], ctx.p(op.get("as", "user:bob")), **kw), op["run"], True
    if k == "inspect":
        return ints(svc.inspect_run(ctx.run_id(op["run"]), ctx.p(op["as"]))), None, False
    if k == "arm":
        e.faults.arm(op["point"])
        return None, None, False
    if k == "inject":
        e.erp.inject(op["fault"])
        return None, None, False
    if k == "clock":
        ctx.clock.advance(op["s"])
        return None, None, False
    if k == "revoke":
        revoke(e.store, PKGS[op.get("pkg", "initial")].artifact_hash, ctx.p(op["as"]), op.get("reason", "defect found"),
               ctx.clock())
        return None, None, True
    if k == "revoke_cap":
        e.policy.revoke_capability(op["pid"], op["cap"])
        return e.policy.version, None, False
    if k == "effect":
        e.catalog.tools[op["tool"]].effect = op["effect"]
        return None, None, False
    if k == "del_tool":
        del e.catalog.tools[op["tool"]]
        return None, None, False
    if k == "clear_reconcilers":
        e.broker.reconcilers.clear()
        return None, None, False
    if k in ("erp_modify", "erp_tamper"):
        cp = svc._cp("acme", ctx.run_id(op["run"]))
        fn = e.erp.modify_out_of_band if k == "erp_modify" else e.erp.tamper_payload
        fn("acme", cp.variables["erp_draft_id"], op["changes"])
        return None, op["run"], True
    if k == "step_until":
        rid = ctx.run_id(op["run"])
        p = ctx.p(op.get("as", "user:alice"))
        for _ in range(50):
            cp = svc._cp(p.tenant_id, rid)
            if cp.state_id == op["state"] or cp.status != "RUNNING":
                return {"state": cp.state_id, "status": cp.status, "revision": cp.revision}, op["run"], True
            svc.advance_run(rid, p)
        raise AssertionError("state not reached")
    if k == "connector":
        if op["kind"] == "spoof_lookup":
            e.broker.connectors["supplier.lookup"] = lambda a, c: {"status": "new", "existing": {}, "approved": True}
        elif op["kind"] == "dying":
            def dying(args, ctx_):
                raise SimulatedCrash("process died before the request reached the ERP")
            e.broker.connectors[op["tool"]] = dying
        return None, None, False
    if k == "bump_intent":
        lid = persist_intent(e, ctx.run_id(op["run"]))["logical_action_id"]
        for _ in range(op["times"]):
            e.store.update_intent("acme", lid, op.get("status", "DISPATCHING"), ctx.clock(), bump_attempt=op.get("bump", True))
        return None, op["run"], True
    if k == "patch_add_evidence_noop":
        e.store._add_evidence = lambda db, tenant, rec: None
        return None, None, False
    if k == "interleave_dispatch":
        rid = ctx.run_id(op["run"])
        real = e.broker.dispatch
        seen = {"n": 0}
        env = e

        def interleaved(**kw):
            seen["n"] += 1
            if seen["n"] == 1:
                ctx.clock.advance(env.service.lease_ttl + 1)
                env.erp.inject("timeout_after_commit")
                try:
                    b = env.service.advance_run(rid, env.principal("user:alice"), worker_id="worker-2")
                    ctx.side.append(enc_step(b))
                except Exception as exc:  # noqa: BLE001
                    ctx.side.append(enc_error(exc))
                ctx.side.append(persist_intent(env, rid)["status"])
            return real(**kw)

        e.broker.dispatch = interleaved
        ctx.restore_dispatch = real
        return None, None, False
    if k == "restore_dispatch":
        e.broker.dispatch = ctx.restore_dispatch
        return ctx.side, None, False
    if k == "crashy_update_intent":
        real = e.store.update_intent
        state = {"n": 0}

        def crashy(tenant, lid, status, *a, **kw):
            if status == "SUCCEEDED" and state["n"] == 0:
                state["n"] = 1
                raise SimulatedCrash("process died after receipt insert, before intent update")
            return real(tenant, lid, status, *a, **kw)

        e.store.update_intent = crashy
        return None, None, False
    if k == "racing_response":
        rid = ctx.run_id(op["run"])
        ix = ctx.ix[op["run"]]
        real = e.store.record_response
        state = {"n": 0}
        env = e

        def racing(*a, **kw):
            if state["n"] == 0:
                state["n"] = 1
                r = env.service.resume_interaction(rid, ix["interaction_id"],
                                                   {"approval_decision": "approved", "scope_digest": ix["scope_digest"]},
                                                   env.principal("user:bob"))
                ctx.side.append(enc_step(r))
            return real(*a, **kw)

        e.store.record_response = racing
        return None, None, False
    if k == "forge_scope_digest":
        ix = ctx.ix[op["run"]]
        with e.store.tx() as db:
            db.execute("UPDATE approval_requests SET scope_digest='sha256:forged' WHERE interaction_id=?",
                       (ix["interaction_id"],))
        return None, op["run"], True
    if k == "approval_check":
        rid = ctx.run_id(op["run"])
        cp = svc._cp("acme", rid)
        run = e.store.get_run("acme", rid)
        pkg = svc.package(cp.artifact_hash)
        prep = svc._prepare_tool(cp, pkg, "PERSIST_DRAFT", cp.revision)
        intent = {"state_id": "PERSIST_DRAFT", "tool": "erp.create_draft", "tool_version": "1.0.0",
                  "logical_action_id": prep["lid"], "args": prep["args"], "args_digest": prep["args_digest"]}
        out = [list(svc._approval_check(run, cp, pkg, intent)())]
        tampered = dict(intent, args=dict(prep["args"], supplier_ref="SUP-99999"), args_digest="sha256:changed")
        out.append(list(svc._approval_check(run, cp, pkg, tampered)()))
        return out, None, False
    if k == "authorize":
        rid = ctx.runs.get(op.get("run"), "nope")
        intent = {"tenant_id": "acme", "run_id": rid, "logical_action_id": "la_x", "tool": "erp.read_draft",
                  "tool_version": "1.0.0", "args": op["args"], "args_digest": "d", "idempotency_key": "k",
                  "status": "PENDING", "attempts": 0}
        called = []
        e.broker.connectors["erp.read_draft"] = lambda a, c: called.append(a) or {}
        ok, why = e.broker.authorize(intent=intent, spec=e.catalog.get("erp.read_draft"), principal=ctx.p("user:alice"),
                                     package=INITIAL, business_unit=op.get("bu", "BU-EMEA"),
                                     approval_check=lambda: (True, ""),
                                     lease_token=ctx.tokens.get(op.get("token")) if op.get("token") else None)
        return [ok, why, len(called)], None, False
    if k == "lease":
        t = e.store.acquire_lease("acme", ctx.run_id(op["run"]), op["worker"], ctx.clock(), op["ttl"])
        if op.get("save"):
            ctx.tokens[op["save"]] = t
        return t, None, False
    if k == "commit_stale":
        rid = ctx.run_id(op["run"])
        cp = e.store.latest_checkpoint("acme", rid)
        e.store.commit_transition("acme", rid, cp["revision"], ctx.tokens[op["token"]], {**cp, "revision": cp["revision"] + 1},
                                  [], ctx.clock())
        return None, None, False
    if k == "freshness_check":
        rid = ctx.run_id(op["run"])
        run = e.store.get_run("acme", rid)
        cp = svc._cp("acme", rid)
        check = svc.freshness["persisted_draft_matches_approved_payload"]
        cp_end = cp.model_copy(update={"state_id": "END_VERIFIED_DRAFT", "revision": cp.revision - 1})
        out = [list(check(svc, run, cp_end, svc.package(cp.artifact_hash), ctx.p("user:alice")))
               for _ in range(op.get("times", 1))]
        return out, op["run"], True
    if k == "stale_dispatch":
        rid = ctx.run_id(op["run"])
        cp = svc._cp("acme", rid)
        pkg = svc.package(cp.artifact_hash)
        prep = svc._prepare_tool(cp, pkg, cp.state_id, cp.revision)
        t1 = e.store.acquire_lease("acme", rid, "worker-1", ctx.clock(), 10)
        intent = e.store.create_intent("acme", rid, prep["lid"], cp.state_id, cp.revision, prep["spec"].name,
                                       prep["spec"].version, prep["args"], prep["args_digest"], prep["idem"], t1,
                                       ctx.clock())
        ctx.clock.advance(11)
        e.store.acquire_lease("acme", rid, "worker-2", ctx.clock(), 10)
        r = e.broker.dispatch(intent=intent, principal=ctx.p("user:alice"), package=pkg, business_unit="BU-EMEA",
                              approval_check=lambda: (True, ""), lease_token=t1, subject_values={})
        return [enc_broker(r), e.store.intent_for_revision("acme", rid, cp.revision)["status"],
                e.store.receipts("acme", prep["lid"])], op["run"], True
    if k == "stop_direct":
        rid = ctx.run_id(op["run"])
        run = e.store.get_run("acme", rid)
        cp = svc._cp("acme", rid)
        svc._stop(run, cp, 999, "FAILED", "X", "y")
        return None, None, False
    if k == "set_run_status":
        return e.store.set_run_status("acme", ctx.run_id(op["run"]), op["status"]), op["run"], True
    if k == "invalidate_evidence":
        rid = ctx.run_id(op["run"])
        cp = svc._cp("acme", rid)
        e.store.invalidate_evidence("acme", cp.variables["verification_receipt"], "test", ctx.clock(), run_id=rid)
        return None, op["run"], True
    if k == "evidence":
        return ints(e.store.evidence("acme", ctx.run_id(op["run"]))), None, False
    if k == "unresolved":
        return svc._unresolved("acme", ctx.run_id(op["run"])), None, False
    if k == "timer":
        ctx.timer.base, ctx.timer.step = op["base"], op["step"]
        return None, None, False
    if k == "append_timing":
        e.store.append_events("acme", ctx.run_id(op["run"]), [dict(op["event"], type="TIMING")], ctx.clock())
        return None, None, False
    if k == "metrics":
        kw = {}
        if "run" in op:
            kw["run_id"] = ctx.runs.get(op["run"], op["run"])
        if "artifact" in op:
            kw["artifact_hash"] = PKGS[op["artifact"]].artifact_hash
        rep = M.collect(e.store, op.get("tenant", "acme"), **kw)
        out = {"report": ints(M.render_json(rep)), "prometheus": M.render_prometheus(rep)}
        if op.get("hostile") and "erp.create_draft" in rep["by_tool"]:
            rep["by_tool"]['we"ird\\tool\nx'] = rep["by_tool"]["erp.create_draft"]
            out["hostile"] = M.render_prometheus(rep)
        return out, None, False
    if k == "admit":
        pol = deployment_policy() if op.get("policy", "default") == "default" else None
        kw = {}
        if op.get("archive_manifest") is not None:
            kw["archive_manifest"] = op["archive_manifest"]
        a = admit(e.store, PKGS[op.get("pkg", "initial")], e.catalog,
                  expected_parent_hash=PKGS[op["parent"]].artifact_hash if op.get("parent") else op.get("parent_hash"),
                  approver=ctx.p(op.get("as", "user:dana")), environment=op.get("environment", "sandbox"),
                  deployment_policy=pol, now=ctx.clock(),
                  skill_text=skill_source().text if op.get("skill_text", True) else None, **kw)
        return enc_adm(a), None, True
    if k == "admit_raw":
        return admit_raw(ctx, PKGS[op["pkg"]]), None, True
    if k == "is_admitted":
        return is_admitted_in(e.store, PKGS[op.get("pkg", "initial")].artifact_hash, op["environment"]), None, False
    if k == "put_version":
        e.store.put_version(PKGS[op["pkg"]].to_json(), op.get("actor", "test"), op.get("now", ctx.clock()))
        return None, None, False
    if k == "forge_lifecycle":
        with e.store.tx() as db:
            e.store.add_lifecycle(db, PKGS[op.get("pkg", "initial")].artifact_hash, "admitted", "mallory",
                                  op.get("environment", "sandbox"), op.get("now", 1.5))
        return None, None, False
    if k == "forge_record":
        h = PKGS[op.get("pkg", "initial")].artifact_hash
        rec = op["record"]
        if isinstance(rec, dict) and rec.get("artifact_hash") == "$hash":
            rec = {**rec, "artifact_hash": h}
        key = f"{h}@{op.get('environment', 'sandbox')}"
        rec_text = json.dumps(rec) if not isinstance(rec, str) else rec
        with e.store.tx() as db:
            db.execute("INSERT OR REPLACE INTO admission_reports VALUES(?,?,?)",
                       (key, rec_text, json.dumps(op.get("report", {"report_digest": "d"}))))
        return None, None, False
    if k == "sign_record":
        # a correctly signed record bound to a report whose digest is in the stored report
        h = PKGS[op.get("pkg", "initial")].artifact_hash
        key_id, key = signing_key()
        rec = sign_admission(AdmissionRecord(artifact_hash=h, environment=op.get("environment", "sandbox"),
                                             approver="mallory", admitted_at="2026-01-01T00:00:00+00:00",
                                             validation_report_digest="d", replay_archive_digest="a", key_id=key_id), key)
        with e.store.tx() as db:
            db.execute("INSERT OR REPLACE INTO admission_reports VALUES(?,?,?)",
                       (f"{h}@{op.get('environment', 'sandbox')}", json.dumps(rec.model_dump(mode="json")),
                        json.dumps({"report_digest": op.get("report_digest", "d")})))
        return rec.model_dump(mode="json"), None, False
    if k == "enroll":
        a = enroll_protected(e.store, op.get("skill", SKILL), [], actor=ctx.p(op.get("as", "user:dana")),
                             environment=op.get("environment", "sandbox"), now=ctx.clock(),
                             negative=op.get("negative", False))
        return enc_adm(a), None, True
    if k == "export":
        from hexis_service.traces.model import export_run_trace
        ts = [export_run_trace(svc, ctx.run_id(r), ctx.p("user:alice"), op.get("verdict", "accepted")) for r in op["runs"]]
        ctx.traces[op["save"]] = ts
        return [t.to_jsonl() for t in ts], None, False
    if k == "enroll_traces":
        ts = [t for name in op["traces"] for t in ctx.traces[name]]
        a = enroll_protected(e.store, SKILL, ts, actor=ctx.p(op.get("as", "user:dana")), environment="sandbox",
                             now=ctx.clock(), negative=op.get("negative", False))
        return enc_adm(a), None, True
    if k == "admit_archive":
        prot = [t for name in op.get("protected", []) for t in ctx.traces[name]]
        neg = [t for name in op.get("negative", []) for t in ctx.traces[name]]
        a = admit(e.store, PKGS[op["pkg"]], e.catalog, expected_parent_hash=PKGS[op["parent"]].artifact_hash
                  if op.get("parent") else None, approver=ctx.p("user:dana"), environment="sandbox",
                  deployment_policy=deployment_policy(), protected=prot, negative=neg, now=ctx.clock(),
                  skill_text=skill_source().text)
        return enc_adm(a), None, True
    if k == "approver_sod":
        d = e.policy.can_approve(ctx.p(op["approver"]), op["initiator"], "acme", op.get("role", ""))
        return {"outcome": d.outcome, "reasons": d.reasons}, None, False
    raise ValueError(f"unknown op {k}")


FULL = "--full" in __import__("sys").argv


def run_scenario(name: str, ops: list) -> dict:
    """Snapshots are stored in full after the last operation and after every failing one, and as a canonical digest
    (``snap_digest``) elsewhere; ``gen_runtime.py --full`` stores every snapshot in full (for debugging)."""
    with tempfile.TemporaryDirectory() as tmp, seq_uuids():
        ctx = Ctx(Path(tmp))
        transcript = []
        for i, op in enumerate(ops):
            entry = {}
            try:
                res, run, take = do(ctx, op)
                entry["result"] = ints(res)
            except (Exception, SimulatedCrash) as exc:  # noqa: BLE001
                entry["error"] = enc_error(exc)
                run, take = op.get("run"), True
            if take and ctx.env is not None:
                sn = snap(ctx, run if run is not None else op.get("run"))
                if FULL or i == len(ops) - 1 or "error" in entry:
                    entry["snap"] = sn
                else:
                    entry["snap_digest"] = digest(sn)
            transcript.append(entry)
        return {"name": name, "ops": ops, "transcript": transcript}


# ---------------------------------------------------------------------------------------------------------------- #
# scenarios
# ---------------------------------------------------------------------------------------------------------------- #
ENV = {"op": "env", "dir": "state"}
START = {"op": "start", "run": "r1"}
RUN = {"op": "run", "run": "r1"}
APPROVE = {"op": "approve", "run": "r1"}
TO_APPROVAL = [ENV, START, RUN]
APPROVED = TO_APPROVAL + [APPROVE]
INJECT = {"supplier_ref": "SUP-30001", "document_ids": ["DOC-INJECT-30001"]}


def restart_finish(worker="worker-2"):
    return [{"op": "clock", "s": 1000}, {"op": "restart"}, {"op": "run", "run": "r1", "worker": worker}]


def non_idempotent_reconciling():
    return [ENV, {"op": "effect", "tool": "erp.create_draft", "effect": "non_idempotent_write"}, START, RUN, APPROVE,
            {"op": "inject", "fault": "timeout_after_commit"}, RUN]


def crash_before_erp_commit():
    return APPROVED + [{"op": "connector", "kind": "dying", "tool": "erp.create_draft"}, RUN,
                       {"op": "clock", "s": 1000}, {"op": "restart"}]


SCENARIOS: dict[str, list] = {
    "happy_path": APPROVED + [RUN, {"op": "inspect", "run": "r1", "as": "user:alice"},
                              {"op": "evidence", "run": "r1"}],
    "restart_while_waiting": TO_APPROVAL + [{"op": "restart"}, APPROVE, RUN, APPROVE],
    "self_approval_refused": TO_APPROVAL + [{"op": "restart"}, dict(APPROVE, **{"as": "user:alice"}),
                                            {"op": "approver_sod", "approver": "user:bob", "initiator": "user:bob"},
                                            {"op": "approver_sod", "approver": "user:carol", "initiator": "user:alice",
                                             "role": "procurement_specialist"},
                                            {"op": "approver_sod", "approver": "user:bob", "initiator": "user:alice",
                                             "role": "procurement_specialist"}],
    "approval_authentication": TO_APPROVAL + [
        dict(APPROVE, **{"as": "user:alice"}), dict(APPROVE, **{"as": "user:carol"}),
        dict(APPROVE, **{"as": "user:mallory"}), dict(APPROVE, scope="sha256:0"),
        dict(APPROVE, decision=True), dict(APPROVE, decision="maybe"),
        {"op": "resume", "run": "r1", "as": "user:bob", "response": {"approval_decision": "approved"}},
        dict(APPROVE, request_id="req-a"), dict(APPROVE, request_id="req-a"), dict(APPROVE, request_id="req-b")],
    "timeout_after_commit": APPROVED + [{"op": "inject", "fault": "timeout_after_commit"}, RUN],
    "timeout_before_commit": APPROVED + [{"op": "inject", "fault": "timeout_before_commit"}, RUN],
    "non_idempotent_reconciling": non_idempotent_reconciling() + [RUN, {"op": "unresolved", "run": "r1"},
                                                                  dict(RUN, worker="worker-9")],
    "resolve_present": non_idempotent_reconciling() + [
        {"op": "resolve", "run": "r1", "outcome": "present", "as": "user:alice", "output": {}},
        {"op": "resolve", "run": "r1", "outcome": "present", "as": "user:bob", "output": {"status": "weird"}},
        {"op": "resolve", "run": "r1", "outcome": "bogus", "as": "user:bob"},
        {"op": "resolve", "run": "r1", "outcome": "present", "as": "user:bob",
         "output": {"status": "created", "draft_id": "D-0001", "version": 1}, "note": "seen in ERP"},
        {"op": "resolve", "run": "r1", "outcome": "absent", "as": "user:bob"},
        RUN],
    "resolve_absent_then_cancel": non_idempotent_reconciling() + [
        {"op": "resolve", "run": "r1", "outcome": "absent", "as": "user:bob", "note": "checked: nothing there"},
        {"op": "clock", "s": 1000}, {"op": "cancel", "run": "r1"}],
    "resolve_retired_tool": non_idempotent_reconciling() + [
        {"op": "del_tool", "tool": "erp.create_draft"},
        {"op": "resolve", "run": "r1", "outcome": "present", "as": "user:bob",
         "output": {"status": "created", "draft_id": "D-0001", "version": 1}},
        {"op": "resolve", "run": "r1", "outcome": "absent", "as": "user:bob"}],
    "resolve_verifier_forbidden": APPROVED + [
        {"op": "step_until", "run": "r1", "state": "VERIFY_PERSISTED"}, {"op": "arm", "point": "after_remote_call"},
        {"op": "advance", "run": "r1"},
        {"op": "resolve", "run": "r1", "tool": "draft.verify_persisted", "outcome": "present", "as": "user:bob",
         "output": {"status": "match", "receipt_id": "vr_FORGED"}},
        {"op": "resolve", "run": "r1", "tool": "draft.verify_persisted", "outcome": "absent", "as": "user:bob"}]
    + restart_finish(),
    "resolve_validator_forbidden": [ENV, START, {"op": "step_until", "run": "r1", "state": "VALIDATE_DRAFT"},
                                    {"op": "arm", "point": "after_remote_call"}, {"op": "advance", "run": "r1"},
                                    {"op": "resolve", "run": "r1", "tool": "draft.validate", "outcome": "present",
                                     "as": "user:bob", "output": {"status": "pass", "issues": [], "draft_digest": "x"}}],
    "stale_lease_fencing": TO_APPROVAL + [
        {"op": "lease", "run": "r1", "worker": "worker-1", "ttl": 10, "save": "t1"},
        {"op": "lease", "run": "r1", "worker": "worker-2", "ttl": 10},
        {"op": "clock", "s": 11},
        {"op": "lease", "run": "r1", "worker": "worker-2", "ttl": 10, "save": "t2"},
        {"op": "commit_stale", "run": "r1", "token": "t1"},
        {"op": "authorize", "run": "r1", "args": {"draft_id": "D-1"}, "token": "t1"},
        {"op": "authorize", "run": "r1", "args": {"draft_id": "D-1"}, "token": "t2"},
        {"op": "authorize", "args": {"draft_id": 7}},
        {"op": "authorize", "run": "r1", "args": {"draft_id": 7}},
        {"op": "authorize", "run": "r1", "args": {"draft_id": "D-1", "business_unit": "BU-APAC"}},
        {"op": "authorize", "run": "r1", "args": {"draft_id": "D-1"}, "bu": None},
        {"op": "advance", "run": "r1", "worker": "worker-1"},
        {"op": "stop_direct", "run": "r1"}],
    "stale_denial_ledger": APPROVED + [{"op": "stale_dispatch", "run": "r1"}],
    "stale_worker_unknown_effect": [ENV, {"op": "effect", "tool": "erp.create_draft", "effect": "non_idempotent_write"},
                                    START, RUN, APPROVE, {"op": "interleave_dispatch", "run": "r1"},
                                    {"op": "advance", "run": "r1", "worker": "worker-1"},
                                    {"op": "restore_dispatch"}, {"op": "clock", "s": 301},
                                    {"op": "advance", "run": "r1", "worker": "worker-3"},
                                    {"op": "unresolved", "run": "r1"}],
    "cancel_races_write": APPROVED + [{"op": "arm", "point": "after_remote_call"}, RUN, {"op": "clock", "s": 1000},
                                      {"op": "restart"}, {"op": "cancel", "run": "r1"},
                                      {"op": "advance", "run": "r1", "worker": "worker-3"},
                                      {"op": "cancel", "run": "r1"}],
    "cancel_unresolvable": non_idempotent_reconciling() + [{"op": "cancel", "run": "r1"}, {"op": "clock", "s": 1000},
                                                           {"op": "cancel", "run": "r1"}],
    "cancel_while_waiting": TO_APPROVAL + [{"op": "cancel", "run": "r1", "as": "user:carol"},
                                           {"op": "cancel", "run": "r1", "expected_revision": 99},
                                           {"op": "cancel", "run": "r1", "worker": "worker-1"}, APPROVE,
                                           {"op": "set_run_status", "run": "r1", "status": "RUNNING"},
                                           {"op": "advance", "run": "r1"}, {"op": "cancel", "run": "r1"}],
    "cancel_retired_tool": APPROVED + [{"op": "arm", "point": "after_remote_call"}, RUN, {"op": "clock", "s": 1000},
                                       {"op": "restart"}, {"op": "del_tool", "tool": "erp.create_draft"},
                                       {"op": "cancel", "run": "r1"}],
    "cancel_proven_absent": crash_before_erp_commit() + [{"op": "cancel", "run": "r1"},
                                                         {"op": "advance", "run": "r1", "worker": "canceller"}],
    "revoke_proven_absent": crash_before_erp_commit() + [{"op": "revoke", "as": "user:dana"},
                                                         {"op": "advance", "run": "r1", "worker": "worker-2"}],
    "retry_budget_exhausted": crash_before_erp_commit() + [{"op": "bump_intent", "run": "r1", "times": 5},
                                                           {"op": "advance", "run": "r1", "worker": "worker-2"},
                                                           {"op": "cancel", "run": "r1", "worker": "worker-2"}],
    "A10_repairs_exhausted": [ENV, dict(START, task={"document_ids": ["DOC-W9-10042"]}), RUN],
    "A20_policy_change": APPROVED + [{"op": "revoke_cap", "pid": "user:carol", "cap": "documents:read"}, RUN],
    "A20_changed_args": APPROVED + [{"op": "approval_check", "run": "r1"}],
    "A20_altered_digest": APPROVED + [{"op": "forge_scope_digest", "run": "r1"}, RUN],
    "A21_revoked_capability": APPROVED + [{"op": "revoke_cap", "pid": "user:alice", "cap": "erp:draft:create"}, RUN],
    "A25_out_of_band": APPROVED + [{"op": "step_until", "run": "r1", "state": "END_VERIFIED_DRAFT"},
                                   {"op": "erp_modify", "run": "r1", "changes": {"legal_name": "Changed Later GmbH"}},
                                   {"op": "advance", "run": "r1"}, {"op": "evidence", "run": "r1"}],
    "A26_gullible": [ENV, {"op": "restart", "model": {"gullible": True}}, dict(START, task=INJECT), RUN],
    "A26_document_text": [ENV, dict(START, task=INJECT), RUN],
    "cross_tenant": TO_APPROVAL + [{"op": "inspect", "run": "r1", "as": "user:mallory"},
                                   {"op": "advance", "run": "r1", "as": "user:mallory"},
                                   {"op": "cancel", "run": "r1", "as": "user:mallory"},
                                   dict(START, run="r2", task={"principal": "user:bob", "tenant_id": "globex"}),
                                   dict(START, run="r3", task={"document_ids": "DOC-W9-10042"})],
    "A28_tamper": APPROVED + [{"op": "step_until", "run": "r1", "state": "READ_BACK"},
                              {"op": "erp_tamper", "run": "r1", "changes": {"tax_id": "DE000000000"}}, RUN],
    "A29_invalid_outputs": [ENV, {"op": "restart", "model": {"invalid_outputs": 5}}, START, RUN],
    "invalid_output_repaired": [ENV, {"op": "restart", "model": {"invalid_outputs": 1}}, START, RUN],
    "model_unavailable": [ENV, {"op": "restart", "model": {"unavailable": True}}, START, RUN],
    "A32_revocation": TO_APPROVAL + [{"op": "revoke", "as": "user:dana"}, dict(START, run="r2"), APPROVE, RUN,
                                     {"op": "revoke", "as": "user:alice", "reason": "x"}],
    "approval_expiry": TO_APPROVAL + [{"op": "clock", "s": 86401}, APPROVE, RUN],
    "request_dedup": [ENV, dict(START, request_id="req-1"), dict(START, run="r1b", request_id="req-1"),
                      {"op": "advance", "run": "r1", "expected_revision": 5}, {"op": "advance", "run": "r1",
                                                                                 "expected_revision": 0}],
    "business_unit_denied": [ENV, dict(START, task={"business_unit": "BU-APAC"}), RUN],
    "business_unit_in_args": [ENV, {"op": "restart", "model": {"kind": "foreign_bu"}}, START, RUN],
    "spoofed_connector": [ENV, {"op": "connector", "kind": "spoof_lookup"}, START, RUN],
    "unadmitted_artifact": [ENV, {"op": "put_version", "pkg": "other"}, dict(START, pkg="other"),
                            {"op": "is_admitted", "pkg": "other", "environment": "sandbox"}],
    "freshness_rereads_after_crash": APPROVED + [
        {"op": "step_until", "run": "r1", "state": "END_VERIFIED_DRAFT"}, {"op": "arm", "point": "before_commit"},
        {"op": "advance", "run": "r1"}, {"op": "erp_modify", "run": "r1", "changes": {"tax_id": "DE999999999"}}]
    + restart_finish(),
    "freshness_never_deduplicated": APPROVED + [RUN, {"op": "freshness_check", "run": "r1", "times": 2}],
    "C14_crash_between_receipt_and_intent": APPROVED + [{"op": "crashy_update_intent"}, RUN] + restart_finish(),
    "C14_dedup_repairs_intent": APPROVED + [{"op": "arm", "point": "after_receipt"}, RUN,
                                            {"op": "bump_intent", "run": "r1", "times": 1, "bump": False}]
    + restart_finish(),
    "C15_crash_after_verifier_receipt": APPROVED + [{"op": "step_until", "run": "r1", "state": "VERIFY_PERSISTED"},
                                                    {"op": "arm", "point": "after_receipt"}, RUN] + restart_finish(),
    "C15_lost_evidence_rederived": APPROVED + [{"op": "step_until", "run": "r1", "state": "VERIFY_PERSISTED"},
                                               {"op": "patch_add_evidence_noop"}, {"op": "arm", "point": "before_commit"},
                                               {"op": "advance", "run": "r1"}, {"op": "evidence", "run": "r1"}]
    + restart_finish(),
    "C18_second_run_same_draft": APPROVED + [RUN, dict(START, run="r2"), dict(RUN, run="r2"), dict(APPROVE, run="r2"),
                                             {"op": "inject", "fault": "timeout_before_commit"}, dict(RUN, run="r2"),
                                             {"op": "invalidate_evidence", "run": "r2"},
                                             {"op": "evidence", "run": "r1"}],
    "C19_losing_response": TO_APPROVAL + [{"op": "racing_response", "run": "r1"},
                                          dict(APPROVE, decision="rejected", request_id="tab-2"),
                                          {"op": "evidence", "run": "r1"}],
    "C08_specialist_role": [{"op": "env", "dir": "s2", "admit": False},
                            {"op": "admit", "pkg": "specialist"}, dict(START, pkg="specialist"), RUN,
                            dict(APPROVE, **{"as": "user:carol"}), APPROVE],
    "missing_docs_refined": [ENV, {"op": "admit_raw", "pkg": "refined"},
                             dict(START, pkg="refined", task={"supplier_ref": "SUP-40002",
                                                              "document_ids": ["DOC-LATE-MISSING"]}), RUN,
                             {"op": "resume", "run": "r1", "as": "user:carol", "response": {"document_ids": ["DOC-LATE-40002"]}},
                             {"op": "resume", "run": "r1", "as": "user:alice", "response": {"document_ids": 7}},
                             {"op": "resume", "run": "r1", "as": "user:alice", "response": {"document_ids": ["DOC-LATE-40002"]}},
                             RUN, APPROVE, RUN],
    "registry_conflict_review": [ENV, dict(START, task={"supplier_ref": "SUP-55555"}), RUN,
                                 dict(START, run="r2", task={"supplier_ref": "SUP-20077",
                                                              "document_ids": ["DOC-W9-20077"]}), dict(RUN, run="r2")],
    "metrics_mixed": [
        {"op": "env", "dir": "m"}, START, RUN, {"op": "clock", "s": 3600}, APPROVE, RUN,
        {"op": "restart", "model": {"invalid_outputs": 1}}, dict(START, run="r2"), dict(RUN, run="r2"),
        {"op": "inject", "fault": "timeout_after_commit"}, {"op": "clock", "s": 60}, dict(APPROVE, run="r2"),
        dict(RUN, run="r2"),
        {"op": "restart", "model": {"invalid_outputs": 5}}, dict(START, run="r3"), dict(RUN, run="r3"),
        {"op": "restart", "model": {"unavailable": True}}, dict(START, run="r4"), dict(RUN, run="r4"),
        {"op": "restart", "model": {}}, dict(START, run="r5"), dict(RUN, run="r5"),
        {"op": "inject", "fault": "timeout_after_commit"}, {"op": "clear_reconcilers"},
        {"op": "effect", "tool": "erp.create_draft", "effect": "non_idempotent_write"}, dict(APPROVE, run="r5"),
        dict(RUN, run="r5"),
        {"op": "metrics", "hostile": True}, {"op": "metrics", "run": "r2"}, {"op": "metrics", "run": "r3"},
        {"op": "metrics", "artifact": "initial"}, {"op": "metrics", "artifact": "refined"},
        {"op": "metrics", "tenant": "globex"}, {"op": "metrics", "tenant": "globex", "run": "r1"}],
    "metrics_priced": [{"op": "env", "dir": "p", "model": {"cost": 0.01}}, START, RUN, {"op": "clock", "s": 7.5},
                       APPROVE, RUN, {"op": "metrics"}],
    # Python 3.12 sum() is compensated (Neumaier): 6 x 0.1 is 0.6000000000000001, latency totals likewise
    "metrics_float_sums": [{"op": "env", "dir": "p", "model": {"cost": 0.1}},
                           {"op": "timer", "base": 12345.678, "step": 0.1},
                           START, RUN, APPROVE, RUN,
                           dict(START, run="r2"), dict(RUN, run="r2"), dict(APPROVE, run="r2"), dict(RUN, run="r2"),
                           dict(START, run="r3"), dict(RUN, run="r3"), dict(APPROVE, run="r3"), dict(RUN, run="r3"),
                           {"op": "metrics"}, {"op": "metrics", "run": "r2"}],
    # integer-like keys keep Python's sorted()/insertion order in the report and the Prometheus text
    "metrics_integer_keys": [ENV, START, RUN, dict(START, run="r2"),
                             {"op": "append_timing", "run": "r1", "event": {
                                 "state": "10", "revision": 1, "total_s": 0.5, "engine_s": 0.25, "model_s": 0.125,
                                 "tool_s": 0.125, "model_calls": [{"model_id": "10", "latency_s": 0.125,
                                                                  "input_tokens": 3, "output_tokens": 4}],
                                 "tool_calls": [{"tool": "9", "latency_s": 0.125, "attempt": 1}]}},
                             {"op": "append_timing", "run": "r1", "event": {
                                 "state": "9", "revision": 2, "total_s": 0.75, "engine_s": 0.5, "model_s": 0.125,
                                 "tool_s": 0.125, "human_wait_s": 2.5,
                                 "model_calls": [{"model_id": "9", "latency_s": 0.125, "cost_usd": 0.1}],
                                 "tool_calls": [{"tool": "10", "latency_s": 0.125, "attempt": 2}]}},
                             {"op": "append_timing", "run": "r2", "event": {"state": "2", "revision": 0,
                                                                            "total_s": 0.25}},
                             {"op": "metrics"}, {"op": "metrics", "run": "r1"}],
    # an integral logical clock: expires_at is the float 1790086401.0 in the approval scope digest
    "approval_integral_clock": [ENV, {"op": "clock", "s": 0.75}, START, RUN, APPROVE, RUN],
    "approval_default_clock": [ENV, {"op": "clock", "s": -0.25}, START, RUN,
                               dict(APPROVE, scope="sha256:" + "0" * 64), APPROVE, RUN],
    # RESPONSE_INVALID messages: python-jsonschema keyword order, sorted extras
    "response_schema_order": [
        ENV, START, RUN,
        {"op": "resume", "run": "r1", "as": "user:bob",
         "response_json": json.dumps({"approval_decision": "rejected", "\u00fcn\u00ef": "\u00e7", "a": [1, 2.5], "Z": None}, ensure_ascii=False)},
        {"op": "resume", "run": "r1", "as": "user:bob", "response_json": json.dumps({"document_ids": []}, ensure_ascii=False)},
        {"op": "resume", "run": "r1", "as": "user:bob", "response_json": json.dumps({"zz": 1, "approval_decision": 5, "b": 2}, ensure_ascii=False)},
        {"op": "resume", "run": "r1", "as": "user:bob", "response_json": json.dumps({"approval_decision": "maybe", "10": 1, "9": 2}, ensure_ascii=False)},
        {"op": "admit_raw", "pkg": "refined"},
        dict(START, run="r2", pkg="refined", task={"supplier_ref": "SUP-40002", "document_ids": ["DOC-LATE-MISSING"]}),
        dict(RUN, run="r2"),
        {"op": "resume", "run": "r2", "as": "user:alice", "response_json": json.dumps({"document_ids": [1, "x"], "q": 1, "\u00e9": 2}, ensure_ascii=False)},
        {"op": "resume", "run": "r2", "as": "user:alice", "response_json": json.dumps({"approval_decision": "approved"}, ensure_ascii=False)},
        {"op": "resume", "run": "r2", "as": "user:alice", "response_json": json.dumps({"document_ids": ["DOC-LATE-40002"]}, ensure_ascii=False)},
        dict(RUN, run="r2"),
        {"op": "resume", "run": "r2", "as": "user:bob", "response_json": json.dumps({"document_ids": []}, ensure_ascii=False)},
        {"op": "resume", "run": "r2", "as": "user:bob", "response_json": json.dumps({"y": [], "x": {}, "approval_decision": None}, ensure_ascii=False)}],
    "admission": [
        {"op": "env", "dir": "a", "admit": False},
        {"op": "admit", "as": "user:alice"},
        {"op": "admit", "policy": None, "environment": "other"},
        {"op": "admit", "pkg": "unsealed", "environment": "other"},
        {"op": "admit", "skill_text": False},
        {"op": "admit", "pkg": "wide", "environment": "other"},
        {"op": "admit", "parent_hash": "sha256:nope"},
        {"op": "admit", "archive_manifest": {"protected": [], "negative": [], "held_out": "x"}},
        {"op": "is_admitted", "environment": "sandbox"},
        {"op": "admit"},
        {"op": "is_admitted", "environment": "sandbox"},
        {"op": "is_admitted", "environment": "production"},
        {"op": "admit"},
        {"op": "admit", "environment": "production"},
        {"op": "admit", "environment": "production", "parent": "initial"},
        {"op": "enroll", "as": "user:alice"},
        {"op": "enroll", "environment": "staging"},
        {"op": "enroll"},
        {"op": "enroll", "negative": True},
        {"op": "admit", "environment": "staging"},
        {"op": "revoke", "as": "user:alice", "reason": "x"},
        {"op": "revoke", "as": "user:dana", "reason": "defect found"},
        {"op": "is_admitted", "environment": "sandbox"},
        dict(START, run="r9")],
    "archive_gates": [
        ENV, START, RUN, APPROVE, RUN, dict(START, run="r2", task={"supplier_ref": "SUP-55555"}), dict(RUN, run="r2"),
        {"op": "export", "runs": ["r1", "r2"], "save": "arch"},
        {"op": "enroll_traces", "traces": ["arch"], "as": "user:alice"},
        {"op": "enroll_traces", "traces": ["arch"]},
        {"op": "enroll_traces", "traces": ["arch"]},
        {"op": "admit_archive", "pkg": "refined", "parent": "initial", "protected": ["arch"]},
        {"op": "admit_archive", "pkg": "refined", "parent": "initial", "protected": ["dev"]},
        {"op": "admit_archive", "pkg": "refined", "parent": "initial", "protected": ["arch", "dev"], "negative": ["dev"]},
        {"op": "admit_archive", "pkg": "refined", "parent": "initial", "protected": ["arch", "dev"]},
        {"op": "enroll_traces", "traces": ["dev"], "negative": True},
        {"op": "enroll_traces", "traces": ["dev"]},
        dict(START, run="r3", pkg="refined", task={"supplier_ref": "SUP-40002", "document_ids": ["DOC-LATE-MISSING"]}),
        dict(RUN, run="r3"), {"op": "export", "runs": ["r3"], "save": "late"},
        {"op": "enroll_traces", "traces": ["late"]}],
    "admission_environments": [
        {"op": "env", "dir": "s4", "admit": False}, {"op": "admit", "environment": "staging"}, START,
        {"op": "admit", "environment": "sandbox"}, START, RUN],
    "admission_forged": [
        {"op": "env", "dir": "s5", "admit": False}, {"op": "put_version", "pkg": "initial", "actor": "mallory", "now": 1.5},
        {"op": "forge_lifecycle"}, START, {"op": "is_admitted", "environment": "sandbox"},
        {"op": "forge_record", "record": {"artifact_hash": "$hash", "environment": "sandbox", "approver": "mallory",
                                          "admitted_at": "2026-01-01T00:00:00+00:00", "validation_report_digest": "d",
                                          "replay_archive_digest": "a", "key_id": "k",
                                          "signature": "hmac-sha256:" + "0" * 64}},
        START, {"op": "is_admitted", "environment": "sandbox"},
        {"op": "forge_record", "record": "{not json"}, {"op": "is_admitted", "environment": "sandbox"},
        {"op": "forge_record", "record": {"artifact_hash": "$hash"}}, {"op": "is_admitted", "environment": "sandbox"},
        {"op": "sign_record"}, {"op": "is_admitted", "environment": "sandbox"}, START,
        {"op": "sign_record", "report_digest": "other"}, {"op": "is_admitted", "environment": "sandbox"},
        {"op": "sign_record", "environment": "staging"}, {"op": "is_admitted", "environment": "staging"}],
}

# one crash scenario per fault-injection point, then a restart that must not duplicate the write
for _pt in ("after_intent", "before_dispatch", "after_remote_call", "after_receipt", "before_commit"):
    SCENARIOS[f"crash_{_pt}"] = APPROVED + [{"op": "arm", "point": _pt}, RUN] + restart_finish()


# ---------------------------------------------------------------------------------------------------------------- #
# seeded random scenarios: each operation is chosen from the live Python state, then recorded for the JS replay.
# Snapshots are stored as digests (``snap_digest``) to keep the golden small.
# ---------------------------------------------------------------------------------------------------------------- #
WHO = ["user:alice", "user:bob", "user:carol", "user:dana", "user:mallory"]
TASKS = [{}, {}, {}, {"document_ids": ["DOC-W9-10042"]}, {"supplier_ref": "SUP-55555"}, INJECT,
         {"business_unit": "BU-APAC"}, {"supplier_ref": "SUP-20077", "document_ids": ["DOC-W9-20077"]}]
MODELS = [None, None, {}, {"invalid_outputs": 1}, {"invalid_outputs": 3}, {"unavailable": True}, {"gullible": True},
          {"kind": "foreign_bu"}, {"cost": 0.25}]


def choose(ctx: Ctx, rng) -> dict:
    e = ctx.env
    runs = sorted(ctx.runs)
    name = rng.choice(runs)
    rid = ctx.runs[name]
    cp = e.service._cp("acme", rid)
    run = e.store.get_run("acme", rid)
    status = run["status"]
    r = rng.random()
    live = [n for n in runs if e.store.get_run("acme", ctx.runs[n])["status"] not in ("COMPLETED", "FAILED", "CANCELLED")]
    if len(runs) < 8 and (r < 0.04 or (not live and r < 0.8)):
        return {"op": "start", "run": f"r{len(runs) + 1}", "task": rng.choice(TASKS), "pkg": "initial"}
    if live and rng.random() < 0.85:
        name = rng.choice(live)
        rid = ctx.runs[name]
        cp = e.service._cp("acme", rid)
        status = e.store.get_run("acme", rid)["status"]
    if status == "WAITING_FOR_APPROVAL" and name in ctx.ix and r < 0.75:
        op = {"op": "approve", "run": name, "as": rng.choice(["user:bob"] * 4 + WHO)}
        if rng.random() < 0.1:
            op["scope"] = "sha256:0"
        if rng.random() < 0.1:
            op["decision"] = rng.choice(["rejected", True, "approved"])
        if rng.random() < 0.15:
            op["request_id"] = rng.choice(["q1", "q2"])
        return op
    if status == "WAITING_FOR_INPUT" and name in ctx.ix and r < 0.55:
        return {"op": "resume", "run": name, "as": rng.choice(["user:alice", "user:alice", "user:carol", "user:bob"]),
                "response": {"document_ids": rng.choice([["DOC-LATE-40002"], ["DOC-W9-10042"], 7])}}
    pending = [i for i in e.store.intents("acme", rid) if i["status"] in ("DISPATCHING", "UNKNOWN_EFFECT")]
    choices = ["run"] * 6 + ["advance"] * 6 + ["clock", "clock", "inject", "inject", "arm", "restart", "cancel",
                                                "effect", "effect", "metrics", "inspect", "unresolved", "evidence"]
    if rng.random() < 0.3:
        choices.append("revoke_cap")
    if pending:
        choices += ["resolve"] * 3
    if "erp_draft_id" in cp.variables:
        choices += ["erp_modify", "erp_tamper"]
    if rng.random() < 0.02:
        choices.append("revoke")
    k = rng.choice(choices)
    if k == "run":
        return {"op": "run", "run": name, **({"worker": rng.choice(["worker-1", "worker-2"])} if rng.random() < 0.3 else {})}
    if k == "advance":
        op = {"op": "advance", "run": name}
        if rng.random() < 0.3:
            op["worker"] = rng.choice(["worker-1", "worker-2", "worker-3"])
        if rng.random() < 0.1:
            op["expected_revision"] = rng.choice([cp.revision, cp.revision + 1])
        return op
    if k == "clock":
        return {"op": "clock", "s": rng.choice([1, 11, 301, 1000, 86401, 0.5])}
    if k == "inject":
        return {"op": "inject", "fault": rng.choice(["timeout_after_commit", "timeout_before_commit", "read_unavailable"])}
    if k == "arm":
        return {"op": "arm", "point": rng.choice(["after_intent", "before_dispatch", "after_remote_call", "after_receipt",
                                                  "before_commit"])}
    if k == "restart":
        return {"op": "restart", **({"model": rng.choice(MODELS)} if rng.random() < 0.3 else {})}
    if k == "cancel":
        return {"op": "cancel", "run": name, "as": rng.choice(["user:alice", "user:bob", "user:carol"]),
                **({"worker": "worker-1"} if rng.random() < 0.3 else {})}
    if k == "effect":
        return {"op": "effect", "tool": "erp.create_draft",
                "effect": rng.choice(["non_idempotent_write", "idempotent_write", "reconciliable_write"])}
    if k == "revoke_cap":
        return {"op": "revoke_cap", "pid": rng.choice(["user:carol", "user:alice"]),
                "cap": rng.choice(["documents:read", "erp:draft:create", "erp:draft:read"])}
    if k == "metrics":
        return {"op": "metrics", **({"run": name} if rng.random() < 0.5 else {})}
    if k in ("inspect", "unresolved", "evidence"):
        return {"op": k, "run": name, **({"as": rng.choice(WHO)} if k == "inspect" else {})}
    if k == "resolve":
        it = rng.choice(pending)
        op = {"op": "resolve", "run": name, "lid": it["logical_action_id"], "outcome": rng.choice(["present", "absent", "absent"]),
              "as": rng.choice(["user:bob", "user:bob", "user:alice"])}
        if op["outcome"] == "present":
            op["output"] = rng.choice([{"status": "created", "draft_id": "D-0001", "version": 1}, {"status": "x"}])
        return op
    if k in ("erp_modify", "erp_tamper"):
        return {"op": k, "run": name, "changes": rng.choice([{"tax_id": "DE999999999"}, {"legal_name": "Other GmbH"}])}
    if k == "revoke":
        return {"op": "revoke", "as": rng.choice(["user:dana", "user:alice"])}
    raise AssertionError(k)


def exec_op(ctx: Ctx, op: dict, digest_only: bool) -> dict:
    """Random scenarios store digests of results and snapshots (plus the status, for readable failures)."""
    entry = {}
    try:
        res, run, take = do(ctx, op)
        res = ints(res)
        if digest_only and not FULL:
            entry["result_digest"] = digest(res)
            if isinstance(res, dict) and "status" in res:
                entry["status"] = res["status"]
        else:
            entry["result"] = res
    except (Exception, SimulatedCrash) as exc:  # noqa: BLE001
        entry["error"] = enc_error(exc)
        run, take = op.get("run"), True
    if take and ctx.env is not None:
        sn = snap(ctx, run if run is not None else op.get("run"))
        if digest_only and not FULL:
            entry["snap_digest"] = digest(sn)
        else:
            entry["snap"] = sn
    return entry


def run_random(name: str, seed: int, n_ops: int) -> dict:
    import random
    rng = random.Random(seed)
    with tempfile.TemporaryDirectory() as tmp, seq_uuids():
        ctx = Ctx(Path(tmp))
        ops = [{"op": "env", "dir": "state", **({"model": rng.choice(MODELS)} if rng.random() < 0.4 else {})},
               {"op": "start", "run": "r1", "task": rng.choice(TASKS)}]
        transcript = [exec_op(ctx, op, True) for op in ops]
        for _ in range(n_ops):
            op = choose(ctx, rng)
            ops.append(op)
            transcript.append(exec_op(ctx, op, True))
        return {"name": name, "ops": ops, "transcript": transcript, "random": True}


def utc_errors():
    """``datetime.fromtimestamp`` range errors (admit's ``admitted_at``)."""
    from datetime import datetime, timezone
    out = []
    for t in (253402300800, 253402300799.9999996, 253402300800.5, -62135596800.5, -62135596801, 8.64e12 + 0.5,
              -1e13 + 0.5, 6.7e16 + 0.5, -6.7e16 + 0.5, 6.8e16 + 0.5, -6.8e16 + 0.5, 1e17 + 0.5, 9.2e18 + 0.5,
              9.3e18 + 0.5, -9.3e18 + 0.5, 1e300 + 0.5, 9223372036854774784.0, 2.0 ** 63, -(2.0 ** 63),
              -9223372036854777856.0):
        try:
            datetime.fromtimestamp(t, timezone.utc)
            raise AssertionError(t)
        except (ValueError, OSError, OverflowError) as exc:
            out.append([repr(t), type(exc).__name__, str(exc)])  # repr: integral floats cannot be stored
    return out


def schema_order_vectors():
    """``validate_against`` error order (schema keyword order, stable sort by path, sorted extras). Schemas and
    values are JSON text so their key order survives the sorted-key golden file."""
    from hexis_service.tools.catalog import validate_against
    S = [
        ({"additionalProperties": False, "required": ["a", "b"], "type": "object",
          "properties": {"z": {"type": "string", "minLength": 2}, "a": {"enum": [1, 2]}}},
         [{"z": 1, "q": 1, "\u00fc": 2, "A": 3}, {"y": 1}, {"b": 1, "a": 5, "z": "x", "10": 0, "9": 0}, 7]),
        ({"properties": {"b": {"type": "integer", "maximum": 3}, "a": {"type": "string"}}, "required": ["c"],
          "additionalProperties": {"type": "string", "maxLength": 1}, "minProperties_absent": None},
         [{"a": 1, "b": 9, "x": 1, "w": "long", "c": 0}, {"x": "ok", "b": 4.5}]),
        ({"type": "array", "items": {"type": "object", "required": ["id"], "additionalProperties": False,
                                     "properties": {"id": {"type": "string", "pattern": "^D-"}}},
          "minItems": 1, "maxItems": 2},
         [[{"id": "x", "k": 1}, {}, {"id": 3}], [], [{"id": "D-1"}]]),
        ({"allOf": [{"required": ["b"]}, {"properties": {"a": {"const": 1}}}], "required": ["a"],
          "anyOf": [{"type": "object", "required": ["z"]}, {"type": "string"}],
          "properties": {"a": {"type": "integer", "minimum": 2}}},
         [{"a": 0}, {"a": 1, "b": 1, "z": 1}, "s"]),
        ({"patternProperties": {"^x": {"type": "integer"}, "y$": {"type": "string"}},
          "additionalProperties": {"type": "integer"}, "properties": {"xy": {"minimum": 5}}},
         [{"xy": 1, "xay": "s", "ay": 1, "b": 0, "x1": "n"}]),
        ({"type": ["object", "null"], "not": {"required": ["bad"]}, "oneOf": [{"required": ["p"]}, {"type": "object", "required": ["q"]}],
          "properties": {"p": {"type": "boolean"}, "q": {"uniqueItems": True}}},
         [{"bad": 1, "p": 1}, {"bad": 1, "q": [1, 1]}, {"bad": 1}, None, {"p": True}]),
    ]
    # (messages outside the shared subset, e.g. oneOf matching twice or patternProperties with
    # additionalProperties false, differ in HX.jsonschema and are left out here)
    out = []
    for schema, values in S:
        schema = {k: v for k, v in schema.items() if v is not None}
        for v in values:
            out.append([json.dumps(schema, ensure_ascii=False), json.dumps(v, ensure_ascii=False),
                        validate_against(schema, v)])
    return out


def fsum_vectors():
    """Python 3.12 ``sum()`` (compensated) over float lists, as the metrics and TIMING totals use it."""
    import random
    rng = random.Random(4242)
    cases = [[0.1] * 6, [0.1] * 10, [1e100, 1.0, -1e100, 1.0], [0.125 * n for n in range(1, 9)],
             [12345.678 + 0.1 * n - (12345.678 + 0.1 * (n - 1)) for n in range(1, 30)], [-0.0, -0.0], [1.5, -1.5],
             [1e308, 1e308, -1e308], [0.7, 0.1, 0.2, -0.3]]
    for _ in range(300):
        n = rng.randint(1, 25)
        kind = rng.random()
        if kind < 0.4:
            xs = [rng.random() * 10 ** rng.randint(-3, 3) for _ in range(n)]
        elif kind < 0.7:
            xs = [round(rng.uniform(-1000, 1000), rng.randint(0, 6)) for _ in range(n)]
        else:
            xs = [rng.choice([0.1, 0.2, 0.3, 1e16, -1e16, 3.0000001, 1e-7, 2.5]) for _ in range(n)]
        cases.append(xs)
    out = []
    for xs in cases:
        out.append([[repr(x) for x in xs], repr(sum(xs))])  # repr: integral floats cannot be stored
    return out


def main():
    index, files, cur, size = [], [], [], 0
    todo = [(name, lambda n=name, o=ops: run_scenario(n, o)) for name, ops in SCENARIOS.items()]
    todo += [(f"random_{i:02d}", lambda i=i: run_random(f"random_{i:02d}", 7100 + i, 45)) for i in range(N_RANDOM)]
    for name, fn in todo:
        sc = fn()
        text = json.dumps(sc)
        index.append({"name": name, "file": None, "ops": len(sc["ops"])})
        if cur and size + len(text) > (1_300_000 if not FULL else 10**12):
            files.append(cur)
            cur, size = [], 0
        cur.append(sc)
        size += len(text)
    if cur:
        files.append(cur)
    k = 0
    for i, scs in enumerate(files, 1):
        write(f"runtime_{i}", {"scenarios": scs})
        for sc in scs:
            index[k]["file"] = f"runtime_{i}"
            k += 1
    hashes = {n: p.artifact_hash for n, p in PKGS.items()}
    write("runtime", {"index": index, "hashes": hashes, "refined_json": json.dumps(REFINED.to_json(), ensure_ascii=False),
                      "dev_trace": DEV.to_jsonl(),
                      "unsealed_hash": PKGS["unsealed"].artifact_hash,
                      "utc": [[t, __import__("datetime").datetime.fromtimestamp(t, __import__("datetime").timezone.utc)
                               .isoformat()] for t in (CLOCK0, 0, 1.5, 1790000000.0000005, 1790000000.0000015,
                                                       1790000000.9999996, 1790003600.25, 946684799.5, 4102444800.125,
                                                       253402300799.99, 253402300799.999999 - 0.25, -62135596800, -62135596799.75)],
                      "utc_errors": utc_errors(), "fsum": fsum_vectors(),
                      "schema_order": schema_order_vectors()})
    for p in sorted(GOLDEN.glob("runtime_*.json")):
        if int(p.stem.split("_")[1]) > len(files):
            p.unlink()
    print(f"{len(todo)} scenarios in {len(files)} files")


if __name__ == "__main__":
    main()
