/* Port of hexis_service/canonical.py: strict JSON intake, canonical serialization, SHA-256 digests.
 *
 * Canonical form hexis-canon/1 (byte-identical to Python's json.dumps(sort_keys=True,
 * separators=(",", ":"), ensure_ascii=False)):
 *  - object keys sorted by Unicode code point, arrays in order, no whitespace;
 *  - integers as integers; non-integers with Python's float repr rules (shortest round-trip digits,
 *    exponent form when decpt <= -4 or decpt > 16, at least two exponent digits);
 *  - strings escaped exactly like Python (", \, \b \f \n \r \t, other C0 controls as \u00xx).
 *
 * Deliberate, conservative deviations (see DEVIATIONS.md): JS has a single number type, so integral
 * float literals (1.0, -0.0, 1e2) and integers outside +/-(2^53-1) are rejected by strict_loads and by
 * check_value instead of being silently changed.
 */
(function (HX) {
  "use strict";
  const canonical = (HX.canonical = HX.canonical || {});
  const util = HX.util;

  canonical.CANON_VERSION = "hexis-canon/1";
  canonical.MAX_BYTES = 8 * 1024 * 1024;
  canonical.MAX_DEPTH = 64;
  canonical.MAX_STRING = 1024 * 1024;
  canonical.MAX_INT_BITS = 4096 * 3;

  class CanonicalError extends HX.HXError {
    constructor(message) {
      super("CANONICAL", message);
      this.message = message;
    }
  }
  canonical.CanonicalError = CanonicalError;

  /* ------------------------------------------------------------------------------------------ */
  /* Python-compatible number formatting                                                         */
  /* ------------------------------------------------------------------------------------------ */

  /** Python repr of a non-integer finite float. */
  function py_float_repr(x) {
    if (!Number.isFinite(x)) throw new CanonicalError("non-finite number");
    const neg = x < 0 || Object.is(x, -0);
    const ex = Math.abs(x).toExponential(); /* shortest round-trip digits, e.g. "1.2345e+2" */
    const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(ex);
    if (!m) throw new CanonicalError("cannot format number " + String(x));
    let digits = m[1] + (m[2] || "");
    digits = digits.replace(/0+$/, "") || "0";
    const e = parseInt(m[3], 10);
    const decpt = e + 1; /* value = 0.DIGITS x 10^decpt */
    let body;
    if (decpt <= -4 || decpt > 16) {
      const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
      const ee = decpt - 1;
      const sign = ee < 0 ? "-" : "+";
      const mag = String(Math.abs(ee)).padStart(2, "0");
      body = mant + "e" + sign + mag;
    } else if (decpt <= 0) {
      body = "0." + "0".repeat(-decpt) + digits;
    } else if (decpt >= digits.length) {
      body = digits + "0".repeat(decpt - digits.length) + ".0";
    } else {
      body = digits.slice(0, decpt) + "." + digits.slice(decpt);
    }
    return (neg ? "-" : "") + body;
  }
  canonical.py_float_repr = py_float_repr;

  /** Format a JS number the way Python would format the corresponding int/float. */
  canonical.py_number = function (x) {
    if (Number.isInteger(x)) return Object.is(x, -0) ? "0" : String(x).indexOf("e") >= 0 ? BigInt(x).toString() : String(x);
    return py_float_repr(x);
  };

  /* ------------------------------------------------------------------------------------------ */
  /* check_value                                                                                 */
  /* ------------------------------------------------------------------------------------------ */

  function check_string(s) {
    if (s.length > canonical.MAX_STRING && util.codepoint_length(s) > canonical.MAX_STRING) {
      throw new CanonicalError("string too long");
    }
    if (util.has_lone_surrogate(s)) throw new CanonicalError("lone surrogate in string");
  }

  function check_value(value, depth) {
    depth = depth || 0;
    if (depth > canonical.MAX_DEPTH) throw new CanonicalError("nesting too deep");
    if (value === null || value === true || value === false) return;
    const t = typeof value;
    if (t === "number") {
      if (!Number.isFinite(value)) throw new CanonicalError("non-finite number");
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new CanonicalError("integer outside the exactly representable range (+/-(2^53-1))");
      }
      return;
    }
    if (t === "string") { check_string(value); return; }
    if (Array.isArray(value)) {
      for (const v of value) check_value(v, depth + 1);
      return;
    }
    if (util.is_plain_object(value)) {
      for (const k of Object.keys(value)) {
        check_string(k);
        if (value[k] === undefined) throw new CanonicalError("undefined value for key " + util.py_repr(k));
        check_value(value[k], depth + 1);
      }
      return;
    }
    throw new CanonicalError("unsupported type " + (value === undefined ? "undefined" : t));
  }
  canonical.check_value = function (value, depth) { check_value(value, depth || 0); };

  /* ------------------------------------------------------------------------------------------ */
  /* Canonical serialization                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  function ser(value, out) {
    if (value === null) { out.push("null"); return; }
    if (value === true) { out.push("true"); return; }
    if (value === false) { out.push("false"); return; }
    if (typeof value === "number") { out.push(canonical.py_number(value)); return; }
    if (typeof value === "string") { out.push(JSON.stringify(value)); return; }
    if (Array.isArray(value)) {
      out.push("[");
      for (let i = 0; i < value.length; i++) {
        if (i) out.push(",");
        ser(value[i], out);
      }
      out.push("]");
      return;
    }
    const keys = util.sorted_keys(value);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i) out.push(",");
      out.push(JSON.stringify(keys[i]), ":");
      ser(value[keys[i]], out);
    }
    out.push("}");
  }

  /** Canonical JSON text (string). */
  canonical.canonical_text = function (value) {
    check_value(value, 0);
    const out = [];
    ser(value, out);
    return out.join("");
  };

  /** Canonical JSON as UTF-8 bytes (Uint8Array), like Python canonical_bytes. */
  canonical.canonical_bytes = function (value) {
    return util.utf8(canonical.canonical_text(value));
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Strict JSON parser (duplicate keys, depth, numbers, surrogates)                              */
  /* ------------------------------------------------------------------------------------------ */

  function parse_strict(text) {
    let i = 0;
    const n = text.length;
    function fail(msg) { throw new CanonicalError("invalid JSON: " + msg + " at char " + i); }
    function ws() {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
        else break;
      }
    }
    function value(depth) {
      if (depth > canonical.MAX_DEPTH) throw new CanonicalError("nesting too deep");
      ws();
      if (i >= n) fail("unexpected end");
      const c = text[i];
      if (c === "{") return object(depth);
      if (c === "[") return array(depth);
      if (c === '"') return string();
      if (c === "t") return literal("true", true);
      if (c === "f") return literal("false", false);
      if (c === "n") return literal("null", null);
      if (c === "N" || c === "I" || (c === "-" && text[i + 1] === "I")) {
        throw new CanonicalError("non-finite number is not allowed");
      }
      if (c === "-" || (c >= "0" && c <= "9")) return number();
      fail("unexpected character " + util.py_repr(c));
    }
    function literal(word, v) {
      if (text.substr(i, word.length) !== word) fail("expected " + word);
      i += word.length;
      return v;
    }
    function number() {
      const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(i, i + 4096));
      if (!m) fail("bad number");
      const lit = m[0];
      i += lit.length;
      const isFloat = m[1] !== undefined || m[2] !== undefined;
      const v = Number(lit);
      if (!Number.isFinite(v)) throw new CanonicalError("non-finite number");
      if (isFloat && Number.isInteger(v)) {
        throw new CanonicalError("integral float literal " + lit + " is not representable (use an integer)");
      }
      if (!isFloat && !Number.isSafeInteger(v)) {
        throw new CanonicalError("integer outside the exactly representable range (+/-(2^53-1))");
      }
      return v === 0 ? 0 : v; /* "-0" is the integer 0, as in Python */
    }
    function string() {
      i++; /* opening quote */
      let out = "";
      let start = i;
      while (true) {
        if (i >= n) fail("unterminated string");
        const c = text.charCodeAt(i);
        if (c === 0x22) { out += text.slice(start, i); i++; break; }
        if (c < 0x20) fail("invalid control character");
        if (c === 0x5c) {
          out += text.slice(start, i);
          const e = text[i + 1];
          i += 2;
          if (e === '"') out += '"';
          else if (e === "\\") out += "\\";
          else if (e === "/") out += "/";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "n") out += "\n";
          else if (e === "r") out += "\r";
          else if (e === "t") out += "\t";
          else if (e === "u") {
            const h = text.substr(i, 4);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("bad unicode escape");
            out += String.fromCharCode(parseInt(h, 16));
            i += 4;
          } else fail("bad escape");
          start = i;
          continue;
        }
        i++;
      }
      return out;
    }
    function array(depth) {
      i++;
      const out = [];
      ws();
      if (text[i] === "]") { i++; return out; }
      while (true) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return out; }
        fail("expected , or ]");
      }
    }
    function object(depth) {
      i++;
      const out = {};
      const seen = new Set();
      ws();
      if (text[i] === "}") { i++; return out; }
      while (true) {
        ws();
        if (text[i] !== '"') fail("expected property name");
        const k = string();
        ws();
        if (text[i] !== ":") fail("expected :");
        i++;
        const v = value(depth + 1);
        if (seen.has(k)) throw new CanonicalError("duplicate JSON key " + util.py_repr(k));
        seen.add(k);
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return out; }
        fail("expected , or }");
      }
    }
    const v = value(0);
    ws();
    if (i !== n) fail("extra data");
    return v;
  }

  /** Parse JSON text strictly (mirrors strict_loads(str)). */
  canonical.strict_loads = function (text) {
    if (text instanceof Uint8Array) return canonical.strict_loads_bytes(text);
    if (typeof text !== "string") throw new CanonicalError("strict_loads expects a string");
    if (util.utf8(text).length > canonical.MAX_BYTES) throw new CanonicalError("document exceeds size limit");
    const v = parse_strict(text);
    check_value(v, 0);
    return v;
  };

  /** Parse UTF-8 bytes strictly (mirrors strict_loads(bytes)). */
  canonical.strict_loads_bytes = function (bytes) {
    if (bytes.length > canonical.MAX_BYTES) throw new CanonicalError("document exceeds size limit");
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new CanonicalError("UTF-8 BOM is not allowed");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      throw new CanonicalError("invalid UTF-8: " + e.message);
    }
    const v = parse_strict(text);
    check_value(v, 0);
    return v;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* SHA-256 / HMAC-SHA256 (synchronous, pure JS)                                                  */
  /* ------------------------------------------------------------------------------------------ */

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256_bytes(data) {
    const len = data.length;
    const bitLenHi = Math.floor(len / 0x20000000);
    const bitLenLo = (len << 3) >>> 0;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(data);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bitLenHi);
    dv.setUint32(padded.length - 4, bitLenLo);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
      for (let t = 16; t < 64; t++) {
        const a = w[t - 15], b = w[t - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, idx) => odv.setUint32(idx * 4, v));
    return out;
  }
  canonical.sha256_bytes = function (data) {
    return sha256_bytes(typeof data === "string" ? util.utf8(data) : data);
  };

  function hex(bytes) {
    let s = "";
    for (let k = 0; k < bytes.length; k++) s += (bytes[k] < 16 ? "0" : "") + bytes[k].toString(16);
    return s;
  }
  canonical.hex = hex;

  /** sha256 hex of a string (UTF-8) or bytes. */
  canonical.sha256_hex = function (data) {
    if (typeof data === "string") {
      if (util.has_lone_surrogate(data)) throw new CanonicalError("lone surrogate in string");
      data = util.utf8(data);
    }
    return hex(sha256_bytes(data));
  };

  /** HMAC-SHA256 hex digest (key and message: string or bytes). */
  canonical.hmac_sha256_hex = function (key, message) {
    let k = typeof key === "string" ? util.utf8(key) : key;
    const m = typeof message === "string" ? util.utf8(message) : message;
    if (k.length > 64) k = sha256_bytes(k);
    const ipad = new Uint8Array(64 + m.length);
    const opadKey = new Uint8Array(64);
    for (let j = 0; j < 64; j++) {
      const kb = j < k.length ? k[j] : 0;
      ipad[j] = kb ^ 0x36;
      opadKey[j] = kb ^ 0x5c;
    }
    ipad.set(m, 64);
    const inner = sha256_bytes(ipad);
    const outer = new Uint8Array(64 + 32);
    outer.set(opadKey);
    outer.set(inner, 64);
    return hex(sha256_bytes(outer));
  };

  /** Constant-time-ish string comparison (mirrors hmac.compare_digest usage). */
  canonical.compare_digest = function (a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    let r = 0;
    for (let j = 0; j < a.length; j++) r |= a.charCodeAt(j) ^ b.charCodeAt(j);
    return r === 0;
  };

  /** "sha256:<hex>" of the canonical form. */
  canonical.digest = function (value) {
    return "sha256:" + hex(sha256_bytes(canonical.canonical_bytes(value)));
  };
})(globalThis.HX = globalThis.HX || {});
