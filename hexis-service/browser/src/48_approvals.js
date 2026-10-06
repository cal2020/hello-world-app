/* Port of hexis_service/approvals/scope.py (HX.approvals) and hexis_service/evidence/receipts.py (HX.evidence).
 *
 * Approval scope binding (brief §12.1): an approval binds tenant, run, interaction, artifact hash, logical action
 * id, tool/version, canonical argument digest, target business reference, evidence versions, policy version,
 * required approver role and expiry. The broker recomputes the scope at dispatch; any difference invalidates it.
 *
 * Evidence receipts (brief §12.3) are tied to subjects and versions, not durable booleans: a receipt records the
 * digest of each subject variable at verification time; any later change to a subject variable invalidates it.
 *
 * Keyword-only Python parameters become one options object (``approval_scope({tenant_id, run_id, ...})``);
 * ``make_receipt``'s optional ``receipt_id`` and ``valid_positive``'s optional ``claim`` are positional.
 * Python built-in errors (KeyError, TypeError, AttributeError) are ``HX.HXError`` with the class name as ``code``.
 */
(function (HX) {
  "use strict";
  const approvals = (HX.approvals = HX.approvals || {});
  const evidence = (HX.evidence = HX.evidence || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const is_dict = (v) => HX.util.is_plain_object(v);

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }
  function type_name(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") return "dict";
    return typeof v;
  }
  /** Python ``str(x)`` (f-string interpolation) of a JSON value. */
  function py_str(v) { return typeof v === "string" ? v : HX.kernel._py_repr(v); }
  function truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  function iterate(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return Array.from(v);
    if (is_dict(v)) return Object.keys(v);
    throw pyerr("TypeError", "'" + type_name(v) + "' object is not iterable");
  }
  function getitem(d, k) {
    if (is_dict(d)) {
      if (typeof k === "string" && hasOwn(d, k)) return d[k];
      if (Array.isArray(k) || is_dict(k)) throw pyerr("TypeError", "unhashable type: '" + type_name(k) + "'");
      throw pyerr("KeyError", HX.kernel._py_repr(k));
    }
    if (Array.isArray(d) || typeof d === "string") {
      throw pyerr("TypeError", (Array.isArray(d) ? "list" : "string") + " indices must be integers");
    }
    throw pyerr("TypeError", "'" + type_name(d) + "' object is not subscriptable");
  }
  function contains(d, k) {
    if (!is_dict(d)) {
      if (Array.isArray(d)) return d.some((x) => HX.policy._py_eq(x, k));
      if (typeof d === "string") {
        if (typeof k !== "string") throw pyerr("TypeError", "'in <string>' requires string as left operand, not " + type_name(k));
        return d.indexOf(k) >= 0;
      }
      throw pyerr("TypeError", "argument of type '" + type_name(d) + "' is not iterable");
    }
    if (Array.isArray(k) || is_dict(k)) throw pyerr("TypeError", "unhashable type: '" + type_name(k) + "'");
    return typeof k === "string" && hasOwn(d, k);
  }
  function set_own(o, k, v) {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }

  /* ------------------------------------------------------------------------------------------ */
  /* approvals/scope.py                                                                           */
  /* ------------------------------------------------------------------------------------------ */
  /** canonical.sha256_hex(str): ``str.encode("utf-8")`` raises UnicodeEncodeError (Python's exact message) for
   * lone surrogates, where HX.canonical.sha256_hex would raise CanonicalError. */
  function sha256_hex_str(s) {
    const cps = Array.from(s);
    const lone = (c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff;
    const i = cps.findIndex(lone);
    if (i >= 0) {
      let j = i;
      while (j + 1 < cps.length && lone(cps[j + 1])) j++;
      const msg = j === i
        ? "'utf-8' codec can't encode character '\\u" + cps[i].charCodeAt(0).toString(16) + "' in position " + i +
          ": surrogates not allowed"
        : "'utf-8' codec can't encode characters in position " + i + "-" + j + ": surrogates not allowed";
      const e = new HX.HXError("UnicodeEncodeError", msg);
      e.message = msg;
      throw e;
    }
    return HX.canonical.sha256_hex(s);
  }

  approvals.logical_action_id = function (run_id, state_id, revision, args_digest) {
    return "la_" + sha256_hex_str(py_str(run_id) + "|" + py_str(state_id) + "|" + py_str(revision) + "|" +
      py_str(args_digest)).slice(0, 24);
  };

  approvals.idempotency_key = function (tenant_id, lid) {
    return "idem_" + sha256_hex_str(py_str(tenant_id) + "|" + py_str(lid)).slice(0, 32);
  };

  const SCOPE_ARGS = ["tenant_id", "run_id", "interaction_id", "artifact_hash", "lid", "tool", "tool_version",
    "args_digest", "business_reference", "evidence", "policy_version", "required_role", "expires_at"];

  /** ``approval_scope(*, tenant_id, run_id, interaction_id, artifact_hash, lid, tool, tool_version, args_digest,
   *  business_reference, evidence, policy_version, required_role, expires_at)`` as one options object. */
  approvals.approval_scope = function (kw) {
    if (!is_dict(kw)) throw pyerr("TypeError", "approval_scope() takes keyword arguments as an object");
    for (const k of Object.keys(kw)) {
      if (SCOPE_ARGS.indexOf(k) < 0) throw pyerr("TypeError", "approval_scope() got an unexpected keyword argument '" + k + "'");
    }
    const missing = SCOPE_ARGS.filter((k) => !hasOwn(kw, k) || kw[k] === undefined);
    if (missing.length) {
      throw pyerr("TypeError", "approval_scope() missing " + missing.length + " required keyword-only argument" +
        (missing.length > 1 ? "s" : "") + ": " + missing.map((m) => "'" + m + "'").join(", "));
    }
    const c = HX.kernel._clone;
    return { tenant_id: c(kw.tenant_id), run_id: c(kw.run_id), interaction_id: c(kw.interaction_id),
      artifact_hash: c(kw.artifact_hash), logical_action_id: c(kw.lid), tool: c(kw.tool), tool_version: c(kw.tool_version),
      args_digest: c(kw.args_digest), target: { business_reference: c(kw.business_reference) }, evidence: c(kw.evidence),
      policy_version: c(kw.policy_version), required_role: c(kw.required_role), expires_at: c(kw.expires_at) };
  };

  approvals.scope_digest = function (scope) { return HX.canonical.digest(scope); };

  /* ------------------------------------------------------------------------------------------ */
  /* evidence/receipts.py                                                                         */
  /* ------------------------------------------------------------------------------------------ */
  evidence.POSITIVE_RESULTS = Object.freeze(["pass", "match"]);

  /** ``{name: digest(values[name]) or "unset"}`` for each subject variable name. */
  evidence.subject_of = function (values, names) {
    const out = {};
    for (const n of iterate(names)) {
      if (Array.isArray(n) || is_dict(n)) throw pyerr("TypeError", "unhashable type: '" + type_name(n) + "'");
      const v = contains(values, n) ? HX.canonical.digest(getitem(values, n)) : "unset";
      /* Python allows any hashable name here; a non-str key cannot be represented (or canonicalized) later */
      if (typeof n !== "string") throw pyerr("TypeError", "subject variable names must be strings (JS port)");
      set_own(out, n, v);
    }
    return out;
  };

  evidence.make_receipt = function (run_id, claim, verifier, verifier_version, subject, result, source_ref, observed_at,
    receipt_id) {
    const body = { run_id, claim, verifier, verifier_version, subject: HX.kernel._clone(subject),
      subject_digest: HX.canonical.digest(subject), result, source_ref, observed_at };
    if (truthy(receipt_id)) {
      body.receipt_id = receipt_id;
    } else {
      const idbody = {};
      for (const k of Object.keys(body)) if (k !== "observed_at") idbody[k] = body[k];
      body.receipt_id = "ev_" + HX.canonical.digest(idbody).slice(7, 31);
    }
    return body;
  };

  evidence.is_current = function (rec, values) {
    if (!is_dict(rec)) throw pyerr("AttributeError", "'" + type_name(rec) + "' object has no attribute 'get'");
    if (hasOwn(rec, "invalidated_at") && rec.invalidated_at !== null) return false;
    const subject = getitem(rec, "subject");
    if (!is_dict(subject)) throw pyerr("AttributeError", "'" + type_name(subject) + "' object has no attribute 'items'");
    for (const k of Object.keys(subject)) {
      if (evidence.subject_of(values, [k])[k] !== subject[k]) return false;
    }
    return true;
  };

  evidence.valid_positive = function (receipts, values, claim) {
    if (claim === undefined) claim = null;
    const out = [];
    for (const r of iterate(receipts)) {
      if (!evidence.POSITIVE_RESULTS.some((p) => HX.policy._py_eq(p, getitem(r, "result")))) continue;
      if (!evidence.is_current(r, values)) continue;
      if (claim !== null && !HX.policy._py_eq(getitem(r, "claim"), claim)) continue;
      out.push(r);
    }
    return out;
  };

  /** Evidence versions an approval binds: every currently valid positive receipt, sorted by receipt id. */
  evidence.evidence_scope = function (receipts, values) {
    const items = evidence.valid_positive(receipts, values).map((r) => ({
      receipt_id: HX.kernel._clone(getitem(r, "receipt_id")), claim: HX.kernel._clone(getitem(r, "claim")),
      subject_digest: HX.kernel._clone(getitem(r, "subject_digest")) }));
    if (items.length > 1 && items.some((it) => typeof it.receipt_id !== "string")) {
      throw pyerr("TypeError", "'<' not supported for non-str receipt ids (JS port: receipt ids are strings)");
    }
    return items.sort((a, b) => HX.util.cmp_codepoints(a.receipt_id, b.receipt_id));
  };
})(globalThis.HX = globalThis.HX || {});
