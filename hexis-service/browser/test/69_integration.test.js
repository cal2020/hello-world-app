/* Cross-module parity (wave 4): HX.env + HX.service runs exported with HX.traces.export_run_trace, replayed with
 * HX.replay, refined with HX.update and admitted / enrolled with HX.registry, composed exactly as the Python
 * reference composes them (golden/update_integration.json from golden/gen_update.py). The scenario interpreter is
 * the runtime one (test/50_broker.test.js, globalThis.RT_RUNTIME) extended with the update/admission operations of
 * gen_update.py's ``do_upd``. Every result, error and snapshot must equal Python's. */
(function () {
  const RT = globalThis.RT_RUNTIME;
  const U = globalThis.UPD;
  const SKILL = "supplier-onboarding-draft";
  const CLOCK0 = 1790000000.25;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

  /** gen_runtime.snap (the same snapshot the runtime scenarios compare). */
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

  const pkg_of = (ctx, name) => (hasOwn(ctx.cands, name) ? ctx.cands[name] : RT.pkgs()[name]);
  const traces_of = (ctx, names) => [].concat(...(names || []).map((n) => ctx.traces[n]));

  function do_upd(ctx, op) {
    const e = ctx.env;
    const p = (who) => e.principal(who);
    const skill_text = HX.env.skill_source().text;
    switch (op.op) {
      case "ref_traces": {
        const R = HX.reference;
        Object.assign(ctx.traces, { missing: [R.missing_docs_trace()], shortcut: [R.shortcut_trace()],
          forbidden: [R.forbidden_write_trace()], duplicate: [R.duplicate_write_trace()] });
        return [["missing", "shortcut", "forbidden", "duplicate"].map((n) => HX.traces.to_jsonl(ctx.traces[n][0])), null, false];
      }
      case "candidate": {
        const parent = pkg_of(ctx, op.parent);
        const al = new U.ALIGNERS[op.aligner]();
        let cand = HX.update.apply_ops(parent, al.propose(U.fake_context(parent)), hasOwn(op, "trace_ids") ? op.trace_ids : null);
        if (hasOwn(op, "policy")) {
          const d = HX.traces._clone(HX.pkg.to_json(cand));
          d.execution_policy = Object.assign({}, d.execution_policy, op.policy);
          d.artifact_hash = "";
          cand = HX.pkg.sealed(d);
        }
        ctx.cands[op.name] = cand;
        return [{ hash: cand.artifact_hash, lineage: cand.lineage }, null, false];
      }
      case "propose": {
        const t = ctx.traces[op.trace][op.index || 0];
        const prop = HX.update.propose_update(pkg_of(ctx, op.parent), t, traces_of(ctx, op.protected),
          traces_of(ctx, op.negative), e.catalog, new U.ALIGNERS[op.aligner](),
          (hasOwn(op, "skill_text") ? op.skill_text : true) ? skill_text : null);
        if (prop.candidate !== null && hasOwn(op, "save")) ctx.cands[op.save] = prop.candidate;
        return [prop.to_json(), null, false];
      }
      case "evaluate":
        return [HX.update.evaluate_candidate(pkg_of(ctx, op.parent), pkg_of(ctx, op.cand), ctx.traces[op.trace][0],
          traces_of(ctx, op.protected), traces_of(ctx, op.negative), e.catalog, skill_text), null, false];
      case "admit_cand": {
        const kw = { expected_parent_hash: op.parent ? pkg_of(ctx, op.parent).artifact_hash : null,
          approver: p(op.as || "user:dana"), environment: "sandbox", deployment_policy: HX.fixture.deployment_policy(),
          protected: traces_of(ctx, op.protected), negative: traces_of(ctx, op.negative), now: ctx.clock(), skill_text };
        if (hasOwn(op, "manifest")) kw.archive_manifest = HX.update.archive_manifest(traces_of(ctx, op.manifest[0]), traces_of(ctx, op.manifest[1]));
        const a = HX.registry.admit(e.store, pkg_of(ctx, op.pkg), e.catalog, kw);
        return [{ status: a.status, artifact_hash: a.artifact_hash, reasons: a.reasons, record: a.record,
          archive_version: a.archive_version }, null, true];
      }
      case "start_cand": {
        const h = e.service.start_run(pkg_of(ctx, op.pkg).artifact_hash, HX.env.task(op.task), p(op.as || "user:alice"), "");
        ctx.runs[op.run] = h.run_id;
        return [{ run_id: h.run_id, tenant_id: h.tenant_id, artifact_hash: h.artifact_hash, status: h.status,
          revision: h.revision }, op.run, true];
      }
      case "replay_saved":
        return [ctx.traces[op.traces].map((t) => HX.replay.replay(pkg_of(ctx, op.pkg), t, op.mode).to_json()), null, false];
      case "manifest": {
        const pr = traces_of(ctx, op.protected), ng = traces_of(ctx, op.negative);
        return [{ manifest: HX.update.archive_manifest(pr, ng), digest: HX.update.manifest_digest(pr, ng) }, null, false];
      }
      default:
        return RT.do_op(ctx, op);
    }
  }

  function run(sc) {
    let n = 0, tbase = 0.0, tstep = 0.125;
    const ctx = { clock: new HX.env.ManualClock(CLOCK0), timer: () => tbase + tstep * ++n, ids: HX.env.make_seq_ids(1),
      set_timer: (base, step) => { tbase = base; tstep = step; },
      envs: {}, env: null, runs: {}, ix: {}, tokens: {}, side: [], paths: [], wdir: "/golden-update/" + sc.name + "/",
      traces: { dev: [HX.reference.missing_docs_trace()] }, cands: {} };
    const counts = {};
    try {
      sc.ops.forEach((op, i) => {
        const want = sc.transcript[i];
        const got = {};
        let rn, take;
        try {
          const [res, r, t] = do_upd(ctx, op);
          got.result = plain(res);
          rn = r; take = t;
        } catch (exc) {
          got.error = RT.enc_error(exc);
          rn = op.run; take = true;
        }
        if (take && ctx.env !== null) {
          const sn = snap(ctx, rn !== null && rn !== undefined ? rn : op.run);
          if (hasOwn(want, "snap_digest")) got.snap_digest = HX.canonical.digest(sn);
          else got.snap = sn;
        }
        U.same(got, want, sc.name + " op " + i + " " + JSON.stringify(op));
        counts[op.op] = (counts[op.op] || 0) + 1;
      });
    } finally {
      for (const pth of ctx.paths) {
        HX.store.Store.reset_storage(pth + "/hexis.db");
        HX.fakes.FakeERP.reset_storage(pth + "/fake_erp.db");
      }
    }
    return { ctx, counts };
  }

  /* r1 approved, r2 registry conflict, r3 repairs exhausted, r4 invalid outputs (fallback), r5 model unavailable,
     r6 missing documents on the refined package, r7 waiting for approval, r8 second miss, r9 timeout after commit */
  const TERMINALS = ["END_VERIFIED_DRAFT", "END_REVIEW", "END_UNVERIFIED", "END_REVIEW", "END_REVIEW",
    "END_VERIFIED_DRAFT", null, "END_UNVERIFIED", "END_VERIFIED_DRAFT"];
  const SCEN = () => new Map(golden("update_integration").scenarios.map((s) => [s.name, s]));

  test("integration: terminal runs exported by HX.traces.export_run_trace are byte-identical to Python's", () => {
    const sc = SCEN().get("int_exports");
    const { ctx, counts } = run(sc);
    assert.equal(counts.export, 3);
    /* the exported texts are part of the transcript; check the terminal outcomes they cover */
    const term = ctx.traces.all.map((t) => {
      const last = t.records[t.records.length - 1];
      return last && last.action.kind === "end" ? last.action.terminal : null;
    });
    assert.deepEqual(term, TERMINALS);
    for (const t of ctx.traces.all) assert.deepEqual(HX.traces.integrity_errors(t), []);
  });

  test("integration: the demo narrative (protected runs, refinement, admission, live refined run, shortcut, enrolment)", () => {
    const { ctx, counts } = run(SCEN().get("int_demo"));
    assert.ok(counts.admit_cand === 2 && counts.enroll_traces >= 9 && counts.propose === 3);
    /* the demo's protected traces are the ones the update golden was generated with */
    assert.deepEqual(ctx.traces.prot.map((t) => HX.traces.to_jsonl(t)), golden("update").protected_jsonl);
    assert.equal(ctx.cands.refined_p.artifact_hash, HX.data.python_build.refined_artifact_hash);
  });

  test("integration: admission with non-empty archives (breaking, widening, stale parent CAS, legitimate) and enrolment", () => {
    const { counts } = run(SCEN().get("int_admit"));
    assert.ok(counts.admit_cand >= 12 && counts.candidate >= 5);
    const tr = SCEN().get("int_admit").transcript;
    const statuses = SCEN().get("int_admit").ops.map((op, i) => (op.op === "admit_cand" ? tr[i].result.status : null)).filter((s) => s);
    assert.ok(statuses.includes("ADMITTED") && statuses.includes("CONFLICT") && statuses.includes("REJECTED"));
  });

  test("integration: every scenario in the golden file is covered", () => {
    assert.deepEqual(Array.from(SCEN().keys()).sort(), ["int_admit", "int_demo", "int_exports"]);
  });
})();
