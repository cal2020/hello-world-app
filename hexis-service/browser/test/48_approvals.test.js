/* Parity of HX.approvals (approvals/scope.py) and HX.evidence (evidence/receipts.py) with golden/policy.json. */
(function () {
  const A = HX.approvals, E = HX.evidence;
  const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  test("logical_action_id, idempotency_key, approval_scope and scope_digest match Python", () => {
    const G = golden("policy");
    for (const v of G.lids) {
      assert.equal(A.logical_action_id(...v.args), v.lid, JSON.stringify(v.args));
      assert.equal(A.idempotency_key(v.args[0], v.lid), v.idem);
    }
    for (const v of G.scopes) {
      const sc = A.approval_scope(v.kw);
      assert.deepEqual(plain(sc), v.scope);
      assert.deepEqual(Object.keys(sc), Object.keys(v.scope).length ? ["tenant_id", "run_id", "interaction_id",
        "artifact_hash", "logical_action_id", "tool", "tool_version", "args_digest", "target", "evidence",
        "policy_version", "required_role", "expires_at"] : []);
      assert.equal(A.scope_digest(sc), v.digest);
    }
    for (const v of G.scope_errors) {
      assert.equal(v.result.exc, "TypeError");
      assert.throws(() => A.approval_scope(v.kw), (e) => e.code === "TypeError");
    }
    assert.ok(G.lids.length >= 100 && G.scopes.length >= 80);
  });

  test("logical_action_id / idempotency_key: lone surrogates raise UnicodeEncodeError with Python's message", () => {
    const G = golden("policy");
    assert.ok(G.lid_errors.length >= 10);
    for (const v of G.lid_errors) {
      const args = JSON.parse(v.args_json);
      let got;
      try { got = { ok: A[v.fn](...args) }; } catch (e) {
        assert.ok(e instanceof HX.HXError, String(e));
        got = { exc: e.code, message: e.message };
      }
      assert.deepEqual(got, v.result, v.fn + " " + v.args_json);
    }
  });

  test("evidence: subject_of, make_receipt (ids, digests), is_current, valid_positive and evidence_scope match Python", () => {
    const G = golden("policy");
    assert.deepEqual(Array.from(E.POSITIVE_RESULTS), G.positive_results);
    for (const v of G.subjects) assert.deepEqual(plain(E.subject_of(v.values, v.names)), v.subject, JSON.stringify(v.names));
    for (const v of G.receipts) {
      const rec = v.receipt_id === null ? E.make_receipt(...v.args) : E.make_receipt(...v.args, v.receipt_id);
      const want = Object.assign({}, v.receipt);
      delete want.invalidated_at;
      assert.deepEqual(plain(rec), want);
      assert.deepEqual(Object.keys(rec), ["run_id", "claim", "verifier", "verifier_version", "subject", "subject_digest",
        "result", "source_ref", "observed_at", "receipt_id"]);
    }
    for (const v of G.validity) {
      const label = JSON.stringify(v.receipts.map((r) => r.receipt_id)) + " " + v.claim;
      assert.deepEqual(v.receipts.map((r) => E.is_current(r, v.values)), v.current, label);
      const vp = v.claim === null ? E.valid_positive(v.receipts, v.values) : E.valid_positive(v.receipts, v.values, v.claim);
      assert.deepEqual(vp.map((r) => r.receipt_id), v.valid, label);
      assert.deepEqual(plain(E.evidence_scope(v.receipts, v.values)), v.scope, label);
    }
    assert.ok(G.validity.length >= 80);
  });

  test("evidence: a later change to a subject variable invalidates the receipt", () => {
    const vals = { erp_draft_id: "ERP-1", persisted_version: 2 };
    const subj = E.subject_of(vals, ["erp_draft_id", "persisted_version", "ghost"]);
    assert.equal(subj.ghost, "unset");
    const rec = E.make_receipt("r", "c", "v", "1", subj, "match", "la#1", 5);
    assert.equal(E.is_current(rec, vals), true);
    assert.equal(E.is_current(rec, Object.assign({}, vals, { persisted_version: 3 })), false);
    assert.equal(E.is_current(rec, Object.assign({}, vals, { ghost: null })), false);
    assert.equal(E.is_current(Object.assign({}, rec, { invalidated_at: 9 }), vals), false);
    assert.deepEqual(E.evidence_scope([rec], vals), [{ receipt_id: rec.receipt_id, claim: "c", subject_digest: rec.subject_digest }]);
  });

  test("evidence deviations: non-str subject names and mixed receipt ids fail closed (TypeError)", () => {
    assert.throws(() => E.subject_of({ a: 1 }, [5]), (e) => e.code === "TypeError");
    const r1 = E.make_receipt("r", "c", "v", "1", {}, "pass", "s", 1, 5);
    const r2 = E.make_receipt("r", "c", "v", "1", {}, "pass", "s", 1, "ev_b");
    assert.throws(() => E.evidence_scope([r1, r2], {}), (e) => e.code === "TypeError");
    assert.deepEqual(E.evidence_scope([r1], {}).map((x) => x.receipt_id), [5]);
  });
})();
