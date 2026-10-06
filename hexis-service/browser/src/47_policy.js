/* Port of hexis_service/tools/policy.py: the independent, deterministic policy boundary (brief §12.2).
 *
 * Authorization derives from the authenticated principal and server-side policy. A machine's capability
 * ceiling can only narrow it. Anything the policy cannot evaluate is INDETERMINATE, which the broker treats
 * as a denial requiring review. The identity directory is SIMULATED for the offline demonstration.
 *
 * Shapes: ``Principal`` and ``PolicyDocument`` are plain objects with the fields of ``model_dump(mode="json")``
 * (a Principal is frozen, like ``frozen=True``; ``roles`` is an array). ``Decision`` is a class with ``outcome``,
 * ``reasons`` and the ``allowed`` getter. ``PolicyService.version`` is a getter, like the Python property.
 * Principal entries of the document are free-form dicts and are used with Python semantics (``in`` on a str
 * entry is a substring test, a missing ``tenant_id`` is a KeyError, ...). Python built-in errors are
 * ``HX.HXError`` with the class name as ``code`` (``PermissionError``, ``KeyError``, ``TypeError``,
 * ``AttributeError``, ``ValueError``); pydantic errors are ``HX.policy.ValidationError``.
 */
(function (HX) {
  "use strict";
  const policy = (HX.policy = HX.policy || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const is_dict = (v) => HX.util.is_plain_object(v);

  class ValidationError extends HX.HXError {
    constructor(message, errors, model) {
      super("VALIDATION_ERROR", message, { errors: errors || [], model: model || "" });
      this.message = message;
      this.errors = errors || [];
      this.model = model || "";
    }
  }
  policy.ValidationError = ValidationError;

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
  const repr = (v) => HX.kernel._py_repr(v);

  function set_own(o, k, v) {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) set_own(out, k, clone(v[k]));
      return out;
    }
    return v;
  }

  /** Python ``a == b`` for JSON values (1 == 1.0 == True; dicts by keys and values). */
  function py_eq(a, b) {
    const na = typeof a === "number" || typeof a === "boolean", nb = typeof b === "number" || typeof b === "boolean";
    if (na || nb) return na && nb && Number(a) === Number(b);
    if (a === null || b === null) return a === b;
    if (typeof a === "string" || typeof b === "string") return a === b;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((x, i) => py_eq(x, b[i]));
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && py_eq(a[k], b[k]));
  }
  policy._py_eq = py_eq;

  /** Python ``x in container`` for JSON values. */
  function py_in(x, c) {
    if (Array.isArray(c)) return c.some((e) => py_eq(e, x));
    if (typeof c === "string") {
      if (typeof x !== "string") throw pyerr("TypeError", "'in <string>' requires string as left operand, not " + type_name(x));
      return c.indexOf(x) >= 0;
    }
    if (is_dict(c)) {
      if (Array.isArray(x) || is_dict(x)) throw pyerr("TypeError", "unhashable type: '" + type_name(x) + "'");
      return typeof x === "string" && hasOwn(c, x);
    }
    throw pyerr("TypeError", "argument of type '" + type_name(c) + "' is not iterable");
  }
  policy._py_in = py_in;

  /** Python ``d.get(k, default)`` (AttributeError when ``d`` is not a dict). */
  function pyget(d, k, dflt) {
    if (!is_dict(d)) throw pyerr("AttributeError", "'" + type_name(d) + "' object has no attribute 'get'");
    return hasOwn(d, k) ? d[k] : dflt;
  }
  /** Python ``d[k]`` on a dict. */
  function getitem(d, k) {
    if (is_dict(d)) {
      if (hasOwn(d, k)) return d[k];
      throw pyerr("KeyError", repr(k));
    }
    throw pyerr("TypeError", "'" + type_name(d) + "' object is not subscriptable");
  }
  /** Python ``tuple(x)`` / iteration of a JSON value. */
  function py_tuple(v) {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (is_dict(v)) return Object.keys(v);
    throw pyerr("TypeError", "'" + type_name(v) + "' object is not iterable");
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Models                                                                                       */
  /* ------------------------------------------------------------------------------------------ */
  let SPECS = null;
  function specs() {
    if (SPECS) return SPECS;
    const pyd = HX.efsm.pyd, T = pyd.T, F = pyd.F;
    SPECS = {
      Principal: { name: "Principal", extra: "forbid", fields: [
        F("id", T.str), F("tenant_id", T.str), F("roles", T.list(T.str), { default: [] }),
        F("authenticated_by", T.str, { default: "simulated-directory" })] },
      PolicyDocument: { name: "PolicyDocument", extra: "forbid", fields: [
        F("policy_version", T.str), F("note", T.str, { default: "" }),
        F("principals", { k: "map", of: T.dict }),
        F("approval_required_capabilities", T.list(T.str), { default: [] }),
        F("approver_role", T.str), F("separation_of_duties", T.bool, { default: true })] },
    };
    return SPECS;
  }
  function validate(name, value) {
    return clone(HX.efsm.pyd.model_validate(specs()[name], value, ValidationError));
  }
  function deep_freeze(v) {
    if (v !== null && typeof v === "object") {
      for (const k of Object.keys(v)) deep_freeze(v[k]);
      Object.freeze(v);
    }
    return v;
  }

  /** ``Principal(**fields)``: host-authenticated identity (frozen). ``roles`` is ``tuple[str, ...]`` (an array
   *  here; a non-sequence gives pydantic's ``tuple_type`` error). */
  function Principal(fields) {
    const spec = specs().Principal;
    const r = HX.efsm.pyd.validate(spec, fields);
    if (r.errors.length) {
      const errs = r.errors.map((e) => (e.type === "list_type" && e.loc.length === 1 && e.loc[0] === "roles"
        ? Object.assign({}, e, { type: "tuple_type", msg: "Input should be a valid tuple" }) : e));
      throw new ValidationError(HX.efsm.pyd.format_errors("Principal", errs), errs, "Principal");
    }
    return deep_freeze(clone(r.value));
  }
  Principal.model_validate = (v) => Principal(v);
  Principal.model_fields = ["id", "tenant_id", "roles", "authenticated_by"];
  policy.Principal = Principal;

  /** ``PolicyDocument.model_validate(doc)``. */
  policy.PolicyDocument = {
    model_validate: (v) => validate("PolicyDocument", v),
    model_fields: ["policy_version", "note", "principals", "approval_required_capabilities", "approver_role",
      "separation_of_duties"],
  };

  class Decision {
    constructor(outcome, reasons) {
      this.outcome = outcome; /* ALLOW | DENY | INDETERMINATE */
      this.reasons = reasons === undefined ? [] : reasons;
    }
    get allowed() { return this.outcome === "ALLOW"; }
    toJSON() { return { outcome: this.outcome, reasons: this.reasons }; }
  }
  policy.Decision = Decision;

  class PolicyService {
    constructor(doc) {
      this.doc = validate("PolicyDocument", clone(doc));
    }

    get version() { return this.doc.policy_version; }

    digest() { return HX.canonical.digest(this.doc); }

    /** Simulated host authentication against the directory. */
    authenticate(principal_id) {
      const p = principal_lookup(this.doc.principals, principal_id);
      if (p === null) throw pyerr("PermissionError", "unknown principal " + repr(principal_id));
      return Principal({ id: principal_id, tenant_id: getitem(p, "tenant_id"), roles: py_tuple(pyget(p, "roles", [])) });
    }

    _entry(principal) {
      const e = principal_lookup(this.doc.principals, principal.id);
      if (e === null || !py_eq(getitem(e, "tenant_id"), principal.tenant_id)) return null;
      return e;
    }

    evaluate_dispatch(principal, tenant_id, capability, ceiling, business_unit) {
      const e = this._entry(principal);
      if (e === null) return new Decision("INDETERMINATE", ["principal not found in current policy"]);
      const reasons = [];
      if (!py_eq(principal.tenant_id, tenant_id)) reasons.push("cross-tenant dispatch");
      if (!py_in(capability, ceiling)) reasons.push("capability " + py_str(capability) + " outside package ceiling");
      if (!py_in(capability, pyget(e, "capabilities", []))) reasons.push("principal lacks capability " + py_str(capability));
      if (business_unit === null || business_unit === undefined) {
        return new Decision("INDETERMINATE", reasons.concat(["business unit unknown"]));
      }
      if (!py_in(business_unit, pyget(e, "business_units", []))) {
        reasons.push("principal not scoped to business unit " + py_str(business_unit));
      }
      return reasons.length ? new Decision("DENY", reasons) : new Decision("ALLOW");
    }

    requires_approval(capability) {
      return py_in(capability, this.doc.approval_required_capabilities);
    }

    can_approve(approver, initiator_id, tenant_id, required_role) {
      if (required_role === undefined) required_role = "";
      const e = this._entry(approver);
      if (e === null) return new Decision("INDETERMINATE", ["approver not found in current policy"]);
      const reasons = [];
      if (!py_eq(approver.tenant_id, tenant_id)) reasons.push("approver from another tenant");
      /* Authority comes from host policy: the deployment's approver_role is always required. A package's
         interaction required_role can only ADD a requirement (narrow who may approve), never replace it. */
      const roles = [this.doc.approver_role].concat(
        truthy(required_role) && !py_eq(required_role, this.doc.approver_role) ? [required_role] : []);
      for (const role of roles) {
        if (!py_in(role, pyget(e, "roles", []))) reasons.push("approver lacks role " + py_str(role));
      }
      if (this.doc.separation_of_duties && py_eq(approver.id, initiator_id)) {
        reasons.push("separation of duties: initiator cannot approve");
      }
      return reasons.length ? new Decision("DENY", reasons) : new Decision("ALLOW");
    }

    /* ---- administrative mutation (tests / demo); produces a new policy version ---------------- */
    revoke_capability(principal_id, capability) {
      if (Array.isArray(principal_id) || is_dict(principal_id)) {
        throw pyerr("TypeError", "unhashable type: '" + type_name(principal_id) + "'");
      }
      if (typeof principal_id !== "string" || !hasOwn(this.doc.principals, principal_id)) throw pyerr("KeyError", repr(principal_id));
      const entry = this.doc.principals[principal_id];
      if (!is_dict(entry)) throw pyerr("AttributeError", "'" + type_name(entry) + "' object has no attribute 'setdefault'");
      if (!hasOwn(entry, "capabilities")) set_own(entry, "capabilities", []);
      const caps = entry.capabilities;
      if (py_in(capability, caps)) {
        if (!Array.isArray(caps)) throw pyerr("AttributeError", "'" + type_name(caps) + "' object has no attribute 'remove'");
        caps.splice(caps.findIndex((c) => py_eq(c, capability)), 1);
      }
      this.doc.policy_version = this.doc.policy_version.split("+")[0] + "+rev" + HX.canonical.digest(this.doc.principals).slice(7, 15);
      return null;
    }
  }
  policy.PolicyService = PolicyService;

  function principal_lookup(principals, pid) {
    if (Array.isArray(pid) || is_dict(pid)) throw pyerr("TypeError", "unhashable type: '" + type_name(pid) + "'");
    return typeof pid === "string" && hasOwn(principals, pid) ? principals[pid] : null;
  }
  function truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  /** Python ``f"{x}"`` (str()) of a JSON value. */
  function py_str(v) {
    if (typeof v === "string") return v;
    return repr(v);
  }
})(globalThis.HX = globalThis.HX || {});
