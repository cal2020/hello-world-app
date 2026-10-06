/* Parity of HX.store with storage/sqlite.py Store (golden/store.json + store_<n>.json from gen_store.py). */
(function () {
  const S = HX.store;
  const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const PY = ["KeyError", "TypeError", "AttributeError", "ValueError", "IntegrityError", "ProgrammingError",
    "UnicodeEncodeError", "InterfaceError", "OverflowError"];
  const KW_ONLY = new Set(["publish_admission", "append_archive_manifest"]);

  function fill(t, seq) {
    if (typeof t === "string") return t.split("{seq}").join(String(seq));
    if (Array.isArray(t)) return t.map((x) => fill(x, seq));
    if (t !== null && typeof t === "object") {
      const out = {};
      for (const k of Object.keys(t)) out[k] = fill(t[k], seq);
      return out;
    }
    return t;
  }

  function call(st, op) {
    const args = plain(op.a);
    const kw = plain(op.kw);
    if (kw.evidence && kw.evidence.$evidence) {
      const tmpl = kw.evidence.$evidence;
      kw.evidence = (seq) => tmpl.map((x) => fill(x, seq));
    }
    try {
      let r;
      if (KW_ONLY.has(op.m)) r = st[op.m](kw);
      else if (Object.keys(kw).length) r = st[op.m](...args, kw);
      else r = st[op.m](...args);
      return { r: plain(r === undefined ? null : r) };
    } catch (e) {
      if (e instanceof S.ConflictError) return { e: "ConflictError", code: e.code, message: e.message };
      if (e instanceof HX.canonical.CanonicalError) return { e: "CanonicalError", message: e.message };
      if (e instanceof HX.HXError && PY.indexOf(e.code) >= 0) return { e: e.code, message: e.message };
      throw e;
    }
  }

  function check_op(got, want, label) {
    if (want.e !== undefined) {
      assert.equal(got.e, want.e, label + ": " + JSON.stringify(got) + " vs " + JSON.stringify(want));
      if (want.e === "ConflictError") {
        assert.equal(got.code, want.code, label);
        assert.equal(got.message, want.message, label);
      }
      return;
    }
    assert.equal(got.e, undefined, label + ": JS raised " + JSON.stringify(got));
    assert.deepEqual(got.r, want.r, label);
  }

  test("store: 340+ random operation sequences on the real SQLite Store reproduced call for call, with identical tables", () => {
    const G = golden("store");
    let n = 0;
    for (const file of G.files) {
      for (const [si, seq] of golden(file).sequences.entries()) {
        const st = new S.Store(":memory:");
        for (const [oi, op] of seq.ops.entries()) {
          check_op(call(st, op), op.out, `${file}#${si} op ${oi} ${op.m}(${JSON.stringify(op.a)}, ${JSON.stringify(op.kw)})`);
          n++;
        }
        const tables = st.tables();
        for (const t of G.tables) assert.deepEqual(tables[t], seq.tables[t], `${file}#${si} table ${t}`);
        /* the snapshot round-trips, and a reopened store sees the same data */
        const again = S.Store.restore(JSON.stringify(st.snapshot()));
        assert.deepEqual(again.tables(), tables, `${file}#${si} snapshot`);
        assert.deepEqual(st.reopen().tables(), tables, `${file}#${si} reopen`);
      }
    }
    assert.ok(G.n_sequences >= 300);
    assert.equal(n, G.n_ops + golden(G.files[0]).sequences[0].ops.length);
  });

  test("store: every Python public method is provided (minus raw SQL), and schema_version is 2", () => {
    const methods = ["schema_version", "reopen", "close", "put_version", "get_version", "lifecycle", "add_lifecycle",
      "is_revoked", "is_admitted", "add_lifecycle_entry", "admission_record", "publish_admission",
      "append_archive_manifest", "get_active", "create_run", "run_by_request", "list_runs", "get_run",
      "latest_checkpoint", "checkpoints", "append_events", "events", "commit_transition", "set_run_status",
      "request_cancel", "acquire_lease", "lease_token", "create_intent", "intent_for_revision", "intent", "intents",
      "update_intent", "record_outcome", "add_receipt", "receipts", "create_interaction", "interaction",
      "interaction_for_revision", "set_interaction_status", "record_response", "response", "add_evidence", "evidence",
      "invalidate_evidence", "put_trace", "trace_body", "put_proposal", "archive"];
    const st = new S.Store();
    for (const m of methods) assert.equal(typeof st[m], "function", m);
    for (const m of ["q1", "qa", "tx"]) assert.equal(st[m], undefined, m);
    assert.equal(st.schema_version(), golden("store").schema_version);
    assert.equal(S.SCHEMA_VERSION, 2);
  });

  test("store: getters return deep copies; immutable tables have no update path; terminal runs are never reopened", () => {
    const st = new S.Store();
    assert.equal(st.create_run("t", "r", "h", "p", "", { status: "RUNNING", revision: 0, v: { a: [1] } }, [{ type: "A", x: { y: 1 } }], 1), true);
    const cp = st.latest_checkpoint("t", "r");
    cp.v.a.push(2);
    cp.status = "X";
    assert.deepEqual(st.latest_checkpoint("t", "r"), { revision: 0, status: "RUNNING", v: { a: [1] } });
    const ev = st.events("t", "r");
    ev[0].x.y = 9;
    assert.equal(st.events("t", "r")[0].x.y, 1);
    const tb = st.tables();
    tb.runs[0][4] = "HACKED";
    assert.equal(st.get_run("t", "r").status, "RUNNING");
    assert.throws(() => st._update("checkpoints", () => true, () => ({ body: "{}" })), /append-only/);
    st.commit_transition("t", "r", 0, null, { status: "COMPLETED", revision: 1 }, [], 2);
    assert.equal(st.set_run_status("t", "r", "RUNNING"), false);
    assert.equal(st.get_run("t", "r").status, "COMPLETED");
    /* tenant scoping */
    assert.equal(st.get_run("globex", "r"), null);
    assert.deepEqual(st.list_runs("globex"), []);
    assert.equal(st.latest_checkpoint("globex", "r"), null);
  });

  test("store: transactions roll back every write of a failing call", () => {
    const st = new S.Store();
    /* the run row is written, then the second event lacks "type" -> KeyError, nothing stays */
    assert.throws(() => st.create_run("t", "r", "h", "p", "", { status: "RUNNING" }, [{ type: "A" }, { no: 1 }], 1),
      (e) => e.code === "KeyError");
    assert.equal(st.get_run("t", "r"), null);
    assert.deepEqual(st.events("t", "r"), []);
    st.create_run("t", "r", "h", "p", "", { status: "RUNNING" }, [], 1);
    st.acquire_lease("t", "r", "w", 1, 10);
    /* INSERT OR REPLACE then failure: the replaced row comes back */
    const before = st.tables();
    assert.throws(() => st.publish_admission({ environment: "e", skill_id: "s", artifact_hash: "h", expected_parent_hash: null,
      gated_archive_version: null, traces: [["t1", "s", "b"]], record: {}, report: {}, env_key: "h@e", actor: "a",
      manifest: [], now: 2 }), (e) => e.code === "TypeError");
    assert.deepEqual(st.tables(), before);
  });

  test("store: snapshot()/restore(json) persist the whole store; restore validates", () => {
    const st = new S.Store();
    st.create_run("t", "r", "h", "p", "q", { status: "RUNNING", revision: 0 }, [{ type: "A" }], 1.5);
    st.put_proposal("p1", "h", null, "CANDIDATE", { b: 1 }, 2);
    const snap = JSON.parse(JSON.stringify(st.snapshot()));
    assert.equal(snap.format, S.SNAPSHOT_FORMAT);
    const st2 = new S.Store().restore(snap);
    assert.deepEqual(st2.tables(), st.tables());
    assert.deepEqual(st2.proposals(), [{ proposal_id: "p1", parent_hash: "h", candidate_hash: null, status: "CANDIDATE", body: { b: 1 }, created_at: 2 }]);
    assert.equal(st2.run_by_request("t", "q"), "r");
    const bad = (mut) => { const s = JSON.parse(JSON.stringify(snap)); mut(s); return () => S.Store.restore(s); };
    assert.throws(bad((s) => { s.format = "x"; }), /snapshot/);
    assert.throws(bad((s) => { s.tables.runs[0][4] = null; }), /snapshot/);
    assert.throws(bad((s) => { s.tables.runs.push(s.tables.runs[0]); }), /snapshot/);
    assert.throws(bad((s) => { s.tables.nope = []; }), /snapshot/);
    assert.throws(bad((s) => { s.tables.runs[0][7] = "1"; }), /snapshot/);
  });

  test("store: reopen() shares data; close() refuses further use; open_store selects like Python", () => {
    const st = new S.Store();
    const again = st.reopen();
    assert.notEqual(again, st);
    st.put_trace("tr", "sha", "body", 1);
    assert.equal(again.trace_body("tr"), "body");
    again.close();
    assert.throws(() => again.trace_body("tr"), (e) => e.code === "ProgrammingError");
    assert.equal(st.trace_body("tr"), "body");
    for (const v of golden("store").open_store) {
      if (v.exc) {
        assert.throws(() => S.open_store(v.url), (e) => e.code === "ValueError", v.url);
      } else {
        const s = S.open_store(v.url);
        assert.equal(s.path, v.path, v.url);
        S.Store.reset_storage(s.path);
      }
    }
    assert.throws(() => S.open_store("postgresql://h/db"), (e) => e.code === "ValueError");
    /* reopen() like Python for "", file paths and a closed ":memory:" store; an open ":memory:" store gives a new
       object over the same data (documented deviation: Python returns self) */
    for (const v of golden("store").reopen) {
      const path = v.path === "FILE" ? "reopen-golden.db" : v.path;
      S.Store.reset_storage(path);
      const a = new S.Store(path);
      a.put_trace("x", "s", "b", 1);
      if (v.close_first) a.close();
      const b = a.reopen();
      const body = (st) => { try { return { ok: st.trace_body("x") }; } catch (e) { return { e: e.code, message: e.message }; } };
      const label = JSON.stringify([v.path, v.close_first]);
      assert.equal(b === a, v.path === ":memory:" && !v.close_first ? false : v.same_object, label);
      assert.deepEqual(body(b), v.reopened_body, label);
      assert.deepEqual(body(a), v.original_body, label);
      S.Store.reset_storage(path);
    }
    /* a file path shares rows across Store objects, like reopening the SQLite file */
    const a = new S.Store("lab.db"), b = new S.Store("lab.db");
    a.put_trace("x", "s", "b", 1);
    assert.equal(b.trace_body("x"), "b");
    S.Store.reset_storage("lab.db");
    assert.equal(new S.Store("lab.db").trace_body("x"), null);
  });

  test("store deviation: values SQLite coerces by column affinity (floats in TEXT, strings in REAL/INTEGER) raise InterfaceError", () => {
    for (const d of golden("store").deviations) {
      const got = call(new S.Store(), d.op);
      if (d.python.e) assert.equal(got.e, d.python.e, JSON.stringify(d.op));
      else assert.equal(got.e, "InterfaceError", JSON.stringify(d.op) + " -> " + JSON.stringify(got));
    }
  });
})();
