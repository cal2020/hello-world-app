/* Port of hexis_service/runtime/kernel.py: the pure transition kernel (brief §7.1).
 *
 * ``advance`` performs no network access, model calls, storage writes, randomness or clock reads.
 * Everything external arrives inside a recorded Observation. Given the same checkpoint, observation and
 * package, it returns the same result.
 *
 * Data shapes:
 *  - RunCheckpoint, Observation, Budget and Assurance are plain objects with exactly the fields of
 *    ``model_dump(mode="json")`` (every default present, declaration order). Build them from untrusted
 *    data with ``new_checkpoint(fields)`` / ``new_observation(fields)`` (or ``RunCheckpoint.model_validate``),
 *    which apply pydantic's validation (extra="forbid", Literal kind/status, lax int coercions) and throw
 *    ``HX.kernel.ValidationError`` like ``pydantic.ValidationError``.
 *  - ``advance(checkpoint, obs, package)`` takes such dumps (Python takes the model instances) and a
 *    normalized package dump (``HX.pkg.normalize_package``). It never mutates its inputs: everything it
 *    returns is a fresh copy (Python copies with model_copy/deepcopy).
 *  - ``KernelResult`` is ``{checkpoint, events, delta, edge}``.
 *  - Python tuples become arrays: ``resolve_path`` returns ``[found, value]``, ``select_edge`` returns
 *    ``[index, error]``.
 *
 * Python built-in exceptions that escape the reference on malformed input (KeyError, TypeError,
 * AttributeError, ValueError) are ``HX.HXError`` with the Python class name as ``code``.
 */
