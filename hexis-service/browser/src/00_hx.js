/* HEXIS browser engine: core namespace, error base and shared utilities. Loaded first. */
(function (HX) {
  "use strict";

  HX.VERSION = "hexis-browser/1";

  /** Base class for every engine error. Mirrors Python exceptions that carry code/message/detail. */
  class HXError extends Error {
    constructor(code, message, detail) {
      super(message === undefined ? String(code) : (code ? code + ": " + message : message));
      this.name = this.constructor.name;
      this.code = code;
      this.msg = message === undefined ? String(code) : message;
      this.detail = detail || {};
    }
  }
  HX.HXError = HXError;

  const util = (HX.util = HX.util || {});

  util.is_plain_object = function (v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };

  /** Deep copy of JSON-like data (objects, arrays, primitives). */
  util.deep_clone = function deep_clone(v) {
    if (Array.isArray(v)) return v.map(deep_clone);
    if (util.is_plain_object(v)) {
      const out = {};
      for (const k of Object.keys(v)) out[k] = deep_clone(v[k]);
      return out;
    }
    return v;
  };

  /** Structural equality for JSON-like data (Python == semantics, except bool !== number). */
  util.deep_equal = function deep_equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a === "number") return a === b; /* NaN never equal; -0 === 0 */
    if (a === null || b === null) return false;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deep_equal(a[i], b[i])) return false;
      return true;
    }
    if (Array.isArray(b)) return false;
    if (typeof a === "object") {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!deep_equal(a[k], b[k])) return false;
      }
      return true;
    }
    return false;
  };

  /** Compare two strings by Unicode code point (Python str ordering). */
  util.cmp_codepoints = function (a, b) {
    if (a === b) return 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a.charCodeAt(i), y = b.charCodeAt(i);
      if (x !== y) {
        const xs = x >= 0xd800 && x <= 0xdfff, ys = y >= 0xd800 && y <= 0xdfff;
        if (xs === ys) return x < y ? -1 : 1; /* both BMP or both surrogate units */
        /* exactly one is a surrogate (astral code point >= 0x10000): it sorts after any BMP unit */
        return xs ? 1 : -1;
      }
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  };

  util.sorted_keys = function (obj) {
    return Object.keys(obj).sort(util.cmp_codepoints);
  };

  /** Number of Unicode code points (Python len(str)). */
  util.codepoint_length = function (s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) i++;
      }
      n++;
    }
    return n;
  };

  /** True if the string contains an unpaired surrogate (not encodable as UTF-8). */
  util.has_lone_surrogate = function (s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
        return true;
      }
      if (c >= 0xdc00 && c <= 0xdfff) return true;
    }
    return false;
  };

  const _enc = new TextEncoder();
  util.utf8 = function (s) { return _enc.encode(s); };

  /* ---------------- Python repr (for messages that mirror the reference) ---------------- */

  function repr_str(s) {
    const quote = s.indexOf("'") >= 0 && s.indexOf('"') < 0 ? '"' : "'";
    let out = quote;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === "\\") out += "\\\\";
      else if (ch === quote) out += "\\" + quote;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad) out += "\\x" + c.toString(16).padStart(2, "0");
      else if (c >= 0xd800 && c <= 0xdfff) out += "\\u" + c.toString(16).padStart(4, "0");
      else out += ch;
    }
    return out + quote;
  }

  /** Python repr() of a JSON-like value (True/False/None, single-quoted strings, float repr). */
  util.py_repr = function py_repr(v) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return HX.canonical ? HX.canonical.py_number(v) : String(v);
    if (typeof v === "string") return repr_str(v);
    if (Array.isArray(v)) return "[" + v.map(py_repr).join(", ") + "]";
    if (typeof v === "object") {
      return "{" + Object.keys(v).map((k) => repr_str(k) + ": " + py_repr(v[k])).join(", ") + "}";
    }
    return String(v);
  };

  /** Default id source: deterministic counter-based hex ids (32 hex digits like uuid4().hex). */
  util.make_id_source = function (start) {
    let n = start === undefined ? 1 : start;
    return function next_hex() {
      const s = (n++).toString(16);
      return "0".repeat(Math.max(0, 32 - s.length)) + s;
    };
  };
})(globalThis.HX = globalThis.HX || {});
