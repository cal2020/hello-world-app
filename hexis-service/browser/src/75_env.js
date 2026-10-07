/* Port of hexis_service/demo/env.py: wiring for the offline procurement demonstration and tests (fixture mode).
 *
 * API:
 *   new ManualClock(t = 1790000000.0): a callable clock object -> use ``clock.now()`` or pass ``clock`` itself (it is
 *     a function: ``clock()`` returns ``clock.t``); ``clock.advance(s)``.
 *   build_env(workdir = null, {store, erp, policy, clock, model, docs, registry, store_url, timer, ids}) -> Env
 *     (``build_env({clock, ...})`` without a workdir also works). With a workdir the store and the fake ERP are
 *     path-backed (HX.store.Store / HX.fakes.FakeERP share rows per path in this JS realm, like files); without
 *     one they are ":memory:".
 *   Env: {store, catalog, policy, docs, registry, erp, faults, broker, model, service, clock, timer, ids},
 *     ``env.principal(pid)``, ``env.restart(model?)`` (a simulated process restart: ``store.reopen()``, the ERP
 *     reopened like Python's ``FakeERP(path)`` / the same object for ":memory:", a new broker and service, the same
 *     policy, clock, timer, id source, documents and registry).
 *   load_catalog(), load_policy(), skill_source(), compile_procurement(catalog?), admit_initial(env, pkg,
 *     protected?, negative?), TASK.
 * ``ids`` replaces Python's global ``uuid.uuid4().hex`` (e.g. HX.util.make_id_source(1)); a restarted Env shares it.
 */