(function (HX) {
  "use strict";
  const kernel = (HX.kernel = HX.kernel || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  kernel.STATUSES = Object.freeze(["READY", "RUNNING", "WAITING_FOR_INPUT", "WAITING_FOR_APPROVAL", "RECONCILING",
    "COMPLETED", "FAILED", "CANCELLED"]);
  kernel.TERMINAL_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED"]);
  kernel.OBSERVATION_KINDS = Object.freeze(["tool", "model", "judge", "user", "end"]);

  class KernelError extends HX.HXError {
    constructor(code, message, detail) {
      super(code, message, detail || {});
      this.message = message; /* Python: exc.message (str(exc) is "CODE: message") */
    }
    toString() { return this.code + ": " + this.message; }
  }
  kernel.KernelError = KernelError;

  /** pydantic.ValidationError for RunCheckpoint / Observation / Budget / Assurance. */
  class ValidationError extends HX.HXError {
    constructor(message, errors, model) {
      super("VALIDATION_ERROR", message, { errors: errors || [], model: model || "" });
      this.message = message;
      this.errors = errors || [];
      this.model = model || "";
    }
  }
  kernel.ValidationError = ValidationError;

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }
  kernel._pyerr = pyerr;

  /* ------------------------------------------------------------------------------------------ */
  /* Python value semantics                                                                       */
  /* ------------------------------------------------------------------------------------------ */
  const is_dict = (v) => HX.util.is_plain_object(v);

  function set_own(o, k, v) {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }

  /** Deep copy of JSON data; null-prototype maps become ordinary objects (``__proto__`` stays data). */
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) set_own(out, k, clone(v[k]));
      return out;
    }
    return v;
  }
  kernel._clone = clone;

  function py_type_name(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") return "dict";
    return typeof v;
  }
  kernel._py_type_name = py_type_name;

  function repr_str(s) {
    return HX.guards && HX.guards._py_repr_str ? HX.guards._py_repr_str(s) : HX.util.py_repr(s);
  }

  /** Python repr() of a JSON value. */
  function pyr(v) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return HX.canonical.py_number(v);
    if (typeof v === "string") return repr_str(v);
    if (Array.isArray(v)) return "[" + v.map(pyr).join(", ") + "]";
    if (typeof v === "object") return "{" + Object.keys(v).map((k) => repr_str(k) + ": " + pyr(v[k])).join(", ") + "}";
    return String(v);
  }
  kernel._py_repr = pyr;

  function py_truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  kernel._py_truthy = py_truthy;

  /** Python list(x) of a JSON value (shallow, like Python). ``list(dict)`` is the keys in insertion order,
   *  which a JS object cannot give back once an integer-like key ("7") is among several keys: such a dict
   *  raises (JS-only ``KEY_ORDER_UNKNOWN``) instead of returning a possibly reordered list. */
  function py_list(v) {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (is_dict(v)) {
      const keys = Object.keys(v);
      if (keys.length > 1 && keys.some((k) => /^(?:0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295)) {
        throw pyerr("KEY_ORDER_UNKNOWN", "list() of a dict with integer-like keys " + pyr(keys) +
          ": the JavaScript port cannot recover their insertion order");
      }
      return keys;
    }
    throw pyerr("TypeError", "'" + py_type_name(v) + "' object is not iterable");
  }
  kernel._py_list = py_list;

  /** ``x.get(key, default)`` on a value that should be a dict (AttributeError otherwise). */
  function py_get(d, key, dflt) {
    if (!is_dict(d)) throw pyerr("AttributeError", "'" + py_type_name(d) + "' object has no attribute 'get'");
    return hasOwn(d, key) ? d[key] : dflt;
  }

  const INT_WS = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
  /** Python int(x) for JSON values (ASCII digit strings only). */
  function py_int(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        throw pyerr(Number.isNaN(v) ? "ValueError" : "OverflowError", "cannot convert float " +
          (Number.isNaN(v) ? "NaN" : "infinity") + " to integer");
      }
      const t = Math.trunc(v);
      return t === 0 ? 0 : t;
    }
    if (typeof v === "string") {
      /* the whitespace CPython's int() strips (not str.isspace: U+001C..U+001F are refused, U+FEFF too) */
      const s = v.replace(INT_WS, "");
      if (/^[+-]?[0-9](?:_?[0-9])*$/.test(s)) {
        const n = Number(s.replace(/_/g, ""));
        if (!Number.isSafeInteger(n)) {
          throw pyerr("ValueError", "integer " + s + " is outside the range supported by the JavaScript port");
        }
        return n === 0 ? 0 : n;
      }
      throw pyerr("ValueError", "invalid literal for int() with base 10: " + repr_str(v));
    }
    throw pyerr("TypeError", "int() argument must be a string, a bytes-like object or a real number, not '" +
      py_type_name(v) + "'");
  }
  kernel._py_int = py_int;

  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  const sorted = (xs) => xs.slice().sort(cmp);

  /* ------------------------------------------------------------------------------------------ */
  /* Models (pydantic emulation via HX.efsm.pyd)                                                 */
  /* ------------------------------------------------------------------------------------------ */
  let SPECS = null;
  function specs() {
    if (SPECS) return SPECS;
    const pyd = HX.efsm.pyd, T = pyd.T, F = pyd.F;
    const S = {};
    const model = (name, fields) => (S[name] = { name, fields, extra: "forbid" });
    model("Budget", [
      F("steps", T.int, { default: 0 }), F("tool_calls", T.int, { default: 0 }),
      F("model_calls", T.int, { default: 0 }), F("tokens", T.int, { default: 0 }),
      F("output_repairs", T.int, { default: 0 }),
    ]);
    model("Assurance", [
      F("entered_fallback", T.bool, { default: false }),
      F("fallback_reason", T.str, { default: "" }),
      F("missing_evidence", T.list(T.str), { default: [] }),
      F("policy_violations", T.list(T.str), { default: [] }),
      F("unresolved_effects", T.list(T.str), { default: [] }),
      F("verification_scope", T.str, { default: "" }),
      F("diagnostics", T.list(T.dict), { default: [] }),
    ]);
    model("RunCheckpoint", [
      F("record_schema", T.lit("hexis-checkpoint/1"), { default: "hexis-checkpoint/1" }),
      F("tenant_id", T.str), F("run_id", T.str), F("artifact_hash", T.str), F("state_id", T.str),
      F("revision", T.int, { default: 0 }),
      F("variables", T.dict),
      F("budget", T.model(() => S.Budget), { model_default: true }),
      F("status", T.lit(...kernel.STATUSES), { default: "RUNNING" }),
      F("outcome", T.opt(T.dict), { default: null }),
      F("assurance", T.model(() => S.Assurance), { model_default: true }),
      F("evidence_refs", T.list(T.str), { default: [] }),
    ]);
    model("Observation", [
      F("record_schema", T.lit("hexis-observation/1"), { default: "hexis-observation/1" }),
      F("run_id", T.str), F("state_id", T.str), F("revision", T.int),
      F("kind", T.lit(...kernel.OBSERVATION_KINDS)),
      F("outputs", T.dict, { default: {} }),
      F("actor", T.str, { default: "" }),
      F("receipt_ref", T.str, { default: "" }),
      F("usage", { k: "map", of: T.int }, { factory: () => Object.create(null) }),
      F("engine", T.dict, { default: {} }),
      F("failure", T.str, { default: "" }),
    ]);
    SPECS = S;
    return S;
  }

  function validate_model(name, value) {
    const spec = specs()[name];
    const out = HX.efsm.pyd.model_validate(spec, value, ValidationError);
    return clone(out); /* null-prototype maps (usage) become ordinary objects */
  }

  function model_api(name) {
    return {
      name,
      get model_fields() { return specs()[name].fields.map((f) => f.name); },
      model_validate(value) { return validate_model(name, value); },
      digest(value) { return HX.canonical.digest(validate_model(name, value)); },
    };
  }
  kernel.Budget = model_api("Budget");
  kernel.Assurance = model_api("Assurance");
  kernel.RunCheckpoint = model_api("RunCheckpoint");
  kernel.Observation = model_api("Observation");

  /** ``RunCheckpoint(**fields)``: validated dump with every default present. */
  kernel.new_checkpoint = function (fields) { return validate_model("RunCheckpoint", fields); };
  /** ``Observation(**fields)``: validated dump with every default present. */
  kernel.new_observation = function (fields) { return validate_model("Observation", fields); };
  kernel.new_budget = function (fields) { return validate_model("Budget", fields || {}); };
  kernel.new_assurance = function (fields) { return validate_model("Assurance", fields || {}); };
  /** ``RunCheckpoint.digest()`` / ``Observation.digest()``: digest(model_dump(mode="json")). Both models have
   *  no float fields, so the plain canonical digest of the dump matches Python byte for byte. */
  kernel.checkpoint_digest = function (cp) { return HX.canonical.digest(cp); };
  kernel.observation_digest = function (obs) { return HX.canonical.digest(obs); };

  /** ``KernelResult(checkpoint, events=[], delta={}, edge=None)``. */
  function KernelResult(checkpoint, events, delta, edge) {
    return { checkpoint, events: events || [], delta: delta || {}, edge: edge === undefined ? null : edge };
  }
  kernel.KernelResult = KernelResult;

  /* ------------------------------------------------------------------------------------------ */
  /* Task input, templates                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  /** Resolve ``task.input.a.b`` (dot path) or ``/a/b`` (JSON-Pointer style). Returns ``[found, value]``. */
  kernel.resolve_path = function (task_input, init_from) {
    if (typeof init_from !== "string") {
      throw pyerr("AttributeError", "'" + py_type_name(init_from) + "' object has no attribute 'startswith'");
    }
    let parts;
    if (init_from.startsWith("/")) {
      parts = init_from.slice(1).split("/").map((p) => p.split("~1").join("/").split("~0").join("~"));
    } else {
      parts = init_from.split(".");
      if (!(parts.length >= 2 && parts[0] === "task" && parts[1] === "input")) {
        throw new KernelError("BAD_INIT_FROM", "unsupported init_from " + repr_str(init_from));
      }
      parts = parts.slice(2);
    }
    let cur = task_input;
    for (const p of parts) {
      if (is_dict(cur) && hasOwn(cur, p)) cur = cur[p];
      else return [false, null];
    }
    return [true, cur];
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Schema checks with python-jsonschema's exact multipleOf                                      */
  /* ------------------------------------------------------------------------------------------ */
  /* HX.jsonschema accepts any number within 1e-9 of a multiple; python-jsonschema (_keywords.multipleOf) is
   * exact: an int divisor uses ``instance % dB``, a float divisor ``int(q) != q`` with q = instance / dB, and,
   * when q overflows, exact Fraction arithmetic. The kernel's verdicts (TASK_INPUT_INVALID, OUTPUT_SCHEMA) must
   * be Python's, so a schema that uses multipleOf is checked here: HX.catalog.validate_against runs on the
   * schema with multipleOf (and every anyOf/oneOf/not whose subtree uses it) removed, and this walker adds the
   * exact multipleOf errors and decides those combinators itself. Schemas without multipleOf go straight to
   * HX.catalog.validate_against, unchanged. */

  /** |x| (finite, non-zero) as [odd BigInt mantissa, binary exponent]. */
  function dbl_parts(x) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, Math.abs(x));
    const hi = dv.getUint32(0), lo = dv.getUint32(4);
    const e = (hi >>> 20) & 0x7ff;
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let exp;
    if (e === 0) exp = -1074;
    else { m |= 1n << 52n; exp = e - 1075; }
    while ((m & 1n) === 0n) { m >>= 1n; exp++; }
    return [m, exp];
  }

  /** python-jsonschema multipleOf: true when ``instance`` is NOT a multiple of ``dB`` (numbers only). */
  function py_multiple_fails(instance, dB) {
    if (dB === 0) throw pyerr("ZeroDivisionError", Number.isInteger(dB) ? "integer modulo by zero" : "float division by zero");
    if (Number.isInteger(dB)) return instance % dB !== 0; /* int divisor (integral floats never reach JS) */
    const q = instance / dB;
    if (Number.isFinite(q)) return !Number.isInteger(q);
    /* OverflowError -> (Fraction(instance) / Fraction(dB)).denominator != 1 */
    if (instance === 0) return false;
    const [mi, ei] = dbl_parts(instance), [md, ed] = dbl_parts(dB);
    return !(mi % md === 0n && ei - ed >= 0);
  }
  kernel._py_multiple_fails = py_multiple_fails;

  function uses_multiple_of(s) {
    if (Array.isArray(s)) return s.some(uses_multiple_of);
    if (!is_dict(s)) return false;
    if (typeof s.multipleOf === "number") return true;
    return Object.keys(s).some((k) => uses_multiple_of(s[k]));
  }

  const SUB_MAPS = ["properties", "patternProperties"];
  /** Copy of a schema without numeric multipleOf and without the combinators that contain one. */
  function strip_mo(s) {
    if (!is_dict(s)) return s;
    const out = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (k === "multipleOf" && typeof v === "number") continue;
      if ((k === "anyOf" || k === "oneOf" || k === "not") && uses_multiple_of(v)) continue;
      if (SUB_MAPS.indexOf(k) >= 0 && is_dict(v)) {
        const m = {};
        for (const kk of Object.keys(v)) set_own(m, kk, strip_mo(v[kk]));
        set_own(out, k, m);
      } else if (k === "items" || k === "additionalProperties") set_own(out, k, strip_mo(v));
      else if (k === "allOf" && Array.isArray(v)) set_own(out, k, v.map(strip_mo));
      else set_own(out, k, v);
    }
    return out;
  }

  /* CPython 3.12 (Unicode 15.0) re classes for str patterns, as code point ranges (hex), generated from
   * re.fullmatch(r'\d' / r'\s' / r'\w', chr(c)) over every code point (golden/gen_kernel.py checks them). */
  const PY_RE_TABLES = {
    d: [
      "30-39,660-669,6f0-6f9,7c0-7c9,966-96f,9e6-9ef,a66-a6f,ae6-aef,b66-b6f,be6-bef,c66-c6f,ce6-cef",
      "d66-d6f,de6-def,e50-e59,ed0-ed9,f20-f29,1040-1049,1090-1099,17e0-17e9,1810-1819,1946-194f,19d0-19d9",
      "1a80-1a89,1a90-1a99,1b50-1b59,1bb0-1bb9,1c40-1c49,1c50-1c59,a620-a629,a8d0-a8d9,a900-a909,a9d0-a9d9",
      "a9f0-a9f9,aa50-aa59,abf0-abf9,ff10-ff19,104a0-104a9,10d30-10d39,11066-1106f,110f0-110f9,11136-1113f",
      "111d0-111d9,112f0-112f9,11450-11459,114d0-114d9,11650-11659,116c0-116c9,11730-11739,118e0-118e9",
      "11950-11959,11c50-11c59,11d50-11d59,11da0-11da9,11f50-11f59,16a60-16a69,16ac0-16ac9,16b50-16b59",
      "1d7ce-1d7ff,1e140-1e149,1e2f0-1e2f9,1e4f0-1e4f9,1e950-1e959,1fbf0-1fbf9"
    ].join(","),
    s: [
      "9-d,1c-20,85,a0,1680,2000-200a,2028-2029,202f,205f,3000"
    ].join(","),
    w: [
      "30-39,41-5a,5f,61-7a,aa,b2-b3,b5,b9-ba,bc-be,c0-d6,d8-f6,f8-2c1,2c6-2d1,2e0-2e4,2ec,2ee,370-374",
      "376-377,37a-37d,37f,386,388-38a,38c,38e-3a1,3a3-3f5,3f7-481,48a-52f,531-556,559,560-588,5d0-5ea",
      "5ef-5f2,620-64a,660-669,66e-66f,671-6d3,6d5,6e5-6e6,6ee-6fc,6ff,710,712-72f,74d-7a5,7b1,7c0-7ea",
      "7f4-7f5,7fa,800-815,81a,824,828,840-858,860-86a,870-887,889-88e,8a0-8c9,904-939,93d,950,958-961",
      "966-96f,971-980,985-98c,98f-990,993-9a8,9aa-9b0,9b2,9b6-9b9,9bd,9ce,9dc-9dd,9df-9e1,9e6-9f1,9f4-9f9",
      "9fc,a05-a0a,a0f-a10,a13-a28,a2a-a30,a32-a33,a35-a36,a38-a39,a59-a5c,a5e,a66-a6f,a72-a74,a85-a8d",
      "a8f-a91,a93-aa8,aaa-ab0,ab2-ab3,ab5-ab9,abd,ad0,ae0-ae1,ae6-aef,af9,b05-b0c,b0f-b10,b13-b28,b2a-b30",
      "b32-b33,b35-b39,b3d,b5c-b5d,b5f-b61,b66-b6f,b71-b77,b83,b85-b8a,b8e-b90,b92-b95,b99-b9a,b9c,b9e-b9f",
      "ba3-ba4,ba8-baa,bae-bb9,bd0,be6-bf2,c05-c0c,c0e-c10,c12-c28,c2a-c39,c3d,c58-c5a,c5d,c60-c61,c66-c6f",
      "c78-c7e,c80,c85-c8c,c8e-c90,c92-ca8,caa-cb3,cb5-cb9,cbd,cdd-cde,ce0-ce1,ce6-cef,cf1-cf2,d04-d0c",
      "d0e-d10,d12-d3a,d3d,d4e,d54-d56,d58-d61,d66-d78,d7a-d7f,d85-d96,d9a-db1,db3-dbb,dbd,dc0-dc6,de6-def",
      "e01-e30,e32-e33,e40-e46,e50-e59,e81-e82,e84,e86-e8a,e8c-ea3,ea5,ea7-eb0,eb2-eb3,ebd,ec0-ec4,ec6",
      "ed0-ed9,edc-edf,f00,f20-f33,f40-f47,f49-f6c,f88-f8c,1000-102a,103f-1049,1050-1055,105a-105d,1061",
      "1065-1066,106e-1070,1075-1081,108e,1090-1099,10a0-10c5,10c7,10cd,10d0-10fa,10fc-1248,124a-124d",
      "1250-1256,1258,125a-125d,1260-1288,128a-128d,1290-12b0,12b2-12b5,12b8-12be,12c0,12c2-12c5,12c8-12d6",
      "12d8-1310,1312-1315,1318-135a,1369-137c,1380-138f,13a0-13f5,13f8-13fd,1401-166c,166f-167f,1681-169a",
      "16a0-16ea,16ee-16f8,1700-1711,171f-1731,1740-1751,1760-176c,176e-1770,1780-17b3,17d7,17dc,17e0-17e9",
      "17f0-17f9,1810-1819,1820-1878,1880-1884,1887-18a8,18aa,18b0-18f5,1900-191e,1946-196d,1970-1974",
      "1980-19ab,19b0-19c9,19d0-19da,1a00-1a16,1a20-1a54,1a80-1a89,1a90-1a99,1aa7,1b05-1b33,1b45-1b4c",
      "1b50-1b59,1b83-1ba0,1bae-1be5,1c00-1c23,1c40-1c49,1c4d-1c7d,1c80-1c88,1c90-1cba,1cbd-1cbf,1ce9-1cec",
      "1cee-1cf3,1cf5-1cf6,1cfa,1d00-1dbf,1e00-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d",
      "1f5f-1f7d,1f80-1fb4,1fb6-1fbc,1fbe,1fc2-1fc4,1fc6-1fcc,1fd0-1fd3,1fd6-1fdb,1fe0-1fec,1ff2-1ff4",
      "1ff6-1ffc,2070-2071,2074-2079,207f-2089,2090-209c,2102,2107,210a-2113,2115,2119-211d,2124,2126,2128",
      "212a-212d,212f-2139,213c-213f,2145-2149,214e,2150-2189,2460-249b,24ea-24ff,2776-2793,2c00-2ce4",
      "2ceb-2cee,2cf2-2cf3,2cfd,2d00-2d25,2d27,2d2d,2d30-2d67,2d6f,2d80-2d96,2da0-2da6,2da8-2dae,2db0-2db6",
      "2db8-2dbe,2dc0-2dc6,2dc8-2dce,2dd0-2dd6,2dd8-2dde,2e2f,3005-3007,3021-3029,3031-3035,3038-303c",
      "3041-3096,309d-309f,30a1-30fa,30fc-30ff,3105-312f,3131-318e,3192-3195,31a0-31bf,31f0-31ff,3220-3229",
      "3248-324f,3251-325f,3280-3289,32b1-32bf,3400-4dbf,4e00-a48c,a4d0-a4fd,a500-a60c,a610-a62b,a640-a66e",
      "a67f-a69d,a6a0-a6ef,a717-a71f,a722-a788,a78b-a7ca,a7d0-a7d1,a7d3,a7d5-a7d9,a7f2-a801,a803-a805",
      "a807-a80a,a80c-a822,a830-a835,a840-a873,a882-a8b3,a8d0-a8d9,a8f2-a8f7,a8fb,a8fd-a8fe,a900-a925",
      "a930-a946,a960-a97c,a984-a9b2,a9cf-a9d9,a9e0-a9e4,a9e6-a9fe,aa00-aa28,aa40-aa42,aa44-aa4b,aa50-aa59",
      "aa60-aa76,aa7a,aa7e-aaaf,aab1,aab5-aab6,aab9-aabd,aac0,aac2,aadb-aadd,aae0-aaea,aaf2-aaf4,ab01-ab06",
      "ab09-ab0e,ab11-ab16,ab20-ab26,ab28-ab2e,ab30-ab5a,ab5c-ab69,ab70-abe2,abf0-abf9,ac00-d7a3,d7b0-d7c6",
      "d7cb-d7fb,f900-fa6d,fa70-fad9,fb00-fb06,fb13-fb17,fb1d,fb1f-fb28,fb2a-fb36,fb38-fb3c,fb3e,fb40-fb41",
      "fb43-fb44,fb46-fbb1,fbd3-fd3d,fd50-fd8f,fd92-fdc7,fdf0-fdfb,fe70-fe74,fe76-fefc,ff10-ff19,ff21-ff3a",
      "ff41-ff5a,ff66-ffbe,ffc2-ffc7,ffca-ffcf,ffd2-ffd7,ffda-ffdc,10000-1000b,1000d-10026,10028-1003a",
      "1003c-1003d,1003f-1004d,10050-1005d,10080-100fa,10107-10133,10140-10178,1018a-1018b,10280-1029c",
      "102a0-102d0,102e1-102fb,10300-10323,1032d-1034a,10350-10375,10380-1039d,103a0-103c3,103c8-103cf",
      "103d1-103d5,10400-1049d,104a0-104a9,104b0-104d3,104d8-104fb,10500-10527,10530-10563,10570-1057a",
      "1057c-1058a,1058c-10592,10594-10595,10597-105a1,105a3-105b1,105b3-105b9,105bb-105bc,10600-10736",
      "10740-10755,10760-10767,10780-10785,10787-107b0,107b2-107ba,10800-10805,10808,1080a-10835",
      "10837-10838,1083c,1083f-10855,10858-10876,10879-1089e,108a7-108af,108e0-108f2,108f4-108f5",
      "108fb-1091b,10920-10939,10980-109b7,109bc-109cf,109d2-10a00,10a10-10a13,10a15-10a17,10a19-10a35",
      "10a40-10a48,10a60-10a7e,10a80-10a9f,10ac0-10ac7,10ac9-10ae4,10aeb-10aef,10b00-10b35,10b40-10b55",
      "10b58-10b72,10b78-10b91,10ba9-10baf,10c00-10c48,10c80-10cb2,10cc0-10cf2,10cfa-10d23,10d30-10d39",
      "10e60-10e7e,10e80-10ea9,10eb0-10eb1,10f00-10f27,10f30-10f45,10f51-10f54,10f70-10f81,10fb0-10fcb",
      "10fe0-10ff6,11003-11037,11052-1106f,11071-11072,11075,11083-110af,110d0-110e8,110f0-110f9",
      "11103-11126,11136-1113f,11144,11147,11150-11172,11176,11183-111b2,111c1-111c4,111d0-111da,111dc",
      "111e1-111f4,11200-11211,11213-1122b,1123f-11240,11280-11286,11288,1128a-1128d,1128f-1129d",
      "1129f-112a8,112b0-112de,112f0-112f9,11305-1130c,1130f-11310,11313-11328,1132a-11330,11332-11333",
      "11335-11339,1133d,11350,1135d-11361,11400-11434,11447-1144a,11450-11459,1145f-11461,11480-114af",
      "114c4-114c5,114c7,114d0-114d9,11580-115ae,115d8-115db,11600-1162f,11644,11650-11659,11680-116aa",
      "116b8,116c0-116c9,11700-1171a,11730-1173b,11740-11746,11800-1182b,118a0-118f2,118ff-11906,11909",
      "1190c-11913,11915-11916,11918-1192f,1193f,11941,11950-11959,119a0-119a7,119aa-119d0,119e1,119e3",
      "11a00,11a0b-11a32,11a3a,11a50,11a5c-11a89,11a9d,11ab0-11af8,11c00-11c08,11c0a-11c2e,11c40",
      "11c50-11c6c,11c72-11c8f,11d00-11d06,11d08-11d09,11d0b-11d30,11d46,11d50-11d59,11d60-11d65",
      "11d67-11d68,11d6a-11d89,11d98,11da0-11da9,11ee0-11ef2,11f02,11f04-11f10,11f12-11f33,11f50-11f59",
      "11fb0,11fc0-11fd4,12000-12399,12400-1246e,12480-12543,12f90-12ff0,13000-1342f,13441-13446",
      "14400-14646,16800-16a38,16a40-16a5e,16a60-16a69,16a70-16abe,16ac0-16ac9,16ad0-16aed,16b00-16b2f",
      "16b40-16b43,16b50-16b59,16b5b-16b61,16b63-16b77,16b7d-16b8f,16e40-16e96,16f00-16f4a,16f50",
      "16f93-16f9f,16fe0-16fe1,16fe3,17000-187f7,18800-18cd5,18d00-18d08,1aff0-1aff3,1aff5-1affb",
      "1affd-1affe,1b000-1b122,1b132,1b150-1b152,1b155,1b164-1b167,1b170-1b2fb,1bc00-1bc6a,1bc70-1bc7c",
      "1bc80-1bc88,1bc90-1bc99,1d2c0-1d2d3,1d2e0-1d2f3,1d360-1d378,1d400-1d454,1d456-1d49c,1d49e-1d49f",
      "1d4a2,1d4a5-1d4a6,1d4a9-1d4ac,1d4ae-1d4b9,1d4bb,1d4bd-1d4c3,1d4c5-1d505,1d507-1d50a,1d50d-1d514",
      "1d516-1d51c,1d51e-1d539,1d53b-1d53e,1d540-1d544,1d546,1d54a-1d550,1d552-1d6a5,1d6a8-1d6c0",
      "1d6c2-1d6da,1d6dc-1d6fa,1d6fc-1d714,1d716-1d734,1d736-1d74e,1d750-1d76e,1d770-1d788,1d78a-1d7a8",
      "1d7aa-1d7c2,1d7c4-1d7cb,1d7ce-1d7ff,1df00-1df1e,1df25-1df2a,1e030-1e06d,1e100-1e12c,1e137-1e13d",
      "1e140-1e149,1e14e,1e290-1e2ad,1e2c0-1e2eb,1e2f0-1e2f9,1e4d0-1e4eb,1e4f0-1e4f9,1e7e0-1e7e6",
      "1e7e8-1e7eb,1e7ed-1e7ee,1e7f0-1e7fe,1e800-1e8c4,1e8c7-1e8cf,1e900-1e943,1e94b,1e950-1e959",
      "1ec71-1ecab,1ecad-1ecaf,1ecb1-1ecb4,1ed01-1ed2d,1ed2f-1ed3d,1ee00-1ee03,1ee05-1ee1f,1ee21-1ee22",
      "1ee24,1ee27,1ee29-1ee32,1ee34-1ee37,1ee39,1ee3b,1ee42,1ee47,1ee49,1ee4b,1ee4d-1ee4f,1ee51-1ee52",
      "1ee54,1ee57,1ee59,1ee5b,1ee5d,1ee5f,1ee61-1ee62,1ee64,1ee67-1ee6a,1ee6c-1ee72,1ee74-1ee77",
      "1ee79-1ee7c,1ee7e,1ee80-1ee89,1ee8b-1ee9b,1eea1-1eea3,1eea5-1eea9,1eeab-1eebb,1f100-1f10c",
      "1fbf0-1fbf9,20000-2a6df,2a700-2b739,2b740-2b81d,2b820-2cea1,2ceb0-2ebe0,2f800-2fa1d,30000-3134a",
      "31350-323af"
    ].join(","),
  };

  /* Python ``re`` semantics for schema regexes. python-jsonschema applies ``pattern`` and ``patternProperties``
   * with ``re.search``: ``$`` also matches before a final "\n", ``.`` matches everything but "\n", and ``\d``,
   * ``\w``, ``\s`` (and ``\b``) are Unicode-aware with CPython's own tables. A JS ``u`` regex differs on all of
   * these, which would make a verdict stricter for a plain ``pattern`` but more permissive under ``not`` or for
   * ``patternProperties`` keys. So the kernel translates every schema regex into a JS regex with Python's
   * meaning before validating. Only a well-understood subset is translated; any other regex (flags, back
   * references, \N{...}, octal escapes, quantified assertions, possessive repeats, ...) makes the whole schema
   * check fail closed, so the verdict is always Python's or a rejection. */
  kernel._PY_RE_TABLES = PY_RE_TABLES;
  class PyReUnsupported extends Error {}
  const re_fail = (why) => { throw new PyReUnsupported(why); };
  const MAX_CP = 0x10ffff;
  let PY_RE_CLS = null;

  function parse_table(t) {
    return t.split(",").map((part) => {
      const [a, b] = part.split("-");
      return [parseInt(a, 16), parseInt(b === undefined ? a : b, 16)];
    });
  }
  function complement(rs) {
    const out = [];
    let next = 0;
    for (const [a, b] of rs) {
      if (a > next) out.push([next, a - 1]);
      next = b + 1;
    }
    if (next <= MAX_CP) out.push([next, MAX_CP]);
    return out;
  }
  function union(rs) {
    const s = rs.slice().sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of s) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }
  function py_re_classes() {
    if (PY_RE_CLS === null) {
      const c = {};
      for (const k of ["d", "s", "w"]) {
        c[k] = parse_table(PY_RE_TABLES[k]);
        c[k.toUpperCase()] = complement(c[k]);
      }
      PY_RE_CLS = c;
    }
    return PY_RE_CLS;
  }
  const cls_cp = (c) => (/^[A-Za-z0-9]$/.test(String.fromCodePoint(c)) ? String.fromCodePoint(c) : "\\u{" + c.toString(16) + "}");
  function cls_src(rs, negate) {
    return "[" + (negate ? "^" : "") + rs.map(([a, b]) => (a === b ? cls_cp(a) : cls_cp(a) + "-" + cls_cp(b))).join("") + "]";
  }
  const JS_SYNTAX = "^$\\.*+?()[]{}|/";
  function lit_src(c) {
    const ch = String.fromCodePoint(c);
    if (JS_SYNTAX.indexOf(ch) >= 0) return "\\" + ch;
    if (c >= 0x20 && c <= 0x7e) return ch;
    return "\\u{" + c.toString(16) + "}";
  }
  const SIMPLE_ESC = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  const HEXD = /^[0-9A-Fa-f]$/;

  /** JS source (for ``new RegExp(src, "u")``) with the meaning of Python ``re.search(p, s)``; throws
   *  PyReUnsupported outside the translated subset or when Python's ``re`` would refuse the regex. */
  function py_regex_to_js(p) {
    if (typeof p !== "string") re_fail("not a string");
    if (HX.catalog.py_regex_check(p) !== null) re_fail("not a valid Python regular expression");
    const cps = Array.from(p);
    let i = 0;
    const word = () => cls_src(py_re_classes().w, false);
    const hex_escape = (n) => {
      const h = cps.slice(i, i + n);
      if (h.length !== n || !h.every((x) => HEXD.test(x))) re_fail("bad escape");
      i += n;
      const v = parseInt(h.join(""), 16);
      if (v > MAX_CP) re_fail("bad escape");
      return v;
    };
    /* one escape after "\"; returns {lit: cp} or {cls: "d"|"D"|...} or {src, q} (outside classes only) */
    function escape(in_class) {
      const c = cps[i++];
      if (c === undefined) re_fail("bad escape (end of pattern)");
      if ("dDsSwW".indexOf(c) >= 0) return { cls: c };
      if (c === "x") return { lit: hex_escape(2) };
      if (c === "u") return { lit: hex_escape(4) };
      if (c === "U") return { lit: hex_escape(8) };
      if (!in_class) {
        if (c === "A") return { src: "^", q: false };
        if (c === "Z") return { src: "$", q: false };
        if (c === "b") return { src: "(?:(?<=" + word() + ")(?!" + word() + ")|(?<!" + word() + ")(?=" + word() + "))", q: false };
        /* CPython 3.12: \B never matches inside an empty string */
        if (c === "B") {
          return { src: "(?:(?<=" + word() + ")(?=" + word() + ")|(?<!" + word() + ")(?!" + word() +
            ")(?:(?<=[^])|(?=[^])))", q: false };
        }
      }
      if (hasOwn(SIMPLE_ESC, c) && (in_class || c !== "b")) return { lit: SIMPLE_ESC[c] };
      if (/^[A-Za-z0-9]$/.test(c)) re_fail("unsupported escape \\" + c);
      return { lit: c.codePointAt(0) };
    }
    function parse_class() {
      const negate = cps[i] === "^";
      if (negate) i++;
      const start = i;
      const rs = [];
      const C = py_re_classes();
      const add = (code) => { if ("cls" in code) rs.push(...C[code.cls]); else rs.push([code.lit, code.lit]); };
      for (;;) {
        const c = cps[i++];
        if (c === undefined) re_fail("unterminated character set");
        if (c === "]" && i - 1 !== start) break;
        const code1 = c === "\\" ? escape(true) : { lit: c.codePointAt(0) };
        if (cps[i] === "-") {
          i++;
          const that = cps[i++];
          if (that === undefined) re_fail("unterminated character set");
          if (that === "]") { add(code1); add({ lit: 45 }); break; }
          const code2 = that === "\\" ? escape(true) : { lit: that.codePointAt(0) };
          if (!("lit" in code1) || !("lit" in code2) || code2.lit < code1.lit) re_fail("bad character range");
          rs.push([code1.lit, code2.lit]);
        } else add(code1);
      }
      return cls_src(union(rs), negate);
    }
    /* Python's {m,n} syntax at cps[j] ("{"), or null when the brace is a literal */
    function brace_at(j) {
      if (cps[j] !== "{" || cps[j + 1] === "}") return null;
      let k = j + 1, lo = "", hi = "";
      while (/^[0-9]$/.test(cps[k] || "")) lo += cps[k++];
      if (cps[k] === ",") { k++; while (/^[0-9]$/.test(cps[k] || "")) hi += cps[k++]; } else hi = lo;
      if (cps[k] !== "}") return null;
      const min = lo ? Number(lo) : 0, max = hi ? Number(hi) : Infinity;
      if (min > 100000 || (max !== Infinity && max > 100000)) re_fail("repeat count too large for the port");
      if (max < min) re_fail("min repeat greater than max repeat");
      return { min, max, end: k + 1 };
    }
    const is_repeat_at = (j) => "*+?".indexOf(cps[j]) >= 0 && cps[j] !== undefined || brace_at(j) !== null;
    function parse_atom() {
      const c = cps[i];
      if ("*+?".indexOf(c) >= 0) re_fail("nothing to repeat");
      if (c === "{") {
        if (brace_at(i) !== null) re_fail("nothing to repeat");
        i++;
        return { src: "\\{", q: true };
      }
      i++;
      if (c === ".") return { src: "[^\\n]", q: true };
      if (c === "^") return { src: "^", q: false };
      if (c === "$") return { src: "(?=\\n?$)", q: false };
      if (c === "[") return { src: parse_class(), q: true };
      if (c === "\\") {
        const e = escape(false);
        if ("cls" in e) {
          const C = py_re_classes();
          const up = e.cls === e.cls.toUpperCase();
          return { src: cls_src(C[e.cls.toLowerCase()], up), q: true };
        }
        if ("lit" in e) return { src: lit_src(e.lit), q: true };
        return e;
      }
      if (c === "(") {
        let open = "(?:", q = true;
        if (cps[i] === "?") {
          const two = cps.slice(i, i + 3).join("");
          if (two.startsWith("?:")) i += 2;
          else if (two.startsWith("?=") || two.startsWith("?!")) { open = "(" + two.slice(0, 2); i += 2; q = false; }
          else if (two === "?<=" || two === "?<!") { open = "(" + two; i += 3; q = false; }
          else if (two.startsWith("?P<")) {
            i += 3;
            let name = "";
            while (cps[i] !== undefined && cps[i] !== ">") name += cps[i++];
            if (cps[i] !== ">" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) re_fail("unsupported group name");
            i++;
          } else re_fail("unsupported group or flag (?" + (cps[i + 1] || ""));
        }
        const inner = parse_alt();
        if (cps[i] !== ")") re_fail("missing ), unterminated subpattern");
        i++;
        /* Python repeats a look-around like any group (zero width: min 0 -> empty, else the assertion once); a JS
           u regex only quantifies it inside a group, where the repeat has the same meaning */
        return q ? { src: open + inner + ")", q } : { src: "(?:" + open + inner + "))", q: true };
      }
      if (c === ")") re_fail("unbalanced parenthesis");
      return { src: lit_src(c.codePointAt(0)), q: true };
    }
    function parse_seq() {
      let out = "";
      for (;;) {
        const c = cps[i];
        if (c === undefined || c === "|" || c === ")") return out;
        const atom = parse_atom();
        out += atom.src;
        if (!is_repeat_at(i)) continue;
        if (!atom.q) re_fail("quantified assertion");
        const b = brace_at(i);
        if (b !== null) {
          out += "{" + b.min + "," + (b.max === Infinity ? "" : b.max) + "}";
          i = b.end;
        } else out += cps[i++];
        if (cps[i] === "?") out += cps[i++];
        else if (cps[i] === "+") re_fail("possessive repeat");
        if (is_repeat_at(i)) re_fail("multiple repeat");
      }
    }
    function parse_alt() {
      const parts = [parse_seq()];
      while (cps[i] === "|") { i++; parts.push(parse_seq()); }
      return parts.join("|");
    }
    const src = parse_alt();
    if (i < cps.length) re_fail("unbalanced parenthesis");
    new RegExp(src, "u"); /* must compile */
    return src;
  }
  const PY_RE_CACHE = new Map();
  /** Cached ``py_regex_to_js``: {src} or {why}. */
  function py_regex(p) {
    if (typeof p !== "string") return { why: "not a string" };
    let r = PY_RE_CACHE.get(p);
    if (r === undefined) {
      try { r = { src: py_regex_to_js(p) }; } catch (e) {
        if (!(e instanceof PyReUnsupported) && !(e instanceof SyntaxError)) throw e;
        r = { why: e.message };
      }
      if (PY_RE_CACHE.size > 2000) PY_RE_CACHE.clear();
      PY_RE_CACHE.set(p, r);
    }
    return r;
  }
  kernel._py_regex_to_js = function (p) { const r = py_regex(p); return "src" in r ? r.src : null; };
  /** Python ``re.search(p, s) is not None``; throws HX.HXError("UNSUPPORTED_PATTERN") outside the subset. */
  kernel._py_re_search = function (p, s) {
    const r = py_regex(p);
    if (!("src" in r)) throw new HX.HXError("UNSUPPORTED_PATTERN", "unsupported pattern " + repr_str(String(p)) + ": " + r.why);
    return new RegExp(r.src, "u").test(s);
  };

  /** Copy of a schema whose ``pattern`` values and ``patternProperties`` keys are translated to JS with
   *  Python's meaning; throws PyReUnsupported (with the pattern) when one is outside the subset. */
  function translate_schema(s, names) {
    if (Array.isArray(s)) return s.map((x) => translate_schema(x, names));
    if (!is_dict(s)) return s;
    const tr = (p) => {
      const r = py_regex(p);
      if (!("src" in r)) throw new PyReUnsupported("unsupported pattern " + pyr(p) + " (" + r.why + ")");
      if (names) names.set(r.src, p);
      return r.src;
    };
    const sub = (x) => translate_schema(x, names);
    const out = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (k === "pattern") set_own(out, k, tr(v));
      else if (k === "patternProperties" && is_dict(v)) {
        const m = {};
        for (const kk of Object.keys(v)) {
          let tk = tr(kk);
          while (hasOwn(m, tk)) tk += "(?:)"; /* two Python regexes with the same translation stay separate */
          if (names) names.set(tk, kk);
          set_own(m, tk, sub(v[kk]));
        }
        set_own(out, k, m);
      } else if (k === "properties" && is_dict(v)) {
        const m = {};
        for (const kk of Object.keys(v)) set_own(m, kk, sub(v[kk]));
        set_own(out, k, m);
      } else if (k === "items" || k === "additionalProperties" || k === "not") set_own(out, k, sub(v));
      else if ((k === "allOf" || k === "anyOf" || k === "oneOf") && Array.isArray(v)) set_own(out, k, v.map(sub));
      else set_own(out, k, v);
    }
    return out;
  }

  function pattern_re(p) {
    try { return new RegExp(p, "u"); } catch (e) { return null; }
  }
  const at = (path) => (path.length ? path.map(String).join("/") : "<root>");

  /** Errors the stripped check leaves out: exact multipleOf and the removed combinators (mirrors HX.jsonschema's walk). */
  function mo_walk(s, v, path, out) {
    if (!is_dict(s)) return;
    if (typeof s.multipleOf === "number" && typeof v === "number" && py_multiple_fails(v, s.multipleOf)) {
      out.push(at(path) + ": " + pyr(v) + " is not a multiple of " + pyr(s.multipleOf));
    }
    if (Array.isArray(v) && "items" in s) v.forEach((item, i) => mo_walk(s.items, item, path.concat([i]), out));
    if (is_dict(v)) {
      const props = is_dict(s.properties) ? s.properties : {};
      const pprops = is_dict(s.patternProperties) ? s.patternProperties : {};
      for (const k of Object.keys(v)) {
        let matched = false;
        if (hasOwn(props, k)) { matched = true; mo_walk(props[k], v[k], path.concat([k]), out); }
        for (const p of Object.keys(pprops)) {
          const re = pattern_re(p);
          if (re && re.test(k)) { matched = true; mo_walk(pprops[p], v[k], path.concat([k]), out); }
        }
        if (!matched && "additionalProperties" in s) mo_walk(s.additionalProperties, v[k], path.concat([k]), out);
      }
    }
    if (Array.isArray(s.allOf)) s.allOf.forEach((b) => mo_walk(b, v, path, out));
    const valid = (b) => js_schema_errors(b, v).length === 0;
    if (Array.isArray(s.anyOf) && uses_multiple_of(s.anyOf) && !s.anyOf.some(valid)) {
      out.push(at(path) + ": " + pyr(v) + " is not valid under any of the given schemas");
    }
    if (Array.isArray(s.oneOf) && uses_multiple_of(s.oneOf)) {
      const n = s.oneOf.filter(valid).length;
      if (n !== 1) {
        out.push(at(path) + ": " + (n === 0 ? pyr(v) + " is not valid under any of the given schemas"
          : pyr(v) + " is valid under each of " + n + " schemas"));
      }
    }
    if ("not" in s && uses_multiple_of(s.not) && valid(s.not)) {
      out.push(at(path) + ": " + pyr(v) + " should not be valid under " + pyr(s.not));
    }
  }

  /** HX.catalog.validate_against with python-jsonschema's exact multipleOf, on a translated schema. */
  function js_schema_errors(schema, value) {
    if (!uses_multiple_of(schema)) return HX.catalog.validate_against(schema, value);
    const errs = HX.catalog.validate_against(strip_mo(schema), value);
    mo_walk(schema, value, [], errs);
    return errs;
  }

  /** python-jsonschema's verdict (``validate_against``): Python regex semantics and exact multipleOf. A schema
   *  with a regex outside the translated subset fails closed with one "<root>: unsupported pattern" error. */
  function schema_errors(schema, value) {
    let t;
    const names = new Map();
    try { t = translate_schema(schema, names); } catch (e) {
      if (e instanceof PyReUnsupported) return ["<root>: " + e.message];
      throw e;
    }
    const errs = js_schema_errors(t, value);
    /* messages name the schema's own regexes, not their translations (longest first) */
    const swaps = Array.from(names).filter(([js, py]) => js !== py).sort((a, b) => b[0].length - a[0].length)
      .map(([js, py]) => [HX.util.py_repr(js), HX.util.py_repr(py)]);
    return swaps.length ? errs.map((m) => swaps.reduce((acc, [a, b]) => acc.split(a).join(b), m)) : errs;
  }
  kernel._schema_errors = schema_errors;

  kernel.initial_checkpoint = function (pkg, tenant_id, run_id, task_input) {
    const schema = py_truthy(pkg.contracts.task_input_schema) ? pkg.contracts.task_input_schema : { type: "object" };
    const errs = schema_errors(schema, task_input);
    if (errs.length) throw new KernelError("TASK_INPUT_INVALID", errs.slice(0, 5).join("; "), { errors: errs });
    const vals = {};
    for (const v of pkg.machine.variables) {
      if (py_truthy(v.init_from)) {
        const [found, val] = kernel.resolve_path(task_input, v.init_from);
        if (found) set_own(vals, v.name, clone(val));
      } else if (v.init !== null && v.init !== undefined) {
        set_own(vals, v.name, clone(v.init));
      }
    }
    return kernel.new_checkpoint({ tenant_id, run_id, artifact_hash: pkg.artifact_hash,
      state_id: pkg.machine.initial, variables: vals });
  };

  /* Python: _WHOLE = ^\$\{name\}$ under re.match ($ also matches before a final "\n"); _PART unanchored */
  const WHOLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}\n?$/;
  const PART = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

  /** Strict binding: a missing variable is an explicit error, never None or ''. */
  kernel.fill_template = function fill_template(obj, values) {
    if (typeof obj === "string") {
      const m = WHOLE.exec(obj);
      if (m) {
        if (!hasOwn(values, m[1])) {
          throw new KernelError("MISSING_INPUT_BINDING", "template variable " + repr_str(m[1]) + " is unset",
            { variable: m[1] });
        }
        return clone(values[m[1]]);
      }
      return obj.replace(PART, (_all, name) => {
        if (!hasOwn(values, name)) {
          throw new KernelError("MISSING_INPUT_BINDING", "template variable " + repr_str(name) + " is unset",
            { variable: name });
        }
        const v = values[name];
        if (typeof v === "string") return v;
        if (typeof v === "number") return HX.canonical.py_number(v);
        throw new KernelError("TEMPLATE_TYPE", "cannot interpolate " + py_type_name(v) + " " + repr_str(name) +
          " into text");
      });
    }
    if (Array.isArray(obj)) return obj.map((v) => fill_template(v, values));
    if (obj !== null && typeof obj === "object") {
      const out = {};
      for (const k of Object.keys(obj)) set_own(out, k, fill_template(obj[k], values));
      return out;
    }
    return obj;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Output validation                                                                            */
  /* ------------------------------------------------------------------------------------------ */
  const TYPE_OK = {
    string: (v) => typeof v === "string",
    integer: (v) => typeof v === "number" && Number.isInteger(v),
    number: (v) => typeof v === "number",
    boolean: (v) => typeof v === "boolean",
    array: (v) => Array.isArray(v),
    object: (v) => is_dict(v),
  };
  const OWNER = { tool: "tool", model: "model", judge: "model", user: "user" };

  function state_of(pkg, state_id) {
    const states = pkg.machine.states;
    if (!hasOwn(states, state_id)) throw pyerr("KeyError", repr_str(String(state_id)));
    return states[state_id];
  }

  kernel.validate_declared_outputs = function (pkg, state_id, obs, current) {
    const st = state_of(pkg, state_id);
    const a = st.action;
    const writes = Array.isArray(a.writes) ? a.writes.slice() : [];
    const outputs = obs.outputs;
    let delta;
    if (a.kind === "tool") {
      const bound = new Map();
      for (const k of Object.keys(outputs)) bound.set(hasOwn(a.binds, k) ? a.binds[k] : k, outputs[k]);
      const missing = writes.filter((w) => !bound.has(w));
      if (missing.length) {
        throw new KernelError("OUTPUT_INCOMPLETE", "tool output lacks declared writes " + pyr(missing), { missing });
      }
      delta = new Map();
      for (const w of writes) delta.set(w, bound.get(w));
    } else {
      const keys = Object.keys(outputs);
      const wset = new Set(writes), kset = new Set(keys);
      const extra = sorted(keys.filter((k) => !wset.has(k)));
      const missing = sorted(Array.from(wset).filter((w) => !kset.has(w)));
      if (extra.length) {
        throw new KernelError("UNEXPECTED_OUTPUT_KEYS", a.kind + " output has undeclared keys " + pyr(extra), { extra });
      }
      if (missing.length) {
        throw new KernelError("OUTPUT_INCOMPLETE", a.kind + " output lacks declared writes " + pyr(missing), { missing });
      }
      delta = new Map(keys.map((k) => [k, outputs[k]]));
      if (a.kind === "judge") {
        if (!writes.length) throw pyerr("IndexError", "list index out of range");
        const label = delta.get(writes[0]);
        if (!(typeof label === "string" && a.labels.indexOf(label) >= 0)) {
          throw new KernelError("INVALID_JUDGE_LABEL", "label " + pyr(label) + " not in " + pyr(a.labels),
            { label: clone(label) });
        }
      }
    }
    if (!hasOwn(OWNER, a.kind)) throw pyerr("KeyError", repr_str(String(a.kind)));
    const expected_owner = OWNER[a.kind];
    const types = HX.efsm.var_types(pkg.machine);
    const vcs = pkg.contracts.variables;
    for (const [k, v] of delta) {
      const vc = hasOwn(vcs, k) ? vcs[k] : null;
      if (vc === null || vc.owner !== expected_owner) {
        throw new KernelError("WRITE_OWNERSHIP", a.kind + " may not write " + repr_str(k), { variable: k });
      }
      if (v !== null) {
        if (!(k in types)) throw pyerr("KeyError", repr_str(k));
        if (!TYPE_OK[types[k]](v)) {
          throw new KernelError("OUTPUT_TYPE", repr_str(k) + " expects " + types[k] + ", got " + py_type_name(v),
            { variable: k });
        }
      }
      const schema = py_truthy(vc.schema) ? vc.schema : {};
      let errs = schema_errors(schema, v);
      if (v === null && !py_truthy(vc.schema)) errs = [k + ": null is not allowed without an explicit schema"];
      if (errs.length) {
        throw new KernelError("OUTPUT_SCHEMA", repr_str(k) + " fails its schema: " + errs[0], { variable: k, errors: errs });
      }
    }
    const fsw = pkg.contracts.field_scoped_writes;
    const scope = hasOwn(fsw, state_id) ? fsw[state_id] : null;
    if (scope && delta.has(scope.variable)) {
      let old = hasOwn(current, scope.variable) ? current[scope.variable] : null;
      const neu = delta.get(scope.variable);
      if (old === null) old = {};
      if (!is_dict(old) || !is_dict(neu)) {
        throw new KernelError("FIELD_SCOPE_VIOLATION", state_id + " field-scoped variable " + repr_str(scope.variable) +
          " must remain an object", { variable: scope.variable });
      }
      const iv = hasOwn(current, scope.allowed_fields_from) ? current[scope.allowed_fields_from] : null;
      const issues = py_truthy(iv) ? iv : [];
      const allowed = new Set();
      for (const i of Array.isArray(issues) ? issues : []) {
        if (is_dict(i) && hasOwn(i, scope.field_key) && typeof i[scope.field_key] === "string") allowed.add(i[scope.field_key]);
      }
      /* Key presence and exact JSON value (via canonical digest) both count: unset vs null, 1 vs true. */
      const changed = new Set();
      try {
        const all = new Set(Object.keys(old).concat(Object.keys(neu)));
        for (const k of all) {
          const io = hasOwn(old, k), inn = hasOwn(neu, k);
          if (io !== inn || (io && HX.canonical.digest(old[k]) !== HX.canonical.digest(neu[k]))) changed.add(k);
        }
      } catch (exc) {
        if (exc instanceof HX.canonical.CanonicalError) {
          throw new KernelError("FIELD_SCOPE_VIOLATION", state_id + " field-scoped value is not canonical JSON: " +
            exc.message, { variable: scope.variable });
        }
        throw exc;
      }
      const outside = sorted(Array.from(changed).filter((k) => !allowed.has(k)));
      if (outside.length) {
        throw new KernelError("FIELD_SCOPE_VIOLATION", state_id + " changed fields outside " +
          pyr(sorted(Array.from(allowed))) + ": " + pyr(outside), { fields: outside });
      }
    }
    const out = {};
    for (const [k, v] of delta) set_own(out, k, clone(v));
    return out;
  };

  /** First enabled edge, default last. Guard errors are returned, never treated as false.
   *  Returns ``[index, null]``, ``[null, error_message]`` or ``[null, null]``. */
  kernel.select_edge = function (pkg, state_id, variables) {
    const st = state_of(pkg, state_id);
    const ts = st.transitions;
    const ordered = [];
    ts.forEach((t, i) => { if (py_truthy(t["if"])) ordered.push([i, t]); });
    ts.forEach((t, i) => { if (!py_truthy(t["if"])) ordered.push([i, t]); });
    for (const [i, t] of ordered) {
      if (!py_truthy(t["if"])) return [i, null];
      try {
        if (HX.guards.evaluate(t["if"], variables)) return [i, null];
      } catch (exc) {
        if (exc instanceof HX.guards.GuardError) return [null, "edge " + i + " guard " + repr_str(t["if"]) + ": " + exc.message];
        throw exc;
      }
    }
    return [null, null];
  };

  /* ------------------------------------------------------------------------------------------ */
  /* The reducer                                                                                  */
  /* ------------------------------------------------------------------------------------------ */
  function with_updates(cp, upd) {
    const out = {};
    for (const k of Object.keys(cp)) out[k] = hasOwn(upd, k) ? upd[k] : cp[k];
    return out;
  }

  function _stop(cp, status, code, message, events, detail) {
    const a = clone(cp.assurance);
    const diag = { code, message, state: cp.state_id, revision: cp.revision };
    if (detail) for (const k of Object.keys(detail)) set_own(diag, k, clone(detail[k]));
    a.diagnostics.push(diag);
    const neu = with_updates(cp, { status, assurance: a, revision: cp.revision + 1 });
    events.push({ type: "RUN_STOPPED", status, code, state: cp.state_id, message });
    return KernelResult(neu, events);
  }

  function _charge(budget, obs) {
    const b = clone(budget);
    const u = obs.usage;
    const get = (k) => (hasOwn(u, k) ? py_int(u[k]) : 0);
    b.steps += 1;
    b.tool_calls += get("tool_calls");
    b.model_calls += get("model_calls");
    b.tokens += get("tokens");
    b.output_repairs += get("output_repairs");
    return b;
  }

  function _over_budget(pkg, b) {
    const lim = pkg.execution_policy.budgets;
    if (b.steps > Math.min(lim.max_steps, pkg.machine.max_steps)) return "steps";
    if (b.tool_calls > lim.max_tool_calls) return "tool_calls";
    if (b.model_calls > lim.max_model_calls) return "model_calls";
    if (b.tokens > lim.max_tokens) return "tokens";
    return null;
  }

  kernel.advance = function (checkpoint, obs, pkg) {
    if (checkpoint.artifact_hash !== pkg.artifact_hash) {
      throw new KernelError("ARTIFACT_MISMATCH", "checkpoint is pinned to a different artifact");
    }
    if (kernel.TERMINAL_STATUSES.indexOf(checkpoint.status) >= 0) {
      throw new KernelError("RUN_FINISHED", "run already " + checkpoint.status);
    }
    if (obs.run_id !== checkpoint.run_id || obs.state_id !== checkpoint.state_id || obs.revision !== checkpoint.revision) {
      throw new KernelError("OBSERVATION_IDENTITY", "observation does not belong to this state visit",
        { expected: [checkpoint.run_id, checkpoint.state_id, checkpoint.revision],
          got: [obs.run_id, obs.state_id, obs.revision] });
    }
    const states = pkg.machine.states;
    if (!hasOwn(states, checkpoint.state_id)) throw new KernelError("UNKNOWN_STATE", checkpoint.state_id);
    const st = states[checkpoint.state_id];
    if (obs.kind !== st.action.kind) {
      throw new KernelError("OBSERVATION_KIND", "state " + st.id + " is " + st.action.kind + ", observation is " + obs.kind);
    }
    const events = [{ type: "OBSERVATION_ACCEPTED", state: st.id, revision: checkpoint.revision, kind: obs.kind,
      observation_digest: kernel.observation_digest(obs), actor: obs.actor, receipt_ref: obs.receipt_ref }];
    const budget = _charge(checkpoint.budget, obs);
    const cp = with_updates(clone(checkpoint), { budget });

    if (st.action.kind === "end") return _finish(cp, obs, pkg, events);

    if (py_truthy(obs.failure)) {
      /* Recorded host decision: this state could not produce a valid observation. Route to the reserved
         fallback state; record entry permanently. */
      const a = clone(cp.assurance);
      a.entered_fallback = true;
      a.fallback_reason = st.id + ": " + obs.failure;
      const fb = pkg.machine.fallback;
      const neu = with_updates(cp, { state_id: fb, revision: cp.revision + 1, assurance: a, status: "RUNNING" });
      events.push({ type: "FALLBACK_ENTERED", from: st.id, to: fb, reason: obs.failure });
      return KernelResult(neu, events);
    }

    const delta = kernel.validate_declared_outputs(pkg, st.id, obs, cp.variables);
    const after = clone(cp.variables);
    for (const k of Object.keys(delta)) set_own(after, k, clone(delta[k]));
    const [idx, gerr] = kernel.select_edge(pkg, st.id, after);
    if (gerr) return _stop(with_updates(cp, { variables: after }), "FAILED", "GUARD_EVALUATION_ERROR", gerr, events);
    if (idx === null) {
      return _stop(with_updates(cp, { variables: after }), "FAILED", "NO_ENABLED_TRANSITION",
        "no edge enabled from " + st.id, events);
    }
    const edge = st.transitions[idx];
    if (py_truthy(edge.inc)) { /* the guard saw the old counter; the increment follows selection */
      set_own(after, edge.inc, py_int(hasOwn(after, edge.inc) ? after[edge.inc] : 0) + 1);
    }
    const over = _over_budget(pkg, budget);
    if (over) {
      return _stop(with_updates(cp, { variables: after }), "FAILED", "BUDGET_EXHAUSTED",
        "run budget '" + over + "' exhausted", events);
    }
    const neu = with_updates(cp, { variables: after, state_id: edge.to, revision: cp.revision + 1, status: "RUNNING" });
    const e = { index: idx, "if": edge["if"], to: edge.to, inc: edge.inc };
    events.push({ type: "TRANSITION", from: st.id, to: edge.to, edge: clone(e), delta_keys: sorted(Object.keys(delta)),
      delta_digest: HX.canonical.digest(delta), revision: neu.revision });
    return KernelResult(neu, events, delta, e);
  };

  function _finish(cp, obs, pkg, events) {
    const st = pkg.machine.states[cp.state_id];
    const tid = st.action.terminal;
    const term = HX.efsm.terminal(pkg.machine, tid);
    const tcs = pkg.contracts.terminals;
    const tc = hasOwn(tcs, tid) ? tcs[tid] : null;
    const touts = term ? term.output : [];
    const missing = touts.filter((o) => !hasOwn(cp.variables, o));
    if (missing.length) {
      return _stop(cp, "FAILED", "TERMINAL_OUTPUT_MISSING", "terminal " + tid + " lacks outputs " + pyr(missing), events);
    }
    const adm = hasOwn(obs.engine, "terminal_admission") ? obs.engine.terminal_admission : {};
    const a = clone(cp.assurance);
    a.unresolved_effects = clone(py_list(py_get(adm, "unresolved_effects", [])));
    if (tc !== null && tc.category === "verified") {
      if (!py_truthy(py_get(adm, "evidence_valid", null)) || a.unresolved_effects.length) {
        a.missing_evidence = clone(py_list(py_get(adm, "missing", ["no valid evidence receipt"])));
        return _stop(with_updates(cp, { assurance: a }), "FAILED", "TERMINAL_ADMISSION_DENIED",
          "verified terminal " + tid + " not supported by current evidence", events, { missing: a.missing_evidence });
      }
      a.verification_scope = tc.verification_scope;
    }
    const outputs = {};
    for (const o of touts) set_own(outputs, o, clone(cp.variables[o]));
    const outcome = { terminal: tid, category: tc ? tc.category : (term ? term.kind : ""), outputs,
      evidence_receipts: clone(py_list(py_get(adm, "receipts", []))) };
    const neu = with_updates(cp, { status: "COMPLETED", outcome, assurance: a, revision: cp.revision + 1,
      evidence_refs: clone(py_list(py_get(adm, "receipts", []))) });
    events.push({ type: "TERMINAL_ADMITTED", terminal: tid, category: outcome.category });
    return KernelResult(neu, events);
  }
})(globalThis.HX = globalThis.HX || {});
