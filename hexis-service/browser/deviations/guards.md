# `20_guards` (`HX.guards`): deliberate deviations from `guards.py`

Reference: `src/hexis_service/guards.py` on CPython 3.12.3 (`unicodedata` 15.0.0). The port reproduces
`ast.parse(expr, mode="eval")` followed by the allowlist and limits, and then typing, evaluation and
disjointness analysis. Parity is proven by `golden/gen_guards.py` (the real Python code) and
`test/20_guards.test.js`. Every entry below is conservative: the port rejects, errors or reports `UNKNOWN`
where Python would accept, return a value or decide. It is never more permissive.

| # | Area | Python | JS port | Why | Test |
|---|---|---|---|---|---|
| 1 | Integer literals above 2^53−1 (`n > 9007199254740993`, `0x20000000000000`, a 400-digit literal) | accepted (arbitrary-precision int) | `GuardError` "integer literal … is outside the range supported by the JavaScript port" | a JS number cannot hold the exact value. Comparisons would silently round, so a guard could change meaning. Guard literals are never negative (unary minus is not allowed), so only the upper bound applies. | "documented deviations are exactly …", "analyze_disjoint: status, edges …" (`literal_dev`) |
| 2 | `\N{NAME}` escapes in non-raw string literals | resolved through the Unicode name database | `GuardError` "\N{...} escapes are not supported" | shipping the ~1 MB name database in the page is not worth it. Raw strings (`r'\N'`) are unaffected. | "documented deviations …" |
| 3 | String escapes that produce a surrogate code point (`'\ud800'`, `'😀'`, `'\U0000d800'`) | accepted: a str of lone surrogates (`'😀'` is 2 code points and differs from `'😀'`) | `GuardError` | JS strings cannot tell a surrogate pair from the astral character, so `== '😀'` would become true and the 256-character limit would count differently | "documented deviations …" |
| 4 | Guard text that contains a lone surrogate | `UnicodeEncodeError` escapes from `parse` (not a `GuardError`) | `GuardError` "guard text contains a lone surrogate" | same rejection, with the error class callers already handle. Engine data never contains lone surrogates (`strict_loads` rejects them). | "documented deviations …" (`r === "exc"` cases) |
| 5 | Disjointness analysis when an exact representative has no double in its region | Python evaluates exact ints such as `2**53 + 1` between the constants `9007199254740992.0` and `9007199254740994.0`, or above `1.7976931348623157e308` | when the enumeration reaches such a value it returns `UNKNOWN` ("… has no exact JavaScript number in its region (JavaScript port limitation)"). Up to that point the enumeration and its results are identical. | the guards would be evaluated on a value no JS number can stand for. `UNKNOWN` fails admission (`GUARDS_DISJOINTNESS_UNKNOWN`) just as `COUNTEREXAMPLE` does (`GUARDS_OVERLAP`). This is only reachable with constants at or above 2^53. | "deviation - an integer between adjacent doubles …", "analyze_disjoint: status, edges …" (`port_unknown`) |
| 6 | Counterexample values for exact integers beyond the double grid that do have room in their region | e.g. `{"x": 100000000000000000001}` for `x > 1e20` / `x > 5e19` | the nearest double strictly inside the same region, e.g. `100000000000000016384` | status, edges and the order of the enumeration are unchanged (the value lies strictly between the same constants), and the counterexample really satisfies the guards under JS `evaluate` | "analyze_disjoint: status, edges …" (`rep`), "deviation - …" |
| 7 | `typecheck` with a mixed-type list literal (`x in [1, 'a']`) | `set.pop()` returns an arbitrary kind (hash order, randomized per process). Later errors can depend on it, e.g. "'in' mixes string with a list of numeric". | always pops in the fixed order numeric, string, boolean (a stable order that CPython's own pop also exhibits for some hash seeds) | Python is nondeterministic here. The guard is already rejected by "mixed-type list literal", so only the extra messages vary. | "typecheck returns Python's exact error lists" (the golden enumerates every pop order) |
| 8 | Equality between values that are not JSON-like (`undefined`, BigInt, functions, class instances) in an environment | Python's `==` on objects of the same unknown category | `GuardError` "equality between values of unsupported type is not allowed" | Python environments come from JSON and never contain such values. Failing closed is safer than guessing a JS equality. | "GuardError, UNKNOWN, vars_of, Map inputs …" |
| 9 | Non-string, unhashable `expr` (e.g. a list) | `TypeError` from `lru_cache` | `GuardError` "empty guard …" (the same as for other non-strings) | consistent error class. Callers pass strings. | "GuardError, UNKNOWN …" |

## Not deviations (verified equal, listed because JS makes them easy to get wrong)

* **Lexing**: CPython's tokenizer is ported, not approximated. That covers indentation (`" x"` and `"x\n "` are
  errors, `"\fx"` and `"x\n\f"` are fine), blank and comment lines, backslash continuation (including at EOF), CRLF
  and lone CR translation, the 200-bracket nesting limit, and keyword-adjacent numbers (`x == 1and y`,
  `x==1in[1]` and `0x1for y` are valid with only a SyntaxWarning). It also covers number literal rules (`0_0`, `09.5`,
  `1_` and `01`) and the string prefix grammar (`ur''` and `bu''` are a name followed by a string, so they are
  syntax errors). The differential fuzz agreed on over 900,000 random, mutated, exhaustive-short and targeted
  inputs during development, and 3,881 of them are committed as golden vectors. `gen_guards.py --out DIR --scale N`
  regenerates larger sets in the same format for local runs.
* **Identifiers**: Python's own XID_Start/XID_Continue tables (Unicode 15.0) are embedded, because browsers ship
  newer Unicode data (for example, U+200C became XID_Continue in 15.1). Names are NFKC-normalized after the keyword
  check on the raw spelling, so `Ｔｒｕｅ` is the name `True` and `ｅｍｐｔｙ(x)` is a predicate call. The golden
  checks the tables and the NFKC result of all 139,400 non-ASCII identifier code points by digest. That runs in the
  Node suite, and during development it was also run in the bundled page in Chromium 141.
* **Limits** are counted exactly like `ast.walk` and `guards._depth`: `Expression`, the `Load` ctx of every
  Name/List/Tuple/Attribute, and one node per `BoolOp.op`, `UnaryOp.op`, `BinOp.op` and `Compare.ops` entry.
  Lengths are counted in code points.
* **Integral float literals** (`2.0`, `1e5`, `1e20`, `0e0`) are accepted like in Python. Their Constant node carries
  `py_type: "float"` so int and float stay distinguishable (`_const_type` gives `"number"`). Values compare exactly
  like Python's int/float comparisons for every value a JS number can hold.
* **Disjointness domains** are computed exactly: BigInt is used for `floor(c) ± 1` beyond 2^53. Python's set
  semantics for constants are kept, so `True` and `1` (or `False` and `0`) collide and the first one inserted
  wins, which can hide a numeric constant. The total is a BigInt, so the `MAX_CONFIGS` decision and the message
  are exact.
* **Messages**: allowlist, limit, typecheck, runtime and analysis messages are Python's exact strings (golden
  checks them whenever the port builds the full tree). Only CPython *syntax error* texts are approximations.
* **API shape, not semantics**: `parse` returns a deep-frozen, cached tree (Python returns the cached mutable
  tree). `vars_of` returns a `Set` iterated in sorted order (Python returns an unordered `set`). `Analysis` is a
  plain object whose `edges` is an array (Python uses a tuple). Python's `_bare` marks become an evaluation
  parameter and `_is_bare_condition(name, tree)`.
