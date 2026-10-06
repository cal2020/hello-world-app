"""Golden vectors for HX.guards (port of hexis_service/guards.py).

Writes, by running the real Python reference (CPython 3.12 ast + hexis_service.guards):
  guards_parse.json      hand-written corpus: parse result, message, Python tree, node count, depth
  guards_fuzz.json       seeded random grammar expressions, character mutations and short random strings
  guards_semantics.json  typecheck / evaluate / evaluate3 of every accepted guard on several environments
  guards_disjoint.json   analyze_disjoint on hand-written and random guard sets
  guards_unicode.json    Unicode 15.0 tables (XID, whitespace, printable), NFKC of identifiers, repr samples

    python gen_guards.py                                   # committed golden files
    python gen_guards.py --out DIR --seed 7 --scale 20     # large local differential run (same format)

Parse records ("cases"): e (or e16), note, r ("ok" | "err" | "exc"), m (GuardError text), x (class of a non-GuardError
exception), vars (accepted), parsed (ast.parse succeeded), nodes and depth (ast.walk count and guards._depth), ast
(the tree in the JS port's shape as compact JSON text, when the port can represent its values), dev (Python accepts,
the port rejects by design), nesc (the text contains a \\N escape, whose name the port cannot check).

Encodings (JSON cannot carry these Python values):
  * an expression containing a lone surrogate is stored as "e16": [UTF-16 code units] instead of "e";
  * UNKNOWN in an environment is {"$unknown": true};
  * an integer outside +/-(2**53-1) is {"$int": "<decimal>"};
  * float constants in trees are their Python repr string ("2.0", "1e+20", "inf"); complex constants carry the repr
    of their imaginary part; bytes constants are lists of byte values.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import io
import itertools
import json
import random
import sys
import tokenize
import unicodedata
import warnings
from pathlib import Path

from _common import GOLDEN, _check, write

from hexis_service import guards as G

warnings.simplefilter("ignore")  # SyntaxWarnings (e.g. `1and x`, invalid escapes) are not errors by default
SAFE = 2**53 - 1


# --------------------------------------------------------------------------------------------- #
# Python AST -> JS port node shape
# --------------------------------------------------------------------------------------------- #
class NotComparable(Exception):
    """The port stands for this value with a placeholder (surrogate code points, \\N escapes)."""


def has_surrogate(s: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def js_const(v):
    if v is None:
        return {"type": "Constant", "value": None, "py_type": "NoneType"}
    if v is Ellipsis:
        return {"type": "Constant", "value": None, "py_type": "ellipsis"}
    if isinstance(v, bool):
        return {"type": "Constant", "value": v, "py_type": "bool"}
    if isinstance(v, int):
        return {"type": "Constant", "value": v if v <= SAFE else {"$int": str(v)}, "py_type": "int"}
    if isinstance(v, float):
        return {"type": "Constant", "value": repr(v), "py_type": "float"}
    if isinstance(v, complex):
        return {"type": "Constant", "value": repr(v.imag), "py_type": "complex"}
    if isinstance(v, bytes):
        return {"type": "Constant", "value": list(v), "py_type": "bytes"}
    if isinstance(v, str):
        if has_surrogate(v):
            raise NotComparable("surrogate code point")
        return {"type": "Constant", "value": v, "py_type": "str"}
    raise TypeError(type(v).__name__)


def js_ast(node):
    """The JS port's shape of a Python AST: the node's _fields, operators and contexts as class names, Load
    contexts implicit, annotations/type comments/string kinds dropped (always None or irrelevant here)."""
    if isinstance(node, ast.Constant):
        return js_const(node.value)
    out = {"type": type(node).__name__}
    for f in node._fields:
        v = getattr(node, f, None)
        if f == "ctx":
            if type(v).__name__ != "Load":
                out["ctx"] = type(v).__name__
        elif f == "op":
            out[f] = type(v).__name__
        elif f == "ops":
            out[f] = [type(o).__name__ for o in v]
        elif f in ("annotation", "type_comment", "kind"):
            continue
        else:
            out[f] = _conv(v)
    return out


def _conv(v):
    if isinstance(v, ast.AST):
        return js_ast(v)
    if isinstance(v, list):
        return [_conv(x) for x in v]
    if v is None or isinstance(v, (str, int)):
        return v
    raise TypeError(type(v).__name__)


def uses_N_escape(expr: str) -> bool:
    """True if a non-raw str literal of the expression contains a \\N{...} escape (JS deviation)."""
    src = expr.replace("\r\n", "\n").replace("\r", "\n")
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except Exception:  # noqa: BLE001
        return "\\N" in src
    for tk in toks:
        if tk.type != tokenize.STRING:
            continue
        s = tk.string
        prefix = s[:len(s) - len(s.lstrip("rRbBuUfF"))]
        if "r" in prefix.lower() or "b" in prefix.lower():
            continue
        body = s[len(prefix):]
        i = 0
        while i < len(body):
            if body[i] == "\\":
                if body[i + 1:i + 2] == "N":
                    return True
                i += 2
            else:
                i += 1
    return False


def deviation(tree, expr) -> bool:
    """True if the port rejects this guard although Python accepts it (deviations/guards.md #1-#3)."""
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant):
            v = n.value
            if isinstance(v, int) and not isinstance(v, bool) and v > SAFE:
                return True
            if isinstance(v, str) and has_surrogate(v):
                return True
    return uses_N_escape(expr)


def enc_expr(e: str) -> dict:
    """{"e": text}, or {"e16": [UTF-16 code units]} when the text has a lone surrogate (not UTF-8 encodable)."""
    if has_surrogate(e):
        b = e.encode("utf-16-le", "surrogatepass")
        return {"e16": [int.from_bytes(b[i:i + 2], "little") for i in range(0, len(b), 2)]}
    return {"e": e}


