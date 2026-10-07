/* Port of hexis_service/traces/model.py: trace records as upstream-compatible JSONL (header line + one record
 * per line) with an extension block carrying record digests, so tampering is detectable (brief §9.2, A31).
 *
 * Data shapes (README "Module conventions"):
 *  - A Record is a plain object with exactly the fields of ``Record.model_dump(mode="json")``:
 *    ``{step, state, clause, action, output, vars, meta}``. Build one with ``new_record(fields)``.
 *  - A Trace is a plain object with exactly the fields of ``Trace.model_dump(mode="json")``:
 *    ``{trace_id, task, verdict, error_step, source, tenant_id, run_id, artifact_hash, records}``. Build one with
 *    ``new_trace(fields)`` (pydantic validation; throws ``HX.traces.ValidationError``).
 *  - Python's private ``_seal`` ({records_digest, header_digest}, captured at seal or load time) is kept in a
 *    WeakMap keyed by the trace object, so it is never serialized. ``seal(trace)`` returns a new sealed trace,
 *    ``from_jsonl`` attaches the seal read from the header, and ``model_copy(trace, {deep, update})`` carries the
 *    seal over like pydantic's ``model_copy``. Any other copy (``HX.util.deep_clone``, ``structuredClone``,
 *    ``JSON.parse(JSON.stringify(t))``) is an UNSEALED trace and is rejected by every consumer (fail closed).
 *  - Python methods become functions taking the trace first: ``records_digest(t)``, ``header_digest(t)``,
 *    ``integrity_errors(t, expected_records_digest)``, ``to_jsonl(t)``; ``Trace.from_jsonl(text)`` is
 *    ``from_jsonl(text)`` and returns ``[trace, integrity_errors]``; ``Record.body_digest`` is ``body_digest(r)``.
 *  - ``to_jsonl`` is byte-identical to Python's ``json.dumps(..., sort_keys=True, ensure_ascii=False)``
 *    (``py_json_dumps``).
 *
 * Python built-in exceptions on malformed input are ``HX.HXError`` with the class name as ``code``
 * (AttributeError, TypeError, ValueError, KeyError, IndexError); JSON errors are ``HX.canonical.CanonicalError``.
 */
