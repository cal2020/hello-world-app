/* Port of hexis_service/runtime/service.py: run orchestration (brief §7.1, §11, §12, §15).
 *
 * ``advance_run`` executes exactly one persisted step: it claims a lease (fencing token), prepares the state's
 * action, records intent / interaction durably, dispatches through the broker, and commits the kernel's
 * transition + events + observation in one transaction. The pure reducer (HX.kernel.advance) remains separately
 * callable for conformance and recorded replay.
 *
 * API (Python keyword arguments become a trailing options object):
 *   new RunService(store, catalog, policy, broker, model, {clock, environment = "sandbox", faults, freshness,
 *                  lease_ttl = 300, timer, ids})
 *     ids: a function returning 32 hex digits (Python ``uuid.uuid4().hex``), e.g. HX.util.make_id_source(1).
 *   start_run(package_hash, task_input, principal, request_id = "") -> RunHandle
 *   advance_run(run_id, principal, expected_revision = null, worker_id = "worker-1")  (or {expected_revision, worker_id})
 *   run_until_blocked(run_id, principal, worker_id = "worker-1", max_steps = 200)      (or {worker_id, max_steps})
 *   resume_interaction(run_id, interaction_id, response, principal, request_id = "")
 *   cancel_run(run_id, expected_revision, principal, worker_id = "canceller")           (or {worker_id})
 *   resolve_effect(run_id, logical_action_id, outcome, principal, {output, note})
 *   inspect_run(run_id, principal) -> dict
 *   package(artifact_hash) -> normalized MachinePackage dump
 * Checkpoints and observations are plain dumps (HX.kernel); ``StepResult.checkpoint`` is a checkpoint dump.
 * ``model`` is any object with ``generate(request_dump) -> ModelResponse dump`` (and optionally ``model_id``).
 * Freshness checks are ``fn(svc, run, cp, pkg, initiator, lease_token = null) -> [ok, why]``.
 *
 * ``SimulatedCrash`` propagates out of every API exactly where Python lets it escape.
 */
