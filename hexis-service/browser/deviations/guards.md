# `20_guards` (`HX.guards`): deliberate deviations from `guards.py`

Reference: `src/hexis_service/guards.py` on CPython 3.12.3 (`unicodedata` 15.0.0). The port reproduces
`ast.parse(expr, mode="eval")` followed by the allowlist and limits, and then typing, evaluation and
disjointness analysis. Parity is proven by `golden/gen_guards.py` (the real Python code) and
`test/20_guards.test.js`. Every entry below is conservative: the port rejects, errors or reports `UNKNOWN`
where Python would accept, return a value or decide. It is never more permissive.

| # | Area | Python | JS port | Why | Test |
|---|---|---|---|---|---|
| 1 | Integer literals above 2^53−1 (`n > 9007199254740993`, `0x20000000000000`, a 400-digit literal) | accepted (arbitrary-precision int) | `GuardError` "integer literal … is outside the range supported by the JavaScript port", raised only when Python's own checks (syntax, node count, depth, allowlist) all pass. A guard that Python rejects for another reason gets Python's message (`[9007199254740993, x]` → "list literals may only contain constants"). | a JS number cannot hold the exact value. Comparisons would silently round, so a guard could change meaning. Guard literals are never negative (unary minus is not allowed), so only the upper bound applies. | "documented deviations are exactly …" (`dev` cases), corpus notes "JS deviation" and "deviation after Python's checks", "analyze_disjoint: status, edges …" (`literal_dev`) |
| 2 | `\N{name}` escapes in non-raw string literals | resolved through the Unicode name database; an unknown name is a syntax error | the escape's syntax is checked, and so is the character set of the name (Unicode names use only letters, digits, space and hyphen). It stands for one placeholder character. A guard Python accepts is then rejected with `GuardError` "\N{...} escapes are not supported by the JavaScript port", after Python's own checks. If the name is not a real character name, Python reports a syntax error, and the port reports what Python would report after it, or the message above. | shipping the ~1 MB name database in the page is not worth it. Raw strings (`r'\N'`) and bytes are unaffected. | "documented deviations …"; the parse tests relax only the message of texts containing `\N` (`nesc`) |
| 3 | String escapes that produce a surrogate code point (`'\ud800'`, `'\ud83d\ude00'`, `'\U0000d800'`) | accepted: a str of lone surrogates (`'\ud83d\ude00'` is 2 code points and differs from `'😀'`) | one placeholder character each (so lengths, node counts and Python's messages are unchanged), and `GuardError` "string escapes producing surrogate code points are not supported by the JavaScript port" for a guard Python accepts | JS strings cannot tell a surrogate pair from the astral character, so `== '😀'` would become true and the 256-character limit would count differently | "documented deviations …" |
| 4 | Inputs on which CPython's `ast.parse` raises something other than `SyntaxError`, so that `parse`, `typecheck`, `evaluate`, `evaluate3` and `analyze_disjoint` all raise it (none of them catches it): **`UnicodeEncodeError`**: the guard text contains a lone surrogate. **`MemoryError`** ("Parser stack overflowed"): CPython's parser has a limit of 6000 nested rule calls. Its second, error-reporting pass, which only runs on invalid input, uses more calls per bracket than the first, and overflows on some invalid guards nested about 190 or more brackets deep, still within 512 characters and under the 200-bracket tokenizer limit. Examples: `'[' * 193 + 'x' + ']' * 193 + ' x'`, `'(' * 200 + 'x +' + ')' * 200`. Valid input never overflows (the first pass handles 200 levels). **`ValueError`** ("field 'value' is required for Constant"): an f-string `=` field inside a format specification, `f'{x:{y=}}'`. The AST constructor raises it while parsing. **`UnicodeDecodeError`**: an invalid escape in the text of an f-string format specification, `f'{x:\x4}'`. CPython does not convert this decode error into a `SyntaxError`. | the exception | `GuardError`. `typecheck` returns `[message]`, `evaluate` raises `GuardError`, and `analyze_disjoint` returns `UNKNOWN` "unparseable guard: …". The message names the cause (lone surrogate; f-string `=` field), or it is a syntax error: the text is invalid anyway, and the port's tokenizer runs ahead of its parser, so a later syntax error can be reported first. | the same rejection, with the error class that callers handle. The port is never more permissive here. Every guard Python accepts at maximal depth is accepted (golden notes "maximal depth"; during development, none of 2,166 valid random nestings up to 200 brackets deep overflowed CPython's first pass). | "documented deviations …" (the committed `exc` cases of all four classes, including the verifier's `[`×193 case), "analyze_disjoint: status, edges …" (cases with `x`) |
| 5 | Disjointness analysis when an exact representative has no double in its region | Python evaluates exact ints such as `2**53 + 1` between the constants `9007199254740992.0` and `9007199254740994.0`, or above `1.7976931348623157e308` | when the enumeration reaches such a value it returns `UNKNOWN` ("… has no exact JavaScript number in its region (JavaScript port limitation)"). Up to that point the enumeration and its results are identical. | the guards would be evaluated on a value no JS number can stand for. `UNKNOWN` fails admission (`GUARDS_DISJOINTNESS_UNKNOWN`) just as `COUNTEREXAMPLE` does (`GUARDS_OVERLAP`). This is only reachable with constants at or above 2^53. | "deviation - an integer between adjacent doubles …", "analyze_disjoint: status, edges …" (`port_unknown`) |
| 6 | Counterexample values for exact integers beyond the double grid that do have room in their region | e.g. `{"x": 100000000000000000001}` for `x > 1e20` / `x > 5e19` | the nearest double strictly inside the same region, e.g. `100000000000000016384` | status, edges and the order of the enumeration are unchanged (the value lies strictly between the same constants), and the counterexample really satisfies the guards under JS `evaluate`. **Consumers:** a counterexample can hold an integral number at or above 2^53, both here and where it equals Python's value exactly (`x >= 1e16` / `x == 1e16` gives `{x: 10000000000000000}` on both sides). `HX.canonical` refuses such numbers (`CanonicalError`), so a counterexample must not be digested as is; `HX.validate` reports them as digit strings (`deviations/static.md` #7) | "analyze_disjoint: status, edges …" (`rep`), "deviation - …"; `30_validate` "documented deviation #7 …" |
| 7 | `typecheck` with a mixed-type list literal (`x in [1, 'a']`) | `set.pop()` returns an arbitrary kind (hash order, randomized per process). Later errors can depend on it, e.g. "'in' mixes string with a list of numeric". | always pops in the fixed order numeric, string, boolean (a stable order that CPython's own pop also exhibits for some hash seeds) | Python is nondeterministic here. The guard is already rejected by "mixed-type list literal", so only the extra messages vary. | "typecheck returns Python's exact error lists" (the golden enumerates every pop order) |
| 8 | Equality between values that are not JSON-like (`undefined`, BigInt, functions, class instances) in an environment | Python's `==` on objects of the same unknown category | `GuardError` "equality between values of unsupported type is not allowed" | Python environments come from JSON and never contain such values. Failing closed is safer than guessing a JS equality. | "GuardError, UNKNOWN, vars_of, Map inputs …" |
| 9 | Non-string, unhashable `expr` (e.g. a list) | `TypeError` from `lru_cache` | `GuardError` "empty guard …" (the same as for other non-strings) | consistent error class. Callers pass strings. | "GuardError, UNKNOWN …" |
| 10 | A JavaScript stack too small for deep nesting | the C parser accepts every guard up to the 200-bracket tokenizer limit | the parser uses about six JS frames per bracket level. The deepest guards Python accepts (200 nested brackets) need about 250 KB of V8 stack. That is available in Node (984 KB default), in a Chromium page, and in a cold dedicated Worker in Chromium 141 (about 500 KB; measured with room to spare). On a smaller stack, `parse` raises `GuardError` "guard is nested too deeply for this JavaScript engine's stack (JavaScript port limitation)", never `RangeError`/`InternalError`. `typecheck` and `analyze_disjoint` then treat the guard like any invalid one. The error object is built in advance so that reporting it needs almost no stack. A caller that has already exhausted the stack before calling still gets the engine's own error. | engine stack sizes vary. Failing closed keeps the module's contract (only `GuardError`). | "deep nesting never escapes as RangeError …" (child processes with `--stack-size=984` and `120`) |

## Not deviations (verified equal, listed because JS makes them easy to get wrong)

* **Lexing**: CPython's tokenizer is ported, not approximated. That covers indentation (`" x"` and `"x\n "` are
  errors, `"\fx"` and `"x\n\f"` are fine), blank and comment lines, backslash continuation (including at EOF), CRLF
  and lone CR translation, the 200-bracket nesting limit, and keyword-adjacent numbers (`x == 1and y`,
  `x==1in[1]` and `0x1for y` are valid with only a SyntaxWarning). It also covers number literal rules (`0_0`,
  `09.5`, `1_`, `01`, imaginary literals) and the string prefix grammar (`ur''` and `bu''` are a name followed by a
  string, so they are syntax errors). PEP 701 f-strings are tokenized with CPython's mode stack: nested replacement
  fields and format specifications (at most 3 expression levels), `{{`/`}}`, conversions, quote reuse, comments
  and newlines in fields, the `=` debug text (with CPython's comment stripping), and the `\N{` and `\{` special
  cases. Bytes literals are ASCII-only with bytes escapes.
* **Parsing**: the whole expression grammar of the first PEG pass is ported, and every construct gets a
  Python-shaped node: lambda parameters, comprehensions with their targets, slices, keyword and starred
  arguments, dict/set displays, `await`, `yield`, walrus, attributes, subscripts, f-strings (`JoinedStr` and
  `FormattedValue`, built with CPython's string concatenation and empty-part rules), bytes and complex constants.
  `_parse_raw` returns these trees (Store contexts are explicit). So node counts, depths and the order in which
  `_check` meets the first offending node are Python's. A guard therefore gets Python's allowlist or limit message
  whatever it contains: "constant not allowed: 1j", "constant not allowed: b'a'", "list literals may only contain
  constants" for `[*y]` or `[f'a']`, "empty takes exactly one variable argument" for a generator argument,
  "syntax node not allowed: Set", "the only unary operator allowed is 'not'" for `-{x}`, or "guard has more than
  64 syntax nodes" before any allowlist message. The JS-only rejections (#1 to #3) are decided after all of
  Python's checks.
* **Messages**: every `GuardError` text from the allowlist, the limits, `typecheck`, evaluation and
  `analyze_disjoint` is Python's exact string. That includes the `repr()` parts. Python's `str` repr is
  reproduced with the Unicode 15.0 `str.isprintable` table embedded in the module (non-ASCII Zs/Zl/Zp/Cc/Cf/Cs/Co/Cn
  become `\xhh`, `\uhhhh` or `\Uhhhhhhhh`). Bytes, complex, `None` and `Ellipsis` use Python's reprs as well. The
  one exception is **syntax-error text**. The port reports `guard syntax error: …` exactly when CPython reports a
  `SyntaxError`, and the text follows CPython's tokenizer, string decoder (including byte positions) and f-string
  checks. CPython's second, error-reporting parser pass ("invalid syntax. Perhaps you forgot a comma?", "cannot
  assign to function call", …) is not ported, and when a text has several errors the port may report a different
  one first. In the committed golden, 2,825 of 3,161 syntax-error texts (89%) are identical. Consequence: for a
  package whose guard has a syntax error, `typecheck`'s text, and so the `GUARD_INVALID` finding message and
  `report_digest`, can differ from Python's. Codes and statuses are the same.
* **Identifiers**: Python's own XID_Start/XID_Continue tables (Unicode 15.0) are embedded, because browsers ship
  newer Unicode data (for example, U+200C became XID_Continue in 15.1). Names are NFKC-normalized after the keyword
  check on the raw spelling, so `Ｔｒｕｅ` is the name `True` and `ｅｍｐｔｙ(x)` is a predicate call. The golden
  checks the tables and the NFKC result of all 139,400 non-ASCII identifier code points by digest.
* **Limits** are counted exactly like `ast.walk` and `guards._depth`: `Expression`, the ctx of every
  Name/List/Tuple/Attribute/Subscript/Starred, one node per `BoolOp.op`, `UnaryOp.op`, `BinOp.op` and
  `Compare.ops` entry, and `arguments`, `arg`, `keyword` and `comprehension` nodes. Lengths are counted in code
  points.
* **Integral float literals** (`2.0`, `1e5`, `1e20`, `0e0`) are accepted like in Python. Their Constant node carries
  `py_type: "float"` so int and float stay distinguishable (`_const_type` gives `"number"`). Values compare exactly
  like Python's int/float comparisons for every value a JS number can hold.
* **Disjointness domains** are computed exactly: BigInt is used for `floor(c) ± 1` beyond 2^53. Python's set
  semantics for constants are kept, so `True` and `1` (or `False` and `0`) collide and the first one inserted
  wins, which can hide a numeric constant. The total is a BigInt, so the `MAX_CONFIGS` decision and the message
  are exact.
* **API shape, not semantics**: `parse` returns a deep-frozen, cached tree (Python returns the cached mutable
  tree). `vars_of` returns a `Set` iterated in sorted order (Python returns an unordered `set`). `Analysis` is a
  plain object whose `edges` is an array (Python uses a tuple). Python's `_bare` marks become an evaluation
  parameter and `_is_bare_condition(name, tree)`.

## Evidence

The committed golden holds 1,322 hand-written and 5,000 random parse cases. They record Python's result, its message
or exception class, and the tree, node count and depth whenever `ast.parse` succeeds; the port must reproduce all of
them. It also holds 1,006 accepted guards × 4 type environments × 8 value environments for typing and evaluation,
631 disjointness cases (94 of them put raw characters, most of them non-printable, into the guard text quoted by an analysis detail), and the Unicode
tables. During development, about 2.86 million further inputs agreed with CPython 3.12.3 on acceptance, message
class, tree, node count and depth. They were:
* three exhaustive sweeps of every string of 1 to 4 tokens over 28-symbol alphabets (637,420 each);
* 100,000 grammar and mutation inputs;
* 200,000 f-string inputs;
* 400,000 token sequences;
* 150,000 random programs over the whole expression grammar (`ast.unparse` of random trees);
* 100,000 escape-sequence literals.

The only inputs that differed were `\N{…}` escapes with unknown names (#2). `gen_guards.py --out DIR --scale N`
regenerates larger random sets in the same format. The parse, repr and Unicode-table checks also pass in the bundled page
(strict CSP) in Chromium 141.0.7390.37.