(function (HX) {
  "use strict";
  const env = (HX.env = HX.env || {});

  /** ``ManualClock(t)``: a function object (``clock()`` -> t) with ``t`` and ``advance(s)``. */
  function ManualClock(t) {
    const clock = function () { return clock.t; };
    clock.t = t === undefined ? 1790000000.0 : t;
    clock.advance = function (s) { clock.t += s; };
    clock.now = function () { return clock.t; };
    Object.setPrototypeOf(clock, ManualClock.prototype);
    return clock;
  }
  ManualClock.prototype = Object.create(Function.prototype);
  ManualClock.prototype.constructor = ManualClock;
  env.ManualClock = ManualClock;

  env.load_catalog = function load_catalog() { return HX.catalog.load_catalog(HX.kernel._clone(HX.data.tool_catalog)); };
  env.load_policy = function load_policy() { return HX.kernel._clone(HX.data.policy); };
  env.skill_source = function skill_source() { return HX.compile.skill_source(); };
  env.compile_procurement = function compile_procurement(catalog) { return HX.compile.compile_procurement(catalog); };

  class Env {
    constructor(f) {
      this.store = f.store;
      this.catalog = f.catalog;
      this.policy = f.policy;
      this.docs = f.docs;
      this.registry = f.registry;
      this.erp = f.erp;
      this.faults = f.faults;
      this.broker = f.broker;
      this.model = f.model;
      this.service = f.service;
      this.clock = f.clock;
      this.timer = f.timer; /* monotonic, latency metrics only (never logical time) */
      this.ids = f.ids;
    }

    principal(pid) { return this.policy.authenticate(pid); }

    /** Simulate a process restart: new store connection (same data), broker and service over the same backend. */
    restart(model) {
      const store = this.store.reopen();
      const erp = this.erp.reopen();
      return env.build_env(null, { store, erp, policy: this.policy, clock: this.clock, model: model || this.model,
        docs: this.docs, registry: this.registry, timer: this.timer, ids: this.ids });
    }
  }
  env.Env = Env;

  const BUILD_KW = ["store", "erp", "policy", "clock", "model", "docs", "registry", "store_url", "timer", "ids"];

  env.build_env = function build_env(workdir, opts) {
    if (HX.util.is_plain_object(workdir) && opts === undefined) {
      opts = workdir;
      workdir = null;
    }
    const o = opts || {};
    for (const k of Object.keys(o)) {
      if (BUILD_KW.indexOf(k) < 0) throw HX.broker._pyerr("TypeError", "build_env() got an unexpected keyword argument '" + k + "'");
    }
    const wd = workdir === undefined || workdir === null || workdir === "" ? null : String(workdir).replace(/\/+$/, "");
    let store = o.store || null;
    if (store === null && o.store_url) store = HX.store.open_store(o.store_url);
    store = store || new HX.store.Store(wd ? wd + "/hexis.db" : ":memory:");
    const erp = o.erp || new HX.fakes.FakeERP(wd ? wd + "/fake_erp.db" : ":memory:");
    const catalog = env.load_catalog();
    const policy = o.policy || new HX.policy.PolicyService(env.load_policy());
    const clock = o.clock || HX.broker._default_clock;
    const docs = o.docs || new HX.fakes.DocumentStore();
    const registry = o.registry || new HX.fakes.SupplierRegistry();
    const faults = new HX.broker.FaultInjector();
    const timer = o.timer || HX.broker._default_timer;
    const ids = o.ids || HX.service.default_ids;
    const connectors = {
      "documents.read": (a, c) => docs.read(a, c),
      "supplier.lookup": (a, c) => registry.lookup(a, c),
      "draft.validate": (a, c) => HX.fakes.validate_draft(a, c),
      "erp.create_draft": (a, c) => erp.create_draft(a, c),
      "erp.read_draft": (a, c) => erp.read_draft(a, c),
      "draft.verify_persisted": (a, c) => HX.fakes.verify_persisted(a, c),
    };
    const broker = new HX.broker.ToolBroker(store, catalog, policy, connectors,
      { "erp.create_draft": (a, c) => erp.reconcile_create(a, c) }, clock, faults, timer);
    const model = o.model || new HX.fakes.FixtureExtractionModel();
    const service = new HX.service.RunService(store, catalog, policy, broker, model, { clock, faults,
      freshness: { persisted_draft_matches_approved_payload: HX.service.erp_freshness() }, timer, ids });
    return new Env({ store, catalog, policy, docs, registry, erp, faults, broker, model, service, clock, timer, ids });
  };

  env.admit_initial = function admit_initial(e, pkg, protected_, negative) {
    return HX.registry.admit(e.store, pkg, e.catalog, { expected_parent_hash: null, approver: e.principal("user:dana"),
      environment: "sandbox", deployment_policy: HX.fixture.deployment_policy(),
      protected: protected_ || [], negative: negative || [], now: e.clock(), skill_text: env.skill_source().text });
  };

  /** A deterministic id source whose n-th id is ``f"{n:016x}{n:016x}"``. Unlike HX.util.make_id_source (Python's
   *  ``uuid.UUID(int=n).hex``), the first 16 hex digits differ per call, so run ids (``run_`` + hex[:16]) and
   *  interaction ids (``ix_`` + hex[:16]) stay unique. The runtime goldens patch Python's uuid4 the same way. */
  env.make_seq_ids = function make_seq_ids(start) {
    let n = start === undefined ? 1 : start;
    return function next_hex() {
      const h = (n++).toString(16).padStart(16, "0");
      return h + h;
    };
  };

  env.TASK = Object.freeze({ supplier_ref: "SUP-10042", business_unit: "BU-EMEA",
    document_ids: Object.freeze(["DOC-W9-10042", "DOC-FORM-10042"]),
    required_fields: Object.freeze(["legal_name", "country", "tax_id", "contact_email"]),
    policy_version: "onboarding-policy/2026-09" });
  /** A fresh mutable copy of TASK (Python code builds ``dict(TASK, ...)``). */
  env.task = function task(overrides) {
    return Object.assign(HX.kernel._clone(env.TASK), overrides || {});
  };
})(globalThis.HX = globalThis.HX || {});
