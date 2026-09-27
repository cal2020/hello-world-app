"""Durable run orchestration around the pure kernel (brief sections 7, 11, 12, 15).

Each step: load the latest checkpoint -> perform the state's action outside
any database transaction (model call, tool dispatch through the broker,
interaction creation) -> build a recorded observation -> ``kernel.apply`` ->
commit checkpoint + events + observation in one transaction, guarded by the
expected revision and the worker's fencing token.

A worker can exit while a run waits for input or approval; any later process
with the same store resumes it from the persisted checkpoint.
"""
from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass
from typing import Any

from . import canonical
from . import jsonschema_lite as JS
from . import kernel
from .authority import ApprovalService, EvidenceService, PolicyService, Principal, approval_digest
from .broker import Outcome, ToolBroker, canonical_args_digest
from .models import ModelAdapter, ModelUnavailable, StateRequest
from .package import LoadedPackage
from .registry import Registry
from .store import ConflictError, Store
from .validator import ANY_PLACEHOLDER, PLACEHOLDER


class RunError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def resolve_template(template: Any, variables: dict, reads: tuple[str, ...]) -> Any:
    """Strict placeholder resolution: every ``${var}`` must be a declared read that is set.
    Missing values raise instead of becoming None or ''."""
    if isinstance(template, str):
        m = PLACEHOLDER.match(template)
        if m:
            name = m.group(1)
            if name not in reads:
                raise kernel.InputBindingError(f"template variable {name!r} is not a declared read")
            if name not in variables:
                raise kernel.InputBindingError(f"required input {name!r} is unset")
            return copy.deepcopy(variables[name])
        if ANY_PLACEHOLDER.search(template):
            raise kernel.InputBindingError(f"partial placeholder in {template!r}")
        return template
    if isinstance(template, dict):
        return {k: resolve_template(v, variables, reads) for k, v in template.items()}
    if isinstance(template, list):
        return [resolve_template(v, variables, reads) for v in template]
    return template


def logical_action_id(run_id: str, state_id: str, revision: int, tool: str, args_digest: str, is_write: bool) -> str:
    # Writes with identical arguments in the same run and state are the same logical action;
    # a changed draft or target is a new logical intent (and needs fresh approval).
    suffix = args_digest[7:23] if is_write else f"r{revision}"
    return f"{run_id}/{state_id}/{tool}/{suffix}"


@dataclass
class Services:
    store: Store
    registry: Registry
    policy: PolicyService
    approvals: ApprovalService
    evidence: EvidenceService
    broker: ToolBroker
    model: ModelAdapter
    clock: Any = time.time


