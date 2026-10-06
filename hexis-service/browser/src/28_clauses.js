/* Port of hexis_service/compiler/clauses.py: source clause indexing with exact span provenance.
 *
 * Clause IDs are ``S<section>.<ordinal>`` (section 0 is text before the first heading; a level-1 heading
 * before any clause is the document title and stays section 0). Each list item and each paragraph is one
 * clause. ``start``/``end`` are Python string offsets, i.e. Unicode CODE POINTS (not UTF-16 units), and
 * ``text`` is exactly ``source[start:end]``.
 *
 * Python semantics reproduced exactly: ``str.splitlines(keepends=True)`` (\n \r \r\n \v \f \x1c \x1d \x1e
 * \x85 U+2028 U+2029), ``str.strip()``/``lstrip()`` (``str.isspace``), ``re`` ``\s`` (same set) and ``\d``
 * (Unicode 15.0 decimal digits, as CPython 3.12), ``re.match`` anchoring and ``.`` (anything but \n).
 * The string helpers are exported for other modules (55_fakes uses them).
 */
(function (HX) {
  "use strict";
  const clauses = (HX.clauses = HX.clauses || {});

  clauses.CRITICAL_MARK = "**MUST**";

  /** Python ``str.isspace()`` / ``re`` ``\s`` character class body (CPython 3.12, Unicode 15.0). */
  const PY_WS = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  /** Python ``re`` ``\d`` for str patterns (Unicode Nd, 15.0); needs the ``u`` flag. */
  const PY_DIGIT = "\\u0030-\\u0039\\u0660-\\u0669\\u06f0-\\u06f9\\u07c0-\\u07c9\\u0966-\\u096f\\u09e6-\\u09ef" +
    "\\u0a66-\\u0a6f\\u0ae6-\\u0aef\\u0b66-\\u0b6f\\u0be6-\\u0bef\\u0c66-\\u0c6f\\u0ce6-\\u0cef\\u0d66-\\u0d6f" +
    "\\u0de6-\\u0def\\u0e50-\\u0e59\\u0ed0-\\u0ed9\\u0f20-\\u0f29\\u1040-\\u1049\\u1090-\\u1099\\u17e0-\\u17e9" +
    "\\u1810-\\u1819\\u1946-\\u194f\\u19d0-\\u19d9\\u1a80-\\u1a89\\u1a90-\\u1a99\\u1b50-\\u1b59\\u1bb0-\\u1bb9" +
    "\\u1c40-\\u1c49\\u1c50-\\u1c59\\ua620-\\ua629\\ua8d0-\\ua8d9\\ua900-\\ua909\\ua9d0-\\ua9d9\\ua9f0-\\ua9f9" +
    "\\uaa50-\\uaa59\\uabf0-\\uabf9\\uff10-\\uff19\\u{104a0}-\\u{104a9}\\u{10d30}-\\u{10d39}\\u{11066}-\\u{1106f}" +
    "\\u{110f0}-\\u{110f9}\\u{11136}-\\u{1113f}\\u{111d0}-\\u{111d9}\\u{112f0}-\\u{112f9}\\u{11450}-\\u{11459}" +
    "\\u{114d0}-\\u{114d9}\\u{11650}-\\u{11659}\\u{116c0}-\\u{116c9}\\u{11730}-\\u{11739}\\u{118e0}-\\u{118e9}" +
    "\\u{11950}-\\u{11959}\\u{11c50}-\\u{11c59}\\u{11d50}-\\u{11d59}\\u{11da0}-\\u{11da9}\\u{11f50}-\\u{11f59}" +
    "\\u{16a60}-\\u{16a69}\\u{16ac0}-\\u{16ac9}\\u{16b50}-\\u{16b59}\\u{1d7ce}-\\u{1d7ff}\\u{1e140}-\\u{1e149}" +
    "\\u{1e2f0}-\\u{1e2f9}\\u{1e4f0}-\\u{1e4f9}\\u{1e950}-\\u{1e959}\\u{1fbf0}-\\u{1fbf9}";
  clauses.PY_WS_CLASS = PY_WS;
  clauses.PY_DIGIT_CLASS = PY_DIGIT;

  const RE_SPACE = new RegExp("^[" + PY_WS + "]$");
  const RE_STRIP = new RegExp("^[" + PY_WS + "]+|[" + PY_WS + "]+$", "g");
  const RE_LSTRIP = new RegExp("^[" + PY_WS + "]+");
  const RE_RSTRIP = new RegExp("[" + PY_WS + "]+$");
  /* _HEADING = r"^(#{1,6})\s+(.*)$" and _ITEM = r"^\s*(?:[-*]|\d+[.)])\s+" (content never holds \n) */
  const RE_HEADING = new RegExp("^(#{1,6})[" + PY_WS + "]+([^\\n]*)$", "u");
  const RE_ITEM = new RegExp("^[" + PY_WS + "]*(?:[-*]|[" + PY_DIGIT + "]+[.)])[" + PY_WS + "]+", "u");
  const LINE_BREAK = /[\n\x0b\x0c\r\x1c\x1d\x1e\x85\u2028\u2029]/;

  /** Python ``ch.isspace()`` for a single character. */
  clauses.py_isspace = function (ch) { return RE_SPACE.test(ch); };
  /** Python ``s.strip()`` / ``s.lstrip()`` / ``s.rstrip()`` (no argument). */
  clauses.py_strip = function (s) { return s.replace(RE_STRIP, ""); };
  clauses.py_lstrip = function (s) { return s.replace(RE_LSTRIP, ""); };
  clauses.py_rstrip = function (s) { return s.replace(RE_RSTRIP, ""); };

  /** Python ``s.splitlines(keepends)``. */
  clauses.splitlines = function (s, keepends) {
    const out = [];
    let i = 0, start = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i];
      if (LINE_BREAK.test(ch)) {
        let end = i + 1;
        if (ch === "\r" && s[i + 1] === "\n") end = i + 2;
        out.push(keepends ? s.slice(start, end) : s.slice(start, i));
        start = i = end;
      } else {
        i++;
      }
    }
    if (start < n) out.push(s.slice(start));
    return out;
  };

  const cplen = (s) => HX.util.codepoint_length(s);

  /** UTF-16 offset of every code point boundary of ``text`` (length = codepoints + 1). */
  function cp_offsets(text) {
    const offs = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      offs.push(i);
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { i += 2; continue; }
      }
      i++;
    }
    offs.push(n);
    return offs;
  }

  /** Python built-in errors as HX.HXError with the class name as ``code`` (as in 55_fakes). */
  function pyerr(type, msg) {
    const e = new HX.HXError(type, msg);
    e.message = msg;
    return e;
  }

  function clause_ref(id, start, end, heading, body) {
    /* Python hashes body.encode("utf-8"): a lone surrogate in a clause body is a UnicodeEncodeError
       (only clause bodies are hashed; a heading or blank line with one is fine, as in Python) */
    if (HX.util.has_lone_surrogate(body)) {
      throw pyerr("UnicodeEncodeError", "'utf-8' codec can't encode character: surrogates not allowed");
    }
    return { id, start, end, heading, text: body, sha256: HX.canonical.sha256_hex(body) };
  }

  /** ``index_clauses(text)`` -> list of ClauseRef dumps ``{id, start, end, heading, text, sha256}``.
   *  A non-string raises AttributeError (``text.splitlines``), as in Python. */
  clauses.index_clauses = function (text) {
    if (typeof text !== "string") {
      const t = text === null || text === undefined ? "NoneType" : typeof text === "boolean" ? "bool"
        : typeof text === "number" ? (Number.isInteger(text) ? "int" : "float") : Array.isArray(text) ? "list" : "dict";
      throw pyerr("AttributeError", "'" + t + "' object has no attribute 'splitlines'");
    }
    const offs = cp_offsets(text);
    const slice = (s, e) => text.slice(offs[s], offs[e]);
    const out = [];
    let section = 0, ordinal = 0, heading = "";
    let pos = 0;
    let para_start = null, para_end = null;

    function flush_para() {
      if (para_start !== null && para_end !== null && clauses.py_strip(slice(para_start, para_end))) {
        ordinal += 1;
        const body = slice(para_start, para_end);
        out.push(clause_ref("S" + section + "." + ordinal, para_start, para_end, heading, body));
      }
      para_start = para_end = null;
    }

    for (const line of clauses.splitlines(text, true)) {
      const start = pos;
      const content = line.replace(/[\r\n]+$/, "");
      pos += cplen(line);
      const h = RE_HEADING.exec(content);
      if (h) {
        flush_para();
        if (h[1].length === 1 && section === 0 && !out.length) {
          heading = clauses.py_strip(h[2]); /* document title stays section 0 */
          continue;
        }
        section += 1;
        ordinal = 0;
        heading = clauses.py_strip(h[2]);
        continue;
      }
      if (!clauses.py_strip(content)) {
        flush_para();
        continue;
      }
      const m = RE_ITEM.exec(content);
      if (m) {
        flush_para();
        ordinal += 1;
        const s = start + cplen(m[0]);
        const e = start + cplen(content);
        out.push(clause_ref("S" + section + "." + ordinal, s, e, heading, slice(s, e)));
        continue;
      }
      if (para_start === null) para_start = start + (cplen(content) - cplen(clauses.py_lstrip(content)));
      para_end = start + cplen(content);
    }
    flush_para();
    return out;
  };

  /** ``is_critical(clause)``: the clause text contains ``**MUST**``. */
  clauses.is_critical = function (clause) {
    return clause.text.indexOf(clauses.CRITICAL_MARK) >= 0;
  };
})(globalThis.HX = globalThis.HX || {});
