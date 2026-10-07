/* Port of hexis_service/replay/replay.py: replay modes (brief §10). Never collapsed into one "verified" flag.
 *
 *  - ``structural``: can the machine represent the recorded observable sequence and exact terminal? Missing
 *    intermediate model/judge values become explicit placeholders (UNKNOWN); guards over unknown values branch.
 *    Placeholders are listed in the report and are never evidence.
 *  - ``recorded``: re-run the pure kernel over complete recorded observations; results must match the recorded
 *    checkpoint digests exactly. Network access is disabled by construction (``no_external_calls``); any
 *    attempted external call is a hard failure. Missing observations => INCOMPLETE.
 *  - ``sandbox_live``: running the RunService against fakes (evals), not a replay of a trace.
 *
 * Shapes: ``package`` is a normalized MachinePackage dump (``HX.pkg.normalize_package``); ``trace`` is an
 * ``HX.traces`` trace (its seal travels in ``HX.traces``' WeakMap). Reports are ``ReplayReport`` instances with
 * ``to_json()``. Python's context manager ``no_external_calls()`` is ``no_external_calls(fn)``: it runs ``fn``
 * with the network APIs replaced and restores them in a ``finally``. ``replay_recorded(package, trace,
 * {on_step})`` calls ``on_step(checkpoint_dump, observation_dump)`` before each kernel step.
 */