def parse_record(expr: str, note: str = "") -> dict:
    rec = enc_expr(expr)
    if note:
        rec["note"] = note
    tree = None
    try:
        G.parse(expr)
        rec["r"] = "ok"
        rec["vars"] = sorted(G.vars_of(expr))
    except G.GuardError as exc:
        rec["r"] = "err"
        rec["m"] = str(exc)
    except BaseException as exc:  # noqa: BLE001 - UnicodeEncodeError, MemoryError, ValueError escape from parse
        rec["r"] = "exc"
        rec["x"] = type(exc).__name__
    if expr.strip() and len(expr) <= G.MAX_LEN:
        try:
            tree = ast.parse(expr, mode="eval")
        except BaseException:  # noqa: BLE001
            tree = None
    if tree is not None:
        rec["parsed"] = True
        rec["nodes"] = len(list(ast.walk(tree)))
        rec["depth"] = G._depth(tree)
        if "\\N" not in expr:
            try:
                rec["ast"] = json.dumps(js_ast(tree), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            except NotComparable:
                pass
        if rec["r"] == "ok" and deviation(tree, expr):
            rec["dev"] = True
    if "\\N" in expr:
        rec["nesc"] = True
    return rec


# --------------------------------------------------------------------------------------------- #
# Hand-written corpus
# --------------------------------------------------------------------------------------------- #
def and_chain(terms):
    return " and ".join(terms)


CORPUS: list[tuple[str, str]] = []


def C(expr, note=""):
    CORPUS.append((expr, note))


def CS(exprs, note):
    for e in exprs:
        C(e, note)


# accepted constructs
CS(["x", "b", "True", "False", "1", "0", "2.5", "'s'", "x == 1", "x != 1", "x < 1", "x <= 1", "x > 1", "x >= 1",
    "s == 'a'", "s != \"b\"", "s in ['a', 'b']", "s not in ['a', 'b']", "n in (1, 2)", "n in (1,)", "n in [1,]",
    "n in []", "n in ()", "x in [1.5, 2]", "b == True", "b != False", "empty(s)", "nonempty(arr)", "empty(x,)",
    "empty((x))", "empty((x),)", "(empty)(x)", "((nonempty))(x)", "empty(empty)", "empty(__x)",
    "not b", "not not b", "not (x == 1)", "b and c", "b or c", "b and c or not b", "(b or c) and b",
    "b and (c and b)", "(b and c) and b", "b or c or b", "1 < n < 4", "0 <= x <= 5 < 100", "x == y == z",
    "x == 1 and s in ['a'] or empty(arr)", "(x == 1) == (y == 2)", "empty(x) == True", "1, 2", "1,", "()", "[]",
    "[1, 'a']", "x == (1)", "(x) == 1", "((x)) == ((1))", "x in [(1)]", "x in ((1, 2))", "s == 'a' 'b'",
    "s == u'a'", "s == U'a' r'b'", "s == R'\\d'", "s == r'\\''", "s == '''tri'''", 's == """tri"""',
    "s == '''a\nb'''", "s == 'a\\\nb'", "s == r'a\\\nb'", "s == '\\x41\\u00e9\\U0001F600'", "s == '\\777'",
    "s == '\\0'", "s == '\\d'", "s == '\\t\\n\\r\\a\\b\\f\\v'", "s == '\\''", "s == \"\\\"\"", "s == '#'",
    "s == 'é\U0001F600'", "s == ''", "n == 0x1F", "n == 0X1f", "n == 0o17", "n == 0b101", "n == 0b1_0",
    "n == 1_000", "n == 00", "n == 0_0", "x == 0e0", "x == 1e3", "x == 1E3", "x == 1.", "x == .5", "x == 1.e2",
    "x == 0_1.5", "x == 09.5", "x == 1e-400", "x == 1e20", "x == 2.0", "x == 0.10000000000000003",
    "x == 1.7976931348623157e308", "n == 9007199254740991", "x == 1and y", "x == 1or y", "x==1in[1]",
    "x==1not in[2]", "x == 0x1for y", "x == 1.and y", "x == 0b1or y", "n == 1if b else 2",
    "Ｔｒｕｅ", "ｅｍｐｔｙ(x)", "K == 1", "µ == 1", "ﬁx == 1",
    "é == 1", "é == 1", "π > 3", "日本 == 'x'", "_ == 1", "match == 1", "type == 1",
    "case and b", "print == 1", "rb == 1", "f == 1", "u in [1]", "br and b", "x # comment", "x == 1 # c",
    "# c\nx == 1", "x == 1\n", "x == 1\n\n", "\nx == 1", "x == 1\n#c", "x == 1\n  #c", "x == 1\n  #c\n",
    "x == 1\n\x0c", "\x0cx == 1", "  \x0cx == 1", "x == \\\n1", "\\\nx == 1", "(x\n== 1)", "(\nx == 1\n)",
    "[1,\n2] == x", "x == 1\r\n", "x == 1\r", "(x\r\n== 1)", "x\x0c== 1",
    "x ==\t1", "x == 1 ", "x == 1\t", "s == 'a' \\\n 'b'", "(s == 'a'\n 'b')", "x == 1 #", "x == 1 # it's \\",
    "s in ['a', # c\n 'b']", "empty(__proto__)", "nonempty(constructor) and toString", "hasOwnProperty == 1",
    "s == '\u3000'", "s == '\u200b' # \u2028", "s == '\x85\xa0\xad'", "s == 'a\U000E0001'",
    "s == '\\U0010FFFF'", "s == '\uFEFF'", "s == '\u061c\u2066'"], "accepted construct")

# rejections: syntax
CS(["", " ", "\t", "\n", "\x0c", " ", "　", " ", "\x1c\x85", "﻿", "x ==", "== 1", "x = 1",
    "x === 1", "x <> 1", "x == not y", "x not y", "x in not y", "not", "x and", "and x", "(x", "x)", "[x", "x]",
    "(x]", "x == 1 1", "x y", "x;", "x\n;", "x\ny", " x", "\tx", "\x0c  x", "\n x", "x\n ", "x\n\t", "x \\\n",
    "x \\", "x\\y", " \\\nx", "\\\n x", "x\n\\\n", "x\x00", "x\x0b", "x == 1", "x‌ == 1", "＿ == 1",
    "́ == 1", "x == 01", "x == 1_", "x == 1__0", "x == 0x", "x == 0x_", "x == 0b2", "x == 0o8", "x == 08",
    "x == 0_1", "x == 1x", "x == 1.else", "x == 1e", "x == 1e+", "x == 1e_5", "x == 0x1and y", "s == 'abc",
    "s == '''abc", "s == 'a\nb'", "s == '\\x4'", "s == '\\u12'", "s == '\\U00110000'", "s == ur'x'",
    "s == bu'x'", "s == 'a' b'b'", "s == b'é'", "x if y", "lambda", "x == lambda: 1", "await", "x.if",
    "x == $", "x == ?", "x == `", "x == !", "x := 1", "*x", "x, *y", "(yield", "{1:}", "x[", "f(x=)",
    "f(x for x in y, z)", "print x", "x == 1\nx == 2", "# only a comment", "x == 1 if", "1 < < 2",
    "x not in", "x is not", "x in [1,,2]", "x in [,]", "empty(,)", "x == ()(", "((x)", "x == 0x1j",
    "x == 1.real", "x == 1jx", "x == 1j_", "s == '\\N'", "s == '\\N{}'", "s == '\\N{x'"], "syntax error")

# rejections: allowlist and limits
CS(["x + 1", "x == 1 + 2", "-x", "x == -1", "+x", "~x", "x in [-1]", "x is None", "x is not y", "x == None",
    "x == ...", "x == b'a'", "x == rb'a'", "x == 1j", "x == 2.5J", "x == f'a'", "x == F'{x}'", "x == rf'a'",
    "x == 'a' f'b'", "x == 1e400", "foo(x)", "empty()", "empty(x, y)", "empty(x=1)", "empty(*x)", "empty(**x)",
    "empty('a')", "empty(1)", "empty([x])", "empty((x,))", "empty(x)(y)", "empty(x).y", "empty(x)[0]",
    "empty(x for x in y)", "x(1)", "True(x)", "'a'(x)", "x in [y]", "[x]", "x, y", "[1, [2]]", "x in [(1, 2)]",
    "x in [x == 1]", "empty == 1", "nonempty", "__x == 1", "__ == 1", "_＿_x == 1", "x.__class__",
    "x.y == 1", "x if y else z", "x == 1 if b else 2", "lambda: 1", "lambda x: x", "await x", "(yield)",
    "(yield x)", "{}", "{1}", "{1: 2}", "{**x}", "x[0]", "x[0:1]", "x[::2]", "[x for x in y]", "{x for x in y}",
    "{x: 1 for x in y}", "(x for x in y)", "(x := 1)", "[*x]", "(*x,)", "f(*x)", "x @ y", "x ** 2",
    "x // 2", "x % 2", "x << 1", "x & y", "x | y", "x ^ y", "-x ** 2", "x == 'a' * 3"], "allowlist rejection")

# the verifier's message cases and other constructs the port rejects while parsing in earlier versions
CS(["x == 1j", "x == b'a'", "x in [*y]", "empty(x for x in y)", "{1}", "-{x}", "x == 0j", "x == 1e400j",
    "x == 1e16j", "x == 1e15j", "x == 123456789012345678j", "x == 1_0j", "x == 0_1j", "x == .5j", "x == 1.j",
    "x == 1e-5j", "x == 2.5e-324j", "[1j]", "x in [b'a', x]", "x in [x, b'a']", "x in [1j, x]", "x in [f'a']",
    "x in [f'{x}']", "[x := 1]", "[(x := 1)]", "x in [(x := 1)]", "x in [lambda: 1]", "x in [await y]",
    "x in [(yield)]", "x in [x for x in y]", "x in [{1}]", "x in [{}]", "x in [...]", "x in [None]",
    "x in [1, None]", "x in [-1, 1]", "x in [b'']", "x == b''", "x == b'\\x00\\x7f\\x80\\xff\\t\\n\\r'",
    "x == b'\\''", "x == b'\"'", "x == b'\\'\"'", "x == b\"'\"", "x == b'\\\\'", "x == rb'\\x'", "x == br'\\x'",
    "x == Rb'a' rB'b'", "x == b'a' b'b'", "x == b'\\777'", "x == b'\\8'", "x == b'\\x4'", "x == b'\\\n'",
    "x == b'a' 'b'", "x == 'a' b'b'", "x == f'a' b'b'", "x == b'é'", "x == rb'é'", "s == 'a' + 1",
    "empty(*x for x in y)", "empty(x, *y)", "empty(x, **y)", "empty(**x, y=1)", "empty(x=1, *y)",
    "empty(a:=1)", "empty((a:=1))", "nonempty(x,)", "empty.x(y)", "empty[0](x)", "x.empty(y)",
    "empty(x)(y) == 1", "not -x", "not ~x", "not +x", "-(x == 1)", "x == -(1)", "x in [-(1)]",
    "x is y", "x is not None", "x in y is z", "x == y is z", "x < lambda: 1", "x == (lambda: 1)",
    "x == [i for i in y]", "x == {i: 1 for i in y}", "x == (i for i in y)", "x == {i for i in y}",
    "x == await y", "x == (yield)", "x == y[0]", "x == y.z", "x == y()", "x == y(z)", "x == {}", "x == {1}",
    "x == [1]", "x == ()", "x == (1, 2)", "x in {1, 2}", "x in {1: 2}", "b and await x", "b and (yield)",
    "b and lambda: 1", "b and (x := 1)", "b and x[0]", "b and [x]", "b and {x}", "b and f'x'", "b and b'x'",
    "b and 1j", "b and ...", "b and None", "b or -x", "not (x := 1)", "not lambda: 1", "not await x",
    "(not x) + 1", "[x] + [y]", "x in [1] + [2]"], "message order")

# limit boundaries
nodes63 = and_chain(["x == 1"] * 12)
nodes64 = and_chain(["x == 1"] * 11 + ["not b", "b"])
nodes65 = and_chain(["x == 1"] * 12 + ["b"])
C(nodes63, "63 nodes")
C(nodes64, "64 nodes")
C(nodes65, "65 nodes")
C(and_chain(["x + 1 == 1"] * 12), "BinOp chain over 64 nodes")
for k in (8, 9):
    C("not " * k + "x == 1", f"depth {k + 4}")
C("((((((b and c) and b) and c) and b) and c) and b)", "nested BoolOp depth")
C("(((((((((b and c) and b) and c) and b) and c) and b) and c) and b) and c)", "nested BoolOp deeper")
C("x in [" + ", ".join(str(i) for i in range(32)) + "]", "32 list items")
C("x in [" + ", ".join(str(i) for i in range(33)) + "]", "33 list items")
C("x in (" + ", ".join(str(i) for i in range(32)) + ")", "32 tuple items")
C("s == '" + "a" * 256 + "'", "256-character string")
C("s == '" + "a" * 257 + "'", "257-character string")
C("s == '" + "\U0001F600" * 256 + "'", "256 astral characters")
C("s == '" + "\U0001F600" * 257 + "'", "257 astral characters")
C("s == '" + "a" * 128 + "' '" + "b" * 129 + "'", "concatenation over 256")
pad = "x == 1 #"
C(pad + "a" * (512 - len(pad)), "512 characters")
C(pad + "a" * (513 - len(pad)), "513 characters")
C(pad + "\U0001F600" * (512 - len(pad)), "512 code points, astral")
C(pad + "\U0001F600" * (513 - len(pad)), "513 code points, astral")
for k in (199, 200, 201):
    C("(" * k + "x" + ")" * k, f"{k} nested parentheses")
C("[" + "(" * 199 + "1" + ")" * 199 + "]", "list + 199 parentheses = 200 levels")
C("[" + "(" * 200 + "1" + ")" * 200 + "]", "201 levels")
C("not(" * 100 + "x" + ")" * 100, "not( nesting")
# limits reached through constructs the allowlist rejects: the limit message comes first
C(and_chain(["x == 1"] * 11) + " and (lambda a, b, c, d, e, f, g, h: 1)", "lambda over 64 nodes")
C(and_chain(["x == 1"] * 12) + " and f'{x}'", "f-string over 64 nodes")
C(and_chain(["x == 1"] * 12) + " and x[0]", "subscript over 64 nodes")
C(and_chain(["x == 1"] * 12) + " and {1: 2}", "dict over 64 nodes")
C(and_chain(["x == 1"] * 12) + " and 9007199254740993", "big literal over 64 nodes")
C("f'{f'{f'{f'{x}'}'}'}' == s", "nested f-strings, depth 12")
C("f'{f'{f'{f'{f'{x}'}'}'}'}' == s", "nested f-strings deeper than 12")
C("x == [[[[[[[[[[[1]]]]]]]]]]]", "nested lists deeper than 12")
C("x == (lambda: (lambda: (lambda: (lambda: 1))))", "nested lambdas")
C("x in [" + ", ".join(["1j"] * 33) + "]", "33 complex items")
C("x in [" + ", ".join(["b'a'"] * 32) + "]", "32 bytes items")

# documented JS deviations (Python accepts, the port rejects)
for e in ["n == 9007199254740992", "n == 9007199254740993", "n > " + "9" * 400, "n == 0x20000000000000",
          "s == '\\N{BULLET}'", "s == '\\ud83d\\ude00'", "s == '\\udc00'", "s == '\\U0000d800'", "x == '\ud800'"]:
    C(e, "JS deviation")
# ... decided after Python's own checks, so a guard Python rejects keeps Python's message
CS(["[9007199254740993, x]", "x in [9007199254740993, y]", "9007199254740993 + 1", "n == 9007199254740993 or x.y",
    "n == 9007199254740993 and", "s == '\\N{BULLET}' + 1", "s == '\\ud800' and x.y", "[9007199254740993] * 2",
    "s == '\\N{bullet}' and f'x'", "s == '\\N{NO SUCH NAME}'", "s == '\\N{BULLET }'", "s in ['\\N{BULLET}', x]",
    "x in [0x20000000000000, -1]", "s == '\\udc00' 'a' and y", "n == 9007199254740993 or x == 1j"],
   "deviation after Python's checks")

# f-strings (PEP 701 tokenizer and AST)
CS(["f''", "f'a'", "F'a'", "rf'\\d'", "fr'\\d'", "Rf'x'", "fR'x'", "f\"x\"", "f'''x'''", 'f"""x"""', "f'{x}'",
    "f'{x!r}'", "f'{x!s}'", "f'{x!a}'", "f'{x!z}'", "f'{x! r}'", "f'{x!r }'", "f'{x!ｒ}'", "f'{x!rr}'",
    "f'{x!}'", "f'{x!r:}'", "f'{x=}'", "f'{x = }'", "f'{x=!r}'", "f'{x=:>10}'", "f'{x=!s:>10}'", "f'{x:>10}'",
    "f'{x:{y}}'", "f'{x:{y:{z}}}'", "f'{x:{y:{z:{w}}}}'", "f'{x:{y=}}'", "f'{x:{y=!r}}'", "f'{x:{y=:z}}'",
    "f'{{}}'", "f'{{x}}'", "f'a{{b'", "f'}}'", "f'}'", "f'{'", "f'{}'", "f'{x}}'", "f'{x'", "f'{x:}'",
    "f'{x:}}'", "f'{x:{{}}}'", "f'{{{x}}}'", "f'\\{x}'", "rf'\\{x}'", "f'\\N{BULLET}'", "f'\\N{BULLET}{x}'",
    "f'\\N{bullet}'", "f'\\N{NOPE}'", "f'\\N{x{y}'", "f'\\x41{x}'", "f'\\x4{x}'", "f'{x}' f'{y}'",
    "'a' f'{x}' 'b'", "f'{x}' '' 'a'", "'a' '' f'{x}'", "'' f'{x}'", "f'{x}' ''", "'a' f'' 'b'",
    "f'{x}' b'a'", "b'a' f'{x}'", "f'{f'{x}'}'", "f'{f\"{x}\"}'", "f'{\"a\"}'", "f'{'a'}'",
    "f'{x:{\"a\"}}'", "f'''{x\n}'''", "f'{x\n}'", "f'{x:\n}'", "f'''{x:\n}'''", "f'{x#}'",
    "f'''{x # c\n}'''", "f'''{x # c\n=}'''", "f'{lambda x: 1}'", "f'{(lambda x: 1)}'", "f'{x:=1}'",
    "f'{(x:=1)}'", "f'{x!=y}'", "f'{x!=y=}'", "f'{yield}'", "f'{yield x}'", "f'{*x}'", "f'{*x, y}'",
    "f'{x, y}'", "f'{x for x in y}'", "f'{[x for x in y]}'", "f'{x:{y}{z}}'", "f'{x:a{y}b}'", "f'{x}{y}'",
    "f'{x}a{y}'", "f'{f'{f'{x}'}'}'", "f'{'\\n'}'", "f'{\"\\\\N{BULLET}\"}'", "f'{r\"\\x\"=}'",
    "f'{\"#\"=}'", "f'''{x = # c\n}'''", "f'{x:\\x41}'", "rf'{x:\\x41}'", "f'{x:\\x4}'", "f'{x:\\N{BULLET}}'",
    "f'\\\n{x}'", "f'''a\nb{x}'''", "f'''{x}\n'''", "f'{x}\\\n'", "f'{ x }'", "f'{\nx\n}'", "f'{x\\\n}'",
    "f'{x}' f''", "f'' f''", "f'{x=}' 'a'", "'a' f'{x=}'", "f'a{x=}'", "f'{x=}{y=}'", "f'{x}' == s",
    "s == f'{x}'", "s in [f'a', 'b']", "empty(f'{x}')", "f'{x}'.y", "f'{x}'[0]", "f'{x}'(y)", "-f'a'",
    "not f'a'", "f'a' and b", "f'{x:{y:{z}}}' == s", "f'{x!r:>{y}}'", "f'{x=!r:>{y}}'", "f'{{'", "f'}}{{'",
    "f'{x:{{'", "f'{x:}}}'", "f'{x:{y}}}'", "f'{x!r=}'", "f'{x=!}'", "f'{=x}'", "f'{!r}'", "f'{:x}'",
    "f'{x:{}}'", "f'{x:{y!z}}'", "f'{x:{y: {z}}}'", "f'{\"a\" \"b\"}'", "f'{b\"a\"}'", "f'{1j}'",
    "f'{x[0]:>{w}.{p}f}'", "f'{x:%Y-%m-%d}'", "f'{x!r:^{w}}'", "f'{x}' f'{y}' f'{z}'", "u'a' f'{x}'",
    "f'{x}' u'a'", "f'{f'{f'{f'{f'{x}'}'}'}'}'", "f'{x:{y}' '}'", "f\"{x:{'a'}}\"", "f'{x:\\{y}}'",
    "f'\\{{x}}'", "f'{{\\}}'", "f'{x}\\'", "f'\\'{x}'", "rf'\\'{x}'", "f'{x!a}' == s", "f'{x!s:{y!r}}'",
    "f'{\"\\\\\"}'", "f'{x:{y:{z!r}}}'", "f'{x:{y:{z=}}}'", "f'{x,}'", "f'{x,=}'", "f'{(x,)=}'",
    "f'{x:\\u12}'", "f'{x:\\N}'", "f'{x:\\U00110000}'", "f'{x:\\N{NOPE}}'", "rf'{x:\\x4}'", "f'{x:{y:\\x4}}'",
    "f'{x:\\x4}' f'{'", "f'{x:\\x4}' and (", "f'{x:\\x41}' and b'é'",
    "f'{await x}'", "f'{x if y else z}'", "f'{x if y else z=}'", "f'{lambda: 1=}'", "f'{(lambda: 1)=}'",
    "f'{x:=}'", "f'{x:!r}'", "f'{x!r!s}'", "f'{x!r:{y}:z}'", "f'{# c\n}'", "f'''{# c\nx}'''"],
   "f-string")

# bytes and complex literals
CS(["b'a'", "B'a'", "rb'\\x'", "br'\\x'", "Rb'x'", "bR'x'", "b'\\x41'", "b'\\x4'", "b'\\777'", "b'\\8'",
    "b'é'", "b'a' b'b'", "b'a' 'b'", "b'\\n\\t\\r\\\\\\''", "b'\"'", "b\"'\"", "b'\\'\"'",
    "b'\\x00\\x7f\\x80\\xff'", "b''", "b''''''", "b'''a\nb'''", "b'\\\nx'", "b'\\N{BULLET}'", "b'\\u0041'",
    "rb''", "b'a' rb'b' Rb'c'", "1j", "1J", "0j", "2.5j", "1e400j", "1_0j", "0_1j", ".5j", "1.j", "1e3j",
    "1e16j", "1e15j", "123456789012345678j", "0x1j", "0o1j", "0b1j", "1jif x else y", "1jor x",
    "00j", "09j", "1e5_0j", "1_j", "1__0j"], "bytes and complex")

# lambda
CS(["lambda: 1", "lambda x: x", "lambda x, y: x", "lambda *a: 1", "lambda **k: 1", "lambda *, k: 1", "lambda *: 1",
    "lambda x=1: x", "lambda x=1, y: 1", "lambda x, /, y: 1", "lambda /: 1", "lambda x, /: 1", "lambda x,: 1",
    "lambda x, *, y=1, z: 1", "lambda *a, b=1, **c: 1", "lambda **k, a: 1", "lambda (x): 1", "lambda x: lambda y: x",
    "lambda: (yield)", "lambda x=lambda: 1: x", "(lambda: 1)()", "[lambda: 1]", "{lambda: 1}", "{lambda: 1: 2}",
    "lambda a, /, b=1, *c, d, e=2, **f: 0", "lambda *, **k: 1", "lambda *a, *b: 1", "lambda a, a: 1",
    "lambda print: 1", "lambda if: 1", "lambda *a=1: 0", "lambda **k=1: 0", "lambda a, **b, : 0",
    "lambda a, /, : 0", "lambda a, /, *, b: 0", "lambda a, *, /: 0", "lambda a, /, /: 0", "lambda a=1, /, b: 0",
    "lambda a=1, /, b=2: 0", "lambda a, b=1, /, c=2: 0", "lambda *,: 0", "lambda *a,: 0", "lambda **k,: 0",
    "lambda a b: 0", "lambda a,, : 0", "lambda x: x if x else y", "lambda: lambda: lambda: 1",
    "lambda x=(yield): x", "lambda x=y if z else w: x", "lambda ｘ: ｘ", "lambda match, case, type: 0",
    "lambda: *x", "lambda: x, y", "(lambda: x, y)", "lambda *a, b, c=1, d: 0", "lambda a=1, *b, c: 0",
    "lambda a, *b=1: 0", "lambda a: (yield from b)", "lambda: await x", "lambda: [x async for x in y]"],
   "lambda")

# comprehensions
CS(["[x for x in y]", "[x for x in y if z]", "[x for x in y if a if b]", "[x for x in y for z in w]",
    "[x async for x in y]", "(x for x in y)", "{x for x in y}", "{x: y for x in z}", "[x for x, in y]",
    "[x for x, y in z]", "[x for (x, y) in z]", "[x for [x, y] in z]", "[x for *x, y in z]", "[x for x.y in z]",
    "[x for x[0] in z]", "[x for x() in z]", "[x for 1 in z]", "[x for x in y if lambda: 1]",
    "[x for x in lambda: y]", "[x for x in y, z]", "[*x for x in y]", "{**x for x in y}", "[x for x in *y]",
    "[x for (x) in y]", "[x for ((x)) in y]", "[x for (x := 1) in y]", "[(x := 1) for y in z]",
    "[x for x in y if (z := 1)]", "[x for f(x).y in z]", "[x for \"s\".y in z]", "[x for None.x in z]",
    "[x for (a, b)[0] in z]", "[x for a, in b]", "[x for a, b, in c]", "[x for in y]", "[x for x y]",
    "[x for x in]", "[x for *x in y]", "[x for (*x,) in y]", "[x for [*x] in y]", "[x for (*x) in y]",
    "[x for **x in y]", "[x for * *x in y]", "[x for x, *y, z in w]", "[x for [a, [b, c]] in d]",
    "[x for (a.b, c[0]) in d]", "[x for (a.b(), c) in d]", "[x for a.b() in d]", "[x for [a for a in b][0] in c]",
    "[x for (x for x in y).a in z]", "[x for await x in y]", "[x for -x in y]", "[x for True in y]",
    "[x for x in y if a else b]", "[x if y else z for x in w]", "[x if y for z in w]", "[x, y for y in z]",
    "[x for x in (yield)]", "[x for x in await y]", "[x for x in y async for z in w]", "[x async]",
    "[x for x in y if await z]", "(x for x in y if z)", "(x for x in y)(z)", "{x: y for x, y in z}",
    "{x: y for x in z if w}", "{(x := 1) for y in z}", "{x := 1 for y in z}", "[x := 1 for y in z]",
    "(x := 1 for y in z)", "[x for x in y for]", "[for x in y]", "[x for x in y if]", "[x for x in not y]",
    "[x for x in y or z]", "[x for x in y if z or w]", "[x for x in y == z]", "[x for x in y if z == w]",
    "[x for x in y if not z]", "[x for x in y if lambda: z]", "[x for x.y.z in w]", "[x for x[0][1] in w]",
    "[x for x[0].y in w]", "[x for ([x]) in w]", "[x for ([x], y) in w]", "[x for ((x), (y)) in w]",
    "[x for x[*a] in w]", "[x for x[a:b] in w]", "[x for 'a' in w]", "[x for (1).x in w]",
    "[x for [1][0] in w]", "[x for {}.x in w]", "[x for x in y][0]", "[ｘ for ｘ in ｙ]"],
   "comprehension")

# subscripts and slices
CS(["x[0]", "x[1:2]", "x[:]", "x[::]", "x[1:2:3]", "x[::2]", "x[a, b]", "x[a:b, c]", "x[*a]", "x[*a, b]", "x[a,]",
    "x[]", "x[a:=1]", "x[(a:=1):2]", "x[a:=1:2]", "x[lambda: 1]", "x[lambda: 1:2]", "x[1:2:3:4]", "x[*]",
    "x[:,:]", "x[...]", "x[None]", "x[a][b]", "x[a](b)", "x[a].b", "x[1:]", "x[:2]", "x[::-1]", "x[a, *b, c]",
    "x[*a:b]", "x[a:*b]", "x[*a, *b]", "x[a if b else c]", "x[a if b else c:d]", "x[yield]", "x[(yield)]",
    "x[await y]", "x[x for x in y]", "x[(x for x in y)]", "x[[x for x in y]]", "x[:=1]", "x[a:b:]", "x[a::]",
    "x[::c]", "x[:b:c]", "x[a, b:c:d, *e]", "x[(a, b)]", "x[()]", "x[[]]", "x[{}]", "x['a']", "x[1j]",
    "x[b'a']", "x[f'{y}']", "x[not a]", "x[a and b]", "x[a < b]", "x[-a]", "x[a,,]", "x[,]"], "subscript")

# calls
CS(["f()", "f(x)", "f(x,)", "f(x, y)", "f(*x)", "f(**x)", "f(a=1)", "f(a=1, *b)", "f(**a, b=1)", "f(**a, *b)",
    "f(a=1, b)", "f(x for x in y)", "f(x for x in y, z)", "f(z, x for x in y)", "f((x for x in y), z)",
    "f(a:=1)", "f(a.b=1)", "f(1=2)", "f(*)", "f(,)", "f(x=)", "f(**)", "f(*a, b)", "f(*a, *b)", "f(**a, **b)",
    "f(a=1, b=2)", "f(a, b=1, *c, d=2, **e)", "f(a=1, **b, c=2)", "f(*a, **b, c)", "f(**a, b)",
    "f(x for x in y)(z)", "f(x)(y)", "f.g(x)", "f(lambda: 1)", "f(lambda x: x, y)", "f(x if y else z)",
    "f(*x if y else z)", "f(**x if y else z)", "f(a=lambda: 1)", "f(a=*b)", "f(a=**b)", "f(*a=1)", "f(a==1)",
    "f(a=1==2)", "f((a)=1)", "f(a, (b)=1)", "f(not x)", "f(-x)", "f(await x)", "f((yield))", "f(yield)",
    "f(a:=1, b)", "f(a, b:=1)", "f(*a:=1)", "f(x for x in y if z)", "f(x async for x in y)",
    "f(*(x for x in y))", "f(**{})", "f(**{}, **{})", "f(match=1)", "f(if=1)", "f(ｋ=1)", "f(a=1, a=2)",
    "f(a, *b, c=1, *d, e=2, **f)", "f(x,,)", "f(,x)", "f(x y)", "f(x)y", "empty(x)", "empty(x=1, y=2)",
    "nonempty(x, )", "empty( x )", "empty(\nx\n)", "empty(x # c\n)"], "call")

# dict and set displays
CS(["{}", "{1}", "{1, 2}", "{1: 2}", "{1: 2, 3: 4}", "{**x}", "{**x, 1: 2}", "{1: 2, **x}", "{*x}", "{*x, 1}",
    "{1: 2, 3}", "{1, 2: 3}", "{x := 1}", "{(x := 1): 2}", "{x: y for x in z}", "{x for x in y}",
    "{**x for x in y}", "{*x for x in y}", "{1: 2,}", "{1,}", "{,}", "{1:}", "{:1}", "{lambda: 1}",
    "{lambda: 1: 2}", "{1: lambda: 2}", "{a: b: c}", "{**a or b}", "x in {1}", "x == {}", "[{}]",
    "x in [{1: 2}]", "{**a, **b}", "{*a, *b}", "{**a, *b}", "{*a, **b}", "{**a: b}", "{a: *b}", "{a: **b}",
    "{a, *b, c}", "{a: b, **c, d: e}", "{a: b, c}", "{(a, b): c}", "{a: (b, c)}", "{a: b, c: d, }",
    "{x := 1, 2}", "{1, x := 2}", "{(x := 1)}", "{x: (y := 1)}", "{x: y := 1}", "{x if y else z: w}",
    "{x: y if z else w}", "{yield}", "{(yield)}", "{await x}", "{await x: y}", "{**await x}", "{*await x}",
    "{x for x in y if z}", "{x: y for x in z for w in v}", "{{}}", "{{1}}", "{{1: 2}: 3}", "{a: {b: c}}",
    "{1: 2 for x in y}", "{**x, }", "{*x, }", "{* x}", "{** x}"], "display")

# await, yield, starred, walrus, attribute, ellipsis, None
CS(["await x", "await", "await await x", "-await x", "await x ** 2", "x == await y", "await -x", "await (x)",
    "await x.y", "await x[0]", "await x()", "await f'x'", "(await x)", "not await x", "await x and y",
    "(yield)", "(yield x)", "(yield x, y)", "(yield *x, y)", "(yield from x)", "(yield from)", "yield x",
    "x == (yield)", "[(yield)]", "(yield x,)", "(yield *x)", "(yield *x,)", "(yield from x, y)",
    "(yield from *x)", "((yield))", "((yield), 1)", "(1, (yield))", "*x,", "(*x,)", "[*x]", "[*x, *y]", "(*x)",
    "x == *y", "x in (*y,)", "{*x}", "f'{*x}'", "*x, y", "x, *y,", "(x := 1)", "x := 1", "(x.y := 1)",
    "((x) := 1)", "[x := 1]", "[(x := 1)]", "f(x := 1)", "(x := y := 1)", "(x := (y := 1))", "x[y := 1]",
    "(x := 1, y := 2)", "(x := lambda: 1)", "(x := yield)", "(x := *y)", "(ｘ := 1)", "(x:=1)", "(x :=1)",
    "x.y", "x.y.z", "x.if", "x.match", "x .y", "1 .real", "1..real", "\"s\".upper", "x.__class__", "().x",
    "[].x", "{}.x", "x.ｙ", "x.y()", "x.(y)", "x..y", "x.1", "x. y", "x.\ny", "(x\n.y)", "None", "...",
    "Ellipsis", "x == ...", "... == x", "x in [..., 1]", "x is ...", "x is None", "x is not None",
    "not x is y", "x if y else z", "x if y else z if w else v", "(x if y else z) if w else v",
    "x if (y if z else w) else v", "lambda: x if y else z", "x if lambda: y else z", "x if y else lambda: z",
    "x if not y else z", "x if y or z else w", "x if y and z else w", "x if y == z else w", "x or y if z else w",
    "not x if y else z", "x if y else not z", "x < y if z else w", "-x if y else z", "x if -y else z",
    "x in y not in z", "x is y is not z", "x < y > z", "x == y != z <= w", "x not in y in z"],
   "await yield starred walrus attribute")

# deep nesting: CPython's parser stack (MAXSTACK 6000) overflows during its second, error-reporting pass on some
# invalid inputs; valid inputs never reach it within the 200-bracket tokenizer limit
for k in (150, 180, 190, 192, 193, 195, 198, 199, 200):
    C("[" * k + "x" + "]" * k + " x", f"{k} brackets then an error")
    C("(" * k + "x +" + ")" * k, f"{k} parentheses, error inside")
    C("(" * k + "x" + ")" * k + " +", f"{k} parentheses, error after")
for k in (193, 196, 200):
    C("{" * k + "1" + "}" * k + " x", f"{k} braces then an error")
    C("(" * k + "x" + ")" * k + " x", f"{k} parentheses then an error")
    C("f(" * min(k, 120) + "x" + ")" * min(k, 120) + " x", f"{min(k, 120)} calls then an error")
# maximal-depth inputs Python accepts (the port must accept the guards among them)
for e in ["(" * 200 + "x" + ")" * 200, "(" * 199 + "x == 1" + ")" * 199, "x == " + "(" * 200 + "1" + ")" * 200,
          "x in [" + "(" * 199 + "1" + ")" * 199 + "]", "empty(" + "(" * 199 + "x" + ")" * 199 + ")",
          "(" * 100 + "b and " + "(" * 99 + "c" + ")" * 99 + ")" * 100, "not " + "(" * 200 + "b" + ")" * 200,
          "(" * 100 + "not " + "(" * 100 + "b" + ")" * 100 + ")" * 100,
          "x == 1 and (" + "(" * 198 + "y < 2" + ")" * 198 + ")", "(" * 200 + "s" + ")" * 200 + " in ['a']",
          "[" * 200 + "x" + "]" * 200, "{" * 200 + "1" + "}" * 200, "f(" * 120 + "x" + ")" * 120,
          "x[" * 120 + "0" + "]" * 120, "(" * 199 + "x for x in y" + ")" * 199, "f'{" + "(" * 199 + "x" + ")" * 199 + "}'",
          "(" * 50 + "lambda: " * 30 + "x" + ")" * 50, "[" * 100 + "(" * 100 + "x" + ")" * 100 + "]" * 100,
          "(" * 66 + "x if y else " * 30 + "z" + ")" * 66, "-(" * 150 + "x" + ")" * 150,
          "(" * 150 + "x" + ")" * 150 + " == " + "(" * 50 + "1" + ")" * 50]:
    C(e, "maximal depth")

# repr of non-printable characters in messages
for ch in ["\u3000", "\u1680", "\u2028", "\u2029", "\u200b", "\ufeff", "\u061c", "\u2066", "\U000E0001", "\ue000",
           "\u0378", "\U0010FFFD", "\x85", "\xa0", "\xad", "\x7f", "\u00e9", "\U0001F600", "\u0300", "\uFFFF"]:
    C("x == y and s == '" + ch + "'", "repr probe")


# --------------------------------------------------------------------------------------------- #
# Random expressions
# --------------------------------------------------------------------------------------------- #
NAMES = ["x", "y", "n", "m", "s", "t", "b", "c", "arr", "tags", "obj", "status", "empty", "nonempty", "__x", "_",
         "match", "ｘ", "é", "ﬁx", "K", "µ", "π", "a1", "x_y", "print"]
NUMBERS = ["0", "1", "2", "3", "10", "2.5", "0.5", "1e3", "0x1F", "0o17", "0b101", "1_000", "00", "1.", ".5", "1e20",
           "1e400", "1j", "9007199254740991", "9007199254740993", "0e0", "007", "1_", "0x", "08", "0_1", "2.5J",
           "1e400j", "0j"]
STRINGS = ["'a'", '"b"', "''", "'pass'", "'repairable'", "r'\\d'", "u'x'", "b'x'", "f'x'", "'''t'''", "'a' 'b'",
           "'\\x41'", "'\\u00e9'", "'\\N{BULLET}'", "'\\ud800'", "'\\777'", "'\\d'", "'\\x4'", "'unterminated",
           "'" + "z" * 257 + "'", "f'{x}'", "f'{x!r}'", "f'{x=}'", "f'{x:>3}'", "f'{x:{y}}'", "rf'\\d{x}'",
           "f'{{}}'", "f'{x}' 'a'", "b'\\x41'", "rb'\\x'", "b''", "f''", "f'{x:{y=}}'", "f'{'a'}'", "'a' f'b'",
           "b'a' 'b'", "f'{x!z}'", "f'{'", "f'}'"]
CMP = ["==", "!=", "<", "<=", ">", ">=", "in", "not in", "is", "is not", "<>"]
BINOPS = ["+", "-", "*", "/", "//", "%", "**", "@", "<<", ">>", "&", "|", "^"]
WS = [" ", "  ", "\t", "\x0c", " \\\n", "\n", " # c\n", "\r\n"]


class Gen:
    def __init__(self, rng):
        self.r = rng

    def ws(self):
        r = self.r.random()
        return " " if r < 0.75 else "" if r < 0.85 else self.r.choice(WS)

    def pick(self, pool, common):
        return self.r.choice(pool[:common]) if self.r.random() < 0.8 else self.r.choice(pool)

    def atom(self, d):
        r = self.r.random()
        if r < 0.36:
            return self.pick(NAMES, 12)
        if r < 0.52:
            return self.pick(NUMBERS, 10)
        if r < 0.66:
            return self.pick(STRINGS, 6)
        if r < 0.71:
            return self.r.choice(["True", "False", "None", "..."])
        if r < 0.82:
            return self.lst(d)
        if r < 0.88:
            return "(" + self.expr(d + 1) + ")"
        return self.call(d)

    def lst(self, d):
        k = self.r.choice([0, 1, 2, 31, 32, 33]) if self.r.random() < 0.15 else self.r.randint(0, 4)
        elts = [self.r.choice(NUMBERS[:8] + STRINGS[:5] + ["True", "False"]) if self.r.random() < 0.85
                else self.atom(d + 1) for _ in range(k)]
        tail = "," if elts and self.r.random() < 0.2 else ""
        if self.r.random() < 0.5:
            return "[" + ", ".join(elts) + tail + "]"
        if len(elts) == 1 and not tail and self.r.random() < 0.7:
            tail = ","
        return "(" + ", ".join(elts) + tail + ")"

    def call(self, d):
        f = self.r.choice(["empty", "nonempty", "empty", "nonempty", "foo", "(empty)", "ｅｍｐｔｙ"])
        r = self.r.random()
        arg = (self.pick(NAMES, 12) if r < 0.65 else self.pick(NAMES, 12) + "," if r < 0.72 else "" if r < 0.77
               else "x, y" if r < 0.81 else "x=1" if r < 0.85 else self.r.choice(["*x", "**x", "x for x in y", "a:=1"])
               if r < 0.9 else self.atom(d + 1))
        return f + "(" + arg + ")"

    def comparison(self, d):
        out = self.atom(d)
        for _ in range(1 if self.r.random() < 0.8 else self.r.randint(2, 3)):
            op = self.r.choice(CMP[:8]) if self.r.random() > 0.12 else self.r.choice(CMP)
            out += self.ws() + op + self.ws() + self.atom(d)
        return out

    def term(self, d):
        r = self.r.random()
        if r < 0.06:
            return self.atom(d) + self.ws() + self.r.choice(BINOPS) + self.ws() + self.atom(d)
        if r < 0.09:
            return self.r.choice(["-", "+", "~"]) + self.atom(d)
        if r < 0.55:
            return self.comparison(d)
        if r < 0.7:
            return self.call(d)
        if r < 0.82:
            return self.pick(NAMES, 12)
        if r < 0.88:
            return self.r.choice(["True", "False"])
        return self.atom(d)

    def expr(self, d=0):
        if d > 4:
            return self.term(d)
        r = self.r.random()
        if r < 0.25:
            return self.r.choice([" and ", " or "]).join(self.expr(d + 1) for _ in range(self.r.randint(2, 4)))
        if r < 0.35:
            return "not " + self.expr(d + 1)
        if r < 0.45:
            return "(" + self.expr(d + 1) + ")"
        if r < 0.53:
            return self.forbidden(d)
        return self.term(d)

    def forbidden(self, d):
        a = self.atom(d + 1)
        forms = ["{a} if {t} else {t}", "lambda: {a}", "{a}.attr", "{a}[0]", "{a}[1:2]", "{{{a}}}", "{{{a}: 1}}",
                 "[{a} for x in y]", "({a} for x in y)", "(x := {a})", "await {a}", "(yield {a})", "[*{a}]",
                 "f(*{a})", "f(k={a})", "{a}(x)", "{a} is {a}", "{a} not {a}", "f'{{{a}}}'", "{a}, {a}", "{a},",
                 "{a} = 1", "x if y", "{a} and", "({a}", "{a}]", "lambda x, *y, z=1, **k: {a}", "lambda {a}: 1",
                 "[{a} for x, y in z if {t}]", "{{x: {a} for x in y}}", "{{{a} for x in y}}", "{a}[{a}:{a}:{a}]",
                 "{a}[*{a}]", "{a}[{a}, {a}]", "f({a}, *{a}, k={a}, **{a})", "f({a} for x in y)",
                 "f'{{{a}!r:>{{{a}}}}}'", "f'{{{a}=}}'", "f'{{{a}:{{{a}=}}}}'", "f'a{{{a}}}b' 'c'",
                 "b'x' {a}", "{a} b'x'", "{{**{a}}}", "{{*{a}}}", "({a}, *{a})", "(yield from {a})",
                 "[x for {a} in y]", "[x for x in {a} if {a}]", "-{a} ** -{a}", "{a}.y.z", "{a}()",
                 "not {a} in {a}", "{a} if not {a} else {a}", "({a} := 1)", "[{a} async for x in y]"]
        return self.r.choice(forms).format(a=a, t=self.term(d + 1))


ALPHABET = list("xyns_ab0129.eE+-*<>=!()[],:'\"#\\ \t\n\r\x0c\x0bjJ{}") + [
    "and", "or", "not", "in", "is", "if", "else", "None", "True", "empty", "é", " ", "‌", "́",
    "\U0001F600", "ｘ", "\x00", "\ud800", "r'", "b'", "f'", "rb'", "'''", "\\\n", "0x", "1e", "__", "lambda",
    "for", ":=", "**", "f'{", "}'", "!r", "=}", "await", "yield", "\u3000", "\u200b"]


def mutate(rng, s):
    s = list(s)
    for _ in range(rng.randint(1, 3)):
        op, pos = rng.random(), rng.randint(0, len(s))
        if op < 0.4:
            s[pos:pos] = list(rng.choice(ALPHABET))
        elif op < 0.7 and s:
            del s[min(pos, len(s) - 1)]
        elif op < 0.9 and s:
            s[min(pos, len(s) - 1)] = rng.choice(ALPHABET)
        elif s:
            a = rng.randint(0, len(s) - 1)
            s[pos:pos] = s[a:rng.randint(a, min(len(s), a + 6))]
    return "".join(s)


def lexical(rng):
    core = rng.choice(["x == 1", "s in ['a', 'b']", "empty(x)", "not b", "x < 2.5 and y", "(x\n== 1)", "[1,\n2]",
                       "s == 'a' 'b'", "n >= 0x1f", "b", "f'{x}'", "f'''{x\n}'''", "lambda: 1", "b'a'"])
    pre = "".join(rng.choice(["", " ", "\t", "\n", "\x0c", "# c\n", "\\\n", "\r\n", "\r", "  \n"])
                  for _ in range(rng.randint(0, 3)))
    post = "".join(rng.choice(["", " ", "\t", "\n", "\x0c", " # c", "\\\n", "\r\n", "\r", "\n  ", "\n#c", "\n\x0c",
                               "\n\\\n", ";"]) for _ in range(rng.randint(0, 3)))
    return pre + core + post


SHORT = list("xyfbrj01.e_+-*/%@&|^~<>=!(),[]{}:;'\"#\\ \n\t") + ["and", "or", "not", "in", "is", "if", "else",
                                                                    "lambda", "for", "None", "True", "await",
                                                                    "yield", "é", "\u3000", "f'", "b'", "'''"]


def short_string(rng):
    return "".join(rng.choice(SHORT) for _ in range(rng.randint(1, 6)))


def random_exprs(rng, n_grammar, n_mut, n_lex, n_short):
    g = Gen(rng)
    grammar = [g.expr() for _ in range(n_grammar)]
    muts = [mutate(rng, rng.choice(grammar)) for _ in range(n_mut)]
    lex = [lexical(rng) for _ in range(n_lex)]
    short = [short_string(rng) for _ in range(n_short)]
    return grammar + muts + lex + short


# --------------------------------------------------------------------------------------------- #
# Semantics: typecheck / evaluate / evaluate3
# --------------------------------------------------------------------------------------------- #
TYPE_ENVS = {
    "typed": {"x": "number", "y": "number", "n": "integer", "m": "integer", "s": "string", "t": "string",
              "b": "boolean", "c": "boolean", "arr": "array", "tags": "array", "obj": "object", "status": "string",
              "empty": "string", "_": "string", "match": "integer", "x́": "string", "fix": "string",
              "K": "integer", "μ": "number", "π": "number", "a1": "integer", "x_y": "number",
              "print": "boolean", "True": "boolean", "z": "boolean", "__x": "array", "__proto__": "array",
              "constructor": "string", "toString": "boolean", "hasOwnProperty": "integer"},
    "wrong": {"x": "string", "y": "boolean", "n": "boolean", "m": "number", "s": "integer", "t": "array",
              "b": "number", "c": "string", "arr": "object", "tags": "string", "obj": "array", "status": "boolean"},
    "partial": {"x": "number", "s": "string", "b": "boolean"},
    "odd": {"x": "null", "y": "?", "n": "list:numeric", "m": "list:empty", "s": "list:string", "t": "foo",
            "b": "?", "c": "boolean", "arr": "list:boolean", "tags": "array", "obj": "object", "status": ""},
}
UNK = {"$unknown": True}
VALUE_ENVS = {
    "typed": {"x": 0.5, "y": 2, "n": 1, "m": 3, "s": "a", "t": "b", "b": True, "c": False, "arr": ["a", 1, True],
              "tags": ["DOC-A"], "obj": {"k": 1}, "status": "pass", "z": True, "_": "a", "match": 1, "fix": "a",
              "K": 1, "μ": 1, "π": 3.14, "a1": 1, "x_y": 0.5, "print": False, "True": True,
              "é": 1, "empty": "", "__x": [1], "x́": "a", "__proto__": [1], "constructor": "",
              "toString": True, "hasOwnProperty": 1},
    "other": {"x": 2.5, "y": 0, "n": 0, "m": 1000, "s": "", "t": "repairable", "b": False, "c": True, "arr": [],
              "tags": [], "obj": {}, "status": "repairable", "z": False, "_": "", "match": 0},
    "wrong": {"x": "1", "y": True, "n": True, "m": "3", "s": 1, "t": ["b"], "b": 1, "c": 0, "arr": "abc",
              "tags": {"a": 1}, "obj": None, "status": None, "z": "true"},
    "missing": {"x": 1, "s": "a"},
    "some_unknown": {"x": UNK, "y": 2, "n": 1, "m": UNK, "s": "a", "t": UNK, "b": UNK, "c": False, "arr": UNK,
                     "tags": ["a"], "obj": {}, "status": "pass", "z": True},
    "all_unknown": {k: UNK for k in ["x", "y", "n", "m", "s", "t", "b", "c", "arr", "tags", "obj", "status", "z"]},
    "numbers": {"x": 9007199254740991, "y": 1e-300, "n": -5, "m": 0.1, "s": "\U0001F600", "t": "á",
                "b": True, "c": True, "arr": [0.1, 2.5, "x", None, [1]], "tags": ["\U0001F600"], "obj": {"": None}},
    "boolint": {"x": True, "y": False, "n": 1, "m": 0, "s": "1", "t": "True", "b": 0, "c": 1, "arr": [True, 1],
                "tags": [False, 0], "obj": {"a": True}, "status": "x"},
}


def dec_env(env):
    return {k: (G.UNKNOWN if v == UNK else v) for k, v in env.items()}


def run(fn, *args):
    try:
        r = fn(*args)
    except G.GuardError as exc:
        return {"error": str(exc)}
    return r


class K(str):
    """str whose hash we control: forces which kind set.pop() returns in typecheck's mixed-list branch."""
    prio: dict = {}

    def __hash__(self):
        return K.prio.get(str(self), 7)


def has_mixed_list(expr):
    tree = G.parse(expr)
    for n in ast.walk(tree):
        if isinstance(n, (ast.List, ast.Tuple)):
            kinds = {G._cat(G._const_type(e.value)) for e in n.elts}
            if len(kinds) > 1:
                return True
    return False


def typecheck_outcomes(expr, types):
    """All results Python's typecheck can produce. It is deterministic except for mixed-type list literals,
    where it pops an arbitrary kind from a set (hash order); enumerate every pop order."""
    if not has_mixed_list(expr):
        return [G.typecheck(expr, types)]
    real = G._cat
    outs = []
    kinds = ["numeric", "string", "boolean"]
    try:
        G._cat = lambda t: K(real(t))
        for perm in itertools.permutations(kinds):
            K.prio = {k: i + 1 for i, k in enumerate(perm)}
            r = G.typecheck(expr, types)
            if r not in outs:
                outs.append(r)
    finally:
        G._cat = real
    return outs


def semantics_record(expr):
    rec = {"e": expr}
    rec["tc"] = {name: typecheck_outcomes(expr, types) for name, types in TYPE_ENVS.items()}
    rec["ev"] = {name: run(G.evaluate, expr, dec_env(env)) for name, env in VALUE_ENVS.items()}
    rec["ev3"] = {name: run(G.evaluate3, expr, dec_env(env)) for name, env in VALUE_ENVS.items()}
    return rec


# --------------------------------------------------------------------------------------------- #
# Disjointness
# --------------------------------------------------------------------------------------------- #
def enc_value(v):
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int):
        return v if abs(v) <= SAFE else {"$int": str(v)}
    if isinstance(v, float):
        return v if not v.is_integer() else {"$float": repr(v)}
    if isinstance(v, list):
        return [enc_value(x) for x in v]
    if isinstance(v, dict):
        return {k: enc_value(x) for k, x in v.items()}
    raise TypeError(type(v))


