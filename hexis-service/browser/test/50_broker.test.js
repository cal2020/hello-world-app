/* Runtime parity (golden/runtime*.json from golden/gen_runtime.py): the shared scenario interpreter, plus the
 * broker-focused scenarios and unit vectors. The interpreter mirrors gen_runtime.py's ``do()`` operation by
 * operation; every scenario must reproduce Python's transcript exactly (results, errors and snapshots). */
(function () {
  const RT = (globalThis.RT_RUNTIME = globalThis.RT_RUNTIME || {});
  const SKILL = "supplier-onboarding-draft";
  const CLOCK0 = 1790000000.25;
  const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  let PKGS = null;
  /** The package variants of gen_runtime.py, re-expressed as JSON edits + sealed(). */
  RT.pkgs = function pkgs() {
    if (PKGS) return PKGS;
    const initial = HX.compile.compile_procurement().package;
    const reseal = (fn) => {
      const d = HX.kernel._clone(HX.pkg.to_json(initial));
      fn(d);
      d.artifact_hash = "";
      return HX.pkg.sealed(d);
    };
    const unsealed = HX.kernel._clone(initial);
    unsealed.artifact_hash = "";
    PKGS = {
      initial,
      /* JSON text keeps Python's key (state) order; the validator's finding order depends on it */
      refined: HX.pkg.normalize_package(HX.canonical.strict_loads(golden("runtime").refined_json)),
      other: reseal((d) => { d.machine.states.EXTRACT_DRAFT.action.prompt = "changed"; }),
      wide: reseal((d) => {
        d.execution_policy.max_loop_bound = 1000;
        d.execution_policy.budgets.max_steps = 100000;
        d.machine.max_steps = 100000;
        d.machine.states.VALIDATE_DRAFT.transitions[1]["if"] = "validation_status == 'repairable' and repair_count < 1000";
      }),
      specialist: reseal((d) => { d.contracts.interactions.REQUEST_APPROVAL.required_role = "procurement_specialist"; }),
      unsealed,
    };
    return PKGS;
  };

  class ForeignBUModel extends HX.fakes.FixtureExtractionModel {
    generate(req) {
      const r = super.generate(req);
      if ((req.state_id === "EXTRACT_DRAFT" || req.state_id === "REPAIR_DRAFT") && HX.util.is_plain_object(r.output) &&
        hasOwn(r.output, "draft")) {
        r.output.draft.business_unit = "BU-APAC";
      }
      return r;
    }
  }
  class CostModel {
    constructor(inner, cost) { this.inner = inner; this.cost = cost; this.model_id = inner.model_id; }
    generate(req) {
      const resp = this.inner.generate(req);
      return HX.models.ModelResponse.model_validate(Object.assign({}, resp, { cost_usd: this.cost }));
    }
  }
  function make_model(spec) {
    if (spec === undefined || spec === null) return undefined;
    const s = Object.assign({}, spec);
    const kind = s.kind || "fixture";
    const cost = hasOwn(s, "cost") ? s.cost : null;
    delete s.kind;
    delete s.cost;
    const m = kind === "foreign_bu" ? new ForeignBUModel(s) : new HX.fakes.FixtureExtractionModel(s);
    return cost !== null ? new CostModel(m, cost) : m;
  }

  function enc_error(e) {
    if (e instanceof HX.service.RunError) return { error: "RunError", code: e.code, message: e.message };
    if (e instanceof HX.broker.SimulatedCrash) return { error: "SimulatedCrash", code: e.point };
    if (e instanceof HX.store.ConflictError) return { error: "ConflictError", code: e.message.split(":")[0], message: e.message };
    if (e instanceof HX.HXError) return { error: e.code };
    throw e; /* a JS bug, not a Python error class */
  }
  RT.enc_error = enc_error;
  const enc_step = (r) => ({ status: r.status, detail: r.detail, checkpoint: r.checkpoint, interaction: r.interaction });
  const enc_handle = (h) => ({ run_id: h.run_id, tenant_id: h.tenant_id, artifact_hash: h.artifact_hash, status: h.status,
    revision: h.revision });
  const enc_cancel = (c) => ({ status: c.status, disclosed_effects: c.disclosed_effects, unresolved: c.unresolved });
  const enc_adm = (a) => ({ status: a.status, artifact_hash: a.artifact_hash, reasons: a.reasons, record: a.record,
    archive_version: a.archive_version });
  const enc_broker = (r) => ({ status: r.status, output: r.output, reason: r.reason, receipt_ref: r.receipt_ref,
    certainty: r.certainty, evidence: r.evidence });

  const persist_intent = (env, rid, tool) => {
    const its = env.store.intents("acme", rid).filter((i) => i.tool === (tool || "erp.create_draft"));
    return its[its.length - 1];
  };

  function snap(ctx, run) {
    const e = ctx.env;
    const out = { erp: e.erp._rows.map((r) => [r.tenant_id, r.draft_id, r.supplier_ref, r.draft_digest, r.idempotency_key,
      r.args_digest, r.payload, r.version]), erp_calls: e.erp.calls.map((c) => c.slice()), erp_faults: e.erp.faults.slice(),
    armed: Array.from(e.faults.armed).sort(), policy_version: e.policy.version,
    active: e.store.get_active("sandbox", SKILL), archive: e.store.archive(SKILL) };
    if (run !== null && run !== undefined && hasOwn(ctx.runs, run)) {
      const rid = ctx.runs[run];
      if (e.store.get_run("acme", rid) !== null) {
        out.inspect = e.service.inspect_run(rid, e.principal("user:alice"));
        out.checkpoints = e.store.checkpoints("acme", rid).map((c) => HX.canonical.digest(c));
      }
    }
    return plain(out);
  }

  function admit_raw(ctx, pkg) {
    const e = ctx.env;
    const rep = HX.validate.validate_package(pkg, e.catalog, "production", { skill_text: HX.env.skill_source().text,
      deployment_policy: HX.fixture.deployment_policy() });
    assert.ok(rep.passed, "refined package validates");
    const rj = rep.to_json();
    const [key_id, key] = HX.registry.signing_key();
    const now = ctx.clock();
    const man = HX.registry._manifest_of([], []);
    const rec = HX.pkg.sign_admission({ artifact_hash: pkg.artifact_hash, environment: "sandbox", approver: "user:dana",
      admitted_at: HX.registry._utc_isoformat(now), validation_report_digest: rj.report_digest,
      replay_archive_digest: HX.canonical.digest(man), key_id }, key);
    HX.registry.register(e.store, pkg, "user:dana", now);
    const active = e.store.get_active("sandbox", pkg.machine.skill_id);
    const cur = e.store.archive(pkg.machine.skill_id) || {};
    return e.store.publish_admission({ environment: "sandbox", skill_id: pkg.machine.skill_id,
      artifact_hash: pkg.artifact_hash, expected_parent_hash: active ? active[0] : null,
      gated_archive_version: hasOwn(cur, "version") ? cur.version : null, traces: [], record: rec, report: rj,
      env_key: pkg.artifact_hash + "@sandbox", actor: "user:dana", manifest: man, now });
  }

  /** INSERT OR REPLACE a raw row (Python uses SQL; the JS store is edited through snapshot/restore). */
  function raw_replace(store, table, keycol, row) {
    const s = store.snapshot();
    const cols = s.columns[table];
    const i = cols.indexOf(keycol);
    s.tables[table] = s.tables[table].filter((r) => r[i] !== row[i]);
    s.tables[table].push(row);
    store.restore(s);
  }
  function raw_update(store, table, where_col, where_val, set_col, value) {
    const s = store.snapshot();
    const cols = s.columns[table];
    const wi = cols.indexOf(where_col), si = cols.indexOf(set_col);
    for (const r of s.tables[table]) if (r[wi] === where_val) r[si] = value;
    store.restore(s);
  }

  function do_op(ctx, op) {
    const k = op.op;
    const e = ctx.env;
    const svc = e ? e.service : null;
    const P = () => RT.pkgs();
    const p = (who) => ctx.env.principal(who);
    const rid = (name) => {
      if (!hasOwn(ctx.runs, name)) throw new HX.HXError("KeyError", name);
      return ctx.runs[name];
    };
    switch (k) {
      case "env": {
        const env = HX.env.build_env(ctx.wdir + op.dir, { clock: ctx.clock, timer: ctx.timer, ids: ctx.ids,
          model: make_model(op.model) });
        ctx.envs[op.name || "main"] = env;
        ctx.env = env;
        ctx.paths.push(ctx.wdir + op.dir);
        if (op.admit === undefined || op.admit) return [enc_adm(HX.env.admit_initial(env, P().initial)), null, true];
        return [null, null, true];
      }
      case "use_env": ctx.env = ctx.envs[op.name]; return [null, null, false];
      case "restart":
        ctx.env = e.restart(make_model(op.model));
        ctx.envs[op.name || "main"] = ctx.env;
        return [null, null, true];
      case "start": {
        const h = svc.start_run(P()[op.pkg || "initial"].artifact_hash, HX.env.task(op.task), p(op.as || "user:alice"),
          op.request_id || "");
        ctx.runs[op.run] = h.run_id;
        return [enc_handle(h), op.run, true];
      }
      case "run":
      case "advance": {
        const kw = {};
        if (hasOwn(op, "worker")) kw.worker_id = op.worker;
        let r;
        if (k === "run") r = svc.run_until_blocked(rid(op.run), p(op.as || "user:alice"), kw);
        else {
          if (hasOwn(op, "expected_revision")) kw.expected_revision = op.expected_revision;
          r = svc.advance_run(rid(op.run), p(op.as || "user:alice"), kw);
        }
        if (r.interaction) ctx.ix[op.run] = r.interaction;
        return [enc_step(r), op.run, true];
      }
      case "approve":
      case "resume": {
        if (!hasOwn(ctx.ix, op.run)) throw new HX.HXError("KeyError", op.run);
        const ix = ctx.ix[op.run];
        let resp;
        if (k === "approve") {
          const scope = (op.scope || "ok") === "ok" ? ix.scope_digest : op.scope;
          resp = { approval_decision: hasOwn(op, "decision") ? op.decision : "approved", scope_digest: scope };
        } else resp = hasOwn(op, "response_json") ? JSON.parse(op.response_json) : op.response;
        const r = svc.resume_interaction(rid(op.run), ix.interaction_id, resp, p(op.as || "user:bob"), op.request_id || "");
        if (r.interaction) ctx.ix[op.run] = r.interaction;
        return [enc_step(r), op.run, true];
      }
      case "cancel": {
        const rest = hasOwn(op, "worker") ? [{ worker_id: op.worker }] : [];
        const c = svc.cancel_run(rid(op.run), hasOwn(op, "expected_revision") ? op.expected_revision : null,
          p(op.as || "user:alice"), ...rest);
        return [enc_cancel(c), op.run, true];
      }
      case "resolve": {
        const r0 = rid(op.run);
        const lid = op.lid || persist_intent(e, r0, op.tool).logical_action_id;
        const kw = {};
        if (hasOwn(op, "output")) kw.output = op.output;
        if (hasOwn(op, "note")) kw.note = op.note;
        return [svc.resolve_effect(r0, lid, op.outcome, p(op.as || "user:bob"), kw), op.run, true];
      }
      case "inspect": return [svc.inspect_run(rid(op.run), p(op.as)), null, false];
      case "arm": e.faults.arm(op.point); return [null, null, false];
      case "inject": e.erp.inject(op.fault); return [null, null, false];
      case "clock": ctx.clock.advance(op.s); return [null, null, false];
      case "timer": ctx.set_timer(op.base, op.step); return [null, null, false];
      case "append_timing":
        e.store.append_events("acme", rid(op.run), [Object.assign({}, op.event, { type: "TIMING" })], ctx.clock());
        return [null, null, false];
      case "revoke":
        HX.registry.revoke(e.store, P()[op.pkg || "initial"].artifact_hash, p(op.as), op.reason || "defect found", ctx.clock());
        return [null, null, true];
      case "revoke_cap": e.policy.revoke_capability(op.pid, op.cap); return [e.policy.version, null, false];
      case "effect": e.catalog.tools[op.tool].effect = op.effect; return [null, null, false];
      case "del_tool": delete e.catalog.tools[op.tool]; return [null, null, false];
      case "clear_reconcilers":
        for (const key of Object.keys(e.broker.reconcilers)) delete e.broker.reconcilers[key];
        return [null, null, false];
      case "erp_modify":
      case "erp_tamper": {
        const cp = svc._cp("acme", rid(op.run));
        if (k === "erp_modify") e.erp.modify_out_of_band("acme", cp.variables.erp_draft_id, op.changes);
        else e.erp.tamper_payload("acme", cp.variables.erp_draft_id, op.changes);
        return [null, op.run, true];
      }
      case "step_until": {
        const r0 = rid(op.run), pr = p(op.as || "user:alice");
        for (let i = 0; i < 50; i++) {
          const cp = svc._cp(pr.tenant_id, r0);
          if (cp.state_id === op.state || cp.status !== "RUNNING") {
            return [{ state: cp.state_id, status: cp.status, revision: cp.revision }, op.run, true];
          }
          svc.advance_run(r0, pr);
        }
        throw new Error("state not reached");
      }
      case "connector":
        if (op.kind === "spoof_lookup") e.broker.connectors["supplier.lookup"] = () => ({ status: "new", existing: {}, approved: true });
        else if (op.kind === "dying") {
          e.broker.connectors[op.tool] = () => { throw new HX.broker.SimulatedCrash("process died before the request reached the ERP"); };
        }
        return [null, null, false];
      case "bump_intent": {
        const lid = persist_intent(e, rid(op.run)).logical_action_id;
        for (let i = 0; i < op.times; i++) {
          e.store.update_intent("acme", lid, op.status || "DISPATCHING", ctx.clock(),
            { bump_attempt: hasOwn(op, "bump") ? op.bump : true });
        }
        return [null, op.run, true];
      }
      case "patch_add_evidence_noop": e.store._add_evidence = () => null; return [null, null, false];
      case "interleave_dispatch": {
        const r0 = rid(op.run);
        const env = e;
        const real = env.broker.dispatch.bind(env.broker);
        let n = 0;
        env.broker.dispatch = function interleaved(kw) {
          n += 1;
          if (n === 1) {
            ctx.clock.advance(env.service.lease_ttl + 1);
            env.erp.inject("timeout_after_commit");
            try {
              const b = env.service.advance_run(r0, env.principal("user:alice"), { worker_id: "worker-2" });
              ctx.side.push(plain(enc_step(b)));
            } catch (exc) {
              if (exc instanceof HX.broker.SimulatedCrash) throw exc;
              ctx.side.push(enc_error(exc));
            }
            ctx.side.push(persist_intent(env, r0).status);
          }
          return real(kw);
        };
        ctx.restore_dispatch = real;
        return [null, null, false];
      }
      case "restore_dispatch": e.broker.dispatch = ctx.restore_dispatch; return [ctx.side, null, false];
      case "crashy_update_intent": {
        const real = e.store.update_intent.bind(e.store);
        let n = 0;
        e.store.update_intent = function (tenant, lid, status, ...rest) {
          if (status === "SUCCEEDED" && n === 0) {
            n = 1;
            throw new HX.broker.SimulatedCrash("process died after receipt insert, before intent update");
          }
          return real(tenant, lid, status, ...rest);
        };
        return [null, null, false];
      }
      case "racing_response": {
        const r0 = rid(op.run);
        const ix = ctx.ix[op.run];
        const env = e;
        const real = env.store.record_response.bind(env.store);
        let n = 0;
        env.store.record_response = function (...args) {
          if (n === 0) {
            n = 1;
            const r = env.service.resume_interaction(r0, ix.interaction_id, { approval_decision: "approved",
              scope_digest: ix.scope_digest }, env.principal("user:bob"));
            ctx.side.push(plain(enc_step(r)));
          }
          return real(...args);
        };
        return [null, null, false];
      }
      case "forge_scope_digest":
        raw_update(e.store, "approval_requests", "interaction_id", ctx.ix[op.run].interaction_id, "scope_digest", "sha256:forged");
        return [null, op.run, true];
      case "approval_check": {
        const r0 = rid(op.run);
        const cp = svc._cp("acme", r0);
        const run = e.store.get_run("acme", r0);
        const pkg = svc.package(cp.artifact_hash);
        const prep = svc._prepare_tool(cp, pkg, "PERSIST_DRAFT", cp.revision);
        const intent = { state_id: "PERSIST_DRAFT", tool: "erp.create_draft", tool_version: "1.0.0",
          logical_action_id: prep.lid, args: prep.args, args_digest: prep.args_digest };
        const out = [svc._approval_check(run, cp, pkg, intent)()];
        const tampered = Object.assign({}, intent, { args: Object.assign({}, prep.args, { supplier_ref: "SUP-99999" }),
          args_digest: "sha256:changed" });
        out.push(svc._approval_check(run, cp, pkg, tampered)());
        return [out, null, false];
      }
      case "authorize": {
        const r0 = hasOwn(ctx.runs, op.run) ? ctx.runs[op.run] : "nope";
        const intent = { tenant_id: "acme", run_id: r0, logical_action_id: "la_x", tool: "erp.read_draft",
          tool_version: "1.0.0", args: op.args, args_digest: "d", idempotency_key: "k", status: "PENDING", attempts: 0 };
        const called = [];
        e.broker.connectors["erp.read_draft"] = (a) => { called.push(a); return {}; };
        const [ok, why] = e.broker.authorize({ intent, spec: HX.catalog.get(e.catalog, "erp.read_draft"),
          principal: p("user:alice"), package: P().initial, business_unit: hasOwn(op, "bu") ? op.bu : "BU-EMEA",
          approval_check: () => [true, ""], lease_token: op.token ? (hasOwn(ctx.tokens, op.token) ? ctx.tokens[op.token] : null) : null });
        return [[ok, why, called.length], null, false];
      }
      case "lease": {
        const t = e.store.acquire_lease("acme", rid(op.run), op.worker, ctx.clock(), op.ttl);
        if (op.save) ctx.tokens[op.save] = t;
        return [t, null, false];
      }
      case "commit_stale": {
        const r0 = rid(op.run);
        const cp = e.store.latest_checkpoint("acme", r0);
        e.store.commit_transition("acme", r0, cp.revision, ctx.tokens[op.token], Object.assign({}, cp, { revision: cp.revision + 1 }),
          [], ctx.clock());
        return [null, null, false];
      }
      case "freshness_check": {
        const r0 = rid(op.run);
        const run = e.store.get_run("acme", r0);
        const cp = svc._cp("acme", r0);
        const check = svc.freshness.persisted_draft_matches_approved_payload;
        const cp_end = Object.assign({}, cp, { state_id: "END_VERIFIED_DRAFT", revision: cp.revision - 1 });
        const out = [];
        for (let i = 0; i < (op.times || 1); i++) out.push(check(svc, run, cp_end, svc.package(cp.artifact_hash), p("user:alice")));
        return [out, op.run, true];
      }
      case "stale_dispatch": {
        const r0 = rid(op.run);
        const cp = svc._cp("acme", r0);
        const pkg = svc.package(cp.artifact_hash);
        const prep = svc._prepare_tool(cp, pkg, cp.state_id, cp.revision);
        const t1 = e.store.acquire_lease("acme", r0, "worker-1", ctx.clock(), 10);
        const intent = e.store.create_intent("acme", r0, prep.lid, cp.state_id, cp.revision, prep.spec.name,
          prep.spec.version, prep.args, prep.args_digest, prep.idem, t1, ctx.clock());
        ctx.clock.advance(11);
        e.store.acquire_lease("acme", r0, "worker-2", ctx.clock(), 10);
        const r = e.broker.dispatch({ intent, principal: p("user:alice"), package: pkg, business_unit: "BU-EMEA",
          approval_check: () => [true, ""], lease_token: t1, subject_values: {} });
        return [[enc_broker(r), e.store.intent_for_revision("acme", r0, cp.revision).status,
          e.store.receipts("acme", prep.lid)], op.run, true];
      }
      case "stop_direct": {
        const r0 = rid(op.run);
        svc._stop(e.store.get_run("acme", r0), svc._cp("acme", r0), 999, "FAILED", "X", "y");
        return [null, null, false];
      }
      case "set_run_status": return [e.store.set_run_status("acme", rid(op.run), op.status), op.run, true];
      case "invalidate_evidence": {
        const r0 = rid(op.run);
        const cp = svc._cp("acme", r0);
        e.store.invalidate_evidence("acme", cp.variables.verification_receipt, "test", ctx.clock(), { run_id: r0 });
        return [null, op.run, true];
      }
      case "evidence": return [e.store.evidence("acme", rid(op.run)), null, false];
      case "unresolved": return [svc._unresolved("acme", rid(op.run)), null, false];
      case "metrics": {
        const kw = {};
        if (hasOwn(op, "run")) kw.run_id = hasOwn(ctx.runs, op.run) ? ctx.runs[op.run] : op.run;
        if (hasOwn(op, "artifact")) kw.artifact_hash = P()[op.artifact].artifact_hash;
        const rep = HX.metrics.collect(e.store, op.tenant || "acme", kw);
        const out = { report: plain(HX.metrics.render_json(rep)), prometheus: HX.metrics.render_prometheus(rep) };
        if (op.hostile && hasOwn(rep.by_tool, "erp.create_draft")) {
          rep.by_tool['we"ird\\tool\nx'] = rep.by_tool["erp.create_draft"];
          out.hostile = HX.metrics.render_prometheus(rep);
        }
        return [out, null, false];
      }
      case "admit": {
        const kw = { expected_parent_hash: op.parent ? P()[op.parent].artifact_hash : (hasOwn(op, "parent_hash") ? op.parent_hash : null),
          approver: p(op.as || "user:dana"), environment: op.environment || "sandbox",
          deployment_policy: (hasOwn(op, "policy") ? op.policy : "default") === "default" ? HX.fixture.deployment_policy() : null,
          now: ctx.clock(), skill_text: (hasOwn(op, "skill_text") ? op.skill_text : true) ? HX.env.skill_source().text : null };
        if (op.archive_manifest !== undefined && op.archive_manifest !== null) kw.archive_manifest = op.archive_manifest;
        return [enc_adm(HX.registry.admit(e.store, P()[op.pkg || "initial"], e.catalog, kw)), null, true];
      }
      case "admit_raw": return [admit_raw(ctx, P()[op.pkg]), null, true];
      case "is_admitted":
        return [HX.registry.is_admitted_in(e.store, P()[op.pkg || "initial"].artifact_hash, op.environment), null, false];
      case "put_version":
        e.store.put_version(HX.pkg.to_json(P()[op.pkg]), op.actor || "test", hasOwn(op, "now") ? op.now : ctx.clock());
        return [null, null, false];
      case "forge_lifecycle":
        e.store.add_lifecycle(null, P()[op.pkg || "initial"].artifact_hash, "admitted", "mallory", op.environment || "sandbox",
          hasOwn(op, "now") ? op.now : 1.5);
        return [null, null, false];
      case "forge_record": {
        const h = P()[op.pkg || "initial"].artifact_hash;
        let rec = op.record;
        if (HX.util.is_plain_object(rec) && rec.artifact_hash === "$hash") rec = Object.assign({}, rec, { artifact_hash: h });
        const text = typeof rec === "string" ? rec : JSON.stringify(rec);
        raw_replace(e.store, "admission_reports", "artifact_hash", [h + "@" + (op.environment || "sandbox"), text,
          JSON.stringify(op.report || { report_digest: "d" })]);
        return [null, null, false];
      }
      case "sign_record": {
        const h = P()[op.pkg || "initial"].artifact_hash;
        const [key_id, key] = HX.registry.signing_key();
        const envn = op.environment || "sandbox";
        const rec = HX.pkg.sign_admission({ artifact_hash: h, environment: envn, approver: "mallory",
          admitted_at: "2026-01-01T00:00:00+00:00", validation_report_digest: "d", replay_archive_digest: "a", key_id }, key);
        raw_replace(e.store, "admission_reports", "artifact_hash", [h + "@" + envn, JSON.stringify(rec),
          JSON.stringify({ report_digest: op.report_digest || "d" })]);
        return [rec, null, false];
      }
      case "enroll":
        return [enc_adm(HX.registry.enroll_protected(e.store, op.skill || SKILL, [], { actor: p(op.as || "user:dana"),
          environment: op.environment || "sandbox", now: ctx.clock(), negative: !!op.negative })), null, true];
      case "export": {
        const ts = op.runs.map((r) => HX.traces.export_run_trace(svc, rid(r), p("user:alice"), op.verdict || "accepted"));
        ctx.traces[op.save] = ts;
        return [ts.map((t) => HX.traces.to_jsonl(t)), null, false];
      }
      case "enroll_traces": {
        const ts = [].concat(...op.traces.map((nm) => ctx.traces[nm]));
        return [enc_adm(HX.registry.enroll_protected(e.store, SKILL, ts, { actor: p(op.as || "user:dana"),
          environment: "sandbox", now: ctx.clock(), negative: !!op.negative })), null, true];
      }
      case "admit_archive": {
        const pick = (names) => [].concat(...(names || []).map((nm) => ctx.traces[nm]));
        return [enc_adm(HX.registry.admit(e.store, P()[op.pkg], e.catalog, {
          expected_parent_hash: op.parent ? P()[op.parent].artifact_hash : null, approver: p("user:dana"),
          environment: "sandbox", deployment_policy: HX.fixture.deployment_policy(), protected: pick(op.protected),
          negative: pick(op.negative), now: ctx.clock(), skill_text: HX.env.skill_source().text })), null, true];
      }
      case "approver_sod": {
        const d = e.policy.can_approve(p(op.approver), op.initiator, "acme", op.role || "");
        return [{ outcome: d.outcome, reasons: d.reasons }, null, false];
      }
      default: throw new Error("unknown op " + k);
    }
  }
  RT.do_op = do_op;

  let SCEN = null;
  RT.scenarios = function scenarios() {
    if (SCEN) return SCEN;
    SCEN = new Map();
    const idx = golden("runtime").index;
    for (const ent of idx) {
      if (!SCEN.has(ent.name)) {
        for (const sc of golden(ent.file).scenarios) SCEN.set(sc.name, sc);
      }
    }
    return SCEN;
  };

  /** Describe the first difference between two JSON values (for readable failures). */
  function first_diff(a, b, path) {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
      for (const k of keys) {
        const d = first_diff(a[k], b[k], path + "." + k);
        if (d) return d;
      }
      return null;
    }
    return path + ": JS " + JSON.stringify(a) + " vs Python " + JSON.stringify(b);
  }
  RT.first_diff = first_diff;

  /** Canonical comparison that ignores key order (golden JSON is written with sorted keys). */
  const canon = (v) => HX.canonical.canonical_text(v);

  /** Replay one scenario and compare every transcript entry with Python's. */
  RT.replay = function replay(name) {
    const sc = RT.scenarios().get(name);
    assert.ok(sc, "scenario " + name + " in golden");
    let n = 0, tbase = 0.0, tstep = 0.125;
    const ctx = { clock: new HX.env.ManualClock(CLOCK0), timer: () => tbase + tstep * ++n, ids: HX.env.make_seq_ids(1),
      set_timer: (base, step) => { tbase = base; tstep = step; },
      envs: {}, env: null, runs: {}, ix: {}, tokens: {}, side: [], paths: [], wdir: "/golden-runtime/" + name + "/",
      traces: { dev: [HX.traces.from_jsonl(golden("runtime").dev_trace)[0]] } };
    try {
      sc.ops.forEach((op, i) => {
        const want = sc.transcript[i];
        const got = {};
        let run, take;
        try {
          const [res, r, t] = do_op(ctx, op);
          const v = plain(res);
          if (hasOwn(want, "result_digest")) {
            got.result_digest = HX.canonical.digest(v);
            if (HX.util.is_plain_object(v) && hasOwn(v, "status")) got.status = v.status;
          } else got.result = v;
          run = r; take = t;
        } catch (exc) {
          got.error = enc_error(exc);
          run = op.run; take = true;
        }
        if (take && ctx.env !== null) {
          const sn = snap(ctx, run !== null && run !== undefined ? run : op.run);
          if (hasOwn(want, "snap_digest")) got.snap_digest = HX.canonical.digest(sn);
          else got.snap = sn;
        }
        if (canon(got) !== canon(want)) {
          const d = first_diff(got, want, "");
          assert.fail(name + " op " + i + " " + JSON.stringify(op) + ": " + d);
        }
      });
    } finally {
      for (const pth of ctx.paths) {
        HX.store.Store.reset_storage(pth + "/hexis.db");
        HX.fakes.FakeERP.reset_storage(pth + "/fake_erp.db");
      }
    }
  };

  RT.covered = RT.covered || new Set();
  RT.cover = function cover(names) {
    for (const nm of names) {
      RT.covered.add(nm);
      test("runtime scenario " + nm, () => RT.replay(nm));
    }
  };

  /* ---- broker-focused scenarios ------------------------------------------------------------------------- */
  RT.cover(["stale_lease_fencing", "stale_denial_ledger", "stale_worker_unknown_effect", "timeout_after_commit",
    "timeout_before_commit", "spoofed_connector", "business_unit_denied", "business_unit_in_args",
    "crash_after_intent", "crash_before_dispatch", "crash_after_remote_call", "crash_after_receipt", "crash_before_commit",
    "C14_crash_between_receipt_and_intent", "C14_dedup_repairs_intent", "C15_crash_after_verifier_receipt",
    "C15_lost_evidence_rederived"]);

  /* ---- unit vectors -------------------------------------------------------------------------------------- */
  test("broker: package variants hash like Python", () => {
    const g = golden("runtime").hashes;
    for (const [k, v] of Object.entries(RT.pkgs())) assert.equal(v.artifact_hash, g[k], k);
  });

  test("broker: FaultInjector, SimulatedCrash, BrokerResult, business units, args_digest", () => {
    const B = HX.broker;
    assert.deepEqual(Array.from(B.FaultInjector.POINTS), ["after_intent", "before_dispatch", "after_remote_call",
      "after_receipt", "before_commit"]);
    const f = new B.FaultInjector();
    f.arm("after_intent", "before_commit");
    f.hit("before_dispatch");
    assert.throws(() => f.hit("after_intent"), (e) => e instanceof B.SimulatedCrash && e.point === "after_intent" &&
      e instanceof HX.HXError && String(e) === "after_intent");
    f.hit("after_intent"); /* disarmed after firing */
    assert.throws(() => f.arm("nowhere"), (e) => e.code === "AssertionError");
    const r = new B.BrokerResult("DENIED");
    assert.deepEqual(plain(r), { status: "DENIED", output: null, reason: "", receipt_ref: "", certainty: "", evidence: [] });
    assert.deepEqual(Array.from(B._business_units_in({ a: [{ business_unit: "X" }, { business_unit: 3 }],
      business_unit: "Y", c: { d: { business_unit: "X" } } })).sort(), ["X", "Y"]);
    assert.equal(B.args_digest({ b: 1, a: [2] }), HX.canonical.digest({ a: [2], b: 1 }));
    assert.equal(HX.errors.ToolTimeout, HX.fakes.ToolTimeout);
    assert.equal(new HX.errors.ToolTimeout("x").message, "x");
  });

  test("broker: dispatch/reconcile require Python's keyword arguments", () => {
    const env = HX.env.build_env({ clock: new HX.env.ManualClock(CLOCK0), timer: () => 0, ids: HX.env.make_seq_ids(1) });
    assert.throws(() => env.broker.dispatch({ intent: {} }), (e) => e.code === "TypeError" && /missing 6 required/.test(e.message));
    assert.throws(() => env.broker.reconcile({ intent: {}, bogus: 1 }), (e) => e.code === "TypeError");
    const unknown = env.broker.dispatch({ intent: { tenant_id: "acme", logical_action_id: "l", tool: "nope" }, principal: null,
      package: null, business_unit: null, approval_check: () => [true, ""], lease_token: null, subject_values: {} });
    assert.deepEqual([unknown.status, unknown.reason], ["DENIED", "UNKNOWN_TOOL"]);
    const nr = env.broker.reconcile({ intent: { tenant_id: "acme", logical_action_id: "l", tool: "nope", idempotency_key: "k" },
      principal: null, package: null, business_unit: null, approval_check: () => [true, ""], lease_token: null, subject_values: {} });
    assert.equal(nr.status, "NEEDS_RESOLUTION");
    assert.equal(nr.reason, "tool nope is not in the current catalog; cannot reconcile automatically");
  });

  test("broker: SimulatedCrash escapes connector timing and is recorded as outcome 'error'", () => {
    const env = HX.env.build_env({ clock: new HX.env.ManualClock(CLOCK0), timer: () => 1.5, ids: HX.env.make_seq_ids(1) });
    const spec = HX.catalog.get(env.catalog, "documents.read");
    assert.throws(() => env.broker._timed(spec, "dispatch", 1, () => { throw new HX.broker.SimulatedCrash("p"); }),
      (e) => e instanceof HX.broker.SimulatedCrash);
    assert.throws(() => env.broker._timed(spec, "dispatch", 2, () => { throw new HX.errors.ToolTimeout("t"); }));
    assert.throws(() => env.broker._timed(spec, "dispatch", 3, () => { throw new HX.errors.ToolFailure("f"); }));
    assert.deepEqual(env.broker.take_timings().map((t) => [t.op, t.attempt, t.outcome, t.latency_s]),
      [["dispatch", 1, "error", 0], ["dispatch", 2, "timeout", 0], ["dispatch", 3, "failure", 0]]);
    assert.deepEqual(env.broker.take_timings(), []);
  });
})();
