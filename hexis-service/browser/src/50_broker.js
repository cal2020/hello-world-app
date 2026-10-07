/* Port of hexis_service/tools/broker.py (+ tools/errors.py): the only path to external effects.
 *
 * Immediately before every dispatch the broker independently re-checks worker fencing, cancellation, input
 * schema, tenant, capability ceiling ∩ principal permissions, approval scope (for approval-gated capabilities)
 * and evidence validity. It never trusts a model's or machine's claim that authorization, approval or
 * verification occurred.
 *
 * API (Python keyword arguments become one options object):
 *   new ToolBroker(store, catalog, policy, connectors, reconcilers = {}, clock = Date.now()/1000, faults, timer)
 *     (the trailing parameters may also be given as one options object {reconcilers, clock, faults, timer})
 *   broker.dispatch({intent, principal, package, business_unit, approval_check, lease_token, subject_values,
 *                    transport_retries = 2}) -> BrokerResult
 *   broker.reconcile({...same...}) -> BrokerResult
 *   broker.authorize({intent, spec, principal, package, business_unit, approval_check, lease_token}) -> [ok, why]
 *   broker.take_timings() -> [{tool, tool_version, op, attempt, latency_s, outcome}]
 *   ``approval_check`` is a function returning ``[ok, why]`` (a Python tuple).
 *
 * ``catalog`` is a normalized ToolCatalog dump (HX.catalog.load_catalog), ``package`` a normalized
 * MachinePackage dump, ``policy`` an HX.policy.PolicyService, ``store`` an HX.store.Store. Connectors and
 * reconcilers are plain objects mapping tool names to functions ``(args, ctx) -> output``.
 *
 * ``SimulatedCrash`` (Python: a BaseException) extends HX.HXError; no handler in the engine swallows it.
 */
