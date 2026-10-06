/* Port of hexis_service/runtime/kernel.py: the pure transition kernel (brief §7.1).
 *
 * ``advance`` performs no network access, model calls, storage writes, randomness or clock reads.
 * Everything external arrives inside a recorded Observation. Given the same checkpoint, observation and
 * package, it returns the same result.
 *
 * Data shapes:
 *  - RunCheckpoint, Observation, Budget and Assurance are plain objects with exactly the fields of
 *    ``model_dump(mode="json")`` (every default present, declaration order). Build them from untrusted
 *    data with ``new_checkpoint(fields)`` / ``new_observation(fields)`` (or ``RunCheckpoint.model_validate``),
 *    which apply pydantic's validation (extra="forbid", Literal kind/status, lax int coercions) and throw
 *    ``HX.kernel.ValidationError`` like ``pydantic.ValidationError``.
 *  - ``advance(checkpoint, obs, package)`` takes such dumps (Python takes the model instances) and a
 *    normalized package dump (``HX.pkg.normalize_package``). It never mutates its inputs: everything it
 *    returns is a fresh copy (Python copies with model_copy/deepcopy).
 *  - ``KernelResult`` is ``{checkpoint, events, delta, edge}``.
 *  - Python tuples become arrays: ``resolve_path`` returns ``[found, value]``, ``select_edge`` returns
 *    ``[index, error]``.
 *
 * Python built-in exceptions that escape the reference on malformed input (KeyError, TypeError,
 * AttributeError, ValueError) are ``HX.HXError`` with the Python class name as ``code``.
 */
