/* Port of hexis_service/metrics.py: latency breakdown and usage aggregates from run records (brief §15).
 *
 * Inputs are the append-only ``TIMING`` run events written by HX.service.RunService after every step plus the
 * domain records (action intents/receipts and the EFFECT_UNKNOWN / RECONCILIATION_REQUIRED events) for
 * external-effect uncertainty. Nothing here writes to the store, and every query is scoped to one tenant.
 *
 * API: collect(store, tenant_id, {run_id, artifact_hash}) -> report; render_json(report) -> report;
 *      render_prometheus(report) -> text (exposition format 0.0.4); percentile(values, q); escape_label(v).
 *
 * Numbers: Python prints a sample with ``repr(float)`` when the value is a float and ``str(int)`` when it is an
 * int. JS has one number type, so ``render_prometheus`` knows which report fields are floats in Python (every
 * latency/second value, cost and ratio; counts are ints; a latency ``total`` over no samples is the int 0).
 */
(function (HX) {
  "use strict";
  const metrics = (HX.metrics = HX.metrics || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  metrics.UNCERTAIN_EVENTS = Object.freeze(["EFFECT_UNKNOWN", "RECONCILIATION_REQUIRED"]);
  const UNRESOLVED = ["DISPATCHING", "UNKNOWN_EFFECT"];
  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }
  const get = (d, k, dflt) => (hasOwn(d, k) ? d[k] : dflt);
  function truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  /** Python ``float(v)`` for JSON values (numbers, bools, numeric strings). */
  function py_float(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = v.trim().replace(/_/g, "");
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
      if (/^[+-]?(inf|infinity)$/i.test(t)) return t[0] === "-" ? -Infinity : Infinity;
      if (/^[+-]?nan$/i.test(t)) return NaN;
      throw pyerr("ValueError", "could not convert string to float: " + HX.util.py_repr(v));
    }
    throw pyerr("TypeError", "float() argument must be a string or a real number, not '" + HX.kernel._py_type_name(v) + "'");
  }
  /** Python ``int(v)`` for JSON values. */
  function py_int(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw pyerr(Number.isNaN(v) ? "ValueError" : "OverflowError", "cannot convert float to integer");
      return Math.trunc(v);
    }
    return HX.kernel._py_int(v);
  }

  /** Nearest-rank percentile (``q`` in 0..100); null for no samples. */
  metrics.percentile = function percentile(values, q) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const k = Math.max(1, Math.ceil(q / 100.0 * s.length));
    return s[k - 1];
  };
  /** Python 3.12 ``sum(xs)`` over floats: the first item is added to the int 0, the rest with Neumaier's compensated
   *  summation (CPython builtin_sum_impl), and the compensation is added at the end only when it is finite and
   *  non-zero. ``sum([])`` is the int 0. Every item is treated as a float (JS cannot tell ``1`` from ``1.0``);
   *  for integer items whose partial sums stay below 2^53 the result is the same exact integer either way. */
  function py_fsum(xs) {
    if (!xs.length) return 0;
    let f = 0 + xs[0], c = 0.0;
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i];
      const t = f + x;
      if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
      else c += (x - t) + f;
      f = t;
    }
    if (c !== 0 && Number.isFinite(c)) f += c;
    return f;
  }
  metrics.py_fsum = py_fsum;
  const fsum = py_fsum;
  /** Non-enumerable key order of ``per_run`` (see keys_of). */
  const KEY_ORDER = Symbol("hexis.metrics.key_order");
  /** The keys of a report section in Python's dict order. ``by_*`` sections are built from ``sorted()`` items, so
   *  their order is code-point order (a JS object would enumerate integer-like keys such as "9" before "10" first);
   *  ``per_run`` uses the insertion order recorded by ``collect``. Keys added to the object later (not in the
   *  recorded order) follow in the object's own order, like a later dict insertion. */
  function keys_of(obj, sorted) {
    const own = Object.keys(obj);
    const rec = obj[KEY_ORDER];
    if (Array.isArray(rec)) {
      const set = new Set(own);
      const first = rec.filter((k) => set.has(k));
      const seen = new Set(first);
      return first.concat(own.filter((k) => !seen.has(k)));
    }
    return sorted ? own.slice().sort(cmp) : own;
  }
  metrics._keys_of = keys_of;
  const isum = (xs) => xs.reduce((s, x) => s + x, 0);

  function latency(values) {
    return { p50: metrics.percentile(values, 50), p95: metrics.percentile(values, 95),
      max: values.length ? Math.max(...values) : null, total: fsum(values), samples: values.length };
  }

  /** Known only if there is at least one priced call and every call reported its cost. */
  function cost(costs) {
    if (!costs.length || costs.some((c) => c === null || c === undefined)) return null;
    return fsum(costs);
  }

  class Acc {
    constructor() {
      this.count = 0;
      this.latencies = [];
      this.tokens_in = 0;
      this.tokens_out = 0;
      this.costs = [];
      this.retries = 0;
      this.validation_failures = 0;
      this.visits = new Set();
      this.fallback_visits = new Set();
      this.human_wait = [];
      this.raised = new Set();
      this.outstanding = new Set();
      this.split = { engine_s: 0.0, model_s: 0.0, tool_s: 0.0 };
    }
    to_json(o) {
      const human_wait = !!(o && o.human_wait), split = !!(o && o.split);
      let resolved = 0;
      for (const x of this.raised) if (!this.outstanding.has(x)) resolved++;
      const out = {
        count: this.count, latency_s: latency(this.latencies),
        tokens: { input: this.tokens_in, output: this.tokens_out, total: this.tokens_in + this.tokens_out },
        cost_usd: cost(this.costs), retries: this.retries, validation_failures: this.validation_failures,
        fallback: { visits: this.visits.size, entries: this.fallback_visits.size,
          frequency: this.visits.size ? this.fallback_visits.size / this.visits.size : null },
        uncertain_effects: { raised: this.raised.size, resolved, outstanding: this.outstanding.size },
      };
      if (human_wait) out.human_wait_s = latency(this.human_wait);
      if (split) Object.assign(out, this.split);
      return out;
    }
  }
  metrics._Acc = Acc;

  function run_ids(store, tenant_id) {
    if (store && typeof store.list_runs === "function") {
      return store.list_runs(tenant_id).map((r) => (typeof r === "string" ? r : r.run_id));
    }
    throw pyerr("AttributeError", "store has no list_runs");
  }

  function setdefault(m, k) {
    if (!m.has(k)) m.set(k, new Acc());
    return m.get(k);
  }
  const visit_key = (rid, rev) => JSON.stringify([rid, rev]);

  /** Aggregate the metrics report for ``tenant_id`` (optionally one run and/or one artifact). The tenant is the
   *  caller's authenticated tenant; runs of any other tenant are never read. */
  metrics.collect = function collect(store, tenant_id, opts) {
    const o = opts || {};
    for (const k of Object.keys(o)) {
      if (k !== "run_id" && k !== "artifact_hash") throw pyerr("TypeError", "collect() got an unexpected keyword argument '" + k + "'");
    }
    const run_id = o.run_id === undefined ? null : o.run_id;
    const artifact_hash = o.artifact_hash === undefined ? null : o.artifact_hash;
    const ids = truthy(run_id) ? [run_id] : run_ids(store, tenant_id);
    const by_model = new Map(), by_state = new Map(), by_tool = new Map();
    const per_run = new Map();
    const totals = { engine_s: 0.0, model_s: 0.0, tool_s: 0.0, human_wait_s: 0.0, steps: 0 };
    const all_costs = [];
    for (const rid of ids) {
      const run = store.get_run(tenant_id, rid);
      if (run === null || (truthy(artifact_hash) && run.artifact_hash !== artifact_hash)) continue;
      const events = store.events(tenant_id, rid);
      const r = { status: run.status, artifact_hash: run.artifact_hash, steps: 0, engine_s: 0.0, model_s: 0.0,
        tool_s: 0.0, human_wait_s: 0.0, tokens: 0 };
      const run_costs = [], model_costs = [];
      for (const ev of events) {
        if (get(ev, "type") !== "TIMING") continue;
        const visit = visit_key(rid, py_int(get(ev, "revision", 0)));
        const st = setdefault(by_state, get(ev, "state", "?"));
        st.count += 1;
        st.visits.add(visit);
        st.latencies.push(py_float(get(ev, "total_s", 0.0)));
        for (const k of ["engine_s", "model_s", "tool_s"]) {
          st.split[k] += py_float(get(ev, k, 0.0));
          r[k] += py_float(get(ev, k, 0.0));
        }
        const tok = truthy(get(ev, "tokens")) ? ev.tokens : {};
        st.tokens_in += py_int(get(tok, "input", 0));
        st.tokens_out += py_int(get(tok, "output", 0));
        r.tokens += py_int(get(tok, "input", 0)) + py_int(get(tok, "output", 0));
        const retries = truthy(get(ev, "retries")) ? ev.retries : {};
        st.retries += isum(Object.keys(retries).map((k) => py_int(retries[k])));
        st.validation_failures += py_int(get(ev, "validation_failures", 0));
        if (truthy(get(ev, "fallback"))) st.fallback_visits.add(visit);
        if (get(ev, "human_wait_s", null) !== null) {
          st.human_wait.push(py_float(ev.human_wait_s));
          r.human_wait_s += py_float(ev.human_wait_s);
        }
        r.steps += 1;
        const models_here = new Set();
        for (const c of truthy(get(ev, "model_calls")) ? ev.model_calls : []) {
          const mid = get(c, "model_id", "?");
          models_here.add(mid);
          const acc = setdefault(by_model, mid);
          acc.count += 1;
          acc.latencies.push(py_float(get(c, "latency_s", 0.0)));
          acc.tokens_in += py_int(get(c, "input_tokens", 0));
          acc.tokens_out += py_int(get(c, "output_tokens", 0));
          if (truthy(get(c, "transport_retry")) || truthy(get(c, "repair"))) acc.retries += 1;
          if (get(c, "outcome") === "rejected") acc.validation_failures += 1;
          if (get(c, "outcome") !== "unavailable") {
            const cu = get(c, "cost_usd", null);
            acc.costs.push(cu); st.costs.push(cu); run_costs.push(cu); model_costs.push(cu);
          }
        }
        for (const mid of models_here) {
          by_model.get(mid).visits.add(visit);
          if (truthy(get(ev, "fallback"))) by_model.get(mid).fallback_visits.add(visit);
        }
        const tools_here = new Set();
        for (const c of truthy(get(ev, "tool_calls")) ? ev.tool_calls : []) {
          const name = get(c, "tool", "?");
          tools_here.add(name);
          const acc = setdefault(by_tool, name);
          acc.count += 1;
          acc.latencies.push(py_float(get(c, "latency_s", 0.0)));
          acc.costs.push(null); /* connector cost is not measurable here: unknown, not 0 */
          st.costs.push(null);
          run_costs.push(null);
          if (py_int(get(c, "attempt", 1)) > 1 || get(c, "op") === "redispatch") acc.retries += 1;
        }
        for (const name of tools_here) {
          by_tool.get(name).visits.add(visit);
          if (truthy(get(ev, "fallback"))) by_tool.get(name).fallback_visits.add(visit);
        }
      }
      /* External-effect uncertainty from the authoritative ledger, not from timing. */
      const raised = new Set();
      for (const e of events) {
        if (metrics.UNCERTAIN_EVENTS.indexOf(get(e, "type")) >= 0 && truthy(get(e, "logical_action_id"))) {
          raised.add(e.logical_action_id);
        }
      }
      if (raised.size) {
        const intents = new Map();
        for (const i of store.intents(tenant_id, rid)) intents.set(i.logical_action_id, i);
        const succeeded = new Set(store.receipts(tenant_id, { run_id: rid }).filter((x) => x.dispatch_state === "SUCCEEDED")
          .map((x) => x.logical_action_id));
        for (const lid of raised) {
          const it = intents.get(lid) || {};
          const open = UNRESOLVED.indexOf(get(it, "status")) >= 0 && !succeeded.has(lid);
          for (const acc of [setdefault(by_tool, get(it, "tool", "?")), setdefault(by_state, get(it, "state_id", "?"))]) {
            acc.raised.add(lid);
            if (open) acc.outstanding.add(lid);
          }
        }
      }
      r.cost_usd = cost(run_costs);
      r.model_cost_usd = cost(model_costs);
      r.uncertain_effects = raised.size;
      all_costs.push(...run_costs);
      per_run.set(rid, r);
      for (const k of ["engine_s", "model_s", "tool_s", "human_wait_s", "steps"]) totals[k] += r[k];
    }
    const obj = (m, fn) => {
      const out = {};
      const keys = Array.from(m.keys()).sort(cmp);
      for (const k of keys) out[k] = fn(m.get(k));
      Object.defineProperty(out, KEY_ORDER, { value: keys, enumerable: false });
      return out;
    };
    const pr = {};
    for (const [k, v] of per_run) pr[k] = v;
    /* Python's per_run keeps insertion order; a plain object would move integer-like run ids first */
    Object.defineProperty(pr, KEY_ORDER, { value: Array.from(per_run.keys()), enumerable: false });
    return {
      schema: "hexis-metrics/1", tenant_id,
      filters: { run_id, artifact_hash }, runs: per_run.size,
      by_model: obj(by_model, (v) => v.to_json()),
      by_state: obj(by_state, (v) => v.to_json({ human_wait: true, split: true })),
      by_tool: obj(by_tool, (v) => v.to_json()),
      per_run: pr,
      totals: Object.assign({}, totals, { cost_usd: cost(all_costs) }),
    };
  };

  /* ------------------------------------------------------------------------------------------------------ */
  /* Prometheus text exposition format (version 0.0.4)                                                       */
  /* ------------------------------------------------------------------------------------------------------ */
  const METRIC_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
  const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  /* Python's re ``$`` also matches before a final "\n" */
  const re_match = (re, s) => re.test(s) || (s.endsWith("\n") && re.test(s.slice(0, -1)));

  metrics.escape_label = function escape_label(value) {
    return HX.broker._py_str(value).split("\\").join("\\\\").split("\n").join("\\n").split('"').join('\\"');
  };

  /** A sample value: ``{v, float}`` (Python float -> repr) or a bare number/bool (Python int/bool). */
  function num(v, is_float) {
    if (typeof v === "boolean") return v ? "1" : "0";
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "+Inf";
    if (v === -Infinity) return "-Inf";
    if (!is_float) return HX.canonical.py_number(v);
    return HX.canonical.py_float_repr(v);
  }
  metrics._num = num;

  class Families {
    constructor() { this.order = []; this.meta = new Map(); this.samples = new Map(); }
    /** ``family`` groups ``_sum``/``_count`` samples under their summary's TYPE line. */
    add(name, typ, help, value, labels, is_float, family) {
      if (value === null || value === undefined) return; /* unknown values are omitted, never rendered as 0 */
      const fam = family || name;
      if (!re_match(METRIC_RE, name) || !re_match(METRIC_RE, fam)) throw pyerr("AssertionError", name);
      if (!this.meta.has(fam)) {
        this.order.push(fam);
        this.meta.set(fam, [typ, help]);
        this.samples.set(fam, []);
      }
      const lab = Object.keys(labels).filter((k) => re_match(LABEL_RE, k))
        .map((k) => k + '="' + metrics.escape_label(labels[k]) + '"').join(",");
      this.samples.get(fam).push(lab ? name + "{" + lab + "} " + num(value, is_float) : name + " " + num(value, is_float));
    }
    render() {
      const out = [];
      for (const fam of this.order) {
        const [typ, help] = this.meta.get(fam);
        out.push("# HELP " + fam + " " + help.split("\\").join("\\\\").split("\n").join("\\n"));
        out.push("# TYPE " + fam + " " + typ);
        out.push(...this.samples.get(fam));
      }
      return out.join("\n") + "\n";
    }
  }

  metrics.render_json = function render_json(report) { return report; };

  metrics.render_prometheus = function render_prometheus(report) {
    const f = new Families();
    const what_of = { model: "model calls", state: "state steps", tool: "tool connector calls" };
    for (const [dim, key] of [["model", "by_model"], ["state", "by_state"], ["tool", "by_tool"]]) {
      const what = what_of[dim];
      const sect = report[key];
      for (const k of keys_of(sect, true)) {
        const s = sect[k];
        const lab = {};
        lab[dim] = k;
        const fam = "hexis_" + dim + "_latency_seconds";
        const lat = s.latency_s;
        const help = "Latency of " + what + " in seconds (monotonic timer).";
        /* Python: percentiles and max are floats (float() of each sample); total is sum() -> int 0 when empty */
        const lat_float = lat.samples > 0;
        for (const q of ["0.5", "0.95"]) {
          f.add(fam, "summary", help, lat[q === "0.5" ? "p50" : "p95"], Object.assign({}, lab, { quantile: q }), true);
        }
        f.add(fam + "_sum", "summary", help, lat.total, lab, lat_float, fam);
        f.add(fam + "_count", "summary", help, lat.samples, lab, false, fam);
        f.add("hexis_" + dim + "_latency_max_seconds", "gauge", "Maximum latency of " + what + " in seconds.", lat.max, lab, true);
        f.add("hexis_" + dim + "_calls_total", "counter", "Number of " + what + ".", s.count, lab, false);
        for (const direction of ["input", "output"]) {
          f.add("hexis_" + dim + "_tokens_total", "counter", "Model tokens consumed by " + what + ".", s.tokens[direction],
            Object.assign({}, lab, { direction }), false);
        }
        f.add("hexis_" + dim + "_cost_known", "gauge", "1 if every call reported its cost, 0 if cost is unknown.",
          s.cost_usd !== null && s.cost_usd !== undefined ? 1 : 0, lab, false);
        f.add("hexis_" + dim + "_cost_usd_total", "counter", "Reported cost in USD (omitted when unknown).", s.cost_usd, lab, true);
        f.add("hexis_" + dim + "_retries_total", "counter", "Transport retries and output repairs.", s.retries, lab, false);
        f.add("hexis_" + dim + "_validation_failures_total", "counter", "Rejected model outputs / observations.",
          s.validation_failures, lab, false);
        f.add("hexis_" + dim + "_fallback_entries_total", "counter", "State visits that entered the fallback.",
          s.fallback.entries, lab, false);
        f.add("hexis_" + dim + "_fallback_ratio", "gauge", "Fallback entries per state visit.", s.fallback.frequency, lab, true);
        for (const phase of ["raised", "resolved", "outstanding"]) {
          f.add("hexis_" + dim + "_uncertain_effects", "gauge", "External effects whose outcome was unknown.",
            s.uncertain_effects[phase], Object.assign({}, lab, { phase }), false);
        }
        if (hasOwn(s, "human_wait_s")) {
          const hw = s.human_wait_s;
          f.add("hexis_state_human_wait_seconds_total", "counter",
            "Human wait (interaction opened to answered, logical clock) in seconds.", hw.total, lab, hw.samples > 0);
          f.add("hexis_state_human_wait_max_seconds", "gauge", "Maximum human wait in seconds.", hw.max, lab, true);
        }
      }
    }
    for (const rid of keys_of(report.per_run, false)) {
      const r = report.per_run[rid];
      for (const comp of ["engine", "model", "tool", "human_wait"]) {
        f.add("hexis_run_seconds", "gauge", "Per-run time by component: engine overhead, model, tool, human wait.",
          r[comp + "_s"], { run: rid, component: comp }, true);
      }
      f.add("hexis_run_steps", "gauge", "Persisted steps per run.", r.steps, { run: rid }, false);
    }
    const t = report.totals;
    for (const comp of ["engine", "model", "tool", "human_wait"]) {
      f.add("hexis_seconds_total", "counter", "Time by component across the selected runs.", t[comp + "_s"],
        { component: comp }, true);
    }
    f.add("hexis_runs", "gauge", "Runs included in this report.", report.runs, {}, false);
    return f.render();
  };
})(globalThis.HX = globalThis.HX || {});
