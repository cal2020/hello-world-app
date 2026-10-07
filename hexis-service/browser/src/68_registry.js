/* Port of hexis_service/artifacts/registry.py: immutable versions, admission, active pointers, revocation
 * (brief §6.2, §9.5).
 *
 * Lifecycle: validated -> admitted -> active; revoked prevents new runs. Admission re-validates the package
 * itself (it never trusts a report handed to it) against the operator's deployment policy, replays every
 * protected trace and the negative corpus itself (refusing archives that drop entries of the current archive
 * version), requires an admin role, binds the artifact hash to the validation-report digest and replay-archive
 * digest in a signed record, and publishes the new active pointer plus the new protected-archive manifest
 * atomically with a compare-and-swap against the expected parent.
 *
 * API (Python keyword arguments become one options object):
 *   admit(store, pkg, catalog, {expected_parent_hash, approver, environment, now, deployment_policy, protected,
 *         negative, archive_manifest, skill_text}) -> AdmissionResult
 *   enroll_protected(store, skill_id, traces, {actor, environment, now, negative = false}) -> AdmissionResult
 *   register(store, pkg, actor, now); revoke(store, artifact_hash, actor, reason, now);
 *   is_admitted_in(store, artifact_hash, environment) -> bool; signing_key() -> [key_id, key]
 * ``pkg`` is a MachinePackage dump (normalized here). Traces are HX.traces objects; the archive gates use
 * HX.traces / HX.replay / HX.normalize at call time, and only when there are traces to check.
 *
 * ``signing_key()`` reads ``HX.registry.environ`` (the stand-in for ``os.environ``: ``HEXIS_ADMISSION_KEY``,
 * ``HEXIS_ADMISSION_KEY_ID``); unset, it is the labeled insecure demo key, as in Python.
 */