(function (HX) {
  "use strict";
  const kernel = (HX.kernel = HX.kernel || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  kernel.STATUSES = Object.freeze(["READY", "RUNNING", "WAITING_FOR_INPUT", "WAITING_FOR_APPROVAL", "RECONCILING",
    "COMPLETED", "FAILED", "CANCELLED"]);
  kernel.TERMINAL_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED"]);
  kernel.OBSERVATION_KINDS = Object.freeze(["tool", "model", "judge", "user", "end"]);

  class KernelError extends HX.HXError {
    constructor(code, message, detail) {
      super(code, message, detail || {});
      this.message = message; /* Python: exc.message (str(exc) is "CODE: message") */
    }
    toString() { return this.code + ": " + this.message; }
  }
  kernel.KernelError = KernelError;

  /** pydantic.ValidationError for RunCheckpoint / Observation / Budget / Assurance. */
  class ValidationError extends HX.HXError {
    constructor(message, errors, model) {
      super("VALIDATION_ERROR", message, { errors: errors || [], model: model || "" });
      this.message = message;
      this.errors = errors || [];
      this.model = model || "";
    }
  }
  kernel.ValidationError = ValidationError;

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }
  kernel._pyerr = pyerr;

  /* ------------------------------------------------------------------------------------------ */
  /* Python value semantics                                                                       */
  /* ------------------------------------------------------------------------------------------ */
  const is_dict = (v) => HX.util.is_plain_object(v);

  function set_own(o, k, v) {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }

  /** Deep copy of JSON data; null-prototype maps become ordinary objects (``__proto__`` stays data). */
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) set_own(out, k, clone(v[k]));
      return out;
    }
    return v;
  }
  kernel._clone = clone;

  function py_type_name(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") return "dict";
    return typeof v;
  }
  kernel._py_type_name = py_type_name;

  function repr_str(s) {
    return HX.guards && HX.guards._py_repr_str ? HX.guards._py_repr_str(s) : HX.util.py_repr(s);
  }

  /** Python repr() of a JSON value. */
  function pyr(v) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return HX.canonical.py_number(v);
    if (typeof v === "string") return repr_str(v);
    if (Array.isArray(v)) return "[" + v.map(pyr).join(", ") + "]";
    if (typeof v === "object") return "{" + Object.keys(v).map((k) => repr_str(k) + ": " + pyr(v[k])).join(", ") + "}";
    return String(v);
  }
  kernel._py_repr = pyr;

  function py_truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  kernel._py_truthy = py_truthy;

  /** Python list(x) of a JSON value (shallow, like Python). */
  function py_list(v) {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (is_dict(v)) return Object.keys(v);
    throw pyerr("TypeError", "'" + py_type_name(v) + "' object is not iterable");
  }
  kernel._py_list = py_list;

  /** ``x.get(key, default)`` on a value that should be a dict (AttributeError otherwise). */
  function py_get(d, key, dflt) {
    if (!is_dict(d)) throw pyerr("AttributeError", "'" + py_type_name(d) + "' object has no attribute 'get'");
    return hasOwn(d, key) ? d[key] : dflt;
  }

  /** Python int(x) for JSON values (ASCII digit strings only). */
  function py_int(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        throw pyerr(Number.isNaN(v) ? "ValueError" : "OverflowError", "cannot convert float " +
          (Number.isNaN(v) ? "NaN" : "infinity") + " to integer");
      }
      const t = Math.trunc(v);
      return t === 0 ? 0 : t;
    }
    if (typeof v === "string") {
      const s = v.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g, "");
      if (/^[+-]?[0-9](?:_?[0-9])*$/.test(s)) {
        const n = Number(s.replace(/_/g, ""));
        if (!Number.isSafeInteger(n)) {
          throw pyerr("ValueError", "integer " + s + " is outside the range supported by the JavaScript port");
        }
        return n === 0 ? 0 : n;
      }
      throw pyerr("ValueError", "invalid literal for int() with base 10: " + repr_str(v));
    }
    throw pyerr("TypeError", "int() argument must be a string, a bytes-like object or a real number, not '" +
      py_type_name(v) + "'");
  }
  kernel._py_int = py_int;

  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  const sorted = (xs) => xs.slice().sort(cmp);

  /* ------------------------------------------------------------------------------------------ */
  /* Models (pydantic emulation via HX.efsm.pyd)                                                 */
  /* ------------------------------------------------------------------------------------------ */
  let SPECS = null;
  function specs() {
    if (SPECS) return SPECS;
    const pyd = HX.efsm.pyd, T = pyd.T, F = pyd.F;
    const S = {};
    const model = (name, fields) => (S[name] = { name, fields, extra: "forbid" });
    model("Budget", [
      F("steps", T.int, { default: 0 }), F("tool_calls", T.int, { default: 0 }),
      F("model_calls", T.int, { default: 0 }), F("tokens", T.int, { default: 0 }),
      F("output_repairs", T.int, { default: 0 }),
    ]);
    model("Assurance", [
      F("entered_fallback", T.bool, { default: false }),
      F("fallback_reason", T.str, { default: "" }),
      F("missing_evidence", T.list(T.str), { default: [] }),
      F("policy_violations", T.list(T.str), { default: [] }),
      F("unresolved_effects", T.list(T.str), { default: [] }),
      F("verification_scope", T.str, { default: "" }),
      F("diagnostics", T.list(T.dict), { default: [] }),
    ]);
    model("RunCheckpoint", [
      F("record_schema", T.lit("hexis-checkpoint/1"), { default: "hexis-checkpoint/1" }),
      F("tenant_id", T.str), F("run_id", T.str), F("artifact_hash", T.str), F("state_id", T.str),
      F("revision", T.int, { default: 0 }),
      F("variables", T.dict),
      F("budget", T.model(() => S.Budget), { model_default: true }),
      F("status", T.lit(...kernel.STATUSES), { default: "RUNNING" }),
      F("outcome", T.opt(T.dict), { default: null }),
      F("assurance", T.model(() => S.Assurance), { model_default: true }),
      F("evidence_refs", T.list(T.str), { default: [] }),
    ]);
    model("Observation", [
      F("record_schema", T.lit("hexis-observation/1"), { default: "hexis-observation/1" }),
      F("run_id", T.str), F("state_id", T.str), F("revision", T.int),
      F("kind", T.lit(...kernel.OBSERVATION_KINDS)),
      F("outputs", T.dict, { default: {} }),
      F("actor", T.str, { default: "" }),
      F("receipt_ref", T.str, { default: "" }),
      F("usage", { k: "map", of: T.int }, { factory: () => Object.create(null) }),
      F("engine", T.dict, { default: {} }),
      F("failure", T.str, { default: "" }),
    ]);
    SPECS = S;
    return S;
  }

  function validate_model(name, value) {
    const spec = specs()[name];
    const out = HX.efsm.pyd.model_validate(spec, value, ValidationError);
    return clone(out); /* null-prototype maps (usage) become ordinary objects */
  }

  function model_api(name) {
    return {
      name,
      get model_fields() { return specs()[name].fields.map((f) => f.name); },
      model_validate(value) { return validate_model(name, value); },
      digest(value) { return HX.canonical.digest(validate_model(name, value)); },
    };
  }
  kernel.Budget = model_api("Budget");
  kernel.Assurance = model_api("Assurance");
  kernel.RunCheckpoint = model_api("RunCheckpoint");
  kernel.Observation = model_api("Observation");

  /** ``RunCheckpoint(**fields)``: validated dump with every default present. */
  kernel.new_checkpoint = function (fields) { return validate_model("RunCheckpoint", fields); };
  /** ``Observation(**fields)``: validated dump with every default present. */
  kernel.new_observation = function (fields) { return validate_model("Observation", fields); };
  kernel.new_budget = function (fields) { return validate_model("Budget", fields || {}); };
  kernel.new_assurance = function (fields) { return validate_model("Assurance", fields || {}); };
  /** ``RunCheckpoint.digest()`` / ``Observation.digest()``: digest(model_dump(mode="json")). Both models have
   *  no float fields, so the plain canonical digest of the dump matches Python byte for byte. */
  kernel.checkpoint_digest = function (cp) { return HX.canonical.digest(cp); };
  kernel.observation_digest = function (obs) { return HX.canonical.digest(obs); };

  /** ``KernelResult(checkpoint, events=[], delta={}, edge=None)``. */
  function KernelResult(checkpoint, events, delta, edge) {
    return { checkpoint, events: events || [], delta: delta || {}, edge: edge === undefined ? null : edge };
  }
  kernel.KernelResult = KernelResult;

  /* ------------------------------------------------------------------------------------------ */
  /* Task input, templates                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  /** Resolve ``task.input.a.b`` (dot path) or ``/a/b`` (JSON-Pointer style). Returns ``[found, value]``. */
  kernel.resolve_path = function (task_input, init_from) {
    if (typeof init_from !== "string") {
      throw pyerr("AttributeError", "'" + py_type_name(init_from) + "' object has no attribute 'startswith'");
    }
    let parts;
    if (init_from.startsWith("/")) {
      parts = init_from.slice(1).split("/").map((p) => p.split("~1").join("/").split("~0").join("~"));
    } else {
      parts = init_from.split(".");
      if (!(parts.length >= 2 && parts[0] === "task" && parts[1] === "input")) {
        throw new KernelError("BAD_INIT_FROM", "unsupported init_from " + repr_str(init_from));
      }
      parts = parts.slice(2);
    }
    let cur = task_input;
    for (const p of parts) {
      if (is_dict(cur) && hasOwn(cur, p)) cur = cur[p];
      else return [false, null];
    }
    return [true, cur];
  };

  kernel.initial_checkpoint = function (pkg, tenant_id, run_id, task_input) {
    const schema = py_truthy(pkg.contracts.task_input_schema) ? pkg.contracts.task_input_schema : { type: "object" };
    const errs = HX.catalog.validate_against(schema, task_input);
    if (errs.length) throw new KernelError("TASK_INPUT_INVALID", errs.slice(0, 5).join("; "), { errors: errs });
    const vals = {};
    for (const v of pkg.machine.variables) {
      if (py_truthy(v.init_from)) {
        const [found, val] = kernel.resolve_path(task_input, v.init_from);
        if (found) set_own(vals, v.name, clone(val));
      } else if (v.init !== null && v.init !== undefined) {
        set_own(vals, v.name, clone(v.init));
      }
    }
    return kernel.new_checkpoint({ tenant_id, run_id, artifact_hash: pkg.artifact_hash,
      state_id: pkg.machine.initial, variables: vals });
  };

  /* Python: _WHOLE = ^\$\{name\}$ under re.match ($ also matches before a final "\n"); _PART unanchored */
  const WHOLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}\n?$/;
  const PART = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

  /** Strict binding: a missing variable is an explicit error, never None or ''. */
  kernel.fill_template = function fill_template(obj, values) {
    if (typeof obj === "string") {
      const m = WHOLE.exec(obj);
      if (m) {
        if (!hasOwn(values, m[1])) {
          throw new KernelError("MISSING_INPUT_BINDING", "template variable " + repr_str(m[1]) + " is unset",
            { variable: m[1] });
        }
        return clone(values[m[1]]);
      }
      return obj.replace(PART, (_all, name) => {
        if (!hasOwn(values, name)) {
          throw new KernelError("MISSING_INPUT_BINDING", "template variable " + repr_str(name) + " is unset",
            { variable: name });
        }
        const v = values[name];
        if (typeof v === "string") return v;
        if (typeof v === "number") return HX.canonical.py_number(v);
        throw new KernelError("TEMPLATE_TYPE", "cannot interpolate " + py_type_name(v) + " " + repr_str(name) +
          " into text");
      });
    }
    if (Array.isArray(obj)) return obj.map((v) => fill_template(v, values));
    if (obj !== null && typeof obj === "object") {
      const out = {};
      for (const k of Object.keys(obj)) set_own(out, k, fill_template(obj[k], values));
      return out;
    }
    return obj;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Output validation                                                                            */
  /* ------------------------------------------------------------------------------------------ */
  const TYPE_OK = {
    string: (v) => typeof v === "string",
    integer: (v) => typeof v === "number" && Number.isInteger(v),
    number: (v) => typeof v === "number",
    boolean: (v) => typeof v === "boolean",
    array: (v) => Array.isArray(v),
    object: (v) => is_dict(v),
  };
  const OWNER = { tool: "tool", model: "model", judge: "model", user: "user" };

  function state_of(pkg, state_id) {
    const states = pkg.machine.states;
    if (!hasOwn(states, state_id)) throw pyerr("KeyError", repr_str(String(state_id)));
    return states[state_id];
  }

  kernel.validate_declared_outputs = function (pkg, state_id, obs, current) {
    const st = state_of(pkg, state_id);
    const a = st.action;
    const writes = Array.isArray(a.writes) ? a.writes.slice() : [];
    const outputs = obs.outputs;
    let delta;
    if (a.kind === "tool") {
      const bound = new Map();
      for (const k of Object.keys(outputs)) bound.set(hasOwn(a.binds, k) ? a.binds[k] : k, outputs[k]);
      const missing = writes.filter((w) => !bound.has(w));
      if (missing.length) {
        throw new KernelError("OUTPUT_INCOMPLETE", "tool output lacks declared writes " + pyr(missing), { missing });
      }
      delta = new Map();
      for (const w of writes) delta.set(w, bound.get(w));
    } else {
      const keys = Object.keys(outputs);
      const wset = new Set(writes), kset = new Set(keys);
      const extra = sorted(keys.filter((k) => !wset.has(k)));
      const missing = sorted(Array.from(wset).filter((w) => !kset.has(w)));
      if (extra.length) {
        throw new KernelError("UNEXPECTED_OUTPUT_KEYS", a.kind + " output has undeclared keys " + pyr(extra), { extra });
      }
      if (missing.length) {
        throw new KernelError("OUTPUT_INCOMPLETE", a.kind + " output lacks declared writes " + pyr(missing), { missing });
      }
      delta = new Map(keys.map((k) => [k, outputs[k]]));
      if (a.kind === "judge") {
        const label = delta.get(writes[0]);
        if (!(typeof label === "string" && a.labels.indexOf(label) >= 0)) {
          throw new KernelError("INVALID_JUDGE_LABEL", "label " + pyr(label) + " not in " + pyr(a.labels),
            { label: clone(label) });
        }
      }
    }
    if (!hasOwn(OWNER, a.kind)) throw pyerr("KeyError", repr_str(String(a.kind)));
    const expected_owner = OWNER[a.kind];
    const types = HX.efsm.var_types(pkg.machine);
    const vcs = pkg.contracts.variables;
    for (const [k, v] of delta) {
      const vc = hasOwn(vcs, k) ? vcs[k] : null;
      if (vc === null || vc.owner !== expected_owner) {
        throw new KernelError("WRITE_OWNERSHIP", a.kind + " may not write " + repr_str(k), { variable: k });
      }
      if (v !== null) {
        if (!(k in types)) throw pyerr("KeyError", repr_str(k));
        if (!TYPE_OK[types[k]](v)) {
          throw new KernelError("OUTPUT_TYPE", repr_str(k) + " expects " + types[k] + ", got " + py_type_name(v),
            { variable: k });
        }
      }
      const schema = py_truthy(vc.schema) ? vc.schema : {};
      let errs = HX.catalog.validate_against(schema, v);
      if (v === null && !py_truthy(vc.schema)) errs = [k + ": null is not allowed without an explicit schema"];
      if (errs.length) {
        throw new KernelError("OUTPUT_SCHEMA", repr_str(k) + " fails its schema: " + errs[0], { variable: k, errors: errs });
      }
    }
    const fsw = pkg.contracts.field_scoped_writes;
    const scope = hasOwn(fsw, state_id) ? fsw[state_id] : null;
    if (scope && delta.has(scope.variable)) {
      let old = hasOwn(current, scope.variable) ? current[scope.variable] : null;
      const neu = delta.get(scope.variable);
      if (old === null) old = {};
      if (!is_dict(old) || !is_dict(neu)) {
        throw new KernelError("FIELD_SCOPE_VIOLATION", state_id + " field-scoped variable " + repr_str(scope.variable) +
          " must remain an object", { variable: scope.variable });
      }
      const iv = hasOwn(current, scope.allowed_fields_from) ? current[scope.allowed_fields_from] : null;
      const issues = py_truthy(iv) ? iv : [];
      const allowed = new Set();
      for (const i of Array.isArray(issues) ? issues : []) {
        if (is_dict(i) && hasOwn(i, scope.field_key) && typeof i[scope.field_key] === "string") allowed.add(i[scope.field_key]);
      }
      /* Key presence and exact JSON value (via canonical digest) both count: unset vs null, 1 vs true. */
      const changed = new Set();
      try {
        const all = new Set(Object.keys(old).concat(Object.keys(neu)));
        for (const k of all) {
          const io = hasOwn(old, k), inn = hasOwn(neu, k);
          if (io !== inn || (io && HX.canonical.digest(old[k]) !== HX.canonical.digest(neu[k]))) changed.add(k);
        }
      } catch (exc) {
        if (exc instanceof HX.canonical.CanonicalError) {
          throw new KernelError("FIELD_SCOPE_VIOLATION", state_id + " field-scoped value is not canonical JSON: " +
            exc.message, { variable: scope.variable });
        }
        throw exc;
      }
      const outside = sorted(Array.from(changed).filter((k) => !allowed.has(k)));
      if (outside.length) {
        throw new KernelError("FIELD_SCOPE_VIOLATION", state_id + " changed fields outside " +
          pyr(sorted(Array.from(allowed))) + ": " + pyr(outside), { fields: outside });
      }
    }
    const out = {};
    for (const [k, v] of delta) set_own(out, k, clone(v));
    return out;
  };

  /** First enabled edge, default last. Guard errors are returned, never treated as false.
   *  Returns ``[index, null]``, ``[null, error_message]`` or ``[null, null]``. */
  kernel.select_edge = function (pkg, state_id, variables) {
    const st = state_of(pkg, state_id);
    const ts = st.transitions;
    const ordered = [];
    ts.forEach((t, i) => { if (py_truthy(t["if"])) ordered.push([i, t]); });
    ts.forEach((t, i) => { if (!py_truthy(t["if"])) ordered.push([i, t]); });
    for (const [i, t] of ordered) {
      if (!py_truthy(t["if"])) return [i, null];
      try {
        if (HX.guards.evaluate(t["if"], variables)) return [i, null];
      } catch (exc) {
        if (exc instanceof HX.guards.GuardError) return [null, "edge " + i + " guard " + repr_str(t["if"]) + ": " + exc.message];
        throw exc;
      }
    }
    return [null, null];
  };

  /* ------------------------------------------------------------------------------------------ */
  /* The reducer                                                                                  */
  /* ------------------------------------------------------------------------------------------ */
  function with_updates(cp, upd) {
    const out = {};
    for (const k of Object.keys(cp)) out[k] = hasOwn(upd, k) ? upd[k] : cp[k];
    return out;
  }

  function _stop(cp, status, code, message, events, detail) {
    const a = clone(cp.assurance);
    const diag = { code, message, state: cp.state_id, revision: cp.revision };
    if (detail) for (const k of Object.keys(detail)) set_own(diag, k, clone(detail[k]));
    a.diagnostics.push(diag);
    const neu = with_updates(cp, { status, assurance: a, revision: cp.revision + 1 });
    events.push({ type: "RUN_STOPPED", status, code, state: cp.state_id, message });
    return KernelResult(neu, events);
  }

  function _charge(budget, obs) {
    const b = clone(budget);
    const u = obs.usage;
    const get = (k) => (hasOwn(u, k) ? py_int(u[k]) : 0);
    b.steps += 1;
    b.tool_calls += get("tool_calls");
    b.model_calls += get("model_calls");
    b.tokens += get("tokens");
    b.output_repairs += get("output_repairs");
    return b;
  }

  function _over_budget(pkg, b) {
    const lim = pkg.execution_policy.budgets;
    if (b.steps > Math.min(lim.max_steps, pkg.machine.max_steps)) return "steps";
    if (b.tool_calls > lim.max_tool_calls) return "tool_calls";
    if (b.model_calls > lim.max_model_calls) return "model_calls";
    if (b.tokens > lim.max_tokens) return "tokens";
    return null;
  }

  kernel.advance = function (checkpoint, obs, pkg) {
    if (checkpoint.artifact_hash !== pkg.artifact_hash) {
      throw new KernelError("ARTIFACT_MISMATCH", "checkpoint is pinned to a different artifact");
    }
    if (kernel.TERMINAL_STATUSES.indexOf(checkpoint.status) >= 0) {
      throw new KernelError("RUN_FINISHED", "run already " + checkpoint.status);
    }
    if (obs.run_id !== checkpoint.run_id || obs.state_id !== checkpoint.state_id || obs.revision !== checkpoint.revision) {
      throw new KernelError("OBSERVATION_IDENTITY", "observation does not belong to this state visit",
        { expected: [checkpoint.run_id, checkpoint.state_id, checkpoint.revision],
          got: [obs.run_id, obs.state_id, obs.revision] });
    }
    const states = pkg.machine.states;
    if (!hasOwn(states, checkpoint.state_id)) throw new KernelError("UNKNOWN_STATE", checkpoint.state_id);
    const st = states[checkpoint.state_id];
    if (obs.kind !== st.action.kind) {
      throw new KernelError("OBSERVATION_KIND", "state " + st.id + " is " + st.action.kind + ", observation is " + obs.kind);
    }
    const events = [{ type: "OBSERVATION_ACCEPTED", state: st.id, revision: checkpoint.revision, kind: obs.kind,
      observation_digest: kernel.observation_digest(obs), actor: obs.actor, receipt_ref: obs.receipt_ref }];
    const budget = _charge(checkpoint.budget, obs);
    const cp = with_updates(clone(checkpoint), { budget });

    if (st.action.kind === "end") return _finish(cp, obs, pkg, events);

    if (py_truthy(obs.failure)) {
      /* Recorded host decision: this state could not produce a valid observation. Route to the reserved
         fallback state; record entry permanently. */
      const a = clone(cp.assurance);
      a.entered_fallback = true;
      a.fallback_reason = st.id + ": " + obs.failure;
      const fb = pkg.machine.fallback;
      const neu = with_updates(cp, { state_id: fb, revision: cp.revision + 1, assurance: a, status: "RUNNING" });
      events.push({ type: "FALLBACK_ENTERED", from: st.id, to: fb, reason: obs.failure });
      return KernelResult(neu, events);
    }

    const delta = kernel.validate_declared_outputs(pkg, st.id, obs, cp.variables);
    const after = clone(cp.variables);
    for (const k of Object.keys(delta)) set_own(after, k, clone(delta[k]));
    const [idx, gerr] = kernel.select_edge(pkg, st.id, after);
    if (gerr) return _stop(with_updates(cp, { variables: after }), "FAILED", "GUARD_EVALUATION_ERROR", gerr, events);
    if (idx === null) {
      return _stop(with_updates(cp, { variables: after }), "FAILED", "NO_ENABLED_TRANSITION",
        "no edge enabled from " + st.id, events);
    }
    const edge = st.transitions[idx];
    if (py_truthy(edge.inc)) { /* the guard saw the old counter; the increment follows selection */
      set_own(after, edge.inc, py_int(hasOwn(after, edge.inc) ? after[edge.inc] : 0) + 1);
    }
    const over = _over_budget(pkg, budget);
    if (over) {
      return _stop(with_updates(cp, { variables: after }), "FAILED", "BUDGET_EXHAUSTED",
        "run budget '" + over + "' exhausted", events);
    }
    const neu = with_updates(cp, { variables: after, state_id: edge.to, revision: cp.revision + 1, status: "RUNNING" });
    const e = { index: idx, "if": edge["if"], to: edge.to, inc: edge.inc };
    events.push({ type: "TRANSITION", from: st.id, to: edge.to, edge: clone(e), delta_keys: sorted(Object.keys(delta)),
      delta_digest: HX.canonical.digest(delta), revision: neu.revision });
    return KernelResult(neu, events, delta, e);
  };

  function _finish(cp, obs, pkg, events) {
    const st = pkg.machine.states[cp.state_id];
    const tid = st.action.terminal;
    const term = HX.efsm.terminal(pkg.machine, tid);
    const tcs = pkg.contracts.terminals;
    const tc = hasOwn(tcs, tid) ? tcs[tid] : null;
    const touts = term ? term.output : [];
    const missing = touts.filter((o) => !hasOwn(cp.variables, o));
    if (missing.length) {
      return _stop(cp, "FAILED", "TERMINAL_OUTPUT_MISSING", "terminal " + tid + " lacks outputs " + pyr(missing), events);
    }
    const adm = hasOwn(obs.engine, "terminal_admission") ? obs.engine.terminal_admission : {};
    const a = clone(cp.assurance);
    a.unresolved_effects = clone(py_list(py_get(adm, "unresolved_effects", [])));
    if (tc !== null && tc.category === "verified") {
      if (!py_truthy(py_get(adm, "evidence_valid", null)) || a.unresolved_effects.length) {
        a.missing_evidence = clone(py_list(py_get(adm, "missing", ["no valid evidence receipt"])));
        return _stop(with_updates(cp, { assurance: a }), "FAILED", "TERMINAL_ADMISSION_DENIED",
          "verified terminal " + tid + " not supported by current evidence", events, { missing: a.missing_evidence });
      }
      a.verification_scope = tc.verification_scope;
    }
    const outputs = {};
    for (const o of touts) set_own(outputs, o, clone(cp.variables[o]));
    const outcome = { terminal: tid, category: tc ? tc.category : (term ? term.kind : ""), outputs,
      evidence_receipts: clone(py_list(py_get(adm, "receipts", []))) };
    const neu = with_updates(cp, { status: "COMPLETED", outcome, assurance: a, revision: cp.revision + 1,
      evidence_refs: clone(py_list(py_get(adm, "receipts", []))) });
    events.push({ type: "TERMINAL_ADMITTED", terminal: tid, category: outcome.category });
    return KernelResult(neu, events);
  }
})(globalThis.HX = globalThis.HX || {});
