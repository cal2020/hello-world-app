/* Port of hexis_service/guards.py: allowlisted guard parsing, static typing, strict and Kleene
 * evaluation, and PROVEN / COUNTEREXAMPLE / UNKNOWN disjointness analysis.
 *
 * parse() accepts exactly the strings the Python reference accepts, i.e. CPython 3.12's
 * ast.parse(expr, mode="eval") followed by the allowlist and the size limits, and rejects the others with
 * Python's message. It is built from
 *   - a port of the CPython 3.12 tokenizer (indentation, blank and comment lines, backslash
 *     continuation, nesting limit of 200 brackets, number literals including the keyword-adjacent
 *     forms such as `1and x`, string prefixes and escapes, PEP 701 f-strings, newline translation);
 *   - identifiers checked against Python's own Unicode 15.0 XID tables (embedded below; JS engines
 *     ship newer Unicode data) and NFKC-normalized like CPython (keywords are recognized on the raw
 *     spelling, so `Ｔｒｕｅ` is the name `True`);
 *   - a recursive-descent parser for the whole expression grammar (first PEG pass) that builds
 *     Python-shaped AST nodes for every construct, so node counts and depths are computed exactly like
 *     ast.walk and guards._depth (which count Expression, ctx and operator nodes) and _check reports the
 *     same first offending node as Python.
 * Every rejection is a GuardError. Syntax error texts approximate CPython's (its second, error-reporting
 * parser pass is not ported).
 *
 * Deliberate, conservative deviations (deviations/guards.md): integer literals above 2^53-1, string
 * escapes that produce surrogate code points and \N{...} escapes are rejected when the guard would
 * otherwise be accepted; inputs on which CPython raises a non-GuardError (lone surrogates, parser stack
 * overflow, the f-string ValueError) raise GuardError; disjointness analysis reports UNKNOWN when it would
 * have to evaluate a representative value that no JS number can stand for.
 */