def big_domain(guards, types):
    """True if Python's enumeration domain contains an integer that is not exactly a double."""
    consts = {}
    for g in guards:
        try:
            c, ok = G._constants_by_var(G.parse(g))
        except G.GuardError:
            return False
        if not ok:
            return False
        for k, v in c.items():
            consts.setdefault(k, set()).update(v)
    for n, cs in consts.items():
        if n in types:
            try:
                dom = G._domain(types[n], cs)
            except Exception:  # noqa: BLE001
                return False
            if any(isinstance(v, int) and not isinstance(v, bool) and not_double(v) for v in dom):
                return True
    return False


def not_double(v: int) -> bool:
    try:
        return float(v) != v
    except OverflowError:
        return True


def disjoint_record(guards, types, note=""):
    try:
        an = G.analyze_disjoint(list(guards), types)
    except BaseException as exc:  # noqa: BLE001 - a non-GuardError escaping from parse (deviations/guards.md)
        rec = {"guards": list(guards), "types": types, "x": type(exc).__name__}
        if note:
            rec["note"] = note
        return rec
    rec = {"guards": list(guards), "types": types, "status": an.status, "detail": an.detail,
           "edges": list(an.edges), "counterexample": enc_value(an.counterexample)}
    if note:
        rec["note"] = note
    if big_domain(guards, types):
        rec["big"] = True
    return rec


