/* Port of hexis_service/traces/update.py: trace-driven refinement (brief §9.3-9.5).
 *
 * ``propose_update`` never mutates the parent. It (1) checks archive eligibility, (2) tries the parent first,
 * (3) asks an aligner for operations, validates each operation independently of the aligner's rationale,
 * (4) builds the candidate on a deep copy, and (5) runs every gate: policy non-widening, static validation, replay
 * of the new trace, replay of EVERY protected trace, and the negative corpus. At most two candidate attempts; the
 * second is marked restrictive. Deployment is a separate admission step (``HX.registry.admit``) with a parent
 * compare-and-swap.
 *
 * API (Python names, keyword arguments as positional parameters in Python's order):
 *   MAX_ATTEMPTS
 *   new UpdateProposal(status, parent_hash, trace_id, {candidate, diff, gates, attempts, diagnostics,
 *     negative_additions, requires_review}) with ``to_json()``
 *   apply_ops(parent, ops, trace_ids = null) -> a sealed, normalized MachinePackage dump
 *   policy_widening(parent, cand) -> [finding string]
 *   evaluate_candidate(parent, cand, trace, protected, negative, catalog, skill_text = null) -> gates dict
 *   propose_update(parent, trace, protected, negative, catalog, aligner, skill_text = null) -> UpdateProposal
 *   archive_manifest(protected, negative), manifest_digest(protected, negative)
 *   _validate_ops(parent, ops, events, catalog) -> [error string]
 *
 * Packages are MachinePackage dumps (raw or normalized; they are normalized on entry, so an invalid dump throws
 * ``HX.pkg.PackageError``). Traces are ``HX.traces`` traces (sealed), events NormalizedEvent dumps. An aligner is any
 * object with ``model_id`` and ``propose(context) -> ops``. Operations are plain JSON objects and are used with
 * Python semantics (``dict.get``, ``[]`` with KeyError/IndexError/TypeError, truthiness, ``==``, hashing, list
 * insertion and negative indices); Python built-in exceptions are ``HX.HXError`` with the class name as ``code``.
 */
