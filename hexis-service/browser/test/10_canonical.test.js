/* Parity of HX.canonical with hexis_service/canonical.py (golden/canonical.json). */
(function () {
  const C = HX.canonical;
  const G = () => golden("canonical");

  test("canonical text and digest match Python for every golden value", () => {
    for (const c of G().canonical) {
      assert.equal(C.canonical_text(c.value), c.canonical, `canonical text of ${JSON.stringify(c.value)}`);
      assert.equal(C.digest(c.value), c.digest);
    }
  });

  test("float formatting matches Python repr for 600+ floats across all magnitudes", () => {
    const bad = [];
    for (const c of G().floats) {
      const got = C.py_float_repr(c.value);
      if (got !== c.repr) bad.push(`${c.repr} -> ${got}`);
    }
    assert.deepEqual(bad.slice(0, 10), [], `${bad.length} mismatches`);
  });

  test("strict_loads accepts/rejects exactly like Python, except documented deviations", () => {
    for (const c of G().loads) {
      let got, err;
      try { got = C.strict_loads(c.text); } catch (e) { err = e; }
      if (c.js === "accept") {
        assert.ok(!err, `should accept ${JSON.stringify(c.text)} (${c.note}): ${err && err.message}`);
        assert.deepEqual(got, c.value);
      } else {
        assert.ok(err instanceof C.CanonicalError, `should reject ${JSON.stringify(c.text).slice(0, 80)} (${c.note})`);
      }
    }
  });

  test("documented deviations are exactly integral floats and integers beyond 2^53", () => {
    const dev = G().loads.filter((c) => c.deviation).map((c) => c.text).sort();
    assert.deepEqual(dev, ["-0.0", "1.0", "1e2", "9007199254740993"].sort());
  });

  test("strict_loads_bytes: BOM, invalid UTF-8 and encoded surrogates rejected", () => {
    for (const c of G().loads_bytes) {
      const bytes = new Uint8Array(c.hex.match(/../g).map((h) => parseInt(h, 16)));
      let got, err;
      try { got = C.strict_loads_bytes(bytes); } catch (e) { err = e; }
      if (c.python === "accept") { assert.ok(!err, c.note); assert.deepEqual(got, c.value); }
      else assert.ok(err instanceof C.CanonicalError, c.note);
    }
  });

  test("sha256 and hmac-sha256 match Python", () => {
    for (const c of G().sha256) assert.equal(C.sha256_hex(c.text), c.sha256, JSON.stringify(c.text).slice(0, 40));
    for (const c of G().hmac) assert.equal(C.hmac_sha256_hex(c.key, c.message), c.hmac);
  });

  test("check_value rejects non-JSON values and lone surrogates", () => {
    for (const bad of [NaN, Infinity, undefined, () => 1, "\ud800", { "\udc00": 1 }, 2 ** 60, [new Date()]]) {
      assert.throws(() => C.canonical_text(bad), C.CanonicalError);
    }
    let deep = 1;
    for (let i = 0; i < 65; i++) deep = [deep];
    assert.throws(() => C.check_value(deep), /nesting too deep/);
  });

  test("__proto__ keys are data, not prototype mutation", () => {
    const v = C.strict_loads('{"__proto__": {"polluted": 1}}');
    assert.equal(({}).polluted, undefined);
    assert.deepEqual(Object.keys(v), ["__proto__"]);
    assert.equal(C.canonical_text(v), '{"__proto__":{"polluted":1}}');
  });

  test("JSON Schema subset agrees with python-jsonschema on validity and error paths", () => {
    const g = golden("jsonschema");
    for (const c of g.cases) {
      const errs = HX.jsonschema.validate_against(g.schemas[c.schema], c.instance);
      assert.equal(errs.length === 0, c.valid, `${JSON.stringify(c.instance)}: ${errs.join("; ")}`);
      const paths = [...new Set(errs.map((e) => e.split(":")[0]))].sort();
      assert.deepEqual(paths, c.error_paths, JSON.stringify(c.instance));
    }
  });

  test("JSON Schema: unsupported keywords fail closed", () => {
    assert.ok(HX.jsonschema.validate_against({ $ref: "#/x" }, 1).length > 0);
    assert.ok(HX.jsonschema.check_schema({ type: "strin" }).length > 0);
    assert.deepEqual(HX.jsonschema.check_schema({ type: ["string", "null"], minLength: 1 }), []);
  });
})();