DISJOINT_HAND = [
    (["validation_status == 'pass'", "validation_status == 'repairable' and repair_count < 2"],
     {"validation_status": "string", "repair_count": "integer"}, "procurement validate state"),
    (["validation_status in ['pass', 'repairable'] and repair_count < 2", "validation_status == 'repairable'"],
     {"validation_status": "string", "repair_count": "integer"}, "A08 overlap"),
    (["validation_status == 'repairable' and repair_count < readback_count", "validation_status == 'pass'"],
     {"validation_status": "string", "repair_count": "integer", "readback_count": "integer"}, "A08 var-to-var"),
    (['"a" in tags', '"b" in tags'], {"tags": "array"}, "membership in array variable"),
    (['"DOC-A" in tags', '"DOC-B" not in tags'], {"tags": "array"}, "membership in array variable"),
    (["empty(tags)", "nonempty(tags)"], {"tags": "array"}, "empty/nonempty array"),
    (["empty(o)", "nonempty(o)"], {"o": "object"}, "empty/nonempty object"),
    (["empty(s)", "nonempty(s)", "s == 'a'"], {"s": "string"}, "empty/nonempty string overlap"),
    (["x > 1e20", "x > 5e19"], {"x": "number"}, "large constants"),
    (["n > 9007199254740993", "n > 9007199254740993"], {"n": "integer"}, "big int literal (JS rejects)"),
    (["n > 9007199254740993", "n < 9007199254740995"], {"n": "integer"}, "big int literal (JS rejects)"),
    (["x > 9007199254740993", "x < 9007199254740995"], {"x": "number"}, "big int literal (JS rejects)"),
    (["x > 1e300", "x > 1e299"], {"x": "number"}, "huge constants"),
    (["x > 0.1", "x < 0.10000000000000003"], {"x": "number"}, "adjacent floats"),
    (["x > 1e20", "x <= 1e20"], {"x": "number"}, "disjoint large"),
    (["n > 9007199254740993", "n <= 9007199254740993"], {"n": "integer"}, "big int literal (JS rejects)"),
    (["n > 2.5", "n < 3"], {"n": "integer"}, "integer between fractional bounds"),
    (["x > 0.1", "x < 0.1"], {"x": "number"}, "disjoint float"),
    (["n > 2.5", "n < 3.5"], {"n": "integer"}, "integer 3 overlaps"),
    (["8.5 < x < 10", "x < 8.9"], {"x": "number"}, "chained overlap"),
    (["1 < n < 10", "n == 2"], {"n": "integer"}, "chained overlap"),
    (["0 <= x <= 5 < 100", "x > 4.5"], {"x": "number"}, "chained overlap"),
    (["0 <= x < 5", "5 <= x < 10"], {"x": "number"}, "chained disjoint"),
    (["n > " + "9" * 400, "n < 3"], {"n": "integer"}, "huge literal (JS rejects)"),
    (["x > " + "9" * 400, "x > " + "9" * 400 + "0"], {"x": "number"}, "huge literal (JS rejects)"),
    (["x > 1.7976931348623157e308", "x > 1e308"], {"x": "number"}, "max double (JS: no double above)"),
    (["x >= 1.7976931348623157e308", "x > 1e308"], {"x": "number"}, "max double, equality region"),
    (["n > 9007199254740992.0", "n < 9007199254740994.0"], {"n": "integer"}, "adjacent doubles above 2**53"),
    (["x > 9007199254740992.0", "x < 9007199254740994.0"], {"x": "number"}, "adjacent doubles above 2**53"),
    (["n > 9007199254740991", "n < 9007199254740993.0"], {"n": "integer"}, "2**53 boundary"),
    (["x > 4503599627370495.5", "x < 4503599627370496"], {"x": "number"}, "no double strictly between"),
    (["x > 5e-324", "x < 1e-323"], {"x": "number"}, "subnormal neighbours"),
    (["x == 0.0", "x < 5e-324"], {"x": "number"}, "zero and subnormal"),
    (["x == 1", "x == True"], {"x": "integer"}, "bool/int set collision, int first"),
    (["x == True", "x == 1"], {"x": "integer"}, "bool/int set collision, bool first"),
    (["x == False or x == 0", "x > 0"], {"x": "integer"}, "False/0 collision"),
    (["not b and x == True", "x == 1 and b", "x >= 1 and b"], {"b": "boolean", "x": "number"},
     "True inserted first hides the constant 1 from the numeric domain"),
    (["x == 1 and b", "x >= 1 and b", "not b and x == True"], {"b": "boolean", "x": "number"},
     "1 inserted first keeps it"),
    (["not b and x in [False, 2.5]", "x < 0.5 and b", "x >= 0 and b"], {"b": "boolean", "x": "number"},
     "False hides 0 inside a list literal"),
    (["a == 1 and b2 == 1 and c2 == 1 and d == 1 and e == 1 and f == 1 and g == 1 and h == 1 and i == 1",
      "a != 1 and b2 != 1"], {k: "integer" for k in ["a", "b2", "c2", "d", "e", "f", "g", "h", "i"]},
     "19683 configurations, just under the bound"),
    (["b", "not b"], {"b": "boolean"}, "boolean partition"),
    (["b", "b and c"], {"b": "boolean", "c": "boolean"}, "boolean overlap"),
    (["b == True", "b == False"], {"b": "boolean"}, "boolean equality partition"),
    (["x == 1", "y == 2"], {"x": "integer"}, "undeclared variable"),
    (["x == 1", "x =="], {"x": "integer"}, "unparseable guard"),
    (["x == 1", ""], {"x": "integer"}, "empty guard"),
    (["x == 1"], {"x": "integer"}, "single guard"),
    ([], {}, "no guards"),
    (["x == 'a'", "x == 1"], {"x": "string"}, "evaluation error"),
    (["x", "not x"], {"x": "integer"}, "bare non-boolean name"),
    (["True", "True"], {}, "constant guards"),
    (["True", "False"], {}, "constant guards"),
    (["1", "True"], {}, "non-boolean constant"),
    (["a == 1 and b2 == 1 and c2 == 1 and d == 1 and h == 1", "e == 1 and f == 1 and g == 1 and i == 1 and j == 1"],
     {k: "integer" for k in ["a", "b2", "c2", "d", "e", "f", "g", "h", "i", "j"]}, "configuration bound exceeded"),
    (["a == 1 and b2 == 1 and c2 == 1 and d == 1", "e == 1 and f == 1 and g == 1 and h == 2 and i == 3"],
     {k: "integer" for k in ["a", "b2", "c2", "d", "e", "f", "g", "h", "i"]}, "configuration bound exactly"),
    (["a < 1 and b2 < 1 and c2 < 1", "a > 1 and b2 > 1 and c2 > 1"],
     {k: "integer" for k in ["a", "b2", "c2"]}, "three variables disjoint"),
    (["x in [1, 2, 3]", "x in [3, 4]"], {"x": "integer"}, "list overlap"),
    (["x in (1, 2)", "x not in (1, 2)"], {"x": "integer"}, "list partition"),
    (["s in ['a', 'b']", "s not in ['a', 'b']"], {"s": "string"}, "string list partition"),
    (["s == 'a'", "s == 'b'", "s == 'a'"], {"s": "string"}, "triple overlap first and last"),
    (["s == 'é'", "s == 'é'"], {"s": "string"}, "unnormalized strings"),
    (["s < 'b'", "s == 'a'"], {"s": "string"}, "string ordering error"),
    (["x == 2.0", "x == 2"], {"x": "number"}, "float/int same value"),
    (["n == 2.0", "n == 2"], {"n": "integer"}, "float/int same value, integer"),
    (["x > 2", "x < 2.0000000000000004"], {"x": "number"}, "next double above integer"),
    (["n > 2", "n < 2.0000000000000004"], {"n": "integer"}, "no integer in region"),
    (["x == 1 and y", "x == 1 and not y"], {"x": "integer", "y": "boolean"}, "two variables"),
    (["x > 0 and s == 'a'", "x < 5 and s == 'a'"], {"x": "number", "s": "string"}, "two variables overlap"),
    (["empty(s) or s == 'x'", "nonempty(s) and s != 'x'"], {"s": "string"}, "string predicates"),
    (["x == 1", "x == 1"], {"x": "null"}, "unknown type name -> numeric domain"),
    (["x == 1", "x == 2"], {"x": "array"}, "equality on array evaluation error"),
    (["x in [1]", "x in [2]"], {"x": "boolean"}, "in on boolean evaluation error"),
    (["é > 1", "é < 3"], {"é": "integer"}, "unicode variable"),
    (["K > 1", "K < 3"], {"K": "integer"}, "NFKC-normalized variable"),
    (["empty(empty)", "nonempty(empty)"], {"empty": "string"}, "predicate name as argument"),
    (["x == 1", "x == 1"], {"x": "integer"}, "identical guards"),
    (["empty(__proto__)", "nonempty(__proto__)"], {"__proto__": "array"}, "__proto__ as a variable name"),
    (["empty(__proto__)", "empty(__proto__) or nonempty(__proto__)"], {"__proto__": "string"},
     "__proto__ in a counterexample"),
    (["constructor == 'a'", "constructor != 'b'"], {"constructor": "string"}, "constructor as a variable name"),
    (["x == 1j", "x == 1"], {"x": "number"}, "complex literal message"),
    (["x == b'a'", "x == 1"], {"x": "string"}, "bytes literal message"),
    (["x in [*y]", "x == 1"], {"x": "integer"}, "starred list message"),
    (["empty(x for x in y)", "x == 1"], {"x": "integer"}, "generator argument message"),
    (["{1}", "x == 1"], {"x": "integer"}, "set display message"),
    (["-{x}", "x == 1"], {"x": "integer"}, "unary minus before a display"),
    (["x == f'{y}'", "x == 1"], {"x": "string"}, "f-string message"),
    (["x == 1", "f'{x:{y=}}' == s"], {"x": "integer", "s": "string"}, "f-string ValueError (JS GuardError)"),
]

