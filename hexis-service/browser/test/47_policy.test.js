/* Parity of HX.policy with tools/policy.py (golden/policy.json + policy_dispatch.json from gen_policy.py). */
(function () {
  const PO = HX.policy;
  const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const PY = ["KeyError", "TypeError", "AttributeError", "ValueError", "PermissionError"];
  const err_key = (e) => JSON.stringify(e);

  function run(fn) {
    try {
      return { ok: fn() };
    } catch (e) {
      if (e instanceof PO.ValidationError) return { exc: "ValidationError", errors: e.errors.map((x) => [x.type, x.loc]) };
      if (e instanceof HX.HXError && PY.indexOf(e.code) >= 0) return { exc: e.code, message: e.message };
      throw e;
    }
  }
  function same(got, want, label) {
    if (want.exc === undefined) {
      assert.equal(got.exc, undefined, label + ": JS raised " + JSON.stringify(got));
      assert.deepEqual(plain(got.ok), want.ok, label);
      return;
    }
    assert.equal(got.exc, want.exc, label + ": " + JSON.stringify(got));
    if (want.exc === "ValidationError") assert.deepEqual(got.errors.map(err_key).sort(), want.errors.map(err_key).sort(), label);
    else if (want.exc === "PermissionError" || want.exc === "KeyError") assert.equal(got.message, want.message, label);
  }
  const dec = (d) => [d.outcome, d.reasons, d.allowed];

  test("PolicyDocument validation, version and digest match Python", () => {
    for (const c of golden("policy").doc_cases) {
      same(run(() => {
        const s = new PO.PolicyService(c.doc);
        return { doc: s.doc, version: s.version, digest: s.digest() };
      }), c.result, JSON.stringify(c.doc).slice(0, 120));
    }
  });

  test("authenticate and Principal(**fields) match Python (frozen principals, tuple roles)", () => {
    const G = golden("policy");
    const svcs = {};
    for (const n of Object.keys(G.docs)) svcs[n] = new PO.PolicyService(G.docs[n]);
    for (const a of G.auth) same(run(() => svcs[a.doc].authenticate(a.pid)), a.result, a.doc + " " + JSON.stringify(a.pid));
    for (const c of G.principal_cases) same(run(() => PO.Principal(c.fields)), c.result, JSON.stringify(c.fields));
    const p = svcs.example.authenticate("user:alice");
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.roles));
    assert.throws(() => { "use strict"; p.tenant_id = "globex"; }, TypeError);
  });

  test("evaluate_dispatch decision table: every principal x tenant x capability x ceiling x business unit", () => {
    const G = golden("policy");
    const rows = golden("policy_dispatch").dispatch;
    const svcs = {};
    for (const n of Object.keys(G.docs)) svcs[n] = new PO.PolicyService(G.docs[n]);
    for (const r of rows) {
      const P = PO.Principal(G.principals[r.doc][r.p]);
      same(run(() => dec(svcs[r.doc].evaluate_dispatch(P, r.tenant, r.cap, G.ceilings[r.ceiling], r.bu))), r.result,
        `${r.doc} ${P.id} ${r.tenant} ${r.cap} ${r.ceiling} ${r.bu}`);
    }
    assert.ok(rows.length >= 4000);
    const svc = svcs.example;
    const alice = svc.authenticate("user:alice");
    for (const r of G.odd_dispatch) {
      same(run(() => dec(svc.evaluate_dispatch(alice, "acme", r.cap, r.ceiling, r.bu))), r.result, JSON.stringify(r));
    }
  });

  test("can_approve (review fixes: approver_role always required, package role only narrows, SoD) and requires_approval", () => {
    const G = golden("policy");
    const svcs = {};
    for (const n of Object.keys(G.docs)) svcs[n] = new PO.PolicyService(G.docs[n]);
    for (const r of G.approve) {
      const P = PO.Principal(G.principals[r.doc][r.p]);
      const got = run(() => dec(r.role === null ? svcs[r.doc].can_approve(P, r.initiator, r.tenant)
        : svcs[r.doc].can_approve(P, r.initiator, r.tenant, r.role)));
      same(got, r.result, `${r.doc} ${P.id} ${r.initiator} ${r.tenant} ${r.role}`);
    }
    for (const r of G.requires) same(run(() => svcs[r.doc].requires_approval(r.cap)), r.result, r.doc + " " + r.cap);
    const d = new PO.Decision("ALLOW");
    assert.equal(d.allowed, true);
    assert.deepEqual(d.reasons, []);
    assert.equal(new PO.Decision("DENY", ["x"]).allowed, false);
  });

  test("revoke_capability sequences reproduce the exact policy_version suffix scheme and digests", () => {
    const G = golden("policy");
    for (const seq of G.revokes) {
      const s = new PO.PolicyService(G.docs[seq.doc]);
      for (const st of seq.steps) {
        same(run(() => s.revoke_capability(st.pid, st.cap)), st.result, seq.doc + " revoke " + st.pid + " " + st.cap);
        assert.equal(s.version, st.version);
        assert.equal(s.digest(), st.digest);
        assert.deepEqual(plain(s.doc.principals), st.principals);
      }
    }
    /* the service owns a copy of its document */
    const doc = plain(G.docs.example);
    const s = new PO.PolicyService(doc);
    s.revoke_capability("user:alice", "documents:read");
    assert.ok(doc.principals["user:alice"].capabilities.includes("documents:read"));
    assert.match(s.version, /^onboarding-policy\/2026-09\+rev[0-9a-f]{8}$/);
  });
})();