(function (HX) {
  "use strict";
  const guards = (HX.guards = HX.guards || {});

  /* ------------------------------------------------------------------------------------------ */
  /* Constants and errors                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  guards.MAX_LEN = 512;
  guards.MAX_DEPTH = 12;
  guards.MAX_NODES = 64;
  guards.MAX_LIST = 32;
  guards.MAX_STR = 256;
  guards.MAX_CONFIGS = 20000;
  guards.PREDICATES = Object.freeze(["empty", "nonempty"]);
  /** Python's _CMP keyed by ast op class name (the strings in Compare.ops). */
  guards._CMP = Object.freeze({ Eq: "==", NotEq: "!=", Lt: "<", LtE: "<=", Gt: ">", GtE: ">=", In: "in", NotIn: "not in" });
  guards.NUMERIC = Object.freeze(["integer", "number"]);
  /** JS-only: integer literals above this are rejected (Python accepts arbitrary precision). */
  guards.MAX_INT_LITERAL = Number.MAX_SAFE_INTEGER;

  class GuardError extends HX.HXError {
    constructor(message) {
      super("GUARD", message);
      this.message = message; /* str(exc) in Python */
    }
  }
  guards.GuardError = GuardError;

  /** Python's UNKNOWN sentinel (structural replay placeholder). Not a plain object, not JSON. */
  class _Unknown {
    toString() { return "UNKNOWN"; }
  }
  guards._Unknown = _Unknown;
  const UNKNOWN = Object.freeze(new _Unknown());
  guards.UNKNOWN = UNKNOWN;

  const hasOwn = Object.prototype.hasOwnProperty;
  function has_key(m, k) {
    if (m instanceof Map) return m.has(k);
    return m !== null && typeof m === "object" && hasOwn.call(m, k);
  }
  function get_key(m, k) { return m instanceof Map ? m.get(k) : m[k]; }
  function is_predicate(id) { return id === "empty" || id === "nonempty"; }
  /** Python repr() for message text: exact for str (Unicode 15.0 printable table), HX.util.py_repr otherwise. */
  function repr(v) { return typeof v === "string" ? py_repr_str(v) : HX.util.py_repr(v); }

  /** Python truthiness of a JSON-like value. */
  function py_truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (v === true) return true;
    if (typeof v === "number") return v !== 0; /* NaN is truthy in Python too */
    if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (HX.util.is_plain_object(v)) return Object.keys(v).length > 0;
    return true;
  }
  guards._py_truthy = py_truthy;

  /* ------------------------------------------------------------------------------------------ */
  /* Unicode data taken from CPython 3.12 (unicodedata 15.0.0)                                   */
  /* ------------------------------------------------------------------------------------------ */

  /* XID_Start / XID_Continue as ranges, each entry "gap,length" in hex relative to the previous end. */
  const XID_START_DATA =
    "41,19,7,19,30,0,b,0,5,0,6,16,2,1e,2,1c9,5,b,f,4,8,0,2,0,82,4,2,1,4,2,2,0,7,0,2,2,2,0,2,13,2,52,2,8a,9,a5,2,2" +
    "5,3,0,7,28,48,1a,5,3,2e,2a,24,1,2,62,2,0,10,1,8,1,b,2,3,0,11,0,2,1d,1e,58,c,0,19,20,a,1,5,0,6,15,5,0,a,0,4,0" +
    ",18,18,8,a,6,17,2,5,12,29,3b,35,4,0,13,0,8,9,10,f,5,7,3,1,3,15,2,6,2,0,4,3,4,0,11,0,e,1,2,2,f,1,b,0,9,5,5,1," +
    "3,15,2,6,2,1,2,1,2,1,20,3,2,0,14,2,11,8,2,2,2,15,2,6,2,1,2,4,4,0,13,0,10,1,18,0,c,7,3,1,3,15,2,6,2,1,2,4,4,0" +
    ",1f,1,2,2,10,0,12,0,2,5,4,2,2,3,4,1,2,0,2,1,4,1,4,2,4,b,17,0,35,7,2,2,2,16,2,f,4,0,1b,2,3,0,3,1,1f,0,5,7,2,2" +
    ",2,16,2,9,2,4,4,0,20,1,2,1,10,1,12,8,2,2,2,28,3,0,11,0,6,2,9,2,19,5,6,11,4,17,2,8,2,0,3,6,3b,2f,2,0,e,6,3b,1" +
    ",2,0,2,4,2,17,2,0,2,9,2,0,b,0,3,4,2,0,16,3,21,0,40,7,2,23,1c,4,74,2a,15,0,11,5,5,3,4,0,4,1,8,2,5,c,d,0,12,25" +
    ",2,0,6,0,3,2a,2,14c,2,3,3,6,2,0,2,3,3,28,2,3,3,20,2,3,3,6,2,0,2,3,3,e,2,38,2,3,3,42,26,f,11,55,3,5,4,26b,3,1" +
    "0,2,19,6,4a,4,a,8,11,e,12,f,11,f,c,2,2,10,33,24,0,5,0,44,58,8,28,2,0,6,45,b,1e,32,1d,3,4,c,2b,5,19,37,16,a,3" +
    "4,53,0,5e,2e,12,7,37,1d,e,1,b,2b,1b,23,2a,2,b,23,3,8,8,2a,3,2,2a,3,2,5,2,1,4,0,6,bf,41,115,3,5,3,25,3,5,3,7," +
    "2,0,2,0,2,0,2,1e,3,34,2,6,2,0,4,2,2,6,4,3,3,5,5,c,6,2,2,6,75,0,e,0,11,c,66,0,5,0,3,9,2,0,3,5,7,0,2,0,2,0,2,f" +
    ",3,3,6,4,5,0,12,28,a78,e4,7,3,4,1,d,25,2,0,6,0,3,37,8,0,11,16,a,6,2,6,2,6,2,6,2,6,2,6,2,6,2,6,227,2,1a,8,8,4" +
    ",3,4,5,55,7,2,2,59,2,3,6,2a,2,5d,12,1f,31,f,201,19bf,41,568c,44,2d,3,10c,4,f,b,1,15,2e,11,1e,3,4f,28,8,3,66," +
    "3,3f,6,1,2,0,2,4,19,f,2,2,2,3,2,16,1e,33,f,31,3f,5,4,0,2,1,c,1b,b,16,1a,1c,8,2e,1d,0,11,4,2,9,b,4,2,28,18,2," +
    "2,7,15,16,4,0,4,31,2,0,4,1,3,4,3,0,2,0,19,2,3,a,8,2,d,5,3,5,3,5,a,6,2,6,2,2a,2,d,7,72,1e,2ba3,d,16,5,30,2105" +
    ",16d,3,69,27,6,d,4,6,0,2,9,2,c,2,4,2,0,2,1,2,1,2,6b,22,8a,7,d9,13,3f,3,35,29,9,78,0,2,0,4,0,2,0,2,0,2,0,2,7d" +
    ",25,19,7,19,c,37,3,1e,4,5,3,5,3,5,3,2,24,b,2,19,2,12,2,1,2,e,3,d,23,7a,46,34,10c,1c,4,30,30,1f,e,1d,6,25,b,1" +
    "d,3,23,5,7,2,4,2b,9d,13,23,5,23,5,27,9,33,d,a,2,e,2,6,2,1,2,a,2,e,2,6,2,1,44,136,a,15,b,7,19,5,2,29,2,8,46,5" +
    ",3,0,2,2b,2,1,4,0,3,16,b,16,a,1e,42,12,2,1,b,15,b,19,47,37,7,1,41,0,10,3,2,2,2,1c,2b,1c,4,1c,24,7,2,1b,1c,35" +
    ",b,15,b,12,e,11,6f,48,38,32,e,32,e,23,15d,29,7,1,4f,1c,b,0,9,15,2b,11,2f,14,1c,16,d,34,3a,1,3,0,e,2c,21,18,1" +
    "b,23,1e,0,3,0,9,22,4,0,d,2f,f,3,16,0,2,0,24,11,2,18,14,1,40,6,2,0,2,3,2,e,2,9,8,2e,27,7,3,1,3,15,2,6,2,1,2,4" +
    ",4,0,13,0,d,4,9f,34,13,3,15,2,1f,2f,15,1,2,0,b9,2e,2a,3,25,2f,15,0,3c,2a,e,0,48,1a,26,6,ba,2b,75,3f,20,7,3,0" +
    ",3,7,2,1,2,17,10,0,2,0,5f,7,3,26,11,0,2,0,1d,0,b,27,8,0,16,0,c,2d,14,0,13,48,108,8,2,24,12,0,32,1d,71,6,2,1," +
    "2,25,16,0,1a,5,2,1,2,1f,f,0,148,12,10,0,2,c,2,21,7d,0,50,399,67,6e,12,c3,a4d,60,10,42f,12,5,fba,246,21ba,238" +
    ",8,1e,12,4e,12,1d,13,2f,11,3,20,14,6,12,2b1,3f,81,4a,6,0,43,c,41,1,2,0,1d,17f7,9,4d5,2b,8,22e8,3,2,6,2,1,2,1" +
    "22,10,0,1e,2,3,0,f,3,9,18b,905,6a,6,c,4,8,8,9,1767,54,2,46,2,1,3,0,3,1,3,3,2,b,2,0,2,6,2,40,2,3,3,7,2,6,2,1b" +
    ",2,3,2,4,2,0,4,6,2,153,3,18,2,18,2,1e,2,18,2,1e,2,18,2,1e,2,18,2,1e,2,18,2,7,735,1e,7,5,106,3d,93,2c,b,6,11," +
    "0,142,1d,13,2b,1e5,1b,2f5,6,2,3,2,1,2,e,2,c4,3c,43,8,0,4b5,3,2,1a,2,1,2,0,3,0,2,9,2,3,2,0,2,0,7,0,5,0,2,0,2," +
    "0,2,2,2,1,2,0,3,0,2,0,2,0,2,0,2,0,2,1,2,0,3,3,2,6,2,3,2,3,2,0,2,9,2,10,6,2,2,4,2,10,1145,a6df,21,1039,7,dd,3" +
    ",1681,f,1d30,c20,21d,5e3,134a,6,105f";
  const XID_CONTINUE_DATA =
    "30,9,8,19,5,0,2,19,30,0,b,0,2,0,3,0,6,16,2,1e,2,1c9,5,b,f,4,8,0,2,0,12,74,2,1,4,2,2,0,7,4,2,0,2,13,2,52,2,8a" +
    ",2,4,3,a5,2,25,3,0,7,28,9,2c,2,0,2,1,2,1,2,0,9,1a,5,3,1e,a,6,49,5,65,2,7,3,9,2,12,3,0,11,3a,3,64,f,35,5,0,3," +
    "0,3,2d,13,1b,5,a,6,17,2,5,a,49,2,80,3,9,2,12,2,7,3,1,3,15,2,6,2,0,4,3,3,8,3,1,3,3,9,0,5,1,2,4,3,b,b,0,2,0,3," +
    "2,2,5,5,1,3,15,2,6,2,1,2,1,2,1,3,0,2,4,5,1,3,2,4,0,8,3,2,0,8,f,c,2,2,8,2,2,2,15,2,6,2,1,2,4,3,9,2,2,2,2,3,0," +
    "10,3,3,9,a,6,2,2,2,7,3,1,3,15,2,6,2,1,2,4,3,8,3,1,3,2,8,2,5,1,2,4,3,9,2,0,11,1,2,5,4,2,2,3,4,1,2,0,2,1,4,1,4" +
    ",2,4,b,5,4,4,2,2,3,3,0,7,0,f,9,11,c,2,2,2,16,2,f,3,8,2,2,2,3,8,1,2,2,3,0,3,3,3,9,11,3,2,7,2,2,2,16,2,9,2,4,3" +
    ",8,2,2,2,3,8,1,7,1,2,3,3,9,2,2,d,c,2,2,2,32,2,2,2,4,6,3,8,4,3,9,b,5,2,2,2,11,4,17,2,8,2,0,3,6,4,0,5,5,2,0,2," +
    "7,7,9,3,1,e,39,6,e,2,9,28,1,2,0,2,4,2,17,2,0,2,16,3,4,2,0,2,6,2,9,3,3,21,0,18,1,7,9,c,0,2,0,2,0,5,9,2,23,5,1" +
    "3,2,11,2,23,a,0,3a,49,7,4d,3,25,2,0,6,0,3,2a,2,14c,2,3,3,6,2,0,2,3,3,28,2,3,3,20,2,3,3,6,2,0,2,3,3,e,2,38,2," +
    "3,3,42,3,2,a,8,f,f,11,55,3,5,4,26b,3,10,2,19,6,4a,4,a,8,15,a,15,c,13,d,c,2,2,2,1,d,53,4,0,5,1,3,9,22,2,2,a,7" +
    ",58,8,2a,6,45,b,1e,2,b,5,b,b,27,3,4,c,2b,5,19,7,a,26,1b,5,3e,2,1c,3,a,7,9,e,0,9,d,2,f,32,4c,4,9,12,8,d,73,d," +
    "37,9,9,4,30,3,8,8,2a,3,2,11,2,2,26,6,215,3,5,3,25,3,5,3,7,2,0,2,0,2,0,2,1e,3,34,2,6,2,0,4,2,2,6,4,3,3,5,5,c," +
    "6,2,2,6,43,1,14,0,1d,0,e,0,11,c,34,c,5,0,4,b,12,0,5,0,3,9,2,0,3,5,7,0,2,0,2,0,2,f,3,3,6,4,5,0,12,28,a78,e4,7" +
    ",8,d,25,2,0,6,0,3,37,8,0,10,17,a,6,2,6,2,6,2,6,2,6,2,6,2,6,2,6,2,1f,206,2,1a,e,2,4,3,4,5,55,3,1,3,2,2,59,2,3" +
    ",6,2a,2,5d,12,1f,31,f,201,19bf,41,568c,44,2d,3,10c,4,1b,15,2f,5,9,2,72,26,8,3,66,3,3f,6,1,2,0,2,4,19,35,5,0," +
    "14,33,d,45,b,9,7,17,4,0,2,30,3,23,d,1c,4,40,f,a,7,1e,2,36,a,d,3,9,7,16,4,48,19,2,3,f,3,4,b,5,3,5,3,5,a,6,2,6" +
    ",2,2a,2,d,7,7a,2,1,3,9,7,2ba3,d,16,5,30,2105,16d,3,69,27,6,d,4,6,b,2,c,2,4,2,0,2,1,2,1,2,6b,22,8a,7,d9,13,3f" +
    ",3,35,29,9,7,f,11,f,4,1,19,2,22,0,2,0,4,0,2,0,2,0,2,0,2,7d,14,9,8,19,5,0,2,19,c,58,4,5,3,5,3,5,3,2,24,b,2,19" +
    ",2,12,2,1,2,e,3,d,23,7a,46,34,89,0,83,1c,4,30,10,0,20,1f,e,1d,6,2a,6,1d,3,23,5,7,2,4,2b,9d,3,9,7,23,5,23,5,2" +
    "7,9,33,d,a,2,e,2,6,2,1,2,a,2,e,2,6,2,1,44,136,a,15,b,7,19,5,2,29,2,8,46,5,3,0,2,2b,2,1,4,0,3,16,b,16,a,1e,42" +
    ",12,2,1,b,15,b,19,47,37,7,1,41,3,2,1,6,7,2,2,2,1c,3,2,5,0,21,1c,4,1c,24,7,2,1d,1a,35,b,15,b,12,e,11,6f,48,38" +
    ",32,e,32,e,27,9,9,147,29,2,1,4,1,4c,1f,b,0,9,20,20,15,2b,14,1c,16,a,46,20,f,a,3b,8,0,e,18,8,9,7,34,2,9,5,3,9" +
    ",23,3,0,a,44,5,3,2,c,2,0,24,11,2,24,7,3,3f,6,2,0,2,3,2,e,2,9,8,3a,6,9,7,3,2,7,3,1,3,15,2,6,2,1,2,4,2,9,3,1,3" +
    ",2,3,0,7,0,6,6,3,6,4,4,8c,4a,6,9,5,3,1f,45,2,0,9,9,a7,35,3,8,18,5,23,40,4,0,c,9,27,38,8,9,37,1a,3,e,5,9,7,6," +
    "ba,3a,66,49,16,7,3,0,3,7,2,1,2,1d,2,1,3,8,d,9,47,7,3,2d,3,7,2,1,1c,3e,9,0,9,49,4,0,13,48,108,8,2,2c,2,8,10,9" +
    ",19,1d,3,15,2,d,4a,6,2,1,2,2b,4,0,2,1,2,8,9,9,7,5,2,1,2,24,2,1,2,5,8,9,137,16,a,10,2,28,4,4,e,9,57,0,50,399," +
    "67,6e,12,c3,a4d,60,10,42f,11,15,fab,246,21ba,238,8,1e,2,9,7,4e,2,9,7,1d,3,4,c,36,a,3,d,9,a,14,6,12,2b1,3f,81" +
    ",4a,5,38,8,10,41,1,2,1,c,1,f,17f7,9,4d5,2b,8,22e8,3,2,6,2,1,2,122,10,0,1e,2,3,0,f,3,9,18b,905,6a,6,c,4,8,8,9" +
    ",4,1,1262,2d,3,16,21f,4,4,5,9,7,3,6,1f,3,95,2,1bc,54,2,46,2,1,3,0,3,1,3,3,2,b,2,0,2,6,2,40,2,3,3,7,2,6,2,1b," +
    "2,3,2,4,2,0,4,6,2,153,3,18,2,18,2,1e,2,18,2,1e,2,18,2,1e,2,18,2,1e,2,18,2,7,3,31,201,36,5,31,9,0,f,0,17,4,2," +
    "e,451,1e,7,5,d6,6,2,10,3,6,2,1,2,4,6,3d,22,0,71,2c,4,d,3,9,5,0,142,1e,12,39,1d7,29,2e7,6,2,3,2,1,2,e,2,c4,c," +
    "6,2a,4b,5,9,4a7,3,2,1a,2,1,2,0,3,0,2,9,2,3,2,0,2,0,7,0,5,0,2,0,2,0,2,2,2,1,2,0,3,0,2,0,2,0,2,0,2,0,2,1,2,0,3" +
    ",3,2,6,2,3,2,3,2,0,2,9,2,10,6,2,2,4,2,10,d35,9,407,a6df,21,1039,7,dd,3,1681,f,1d30,c20,21d,5e3,134a,6,105f,a" +
    "dd51,ef";
  /* str.isspace() code points (what str.strip() removes). */
  const PY_SPACE = new Set([9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196,
    8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288]);

  let _xs = null, _xc = null;
  function decode_ranges(enc) {
    const parts = enc.split(",");
    const out = new Uint32Array(parts.length);
    let prev = 0;
    for (let k = 0; k < parts.length; k += 2) {
      const a = prev + parseInt(parts[k], 16);
      const b = a + parseInt(parts[k + 1], 16);
      out[k] = a;
      out[k + 1] = b;
      prev = b;
    }
    return out;
  }
  function in_ranges(r, cp) {
    let lo = 0, hi = (r.length >> 1) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < r[2 * mid]) hi = mid - 1;
      else if (cp > r[2 * mid + 1]) lo = mid + 1;
      else return true;
    }
    return false;
  }
  /** Python's _PyUnicode_IsXidStart (Unicode 15.0). '_' is not XID_Start; identifiers allow it anyway. */
  guards._is_xid_start = function (cp) {
    if (!_xs) _xs = decode_ranges(XID_START_DATA);
    return in_ranges(_xs, cp);
  };
  /** Python's _PyUnicode_IsXidContinue (Unicode 15.0). */
  guards._is_xid_continue = function (cp) {
    if (!_xc) _xc = decode_ranges(XID_CONTINUE_DATA);
    return in_ranges(_xc, cp);
  };
  /** Ranges as [start, end, start, end, ...] (tests compare them with Python's). */
  guards._xid_ranges = function () {
    if (!_xs) _xs = decode_ranges(XID_START_DATA);
    if (!_xc) _xc = decode_ranges(XID_CONTINUE_DATA);
    return { start: Array.from(_xs), continue: Array.from(_xc) };
  };
  /** Python `not s.strip()` for a str. */
  function py_blank(s) {
    for (const ch of s) if (!PY_SPACE.has(ch.codePointAt(0))) return false;
    return true;
  }
  guards._py_space = function () { return [...PY_SPACE]; };
  guards._py_blank = py_blank;

  /* ------------------------------------------------------------------------------------------ */
  /* Printable characters (str.isprintable, Unicode 15.0) and Python's repr                       */
  /* ------------------------------------------------------------------------------------------ */

  /* Code points str.isprintable() rejects (categories Cc Cf Cs Co Cn Zl Zp, and Zs except U+0020), encoded
   * like the XID tables. Python's repr() escapes exactly these. */
  const NONPRINT_DATA =
    "0,1f,60,21,d,0,2cb,1,7,3,8,0,2,0,15,0,18e,0,27,1,33,1,4,0,38,7,1c,3,7,10,17,0,c1,0,31,1,3c,1,66,d,3c,1,32,1,10" +
    ",0,1d,1,2,0,c,4,20,8,4b,0,a2,0,9,1,3,1,17,0,8,0,2,2,5,1,a,1,3,1,5,7,2,3,3,0,6,1,1a,1,4,0,7,3,3,1,17,0,8,0,3,0," +
    "3,0,3,1,2,0,6,3,3,1,4,2,2,6,5,0,2,6,12,9,4,0,a,0,4,0,17,0,8,0,3,0,6,1,b,0,4,0,4,1,2,e,5,1,d,6,8,0,4,0,9,1,3,1," +
    "17,0,8,0,3,0,6,1,a,1,3,1,4,6,4,3,3,0,6,1,13,9,3,0,7,2,4,0,5,2,3,0,2,0,3,2,3,2,4,2,d,3,6,2,4,0,5,1,2,5,2,d,16,4" +
    ",e,0,4,0,18,0,11,1,a,0,4,0,5,6,3,0,4,1,2,1,5,1,b,6,17,0,4,0,18,0,b,0,6,1,a,0,4,0,5,6,3,5,3,0,5,1,b,0,4,b,e,0,4" +
    ",0,34,0,4,0,7,3,11,1,1b,0,4,0,13,2,19,0,a,0,2,1,8,2,2,3,7,0,2,0,9,5,b,1,4,b,3b,3,1e,24,3,0,2,0,6,0,19,0,2,0,18" +
    ",1,6,0,2,0,8,0,b,1,5,1f,49,0,25,3,28,0,25,0,10,0,e,24,c7,0,2,4,2,1,17a,0,5,1,8,0,2,0,5,1,2a,0,5,1,22,0,5,1,8,0" +
    ",2,0,5,1,10,0,3a,0,5,1,44,1,21,2,1b,5,57,1,7,1,281,0,1d,2,5a,6,17,8,19,8,15,b,e,0,4,0,3,b,5f,1,b,5,b,5,f,0,c,5" +
    ",5a,6,2c,4,47,9,20,0,d,3,d,3,2,2,2b,1,6,a,2d,3,1b,5,c,2,3f,1,42,0,1e,1,c,5,b,5,f,1,20,30,4e,2,30,0,75,7,3d,2,1" +
    "0,2,3d,6,2c,1,c,7,2c,4,217,1,7,1,27,1,7,1,9,0,2,0,2,0,2,0,20,1,36,0,10,0,f,1,7,0,14,1,4,0,a,10,19,7,30,10,3,1," +
    "1c,0,e,2,22,e,22,e,8d,3,298,18,c,14,715,1,21,0,15e,4,2e,0,2,4,2,1,39,6,3,d,19,8,8,0,8,0,8,0,8,0,8,0,8,0,8,0,8," +
    "0,7f,21,1b,0,5a,b,d7,19,d,4,40,0,57,1,68,4,2c,0,5f,0,55,b,30,0,726e,2,38,8,15d,13,b9,7,cc,4,3,0,2,0,6,17,3c,2," +
    "b,5,39,7,47,7,d,5,75,a,1f,2,4f,0,c,3,22,0,38,8,f,1,b,1,68,17,1d,9,7,1,7,1,7,8,8,0,8,0,3d,3,7f,1,b,5,2ba5,b,18," +
    "3,32,2103,16f,1,6b,25,8,b,6,4,1b,0,6,0,2,0,3,0,3,0,7e,f,1be,1,37,6,2,1f,2b,5,34,0,14,0,5,3,6,0,88,3,bf,2,7,1,7" +
    ",1,7,1,4,2,8,0,8,c,3,1,d,0,1b,0,14,0,3,0,10,1,f,21,7c,4,4,3,2e,2,59,0,e,2,2,2e,2f,81,1e,2,32,e,1d,3,25,8,1f,4," +
    "2c,4,1f,0,26,3,f,29,9f,1,b,5,25,3,25,3,29,7,35,a,d,0,10,0,8,0,3,0,c,0,10,0,8,0,3,42,138,8,17,9,9,17,7,0,2b,0,a" +
    ",44,7,1,2,0,2d,0,3,2,2,1,18,0,49,7,a,2f,14,0,3,4,22,2,1c,4,2,3f,39,3,15,1,33,0,3,4,9,0,4,0,1e,1,4,3,b,6,a,6,41" +
    ",1f,28,3,d,8,37,2,1e,1,1c,4,1b,6,5,b,8,4f,4a,36,34,c,34,6,2f,7,b,125,20,0,2b,0,4,1,3,4a,2c,7,2b,15,1b,25,1d,13" +
    ",18,8,4f,3,25,8,3f,0,6,c,1a,6,b,5,36,0,13,7,28,8,61,0,15,a,13,0,30,3d,8,0,2,0,5,0,10,0,c,5,3c,4,b,5,5,0,9,1,3," +
    "1,17,0,8,0,3,0,6,0,b,1,3,1,4,1,2,5,2,4,8,1,8,2,6,8a,5d,0,6,1d,49,7,b,a5,37,1,27,21,46,a,b,5,e,12,3b,5,b,35,1c," +
    "1,10,3,18,b8,3d,63,54,b,9,1,2,1,9,0,3,0,1f,0,3,1,d,8,b,45,9,1,2f,1,c,1a,49,7,54,c,4a,6,b,f5,a,0,2e,0,f,9,1e,2," +
    "21,1,17,0,f,48,8,0,3,0,2d,2,2,0,3,0,a,7,b,5,7,0,3,0,26,0,3,0,7,6,b,135,1a,6,12,0,2a,2,1d,55,2,e,33,c,39c,65,70" +
    ",0,6,a,c5,a4b,64,c,431,f,17,fa9,248,21b8,23a,6,20,0,b,3,52,0,b,5,1f,1,7,9,47,9,b,0,8,0,16,4,14,2af,5c,64,4c,3," +
    "3a,6,12,3f,6,a,3,d,17f9,7,4d7,29,a,22e6,5,0,8,0,3,0,124,e,2,1c,4,1,2,d,5,7,18d,903,6c,4,e,2,a,6,b,1,5,125f,2f," +
    "1,18,8,75,3b,f7,9,28,1,4b,7,71,14,47,79,15,b,15,b,58,8,1a,86,56,0,48,0,3,1,2,1,3,1,5,0,d,0,2,0,8,0,42,0,5,1,9," +
    "0,8,0,1d,0,5,0,6,0,2,2,8,0,155,1,125,1,2bf,e,6,0,10,44f,20,5,7,d4,8,0,12,1,8,0,3,0,6,4,3f,20,2,6f,2e,2,f,1,b,3" +
    ",3,13f,20,10,3b,4,2,1cf,2b,2e5,8,0,5,0,3,0,10,0,c6,1,11,28,4d,3,b,3,3,310,45,4b,3e,c1,5,0,1c,0,3,0,2,1,2,0,b,0" +
    ",5,0,2,0,2,5,2,3,2,0,2,0,2,0,4,0,3,0,2,1,2,0,2,0,2,0,2,0,2,0,3,0,2,1,5,0,8,0,5,0,5,0,2,0,b,0,12,4,4,0,6,0,12,3" +
    "3,3,10d,2d,3,65,b,10,1,10,0,10,0,26,9,af,37,1e,c,2d,3,a,6,3,d,7,99,3d9,3,12,2,e,2,78,3,60,5,d,3,2,e,d,3,39,7,b" +
    ",5,29,7,1f,1,3,4d,155,b,f,1,e,2,a,6,2f,0,8,7,f,3,a,6,a,6,94,0,38,24,b,405,a6e1,1f,103b,5,df,1,1683,d,1d32,c1e," +
    "21f,5e1,134c,4,1061,add4f,f1,2fe0f";
  let _np = null;
  /** Python's Py_UNICODE_ISPRINTABLE (Unicode 15.0). */
  function is_printable(cp) {
    if (!_np) _np = decode_ranges(NONPRINT_DATA);
    return !in_ranges(_np, cp);
  }
  guards._is_printable = is_printable;
  guards._nonprintable_ranges = function () {
    if (!_np) _np = decode_ranges(NONPRINT_DATA);
    return Array.from(_np);
  };
  const hexn = (c, w) => c.toString(16).padStart(w, "0");

  /** Python's repr() of a str (unicode_repr): smart quotes; backslash, the quote, \t \n \r; \xhh for other ASCII
   *  controls; \xhh, \uhhhh or \Uhhhhhhhh for every non-ASCII character str.isprintable() rejects. JS lone
   *  surrogates are code points of category Cs, as in Python. */
  function py_repr_str(s) {
    const q = s.indexOf("'") >= 0 && s.indexOf('"') < 0 ? 0x22 : 0x27;
    let out = String.fromCharCode(q);
    for (let k = 0; k < s.length; k++) {
      let c = s.charCodeAt(k);
      if (c >= 0xd800 && c <= 0xdbff && k + 1 < s.length) {
        const d = s.charCodeAt(k + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); k++; }
      }
      if (c === q || c === 0x5c) out += "\\" + String.fromCharCode(c);
      else if (c === 0x09) out += "\\t";
      else if (c === 0x0a) out += "\\n";
      else if (c === 0x0d) out += "\\r";
      else if (c < 0x20 || c === 0x7f) out += "\\x" + hexn(c, 2);
      else if (c < 0x7f) out += String.fromCharCode(c);
      else if (is_printable(c)) out += String.fromCodePoint(c);
      else if (c <= 0xff) out += "\\x" + hexn(c, 2);
      else if (c <= 0xffff) out += "\\u" + hexn(c, 4);
      else out += "\\U" + hexn(c, 8);
    }
    return out + String.fromCharCode(q);
  }
  guards._py_repr_str = py_repr_str;

  /** Python's repr() of bytes (a list of byte values). */
  function py_repr_bytes(bs) {
    const q = bs.indexOf(0x27) >= 0 && bs.indexOf(0x22) < 0 ? 0x22 : 0x27;
    let out = "b" + String.fromCharCode(q);
    for (const c of bs) {
      if (c === q || c === 0x5c) out += "\\" + String.fromCharCode(c);
      else if (c === 0x09) out += "\\t";
      else if (c === 0x0a) out += "\\n";
      else if (c === 0x0d) out += "\\r";
      else if (c < 0x20 || c >= 0x7f) out += "\\x" + hexn(c, 2);
      else out += String.fromCharCode(c);
    }
    return out + String.fromCharCode(q);
  }
  guards._py_repr_bytes = py_repr_bytes;

  /** Python's repr() of an imaginary literal's value, complex(0.0, imag): repr of imag without ".0", then "j". */
  function py_repr_imag(imag) {
    let s;
    if (Number.isNaN(imag)) s = "nan";
    else if (!Number.isFinite(imag)) s = imag > 0 ? "inf" : "-inf";
    else {
      s = HX.canonical.py_float_repr(imag);
      if (s.endsWith(".0")) s = s.slice(0, -2);
    }
    return s + "j";
  }
  guards._py_repr_imag = py_repr_imag;

  /* ------------------------------------------------------------------------------------------ */
  /* Tokenizer (port of CPython 3.12 Parser/tokenizer.c: normal mode and PEP 701 f-string mode)   */
  /* ------------------------------------------------------------------------------------------ */

  const EOF = -1;
  const MAXLEVEL = 200;
  const MAX_EXPR_NESTING = 3;
  const MAXFSTRINGLEVEL = 150;
  const TABSIZE = 8;
  const REGULAR = 0, FSTRING = 1;
  const KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);
  const TWO_CHAR = new Set(["!=", "%=", "&=", "**", "*=", "+=", "-=", "->", "//", "/=", ":=", "<<", "<=", "<>", "==",
    ">=", ">>", "@=", "^=", "|="]);
  const THREE_CHAR = new Set(["**=", "...", "//=", "<<=", ">>="]);
  const ONE_CHAR = "!%&()*+,-./:;<=>@[]^{|}~";
  const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

  function syntax_error(msg) { return new GuardError("guard syntax error: " + msg); }
  function hex4(c) { return c.toString(16).toUpperCase().padStart(4, "0"); }
  const isdigit = (c) => c >= 0x30 && c <= 0x39;
  const isxdigit = (c) => isdigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
  const is_id_start = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c >= 128;
  const is_id_char = (c) => is_id_start(c) || isdigit(c);
  const fromcps = (cps, a, b) => {
    let s = "";
    for (let k = a; k < b; k++) s += String.fromCodePoint(cps[k]);
    return s;
  };

  /** Tokenize newline-translated source (array of code points) into a token array ending with ENDMARKER.
   *  Throws GuardError for tokenizer errors. Token shapes:
   *    NAME {s, kw, id (NFKC), a, b}   NUMBER {kind: "int"|"float"|"complex", value, raw?}
   *    STRING {bytes, raw, body}   FSTRING_START {raw}   FSTRING_MIDDLE {body}   FSTRING_END
   *    OP {s, a, b, meta?}   NEWLINE   ENDMARKER
   *  a/b are code point offsets; meta is the debug text CPython attaches to `}`, `!` and `:` of f-string fields. */
  function tokenize(cps) {
    const n = cps.length;
    let pos = 0;
    let atbol = true;
    let level = 0;
    const parens = [];
    const toks = [];
    /* tok_mode_stack: index 0 is the regular top level (curly_bracket_expr_start_depth starts at 0 there) */
    const modes = [{ kind: REGULAR, depth: 0, expr_start: 0, debug: false }];
    const nextc = () => (pos < n ? cps[pos++] : EOF);
    const backup = (c) => { if (c !== EOF) pos--; };
    /* tok->lineno: the line of the last character read (a newline belongs to the line it ends) */
    const lineno = () => { let l = 1; for (let k = 0; k < pos - 1 && k < n; k++) if (cps[k] === 0x0a) l++; return l; };

    function continuation() {
      let c = nextc();
      if (c !== 0x0a) throw syntax_error("unexpected character after line continuation character");
      c = nextc();
      if (c === EOF) throw syntax_error("unexpected EOF while parsing");
      backup(c);
    }

    function lookahead(test) {
      const save = pos;
      let k = 0;
      for (;;) {
        const c = nextc();
        if (k === test.length) {
          const res = !is_id_char(c);
          pos = save;
          return res;
        }
        if (c === test.charCodeAt(k)) { k++; continue; }
        pos = save;
        return false;
      }
    }

    /* `1and x` is valid (a SyntaxWarning only); `1x` is an error. */
    function verify_end_of_number(c, kind) {
      let r = false;
      if (c === 0x61) r = lookahead("nd");
      else if (c === 0x65) r = lookahead("lse");
      else if (c === 0x66) r = lookahead("or");
      else if (c === 0x69) {
        const c2 = nextc();
        if (c2 === 0x66 || c2 === 0x6e || c2 === 0x73) r = true;
        backup(c2);
      } else if (c === 0x6f) r = lookahead("r");
      else if (c === 0x6e) r = lookahead("ot");
      if (r) return;
      if (c >= 0 && c < 128 && is_id_char(c)) throw syntax_error("invalid " + kind + " literal");
    }

    function decimal_tail() {
      let c;
      for (;;) {
        do { c = nextc(); } while (isdigit(c));
        if (c !== 0x5f) break;
        c = nextc();
        if (!isdigit(c)) { backup(c); throw syntax_error("invalid decimal literal"); }
      }
      return c;
    }

    function number_token(start) {
      const raw = fromcps(cps, start, pos);
      const clean = raw.replace(/_/g, "");
      const last = clean.charCodeAt(clean.length - 1);
      if (last === 0x6a || last === 0x4a) {
        return { t: "NUMBER", kind: "complex", value: Number(clean.slice(0, -1)), a: start, b: pos };
      }
      const p2 = clean.slice(0, 2).toLowerCase();
      if (p2 === "0x" || p2 === "0o" || p2 === "0b" || !/[.eE]/.test(clean)) {
        const big = BigInt(p2 === "0x" || p2 === "0o" || p2 === "0b" ? p2 + clean.slice(2) : clean);
        if (big > MAX_SAFE_BIG) return { t: "NUMBER", kind: "int", value: big, raw, a: start, b: pos };
        return { t: "NUMBER", kind: "int", value: Number(big), a: start, b: pos };
      }
      return { t: "NUMBER", kind: "float", value: Number(clean), a: start, b: pos };
    }

    function fraction(c, start) {
      if (isdigit(c)) c = decimal_tail();
      return exponent_or_end(c, start);
    }
    function exponent_or_end(c, start) {
      if (c === 0x65 || c === 0x45) {
        const e = c;
        c = nextc();
        if (c === 0x2b || c === 0x2d) {
          c = nextc();
          if (!isdigit(c)) { backup(c); throw syntax_error("invalid decimal literal"); }
        } else if (!isdigit(c)) {
          backup(c);
          verify_end_of_number(e, "decimal");
          backup(e);
          return number_token(start);
        }
        c = decimal_tail();
      }
      if (c === 0x6a || c === 0x4a) {
        c = nextc();
        verify_end_of_number(c, "imaginary");
      } else verify_end_of_number(c, "decimal");
      backup(c);
      return number_token(start);
    }

    function read_number(c, start) {
      if (c !== 0x30) {
        c = decimal_tail();
        if (c === 0x2e) return fraction(nextc(), start);
        return exponent_or_end(c, start);
      }
      c = nextc();
      if (c === 0x78 || c === 0x58) { /* hex */
        c = nextc();
        do {
          if (c === 0x5f) c = nextc();
          if (!isxdigit(c)) { backup(c); throw syntax_error("invalid hexadecimal literal"); }
          do { c = nextc(); } while (isxdigit(c));
        } while (c === 0x5f);
        verify_end_of_number(c, "hexadecimal");
        backup(c);
        return number_token(start);
      }
      if (c === 0x6f || c === 0x4f) { /* octal */
        c = nextc();
        do {
          if (c === 0x5f) c = nextc();
          if (c < 0x30 || c >= 0x38) {
            if (isdigit(c)) throw syntax_error("invalid digit '" + String.fromCharCode(c) + "' in octal literal");
            backup(c);
            throw syntax_error("invalid octal literal");
          }
          do { c = nextc(); } while (c >= 0x30 && c < 0x38);
        } while (c === 0x5f);
        if (isdigit(c)) throw syntax_error("invalid digit '" + String.fromCharCode(c) + "' in octal literal");
        verify_end_of_number(c, "octal");
        backup(c);
        return number_token(start);
      }
      if (c === 0x62 || c === 0x42) { /* binary */
        c = nextc();
        do {
          if (c === 0x5f) c = nextc();
          if (c !== 0x30 && c !== 0x31) {
            if (isdigit(c)) throw syntax_error("invalid digit '" + String.fromCharCode(c) + "' in binary literal");
            backup(c);
            throw syntax_error("invalid binary literal");
          }
          do { c = nextc(); } while (c === 0x30 || c === 0x31);
        } while (c === 0x5f);
        if (isdigit(c)) throw syntax_error("invalid digit '" + String.fromCharCode(c) + "' in binary literal");
        verify_end_of_number(c, "binary");
        backup(c);
        return number_token(start);
      }
      /* "0", zeros with underscores, or a float/imaginary with leading zeros */
      let nonzero = false;
      for (;;) {
        if (c === 0x5f) {
          c = nextc();
          if (!isdigit(c)) { backup(c); throw syntax_error("invalid decimal literal"); }
        }
        if (c !== 0x30) break;
        c = nextc();
      }
      if (isdigit(c)) { nonzero = true; c = decimal_tail(); }
      if (c === 0x2e) return fraction(nextc(), start);
      if (c === 0x65 || c === 0x45) return exponent_or_end(c, start);
      if (c === 0x6a || c === 0x4a) return exponent_or_end(c, start);
      if (nonzero) {
        backup(c);
        throw syntax_error("leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers");
      }
      verify_end_of_number(c, "decimal");
      backup(c);
      return number_token(start);
    }

    /* letter_quote: a str or bytes literal; the opening quote has been read */
    function read_string(start, quote, is_bytes, is_raw) {
      let quote_size = 1, end_quote_size = 0;
      let c = nextc();
      if (c === quote) {
        c = nextc();
        if (c === quote) quote_size = 3;
        else end_quote_size = 1; /* empty string */
      }
      if (c !== quote) backup(c);
      const body_start = pos;
      while (end_quote_size !== quote_size) {
        c = nextc();
        if (c === EOF || (quote_size === 1 && c === 0x0a)) {
          const m = modes[modes.length - 1];
          if (modes.length > 1 && m.quote === quote && m.quote_size === quote_size) {
            throw syntax_error("f-string: expecting '}'");
          }
          throw syntax_error((quote_size === 3 ? "unterminated triple-quoted string literal" : "unterminated string literal") +
            " (detected at line " + lineno() + ")");
        }
        if (c === quote) end_quote_size += 1;
        else {
          end_quote_size = 0;
          if (c === 0x5c) nextc(); /* skip the escaped character */
        }
      }
      return { t: "STRING", bytes: is_bytes, raw: is_raw, body: cps.slice(body_start, Math.max(body_start, pos - quote_size)),
        a: start, b: pos };
    }

    /* f_string_quote: push an f-string tokenizer mode; the opening quote has been read */
    function fstring_start(start, quote) {
      let quote_size = 1;
      const after = nextc();
      if (after === quote) {
        const after2 = nextc();
        if (after2 === quote) quote_size = 3;
        else { backup(after2); backup(after); }
      }
      if (after !== quote) backup(after);
      if (modes.length >= MAXFSTRINGLEVEL) throw syntax_error("too many nested f-strings");
      const first = cps[start];
      const raw = first === 0x66 || first === 0x46 ? (cps[start + 1] | 0x20) === 0x72 : true;
      modes.push({ kind: FSTRING, quote, quote_size, raw, depth: 0, expr_start: -1, last_expr_end: -1, buf_start: -1,
        debug: false });
      return { t: "FSTRING_START", raw, a: start, b: pos };
    }

    function verify_identifier(start) {
      for (let k = start; k < pos; k++) {
        const ch = cps[k];
        const ok = k === start ? ch === 0x5f || guards._is_xid_start(ch) : guards._is_xid_continue(ch);
        if (!ok) {
          throw syntax_error(is_printable(ch)
            ? "invalid character '" + String.fromCodePoint(ch) + "' (U+" + hex4(ch) + ")"
            : "invalid non-printable character U+" + hex4(ch));
        }
      }
    }

    /* set_fstring_expr: the text of the field's expression (debug metadata), with '#' comments removed */
    function debug_text(cur) {
      const end = cur.last_expr_end, out = [];
      for (let k = cur.buf_start; k < end; k++) {
        if (cps[k] === 0x23) {
          while (k < end && cps[k] !== 0x0a) k++;
          if (k < end) out.push(0x0a);
        } else out.push(cps[k]);
      }
      return out;
    }

    /* tok_get_normal_mode */
    function get_normal(cur) {
      for (;;) { /* label "nextline" */
        let blankline = false;
        if (atbol) {
          atbol = false;
          let col = 0, cont_line_col = 0, c;
          for (;;) {
            c = nextc();
            if (c === 0x20) col++;
            else if (c === 0x09) col = (Math.floor(col / TABSIZE) + 1) * TABSIZE;
            else if (c === 0x0c) col = 0;
            else if (c === 0x5c) {
              cont_line_col = cont_line_col ? cont_line_col : col;
              continuation();
            } else break;
          }
          backup(c);
          if (c === 0x23 || c === 0x0a) blankline = true; /* whitespace/comment-only line */
          /* eval input never accepts INDENT: any indented logical line at level 0 is an error */
          if (!blankline && level === 0 && (cont_line_col ? cont_line_col : col) !== 0) {
            throw syntax_error("unexpected indent");
          }
        }
        for (;;) { /* label "again" */
          let c;
          do { c = nextc(); } while (c === 0x20 || c === 0x09 || c === 0x0c);
          const start = c === EOF ? pos : pos - 1;
          if (c === 0x23) { while (c !== EOF && c !== 0x0a) c = nextc(); }
          if (c === EOF) {
            if (level) throw syntax_error("'" + String.fromCharCode(parens[parens.length - 1]) + "' was never closed");
            return { t: "ENDMARKER" };
          }
          if (is_id_start(c)) {
            let saw_b = false, saw_r = false, saw_u = false, saw_f = false;
            for (;;) {
              if (!(saw_b || saw_u || saw_f) && (c === 0x62 || c === 0x42)) saw_b = true;
              else if (!(saw_b || saw_u || saw_r || saw_f) && (c === 0x75 || c === 0x55)) saw_u = true;
              else if (!(saw_r || saw_u) && (c === 0x72 || c === 0x52)) saw_r = true;
              else if (!(saw_f || saw_b || saw_u) && (c === 0x66 || c === 0x46)) saw_f = true;
              else break;
              c = nextc();
              if (c === 0x22 || c === 0x27) return saw_f ? fstring_start(start, c) : read_string(start, c, saw_b, saw_r);
            }
            let nonascii = false;
            while (is_id_char(c)) {
              if (c >= 128) nonascii = true;
              c = nextc();
            }
            backup(c);
            if (nonascii) verify_identifier(start);
            const s = fromcps(cps, start, pos);
            return { t: "NAME", s, kw: !nonascii && KEYWORDS.has(s), id: nonascii ? s.normalize("NFKC") : s, a: start, b: pos };
          }
          if (c === 0x0a) {
            atbol = true;
            if (blankline || level > 0) break; /* goto nextline */
            return { t: "NEWLINE" };
          }
          if (c === 0x2e) {
            const c2 = nextc();
            if (isdigit(c2)) return fraction(c2, start);
            if (c2 === 0x2e) {
              const c3 = nextc();
              if (c3 === 0x2e) return { t: "OP", s: "...", a: start, b: pos };
              backup(c3);
            }
            backup(c2);
            return { t: "OP", s: ".", a: start, b: pos };
          }
          if (isdigit(c)) return read_number(c, start);
          if (c === 0x22 || c === 0x27) return read_string(start, c, false, false);
          if (c === 0x5c) { continuation(); continue; } /* goto again */

          /* f-string expression bookkeeping for ':', '}', '!' and '{' */
          let meta;
          if ((c === 0x3a || c === 0x7d || c === 0x21 || c === 0x7b) && modes.length > 1 && cur.expr_start >= 0) {
            const cursor = cur.depth - (c !== 0x7b ? 1 : 0);
            if (cursor === 0) { /* update_fstring_expr */
              if (c === 0x7b) { cur.buf_start = pos; cur.last_expr_end = -1; }
              else if (cur.last_expr_end === -1) cur.last_expr_end = start;
            }
            if (cursor === 0 && c !== 0x7b && cur.debug) meta = debug_text(cur);
            if (c === 0x3a && cursor === cur.expr_start) {
              cur.kind = FSTRING; /* the format spec follows */
              return { t: "OP", s: ":", a: start, b: pos, meta };
            }
          }
          const c2 = nextc();
          if (c2 !== EOF && c2 < 128 && TWO_CHAR.has(String.fromCharCode(c, c2))) {
            const two = String.fromCharCode(c, c2);
            const c3 = nextc();
            if (c3 !== EOF && c3 < 128 && THREE_CHAR.has(two + String.fromCharCode(c3))) {
              return { t: "OP", s: two + String.fromCharCode(c3), a: start, b: pos, meta };
            }
            backup(c3);
            return { t: "OP", s: two, a: start, b: pos, meta };
          }
          backup(c2);
          if (c === 0x28 || c === 0x5b || c === 0x7b) {
            if (level >= MAXLEVEL) throw syntax_error("too many nested parentheses");
            parens.push(c);
            level++;
            if (modes.length > 1) cur.depth++;
          } else if (c === 0x29 || c === 0x5d || c === 0x7d) {
            if (modes.length > 1 && !cur.depth && c === 0x7d) throw syntax_error("f-string: single '}' is not allowed");
            if (!level) throw syntax_error("unmatched '" + String.fromCharCode(c) + "'");
            level--;
            const opening = parens.pop();
            if (!((opening === 0x28 && c === 0x29) || (opening === 0x5b && c === 0x5d) || (opening === 0x7b && c === 0x7d))) {
              throw syntax_error("closing parenthesis '" + String.fromCharCode(c) + "' does not match opening parenthesis '" +
                String.fromCharCode(opening) + "'");
            }
            if (modes.length > 1) {
              cur.depth--;
              if (c === 0x7d && cur.depth === cur.expr_start) {
                cur.expr_start--;
                cur.kind = FSTRING;
                cur.debug = false;
              }
            }
          }
          if (c < 0x20 || c === 0x7f) throw syntax_error("invalid non-printable character U+" + hex4(c));
          if (c === 0x3d && cur.expr_start >= 0) cur.debug = true;
          if (ONE_CHAR.indexOf(String.fromCharCode(c)) < 0) throw syntax_error("invalid syntax");
          return { t: "OP", s: String.fromCharCode(c), a: start, b: pos, meta };
        }
      }
    }

    /* tok_get_fstring_mode */
    function get_fstring(cur) {
      const start = pos;
      const c0 = nextc();
      if (c0 === 0x7b) {
        const peek1 = nextc();
        backup(peek1);
        backup(c0);
        if (peek1 !== 0x7b) {
          cur.expr_start++;
          if (cur.expr_start >= MAX_EXPR_NESTING) throw syntax_error("f-string: expressions nested too deeply");
          cur.kind = REGULAR;
          return get_normal(cur);
        }
      } else backup(c0);
      let k = 0;
      for (; k < cur.quote_size; k++) {
        const q = nextc();
        if (q !== cur.quote) { backup(q); break; }
      }
      if (k === cur.quote_size) {
        modes.pop();
        return { t: "FSTRING_END", a: start, b: pos };
      }
      let end_quote_size = 0, unicode_escape = false;
      while (end_quote_size !== cur.quote_size) {
        const c = nextc();
        const in_format_spec = cur.last_expr_end !== -1 && cur.expr_start >= 0;
        if (c === EOF || (cur.quote_size === 1 && c === 0x0a)) {
          if (in_format_spec && c === 0x0a) {
            backup(c);
            cur.kind = REGULAR;
            return { t: "FSTRING_MIDDLE", body: cps.slice(start, pos), a: start, b: pos };
          }
          throw syntax_error((cur.quote_size === 3 ? "unterminated triple-quoted f-string literal" : "unterminated f-string literal") +
            " (detected at line " + lineno() + ")");
        }
        if (c === cur.quote) { end_quote_size += 1; continue; }
        end_quote_size = 0;
        if (c === 0x7b) {
          const peek = nextc();
          if (peek !== 0x7b || in_format_spec) {
            backup(peek);
            backup(c);
            cur.expr_start++;
            if (cur.expr_start >= MAX_EXPR_NESTING) throw syntax_error("f-string: expressions nested too deeply");
            cur.kind = REGULAR;
            return { t: "FSTRING_MIDDLE", body: cps.slice(start, pos), a: start, b: pos };
          }
          return { t: "FSTRING_MIDDLE", body: cps.slice(start, pos - 1), a: start, b: pos };
        }
        if (c === 0x7d) {
          if (unicode_escape) return { t: "FSTRING_MIDDLE", body: cps.slice(start, pos), a: start, b: pos };
          const peek = nextc();
          if (peek === 0x7d && !in_format_spec) return { t: "FSTRING_MIDDLE", body: cps.slice(start, pos - 1), a: start, b: pos };
          backup(peek);
          backup(c);
          cur.kind = REGULAR;
          return { t: "FSTRING_MIDDLE", body: cps.slice(start, pos), a: start, b: pos };
        }
        if (c === 0x5c) {
          let peek = nextc();
          if (peek === 0x7b || peek === 0x7d) { backup(peek); continue; } /* (a SyntaxWarning in Python) */
          if (!cur.raw && peek === 0x4e) {
            peek = nextc();
            if (peek === 0x7b) unicode_escape = true;
            else backup(peek);
          }
        }
      }
      for (k = 0; k < cur.quote_size; k++) pos--; /* the closing quotes become FSTRING_END */
      return { t: "FSTRING_MIDDLE", body: cps.slice(start, pos), a: start, b: pos };
    }

    for (;;) { /* one iteration per CPython tok_get call */
      const m = modes[modes.length - 1];
      const tk = m.kind === REGULAR ? get_normal(m) : get_fstring(m);
      toks.push(tk);
      if (tk.t === "ENDMARKER") return toks;
    }
  }
  guards._tokenize = function (src) {
    return tokenize(Array.from(src.replace(/\r\n?/g, "\n"), (ch) => ch.codePointAt(0)));
  };

  /* ------------------------------------------------------------------------------------------ */
  /* String literal decoding (Parser/string_parser.c)                                             */
  /* ------------------------------------------------------------------------------------------ */

  /* Port-only marks on decoded str values: the exact value is unknown to the port (deviations/guards.md). */
  const N_ESCAPE = 1; /* \N{name}: the port has no Unicode name database; one placeholder code point */
  const SURROGATE = 2; /* an escape that produces a surrogate code point; one placeholder code point */
  const PLACEHOLDER = "\uFFFD";
  const isalnum = (c) => isdigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

  /** decode_unicode_with_escapes for a str body (code points) -> {s, flags}. Like CPython, it first rewrites the
   *  body into an ASCII buffer (every non-ASCII character becomes \Uxxxxxxxx, and a backslash before a non-ASCII
   *  character or at the end gets "u005c" appended), then runs _PyUnicode_DecodeUnicodeEscapeInternal on it, so
   *  values and error positions are CPython's. */
  function decode_str(body) {
    const buf = [];
    const len = body.length;
    for (let k = 0; k < len;) {
      if (body[k] === 0x5c) {
        buf.push(0x5c);
        k++;
        if (k >= len || body[k] >= 0x80) {
          buf.push(0x75, 0x30, 0x30, 0x35, 0x63);
          if (k >= len) break;
        }
      }
      const c = body[k++];
      if (c < 0x80) { buf.push(c); continue; }
      buf.push(0x5c, 0x55);
      const h = c.toString(16).padStart(8, "0");
      for (let q = 0; q < 8; q++) buf.push(h.charCodeAt(q));
    }
    let out = "", flags = 0;
    const n = buf.length;
    const err = (start, end, message) => syntax_error("(unicode error) 'unicodeescape' codec can't decode " +
      (end === start + 1 ? "byte 0x" + hexn(buf[start], 2) + " in position " + start : "bytes in position " + start + "-" +
      (end - 1)) + ": " + message);
    for (let s = 0; s < n;) {
      let c = buf[s++];
      if (c !== 0x5c) { out += String.fromCharCode(c); continue; }
      const startinpos = s - 1;
      if (s >= n) throw err(startinpos, s, "\\ at end of string");
      c = buf[s++];
      switch (c) {
        case 0x0a: continue;
        case 0x5c: out += "\\"; continue;
        case 0x27: out += "'"; continue;
        case 0x22: out += '"'; continue;
        case 0x62: out += "\b"; continue;
        case 0x66: out += "\f"; continue;
        case 0x74: out += "\t"; continue;
        case 0x6e: out += "\n"; continue;
        case 0x72: out += "\r"; continue;
        case 0x76: out += "\v"; continue;
        case 0x61: out += "\x07"; continue;
        case 0x78: case 0x75: case 0x55: {
          let count = c === 0x78 ? 2 : c === 0x75 ? 4 : 8;
          const message = "truncated " + (c === 0x78 ? "\\xXX" : c === 0x75 ? "\\uXXXX" : "\\UXXXXXXXX") + " escape";
          let ch = 0;
          for (; count; ++s, --count) {
            if (s >= n || !isxdigit(buf[s])) throw err(startinpos, s, message);
            ch = ch * 16 + parseInt(String.fromCharCode(buf[s]), 16);
          }
          if (ch > 0x10ffff) throw err(startinpos, s, "illegal Unicode character");
          if (ch >= 0xd800 && ch <= 0xdfff) { out += PLACEHOLDER; flags |= SURROGATE; continue; }
          out += String.fromCodePoint(ch);
          continue;
        }
        case 0x4e: { /* \N{name}: the port has no name database (deviations/guards.md) */
          const message = "malformed \\N character escape";
          if (s >= n || buf[s] !== 0x7b) throw err(startinpos, s, message);
          const name_start = ++s;
          while (s < n && buf[s] !== 0x7d) s++;
          if (s >= n || s === name_start) throw err(startinpos, s, message);
          const name_end = s++;
          for (let q = name_start; q < name_end; q++) { /* Unicode names use only A-Z, 0-9, space and hyphen (any case) */
            const ch = buf[q];
            if (!(isalnum(ch) || ch === 0x20 || ch === 0x2d)) throw err(startinpos, s, "unknown Unicode character name");
          }
          out += PLACEHOLDER;
          flags |= N_ESCAPE;
          continue;
        }
        default:
          if (c >= 0x30 && c <= 0x37) {
            let ch = c - 0x30;
            if (s < n && buf[s] >= 0x30 && buf[s] <= 0x37) {
              ch = (ch << 3) + buf[s++] - 0x30;
              if (s < n && buf[s] >= 0x30 && buf[s] <= 0x37) ch = (ch << 3) + buf[s++] - 0x30;
            }
            out += String.fromCodePoint(ch);
            continue;
          }
          out += "\\" + String.fromCharCode(c); /* an unknown escape keeps the backslash (a SyntaxWarning) */
      }
    }
    return { s: out, flags };
  }
  guards._decode_str = function (s) { return decode_str(Array.from(s, (ch) => ch.codePointAt(0))); };

  /** _PyBytes_DecodeEscape for a bytes body (ASCII code points) -> list of byte values. */
  function decode_bytes(body) {
    const out = [];
    const len = body.length;
    for (let k = 0; k < len; k++) {
      const c = body[k];
      if (c !== 0x5c) { out.push(c); continue; }
      if (++k >= len) throw syntax_error("(value error) Trailing \\ in string");
      const e = body[k];
      switch (e) {
        case 0x0a: break;
        case 0x5c: out.push(0x5c); break;
        case 0x27: out.push(0x27); break;
        case 0x22: out.push(0x22); break;
        case 0x62: out.push(0x08); break;
        case 0x66: out.push(0x0c); break;
        case 0x74: out.push(0x09); break;
        case 0x6e: out.push(0x0a); break;
        case 0x72: out.push(0x0d); break;
        case 0x76: out.push(0x0b); break;
        case 0x61: out.push(0x07); break;
        case 0x78:
          if (k + 2 < len && isxdigit(body[k + 1]) && isxdigit(body[k + 2])) {
            out.push(parseInt(String.fromCharCode(body[k + 1], body[k + 2]), 16));
            k += 2;
            break;
          }
          throw syntax_error("(value error) invalid \\x escape at position " + (k - 1));
        default:
          if (e >= 0x30 && e <= 0x37) {
            let ch = e - 0x30;
            if (k + 1 < len && body[k + 1] >= 0x30 && body[k + 1] <= 0x37) {
              ch = (ch << 3) + body[++k] - 0x30;
              if (k + 1 < len && body[k + 1] >= 0x30 && body[k + 1] <= 0x37) ch = (ch << 3) + body[++k] - 0x30;
            }
            out.push(ch & 0xff);
          } else {
            out.push(0x5c); /* unknown escape: keep the backslash and reread the character */
            k--;
          }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Parser (CPython 3.12 PEG grammar, expression part, first pass)                               */
  /* ------------------------------------------------------------------------------------------ */
  /* Builds Python-shaped nodes for every construct ast.parse(expr, mode="eval") accepts (see PORTING.md for
   * the allowlisted ones). Additional node types mirror Python's ast fields: NamedExpr {target, value},
   * Lambda {args, body}, arguments {posonlyargs, args, vararg, kwonlyargs, kw_defaults, kwarg, defaults},
   * arg {arg}, Dict {keys, values}, Set {elts}, ListComp/SetComp/GeneratorExp {elt, generators},
   * DictComp {key, value, generators}, comprehension {target, iter, ifs, is_async}, Await/Yield/YieldFrom
   * {value}, Attribute {value, attr}, Subscript {value, slice}, Slice {lower, upper, step}, Starred {value},
   * keyword {arg, value}, JoinedStr {values}, FormattedValue {value, conversion, format_spec}. Name, List,
   * Tuple, Starred, Attribute and Subscript in a Store context carry ctx: "Store" (Load is implicit).
   * Constant.py_type is "str", "int", "float", "bool", "NoneType", "ellipsis", "bytes" (value: byte list) or
   * "complex" (value: the imaginary part). An int literal above 2^53-1 has a BigInt value.
   *
   * The parser is a deterministic recursive descent that commits where the PEG's ordered choice commits, so
   * it accepts exactly the first-pass language. Recursion per bracket level is kept small (expression ->
   * disjunction -> binary -> factor -> bracket form) so that the 200 nesting levels CPython's tokenizer
   * allows fit in small JS stacks. */

  const COMPARE_OPS = new Map([["==", "Eq"], ["!=", "NotEq"], ["<", "Lt"], ["<=", "LtE"], [">", "Gt"], [">=", "GtE"]]);
  const BINOPS = new Map([["|", ["BitOr", 1]], ["^", ["BitXor", 2]], ["&", ["BitAnd", 3]], ["<<", ["LShift", 4]],
    [">>", ["RShift", 4]], ["+", ["Add", 5]], ["-", ["Sub", 5]], ["*", ["Mult", 6]], ["/", ["Div", 6]],
    ["//", ["FloorDiv", 6]], ["%", ["Mod", 6]], ["@", ["MatMult", 6]]]);
  const UNARY_OPS = new Map([["-", "USub"], ["+", "UAdd"], ["~", "Invert"]]);
  const EXPR_START_KW = new Set(["True", "False", "None", "not", "lambda", "await"]);
  const EXPR_START_OP = new Set(["(", "[", "{", "-", "+", "~", "..."]);

  function constant(value, py_type) { return { type: "Constant", value, py_type }; }

  /* Deviation marks on Constant nodes (not part of the tree shape): message thrown by parse() if the guard would
   * otherwise be accepted. */
  const DEV = new WeakMap();

  function parse_tokens(toks) {
    let i = 0;
    const last = toks.length - 1;
    const peek = () => toks[i];
    const peek1 = () => toks[i < last ? i + 1 : last];
    const is_op = (tk, s) => tk.t === "OP" && tk.s === s;
    const is_kw = (tk, s) => tk.t === "NAME" && tk.kw && tk.s === s;
    const fail = (msg) => { throw syntax_error(msg || "invalid syntax"); };
    const expect = (s) => { if (!is_op(toks[i], s)) fail(); i++; };
    function starts_expression(tk) {
      switch (tk.t) {
        case "NAME": return !tk.kw || EXPR_START_KW.has(tk.s);
        case "NUMBER": case "STRING": case "FSTRING_START": return true;
        case "OP": return EXPR_START_OP.has(tk.s);
        default: return false;
      }
    }
    const starts_star_expression = (tk) => starts_expression(tk) || is_op(tk, "*");
    const comprehension_follows = () => is_kw(toks[i], "for") || (is_kw(toks[i], "async") && is_kw(peek1(), "for"));

    /* expressions: expression (',' expression)* [','] */
    function expressions() {
      const first = expression();
      if (!is_op(peek(), ",")) return first;
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (!starts_expression(peek())) break;
        elts.push(expression());
      }
      return { type: "Tuple", elts };
    }

    /* expression: disjunction 'if' disjunction 'else' expression | disjunction | lambdef (else-chains iterate) */
    function expression() {
      let pairs = null, e;
      for (;;) {
        if (is_kw(peek(), "lambda")) { e = lambdef(); break; }
        const body = disjunction();
        if (!is_kw(peek(), "if")) { e = body; break; }
        i++;
        const test = disjunction();
        if (!is_kw(peek(), "else")) fail("expected 'else' after 'if' expression");
        i++;
        (pairs || (pairs = [])).push(body, test);
      }
      if (pairs) {
        for (let k = pairs.length - 2; k >= 0; k -= 2) e = { type: "IfExp", test: pairs[k + 1], body: pairs[k], orelse: e };
      }
      return e;
    }

    /* disjunction / conjunction / inversion / comparison in one frame */
    function disjunction() {
      let ors = null, ands = null;
      for (;;) {
        let nots = 0;
        while (is_kw(peek(), "not")) { i++; nots++; }
        const left = binary();
        let e = left, ops = null, comps = null;
        for (;;) {
          const tk = peek();
          let op = null;
          if (tk.t === "OP") {
            op = COMPARE_OPS.get(tk.s) || null;
            if (op) i++;
          } else if (tk.t === "NAME" && tk.kw) {
            if (tk.s === "in") { op = "In"; i++; }
            else if (tk.s === "not" && is_kw(peek1(), "in")) { op = "NotIn"; i += 2; }
            else if (tk.s === "is") {
              if (is_kw(peek1(), "not")) { op = "IsNot"; i += 2; } else { op = "Is"; i++; }
            }
          }
          if (!op) break;
          if (!ops) { ops = []; comps = []; }
          ops.push(op);
          comps.push(binary());
        }
        if (ops) e = { type: "Compare", left, ops, comparators: comps };
        while (nots-- > 0) e = { type: "UnaryOp", op: "Not", operand: e };
        if (is_kw(peek(), "and")) { i++; (ands || (ands = [])).push(e); continue; }
        if (ands) { ands.push(e); e = { type: "BoolOp", op: "And", values: ands }; ands = null; }
        if (is_kw(peek(), "or")) { i++; (ors || (ors = [])).push(e); continue; }
        if (ors) { ors.push(e); e = { type: "BoolOp", op: "Or", values: ors }; }
        return e;
      }
    }

    /* bitwise_or .. term: left-associative binary operators by precedence climbing */
    function binary() {
      const first = factor();
      let tk = peek();
      if (tk.t !== "OP" || !BINOPS.has(tk.s)) return first;
      const vals = [first], ops = [];
      const reduce = () => {
        const r = vals.pop(), l = vals.pop();
        vals.push({ type: "BinOp", left: l, op: ops.pop()[0], right: r });
      };
      for (;;) {
        tk = peek();
        const info = tk.t === "OP" ? BINOPS.get(tk.s) : undefined;
        if (!info) break;
        i++;
        while (ops.length && ops[ops.length - 1][1] >= info[1]) reduce();
        ops.push(info);
        vals.push(factor());
      }
      while (ops.length) reduce();
      return vals[0];
    }

    /* factor / power / await_primary / primary / atom: unary prefixes, a right-associative '**' chain */
    function factor() {
      let segs = null, pre = null, base;
      for (;;) {
        pre = null;
        for (;;) {
          const tk = peek();
          const u = tk.t === "OP" ? UNARY_OPS.get(tk.s) : undefined;
          if (!u) break;
          (pre || (pre = [])).push(u);
          i++;
        }
        if (is_kw(peek(), "await")) { i++; base = { type: "Await", value: primary() }; }
        else base = primary();
        if (!is_op(peek(), "**")) break;
        i++;
        (segs || (segs = [])).push(pre, base);
      }
      let e = base;
      if (pre) for (let p = pre.length - 1; p >= 0; p--) e = { type: "UnaryOp", op: pre[p], operand: e };
      if (segs) {
        for (let k = segs.length - 2; k >= 0; k -= 2) {
          e = { type: "BinOp", left: segs[k + 1], op: "Pow", right: e };
          const pk = segs[k];
          if (pk) for (let p = pk.length - 1; p >= 0; p--) e = { type: "UnaryOp", op: pk[p], operand: e };
        }
      }
      return e;
    }

    /* primary: atom followed by '.' NAME, call, subscript trailers (atom inlined: one frame less per bracket level) */
    function primary() {
      let e;
      const t0 = peek();
      switch (t0.t) {
        case "NAME":
          if (!t0.kw) { i++; e = { type: "Name", id: t0.id }; break; }
          if (t0.s === "True" || t0.s === "False") { i++; e = constant(t0.s === "True", "bool"); break; }
          if (t0.s === "None") { i++; e = constant(null, "NoneType"); break; }
          return fail();
        case "NUMBER":
          i++;
          if (t0.kind === "complex") e = constant(t0.value, "complex");
          else if (t0.kind === "float") e = constant(t0.value, "float");
          else {
            e = constant(t0.value, "int");
            if (t0.raw !== undefined) {
              DEV.set(e, "integer literal " + t0.raw + " is outside the range supported by the JavaScript port (at most 2^53-1)");
            }
          }
          break;
        case "STRING": case "FSTRING_START":
          e = strings();
          break;
        case "OP":
          if (t0.s === "(") { e = paren(); break; }
          if (t0.s === "[") { e = list_display(); break; }
          if (t0.s === "{") { e = brace_display(); break; }
          if (t0.s === "...") { i++; e = constant(null, "ellipsis"); break; }
          return fail();
        default:
          return fail();
      }
      for (;;) {
        const tk = peek();
        if (tk.t !== "OP") return e;
        if (tk.s === ".") {
          i++;
          const nm = peek();
          if (nm.t !== "NAME" || nm.kw) fail();
          i++;
          e = { type: "Attribute", value: e, attr: nm.id };
        } else if (tk.s === "(") e = call(e);
        else if (tk.s === "[") {
          i++;
          const s = slices();
          expect("]");
          e = { type: "Subscript", value: e, slice: s };
        } else return e;
      }
    }

    /* named_expression: NAME ':=' expression | expression !':=' (bracket forms inline the second alternative) */
    const walrus_follows = () => toks[i].t === "NAME" && !toks[i].kw && is_op(peek1(), ":=");
    function walrus() {
      const tk = peek();
      i += 2;
      return { type: "NamedExpr", target: { type: "Name", id: tk.id, ctx: "Store" }, value: expression() };
    }
    function named_expression() {
      if (walrus_follows()) return walrus();
      const e = expression();
      if (is_op(peek(), ":=")) fail();
      return e;
    }
    /* star_named_expression: '*' bitwise_or | named_expression */
    function star_named_expression() {
      if (is_op(peek(), "*")) { i++; return { type: "Starred", value: binary() }; }
      return named_expression();
    }
    /* star_expressions (yield values, f-string fields) */
    function star_expression() {
      if (is_op(peek(), "*")) { i++; return { type: "Starred", value: binary() }; }
      return expression();
    }
    function star_expressions() {
      const first = star_expression();
      if (!is_op(peek(), ",")) return first;
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (!starts_star_expression(peek())) break;
        elts.push(star_expression());
      }
      return { type: "Tuple", elts };
    }
    /* yield_expr: 'yield' 'from' expression | 'yield' [star_expressions] */
    function yield_expr() {
      i++;
      if (is_kw(peek(), "from")) { i++; return { type: "YieldFrom", value: expression() }; }
      return { type: "Yield", value: starts_star_expression(peek()) ? star_expressions() : null };
    }

    /* tuple | group | genexp */
    function paren() {
      i++;
      const tk = peek();
      if (is_op(tk, ")")) { i++; return { type: "Tuple", elts: [] }; }
      if (is_kw(tk, "yield")) { const y = yield_expr(); expect(")"); return y; }
      let first;
      if (is_op(tk, "*")) {
        i++;
        first = { type: "Starred", value: binary() };
        if (!is_op(peek(), ",")) fail();
      } else {
        if (walrus_follows()) first = walrus();
        else {
          first = expression();
          if (is_op(peek(), ":=")) fail();
        }
        if (comprehension_follows()) {
          const gens = for_if_clauses();
          expect(")");
          return { type: "GeneratorExp", elt: first, generators: gens };
        }
        if (is_op(peek(), ")")) { i++; return first; }
        if (!is_op(peek(), ",")) fail();
      }
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (is_op(peek(), ")")) break;
        elts.push(star_named_expression());
      }
      expect(")");
      return { type: "Tuple", elts };
    }

    /* list | listcomp */
    function list_display() {
      i++;
      if (is_op(peek(), "]")) { i++; return { type: "List", elts: [] }; }
      const starred = is_op(peek(), "*");
      let first;
      if (starred || walrus_follows()) first = star_named_expression();
      else {
        first = expression();
        if (is_op(peek(), ":=")) fail();
      }
      if (!starred && comprehension_follows()) {
        const gens = for_if_clauses();
        expect("]");
        return { type: "ListComp", elt: first, generators: gens };
      }
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (is_op(peek(), "]")) break;
        elts.push(star_named_expression());
      }
      expect("]");
      return { type: "List", elts };
    }

    /* dict | set | dictcomp | setcomp */
    function brace_display() {
      i++;
      const tk = peek();
      if (is_op(tk, "}")) { i++; return { type: "Dict", keys: [], values: [] }; }
      if (is_op(tk, "**")) { i++; return dict_rest([null], [binary()]); }
      if (is_op(tk, "*")) { i++; return set_rest({ type: "Starred", value: binary() }); }
      let first;
      if (walrus_follows()) first = walrus();
      else {
        first = expression();
        if (is_op(peek(), ":")) {
          i++;
          const v = expression();
          if (comprehension_follows()) {
            const gens = for_if_clauses();
            expect("}");
            return { type: "DictComp", key: first, value: v, generators: gens };
          }
          return dict_rest([first], [v]);
        }
        if (is_op(peek(), ":=")) fail();
      }
      if (comprehension_follows()) {
        const gens = for_if_clauses();
        expect("}");
        return { type: "SetComp", elt: first, generators: gens };
      }
      return set_rest(first);
    }
    function dict_rest(keys, values) {
      while (is_op(peek(), ",")) {
        i++;
        if (is_op(peek(), "}")) break;
        if (is_op(peek(), "**")) { i++; keys.push(null); values.push(binary()); continue; }
        keys.push(expression());
        expect(":");
        values.push(expression());
      }
      expect("}");
      return { type: "Dict", keys, values };
    }
    function set_rest(first) {
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (is_op(peek(), "}")) break;
        elts.push(star_named_expression());
      }
      expect("}");
      return { type: "Set", elts };
    }

    /* for_if_clauses: (['async'] 'for' star_targets 'in' disjunction ('if' disjunction)*)+ */
    function for_if_clauses() {
      const gens = [];
      for (;;) {
        let is_async = 0;
        if (is_kw(peek(), "async") && is_kw(peek1(), "for")) { i++; is_async = 1; }
        else if (!is_kw(peek(), "for")) break;
        i++;
        const target = star_targets();
        if (!is_kw(peek(), "in")) fail();
        i++;
        const iter = disjunction();
        const ifs = [];
        while (is_kw(peek(), "if")) { i++; ifs.push(disjunction()); }
        gens.push({ type: "comprehension", target, iter, ifs, is_async });
      }
      if (!gens.length) fail();
      return gens;
    }

    /* star_targets of a comprehension: the target is parsed as atom + trailers (t_primary) and then checked and
       converted like CPython's star_atom / target_with_star_atom / _PyPegen_set_expr_context. */
    function star_targets() {
      const first = star_target();
      if (!is_op(peek(), ",")) return first;
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (is_kw(peek(), "in")) break;
        elts.push(star_target());
      }
      return { type: "Tuple", elts, ctx: "Store" };
    }
    function star_target() {
      if (is_op(peek(), "*")) {
        i++;
        if (is_op(peek(), "*")) fail();
        return { type: "Starred", value: star_target(), ctx: "Store" };
      }
      return to_target(primary(), false);
    }
    /* e was parsed as an expression (Load); return the Store target or fail. `elem` is true inside a
       parenthesized or bracketed target sequence (where '*' targets are allowed). */
    function to_target(e, elem) {
      switch (e.type) {
        case "Name": return { type: "Name", id: e.id, ctx: "Store" };
        case "Attribute": return { type: "Attribute", value: e.value, attr: e.attr, ctx: "Store" };
        case "Subscript": return { type: "Subscript", value: e.value, slice: e.slice, ctx: "Store" };
        case "Tuple": case "List":
          return { type: e.type, elts: e.elts.map((x) => to_target(x, true)), ctx: "Store" };
        case "Starred":
          if (!elem || e.value.type === "Starred") return fail();
          return { type: "Starred", value: to_target(e.value, false), ctx: "Store" };
        default:
          return fail();
      }
    }

    /* primary '(' [arguments] ')' and primary genexp */
    function call(func) {
      i++;
      const args = [], keywords = [];
      if (is_op(peek(), ")")) { i++; return { type: "Call", func, args, keywords }; }
      let kw_phase = false, dstar = false, first = true;
      for (;;) {
        const tk = peek();
        if (is_op(tk, "*")) {
          i++;
          if (dstar || !starts_expression(peek())) fail(dstar ? "iterable argument unpacking follows keyword argument unpacking" :
            "Invalid star expression");
          args.push({ type: "Starred", value: expression() });
        } else if (is_op(tk, "**")) {
          i++;
          keywords.push({ type: "keyword", arg: null, value: expression() });
          kw_phase = dstar = true;
        } else if (tk.t === "NAME" && !tk.kw && is_op(peek1(), "=")) {
          i += 2;
          keywords.push({ type: "keyword", arg: tk.id, value: expression() });
          kw_phase = true;
        } else {
          if (kw_phase) fail("positional argument follows keyword argument");
          let e;
          if (walrus_follows()) e = walrus();
          else {
            e = expression();
            if (is_op(peek(), ":=")) fail();
          }
          if (first && comprehension_follows()) {
            const gens = for_if_clauses();
            expect(")");
            return { type: "Call", func, args: [{ type: "GeneratorExp", elt: e, generators: gens }], keywords: [] };
          }
          if (is_op(peek(), "=")) fail();
          args.push(e);
        }
        first = false;
        if (!is_op(peek(), ",")) break;
        i++;
        if (is_op(peek(), ")")) break;
      }
      expect(")");
      return { type: "Call", func, args, keywords };
    }

    /* slices: slice !',' | ','.(slice | starred_expression)+ [','] */
    function slices() {
      const first = slice_item();
      if (!is_op(peek(), ",") && first.type !== "Starred") return first;
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (is_op(peek(), "]")) break;
        elts.push(slice_item());
      }
      return { type: "Tuple", elts };
    }
    function slice_item() {
      const tk = peek();
      if (is_op(tk, "*")) {
        i++;
        if (!starts_expression(peek())) fail("Invalid star expression");
        return { type: "Starred", value: expression() };
      }
      if (tk.t === "NAME" && !tk.kw && is_op(peek1(), ":=")) return named_expression();
      let lower = null;
      if (!is_op(tk, ":")) {
        lower = expression();
        if (!is_op(peek(), ":")) {
          if (is_op(peek(), ":=")) fail();
          return lower;
        }
      }
      i++;
      const upper = starts_expression(peek()) ? expression() : null;
      let step = null;
      if (is_op(peek(), ":")) {
        i++;
        if (starts_expression(peek())) step = expression();
      }
      return { type: "Slice", lower, upper, step };
    }

    /* lambdef: 'lambda' [lambda_params] ':' expression */
    function lambdef() {
      i++;
      const args = lambda_params();
      expect(":");
      return { type: "Lambda", args, body: expression() };
    }
    /* lambda_parameters (all five PEG alternatives): positional parameters with a '/' marker and defaults
       that, once started, continue up to '*'; then '*' [name] with keyword-only parameters (a bare '*'
       needs at least one); then '**' name. Each parameter is followed by ',' or by the ':' of the lambda. */
    function lambda_params() {
      const pos = [], pos_defaults = [], kwonly = [], kw_defaults = [];
      let slash = -1, vararg = null, kwarg = null, phase = 0, bare_star = false, seen_default = false;
      const arg = (tk) => ({ type: "arg", arg: tk.id });
      const sep = () => {
        if (is_op(peek(), ",")) { i++; return; }
        if (!is_op(peek(), ":")) fail();
      };
      while (!is_op(peek(), ":")) {
        const tk = peek();
        if (tk.t === "NAME" && !tk.kw && phase < 2) {
          i++;
          let d = null;
          if (is_op(peek(), "=")) { i++; d = expression(); }
          if (phase === 0) {
            if (d === null && seen_default) fail("parameter without a default follows parameter with a default");
            if (d !== null) { seen_default = true; pos_defaults.push(d); }
            pos.push(arg(tk));
          } else {
            kwonly.push(arg(tk));
            kw_defaults.push(d);
          }
          sep();
        } else if (is_op(tk, "/") && phase === 0 && slash < 0 && pos.length) {
          i++;
          slash = pos.length;
          sep();
        } else if (is_op(tk, "*") && phase === 0) {
          i++;
          const nm = peek();
          if (nm.t === "NAME" && !nm.kw) { i++; vararg = arg(nm); sep(); }
          else if (is_op(nm, ",")) { i++; bare_star = true; }
          else fail();
          phase = 1;
        } else if (is_op(tk, "**") && phase < 2) {
          if (bare_star && !kwonly.length) fail("named arguments must follow bare *");
          i++;
          const nm = peek();
          if (nm.t !== "NAME" || nm.kw) fail();
          i++;
          kwarg = arg(nm);
          sep();
          phase = 2;
        } else fail();
      }
      if (bare_star && !kwonly.length) fail("named arguments must follow bare *");
      const posonly = slash < 0 ? [] : pos.slice(0, slash);
      return { type: "arguments", posonlyargs: posonly, args: slash < 0 ? pos : pos.slice(slash), vararg,
        kwonlyargs: kwonly, kw_defaults, kwarg, defaults: pos_defaults };
    }

    /* ---- strings and f-strings -------------------------------------------------------------- */

    function str_constant(s, flags) {
      const c = constant(s, "str");
      if (flags & N_ESCAPE) DEV.set(c, "\\N{...} escapes are not supported by the JavaScript port");
      else if (flags & SURROGATE) DEV.set(c, "string escapes producing surrogate code points are not supported by the JavaScript port");
      return c;
    }
    /* string: STRING (_PyPegen_parse_string) */
    function string_constant(tk) {
      const body = tk.body;
      if (tk.bytes) {
        for (const ch of body) if (ch >= 0x80) fail("bytes can only contain ASCII literal characters");
        return constant(tk.raw || body.indexOf(0x5c) < 0 ? body.slice() : decode_bytes(body), "bytes");
      }
      if (tk.raw || body.indexOf(0x5c) < 0) return str_constant(fromcps(body, 0, body.length), 0);
      const d = decode_str(body);
      return str_constant(d.s, d.flags);
    }
    /* _PyPegen_decode_fstring_part / _PyPegen_decoded_constant_from_token */
    function fstring_part(cps, is_raw) {
      const n = cps.length === 2 && ((cps[0] === 0x7b && cps[1] === 0x7b) || (cps[0] === 0x7d && cps[1] === 0x7d)) ? 1 : cps.length;
      const body = n === cps.length ? cps : cps.slice(0, n);
      if (is_raw || body.indexOf(0x5c) < 0) return str_constant(fromcps(body, 0, body.length), 0);
      const d = decode_str(body);
      return str_constant(d.s, d.flags);
    }
    /* fstring: FSTRING_START fstring_middle* FSTRING_END (_PyPegen_joined_str) */
    function fstring() {
      const start = peek();
      i++;
      const items = [];
      for (;;) {
        const tk = peek();
        if (tk.t === "FSTRING_END") { i++; break; }
        if (tk.t === "FSTRING_MIDDLE") { i++; items.push({ raw_text: tk.body }); continue; }
        if (is_op(tk, "{")) { items.push(replacement_field()); continue; }
        fail();
      }
      const values = [];
      for (const it of items) {
        const parts = it.type === "JoinedStr" ? it.values : [it]; /* unpack_top_level_joined_strs */
        for (const p of parts) {
          if (p.raw_text !== undefined) {
            const c = fstring_part(p.raw_text, start.raw);
            if (c.value.length) values.push(c);
          } else values.push(p);
        }
      }
      return { type: "JoinedStr", values };
    }
    /* fstring_replacement_field: '{' (yield_expr | star_expressions) ['='] ['!' NAME] [':' spec*] '}' */
    function replacement_field() {
      i++;
      const value = is_kw(peek(), "yield") ? yield_expr() : star_expressions();
      let debug = false;
      if (is_op(peek(), "=")) { debug = true; i++; }
      let bang = null, conv = null;
      if (is_op(peek(), "!")) {
        bang = peek();
        i++;
        conv = peek();
        if (conv.t !== "NAME" || conv.kw) fail();
        i++;
        if (bang.b !== conv.a) fail("f-string: conversion type must come right after the exclamanation mark");
      }
      let colon = null, spec = null;
      if (is_op(peek(), ":")) {
        colon = peek();
        i++;
        spec = [];
        for (;;) {
          const tk = peek();
          if (tk.t === "FSTRING_MIDDLE") { i++; spec.push(fstring_part(tk.body, false)); continue; }
          if (is_op(tk, "{")) { spec.push(replacement_field()); continue; }
          break;
        }
        /* _PyPegen_setup_full_format_spec: a lone empty part means an empty spec */
        if (spec.length === 1 && spec[0].type === "Constant" && spec[0].value === "") spec = [];
      }
      const rbrace = peek();
      if (!is_op(rbrace, "}")) fail("f-string: expecting '}'");
      i++;
      /* _PyPegen_formatted_value */
      let conversion = -1;
      if (conv) {
        const id = conv.id;
        if (HX.util.codepoint_length(id) > 1 || !(id === "s" || id === "r" || id === "a")) {
          fail("f-string: invalid conversion character " + py_repr_str(id) + ": expected 's', 'r', or 'a'");
        }
        conversion = id.charCodeAt(0);
      } else if (debug && !spec) conversion = 0x72;
      const fv = { type: "FormattedValue", value, conversion, format_spec: spec ? { type: "JoinedStr", values: spec } : null };
      if (!debug) return fv;
      const meta = bang ? bang.meta : colon ? colon.meta : rbrace.meta;
      if (meta === undefined) {
        /* CPython records the text only for fields at the top of an f-string. Inside a format specification the
           debug Constant gets no value, and the node constructor raises ValueError right here, ending the parse
           (deviations/guards.md) */
        throw new GuardError("guard has an f-string '=' field inside a format specification (Python's parser raises " +
          "ValueError: field 'value' is required for Constant)");
      }
      return { type: "JoinedStr", values: [{ raw_text: meta }, fv] };
    }
    /* strings: (fstring | string)+ (_PyPegen_concatenate_strings) */
    function strings() {
      const items = [];
      let f = false, u = false, b = false;
      for (;;) {
        const tk = peek();
        if (tk.t === "STRING") {
          i++;
          const c = string_constant(tk);
          if (c.py_type === "bytes") b = true; else u = true;
          items.push(c);
        } else if (tk.t === "FSTRING_START") {
          items.push(fstring());
          f = true;
        } else break;
      }
      if ((u || f) && b) fail("cannot mix bytes and nonbytes literals");
      if (b) {
        if (items.length === 1) return items[0];
        let all = [];
        for (const it of items) all = all.concat(it.value);
        return constant(all, "bytes");
      }
      if (!f && items.length === 1) return items[0];
      const flat = [];
      for (const it of items) {
        if (it.type === "Constant") flat.push(it);
        else for (const v of it.values) flat.push(v);
      }
      const values = [];
      for (let k = 0; k < flat.length; k++) {
        let e = flat[k];
        if (e.type === "Constant") {
          if (k + 1 < flat.length && flat[k + 1].type === "Constant") {
            let s = "", dev = null, j = k;
            for (; j < flat.length && flat[j].type === "Constant"; j++) {
              s += flat[j].value;
              if (dev === null && DEV.has(flat[j])) dev = DEV.get(flat[j]);
            }
            k = j - 1;
            e = constant(s, "str");
            if (dev !== null) DEV.set(e, dev);
          }
          if (f && e.value.length === 0) continue;
        }
        values.push(e);
      }
      if (!f) return values[0];
      return { type: "JoinedStr", values };
    }

    /* eval: expressions NEWLINE* ENDMARKER */
    const body = expressions();
    while (peek().t === "NEWLINE") i++;
    if (peek().t !== "ENDMARKER") fail();
    return { type: "Expression", body };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* AST metrics (ast.walk count and guards._depth, including ctx/op nodes)                       */
  /* ------------------------------------------------------------------------------------------ */

  const ctx_node = (node) => ({ type: node.ctx || "Load" });
  const push_all = (out, xs) => { for (const x of xs) if (x) out.push(x); return out; };

  /** Child nodes in ast.iter_child_nodes order; ctx and operator nodes appear as {type: <class name>}. */
  function children(node) {
    switch (node.type) {
      case "Expression": return [node.body];
      case "BoolOp": return [{ type: node.op }, ...node.values];
      case "NamedExpr": return [node.target, node.value];
      case "BinOp": return [node.left, { type: node.op }, node.right];
      case "UnaryOp": return [{ type: node.op }, node.operand];
      case "Lambda": return [node.args, node.body];
      case "IfExp": return [node.test, node.body, node.orelse];
      case "Dict": return push_all(push_all([], node.keys), node.values);
      case "Set": return node.elts.slice();
      case "ListComp": case "SetComp": case "GeneratorExp": return [node.elt, ...node.generators];
      case "DictComp": return [node.key, node.value, ...node.generators];
      case "Await": case "YieldFrom": return [node.value];
      case "Yield": return node.value ? [node.value] : [];
      case "Compare": return [node.left, ...node.ops.map((o) => ({ type: o })), ...node.comparators];
      case "Call": return [node.func, ...node.args, ...node.keywords];
      case "FormattedValue": return node.format_spec ? [node.value, node.format_spec] : [node.value];
      case "JoinedStr": return node.values.slice();
      case "Attribute": return [node.value, ctx_node(node)];
      case "Subscript": return [node.value, node.slice, ctx_node(node)];
      case "Starred": return [node.value, ctx_node(node)];
      case "Name": return [ctx_node(node)];
      case "List": case "Tuple": return [...node.elts, ctx_node(node)];
      case "Slice": return push_all([], [node.lower, node.upper, node.step]);
      case "comprehension": return [node.target, node.iter, ...node.ifs];
      case "arguments":
        return push_all(push_all([...node.posonlyargs, ...node.args], [node.vararg]).concat(node.kwonlyargs),
          [...node.kw_defaults, node.kwarg, ...node.defaults]);
      case "keyword": return [node.value];
      default: return [];
    }
  }
  guards._children = children;

  /** Python ast.walk order (breadth first), ctx/op nodes included. */
  function walk(tree) {
    const out = [tree];
    for (let k = 0; k < out.length; k++) for (const c of children(out[k])) out.push(c);
    return out;
  }
  guards._walk = walk;
  guards._node_count = function (tree) { return walk(tree).length; };
  /** guards._depth: 1 + max depth of the children (computed without recursion). */
  function _depth(tree) {
    let best = 0;
    const stack = [[tree, 1]];
    while (stack.length) {
      const [node, d] = stack.pop();
      if (d > best) best = d;
      for (const c of children(node)) stack.push([c, d + 1]);
    }
    return best;
  }
  guards._depth = _depth;

  function deep_freeze(o) {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) deep_freeze(o[k]);
    }
    return o;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* parse / _check / vars_of                                                                     */
  /* ------------------------------------------------------------------------------------------ */

  /** True for the engine's stack-overflow error (V8/JavaScriptCore RangeError "Maximum call stack size exceeded",
   *  SpiderMonkey InternalError "too much recursion"). Kept free of calls: it runs right after an overflow. */
  function is_stack_overflow(e) {
    if (e === null || typeof e !== "object" || e instanceof GuardError) return false;
    const msg = typeof e.message === "string" ? e.message : "";
    return e.name === "InternalError" || (e.name === "RangeError" && msg.indexOf("call stack") >= 0) ||
      msg.indexOf("too much recursion") >= 0;
  }
  guards._is_stack_overflow = is_stack_overflow;
  /* Built in advance so that reporting an overflow needs no further stack (deviations/guards.md). */
  const STACK_ERROR = new GuardError("guard is nested too deeply for this JavaScript engine's stack (JavaScript port limitation)");

  /** ast.parse(expr, mode="eval") without limits or allowlist: the Python-shaped tree, or GuardError for every
   *  input CPython rejects (syntax errors, and the encode/ValueError cases listed in deviations/guards.md). */
  guards._parse_raw = function (expr) {
    if (typeof expr !== "string") throw new GuardError("guard is not a string");
    let tree;
    try {
      if (HX.util.has_lone_surrogate(expr)) {
        throw new GuardError("guard text contains a lone surrogate (not encodable as UTF-8)");
      }
      if (expr.indexOf("\u0000") >= 0) throw syntax_error("source code string cannot contain null bytes");
      const cps = Array.from(expr.replace(/\r\n?/g, "\n"), (ch) => ch.codePointAt(0));
      tree = parse_tokens(tokenize(cps));
    } catch (e) {
      if (is_stack_overflow(e)) throw STACK_ERROR;
      throw e;
    }
    return tree;
  };

  function const_repr(node) {
    switch (node.py_type) {
      case "NoneType": return "None";
      case "ellipsis": return "Ellipsis";
      case "bytes": return py_repr_bytes(node.value);
      case "complex": return py_repr_imag(node.value);
      case "str": return py_repr_str(node.value);
      default: return HX.util.py_repr(node.value);
    }
  }
  guards._const_repr = const_repr;

  function _check(node) {
    switch (node.type) {
      case "BoolOp":
        for (const v of node.values) _check(v);
        return;
      case "UnaryOp":
        if (node.op !== "Not") throw new GuardError("the only unary operator allowed is 'not'");
        _check(node.operand);
        return;
      case "Compare":
        for (const op of node.ops) {
          if (!hasOwn.call(guards._CMP, op)) throw new GuardError("comparison operator not allowed: " + op);
        }
        _check(node.left);
        for (const c of node.comparators) _check(c);
        return;
      case "Call":
        if (!(node.func.type === "Name" && is_predicate(node.func.id))) {
          throw new GuardError("only empty(x) / nonempty(x) calls are allowed");
        }
        if (node.args.length !== 1 || node.keywords.length || node.args[0].type !== "Name") {
          throw new GuardError(node.func.id + " takes exactly one variable argument");
        }
        return;
      case "List":
      case "Tuple":
        if (node.elts.length > guards.MAX_LIST) throw new GuardError("literal list longer than " + guards.MAX_LIST);
        for (const e of node.elts) {
          if (e.type !== "Constant") throw new GuardError("list literals may only contain constants");
          _check(e);
        }
        return;
      case "Name":
        if (is_predicate(node.id) || node.id.startsWith("__")) throw new GuardError("name not allowed: " + node.id);
        return;
      case "Constant": {
        const t = node.py_type;
        if (t !== "str" && t !== "int" && t !== "float" && t !== "bool") {
          throw new GuardError("constant not allowed: " + const_repr(node));
        }
        if (t === "str" && HX.util.codepoint_length(node.value) > guards.MAX_STR) {
          throw new GuardError("string literal too long");
        }
        if (t === "float" && !Number.isFinite(node.value)) throw new GuardError("non-finite literal");
        return;
      }
      default:
        throw new GuardError("syntax node not allowed: " + node.type);
    }
  }
  guards._check = _check;

  const _cache = new Map();
  const CACHE_SIZE = 2048;

  /** parse(expr) -> frozen {type: "Expression", body} or GuardError (cached like Python's lru_cache). */
  guards.parse = function parse(expr) {
    if (typeof expr === "string" && _cache.has(expr)) {
      const hit = _cache.get(expr);
      _cache.delete(expr);
      _cache.set(expr, hit);
      return hit;
    }
    if (typeof expr !== "string" || py_blank(expr)) throw new GuardError("empty guard (default edges have cond == '')");
    if (HX.util.codepoint_length(expr) > guards.MAX_LEN) {
      throw new GuardError("guard longer than " + guards.MAX_LEN + " characters");
    }
    const tree = guards._parse_raw(expr);
    const nodes = walk(tree);
    if (nodes.length > guards.MAX_NODES) {
      throw new GuardError("guard has more than " + guards.MAX_NODES + " syntax nodes");
    }
    if (_depth(tree) > guards.MAX_DEPTH) throw new GuardError("guard AST deeper than " + guards.MAX_DEPTH);
    _check(tree.body);
    /* JS-only rejections of guards Python accepts (deviations/guards.md), decided after Python's own checks so
       that every guard Python rejects gets Python's message */
    for (const n of nodes) if (DEV.has(n)) throw new GuardError(DEV.get(n));
    deep_freeze(tree);
    _cache.set(expr, tree);
    if (_cache.size > CACHE_SIZE) _cache.delete(_cache.keys().next().value);
    return tree;
  };
  guards._prepared = guards.parse;

  /** Variables a guard reads, as a Set iterated in sorted (code point) order. Falsy input -> empty. */
  guards.vars_of = function vars_of(expr) {
    if (!py_truthy(expr)) return new Set();
    const tree = guards.parse(expr);
    const out = [];
    for (const n of walk(tree)) {
      if (n.type === "Name" && !is_predicate(n.id) && out.indexOf(n.id) < 0) out.push(n.id);
    }
    return new Set(out.sort(HX.util.cmp_codepoints));
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Static typing                                                                                */
  /* ------------------------------------------------------------------------------------------ */

  /** Python _const_type. Pass a Constant node to distinguish int from float (JS has one number type). */
  function _const_type(v) {
    if (v && typeof v === "object" && v.type === "Constant") {
      const t = v.py_type;
      return t === "bool" ? "boolean" : t === "int" ? "integer" : t === "float" ? "number" : "string";
    }
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return "string";
  }
  guards._const_type = _const_type;
  function _cat(t) { return t === "integer" || t === "number" ? "numeric" : t; }
  guards._cat = _cat;
  const starts = (t, p) => typeof t === "string" && t.startsWith(p);
  const ORDERING = new Set(["<", "<=", ">", ">="]);
  const KIND_ORDER = ["numeric", "string", "boolean"];

  /** Return a list of type errors (empty means a well-typed boolean guard). */
  guards.typecheck = function typecheck(expr, var_types) {
    const errors = [];
    let tree;
    try {
      tree = guards.parse(expr);
    } catch (e) {
      if (e instanceof GuardError) return [e.message];
      throw e;
    }
    function typ(node) {
      if (node.type === "Name") {
        if (!has_key(var_types, node.id)) {
          errors.push("undeclared variable " + repr(node.id));
          return "?";
        }
        return get_key(var_types, node.id);
      }
      if (node.type === "Constant") return _const_type(node);
      if (node.type === "List" || node.type === "Tuple") {
        const kinds = [];
        for (const e of node.elts) {
          const k = _cat(_const_type(e));
          if (kinds.indexOf(k) < 0) kinds.push(k);
        }
        if (kinds.length > 1) errors.push("mixed-type list literal");
        /* Python pops an arbitrary element of the set: the one in the lowest hash slot, a fixed order within a
         * process. The port uses one such fixed order (numeric, string, boolean); see deviations/guards.md. */
        if (!kinds.length) return "list:empty";
        for (const k of KIND_ORDER) if (kinds.indexOf(k) >= 0) return "list:" + k;
        return "list:" + kinds[0];
      }
      return bool_expr(node) ? "boolean" : "?";
    }
    function bool_expr(node) {
      switch (node.type) {
        case "BoolOp":
          for (const v of node.values) if (!bool_expr(v)) errors.push("operand of and/or must be boolean");
          return true;
        case "UnaryOp":
          if (!bool_expr(node.operand)) errors.push("operand of 'not' must be boolean");
          return true;
        case "Call": {
          const t = typ(node.args[0]);
          if (t !== "string" && t !== "array" && t !== "object" && t !== "?") {
            errors.push(node.func.id + "() needs a string/array/object variable, got " + t);
          }
          return true;
        }
        case "Compare": {
          let left = node.left;
          for (let k = 0; k < node.ops.length; k++) {
            const right = node.comparators[k];
            const o = guards._CMP[node.ops[k]];
            const lt = typ(left), rt = typ(right);
            if (lt === "?" || rt === "?") {
              /* already reported */
            } else if (o === "in" || o === "not in") {
              if (starts(rt, "list:")) {
                const inner = rt.slice(5);
                if (inner !== "empty" && inner !== _cat(lt)) errors.push("'" + o + "' mixes " + lt + " with a list of " + inner);
                if (lt === "array" || lt === "object" || lt === "boolean") {
                  errors.push("'" + o + "' left operand must be string or numeric, got " + lt);
                }
              } else if (rt === "array") {
                if (lt !== "string" && lt !== "integer" && lt !== "number") {
                  errors.push("'" + o + "' left operand must be scalar, got " + lt);
                }
              } else {
                errors.push("'" + o + "' needs a list literal or array variable on the right, got " + rt);
              }
            } else if (ORDERING.has(o)) {
              if (_cat(lt) !== "numeric" || _cat(rt) !== "numeric") {
                errors.push("ordering comparison needs numbers, got " + lt + " " + o + " " + rt);
              }
            } else if (starts(lt, "list:") || starts(rt, "list:")) {
              errors.push("equality against a list literal is not allowed");
            } else if (lt === "array" || lt === "object" || rt === "array" || rt === "object") {
              errors.push("equality on array/object is not allowed; use empty()/nonempty()");
            } else if (_cat(lt) !== _cat(rt)) {
              errors.push("type mismatch: " + lt + " " + o + " " + rt + " (no implicit coercion)");
            }
            left = right;
          }
          return true;
        }
        case "Name": {
          const t = typ(node);
          if (t !== "boolean" && t !== "?") {
            errors.push("variable " + repr(node.id) + " of type " + t + " used as a condition (no truthiness)");
          }
          return true;
        }
        case "Constant":
          if (node.py_type !== "bool") errors.push("non-boolean constant used as a condition");
          return true;
        default:
          return false;
      }
    }
    if (!bool_expr(tree.body)) errors.push("guard is not a boolean expression");
    return errors;
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Strict runtime evaluation                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  /** Python _rt_cat for JSON-like values ("?" for anything else, including UNKNOWN). */
  function _rt_cat(v) {
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return "numeric";
    if (typeof v === "string") return "string";
    if (Array.isArray(v)) return "array";
    if (v === null) return "null";
    if (HX.util.is_plain_object(v)) return "object";
    return "?";
  }
  guards._rt_cat = _rt_cat;

  function _cmp(o, a, b) {
    if (o === "in" || o === "not in") {
      if (!Array.isArray(b)) throw new GuardError("right operand of '" + o + "' is not a list");
      const ca = _rt_cat(a);
      if (ca !== "string" && ca !== "numeric") throw new GuardError("left operand of '" + o + "' has type " + ca);
      let hit = false;
      for (const x of b) {
        if (_rt_cat(x) === ca && x === a) { hit = true; break; }
      }
      return o === "in" ? hit : !hit;
    }
    const ca = _rt_cat(a), cb = _rt_cat(b);
    if (ORDERING.has(o)) {
      if (ca !== "numeric" || cb !== "numeric") throw new GuardError("ordering comparison on " + ca + " and " + cb);
      return o === "<" ? a < b : o === "<=" ? a <= b : o === ">" ? a > b : a >= b;
    }
    if (ca !== cb || ca === "array" || ca === "object" || ca === "null") {
      throw new GuardError("equality between " + ca + " and " + cb + " is not allowed");
    }
    if (ca === "?") throw new GuardError("equality between values of unsupported type is not allowed");
    return o === "==" ? a === b : a !== b;
  }
  guards._cmp = _cmp;

  function _pred(name, v) {
    let len;
    if (typeof v === "string" || Array.isArray(v)) len = v.length;
    else if (HX.util.is_plain_object(v)) len = Object.keys(v).length;
    else throw new GuardError(name + "() applied to " + _rt_cat(v));
    return name === "empty" ? len === 0 : len > 0;
  }
  guards._pred = _pred;

  /** Python _eval. `bare` is Python's _bare mark: true for names whose ancestors are only and/or/not. */
  function _eval(node, env, unknown_ok, bare) {
    switch (node.type) {
      case "BoolOp": {
        const is_and = node.op === "And";
        let saw_unknown = false;
        for (const v of node.values) {
          const r = _eval(v, env, unknown_ok, true);
          if (r === UNKNOWN) { saw_unknown = true; continue; }
          if (typeof r !== "boolean") throw new GuardError("non-boolean operand of and/or");
          if (is_and && !r) return false;
          if (!is_and && r) return true;
        }
        return saw_unknown ? UNKNOWN : is_and;
      }
      case "UnaryOp": {
        const r = _eval(node.operand, env, unknown_ok, true);
        if (r === UNKNOWN) return UNKNOWN;
        if (typeof r !== "boolean") throw new GuardError("non-boolean operand of not");
        return !r;
      }
      case "Compare": {
        let left = _eval(node.left, env, unknown_ok, false);
        let result = true;
        for (let k = 0; k < node.ops.length; k++) {
          const right = _eval(node.comparators[k], env, unknown_ok, false);
          if (left === UNKNOWN || right === UNKNOWN) result = UNKNOWN;
          else if (!_cmp(guards._CMP[node.ops[k]], left, right)) return false;
          left = right;
        }
        return result;
      }
      case "Call": {
        const v = _eval(node.args[0], env, unknown_ok, false);
        return v === UNKNOWN ? UNKNOWN : _pred(node.func.id, v);
      }
      case "List":
      case "Tuple":
        return node.elts.map((e) => e.value);
      case "Name": {
        if (!has_key(env, node.id)) throw new GuardError("guard uses undefined variable " + repr(node.id));
        const v = get_key(env, node.id);
        if (v === UNKNOWN && !unknown_ok) throw new GuardError("variable " + repr(node.id) + " has no observed value");
        if (v !== UNKNOWN && typeof v !== "boolean" && bare) {
          throw new GuardError("variable " + repr(node.id) + " used as a condition is not boolean");
        }
        return v;
      }
      case "Constant":
        return node.value;
      default:
        throw new GuardError("unexpected node " + node.type);
    }
  }
  guards._eval = function (node, env, unknown_ok, bare) { return _eval(node, env, !!unknown_ok, !!bare); };

  /** Python _is_bare_condition after _prepared() marked the tree: true iff the Name node `name` is reached
   *  from the guard body through and/or/not only, i.e. it is used directly as a condition. */
  guards._is_bare_condition = function (name, tree) {
    const visit = (n, cond) => {
      if (n === name) return cond;
      if (n.type === "BoolOp") return n.values.some((v) => visit(v, true));
      if (n.type === "UnaryOp") return visit(n.operand, true);
      return children(n).some((k) => visit(k, false));
    };
    return visit(tree.type === "Expression" ? tree.body : tree, true);
  };

  /** Strict evaluation: returns a boolean or throws GuardError. */
  guards.evaluate = function evaluate(expr, env) {
    const r = _eval(guards.parse(expr).body, env, false, true);
    if (typeof r !== "boolean") throw new GuardError("guard did not evaluate to a boolean");
    return r;
  };

  /** Kleene three-valued evaluation for structural replay: null means unknown. */
  guards.evaluate3 = function evaluate3(expr, env) {
    const r = _eval(guards.parse(expr).body, env, true, true);
    return r === UNKNOWN ? null : py_truthy(r);
  };

  /* ------------------------------------------------------------------------------------------ */
  /* Disjointness analysis                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  /** Python's Analysis dataclass as a plain object. */
  function Analysis(status, detail, counterexample, edges) {
    return { status, detail: detail === undefined ? "" : detail, counterexample: counterexample || {}, edges: edges || [] };
  }
  guards.Analysis = Analysis;

  /** A Python set of guard constants: True == 1 and False == 0 collide and the first one inserted stays. */
  class PySet {
    constructor() { this.m = new Map(); }
    static key(v) {
      if (typeof v === "boolean") return "n" + (v ? 1 : 0);
      if (typeof v === "number") return "n" + String(v === 0 ? 0 : v);
      return "s" + String(v);
    }
    add(v) { const k = PySet.key(v); if (!this.m.has(k)) this.m.set(k, v); }
    update(vs) { for (const v of vs) this.add(v); }
    values() { return [...this.m.values()]; }
  }

  /** Constants each variable is compared against, and false when outside the enumerable fragment. */
  function _constants_by_var(tree) {
    const consts = new Map();
    const setdefault = (k) => { if (!consts.has(k)) consts.set(k, new PySet()); return consts.get(k); };
    let ok = true;
    for (const n of walk(tree)) {
      if (n.type === "Compare") {
        const operands = [n.left, ...n.comparators];
        for (let k = 0; k < n.ops.length; k++) {
          if ((n.ops[k] === "In" || n.ops[k] === "NotIn") && n.comparators[k].type === "Name") ok = false;
        }
        for (let k = 0; k + 1 < operands.length; k++) {
          const a = operands[k], b = operands[k + 1];
          if (a.type === "Name" && b.type === "Name") ok = false;
          for (const [x, y] of [[a, b], [b, a]]) {
            if (x.type !== "Name") continue;
            if (y.type === "Constant") setdefault(x.id).add(y.value);
            else if (y.type === "List" || y.type === "Tuple") setdefault(x.id).update(y.elts.map((e) => e.value));
          }
        }
      } else if (n.type === "Name" && !is_predicate(n.id)) setdefault(n.id);
    }
    return [consts, ok];
  }
  guards._constants_by_var = function (tree) {
    const [consts, ok] = _constants_by_var(tree);
    const out = new Map();
    for (const [k, s] of consts) out.set(k, s.values());
    return [out, ok];
  };

  const _f64 = new Float64Array(1);
  const _u64 = new BigUint64Array(_f64.buffer);
  /** math.nextafter(x, +inf). */
  function next_up(x) {
    if (Number.isNaN(x) || x === Infinity) return x;
    if (x === 0) return Number.MIN_VALUE;
    _f64[0] = x;
    if (x > 0) _u64[0] += 1n;
    else _u64[0] -= 1n;
    return _f64[0];
  }
  function next_down(x) { return -next_up(-x); }
  guards._next_up = next_up;
  guards._next_down = next_down;

  /** Smallest finite double strictly greater than a, or null (constants are doubles in the port). */
  guards._smallest_float_above = function (a) {
    const f = next_up(a);
    return Number.isFinite(f) ? f : null;
  };

  /* Exact integers beyond the double grid are BigInt; everything else is an exact double. */
  function int_plus(f, d) {
    const r = f + d;
    if (Number.isSafeInteger(f) && Number.isSafeInteger(r)) return r;
    const big = BigInt(f) + BigInt(d);
    const as_num = Number(big);
    return Number.isFinite(as_num) && BigInt(as_num) === big ? as_num : big;
  }
  const exact_key = (v) => (typeof v === "bigint" ? "b" + v.toString() : "n" + String(v === 0 ? 0 : v));
  const exact_cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); /* Number/BigInt comparisons are exact */

  function numeric_domain_ex(integer, cs) {
    const pts = [];
    const seen = new Set();
    for (const c of cs) {
      if (typeof c !== "number") continue; /* bools and strings are not numeric constants */
      const v = c === 0 ? 0 : c;
      if (!seen.has(v)) { seen.add(v); pts.push(v); }
    }
    pts.sort(exact_cmp);
    if (!pts.length) return { values: [0], pts };
    const vals = new Map();
    const add = (v) => { const k = exact_key(v); if (!vals.has(k)) vals.set(k, v); };
    add(0);
    for (const p of pts) {
      if (Number.isInteger(p)) add(p);
      else if (!integer) add(p);
    }
    add(int_plus(Math.floor(pts[0]), -1));
    add(int_plus(Math.floor(pts[pts.length - 1]), 1));
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const nxt = int_plus(Math.floor(a), 1);
      if (nxt < b) add(nxt);
      else if (!integer) {
        const f = guards._smallest_float_above(a);
        if (f !== null && f < b) add(f);
      }
    }
    return { values: [...vals.values()].sort(exact_cmp), pts };
  }

  /** Python _numeric_domain. Values are exact: numbers, or BigInt for integers off the double grid. */
  guards._numeric_domain = function (integer, cs) { return numeric_domain_ex(!!integer, [...cs]).values; };

  /** A JS number in the same equivalence region as the exact value v (strictly between the same
   *  constants), or null if no double lies in that region. */
  function representative(v, pts) {
    if (typeof v === "number") return v;
    let lo = -Infinity, hi = Infinity;
    for (const p of pts) {
      if (p < v) lo = p;
      else if (p > v) { hi = p; break; }
    }
    const r = Number(v);
    if (Number.isFinite(r) && r > lo && r < hi) return r;
    if (r <= lo) {
      const u = next_up(lo);
      return Number.isFinite(u) && u < hi ? u : null;
    }
    const d = next_down(hi);
    return Number.isFinite(d) && d > lo ? d : null;
  }
  guards._representative = representative;

  function domain_ex(t, cs) {
    if (t === "boolean") return { values: [true, false], pts: null };
    if (t === "string") {
      const ss = new Set(["", "\u0000other"]);
      for (const c of cs) if (typeof c === "string") ss.add(c);
      return { values: [...ss].sort(HX.util.cmp_codepoints), pts: null };
    }
    if (t === "array") return { values: [[], ["\u0000x"]], pts: null };
    if (t === "object") return { values: [{}, { "\u0000k": 0 }], pts: null };
    return numeric_domain_ex(t === "integer", cs);
  }
  /** Python _domain (exact values; see _numeric_domain). */
  guards._domain = function (t, cs) { return domain_ex(t, [...cs]).values; };

  /** obj[k] = v as an own data property, even for k === "__proto__" (a legal argument of empty()/nonempty()). */
  function set_own(obj, k, v) {
    Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
    return obj;
  }

  /** Decide whether the guarded edges of one state are pairwise mutually exclusive. */
  guards.analyze_disjoint = function analyze_disjoint(guard_list, var_types) {
    const gl = [...guard_list];
    if (gl.length < 2) return Analysis("PROVEN", "fewer than two guarded edges");
    const consts = new Map();
    const trees = [];
    for (const g of gl) {
      let c, ok;
      try {
        const tree = guards.parse(g);
        trees.push(tree);
        [c, ok] = _constants_by_var(tree);
      } catch (e) {
        if (e instanceof GuardError) return Analysis("UNKNOWN", "unparseable guard: " + e.message);
        throw e;
      }
      if (!ok) {
        return Analysis("UNKNOWN", "guard " + repr(g) + " compares two variables or tests membership in an array " +
          "variable; outside the enumerable fragment");
      }
      for (const [k, s] of c) {
        if (!consts.has(k)) consts.set(k, new PySet());
        consts.get(k).update(s.values());
      }
    }
    const names = [...consts.keys()].sort(HX.util.cmp_codepoints);
    const domains = [];
    for (const name of names) {
      if (!has_key(var_types, name)) return Analysis("UNKNOWN", "undeclared variable " + repr(name));
      const d = domain_ex(get_key(var_types, name), consts.get(name).values());
      domains.push(d.pts ? d.values.map((v) => ({ exact: v, rep: representative(v, d.pts) }))
        : d.values.map((v) => ({ exact: v, rep: v })));
    }
    let total = 1n;
    for (const d of domains) total *= BigInt(d.length);
    if (total > BigInt(guards.MAX_CONFIGS)) {
      return Analysis("UNKNOWN", total + " configurations exceed analysis bound " + guards.MAX_CONFIGS);
    }
    const idx = new Array(names.length).fill(0);
    const count = Number(total);
    for (let step = 0; step < count; step++) {
      const env = {};
      for (let k = 0; k < names.length; k++) {
        const entry = domains[k][idx[k]];
        if (entry.rep === null) {
          return Analysis("UNKNOWN", "representative value " + entry.exact + " for " + repr(names[k]) +
            " has no exact JavaScript number in its region (JavaScript port limitation)");
        }
        set_own(env, names[k], entry.rep);
      }
      const true_edges = [];
      for (let gi = 0; gi < gl.length; gi++) {
        try { /* evaluate(g, env) on the already parsed tree */
          const r = _eval(trees[gi].body, env, false, true);
          if (typeof r !== "boolean") throw new GuardError("guard did not evaluate to a boolean");
          if (r) true_edges.push(gi);
        } catch (e) {
          if (e instanceof GuardError) return Analysis("UNKNOWN", "evaluation error during analysis: " + e.message);
          throw e;
        }
      }
      if (true_edges.length > 1) {
        const cx = {};
        for (const k of names) set_own(cx, k, env[k]);
        return Analysis("COUNTEREXAMPLE", "guards [" + true_edges.join(", ") + "] are simultaneously true", cx, true_edges);
      }
      for (let k = names.length - 1; k >= 0; k--) { /* itertools.product order: last name fastest */
        if (++idx[k] < domains[k].length) break;
        idx[k] = 0;
      }
    }
    return Analysis("PROVEN", "exhaustive over " + total + " representative configurations");
  };
})(globalThis.HX = globalThis.HX || {});
