/* Port of hexis_service/compiler/compile.py (HX.compile): snapshot -> clause index -> context -> draft ->
 * validate -> bounded repair -> deterministic normalization -> unadmitted package.
 *
 * The compiler model is an injected adapter ``{model_id, settings, draft(context, diagnostics, attempt)}``
 * (optionally ``prompt_template`` / ``prompt_template_sha256`` for live compilers). It proposes; it never
 * admits. Every draft, its findings and its diff to the previous draft are kept in the result.
 * Packages are MachinePackage dumps; reports are HX.validate.ValidationReport instances.
 */
(function (HX) {
  "use strict";
  const compile = (HX.compile = HX.compile || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const is_dict = (v) => HX.util.is_plain_object(v);
  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  const sorted = (it) => Array.from(it).sort(cmp);
  const clone = (v) => HX.util.deep_clone(v);

  compile.COMPILER_VERSION = "hexis-service-compiler/1";
  compile.NORMALIZER_VERSION = "hexis-service-normalizer/1";
  compile.GUARD_GRAMMAR = "Guards: boolean and/or/not over typed comparisons (==, !=, <, <=, >, >=), membership in literal " +
    "lists (x in ['a','b']), and empty(x)/nonempty(x). No calls, attributes, imports or null literals. " +
    "Guarded edges must be pairwise exclusive; exactly one default edge (empty 'if'), placed last.";
  compile.ACTION_KINDS = ["tool", "model", "judge", "user", "end"];
  compile.TERMINAL_CATEGORIES = ["verified", "unverified", "fallback"];

  const V = () => HX.validate;
  const truthy = (v) => V()._py_truthy(v);
  const py_eq = (a, b) => V()._py_eq(a, b);
  const py_str = (v) => V()._py_str(v);
  /** Python ``s[:n]`` by code point. */
  const cp_head = (s, n) => {
    if (s.length <= n) return s;
    const cps = Array.from(s);
    return cps.length <= n ? s : cps.slice(0, n).join("");
  };
  const set_own = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

  /** ``prompts_sha256``: the context digest; models exposing ``prompt_template_sha256`` bind the template too. */
  compile.prompts_digest = function prompts_digest(context, model) {
    const tmpl = model && model.prompt_template_sha256 !== undefined ? model.prompt_template_sha256 : "";
    if (!truthy(tmpl)) return HX.canonical.digest(context);
    return HX.canonical.digest({
      context_sha256: HX.canonical.digest(context),
      prompt_template: model.prompt_template !== undefined ? model.prompt_template : "",
      prompt_template_sha256: tmpl,
    });
  };

  class CompileResult {
    constructor(status, package_, report, attempts, coverage, review_required) {
      this.status = status; /* "validated" | "rejected" */
      this.package = package_ === undefined ? null : package_;
      this.report = report === undefined ? null : report;
      this.attempts = attempts || [];
      this.coverage = coverage || [];
      this.review_required = review_required || [];
    }

    to_json() {
      return {
        status: this.status, artifact_hash: this.package ? this.package.artifact_hash : null, attempts: this.attempts,
        coverage: this.coverage, review_required: this.review_required, report: this.report ? this.report.to_json() : null,
      };
    }
  }
  compile.CompileResult = CompileResult;

  /** Only approved interfaces, grammar, action schema, terminal vocabulary and numbered source content.
   *  ``policy``: DeploymentPolicy dump; ``catalog``: ToolCatalog dump. */
  compile.build_context = function build_context(source, clauses, catalog, policy) {
    const tools = {};
    for (const n of Object.keys(catalog.tools)) {
      const t = catalog.tools[n];
      set_own(tools, n, { version: t.version, input_schema: t.input_schema, output_schema: t.output_schema,
        effect: t.effect, verifier_claims: t.verifier_claims });
    }
    return {
      clauses: clauses.map((c) => ({ id: c.id, heading: c.heading, text: c.text, critical: HX.clauses.is_critical(c) })),
      tools,
      guard_grammar: compile.GUARD_GRAMMAR,
      action_kinds: compile.ACTION_KINDS.slice(),
      terminal_categories: compile.TERMINAL_CATEGORIES.slice(),
      task_input_schema: policy.task_input_schema,
      capability_ceiling: policy.execution_policy.capability_ceiling,
      max_loop_bound: policy.execution_policy.max_loop_bound,
    };
  };

  /** Documented canonical transformations; none changes behavior: default edges after guarded edges,
   *  variables sorted by name, states initial-first then breadth-first then the rest by id. */
  compile.normalize_machine = function normalize_machine(m) {
    const data = HX.efsm.to_json(m);
    for (const sid of Object.keys(data.states)) {
      const st = data.states[sid];
      const trans = st.transitions || [];
      st.transitions = trans.filter((t) => truthy(t["if"])).concat(trans.filter((t) => !truthy(t["if"])));
    }
    data.variables = data.variables.slice().sort((a, b) => cmp(a.name, b.name));
    const order = [];
    const seen = new Set();
    const queue = [m.initial];
    for (let qi = 0; qi < queue.length; qi++) {
      const s = queue[qi];
      if (seen.has(s) || !hasOwn(data.states, s)) continue;
      seen.add(s);
      order.push(s);
      for (const t of data.states[s].transitions) queue.push(t.to);
    }
    for (const s of sorted(Object.keys(data.states).filter((x) => !seen.has(x)))) order.push(s);
    const states = Object.create(null);
    for (const s of order) set_own(states, s, data.states[s]);
    data.states = states;
    return HX.efsm.load_machine(data);
  };

  compile._coverage_regressions = function _coverage_regressions(prev, cur, critical_ids) {
    const out = [];
    for (const cid of sorted(critical_ids)) {
      const p = hasOwn(prev, cid) ? prev[cid] : null, c = hasOwn(cur, cid) ? cur[cid] : null;
      if (truthy(p) && p.classification === "executable_control" &&
          (!truthy(c) || c.classification !== "executable_control" || !truthy(c.states))) {
        out.push(new HX.validate.Finding("REQUIREMENT_DROPPED", "repair removed executable coverage of critical clause " + cid,
          { clause: cid }));
      }
    }
    return out;
  };

  /** The requirement set a repair must not shrink (keys contain ':', so a plain object keeps insertion order). */
  compile._requirements = function _requirements(contracts) {
    const out = {};
    for (const o of contracts.ordering) out["ordering:" + o.id] = clone(o);
    for (const sid of Object.keys(contracts.interactions)) out["interaction:" + sid] = clone(contracts.interactions[sid]);
    for (const tid of Object.keys(contracts.terminals)) {
      for (const ev of contracts.terminals[tid].evidence) out["evidence:" + tid + ":" + ev.claim] = clone(ev);
    }
    return out;
  };

  const subset = (a, b) => { const sb = new Set(b); return a.every((x) => sb.has(x)); };

  /** True when ``cur`` constrains at least as much as ``prev``. */
  compile._at_least_as_strong = function _at_least_as_strong(key, prev, cur) {
    const kind = key.split(":")[0];
    if (kind === "ordering") {
      return cur.before === prev.before && cur.clause === prev.clause && cur.requires.length > 0 &&
        subset(cur.requires, prev.requires) && subset(prev.invalidated_by, cur.invalidated_by);
    }
    if (kind === "interaction") {
      return ["type", "approves_state", "response_schema"].every((k) => py_eq(cur[k], prev[k])) &&
        (!prev.required_role || cur.required_role === prev.required_role);
    }
    if (kind === "evidence") {
      return cur.verifier_tool === prev.verifier_tool && subset(prev.subject_vars, cur.subject_vars);
    }
    return false;
  };

  compile._malformed_requirements = function _malformed_requirements(findings) {
    const out = new Set();
    for (const f of findings) {
      const v = hasOwn(f.detail, "malformed_requirement") ? f.detail.malformed_requirement : null;
      if (truthy(v)) out.add(py_str(v));
    }
    return out;
  };

  compile._requirement_regressions = function _requirement_regressions(prev, cur, named) {
    const out = [];
    for (const key of sorted(Object.keys(prev))) {
      let why;
      if (!hasOwn(cur, key)) why = "removed";
      else if (!py_eq(cur[key], prev[key]) && !compile._at_least_as_strong(key, prev[key], cur[key])) why = "changed";
      else continue;
      const tail = key.slice(key.indexOf(":") + 1);
      const note = named.has(tail) || named.has(key) ? " (named by a previous diagnostic)" : "";
      out.push(new HX.validate.Finding("REQUIREMENT_DROPPED", "repair " + why + " requirement " + key + note,
        { detail: { requirement: key } }));
    }
    return out;
  };

  compile._advance_baseline = function _advance_baseline(prev, cur, malformed) {
    const out = Object.assign({}, prev);
    for (const key of Object.keys(cur)) {
      const val = cur[key];
      if (malformed.has(key)) continue;
      if (!hasOwn(prev, key) || py_eq(val, prev[key]) || compile._at_least_as_strong(key, prev[key], val)) out[key] = val;
    }
    return out;
  };

  /** Python ``raw[key]`` on a draft value; KeyError/TypeError like Python. */
  function subscript(raw, key) {
    if (is_dict(raw)) {
      if (!hasOwn(raw, key)) throw V()._pyerr("KeyError", V()._repr(key));
      return raw[key];
    }
    if (Array.isArray(raw)) throw V()._pyerr("TypeError", "list indices must be integers or slices, not str");
    if (typeof raw === "string") throw V()._pyerr("TypeError", "string indices must be integers, not 'str'");
    throw V()._pyerr("TypeError", "'" + V()._type_name(raw) + "' object is not subscriptable");
  }

  function exc_text(e) {
    if (e instanceof HX.HXError && typeof e.msg === "string") return e.msg;
    return e && e.message !== undefined ? String(e.message) : String(e);
  }

  /** ``compile_skill(source, tool_catalog, deployment_policy, model, max_attempts=3)``.
   *  ``source``: ``{path, text, resources}``; ``deployment_policy``: DeploymentPolicy dump; the last argument
   *  may be a number or ``{max_attempts}``. */
  compile.compile_skill = function compile_skill(source_, tool_catalog_, deployment_policy_, model, max_attempts) {
    if (is_dict(max_attempts)) max_attempts = max_attempts.max_attempts;
    if (max_attempts === undefined || max_attempts === null) max_attempts = 3;
    const source = HX.pkg.SkillSource.model_validate(source_);
    const tool_catalog = HX.catalog.load_catalog(tool_catalog_);
    const dp = HX.pkg.DeploymentPolicy.model_validate(deployment_policy_);
    const clauses = HX.clauses.index_clauses(source.text);
    const critical_ids = new Set(clauses.filter((c) => HX.clauses.is_critical(c)).map((c) => c.id));
    const context = compile.build_context(source, clauses, tool_catalog, dp);
    const resources = Object.create(null);
    for (const k of sorted(Object.keys(source.resources))) set_own(resources, k, HX.canonical.sha256_hex(source.resources[k]));
    const manifest = HX.pkg.SourceManifest.model_validate({
      skill_path: source.path, skill_sha256: HX.canonical.sha256_hex(source.text), resources, clauses,
      tool_catalog_sha256: HX.catalog.digest(tool_catalog), input_contract_sha256: HX.canonical.digest(dp.task_input_schema),
      deployment_policy_sha256: HX.pkg.DeploymentPolicy.digest(dp),
    });
    const cmanifest = HX.pkg.CompilerManifest.model_validate({
      compiler: compile.COMPILER_VERSION, prompts_sha256: compile.prompts_digest(context, model), model_id: model.model_id,
      model_settings: model.settings, validator_version: HX.validate.VALIDATOR_VERSION,
      normalizer_version: compile.NORMALIZER_VERSION,
    });
    const attempts = [];
    let diagnostics = [];
    let prev_pkg = null;
    let prev_cov = Object.create(null);
    let prev_reqs = {};
    let report = null;
    const opts = { skill_text: source.text, deployment_policy: dp };
    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      const raw = model.draft(context, diagnostics, attempt);
      if (is_dict(raw) && hasOwn(raw, "malformed") && is_dict(raw.malformed)) {
        const bad = raw.malformed;
        const code = hasOwn(bad, "code") && truthy(bad.code) ? bad.code : "DRAFT_MALFORMED";
        const d = { code: py_str(code), message: cp_head(py_str(hasOwn(bad, "message") ? bad.message : ""), 2000) };
        if (hasOwn(bad, "detail") && is_dict(bad.detail)) d.detail = bad.detail;
        diagnostics = [d];
        attempts.push({ attempt, status: "malformed", findings: diagnostics });
        continue;
      }
      let machine, contracts;
      try {
        machine = HX.efsm.load_machine(subscript(raw, "machine"));
        contracts = HX.pkg.Contracts.model_validate(subscript(raw, "contracts"));
      } catch (e) {
        if (e instanceof RangeError && !(e instanceof HX.HXError)) throw e;
        diagnostics = [{ code: "DRAFT_SCHEMA", message: cp_head(exc_text(e), 2000) }];
        attempts.push({ attempt, status: "malformed", findings: diagnostics });
        continue;
      }
      contracts.task_input_schema = dp.task_input_schema;
      const pkg = HX.pkg.sealed({ machine, source_manifest: manifest, compiler_manifest: cmanifest, contracts,
        execution_policy: dp.execution_policy, lineage: {} });
      report = HX.validate.validate_package(pkg, tool_catalog, dp.profile, opts);
      const cov = Object.create(null);
      for (const k of Object.keys(contracts.clause_coverage)) set_own(cov, k, clone(contracts.clause_coverage[k]));
      let regress = compile._coverage_regressions(prev_cov, cov, critical_ids);
      const reqs = compile._requirements(contracts);
      const named = new Set();
      for (const d of diagnostics) {
        const det = hasOwn(d, "detail") && truthy(d.detail) ? d.detail : {};
        named.add(py_str(hasOwn(det, "requirement") ? det.requirement : ""));
      }
      regress = regress.concat(compile._requirement_regressions(prev_reqs, reqs, named));
      for (const f of regress) report.findings.push(f);
      const entry = { attempt, draft_hash: pkg.artifact_hash, status: report.passed ? "valid" : "invalid",
        findings: report.findings.filter((f) => f.severity === "error").map((f) => f.to_json()) };
      if (prev_pkg !== null) entry.diff_from_previous = HX.diff.package_diff(prev_pkg, pkg, tool_catalog);
      attempts.push(entry);
      if (!Object.keys(prev_cov).length) prev_cov = cov;
      else {
        const merged = Object.create(null);
        for (const k of Object.keys(prev_cov)) set_own(merged, k, prev_cov[k]);
        for (const k of Object.keys(cov)) set_own(merged, k, cov[k]);
        prev_cov = merged;
      }
      prev_pkg = pkg;
      prev_reqs = compile._advance_baseline(prev_reqs, reqs, compile._malformed_requirements(report.findings));
      if (report.passed) {
        const normalized = HX.pkg.sealed({ machine: compile.normalize_machine(machine), source_manifest: manifest,
          compiler_manifest: cmanifest, contracts, execution_policy: dp.execution_policy });
        const nreport = HX.validate.validate_package(normalized, tool_catalog, dp.profile, opts);
        if (!nreport.passed) {
          attempts.push({ attempt, status: "normalization_broke_validity", findings: nreport.errors().map((f) => f.to_json()) });
          return new CompileResult("rejected", null, nreport, attempts);
        }
        const rj = nreport.to_json();
        const unresolved = [];
        for (const k of Object.keys(contracts.clause_coverage)) {
          const v = contracts.clause_coverage[k];
          if (v.classification === "unsupported") unresolved.push("clause " + k + ": " + v.classification + " - " + v.justification);
        }
        const final = normalized;
        final.validation_manifest = HX.pkg.ValidationManifest.model_validate({
          profile: dp.profile, report_digest: rj.report_digest, passed: true, findings: rj.findings,
          unresolved_limitations: unresolved,
        });
        const coverage = coverage_table(final);
        const review = coverage.filter((r) => r.classification === "unsupported")
          .map((r) => r.clause + " (" + r.classification + "): " + r.justification);
        return new CompileResult("validated", final, nreport, attempts, coverage, review);
      }
      diagnostics = report.errors().map((f) => f.to_json());
    }
    return new CompileResult("rejected", prev_pkg, report, attempts);
  };

  function coverage_table(pkg) {
    const reach = HX.validate.reachable(pkg.machine, pkg.machine.initial);
    const rows = [];
    const cc = pkg.contracts.clause_coverage;
    for (const c of pkg.source_manifest.clauses) {
      const cov = hasOwn(cc, c.id) ? cc[c.id] : null;
      rows.push({ clause: c.id, critical: HX.clauses.is_critical(c), text: c.text,
        classification: cov ? cov.classification : "UNCLASSIFIED",
        states: (cov ? cov.states : []).filter((s) => reach.has(s)),
        justification: cov ? cov.justification : "" });
    }
    return rows;
  }
  compile._coverage_table = coverage_table;

  compile.coverage_markdown = function coverage_markdown(rows) {
    const lines = ["| Clause | Critical | Classification | States | Text |", "|---|---|---|---|---|"];
    for (const r of rows) {
      const text = r.text.split("|").join("\\|");
      const n = HX.util.codepoint_length(text);
      lines.push("| " + r.clause + " | " + (r.critical ? "yes" : "") + " | " + r.classification + " | " +
        r.states.join(", ") + " | " + cp_head(text, 90) + (n > 90 ? "…" : "") + " |");
    }
    return lines.join("\n");
  };

  /** ``demo/env.py::skill_source()`` */
  compile.skill_source = function skill_source() {
    return { path: HX.data.skill_path, text: HX.data.skill_md, resources: {} };
  };

  /** ``demo/env.py::compile_procurement(catalog=None)`` */
  compile.compile_procurement = function compile_procurement(catalog) {
    return compile.compile_skill(compile.skill_source(), catalog || HX.catalog.load_catalog(HX.data.tool_catalog),
      HX.fixture.deployment_policy(), new HX.fixture.FixtureCompilerModel());
  };
})(globalThis.HX = globalThis.HX || {});
