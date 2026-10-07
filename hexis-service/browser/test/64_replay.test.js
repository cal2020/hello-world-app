/* Parity of HX.replay with replay/replay.py (golden/traces*.json from gen_traces.py). */
(function () {
  const RP = HX.replay;
  const H = () => globalThis.TRACES_GOLDEN;
  const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  /* Details that embed python-jsonschema texts (kernel TASK_INPUT_INVALID / OUTPUT_SCHEMA, deviations/kernel.md)
     are compared up to the jsonschema text; everything else is exact. */
  const SCHEMA_DETAIL = /^(cannot reconstruct initial variables: |(?:TASK_INPUT_INVALID|OUTPUT_SCHEMA): )/;
  function check_detail(got, want, label) {
    const m = SCHEMA_DETAIL.exec(want);
    if (m && !/^cannot reconstruct initial variables: (loop counter|initial checkpoint variables)/.test(want)) {
      assert.ok(got.startsWith(m[1]), label + " detail\nJS:     " + got + "\nPython: " + want);
      if (m[1].startsWith("cannot")) assert.ok(/(^|; )(<root>|[^ ]+): /.test(got.slice(m[1].length)), label + " jsonschema text: " + got);
      if (/^OUTPUT_SCHEMA/.test(m[1])) assert.equal(got.split(" fails its schema")[0], want.split(" fails its schema")[0], label + " variable");
      return;
    }
    assert.equal(got, want, label + " detail");
  }

  function check_report(got, want, label) {
    const j = got.to_json();
    check_detail(j.detail, want.detail, label);
    for (const k of ["mode", "trace_id", "artifact_hash", "status", "placeholders", "versions"]) {
      assert.ok(HX.util.deep_equal(JSON.parse(JSON.stringify(j[k])), want[k]),
        label + " " + k + "\nJS:     " + JSON.stringify(j[k]) + "\nPython: " + JSON.stringify(want[k]));
    }
    H().check_pack(j.path, want.path, label + " path");
    H().check_pack(j.divergence, want.divergence, label + " divergence");
  }

  test("replay: constants", () => {
    const v = H().main().versions;
    assert.equal(RP.REPLAY_VERSION, v.replay);
    assert.equal(RP.MAX_NODES, v.max_nodes);
  });

  test("replay: every vector - structural and recorded reports against each package", () => {
    const P = H().packages();
    let n = 0;
    for (const v of H().vectors()) {
      if (v.js_deviation || v.load.exc !== undefined) continue;
      const label = v.name + (v.note ? " [" + v.note + "]" : "");
      const [t] = H().load(v);
      for (const pk of Object.keys(v.pkgs)) {
        for (const mode of ["structural", "recorded"]) {
          const want = v.pkgs[pk][mode];
          const got = H().run(() => RP.replay(P[pk], t, mode));
          if (want.exc !== undefined) H().same_exc(got, want, label + " " + mode + "@" + pk);
          else {
            assert.ok(got.ok, label + " " + mode + "@" + pk + " raised " + JSON.stringify(got));
            check_report(got.ok, want.ok, label + " " + mode + "@" + pk);
          }
          n++;
        }
      }
    }
    assert.ok(n > 2500, "replays " + n);
  });

  test("replay: on_step sees every step; a network call from on_step is an ERROR and globals are restored", () => {
    const g = H().main();
    const P = H().packages();
    const [t] = HX.traces.from_jsonl(g.bases.happy.jsonl);
    const calls = [];
    const rep = RP.replay(P.initial, t, "recorded", { on_step: (cp, obs) => calls.push([cp.state_id, cp.revision, obs.state_id, obs.kind]) });
    assert.deepEqual(calls, g.on_step.calls);
    check_report(rep, g.on_step.report, "on_step");
    const saved = globalThis.fetch;
    const rogue = RP.replay(P.initial, t, "recorded", { on_step: () => { globalThis.fetch("https://example.com/"); } });
    check_report(rogue, g.rogue, "rogue fetch");
    assert.equal(globalThis.fetch, saved, "fetch restored");
    /* every replaced API throws inside, and is restored afterwards (also when fn throws) */
    const fakes = {};
    const names = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];
    const before = {};
    for (const k of names) before[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    for (const k of names) if (!before[k]) { fakes[k] = function () { return "net"; }; globalThis[k] = fakes[k]; }
    const nav_before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    if (!nav_before) globalThis.navigator = {};
    const nav = globalThis.navigator;
    const had_beacon = Object.prototype.hasOwnProperty.call(nav, "sendBeacon");
    if (typeof nav.sendBeacon === "undefined") nav.sendBeacon = () => true;
    try {
      RP.no_external_calls(() => {
        for (const k of names) {
          assert.throws(() => globalThis[k]("x"), RP.ExternalCallAttempted, k);
          assert.throws(() => new globalThis[k]("x"), RP.ExternalCallAttempted, "new " + k);
        }
        assert.throws(() => globalThis.navigator.sendBeacon("x"), RP.ExternalCallAttempted, "sendBeacon");
      });
      assert.throws(() => RP.no_external_calls(() => { throw new Error("boom"); }), /boom/);
      for (const k of names) {
        if (fakes[k]) assert.equal(globalThis[k], fakes[k], k + " restored");
        else assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, k), before[k], k + " restored");
      }
      assert.equal(typeof globalThis.navigator.sendBeacon, "function");
      assert.equal(globalThis.navigator.sendBeacon("x"), true);
    } finally {
      for (const k of Object.keys(fakes)) delete globalThis[k];
      if (!had_beacon) delete nav.sendBeacon;
      if (!nav_before) delete globalThis.navigator;
    }
  });

  test("replay: unsupported modes raise ValueError; unknown keywords raise TypeError", () => {
    const g = H().main();
    const P = H().packages();
    const [t] = HX.traces.from_jsonl(g.bases.happy.jsonl);
    for (const m of Object.keys(g.mode_errors)) {
      H().same_exc(H().run(() => RP.replay(P.initial, t, m)), g.mode_errors[m], "mode " + m);
    }
    assert.equal(H().run(() => RP.replay(P.initial, t, "recorded", { bogus: 1 })).exc, "TypeError");
  });

  test("replay: A30 recorded replay is reproducible; A12 placeholders are never evidence", () => {
    const g = H().main();
    const P = H().packages();
    const [t] = HX.traces.from_jsonl(g.bases.happy.jsonl);
    const reps = [0, 1, 2].map(() => JSON.stringify(RP.replay(P.initial, t, "recorded").to_json()));
    assert.equal(reps[0], reps[1]);
    assert.equal(reps[1], reps[2]);
    const s = RP.replay(P.initial, t, "structural");
    assert.equal(s.status, "PASS");
    assert.deepEqual(Array.from(new Set(s.placeholders.map((p) => p.state))).sort(), ["EXTRACT_DRAFT", "REPAIR_DRAFT"]);
    assert.ok(!("evidence" in s.to_json()));
  });

  test("replay/traces deviation: str()/repr() of a dict with integer-like keys raises KEY_ORDER_UNKNOWN", () => {
    const T = HX.traces, N = HX.normalize;
    const g = H().main();
    const P = H().packages();
    assert.ok(g.key_order.length >= 5);
    const KO = "KEY_ORDER_UNKNOWN";
    for (const v of g.key_order) {
      const py = v.python;
      assert.deepEqual(py.errors, [], v.name + ": Python loads it intact");
      const loaded = H().run(() => T.from_jsonl(v.text));
      if (v.where === "from_jsonl") {
        /* Python derives trace_id = str(task_id) (insertion order); JS refuses instead of hashing another text */
        assert.equal(loaded.exc, KO, v.name + " from_jsonl " + JSON.stringify(loaded));
        /* with Python's derived trace_id stored in the header, the same text loads in JS with Python's digests
           (task_id itself is order-free data) */
        const lines = v.text.split("\n");
        const head = JSON.parse(lines[0]);
        head.hexis_service.trace_id = py.trace_id;
        const [t2, errs2] = T.from_jsonl([JSON.stringify(head)].concat(lines.slice(1)).join("\n"));
        assert.equal(t2.trace_id, py.trace_id);
        assert.deepEqual(errs2, [], v.name + " integrity with the stored trace_id");
        assert.equal(T.header_digest(t2), py.header_digest, v.name + " header_digest");
        continue;
      }
      assert.ok(loaded.ok, v.name + " " + JSON.stringify(loaded));
      const [t, errs] = loaded.ok;
      assert.deepEqual(errs, py.errors, v.name + " integrity");
      assert.equal(T.header_digest(t), py.header_digest, v.name + " header_digest");
      assert.ok(py.normalize.ok, v.name + ": Python normalizes it");
      assert.equal(H().run(() => N.normalize(t)).exc, KO, v.name + " normalize");
      const el = H().run(() => N.eligibility(t, P.mini_branch));
      if (el.exc !== undefined) assert.equal(el.exc, KO, v.name + " eligibility");
      else assert.deepEqual(plain(el.ok), py.eligibility.ok, v.name + " eligibility");
      for (const pk of Object.keys(py.replays)) {
        for (const m of ["structural", "recorded"]) {
          const want = py.replays[pk][m];
          assert.ok(want.ok, v.name + ": Python reports " + m);
          const got = H().run(() => RP.replay(P[pk], t, m));
          if (got.exc !== undefined) assert.equal(got.exc, KO, v.name + " " + m + " " + JSON.stringify(got));
          else check_report(got.ok, want.ok, v.name + " " + m);
        }
      }
      assert.equal(H().run(() => RP.replay(P.mini_branch, t, "structural")).exc, KO, v.name + " structural raises");
    }
    /* JS-only: two tool outputs binding the same variable, one of them integer-like */
    assert.equal(T._key_order_lost(["1", "x"]), true);
    assert.equal(T._key_order_lost(["x", "y"]), false);
    assert.equal(T._py_repr({ a: { c: 1, b: 2 } }), "{'a': {'c': 1, 'b': 2}}");
    assert.equal(T._py_repr({ 7: 1 }), "{'7': 1}");
    assert.equal(H().run(() => T._py_repr([{ b: 1, 7: 2 }])).exc, KO);
    assert.equal(T._py_repr_msg({ b: 1, 7: 2 }), "{'7': 2, 'b': 1}");
  });

  test("replay: counter int() accepts Unicode decimal digits like Python's int()", () => {
    const cases = H().main().py_int;
    assert.ok(cases.length > 600);
    let n = 0;
    for (const [s, want] of cases) {
      const got = H().run(() => RP._py_int(s));
      if (want === null) assert.equal(got.exc, "ValueError", JSON.stringify(s));
      else if (Number.isSafeInteger(want)) assert.equal(got.ok, want, JSON.stringify(s));
      else { assert.equal(got.exc, "ValueError", JSON.stringify(s) + " (beyond 2^53, deviation 4)"); continue; }
      n++;
    }
    assert.ok(n > 600);
  });

  test("replay/traces documented deviations (deviations/traces.md)", () => {
    const T = HX.traces;
    /* 1. a loop counter that would leave the safe-integer range raises ValueError (Python keeps counting) */
    const d = JSON.parse(JSON.stringify(H().main().packages.mini_counter));
    d.machine.states.T.transitions = [{ "if": "", to: "OK", inc: "zz" }];
    const pkg = HX.pkg.sealed(HX.pkg.normalize_package(d));
    const mk = (start) => T.seal(T.new_trace({ trace_id: "big", task: { initial_checkpoint: { variables: { zz: start } } },
      records: [{ step: 0, action: { kind: "tool", name: "tool.t", input: {} }, output: { v: "a" } },
        { step: 1, action: { kind: "end", terminal: "END_OK" } }] }));
    assert.equal(RP.replay_structural(pkg, mk(5)).status, "PASS");
    const r = H().run(() => RP.replay_structural(pkg, mk(Number.MAX_SAFE_INTEGER)));
    assert.equal(r.exc, "ValueError", JSON.stringify(r));
    /* 2. list() of a dict with integer-like keys (tool labels) cannot recover insertion order */
    const t2 = T.seal(T.new_trace({ trace_id: "lbl", records: [{ step: 0, action: { kind: "tool", name: "x", labels: { b: 1, 7: 2 } } }] }));
    assert.equal(H().run(() => HX.normalize.normalize(t2)).exc, "KEY_ORDER_UNKNOWN");
    const t3 = T.seal(T.new_trace({ trace_id: "lbl", records: [{ step: 0, action: { kind: "tool", name: "x", labels: { b: 1, c: 2 } } }] }));
    assert.deepEqual(HX.normalize.normalize(t3)[0][0].labels, ["b", "c"]);
    /* 3. record and trace values must be plain JSON (Python accepts any object in dict fields) */
    assert.throws(() => T.new_record({ step: 0, output: { x: undefined } }), T.ValidationError);
    assert.throws(() => T.new_record({ step: 0, output: { x: 2 ** 60 } }), T.ValidationError);
    assert.throws(() => T.new_record({ step: 0, output: { x: "\ud800" } }), T.ValidationError);
    /* 4. py_json_dumps refuses values Python would print but JS cannot hold exactly */
    assert.throws(() => T.py_json_dumps({ x: 2 ** 60 }), HX.canonical.CanonicalError);
    /* 5. a network API that cannot be replaced fails closed (a frozen navigator with sendBeacon) */
    const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: Object.freeze({ sendBeacon() { return true; } }),
      configurable: true, writable: true });
    try {
      assert.throws(() => RP.no_external_calls(() => 1), RP.ExternalCallAttempted);
      assert.equal(globalThis.fetch.name !== "deny", true, "fetch restored after the failed patch");
      const [t] = T.from_jsonl(H().main().bases.happy.jsonl);
      const rep = RP.replay(H().packages().initial, t, "recorded");
      assert.equal(rep.status, "ERROR");
      assert.ok(rep.detail.startsWith("EXTERNAL_CALL_ATTEMPTED: cannot disable network access (sendBeacon)"), rep.detail);
    } finally {
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete globalThis.navigator;
    }
  });
})();
