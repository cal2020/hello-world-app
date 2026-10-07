/* Port of evals/run_eval.py: fixture-mode evaluation, initial vs trace-refined machine on held-out synthetic tasks.
 *
 * What this measures: software behavior (procedural conformance, terminal honesty, recovery, human burden, engine
 * step counts) with a deterministic fake model and fake connectors. What it does NOT measure: live model quality,
 * cost, latency, or the paper's reported gains. The direct-prompting ReAct baseline arm requires a live model and is
 * reported as NOT RUN.
 *
 * API:
 *   dev_overlap(task, dev) -> [reason strings]      (dev: an HX.traces trace)
 *   run_task(env, pkg, task) -> row                  (env: HX.env.Env, pkg: a MachinePackage dump)
 *   summarize(rows) -> summary dict
 *   run_eval({tasks = HX.data.heldout_tasks.tasks, clock_start = 1790000000.25, ids, timer}) -> result dict
 *     (``tasks`` may also be the task file object {tasks: [...]}). ``result.environment`` is
 *     {runtime: "browser", engine: HX.VERSION} instead of Python's interpreter, platform, commit and command.
 *   report_lines(result) -> [lines]; report_markdown(result) -> Python's report.md text ("\n".join(lines) + "\n").
 *     The commit line reads "Engine `<engine>`" where Python prints "Commit `<sha[:12]>`", unless
 *     ``result.environment.git_commit`` is a string (a Python result), in which case it is Python's line exactly.
 *   fmt2(v): Python ``f"{v:.2f}"`` (round-half-even on the exact binary value).
 *   RATIO_METRICS: the summary keys formatted with ".2f" (Python decides by ``isinstance(v, float)``).
 *
 * Errors are HX.HXError with Python's class name as code (KeyError, TypeError, AttributeError) where Python raises.
 */