(function (HX) {
  "use strict";
  const broker = (HX.broker = HX.broker || {});
  const errors = (HX.errors = HX.errors || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  /* ---- tools/errors.py (shared with 55_fakes; defined idempotently with the same shape) ---------------- */
  if (!errors.ToolTimeout) {
    /** Transport timeout; after dispatch of a write this means the effect is UNKNOWN. */
    errors.ToolTimeout = class ToolTimeout extends HX.HXError {
      constructor(message) {
        const m = message === undefined ? "" : String(message);
        super("TOOL_TIMEOUT", m);
        this.message = m;
      }
    };
  }
  if (!errors.ToolFailure) {
    /** Connector reported a failure. */
    errors.ToolFailure = class ToolFailure extends HX.HXError {
      constructor(message) {
        const m = message === undefined ? "" : String(message);
        super("TOOL_FAILURE", m);
        this.message = m;
      }
    };
  }
  broker.ToolTimeout = errors.ToolTimeout;
  broker.ToolFailure = errors.ToolFailure;

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }
  broker._pyerr = pyerr;

  const repr = (v) => (HX.kernel && HX.kernel._py_repr ? HX.kernel._py_repr(v) : HX.util.py_repr(v));
  /** Python ``str(v)`` of a JSON value. */
  function py_str(v) {
    if (typeof v === "string") return v;
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return HX.canonical.py_number(v);
    return repr(v);
  }
  broker._py_str = py_str;
  function truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  broker._truthy = truthy;
  /** Python ``d[k]`` (KeyError when missing). */
  function item(d, k) {
    if (hasOwn(d, k)) return d[k];
    throw pyerr("KeyError", repr(k));
  }
  /** Python ``d.get(k)`` on a dict (None when missing or not a dict-like value). */
  function get(d, k, dflt) {
    if (hasOwn(d, k)) return d[k];
    return dflt === undefined ? null : dflt;
  }
  broker._item = item;
  broker._get = get;

  /** True for SimulatedCrash: catch-all handlers in the port must rethrow it (Python BaseException). */
  broker.is_crash = (e) => e instanceof SimulatedCrash;

  /* ---- fault injection --------------------------------------------------------------------------------- */
  /** Process death at an injected boundary (Python: BaseException, so it is never swallowed). */
  class SimulatedCrash extends HX.HXError {
    constructor(point) {
      const p = point === undefined ? "" : String(point);
      super("SIMULATED_CRASH", p);
      this.point = p;
      this.message = p; /* Python: str(exc) */
    }
    toString() { return this.message; }
  }
  broker.SimulatedCrash = SimulatedCrash;

  class FaultInjector {
    constructor() { this.armed = new Set(); }
    arm(...points) {
      for (const p of points) {
        if (FaultInjector.POINTS.indexOf(p) < 0) throw pyerr("AssertionError", String(p));
        this.armed.add(p);
      }
    }
    hit(point) {
      if (this.armed.has(point)) {
        this.armed.delete(point);
        throw new SimulatedCrash(point);
      }
    }
  }
  FaultInjector.POINTS = Object.freeze(["after_intent", "before_dispatch", "after_remote_call", "after_receipt",
    "before_commit"]);
  broker.FaultInjector = FaultInjector;

  /** ``BrokerResult(status, output=None, reason="", receipt_ref="", certainty="", evidence=[])``;
   *  status: SUCCEEDED | DENIED | UNKNOWN_EFFECT | FAILED | NEEDS_RESOLUTION */
  class BrokerResult {
    constructor(status, output, reason, receipt_ref, certainty, evidence) {
      this.status = status;
      this.output = output === undefined ? null : output;
      this.reason = reason === undefined ? "" : reason;
      this.receipt_ref = receipt_ref === undefined ? "" : receipt_ref;
      this.certainty = certainty === undefined ? "" : certainty;
      this.evidence = evidence === undefined ? [] : evidence;
    }
    toJSON() {
      return { status: this.status, output: this.output, reason: this.reason, receipt_ref: this.receipt_ref,
        certainty: this.certainty, evidence: this.evidence };
    }
  }
  broker.BrokerResult = BrokerResult;

  /* Intent statuses a broker denial may overwrite. DISPATCHING / UNKNOWN_EFFECT / SUCCEEDED never are. */
  const DENIABLE = Object.freeze(["PENDING", "DENIED", "FAILED", "ABANDONED"]);
  broker._DENIABLE = DENIABLE;

  /** Every ``business_unit`` value named anywhere in a tool's arguments (a Set). */
  function business_units_in(value) {
    const found = new Set();
    if (HX.util.is_plain_object(value) || (value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === null)) {
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (k === "business_unit" && typeof v === "string") found.add(v);
        else for (const x of business_units_in(v)) found.add(x);
      }
    } else if (Array.isArray(value)) {
      for (const v of value) for (const x of business_units_in(v)) found.add(x);
    }
    return found;
  }
  broker._business_units_in = business_units_in;

  broker.args_digest = function (args) { return HX.canonical.digest(args); };

  /** Python-jsonschema verdicts through the catalog validator. Where HX.jsonschema accepts a value that the
   *  kernel's exact checker (Python regex semantics, exact multipleOf) rejects, the kernel's errors are used,
   *  so the broker is never more permissive than Python. */
  function validate_against(schema, value) {
    const errs = HX.catalog.validate_against(schema, value);
    if (errs.length) return py_error_order(schema, value, errs);
    if (!HX.kernel || !HX.kernel._schema_errors) return errs;
    return HX.kernel._schema_errors(schema, value);
  }

  /* python-jsonschema's error order. ``Draft202012Validator.iter_errors`` visits a schema's keywords in the
   * schema's own key order (``properties`` in its property order, ``patternProperties`` per pattern, then per
   * instance key), ``validate_against`` stable-sorts the errors by path, and ``additionalProperties: false`` names
   * the extra keys sorted (``sorted(extras, key=str)``). HX.jsonschema uses a fixed keyword order and lists extras in
   * instance order. This walker re-derives the same errors in Python's order: structural keywords are walked here,
   * every other keyword is checked alone through HX.catalog.validate_against, so the messages are HX.jsonschema's.
   * It never changes a verdict: unless its errors (with extras in instance order) are exactly HX.jsonschema's,
   * as a multiset, HX.jsonschema's list is returned unchanged. */
  const STRUCTURAL = new Set(["properties", "patternProperties", "additionalProperties", "items", "allOf"]);
  function py_order_walk(schema, value, path, out) {
    const R = (v) => HX.util.py_repr(v);
    if (schema === true) return;
    if (schema === false) { out.push([path, "False schema does not allow " + R(value), null]); return; }
    if (!HX.util.is_plain_object(schema)) { out.push([path, "invalid schema", null]); return; }
    const obj = HX.util.is_plain_object(value);
    const props = HX.util.is_plain_object(schema.properties) ? schema.properties : {};
    const pprops = HX.util.is_plain_object(schema.patternProperties) ? schema.patternProperties : {};
    const pattern = (p) => { try { return new RegExp(p, "u"); } catch (e) { return null; } };
    for (const kw of Object.keys(schema)) {
      const sub = schema[kw];
      if (!STRUCTURAL.has(kw)) {
        const one = {};
        Object.defineProperty(one, kw, { value: sub, enumerable: true, writable: true, configurable: true });
        for (const e of HX.catalog.validate_against(one, value)) {
          if (!e.startsWith("<root>: ")) throw new Error("unexpected nested error " + e);
          out.push([path, e.slice(8), null]);
        }
      } else if (kw === "properties") {
        if (obj) for (const k of Object.keys(props)) if (hasOwn(value, k)) py_order_walk(props[k], value[k], path.concat([k]), out);
      } else if (kw === "patternProperties") {
        if (obj) {
          for (const p of Object.keys(pprops)) {
            const re = pattern(p);
            if (re) for (const k of Object.keys(value)) if (re.test(k)) py_order_walk(pprops[p], value[k], path.concat([k]), out);
          }
        }
      } else if (kw === "additionalProperties") {
        if (!obj) continue;
        const extras = Object.keys(value).filter((k) => !hasOwn(props, k) &&
          !Object.keys(pprops).some((p) => { const re = pattern(p); return re !== null && re.test(k); }));
        if (!extras.length) continue;
        if (sub === false) {
          const msg = (ks) => "Additional properties are not allowed (" + ks.map(R).join(", ") +
            (ks.length === 1 ? " was" : " were") + " unexpected)";
          out.push([path, msg(extras.slice().sort(cmp)), msg(extras)]);
        } else if (sub !== true) {
          for (const k of extras) py_order_walk(sub, value[k], path.concat([k]), out);
        }
      } else if (kw === "items") {
        if (Array.isArray(value)) value.forEach((x, i) => py_order_walk(sub, x, path.concat([i]), out));
      } else if (kw === "allOf") {
        if (Array.isArray(sub)) sub.forEach((b) => py_order_walk(b, value, path, out));
      }
    }
  }
  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  function py_error_order(schema, value, js_errs) {
    const out = [];
    try { py_order_walk(schema, value, [], out); } catch (e) {
      if (e instanceof HX.HXError) throw e;
      return js_errs;
    }
    const key = (p) => p.map((x) => (typeof x === "number" ? "#" + String(x).padStart(12, "0") : "$" + x)).join("\u0000");
    const keyed = out.map((e, i) => [key(e[0]), i, e]);
    keyed.sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]);
    const fmt = (p, m) => (p.length ? p.map(String).join("/") : "<root>") + ": " + m;
    const as_js = keyed.map(([, , e]) => fmt(e[0], e[2] === null ? e[1] : e[2])).sort(cmp);
    const want = js_errs.slice().sort(cmp);
    if (as_js.length !== want.length || as_js.some((m, i) => m !== want[i])) return js_errs;
    return keyed.map(([, , e]) => fmt(e[0], e[1]));
  }
  broker._py_error_order = py_error_order;
  broker._validate_against = validate_against;

  function default_clock() { return Date.now() / 1000; }
  function default_timer() {
    const p = globalThis.performance;
    return p && typeof p.now === "function" ? p.now() / 1000 : Date.now() / 1000;
  }
  broker._default_clock = default_clock;
  broker._default_timer = default_timer;

  const TRAILING = ["reconcilers", "clock", "faults", "timer"];

  /** Keyword arguments as one object: unknown keys and missing required keys are TypeErrors (Python). */
  function kw(fn, obj, required, optional) {
    if (!HX.util.is_plain_object(obj)) throw pyerr("TypeError", fn + "() takes keyword arguments as an object");
    for (const k of Object.keys(obj)) {
      if (required.indexOf(k) < 0 && optional.indexOf(k) < 0) {
        throw pyerr("TypeError", fn + "() got an unexpected keyword argument '" + k + "'");
      }
    }
    const missing = required.filter((k) => !hasOwn(obj, k) || obj[k] === undefined);
    if (missing.length) {
      throw pyerr("TypeError", fn + "() missing " + missing.length + " required keyword-only argument" +
        (missing.length > 1 ? "s" : "") + ": " + missing.map((m) => "'" + m + "'").join(", "));
    }
    return obj;
  }
  broker._kw = kw;
  const DISPATCH_KW = ["intent", "principal", "package", "business_unit", "approval_check", "lease_token",
    "subject_values"];

  class ToolBroker {
    constructor(store, catalog, policy, connectors, reconcilers, clock, faults, timer) {
      if (HX.util.is_plain_object(reconcilers) && clock === undefined && Object.keys(reconcilers).length &&
        Object.keys(reconcilers).every((k) => TRAILING.indexOf(k) >= 0)) {
        ({ reconcilers, clock, faults, timer } = reconcilers);
      }
      this.store = store;
      this.catalog = catalog;
      this.policy = policy;
      this.connectors = connectors;
      this.reconcilers = truthy(reconcilers) ? reconcilers : {};
      this.clock = clock || default_clock;
      /* Monotonic timer for latency metrics only; never used for expiry/leases and never recorded in
         observations, receipts or checkpoints (see metrics). */
      this.timer = timer || default_timer;
      this.faults = faults || new FaultInjector();
      this._timings_buf = [];
    }

    _spec(name) { return HX.catalog.get(this.catalog, name); }

    /* ---- latency instrumentation (drained by RunService after each step) ------------------------------- */
    _timings() { return this._timings_buf; }

    /** Return and clear the connector/reconciler call timings recorded so far. */
    take_timings() {
      const out = this._timings_buf.slice();
      this._timings_buf.length = 0;
      return out;
    }

    _timed(spec, op, attempt, fn) {
      const t0 = this.timer();
      let outcome = "error";
      try {
        const out = fn();
        outcome = "ok";
        return out;
      } catch (e) {
        if (e instanceof errors.ToolTimeout) outcome = "timeout";
        else if (e instanceof errors.ToolFailure) outcome = "failure";
        throw e;
      } finally {
        this._timings().push({ tool: spec.name, tool_version: spec.version, op, attempt,
          latency_s: this.timer() - t0, outcome });
      }
    }

    _connector(table, name) {
      if (hasOwn(table, name) || (table && typeof table === "object" && Object.getPrototypeOf(table) === null && name in table)) {
        return table[name];
      }
      throw pyerr("KeyError", repr(name));
    }

    /* ---------------------------------------------------------------------------------------------------- */
    authorize(o) {
      const a = kw("authorize", o, ["intent", "spec", "principal", "package", "business_unit", "approval_check",
        "lease_token"], []);
      const intent = a.intent, spec = a.spec, principal = a.principal;
      const tenant = item(intent, "tenant_id");
      const lease_token = a.lease_token === undefined ? null : a.lease_token;
      if (lease_token !== null && !HX.policy._py_eq(this.store.lease_token(tenant, item(intent, "run_id")), lease_token)) {
        return [false, "STALE_LEASE"];
      }
      const run = this.store.get_run(tenant, item(intent, "run_id"));
      if (run === null || run.tenant_id !== principal.tenant_id) return [false, "TENANT_SCOPE"];
      const is_write = HX.catalog.is_write(spec);
      if (run.cancel_requested && is_write) return [false, "RUN_CANCELLED"];
      if (this.store.is_revoked(run.artifact_hash) && is_write) return [false, "ARTIFACT_REVOKED"];
      if (spec.version !== item(intent, "tool_version")) return [false, "TOOL_VERSION_CHANGED"];
      const errs = validate_against(spec.input_schema, item(intent, "args"));
      if (errs.length) return [false, "INPUT_SCHEMA: " + errs.slice(0, 3).join("; ")];
      /* The business unit the effect actually targets is the one in the arguments, not only the run's task
         variable: every business unit named in the arguments must be the run's scoped unit. */
      const business_unit = a.business_unit === undefined ? null : a.business_unit;
      const targeted = Array.from(business_units_in(item(intent, "args"))).sort(HX.util.cmp_codepoints);
      const foreign = targeted.filter((b) => b !== business_unit);
      if (foreign.length) {
        return [false, "POLICY_DENY: tool arguments target business unit(s) " + repr(foreign) +
          " outside the run's scoped business unit " + py_str(business_unit)];
      }
      const d = this.policy.evaluate_dispatch(principal, tenant, spec.capability,
        a.package.execution_policy.capability_ceiling, business_unit);
      if (!d.allowed) return [false, "POLICY_" + d.outcome + ": " + d.reasons.join("; ")];
      if (this.policy.requires_approval(spec.capability)) {
        const [ok, why] = a.approval_check();
        if (!ok) return [false, "APPROVAL_INVALID: " + why];
      }
      return [true, ""];
    }

    dispatch(o) {
      const a = kw("dispatch", o, DISPATCH_KW, ["transport_retries"]);
      let intent = a.intent;
      const transport_retries = a.transport_retries === undefined ? 2 : a.transport_retries;
      const lease_token = a.lease_token === undefined ? null : a.lease_token;
      const tenant = item(intent, "tenant_id"), lid = item(intent, "logical_action_id");
      const spec = this._spec(item(intent, "tool"));
      if (spec === null) return new BrokerResult("DENIED", null, "UNKNOWN_TOOL");
      /* Never trust the caller's snapshot of the intent: another worker may have moved it on. */
      const stored = this.store.intent(tenant, lid);
      if (stored !== null) intent = Object.assign({}, intent, { status: stored.status, attempts: stored.attempts });
      const prior = this.store.receipts(tenant, lid);
      const done = prior.filter((r) => r.dispatch_state === "SUCCEEDED");
      if (done.length) { /* deduplicate repeated delivery of the same logical action */
        const r = done[done.length - 1];
        if (stored !== null && stored.status !== "SUCCEEDED") {
          /* Receipts are authoritative: repair an intent left behind by an interrupted update. */
          this.store.update_intent(tenant, lid, "SUCCEEDED", this.clock());
        }
        const evidence = this._recover_evidence(intent, spec, r, a.subject_values);
        return new BrokerResult("SUCCEEDED", r.result, "deduplicated", lid + "#" + r.seq, r.certainty, evidence);
      }
      const status = item(intent, "status");
      if (status === "DISPATCHING" || status === "UNKNOWN_EFFECT") {
        return this.reconcile({ intent, principal: a.principal, package: a.package, business_unit: a.business_unit,
          approval_check: a.approval_check, lease_token, subject_values: a.subject_values, transport_retries });
      }
      const [ok, why] = this.authorize({ intent, spec, principal: a.principal, package: a.package,
        business_unit: a.business_unit, approval_check: a.approval_check, lease_token });
      if (!ok) {
        if (why === "STALE_LEASE") return new BrokerResult("DENIED", null, why); /* a fenced-off worker must not touch the ledger */
        const seq = this.store.record_outcome(tenant, lid, item(intent, "run_id"), spec.name, spec.version,
          item(intent, "args_digest"), item(intent, "idempotency_key"), "DENIED", "no_effect", null, { reason: why },
          "broker", this.clock(), { intent_status: stored !== null ? "DENIED" : null, require_token: lease_token,
            expect_status: stored !== null ? DENIABLE.slice() : null });
        if (seq === null) return new BrokerResult("DENIED", null, "STALE_LEASE: intent changed concurrently");
        return new BrokerResult("DENIED", null, why);
      }
      return this._call(intent, spec, a.subject_values, transport_retries, lease_token);
    }

    _call(intent, spec, subject_values, retries, lease_token, op) {
      op = op === undefined ? "dispatch" : op;
      const tenant = item(intent, "tenant_id"), lid = item(intent, "logical_action_id");
      const ctx = { tenant_id: tenant, idempotency_key: item(intent, "idempotency_key"), logical_action_id: lid };
      let attempts = 0;
      for (;;) {
        attempts += 1;
        this.faults.hit("before_dispatch");
        /* Fencing is enforced again atomically with the DISPATCHING transition. */
        this.store.update_intent(tenant, lid, "DISPATCHING", this.clock(), { bump_attempt: true,
          require_token: lease_token, run_id: item(intent, "run_id") });
        let out;
        try {
          const fn = this._connector(this.connectors, spec.name);
          out = this._timed(spec, op, attempts, () => fn(item(intent, "args"), ctx));
        } catch (exc) {
          if (exc instanceof errors.ToolTimeout) {
            const ro = spec.effect === "read" || spec.effect === "pure";
            if (ro && attempts <= retries) continue; /* transport retry of the same read-only operation */
            if (ro) {
              this._receipt(intent, spec, "FAILED", "no_effect", null, { error: exc.message }, "FAILED");
              return new BrokerResult("FAILED", null, "TIMEOUT: " + exc.message);
            }
            this._receipt(intent, spec, "UNKNOWN_EFFECT", "unknown", null, { error: exc.message }, "UNKNOWN_EFFECT");
            return new BrokerResult("UNKNOWN_EFFECT", null, "TIMEOUT_AFTER_DISPATCH: " + exc.message);
          }
          if (exc instanceof errors.ToolFailure) {
            const w = HX.catalog.is_write(spec);
            const certainty = !w ? "no_effect" : "unknown";
            const state = !w ? "FAILED" : "UNKNOWN_EFFECT";
            this._receipt(intent, spec, state, certainty, null, { error: exc.message }, state);
            return new BrokerResult(state, null, "TOOL_FAILURE: " + exc.message);
          }
          throw exc;
        }
        this.faults.hit("after_remote_call");
        return this._accept(intent, spec, out, "certain", subject_values);
      }
    }

    /** Append a receipt and (atomically) move the intent to ``intent_status`` / issue evidence. */
    _receipt(intent, spec, state, certainty, ext, result, intent_status, evidence) {
      const seq = this.store.record_outcome(item(intent, "tenant_id"), item(intent, "logical_action_id"),
        item(intent, "run_id"), spec.name, spec.version, item(intent, "args_digest"), item(intent, "idempotency_key"),
        state, certainty, ext, result, "connector:" + spec.name + "@" + spec.version, this.clock(),
        { intent_status: intent_status === undefined ? null : intent_status, evidence: evidence || null });
      if (seq === null) throw pyerr("AssertionError", "");
      return seq;
    }

    _evidence_for(intent, spec, out, seq, subject_values, observed_at) {
      if (!truthy(spec.verifier_claims) || !HX.util.is_plain_object(out)) return [];
      const names = Object.keys(subject_values).sort(HX.util.cmp_codepoints);
      const subj = HX.evidence.subject_of(subject_values, names);
      return spec.verifier_claims.map((claim) => HX.evidence.make_receipt(item(intent, "run_id"), claim, spec.name,
        spec.version, subj, py_str(get(out, "status")), item(intent, "logical_action_id") + "#" + seq, observed_at,
        get(out, "receipt_id")));
    }

    /** Evidence is derived from the SUCCEEDED receipt; re-issue it (idempotently) if it is missing, e.g. after a
     *  crash of a process that stored the receipt under an older, non-atomic layout. */
    _recover_evidence(intent, spec, receipt, subject_values) {
      if (!truthy(spec.verifier_claims) || !truthy(subject_values)) return [];
      const ref = item(intent, "logical_action_id") + "#" + receipt.seq;
      const have = this.store.evidence(item(intent, "tenant_id"), item(intent, "run_id")).filter((e) => e.source_ref === ref);
      if (have.length) return have;
      const recs = this._evidence_for(intent, spec, receipt.result, receipt.seq, subject_values, receipt.created_at);
      for (const rec of recs) this.store.add_evidence(item(intent, "tenant_id"), rec);
      return recs;
    }

    _accept(intent, spec, out, certainty, subject_values) {
      const lid = item(intent, "logical_action_id");
      const errs = validate_against(spec.output_schema, out);
      if (errs.length) { /* spoofed / malformed connector output never reaches machine variables */
        const w = HX.catalog.is_write(spec);
        const state = w ? "UNKNOWN_EFFECT" : "FAILED";
        this._receipt(intent, spec, state, w ? "unknown" : "no_effect", null, { invalid_output: errs.slice(0, 3) }, state);
        return new BrokerResult(state, null, "OUTPUT_SCHEMA: " + errs.slice(0, 3).join("; "));
      }
      let ext = null;
      if (HX.util.is_plain_object(out)) {
        ext = truthy(get(out, "draft_id")) ? out.draft_id : get(out, "receipt_id");
      }
      const now = this.clock();
      const issued = [];
      const evidence = (seq) => {
        issued.push(...this._evidence_for(intent, spec, out, seq, subject_values, now));
        return issued;
      };
      /* Receipt, intent status and evidence are one transaction: a crash leaves all or none of them. */
      const seq = this._receipt(intent, spec, "SUCCEEDED", certainty, ext, out, "SUCCEEDED", evidence);
      this.faults.hit("after_receipt");
      return new BrokerResult("SUCCEEDED", out, "", lid + "#" + seq, certainty, issued);
    }

    /* ---------------------------------------------------------------------------------------------------- */
    /** Resolve a dispatched action whose outcome is unknown. Never blindly repeats a non-idempotent write. */
    reconcile(o) {
      const a = kw("reconcile", o, DISPATCH_KW, ["transport_retries"]);
      const intent = a.intent;
      const transport_retries = a.transport_retries === undefined ? 2 : a.transport_retries;
      const lease_token = a.lease_token === undefined ? null : a.lease_token;
      const tenant = item(intent, "tenant_id"), lid = item(intent, "logical_action_id");
      const spec = this._spec(item(intent, "tool"));
      if (spec === null) {
        return new BrokerResult("NEEDS_RESOLUTION", null, "tool " + py_str(intent.tool) +
          " is not in the current catalog; cannot reconcile automatically");
      }
      const ctx = { tenant_id: tenant, idempotency_key: item(intent, "idempotency_key"), logical_action_id: lid };
      const auth = () => this.authorize({ intent, spec, principal: a.principal, package: a.package,
        business_unit: a.business_unit, approval_check: a.approval_check, lease_token });
      if (spec.effect === "read" || spec.effect === "pure") {
        /* No external effect to reconcile: safe to (re)dispatch under full authorization. */
        this.store.update_intent(tenant, lid, "PENDING", this.clock(), { require_token: lease_token,
          run_id: item(intent, "run_id") });
        const [ok, why] = auth();
        if (!ok) return new BrokerResult("DENIED", null, why);
        return this._call(Object.assign({}, intent, { status: "PENDING" }), spec, a.subject_values, transport_retries,
          lease_token, "redispatch");
      }
      let proven_absent = false;
      if (spec.effect === "reconciliable_write" && hasOwn(this.reconcilers, spec.name)) {
        const fn = this.reconcilers[spec.name];
        const found = this._timed(spec, "reconcile", 1, () => fn(item(intent, "args"), ctx));
        if (found !== null && found !== undefined) return this._accept(intent, spec, found, "reconciled", a.subject_values);
        /* Proven absent by business-reference lookup: a retry with the same key is safe, but only under a fresh
           authorization/approval check. */
        proven_absent = true;
      } else if (spec.effect === "idempotent_write") {
        /* retry with same key and identical arguments */
      } else {
        this.store.update_intent(tenant, lid, "UNKNOWN_EFFECT", this.clock(),
          { expect_status: ["DISPATCHING", "UNKNOWN_EFFECT"] });
        return new BrokerResult("NEEDS_RESOLUTION", null,
          "non-idempotent write with unknown effect: human resolution required; no automatic retry");
      }
      const [ok, why] = auth();
      if (!ok) {
        if (proven_absent && why !== "STALE_LEASE") {
          /* The effect provably did not happen and will not be retried (cancelled, revoked, denied): resolve it as
             no-effect so it is not reported as unresolved forever. */
          this.store.record_outcome(tenant, lid, item(intent, "run_id"), spec.name, spec.version,
            item(intent, "args_digest"), item(intent, "idempotency_key"), "ABANDONED", "no_effect", null,
            { reason: "proven absent by business-reference lookup; retry not authorized: " + why }, "broker:reconcile",
            this.clock(), { intent_status: "ABANDONED", require_token: lease_token,
              expect_status: ["DISPATCHING", "UNKNOWN_EFFECT"] });
        }
        return new BrokerResult("DENIED", null, why);
      }
      if (py_gt(item(intent, "attempts"), transport_retries)) {
        return new BrokerResult("NEEDS_RESOLUTION", null, "retry budget for uncertain write exhausted");
      }
      return this._call(intent, spec, a.subject_values, 0, lease_token, "redispatch");
    }
  }
  broker.ToolBroker = ToolBroker;

  function py_gt(a, b) {
    const num = (v) => (typeof v === "boolean" ? Number(v) : v);
    const x = num(a), y = num(b);
    if (typeof x !== "number" || typeof y !== "number") {
      throw pyerr("TypeError", "'>' not supported between instances of '" + (HX.kernel ? HX.kernel._py_type_name(a) : typeof a) +
        "' and '" + (HX.kernel ? HX.kernel._py_type_name(b) : typeof b) + "'");
    }
    return x > y;
  }
})(globalThis.HX = globalThis.HX || {});
