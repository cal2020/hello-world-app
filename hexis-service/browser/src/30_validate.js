/* Port of hexis_service/artifacts/validate.py (HX.validate): static admission checks for production packages.
 *
 * Every finding carries a code and an exact location (state / edge index / variable / clause).
 * ``profile="production"`` treats every finding of severity ``error`` as blocking; the ``sandbox`` profile
 * downgrades provenance-only findings to warnings but never relaxes guard, ownership, ordering, loop or
 * tool-contract checks.
 *
 * Packages and catalogs are the normalized dumps of HX.pkg / HX.catalog (raw dicts are normalized first, which
 * raises PackageError / CatalogError where pydantic would). Finding order follows Python's iteration order.
 * Where Python iterates a ``set`` (duplicate variables/terminals, a state's writes for WRITE_OWNERSHIP, states
 * that cannot stop) its order is arbitrary per process; the port uses first-occurrence order. See
 * deviations/static.md.
 */
(function (HX) {
  "use strict";
  const validate = (HX.validate = HX.validate || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  validate.CRITICAL_MARK = "**MUST**";
  validate.SELECTOR_KINDS = ["state", "tool", "terminal", "user"];
  validate.VALIDATOR_VERSION = "hexis-service-validator/1";
  const TEMPLATE_SRC = "\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}";
  validate.TEMPLATE_RE = new RegExp(TEMPLATE_SRC);

  /* ------------------------------------------------------------------------------------------ */
  /* Python helpers                                                                               */
  /* ------------------------------------------------------------------------------------------ */

  function pyerr(type, msg) {
    const e = new HX.HXError(type, msg);
    e.message = msg;
    return e;
  }
  validate._pyerr = pyerr;

  const is_dict = (v) => HX.util.is_plain_object(v);

  function type_name(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (is_dict(v)) return "dict";
    return typeof v;
  }
  validate._type_name = type_name;

  /** Python repr() of a JSON value (exact str repr from HX.guards). ``float_field``: print numbers as floats. */
  function repr(v, float_field) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return float_field ? HX.canonical.py_float_repr(v) : HX.canonical.py_number(v);
    if (typeof v === "string") return HX.guards._py_repr_str(v);
    if (Array.isArray(v)) return "[" + v.map((x) => repr(x)).join(", ") + "]";
    if (typeof v === "object") return "{" + Object.keys(v).map((k) => repr(k) + ": " + repr(v[k])).join(", ") + "}";
    return String(v);
  }
  validate._repr = repr;

  /** Python str() of a JSON value. */
  function py_str(v, float_field) {
    return typeof v === "string" ? v : repr(v, float_field);
  }
  validate._py_str = py_str;

  /** Python ``==`` on JSON values (True == 1, 1 == 1.0; dict key order ignored). */
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
  validate._py_eq = py_eq;

  /** Python ``iter(v)`` for JSON values, as an array; TypeError when not iterable. */
  function py_iter(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return Array.from(v);
    if (is_dict(v)) return Object.keys(v);
    throw pyerr("TypeError", "'" + type_name(v) + "' object is not iterable");
  }
  validate._py_iter = py_iter;

  /** Python ``set(v)`` of JSON values: {strs: Set of strings, others: hashable non-strings}. Unhashable
   *  elements raise TypeError like Python. */
  function py_set(v) {
    const strs = new Set();
    const others = [];
    for (const x of py_iter(v)) {
      if (typeof x === "string") strs.add(x);
      else if (Array.isArray(x) || is_dict(x)) throw pyerr("TypeError", "unhashable type: '" + type_name(x) + "'");
      else others.push(x);
    }
    return { strs, others };
  }

  /** Python ``str.strip()`` (Unicode whitespace). */
  const py_strip = (s) => HX.clauses.py_strip(s);

  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  const sorted = (it) => Array.from(it).sort(cmp);

  /** Python slice ``seq[start:end]`` (step 1) on an array of code points; returns a string. */
  function py_slice(cps, start, end) {
    const n = cps.length;
    const norm = (i) => (i < 0 ? Math.max(0, i + n) : Math.min(i, n));
    const s = norm(start), e = norm(end);
    return s >= e ? "" : cps.slice(s, e).join("");
  }
  validate._py_slice = py_slice;

  function str_partition(s, sep) {
    const i = s.indexOf(sep);
    return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Finding / ValidationReport                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  const FINDING_FIELDS = ["code", "message", "severity", "state", "edge", "variable", "clause", "detail"];

  /** ``Finding(code, message, severity="error", state=None, edge=None, variable=None, clause=None, detail={})``.
   *  JS: ``new Finding(code, message, [severity], [{severity, state, edge, variable, clause, detail}])``. */
  class Finding {
    constructor(code, message, severity, opts) {
      if (severity !== null && typeof severity === "object") { opts = severity; severity = undefined; }
      opts = opts || {};
      this.code = code;
      this.message = message;
      this.severity = severity !== undefined ? severity : (opts.severity !== undefined ? opts.severity : "error");
      this.state = opts.state === undefined ? null : opts.state;
      this.edge = opts.edge === undefined ? null : opts.edge;
      this.variable = opts.variable === undefined ? null : opts.variable;
      this.clause = opts.clause === undefined ? null : opts.clause;
      this.detail = opts.detail === undefined ? {} : opts.detail;
    }

    /** Fields whose value is not None, {} or "" (Python ``to_json``). */
    to_json() {
      const out = {};
      for (const k of FINDING_FIELDS) {
        const v = this[k];
        if (v === null || v === undefined || v === "") continue;
        if (is_dict(v) && Object.keys(v).length === 0) continue;
        out[k] = v;
      }
      return out;
    }
  }
  validate.Finding = Finding;

  class ValidationReport {
    constructor(profile, artifact_hash, findings, analyses) {
      this.profile = profile;
      this.artifact_hash = artifact_hash;
      this.findings = findings;
      this.analyses = analyses;
    }

    /** Python property ``errors``: findings of severity ``error``. */
    errors() { return this.findings.filter((f) => f.severity === "error"); }

    get passed() { return this.errors().length === 0; }

    /** Set of error codes (insertion order). */
    codes() { return new Set(this.errors().map((f) => f.code)); }

    to_json() {
      const body = {
        validator: validate.VALIDATOR_VERSION, profile: this.profile, artifact_hash: this.artifact_hash,
        passed: this.passed, findings: this.findings.map((f) => f.to_json()), analyses: this.analyses,
      };
      body.report_digest = HX.canonical.digest(body);
      return body;
    }
  }
  validate.ValidationReport = ValidationReport;

  /* ------------------------------------------------------------------------------------------ */
  /* graph helpers                                                                                */
  /* ------------------------------------------------------------------------------------------ */

  /** Deviation #7 (deviations/static.md): a disjointness counterexample may hold an integral number at or above 2^53
   *  (the exact value Python found, e.g. ``1e16``, or a guards.md #6 representative). ``HX.canonical`` refuses such
   *  numbers, so the report could not be digested; the value is reported as its decimal digits in a string instead.
   *  The verdict (GUARDS_OVERLAP, an error) is unchanged. */
  function digestible_counterexample(cex) {
    if (cex === null || typeof cex !== "object") return cex;
    const out = {};
    for (const k of Object.keys(cex)) {
      const v = cex[k];
      const big = typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v);
      Object.defineProperty(out, k, { value: big ? BigInt(v).toString() : v, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  validate._digestible_counterexample = digestible_counterexample;
  const clone_cex = (c) => (c === null || typeof c !== "object" ? c : digestible_counterexample(c));

  /** Template variables ``${name}`` in a JSON value, as a Set. */
  validate.template_vars = function template_vars(obj) {
    const out = new Set();
    (function walk(o) {
      if (typeof o === "string") {
        const re = new RegExp(TEMPLATE_SRC, "g");
        let m;
        while ((m = re.exec(o)) !== null) out.add(m[1]);
      } else if (is_dict(o)) {
        for (const k of Object.keys(o)) walk(o[k]);
      } else if (Array.isArray(o)) {
        for (const v of o) walk(v);
      }
    })(obj);
    return out;
  };

  validate.action_reads = function (st) {
    const a = st.action;
    const reads = new Set(Array.isArray(a.reads) ? a.reads : []);
    if (a.kind === "tool") for (const v of validate.template_vars(a.input)) reads.add(v);
    return reads;
  };

  validate.action_writes = function (st) {
    return new Set(Array.isArray(st.action.writes) ? st.action.writes : []);
  };

  /** ``{sid: [targets in ordered_transitions order]}`` (null-prototype object, state order). */
  validate.successors = function (m) {
    const out = Object.create(null);
    for (const sid of Object.keys(m.states)) out[sid] = HX.efsm.ordered_transitions(m.states[sid]).map((t) => t.to);
    return out;
  };

  /** States reachable from ``start`` (a Set in BFS order; contains ``start`` even if it is not a state). */
  validate.reachable = function (m, start) {
    const succ = validate.successors(m);
    const seen = new Set([start]);
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const s = q[qi];
      for (const t of (hasOwn(succ, s) ? succ[s] : [])) {
        if (hasOwn(m.states, t) && !seen.has(t)) {
          seen.add(t);
          q.push(t);
        }
      }
    }
    return seen;
  };

  /** Python's recursive Tarjan raises RecursionError at about 996 nested calls minus the caller's stack depth;
   *  the port refuses earlier, at a fixed depth (deviations/static.md). */
  validate.MAX_SCC_DEPTH = 900;

  /** Tarjan's SCCs in Python's visiting order. ``succ``: Map or object of arrays. */
  function _sccs(nodes, succ) {
    const get = (v) => (succ instanceof Map ? succ.get(v) || [] : (hasOwn(succ, v) ? succ[v] : []));
    const index = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
    let counter = 0, depth = 0;
    function strong(v) {
      if (++depth > validate.MAX_SCC_DEPTH) {
        throw pyerr("RecursionError", "maximum recursion depth exceeded (JavaScript port limit: " + validate.MAX_SCC_DEPTH +
          " nested states in the strongly-connected-component search)");
      }
      index.set(v, counter);
      low.set(v, counter);
      counter += 1;
      stack.push(v);
      on.add(v);
      for (const w of get(v)) {
        if (!index.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (on.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        for (;;) {
          const w = stack.pop();
          on.delete(w);
          comp.push(w);
          if (w === v) break;
        }
        out.push(comp);
      }
      depth--;
    }
    for (const n of nodes) if (!index.has(n)) strong(n);
    return out;
  }
  validate._sccs = _sccs;

  function _matches(sel, sid, st, pkg) {
    const [kind, , val] = str_partition(sel, ":");
    const a = st.action;
    if (kind === "state") return sid === val;
    if (kind === "tool") return a.kind === "tool" && a.name === val;
    if (kind === "terminal") return a.kind === "end" && a.terminal === val;
    if (kind === "user") {
      const ints = pkg.contracts.interactions;
      const ic = hasOwn(ints, sid) ? ints[sid] : null;
      return a.kind === "user" && ic !== null && ic.type === val;
    }
    return false;
  }
  validate._matches = _matches;

  function state_of(m, sid) {
    if (!hasOwn(m.states, sid)) throw pyerr("KeyError", repr(sid));
    return m.states[sid];
  }

  /** Return a counterexample path violating ``req`` or null. Guard feasibility is ignored. The fallback
   *  state is also a start point. ``states``: optional iterable restricting the graph. */
  validate.check_ordering = function check_ordering(pkg, req, states) {
    const m = pkg.machine;
    const inval = new Set(req.invalidated_by || []);
    const allowed = states !== undefined && states !== null ? new Set(states) : new Set(Object.keys(m.states));
    const starts = [[m.initial, false]];
    if (hasOwn(m.states, m.fallback) && allowed.has(m.fallback) && m.fallback !== m.initial) starts.push([m.fallback, false]);
    const key = (sid, flag) => (flag ? "1" : "0") + sid;
    const parent = new Map();
    for (const s of starts) parent.set(key(s[0], s[1]), null);
    const q = starts.slice();
    for (let qi = 0; qi < q.length; qi++) {
      const [sid, flag] = q[qi];
      const st = state_of(m, sid);
      if (_matches(req.before, sid, st, pkg) && !flag) {
        const path = [];
        let cur = [sid, flag];
        while (cur !== null) {
          path.push(cur[0]);
          cur = parent.get(key(cur[0], cur[1]));
        }
        return path.reverse();
      }
      let nflag;
      if (req.requires.some((r) => _matches(r, sid, st, pkg))) nflag = true;
      else if ([...validate.action_writes(st)].some((w) => inval.has(w))) nflag = false;
      else nflag = flag;
      for (const t of HX.efsm.ordered_transitions(st)) {
        if (hasOwn(m.states, t.to) && allowed.has(t.to)) {
          const k = key(t.to, nflag);
          if (!parent.has(k)) {
            parent.set(k, [sid, flag]);
            q.push([t.to, nflag]);
          }
        }
      }
    }
    return null;
  };

  /** Why an ordering selector is malformed or matches nothing, else null. */
  validate.selector_problem = function selector_problem(sel, pkg, catalog) {
    const [kind, sep, val] = str_partition(sel, ":");
    if (!sep || validate.SELECTOR_KINDS.indexOf(kind) < 0 || !val || val !== py_strip(val)) {
      return "malformed selector " + repr(sel) + " (expected one of " +
        validate.SELECTOR_KINDS.map((k) => k + ":<name>").join(", ") + ")";
    }
    if (kind === "tool" && HX.catalog.get(catalog, val) === null) {
      return "selector " + repr(sel) + " names a tool that is not in the catalog";
    }
    const m = pkg.machine;
    if (!Object.keys(m.states).some((sid) => _matches(sel, sid, m.states[sid], pkg))) {
      return "selector " + repr(sel) + " matches no state of the machine";
    }
    return null;
  };

  /** Ways the package's execution policy is wider than the operator's (both ExecutionPolicy dumps). */
  validate.policy_widening_findings = function policy_widening_findings(pkg_policy, operator) {
    const out = [];
    const opc = new Set(operator.capability_ceiling);
    const extra = sorted(new Set(pkg_policy.capability_ceiling.filter((c) => !opc.has(c))));
    if (extra.length) out.push("capability_ceiling adds " + repr(extra));
    if (operator.fallback_mode === "stop_for_review" && pkg_policy.fallback_mode !== "stop_for_review") {
      out.push("fallback_mode " + repr(pkg_policy.fallback_mode) + " widens operator 'stop_for_review'");
    }
    if (operator.write_workflow && !pkg_policy.write_workflow) {
      out.push("write_workflow=false relaxes operator write-workflow controls");
    }
    for (const f of ["max_loop_bound", "structured_output_repairs", "transport_retries", "approval_expiry_s"]) {
      if (pkg_policy[f] > operator[f]) out.push(f + " " + py_str(pkg_policy[f]) + " > operator " + py_str(operator[f]));
    }
    const pb = pkg_policy.budgets, ob = operator.budgets;
    for (const f of ["max_steps", "max_tool_calls", "max_model_calls", "max_tokens", "max_elapsed_s"]) {
      if (pb[f] > ob[f]) out.push("budgets." + f + " " + py_str(pb[f]) + " > operator " + py_str(ob[f]));
    }
    if (ob.max_spend_usd !== null && ob.max_spend_usd !== undefined &&
        (pb.max_spend_usd === null || pb.max_spend_usd === undefined || pb.max_spend_usd > ob.max_spend_usd)) {
      out.push("budgets.max_spend_usd " + py_str(pb.max_spend_usd, true) + " exceeds operator " +
        py_str(ob.max_spend_usd, true));
    }
    return out;
  };

  /** OrderingRequirement dump. */
  const ordering_req = (id, requires, before, invalidated_by) => ({ id, requires, before, invalidated_by, clause: "" });

  /** Requirements implied by terminal evidence and approval contracts (OrderingRequirement dumps). */
  validate.derived_ordering = function derived_ordering(pkg) {
    const m = pkg.machine;
    const C = pkg.contracts;
    const out = [];
    for (const tid of Object.keys(C.terminals)) {
      for (const ev of C.terminals[tid].evidence) {
        out.push(ordering_req("derived:evidence:" + tid + ":" + ev.claim, ["tool:" + ev.verifier_tool],
          "terminal:" + tid, ev.subject_vars.slice()));
      }
    }
    for (const sid of Object.keys(C.interactions)) {
      const ic = C.interactions[sid];
      if (ic.type === "approval" && hasOwn(m.states, ic.approves_state)) {
        const target = m.states[ic.approves_state];
        out.push(ordering_req("derived:approval:" + sid, ["state:" + sid], "state:" + ic.approves_state,
          sorted(validate.action_reads(target))));
      }
    }
    return out;
  };

  function _top_conjuncts(expr) {
    const body = HX.guards.parse(expr).body;
    if (body.type === "BoolOp" && body.op === "And") return body.values.slice();
    return [body];
  }
  validate._top_conjuncts = _top_conjuncts;

  /** True iff ``expr`` has a top-level conjunct ``dvar == 'approved'``. */
  function _requires_approved(expr, dvar) {
    if (!expr) return false;
    let conj;
    try {
      conj = _top_conjuncts(expr);
    } catch (e) {
      if (e instanceof HX.guards.GuardError) return false;
      throw e;
    }
    for (const c of conj) {
      if (c.type === "Compare" && c.ops.length === 1 && c.ops[0] === "Eq") {
        const sides = [c.left, c.comparators[0]];
        const names = sides.filter((x) => x.type === "Name");
        const consts = sides.filter((x) => x.type === "Constant");
        if (names.length === 1 && names[0].id === dvar && consts.length === 1 && consts[0].value === "approved") return true;
      }
    }
    return false;
  }
  validate._requires_approved = _requires_approved;

  /** If ``expr`` has a top-level conjunct ``counter < K`` / ``counter <= K``, the number of times the edge
   *  can be taken with an increment of one from zero; else null. Raises GuardError for an invalid guard. */
  validate.edge_bound = function edge_bound(expr, counter) {
    if (!expr) return null;
    for (const c of _top_conjuncts(expr)) {
      if (c.type === "Compare" && c.ops.length === 1 && c.left.type === "Name" && c.left.id === counter &&
          c.comparators[0].type === "Constant") {
        const node = c.comparators[0];
        if (node.py_type !== "int") continue; /* bool, float and str constants are skipped */
        const k = node.value;
        if (c.ops[0] === "Lt") return Math.max(k, 0);
        if (c.ops[0] === "LtE") return Math.max(k + 1, 0);
      }
    }
    return null;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* validate_package                                                                             */
  /* ------------------------------------------------------------------------------------------ */

  const EXPECTED_OWNER = { model: "model", judge: "model", tool: "tool", user: "user" };

  function operator_policy(dp) {
    const src = hasOwn(dp, "execution_policy") ? dp.execution_policy : dp;
    return HX.pkg.ExecutionPolicy.model_validate(src);
  }

  /** ``validate_package(pkg, catalog, profile="production", {skill_text, deployment_policy})``.
   *  ``deployment_policy``: a DeploymentPolicy dump (anything with ``execution_policy``) or an ExecutionPolicy
   *  dump; when given, the package's own policy may not widen it. */
  validate.validate_package = function validate_package(package_, catalog_, profile, opts) {
    if (profile === undefined || profile === null) profile = "production";
    opts = opts || {};
    const skill_text = opts.skill_text === undefined ? null : opts.skill_text;
    const deployment_policy = opts.deployment_policy === undefined ? null : opts.deployment_policy;
    const G = HX.guards;
    const pkg = HX.pkg.normalize_package(package_);
    const catalog = HX.catalog.load_catalog(catalog_);
    const WRITE = new Set(HX.catalog.WRITE_EFFECTS);
    const F = [];
    const analyses = [];
    const m = pkg.machine;
    const C = pkg.contracts;
    const P = pkg.execution_policy;
    const types = HX.efsm.var_types(m);
    const has_type = (v) => hasOwn(types, v);
    const type_of = (v) => (has_type(v) ? types[v] : null);
    const states = m.states;
    const sids = Object.keys(states);
    const has_state = (s) => hasOwn(states, s);
    const cget = (map, k) => (hasOwn(map, k) ? map[k] : null);

    const err = (code, msg, kw) => { F.push(new Finding(code, msg, "error", kw)); };
    const report = () => new ValidationReport(profile, pkg.artifact_hash, F, analyses);

    /* ---- integrity ---- */
    if (!pkg.artifact_hash) err("HASH_MISSING", "package is unsealed: artifact_hash is empty");
    else if (!HX.pkg.verify_hash(pkg)) err("HASH_MISMATCH", "artifact_hash does not match the canonical hash payload");
    if (deployment_policy !== null) {
      const op = operator_policy(deployment_policy);
      for (const w of validate.policy_widening_findings(P, op)) {
        err("POLICY_EXCEEDS_DEPLOYMENT", "execution_policy exceeds the operator deployment policy: " + w);
      }
    }
    if (pkg.source_manifest.tool_catalog_sha256 !== HX.catalog.digest(catalog)) {
      err("CATALOG_MISMATCH", "package was compiled against a different tool catalog digest");
    }
    for (const e of HX.catalog.check_schemas(catalog)) err("CATALOG_SCHEMA", e);

    /* ---- structure ---- */
    for (const sid of sids) {
      const st = states[sid];
      if (sid !== st.id) err("STATE_ID_MISMATCH", "state key " + repr(sid) + " != id " + repr(st.id), { state: sid });
    }
    const names = m.variables.map((v) => v.name);
    for (const n of dupes(names)) err("DUPLICATE_VARIABLE", "variable " + repr(n) + " declared more than once", { variable: n });
    const tids = m.terminals.map((t) => t.id);
    for (const t of dupes(tids)) err("DUPLICATE_TERMINAL", "terminal " + repr(t) + " declared more than once");
    if (!has_state(m.initial)) {
      err("UNKNOWN_INITIAL", "initial state " + repr(m.initial) + " does not exist", { state: m.initial });
      return report();
    }
    if (!has_state(m.fallback)) {
      err("UNKNOWN_FALLBACK", "fallback state " + repr(m.fallback) + " does not exist", { state: m.fallback });
    }
    for (const v of names) {
      if (!hasOwn(C.variables, v)) err("VARIABLE_CONTRACT_MISSING", "variable " + repr(v) + " has no ownership contract", { variable: v });
    }
    for (const v of Object.keys(C.variables)) {
      if (!has_type(v)) err("UNKNOWN_VARIABLE", "contract names undeclared variable " + repr(v), { variable: v });
    }
    for (const t of m.terminals) {
      const tc = cget(C.terminals, t.id);
      if (tc === null) err("TERMINAL_CONTRACT_MISSING", "terminal " + repr(t.id) + " has no contract");
      else if (t.kind && t.kind !== tc.category) {
        err("TERMINAL_CATEGORY_MISMATCH", "terminal " + repr(t.id) + " kind " + repr(t.kind) + " != contract " + repr(tc.category));
      }
      for (const o of t.output) {
        if (!has_type(o)) err("UNKNOWN_VARIABLE", "terminal " + repr(t.id) + " outputs undeclared " + repr(o), { variable: o });
      }
    }
    const tidset = new Set(tids);
    for (const tid of Object.keys(C.terminals)) {
      if (!tidset.has(tid)) err("UNKNOWN_TERMINAL", "terminal contract for undeclared terminal " + repr(tid));
    }

    const ceiling = new Set(P.capability_ceiling);
    const owner = new Map();
    for (const k of Object.keys(C.variables)) owner.set(k, C.variables[k].owner);
    const counters_written_by_inc = new Set();

    for (const sid of sids) {
      const st = states[sid];
      const a = st.action;
      const writes = validate.action_writes(st);
      const rw = new Set([...validate.action_reads(st), ...writes]);
      for (const v of sorted(rw)) {
        if (!has_type(v)) {
          err("UNKNOWN_VARIABLE", "state " + sid + " references undeclared variable " + repr(v), { state: sid, variable: v });
        }
      }
      if (a.kind === "end") {
        if (!tidset.has(a.terminal)) err("UNKNOWN_TERMINAL", "state " + sid + " ends in undeclared terminal " + repr(a.terminal), { state: sid });
        if (st.transitions.length) err("TERMINAL_HAS_EDGES", "end state " + sid + " has outgoing transitions", { state: sid });
        continue;
      }
      if (!st.transitions.length) err("NO_TRANSITIONS", "non-terminal state " + sid + " has no outgoing transitions", { state: sid });
      const expected_owner = EXPECTED_OWNER[a.kind];
      for (const w of writes) {
        if (owner.has(w) && owner.get(w) !== expected_owner) {
          err("WRITE_OWNERSHIP", a.kind + " state " + sid + " writes " + repr(w) + " owned by " + owner.get(w), { state: sid, variable: w });
        }
      }
      if (a.kind === "judge") {
        const w = a.writes[0];
        const schema = hasOwn(C.variables, w) ? C.variables[w].schema : {};
        const enm = hasOwn(schema, "enum") ? schema.enum : null;
        if (type_of(w) !== "string") {
          err("JUDGE_LABEL_TYPE", "judge " + sid + " label variable " + repr(w) + " must be a string", { state: sid, variable: w });
        }
        if (enm !== null) {
          const es = py_set(enm);
          const ls = new Set(a.labels);
          const same = es.others.length === 0 && es.strs.size === ls.size && [...ls].every((x) => es.strs.has(x));
          if (!same) {
            err("JUDGE_LABELS_SCHEMA", "judge " + sid + " labels " + repr(a.labels) + " differ from schema enum " + py_str(enm), { state: sid });
          }
        }
      }
      if (a.kind === "user") {
        const ic = cget(C.interactions, sid);
        if (ic === null) err("INTERACTION_CONTRACT_MISSING", "user state " + sid + " has no interaction contract", { state: sid });
        else if (ic.type === "approval" && !has_state(ic.approves_state)) {
          err("UNKNOWN_STATE", "approval " + sid + " approves unknown state " + repr(ic.approves_state),
            { state: sid, detail: { malformed_requirement: "interaction:" + sid } });
        }
      }
      if (a.kind === "tool") {
        const spec = HX.catalog.get(catalog, a.name);
        if (spec === null) {
          err("UNKNOWN_TOOL", "state " + sid + " calls unregistered tool " + repr(a.name), { state: sid });
          continue;
        }
        if (!ceiling.has(spec.capability)) {
          err("CAPABILITY_EXCEEDS_CEILING", "tool " + a.name + " needs " + repr(spec.capability) + " outside package ceiling", { state: sid });
        }
        const out_props_obj = py_or(hasOwn(spec.output_schema, "properties") ? spec.output_schema.properties : null, {});
        if (!is_dict(out_props_obj)) throw pyerr("AttributeError", "'" + type_name(out_props_obj) + "' object has no attribute 'keys'");
        const out_props = Object.keys(out_props_obj);
        const in_props = py_or(hasOwn(spec.input_schema, "properties") ? spec.input_schema.properties : null, {});
        const binds = a.binds;
        for (const k of Object.keys(binds)) {
          const target = binds[k];
          if (out_props.indexOf(k) < 0) err("BIND_UNKNOWN_OUTPUT", sid + " binds unknown output key " + repr(k) + " of " + a.name, { state: sid });
          if (a.writes.indexOf(target) < 0) {
            err("BIND_TARGET_NOT_WRITTEN", sid + " binds " + repr(k) + " to " + repr(target) + " not in writes", { state: sid, variable: target });
          }
        }
        const producible = new Set(out_props.map((k) => (hasOwn(binds, k) ? binds[k] : k)));
        for (const w of a.writes) {
          if (!producible.has(w)) {
            err("WRITE_NOT_PRODUCED", sid + " declares write " + repr(w) + " that " + a.name + " cannot produce", { state: sid, variable: w });
          }
        }
        const required = hasOwn(spec.input_schema, "required") ? spec.input_schema.required : [];
        for (const k of py_iter(required)) {
          if (Array.isArray(k) || is_dict(k)) throw pyerr("TypeError", "unhashable type: '" + type_name(k) + "'");
          if (!(typeof k === "string" && hasOwn(a.input, k))) {
            err("TOOL_INPUT_MISSING", sid + " omits required input " + repr(k) + " of " + a.name, { state: sid });
          }
        }
        if (spec.input_schema.additionalProperties === false) {
          for (const k of Object.keys(a.input)) {
            if (!py_contains(in_props, k)) err("TOOL_INPUT_UNKNOWN", sid + " passes unknown input " + repr(k) + " to " + a.name, { state: sid });
          }
        }
        for (const k of Object.keys(a.input)) {
          const tmpl = a.input[k];
          if (typeof tmpl === "string" && !new RegExp("^(?:" + TEMPLATE_SRC + ")$").test(tmpl) && validate.TEMPLATE_RE.test(tmpl)) {
            const re = new RegExp(TEMPLATE_SRC, "g");
            let mm;
            while ((mm = re.exec(tmpl)) !== null) {
              const v = mm[1];
              const t = type_of(v);
              if (t !== "string" && t !== "integer" && t !== "number") {
                err("TEMPLATE_TYPE", sid + " interpolates non-scalar " + repr(v) + " into a string", { state: sid, variable: v });
              }
            }
          }
        }
      }
      st.transitions.forEach((t, i) => {
        if (!has_state(t.to)) err("UNKNOWN_TARGET", sid + " edge " + i + " targets unknown state " + repr(t.to), { state: sid, edge: i });
        if (t.inc) {
          counters_written_by_inc.add(t.inc);
          if (type_of(t.inc) !== "integer") err("COUNTER_TYPE", sid + " edge " + i + " increments non-integer " + repr(t.inc), { state: sid, edge: i });
          if ((owner.has(t.inc) ? owner.get(t.inc) : null) !== "engine") {
            err("COUNTER_OWNERSHIP", "counter " + repr(t.inc) + " must be engine-owned", { state: sid, variable: t.inc });
          }
        }
      });
    }

    for (const [v, o] of owner) {
      if (o === "engine") {
        const vr = HX.efsm.var(m, v);
        if (vr !== null && vr.init_from) err("ENGINE_FROM_TASK", "engine-owned " + repr(v) + " cannot be initialised from task input", { variable: v });
      }
    }
    for (const v of sorted(counters_written_by_inc)) {
      const vr = HX.efsm.var(m, v);
      if (vr !== null && !(typeof vr.init === "number" && Number.isInteger(vr.init) && vr.init === 0)) {
        err("COUNTER_INIT", "loop counter " + repr(v) + " must be initialised to integer 0 (got " + repr(vr.init) + ")", { variable: v });
      }
    }

    /* ---- guards ---- */
    for (const sid of sids) {
      const st = states[sid];
      if (st.action.kind === "end") continue;
      const defaults = [];
      st.transitions.forEach((t, i) => { if (!t["if"]) defaults.push(i); });
      if (defaults.length > 1) err("MULTIPLE_DEFAULTS", sid + " has " + defaults.length + " default edges", { state: sid });
      if (!defaults.length) err("NO_DEFAULT", sid + " has no default edge (every nonterminal state needs a safe default)", { state: sid });
      else if (defaults[defaults.length - 1] !== st.transitions.length - 1) {
        err("DEFAULT_NOT_LAST", sid + " default edge is not last in serialized order", { state: sid, edge: defaults[defaults.length - 1] });
      }
      const guarded = [];
      st.transitions.forEach((t, i) => { if (t["if"]) guarded.push([i, t["if"]]); });
      for (const [i, g] of guarded) {
        for (const e of G.typecheck(g, types)) {
          err("GUARD_INVALID", sid + " edge " + i + ": " + e, { state: sid, edge: i, detail: { guard: g } });
        }
      }
      if (guarded.length && defaults.length) {
        const last = defaults[defaults.length - 1];
        const dt = cget(states, st.transitions[last].to);
        if (dt !== null && dt.action.kind === "tool") {
          const spec = HX.catalog.get(catalog, dt.action.name);
          if (spec !== null && WRITE.has(spec.effect)) {
            err("UNSAFE_DEFAULT", sid + " default edge falls through to consequential write " + dt.id, { state: sid, edge: last });
          }
        }
      }
      if (guarded.length >= 2 && !F.some((f) => f.state === sid && f.code === "GUARD_INVALID")) {
        const an = G.analyze_disjoint(guarded.map((x) => x[1]), types);
        const cex = digestible_counterexample(an.counterexample);
        analyses.push({ state: sid, analysis: "disjointness", status: an.status, detail: an.detail, counterexample: cex });
        if (an.status === "COUNTEREXAMPLE") {
          err("GUARDS_OVERLAP", sid + ": guarded edges " + repr(an.edges.map((i) => guarded[i][0])) + " overlap",
            { state: sid, detail: { counterexample: clone_cex(cex) } });
        } else if (an.status === "UNKNOWN") {
          err("GUARDS_DISJOINTNESS_UNKNOWN", sid + ": disjointness not proven (" + an.detail + ")", { state: sid });
        }
      }
    }

    /* ---- reachability ---- */
    let reach = validate.reachable(m, m.initial);
    const fb_reach = has_state(m.fallback) ? validate.reachable(m, m.fallback) : new Set();
    for (const sid of sids) {
      if (!reach.has(sid) && !hasOwn(C.explained_unreachable, sid) && !fb_reach.has(sid)) {
        err("DEAD_STATE", "state " + sid + " is unreachable from " + m.initial, { state: sid });
      }
    }
    reach = new Set([...reach, ...fb_reach]);
    const ends = sids.filter((sid) => states[sid].action.kind === "end");
    const pred = new Map(sids.map((s) => [s, new Set()]));
    for (const sid of sids) for (const t of states[sid].transitions) if (pred.has(t.to)) pred.get(t.to).add(sid);
    const can_stop = new Set(ends);
    const q = ends.slice();
    for (let qi = 0; qi < q.length; qi++) {
      for (const p of pred.get(q[qi])) {
        if (!can_stop.has(p)) {
          can_stop.add(p);
          q.push(p);
        }
      }
    }
    for (const sid of reach) if (!can_stop.has(sid)) err("NO_ROUTE_TO_STOP", "state " + sid + " cannot reach any terminal", { state: sid });

    /* ---- dataflow: definite assignment ---- */
    const req_raw = hasOwn(C.task_input_schema, "required") ? C.task_input_schema.required : [];
    const required_task = py_set(req_raw).strs;
    const a0 = new Set();
    for (const v of m.variables) {
      if (v.init !== null && v.init !== undefined) a0.add(v.name);
      else if (v.init_from && required_task.has(v.init_from.split(".").pop())) a0.add(v.name);
      else if (v.init_from) F.push(new Finding("OPTIONAL_TASK_INPUT", repr(v.name) + " comes from optional task field", "warning", { variable: v.name }));
    }
    const universe = new Set(Object.keys(types));
    const entries = new Set([m.initial]);
    if (reach.has(m.fallback)) entries.add(m.fallback);
    const IN = new Map(), OUT = new Map();
    const union = (a, b) => { const o = new Set(a); for (const x of b) o.add(x); return o; };
    const set_eq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
    for (const s of reach) {
      IN.set(s, new Set(entries.has(s) ? a0 : universe));
      OUT.set(s, union(IN.get(s), validate.action_writes(states[s])));
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of reach) {
        let new_in;
        if (entries.has(s)) new_in = new Set(a0);
        else {
          new_in = new Set(universe);
          for (const p of pred.get(s)) {
            if (!reach.has(p)) continue;
            const o = OUT.get(p);
            for (const x of [...new_in]) if (!o.has(x)) new_in.delete(x);
          }
        }
        const new_out = union(new_in, validate.action_writes(states[s]));
        if (!set_eq(new_in, IN.get(s)) || !set_eq(new_out, OUT.get(s))) {
          IN.set(s, new_in);
          OUT.set(s, new_out);
          changed = true;
        }
      }
    }
    for (const s of sorted(reach)) {
      const st = states[s];
      const ins = IN.get(s);
      for (const v of sorted([...validate.action_reads(st)].filter((x) => !ins.has(x)))) {
        if (has_type(v)) err("READ_BEFORE_WRITE", s + " reads " + repr(v) + " which is not assigned on every path", { state: s, variable: v });
      }
      st.transitions.forEach((t, i) => {
        if (!t["if"]) return;
        let gv;
        try {
          gv = G.vars_of(t["if"]);
        } catch (e) {
          if (e instanceof G.GuardError) return;
          throw e;
        }
        const outs = OUT.get(s);
        for (const v of sorted([...gv].filter((x) => !outs.has(x)))) {
          if (has_type(v)) err("GUARD_READ_BEFORE_WRITE", s + " edge " + i + " guard reads unassigned " + repr(v), { state: s, edge: i, variable: v });
        }
      });
      if (st.action.kind === "end") {
        const term = HX.efsm.terminal(m, st.action.terminal);
        for (const o of (term ? term.output : [])) {
          if (!ins.has(o)) err("TERMINAL_OUTPUT_UNASSIGNED", s + " terminal output " + repr(o) + " not assigned on every path", { state: s, variable: o });
        }
      }
    }

    /* ---- loops ---- */
    const succ_r = new Map();
    for (const s of reach) succ_r.set(s, states[s].transitions.map((t) => t.to).filter((x) => reach.has(x)));
    for (const comp of _sccs(sorted(reach), succ_r)) {
      const cs = new Set(comp);
      if (comp.length === 1 && (succ_r.get(comp[0]) || []).indexOf(comp[0]) < 0) continue;
      const rest = new Map(comp.map((s) => [s, []]));
      const bounds = [];
      for (const s of comp) {
        states[s].transitions.forEach((t, i) => {
          if (!cs.has(t.to)) return;
          const b = t.inc ? validate.edge_bound(t["if"], t.inc) : null;
          if (b !== null && (owner.has(t.inc) ? owner.get(t.inc) : null) === "engine") {
            if (b > P.max_loop_bound) {
              err("LOOP_BOUND_EXCEEDS_CEILING", s + " edge " + i + " allows " + b + " iterations > ceiling " + P.max_loop_bound, { state: s, edge: i });
            }
            bounds.push({ state: s, edge: i, counter: t.inc, bound: b });
            return;
          }
          rest.get(s).push(t.to);
        });
      }
      const cyc = _sccs(comp, rest).filter((c) => c.length > 1 || (rest.get(c[0]) || []).indexOf(c[0]) >= 0);
      analyses.push({ analysis: "loop", component: sorted(comp), bounded_edges: bounds, status: cyc.length ? "COUNTEREXAMPLE" : "PROVEN" });
      for (const c of cyc) {
        const sc = sorted(c);
        err("LOOP_UNBOUNDED", "cycle through " + repr(sc) + " avoids every counter-bounded edge", { state: sc[0], detail: { cycle_states: sc } });
      }
    }

    /* ---- ordering / evidence ---- */
    for (const req of C.ordering) {
      for (const sel of [req.before, ...req.requires]) {
        const why = validate.selector_problem(sel, pkg, catalog);
        if (why) {
          err("ORDERING_SELECTOR_UNKNOWN", "requirement " + req.id + ": " + why,
            { clause: req.clause || null, detail: { requirement: req.id, selector: sel, malformed_requirement: "ordering:" + req.id } });
        }
      }
      if (!req.requires.length) {
        err("ORDERING_SELECTOR_UNKNOWN", "requirement " + req.id + " requires nothing",
          { clause: req.clause || null, detail: { requirement: req.id, malformed_requirement: "ordering:" + req.id } });
      }
    }
    for (const req of C.ordering.concat(validate.derived_ordering(pkg))) {
      const path = validate.check_ordering(pkg, req, reach);
      if (path !== null) {
        err("ORDERING_VIOLATION", "requirement " + req.id + ": path reaches " + req.before + " without " +
          req.requires.join(" or ") + " (after last change to " + (req.invalidated_by.length ? repr(req.invalidated_by) : "nothing") + ")",
        { state: path[path.length - 1], clause: req.clause || null, detail: { path, requirement: req.id } });
      }
    }
    for (const sid of Object.keys(C.interactions)) {
      const ic = C.interactions[sid];
      const st = cget(states, sid);
      if (ic.type !== "approval" || st === null || st.action.kind !== "user" || !st.action.writes.length) continue;
      const dvar = st.action.writes[0];
      const schema = hasOwn(C.variables, dvar) ? C.variables[dvar].schema : {};
      const enm = py_or(hasOwn(schema, "enum") ? schema.enum : null, []);
      st.transitions.forEach((t, i) => {
        if (t.to !== ic.approves_state) return;
        const weak = [];
        for (const val of py_iter(enm).filter((v) => v !== "approved").concat(["\u0000other"])) {
          try {
            if (!t["if"]) { weak.push(val); continue; }
            const env = Object.create(null);
            for (const k of G.vars_of(t["if"])) {
              let v;
              if (k === dvar) v = val;
              else if (has_type(k)) v = 0;
              else throw pyerr("KeyError", repr(k));
              Object.defineProperty(env, k, { value: v, enumerable: true, writable: true, configurable: true });
            }
            if (G.evaluate(t["if"], env)) weak.push(val);
          } catch (e) {
            if (e instanceof G.GuardError) weak.push(val);
            else throw e;
          }
        }
        if (!weak.length && !_requires_approved(t["if"], dvar)) weak.push("(guard is not conjunctively bound to decision == 'approved')");
        if (weak.length) {
          err("APPROVAL_GUARD_WEAK", sid + " edge " + i + " enters " + ic.approves_state + " for decision values " + repr(weak) +
            "; only 'approved' may", { state: sid, edge: i });
        }
      });
      if (has_state(ic.approves_state)) {
        const succ_wo = new Map();
        for (const s of sids) succ_wo.set(s, states[s].transitions.map((t) => t.to).filter((x) => has_state(x) && x !== sid));
        st.transitions.forEach((t, i) => {
          if (t.to === ic.approves_state || !has_state(t.to) || t.to === sid) return;
          const seen = new Set([t.to]);
          const q2 = [t.to];
          for (let qi = 0; qi < q2.length; qi++) {
            for (const y of succ_wo.get(q2[qi]) || []) {
              if (!seen.has(y)) {
                seen.add(y);
                q2.push(y);
              }
            }
          }
          if (seen.has(ic.approves_state)) {
            err("APPROVAL_BYPASS", sid + " edge " + i + " reaches " + ic.approves_state + " via " + t.to + " without a fresh approval", { state: sid, edge: i });
          }
        });
      }
    }
    for (const tid of Object.keys(C.terminals)) {
      const tc = C.terminals[tid];
      if (tc.category !== "verified") continue;
      if (!tc.evidence.length) err("VERIFIED_WITHOUT_EVIDENCE", "verified terminal " + repr(tid) + " declares no evidence requirement");
      for (const ev of tc.evidence) {
        const spec = HX.catalog.get(catalog, ev.verifier_tool);
        if (spec === null || spec.verifier_claims.indexOf(ev.claim) < 0) {
          err("UNAPPROVED_VERIFIER", repr(ev.verifier_tool) + " is not an approved verifier for " + repr(ev.claim),
            { detail: { malformed_requirement: "evidence:" + tid + ":" + ev.claim } });
        }
        for (const v of ev.subject_vars) {
          if (!has_type(v)) {
            err("UNKNOWN_VARIABLE", "evidence subject " + repr(v) + " undeclared",
              { variable: v, detail: { malformed_requirement: "evidence:" + tid + ":" + ev.claim } });
          }
        }
      }
    }

    /* ---- fallback / policy ---- */
    const wt = new Set();
    for (const sid of sids) {
      const a = states[sid].action;
      if (a.kind !== "tool") continue;
      const spec = HX.catalog.get(catalog, a.name);
      if (spec !== null && WRITE.has(spec.effect)) wt.add(a.name);
    }
    const write_tools = sorted(wt);
    if (write_tools.length && !P.write_workflow) {
      err("WRITE_WORKFLOW_UNDECLARED", "machine calls consequential tools " + repr(write_tools) + " but declares write_workflow = false");
    }
    if ((P.write_workflow || write_tools.length) && P.fallback_mode !== "stop_for_review") {
      err("FALLBACK_MODE", "write workflows require fallback_mode = stop_for_review");
    }
    const fb = cget(states, m.fallback);
    if (fb !== null) {
      if (fb.action.kind !== "end") {
        err("FALLBACK_NOT_REVIEW", "fallback state must be a review end state under stop_for_review", { state: m.fallback });
      } else if (hasOwn(C.terminals, fb.action.terminal) && C.terminals[fb.action.terminal].category !== "fallback") {
        err("FALLBACK_NOT_REVIEW", "fallback terminal must have category 'fallback'", { state: m.fallback });
      }
    }
    if (m.max_steps > P.budgets.max_steps) {
      err("BUDGET_EXCEEDS_POLICY", "machine max_steps " + m.max_steps + " > policy " + P.budgets.max_steps);
    }

    /* ---- provenance ---- */
    const prov_sev = profile === "production" ? "error" : "warning";
    const clauses = new Map();
    for (const c of pkg.source_manifest.clauses) clauses.set(c.id, c);
    const skill_cps = skill_text !== null ? Array.from(skill_text) : null;
    for (const c of clauses.values()) {
      if (HX.canonical.sha256_hex(c.text) !== c.sha256) {
        F.push(new Finding("CLAUSE_HASH", "clause " + c.id + " text does not match its hash", prov_sev, { clause: c.id }));
      }
      if (skill_cps !== null && py_slice(skill_cps, c.start, c.end) !== c.text) {
        F.push(new Finding("CLAUSE_QUOTE_MISMATCH", "clause " + c.id + " text does not match source bytes", prov_sev, { clause: c.id }));
      }
    }
    if (skill_text !== null) {
      if (HX.util.has_lone_surrogate(skill_text)) {
        throw pyerr("UnicodeEncodeError", "'utf-8' codec can't encode character: surrogates not allowed");
      }
      if (HX.canonical.sha256_hex(skill_text) !== pkg.source_manifest.skill_sha256) {
        F.push(new Finding("SKILL_HASH", "skill source does not match the recorded hash", prov_sev));
      }
      for (const sc of HX.clauses.index_clauses(skill_text)) {
        const mc = clauses.has(sc.id) ? clauses.get(sc.id) : null;
        if (mc !== null && mc.start === sc.start && mc.end === sc.end && mc.text === sc.text) continue;
        if (sc.text.indexOf(validate.CRITICAL_MARK) >= 0) {
          err("CRITICAL_CLAUSE_UNSUPPORTED", "safety-critical source clause " + sc.id + " is missing from (or altered in) the source manifest", { clause: sc.id });
        } else {
          F.push(new Finding("CLAUSE_MISSING", "source clause " + sc.id + " is missing from (or altered in) the source manifest", prov_sev, { clause: sc.id }));
        }
      }
    }
    for (const sid of sids) {
      const st = states[sid];
      if (st.clause && !clauses.has(st.clause)) {
        F.push(new Finding("UNKNOWN_CLAUSE", sid + " references unknown clause " + repr(st.clause), prov_sev, { state: sid, clause: st.clause }));
      }
    }
    const coverage = C.clause_coverage;
    for (const [cid, c] of clauses) {
      const critical = c.text.indexOf(validate.CRITICAL_MARK) >= 0;
      const cov = cget(coverage, cid);
      if (critical && (cov === null || cov.classification === "unsupported" || cov.classification === "non_material")) {
        err("CRITICAL_CLAUSE_UNSUPPORTED", "safety-critical clause " + cid + " is " + (cov ? cov.classification : "unclassified"), { clause: cid });
      }
      if (cov !== null && cov.critical !== critical) {
        err("CRITICAL_FLAG_MISMATCH", "clause " + cid + " declares critical=" + repr(cov.critical) + " but its source text " +
          (critical ? "contains" : "lacks") + " " + validate.CRITICAL_MARK, { clause: cid });
      }
    }
    for (const cid of Object.keys(coverage)) {
      const cov = coverage[cid];
      if (!clauses.has(cid)) F.push(new Finding("UNKNOWN_CLAUSE", "coverage for unknown clause " + repr(cid), prov_sev, { clause: cid }));
      for (const s of cov.states) {
        if (!has_state(s)) err("UNKNOWN_STATE", "clause " + cid + " maps to unknown state " + repr(s), { clause: cid });
      }
      if (cov.critical && cov.classification === "unsupported") {
        err("CRITICAL_CLAUSE_UNSUPPORTED", "safety-critical clause " + cid + " is unsupported", { clause: cid });
      }
      if (cov.classification === "executable_control" && !cov.states.length) {
        err("COVERAGE_WITHOUT_STATES", "clause " + cid + " claims executable control but maps to no state", { clause: cid });
      }
    }
    for (const cid of clauses.keys()) {
      if (!hasOwn(coverage, cid)) F.push(new Finding("CLAUSE_UNCLASSIFIED", "clause " + cid + " has no coverage classification", prov_sev, { clause: cid }));
    }
    return report();
  };

  /** Values occurring more than once, in order of first occurrence (Python iterates a set here). */
  function dupes(list) {
    const count = new Map();
    for (const x of list) count.set(x, (count.get(x) || 0) + 1);
    return [...count.keys()].filter((x) => count.get(x) > 1);
  }

  /** Python ``a or b`` for JSON values. */
  function py_or(a, b) {
    return py_truthy(a) ? a : b;
  }
  function py_truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
    if (is_dict(v)) return Object.keys(v).length > 0;
    return true;
  }
  validate._py_truthy = py_truthy;

  /** Python ``k in container`` for a string key and a JSON container. */
  function py_contains(container, k) {
    if (is_dict(container)) return hasOwn(container, k);
    if (Array.isArray(container)) return container.some((x) => x === k);
    if (typeof container === "string") return container.indexOf(k) >= 0;
    throw pyerr("TypeError", "argument of type '" + type_name(container) + "' is not iterable");
  }
})(globalThis.HX = globalThis.HX || {});
