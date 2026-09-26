"""Run orchestration (brief §7.1, §11, §12, §15).

``advance_run`` executes exactly one persisted step: it claims a lease (fencing token), prepares the
state's action, records intent / interaction durably, dispatches through the broker, and commits the
kernel's transition + events + observation in one transaction. No DB transaction is held across a
model call, a human wait or a remote tool call. The pure reducer (:func:`kernel.advance`) remains
separately callable for conformance and recorded replay.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from ..approvals.scope import approval_scope, idempotency_key, logical_action_id, scope_digest
from ..artifacts.package import MachinePackage
from ..artifacts.validate import template_vars
from ..canonical import digest
from ..evidence.receipts import evidence_scope, is_current, subject_of, valid_positive
from ..models.base import ModelAdapter, ModelRequest, ModelUnavailable, output_schema_for
from ..storage.sqlite import ConflictError, Store
from ..tools.broker import FaultInjector, ToolBroker
from ..tools.catalog import ToolCatalog, validate_against
from ..tools.policy import PolicyService, Principal
from . import kernel as K
from .kernel import KernelError, Observation, RunCheckpoint


class RunError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


@dataclass
class RunHandle:
    run_id: str
    tenant_id: str
    artifact_hash: str
    status: str
    revision: int


@dataclass
class StepResult:
    checkpoint: RunCheckpoint
    status: str
    detail: str = ""
    interaction: Optional[dict] = None


@dataclass
class CancellationResult:
    status: str
    disclosed_effects: list[dict] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)


class RunService:
    def __init__(self, store: Store, catalog: ToolCatalog, policy: PolicyService, broker: ToolBroker,
                 model: ModelAdapter, *, clock: Callable[[], float] = time.time, environment: str = "sandbox",
                 faults: Optional[FaultInjector] = None,
                 freshness: Optional[dict[str, Callable[..., tuple[bool, str]]]] = None, lease_ttl: float = 300.0):
        self.store, self.catalog, self.policy, self.broker, self.model = store, catalog, policy, broker, model
        self.clock, self.environment, self.lease_ttl = clock, environment, lease_ttl
        self.faults = faults or broker.faults
        self.freshness = freshness or {}
        self._packages: dict[str, MachinePackage] = {}

    # ------------------------------------------------------------------------------------- #
    def package(self, artifact_hash: str) -> MachinePackage:
        if artifact_hash not in self._packages:
            data = self.store.get_version(artifact_hash)
            if data is None:
                raise RunError("UNKNOWN_ARTIFACT", artifact_hash)
            pkg = MachinePackage.from_json(data)
            if not pkg.verify_hash():
                raise RunError("ARTIFACT_TAMPERED", artifact_hash)
            self._packages[artifact_hash] = pkg
        return self._packages[artifact_hash]

    def _run(self, run_id: str, principal: Principal) -> dict:
        run = self.store.get_run(principal.tenant_id, run_id)  # tenant from host principal, never from input
        if run is None:
            raise RunError("NOT_FOUND", f"run {run_id} not found for tenant")
        return run

    def _cp(self, tenant: str, run_id: str) -> RunCheckpoint:
        return RunCheckpoint.model_validate(self.store.latest_checkpoint(tenant, run_id))

    # ------------------------------------------------------------------------------------- #
    def start_run(self, package_hash: str, task_input: dict, principal: Principal,
                  request_id: str = "") -> RunHandle:
        if request_id:
            existing = self.store.run_by_request(principal.tenant_id, request_id)
            if existing:
                cp = self._cp(principal.tenant_id, existing)
                return RunHandle(existing, principal.tenant_id, cp.artifact_hash,
                                 self.store.get_run(principal.tenant_id, existing)["status"], cp.revision)
        pkg = self.package(package_hash)
        if self.store.is_revoked(package_hash):
            raise RunError("ARTIFACT_REVOKED", "revoked artifacts cannot start new runs")
        if not self.store.is_admitted(package_hash):
            raise RunError("ARTIFACT_NOT_ADMITTED", "only admitted artifacts can run")
        run_id = "run_" + uuid.uuid4().hex[:16]
        try:
            cp = K.initial_checkpoint(pkg, principal.tenant_id, run_id, task_input)
        except KernelError as exc:
            raise RunError(exc.code, exc.message) from exc
        created = self.store.create_run(principal.tenant_id, run_id, package_hash, principal.id, request_id,
                                        cp.model_dump(mode="json"),
                                        [{"type": "RUN_CREATED", "artifact_hash": package_hash, "principal": principal.id,
                                          "task_input_digest": digest(task_input), "checkpoint_digest": cp.digest()}],
                                        self.clock())
        if not created:  # lost a race on the same request id
            return self.start_run(package_hash, task_input, principal, request_id)
        return RunHandle(run_id, principal.tenant_id, package_hash, cp.status, cp.revision)

    # ------------------------------------------------------------------------------------- #
    def advance_run(self, run_id: str, principal: Principal, expected_revision: Optional[int] = None,
                    worker_id: str = "worker-1") -> StepResult:
        run = self._run(run_id, principal)
        tenant = run["tenant_id"]
        cp = self._cp(tenant, run_id)
        if expected_revision is not None and cp.revision != expected_revision:
            raise RunError("REVISION_CONFLICT", f"expected {expected_revision}, current {cp.revision}")
        if cp.status in K.TERMINAL_STATUSES or run["status"] in ("CANCELLED",):
            return StepResult(cp, run["status"], "run finished")
        token = self.store.acquire_lease(tenant, run_id, worker_id, self.clock(), self.lease_ttl)
        if token is None:
            raise RunError("LEASE_HELD", "another worker owns this run")
        pkg = self.package(cp.artifact_hash)
        initiator = self.policy.authenticate(run["principal"])
        if run["cancel_requested"]:
            return self._finish_cancel(run, cp, pkg, initiator, token)
        if self.store.is_revoked(cp.artifact_hash):
            unresolved = self._unresolved(tenant, run_id)
            if not unresolved:
                return self._stop(run, cp, token, "CANCELLED", "ARTIFACT_REVOKED",
                                  "artifact revoked; in-flight policy stops before further dispatch")
        st = pkg.machine.states[cp.state_id]
        kind = st.action.kind
        try:
            if kind == "tool":
                obs = self._tool_step(run, cp, pkg, initiator, token)
            elif kind in ("model", "judge"):
                obs = self._model_step(run, cp, pkg)
            elif kind == "user":
                obs = self._user_step(run, cp, pkg)
            else:
                obs = self._end_step(run, cp, pkg, initiator, token)
        except _Paused as p:
            return StepResult(self._cp(tenant, run_id), p.status, p.detail, p.interaction)
        except KernelError as exc:
            return self._stop(run, cp, token, "FAILED", exc.code, exc.message)
        return self._commit(run, cp, pkg, obs, token)

    def run_until_blocked(self, run_id: str, principal: Principal, worker_id: str = "worker-1",
                          max_steps: int = 200) -> StepResult:
        res = None
        for _ in range(max_steps):
            res = self.advance_run(run_id, principal, worker_id=worker_id)
            if res.status != "RUNNING":
                return res
        assert res is not None
        return res

    # ------------------------------------------------------------------------------------- #
    def _commit(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage, obs: Observation, token: int) -> StepResult:
        try:
            result = K.advance(cp, obs, pkg)
        except KernelError as exc:
            # Observation rejected after the fact (e.g. tool output violates the variable contract): the raw
            # observation and receipts are already stored; stop explicitly instead of erasing them.
            self.store.append_events(run["tenant_id"], run["run_id"],
                                     [{"type": "OBSERVATION_REJECTED", "code": exc.code, "message": exc.message,
                                       "observation": obs.model_dump(mode="json")}], self.clock())
            return self._stop(run, cp, token, "FAILED", exc.code, exc.message)
        events = [{"type": "OBSERVATION", "observation": obs.model_dump(mode="json")}] + result.events
        self.faults.hit("before_commit")
        try:
            self.store.commit_transition(run["tenant_id"], run["run_id"], cp.revision, token,
                                         result.checkpoint.model_dump(mode="json"), events, self.clock())
        except ConflictError as exc:
            raise RunError(str(exc).split(":")[0], str(exc)) from exc
        self._invalidate_stale_evidence(run["tenant_id"], run["run_id"], result.checkpoint)
        status = result.checkpoint.status
        return StepResult(result.checkpoint, status, result.edge["to"] if result.edge else status)

    def _stop(self, run: dict, cp: RunCheckpoint, token: Optional[int], status: str, code: str,
              message: str) -> StepResult:
        a = cp.assurance.model_copy(deep=True)
        a.diagnostics.append({"code": code, "message": message, "state": cp.state_id, "revision": cp.revision})
        if code.startswith("POLICY") or code in ("APPROVAL_INVALID", "BROKER_DENIED"):
            a.policy_violations.append(message)
        a.unresolved_effects = self._unresolved(run["tenant_id"], run["run_id"])
        new = cp.model_copy(update={"status": status, "assurance": a, "revision": cp.revision + 1})
        self.store.commit_transition(run["tenant_id"], run["run_id"], cp.revision, token, new.model_dump(mode="json"),
                                     [{"type": "RUN_STOPPED", "status": status, "code": code, "message": message,
                                       "state": cp.state_id}], self.clock())
        return StepResult(new, status, f"{code}: {message}")

    def _pause(self, run: dict, cp: RunCheckpoint, status: str, detail: str, event: dict,
               interaction: Optional[dict] = None) -> None:
        self.store.append_events(run["tenant_id"], run["run_id"], [event], self.clock())
        self.store.set_run_status(run["tenant_id"], run["run_id"], status)
        raise _Paused(status, detail, interaction)

    def _unresolved(self, tenant: str, run_id: str) -> list[str]:
        return [f"{i['logical_action_id']}:{i['tool']}:{i['status']}" for i in self.store.intents(tenant, run_id)
                if i["status"] in ("DISPATCHING", "UNKNOWN_EFFECT")
                and self.catalog.get(i["tool"]) is not None and self.catalog.get(i["tool"]).is_write]

    # ---- tool ---------------------------------------------------------------------------- #
    def _prepare_tool(self, cp: RunCheckpoint, pkg: MachinePackage, state_id: str, revision: int) -> dict:
        st = pkg.machine.states[state_id]
        spec = self.catalog.get(st.action.name)
        if spec is None:
            raise KernelError("UNKNOWN_TOOL", st.action.name)
        args = K.fill_template(st.action.input, cp.variables)
        errs = validate_against(spec.input_schema, args)
        if errs:
            raise KernelError("TOOL_INPUT_INVALID", "; ".join(errs[:3]), {"errors": errs})
        ad = digest(args)
        lid = logical_action_id(cp.run_id, state_id, revision, ad)
        return {"args": args, "args_digest": ad, "lid": lid, "idem": idempotency_key(cp.tenant_id, lid), "spec": spec}

    def _approval_check(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage, intent: dict
                        ) -> Callable[[], tuple[bool, str]]:
        def check() -> tuple[bool, str]:
            tenant = run["tenant_id"]
            approvals = [(sid, ic) for sid, ic in pkg.contracts.interactions.items()
                         if ic.type == "approval" and ic.approves_state == intent["state_id"]]
            if not approvals:
                return False, "no approval interaction governs this action"
            ixs = [i for i in (self.store.interaction_for_revision(tenant, run["run_id"], r)
                               for r in range(cp.revision)) if i and i["type"] == "approval"
                   and i["state_id"] in {s for s, _ in approvals}]
            if not ixs:
                return False, "no approval recorded"
            ix = ixs[-1]
            resp = self.store.response(tenant, ix["interaction_id"])
            if resp is None or resp["response"].get(_decision_var(pkg, ix["state_id"])) != "approved":
                return False, "latest approval is not an approval decision"
            if ix["expires_at"] is not None and self.clock() > ix["expires_at"]:
                return False, "approval expired"
            ic = pkg.contracts.interactions[ix["state_id"]]
            approver = Principal(id=resp["responder"], tenant_id=tenant,
                                 roles=tuple(self.policy.doc.principals.get(resp["responder"], {}).get("roles", [])))
            d = self.policy.can_approve(approver, run["principal"], tenant, ic.required_role)
            if not d.allowed:
                return False, "approver no longer authorized: " + "; ".join(d.reasons)
            spec = self.catalog.get(intent["tool"])
            current = approval_scope(
                tenant_id=tenant, run_id=run["run_id"], interaction_id=ix["interaction_id"],
                artifact_hash=cp.artifact_hash, lid=intent["logical_action_id"], tool=intent["tool"],
                tool_version=intent["tool_version"], args_digest=intent["args_digest"],
                business_reference=intent["args"].get(spec.business_reference_field) if spec else None,
                evidence=evidence_scope(self.store.evidence(tenant, run["run_id"]), cp.variables),
                policy_version=self.policy.version, required_role=ic.required_role, expires_at=ix["expires_at"])
            if scope_digest(current) != ix["scope_digest"] or resp["scope_digest"] != ix["scope_digest"]:
                diff = sorted(k for k in current if current[k] != ix["scope"].get(k))
                return False, f"approval scope changed: {diff}"
            return True, ""
        return check

    def _tool_step(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage, initiator: Principal,
                   token: int) -> Observation:
        tenant = run["tenant_id"]
        intent = self.store.intent_for_revision(tenant, run["run_id"], cp.revision)
        if intent is None:
            prep = self._prepare_tool(cp, pkg, cp.state_id, cp.revision)
            intent = self.store.create_intent(tenant, run["run_id"], prep["lid"], cp.state_id, cp.revision,
                                              prep["spec"].name, prep["spec"].version, prep["args"],
                                              prep["args_digest"], prep["idem"], token, self.clock())
            self.faults.hit("after_intent")
        spec = self.catalog.get(intent["tool"])
        st = pkg.machine.states[cp.state_id]
        subject = {r: cp.variables[r] for r in sorted(set(st.action.reads) | template_vars(st.action.input))
                   if r in cp.variables}
        res = self.broker.dispatch(intent=intent, principal=initiator, package=pkg,
                                   business_unit=cp.variables.get("business_unit"),
                                   approval_check=self._approval_check(run, cp, pkg, intent), lease_token=token,
                                   subject_values=subject, transport_retries=pkg.execution_policy.transport_retries)
        if res.status == "UNKNOWN_EFFECT":
            self.store.append_events(tenant, run["run_id"], [{"type": "EFFECT_UNKNOWN", "logical_action_id":
                                                              intent["logical_action_id"], "reason": res.reason}],
                                     self.clock())
            self.store.set_run_status(tenant, run["run_id"], "RECONCILING")
            res = self.broker.reconcile(intent=self.store.intent_for_revision(tenant, run["run_id"], cp.revision),
                                        principal=initiator, package=pkg,
                                        business_unit=cp.variables.get("business_unit"),
                                        approval_check=self._approval_check(run, cp, pkg, intent), lease_token=token,
                                        subject_values=subject, transport_retries=pkg.execution_policy.transport_retries)
            self.store.append_events(tenant, run["run_id"], [{"type": "RECONCILED", "logical_action_id":
                                                              intent["logical_action_id"], "status": res.status,
                                                              "certainty": res.certainty, "reason": res.reason}],
                                     self.clock())
        if res.status in ("UNKNOWN_EFFECT", "NEEDS_RESOLUTION"):
            self._pause(run, cp, "RECONCILING", res.reason, {"type": "RECONCILIATION_REQUIRED",
                                                             "logical_action_id": intent["logical_action_id"],
                                                             "reason": res.reason})
        if res.status == "DENIED":
            code = "POLICY_DENIED" if res.reason.startswith("POLICY") else res.reason.split(":")[0]
            raise KernelError(code, f"broker denied {intent['tool']}: {res.reason}")
        if res.status == "FAILED":
            return Observation(run_id=cp.run_id, state_id=cp.state_id, revision=cp.revision, kind="tool",
                               outputs={}, actor=f"tool:{spec.name}", usage={"tool_calls": 1},
                               failure=f"TOOL_FAILED: {res.reason}")
        return Observation(run_id=cp.run_id, state_id=cp.state_id, revision=cp.revision, kind="tool",
                           outputs=res.output or {}, actor=f"tool:{spec.name}@{spec.version}",
                           receipt_ref=res.receipt_ref, usage={"tool_calls": 1})

    # ---- model / judge -------------------------------------------------------------------- #
    def _model_step(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage) -> Observation:
        st = pkg.machine.states[cp.state_id]
        a = st.action
        missing = [r for r in a.reads if r not in cp.variables]
        if missing:
            raise KernelError("MISSING_READ", f"{st.id} reads unset {missing}")
        inputs = {r: cp.variables[r] for r in a.reads}
        schemas = {k: v.schema_ for k, v in pkg.contracts.variables.items()}
        req = ModelRequest(kind=a.kind, state_id=st.id, prompt=a.prompt, inputs=inputs,
                           output_schema=output_schema_for(a.writes, schemas, a.labels if a.kind == "judge" else None),
                           labels=a.labels if a.kind == "judge" else [])
        usage = {"model_calls": 0, "tokens": 0, "output_repairs": 0}
        rejected: list[dict] = []
        repairs_left = pkg.execution_policy.structured_output_repairs
        retries_left = pkg.execution_policy.transport_retries
        while True:
            try:
                resp = self.model.generate(req)
            except ModelUnavailable as exc:
                usage["model_calls"] += 1
                if retries_left > 0:
                    retries_left -= 1
                    continue
                return Observation(run_id=cp.run_id, state_id=st.id, revision=cp.revision, kind=a.kind,
                                   actor=f"model:{getattr(self.model, 'model_id', '?')}", usage=usage,
                                   failure=f"MODEL_UNAVAILABLE: {exc}")
            usage["model_calls"] += 1
            usage["tokens"] += resp.input_tokens + resp.output_tokens
            obs = Observation(run_id=cp.run_id, state_id=st.id, revision=cp.revision, kind=a.kind,
                              outputs=resp.output or {}, actor=f"model:{resp.model_id}", usage=dict(usage))
            try:
                if resp.output is None:
                    raise KernelError("UNPARSEABLE_OUTPUT", "model returned no structured output")
                K.validate_declared_outputs(pkg, st.id, obs, cp.variables)
                return obs
            except KernelError as exc:
                rejected.append({"code": exc.code, "message": exc.message, "output_digest": digest(resp.output or {})})
                self.store.append_events(run["tenant_id"], run["run_id"],
                                         [{"type": "MODEL_OUTPUT_REJECTED", "state": st.id, "code": exc.code,
                                           "message": exc.message, "keys": sorted((resp.output or {}).keys())}],
                                         self.clock())
                if repairs_left <= 0:
                    return Observation(run_id=cp.run_id, state_id=st.id, revision=cp.revision, kind=a.kind,
                                       actor=f"model:{resp.model_id}", usage=usage,
                                       failure=f"OUTPUT_INVALID: {exc.code}")
                repairs_left -= 1
                usage["output_repairs"] += 1
                req = req.model_copy(update={"repair_feedback": f"{exc.code}: {exc.message}. Return exactly the "
                                                                f"keys {a.writes} matching the output schema."})

    # ---- user ------------------------------------------------------------------------------ #
    def _approval_scope_for(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage, state_id: str,
                            interaction_id: str, expires_at: float) -> dict:
        ic = pkg.contracts.interactions[state_id]
        target_state = ic.approves_state
        # The approved action is the next visit of the approved state (revision + 1).
        prep = self._prepare_tool(cp, pkg, target_state, cp.revision + 1)
        spec = prep["spec"]
        return approval_scope(tenant_id=run["tenant_id"], run_id=run["run_id"], interaction_id=interaction_id,
                              artifact_hash=cp.artifact_hash, lid=prep["lid"], tool=spec.name,
                              tool_version=spec.version, args_digest=prep["args_digest"],
                              business_reference=prep["args"].get(spec.business_reference_field),
                              evidence=evidence_scope(self.store.evidence(run["tenant_id"], run["run_id"]),
                                                      cp.variables),
                              policy_version=self.policy.version, required_role=ic.required_role,
                              expires_at=expires_at)

    def _user_step(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage) -> Observation:
        tenant = run["tenant_id"]
        st = pkg.machine.states[cp.state_id]
        ic = pkg.contracts.interactions[st.id]
        ix = self.store.interaction_for_revision(tenant, run["run_id"], cp.revision)
        if ix is None:
            iid = "ix_" + uuid.uuid4().hex[:16]
            now = self.clock()
            expires = now + pkg.execution_policy.approval_expiry_s
            if ic.type == "approval":
                scope = self._approval_scope_for(run, cp, pkg, st.id, iid, expires)
            else:
                scope = {"tenant_id": tenant, "run_id": run["run_id"], "interaction_id": iid, "state_id": st.id,
                         "requested": list(st.action.writes), "context": {r: cp.variables.get(r)
                                                                          for r in st.action.reads}}
            ix = self.store.create_interaction(tenant, run["run_id"], iid, ic.type, st.id, cp.revision, scope,
                                               scope_digest(scope), expires if ic.type == "approval" else None, now)
        resp = self.store.response(tenant, ix["interaction_id"])
        if resp is None:
            if ix["expires_at"] is not None and self.clock() > ix["expires_at"]:
                self.store.set_interaction_status(tenant, ix["interaction_id"], "EXPIRED")
                self.store.append_events(tenant, run["run_id"], [{"type": "APPROVAL_EXPIRED",
                                                                  "interaction_id": ix["interaction_id"]}], self.clock())
                return Observation(run_id=cp.run_id, state_id=st.id, revision=cp.revision, kind="user",
                                   outputs={_decision_var(pkg, st.id): "rejected"}, actor="system:expiry",
                                   engine={"interaction_id": ix["interaction_id"], "expired": True})
            status = "WAITING_FOR_APPROVAL" if ic.type == "approval" else "WAITING_FOR_INPUT"
            self._pause(run, cp, status, f"waiting on {ix['interaction_id']}",
                        {"type": "INTERACTION_OPEN", "interaction_id": ix["interaction_id"], "kind": ic.type,
                         "scope_digest": ix["scope_digest"]}, ix)
        return Observation(run_id=cp.run_id, state_id=st.id, revision=cp.revision, kind="user",
                           outputs=resp["response"], actor=f"user:{resp['responder']}",
                           engine={"interaction_id": ix["interaction_id"], "scope_digest": resp["scope_digest"]})

    def resume_interaction(self, run_id: str, interaction_id: str, response: dict, principal: Principal,
                           request_id: str = "") -> StepResult:
        run = self._run(run_id, principal)
        tenant = run["tenant_id"]
        ix = self.store.interaction(tenant, interaction_id)
        if ix is None or ix["run_id"] != run_id:
            raise RunError("NOT_FOUND", f"interaction {interaction_id}")
        existing = self.store.response(tenant, interaction_id)
        if existing is not None:
            if request_id and existing["request_id"] == request_id:
                return StepResult(self._cp(tenant, run_id), run["status"], "duplicate response ignored")
            raise RunError("ALREADY_ANSWERED", interaction_id)
        if ix["status"] != "OPEN":
            raise RunError("INTERACTION_CLOSED", ix["status"])
        if ix["expires_at"] is not None and self.clock() > ix["expires_at"]:
            raise RunError("INTERACTION_EXPIRED", interaction_id)
        pkg = self.package(run["artifact_hash"])
        ic = pkg.contracts.interactions[ix["state_id"]]
        values = {k: v for k, v in response.items() if k != "scope_digest"}
        errs = validate_against(ic.response_schema or {"type": "object"}, values)
        if errs:
            raise RunError("RESPONSE_INVALID", "; ".join(errs[:3]))
        if ic.type == "approval":
            d = self.policy.can_approve(principal, run["principal"], tenant, ic.required_role)
            if not d.allowed:
                raise RunError("NOT_AUTHORIZED", "; ".join(d.reasons))
            if response.get("scope_digest") != ix["scope_digest"]:
                raise RunError("SCOPE_MISMATCH", "approval must reference the exact scope digest presented")
        elif principal.id != run["principal"] and self.policy.doc.approver_role not in principal.roles:
            raise RunError("NOT_AUTHORIZED", "only the requester or an approver may answer input requests")
        self.store.record_response(tenant, interaction_id, run_id, principal.id, values, ix["scope_digest"], request_id,
                                   self.clock())
        self.store.append_events(tenant, run_id, [{"type": "INTERACTION_ANSWERED", "interaction_id": interaction_id,
                                                   "responder": principal.id, "response_digest": digest(values)}],
                                 self.clock())
        self.store.set_run_status(tenant, run_id, "RUNNING")
        initiator = self.policy.authenticate(run["principal"])
        return self.advance_run(run_id, initiator)

    # ---- terminal admission ------------------------------------------------------------------ #
    def _end_step(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage, initiator: Principal,
                  token: int) -> Observation:
        tenant, run_id = run["tenant_id"], run["run_id"]
        tid = pkg.machine.states[cp.state_id].action.terminal
        tc = pkg.contracts.terminals.get(tid)
        receipts = self.store.evidence(tenant, run_id)
        missing, used = [], []
        if tc is not None and tc.category == "verified":
            for req in tc.evidence:
                ok = [r for r in valid_positive(receipts, cp.variables, req.claim) if r["verifier"] == req.verifier_tool
                      and set(req.subject_vars) <= set(r["subject"])]
                if not ok:
                    missing.append(f"{req.claim}: no current receipt from {req.verifier_tool}")
                    continue
                fresh = self.freshness.get(req.claim)
                if fresh is not None:
                    good, why = fresh(self, run, cp, pkg, initiator)
                    if not good:
                        for r in ok:
                            self.store.invalidate_evidence(tenant, r["receipt_id"], why, self.clock())
                        missing.append(f"{req.claim}: invalidated ({why})")
                        continue
                used.extend(r["receipt_id"] for r in ok)
        admission = {"evidence_valid": not missing, "missing": missing, "receipts": sorted(set(used)),
                     "unresolved_effects": self._unresolved(tenant, run_id)}
        return Observation(run_id=cp.run_id, state_id=cp.state_id, revision=cp.revision, kind="end",
                           actor="engine:terminal-admission", engine={"terminal_admission": admission})

    def _invalidate_stale_evidence(self, tenant: str, run_id: str, cp: RunCheckpoint) -> None:
        for r in self.store.evidence(tenant, run_id):
            if r["invalidated_at"] is None and not is_current(r, cp.variables):
                self.store.invalidate_evidence(tenant, r["receipt_id"], "subject variable changed", self.clock())
                self.store.append_events(tenant, run_id, [{"type": "EVIDENCE_INVALIDATED",
                                                           "receipt_id": r["receipt_id"],
                                                           "reason": "subject variable changed"}], self.clock())

    # ---- cancellation ----------------------------------------------------------------------- #
    def cancel_run(self, run_id: str, expected_revision: Optional[int], principal: Principal,
                   worker_id: str = "canceller") -> CancellationResult:
        run = self._run(run_id, principal)
        if principal.id != run["principal"] and self.policy.doc.approver_role not in principal.roles:
            raise RunError("NOT_AUTHORIZED", "only the requester or an approver may cancel")
        cp = self._cp(run["tenant_id"], run_id)
        if expected_revision is not None and cp.revision != expected_revision:
            raise RunError("REVISION_CONFLICT", f"expected {expected_revision}, current {cp.revision}")
        if cp.status in K.TERMINAL_STATUSES:
            return CancellationResult(cp.status)
        self.store.request_cancel(run["tenant_id"], run_id)  # blocks any future dispatch at the broker
        token = self.store.acquire_lease(run["tenant_id"], run_id, worker_id, self.clock(), self.lease_ttl)
        if token is None:
            return CancellationResult("CANCEL_REQUESTED", unresolved=["another worker holds the lease"])
        res = self._finish_cancel(self.store.get_run(run["tenant_id"], run_id), cp, self.package(cp.artifact_hash),
                                  self.policy.authenticate(run["principal"]), token)
        disclosed = [{"logical_action_id": r["logical_action_id"], "tool": r["tool"], "external_ref": r["external_ref"],
                      "certainty": r["certainty"]}
                     for r in self.store.receipts(run["tenant_id"], run_id=run_id)
                     if r["dispatch_state"] == "SUCCEEDED" and self.catalog.get(r["tool"]).is_write]
        return CancellationResult(res.status, disclosed, self._unresolved(run["tenant_id"], run_id))

    def _finish_cancel(self, run: dict, cp: RunCheckpoint, pkg: MachinePackage, initiator: Principal,
                       token: int) -> StepResult:
        tenant, run_id = run["tenant_id"], run["run_id"]
        for intent in self.store.intents(tenant, run_id):
            spec = self.catalog.get(intent["tool"])
            if intent["status"] in ("DISPATCHING", "UNKNOWN_EFFECT") and spec is not None and spec.is_write:
                res = self.broker.reconcile(intent=intent, principal=initiator, package=pkg,
                                            business_unit=cp.variables.get("business_unit"),
                                            approval_check=lambda: (False, "run cancelled"), lease_token=token,
                                            subject_values={})
                self.store.append_events(tenant, run_id, [{"type": "RECONCILED", "logical_action_id":
                                                           intent["logical_action_id"], "status": res.status,
                                                           "reason": res.reason, "during": "cancellation"}],
                                         self.clock())
        unresolved = self._unresolved(tenant, run_id)
        if unresolved:
            self.store.set_run_status(tenant, run_id, "RECONCILING")
            return StepResult(cp, "RECONCILING", "cancellation pending: unresolved external effects " + str(unresolved))
        effects = [r for r in self.store.receipts(tenant, run_id=run_id)
                   if r["dispatch_state"] == "SUCCEEDED" and self.catalog.get(r["tool"]).is_write]
        msg = "cancelled" + (f"; completed external effects disclosed: {[e['external_ref'] for e in effects]}"
                             if effects else "")
        return self._stop(run, cp, token, "CANCELLED", "CANCELLED", msg)

    # ---- inspection ------------------------------------------------------------------------- #
    def inspect_run(self, run_id: str, principal: Principal) -> dict:
        run = self._run(run_id, principal)
        tenant = run["tenant_id"]
        cp = self._cp(tenant, run_id)
        return {
            "run": run, "checkpoint": cp.model_dump(mode="json"), "outcome": cp.outcome,
            "assurance": cp.assurance.model_dump(mode="json"),
            "path": [e["from"] + "->" + e["to"] for e in self.store.events(tenant, run_id) if e["type"] == "TRANSITION"],
            "events": self.store.events(tenant, run_id),
            "action_intents": [{k: v for k, v in i.items() if k != "args"} for i in self.store.intents(tenant, run_id)],
            "action_receipts": self.store.receipts(tenant, run_id=run_id),
            "evidence": self.store.evidence(tenant, run_id),
        }


class _Paused(Exception):
    def __init__(self, status: str, detail: str, interaction: Optional[dict] = None):
        super().__init__(detail)
        self.status, self.detail, self.interaction = status, detail, interaction


def _decision_var(pkg: MachinePackage, state_id: str) -> str:
    w = pkg.machine.states[state_id].action.writes
    return w[0] if w else "approval_decision"


def erp_freshness(read_tool: str = "erp.read_draft") -> Callable[..., tuple[bool, str]]:
    """Terminal-time freshness check: re-read the persisted subject through the broker (read-only,
    recorded) and require the same version and payload digest as the verified receipt."""

    def check(svc: RunService, run: dict, cp: RunCheckpoint, pkg: MachinePackage,
              initiator: Principal) -> tuple[bool, str]:
        spec = svc.catalog.get(read_tool)
        args = {"draft_id": cp.variables["erp_draft_id"]}
        ad = digest(args)
        lid = logical_action_id(cp.run_id, f"{cp.state_id}#freshness", cp.revision, ad)
        tenant = run["tenant_id"]
        intent = svc.store.create_intent(tenant, run["run_id"], lid, cp.state_id, cp.revision, spec.name,
                                         spec.version, args, ad, idempotency_key(tenant, lid), None, svc.clock())
        res = svc.broker.dispatch(intent=intent, principal=initiator, package=pkg,
                                  business_unit=cp.variables.get("business_unit"), approval_check=lambda: (True, ""),
                                  lease_token=None, subject_values={})
        if res.status != "SUCCEEDED" or res.output.get("status") != "found":
            return False, "persisted draft unavailable at terminal admission"
        if res.output["version"] != cp.variables.get("persisted_version"):
            return False, f"persisted draft changed (version {cp.variables.get('persisted_version')} -> " \
                          f"{res.output['version']})"
        if digest(res.output["draft"]) != cp.variables.get("draft_digest"):
            return False, "persisted payload no longer matches approved digest"
        return True, ""

    return check


def subject_digest_values(values: dict, names: list[str]) -> dict[str, Any]:
    return subject_of(values, names)