# repr in details: a guard text with non-printable characters in a string literal, a comment, or an array membership
REPR_CHARS = ["\u3000", "\u1680", "\u2028", "\u2029", "\u200b", "\ufeff", "\u061c", "\u2066", "\U000E0001", "\ue000",
              "\u0378", "\U0010FFFD", "\x85", "\xa0", "\xad", "\x7f", "\x01", "\u00e9", "\U0001F600", "\u0300",
              "\uFFFF", "\U000F0000", "\u180e", "\u2000", "\u202f", "\u205f", "\U0001D173", "\u00a7", "'", '"', "\\"]
for ch in REPR_CHARS:
    # the raw character inside the guard text (a literal quote or backslash is written the way Python needs it)
    lit = {"'": "\"'\"", "\\": "'\\\\'"}.get(ch, "'" + ch + "'")
    DISJOINT_HAND.append((["x == y and s == " + lit, "x == 1"], {"x": "integer", "y": "integer", "s": "string"},
                          "repr: string literal"))
    DISJOINT_HAND.append((["x == y # " + ch, "x == 1"], {"x": "integer", "y": "integer"}, "repr: comment"))
    DISJOINT_HAND.append(([lit + " in tags", "x == 1"], {"x": "integer", "tags": "array"}, "repr: membership"))
