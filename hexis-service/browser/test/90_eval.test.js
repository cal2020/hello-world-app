/* Parity of HX.eval (src/90_eval.js) with evals/run_eval.py (golden/eval.json from gen_eval.py): run_eval's result
 * (minus ``environment``) and report.md lines for the held-out task set and 8 variants (overlap-free, overlap-only,
 * reversed, binary-tie ratios, 4 seeded random task sets including one that crashes in run_task), plus dev_overlap
 * and summarize unit vectors. Setup as in the golden: ManualClock(1790000000.25), timer 0.125*n, seq ids. */
(function () {
  const G = () => golden("eval");
  const strip_env = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.environment; return c; };

  function run(tasks) {
    let n = 0, idn = 0;
    const seq = HX.env.make_seq_ids(1);
    const res = HX.eval.run_eval({ tasks, timer: () => 0.125 * ++n, ids: () => { idn++; return seq(); } });
    return { res, timer_calls: n, ids_used: idn };
  }
  const exc = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e }; } };

  for (const name of ["heldout", "no_overlap", "only_overlap", "reversed", "eighths", "random_5101", "random_5102",
    "random_5103", "random_5104"]) {
    test("eval: run_eval + report_markdown equal Python's for task set " + name, () => {
      const want = G().runs.find((r) => r.name === name);
      assert.ok(want, "golden variant " + name);
      const tasks = HX.canonical.strict_loads(want.tasks_json);
      const t0 = performance.now();
      const got = exc(() => run(tasks));
      const ms = performance.now() - t0;
      if (want.result === null) {
        /* main() raised inside the evaluation (before results.json) */
        assert.ok(got.error, "Python raised " + want.error);
        assert.equal(got.error.code, want.error[0]);
        assert.equal(got.error.message, want.error[1]);
        return;
      }
      assert.ok(!got.error, got.error && got.error.stack);
      const { res, timer_calls, ids_used } = got.value;
      assert.deepEqual(res.environment, { runtime: "browser", engine: HX.VERSION });
      assert.deepEqual(strip_env(res), want.result);
      assert.equal(timer_calls, want.timer_calls, "timer draws");
      assert.equal(ids_used, want.ids_used, "id draws");
      /* report: with Python's environment (fixed commit) the text is identical, line for line */
      const py_like = Object.assign({}, res, { environment: { git_commit: G().commit } });
      if (want.error) {
        /* main() wrote results.json, then the report crashed (no strictly held-out tasks) */
        assert.equal(want.report, null);
        const e = exc(() => HX.eval.report_markdown(py_like)).error;
        assert.ok(e && e.code === want.error[0] && e.message === want.error[1], "report error " + (e && e.message));
        return;
      }
      assert.deepEqual(HX.eval.report_markdown(py_like).split("\n"), want.report);
      /* browser result: only the commit line differs */
      const mine = HX.eval.report_markdown(res).split("\n");
      assert.equal(mine.length, want.report.length);
      mine.forEach((l, i) => {
        if (i === 2) {
          assert.equal(l, want.report[i].replace("Commit `" + G().commit.slice(0, 12) + "`", "Engine `" + HX.VERSION + "`"));
        } else assert.equal(l, want.report[i], "report line " + i);
      });
      if (name === "heldout") {
        assert.ok(ms < 3000, "run_eval took " + Math.round(ms) + " ms");
        globalThis.HX_DEMO_TIMINGS = Object.assign(globalThis.HX_DEMO_TIMINGS || {}, { run_eval_ms: Math.round(ms) });
      }
    });
  }

  test("eval: run_eval() defaults to HX.data.heldout_tasks and its task_set_digest equals Python's", () => {
    const want = G().runs.find((r) => r.name === "heldout");
    assert.deepEqual(HX.data.heldout_tasks, G().heldout);
    const res = HX.eval.run_eval({ timer: () => 0 });
    assert.equal(res.task_set_digest, want.result.task_set_digest);
    assert.equal(res.artifacts.initial, HX.data.python_build.initial_artifact_hash);
    assert.equal(res.artifacts.refined, HX.data.python_build.refined_artifact_hash);
    /* rows do not depend on ids or timer */
    assert.deepEqual(strip_env(res), want.result);
    assert.deepEqual(strip_env(HX.eval.run_eval({ tasks: HX.data.heldout_tasks.tasks, timer: () => 0 })), want.result);
  });

  test("eval: dev_overlap equals Python's on 212 vectors (4 development traces, curated and random tasks)", () => {
    const R = HX.reference;
    const devs = { missing: R.missing_docs_trace(), shortcut: R.shortcut_trace(), forbidden: R.forbidden_write_trace(),
      duplicate: R.duplicate_write_trace() };
    const vs = G().dev_overlap;
    assert.equal(vs.length, 212);
    let errors = 0, hits = 0;
    for (const v of vs) {
      const got = exc(() => HX.eval.dev_overlap(v.task, devs[v.dev]));
      if (v.error) {
        errors++;
        assert.ok(got.error, JSON.stringify(v));
        assert.equal(got.error.code, v.error[0]);
        assert.equal(got.error.message, v.error[1]);
      } else {
        assert.ok(!got.error, JSON.stringify(v) + " " + (got.error && got.error.message));
        assert.deepEqual(got.value, v.value, JSON.stringify(v));
        if (v.value.length) hits++;
      }
    }
    assert.ok(errors > 0 && hits > 5);
  });

  test("eval: summarize equals Python's (98 row sets incl. the empty one and mixed int/float steps)", () => {
    const vs = G().summarize;
    assert.equal(vs.length, 98);
    for (const v of vs) assert.deepEqual(HX.eval.summarize(v.rows), v.value, JSON.stringify(v.rows.map((r) => r.steps)));
    /* the follow-up repro: Python sum([26, 0.1, 0.1, -3]) = 23.200000000000003 (int items are not compensated) */
    assert.equal(HX.eval._py_sum([26, 0.1, 0.1, -3]), 23.200000000000003);
    assert.equal(HX.eval._py_sum([0.1, 0.1, 0.1]), 0.30000000000000004);
    assert.equal(HX.eval._py_sum([1, 2, true]), 4);
    assert.deepEqual(HX.eval.summarize([]), { tasks: 0 });
  });

  test("eval: fmt2 is Python's .2f (half-even on exact binary ties) and the ratio metrics are fixed", () => {
    const F = HX.eval.fmt2;
    const cases = [[0.125, "0.12"], [0.375, "0.38"], [0.625, "0.62"], [0.875, "0.88"], [4.625, "4.62"], [7.875, "7.88"],
      [8.125, "8.12"], [1, "1.00"], [0, "0.00"], [-0.125, "-0.12"], [-0, "-0.00"], [6 / 7, "0.86"], [1 / 7, "0.14"],
      [45 / 7, "6.43"], [0.005, "0.01"], [0.015, "0.01"], [2.675, "2.67"], [1e22, "10000000000000000000000.00"],
      [true, "1.00"]];
    for (const [v, s] of cases) assert.equal(F(v), s, String(v));
    assert.deepEqual(Array.from(HX.eval.RATIO_METRICS), ["business_success", "procedural_conformance", "terminal_honesty",
      "fallback_rate", "failure_fallback_rate", "mean_steps"]);
  });

  test("eval: documented deviation: non-str task ids are refused (Python accepts any hashable id)", () => {
    const t = JSON.parse(JSON.stringify(HX.data.heldout_tasks.tasks[0]));
    t.id = 7;
    assert.throws(() => HX.eval.run_eval({ tasks: [t] }), (e) => e instanceof HX.HXError && e.code === "TypeError");
  });
})();
