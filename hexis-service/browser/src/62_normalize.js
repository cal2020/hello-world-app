/* Port of hexis_service/traces/normalize.py: trace normalization (brief §9.2) and archive eligibility (§9.1).
 *
 * Normalization keeps pointers to the original records. Only recognized orchestration noise is removed;
 * non-observable model/judge steps are zero-width (they stay in the raw trace). Consecutive same-tool records
 * merge ONLY when the adapter established one logical operation (same ``meta.logical_action_id``) -- distinct
 * writes, approvals, failures and verifications never merge.
 *
 * Shapes: ``normalize(trace)`` returns ``[events, dropped]``; each event is a NormalizedEvent dump (a plain
 * object with exactly ``index, source_steps, kind, tool, phase, inputs, outputs, outcome, role, labels,
 * terminal, interaction_type``), validated like pydantic (``HX.traces.ValidationError``). ``eligibility(trace,
 * package)`` takes a normalized MachinePackage dump (``HX.pkg.normalize_package``) and returns violation dicts.
 * Python built-in errors on malformed records are ``HX.HXError`` with the class name as ``code``.
 */
(function (HX) {
  "use strict";
  const normalize_ns = (HX.normalize = HX.normalize || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const get = (d, k, dflt) => (hasOwn(d, k) ? d[k] : dflt);

  normalize_ns.NORMALIZER_VERSION = "hexis-service-trace-normalizer/1";
  normalize_ns.NOISE_KINDS = Object.freeze(["noop", "heartbeat", "log", "orchestration"]);
  normalize_ns.RECOGNIZED_KINDS = Object.freeze(["tool", "model", "judge", "user", "end"]);
  normalize_ns._EFFECT_KEYS = Object.freeze(["name", "input", "phase", "terminal"]);
  normalize_ns.NormalizedEvent = {
    model_fields: Object.freeze(["index", "source_steps", "kind", "tool", "phase", "inputs", "outputs", "outcome",
      "role", "labels", "terminal", "interaction_type"]),
    model_validate: (v) => HX.traces._validate_model("NormalizedEvent", v),
  };

  /* Python ``x in (tuple of str)``: == membership, so only an equal str matches. */
  const in_strs = (x, tuple) => typeof x === "string" && tuple.indexOf(x) >= 0;

  /** Recognized orchestration noise: a noise kind that names no tool, carries no input, output or terminal and
   *  writes nothing. A 'noise' record carrying any of those is unrecognized, not noise. */
  function is_noise(r) {
    const T = HX.traces;
    const a = r.action;
    return in_strs(get(a, "kind", ""), normalize_ns.NOISE_KINDS) && !normalize_ns._EFFECT_KEYS.some((k) => hasOwn(a, k)) &&
      !T._py_truthy(r.output) && !T._py_truthy(get(r.meta, "writes", null));
  }
  normalize_ns.is_noise = is_noise;

  /** Records that are neither a recognized action kind nor recognized noise. */
  normalize_ns.unrecognized = function (trace) {
    const out = [];
    for (const r of trace.records) {
      const kind = get(r.action, "kind", "");
      if (!in_strs(kind, normalize_ns.RECOGNIZED_KINDS) && !is_noise(r)) out.push({ step: r.step, kind });
    }
    return out;
  };

  function event(fields) { return HX.traces._validate_model("NormalizedEvent", fields); }

  /** ``dict(x)`` of a record output (always a dict on a validated record). */
  function dict_copy(o) {
    const out = {};
    for (const k of Object.keys(o)) HX.traces._set_own(out, k, o[k]);
    return out;
  }

  /** ``normalize(trace)`` -> ``[events, dropped]``; dropped lists every removed record with its reason. */
  normalize_ns.normalize = function (trace) {
    const T = HX.traces;
    const events = [];
    const dropped = [];
    let prev_raw = null; /* position in trace.records of the record that produced events[-1] */
    trace.records.forEach((r, pos) => {
      const kind = get(r.action, "kind", "");
      if (is_noise(r)) {
        dropped.push({ step: r.step, reason: "orchestration noise (" + T._py_str(kind) + ")" });
        return;
      }
      if (in_strs(kind, ["model", "judge"]) && !T._py_truthy(get(r.meta, "observable", null))) {
        dropped.push({ step: r.step, reason: "zero-width (non-observable model/judge step)" });
        return;
      }
      if (kind === "tool") {
        const lid = get(r.meta, "logical_action_id", null);
        const prev = events.length ? events[events.length - 1] : null;
        /* Merge only a retry of one logical operation: the immediately preceding raw record, same tool, same
           logical_action_id and identical input. Anything else is a distinct event. */
        if (prev !== null && prev.kind === "tool" && prev.tool === get(r.action, "name", null) && T._py_truthy(lid) &&
            prev.role === "lid:" + T._py_str(lid) && prev_raw === pos - 1 &&
            T._py_eq(prev.inputs, get(r.action, "input", null))) {
          prev.source_steps.push(r.step);
          prev.outputs = dict_copy(r.output); /* last attempt's observation of the same logical operation */
          prev_raw = pos;
          return;
        }
        events.push(event({ index: events.length, source_steps: [r.step], kind: "tool",
          tool: get(r.action, "name", ""), phase: get(r.action, "phase", ""), inputs: get(r.action, "input", null),
          outputs: dict_copy(r.output), outcome: T._py_str(get(r.output, "status", "")),
          role: T._py_truthy(lid) ? "lid:" + T._py_str(lid) : "", labels: T._py_list(get(r.action, "labels", [])) }));
      } else if (in_strs(kind, ["model", "judge"])) {
        events.push(event({ index: events.length, source_steps: [r.step], kind: "model_output",
          outputs: dict_copy(r.output) }));
      } else if (kind === "user") {
        events.push(event({ index: events.length, source_steps: [r.step], kind: "user", outputs: dict_copy(r.output),
          interaction_type: get(r.meta, "interaction_type", "") }));
      } else if (kind === "end") {
        events.push(event({ index: events.length, source_steps: [r.step], kind: "terminal",
          terminal: get(r.action, "terminal", "") }));
      } else {
        dropped.push({ step: r.step, reason: "unrecognized kind " + T._py_repr(kind) + " (kept out of alignment)",
          unrecognized: true });
        return;
      }
      prev_raw = pos;
    });
    events.forEach((e, i) => { e.index = i; });
    return [events, dropped];
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Selectors and eligibility                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  /** What a record of state ``sid`` looks like when the trace carries no state ids (null for model/judge). */
  function state_signature(pkg, sid) {
    const states = pkg.machine.states;
    if (!hasOwn(states, sid)) return null;
    const a = states[sid].action;
    if (a.kind === "tool") return ["tool", a.name, a.phase || ""];
    if (a.kind === "user") {
      const ics = pkg.contracts.interactions;
      const ic = hasOwn(ics, sid) ? ics[sid] : null;
      return ["user", ic ? ic.type : ""];
    }
    if (a.kind === "end") return ["end", a.terminal];
    return null; /* model/judge steps carry no identity in a stateless record */
  }
  normalize_ns._state_signature = state_signature;

  function record_signature(r, phase) {
    const T = HX.traces;
    const a = r.action;
    const k = get(a, "kind", null);
    if (k === "tool") {
      const p = get(a, "phase", null);
      return ["tool", get(a, "name", null), phase ? (T._py_truthy(p) ? p : phase) : phase];
    }
    if (k === "user") return ["user", get(r.meta, "interaction_type", "")];
    if (k === "end") return ["end", get(a, "terminal", null)];
    return [k];
  }
  normalize_ns._record_signature = record_signature;

  /* Tuple equality where the state signature holds only strings: an element matches only an equal string. */
  function sig_equal(rec, sig) {
    if (rec.length !== sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (rec[i] !== sig[i]) return false;
    return true;
  }

  function resolves_to(pkg, sid, r) {
    const sig = state_signature(pkg, sid);
    return sig !== null && sig_equal(record_signature(r, sig[0] === "tool" ? sig[2] : ""), sig);
  }
  normalize_ns._resolves_to = resolves_to;

  /** ``state:`` selector. Records without state ids resolve through the machine (C30). */
  function state_matches(val, r, pkg, requirement) {
    if (r.state || pkg === null || pkg === undefined) return r.state === val;
    if (!resolves_to(pkg, val, r)) return false;
    if (requirement) {
      /* A requirement is satisfied only by an unambiguous resolution: if another state looks the same the record
         cannot be attributed to ``val`` (never vacuously satisfied). */
      let n = 0;
      for (const s of Object.keys(pkg.machine.states)) if (resolves_to(pkg, s, r)) n++;
      return n === 1;
    }
    return true;
  }

  function partition(s, sep) {
    const i = s.indexOf(sep);
    return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
  }

  /** ``_matches(sel, r, package=None, requirement=False)``. */
  function matches(sel, r, pkg, requirement) {
    const [kind, , val] = partition(sel, ":");
    const a = r.action;
    if (kind === "tool") return get(a, "kind", null) === "tool" && get(a, "name", null) === val;
    if (kind === "state") return state_matches(val, r, pkg, !!requirement);
    if (kind === "terminal") return get(a, "kind", null) === "end" && get(a, "terminal", null) === val;
    if (kind === "user") return get(a, "kind", null) === "user" && get(r.meta, "interaction_type", null) === val;
    return false;
  }
  normalize_ns._matches = matches;

  /** Python ``set(x) & strs`` is non-empty (``x`` iterated like Python; unhashable elements raise TypeError). */
  function intersects(x, strs) {
    const T = HX.traces;
    let items;
    if (Array.isArray(x)) items = x;
    else if (typeof x === "string") items = Array.from(x);
    else if (HX.util.is_plain_object(x)) items = Object.keys(x);
    else throw T._pyerr("TypeError", "'" + T._py_type_name(x) + "' object is not iterable");
    let hit = false;
    for (const e of items) {
      if (Array.isArray(e) || HX.util.is_plain_object(e)) {
        throw T._pyerr("TypeError", "unhashable type: '" + T._py_type_name(e) + "'");
      }
      if (typeof e === "string" && strs.has(e)) hit = true;
    }
    return hit;
  }

  /** Constraint violations that make a trace ineligible for the protected archive. Checked on the raw record
   *  stream (including zero-width steps), with invalidation on writes. */
  normalize_ns.eligibility = function (trace, pkg) {
    const T = HX.traces;
    const violations = [];
    if (trace.verdict === "rejected") violations.push({ code: "REJECTED_VERDICT", step: trace.error_step });
    /* A record that is neither a recognized action nor recognized noise may hide an effect (X06). */
    for (const u of normalize_ns.unrecognized(trace)) {
      violations.push({ code: "UNRECOGNIZED_RECORD", step: u.step, requirement: "kind " + T._py_repr(u.kind) });
    }
    const reqs = pkg.contracts.ordering.concat(HX.validate.derived_ordering(pkg));
    for (const req of reqs) {
      const inval = new Set(req.invalidated_by);
      let satisfied = false;
      for (const r of trace.records) {
        if (matches(req.before, r, pkg) && !satisfied) {
          violations.push({ code: "ORDERING_VIOLATION", requirement: req.id, step: r.step, clause: req.clause });
          break;
        }
        if (req.requires.some((q) => matches(q, r, pkg, true))) satisfied = true;
        else if (intersects(hasOwn(r.meta, "writes") ? r.meta.writes : Object.keys(r.output), inval)) satisfied = false;
      }
    }
    /* A verified terminal must be preceded by a positive verifier result (no misleading success claims). */
    const terms = pkg.contracts.terminals;
    const verified = new Set(Object.keys(terms).filter((t) => terms[t].category === "verified"));
    for (const r of trace.records) {
      if (get(r.action, "kind", null) !== "end") continue;
      const term = get(r.action, "terminal", null);
      if (Array.isArray(term) || HX.util.is_plain_object(term)) {
        throw T._pyerr("TypeError", "unhashable type: '" + T._py_type_name(term) + "'");
      }
      if (typeof term !== "string" || !verified.has(term)) continue;
      for (const ev of terms[term].evidence) {
        const last = trace.records.filter((x) => x.step < r.step && get(x.action, "name", null) === ev.verifier_tool);
        /* ``str(status) not in POSITIVE_RESULTS``: only a str can stringify to "pass"/"match" (the str() of a number,
           bool, None, list or dict never does), so no repr is needed (a dict with integer-like keys stays printable) */
        const status = last.length ? get(last[last.length - 1].output, "status", null) : null;
        if (!last.length || typeof status !== "string" || HX.evidence.POSITIVE_RESULTS.indexOf(status) < 0) {
          violations.push({ code: "UNSUPPORTED_SUCCESS_CLAIM", step: r.step, claim: ev.claim });
        }
      }
    }
    /* Broker denials recorded in the trace mean an unauthorized action was attempted. */
    for (const r of trace.records) {
      if (get(r.meta, "broker_status", null) === "DENIED") violations.push({ code: "UNAUTHORIZED_ACTION_ATTEMPT", step: r.step });
    }
    return violations;
  };

  /** ``first_step(violations)``: the smallest non-null ``step``, or null. */
  normalize_ns.first_step = function (violations) {
    const steps = violations.filter((v) => hasOwn(v, "step") && v.step !== null && v.step !== undefined).map((v) => v.step);
    return steps.length ? steps.reduce((a, b) => (b < a ? b : a)) : null;
  };
})(globalThis.HX = globalThis.HX || {});
