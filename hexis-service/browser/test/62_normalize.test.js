/* Parity of HX.normalize with traces/normalize.py (golden/traces*.json from gen_traces.py). */
(function () {
  const N = HX.normalize;
  const H = () => globalThis.TRACES_GOLDEN;

  test("normalize: constants", () => {
    assert.equal(N.NORMALIZER_VERSION, H().main().versions.normalizer);
    assert.deepEqual(N.NOISE_KINDS.slice(), ["noop", "heartbeat", "log", "orchestration"]);
  });

  test("normalize: every vector - events, dropped records, eligibility and first_step against each package", () => {
    const P = H().packages();
    let n = 0, el = 0;
    for (const v of H().vectors()) {
      if (v.js_deviation || v.load.exc !== undefined) continue;
      const label = v.name + (v.note ? " [" + v.note + "]" : "");
      const [t] = H().load(v);
      const r = H().run(() => N.normalize(t));
      if (v.normalize.exc !== undefined) H().same_exc(r, v.normalize, label + " normalize");
      else {
        assert.ok(r.ok, label + " normalize raised " + JSON.stringify(r));
        const [events, dropped] = r.ok;
        assert.equal(events.length, v.normalize.n, label + " event count");
        H().check_pack(events, v.normalize.events, label + " events");
        assert.deepEqual(JSON.parse(JSON.stringify(dropped)), v.normalize.dropped, label + " dropped");
      }
      for (const pk of Object.keys(v.pkgs)) {
        const want = v.pkgs[pk];
        const got = H().run(() => N.eligibility(t, P[pk]));
        if (want.eligibility.exc !== undefined) H().same_exc(got, want.eligibility, label + " eligibility@" + pk);
        else {
          assert.ok(got.ok, label + " eligibility@" + pk + " raised " + JSON.stringify(got));
          assert.ok(HX.util.deep_equal(JSON.parse(JSON.stringify(got.ok)), want.eligibility.ok),
            label + " eligibility@" + pk + "\nJS:     " + JSON.stringify(got.ok) + "\nPython: " + JSON.stringify(want.eligibility.ok));
          assert.equal(N.first_step(got.ok), want.first_step, label + " first_step@" + pk);
          el++;
        }
      }
      n++;
    }
    assert.ok(n > 550 && el > 1000, "vectors " + n + ", eligibility checks " + el);
  });

  test("normalize: A16 distinct writes never merge; one logical operation merges and keeps both records", () => {
    const g = H().main();
    const [t] = HX.traces.from_jsonl(g.bases.duplicate_write.jsonl);
    const writes = N.normalize(t)[0].filter((e) => e.tool === "erp.create_draft");
    assert.equal(writes.length, 2);
    const t2 = HX.traces.model_copy(t, { deep: true });
    t2.records[1].meta.logical_action_id = t2.records[0].meta.logical_action_id;
    t2.records[1].action.input = t2.records[0].action.input;
    const merged = N.normalize(HX.traces.seal(t2))[0].filter((e) => e.tool === "erp.create_draft");
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].source_steps, [0, 1]);
  });
})();