(function (HX) {
  "use strict";
  const ev = (HX.eval = HX.eval || {});

  ev.MODE = "fixture (deterministic fake model + fake connectors; software behavior only)";
  ev.NOTE = "Deterministic fixtures: repeated runs are identical and are not independent samples.";
  ev.NOT_RUN = Object.freeze({ direct_skill_prompting_react: "requires a live model adapter and credentials; not executed" });
  ev.CLOCK_START = 1790000000.25;
  /** Summary keys whose values are Python floats (``sum(...) / n``); every other summary key is an int. */
  ev.RATIO_METRICS = Object.freeze(["business_success", "procedural_conformance", "terminal_honesty", "fallback_rate",
    "failure_fallback_rate", "mean_steps"]);
  const METRICS = ["business_success", "procedural_conformance", "terminal_honesty", "duplicate_writes", "fallback_rate",
    "failure_fallback_rate", "human_interactions", "mean_steps", "model_calls"];
  const HELDOUT_METRICS = ["business_success", "procedural_conformance", "terminal_honesty", "human_interactions"];

  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const is_dict = (v) => HX.util.is_plain_object(v);
  const pyerr = (cls, msg) => HX.broker._pyerr(cls, msg);
  const repr = (v) => HX.kernel._py_repr(v);
  const str = (v) => HX.broker._py_str(v);
  const truthy = (v) => HX.broker._truthy(v);
  const eq = (a, b) => HX.traces._py_eq(a, b);

  function tname(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    return "dict";
  }
  /** Python ``d[k]``. */
  function item(d, k) {
    if (Array.isArray(d) || typeof d === "string") {
      if (typeof k === "string") throw pyerr("TypeError", (Array.isArray(d) ? "list" : "string") + " indices must be integers or slices, not str");
    }
    if (!is_dict(d)) throw pyerr("TypeError", "'" + tname(d) + "' object is not subscriptable");
    return HX.broker._item(d, k);
  }
  /** Python ``d.get(k, dflt)``. */
  function dget(d, k, dflt) {
    if (!is_dict(d)) throw pyerr("AttributeError", "'" + tname(d) + "' object has no attribute 'get'");
    return hasOwn(d, k) ? d[k] : (dflt === undefined ? null : dflt);
  }
  /** Python ``sorted()`` of hashable JSON scalars (str with str, numbers/bools with numbers). */
  function py_sorted(xs) {
    const strs = xs.every((x) => typeof x === "string");
    const nums = xs.every((x) => typeof x === "number" || typeof x === "boolean");
    if (!strs && !nums) {
      const a = xs.find((x) => typeof x !== "string"), b = xs.find((x) => typeof x === "string");
      throw pyerr("TypeError", "'<' not supported between instances of '" + tname(b === undefined ? a : b) + "' and '" +
        tname(a) + "'");
    }
    return xs.slice().sort(strs ? HX.util.cmp_codepoints : (x, y) => Number(x) - Number(y));
  }
  /** Python ``set(x)`` of an iterable JSON value -> Map(hash key -> first element). */
  function py_set(iterable) {
    const m = new Map();
    for (const v of HX.traces._py_list(iterable)) {
      const k = HX.update._hkey(v);
      if (!m.has(k)) m.set(k, v);
    }
    return m;
  }

  /** Python ``f"{v:.2f}"``: JS toFixed rounds exact ties (odd multiples of 1/8) away from zero, Python to even. */
  function fmt2(v) {
    if (typeof v === "boolean") v = v ? 1 : 0;
    if (typeof v !== "number") throw pyerr("TypeError", "unsupported format string passed to " + tname(v) + ".__format__");
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    const a = Math.abs(v);
    let s;
    if (a < 1e15 && Number.isInteger(a * 8) && !Number.isInteger(a * 4)) {
      const lo = Math.floor(a * 100); /* exact: a*100 = (2i+1)*12.5 */
      const n = lo % 2 === 0 ? lo : lo + 1;
      s = Math.floor(n / 100) + "." + String(n % 100).padStart(2, "0");
    } else if (a >= 1e21) {
      s = BigInt(a).toString() + ".00";
    } else {
      s = a.toFixed(2);
    }
    return (v < 0 || Object.is(v, -0)) ? "-" + s : s;
  }
  ev.fmt2 = fmt2;

  /* ------------------------------------------------------------------------------------------------------------ */

  /** Reasons a 'held-out' task is NOT independent of the development trace given to the aligner.
   *
   *  A task that shares the development trace's supplier or the documents the requester supplied in it is the
   *  training example in disguise; its result must not be reported as held-out generalization. */
  ev.dev_overlap = function dev_overlap(task, dev) {
    const reasons = [];
    const dev_ref = dget(dget(dev.task, "input", {}), "supplier_ref");
    if (truthy(dev_ref) && eq(dget(item(task, "input"), "supplier_ref"), dev_ref)) {
      reasons.push("same supplier_ref " + str(dev_ref) + " as development trace " + str(dev.trace_id));
    }
    const supplied = new Map();
    for (const r of dev.records) {
      if (eq(dget(r.action, "kind"), "user")) {
        for (const [k, v] of py_set(dget(r.output, "document_ids", []))) if (!supplied.has(k)) supplied.set(k, v);
      }
    }
    const theirs = py_set(dget(dget(dget(task, "responses", {}), "input", {}), "document_ids", []));
    const inter = [];
    for (const [k, v] of supplied) if (theirs.has(k)) inter.push(v);
    const shared = py_sorted(inter);
    if (shared.length) {
      reasons.push("supplies the same documents " + repr(shared) + " as development trace " + str(dev.trace_id));
    }
    return reasons;
  };

  ev.run_task = function run_task(env, pkg, task) {
    const alice = env.principal("user:alice"), bob = env.principal("user:bob");
    const T = HX.env.TASK;
    const tin = item(task, "input");
    if (!is_dict(tin)) throw pyerr("TypeError", "'" + tname(tin) + "' object is not a mapping");
    /* {**base, **tin}: a key of tin that overrides base keeps base's position, as in Python */
    const merged = {};
    const base = { required_fields: HX.kernel._clone(T.required_fields), policy_version: T.policy_version };
    for (const k of Object.keys(base)) merged[k] = hasOwn(tin, k) ? tin[k] : base[k];
    for (const k of Object.keys(tin)) if (!hasOwn(base, k)) merged[k] = tin[k];
    const h = env.service.start_run(pkg.artifact_hash, merged, alice);
    let res = env.service.run_until_blocked(h.run_id, alice);
    let interactions = 0;
    while ((res.status === "WAITING_FOR_APPROVAL" || res.status === "WAITING_FOR_INPUT") && interactions < 6) {
      interactions += 1;
      const ix = truthy(res.interaction) ? res.interaction
        : env.store.interaction_for_revision("acme", h.run_id, res.checkpoint.revision);
      if (eq(item(ix, "type"), "approval")) {
        env.service.resume_interaction(h.run_id, item(ix, "interaction_id"), { approval_decision: "approved",
          scope_digest: item(ix, "scope_digest") }, bob);
      } else {
        env.service.resume_interaction(h.run_id, item(ix, "interaction_id"), item(item(task, "responses"), "input"), alice);
      }
      res = env.service.run_until_blocked(h.run_id, alice);
    }
    const cp = res.checkpoint;
    const trace = HX.traces.export_run_trace(env.service, h.run_id, alice);
    const outcome = truthy(cp.outcome) ? cp.outcome : {};
    const cat = dget(outcome, "category", "none");
    const expect = item(item(task, "oracle"), "expect");
    let persisted = null;
    const draft_id = dget(dget(outcome, "outputs", {}), "erp_draft_id");
    if (truthy(draft_id)) {
      persisted = item(env.erp.read_draft({ draft_id }, { tenant_id: "acme" }), "draft");
    }
    let fields_ok = false;
    if (persisted !== null) {
      fields_ok = true;
      const fields = item(item(task, "oracle"), "fields");
      if (!is_dict(fields)) throw pyerr("AttributeError", "'" + tname(fields) + "' object has no attribute 'items'");
      for (const k of Object.keys(fields)) {
        if (!eq(dget(persisted, k), fields[k])) { fields_ok = false; break; }
      }
    }
    const refs = new Set();
    for (const r of env.store.receipts("acme", { run_id: h.run_id })) {
      if (r.tool === "erp.create_draft" && r.dispatch_state === "SUCCEEDED") refs.add(HX.update._hkey(r.external_ref));
    }
    let mapped;
    if (typeof expect === "string" || expect === null || typeof expect === "number" || typeof expect === "boolean") {
      mapped = expect === "review" ? "fallback" : expect;
    } else {
      throw pyerr("TypeError", "unhashable type: '" + tname(expect) + "'");
    }
    const is_verified_expect = eq(expect, "verified");
    const entered = cp.assurance.entered_fallback;
    return {
      task: item(task, "id"), status: res.status, terminal: dget(outcome, "terminal"), category: cat,
      expected: expect,
      business_success: is_verified_expect ? (eq(cat, "verified") && fields_ok) : eq(cat, mapped),
      extraction_correct: is_verified_expect ? fields_ok : null,
      procedural_conformance: !truthy(HX.normalize.eligibility(trace, env.service.package(cp.artifact_hash))),
      terminal_honest: !eq(cat, "verified") || fields_ok,
      duplicate_writes: Math.max(0, refs.size - 1),
      entered_fallback: entered,
      // a run ending in a fallback-category terminal (e.g. END_REVIEW) is a fallback outcome too, even when it
      // got there on a designed branch rather than via a runtime failure
      fallback_outcome: truthy(entered) ? entered : eq(cat, "fallback"),
      human_interactions: interactions,
      steps: cp.budget.steps, tool_calls: cp.budget.tool_calls, model_calls: cp.budget.model_calls,
      tokens_fixture_estimate: cp.budget.tokens,
    };
  };

  /** CPython 3.12 ``sum()`` of numbers (``builtin_sum_impl``), start 0. Integral JS numbers stand for Python ints
   *  (bools count as ints) and other numbers for floats (deviations/demo.md: an integral Python float such as
   *  ``2.0`` or ``1e16`` cannot be told apart). Ints add exactly until the first float; from then on floats use
   *  Neumaier compensation while ints that fit a C long are added to the running double WITHOUT compensation, as
   *  CPython does; an int beyond a C long leaves the fast path for plain ``+``. */
  const LONG_MAX = 2n ** 63n - 1n, LONG_MIN = -(2n ** 63n);
  function py_sum(xs) {
    const nums = xs.map((x) => {
      if (typeof x === "boolean") return x ? 1 : 0;
      if (typeof x !== "number") throw pyerr("TypeError", "unsupported operand type(s) for +: 'int' and '" + tname(x) + "'");
      return x;
    });
    const is_int = (x) => Number.isInteger(x);
    let i = 0;
    let acc = 0n; /* exact int phase */
    while (i < nums.length && is_int(nums[i])) {
      const b = BigInt(nums[i]);
      if (acc + b > LONG_MAX || acc + b < LONG_MIN) break;
      acc += b;
      i++;
    }
    if (i === nums.length) return Number(acc);
    /* generic Python ``+`` from here on: ``result`` is a BigInt (int) or a number (float) */
    let result = acc;
    const add = (r, x) => (typeof r === "bigint" && is_int(x) ? r + BigInt(x) : Number(r) + x);
    result = add(result, nums[i++]);
    while (typeof result === "number" && i <= nums.length) {
      /* the float fast path */
      let f = result, c = 0.0, left = false;
      for (; i < nums.length; i++) {
        const x = nums[i];
        if (!is_int(x)) {
          const t = f + x;
          if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
          else c += (x - t) + f;
          f = t;
          continue;
        }
        const v = BigInt(x);
        if (v <= LONG_MAX && v >= LONG_MIN) { f += x; continue; }
        left = true;
        break;
      }
      if (!left) {
        if (c !== 0 && Number.isFinite(c)) f += c;
        return f;
      }
      result = f; /* CPython drops the compensation when it leaves the fast path */
      for (; i < nums.length; i++) result = add(result, nums[i]);
      return typeof result === "bigint" ? Number(result) : result;
    }
    for (; i < nums.length; i++) result = add(result, nums[i]);
    return typeof result === "bigint" ? Number(result) : result;
  }
  ev._py_sum = py_sum;

  ev.summarize = function summarize(rows) {
    const n = rows.length;
    if (!n) return { tasks: 0 };
    const agg = (k) => rows.filter((r) => truthy(item(r, k))).length / n;
    return { tasks: n, business_success: agg("business_success"), procedural_conformance: agg("procedural_conformance"),
      terminal_honesty: agg("terminal_honest"), duplicate_writes: py_sum(rows.map((r) => item(r, "duplicate_writes"))),
      fallback_rate: agg("fallback_outcome"), failure_fallback_rate: agg("entered_fallback"),
      human_interactions: py_sum(rows.map((r) => item(r, "human_interactions"))),
      mean_steps: py_sum(rows.map((r) => item(r, "steps"))) / n,
      model_calls: py_sum(rows.map((r) => item(r, "model_calls"))) };
  };

  function task_list(tasks) {
    if (tasks === undefined || tasks === null) tasks = HX.data.heldout_tasks;
    if (is_dict(tasks)) tasks = item(tasks, "tasks");
    if (!Array.isArray(tasks)) throw pyerr("TypeError", "tasks must be a list");
    for (const t of tasks) {
      /* deviation (deviations/demo.md): task ids are dict keys of the result; only str ids are accepted */
      if (!is_dict(t)) throw pyerr("TypeError", "'" + tname(t) + "' object is not subscriptable");
      if (typeof item(t, "id") !== "string") throw pyerr("TypeError", "task ids must be strings in the JavaScript port");
    }
    return tasks;
  }

  ev.run_eval = function run_eval(opts) {
    const o = opts || {};
    const tasks = task_list(o.tasks);
    const R = HX.reference;
    const skill_text = HX.env.skill_source().text;
    const initial = HX.env.compile_procurement().package;
    const kw = { clock: new HX.env.ManualClock(o.clock_start === undefined ? ev.CLOCK_START : o.clock_start),
      ids: o.ids || HX.env.make_seq_ids(1) };
    if (o.timer) kw.timer = o.timer;
    const env = HX.env.build_env(null, kw);
    HX.env.admit_initial(env, initial);
    const dev = R.missing_docs_trace(); /* development trace (not a held-out task) */
    const prop = HX.update.propose_update(initial, dev, [], [], env.catalog, new R.FixtureAligner(), skill_text);
    const refined = prop.candidate;
    if (refined === null) throw pyerr("AttributeError", "'NoneType' object has no attribute 'artifact_hash'");
    HX.registry.admit(env.store, refined, env.catalog, { expected_parent_hash: initial.artifact_hash,
      approver: env.principal("user:dana"), environment: "sandbox",
      archive_manifest: HX.update.archive_manifest([dev], []), protected: [dev],
      deployment_policy: HX.fixture.deployment_policy(), now: env.clock(), skill_text });
    const overlap = new Map();
    for (const t of tasks) overlap.set(t.id, ev.dev_overlap(t, dev));
    const arms = { initial_compiled: tasks.map((t) => ev.run_task(env, initial, t)),
      trace_refined: tasks.map((t) => ev.run_task(env, refined, t)) };
    for (const rows of Object.values(arms)) for (const r of rows) r.dev_overlap = overlap.get(r.task);
    const arms_out = {};
    for (const k of Object.keys(arms)) {
      const v = arms[k];
      arms_out[k] = { summary: ev.summarize(v), rows: v,
        strictly_heldout_summary: ev.summarize(v.filter((r) => !truthy(r.dev_overlap))) };
    }
    const dev_ov = {};
    for (const [k, v] of overlap) if (truthy(v)) dev_ov[k] = v;
    return {
      mode: ev.MODE,
      environment: { runtime: "browser", engine: HX.VERSION },
      artifacts: { initial: initial.artifact_hash, refined: refined.artifact_hash },
      task_set_digest: HX.canonical.digest(tasks),
      arms: arms_out,
      dev_overlap: dev_ov,
      not_run: Object.assign({}, ev.NOT_RUN),
      repeats: 1, note: ev.NOTE,
    };
  };

  /** Python's report.md lines for a run_eval result (see the module header for the commit line). */
  ev.report_lines = function report_lines(result) {
    const arms = item(result, "arms");
    const a0 = item(arms, "initial_compiled"), a1 = item(arms, "trace_refined");
    const s0 = item(a0, "summary"), s1 = item(a1, "summary");
    const env = hasOwn(result, "environment") && is_dict(result.environment) ? result.environment : {};
    const ntasks = item(a0, "rows").length;
    const where = typeof env.git_commit === "string" ? "Commit `" + Array.from(env.git_commit).slice(0, 12).join("") + "`"
      : "Engine `" + str(hasOwn(env, "engine") ? env.engine : HX.VERSION) + "`";
    const lines = ["# Fixture-mode evaluation (held-out synthetic tasks)", "",
      "Mode: " + str(item(result, "mode")) + ". " + where + ". Tasks: " + ntasks + ". Repeats: 1 (deterministic).", "",
      "| Metric | initial_compiled | trace_refined |", "|---|---|---|"];
    const fmt_for = (k) => (ev.RATIO_METRICS.indexOf(k) >= 0 ? fmt2 : str);
    for (const k of METRICS) {
      const v0 = item(s0, k);
      const fmt = fmt_for(k);
      lines.push("| " + k + " | " + fmt(v0) + " | " + fmt(item(s1, k)) + " |");
    }
    lines.push("", "`fallback_rate` counts runs that end in a fallback-category terminal (e.g. END_REVIEW) or enter the " +
      "failure fallback; `failure_fallback_rate` counts only the latter.");
    const dov = item(result, "dev_overlap");
    if (truthy(dov)) {
      const h0 = item(a0, "strictly_heldout_summary"), h1 = item(a1, "strictly_heldout_summary");
      lines.push("", "**Development-trace overlap.** These tasks share the supplier or the supplied documents with " +
        "the development trace given to the aligner, so they are NOT held out:", "");
      /* Python iterates the overlap dict in task order (first occurrence of each id); a JS object would put
         integer-like ids first, so the order is taken from the rows */
      const order = [];
      const seen = new Set();
      for (const r of item(a0, "rows")) {
        const id = item(r, "task");
        if (!seen.has(id)) { seen.add(id); if (hasOwn(dov, id)) order.push(id); }
      }
      for (const k of Object.keys(dov)) if (!seen.has(k)) order.push(k);
      for (const k of order) lines.push("- `" + str(k) + "`: " + HX.traces._py_list(dov[k]).map(str).join("; "));
      lines.push("", "Strictly held-out tasks only (" + str(item(h0, "tasks")) + "):", "",
        "| Metric | initial_compiled | trace_refined |", "|---|---|---|");
      for (const k of HELDOUT_METRICS) {
        const v0 = item(h0, k);
        const fmt = fmt_for(k);
        lines.push("| " + k + " | " + fmt(v0) + " | " + fmt(item(h1, k)) + " |");
      }
    }
    lines.push("", "| Task | expected | initial (interactions) | refined (interactions) | dev overlap |",
      "|---|---|---|---|---|");
    const r0 = item(a0, "rows"), r1 = item(a1, "rows");
    for (let i = 0; i < Math.min(r0.length, r1.length); i++) {
      const a = r0[i], b = r1[i];
      lines.push("| " + str(item(a, "task")) + " | " + str(item(a, "expected")) + " | " + str(item(a, "terminal")) + " (" +
        str(item(a, "human_interactions")) + ") | " + str(item(b, "terminal")) + " (" + str(item(b, "human_interactions")) +
        ") | " + (truthy(item(a, "dev_overlap")) ? "yes" : "") + " |");
    }
    lines.push("", "Direct skill prompting + ReAct baseline: **not run** (needs a live model).",
      "These numbers describe deterministic fixture behavior, not model quality or production performance.");
    return lines;
  };

  ev.report_markdown = function report_markdown(result) {
    return ev.report_lines(result).join("\n") + "\n";
  };
})(globalThis.HX = globalThis.HX || {});