(function (HX) {
  "use strict";
  const traces = (HX.traces = HX.traces || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const is_dict = (v) => HX.util.is_plain_object(v);

  traces.TRACE_EXT = "hexis-trace/1";
  traces.RECORD_FIELDS = Object.freeze(["step", "state", "clause", "action", "output", "vars", "meta"]);
  traces.TRACE_FIELDS = Object.freeze(["trace_id", "task", "verdict", "error_step", "source", "tenant_id", "run_id",
    "artifact_hash", "records"]);
  traces.VERDICTS = Object.freeze(["accepted", "rejected", "unknown"]);

  /** pydantic.ValidationError for Record / Trace / NormalizedEvent. */
  class ValidationError extends HX.HXError {
    constructor(message, errors, model) {
      super("VALIDATION_ERROR", message, { errors: errors || [], model: model || "" });
      this.message = message;
      this.errors = errors || [];
      this.model = model || "";
    }
  }
  traces.ValidationError = ValidationError;

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }
  traces._pyerr = pyerr;

  /* ------------------------------------------------------------------------------------------ */
  /* Python value helpers (shared with 62_normalize / 64_replay)                                 */
  /* ------------------------------------------------------------------------------------------ */
  function set_own(o, k, v) {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  traces._set_own = set_own;

  /** Deep copy of JSON data into ordinary objects (``__proto__`` stays data). */
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v !== null && typeof v === "object") {
      if (v === (HX.guards && HX.guards.UNKNOWN)) return v;
      const out = {};
      for (const k of Object.keys(v)) set_own(out, k, clone(v[k]));
      return out;
    }
    return v;
  }
  traces._clone = clone;

  function py_type_name(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") return "dict";
    return typeof v;
  }
  traces._py_type_name = py_type_name;

  function repr_str(s) {
    return HX.guards && HX.guards._py_repr_str ? HX.guards._py_repr_str(s) : HX.util.py_repr(s);
  }

  const INDEX_KEY = /^(?:0|[1-9][0-9]*)$/;
  /** True when a JS object's key order may differ from Python's insertion order: two or more keys, one of them
   *  an array index (JS enumerates those first, in numeric order). */
  function key_order_lost(keys) {
    return keys.length > 1 && keys.some((k) => INDEX_KEY.test(k) && Number(k) < 4294967295);
  }
  traces._key_order_lost = key_order_lost;

  function repr_any(v, strict) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return HX.canonical.py_number(v);
    if (typeof v === "string") return repr_str(v);
    if (Array.isArray(v)) return "[" + v.map((x) => repr_any(x, strict)).join(", ") + "]";
    if (HX.guards && v === HX.guards.UNKNOWN) return "UNKNOWN";
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (strict && key_order_lost(keys)) {
        throw pyerr("KEY_ORDER_UNKNOWN", "str()/repr() of a dict with integer-like keys " +
          repr_any(keys, false) + ": the JavaScript port cannot recover their insertion order");
      }
      return "{" + keys.map((k) => repr_str(k) + ": " + repr_any(v[k], strict)).join(", ") + "}";
    }
    return String(v);
  }

  /** Python ``repr()`` of a JSON value. A dict (at any depth) with two or more keys of which one is integer-like
   *  raises JS-only ``KEY_ORDER_UNKNOWN``: Python prints it in insertion order, which a JS object has lost. */
  function py_repr(v) { return repr_any(v, true); }
  traces._py_repr = py_repr;
  /** ``repr()`` for exception message text only (never raises; such dicts print in JS key order). */
  traces._py_repr_msg = (v) => repr_any(v, false);

  /** Python ``str()`` of a JSON value (f-string ``{x}``). */
  function py_str(v) {
    return typeof v === "string" ? v : py_repr(v);
  }
  traces._py_str = py_str;

  function py_truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  traces._py_truthy = py_truthy;

  /** ``d.get(key, dflt)`` on a value that must be a dict (AttributeError otherwise). */
  function py_get(d, key, dflt) {
    if (!is_dict(d)) throw pyerr("AttributeError", "'" + py_type_name(d) + "' object has no attribute 'get'");
    return hasOwn(d, key) ? d[key] : dflt;
  }
  traces._py_get = py_get;

  /** Python ``==`` on JSON values (True == 1 == 1.0; dict key order ignored). */
  function py_eq(a, b) {
    if (a === b) return true;
    const na = typeof a === "number" || typeof a === "boolean", nb = typeof b === "number" || typeof b === "boolean";
    if (na && nb) return Number(a) === Number(b);
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a === "string" || typeof b === "string") return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!py_eq(a[i], b[i])) return false;
      return true;
    }
    if (typeof a === "object" && typeof b === "object") {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) if (!hasOwn(b, k) || !py_eq(a[k], b[k])) return false;
      return true;
    }
    return false;
  }
  traces._py_eq = py_eq;

  /** Python ``list(x)`` of a JSON value (str -> code points, dict -> keys). A dict with two or more keys of
   *  which one is integer-like raises JS-only ``KEY_ORDER_UNKNOWN`` (its insertion order is lost in JS). */
  function py_list(v) {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (is_dict(v)) {
      const keys = Object.keys(v);
      if (key_order_lost(keys)) {
        throw pyerr("KEY_ORDER_UNKNOWN", "list() of a dict with integer-like keys " + py_repr(keys) +
          ": the JavaScript port cannot recover their insertion order");
      }
      return keys;
    }
    throw pyerr("TypeError", "'" + py_type_name(v) + "' object is not iterable");
  }
  traces._py_list = py_list;

  /* ------------------------------------------------------------------------------------------ */
  /* Python json.dumps(obj, sort_keys=True, ensure_ascii=False) with the default separators       */
  /* ------------------------------------------------------------------------------------------ */
  function dumps(v, out) {
    if (v === null) { out.push("null"); return; }
    if (v === true) { out.push("true"); return; }
    if (v === false) { out.push("false"); return; }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new HX.canonical.CanonicalError("non-finite number");
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
        throw new HX.canonical.CanonicalError("integer outside the exactly representable range (+/-(2^53-1))");
      }
      out.push(HX.canonical.py_number(v));
      return;
    }
    if (typeof v === "string") {
      if (HX.util.has_lone_surrogate(v)) throw new HX.canonical.CanonicalError("lone surrogate in string");
      out.push(JSON.stringify(v)); /* same escapes as Python with ensure_ascii=False */
      return;
    }
    if (Array.isArray(v)) {
      out.push("[");
      for (let i = 0; i < v.length; i++) { if (i) out.push(", "); dumps(v[i], out); }
      out.push("]");
      return;
    }
    if (is_dict(v)) {
      const keys = HX.util.sorted_keys(v);
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        if (i) out.push(", ");
        if (HX.util.has_lone_surrogate(keys[i])) throw new HX.canonical.CanonicalError("lone surrogate in string");
        out.push(JSON.stringify(keys[i]), ": ");
        dumps(v[keys[i]], out);
      }
      out.push("}");
      return;
    }
    throw pyerr("TypeError", "Object of type " + py_type_name(v) + " is not JSON serializable");
  }

  /** ``json.dumps(value, sort_keys=True, ensure_ascii=False)`` (separators ", " and ": "). */
  traces.py_json_dumps = function (value) {
    const out = [];
    dumps(value, out);
    return out.join("");
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Models                                                                                       */
  /* ------------------------------------------------------------------------------------------ */
  let SPECS = null;
  function specs() {
    if (SPECS) return SPECS;
    const pyd = HX.efsm.pyd, T = pyd.T, F = pyd.F;
    const S = {};
    const dict = () => ({});
    S.Record = { name: "Record", extra: "forbid", fields: [
      F("step", T.int), F("state", T.str, { default: "" }), F("clause", T.str, { default: "" }),
      F("action", T.dict, { factory: dict }), F("output", T.dict, { factory: dict }),
      F("vars", T.dict, { factory: dict }), F("meta", T.dict, { factory: dict }),
    ] };
    S.Trace = { name: "Trace", extra: "forbid", fields: [
      F("trace_id", T.str), F("task", T.dict, { factory: dict }),
      F("verdict", T.lit("accepted", "rejected", "unknown"), { default: "unknown" }),
      F("error_step", T.opt(T.int), { default: null }),
      F("source", T.str, { default: "" }), F("tenant_id", T.str, { default: "" }),
      F("run_id", T.str, { default: "" }), F("artifact_hash", T.str, { default: "" }),
      F("records", T.list(T.model(() => S.Record)), { factory: () => [] }),
    ] };
    S.NormalizedEvent = { name: "NormalizedEvent", extra: "forbid", fields: [
      F("index", T.int), F("source_steps", T.list(T.int)), F("kind", T.str),
      F("tool", T.str, { default: "" }), F("phase", T.str, { default: "" }),
      F("inputs", T.any, { default: null }), F("outputs", T.dict, { factory: dict }),
      F("outcome", T.str, { default: "" }), F("role", T.str, { default: "" }),
      F("labels", T.list(T.str), { factory: () => [] }), F("terminal", T.str, { default: "" }),
      F("interaction_type", T.str, { default: "" }),
    ] };
    SPECS = S;
    return S;
  }
  traces._specs = specs;

  /** Validate ``value`` as pydantic model ``name`` ("Record", "Trace", "NormalizedEvent"); a plain dump. */
  function validate_model(name, value) {
    return clone(HX.efsm.pyd.model_validate(specs()[name], value, ValidationError));
  }
  traces._validate_model = validate_model;

  /** ``Record(**fields)``: a validated Record dump with every default present. */
  traces.new_record = function (fields) { return validate_model("Record", fields); };
  /** ``Trace(**fields)``: a validated, UNSEALED Trace dump (records validated too). */
  traces.new_trace = function (fields) { return validate_model("Trace", fields); };
  traces.Record = { model_validate: (v) => validate_model("Record", v), model_fields: traces.RECORD_FIELDS };
  traces.Trace = { model_validate: (v) => validate_model("Trace", v), model_fields: traces.TRACE_FIELDS };

  /** ``record.model_dump(mode="json")``: exactly the model fields, in declaration order. */
  function record_dump(r) {
    const out = {};
    for (const f of traces.RECORD_FIELDS) set_own(out, f, r[f]);
    return out;
  }
  traces.record_dump = record_dump;

  /** ``trace.model_dump(mode="json")`` (a deep copy; the seal is not part of it). */
  traces.model_dump = function (trace) {
    const out = {};
    for (const f of traces.TRACE_FIELDS) {
      set_own(out, f, f === "records" ? trace.records.map((r) => clone(record_dump(r))) : clone(trace[f]));
    }
    return out;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Seal (Python's private _seal)                                                                */
  /* ------------------------------------------------------------------------------------------ */
  const SEALS = new WeakMap();

  /** The seal recorded when ``trace`` was sealed or loaded (a copy; ``{}`` when unsealed). */
  traces.get_seal = function (trace) {
    const s = SEALS.get(trace);
    return s ? Object.assign({}, s) : {};
  };
  /** Test/adapter hook mirroring an assignment to Python's ``trace._seal`` (string values only). */
  traces._set_seal = function (trace, seal) {
    const s = {};
    if (seal) for (const k of ["records_digest", "header_digest"]) if (hasOwn(seal, k)) s[k] = seal[k];
    SEALS.set(trace, s);
    return trace;
  };

  /** ``trace.model_copy(update=..., deep=...)``: a copy that carries the seal (pydantic copies private
   *  attributes). Both forms return independent data in JS (``deep`` is accepted for API parity). */
  traces.model_copy = function (trace, opts) {
    opts = opts || {};
    const update = opts.update || {};
    const out = {};
    for (const f of traces.TRACE_FIELDS) {
      const v = hasOwn(update, f) ? update[f] : trace[f];
      set_own(out, f, f === "records" ? v.map((r) => clone(record_dump(r))) : clone(v));
    }
    const s = SEALS.get(trace);
    SEALS.set(out, s ? Object.assign({}, s) : {});
    return out;
  };

  /** ``Record.body_digest()``: digest of the record dump without ``meta.digest``. */
  traces.body_digest = function (r) {
    const d = record_dump(r);
    const meta = {};
    for (const k of Object.keys(r.meta)) if (k !== "digest") set_own(meta, k, r.meta[k]);
    d.meta = meta;
    return HX.canonical.digest(d);
  };

  /** ``Trace.records_digest()``. */
  traces.records_digest = function (trace) {
    return HX.canonical.digest(trace.records.map((r) => (hasOwn(r.meta, "digest") ? r.meta.digest : "")));
  };

  /** ``Trace.header_digest()``: every header field (task incl. initial checkpoint, verdict, error step,
   *  provenance). */
  traces.header_digest = function (trace) {
    return HX.canonical.digest({ trace_id: trace.trace_id, task: trace.task, verdict: trace.verdict,
      error_step: trace.error_step, source: trace.source, tenant_id: trace.tenant_id, run_id: trace.run_id,
      artifact_hash: trace.artifact_hash });
  };

  /** ``Trace.seal()``: a new trace whose records carry ``meta.digest`` and whose seal is recorded. */
  traces.seal = function (trace) {
    const recs = trace.records.map((r) => {
      const r2 = clone(record_dump(r));
      const meta = {};
      for (const k of Object.keys(r2.meta)) set_own(meta, k, r2.meta[k]);
      set_own(meta, "digest", traces.body_digest(r2));
      r2.meta = meta;
      return r2;
    });
    const t = traces.model_copy(trace, { update: { records: recs } });
    SEALS.set(t, { records_digest: traces.records_digest(t), header_digest: traces.header_digest(t) });
    return t;
  };

  /** ``Trace.integrity_errors(expected_records_digest=None)``: per-record digests plus the sealed records and
   *  header digests. ``expected_records_digest`` (a string, also ``""``) overrides the digest recorded at seal or
   *  load time; a trace with no seal at all is rejected. */
  traces.integrity_errors = function (trace, expected_records_digest) {
    const errs = [];
    for (const r of trace.records) {
      const d = hasOwn(r.meta, "digest") ? r.meta.digest : null;
      if (d !== traces.body_digest(r)) errs.push("record " + py_str(r.step) + ": digest mismatch (tampered or unsealed)");
    }
    const seal = SEALS.get(trace) || {};
    const expected = expected_records_digest !== undefined && expected_records_digest !== null ? expected_records_digest
      : (hasOwn(seal, "records_digest") ? seal.records_digest : null);
    if (expected === null) errs.push("no integrity block (unsealed trace)");
    else if (expected !== traces.records_digest(trace)) {
      errs.push("header records_digest mismatch (records added, removed or reordered)");
    }
    const hd = hasOwn(seal, "header_digest") ? seal.header_digest : null;
    if (expected !== null && hd === null) errs.push("no header digest (trace header is unsealed)");
    else if (hd !== null && hd !== traces.header_digest(trace)) {
      errs.push("header digest mismatch (task, initial checkpoint, verdict or provenance altered)");
    }
    return errs;
  };

  /** ``Trace.to_jsonl()``: byte-identical to Python's. */
  traces.to_jsonl = function (trace) {
    const task = trace.task;
    const head = { header: true, task_id: hasOwn(task, "task_id") ? task.task_id : trace.trace_id,
      input: hasOwn(task, "input") ? task.input : {}, task, verdict: trace.verdict,
      hexis_service: { format: traces.TRACE_EXT, trace_id: trace.trace_id, source: trace.source,
        tenant_id: trace.tenant_id, run_id: trace.run_id, artifact_hash: trace.artifact_hash,
        records_digest: traces.records_digest(trace), header_digest: traces.header_digest(trace) } };
    if (trace.error_step !== null && trace.error_step !== undefined) head.error_step = trace.error_step;
    const lines = [traces.py_json_dumps(head)];
    for (const r of trace.records) lines.push(traces.py_json_dumps(record_dump(r)));
    return lines.join("\n") + "\n";
  };

  /** ``Trace.from_jsonl(text)`` -> ``[trace, integrity_errors]``. Duplicate keys / NaN are rejected outright. */
  traces.from_jsonl = function (text) {
    if (typeof text !== "string") {
      throw pyerr("AttributeError", "'" + py_type_name(text) + "' object has no attribute 'splitlines'");
    }
    const rows = [];
    for (const ln of HX.clauses.splitlines(text)) {
      if (HX.clauses.py_strip(ln)) rows.push(HX.canonical.strict_loads(ln));
    }
    if (!rows.length) throw pyerr("ValueError", "empty trace");
    const head = rows[0], body = rows.slice(1);
    /* the keyword arguments of cls(...) are evaluated in order, before the model validates */
    const ext0 = py_get(head, "hexis_service", null);
    const ext = py_truthy(ext0) ? ext0 : {};
    const task = is_dict(py_get(head, "task", null)) ? head.task : (() => {
      const t = {};
      for (const k of ["task_id", "input"]) if (hasOwn(head, k)) set_own(t, k, head[k]);
      return t;
    })();
    const ext_tid = py_get(ext, "trace_id", null);
    const fields = {
      trace_id: py_truthy(ext_tid) ? ext_tid : py_str(py_get(head, "task_id", "trace")),
      task,
      verdict: py_get(head, "verdict", "unknown"),
      error_step: py_get(head, "error_step", null),
      source: py_get(ext, "source", ""),
      tenant_id: py_get(ext, "tenant_id", ""),
      run_id: py_get(ext, "run_id", ""),
      artifact_hash: py_get(ext, "artifact_hash", ""),
    };
    fields.records = body.map((r) => {
      if (!is_dict(r)) throw pyerr("TypeError", "hexis_service.traces.model.Record() argument after ** must be a mapping, not " + py_type_name(r));
      return validate_model("Record", r);
    });
    const t = validate_model("Trace", fields);
    const seal = {};
    if (py_truthy(ext)) {
      for (const k of ["records_digest", "header_digest"]) if (hasOwn(ext, k) && typeof ext[k] === "string") seal[k] = ext[k];
    }
    SEALS.set(t, seal);
    return [t, traces.integrity_errors(t)];
  };

  /* ------------------------------------------------------------------------------------------ */
  /* export_run_trace                                                                             */
  /* ------------------------------------------------------------------------------------------ */
  function cp_digest(cp) {
    return py_truthy(cp) ? HX.canonical.digest(cp) : null;
  }

  function by_revision(rows) {
    const m = new Map();
    for (const x of rows) m.set(x.revision, x);
    return m;
  }

  function key_error(k) { return pyerr("KeyError", traces._py_repr_msg(k)); }

  /** ``export_run_trace(service, run_id, principal, verdict="unknown")``: a sealed trace built from a run's
   *  recorded observations (complete enough for recorded replay). ``service`` is an ``HX.service.RunService``
   *  (``service.store`` and ``service.package(hash)``, which returns a normalized MachinePackage dump). */
  traces.export_run_trace = function (service, run_id, principal, verdict) {
    if (verdict === undefined) verdict = "unknown";
    const tenant = principal.tenant_id;
    const store = service.store;
    const run = store.get_run(tenant, run_id);
    if (run === null || run === undefined) throw pyerr("TypeError", "'NoneType' object is not subscriptable");
    const pkg = service.package(run.artifact_hash);
    const cps = store.checkpoints(tenant, run_id);
    const intents = by_revision(store.intents(tenant, run_id));
    const interactions = new Map();
    for (const ev of store.events(tenant, run_id)) {
      if (ev.type === "INTERACTION_OPEN") {
        const ix = store.interaction(tenant, ev.interaction_id);
        interactions.set(ix.revision, ix);
      }
    }
    const evs = store.events(tenant, run_id);
    if (!evs.length) throw pyerr("IndexError", "list index out of range");
    const first = evs[0];
    const recs = [];
    const cp_by_rev = by_revision(cps);
    for (const ev of store.events(tenant, run_id)) {
      if (ev.type !== "OBSERVATION") continue;
      const obs = ev.observation;
      if (!hasOwn(pkg.machine.states, obs.state_id)) throw key_error(obs.state_id);
      const st = pkg.machine.states[obs.state_id];
      const a = st.action;
      const action = { kind: a.kind };
      const meta = { revision: obs.revision, observation: obs,
        writes: hasOwn(a, "writes") && py_truthy(a.writes) ? a.writes.slice() : [],
        checkpoint_digest_before: cp_digest(cp_by_rev.get(obs.revision)) };
      const after = cp_by_rev.get(obs.revision + 1);
      if (after !== undefined && after !== null) meta.checkpoint_digest_after = cp_digest(after);
      if (a.kind === "tool") {
        const it = intents.get(obs.revision);
        action.name = a.name;
        action.input = it ? it.args : {};
        action.phase = a.phase;
        if (it) meta.logical_action_id = it.logical_action_id;
      } else if (a.kind === "model" || a.kind === "judge") {
        action.prompt_digest = HX.canonical.digest(a.prompt);
        meta.observable = py_truthy(hasOwn(a, "observable") ? a.observable : false);
      } else if (a.kind === "user") {
        const ix = interactions.get(obs.revision);
        meta.interaction_type = ix ? ix.type : "";
      } else if (a.kind === "end") {
        action.terminal = a.terminal;
      }
      recs.push({ step: recs.length, state: st.id, clause: st.clause, action, output: obs.outputs, meta });
    }
    if (!cps.length) throw pyerr("IndexError", "list index out of range");
    const task = { task_id: run_id, input: { task_input_digest: hasOwn(first, "task_input_digest") ? first.task_input_digest : null },
      initial_checkpoint: cps[0] };
    return traces.seal(traces.new_trace({ trace_id: "trace:" + run_id, task, verdict, source: "run:" + run_id,
      tenant_id: tenant, run_id, artifact_hash: run.artifact_hash, records: recs }));
  };
})(globalThis.HX = globalThis.HX || {});
