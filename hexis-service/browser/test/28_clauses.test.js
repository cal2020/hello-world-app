/* Parity of HX.clauses with compiler/clauses.py (golden/clauses.json). */
(function () {
  const CL = HX.clauses;
  const plain = (x) => JSON.parse(JSON.stringify(x));

  test("index_clauses reproduces Python exactly (ids, headings, text, code-point spans, sha256) on 270+ documents", () => {
    const G = golden("clauses");
    assert.ok(G.cases.length >= 270);
    for (const c of G.cases) {
      const got = CL.index_clauses(c.text);
      assert.deepEqual(plain(got), c.clauses, c.name);
      assert.deepEqual(got.map(CL.is_critical), c.critical, c.name);
      const cps = Array.from(c.text);
      for (const cl of got) assert.equal(cps.slice(cl.start, cl.end).join(""), cl.text, `${c.name} ${cl.id} span`);
    }
  });

  test("SKILL.md: 17 clauses, the Python build's count, with three **MUST** clauses", () => {
    const got = CL.index_clauses(HX.data.skill_md);
    assert.equal(got.length, HX.data.python_build.clause_count);
    assert.deepEqual(got.filter(CL.is_critical).map((c) => c.id), ["S3.1", "S4.1", "S5.1"]);
    assert.deepEqual(plain(got), golden("clauses").cases[0].clauses);
    for (const c of got) assert.deepEqual(Object.keys(c), ["id", "start", "end", "heading", "text", "sha256"]);
  });

  test("Python string helpers: splitlines(keepends), strip/lstrip/rstrip, CRITICAL_MARK", () => {
    const H = golden("clauses").helpers;
    for (const h of H.splitlines) {
      assert.deepEqual(CL.splitlines(h.text, true), h.keepends, JSON.stringify(h.text));
      assert.deepEqual(CL.splitlines(h.text, false), h.plain, JSON.stringify(h.text));
    }
    for (const h of H.strip) {
      assert.equal(CL.py_strip(h.text), h.strip, JSON.stringify(h.text));
      assert.equal(CL.py_lstrip(h.text), h.lstrip, JSON.stringify(h.text));
      assert.equal(CL.py_rstrip(h.text), h.rstrip, JSON.stringify(h.text));
    }
    assert.equal(CL.CRITICAL_MARK, H.critical_mark);
  });

  test("clause refs validate as package ClauseRef models; errors match Python (UnicodeEncodeError, AttributeError)", () => {
    for (const c of CL.index_clauses(HX.data.skill_md)) assert.deepEqual(plain(HX.pkg.ClauseRef.model_validate(c)), plain(c));
    const E = golden("clauses").errors;
    assert.ok(E.length >= 8);
    for (const c of E) {
      const label = c.text_json;
      let got, err;
      try { got = CL.index_clauses(JSON.parse(c.text_json)); } catch (e) { err = e; }
      if (c.result.exc === undefined) {
        assert.ok(!err, `${label}: ${err && err.message}`);
        assert.deepEqual(got.map((x) => x.id), c.result.ok, label);
      } else {
        assert.ok(err instanceof HX.HXError, `${label}: expected ${c.result.exc}`);
        assert.equal(err.code, c.result.exc, label);
        if (c.result.exc === "AttributeError") assert.equal(err.message, c.result.message, label);
      }
    }
  });
})();
