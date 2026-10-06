# Porting rules (read before writing any module)

The Python package `hexis-service/src/hexis_service` is the specification. Read the **current** Python
source of your module completely, including docstrings and the recent review fixes, and read the Python
tests that exercise it (`hexis-service/tests/**`). Port behavior faithfully; do not redesign.

## Hard rules
1. Follow `browser/README.md` (IIFE + `HX.<namespace>`, filename prefixes, snake_case Python-mirroring API,
   synchronous engine, no DOM/network/storage/`Date.now`/`Math.random` in `src/` except as overridable
   defaults, cross-module references only inside function bodies).
2. Own only your assigned files. Other agents work in the same tree at the same time. Never edit another
   module's files, `README.md`, `DEVIATIONS.md`, `build.py`, `test/run.mjs` or `golden/_common.py`. Put
   deviation notes in `browser/deviations/<module>.md` (create it). Do not run `git` commands that change
   state (no add/commit/checkout/stash/reset); read-only `git log/diff/show` is fine.
3. Parity is proven, not claimed: write `browser/golden/gen_<module>.py` that imports the real Python code
   (via `from _common import write, ints, deterministic_uuids`), generates **broad** vectors, including
   adversarial and random/fuzzed ones (seeded `random.Random`), and writes `golden/<module>*.json`. Then
   write `browser/test/NN_<module>.test.js` asserting the JS port reproduces them. Run the generator with
   `hexis-service/.venv/bin/python` from `browser/golden/`, and the tests with `node test/run.mjs` from `browser/`.
   Golden files must stay reasonably small (< 2 MB each).
4. Errors: Python exceptions become `HX.HXError` subclasses with the same class name. Where Python code
   or tests branch on an error *code* (KernelError.code, RunError.code, finding codes), the JS code must be
   identical. Message text should follow Python's wording where practical but need not match exactly.
5. Data shapes: pydantic models are plain objects with **all** fields of `model_dump(mode="json",
   by_alias=True)` present (defaults included), so `HX.canonical.digest` matches Python byte for byte.
6. Any intentional deviation must be conservative (stricter, never more permissive), documented in
   `deviations/<module>.md` with the reason, and covered by a test.

## JavaScript pitfalls that break parity (handle them explicitly)
* **Numbers.** One number type: `1.0 === 1`. Python float fields with integral values (e.g.
  `JudgeAction.error_rate` default `0.0`) canonicalize differently, so document the hash consequence.
  Integers beyond ±(2^53−1) are not exact, so reject them where Python would accept, and document it.
  `Number.isInteger(true)` is false, but `typeof true !== "number"`, and Python's `bool` is an `int`
  subclass: replicate Python's bool/int distinctions exactly as the Python code does (`isinstance(v, bool)`
  checks).
* **Dict order.** Python dicts keep insertion order; JS objects do too, *except* that integer-like keys
  ("0", "17") are always iterated first in ascending order. Where Python iteration order affects output
  (finding order, BFS order, normalization), either use `Map`/ordered arrays internally or reject
  integer-like keys with a clear error (document the deviation).
* **Strings.** Python indexes and measures strings by code point; JS by UTF-16 unit. Spans, offsets and
  `len()` limits must use code points (`HX.util.codepoint_length`, `Array.from(s)`). Python `str.splitlines`
  splits on `\n \r \r\n \v \f \x1c \x1d \x1e \x85    `.
* **Regex.** Python `re.match` anchors at the start only; Python `$` (no MULTILINE) also matches just
  before a final `\n`; Python `\s`/`\w`/`\d` are Unicode-aware for str patterns. Emulate these.
* **Sorting.** Python `sorted()` on strings compares code points (`HX.util.cmp_codepoints`). Python sorts
  are stable. Mixed-type sorts raise TypeError in Python.
* **Sets.** Python `set` iteration order is arbitrary. Where Python output is a sorted list, sort the same
  way. Where it is unordered, compare as sets in tests.
* **Equality.** Python `==` treats `1 == 1.0 == True` as equal (but jsonschema and the guard evaluator
  separate bools). `HX.util.deep_equal` treats `true !== 1`. Use the semantics the Python code actually has.
* **Truthiness.** Python `bool([])`, `bool({})` and `bool("")` are false, while in JS `[]` and `{}` are truthy.

## Guard AST shape (contract between `20_guards` and its consumers such as `30_validate`)
`HX.guards.parse(expr)` returns `{type: "Expression", body}` with nodes mirroring Python `ast`:
```
{type:"BoolOp", op:"And"|"Or", values:[node...]}
{type:"UnaryOp", op:"Not", operand:node}
{type:"Compare", left:node, ops:["Eq"|"NotEq"|"Lt"|"LtE"|"Gt"|"GtE"|"In"|"NotIn"...], comparators:[node...]}
{type:"Call", func:{type:"Name", id}, args:[node...], keywords:[]}
{type:"List"|"Tuple", elts:[node...]}
{type:"Name", id}
{type:"Constant", value}          // string | number | boolean
```
Op names are Python's `ast` class names. Consumers test `node.type === "Compare"` and `node.ops[0] === "Lt"`, the way Python
uses `isinstance(node, ast.Compare)`.
