# Wave 1 — `20_guards` (port of `src/hexis_service/guards.py`)

Files you own: `browser/src/20_guards.js`, `browser/golden/gen_guards.py`, `browser/golden/guards*.json`,
`browser/test/20_guards.test.js`, `browser/deviations/guards.md`.

## Scope
Port every public and module-level name of `guards.py` into `HX.guards`: `MAX_LEN`, `MAX_DEPTH`,
`MAX_NODES`, `MAX_LIST`, `MAX_STR`, `MAX_CONFIGS`, `PREDICATES`, `NUMERIC`, `GuardError`, `parse`,
`vars_of`, `typecheck`, `UNKNOWN`, `evaluate`, `evaluate3`, `Analysis` (as a plain object
`{status, detail, counterexample, edges}`), `analyze_disjoint`, and the helpers other modules may need
(for example the Python `_CMP` op names). Use the AST shape in `specs/PORTING.md`.

`parse` must accept **exactly** the strings Python accepts (`ast.parse(expr, mode="eval")` followed by the
allowlist and limits). Everything else raises `GuardError`. This means a real tokenizer and parser for the
subset of Python expression syntax that can reach the allowlist, plus correct *rejection* of the rest:
* identifiers (Unicode letters, NFKC-normalized like Python), keywords (`True`, `False`, `None`, `and`, `or`,
  `not`, `in`, `is`, `if`, `else`, `lambda`, ...), comments `# ...`, newlines inside brackets, backslash
  continuation, leading and trailing whitespace;
* string literals: `'..'`, `".."`, triple-quoted, prefixes `r`/`u`/`R`/`U` accepted; `b`/`f` (and
  combinations) are rejected because they yield non-str constants or JoinedStr; escapes as in Python; implicit
  concatenation `'a' 'b'`;
* numbers: decimal, `_` separators, hex/octal/binary, floats (`1.`, `.5`, exponents); imaginary `1j` is
  rejected (complex constant); integer literals outside ±(2^53−1) are rejected (documented deviation);
* every operator Python parses but the allowlist rejects (arithmetic, bitwise, `is`, `is not`, unary `-`/`+`/`~`,
  subscripts, attributes, calls other than `empty(x)`/`nonempty(x)` with exactly one Name argument and no
  keywords, starred, lambda, if-expressions, comprehensions, walrus, `await`, ...) must raise `GuardError`;
* precedence and associativity exactly as Python (`or` < `and` < `not` < comparisons; chained comparisons;
  parenthesized forms; tuples incl. bare top-level `a, b`, `()` and `(x,)`; lists with trailing commas;
  `empty(x,)`).
* Limits: length > 512 code points; AST node count > 64 and depth > 12 computed **as Python's `ast.walk` and
  `_depth` count them** (including `Expression`, `Load` ctx nodes on every `Name`/`List`/`Tuple`, and one
  node per operator in `BoolOp.op`, `UnaryOp.op` and every `Compare.ops` entry), list length > 32, string
  constant > 256 code points.

`typecheck`, `evaluate`, `evaluate3` and `analyze_disjoint` must reproduce Python's results, including the
review fixes:
* `in` over an array variable makes the analysis UNKNOWN;
* exact numeric probing near large constants;
* overflow handling;
* bool versus int distinctions;
* undefined variables are errors, never false;
* Kleene logic with `UNKNOWN`.

For analyze_disjoint, the `status` and the `edges` of a COUNTEREXAMPLE must match Python, and the JS
counterexample must truly make those guards true under JS `evaluate`.

## Golden vectors (gen_guards.py) — required breadth
* A hand-written corpus of at least 250 expressions. It must cover:
  - every accepted construct and every rejection reason above;
  - limit boundaries (63, 64 and 65 nodes; depth 12 and 13; 32 and 33 list items; 256 and 257 string
    lengths; 512 and 513 total length);
  - tricky lexing (comments, continuations, NFKC names, raw strings, escapes).
* A seeded random generator of at least 3000 expressions from a grammar mixing allowed and forbidden
  constructs, plus random character-level mutations of valid guards.
* For each expression, record: parse ok/error, `vars_of` (sorted), the Python node count and depth (via
  `ast.walk`/`guards._depth`), `typecheck` error count for a few type environments, and `evaluate` /
  `evaluate3` results (`true`/`false`/`null`/`"error"`) on several environments. The environments must
  include wrong types, booleans, missing variables and UNKNOWN placeholders.
* Disjointness: at least 400 guard pairs or triples with type environments (strings, integers, numbers incl.
  fractional constants, booleans, arrays with `in`, large constants), recording `status` and `edges`.
* Python's `UNKNOWN` sentinel cannot be serialized to JSON. Encode environments as JSON with a marker such as
  `{"$unknown": true}`, and decode it in the test.

## Done when
`node test/run.mjs guards` passes, the whole `node test/run.mjs` passes, and `deviations/guards.md` lists every
intentional difference.