(function (HX) {
  "use strict";
  const service = (HX.service = HX.service || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  class RunError extends HX.HXError {
    constructor(code, message) {
      super(code, message);
      this.message = message; /* Python: exc.message; str(exc) is "CODE: message" */
    }
    toString() { return this.code + ": " + this.message; }
  }
  service.RunError = RunError;

  function pyerr(cls, message) { return HX.broker._pyerr(cls, message); }
  const repr = (v) => HX.kernel._py_repr(v);
  const py_str = (v) => HX.broker._py_str(v);
  const truthy = (v) => HX.broker._truthy(v);
  const item = (d, k) => HX.broker._item(d, k);
  const get = (d, k, dflt) => HX.broker._get(d, k, dflt);
  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  const clone = (v) => HX.kernel._clone(v);
  /** ``k in mapping`` for normalized (possibly null-prototype) maps. */
  const has = (m, k) => m !== null && typeof m === "object" && typeof k === "string" && Object.prototype.hasOwnProperty.call(m, k);
  const mget = (m, k) => (has(m, k) ? m[k] : null);

  /** ``scope_digest(scope)`` as Python computes it. An approval scope's ``expires_at`` is ``clock() +
   *  approval_expiry_s``: a Python float even when it is integral (``1790086400.0``), which canonicalizes as
   *  ``1790086400.0``; JS would print ``1790086400``. The approval scope is therefore serialized with
   *  ``expires_at`` as a float (``HX.canonical.py_float_repr``); everything else is HX.canonical's canonical form.
   *  Input-interaction scopes have no ``expires_at`` and go through HX.approvals.scope_digest unchanged. */
  function scope_digest(scope) {
    if (!HX.util.is_plain_object(scope) || !hasOwn(scope, "expires_at") || typeof scope.expires_at !== "number" ||
        Number.isNaN(scope.expires_at) || !Number.isFinite(scope.expires_at)) {
      return HX.approvals.scope_digest(scope);
    }
    HX.canonical.canonical_text(scope); /* the same checks (and errors) as the plain digest */
    const C = HX.canonical;
    const text = "{" + HX.util.sorted_keys(scope).map((k) => C.canonical_text(k) + ":" +
      (k === "expires_at" ? C.py_float_repr(scope[k]) : C.canonical_text(scope[k]))).join(",") + "}";
    return "sha256:" + C.sha256_hex(text);
  }
  service._scope_digest = scope_digest;

  class RunHandle {
    constructor(run_id, tenant_id, artifact_hash, status, revision) {
      Object.assign(this, { run_id, tenant_id, artifact_hash, status, revision });
    }
    toJSON() { return { run_id: this.run_id, tenant_id: this.tenant_id, artifact_hash: this.artifact_hash,
      status: this.status, revision: this.revision }; }
  }
  service.RunHandle = RunHandle;

  class StepResult {
    constructor(checkpoint, status, detail, interaction) {
      this.checkpoint = checkpoint;
      this.status = status;
      this.detail = detail === undefined ? "" : detail;
      this.interaction = interaction === undefined ? null : interaction;
    }
    toJSON() { return { checkpoint: this.checkpoint, status: this.status, detail: this.detail, interaction: this.interaction }; }
  }
  service.StepResult = StepResult;

  class CancellationResult {
    constructor(status, disclosed_effects, unresolved) {
      this.status = status;
      this.disclosed_effects = disclosed_effects === undefined ? [] : disclosed_effects;
      this.unresolved = unresolved === undefined ? [] : unresolved;
    }
    toJSON() { return { status: this.status, disclosed_effects: this.disclosed_effects, unresolved: this.unresolved }; }
  }
  service.CancellationResult = CancellationResult;

  /** Per-step latency/usage collector. Lives only in memory for the duration of one ``advance_run`` and is
   *  persisted as a separate append-only ``TIMING`` run event; it never enters an observation or checkpoint. */
  class StepMetrics {
    constructor(t0) {
      this.t0 = t0;
      this.run_id = null;
      this.tenant_id = "";
      this.state = "";
      this.revision = 0;
      this.kind = "";
      this.model_calls = [];
      this.human_wait_s = null;
      this.human_wait_expired = false;
      this.validation_failures = [];
      this.fallback = false;
      this.raised = [];
      this.resolved = [];
    }
  }
  service._StepMetrics = StepMetrics;

  class Paused extends Error {
    constructor(status, detail, interaction) {
      super(detail);
      this.status = status;
      this.detail = detail;
      this.interaction = interaction === undefined ? null : interaction;
    }
  }
  service._Paused = Paused;

  function default_ids() {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === "function") {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }
    let s = "";
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
  service.default_ids = default_ids;

  const SVC_OPTS = ["clock", "environment", "faults", "freshness", "lease_ttl", "timer", "ids"];
  const TERMINAL = () => HX.kernel.TERMINAL_STATUSES;

  /** Trailing optional parameters: positional, or one plain options object whose keys are parameter names. */
  function trailing(rest, names, fn) {
    const out = {};
    if (rest.length === 1 && HX.util.is_plain_object(rest[0])) {
      for (const k of Object.keys(rest[0])) {
        if (names.indexOf(k) < 0) throw pyerr("TypeError", fn + "() got an unexpected keyword argument '" + k + "'");
      }
      for (const n of names) out[n] = rest[0][n];
      return out;
    }
    if (rest.length > names.length) throw pyerr("TypeError", fn + "() takes too many positional arguments");
    names.forEach((n, i) => { out[n] = rest[i]; });
    return out;
  }
  service._trailing = trailing;

  const is_crash = (e) => HX.broker && HX.broker.is_crash(e);
  const is_conflict = (e) => e instanceof HX.store.ConflictError;
  const is_kernel_error = (e) => e instanceof HX.kernel.KernelError;
  const conflict_to_run_error = (exc) => new RunError(exc.message.split(":")[0], exc.message);

  function observation(fields) { return HX.kernel.new_observation(fields); }

  function decision_var(pkg, state_id) {
    const w = pkg.machine.states[state_id].action.writes;
    return w && w.length ? w[0] : "approval_decision";
  }
  service._decision_var = decision_var;

  class RunService {
    constructor(store, catalog, policy, broker, model, opts) {
      const o = opts || {};
      for (const k of Object.keys(o)) {
        if (SVC_OPTS.indexOf(k) < 0) throw pyerr("TypeError", "RunService() got an unexpected keyword argument '" + k + "'");
      }
      this.store = store;
      this.catalog = catalog;
      this.policy = policy;
      this.broker = broker;
      this.model = model;
      this.clock = o.clock || HX.broker._default_clock;
      this.environment = o.environment === undefined ? "sandbox" : o.environment;
      this.lease_ttl = o.lease_ttl === undefined ? 300.0 : o.lease_ttl;
      /* ``clock`` is logical time (expiry, leases, human wait). ``timer`` is a monotonic clock used only for latency
         metrics (TIMING events); it never influences a decision, a checkpoint or an observation. */
      this.timer = o.timer || HX.broker._default_timer;
      this.ids = o.ids || default_ids;
      this._metrics_cur = null;
      this.faults = o.faults || broker.faults;
      this.freshness = truthy(o.freshness) ? o.freshness : {};
      this._packages = new Map();
    }

    _hex() { return String(this.ids()); }
    _spec(name) { return HX.catalog.get(this.catalog, name); }

    /* ------------------------------------------------------------------------------------------------ */
    package(artifact_hash) {
      if (!this._packages.has(artifact_hash)) {
        const data = this.store.get_version(artifact_hash);
        if (data === null) throw new RunError("UNKNOWN_ARTIFACT", py_str(artifact_hash));
        const pkg = HX.pkg.from_json(data);
        if (!HX.pkg.verify_hash(pkg)) throw new RunError("ARTIFACT_TAMPERED", py_str(artifact_hash));
        this._packages.set(artifact_hash, pkg);
      }
      return this._packages.get(artifact_hash);
    }

    _run(run_id, principal) {
      const run = this.store.get_run(principal.tenant_id, run_id); /* tenant from host principal, never from input */
      if (run === null) throw new RunError("NOT_FOUND", "run " + py_str(run_id) + " not found for tenant");
      return run;
    }

    _cp(tenant, run_id) {
      return HX.kernel.RunCheckpoint.model_validate(this.store.latest_checkpoint(tenant, run_id));
    }

    /* ------------------------------------------------------------------------------------------------ */
    start_run(package_hash, task_input, principal, request_id) {
      if (request_id === undefined || request_id === null) request_id = "";
      if (truthy(request_id)) {
        const existing = this.store.run_by_request(principal.tenant_id, request_id);
        if (truthy(existing)) {
          const cp = this._cp(principal.tenant_id, existing);
          return new RunHandle(existing, principal.tenant_id, cp.artifact_hash,
            this.store.get_run(principal.tenant_id, existing).status, cp.revision);
        }
      }
      const pkg = this.package(package_hash);
      if (this.store.is_revoked(package_hash)) throw new RunError("ARTIFACT_REVOKED", "revoked artifacts cannot start new runs");
      if (!HX.registry.is_admitted_in(this.store, package_hash, this.environment)) {
        throw new RunError("ARTIFACT_NOT_ADMITTED", "only admitted artifacts can run");
      }
      const run_id = "run_" + this._hex().slice(0, 16);
      let cp;
      try {
        cp = HX.kernel.initial_checkpoint(pkg, principal.tenant_id, run_id, task_input);
      } catch (exc) {
        if (is_kernel_error(exc)) throw new RunError(exc.code, exc.message);
        throw exc;
      }
      const created = this.store.create_run(principal.tenant_id, run_id, package_hash, principal.id, request_id, cp,
        [{ type: "RUN_CREATED", artifact_hash: package_hash, principal: principal.id,
          task_input_digest: HX.canonical.digest(task_input), checkpoint_digest: HX.kernel.checkpoint_digest(cp) }],
        this.clock());
      if (!created) return this.start_run(package_hash, task_input, principal, request_id); /* lost a race on the same request id */
      return new RunHandle(run_id, principal.tenant_id, package_hash, cp.status, cp.revision);
    }

    /* ------------------------------------------------------------------------------------------------ */
    advance_run(run_id, principal, ...rest) {
      const a = trailing(rest, ["expected_revision", "worker_id"], "advance_run");
      const expected_revision = a.expected_revision === undefined ? null : a.expected_revision;
      const worker_id = a.worker_id === undefined ? "worker-1" : a.worker_id;
      const prev = this._metrics_cur;
      const m = new StepMetrics(this.timer());
      if (prev === null) this.broker.take_timings(); /* discard connector timings made outside any step */
      this._metrics_cur = m;
      let res, tool_calls;
      try {
        res = this._advance_run(run_id, principal, expected_revision, worker_id);
      } finally {
        this._metrics_cur = prev;
        tool_calls = prev === null ? this.broker.take_timings() : [];
      }
      if (m.run_id !== null) this._record_timing(m, tool_calls, res);
      return res;
    }

    _metrics() {
      return this._metrics_cur !== null ? this._metrics_cur : new StepMetrics(0.0); /* outside a step: dropped */
    }

    /** Append the step's TIMING event (after the commit, never inside it: timing is not replay input). */
    _record_timing(m, tool_calls, res) {
      /* Python 3.12 sum(): compensated for floats (latencies, costs), exact for the int token counts */
      const sum = (xs) => xs.reduce((s, x) => s + x, 0);
      const fsum = HX.metrics.py_fsum;
      const model_s = fsum(m.model_calls.map((c) => c.latency_s));
      const tool_s = fsum(tool_calls.map((c) => c.latency_s));
      const costs = m.model_calls.filter((c) => c.outcome !== "unavailable").map((c) => c.cost_usd);
      const event = {
        type: "TIMING", schema: "hexis-timing/1", state: m.state, revision: m.revision, kind: m.kind,
        status: res.status, model_s, tool_s,
        human_wait_s: m.human_wait_s, human_wait_expired: m.human_wait_expired,
        model_calls: m.model_calls, tool_calls,
        tokens: { input: sum(m.model_calls.map((c) => c.input_tokens)), output: sum(m.model_calls.map((c) => c.output_tokens)) },
        /* Unknown cost stays unknown (null), never 0: known only if every answered call reported a cost. */
        cost_usd: costs.length && costs.every((c) => c !== null && c !== undefined) ? fsum(costs) : null,
        retries: { model_transport: m.model_calls.filter((c) => c.transport_retry).length,
          output_repair: m.model_calls.filter((c) => c.repair).length,
          tool_transport: tool_calls.filter((c) => c.attempt > 1 || c.op === "redispatch").length },
        validation_failures: m.validation_failures.length, validation_failure_codes: m.validation_failures,
        fallback: m.fallback, uncertain_effects: { raised: m.raised, resolved: m.resolved },
      };
      const total = this.timer() - m.t0;
      /* Engine overhead = prepare + kernel.advance + commit (+ bookkeeping), excluding model and tool calls. */
      event.total_s = total;
      event.engine_s = Math.max(total - model_s - tool_s, 0.0);
      this.store.append_events(m.tenant_id, m.run_id, [event], this.clock());
    }

    _advance_run(run_id, principal, expected_revision, worker_id) {
      const run = this._run(run_id, principal);
      const tenant = run.tenant_id;
      const cp = this._cp(tenant, run_id);
      if (expected_revision !== null && !HX.policy._py_eq(cp.revision, expected_revision)) {
        throw new RunError("REVISION_CONFLICT", "expected " + py_str(expected_revision) + ", current " + cp.revision);
      }
      if (TERMINAL().indexOf(cp.status) >= 0 || run.status === "CANCELLED") {
        return new StepResult(cp, run.status, "run finished");
      }
      const token = this.store.acquire_lease(tenant, run_id, worker_id, this.clock(), this.lease_ttl);
      if (token === null) throw new RunError("LEASE_HELD", "another worker owns this run");
      const pkg = this.package(cp.artifact_hash);
      const m = this._metrics();
      m.run_id = run_id; m.tenant_id = tenant; m.state = cp.state_id; m.revision = cp.revision;
      const st0 = mget(pkg.machine.states, cp.state_id);
      m.kind = st0 !== null ? st0.action.kind : "";
      const initiator = this.policy.authenticate(run.principal);
      if (run.cancel_requested) return this._finish_cancel(run, cp, pkg, initiator, token);
      if (this.store.is_revoked(cp.artifact_hash)) {
        /* In-flight runs reconcile any unresolved write, then stop as CANCELLED (docs/OPERATIONS.md). */
        this._reconcile_unresolved(run, cp, pkg, initiator, token, "artifact revoked", "revocation");
        const unresolved = this._unresolved(tenant, run_id);
        if (unresolved.length) {
          this.store.set_run_status(tenant, run_id, "RECONCILING");
          return new StepResult(cp, "RECONCILING", "artifact revoked; unresolved external effects " + repr(unresolved));
        }
        return this._stop(run, cp, token, "CANCELLED", "ARTIFACT_REVOKED",
          "artifact revoked; in-flight policy stops before further dispatch");
      }
      if (!has(pkg.machine.states, cp.state_id)) throw pyerr("KeyError", repr(cp.state_id));
      const st = pkg.machine.states[cp.state_id];
      const kind = st.action.kind;
      let obs;
      try {
        if (kind === "tool") obs = this._tool_step(run, cp, pkg, initiator, token);
        else if (kind === "model" || kind === "judge") obs = this._model_step(run, cp, pkg);
        else if (kind === "user") obs = this._user_step(run, cp, pkg);
        else obs = this._end_step(run, cp, pkg, initiator, token);
      } catch (exc) {
        if (exc instanceof Paused) return new StepResult(this._cp(tenant, run_id), exc.status, exc.detail, exc.interaction);
        if (is_kernel_error(exc)) return this._stop(run, cp, token, "FAILED", exc.code, exc.message);
        if (is_conflict(exc)) throw conflict_to_run_error(exc); /* fenced off while dispatching */
        throw exc;
      }
      return this._commit(run, cp, pkg, obs, token);
    }

    run_until_blocked(run_id, principal, ...rest) {
      const a = trailing(rest, ["worker_id", "max_steps"], "run_until_blocked");
      const worker_id = a.worker_id === undefined ? "worker-1" : a.worker_id;
      const max_steps = a.max_steps === undefined ? 200 : a.max_steps;
      let res = null;
      for (let i = 0; i < max_steps; i++) {
        res = this.advance_run(run_id, principal, { worker_id });
        if (res.status !== "RUNNING") return res;
      }
      if (res === null) throw pyerr("AssertionError", "");
      return res;
    }

    /* ------------------------------------------------------------------------------------------------ */
    _commit(run, cp, pkg, obs, token) {
      let result;
      try {
        result = HX.kernel.advance(cp, obs, pkg);
      } catch (exc) {
        if (!is_kernel_error(exc)) throw exc;
        /* Observation rejected after the fact (e.g. tool output violates the variable contract): the raw
           observation and receipts are already stored; stop explicitly instead of erasing them. */
        this.store.append_events(run.tenant_id, run.run_id, [{ type: "OBSERVATION_REJECTED", code: exc.code,
          message: exc.message, observation: clone(obs) }], this.clock());
        this._metrics().validation_failures.push(exc.code);
        return this._stop(run, cp, token, "FAILED", exc.code, exc.message);
      }
      const events = [{ type: "OBSERVATION", observation: clone(obs) }].concat(result.events);
      this.faults.hit("before_commit");
      try {
        this.store.commit_transition(run.tenant_id, run.run_id, cp.revision, token, result.checkpoint, events, this.clock());
      } catch (exc) {
        if (is_conflict(exc)) throw conflict_to_run_error(exc);
        throw exc;
      }
      this._metrics().fallback = result.events.some((e) => get(e, "type") === "FALLBACK_ENTERED");
      this._invalidate_stale_evidence(run.tenant_id, run.run_id, result.checkpoint);
      const status = result.checkpoint.status;
      return new StepResult(result.checkpoint, status, result.edge ? result.edge.to : status);
    }

    _stop(run, cp, token, status, code, message) {
      const a = clone(cp.assurance);
      a.diagnostics.push({ code, message, state: cp.state_id, revision: cp.revision });
      if (code.startsWith("POLICY") || code === "APPROVAL_INVALID" || code === "BROKER_DENIED") a.policy_violations.push(message);
      a.unresolved_effects = this._unresolved(run.tenant_id, run.run_id);
      const neu = {};
      for (const k of Object.keys(cp)) neu[k] = cp[k];
      neu.status = status;
      neu.assurance = a;
      neu.revision = cp.revision + 1;
      try {
        this.store.commit_transition(run.tenant_id, run.run_id, cp.revision, token, neu,
          [{ type: "RUN_STOPPED", status, code, message, state: cp.state_id }], this.clock());
      } catch (exc) {
        if (is_conflict(exc)) throw conflict_to_run_error(exc);
        throw exc;
      }
      return new StepResult(neu, status, code + ": " + message);
    }

    _pause(run, cp, status, detail, event, interaction) {
      this.store.append_events(run.tenant_id, run.run_id, [event], this.clock());
      this.store.set_run_status(run.tenant_id, run.run_id, status);
      throw new Paused(status, detail, interaction);
    }

    /** A tool missing from the current catalog is treated as a write (conservative disclosure). */
    _is_write(tool) {
      const spec = this._spec(tool);
      return spec === null || HX.catalog.is_write(spec);
    }

    _unresolved(tenant, run_id) {
      /* Reconcile from receipts, not intent status alone: a SUCCEEDED receipt resolves the intent. */
      const succeeded = new Set(this.store.receipts(tenant, { run_id }).filter((r) => r.dispatch_state === "SUCCEEDED")
        .map((r) => r.logical_action_id));
      return this.store.intents(tenant, run_id)
        .filter((i) => (i.status === "DISPATCHING" || i.status === "UNKNOWN_EFFECT") && !succeeded.has(i.logical_action_id) &&
          this._is_write(i.tool))
        .map((i) => i.logical_action_id + ":" + i.tool + ":" + i.status);
    }

    /* ---- tool ------------------------------------------------------------------------------------- */
    _prepare_tool(cp, pkg, state_id, revision) {
      if (!has(pkg.machine.states, state_id)) throw pyerr("KeyError", repr(state_id));
      const st = pkg.machine.states[state_id];
      const spec = this._spec(st.action.name);
      if (spec === null) throw new HX.kernel.KernelError("UNKNOWN_TOOL", py_str(st.action.name));
      const args = HX.kernel.fill_template(st.action.input, cp.variables);
      const errs = HX.broker._validate_against(spec.input_schema, args);
      if (errs.length) throw new HX.kernel.KernelError("TOOL_INPUT_INVALID", errs.slice(0, 3).join("; "), { errors: errs });
      const ad = HX.canonical.digest(args);
      const lid = HX.approvals.logical_action_id(cp.run_id, state_id, revision, ad);
      return { args, args_digest: ad, lid, idem: HX.approvals.idempotency_key(cp.tenant_id, lid), spec };
    }

    _approval_check(run, cp, pkg, intent) {
      return () => {
        const tenant = run.tenant_id;
        const ics = pkg.contracts.interactions;
        const approvals = Object.keys(ics).filter((sid) => ics[sid].type === "approval" &&
          ics[sid].approves_state === item(intent, "state_id"));
        if (!approvals.length) return [false, "no approval interaction governs this action"];
        const ixs = [];
        for (let r = 0; r < cp.revision; r++) {
          const i = this.store.interaction_for_revision(tenant, run.run_id, r);
          if (truthy(i) && i.type === "approval" && approvals.indexOf(i.state_id) >= 0) ixs.push(i);
        }
        if (!ixs.length) return [false, "no approval recorded"];
        const ix = ixs[ixs.length - 1];
        const resp = this.store.response(tenant, ix.interaction_id);
        if (resp === null || get(resp.response, decision_var(pkg, ix.state_id)) !== "approved") {
          return [false, "latest approval is not an approval decision"];
        }
        if (ix.expires_at !== null && this.clock() > ix.expires_at) return [false, "approval expired"];
        const ic = ics[ix.state_id];
        const entry = get(this.policy.doc.principals, resp.responder, {});
        const approver = HX.policy.Principal({ id: resp.responder, tenant_id: tenant,
          roles: HX.util.is_plain_object(entry) && hasOwn(entry, "roles") ? entry.roles : [] });
        const d = this.policy.can_approve(approver, run.principal, tenant, ic.required_role);
        if (!d.allowed) return [false, "approver no longer authorized: " + d.reasons.join("; ")];
        const spec = this._spec(item(intent, "tool"));
        const current = HX.approvals.approval_scope({
          tenant_id: tenant, run_id: run.run_id, interaction_id: ix.interaction_id, artifact_hash: cp.artifact_hash,
          lid: item(intent, "logical_action_id"), tool: item(intent, "tool"), tool_version: item(intent, "tool_version"),
          args_digest: item(intent, "args_digest"),
          business_reference: spec ? get(item(intent, "args"), spec.business_reference_field) : null,
          evidence: HX.evidence.evidence_scope(this.store.evidence(tenant, run.run_id), cp.variables),
          policy_version: this.policy.version, required_role: ic.required_role, expires_at: ix.expires_at });
        if (scope_digest(current) !== ix.scope_digest || resp.scope_digest !== ix.scope_digest) {
          const diff = Object.keys(current).filter((k) => !HX.policy._py_eq(current[k], get(ix.scope, k))).sort(cmp);
          return [false, "approval scope changed: " + repr(diff)];
        }
        return [true, ""];
      };
    }

    _tool_step(run, cp, pkg, initiator, token) {
      const tenant = run.tenant_id;
      let intent = this.store.intent_for_revision(tenant, run.run_id, cp.revision);
      if (intent === null) {
        const prep = this._prepare_tool(cp, pkg, cp.state_id, cp.revision);
        intent = this.store.create_intent(tenant, run.run_id, prep.lid, cp.state_id, cp.revision, prep.spec.name,
          prep.spec.version, prep.args, prep.args_digest, prep.idem, token, this.clock());
        this.faults.hit("after_intent");
      }
      const spec = this._spec(intent.tool);
      const st = pkg.machine.states[cp.state_id];
      const names = new Set(st.action.reads);
      for (const v of HX.validate.template_vars(st.action.input)) names.add(v);
      const subject = {};
      for (const r of Array.from(names).sort(cmp)) if (hasOwn(cp.variables, r)) subject[r] = cp.variables[r];
      const bu = get(cp.variables, "business_unit");
      const retries = pkg.execution_policy.transport_retries;
      let res = this.broker.dispatch({ intent, principal: initiator, package: pkg, business_unit: bu,
        approval_check: this._approval_check(run, cp, pkg, intent), lease_token: token, subject_values: subject,
        transport_retries: retries });
      const lid = intent.logical_action_id;
      if (res.status === "UNKNOWN_EFFECT") {
        this._metrics().raised.push(lid);
        this.store.append_events(tenant, run.run_id, [{ type: "EFFECT_UNKNOWN", logical_action_id: lid, reason: res.reason }],
          this.clock());
        this.store.set_run_status(tenant, run.run_id, "RECONCILING");
        res = this.broker.reconcile({ intent: this.store.intent_for_revision(tenant, run.run_id, cp.revision),
          principal: initiator, package: pkg, business_unit: bu, approval_check: this._approval_check(run, cp, pkg, intent),
          lease_token: token, subject_values: subject, transport_retries: retries });
        if (res.status === "SUCCEEDED") this._metrics().resolved.push(lid);
        this.store.append_events(tenant, run.run_id, [{ type: "RECONCILED", logical_action_id: lid, status: res.status,
          certainty: res.certainty, reason: res.reason }], this.clock());
      }
      if (res.status === "UNKNOWN_EFFECT" || res.status === "NEEDS_RESOLUTION") {
        this._pause(run, cp, "RECONCILING", res.reason, { type: "RECONCILIATION_REQUIRED", logical_action_id: lid,
          reason: res.reason });
      }
      if (res.status === "DENIED" && res.reason.startsWith("STALE_LEASE")) {
        throw new RunError("STALE_LEASE", "worker no longer owns this run (" + res.reason + ")");
      }
      if (res.status === "DENIED") {
        const code = res.reason.startsWith("POLICY") ? "POLICY_DENIED" : res.reason.split(":")[0];
        throw new HX.kernel.KernelError(code, "broker denied " + py_str(intent.tool) + ": " + res.reason);
      }
      if (spec === null) throw pyerr("AttributeError", "'NoneType' object has no attribute 'name'");
      if (res.status === "FAILED") {
        return observation({ run_id: cp.run_id, state_id: cp.state_id, revision: cp.revision, kind: "tool", outputs: {},
          actor: "tool:" + spec.name, usage: { tool_calls: 1 }, failure: "TOOL_FAILED: " + res.reason });
      }
      return observation({ run_id: cp.run_id, state_id: cp.state_id, revision: cp.revision, kind: "tool",
        outputs: truthy(res.output) ? res.output : {}, actor: "tool:" + spec.name + "@" + spec.version,
        receipt_ref: res.receipt_ref, usage: { tool_calls: 1 } });
    }

    /* ---- model / judge ------------------------------------------------------------------------------ */
    _model_step(run, cp, pkg) {
      const st = pkg.machine.states[cp.state_id];
      const a = st.action;
      const missing = a.reads.filter((r) => !hasOwn(cp.variables, r));
      if (missing.length) throw new HX.kernel.KernelError("MISSING_READ", st.id + " reads unset " + repr(missing));
      const inputs = {};
      for (const r of a.reads) inputs[r] = cp.variables[r];
      const schemas = {};
      const vcs = pkg.contracts.variables;
      for (const k of Object.keys(vcs)) schemas[k] = vcs[k].schema;
      const judge = a.kind === "judge";
      let req = HX.models.ModelRequest.model_validate({ kind: a.kind, state_id: st.id, prompt: a.prompt, inputs,
        output_schema: HX.models.output_schema_for(a.writes, schemas, judge ? a.labels : null),
        labels: judge ? a.labels : [] });
      const usage = { model_calls: 0, tokens: 0, output_repairs: 0 };
      let repairs_left = pkg.execution_policy.structured_output_repairs;
      let retries_left = pkg.execution_policy.transport_retries;
      const m = this._metrics();
      let transport_retry = false;
      const model_id = () => (this.model && this.model.model_id !== undefined ? this.model.model_id : "?");
      for (;;) {
        const t0 = this.timer();
        const call = { model_id: model_id(), attempt: usage.model_calls + 1, repair: truthy(req.repair_feedback),
          transport_retry, input_tokens: 0, output_tokens: 0, cost_usd: null };
        let resp;
        try {
          resp = this.model.generate(req);
        } catch (exc) {
          if (!(exc instanceof HX.models.ModelUnavailable)) throw exc;
          m.model_calls.push(Object.assign({}, call, { latency_s: this.timer() - t0, outcome: "unavailable" }));
          usage.model_calls += 1;
          if (retries_left > 0) {
            retries_left -= 1;
            transport_retry = true;
            continue;
          }
          return observation({ run_id: cp.run_id, state_id: st.id, revision: cp.revision, kind: a.kind,
            actor: "model:" + py_str(model_id()), usage, failure: "MODEL_UNAVAILABLE: " + exc.message });
        }
        Object.assign(call, { latency_s: this.timer() - t0, model_id: resp.model_id, input_tokens: resp.input_tokens,
          output_tokens: resp.output_tokens, cost_usd: resp.cost_usd, outcome: "accepted" });
        m.model_calls.push(call);
        transport_retry = false;
        usage.model_calls += 1;
        usage.tokens += resp.input_tokens + resp.output_tokens;
        const out = truthy(resp.output) ? resp.output : {};
        const obs = observation({ run_id: cp.run_id, state_id: st.id, revision: cp.revision, kind: a.kind,
          outputs: out, actor: "model:" + resp.model_id, usage: Object.assign({}, usage) });
        try {
          if (resp.output === null || resp.output === undefined) {
            throw new HX.kernel.KernelError("UNPARSEABLE_OUTPUT", "model returned no structured output");
          }
          HX.kernel.validate_declared_outputs(pkg, st.id, obs, cp.variables);
          return obs;
        } catch (exc) {
          if (!is_kernel_error(exc)) throw exc;
          HX.canonical.digest(out); /* Python digests the rejected output (rejected[]) */
          call.outcome = "rejected";
          m.validation_failures.push(exc.code);
          this.store.append_events(run.tenant_id, run.run_id, [{ type: "MODEL_OUTPUT_REJECTED", state: st.id,
            code: exc.code, message: exc.message, keys: Object.keys(out).sort(cmp) }], this.clock());
          if (repairs_left <= 0) {
            return observation({ run_id: cp.run_id, state_id: st.id, revision: cp.revision, kind: a.kind,
              actor: "model:" + resp.model_id, usage, failure: "OUTPUT_INVALID: " + exc.code });
          }
          repairs_left -= 1;
          usage.output_repairs += 1;
          req = Object.assign({}, req, { repair_feedback: exc.code + ": " + exc.message + ". Return exactly the keys " +
            repr(a.writes) + " matching the output schema." });
        }
      }
    }

    /* ---- user ----------------------------------------------------------------------------------------- */
    _approval_scope_for(run, cp, pkg, state_id, interaction_id, expires_at) {
      const ic = pkg.contracts.interactions[state_id];
      /* The approved action is the next visit of the approved state (revision + 1). */
      const prep = this._prepare_tool(cp, pkg, ic.approves_state, cp.revision + 1);
      const spec = prep.spec;
      return HX.approvals.approval_scope({ tenant_id: run.tenant_id, run_id: run.run_id, interaction_id,
        artifact_hash: cp.artifact_hash, lid: prep.lid, tool: spec.name, tool_version: spec.version,
        args_digest: prep.args_digest, business_reference: get(prep.args, spec.business_reference_field),
        evidence: HX.evidence.evidence_scope(this.store.evidence(run.tenant_id, run.run_id), cp.variables),
        policy_version: this.policy.version, required_role: ic.required_role, expires_at });
    }

    _user_step(run, cp, pkg) {
      const tenant = run.tenant_id;
      const st = pkg.machine.states[cp.state_id];
      if (!has(pkg.contracts.interactions, st.id)) throw pyerr("KeyError", repr(st.id));
      const ic = pkg.contracts.interactions[st.id];
      let ix = this.store.interaction_for_revision(tenant, run.run_id, cp.revision);
      if (ix === null) {
        const iid = "ix_" + this._hex().slice(0, 16);
        const now = this.clock();
        const expires = now + pkg.execution_policy.approval_expiry_s;
        let scope;
        if (ic.type === "approval") {
          scope = this._approval_scope_for(run, cp, pkg, st.id, iid, expires);
        } else {
          const context = {};
          for (const r of st.action.reads) context[r] = get(cp.variables, r);
          scope = { tenant_id: tenant, run_id: run.run_id, interaction_id: iid, state_id: st.id,
            requested: st.action.writes.slice(), context };
        }
        ix = this.store.create_interaction(tenant, run.run_id, iid, ic.type, st.id, cp.revision, scope,
          scope_digest(scope), ic.type === "approval" ? expires : null, now);
      }
      const resp = this.store.response(tenant, ix.interaction_id);
      if (resp === null) {
        if (ix.expires_at !== null && this.clock() > ix.expires_at) {
          const m = this._metrics();
          m.human_wait_s = this.clock() - ix.created_at;
          m.human_wait_expired = true;
          this.store.set_interaction_status(tenant, ix.interaction_id, "EXPIRED");
          this.store.append_events(tenant, run.run_id, [{ type: "APPROVAL_EXPIRED", interaction_id: ix.interaction_id }],
            this.clock());
          const outputs = {};
          outputs[decision_var(pkg, st.id)] = "rejected";
          return observation({ run_id: cp.run_id, state_id: st.id, revision: cp.revision, kind: "user", outputs,
            actor: "system:expiry", engine: { interaction_id: ix.interaction_id, expired: true } });
        }
        const status = ic.type === "approval" ? "WAITING_FOR_APPROVAL" : "WAITING_FOR_INPUT";
        this._pause(run, cp, status, "waiting on " + ix.interaction_id, { type: "INTERACTION_OPEN",
          interaction_id: ix.interaction_id, kind: ic.type, scope_digest: ix.scope_digest }, ix);
      }
      /* Human wait on the logical clock: interaction opened -> answered. */
      this._metrics().human_wait_s = resp.created_at - ix.created_at;
      return observation({ run_id: cp.run_id, state_id: st.id, revision: cp.revision, kind: "user",
        outputs: resp.response, actor: "user:" + resp.responder,
        engine: { interaction_id: ix.interaction_id, scope_digest: resp.scope_digest } });
    }

    resume_interaction(run_id, interaction_id, response, principal, request_id) {
      if (request_id === undefined || request_id === null) request_id = "";
      let run = this._run(run_id, principal);
      const tenant = run.tenant_id;
      const ix = this.store.interaction(tenant, interaction_id);
      if (ix === null || ix.run_id !== run_id) throw new RunError("NOT_FOUND", "interaction " + py_str(interaction_id));
      const existing = this.store.response(tenant, interaction_id);
      if (existing !== null) {
        if (truthy(request_id) && existing.request_id === request_id) {
          return new StepResult(this._cp(tenant, run_id), run.status, "duplicate response ignored");
        }
        throw new RunError("ALREADY_ANSWERED", py_str(interaction_id));
      }
      const cp = this._cp(tenant, run_id);
      if (TERMINAL().indexOf(cp.status) >= 0 || TERMINAL().indexOf(run.status) >= 0) {
        throw new RunError("RUN_FINISHED", "run is " + py_str(run.status) + "; interactions can no longer be answered");
      }
      if (run.cancel_requested) throw new RunError("RUN_CANCELLED", "cancellation requested; interactions can no longer be answered");
      if (ix.status !== "OPEN") throw new RunError("INTERACTION_CLOSED", py_str(ix.status));
      if (ix.revision !== cp.revision) {
        throw new RunError("INTERACTION_CLOSED", "interaction belongs to revision " + ix.revision + ", run is at " + cp.revision);
      }
      if (ix.expires_at !== null && this.clock() > ix.expires_at) throw new RunError("INTERACTION_EXPIRED", py_str(interaction_id));
      const pkg = this.package(run.artifact_hash);
      const ic = pkg.contracts.interactions[ix.state_id];
      if (!HX.util.is_plain_object(response)) throw pyerr("AttributeError", "'" + HX.kernel._py_type_name(response) + "' object has no attribute 'items'");
      const values = {};
      for (const k of Object.keys(response)) if (k !== "scope_digest") values[k] = response[k];
      const errs = HX.broker._validate_against(truthy(ic.response_schema) ? ic.response_schema : { type: "object" }, values);
      if (errs.length) throw new RunError("RESPONSE_INVALID", errs.slice(0, 3).join("; "));
      if (ic.type === "approval") {
        const d = this.policy.can_approve(principal, run.principal, tenant, ic.required_role);
        if (!d.allowed) throw new RunError("NOT_AUTHORIZED", d.reasons.join("; "));
        if (get(response, "scope_digest") !== ix.scope_digest) {
          throw new RunError("SCOPE_MISMATCH", "approval must reference the exact scope digest presented");
        }
      } else if (principal.id !== run.principal && principal.roles.indexOf(this.policy.doc.approver_role) < 0) {
        throw new RunError("NOT_AUTHORIZED", "only the requester or an approver may answer input requests");
      }
      const recorded = this.store.record_response(tenant, interaction_id, run_id, principal.id, values, ix.scope_digest,
        request_id, this.clock(), { events: [{ type: "INTERACTION_ANSWERED", interaction_id, responder: principal.id,
          response_digest: HX.canonical.digest(values) }], run_status: "RUNNING" });
      if (!recorded) { /* lost a race: another response (or a closure) won; this one was not recorded */
        const won = this.store.response(tenant, interaction_id);
        if (won !== null && truthy(request_id) && won.request_id === request_id) {
          run = this._run(run_id, principal);
          return new StepResult(this._cp(tenant, run_id), run.status, "duplicate response ignored");
        }
        if (won !== null) throw new RunError("ALREADY_ANSWERED", py_str(interaction_id));
        throw new RunError("INTERACTION_CLOSED", py_str(interaction_id));
      }
      const initiator = this.policy.authenticate(run.principal);
      return this.advance_run(run_id, initiator);
    }

    /* ---- terminal admission ------------------------------------------------------------------------------ */
    _end_step(run, cp, pkg, initiator, token) {
      const tenant = run.tenant_id, run_id = run.run_id;
      const tid = pkg.machine.states[cp.state_id].action.terminal;
      const tc = mget(pkg.contracts.terminals, tid);
      const receipts = this.store.evidence(tenant, run_id);
      const missing = [], used = [];
      if (tc !== null && tc.category === "verified") {
        for (const req of tc.evidence) {
          const ok = HX.evidence.valid_positive(receipts, cp.variables, req.claim).filter((r) =>
            r.verifier === req.verifier_tool && req.subject_vars.every((v) => hasOwn(r.subject, v)));
          if (!ok.length) {
            missing.push(req.claim + ": no current receipt from " + req.verifier_tool);
            continue;
          }
          const fresh = mget(this.freshness, req.claim);
          if (fresh !== null) {
            const [good, why] = fresh(this, run, cp, pkg, initiator, token);
            if (!good) {
              for (const r of ok) this.store.invalidate_evidence(tenant, r.receipt_id, why, this.clock(), { run_id });
              missing.push(req.claim + ": invalidated (" + why + ")");
              continue;
            }
          }
          for (const r of ok) used.push(r.receipt_id);
        }
      }
      const admission = { evidence_valid: !missing.length, missing,
        receipts: Array.from(new Set(used)).sort(cmp), unresolved_effects: this._unresolved(tenant, run_id) };
      return observation({ run_id: cp.run_id, state_id: cp.state_id, revision: cp.revision, kind: "end",
        actor: "engine:terminal-admission", engine: { terminal_admission: admission } });
    }

    _invalidate_stale_evidence(tenant, run_id, cp) {
      for (const r of this.store.evidence(tenant, run_id)) {
        if (r.invalidated_at === null && !HX.evidence.is_current(r, cp.variables)) {
          this.store.invalidate_evidence(tenant, r.receipt_id, "subject variable changed", this.clock(), { run_id });
          this.store.append_events(tenant, run_id, [{ type: "EVIDENCE_INVALIDATED", receipt_id: r.receipt_id,
            reason: "subject variable changed" }], this.clock());
        }
      }
    }

    /* ---- cancellation ------------------------------------------------------------------------------------- */
    cancel_run(run_id, expected_revision, principal, ...rest) {
      const a = trailing(rest, ["worker_id"], "cancel_run");
      const worker_id = a.worker_id === undefined ? "canceller" : a.worker_id;
      if (expected_revision === undefined) expected_revision = null;
      const run = this._run(run_id, principal);
      if (principal.id !== run.principal && principal.roles.indexOf(this.policy.doc.approver_role) < 0) {
        throw new RunError("NOT_AUTHORIZED", "only the requester or an approver may cancel");
      }
      const cp = this._cp(run.tenant_id, run_id);
      if (expected_revision !== null && !HX.policy._py_eq(cp.revision, expected_revision)) {
        throw new RunError("REVISION_CONFLICT", "expected " + py_str(expected_revision) + ", current " + cp.revision);
      }
      if (TERMINAL().indexOf(cp.status) >= 0) return new CancellationResult(cp.status);
      this.store.request_cancel(run.tenant_id, run_id); /* blocks any future dispatch at the broker */
      const token = this.store.acquire_lease(run.tenant_id, run_id, worker_id, this.clock(), this.lease_ttl);
      if (token === null) return new CancellationResult("CANCEL_REQUESTED", [], ["another worker holds the lease"]);
      const fresh_run = this.store.get_run(run.tenant_id, run_id);
      const pkg = this.package(cp.artifact_hash);
      const initiator = this.policy.authenticate(run.principal);
      const res = this._finish_cancel(fresh_run, cp, pkg, initiator, token);
      const disclosed = this.store.receipts(run.tenant_id, { run_id })
        .filter((r) => r.dispatch_state === "SUCCEEDED" && this._is_write(r.tool))
        .map((r) => ({ logical_action_id: r.logical_action_id, tool: r.tool, external_ref: r.external_ref,
          certainty: r.certainty }));
      return new CancellationResult(res.status, disclosed, this._unresolved(run.tenant_id, run_id));
    }

    /** Reconcile every in-flight write without authorizing any retry. A write the reconciler proves absent is
     *  resolved as no-effect by the broker; one it finds is recorded as reconciled. */
    _reconcile_unresolved(run, cp, pkg, initiator, token, why, during) {
      const tenant = run.tenant_id, run_id = run.run_id;
      const unresolved = new Set(this._unresolved(tenant, run_id).map((u) => u.split(":")[0]));
      for (const intent of this.store.intents(tenant, run_id)) {
        if (!unresolved.has(intent.logical_action_id) || this._spec(intent.tool) === null) continue;
        const res = this.broker.reconcile({ intent, principal: initiator, package: pkg,
          business_unit: get(cp.variables, "business_unit"), approval_check: () => [false, why], lease_token: token,
          subject_values: {} });
        if (res.reason.startsWith("STALE_LEASE")) throw new RunError("STALE_LEASE", "worker no longer owns this run");
        const now_it = this.store.intent(tenant, intent.logical_action_id);
        if (res.status === "SUCCEEDED" || get(now_it || {}, "status") === "ABANDONED") {
          this._metrics().resolved.push(intent.logical_action_id);
        }
        this.store.append_events(tenant, run_id, [{ type: "RECONCILED", logical_action_id: intent.logical_action_id,
          status: res.status, reason: res.reason, during }], this.clock());
      }
    }

    _finish_cancel(run, cp, pkg, initiator, token) {
      const tenant = run.tenant_id, run_id = run.run_id;
      this._reconcile_unresolved(run, cp, pkg, initiator, token, "run cancelled", "cancellation");
      const unresolved = this._unresolved(tenant, run_id);
      if (unresolved.length) {
        this.store.set_run_status(tenant, run_id, "RECONCILING");
        return new StepResult(cp, "RECONCILING", "cancellation pending: unresolved external effects " + repr(unresolved));
      }
      const effects = this.store.receipts(tenant, { run_id }).filter((r) => r.dispatch_state === "SUCCEEDED" &&
        this._is_write(r.tool));
      const msg = "cancelled" + (effects.length ? "; completed external effects disclosed: " +
        repr(effects.map((e) => e.external_ref)) : "");
      return this._stop(run, cp, token, "CANCELLED", "CANCELLED", msg);
    }

    /* ---- human resolution of uncertain effects --------------------------------------------------------------- */
    /** Record a human's resolution of an in-flight write whose effect is unknown. ``outcome`` is "absent" (the effect
     *  did not happen: the intent is closed as no-effect) or "present" (it happened: ``output`` is the connector result
     *  the human observed, validated against the tool's output schema). Only holders of the deployment policy's
     *  approver role may resolve. Python's keyword arguments ``output``/``note`` are the options object. */
    resolve_effect(run_id, logical_action_id, outcome, principal, opts) {
      const o = opts === undefined || opts === null ? {} : opts;
      if (!HX.util.is_plain_object(o)) throw pyerr("TypeError", "resolve_effect() takes {output, note} as an options object");
      for (const k of Object.keys(o)) {
        if (k !== "output" && k !== "note") throw pyerr("TypeError", "resolve_effect() got an unexpected keyword argument '" + k + "'");
      }
      const output = o.output === undefined ? null : o.output;
      const note = o.note === undefined ? "" : o.note;
      const run = this._run(run_id, principal);
      const tenant = run.tenant_id;
      const entry = get(this.policy.doc.principals, principal.id, {});
      if (principal.roles.indexOf(this.policy.doc.approver_role) < 0 || get(entry, "tenant_id") !== tenant) {
        throw new RunError("NOT_AUTHORIZED", "only an approver may record the resolution of an external effect");
      }
      const intent = this.store.intent(tenant, logical_action_id);
      if (intent === null || intent.run_id !== run_id) throw new RunError("NOT_FOUND", "action " + py_str(logical_action_id));
      if (intent.status !== "DISPATCHING" && intent.status !== "UNKNOWN_EFFECT") {
        throw new RunError("NOT_UNRESOLVED", "action is " + py_str(intent.status));
      }
      const spec = this._spec(intent.tool);
      /* Only writes carry an external effect a human can attest to. Reads, pure tools and verifiers are safely
         re-dispatched on recovery and must never take a human-supplied result as their output. A tool retired from
         the catalog may only be resolved as "absent". */
      if (spec === null) {
        if (outcome !== "absent") throw new RunError("UNKNOWN_TOOL", py_str(intent.tool));
      } else if (!HX.catalog.is_write(spec)) {
        throw new RunError("NOT_A_WRITE", py_str(intent.tool) + " has no external effect to resolve; it is re-run");
      }
      let state, certainty, result, ext;
      if (outcome === "present") {
        const errs = HX.broker._validate_against(spec.output_schema, output);
        if (errs.length) throw new RunError("RESPONSE_INVALID", errs.slice(0, 3).join("; "));
        state = "SUCCEEDED"; certainty = "human_resolved"; result = output;
        ext = HX.util.is_plain_object(output) ? (truthy(get(output, "draft_id")) ? output.draft_id : get(output, "receipt_id")) : null;
      } else if (outcome === "absent") {
        state = "ABANDONED"; certainty = "no_effect"; result = { note }; ext = null;
      } else {
        throw new RunError("RESPONSE_INVALID", "outcome must be 'present' or 'absent'");
      }
      /* Conditional on the intent still being unresolved (atomic with the receipt), so a concurrent reconciliation by
         a worker can never be overwritten. */
      const seq = this.store.record_outcome(tenant, logical_action_id, run_id, intent.tool, intent.tool_version,
        intent.args_digest, intent.idempotency_key, state, certainty, ext, result, "human:" + principal.id, this.clock(),
        { intent_status: state, expect_status: ["DISPATCHING", "UNKNOWN_EFFECT"] });
      if (seq === null) throw new RunError("CONFLICT", "the action changed concurrently; re-inspect and retry");
      const ref = logical_action_id + "#" + seq;
      this.store.append_events(tenant, run_id, [{ type: "EFFECT_RESOLVED", logical_action_id, outcome,
        resolver: principal.id, note, receipt_ref: ref }], this.clock());
      return { logical_action_id, status: state, receipt_ref: ref };
    }

    /* ---- inspection --------------------------------------------------------------------------------------------- */
    inspect_run(run_id, principal) {
      const run = this._run(run_id, principal);
      const tenant = run.tenant_id;
      const cp = this._cp(tenant, run_id);
      return {
        run, checkpoint: cp, outcome: clone(cp.outcome), assurance: clone(cp.assurance),
        path: this.store.events(tenant, run_id).filter((e) => e.type === "TRANSITION").map((e) => e.from + "->" + e.to),
        events: this.store.events(tenant, run_id),
        action_intents: this.store.intents(tenant, run_id).map((i) => {
          const out = {};
          for (const k of Object.keys(i)) if (k !== "args") out[k] = i[k];
          return out;
        }),
        action_receipts: this.store.receipts(tenant, { run_id }),
        evidence: this.store.evidence(tenant, run_id),
      };
    }
  }
  service.RunService = RunService;

  /** Terminal-time freshness check: re-read the persisted subject through the broker (read-only, recorded) and
   *  require the same version and payload digest as the verified receipt. */
  service.erp_freshness = function erp_freshness(read_tool) {
    if (read_tool === undefined) read_tool = "erp.read_draft";
    return function check(svc, run, cp, pkg, initiator, lease_token) {
      if (HX.util.is_plain_object(lease_token)) lease_token = lease_token.lease_token;
      if (lease_token === undefined) lease_token = null;
      const spec = HX.catalog.get(svc.catalog, read_tool);
      const args = { draft_id: item(cp.variables, "erp_draft_id") };
      const ad = HX.canonical.digest(args);
      const tenant = run.tenant_id;
      /* Every terminal-time check is a NEW logical action (per-attempt nonce): it is never deduplicated against a
         read made before a crash or a failed commit, so it always reads the ERP again. No intent row is kept. */
      const lid = HX.approvals.logical_action_id(cp.run_id, cp.state_id + "#freshness#" + svc._hex(), cp.revision, ad);
      if (spec === null) throw pyerr("AttributeError", "'NoneType' object has no attribute 'name'");
      const intent = { tenant_id: tenant, run_id: run.run_id, logical_action_id: lid, state_id: cp.state_id,
        revision: cp.revision, tool: spec.name, tool_version: spec.version, args, args_digest: ad,
        idempotency_key: HX.approvals.idempotency_key(tenant, lid), status: "PENDING", lease_token, attempts: 0 };
      const res = svc.broker.dispatch({ intent, principal: initiator, package: pkg,
        business_unit: get(cp.variables, "business_unit"), approval_check: () => [true, ""], lease_token,
        subject_values: {} });
      if (res.status === "DENIED" && res.reason.startsWith("STALE_LEASE")) {
        throw new RunError("STALE_LEASE", "worker no longer owns this run");
      }
      if (res.status !== "SUCCEEDED" || get(res.output, "status") !== "found") {
        return [false, "persisted draft unavailable at terminal admission"];
      }
      if (!HX.policy._py_eq(item(res.output, "version"), get(cp.variables, "persisted_version"))) {
        return [false, "persisted draft changed (version " + py_str(get(cp.variables, "persisted_version")) + " -> " +
          py_str(res.output.version) + ")"];
      }
      if (HX.canonical.digest(item(res.output, "draft")) !== get(cp.variables, "draft_digest")) {
        return [false, "persisted payload no longer matches approved digest"];
      }
      return [true, ""];
    };
  };

  service.subject_digest_values = function (values, names) { return HX.evidence.subject_of(values, names); };
})(globalThis.HX = globalThis.HX || {});
