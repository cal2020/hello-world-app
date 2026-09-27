"""Pure transition kernel (brief section 7.1).

``advance(checkpoint, observation, package)`` performs no network access,
model calls, database writes, random sampling or clock reads. Every external
fact (tool result, model output, user response, clock reading, evidence
validity) arrives inside the recorded ``observation``. The same checkpoint and
observation always produce the same result (A30).

Semantics:
* guarded edges are evaluated in declaration order, the default edge last,
  first enabled edge wins; guards see the action's outputs and the *old*
  counter value; the chosen edge's ``inc`` is applied after selection;
* a guard error (undefined variable, type mismatch) stops the run with
  ``GUARD_ERROR``; it never falls through to the default edge (A09);
* an increment beyond the declared loop bound stops the run
  (``LOOP_BOUND_EXCEEDED``) even if the guards were wrong;
* invalid model/judge/user output goes to the fallback state, which is
  recorded permanently in the assurance metadata;
* an uncertain tool effect moves the run to ``RECONCILING`` without taking a
  transition;
* entering an end state is a request to finish: required outputs, current
  evidence and unresolved effects are checked before ``COMPLETED``.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any

from . import canonical
from . import guards as G
from . import jsonschema_lite as JS
from .package import LoadedPackage

STATUSES = ("READY", "RUNNING", "WAITING_FOR_INPUT", "WAITING_FOR_APPROVAL", "RECONCILING",
            "COMPLETED", "FAILED", "CANCELLED")
FINAL = {"COMPLETED", "FAILED", "CANCELLED"}


class KernelError(ValueError):
    """Programming or identity error: the observation does not belong to this checkpoint."""


class InputBindingError(ValueError):
    pass


@dataclass
class StepResult:
    checkpoint: dict
    event: dict


def _resolve_pointer(doc: Any, pointer: str) -> Any:
    """RFC 6901 JSON Pointer. Raises KeyError when any segment is missing."""
    if pointer == "":
        return doc
    if not pointer.startswith("/"):
        raise InputBindingError(f"selector {pointer!r} must be a JSON Pointer starting with '/'")
    cur = doc
    for raw in pointer[1:].split("/"):
        seg = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, dict):
            if seg not in cur:
                raise KeyError(pointer)
            cur = cur[seg]
        elif isinstance(cur, list):
            if not seg.isdigit() or int(seg) >= len(cur):
                raise KeyError(pointer)
            cur = cur[int(seg)]
        else:
            raise KeyError(pointer)
    return cur


def initial_checkpoint(pkg: LoadedPackage, tenant_id: str, run_id: str, task_input: dict) -> dict:
    """Build revision 0. Task-sourced variables use explicit JSON Pointer selectors
    (``contracts.variables[x].selector``); a missing or ill-typed input fails."""
    variables: dict[str, Any] = {}
    for v in pkg.machine.variables:
        vc = pkg.contracts.get("variables", {}).get(v.name, {})
        if v.init_from is not None:
            selector = vc.get("selector")
            if selector is None:
                raise InputBindingError(f"variable {v.name!r}: init_from requires an explicit selector contract")
            try:
                value = _resolve_pointer(task_input, selector)
            except KeyError:
                raise InputBindingError(f"required task input {selector!r} for {v.name!r} is missing") from None
            errs = JS.errors(value, pkg.var_schema(v.name), f"task{selector}")
            if errs:
                raise InputBindingError("; ".join(errs))
            variables[v.name] = copy.deepcopy(value)
        elif v.has_init:
            variables[v.name] = copy.deepcopy(v.init)
    limits = dict(pkg.policy.get("budgets", {}))
    return {
        "tenant_id": tenant_id, "run_id": run_id, "artifact_hash": pkg.artifact_hash,
        "state_id": pkg.machine.initial, "revision": 0, "status": "READY",
        "variables": variables, "visits": {},
        "budget": {"limits": limits, "used": {k: 0 for k in limits}},
        "evidence": [], "pending": None, "outcome": None, "diagnostic": None,
        "assurance": {"entered_fallback": False, "missing_evidence": [], "policy_violations": [],
                      "unresolved_effects": [], "verification_scope": None},
    }


def _stop(cp: dict, code: str, message: str, obs: dict, extra: dict | None = None) -> StepResult:
    out = copy.deepcopy(cp)
    out["status"] = "FAILED"
    out["diagnostic"] = {"code": code, "message": message, "state_id": cp["state_id"], **(extra or {})}
    out["revision"] = cp["revision"] + 1
    event = {"type": "stopped", "state_id": cp["state_id"], "revision": out["revision"], "code": code,
             "message": message, "observed_at": obs.get("observed_at"), "artifact_hash": cp["artifact_hash"]}
    return StepResult(out, event)


def _validate_identity(cp: dict, obs: dict, pkg: LoadedPackage) -> None:
    if cp["artifact_hash"] != pkg.artifact_hash:
        raise KernelError("checkpoint is pinned to a different artifact")
    for key in ("run_id", "state_id", "revision"):
        if obs.get(key) != cp[key]:
            raise KernelError(f"observation {key}={obs.get(key)!r} does not match checkpoint {cp[key]!r}")
    if cp["status"] in FINAL:
        raise KernelError(f"run is already {cp['status']}")


def _usage(cp: dict, obs: dict) -> dict:
    used = dict(cp["budget"]["used"])
    add = {"steps": 1, **{k: v for k, v in obs.get("usage", {}).items()}}
    for k, v in add.items():
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise KernelError(f"usage {k} must be a non-negative integer")
        used[k] = used.get(k, 0) + v
    return used


def _to_fallback(cp: dict, pkg: LoadedPackage, obs: dict, reason: str, detail: str) -> StepResult:
    out = copy.deepcopy(cp)
    out["assurance"]["entered_fallback"] = True
    out["state_id"] = pkg.machine.fallback
    out["revision"] = cp["revision"] + 1
    out["status"] = "RUNNING"
    out["pending"] = None
    out["budget"]["used"] = _usage(cp, obs)
    out["diagnostic"] = {"code": reason, "message": detail, "state_id": cp["state_id"]}
    event = {"type": "fallback", "from": cp["state_id"], "to": pkg.machine.fallback, "revision": out["revision"],
             "code": reason, "message": detail, "observed_at": obs.get("observed_at"),
             "artifact_hash": cp["artifact_hash"]}
    return StepResult(out, event)


def _finish(cp: dict, pkg: LoadedPackage, obs: dict) -> StepResult:
    state = pkg.machine.states[cp["state_id"]]
    term = pkg.machine.terminal(state.action.terminal)
    out = copy.deepcopy(cp)
    out["revision"] = cp["revision"] + 1
    missing_outputs = [o for o in term.output if o not in cp["variables"]]
    check = obs.get("terminal_check", {})
    required = pkg.contracts.get("terminals", {}).get(term.id, {}).get("required_evidence", [])
    valid = {e["verifier"] for e in check.get("evidence", []) if e.get("valid") is True}
    missing_ev = [r for r in required if r not in valid]
    unresolved = list(check.get("unresolved_effects", []))
    problems = []
    if missing_outputs:
        problems.append(f"missing outputs {missing_outputs}")
    if term.kind == "verified" and missing_ev:
        problems.append(f"no current evidence from {missing_ev}")
    if term.kind == "verified" and unresolved:
        problems.append(f"unresolved external effects {unresolved}")
    if problems:
        out["status"] = "FAILED"
        out["assurance"]["missing_evidence"] = missing_ev
        out["assurance"]["unresolved_effects"] = unresolved
        out["diagnostic"] = {"code": "TERMINAL_REJECTED", "message": "; ".join(problems), "state_id": cp["state_id"]}
        return StepResult(out, {"type": "terminal_rejected", "terminal": term.id, "revision": out["revision"],
                                "problems": problems, "observed_at": obs.get("observed_at"),
                                "artifact_hash": cp["artifact_hash"]})
    out["status"] = "COMPLETED"
    out["outcome"] = {"terminal": term.id, "kind": term.kind,
                      "outputs": {o: cp["variables"][o] for o in term.output}}
    out["assurance"]["unresolved_effects"] = unresolved
    if term.kind == "verified":
        out["assurance"]["verification_scope"] = check.get("scope")
    return StepResult(out, {"type": "terminal", "terminal": term.id, "kind": term.kind, "revision": out["revision"],
                            "observed_at": obs.get("observed_at"), "artifact_hash": cp["artifact_hash"],
                            "evidence": sorted(valid)})


def _declared_outputs(cp: dict, obs: dict, pkg: LoadedPackage) -> tuple[dict | None, str | None]:
    """Return (delta, error). Error means the action output is unusable."""
    state = pkg.machine.states[cp["state_id"]]
    act = state.action
    if act.kind == "tool":
        spec = pkg.catalog[act.name]
        result = obs.get("result")
        errs = JS.errors(result, spec.output_schema, f"{act.name}.output")
        if errs:
            return None, "; ".join(errs)
        delta = {var: copy.deepcopy(result[key]) for key, var in act.binds.items() if key in result}
    else:
        delta = obs.get("outputs")
        if not isinstance(delta, dict):
            return None, "outputs must be an object"
        extra = set(delta) - set(act.writes)
        if extra:
            return None, f"unexpected output field(s) {sorted(extra)}"
        delta = copy.deepcopy(delta)
    missing = [w for w in act.writes if w not in delta]
    if missing:
        return None, f"declared write(s) {missing} not produced"
    for var, value in delta.items():
        if pkg.owner(var) == "engine":
            return None, f"{var!r} is engine-owned"
        errs = JS.errors(value, pkg.var_schema(var), var)
        if errs:
            return None, "; ".join(errs)
        if act.kind == "judge" and value not in act.labels:
            return None, f"label {value!r} is not one of {list(act.labels)}"
    return delta, None


def apply(cp: dict, obs: dict, pkg: LoadedPackage) -> StepResult:
    """Single entry point used by the runtime and by recorded replay.

    Observation kinds: ``interaction`` (pause for a user/approval response),
    ``stop`` (host-detected failure before dispatch, e.g. input binding),
    ``cancel``; anything else is an action result handled by ``advance``.
    """
    kind = obs.get("kind")
    if kind == "interaction":
        _validate_identity(cp, obs, pkg)
        state = pkg.machine.states[cp["state_id"]]
        if state.action.kind != "user":
            raise KernelError("interactions can only be requested in user states")
        out = copy.deepcopy(cp)
        out["status"] = "WAITING_FOR_APPROVAL" if obs["interaction_type"] == "approval" else "WAITING_FOR_INPUT"
        out["pending"] = {"interaction_id": obs["interaction_id"], "type": obs["interaction_type"]}
        out["revision"] = cp["revision"] + 1
        return StepResult(out, {"type": "interaction_requested", "state_id": cp["state_id"],
                                "interaction_id": obs["interaction_id"], "interaction_type": obs["interaction_type"],
                                "revision": out["revision"], "observed_at": obs.get("observed_at"),
                                "artifact_hash": cp["artifact_hash"]})
    if kind == "stop":
        _validate_identity(cp, obs, pkg)
        return _stop(cp, obs["code"], obs["message"], obs)
    if kind == "cancel":
        _validate_identity(cp, obs, pkg)
        out = copy.deepcopy(cp)
        out["status"] = "CANCELLED"
        out["revision"] = cp["revision"] + 1
        out["pending"] = None
        out["assurance"]["disclosed_effects"] = list(obs.get("disclosed_effects", []))
        return StepResult(out, {"type": "cancelled", "revision": out["revision"], "observed_at": obs.get("observed_at"),
                                "disclosed_effects": out["assurance"]["disclosed_effects"],
                                "artifact_hash": cp["artifact_hash"]})
    return advance(cp, obs, pkg)


def advance(cp: dict, obs: dict, pkg: LoadedPackage) -> StepResult:
    _validate_identity(cp, obs, pkg)
    if cp["status"] in ("WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT") and obs.get("kind") != "user":
        raise KernelError("run is waiting for an interaction response")
    state = pkg.machine.states[cp["state_id"]]
    limits = cp["budget"]["limits"]

    if state.action.kind == "end":
        return _finish(cp, pkg, obs)

    used = _usage(cp, obs)
    over = [k for k, lim in limits.items() if used.get(k, 0) > lim]
    if over:
        return _stop(cp, "BUDGET_EXHAUSTED", f"run budget exhausted: {over}", obs, {"used": used})

    if state.action.kind == "tool":
        certainty = obs.get("certainty")
        if certainty == "unknown_effect":
            out = copy.deepcopy(cp)
            out["status"] = "RECONCILING"
            out["revision"] = cp["revision"] + 1
            out["budget"]["used"] = used
            ref = obs.get("action_id")
            if ref and ref not in out["assurance"]["unresolved_effects"]:
                out["assurance"]["unresolved_effects"].append(ref)
            return StepResult(out, {"type": "reconciling", "state_id": cp["state_id"], "action_id": ref,
                                    "revision": out["revision"], "observed_at": obs.get("observed_at"),
                                    "artifact_hash": cp["artifact_hash"]})
        if certainty != "certain":
            code = "POLICY_DENIED" if certainty == "denied" else "TOOL_FAILED"
            return _stop(cp, code, f"tool outcome {certainty!r}: {obs.get('reason', '')}", obs)

    delta, err = _declared_outputs(cp, obs, pkg)
    if err is not None:
        if state.action.kind == "tool":
            return _stop(cp, "TOOL_OUTPUT_INVALID", err, obs)
        return _to_fallback(cp, pkg, obs, "OUTPUT_INVALID", err)

    after = copy.deepcopy(cp)
    after["variables"].update(delta)
    after["budget"]["used"] = used
    if obs.get("action_id"):
        after["assurance"]["unresolved_effects"] = [
            a for a in after["assurance"]["unresolved_effects"] if a != obs["action_id"]]
    for rid in obs.get("evidence_receipts", []):
        if rid not in after["evidence"]:
            after["evidence"].append(rid)

    env = after["variables"]
    chosen, index = None, None
    ordered = state.ordered_transitions()
    for t in ordered:
        if t.is_default:
            chosen = t
            break
        try:
            if G.evaluate(t.cond, env):
                chosen = t
                break
        except G.GuardError as exc:
            return _stop(after, "GUARD_ERROR", f"guard {t.cond!r}: {exc}", obs)
    if chosen is None:
        return _stop(after, "NO_ENABLED_TRANSITION", "no guard enabled and no default edge", obs)
    index = list(state.transitions).index(chosen)

    if chosen.inc:
        bound = pkg.contracts.get("loop_bounds", {}).get(chosen.inc)
        newval = env.get(chosen.inc, 0) + 1
        if bound is None or newval > bound:
            return _stop(after, "LOOP_BOUND_EXCEEDED", f"{chosen.inc} would become {newval} (bound {bound})", obs)
        after["variables"][chosen.inc] = newval

    after["state_id"] = chosen.to
    after["revision"] = cp["revision"] + 1
    after["status"] = "RUNNING"
    after["pending"] = None
    after["diagnostic"] = None
    after["visits"][cp["state_id"]] = after["visits"].get(cp["state_id"], 0) + 1
    if chosen.to == pkg.machine.fallback:
        after["assurance"]["entered_fallback"] = True
    event = {
        "type": "transition", "from": cp["state_id"], "to": chosen.to, "edge_index": index,
        "guard": chosen.cond, "inc": chosen.inc, "revision": after["revision"],
        "delta_digest": canonical.digest(delta), "delta_keys": sorted(delta),
        "observed_at": obs.get("observed_at"), "artifact_hash": cp["artifact_hash"],
        "action_id": obs.get("action_id"),
    }
    return StepResult(after, event)