DISJOINT_HAND.append((["x == y and s == '\\' \"'", "x == 1"], {"x": "integer", "y": "integer", "s": "string"},
                      "repr: both quotes"))


def random_disjoint(rng, n):
    """Random guard pairs/triples over typed variables with constants drawn from interesting pools."""
    vars_t = {"n": "integer", "m": "integer", "x": "number", "y": "number", "s": "string", "t": "string",
              "b": "boolean", "c": "boolean", "tags": "array", "o": "object"}
    num_c = ["0", "1", "2", "3", "5", "10", "2.5", "0.5", "0.1", "0.10000000000000003", "1e20", "5e19", "1e300",
             "4503599627370495.5", "4503599627370496", "9007199254740991", "9007199254740992.0", "9.007199254740994e15",
             "1.7976931348623157e308", "5e-324", "2.0", "1e-3", "100", "007.5"]
    str_c = ["'a'", "'b'", "'pass'", "'repairable'", "''", "'\\x00other'", "'é'"]

    def atom_guard():
        v = rng.choice(list(vars_t))
        t = vars_t[v]
        if rng.random() < 0.08:  # occasionally a type error or wrong-type constant
            t = rng.choice(["integer", "string", "boolean"])
        r = rng.random()
        if t in ("integer", "number"):
            if r < 0.15:
                return f"{rng.choice(num_c)} {rng.choice(['<', '<='])} {v} {rng.choice(['<', '<='])} {rng.choice(num_c)}"
            if r < 0.3:
                return f"{v} in [{', '.join(rng.sample(num_c, rng.randint(1, 3)))}]"
            return f"{v} {rng.choice(['==', '!=', '<', '<=', '>', '>='])} {rng.choice(num_c)}"
        if t == "string":
            if r < 0.3:
                return f"{v} {rng.choice(['in', 'not in'])} [{', '.join(rng.sample(str_c, rng.randint(1, 3)))}]"
            if r < 0.45:
                return f"{rng.choice(['empty', 'nonempty'])}({v})"
            return f"{v} {rng.choice(['==', '!='])} {rng.choice(str_c)}"
        if t == "boolean":
            return rng.choice([v, f"not {v}", f"{v} == True", f"{v} == False", f"{v} != True"])
        if t == "array":
            return rng.choice([f"empty({v})", f"nonempty({v})", f"'a' in {v}"])
        return rng.choice([f"empty({v})", f"nonempty({v})"])

    def guard():
        k = rng.choice([1, 1, 1, 2, 2, 3])
        g = atom_guard()
        for _ in range(k - 1):
            g = g + rng.choice([" and ", " or "]) + (("not " if rng.random() < 0.2 else "") + atom_guard())
        return g

    def partition():
        """Guards meant to be mutually exclusive, with an occasional boundary slip that makes them overlap."""
        v = rng.choice(list(vars_t))
        t = vars_t[v]
        slip = rng.random() < 0.3
        if t in ("integer", "number"):
            cs = sorted(set(rng.sample(num_c, rng.randint(1, 3))), key=lambda c: (float(c), c))  # no set-order ties
            gs = [f"{v} < {cs[0]}"]
            for a, b in zip(cs, cs[1:]):
                gs.append(f"{a} <= {v} < {b}")
            gs.append(f"{v} >= {cs[-1]}")
            if slip:
                k = rng.randrange(len(gs))
                gs[k] = gs[k].replace("<", "<=", 1) if "<" in gs[k] and "<=" not in gs[k] else gs[k].replace(">=", ">")
        elif t == "string":
            vals = rng.sample(str_c, rng.randint(2, 4))
            gs = [f"{v} == {c}" for c in vals[:-1]] + [f"{v} not in [{', '.join(vals[:-1])}]"]
            if slip:
                gs[-1] = f"{v} not in [{', '.join(vals[:-2] or vals[:1])}]"
        elif t == "boolean":
            gs = [v, f"not {v}"] if not slip else [v, f"{v} or c"]
        else:
            gs = [f"empty({v})", f"nonempty({v})"] if not slip else [f"empty({v})", f"empty({v}) or b"]
        if rng.random() < 0.4:  # shared or differing side conditions
            side = [atom_guard() for _ in gs] if rng.random() < 0.5 else [atom_guard()] * len(gs)
            gs = [f"{g} and {s}" if rng.random() < 0.8 else f"({g}) and not ({s})" for g, s in zip(gs, side)]
        rng.shuffle(gs)
        return gs[:rng.choice([2, 3, len(gs)])]

    out = []
    for _ in range(n):
        if rng.random() < 0.5:
            gs = partition()
        else:
            gs = [guard() for _ in range(rng.choice([2, 2, 3]))]
        if rng.random() < 0.06:
            gs.append(rng.choice(["x =", "y + 1 == 2", "zz == 1", "x == 1j", "x in [*y]", "f'{x}'", "x == b'a'",
                                  "lambda: 1", "x[0] == 1", "{1}"]))
        used = set()
        for g in gs:
            try:
                used |= G.vars_of(g)
            except G.GuardError:
                pass
        types = {k: vars_t[k] for k in sorted(used) if k in vars_t and rng.random() > 0.02}
        out.append((gs, types))
    return out


