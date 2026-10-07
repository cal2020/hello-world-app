/* Parity of HX.demo (src/80_demo.js) with demo/procurement_demo.py::run_demo (golden/demo.json from gen_demo.py):
 * per scenario, the say lines grouped by step heading, the summary, every written file, and the number of timer and
 * id draws must equal Python's. Setup as in the golden: ManualClock(1790000000.25), timer 0.125*n, seq ids. */
(function () {
  const G = () => golden("demo");
  const DONE_RE = /^== done\. Artifacts in <OUT>\/ ==$/;
  const HEAD_RE = /^== (\d\w*)\. /;

  function make(scenario) {
    let n = 0, idn = 0;
    const seq = HX.env.make_seq_ids(1);
    const d = HX.demo.create({ scenario, timer: () => 0.125 * ++n, ids: () => { idn++; return seq(); } });
    return { d, timer_calls: () => n, ids_used: () => idn };
  }

  /** Python's grouping (gen_demo.group): a step without a heading line joins the previous group. */
  function group(results) {
    const out = [];
    for (const r of results) {
      const m = r.lines.length ? HEAD_RE.exec(r.lines[0]) : null;
      if (m || !out.length) out.push({ id: m ? m[1] : null, lines: [] });
      out[out.length - 1].lines.push(...r.lines);
    }
    return out;
  }
  const norm_py = (lines) => lines.map((l) => (DONE_RE.test(l) ? "== done ==" : l));

  function check_files(got, want, label) {
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), label + ": file names");
    for (const k of Object.keys(want)) {
      if (typeof want[k] === "string") assert.equal(got[k], want[k], label + ": " + k);
      else assert.deepEqual(got[k], want[k], label + ": " + k);
    }
  }

  for (const sc of ["full", "timeout-after-commit", "no-fault"]) {
    test("demo: scenario " + sc + " step lines, summary, artifacts, timer/id draws equal Python's", () => {
      const want = G().scenarios.find((s) => s.scenario === sc);
      assert.ok(want, "golden scenario " + sc);
      const { d, timer_calls, ids_used } = make(sc);
      assert.deepEqual(d.steps.map((s) => s.id), ["1", "2", "3", "4", "5", "6a", "6b"]);
      assert.equal(d.done, false);
      const results = [];
      while (!d.done) {
        const r = d.next();
        assert.equal(r.id, d.steps[results.length].id);
        assert.equal(r.title, d.steps[results.length].title);
        results.push(r);
      }
      assert.throws(() => d.next(), (e) => e instanceof HX.HXError && e.code === "StopIteration");
      /* lines grouped by heading */
      const py_groups = want.steps.map((g) => ({ id: g.id, lines: norm_py(g.lines) }));
      assert.deepEqual(group(results), py_groups);
      assert.deepEqual(d.lines, norm_py(want.lines));
      /* headings: the step's own heading starts its lines (step 4 has none without a fault) */
      for (const r of results) {
        const m = r.lines.length ? HEAD_RE.exec(r.lines[0]) : null;
        if (r.id === "4" && sc === "no-fault") assert.equal(m, null);
        else assert.equal(m && m[1], r.id, "heading of step " + r.id);
      }
      /* summary (returned and as summary.json), artifacts */
      assert.deepEqual(JSON.parse(JSON.stringify(d.summary)), want.summary);
      check_files(d.artifacts, want.files, sc);
      const per_step = {};
      for (const r of results) for (const k of Object.keys(r.artifacts)) {
        assert.ok(!(k in per_step), "each file is written by one step: " + k);
        per_step[k] = r.artifacts[k];
      }
      check_files(per_step, want.files, sc + " (per step)");
      assert.equal(timer_calls(), want.timer_calls, "timer draws");
      assert.equal(ids_used(), want.ids_used, "id draws");
      /* ctx and facts the UI reads */
      assert.equal(d.ctx.pkg.artifact_hash, HX.data.python_build.initial_artifact_hash);
      assert.equal(d.ctx.refined.artifact_hash, HX.data.python_build.refined_artifact_hash);
      assert.equal(results[0].facts.admission, "ADMITTED");
      assert.equal(results[3].facts.fault_injected, sc !== "no-fault");
      assert.deepEqual(results[3].facts.reconciliation_events, want.summary.steps.run.reconciliation_events);
      assert.equal(results[6].facts.active_unchanged, true);
      assert.deepEqual(results[6].facts.violations.map((v) => v.path[v.path.length - 1]), ["PERSIST_DRAFT", "REQUEST_APPROVAL"]);
    });
  }

  test("demo: run_all() and HX.demo.run_demo() give the same result and finish in under 3 s", () => {
    const want = G().scenarios.find((s) => s.scenario === "full");
    const { d } = make("full");
    const t0 = performance.now();
    const summary = d.run_all();
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, "run_all took " + Math.round(ms) + " ms");
    globalThis.HX_DEMO_TIMINGS = Object.assign(globalThis.HX_DEMO_TIMINGS || {}, { run_all_ms: Math.round(ms) });
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), want.summary);
    assert.equal(d.done, true);
    assert.equal(d.results.length, 7);
    let n = 0;
    const seen = [];
    const one = HX.demo.run_demo({ scenario: "full", timer: () => 0.125 * ++n, ids: HX.env.make_seq_ids(1),
      say: (l) => seen.push(l) });
    assert.deepEqual(JSON.parse(JSON.stringify(one.summary)), want.summary);
    assert.deepEqual(one.lines, seen);
    assert.deepEqual(one.lines, d.lines);
    check_files(one.artifacts, want.files, "run_demo");
  });

  test("demo: documented deviation #5: step 3 narrates Python-class refusals; native errors and SimulatedCrash propagate", () => {
    function at_step3(thrower) {
      const { d } = make("full");
      d.next(); d.next();
      const env = d.ctx.env;
      const restart = env.restart.bind(env);
      env.restart = (m) => {
        const e2 = restart(m);
        const real = e2.service.resume_interaction.bind(e2.service);
        let first = true;
        e2.service.resume_interaction = (...a) => {
          if (first) { first = false; throw thrower(); }
          return real(...a);
        };
        return e2;
      };
      return d;
    }
    const d1 = at_step3(() => new HX.service.RunError("NOT_AUTHORIZED", "nope"));
    const r = d1.next();
    assert.equal(r.lines[1], "   initiator self-approval refused: NOT_AUTHORIZED: nope");
    assert.equal(d1.ctx.summary.steps.self_approval.detail, "NOT_AUTHORIZED: nope");
    assert.throws(() => at_step3(() => new TypeError("bug")).next(), (e) => e instanceof TypeError && !(e instanceof HX.HXError));
    assert.throws(() => at_step3(() => new HX.broker.SimulatedCrash("p")).next(), (e) => e instanceof HX.broker.SimulatedCrash);
  });

  test("demo: artifacts are snapshots, and two demos in one realm do not share state", () => {
    const a = make("full").d, b = make("no-fault").d;
    a.next(); b.next(); a.next(); b.next();
    assert.notEqual(a.ctx.env.store, b.ctx.env.store);
    a.run_all(); b.run_all();
    assert.deepEqual(a.summary.steps.run.reconciliation_events, ["EFFECT_UNKNOWN", "RECONCILED"]);
    assert.deepEqual(b.summary.steps.run.reconciliation_events, []);
    a.artifacts["summary.json"].mode = "changed";
    assert.equal(a.summary.mode, "fixture");
  });
})();