(function (HX) {
  "use strict";
  const update = (HX.update = HX.update || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  update.MAX_ATTEMPTS = 2;
  update.HELD_OUT_NOTE = "never stored here; held-out tasks are not given to the compiler or aligner";

  /* ------------------------------------------------------------------------------------------ */
  /* Python value helpers                                                                         */
  /* ------------------------------------------------------------------------------------------ */
  const T = () => HX.traces;
  const pyerr = (cls, msg) => HX.traces._pyerr(cls, msg);
  const is_dict = (v) => HX.util.is_plain_object(v);
  const tname = (v) => HX.traces._py_type_name(v);
  const truthy = (v) => HX.traces._py_truthy(v);
  const py_eq = (a, b) => HX.traces._py_eq(a, b);
  const py_str = (v) => HX.traces._py_str(v);
  const py_repr = (v) => HX.traces._py_repr(v);
  const repr_msg = (v) => HX.traces._py_repr_msg(v);
  /** ``d.get(key, dflt)`` (AttributeError on a non-dict). */
  const get = (d, key, dflt) => HX.traces._py_get(d, key, dflt === undefined ? null : dflt);
  const set_own = (o, k, v) => HX.traces._set_own(o, k, v);
  const clone = (v) => HX.traces._clone(v);

  /** A key for Python hashing/equality of a JSON value (``1 == 1.0 == True``); TypeError for unhashables. */
  function hkey(v) {
    if (v === null || v === undefined) return "N";
    if (typeof v === "boolean") return "n:" + (v ? 1 : 0);
    if (typeof v === "number") return "n:" + String(v === 0 ? 0 : v);
    if (typeof v === "string") return "s:" + v;
    throw pyerr("TypeError", "unhashable type: '" + tname(v) + "'");
  }
  update._hkey = hkey;

  /** Python ``int`` for list indices (``bool`` is an ``int``); TypeError otherwise. */
  function as_int(v, insert) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" && Number.isInteger(v)) return v;
    throw pyerr("TypeError", insert ? "'" + tname(v) + "' object cannot be interpreted as an integer"
      : "list indices must be integers or slices, not " + tname(v));
  }

  /* Values stored under non-str keys of a dict (Python allows them; a JS object cannot hold them). */
  const SIDE = new WeakMap();

  /** Python ``x[key]`` for JSON values. */
  function item(x, key) {
    if (is_dict(x)) {
      const h = hkey(key);
      if (typeof key === "string") {
        if (hasOwn(x, key)) return x[key];
      } else if (SIDE.has(x) && SIDE.get(x).has(h)) {
        return SIDE.get(x).get(h);
      }
      throw pyerr("KeyError", repr_msg(key));
    }
    if (Array.isArray(x)) {
      let i = as_int(key, false);
      if (i < 0) i += x.length;
      if (i < 0 || i >= x.length) throw pyerr("IndexError", "list index out of range");
      return x[i];
    }
    if (typeof x === "string") {
      if (typeof key === "boolean" || (typeof key === "number" && Number.isInteger(key))) {
        const cps = Array.from(x);
        let i = Number(key);
        if (i < 0) i += cps.length;
        if (i < 0 || i >= cps.length) throw pyerr("IndexError", "string index out of range");
        return cps[i];
      }
      throw pyerr("TypeError", "string indices must be integers, not '" + tname(key) + "'");
    }
    throw pyerr("TypeError", "'" + tname(x) + "' object is not subscriptable");
  }
  update._item = item;

  /** Python ``x[key] = value``. A value under a non-str key of a dict is kept on the side (never under a JS string
   *  spelling of the key) and recorded in ``bad``: pydantic later refuses it, since the typed maps take str keys. */
  function setitem(x, key, value, bad) {
    if (is_dict(x)) {
      const h = hkey(key);
      if (typeof key !== "string") {
        if (!SIDE.has(x)) SIDE.set(x, new Map());
        SIDE.get(x).set(h, value);
        if (bad) bad.flag = true;
        return;
      }
      set_own(x, key, value);
      return;
    }
    if (Array.isArray(x)) {
      let i = as_int(key, false);
      if (i < 0) i += x.length;
      if (i < 0 || i >= x.length) throw pyerr("IndexError", "list assignment index out of range");
      x[i] = value;
      return;
    }
    throw pyerr("TypeError", "'" + tname(x) + "' object does not support item assignment");
  }

  /** ``{**base, **x}``: a new dict (later keys override values in place); TypeError for a non-mapping ``x``. */
  function merged(base, x) {
    if (!is_dict(x)) throw pyerr("TypeError", "'" + tname(x) + "' object is not a mapping");
    const out = {};
    for (const k of Object.keys(base)) set_own(out, k, base[k]);
    for (const k of Object.keys(x)) set_own(out, k, x[k]);
    return out;
  }

  /** Python ``for x in v`` over a JSON value. */
  const iter = (v) => HX.traces._py_list(v);

  /** Python ``a >= b`` for the event index check (numbers and bools only). */
  function py_ge(a, b) {
    if (typeof a === "number" || typeof a === "boolean") return Number(a) >= b;
    throw pyerr("TypeError", "'>=' not supported between instances of '" + tname(a) + "' and 'int'");
  }

  function norm(p) { return HX.pkg.normalize_package(p); }

  /** Python ``isinstance(exc, pydantic.ValidationError)`` for the JS model errors. */
  function is_validation_error(e) {
    return (HX.efsm && e instanceof HX.efsm.EfsmError) || (HX.pkg && e instanceof HX.pkg.PackageError) ||
      (HX.traces && e instanceof HX.traces.ValidationError);
  }
  update._is_validation_error = is_validation_error;

  /* ------------------------------------------------------------------------------------------ */
  /* UpdateProposal                                                                               */
  /* ------------------------------------------------------------------------------------------ */
  class UpdateProposal {
    /** ``UpdateProposal(status, parent_hash, trace_id, candidate=None, diff={}, gates={}, attempts=[],
     *  diagnostics=[], negative_additions=[], requires_review=[])``. ``status``: NO_CHANGE | CANDIDATE | REJECTED |
     *  EXCLUDED. ``candidate`` is a MachinePackage dump or null. */
    constructor(status, parent_hash, trace_id, fields) {
      const f = fields || {};
      this.status = status;
      this.parent_hash = parent_hash;
      this.trace_id = trace_id;
      this.candidate = hasOwn(f, "candidate") ? f.candidate : null;
      this.diff = hasOwn(f, "diff") ? f.diff : {};
      this.gates = hasOwn(f, "gates") ? f.gates : {};
      this.attempts = hasOwn(f, "attempts") ? f.attempts : [];
      this.diagnostics = hasOwn(f, "diagnostics") ? f.diagnostics : [];
      this.negative_additions = hasOwn(f, "negative_additions") ? f.negative_additions : [];
      this.requires_review = hasOwn(f, "requires_review") ? f.requires_review : [];
    }

    to_json() {
      return { status: this.status, parent_hash: this.parent_hash, trace_id: this.trace_id,
        candidate_hash: this.candidate ? this.candidate.artifact_hash : null, diff: this.diff, gates: this.gates,
        attempts: this.attempts, diagnostics: this.diagnostics, negative_additions: this.negative_additions,
        requires_review: this.requires_review };
    }

    toJSON() { return this.to_json(); }
  }
  update.UpdateProposal = UpdateProposal;

  /* ------------------------------------------------------------------------------------------ */
  /* operation validation                                                                         */
  /* ------------------------------------------------------------------------------------------ */
  const EDGE_OPS = ["add_edge", "retarget_edge"];
  const RATIONALE_OPS = ["add_state", "add_edge", "retarget_edge", "add_variable"];
  const is_str_in = (v, list) => typeof v === "string" && list.indexOf(v) >= 0;

  /** ``_validate_ops(parent, ops, events, catalog)``: each operation checked independently of the aligner's
   *  rationale. ``parent`` is a MachinePackage dump, ``events`` NormalizedEvent dumps, ``catalog`` a ToolCatalog
   *  dump. */
  update._validate_ops = function _validate_ops(parent_, ops, events, catalog) {
    const parent = norm(parent_);
    const errs = [];
    const m = parent.machine;
    const list = iter(ops);
    /* new_states = {o["state"]["id"]: o["state"] for o in ops if o.get("op") == "add_state"} */
    const new_states = new Map();
    for (const o of list) {
      if (get(o, "op") === "add_state") {
        const id = item(item(o, "state"), "id");
        const k = hkey(id);
        const v = item(o, "state");
        if (new_states.has(k)) new_states.get(k)[1] = v;
        else new_states.set(k, [id, v]);
      }
    }
    const all_states = new Set();
    for (const s of Object.keys(m.states)) all_states.add(hkey(s));
    for (const k of new_states.keys()) all_states.add(k);
    const cat_get = (name) => {
      hkey(name);
      return typeof name === "string" && hasOwn(catalog.tools, name) ? catalog.tools[name] : null;
    };
    for (const o of list) {
      const kind = get(o, "op");
      if (kind === "match") {
        const sname = get(o, "state");
        hkey(sname);
        const st = typeof sname === "string" && hasOwn(m.states, sname) ? m.states[sname] : null;
        const sdk = hkey(get(o, "state"));
        const sd = new_states.has(sdk) ? new_states.get(sdk)[1] : null;
        const action = st ? st.action : get(truthy(sd) ? sd : {}, "action");
        const idx = get(o, "event_index");
        if (action === null || action === undefined || idx === null || idx === undefined || py_ge(idx, events.length)) {
          errs.push("match references unknown state/event: " + py_str(o));
          continue;
        }
        const ev = item(events, idx);
        const ag = (k) => get(action, k);
        const ok = (ev.kind === "tool" && py_eq(ag("kind"), "tool") && py_eq(ag("name"), ev.tool) &&
                    (!truthy(ag("phase")) || !truthy(ev.phase) || py_eq(ag("phase"), ev.phase))) ||
                   (ev.kind === "user" && py_eq(ag("kind"), "user")) ||
                   (ev.kind === "terminal" && py_eq(ag("kind"), "end") && py_eq(ag("terminal"), ev.terminal));
        if (!ok) {
          errs.push("match of event " + py_str(idx) + " (" + ev.kind + ":" + (ev.tool || ev.terminal) + ") to " +
            py_str(get(o, "state")) + " is incompatible regardless of rationale");
        }
      } else if (kind === "ignore") {
        if (!truthy(get(o, "reason"))) errs.push("ignore of event " + py_str(get(o, "event_index")) + " has no reason");
      } else if (kind === "add_state") {
        const a = get(item(o, "state"), "action", {});
        const id = item(item(o, "state"), "id");
        hkey(id);
        if (typeof id === "string" && hasOwn(m.states, id)) errs.push("add_state " + py_str(id) + " already exists");
        if (py_eq(get(a, "kind"), "tool") && cat_get(get(a, "name")) === null) {
          errs.push("add_state uses unregistered tool " + py_str(get(a, "name")));
        }
      } else if (is_str_in(kind, EDGE_OPS)) {
        let bad = !all_states.has(hkey(get(o, "from")));
        if (!bad) {
          const dflt = get(o, "to");
          bad = !all_states.has(hkey(get(get(o, "edge", {}), "to", dflt)));
        }
        if (bad) errs.push(kind + " references unknown state: " + py_str(o));
      } else if (!is_str_in(kind, ["add_variable", "set_coverage"])) {
        errs.push("unknown operation " + py_repr(kind));
      }
      if (is_str_in(kind, RATIONALE_OPS) && !truthy(get(o, "rationale"))) errs.push(kind + " needs a rationale");
    }
    return errs;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* apply_ops                                                                                    */
  /* ------------------------------------------------------------------------------------------ */
  const CHANGE_KEYS = ["op", "rationale", "clause", "from", "to", "event_index"];

  /** ``apply_ops(parent, ops, trace_ids=None)``: the candidate built on deep copies of the parent's machine and
   *  contracts (the operations' own objects are inserted by reference, as in Python), sealed. Unknown operation
   *  kinds (``match``, ``ignore``, ...) do not change the package. */
  update.apply_ops = function apply_ops(parent_, ops, trace_ids) {
    const parent = norm(parent_);
    const md = clone(parent.machine);
    const cd = clone(parent.contracts);
    const bad_m = { flag: false }, bad_c = { flag: false };
    const list = iter(ops);
    for (const o of list) {
      const k = item(o, "op");
      if (k === "add_variable") {
        const v = item(o, "variable");
        item(md, "variables").push(v);
        const contract = item(o, "contract");
        const vars = item(cd, "variables");
        setitem(vars, item(item(o, "variable"), "name"), contract, bad_c);
      } else if (k === "add_state") {
        const st = merged({ transitions: [], origin: "trace" }, item(o, "state"));
        const states = item(md, "states");
        setitem(states, item(st, "id"), st, bad_m);
        if (truthy(get(o, "interaction"))) {
          const ix = item(o, "interaction");
          setitem(item(cd, "interactions"), item(st, "id"), ix, bad_c);
        }
      } else if (k === "add_edge") {
        const trans = item(item(item(md, "states"), item(o, "from")), "transitions");
        const edge = merged({ "if": "", to: "", inc: null, support: 1, origin: "trace" }, item(o, "edge"));
        /* the default position is evaluated eagerly: len([t for t in trans if t.get("if")]) */
        let n = 0;
        for (const t of iter(trans)) if (truthy(get(t, "if"))) n++;
        const pos = hasOwn(o, "position") ? o.position : n;
        if (!Array.isArray(trans)) throw pyerr("AttributeError", "'" + tname(trans) + "' object has no attribute 'insert'");
        let i = as_int(pos, true);
        if (i < 0) i = Math.max(0, i + trans.length);
        if (i > trans.length) i = trans.length;
        trans.splice(i, 0, edge);
      } else if (k === "retarget_edge") {
        const to = item(o, "to");
        const trans = item(item(item(md, "states"), item(o, "from")), "transitions");
        const t = item(trans, item(o, "index"));
        if (Array.isArray(t)) throw pyerr("TypeError", "list indices must be integers or slices, not str");
        setitem(t, "to", to, bad_m);
      } else if (k === "set_coverage") {
        const cov = item(o, "coverage");
        setitem(item(cd, "clause_coverage"), item(o, "clause"), cov, bad_c);
      }
    }
    const changes = list.map((op) => {
      if (!is_dict(op)) throw pyerr("AttributeError", "'" + tname(op) + "' object has no attribute 'items'");
      const c = {};
      for (const kk of Object.keys(op)) if (CHANGE_KEYS.indexOf(kk) >= 0) set_own(c, kk, op[kk]);
      return c;
    });
    const lineage = HX.pkg.Lineage.model_validate({ parent_hash: parent.artifact_hash,
      trace_ids: truthy(trace_ids) ? iter(trace_ids) : [], changes });
    if (bad_m.flag) {
      throw new HX.efsm.EfsmError("Machine: dict keys must be str (pydantic string_type)",
        [{ type: "string_type", loc: ["states"], msg: "Input should be a valid string" }], "Machine");
    }
    const machine = HX.efsm.load_machine(md);
    if (bad_c.flag) {
      throw new HX.pkg.PackageError("Contracts: dict keys must be str (pydantic string_type)",
        [{ type: "string_type", loc: [], msg: "Input should be a valid string" }], "Contracts");
    }
    const contracts = HX.pkg.Contracts.model_validate(cd);
    return HX.pkg.sealed({ package_schema: parent.package_schema, machine, artifact_hash: "",
      source_manifest: parent.source_manifest, compiler_manifest: parent.compiler_manifest, contracts,
      execution_policy: parent.execution_policy, lineage });
  };

  /* ------------------------------------------------------------------------------------------ */
  /* gates                                                                                        */
  /* ------------------------------------------------------------------------------------------ */
  /* Strength of a coverage claim. An update may only strengthen a clause's coverage; a lateral move between equally
     ranked classes is treated as a downgrade (it changes what the clause means). */
  update._COVERAGE_RANK = Object.freeze({ non_material: 0, unsupported: 1, external_precondition: 2,
    state_local_knowledge: 2, executable_control: 3 });

  /** ``policy_widening(parent, cand)``: trace-driven updates may add states/variables/coverage; they may not weaken
   *  policy. Dumps are compared with Python ``==`` (``1 == 1.0 == True``, dict order ignored). */
  update.policy_widening = function policy_widening(parent_, cand_) {
    const parent = norm(parent_), cand = norm(cand_);
    const out = [];
    if (!py_eq(parent.execution_policy, cand.execution_policy)) {
      out.push("execution policy changed (capabilities/budgets/fallback) - requires separate policy review");
    }
    const pc = parent.contracts, cc = cand.contracts;
    if (!py_eq(pc.ordering, cc.ordering)) out.push("ordering requirements changed");
    if (!py_eq(pc.terminals, cc.terminals)) out.push("terminal contracts / evidence requirements changed");
    for (const k of Object.keys(pc.interactions)) {
      if (!hasOwn(cc.interactions, k) || !py_eq(cc.interactions[k], pc.interactions[k])) {
        out.push("existing interaction " + k + " changed or removed (approval cannot be removed by an update)");
      }
    }
    for (const k of Object.keys(pc.variables)) {
      if (!hasOwn(cc.variables, k) || !py_eq(cc.variables[k], pc.variables[k])) {
        out.push("variable contract " + k + " changed or removed");
      }
    }
    if (!py_eq(pc.field_scoped_writes, cc.field_scoped_writes)) out.push("field-scoped write contracts changed");
    if (!py_eq(pc.task_input_schema, cc.task_input_schema)) out.push("task input contract changed");
    const R = update._COVERAGE_RANK;
    for (const cid of Object.keys(pc.clause_coverage)) {
      const cov = pc.clause_coverage[cid];
      if (!hasOwn(cc.clause_coverage, cid)) {
        out.push("coverage of clause " + cid + " removed");
        continue;
      }
      const nw = cc.clause_coverage[cid];
      if (cov.classification !== nw.classification && R[nw.classification] <= R[cov.classification]) {
        out.push("coverage of clause " + cid + " downgraded (" + cov.classification + " -> " + nw.classification + ")");
      }
      if (cov.critical && !nw.critical) out.push("clause " + cid + " is no longer marked critical");
      if (cov.classification === "executable_control" && nw.classification === "executable_control") {
        const ns = new Set(nw.states);
        const gone = Array.from(new Set(cov.states)).filter((s) => !ns.has(s));
        if (gone.length) {
          gone.sort(HX.util.cmp_codepoints);
          out.push("executable control of clause " + cid + " remapped away from states " + py_repr(gone));
        }
      }
    }
    return out;
  };

  /** ``evaluate_candidate(parent, cand, trace, protected, negative, catalog, skill_text=None)`` -> the gates dict
   *  (policy_non_widening, static_validation, new_trace_replay, protected_replay, negative_corpus, passed). */
  update.evaluate_candidate = function evaluate_candidate(parent_, cand_, trace, protected_, negative, catalog, skill_text) {
    const parent = norm(parent_), cand = norm(cand_);
    const R = HX.replay;
    const gates = {};
    const widen = update.policy_widening(parent, cand);
    gates.policy_non_widening = { passed: !widen.length, findings: widen };
    const rep = HX.validate.validate_package(cand, catalog, "production",
      { skill_text: skill_text === undefined ? null : skill_text });
    gates.static_validation = { passed: rep.passed, findings: rep.errors().map((f) => f.to_json()) };
    const nr = R.replay_structural(cand, trace);
    gates.new_trace_replay = { passed: nr.status === "PASS", report: nr.to_json() };
    const prot = iter(protected_).map((t) => R.replay_structural(cand, t));
    gates.protected_replay = { passed: prot.every((r) => r.status === "PASS"), count: prot.length,
      failures: prot.filter((r) => r.status !== "PASS").map((r) => r.to_json()) };
    const neg = iter(negative).map((t) => R.replay_structural(cand, t));
    gates.negative_corpus = { passed: neg.every((r) => r.status !== "PASS"), count: neg.length,
      now_representable: neg.filter((r) => r.status === "PASS").map((r) => r.trace_id) };
    gates.passed = Object.keys(gates).every((k) => gates[k].passed);
    return gates;
  };

  /** ``propose_update(parent, trace, protected, negative, catalog, aligner, skill_text=None)``. */
  update.propose_update = function propose_update(parent_, trace, protected_, negative, catalog, aligner, skill_text) {
    const parent = norm(parent_);
    const prop = new UpdateProposal("REJECTED", parent.artifact_hash, trace.trace_id);
    const integ = HX.traces.integrity_errors(trace);
    if (integ.length) {
      prop.status = "EXCLUDED";
      prop.diagnostics = integ.map((e) => "trace integrity: " + e);
      return prop;
    }
    const viol = HX.normalize.eligibility(trace, parent);
    if (viol.length) {
      prop.status = "EXCLUDED";
      prop.diagnostics = viol.map((v) => {
        const req = get(v, "requirement");
        const why = truthy(req) ? req : (truthy(get(v, "claim")) ? get(v, "claim") : "");
        return py_str(item(v, "code")) + " at step " + py_str(get(v, "step")) + ": " + py_str(why);
      });
      prop.negative_additions = [trace.trace_id];
      return prop;
    }
    const first = HX.replay.replay_structural(parent, trace);
    if (first.status === "PASS") {
      prop.status = "NO_CHANGE";
      prop.gates = { new_trace_replay: { passed: true, report: first.to_json() } };
      return prop;
    }
    const [events, dropped] = HX.normalize.normalize(trace);
    let diagnostics = [first.to_json()];
    for (let attempt = 1; attempt <= update.MAX_ATTEMPTS; attempt++) {
      const ctx = { attempt, restrictive: attempt > 1, machine: clone(parent.machine), events: clone(events),
        dropped, divergence: first.divergence, diagnostics, /* the same list in every attempt, like Python */
        clauses: clone(parent.source_manifest.clauses) };
      const ops = aligner.propose(ctx);
      const op_errs = update._validate_ops(parent, ops, events, catalog);
      const entry = { attempt, restrictive: attempt > 1, operations: ops, op_errors: op_errs };
      if (op_errs.length) {
        prop.attempts.push(entry);
        diagnostics = [{ op_errors: op_errs }];
        continue;
      }
      let cand;
      try {
        cand = update.apply_ops(parent, ops, [trace.trace_id]);
      } catch (exc) {
        if (!(exc instanceof HX.HXError)) throw exc;
        entry.op_errors = ["candidate construction failed: " + exc.message];
        prop.attempts.push(entry);
        diagnostics = [{ op_errors: entry.op_errors }];
        continue;
      }
      const gates = update.evaluate_candidate(parent, cand, trace, protected_, negative, catalog, skill_text);
      entry.candidate_hash = cand.artifact_hash;
      const summary = {};
      for (const k of Object.keys(gates)) if (is_dict(gates[k])) summary[k] = gates[k].passed;
      entry.gates = summary;
      prop.attempts.push(entry);
      if (gates.passed) {
        prop.status = "CANDIDATE";
        prop.candidate = cand;
        prop.gates = gates;
        prop.diff = HX.diff.package_diff(parent, cand, catalog);
        if (prop.diff.newly_reachable_effects.length) {
          prop.requires_review.push("new consequential effects reachable: " + prop.diff.newly_reachable_effects.join(", "));
        }
        return prop;
      }
      prop.gates = gates;
      const failing = {};
      for (const k of Object.keys(gates)) if (is_dict(gates[k]) && !gates[k].passed) failing[k] = gates[k];
      diagnostics = [failing];
    }
    prop.diagnostics = ["all candidate attempts failed; parent machine and archive unchanged"];
    return prop;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* archive manifest                                                                             */
  /* ------------------------------------------------------------------------------------------ */
  update.archive_manifest = function archive_manifest(protected_, negative) {
    const ent = (t) => ({ trace_id: t.trace_id, records_digest: HX.traces.records_digest(t) });
    return { protected: iter(protected_).map(ent), negative: iter(negative).map(ent), held_out: update.HELD_OUT_NOTE };
  };

  update.manifest_digest = function manifest_digest(protected_, negative) {
    return HX.canonical.digest(update.archive_manifest(protected_, negative));
  };
})(globalThis.HX = globalThis.HX || {});