# --------------------------------------------------------------------------------------------- #
# Unicode facts
# --------------------------------------------------------------------------------------------- #
def ranges(pred, include_surrogates=False):
    out, start = [], None
    for cp in range(0x110000):
        ok = (include_surrogates or not (0xD800 <= cp <= 0xDFFF)) and pred(chr(cp))
        if ok and start is None:
            start = cp
        elif not ok and start is not None:
            out += [start, cp - 1]
            start = None
    if start is not None:
        out += [start, 0x10FFFF]
    return out


def repr_samples(rng):
    """repr() of strings built from code points around every printable/non-printable boundary, plus quotes."""
    np = ranges(lambda c: not c.isprintable(), include_surrogates=True)
    cps = set()
    for a, b in zip(np[::2], np[1::2]):
        for cp in (a - 1, a, b, b + 1):
            if 0 <= cp <= 0x10FFFF:
                cps.add(cp)
    cps = sorted(cps)
    out = []
    for k in range(0, len(cps), 7):
        chunk = cps[k:k + 7]
        s = "".join(chr(c) for c in chunk) + rng.choice(["", "'", '"', "'\"", "\\", "a"])
        out.append({**enc_expr(s), "repr": repr(s)})
    return out


def unicode_facts(rng):
    xs = ranges(lambda c: c != "_" and c.isidentifier())
    xc = ranges(lambda c: ("a" + c).isidentifier())
    space = [cp for cp in range(0x110000) if not (0xD800 <= cp <= 0xDFFF) and chr(cp).isspace()]
    nonprint = ranges(lambda c: not c.isprintable(), include_surrogates=True)
    # NFKC of every non-ASCII identifier character, as CPython's parser normalizes it
    h = hashlib.sha256()
    changed = 0
    for a, b in zip(xc[::2], xc[1::2]):
        for cp in range(max(a, 0x80), b + 1):
            c = chr(cp)
            s = c if c.isidentifier() else "x" + c
            norm = ast.parse(s, mode="eval").body.id
            changed += norm != s
            h.update(f"{cp:x}={norm}\n".encode("utf-8", "surrogatepass"))
    return {"unidata_version": unicodedata.unidata_version, "xid_start": xs, "xid_continue": xc, "space": space,
            "nonprintable": nonprint, "nfkc_sha256": h.hexdigest(), "nfkc_changed": changed,
            "repr": repr_samples(rng)}