class Runtime:
    def __init__(self, services: Services):
        self.s = services
        self._pkgs: dict[str, LoadedPackage] = {}

    # ------------------------------------------------------------ helpers ---
    def pkg(self, artifact_hash: str) -> LoadedPackage:
        if artifact_hash not in self._pkgs:
            self._pkgs[artifact_hash] = self.s.registry.load(artifact_hash)
        return self._pkgs[artifact_hash]

    def _run_for(self, run_id: str, principal: Principal) -> tuple:
        run = self.s.store.get_run(principal.tenant_id, run_id)
        if run is None:  # tenant scope is server-derived: another tenant's run is simply not found
            raise RunError("NOT_FOUND", f"run {run_id} not found")
        return run

    def _commit(self, prev: dict, result: kernel.StepResult, obs: dict, token: int | None,
                extra=None) -> dict:
        with self.s.store.tx() as c:
            self.s.store.commit_checkpoint(c, prev, result.checkpoint, token, obs)
            if extra:
                extra(c)
            self.s.store.append_events(c, prev["tenant_id"], prev["run_id"], [result.event])
        return result.checkpoint

    def _obs(self, cp: dict, kind: str, **fields: Any) -> dict:
        return {"kind": kind, "run_id": cp["run_id"], "state_id": cp["state_id"], "revision": cp["revision"],
                "observed_at": self.s.clock(), **fields}

    # --------------------------------------------------------------- API ---
    def start_run(self, package_hash: str, task_input: dict, principal: Principal, request_id: str) -> dict:
        tenant = principal.tenant_id
        prior = self.s.store.dedupe_get(tenant, f"start:{request_id}")
        if prior:
            return prior
        if not principal.authenticated:
            raise RunError("UNAUTHENTICATED", "start_run requires an authenticated principal")
        lifecycle = self.s.registry.lifecycle(package_hash)
        if lifecycle != "active":
            raise RunError("NOT_ACTIVE", f"artifact {package_hash} is {lifecycle}; new runs require an active version")
        pkg = self.pkg(package_hash)
        run_id = "run-" + canonical.digest({"tenant": tenant, "request": request_id})[7:19]
        try:
            cp = kernel.initial_checkpoint(pkg, tenant, run_id, task_input)
        except kernel.InputBindingError as exc:
            raise RunError("INVALID_INPUT", str(exc)) from None
        handle = {"run_id": run_id, "artifact_hash": package_hash, "revision": 0}
        with self.s.store.tx() as c:
            self.s.store.create_run(c, cp, principal.principal_id, str(self.s.clock()))
            self.s.store.append_events(c, tenant, run_id, [{"type": "run_started", "artifact_hash": package_hash,
                                                             "principal": principal.principal_id,
                                                             "observed_at": self.s.clock(), "revision": 0}])
            self.s.store.dedupe_put(c, tenant, f"start:{request_id}", handle)
        return handle

    def run(self, run_id: str, principal: Principal, worker_id: str = "worker-1", max_steps: int = 200) -> dict:
        """Advance until the run waits, finishes, or needs reconciliation it cannot resolve."""
        self._run_for(run_id, principal)
        token = self.s.store.acquire_lease(principal.tenant_id, run_id, worker_id)
        cp = self.s.store.latest_checkpoint(principal.tenant_id, run_id)
        for _ in range(max_steps):
            if cp["status"] in kernel.FINAL or cp["status"].startswith("WAITING"):
                return cp
            before = cp["revision"]
            cp = self.advance_run(run_id, cp["revision"], principal, token)
            if cp["revision"] == before:  # no progress possible (e.g. unresolved reconciliation)
                return cp
        return cp

    def advance_run(self, run_id: str, expected_revision: int, principal: Principal, token: int) -> dict:
        run = self._run_for(run_id, principal)
        cp = self.s.store.latest_checkpoint(principal.tenant_id, run_id)
        if cp["revision"] != expected_revision:
            raise ConflictError(f"expected revision {expected_revision}, latest is {cp['revision']}")
        if cp["status"] in kernel.FINAL or cp["status"].startswith("WAITING"):
            return cp
        pkg = self.pkg(cp["artifact_hash"])
        state = pkg.machine.states[cp["state_id"]]
        kind = state.action.kind
        if self.s.registry.lifecycle(cp["artifact_hash"]) == "revoked" and cp["status"] != "RECONCILING":
            # Revocation policy: in-flight runs stop at their next step. A run with an unresolved
            # effect still reconciles first so a completed write is disclosed, never hidden.
            obs = self._obs(cp, "stop", code="ARTIFACT_REVOKED", message="pinned artifact was revoked")
            return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)
        if cp["status"] == "RECONCILING":
            return self._reconcile_step(cp, pkg, state, principal, token, run)
        if kind == "end":
            obs = self._obs(cp, "end", terminal_check=self._terminal_check(cp, pkg, principal))
            return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)
        if kind in ("model", "judge"):
            return self._model_step(cp, pkg, state, token)
        if kind == "user":
            return self._request_interaction(cp, pkg, state, token, run)
        return self._tool_step(cp, pkg, state, principal, token)

    # --------------------------------------------------------- model step ---
    def _model_step(self, cp: dict, pkg: LoadedPackage, state, token: int) -> dict:
        act = state.action
        schema = {"type": "object", "additionalProperties": False, "required": list(act.writes),
                  "properties": {w: pkg.var_schema(w) for w in act.writes}}
        inputs = {r: cp["variables"][r] for r in act.reads if r in cp["variables"]}
        repairs_allowed = pkg.policy.get("structured_output_repairs", 1)
        output, tokens, calls, feedback, error = None, 0, 0, "", ""
        for _ in range(1 + repairs_allowed):
            req = StateRequest(state.id, act.kind, act.prompt, inputs, schema, act.labels, feedback)
            calls += 1
            try:
                resp = self.s.model.generate(req)
            except ModelUnavailable as exc:
                error = f"model unavailable: {exc}"
                output = None
                break
            tokens += resp.tokens
            output = resp.output
            errs = JS.errors(output, schema, "output") if isinstance(output, dict) else ["output is not an object"]
            if act.kind == "judge" and not errs and output[act.writes[0]] not in act.labels:
                errs = [f"label {output[act.writes[0]]!r} not in {list(act.labels)}"]
            if not errs:
                break
            feedback = "; ".join(errs)
            error = feedback
        obs = self._obs(cp, act.kind, outputs=output, usage={"model_calls": calls, "tokens": tokens},
                        model_id=self.s.model.model_id, model_error=error or None)
        return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)

    # ---------------------------------------------------- interaction step ---
    def _request_interaction(self, cp: dict, pkg: LoadedPackage, state, token: int, run: tuple) -> dict:
        is_approval = "approval" in state.action.labels
        interaction_id = "int-" + canonical.digest([cp["run_id"], state.id, cp["revision"]])[7:19]
        now = self.s.clock()
        request = {"interaction_id": interaction_id, "tenant_id": cp["tenant_id"], "run_id": cp["run_id"],
                   "state_id": state.id, "revision": cp["revision"], "prompt": state.action.prompt,
                   "response_schema": {w: pkg.var_schema(w) for w in state.action.writes},
                   "shown": {r: cp["variables"].get(r) for r in state.action.reads}}
        approval = None
        if is_approval:
            conf = pkg.contracts.get("approvals", {}).get(state.id)
            if conf is None:
                raise RunError("CONTRACT", f"approval state {state.id} has no approval contract")
            target = pkg.machine.states[conf["action_state"]]
            spec = pkg.catalog[target.action.name]
            try:
                args = resolve_template(target.action.input, cp["variables"], target.action.reads)
            except kernel.InputBindingError as exc:
                obs = self._obs(cp, "stop", code="INPUT_BINDING", message=str(exc))
                return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)
            digest = canonical_args_digest(spec.name, spec.version, args)
            binding = {
                "tenant_id": cp["tenant_id"], "run_id": cp["run_id"], "interaction_id": interaction_id,
                "artifact_hash": cp["artifact_hash"],
                "logical_action_id": logical_action_id(cp["run_id"], target.id, 0, spec.name, digest, spec.is_write),
                "tool": spec.name, "tool_version": spec.version, "args_digest": digest,
                "target": {"business_unit": args.get("business_unit"), "supplier_name": args.get("supplier_name")},
                "evidence": {e: cp["variables"].get(e) for e in conf.get("evidence", [])},
                "policy_version": self.s.policy.version, "required_role": conf["required_role"],
                "expires_at": now + pkg.policy.get("approval_ttl_seconds", 86400),
            }
            approval = {**binding, "approval_digest": approval_digest(binding), "requested_by": run[3]}
            request["approval"] = approval
        obs = self._obs(cp, "interaction", interaction_id=interaction_id,
                        interaction_type="approval" if is_approval else "input")

        def extra(c):
            c.execute("INSERT OR IGNORE INTO interactions VALUES(?,?,?,?,?,?,?,?)",
                      (cp["tenant_id"], interaction_id, cp["run_id"], "approval" if is_approval else "input",
                       state.id, cp["revision"], "open", json.dumps(request, sort_keys=True)))
            if approval:
                self.s.approvals.create(c, approval)

        return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token, extra)

    def interaction(self, tenant: str, interaction_id: str) -> dict | None:
        rows = self.s.store.q("SELECT request_json, status, type FROM interactions WHERE tenant_id=? AND "
                              "interaction_id=?", (tenant, interaction_id))
        return {**json.loads(rows[0][0]), "status": rows[0][1], "type": rows[0][2]} if rows else None

    def resume_interaction(self, run_id: str, interaction_id: str, response: dict, principal: Principal,
                           request_id: str) -> dict:
        tenant = principal.tenant_id
        prior = self.s.store.dedupe_get(tenant, f"resume:{request_id}")
        if prior:
            return prior
        run = self._run_for(run_id, principal)
        cp = self.s.store.latest_checkpoint(tenant, run_id)
        if not cp["status"].startswith("WAITING") or (cp["pending"] or {}).get("interaction_id") != interaction_id:
            raise RunError("NOT_WAITING", "run is not waiting for this interaction")
        req = self.interaction(tenant, interaction_id)
        pkg = self.pkg(cp["artifact_hash"])
        state = pkg.machine.states[cp["state_id"]]
        token = self.s.store.acquire_lease(tenant, run_id, f"resume:{principal.principal_id}")
        if req["type"] == "approval":
            approval_req, _ = self.s.approvals.get(tenant, interaction_id)
            decision = response.get("decision")
            with self.s.store.tx() as c:
                effective = self.s.approvals.record_response(c, approval_req, principal, decision,
                                                             self.s.clock(), run[3])
            outputs = {state.action.writes[0]: effective}
        else:
            if not principal.authenticated:
                raise RunError("UNAUTHENTICATED", "input responses require an authenticated principal")
            outputs = response
        obs = self._obs(cp, "user", outputs=outputs, actor=principal.principal_id, interaction_id=interaction_id)

        def extra(c):
            c.execute("UPDATE interactions SET status='answered' WHERE tenant_id=? AND interaction_id=?",
                      (tenant, interaction_id))
            self.s.store.dedupe_put(c, tenant, f"resume:{request_id}", {"run_id": run_id, "revision": cp["revision"] + 1})

        return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token, extra)

    # ----------------------------------------------------------- tool step ---
    def _tool_step(self, cp: dict, pkg: LoadedPackage, state, principal: Principal, token: int) -> dict:
        act = state.action
        spec = pkg.catalog[act.name]
        intent = self.s.store.get_intent_for_visit(cp["tenant_id"], cp["run_id"], state.id, cp["revision"])
        if intent is None:
            try:
                args = resolve_template(act.input, cp["variables"], act.reads)
            except kernel.InputBindingError as exc:
                obs = self._obs(cp, "stop", code="INPUT_BINDING", message=str(exc))
                return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)
            errs = JS.errors(args, spec.input_schema, f"{spec.name}.input")
            if errs:
                obs = self._obs(cp, "stop", code="TOOL_INPUT_INVALID", message="; ".join(errs))
                return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)
            digest = canonical_args_digest(spec.name, spec.version, args)
            lid = logical_action_id(cp["run_id"], state.id, cp["revision"], spec.name, digest, spec.is_write)
            existing = self.s.store.get_intent(cp["tenant_id"], lid)
            if existing is None:
                intent = {"tenant_id": cp["tenant_id"], "logical_action_id": lid, "run_id": cp["run_id"],
                          "state_id": state.id, "revision": cp["revision"], "tool": spec.name,
                          "tool_version": spec.version, "args_digest": digest, "args": args,
                          "idempotency_key": "idem-" + canonical.digest(lid)[7:39],
                          "business_reference": "bref-" + canonical.digest([cp["tenant_id"], lid])[7:31]}
                self.s.store.insert_intent(intent)
                intent = self.s.store.get_intent(cp["tenant_id"], lid)
            else:
                intent = existing
            self.s.broker._crash("after_intent")
        approval_evidence = None
        for conf in pkg.contracts.get("approvals", {}).values():
            if conf["action_state"] == state.id:
                approval_evidence = {e: cp["variables"].get(e) for e in conf.get("evidence", [])}
        outcome = self.s.broker.dispatch(pkg, intent, principal, token, approval_evidence)
        return self._commit_tool(cp, pkg, intent, outcome, token)

    def _commit_tool(self, cp: dict, pkg: LoadedPackage, intent: dict, outcome: Outcome, token: int) -> dict:
        obs = self._obs(cp, "tool", tool=intent["tool"], action_id=intent["logical_action_id"],
                        certainty=outcome.certainty, result=outcome.result, reason=outcome.reason,
                        receipt_id=outcome.receipt_id, evidence_receipts=outcome.evidence_receipts,
                        usage={"tool_calls": 1})
        return self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)

    def _reconcile_step(self, cp: dict, pkg: LoadedPackage, state, principal: Principal, token: int, run) -> dict:
        unresolved = cp["assurance"]["unresolved_effects"]
        if not unresolved:
            raise RunError("RECONCILE", "RECONCILING without an unresolved action")
        intent = self.s.store.get_intent(cp["tenant_id"], unresolved[0])
        outcome = self.s.broker.reconcile(pkg, intent)
        if outcome is None:  # proven absent: resend with the same idempotency key
            outcome = self.s.broker.dispatch(pkg, intent, principal, token,
                                             {e: cp["variables"].get(e) for conf in pkg.contracts.get("approvals", {}).values()
                                              if conf["action_state"] == state.id for e in conf.get("evidence", [])})
        if outcome.certainty == "unknown_effect":
            return cp  # stays RECONCILING; needs manual resolution
        return self._commit_tool(cp, pkg, intent, outcome, token)

    # ------------------------------------------------------ terminal check ---
    def _terminal_check(self, cp: dict, pkg: LoadedPackage, principal: Principal) -> dict:
        state = pkg.machine.states[cp["state_id"]]
        term = pkg.machine.terminal(state.action.terminal)
        evidence = []
        for rid in cp["evidence"]:
            got = self.s.evidence.get(cp["tenant_id"], rid)
            if not got:
                continue
            rec, invalidated = got
            valid, why = invalidated is None, invalidated or ""
            if valid:
                current = self.s.broker.read_current(pkg, cp["tenant_id"], rec["subject"]["draft_ref"], principal)
                if current is None:
                    valid, why = False, "subject no longer readable"
                elif current["version"] != rec["subject"]["version"] or \
                        current["payload_hash"] != rec["subject"]["payload_hash"]:
                    valid, why = False, (f"subject changed since verification (version {rec['subject']['version']} "
                                         f"-> {current['version']})")
                if not valid:
                    self.s.evidence.invalidate(cp["tenant_id"], rid, why)
            evidence.append({"receipt_id": rid, "verifier": rec["verifier"], "valid": valid, "reason": why,
                             "subject": rec["subject"]})
        unresolved = [i["logical_action_id"] for i in self.s.store.run_intents(cp["tenant_id"], cp["run_id"])
                      if i["status"] in ("dispatching", "unknown_effect")]
        scope = None
        if term.kind == "verified":
            claim = pkg.contracts.get("terminals", {}).get(term.id, {}).get("claim", "")
            scope = {"claim": claim, "subjects": [e["subject"] for e in evidence if e["valid"]]}
        return {"evidence": evidence, "unresolved_effects": unresolved, "scope": scope}

    # ------------------------------------------------------------- cancel ---
    def cancel_run(self, run_id: str, expected_revision: int, principal: Principal) -> dict:
        self._run_for(run_id, principal)
        cp = self.s.store.latest_checkpoint(principal.tenant_id, run_id)
        if cp["revision"] != expected_revision:
            raise ConflictError(f"expected revision {expected_revision}, latest is {cp['revision']}")
        if cp["status"] in kernel.FINAL:
            return {"cancelled": False, "status": cp["status"]}
        token = self.s.store.acquire_lease(principal.tenant_id, run_id, f"cancel:{principal.principal_id}")
        pkg = self.pkg(cp["artifact_hash"])
        disclosed = []
        for intent in self.s.store.run_intents(principal.tenant_id, run_id):
            if intent["status"] in ("dispatching", "unknown_effect"):
                rec = self.s.broker.reconcile(pkg, intent)
                if rec is not None and rec.certainty == "certain":
                    disclosed.append({"action": intent["logical_action_id"], "effect": "completed",
                                      "external_ref": rec.result.get("draft_ref")})
                else:
                    disclosed.append({"action": intent["logical_action_id"],
                                      "effect": "not_found" if rec is None else "unknown"})
            elif intent["status"] == "committed" and pkg.catalog[intent["tool"]].is_write:
                disclosed.append({"action": intent["logical_action_id"], "effect": "completed",
                                  "external_ref": intent["external_ref"]})
        unresolved = [d for d in disclosed if d["effect"] == "unknown"]
        obs = self._obs(cp, "cancel", disclosed_effects=disclosed)
        new = self._commit(cp, kernel.apply(cp, obs, pkg), obs, token)
        return {"cancelled": True, "safely_cancelled": not unresolved, "disclosed_effects": disclosed,
                "revision": new["revision"]}

    # ------------------------------------------------------------ inspect ---
    def inspect_run(self, run_id: str, principal: Principal) -> dict:
        run = self._run_for(run_id, principal)
        tenant = principal.tenant_id
        cp = self.s.store.latest_checkpoint(tenant, run_id)
        intents = self.s.store.run_intents(tenant, run_id)
        return {
            "run_id": run_id, "tenant_id": tenant, "artifact_hash": run[2], "status": cp["status"],
            "outcome": cp["outcome"], "diagnostic": cp["diagnostic"], "assurance": cp["assurance"],
            "state_id": cp["state_id"], "revision": cp["revision"], "budget": cp["budget"],
            "cost": "unknown (fixture mode; no priced model calls)",
            "events": self.s.store.events(tenant, run_id),
            "actions": [{**{k: i[k] for k in ("logical_action_id", "state_id", "tool", "tool_version", "args_digest",
                                              "status", "attempts", "external_ref", "idempotency_key")},
                         "receipts": [{k: r[k] for k in ("receipt_id", "dispatch_state", "certainty", "reason")}
                                      for r in self.s.store.receipts(tenant, i["logical_action_id"])]}
                        for i in intents],
            "evidence": self.s.evidence.for_run(tenant, run_id),
            "approvals": [self.s.approvals.get(tenant, e["interaction_id"])
                          for e in self.s.store.events(tenant, run_id)
                          if e.get("type") == "interaction_requested" and e.get("interaction_type") == "approval"],
        }
