/* Port of hexis_service/artifacts/efsm.py: the upstream ``efsm-v1`` machine format.
 *
 * Pydantic models become plain JSON objects with exactly the fields of
 * ``model_dump(mode="json", by_alias=True)`` (every default present, fields in declaration order).
 * This file also holds the small pydantic emulation (``HX.efsm.pyd``) that 26_pkg and 55_fakes use for
 * their own models: lax coercions (bool->int, numeric strings, 0/1 and "yes"/"no" bools, ...), the
 * ``extra="forbid"`` rule, aliases, discriminated unions, before/after validators, and error lists with
 * pydantic's error ``type`` and ``loc``.
 *
 * Normalized data shape (see deviations/models.md):
 *  - typed maps (``dict[str, Model]``/``dict[str, str]``: states, contract maps, tools, binds, resources)
 *    are null-prototype objects, so ``key in map`` and ``map[key]`` are safe for any string key;
 *  - integer-like keys ("0", "17") are rejected in order-significant maps because JS objects iterate
 *    them first (Python keeps insertion order);
 *  - model records and free-form JSON (``dict``/``Any`` fields) are ordinary objects;
 *  - JS has one number type, so float fields holding integral values are serialized with Python's
 *    float repr by the model-aware canonical serializer (``pyd.canonical_text``), which makes package
 *    hashes match Python byte for byte (``error_rate: 0.0`` hashes as ``0.0``, ``max_spend_usd: "1e16"``
 *    as ``1e+16``). It serializes the by-alias dump (``if``, ``schema``), which is the form Python hashes
 *    (``to_json()``/``hash_payload()``); Python never hashes the non-alias dump (``cond``, ``schema_``).
 *  - errors: pydantic's (type, loc) entries, plus the error of any documented deviation the input hits
 *    (see "SOFT" below). Their ORDER can differ when an input dict has integer-like keys ("7"), which JS
 *    objects iterate first (e.g. two extra_forbidden errors).
 */