# --------------------------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="write to this directory instead of golden/ (local fuzzing)")
    ap.add_argument("--seed", type=int, default=20261006)
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--no-unicode", action="store_true")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    S = args.scale

    def save(name, obj):
        if args.out is None:
            return write(name, obj)
        _check(obj)
        p = Path(args.out) / (name + ".json")
        p.write_text(json.dumps(obj, sort_keys=True, indent=None, ensure_ascii=False) + "\n", encoding="utf-8")
        return p

    # ---- parse ---------------------------------------------------------------------------- #
    corpus = [parse_record(e, n) for e, n in CORPUS] if S == 1 else []
    fuzz = [parse_record(e) for e in random_exprs(rng, 1800 * S, 1400 * S, 300 * S, 1500 * S)]

    # ---- semantics (accepted, non-deviation guards; corpus first, then random) ------------- #
    accepted = []
    seen = set()
    for r in corpus + fuzz:
        if r["r"] == "ok" and not r.get("dev") and r["e"] not in seen:
            seen.add(r["e"])
            accepted.append(r["e"])
    sem = [semantics_record(e) for e in accepted]

    # ---- disjointness ------------------------------------------------------------------------ #
    dis = [disjoint_record(g, t, n) for g, t, n in DISJOINT_HAND] if S == 1 else []
    dis += [disjoint_record(g, t) for g, t in random_disjoint(rng, 450 * S)]

    paths = []
    if corpus:
        paths.append(save("guards_parse", {"python": sys.version.split()[0], "cases": corpus}))
    paths.append(save("guards_fuzz", {"python": sys.version.split()[0], "cases": fuzz}))
    paths.append(save("guards_semantics", {"type_envs": TYPE_ENVS, "value_envs": VALUE_ENVS, "cases": sem}))
    paths.append(save("guards_disjoint", {"cases": dis}))
    allp = corpus + fuzz
    msg = (f"guards: {len(corpus)} corpus + {len(fuzz)} fuzz parse cases "
           f"({sum(r['r'] == 'ok' for r in allp)} accepted, {sum(r['r'] == 'exc' for r in allp)} non-GuardError, "
           f"{sum(bool(r.get('dev')) for r in allp)} JS deviations), {len(sem)} semantic cases, "
           f"{len(dis)} disjointness cases ({sum(1 for d in dis if d.get('status') == 'COUNTEREXAMPLE')} counterexamples, "
           f"{sum(1 for d in dis if d.get('status') == 'PROVEN')} proven)")
    if not args.no_unicode:
        p4 = save("guards_unicode", unicode_facts(rng))
        msg += f"; unicode facts -> {p4.name}"
    print(msg)
    for p in paths:
        print(f"  {p.name}: {p.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()