(function (HX) {
  "use strict";
  const registry = (HX.registry = HX.registry || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  registry.ADMIN_ROLE = "artifact_admin";
  registry.environ = registry.environ || {};
  registry.HELD_OUT_NOTE = "never stored here; held-out tasks are not given to the compiler or aligner";

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }
  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  const truthy = (v) => HX.broker._truthy(v);
  const get = (d, k, dflt) => (hasOwn(d, k) ? d[k] : (dflt === undefined ? null : dflt));

  /** Development HMAC key from the environment; a fixed demo key is used only when unset and is labeled as such in
   *  every admission record. Returns ``[key_id, key]``. */
  registry.signing_key = function signing_key() {
    const env = registry.environ || {};
    const k = env.HEXIS_ADMISSION_KEY;
    if (truthy(k)) return [truthy(env.HEXIS_ADMISSION_KEY_ID) ? env.HEXIS_ADMISSION_KEY_ID : "env-key", String(k)];
    return ["insecure-demo-key", "hexis-demo-admission-key-not-for-production"];
  };

  /** ``AdmissionResult(status, artifact_hash, reasons=[], record=None, archive_version=None)``;
   *  status: ADMITTED | CONFLICT | REJECTED */
  class AdmissionResult {
    constructor(status, artifact_hash, reasons, record, archive_version) {
      this.status = status;
      this.artifact_hash = artifact_hash;
      this.reasons = reasons === undefined ? [] : reasons;
      this.record = record === undefined ? null : record;
      this.archive_version = archive_version === undefined ? null : archive_version;
    }
    toJSON() {
      return { status: this.status, artifact_hash: this.artifact_hash, reasons: this.reasons, record: this.record,
        archive_version: this.archive_version };
    }
  }
  registry.AdmissionResult = AdmissionResult;

  registry.register = function register(store, pkg, actor, now) {
    store.put_version(HX.pkg.to_json(pkg), actor, now);
    return null;
  };

  /* ---- traces (HX.traces, at call time) ---------------------------------------------------------------- */
  const T = () => {
    if (!HX.traces) throw pyerr("ImportError", "HX.traces is not loaded");
    return HX.traces;
  };
  const tid = (t) => t.trace_id;
  const records_digest = (t) => (typeof t.records_digest === "function" ? t.records_digest() : T().records_digest(t));
  const integrity_errors = (t) => (typeof t.integrity_errors === "function" ? t.integrity_errors() : T().integrity_errors(t));
  const to_jsonl = (t) => (typeof t.to_jsonl === "function" ? t.to_jsonl() : T().to_jsonl(t));
  function from_jsonl(body) {
    const r = T().from_jsonl(body);
    if (Array.isArray(r)) return r;
    return [r.trace, r.errors || r.errs || []];
  }
  function replay_structural(pkg, t) {
    if (!HX.replay) throw pyerr("ImportError", "HX.replay is not loaded");
    return HX.replay.replay_structural(pkg, t);
  }

  /** ``traces.update.archive_manifest(protected, negative)`` */
  function manifest_of(protected_, negative) {
    if (HX.update && typeof HX.update.archive_manifest === "function") return HX.update.archive_manifest(protected_, negative);
    return { protected: protected_.map((t) => ({ trace_id: tid(t), records_digest: records_digest(t) })),
      negative: negative.map((t) => ({ trace_id: tid(t), records_digest: records_digest(t) })),
      held_out: registry.HELD_OUT_NOTE };
  }
  registry._manifest_of = manifest_of;

  /** Admission-time replay gates, computed here rather than trusted from the caller. */
  function check_archive(store, pkg, protected_, negative, current) {
    const reasons = [];
    const by_id = { protected: new Map(), negative: new Map() };
    for (const t of protected_) by_id.protected.set(tid(t), t);
    for (const t of negative) by_id.negative.set(tid(t), t);
    const to_replay = { protected: new Map(by_id.protected), negative: new Map(by_id.negative) };
    for (const kind of ["protected", "negative"]) {
      const ents = truthy(get(current, kind)) ? current[kind] : [];
      for (const ent of ents) {
        const id = get(ent, "trace_id"), rd = get(ent, "records_digest");
        const sup = by_id[kind].has(id) ? by_id[kind].get(id) : null;
        if (sup === null || records_digest(sup) !== rd) {
          reasons.push("archive: " + kind + " entry " + HX.broker._py_str(id) + " of the current archive is missing or altered");
          continue;
        }
        const body = store.trace_body(id);
        if (body !== null) {
          const [stored, errs] = from_jsonl(body);
          if (truthy(errs) || records_digest(stored) !== rd) {
            reasons.push("archive: stored body of " + kind + " trace " + HX.broker._py_str(id) + " does not match the manifest");
            continue;
          }
          to_replay[kind].set(id, stored);
        }
      }
    }
    for (const kind of ["protected", "negative"]) {
      for (const [id, t] of to_replay[kind]) {
        const integ = integrity_errors(t);
        if (integ.length) reasons.push("archive: " + kind + " trace " + id + " integrity: " + integ[0]);
      }
    }
    if (reasons.length) return reasons;
    const sorted_ids = (m) => Array.from(m.keys()).sort(cmp);
    for (const id of sorted_ids(to_replay.protected)) {
      const r = replay_structural(pkg, to_replay.protected.get(id));
      if (r.status !== "PASS") reasons.push("protected replay: " + id + " " + r.status + " " + r.detail);
    }
    for (const id of sorted_ids(to_replay.negative)) {
      const r = replay_structural(pkg, to_replay.negative.get(id));
      if (r.status === "PASS") reasons.push("negative corpus: " + id + " is representable by the candidate");
    }
    return reasons;
  }
  registry._check_archive = check_archive;

  /** Proleptic Gregorian (astronomical) year of ``days`` since 1970-01-01 (H. Hinnant's civil_from_days). */
  function civil_year(days) {
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    return yoe + era * 400 + (mp >= 10 ? 1 : 0);
  }

  /** Python ``datetime.fromtimestamp(now, timezone.utc).isoformat()`` (microseconds rounded half-even). */
  function utc_isoformat(now) {
    if (typeof now !== "number" || !Number.isFinite(now)) {
      throw pyerr("TypeError", "'" + HX.kernel._py_type_name(now) + "' object cannot be interpreted as a timestamp");
    }
    let intpart = Math.trunc(now);
    let frac = (now - intpart) * 1e6;
    const fl = Math.floor(frac), diff = frac - fl;
    let us = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1);
    if (us >= 1e6) { us -= 1e6; intpart += 1; } else if (us < 0) { us += 1e6; intpart -= 1; }
    /* Python's range checks: time_t overflow, gmtime's int tm_year, then datetime's MINYEAR..MAXYEAR */
    if (!(intpart >= -9223372036854775808 && intpart < 9223372036854775808)) {
      throw pyerr("OverflowError", "timestamp out of range for platform time_t");
    }
    const year = civil_year(Math.floor(intpart / 86400));
    if (year - 1900 > 2147483647 || year - 1900 < -2147483648) {
      throw pyerr("OSError", "[Errno 75] Value too large for defined data type");
    }
    if (year < 1 || year > 9999) throw pyerr("ValueError", "year " + year + " is out of range");
    const d = new Date(intpart * 1000);
    const p = (n, w) => String(n).padStart(w, "0");
    let s = p(d.getUTCFullYear(), 4) + "-" + p(d.getUTCMonth() + 1, 2) + "-" + p(d.getUTCDate(), 2) + "T" +
      p(d.getUTCHours(), 2) + ":" + p(d.getUTCMinutes(), 2) + ":" + p(d.getUTCSeconds(), 2);
    if (us) s += "." + p(us, 6);
    return s + "+00:00";
  }
  registry._utc_isoformat = utc_isoformat;

  const ADMIT_KW = ["expected_parent_hash", "approver", "environment", "now"];
  const ADMIT_OPT = ["deployment_policy", "protected", "negative", "archive_manifest", "skill_text"];

  /** Admit ``pkg`` as the new active version of its skill in ``environment``. ``deployment_policy`` is the operator's
   *  trusted policy (a DeploymentPolicy or an ExecutionPolicy dump); admission fails closed without it.
   *  ``protected`` / ``negative`` are the archive traces; admission replays them itself. ``archive_manifest``, if
   *  given, must equal the manifest of those traces. */
  registry.admit = function admit(store, pkg_in, catalog, opts) {
    const o = HX.broker._kw("admit", opts, ADMIT_KW, ADMIT_OPT);
    const pkg = HX.pkg.normalize_package(pkg_in);
    const h = pkg.artifact_hash;
    const protected_ = truthy(o.protected) ? Array.from(o.protected) : [];
    const negative = truthy(o.negative) ? Array.from(o.negative) : [];
    const approver = o.approver;
    const deployment_policy = o.deployment_policy === undefined ? null : o.deployment_policy;
    const skill_text = o.skill_text === undefined ? null : o.skill_text;
    const expected_parent_hash = o.expected_parent_hash === undefined ? null : o.expected_parent_hash;
    if (approver.roles.indexOf(registry.ADMIN_ROLE) < 0) {
      return new AdmissionResult("REJECTED", h, [approver.id + " lacks role " + registry.ADMIN_ROLE]);
    }
    if (deployment_policy === null) {
      return new AdmissionResult("REJECTED", h, ["no operator deployment policy supplied; admission fails closed"]);
    }
    if (!HX.pkg.verify_hash(pkg)) {
      return new AdmissionResult("REJECTED", h, ["HASH_MISSING/HASH_MISMATCH: package is not sealed with its content hash"]);
    }
    if (skill_text === null) {
      return new AdmissionResult("REJECTED", h, ["skill source text is required to verify clause provenance"]);
    }
    const report = HX.validate.validate_package(pkg, catalog, "production", { skill_text, deployment_policy });
    if (!report.passed) {
      return new AdmissionResult("REJECTED", h, report.errors().map((f) => f.code + ": " + f.message));
    }
    const parent = truthy(pkg.lineage.parent_hash) ? pkg.lineage.parent_hash : null;
    const expected = truthy(expected_parent_hash) ? expected_parent_hash : null;
    if (parent !== expected) {
      return new AdmissionResult("REJECTED", h, ["package lineage parent does not match expected parent"]);
    }
    const computed_manifest = manifest_of(protected_, negative);
    if (o.archive_manifest !== undefined && o.archive_manifest !== null &&
      HX.canonical.digest(o.archive_manifest) !== HX.canonical.digest(computed_manifest)) {
      return new AdmissionResult("REJECTED", h, ["archive manifest does not match the supplied archive traces"]);
    }
    const archive_manifest = computed_manifest;
    const have = new Set(protected_.map(tid));
    const missing_origin = Array.from(new Set(pkg.lineage.trace_ids)).filter((t) => !have.has(t)).sort(cmp);
    if (missing_origin.length) {
      return new AdmissionResult("REJECTED", h, missing_origin.map((t) => "originating trace " + t +
        " of this update must be in the protected archive it is admitted with"));
    }
    const stored_archive = store.archive(pkg.machine.skill_id);
    const current_archive = truthy(stored_archive) ? stored_archive : {};
    const gated_version = get(current_archive, "version");
    const gate = check_archive(store, pkg, protected_, negative, current_archive);
    if (gate.length) return new AdmissionResult("REJECTED", h, gate);
    const rj = report.to_json();
    const [key_id, key] = registry.signing_key();
    const rec = HX.pkg.sign_admission({ artifact_hash: h, environment: o.environment, approver: approver.id,
      admitted_at: utc_isoformat(o.now), validation_report_digest: rj.report_digest,
      replay_archive_digest: HX.canonical.digest(archive_manifest), key_id }, key);
    const skill_id = pkg.machine.skill_id;
    registry.register(store, pkg, approver.id, o.now);
    const pub = store.publish_admission({ environment: o.environment, skill_id, artifact_hash: h,
      expected_parent_hash, gated_archive_version: gated_version, traces: trace_rows(protected_.concat(negative)),
      record: rec, report: rj, env_key: env_key(h, o.environment), actor: approver.id, manifest: archive_manifest,
      now: o.now });
    if (pub.status === "CONFLICT") {
      if (pub.conflict === "active") {
        return new AdmissionResult("CONFLICT", h, ["active version is " + HX.broker._py_str(pub.current) + ", expected " +
          HX.broker._py_str(expected_parent_hash) + "; rebase onto the new parent and rerun all gates"]);
      }
      return new AdmissionResult("CONFLICT", h, ["protected archive changed during admission; rerun all gates"]);
    }
    return new AdmissionResult("ADMITTED", h, [], HX.kernel._clone(rec), pub.version);
  };

  /** Append traces to the stored protected archive (or the negative corpus) without a new machine. */
  registry.enroll_protected = function enroll_protected(store, skill_id, traces, opts) {
    const o = HX.broker._kw("enroll_protected", opts, ["actor", "environment", "now"], ["negative"]);
    const negative = truthy(o.negative);
    const kind = negative ? "negative" : "protected";
    if (o.actor.roles.indexOf(registry.ADMIN_ROLE) < 0) {
      return new AdmissionResult("REJECTED", "", [o.actor.id + " lacks role " + registry.ADMIN_ROLE]);
    }
    const active = store.get_active(o.environment, skill_id);
    if (active === null) {
      return new AdmissionResult("REJECTED", "", ["no active version of " + HX.broker._py_str(skill_id) + " in " +
        HX.broker._py_str(o.environment)]);
    }
    const active_hash = active[0];
    const pkg = HX.pkg.from_json(store.get_version(active_hash));
    const stored = store.archive(skill_id);
    const current = truthy(stored) ? stored : {};
    const reasons = [];
    const list = Array.from(traces);
    for (const t of list) {
      const integ = integrity_errors(t);
      if (integ.length) {
        reasons.push(tid(t) + ": integrity: " + integ[0]);
        continue;
      }
      const rep = replay_structural(pkg, t);
      if (negative) {
        if (rep.status === "PASS") reasons.push(tid(t) + ": negative trace is representable by the active version");
        continue;
      }
      if (!HX.normalize) throw pyerr("ImportError", "HX.normalize is not loaded");
      const viol = HX.normalize.eligibility(t, pkg);
      if (viol.length) reasons.push(tid(t) + ": ineligible for the protected archive: " + viol[0].code);
      if (rep.status !== "PASS") reasons.push(tid(t) + ": does not replay against the active version: " + rep.status + " " + rep.detail);
    }
    if (reasons.length) return new AdmissionResult("REJECTED", active_hash, reasons);
    const existing = new Map();
    for (const e of truthy(get(current, kind)) ? current[kind] : []) existing.set(e.trace_id, e);
    for (const t of list) {
      const prev = existing.has(tid(t)) ? existing.get(tid(t)) : null;
      if (prev !== null && get(prev, "records_digest") !== records_digest(t)) {
        return new AdmissionResult("REJECTED", active_hash, [tid(t) + ": already enrolled with different records"]);
      }
      existing.set(tid(t), { trace_id: tid(t), records_digest: records_digest(t) });
    }
    const manifest = { protected: truthy(get(current, "protected")) ? current.protected.slice() : [],
      negative: truthy(get(current, "negative")) ? current.negative.slice() : [],
      held_out: hasOwn(current, "held_out") ? current.held_out : "never stored here" };
    manifest[kind] = Array.from(existing.keys()).sort(cmp).map((k) => existing.get(k));
    const pub = store.append_archive_manifest({ skill_id, expected_version: get(current, "version"),
      artifact_hash: active_hash, manifest, traces: trace_rows(list), actor: o.actor.id,
      lifecycle_state: "archive_enrolled:" + kind, lifecycle_reason: list.map(tid).join(","), now: o.now });
    if (pub.status === "CONFLICT") {
      return new AdmissionResult("CONFLICT", active_hash, ["protected archive changed concurrently; retry"]);
    }
    return new AdmissionResult("ADMITTED", active_hash, [], null, pub.version);
  };

  function trace_rows(traces) {
    return traces.map((t) => {
      const body = to_jsonl(t);
      return [tid(t), HX.canonical.sha256_hex(body), body];
    });
  }
  registry._trace_rows = trace_rows;

  function env_key(artifact_hash, environment) { return artifact_hash + "@" + environment; }
  registry._env_key = env_key;

  /** True only if ``artifact_hash`` was admitted to ``environment`` by ``admit``: an ``admitted`` lifecycle entry
   *  for that environment *and* a stored admission record for that environment whose HMAC signature verifies and
   *  which binds this hash, this environment and the stored validation report. */
  registry.is_admitted_in = function is_admitted_in(store, artifact_hash, environment) {
    if (!store.lifecycle(artifact_hash).some((e) => e.state === "admitted" && e.reason === environment)) return false;
    const row = store.admission_record(env_key(artifact_hash, environment));
    if (!truthy(row)) return false;
    let rec, report;
    try {
      rec = HX.pkg.AdmissionRecord.model_validate(HX.canonical.strict_loads(row[0]));
      report = HX.canonical.strict_loads(row[1]);
    } catch (e) {
      if (HX.broker.is_crash(e)) throw e;
      return false; /* an unparsable record is simply not an admission */
    }
    const [, key] = registry.signing_key();
    if (!(rec.artifact_hash === artifact_hash && rec.environment === environment)) return false;
    if (!HX.util.is_plain_object(report)) {
      throw pyerr("AttributeError", "'" + HX.kernel._py_type_name(report) + "' object has no attribute 'get'");
    }
    return rec.validation_report_digest === get(report, "report_digest") && HX.pkg.verify_admission(rec, key);
  };

  registry.revoke = function revoke(store, artifact_hash, actor, reason, now) {
    if (actor.roles.indexOf(registry.ADMIN_ROLE) < 0) {
      throw pyerr("PermissionError", actor.id + " lacks role " + registry.ADMIN_ROLE);
    }
    store.add_lifecycle_entry(artifact_hash, "revoked", actor.id, reason, now);
    return null;
  };
})(globalThis.HX = globalThis.HX || {});