(function (HX) {
  "use strict";
  const efsm = (HX.efsm = HX.efsm || {});
  const util = HX.util;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  efsm.FALLBACK = "FALLBACK";
  efsm.ABSTAIN = "abstain";
  efsm.LEGACY_ABSTAIN = "\u5f03\u6743"; /* upstream's earlier abstain label */
  efsm.ABSTAIN_LABELS = [efsm.ABSTAIN, efsm.LEGACY_ABSTAIN];
  efsm.VAR_TYPES = ["string", "integer", "number", "boolean", "array", "object"];
  efsm.PROHIBITION_CHECKS = ["absent", "present", "regex", "forbid_action", "require_before"];
  efsm.ACTION_KINDS = ["tool", "model", "judge", "user", "end"];

  /** Machine validation failure (Python: ValueError / pydantic.ValidationError). ``errors`` lists
   *  pydantic-style entries ``{type, loc, msg}``. */
  class EfsmError extends HX.HXError {
    constructor(message, errors, model) {
      super("EFSM_INVALID", message, { errors: errors || [], model: model || "Machine" });
      this.message = message;
      this.errors = errors || [];
      this.model = model || "Machine";
    }
  }
  efsm.EfsmError = EfsmError;

  /* ============================================================================================ */
  /* pyd: pydantic emulation                                                                       */
  /* ============================================================================================ */
  const pyd = (efsm.pyd = {});
  const FAIL = Symbol("FAIL");

  /** Raised by before/after validators; becomes a ``value_error`` at the model's loc. */
  class PyValueError extends Error {}
  /** A Python ``TypeError`` raised inside a validator (pydantic lets it propagate). */
  class PyTypeError extends Error {}
  pyd.PyValueError = PyValueError;
  pyd.PyTypeError = PyTypeError;

  function is_dict(v) { return util.is_plain_object(v); }
  pyd.is_dict = is_dict;

  /** Python truthiness of a JSON-like value. */
  function py_truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (is_dict(v)) return Object.keys(v).length > 0;
    return true;
  }
  pyd.py_truthy = py_truthy;

  /** True for keys JS objects iterate before all others (array indices "0" .. "4294967294"). */
  function is_index_key(k) {
    return /^(?:0|[1-9][0-9]*)$/.test(k) && Number(k) <= 4294967294;
  }
  pyd.is_index_key = is_index_key;

  function set_own(o, k, v) {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  pyd.set_own = set_own;

  /** Deep copy of JSON data (ordinary objects; ``__proto__`` keys stay data). */
  function clone_json(v) {
    if (Array.isArray(v)) return v.map(clone_json);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) set_own(out, k, clone_json(v[k]));
      return out;
    }
    return v;
  }
  pyd.clone_json = clone_json;

  /** Deep copy that keeps each object's prototype (null-prototype maps stay null-prototype). */
  function clone_shape(v) {
    if (Array.isArray(v)) return v.map(clone_shape);
    if (v !== null && typeof v === "object") {
      const out = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
      for (const k of Object.keys(v)) set_own(out, k, clone_shape(v[k]));
      return out;
    }
    return v;
  }
  pyd.clone_shape = clone_shape;

  /* ---- type descriptors (plain data; other files build their own with the same shape) ---- */
  const T = (pyd.T = {
    str: { k: "str" }, int: { k: "int" }, float: { k: "float" }, bool: { k: "bool" }, any: { k: "any" },
    dict: { k: "dict" },
    dict_ordered: { k: "dict", ordered: true },
    list: (of) => ({ k: "list", of }),
    map: (of) => ({ k: "map", of, ordered: true }),
    lit: (...values) => ({ k: "lit", values }),
    opt: (of) => ({ k: "opt", of }),
    model: (m) => ({ k: "model", m }),
    union: (disc, members) => ({ k: "union", disc, members }),
  });

  /** Field spec: ``F(name, type)`` is required; ``F(name, type, {default})``, ``{factory}`` or
   *  ``{model_default: true}`` give defaults. ``alias`` is the serialization and first lookup key;
   *  ``lookup`` lists validation keys in priority order (AliasChoices / populate_by_name). */
  function F(name, type, opts) {
    opts = opts || {};
    const key = opts.alias || name;
    const f = { name, type, key, lookup: opts.lookup || [key] };
    if (hasOwn(opts, "default")) f.default = opts.default;
    else if (opts.factory) f.factory = opts.factory;
    else if (opts.model_default) f.model_default = true;
    else f.required = true;
    return f;
  }
  pyd.F = F;

  function resolve(m) { return typeof m === "function" ? m() : m; }
  pyd.resolve = resolve;

  /* ---- Rust-style trimming and numeric string grammars (pydantic-core lax mode) ---- */
  const RUST_WS = "\\t\\n\\x0b\\x0c\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  const RUST_TRIM = new RegExp("^[" + RUST_WS + "]+|[" + RUST_WS + "]+$", "g");
  const INT_STR = /^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$/;
  const FLOAT_STR = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
  const NONFINITE_STR = /^[+-]?(?:inf|infinity|nan)$/i;
  const BOOL_TRUE = ["1", "on", "t", "true", "y", "yes"];
  const BOOL_FALSE = ["0", "off", "f", "false", "n", "no"];

  function strip_underscores(s) {
    if (s.startsWith("_") || s.endsWith("_") || s.indexOf("__") >= 0 || s.indexOf("_") < 0) return null;
    return s.replace(/_/g, "");
  }

  /** pydantic lax str->int. Returns a safe integer, or an error type string. Accepts the grammar
   *  ``[+-]?digits(_digits)*(.0+)?`` after Rust-style trimming (pydantic also accepts some odd forms such
   *  as "0-1"; those are rejected here, see deviations/models.md). More than 4300 significant digits is
   *  ``int_parsing_size`` as in pydantic-core. */
  function str_to_int(v) {
    const s = v.replace(RUST_TRIM, "");
    if (!INT_STR.test(s)) return "int_parsing";
    let t = s.replace(/_/g, "");
    const dot = t.indexOf(".");
    if (dot >= 0) t = t.slice(0, dot);
    if (t.replace(/^[+-]?0*/, "").length > 4300) return "int_parsing_size";
    const n = Number(t);
    if (!Number.isSafeInteger(n)) return "int_unsafe";
    return n === 0 ? 0 : n;
  }
  pyd.str_to_int = str_to_int;

  /** pydantic lax str->float. Returns a finite number, or an error type string. pydantic-core parses the
   *  trimmed string first and, failing that, the UNTRIMMED string with underscores removed (so " 1_0" is
   *  rejected while "1_0" is 10.0). Python accepts inf/nan words and overflow; those are rejected here. */
  function str_to_float(v) {
    const s = v.replace(RUST_TRIM, "");
    const u = strip_underscores(v);
    let t = FLOAT_STR.test(s) ? s : null;
    if (t === null && u !== null && FLOAT_STR.test(u)) t = u;
    if (t === null) {
      return NONFINITE_STR.test(s) || (u !== null && NONFINITE_STR.test(u)) ? "finite_number" : "float_parsing";
    }
    const n = Number(t);
    if (!Number.isFinite(n)) return "finite_number";
    return n; /* "-0" parses as the float -0.0, as in Python */
  }
  pyd.str_to_float = str_to_float;

  /** pydantic lax str->bool (case-insensitive word list, no trimming). */
  function str_to_bool(v) {
    const l = v.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (BOOL_TRUE.indexOf(l) >= 0) return true;
    if (BOOL_FALSE.indexOf(l) >= 0) return false;
    return "bool_parsing";
  }
  pyd.str_to_bool = str_to_bool;

  /* ---- error messages (close to pydantic's wording) ---- */
  const MSG = {
    missing: "Field required",
    extra_forbidden: "Extra inputs are not permitted",
    string_type: "Input should be a valid string",
    string_unicode: "Input should be a valid string (lone surrogates are not supported by the JS port)",
    int_type: "Input should be a valid integer",
    int_from_float: "Input should be a valid integer, got a number with a fractional part",
    int_parsing: "Input should be a valid integer, unable to parse string as an integer",
    int_parsing_size: "Unable to parse input string as an integer, exceeded maximum size",
    int_unsafe: "Input should be an integer within +/-(2^53-1) (JS port limit)",
    finite_number: "Input should be a finite number",
    float_type: "Input should be a valid number",
    float_parsing: "Input should be a valid number, unable to parse string as a number",
    bool_type: "Input should be a valid boolean",
    bool_parsing: "Input should be a valid boolean, unable to interpret input",
    list_type: "Input should be a valid list",
    dict_type: "Input should be a valid dictionary",
    model_attributes_type: "Input should be a valid dictionary or object to extract fields from",
    json_invalid: "Input should be plain JSON data",
    dict_key_integer_like: "Integer-like keys are not supported in this mapping by the JS port (JS objects reorder them)",
    union_tag_not_found: "Unable to extract tag using discriminator",
  };

  function push(errs, type, loc, msg) {
    errs.push({ type, loc: loc.slice(), msg: msg || MSG[type] || type });
  }

  function lit_msg(values) {
    const q = values.map((x) => util.py_repr(x));
    return "Input should be " + (q.length > 1 ? q.slice(0, -1).join(", ") + " or " + q[q.length - 1] : q[0]);
  }

  /* ---- validators ---- */
  /* A value rejected only by a documented deviation (Python accepts it: non-JSON ``Any`` data, lone
   * surrogates in ``str`` fields and map keys, integer-like map keys, integers beyond 2^53, non-finite
   * floats) is a SOFT failure: the error is reported, but the value still takes part in validating its
   * container, so the model validators pydantic would run still run and their errors are reported too.
   * The overall result fails either way; the port's error list is a superset of pydantic's. */
  class Soft {
    constructor(value) { this.value = value; }
  }
  function soft(errs, type, loc, value, msg) {
    push(errs, type, loc, msg);
    return new Soft(value);
  }

  function v_any(v, loc, errs) {
    try {
      HX.canonical.check_value(v);
    } catch (e) {
      return soft(errs, "json_invalid", loc, v, MSG.json_invalid + ": " + e.message);
    }
    return clone_json(v);
  }

  function v_type(d, v, loc, errs) {
    switch (d.k) {
      case "str":
        if (typeof v === "string") {
          if (util.has_lone_surrogate(v)) return soft(errs, "string_unicode", loc, v);
          return v;
        }
        push(errs, "string_type", loc);
        return FAIL;
      case "int": {
        if (typeof v === "boolean") return v ? 1 : 0;
        let r;
        if (typeof v === "number") {
          if (!Number.isFinite(v)) r = "finite_number";
          else if (!Number.isInteger(v)) r = "int_from_float";
          else if (!Number.isSafeInteger(v)) return soft(errs, "int_unsafe", loc, v);
          else return v === 0 ? 0 : v;
        } else if (typeof v === "string") {
          /* pydantic-core reads the str as UTF-8 first: a lone surrogate is string_unicode */
          r = util.has_lone_surrogate(v) ? "string_unicode" : str_to_int(v);
          if (typeof r === "number") return r;
          if (r === "int_unsafe") return soft(errs, r, loc, v);
        } else r = "int_type";
        push(errs, r, loc);
        return FAIL;
      }
      case "float": {
        if (typeof v === "boolean") return v ? 1 : 0;
        let r;
        if (typeof v === "number") {
          if (Number.isFinite(v)) return v === 0 ? 0 : v;
          return soft(errs, "finite_number", loc, v);
        } else if (typeof v === "string") {
          r = util.has_lone_surrogate(v) ? "string_unicode" : str_to_float(v);
          if (typeof r === "number") return r;
          if (r === "finite_number") return soft(errs, r, loc, v);
        } else r = "float_type";
        push(errs, r, loc);
        return FAIL;
      }
      case "bool": {
        if (typeof v === "boolean") return v;
        let r;
        if (typeof v === "number") {
          if (v === 0) return false;
          if (v === 1) return true;
          /* pydantic-core reads the number as an int64: outside that range it is not even a candidate */
          r = Number.isInteger(v) && v >= -9223372036854775808 && v < 9223372036854775808 ? "bool_parsing" : "bool_type";
        } else if (typeof v === "string") {
          r = util.has_lone_surrogate(v) ? "string_unicode" : str_to_bool(v);
          if (typeof r === "boolean") return r;
        } else r = "bool_type";
        push(errs, r, loc);
        return FAIL;
      }
      case "any":
        return v_any(v, loc, errs);
      case "dict": {
        if (!is_dict(v)) { push(errs, "dict_type", loc); return FAIL; }
        let softened = false;
        if (d.ordered) {
          for (const k of Object.keys(v)) {
            if (is_index_key(k)) { push(errs, "dict_key_integer_like", loc.concat([k])); softened = true; }
          }
        }
        const out = v_any(v, loc, errs);
        return softened && !(out instanceof Soft) ? new Soft(out) : out;
      }
      case "list": {
        if (!Array.isArray(v)) { push(errs, "list_type", loc); return FAIL; }
        const out = new Array(v.length);
        let bad = false, softened = false;
        for (let i = 0; i < v.length; i++) {
          const x = v_type(d.of, v[i], loc.concat([i]), errs);
          if (x === FAIL) bad = true;
          else if (x instanceof Soft) { out[i] = x.value; softened = true; }
          else out[i] = x;
        }
        return bad ? FAIL : softened ? new Soft(out) : out;
      }
      case "map": {
        if (!is_dict(v)) { push(errs, "dict_type", loc); return FAIL; }
        const out = Object.create(null);
        let bad = false, softened = false;
        for (const k of Object.keys(v)) {
          /* Python accepts both keys (soft); the value is still validated */
          if (util.has_lone_surrogate(k)) { push(errs, "string_unicode", loc.concat([k])); softened = true; }
          else if (d.ordered && is_index_key(k)) { push(errs, "dict_key_integer_like", loc.concat([k])); softened = true; }
          const x = v_type(d.of, v[k], loc.concat([k]), errs);
          if (x === FAIL) bad = true;
          else if (x instanceof Soft) { set_own(out, k, x.value); softened = true; }
          else set_own(out, k, x);
        }
        return bad ? FAIL : softened ? new Soft(out) : out;
      }
      case "lit":
        if (typeof v === "string" && util.has_lone_surrogate(v)) { push(errs, "string_unicode", loc); return FAIL; }
        if (d.values.indexOf(v) >= 0) return v;
        push(errs, "literal_error", loc, lit_msg(d.values));
        return FAIL;
      case "opt":
        if (v === null) return null;
        return v_type(d.of, v, loc, errs);
      case "model":
        return v_model(resolve(d.m), v, loc, errs);
      case "union": {
        if (!is_dict(v)) { push(errs, "model_attributes_type", loc); return FAIL; }
        if (!hasOwn(v, d.disc)) {
          push(errs, "union_tag_not_found", loc, "Unable to extract tag using discriminator " + util.py_repr(d.disc));
          return FAIL;
        }
        const tag = v[d.disc];
        const tags = Object.keys(d.members);
        if (typeof tag !== "string" || tags.indexOf(tag) < 0) {
          const shown = typeof tag === "string" ? tag : util.py_repr(tag);
          push(errs, "union_tag_invalid", loc, "Input tag " + util.py_repr(shown) + " found using " + util.py_repr(d.disc) +
            " does not match any of the expected tags: " + tags.map((x) => util.py_repr(x)).join(", "));
          return FAIL;
        }
        return v_model(resolve(d.members[tag]), v, loc.concat([tag]), errs);
      }
      default:
        throw new Error("unknown type descriptor " + d.k);
    }
  }

  function field_default(f) {
    if (hasOwn(f, "default")) return clone_json(f.default);
    if (f.factory) return f.factory();
    if (f.model_default) {
      const errs = [];
      const out = v_model(resolve(f.type.m), {}, [], errs);
      if (errs.length) throw new Error("model default for " + f.name + " is invalid");
      return out;
    }
    throw new Error("field " + f.name + " has no default");
  }

  function v_model(spec, v, loc, errs) {
    if (!is_dict(v)) {
      push(errs, "model_type", loc, "Input should be a valid dictionary or instance of " + spec.name);
      return FAIL;
    }
    if (spec.before) {
      try {
        v = spec.before(v);
      } catch (e) {
        if (e instanceof PyValueError) { push(errs, "value_error", loc, "Value error, " + e.message); return FAIL; }
        if (e instanceof PyTypeError) { push(errs, "python_type_error", loc, "TypeError: " + e.message); return FAIL; }
        throw e;
      }
    }
    /* pydantic-core reads every input key as UTF-8 before validating fields: one key with a lone
       surrogate fails the whole model with a single string_unicode error at the model's loc */
    for (const k of Object.keys(v)) {
      if (util.has_lone_surrogate(k)) { push(errs, "string_unicode", loc); return FAIL; }
    }
    const used = new Set();
    const vals = new Array(spec.fields.length);
    let hard = false, softened = false;
    for (let i = 0; i < spec.fields.length; i++) {
      const f = spec.fields[i];
      let key = null;
      for (const k of f.lookup) if (hasOwn(v, k)) { key = k; break; }
      if (key === null) {
        if (f.required) { push(errs, "missing", loc.concat([f.lookup[0]])); hard = true; continue; }
        vals[i] = field_default(f);
        continue;
      }
      used.add(key);
      const x = v_type(f.type, v[key], loc.concat([key]), errs);
      if (x === FAIL) hard = true;
      else if (x instanceof Soft) { vals[i] = x.value; softened = true; }
      else vals[i] = x;
    }
    const extras = [];
    for (const k of Object.keys(v)) {
      if (used.has(k)) continue;
      if (spec.extra === "allow") {
        const x = v_any(v[k], loc.concat([k]), errs);
        if (x instanceof Soft) { extras.push([k, x.value]); softened = true; }
        else extras.push([k, x]);
      } else {
        push(errs, "extra_forbidden", loc.concat([k]));
        hard = true;
      }
    }
    if (hard) return FAIL;
    const out = {};
    for (let i = 0; i < spec.fields.length; i++) out[spec.fields[i].key] = vals[i];
    for (const [k, x] of extras) set_own(out, k, x);
    if (spec.after) {
      try {
        spec.after(out);
      } catch (e) {
        if (e instanceof PyValueError) { push(errs, "value_error", loc, "Value error, " + e.message); return FAIL; }
        throw e;
      }
    }
    return softened ? new Soft(out) : out;
  }

  /** Validate ``value`` against a model spec. Returns ``{value, errors}``; ``value`` is the
   *  normalized dump (``undefined`` when errors is non-empty). */
  pyd.validate = function (spec, value, loc) {
    const errs = [];
    const out = v_model(resolve(spec), value, loc || [], errs);
    return { value: errs.length ? undefined : out, errors: errs };
  };

  /** Validate a value against any type descriptor. */
  pyd.validate_type = function (d, value, loc) {
    const errs = [];
    const out = v_type(d, value, loc || [], errs);
    return { value: errs.length ? undefined : out, errors: errs };
  };

  /** pydantic-style multi-line message. */
  pyd.format_errors = function (name, errs) {
    const lines = [errs.length + " validation error" + (errs.length === 1 ? "" : "s") + " for " + name];
    for (const e of errs.slice(0, 20)) {
      lines.push(e.loc.length ? e.loc.join(".") : "<root>");
      lines.push("  " + e.msg + " [type=" + e.type + "]");
    }
    if (errs.length > 20) lines.push("... " + (errs.length - 20) + " more");
    return lines.join("\n");
  };

  /** Validate or throw ``new ErrCls(message, errors, name)``. */
  pyd.model_validate = function (spec, value, ErrCls) {
    spec = resolve(spec);
    const r = pyd.validate(spec, value);
    if (r.errors.length) throw new ErrCls(pyd.format_errors(spec.name, r.errors), r.errors, spec.name);
    return r.value;
  };

  /* ---- model-aware canonical serialization (Python float fields keep their float repr) ---- */
  function plain(v, out) {
    if (v === null) { out.push("null"); return; }
    if (v === true) { out.push("true"); return; }
    if (v === false) { out.push("false"); return; }
    if (typeof v === "number") { out.push(HX.canonical.py_number(v)); return; }
    if (typeof v === "string") { out.push(JSON.stringify(v)); return; }
    if (Array.isArray(v)) {
      out.push("[");
      for (let i = 0; i < v.length; i++) { if (i) out.push(","); plain(v[i], out); }
      out.push("]");
      return;
    }
    const keys = util.sorted_keys(v);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i) out.push(",");
      out.push(JSON.stringify(keys[i]), ":");
      plain(v[keys[i]], out);
    }
    out.push("}");
  }

  function typed(d, v, out) {
    if (d) {
      switch (d.k) {
        case "float":
          if (typeof v === "number") { out.push(HX.canonical.py_float_repr(v)); return; }
          break;
        case "opt":
          if (v === null) { out.push("null"); return; }
          typed(d.of, v, out);
          return;
        case "list":
          if (Array.isArray(v)) {
            out.push("[");
            for (let i = 0; i < v.length; i++) { if (i) out.push(","); typed(d.of, v[i], out); }
            out.push("]");
            return;
          }
          break;
        case "map":
          if (is_dict(v)) { obj(v, () => d.of, out); return; }
          break;
        case "model":
          if (is_dict(v)) { model_obj(resolve(d.m), v, out); return; }
          break;
        case "union":
          if (is_dict(v) && typeof v[d.disc] === "string" && hasOwn(d.members, v[d.disc])) {
            model_obj(resolve(d.members[v[d.disc]]), v, out);
            return;
          }
          break;
        default:
          break;
      }
    }
    plain(v, out);
  }

  function obj(v, type_of, out) {
    const keys = util.sorted_keys(v);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i) out.push(",");
      out.push(JSON.stringify(keys[i]), ":");
      typed(type_of(keys[i]), v[keys[i]], out);
    }
    out.push("}");
  }

  function model_obj_types(spec) {
    if (!spec._by_key) {
      const m = Object.create(null);
      for (const f of spec.fields) m[f.key] = f.type;
      Object.defineProperty(spec, "_by_key", { value: m, enumerable: false });
    }
    return spec._by_key;
  }

  function model_obj(spec, v, out) {
    const types = model_obj_types(spec);
    obj(v, (k) => types[k], out);
  }

  /** ``HX.canonical.check_value`` with the model's float typing: a number in a float-typed position only
   *  has to be finite. Python holds a float there and prints its repr (``1e+16``), so integral values
   *  beyond 2^53 (e.g. ``max_spend_usd: "1e16"``) are fine; everywhere else the plain rules apply. */
  function typed_check(d, v, depth) {
    if (depth > HX.canonical.MAX_DEPTH) throw new HX.canonical.CanonicalError("nesting too deep");
    if (d) {
      switch (d.k) {
        case "float":
          if (typeof v === "number") {
            if (!Number.isFinite(v)) throw new HX.canonical.CanonicalError("non-finite number");
            return;
          }
          break;
        case "opt":
          if (v === null) return;
          typed_check(d.of, v, depth);
          return;
        case "list":
          if (Array.isArray(v)) {
            for (const x of v) typed_check(d.of, x, depth + 1);
            return;
          }
          break;
        case "map":
          if (is_dict(v)) {
            obj_check(v, () => d.of, depth);
            return;
          }
          break;
        case "model":
          if (is_dict(v)) {
            model_check(resolve(d.m), v, depth);
            return;
          }
          break;
        case "union":
          if (is_dict(v) && typeof v[d.disc] === "string" && hasOwn(d.members, v[d.disc])) {
            model_check(resolve(d.members[v[d.disc]]), v, depth);
            return;
          }
          break;
        default:
          break;
      }
    }
    HX.canonical.check_value(v, depth);
  }

  function obj_check(v, type_of, depth) {
    for (const k of Object.keys(v)) {
      HX.canonical.check_value(k, depth + 1); /* key: string limits and lone surrogates */
      typed_check(type_of(k), v[k], depth + 1);
    }
  }

  function model_check(spec, v, depth) {
    model_obj_types(spec);
    obj_check(v, (k) => spec._by_key[k], depth);
  }

  /** Canonical JSON text of a model dump, byte-identical to Python's
   *  ``canonical_bytes(model.model_dump(mode="json", by_alias=True))`` (the dump the Python code hashes:
   *  ``to_json()``/``hash_payload()``), even for integral values of float fields, including values beyond
   *  2^53 (``1e+16``). Aliased fields use their alias (``if``, ``schema``). */
  pyd.canonical_text = function (type, value) {
    typed_check(type, value, 0);
    const out = [];
    typed(type, value, out);
    return out.join("");
  };

  pyd.digest = function (type, value) {
    return "sha256:" + HX.canonical.sha256_hex(pyd.canonical_text(type, value));
  };

  /** Public model handle: ``Model.model_validate(obj)`` returns the normalized dump; ``Model.digest`` /
   *  ``Model.canonical_text`` are ``digest`` / ``canonical_bytes`` of ``model_dump(mode="json",
   *  by_alias=True)`` with Python float typing (for models without aliases that equals the plain dump). */
  function model_api(spec, ErrCls) {
    return {
      name: spec.name,
      spec,
      model_fields: spec.fields.map((f) => f.name),
      model_validate(value) { return pyd.model_validate(spec, value, ErrCls); },
      canonical_text(value) { return pyd.canonical_text({ k: "model", m: spec }, pyd.model_validate(spec, value, ErrCls)); },
      digest(value) { return pyd.digest({ k: "model", m: spec }, pyd.model_validate(spec, value, ErrCls)); },
    };
  }
  pyd.model_api = model_api;

  /* ============================================================================================ */
  /* efsm-v1 models                                                                                */
  /* ============================================================================================ */
  const MODELS = (efsm.MODELS = Object.create(null));
  function model(name, fields, opts) {
    const m = Object.assign({ name, fields, extra: "forbid" }, opts || {});
    MODELS[name] = m;
    return m;
  }

  function get(d, k) { return hasOwn(d, k) ? d[k] : null; }

  model("Variable", [
    F("name", T.str),
    F("type", T.lit(...efsm.VAR_TYPES), { default: "string" }),
    F("init", T.opt(T.any), { default: null }),
    F("init_from", T.opt(T.str), { default: null }),
  ], {
    after(v) {
      if (v.init !== null && v.init_from !== null) {
        throw new PyValueError("variable " + v.name + ": give only one of init and init_from");
      }
    },
  });

  model("ToolAction", [
    F("kind", T.lit("tool"), { default: "tool" }),
    F("name", T.str),
    F("input", T.dict_ordered, { default: {} }),
    F("reads", T.list(T.str), { default: [] }),
    F("writes", T.list(T.str), { default: [] }),
    F("phase", T.str, { default: "" }),
    F("labels", T.list(T.str), { default: [] }),
    F("binds", T.map(T.str), { factory: () => Object.create(null) }),
  ]);

  model("ModelAction", [
    F("kind", T.lit("model"), { default: "model" }),
    F("prompt", T.str),
    F("reads", T.list(T.str), { default: [] }),
    F("writes", T.list(T.str), { default: [] }),
    F("introduced", T.bool, { default: false }),
    F("observable", T.bool, { default: false }),
    F("labels", T.list(T.str), { default: [] }),
  ]);

  model("Example", [F("label", T.str)], { extra: "allow" });

  model("JudgeAction", [
    F("kind", T.lit("judge"), { default: "judge" }),
    F("prompt", T.str, { lookup: ["prompt", "question"] }),
    F("reads", T.list(T.str)),
    F("writes", T.list(T.str)),
    F("labels", T.list(T.str)),
    F("abstain", T.str, { default: efsm.ABSTAIN }),
    F("examples", T.list(T.model(() => MODELS.Example)), { default: [] }),
    F("error_rate", T.float, { default: 0 }),
    F("support", T.int, { default: 0 }),
    F("introduced", T.bool, { default: false }),
    F("gold_from", T.str, { default: "" }),
  ], {
    /* _default_abstain (mode="before") */
    before(data) {
      if (py_truthy(get(data, "abstain"))) return data;
      const labels = get(data, "labels");
      let list;
      if (!py_truthy(labels)) list = [];
      else if (Array.isArray(labels)) list = labels;
      else if (typeof labels === "string") list = Array.from(labels);
      else if (is_dict(labels)) list = Object.keys(labels);
      else throw new PyTypeError("'" + (typeof labels === "boolean" ? "bool" : typeof labels === "number" ? (Number.isInteger(labels) ? "int" : "float") : typeof labels) + "' object is not iterable");
      let found = "";
      for (let i = list.length - 1; i >= 0; i--) {
        if (efsm.ABSTAIN_LABELS.indexOf(list[i]) >= 0) { found = list[i]; break; }
      }
      const out = {};
      for (const k of Object.keys(data)) set_own(out, k, data[k]);
      set_own(out, "abstain", found || efsm.ABSTAIN);
      return out;
    },
    /* _checks (mode="after") */
    after(a) {
      if (a.labels.indexOf(a.abstain) < 0) {
        throw new PyValueError("judge abstain label " + util.py_repr(a.abstain) + " must be in labels");
      }
      if (!a.reads.length || !a.writes.length) throw new PyValueError("a judge action needs non-empty reads and writes");
      if (a.writes.length !== 1) throw new PyValueError("a judge action writes exactly one label variable");
    },
  });

  model("UserAction", [
    F("kind", T.lit("user"), { default: "user" }),
    F("prompt", T.str, { default: "" }),
    F("reads", T.list(T.str), { default: [] }),
    F("writes", T.list(T.str), { default: [] }),
    F("labels", T.list(T.str), { default: [] }),
  ]);

  model("EndAction", [
    F("kind", T.lit("end"), { default: "end" }),
    F("terminal", T.str),
  ]);

  const ACTION = T.union("kind", {
    tool: () => MODELS.ToolAction, model: () => MODELS.ModelAction, judge: () => MODELS.JudgeAction,
    user: () => MODELS.UserAction, end: () => MODELS.EndAction,
  });
  efsm.ACTION_TYPE = ACTION;

  model("Transition", [
    F("cond", T.str, { alias: "if", lookup: ["if", "cond"], default: "" }),
    F("to", T.str),
    F("inc", T.opt(T.str), { default: null }),
    F("support", T.int, { default: 0 }),
    F("origin", T.str, { default: "" }),
  ]);

  model("State", [
    F("id", T.str),
    F("clause", T.str, { default: "" }),
    F("action", ACTION),
    F("transitions", T.list(T.model(() => MODELS.Transition)), { default: [] }),
    F("origin", T.str, { default: "" }),
    F("locator", T.str, { default: "" }),
  ]);

  model("Terminal", [
    F("id", T.str),
    F("kind", T.str, { default: "" }),
    F("output", T.list(T.str), { default: [] }),
  ]);

  model("Prohibition", [
    F("id", T.str),
    F("check", T.lit(...efsm.PROHIBITION_CHECKS)),
    F("pattern", T.any),
  ]);

  model("Thresholds", [
    F("min_support", T.int, { default: 2 }),
    F("holdout_ratio", T.float, { default: 0.2 }),
    F("acc_thr", T.float, { default: 0.9 }),
    F("retry_budget", T.int, { default: 3 }),
    F("loop_margin", T.float, { default: 1.5 }),
    F("fallback_rate_target", T.float, { default: 0.15 }),
    F("judge_rewrite_max", T.int, { default: 2 }),
    F("judge_err_max", T.float, { default: 0.2 }),
  ]);

  model("Machine", [
    F("format", T.lit("efsm-v1"), { default: "efsm-v1" }),
    F("skill_id", T.str),
    F("version", T.str, { default: "0.1.0" }),
    F("initial", T.str),
    F("fallback", T.str, { default: efsm.FALLBACK }),
    F("max_steps", T.int, { default: 24 }),
    F("states", T.map(T.model(() => MODELS.State)), { factory: () => Object.create(null) }),
    F("variables", T.list(T.model(() => MODELS.Variable)), { default: [] }),
    F("terminals", T.list(T.model(() => MODELS.Terminal)), { default: [] }),
    F("prohibitions", T.list(T.model(() => MODELS.Prohibition)), { default: [] }),
    F("thresholds", T.model(() => MODELS.Thresholds), { model_default: true }),
    F("audit_tools", T.list(T.str), { default: [] }),
    F("phase_rules", T.str, { default: "" }),
  ]);

  for (const name of Object.keys(MODELS)) efsm[name] = model_api(MODELS[name], EfsmError);
  efsm.MACHINE_TYPE = T.model(() => MODELS.Machine);

  /* ============================================================================================ */
  /* public API (mirrors efsm.py)                                                                 */
  /* ============================================================================================ */

  /** ``load_machine(data)``: format check, then ``Machine.model_validate``. Returns the normalized
   *  dump (a new object). Throws EfsmError. */
  efsm.load_machine = function (data) {
    if (!is_dict(data) || !hasOwn(data, "format") || data.format !== "efsm-v1") {
      const fmt = is_dict(data) && hasOwn(data, "format") ? data.format : null;
      const msg = "not an efsm-v1 machine (format=" + util.py_repr(fmt) + ")";
      throw new EfsmError(msg, [{ type: "value_error", loc: ["format"], msg }], "Machine");
    }
    return pyd.model_validate(MODELS.Machine, data, EfsmError);
  };

  /** ``State.ordered_transitions()``: guarded edges in declaration order, then the default edge(s).
   *  Returns the same transition objects. */
  efsm.ordered_transitions = function (state) {
    const ts = state.transitions || [];
    return ts.filter((t) => !!t["if"]).concat(ts.filter((t) => !t["if"]));
  };

  /** ``Machine.var(name)``: the first variable with that name, or null. */
  efsm.var = function (machine, name) {
    for (const v of machine.variables) if (v.name === name) return v;
    return null;
  };

  /** ``Machine.var_types()``: null-prototype ``{name: type}`` (later duplicates win, first position kept). */
  efsm.var_types = function (machine) {
    const out = Object.create(null);
    for (const v of machine.variables) set_own(out, v.name, v.type);
    return out;
  };

  /** ``Machine.terminal(tid)``: the first terminal with that id, or null. */
  efsm.terminal = function (machine, tid) {
    for (const t of machine.terminals) if (t.id === tid) return t;
    return null;
  };

  /** ``Machine.to_json()``: a fresh normalized dump (upstream key names, transition order kept). */
  efsm.to_json = function (machine) {
    return pyd.model_validate(MODELS.Machine, machine, EfsmError);
  };

  /** Canonical digest of a machine dump with Python float typing (``digest(machine.to_json())``). */
  efsm.machine_digest = function (machine) {
    return pyd.digest(efsm.MACHINE_TYPE, efsm.to_json(machine));
  };
})(globalThis.HX = globalThis.HX || {});