(function (HX) {
  "use strict";
  const replay_ns = (HX.replay = HX.replay || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  replay_ns.REPLAY_VERSION = "hexis-service-replay/1";
  replay_ns.MAX_NODES = 20000;

  /** Python: ``class ExternalCallAttempted(RuntimeError)``. */
  class ExternalCallAttempted extends HX.HXError {
    constructor(message) {
      super("EXTERNAL_CALL_ATTEMPTED", message);
      this.message = message; /* str(exc) */
    }
  }
  replay_ns.ExternalCallAttempted = ExternalCallAttempted;

  /** The browser network entry points replaced during recorded replay (and ``navigator.sendBeacon``). */
  replay_ns.NETWORK_GLOBALS = Object.freeze(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);

  function patch(obj, name, deny, restores) {
    const own = Object.getOwnPropertyDescriptor(obj, name);
    try {
      Object.defineProperty(obj, name, { value: deny, writable: true, configurable: true,
        enumerable: own ? !!own.enumerable : false });
    } catch (e) {
      throw new ExternalCallAttempted("cannot disable network access (" + name + "); refusing to replay");
    }
    restores.push(() => {
      if (own) Object.defineProperty(obj, name, own);
      else delete obj[name];
    });
    if (obj[name] !== deny) throw new ExternalCallAttempted("cannot disable network access (" + name + "); refusing to replay");
  }

  /** Run ``fn()`` with every network API replaced by a function that throws ``ExternalCallAttempted``; restore
   *  them afterwards (also on error). A present API that cannot be replaced fails closed (ExternalCallAttempted). */
  replay_ns.no_external_calls = function (fn) {
    const deny = function () { throw new ExternalCallAttempted("network access attempted during recorded replay"); };
    const restores = [];
    try {
      for (const name of replay_ns.NETWORK_GLOBALS) {
        if (typeof globalThis[name] !== "undefined") patch(globalThis, name, deny, restores);
      }
      const nav = globalThis.navigator;
      if (nav && typeof nav.sendBeacon !== "undefined") patch(nav, "sendBeacon", deny, restores);
      return fn();
    } finally {
      for (let i = restores.length - 1; i >= 0; i--) {
        try { restores[i](); } catch (e) { /* keep restoring the others */ }
      }
    }
  };

  /** Python's ``ReplayReport`` dataclass. */
  class ReplayReport {
    constructor(mode, trace_id, artifact_hash, status, fields) {
      fields = fields || {};
      this.mode = mode;
      this.trace_id = trace_id;
      this.artifact_hash = artifact_hash;
      this.status = status; /* PASS | FAIL | INCOMPLETE | REJECTED | ERROR */
      this.path = fields.path || [];
      this.placeholders = fields.placeholders || [];
      this.divergence = fields.divergence || {};
      this.detail = fields.detail || "";
    }
    to_json() {
      return { mode: this.mode, trace_id: this.trace_id, artifact_hash: this.artifact_hash, status: this.status,
        path: this.path, placeholders: this.placeholders, divergence: this.divergence, detail: this.detail,
        versions: { replay: replay_ns.REPLAY_VERSION, normalizer: HX.normalize.NORMALIZER_VERSION } };
    }
    toJSON() { return this.to_json(); }
  }
  replay_ns.ReplayReport = ReplayReport;

  /** ``replay(package, trace, mode, **kw)``. */
  replay_ns.replay = function (pkg, trace, mode, kw) {
    if (mode === "structural") return replay_ns.replay_structural(pkg, trace);
    if (mode === "recorded") return replay_ns.replay_recorded(pkg, trace, kw);
    throw HX.traces._pyerr("ValueError", "unsupported replay mode " + HX.traces._py_repr_msg(mode) +
      " (sandbox_live runs through evals/)");
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Structural replay                                                                            */
  /* ------------------------------------------------------------------------------------------ */

  /* Variable environments are null-prototype maps (any key is data; values may be guards.UNKNOWN). */
  function env_copy(env) {
    const out = Object.create(null);
    for (const k of Object.keys(env)) out[k] = env[k];
    return out;
  }

  function initial_env(pkg, trace) {
    const T = HX.traces, K = HX.kernel;
    const icp = hasOwn(trace.task, "initial_checkpoint") ? trace.task.initial_checkpoint : null;
    if (HX.util.is_plain_object(icp) && hasOwn(icp, "variables")) {
      const vars = icp.variables;
      if (!HX.util.is_plain_object(vars)) {
        throw new K.KernelError("INITIAL_CHECKPOINT_INVALID", "initial checkpoint variables are not an object");
      }
      const env = env_copy(T._clone(vars));
      /* Loop counters are engine-owned and start at their declared initial value; a recorded initial checkpoint
         that seeds them otherwise would shift every loop bound (X08). */
      const m = pkg.machine;
      const counters = new Set();
      for (const sid of Object.keys(m.states)) {
        for (const t of m.states[sid].transitions) if (T._py_truthy(t.inc)) counters.add(t.inc);
      }
      const decl = new Map();
      for (const v of m.variables) decl.set(v.name, v);
      for (const c of Array.from(counters).sort(HX.util.cmp_codepoints)) {
        if (c in env && decl.has(c) && !T._py_truthy(decl.get(c).init_from)) {
          const init = decl.get(c).init;
          if (!T._py_eq(env[c], T._py_truthy(init) ? init : 0)) {
            throw new K.KernelError("INITIAL_CHECKPOINT_INVALID", "loop counter " + T._py_repr(c) + " starts at " +
              T._py_repr(env[c]) + ", not its initial value");
          }
        }
      }
      return env;
    }
    const inp0 = hasOwn(trace.task, "input") ? trace.task.input : null;
    const inp = T._py_truthy(inp0) ? inp0 : {};
    return env_copy(K.initial_checkpoint(pkg, "replay", "replay", inp).variables);
  }
  replay_ns._initial_env = initial_env;

  function observable(st) {
    const a = st.action;
    return a.kind === "tool" || a.kind === "user" || a.kind === "end" || (a.kind === "model" && HX.traces._py_truthy(a.observable));
  }
  replay_ns._observable = observable;

  /** Canonical text of an environment with UNKNOWN as ``repr(UNKNOWN)`` (Python digests the same dict; equal
   *  canonical text <=> equal digest, so the visited-set key is the same). */
  function env_key(env) {
    const U = HX.guards.UNKNOWN;
    const d = {};
    for (const k of Object.keys(env)) HX.traces._set_own(d, k, env[k] === U ? "UNKNOWN" : env[k]);
    return HX.canonical.canonical_text(d);
  }

  /* Python's int() on a counter value: like HX.kernel._py_int, but also accepting Unicode decimal digits (str
     "\u0663", "\uff11", "\u0661_\u0662"), with CPython 3.12's decimal-digit table (HX.kernel._PY_RE_TABLES.d, Unicode
     15.0, whose runs each start at a digit zero). */
  let DIGIT_RUNS = null;
  function decimal_value(cp) {
    if (DIGIT_RUNS === null) {
      DIGIT_RUNS = [];
      for (const part of String(HX.kernel._PY_RE_TABLES.d).split(",")) {
        const [lo, hi] = part.split("-").map((x) => parseInt(x, 16));
        DIGIT_RUNS.push([lo, hi === undefined ? lo : hi]);
      }
    }
    for (const [lo, hi] of DIGIT_RUNS) if (cp >= lo && cp <= hi) return (cp - lo) % 10;
    return -1;
  }
  function py_int(v) {
    const K = HX.kernel;
    if (typeof v === "string" && /[^\x00-\x7f]/.test(v)) {
      let t = "", changed = false;
      for (const ch of v) {
        const d = ch.codePointAt(0) > 0x7f ? decimal_value(ch.codePointAt(0)) : -1;
        if (d >= 0) { t += String(d); changed = true; } else t += ch;
      }
      if (changed) {
        try {
          return K._py_int(t);
        } catch (exc) {
          if (!(exc instanceof HX.HXError) || exc.code !== "ValueError") throw exc;
          if (/outside the range/.test(exc.message)) throw exc;
        }
      }
    }
    return K._py_int(v);
  }
  replay_ns._py_int = py_int;

  replay_ns.replay_structural = function (pkg, trace) {
    const T = HX.traces, G = HX.guards, K = HX.kernel;
    const U = G.UNKNOWN;
    const rep = new ReplayReport("structural", trace.trace_id, pkg.artifact_hash, "FAIL");
    const errs = T.integrity_errors(trace);
    if (errs.length) {
      rep.status = "REJECTED";
      rep.detail = errs.slice(0, 3).join("; ");
      return rep;
    }
    const [events, dropped] = HX.normalize.normalize(trace);
    const bad = dropped.filter((d) => hasOwn(d, "unrecognized") && T._py_truthy(d.unrecognized)).map((d) => d.step);
    if (bad.length) {
      rep.status = "REJECTED";
      rep.detail = "unrecognized record kinds at steps " + T._py_repr(bad) + " (may hide effects)";
      return rep;
    }
    if (!events.length || events[events.length - 1].kind !== "terminal") {
      rep.status = "INCOMPLETE";
      rep.detail = "trace has no terminal event";
      return rep;
    }
    const m = pkg.machine;
    let env0;
    try {
      env0 = initial_env(pkg, trace);
    } catch (exc) {
      if (exc instanceof K.KernelError) {
        rep.status = "INCOMPLETE";
        rep.detail = "cannot reconstruct initial variables: " + exc.message;
        return rep;
      }
      throw exc;
    }
    let best = { idx: -1 };
    let nodes = 0;
    const seen = new Set();
    /* DFS stack: [state, event index, env, path, placeholders, previous anchor] */
    const stack = [[m.initial, 0, env0, [], [], null]];
    while (stack.length) {
      let [sid, idx, env, path, ph, anchor] = stack.pop();
      nodes += 1;
      if (nodes > replay_ns.MAX_NODES) {
        rep.status = "INCOMPLETE";
        rep.detail = "search exceeded " + replay_ns.MAX_NODES + " nodes; not a pass";
        return rep;
      }
      const key = sid + "\u0000" + idx + "\u0000" + env_key(env);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!hasOwn(m.states, sid)) throw T._pyerr("KeyError", T._py_repr(sid));
      const st = m.states[sid];
      const a = st.action;
      path = path.concat([sid]);
      const ev = idx < events.length ? events[idx] : null;

      const diverge = (expected, why) => {
        if (idx > best.idx) {
          const keys = Object.keys(env);
          let names = null;
          const guard_values = {};
          for (const k of keys) {
            if (names === null) {
              names = new Set();
              for (const t of st.transitions) if (t["if"]) for (const n of G.vars_of(t["if"])) names.add(n);
            }
            if (names.has(k)) T._set_own(guard_values, k, env[k] === U ? null : env[k]);
          }
          best = Object.assign(best, { idx, state: sid, expected, why, previous_anchor: anchor,
            path: path.slice(-12), guard_values });
        }
      };

      env = env_copy(env);
      if (a.kind === "end") {
        if (ev !== null && ev.kind === "terminal" && ev.terminal === a.terminal && idx === events.length - 1) {
          rep.status = "PASS";
          rep.path = path;
          rep.placeholders = ph;
          return rep;
        }
        diverge(ev ? T._clone(ev) : null, "machine ends at " + T._py_str(a.terminal));
        continue;
      }
      let nidx;
      if (observable(st)) {
        if (ev === null) {
          diverge(null, "trace exhausted before a terminal");
          continue;
        }
        if (a.kind === "tool") {
          if (ev.kind !== "tool" || ev.tool !== a.name || (a.phase && ev.phase && a.phase !== ev.phase)) {
            diverge(T._clone(ev), "state expects tool " + a.name);
            continue;
          }
          const bound = new Map();
          const src = new Map();
          for (const k of Object.keys(ev.outputs)) {
            const name = hasOwn(a.binds, k) ? a.binds[k] : k;
            /* two outputs binding the same name: Python keeps the later one in insertion order, which JS has lost
               when one of them is integer-like (fail closed; only reachable with an integer-like variable name,
               as the port refuses integer-like binds keys) */
            if (bound.has(name) && T._key_order_lost([src.get(name), k])) {
              throw T._pyerr("KEY_ORDER_UNKNOWN", "tool outputs " + T._py_repr_msg([src.get(name), k]) + " bind " +
                T._py_repr_msg(name) + ": the JavaScript port cannot recover their insertion order");
            }
            bound.set(name, ev.outputs[k]);
            src.set(name, k);
          }
          for (const w of a.writes) {
            if (bound.has(w)) env[w] = bound.get(w);
            else {
              env[w] = U;
              ph = ph.concat([{ state: sid, variable: w, reason: "tool output missing from trace" }]);
            }
          }
        } else if (a.kind === "user") {
          if (ev.kind !== "user") {
            diverge(T._clone(ev), "state expects a user interaction");
            continue;
          }
          for (const w of a.writes) {
            if (hasOwn(ev.outputs, w)) env[w] = ev.outputs[w];
            else {
              env[w] = U;
              ph = ph.concat([{ state: sid, variable: w, reason: "user response missing" }]);
            }
          }
        } else {
          if (ev.kind !== "model_output") {
            diverge(T._clone(ev), "state expects an observable model output");
            continue;
          }
          for (const w of a.writes) {
            if (hasOwn(ev.outputs, w)) env[w] = ev.outputs[w];
            else {
              env[w] = U;
              ph = ph.concat([{ state: sid, variable: w, reason: "model output missing from trace" }]);
            }
          }
        }
        nidx = idx + 1;
        anchor = sid + "@" + idx;
      } else { /* zero-width model/judge */
        for (const w of a.writes) {
          env[w] = U;
          ph = ph.concat([{ state: sid, variable: w, reason: "zero-width state: value not in trace" }]);
        }
        nidx = idx;
      }
      let branches = [];
      for (const t of HX.efsm.ordered_transitions(st)) {
        if (!t["if"]) {
          branches.push(t);
          break;
        }
        let v;
        try {
          v = G.evaluate3(t["if"], env);
        } catch (exc) {
          if (exc instanceof G.GuardError) {
            diverge(ev ? T._clone(ev) : null, "guard error: " + exc.message);
            branches = [];
            break;
          }
          throw exc;
        }
        if (v === true) {
          branches.push(t);
          break;
        }
        if (v === null) branches.push(t);
      }
      for (let i = branches.length - 1; i >= 0; i--) {
        const t = branches[i];
        let e2 = env;
        if (T._py_truthy(t.inc)) {
          e2 = env_copy(env);
          const cur = t.inc in e2 ? e2[t.inc] : null;
          if (cur === U) e2[t.inc] = U;
          else {
            const n = py_int(T._py_truthy(cur) ? cur : 0) + 1;
            if (!Number.isSafeInteger(n)) {
              throw T._pyerr("ValueError", "loop counter " + T._py_repr(t.inc) +
                " is outside the range supported by the JavaScript port");
            }
            e2[t.inc] = n;
          }
        }
        stack.push([t.to, nidx, e2, path, ph, anchor]);
      }
    }
    const g = (k) => (hasOwn(best, k) ? best[k] : null);
    rep.divergence = { trace_id: trace.trace_id, event_index: g("idx"), previous_anchor: g("previous_anchor"),
      expected_event: g("expected"), actual_state: g("state"), reason: g("why"), guard_values: g("guard_values"),
      path: g("path") };
    rep.detail = "no machine path represents the trace (diverged at event " + T._py_str(g("idx")) + ")";
    return rep;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Recorded replay                                                                              */
  /* ------------------------------------------------------------------------------------------ */

  /** The visible record (used by structural replay and eligibility) must describe exactly the recorded
   *  observation that recorded replay executes; otherwise the modes judge different runs. */
  function record_vs_observation(pkg, r, obs) {
    const T = HX.traces;
    const get = (d, k) => (hasOwn(d, k) ? d[k] : null);
    if (r.state && r.state !== obs.state_id) {
      return "record state " + T._py_repr(r.state) + " != observation state " + T._py_repr(obs.state_id);
    }
    if (get(r.action, "kind") !== obs.kind) {
      return "record kind " + T._py_repr(get(r.action, "kind")) + " != observation kind " + T._py_repr(obs.kind);
    }
    if (!T._py_eq(r.output, obs.outputs)) return "record output differs from observation outputs";
    const states = pkg.machine.states;
    const st = hasOwn(states, obs.state_id) ? states[obs.state_id] : null;
    if (obs.kind === "end" && (st === null || st.action.kind !== "end" || get(r.action, "terminal") !== st.action.terminal)) {
      return "record terminal " + T._py_repr(get(r.action, "terminal")) + " does not match observation state " +
        T._py_repr(obs.state_id);
    }
    if (obs.kind === "tool" && st !== null && st.action.kind === "tool" && get(r.action, "name") !== st.action.name) {
      return "record tool " + T._py_repr(get(r.action, "name")) + " does not match observation state " +
        T._py_repr(obs.state_id);
    }
    return "";
  }
  replay_ns._record_vs_observation = record_vs_observation;

  replay_ns.replay_recorded = function (pkg, trace, kw) {
    const T = HX.traces, K = HX.kernel;
    kw = kw || {};
    for (const k of Object.keys(kw)) {
      if (k !== "on_step") throw T._pyerr("TypeError", "replay_recorded() got an unexpected keyword argument " + T._py_repr_msg(k));
    }
    const on_step = kw.on_step === undefined ? null : kw.on_step;
    const rep = new ReplayReport("recorded", trace.trace_id, pkg.artifact_hash, "FAIL");
    const errs = T.integrity_errors(trace);
    if (errs.length) {
      rep.status = "REJECTED";
      rep.detail = errs.slice(0, 3).join("; ");
      return rep;
    }
    const icp = hasOwn(trace.task, "initial_checkpoint") ? trace.task.initial_checkpoint : null;
    if (!HX.util.is_plain_object(icp)) {
      rep.status = "INCOMPLETE";
      rep.detail = "trace has no initial checkpoint";
      return rep;
    }
    if ((hasOwn(icp, "artifact_hash") ? icp.artifact_hash : null) !== pkg.artifact_hash) {
      rep.status = "FAIL";
      rep.detail = "trace was recorded against a different artifact";
      return rep;
    }
    let cp, path;
    try {
      const early = replay_ns.no_external_calls(() => {
        cp = K.RunCheckpoint.model_validate(icp);
        path = [cp.state_id];
        for (const r of trace.records) {
          const obs_d = hasOwn(r.meta, "observation") ? r.meta.observation : null;
          if (!HX.util.is_plain_object(obs_d)) {
            rep.status = "INCOMPLETE";
            rep.detail = "record " + T._py_str(r.step) + " has no recorded observation";
            rep.path = path;
            return rep;
          }
          const obs = K.Observation.model_validate(obs_d);
          if (!T._py_truthy(hasOwn(r.meta, "checkpoint_digest_before") ? r.meta.checkpoint_digest_before : null)) {
            rep.status = "INCOMPLETE";
            rep.detail = "record " + T._py_str(r.step) + " has no recorded checkpoint digest";
            rep.path = path;
            return rep;
          }
          const mismatch = record_vs_observation(pkg, r, obs);
          if (mismatch) {
            rep.divergence = { record: r.step, reason: mismatch };
            rep.detail = "visible record disagrees with its recorded observation";
            rep.path = path;
            return rep;
          }
          if (HX.canonical.digest(cp) !== r.meta.checkpoint_digest_before) {
            rep.divergence = { record: r.step, reason: "checkpoint before step differs from recording" };
            rep.detail = "state evolution diverged";
            return rep;
          }
          if (on_step !== null) on_step(cp, obs);
          const res = K.advance(cp, obs, pkg);
          cp = res.checkpoint;
          path.push(cp.state_id);
          const after = hasOwn(r.meta, "checkpoint_digest_after") ? r.meta.checkpoint_digest_after : null;
          if (T._py_truthy(after) && HX.canonical.digest(cp) !== after) {
            rep.divergence = { record: r.step, reason: "checkpoint after step differs from recording", state: r.state };
            rep.detail = "transition decision or state evolution diverged";
            rep.path = path;
            return rep;
          }
        }
        return null;
      });
      if (early) return early;
    } catch (exc) {
      if (exc instanceof ExternalCallAttempted) {
        rep.status = "ERROR";
        rep.detail = "EXTERNAL_CALL_ATTEMPTED: " + exc.message;
        return rep;
      }
      if (exc instanceof K.KernelError) {
        rep.status = "FAIL";
        rep.detail = exc.code + ": " + exc.message;
        return rep;
      }
      throw exc;
    }
    rep.status = K.TERMINAL_STATUSES.indexOf(cp.status) >= 0 ? "PASS" : "INCOMPLETE";
    rep.path = path;
    const o = cp.outcome;
    rep.detail = "final status " + cp.status + ", outcome " +
      T._py_str(!T._py_truthy(o) ? o : (hasOwn(o, "terminal") ? o.terminal : null));
    return rep;
  };
})(globalThis.HX = globalThis.HX || {});
