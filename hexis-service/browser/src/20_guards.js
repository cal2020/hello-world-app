/* Port of hexis_service/guards.py: allowlisted guard parsing, static typing, strict and Kleene
 * evaluation, and PROVEN / COUNTEREXAMPLE / UNKNOWN disjointness analysis.
 *
 * parse() accepts exactly the strings the Python reference accepts, i.e. CPython 3.12's
 * ast.parse(expr, mode="eval") followed by the allowlist and the size limits. It is built from
 *   - a port of the CPython 3.12 tokenizer (indentation, blank and comment lines, backslash
 *     continuation, nesting limit of 200 brackets, number literals including the keyword-adjacent
 *     forms such as `1and x`, string prefixes and escapes, newline translation);
 *   - identifiers checked against Python's own Unicode 15.0 XID tables (embedded below; JS engines
 *     ship newer Unicode data) and NFKC-normalized like CPython (keywords are recognized on the raw
 *     spelling, so `Ｔｒｕｅ` is the name `True`);
 *   - a recursive-descent parser that mirrors the PEG grammar's precedence and associativity and
 *     builds Python-shaped AST nodes, so node counts and depths are computed exactly like ast.walk
 *     and guards._depth (which count Expression, ctx Load nodes and operator nodes).
 * Constructs that can never pass the allowlist are rejected as soon as they are seen (f-strings,
 * bytes, complex literals, lambda, comprehensions, subscripts, ...). Every rejection is a GuardError.
 *
 * Deliberate, conservative deviations (deviations/guards.md): integer literals above 2^53-1, string
 * escapes that produce surrogate code points and \N{...} escapes are rejected; a lone surrogate in the
 * guard text raises GuardError (Python raises UnicodeEncodeError); disjointness analysis reports
 * UNKNOWN when it would have to evaluate a representative value that no JS number can stand for.
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
  function repr(v) { return HX.util.py_repr(v); }

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
  /* Tokenizer (port of CPython 3.12 Parser/tokenizer.c, normal mode)                             */
  /* ------------------------------------------------------------------------------------------ */

  const EOF = -1;
  const MAXLEVEL = 200;
  const TABSIZE = 8;
  const KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);
  const TWO_CHAR = new Set(["!=", "%=", "&=", "**", "*=", "+=", "-=", "->", "//", "/=", ":=", "<<", "<=", "<>", "==",
    ">=", ">>", "@=", "^=", "|="]);
  const THREE_CHAR = new Set(["**=", "...", "//=", "<<=", ">>="]);
  const ONE_CHAR = "%&()*+,-./:;<=>@[]^{|}~!";

  function syntax_error(msg) { return new GuardError("guard syntax error: " + msg); }
  function hex4(c) { return c.toString(16).toUpperCase().padStart(4, "0"); }
  const isdigit = (c) => c >= 0x30 && c <= 0x39;
  const isxdigit = (c) => isdigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
  const is_id_start = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c >= 128;
  const is_id_char = (c) => is_id_start(c) || isdigit(c);

  /** Tokenize newline-translated source (array of code points). Throws GuardError. */
  function tokenize(cps) {
    const n = cps.length;
    let pos = 0;
    let atbol = true;
    let level = 0;
    const parens = [];
    const toks = [];
    const nextc = () => (pos < n ? cps[pos++] : EOF);
    const backup = (c) => { if (c !== EOF) pos--; };
    const text = (a, b) => String.fromCodePoint(...cps.slice(a, b));
    const lineno = () => { let l = 1; for (let k = 0; k < pos && k < n; k++) if (cps[k] === 0x0a) l++; return l; };

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
      const raw = text(start, pos);
      const clean = raw.replace(/_/g, "");
      const last = clean.charCodeAt(clean.length - 1);
      if (last === 0x6a || last === 0x4a) {
        throw new GuardError("constant not allowed: complex literal " + raw);
      }
      const p2 = clean.slice(0, 2).toLowerCase();
      if (p2 === "0x" || p2 === "0o" || p2 === "0b" || !/[.eE]/.test(clean)) {
        const big = BigInt(p2 === "0x" || p2 === "0o" || p2 === "0b" ? p2 + clean.slice(2) : clean);
        if (big > BigInt(guards.MAX_INT_LITERAL)) {
          throw new GuardError("integer literal " + raw + " is outside the range supported by the JavaScript port " +
            "(at most 2^53-1)");
        }
        return { t: "NUMBER", value: Number(big), py_type: "int" };
      }
      return { t: "NUMBER", value: Number(clean), py_type: "float" };
    }

    /* After the integer part of a decimal literal; c is the next character (consumed). */
    function after_int(c, start) {
      if (c === 0x2e) return fraction(nextc(), start);
      return exponent_or_end(c, start);
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
      return imag_or_end(c, start);
    }
    function imag_or_end(c, start) {
      if (c === 0x6a || c === 0x4a) {
        c = nextc();
        verify_end_of_number(c, "imaginary");
      } else verify_end_of_number(c, "decimal");
      backup(c);
      return number_token(start);
    }

    function read_number(c, start) {
      if (c !== 0x30) return after_int(decimal_tail(), start);
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
      if (c === 0x6a || c === 0x4a) return imag_or_end(c, start);
      if (nonzero) {
        backup(c);
        throw syntax_error("leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers");
      }
      verify_end_of_number(c, "decimal");
      backup(c);
      return number_token(start);
    }

    /* Python unicode-escape decoding of a non-raw string body (code points). */
    function decode_escapes(body) {
      let out = "";
      const len = body.length;
      for (let k = 0; k < len; k++) {
        const c = body[k];
        if (c !== 0x5c) { out += String.fromCodePoint(c); continue; }
        const e = body[++k];
        switch (e) {
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
          case 0x4e:
            throw new GuardError("\\N{...} escapes are not supported by the JavaScript port");
          default:
            break;
        }
        if (e >= 0x30 && e <= 0x37) {
          let ch = e - 0x30;
          if (k + 1 < len && body[k + 1] >= 0x30 && body[k + 1] <= 0x37) {
            ch = (ch << 3) + body[++k] - 0x30;
            if (k + 1 < len && body[k + 1] >= 0x30 && body[k + 1] <= 0x37) ch = (ch << 3) + body[++k] - 0x30;
          }
          out += String.fromCodePoint(ch);
          continue;
        }
        if (e === 0x78 || e === 0x75 || e === 0x55) {
          const count = e === 0x78 ? 2 : e === 0x75 ? 4 : 8;
          let ch = 0;
          for (let j = 0; j < count; j++) {
            const d = k + 1 < len ? body[k + 1] : EOF;
            if (!isxdigit(d)) {
              const name = e === 0x78 ? "\\xXX" : e === 0x75 ? "\\uXXXX" : "\\UXXXXXXXX";
              throw syntax_error("(unicode error) 'unicodeescape' codec can't decode bytes: truncated " + name + " escape");
            }
            ch = ch * 16 + parseInt(String.fromCharCode(d), 16);
            k++;
          }
          if (ch > 0x10ffff) {
            throw syntax_error("(unicode error) 'unicodeescape' codec can't decode bytes: illegal Unicode character");
          }
          if (ch >= 0xd800 && ch <= 0xdfff) {
            throw new GuardError("string escapes producing surrogate code points are not supported by the JavaScript port");
          }
          out += String.fromCodePoint(ch);
          continue;
        }
        /* unknown escape (SyntaxWarning in Python): kept verbatim */
        out += "\\" + String.fromCodePoint(e);
      }
      return out;
    }

    function read_string(quote, raw) {
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
          throw syntax_error((quote_size === 3 ? "unterminated triple-quoted string literal" : "unterminated string literal") +
            " (detected at line " + lineno() + ")");
        }
        if (c === quote) end_quote_size += 1;
        else {
          end_quote_size = 0;
          if (c === 0x5c) nextc(); /* skip the escaped character */
        }
      }
      const body = cps.slice(body_start, Math.max(body_start, pos - quote_size));
      return { t: "STRING", value: raw ? String.fromCodePoint(...body) : decode_escapes(body) };
    }

    function verify_identifier(start) {
      for (let k = start; k < pos; k++) {
        const ch = cps[k];
        const ok = k === start ? ch === 0x5f || guards._is_xid_start(ch) : guards._is_xid_continue(ch);
        if (!ok) {
          throw syntax_error(ch >= 0x20 && ch !== 0x7f
            ? "invalid character '" + String.fromCodePoint(ch) + "' (U+" + hex4(ch) + ")"
            : "invalid non-printable character U+" + hex4(ch));
        }
      }
    }

    for (;;) { /* one iteration per CPython tok_get call (label "nextline") */
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
      let emitted = false;
      while (!emitted) { /* label "again" */
        let c;
        do { c = nextc(); } while (c === 0x20 || c === 0x09 || c === 0x0c);
        const start = c === EOF ? pos : pos - 1;
        if (c === 0x23) { while (c !== EOF && c !== 0x0a) c = nextc(); }
        if (c === EOF) {
          if (level) throw syntax_error("'" + String.fromCharCode(parens[parens.length - 1]) + "' was never closed");
          toks.push({ t: "ENDMARKER" });
          return toks;
        }
        if (is_id_start(c)) {
          let saw_b = false, saw_r = false, saw_u = false, saw_f = false, str = null;
          for (;;) {
            if (!(saw_b || saw_u || saw_f) && (c === 0x62 || c === 0x42)) saw_b = true;
            else if (!(saw_b || saw_u || saw_r || saw_f) && (c === 0x75 || c === 0x55)) saw_u = true;
            else if (!(saw_r || saw_u) && (c === 0x72 || c === 0x52)) saw_r = true;
            else if (!(saw_f || saw_b || saw_u) && (c === 0x66 || c === 0x46)) saw_f = true;
            else break;
            c = nextc();
            if (c === 0x22 || c === 0x27) {
              if (saw_f) throw new GuardError("syntax node not allowed: JoinedStr");
              if (saw_b) throw new GuardError("constant not allowed: bytes literal");
              str = read_string(c, saw_r);
              break;
            }
          }
          if (str) { toks.push(str); emitted = true; continue; }
          let nonascii = false;
          while (is_id_char(c)) {
            if (c >= 128) nonascii = true;
            c = nextc();
          }
          backup(c);
          if (nonascii) verify_identifier(start);
          const s = text(start, pos);
          toks.push({ t: "NAME", s, kw: !nonascii && KEYWORDS.has(s), id: nonascii ? s.normalize("NFKC") : s });
          emitted = true;
          continue;
        }
        if (c === 0x0a) {
          atbol = true;
          if (blankline || level > 0) break; /* goto nextline */
          toks.push({ t: "NEWLINE" });
          emitted = true;
          continue;
        }
        if (c === 0x2e) {
          const c2 = nextc();
          if (isdigit(c2)) { toks.push(fraction(c2, start)); emitted = true; continue; }
          if (c2 === 0x2e) {
            const c3 = nextc();
            if (c3 === 0x2e) { toks.push({ t: "OP", s: "..." }); emitted = true; continue; }
            backup(c3);
          }
          backup(c2);
          toks.push({ t: "OP", s: "." });
          emitted = true;
          continue;
        }
        if (isdigit(c)) { toks.push(read_number(c, start)); emitted = true; continue; }
        if (c === 0x27 || c === 0x22) { toks.push(read_string(c, false)); emitted = true; continue; }
        if (c === 0x5c) { continuation(); continue; } /* goto again */
        const c2 = nextc();
        if (c2 !== EOF && c2 < 128 && TWO_CHAR.has(String.fromCharCode(c, c2))) {
          const two = String.fromCharCode(c, c2);
          const c3 = nextc();
          if (c3 !== EOF && c3 < 128 && THREE_CHAR.has(two + String.fromCharCode(c3))) {
            toks.push({ t: "OP", s: two + String.fromCharCode(c3) });
          } else {
            backup(c3);
            toks.push({ t: "OP", s: two });
          }
          emitted = true;
          continue;
        }
        backup(c2);
        if (c === 0x28 || c === 0x5b || c === 0x7b) {
          if (level >= MAXLEVEL) throw syntax_error("too many nested parentheses");
          parens.push(c);
          level++;
        } else if (c === 0x29 || c === 0x5d || c === 0x7d) {
          if (!level) throw syntax_error("unmatched '" + String.fromCharCode(c) + "'");
          level--;
          const opening = parens.pop();
          if (!((opening === 0x28 && c === 0x29) || (opening === 0x5b && c === 0x5d) || (opening === 0x7b && c === 0x7d))) {
            throw syntax_error("closing parenthesis '" + String.fromCharCode(c) + "' does not match opening parenthesis '" +
              String.fromCharCode(opening) + "'");
          }
        }
        if (c < 0x20 || c === 0x7f) throw syntax_error("invalid non-printable character U+" + hex4(c));
        if (ONE_CHAR.indexOf(String.fromCharCode(c)) < 0) throw syntax_error("invalid syntax");
        toks.push({ t: "OP", s: String.fromCharCode(c) });
        emitted = true;
      }
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Parser (PEG grammar of CPython 3.12, expression subset)                                      */
  /* ------------------------------------------------------------------------------------------ */

  const COMPARE_OPS = { "==": "Eq", "!=": "NotEq", "<": "Lt", "<=": "LtE", ">": "Gt", ">=": "GtE" };
  const BIN_LEVELS = [
    { "|": "BitOr" }, { "^": "BitXor" }, { "&": "BitAnd" }, { "<<": "LShift", ">>": "RShift" },
    { "+": "Add", "-": "Sub" }, { "*": "Mult", "/": "Div", "//": "FloorDiv", "%": "Mod", "@": "MatMult" },
  ];
  const UNARY_OPS = { "-": "USub", "+": "UAdd", "~": "Invert" };
  const EXPR_START_KW = new Set(["True", "False", "None", "not", "lambda", "await"]);
  const EXPR_START_OP = new Set(["(", "[", "{", "-", "+", "~", "..."]);

  function constant(value, py_type) { return { type: "Constant", value, py_type }; }

  function parse_tokens(toks) {
    let i = 0;
    const peek = (k) => toks[Math.min(i + (k || 0), toks.length - 1)];
    const is_op = (tk, s) => tk.t === "OP" && tk.s === s;
    const is_kw = (tk, s) => tk.t === "NAME" && tk.kw && tk.s === s;
    const is_name = (tk) => tk.t === "NAME" && !tk.kw;
    const fail = (msg) => { throw syntax_error(msg || "invalid syntax"); };
    const reject = (what) => { throw new GuardError("syntax node not allowed: " + what); };
    const expect_op = (s) => { if (!is_op(peek(), s)) fail(); i++; };
    const starts_expression = (tk) =>
      tk.t === "NUMBER" || tk.t === "STRING" || (tk.t === "NAME" && (!tk.kw || EXPR_START_KW.has(tk.s))) ||
      (tk.t === "OP" && EXPR_START_OP.has(tk.s));
    const comprehension_follows = () => is_kw(peek(), "for") || is_kw(peek(), "async");

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
    function expression() {
      if (is_kw(peek(), "lambda")) reject("Lambda");
      const body = disjunction();
      if (!is_kw(peek(), "if")) return body;
      i++;
      const test = disjunction();
      if (!is_kw(peek(), "else")) fail("expected 'else' after 'if' expression");
      i++;
      return { type: "IfExp", test, body, orelse: expression() };
    }
    function named_expression() {
      if (is_name(peek()) && is_op(peek(1), ":=")) reject("NamedExpr");
      const e = expression();
      if (is_op(peek(), ":=")) fail();
      return e;
    }
    function bool_chain(word, next, op) {
      const first = next();
      if (!is_kw(peek(), word)) return first;
      const values = [first];
      while (is_kw(peek(), word)) { i++; values.push(next()); }
      return { type: "BoolOp", op, values };
    }
    function disjunction() { return bool_chain("or", conjunction, "Or"); }
    function conjunction() { return bool_chain("and", inversion, "And"); }
    function inversion() {
      if (is_kw(peek(), "not")) { i++; return { type: "UnaryOp", op: "Not", operand: inversion() }; }
      return comparison();
    }
    function comparison() {
      const left = binary(0);
      const ops = [], comparators = [];
      for (;;) {
        const tk = peek();
        let op = null;
        if (tk.t === "OP" && hasOwn.call(COMPARE_OPS, tk.s)) { op = COMPARE_OPS[tk.s]; i++; }
        else if (is_kw(tk, "in")) { op = "In"; i++; }
        else if (is_kw(tk, "not") && is_kw(peek(1), "in")) { op = "NotIn"; i += 2; }
        else if (is_kw(tk, "is")) {
          if (is_kw(peek(1), "not")) { op = "IsNot"; i += 2; } else { op = "Is"; i++; }
        }
        if (!op) break;
        ops.push(op);
        comparators.push(binary(0));
      }
      return ops.length ? { type: "Compare", left, ops, comparators } : left;
    }
    function binary(lvl) {
      if (lvl === BIN_LEVELS.length) return factor();
      const table = BIN_LEVELS[lvl];
      let left = binary(lvl + 1);
      for (;;) {
        const tk = peek();
        if (tk.t !== "OP" || !hasOwn.call(table, tk.s)) return left;
        i++;
        left = { type: "BinOp", left, op: table[tk.s], right: binary(lvl + 1) };
      }
    }
    function factor() {
      const tk = peek();
      if (tk.t === "OP" && hasOwn.call(UNARY_OPS, tk.s)) {
        i++;
        return { type: "UnaryOp", op: UNARY_OPS[tk.s], operand: factor() };
      }
      const base = await_primary();
      if (is_op(peek(), "**")) { i++; return { type: "BinOp", left: base, op: "Pow", right: factor() }; }
      return base;
    }
    function await_primary() {
      if (is_kw(peek(), "await")) reject("Await");
      return primary();
    }
    function primary() {
      let e = atom();
      for (;;) {
        const tk = peek();
        if (is_op(tk, ".")) {
          i++;
          if (!is_name(peek())) fail();
          e = { type: "Attribute", value: e, attr: peek().id };
          i++;
        } else if (is_op(tk, "(")) e = call(e);
        else if (is_op(tk, "[")) reject("Subscript");
        else return e;
      }
    }
    function call(func) {
      i++; /* ( */
      const args = [];
      if (is_op(peek(), ")")) { i++; return { type: "Call", func, args, keywords: [] }; }
      for (;;) {
        const tk = peek();
        if (is_op(tk, "*")) reject("Starred");
        if (is_op(tk, "**") || (is_name(tk) && is_op(peek(1), "="))) {
          throw new GuardError(func.type === "Name" && is_predicate(func.id)
            ? func.id + " takes exactly one variable argument" : "only empty(x) / nonempty(x) calls are allowed");
        }
        if (is_name(tk) && is_op(peek(1), ":=")) reject("NamedExpr");
        const e = expression();
        if (comprehension_follows()) reject("GeneratorExp");
        if (is_op(peek(), "=") || is_op(peek(), ":=")) fail();
        args.push(e);
        if (is_op(peek(), ",")) {
          i++;
          if (is_op(peek(), ")")) break;
          continue;
        }
        break;
      }
      expect_op(")");
      return { type: "Call", func, args, keywords: [] };
    }
    function atom() {
      const tk = peek();
      if (tk.t === "NAME") {
        if (!tk.kw) { i++; return { type: "Name", id: tk.id }; }
        if (tk.s === "True" || tk.s === "False") { i++; return constant(tk.s === "True", "bool"); }
        if (tk.s === "None") { i++; return constant(null, "NoneType"); }
        fail();
      }
      if (tk.t === "NUMBER") { i++; return constant(tk.value, tk.py_type); }
      if (tk.t === "STRING") {
        let s = "";
        while (peek().t === "STRING") { s += peek().value; i++; }
        return constant(s, "str");
      }
      if (tk.t === "OP") {
        if (tk.s === "(") return paren();
        if (tk.s === "[") return list();
        if (tk.s === "{") reject(is_op(peek(1), "}") ? "Dict" : "Dict/Set");
        if (tk.s === "...") { i++; return constant(null, "ellipsis"); }
      }
      fail();
    }
    function paren() {
      i++; /* ( */
      if (is_op(peek(), ")")) { i++; return { type: "Tuple", elts: [] }; }
      if (is_kw(peek(), "yield")) reject("Yield");
      if (is_op(peek(), "*")) reject("Starred");
      const first = named_expression();
      if (comprehension_follows()) reject("GeneratorExp");
      if (is_op(peek(), ")")) { i++; return first; }
      if (!is_op(peek(), ",")) fail();
      const elts = [first];
      while (is_op(peek(), ",")) {
        i++;
        if (is_op(peek(), ")")) break;
        if (is_op(peek(), "*")) reject("Starred");
        elts.push(named_expression());
      }
      expect_op(")");
      return { type: "Tuple", elts };
    }
    function list() {
      i++; /* [ */
      const elts = [];
      if (is_op(peek(), "]")) { i++; return { type: "List", elts }; }
      for (;;) {
        if (is_op(peek(), "*")) reject("Starred");
        const e = named_expression();
        if (!elts.length && comprehension_follows()) reject("ListComp");
        elts.push(e);
        if (is_op(peek(), ",")) {
          i++;
          if (is_op(peek(), "]")) break;
          continue;
        }
        break;
      }
      expect_op("]");
      return { type: "List", elts };
    }

    const body = expressions();
    while (peek().t === "NEWLINE") i++;
    if (peek().t !== "ENDMARKER") fail();
    return { type: "Expression", body };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* AST metrics (ast.walk count and guards._depth, including ctx/op nodes)                       */
  /* ------------------------------------------------------------------------------------------ */

  /** Child nodes in ast.iter_child_nodes order; ctx and operator nodes appear as {type: <op name>}. */
  function children(node) {
    switch (node.type) {
      case "Expression": return [node.body];
      case "BoolOp": return [{ type: node.op }, ...node.values];
      case "UnaryOp": return [{ type: node.op }, node.operand];
      case "BinOp": return [node.left, { type: node.op }, node.right];
      case "Compare": return [node.left, ...node.ops.map((o) => ({ type: o })), ...node.comparators];
      case "Call": return [node.func, ...node.args, ...node.keywords];
      case "IfExp": return [node.test, node.body, node.orelse];
      case "Attribute": return [node.value, { type: "Load" }];
      case "List": case "Tuple": return [...node.elts, { type: "Load" }];
      case "Name": return [{ type: "Load" }];
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
  /** guards._depth: 1 + max depth of the children. */
  function _depth(node) {
    let m = 0;
    for (const c of children(node)) { const d = _depth(c); if (d > m) m = d; }
    return 1 + m;
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

  /** Syntax only: the Python-shaped tree of ast.parse(expr, mode="eval") (no limits, no allowlist).
   *  Throws GuardError for syntax errors and for constructs the port never builds. */
  guards._parse_raw = function (expr) {
    if (typeof expr !== "string") throw new GuardError("guard is not a string");
    if (HX.util.has_lone_surrogate(expr)) {
      throw new GuardError("guard text contains a lone surrogate (not encodable as UTF-8)");
    }
    if (expr.indexOf("\u0000") >= 0) throw syntax_error("source code string cannot contain null bytes");
    const src = expr.replace(/\r\n?/g, "\n");
    const cps = [];
    for (const ch of src) cps.push(ch.codePointAt(0));
    return parse_tokens(tokenize(cps));
  };

  function const_repr(node) {
    if (node.py_type === "NoneType") return "None";
    if (node.py_type === "ellipsis") return "Ellipsis";
    return repr(node.value);
  }

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
    if (walk(tree).length > guards.MAX_NODES) {
      throw new GuardError("guard has more than " + guards.MAX_NODES + " syntax nodes");
    }
    if (_depth(tree) > guards.MAX_DEPTH) throw new GuardError("guard AST deeper than " + guards.MAX_DEPTH);
    _check(tree.body);
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
