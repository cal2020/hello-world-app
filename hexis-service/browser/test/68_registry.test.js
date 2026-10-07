/* Runtime parity for HX.registry: admission scenarios (golden/runtime*.json) and unit vectors. */
(function () {
  const RT = globalThis.RT_RUNTIME;
  const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

  RT.cover(["admission", "admission_environments", "admission_forged", "unadmitted_artifact", "C08_specialist_role",
    "missing_docs_refined", "A32_revocation", "archive_gates"]);

  test("registry: admitted_at is Python's datetime.fromtimestamp(t, utc).isoformat()", () => {
    for (const [t, iso] of golden("runtime").utc) assert.equal(HX.registry._utc_isoformat(t), iso, String(t));
  });

  test("registry: admitted_at outside datetime's range raises like Python (ValueError/OSError/OverflowError)", () => {
    for (const [t, cls, msg] of golden("runtime").utc_errors) {
      assert.throws(() => HX.registry._utc_isoformat(Number(t)), (e) => e.code === cls && e.message === msg, t);
    }
  });

  test("registry: signing key from HX.registry.environ (os.environ stand-in)", () => {
    const R = HX.registry;
    assert.deepEqual(R.signing_key(), ["insecure-demo-key", "hexis-demo-admission-key-not-for-production"]);
    const saved = R.environ;
    try {
      R.environ = { HEXIS_ADMISSION_KEY: "k1" };
      assert.deepEqual(R.signing_key(), ["env-key", "k1"]);
      R.environ = { HEXIS_ADMISSION_KEY: "k1", HEXIS_ADMISSION_KEY_ID: "kid" };
      assert.deepEqual(R.signing_key(), ["kid", "k1"]);
    } finally {
      R.environ = saved;
    }
  });

  test("registry: AdmissionResult shape, admit/enroll keyword checks, empty-archive manifest", () => {
    const R = HX.registry;
    assert.equal(R.ADMIN_ROLE, "artifact_admin");
    assert.deepEqual(plain(new R.AdmissionResult("REJECTED", "h")), { status: "REJECTED", artifact_hash: "h", reasons: [],
      record: null, archive_version: null });
    const env = HX.env.build_env({ clock: new HX.env.ManualClock(1790000000.25), timer: () => 0, ids: HX.env.make_seq_ids(1) });
    assert.throws(() => R.admit(env.store, RT.pkgs().initial, env.catalog, { approver: env.principal("user:dana") }),
      (e) => e.code === "TypeError" && /missing 3 required/.test(e.message));
    assert.throws(() => R.enroll_protected(env.store, "s", [], { actor: env.principal("user:dana"), environment: "x",
      now: 1, extra: 1 }), (e) => e.code === "TypeError");
    assert.deepEqual(R._manifest_of([], []), { protected: [], negative: [],
      held_out: "never stored here; held-out tasks are not given to the compiler or aligner" });
  });

  test("registry: admission with archive traces needs HX.traces/HX.replay only when there are traces", () => {
    const env = HX.env.build_env({ clock: new HX.env.ManualClock(1790000000.25), timer: () => 0, ids: HX.env.make_seq_ids(1) });
    const res = HX.env.admit_initial(env, RT.pkgs().initial);
    assert.equal(res.status, "ADMITTED");
    assert.equal(res.archive_version, 1);
    assert.equal(HX.registry.is_admitted_in(env.store, RT.pkgs().initial.artifact_hash, "sandbox"), true);
  });
})();
