"""Golden vectors for HX.guards (port of hexis_service/guards.py).

Writes golden/guards_parse.json, guards_semantics.json, guards_disjoint.json and guards_unicode.json by running
the real Python reference (CPython 3.12 ast + hexis_service.guards).

    python gen_guards.py                              # committed golden files
    python gen_guards.py --out DIR --seed 7 --scale 20  # large local differential run (same format)

Encodings (JSON cannot carry these Python values):
  * an expression containing a lone surrogate is stored as "e16": [UTF-16 code units] instead of "e";
  * UNKNOWN in an environment is {"$unknown": true};
  * an integer outside +/-(2**53-1) in a counterexample is {"$int": "<decimal>"};
  * float constants in ASTs are their Python repr string ("2.0", "1e+20", "inf").
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
BUILDABLE = {"Expression", "BoolOp", "UnaryOp", "BinOp", "Compare", "Call", "IfExp", "Attribute", "List", "Tuple",
             "Name", "Constant"}


class NotBuildable(Exception):
    pass


def has_surrogate(s: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def js_ast(node):
    """The JS port's node shape for a Python AST, or NotBuildable for constructs the port never builds
    (it rejects them while parsing: comprehensions, lambda, subscripts, f-strings, bytes, ...)."""
    t = type(node).__name__
    if t not in BUILDABLE:
        raise NotBuildable(t)
    if t == "Expression":
        return {"type": t, "body": js_ast(node.body)}
    if t == "BoolOp":
        return {"type": t, "op": type(node.op).__name__, "values": [js_ast(v) for v in node.values]}
    if t == "UnaryOp":
        return {"type": t, "op": type(node.op).__name__, "operand": js_ast(node.operand)}
    if t == "BinOp":
        return {"type": t, "left": js_ast(node.left), "op": type(node.op).__name__, "right": js_ast(node.right)}
    if t == "Compare":
        return {"type": t, "left": js_ast(node.left), "ops": [type(o).__name__ for o in node.ops],
                "comparators": [js_ast(c) for c in node.comparators]}
    if t == "Call":
        if node.keywords or any(type(a).__name__ == "Starred" for a in node.args):
            raise NotBuildable("Call with keywords/starred")
        return {"type": t, "func": js_ast(node.func), "args": [js_ast(a) for a in node.args], "keywords": []}
    if t == "IfExp":
        return {"type": t, "test": js_ast(node.test), "body": js_ast(node.body), "orelse": js_ast(node.orelse)}
    if t == "Attribute":
        return {"type": t, "value": js_ast(node.value), "attr": node.attr}
    if t in ("List", "Tuple"):
        return {"type": t, "elts": [js_ast(e) for e in node.elts]}
    if t == "Name":
        return {"type": t, "id": node.id}
    v = node.value
    if v is None:
        return {"type": "Constant", "value": None, "py_type": "NoneType"}
    if v is Ellipsis:
        return {"type": "Constant", "value": None, "py_type": "ellipsis"}
    if isinstance(v, bool):
        return {"type": "Constant", "value": v, "py_type": "bool"}
    if isinstance(v, int):
        if v > SAFE:
            raise NotBuildable("integer literal beyond 2**53-1 (JS deviation)")
        return {"type": "Constant", "value": v, "py_type": "int"}
    if isinstance(v, float):
        return {"type": "Constant", "value": repr(v), "py_type": "float"}
    if isinstance(v, str):
        if has_surrogate(v):
            raise NotBuildable("surrogate code point in str constant (JS deviation)")
        return {"type": "Constant", "value": v, "py_type": "str"}
    raise NotBuildable(type(v).__name__)


def uses_N_escape(expr: str) -> bool:
    """True if a non-raw string literal of the expression contains a \\N{...} escape (JS deviation)."""
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
        if "r" in prefix.lower():
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
    try:
        G.parse(expr)
        rec["r"] = "ok"
        rec["vars"] = sorted(G.vars_of(expr))
    except G.GuardError as exc:
        rec["r"] = "err"
        rec["m"] = str(exc)
    except BaseException as exc:  # noqa: BLE001 - e.g. UnicodeEncodeError for lone surrogates
        rec["r"] = "exc"
        rec["x"] = type(exc).__name__
    tree = None
    if expr.strip() and len(expr) <= G.MAX_LEN:
        try:
            tree = ast.parse(expr, mode="eval")
        except BaseException:  # noqa: BLE001
            tree = None
    rec["parsed"] = tree is not None
    if tree is not None:
        rec["nodes"] = len(list(ast.walk(tree)))
        rec["depth"] = G._depth(tree)
        try:
            rec["ast"] = js_ast(tree)
            rec["bld"] = not uses_N_escape(expr)
        except NotBuildable as nb:
            rec["bld"] = False
            rec["nb"] = str(nb)
    rec["dev"] = rec["r"] == "ok" and not rec.get("bld")  # Python accepts, the JS port rejects (documented)
    if not rec.get("bld"):
        rec.pop("ast", None)
    return rec


# --------------------------------------------------------------------------------------------- #
# Hand-written corpus
# --------------------------------------------------------------------------------------------- #
def and_chain(terms):
    return " and ".join(terms)


CORPUS: list[tuple[str, str]] = []


def C(expr, note=""):
    CORPUS.append((expr, note))


# accepted constructs
for e in ["x", "b", "True", "False", "1", "0", "2.5", "'s'", "x == 1", "x != 1", "x < 1", "x <= 1", "x > 1", "x >= 1",
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
          "Ｔｒｕｅ", "ｅｍｐｔｙ(x)", "K == 1", "µ == 1", "ﬁx == 1",
          "é == 1", "é == 1", "π > 3", "日本 == 'x'", "_ == 1", "match == 1", "type == 1",
          "case and b", "print == 1", "rb == 1", "f == 1", "u in [1]", "br and b", "x # comment", "x == 1 # c",
          "# c\nx == 1", "x == 1\n", "x == 1\n\n", "\nx == 1", "x == 1\n#c", "x == 1\n  #c", "x == 1\n  #c\n",
          "x == 1\n\x0c", "\x0cx == 1", "  \x0cx == 1", "x == \\\n1", "\\\nx == 1", "(x\n== 1)", "(\nx == 1\n)",
          "[1,\n2] == x", "x == 1\r\n", "x == 1\r", "x\r\n== 1" if False else "(x\r\n== 1)", "x\x0c== 1",
          "x ==\t1", "x == 1 ", "x == 1\t", "s == 'a' \\\n 'b'", "(s == 'a'\n 'b')", "x == 1 #", "x == 1 # it's \\",
          "s in ['a', # c\n 'b']", "empty(__proto__)", "nonempty(constructor) and toString", "hasOwnProperty == 1"]:
    C(e, "accepted construct")

# rejections: syntax
for e in ["", " ", "\t", "\n", "\x0c", " ", "　", " ", "\x1c\x85", "﻿", "x ==", "== 1", "x = 1",
          "x === 1", "x <> 1", "x == not y", "x not y", "x in not y", "not", "x and", "and x", "(x", "x)", "[x", "x]",
          "(x]", "x == 1 1", "x y", "x;", "x\n;", "x\ny", " x", "\tx", "\x0c  x", "\n x", "x\n ", "x\n\t", "x \\\n",
          "x \\", "x\\y", " \\\nx", "\\\n x", "x\n\\\n", "x\x00", "x\x0b", "x == 1", "x‌ == 1", "＿ == 1",
          "́ == 1", "x == 01", "x == 1_", "x == 1__0", "x == 0x", "x == 0x_", "x == 0b2", "x == 0o8", "x == 08",
          "x == 0_1", "x == 1x", "x == 1.else", "x == 1e", "x == 1e+", "x == 1e_5", "x == 0x1and y", "s == 'abc",
          "s == '''abc", "s == 'a\nb'", "s == '\\x4'", "s == '\\u12'", "s == '\\U00110000'", "s == ur'x'",
          "s == bu'x'", "s == 'a' b'b'", "s == b'é'", "x if y", "lambda", "x == lambda: 1", "await", "x.if",
          "x == $", "x == ?", "x == `", "x == !", "x := 1", "*x", "x, *y", "(yield", "{1:}", "x[", "f(x=)",
          "f(x for x in y, z)", "print x", "x == 1\nx == 2", "# only a comment", "x == 1 if", "1 < < 2",
          "x not in", "x is not", "x in [1,,2]", "x in [,]", "empty(,)", "()()" if False else "x == ()(", "((x)"]:
    C(e, "syntax error")

# rejections: allowlist and limits
for e in ["x + 1", "x == 1 + 2", "-x", "x == -1", "+x", "~x", "x in [-1]", "x is None", "x is not y", "x == None",
          "x == ...", "x == b'a'", "x == rb'a'", "x == 1j", "x == 2.5J", "x == f'a'", "x == F'{x}'", "x == rf'a'",
          "x == 'a' f'b'", "x == 1e400", "foo(x)", "empty()", "empty(x, y)", "empty(x=1)", "empty(*x)", "empty(**x)",
          "empty('a')", "empty(1)", "empty([x])", "empty((x,))", "empty(x)(y)", "empty(x).y", "empty(x)[0]",
          "empty(x for x in y)", "x(1)", "True(x)", "'a'(x)", "x in [y]", "[x]", "x, y", "[1, [2]]", "x in [(1, 2)]",
          "x in [x == 1]", "empty == 1", "nonempty", "__x == 1", "__ == 1", "_＿_x == 1", "x.__class__",
          "x.y == 1", "x if y else z", "x == 1 if b else 2", "lambda: 1", "lambda x: x", "await x", "(yield)",
          "(yield x)", "{}", "{1}", "{1: 2}", "{**x}", "x[0]", "x[0:1]", "x[::2]", "[x for x in y]", "{x for x in y}",
          "{x: 1 for x in y}", "(x for x in y)", "(x := 1)", "[*x]", "(*x,)", "f(*x)", "x @ y", "x ** 2",
          "x // 2", "x % 2", "x << 1", "x & y", "x | y", "x ^ y", "-x ** 2", "x == 'a' * 3"]:
    C(e, "allowlist rejection")

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

# documented JS deviations (Python accepts, the port rejects)
for e in ["n == 9007199254740992", "n == 9007199254740993", "n > " + "9" * 400, "n == 0x20000000000000",
          "s == '\\N{BULLET}'", "s == '\\ud83d\\ude00'", "s == '\\udc00'", "s == '\\U0000d800'", "x == '\ud800'"]:
    C(e, "JS deviation")


# --------------------------------------------------------------------------------------------- #
# Random expressions
# --------------------------------------------------------------------------------------------- #
NAMES = ["x", "y", "n", "m", "s", "t", "b", "c", "arr", "tags", "obj", "status", "empty", "nonempty", "__x", "_",
         "match", "ｘ", "é", "ﬁx", "K", "µ", "π", "a1", "x_y", "print"]
NUMBERS = ["0", "1", "2", "3", "10", "2.5", "0.5", "1e3", "0x1F", "0o17", "0b101", "1_000", "00", "1.", ".5", "1e20",
           "1e400", "1j", "9007199254740991", "9007199254740993", "0e0", "007", "1_", "0x", "08", "0_1"]
STRINGS = ["'a'", '"b"', "''", "'pass'", "'repairable'", "r'\\d'", "u'x'", "b'x'", "f'x'", "'''t'''", "'a' 'b'",
           "'\\x41'", "'\\u00e9'", "'\\N{BULLET}'", "'\\ud800'", "'\\777'", "'\\d'", "'\\x4'", "'unterminated",
           "'" + "z" * 257 + "'"]
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
        if r < 0.38:
            return self.pick(NAMES, 12)
        if r < 0.55:
            return self.pick(NUMBERS, 10)
        if r < 0.68:
            return self.pick(STRINGS, 6)
        if r < 0.73:
            return self.r.choice(["True", "False", "None", "..."])
        if r < 0.84:
            return self.lst(d)
        if r < 0.9:
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
        arg = (self.pick(NAMES, 12) if r < 0.7 else self.pick(NAMES, 12) + "," if r < 0.78 else "" if r < 0.84
               else "x, y" if r < 0.9 else "x=1" if r < 0.95 else self.atom(d + 1))
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
        if r < 0.51:
            return self.forbidden(d)
        return self.term(d)

    def forbidden(self, d):
        a = self.atom(d + 1)
        forms = ["{a} if {t} else {t}", "lambda: {a}", "{a}.attr", "{a}[0]", "{a}[1:2]", "{{{a}}}", "{{{a}: 1}}",
                 "[{a} for x in y]", "({a} for x in y)", "(x := {a})", "await {a}", "(yield {a})", "[*{a}]",
                 "f(*{a})", "f(k={a})", "{a}(x)", "{a} is {a}", "{a} not {a}", "f'{{{a}}}'", "{a}, {a}", "{a},",
                 "{a} = 1", "x if y", "{a} and", "({a}", "{a}]"]
        return self.r.choice(forms).format(a=a, t=self.term(d + 1))


ALPHABET = list("xyns_ab0129.eE+-*<>=!()[],:'\"#\\ \t\n\r\x0c\x0bjJ") + [
    "and", "or", "not", "in", "is", "if", "else", "None", "True", "empty", "é", " ", "‌", "́",
    "\U0001F600", "ｘ", "\x00", "\ud800", "r'", "b'", "f'", "'''", "\\\n", "0x", "1e", "__"]


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
                       "s == 'a' 'b'", "n >= 0x1f", "b"])
    pre = "".join(rng.choice(["", " ", "\t", "\n", "\x0c", "# c\n", "\\\n", "\r\n", "\r", "  \n"])
                  for _ in range(rng.randint(0, 3)))
    post = "".join(rng.choice(["", " ", "\t", "\n", "\x0c", " # c", "\\\n", "\r\n", "\r", "\n  ", "\n#c", "\n\x0c",
                               "\n\\\n", ";"]) for _ in range(rng.randint(0, 3)))
    return pre + core + post


def random_exprs(rng, n_grammar, n_mut, n_lex):
    g = Gen(rng)
    grammar = [g.expr() for _ in range(n_grammar)]
    muts = [mutate(rng, rng.choice(grammar)) for _ in range(n_mut)]
    lex = [lexical(rng) for _ in range(n_lex)]
    return grammar + muts + lex


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
    "numbers": {"x": 9007199254740991, "y": 1e-300, "n": -5, "m": 0.1, "s": "\U0001F600", "t": "á",
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
    an = G.analyze_disjoint(list(guards), types)
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
    (["s == 'é'", "s == 'é'"], {"s": "string"}, "unnormalized strings"),
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
    (["K > 1", "K < 3"], {"K": "integer"}, "NFKC-normalized variable"),
    (["empty(empty)", "nonempty(empty)"], {"empty": "string"}, "predicate name as argument"),
    (["x == 1", "x == 1"], {"x": "integer"}, "identical guards"),
    (["empty(__proto__)", "nonempty(__proto__)"], {"__proto__": "array"}, "__proto__ as a variable name"),
    (["empty(__proto__)", "empty(__proto__) or nonempty(__proto__)"], {"__proto__": "string"},
     "__proto__ in a counterexample"),
    (["constructor == 'a'", "constructor != 'b'"], {"constructor": "string"}, "constructor as a variable name"),
]


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
        if rng.random() < 0.04:
            gs.append(rng.choice(["x =", "y + 1 == 2", "zz == 1"]))
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
def ranges(pred):
    out, start = [], None
    for cp in range(0x110000):
        ok = not (0xD800 <= cp <= 0xDFFF) and pred(chr(cp))
        if ok and start is None:
            start = cp
        elif not ok and start is not None:
            out += [start, cp - 1]
            start = None
    if start is not None:
        out += [start, 0x10FFFF]
    return out


def unicode_facts():
    xs = ranges(lambda c: c != "_" and c.isidentifier())
    xc = ranges(lambda c: ("a" + c).isidentifier())
    space = [cp for cp in range(0x110000) if not (0xD800 <= cp <= 0xDFFF) and chr(cp).isspace()]
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
            "nfkc_sha256": h.hexdigest(), "nfkc_changed": changed}


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
    exprs = list(CORPUS) if S == 1 else []
    corpus_n = len(exprs)
    exprs += [(e, "") for e in random_exprs(rng, 1800 * S, 1400 * S, 300 * S)]
    parse_recs = [parse_record(e, n) for e, n in exprs]

    # ---- semantics (accepted, non-deviation guards; corpus first, then random) ------------- #
    accepted = []
    seen = set()
    for r in parse_recs:
        if r["r"] == "ok" and not r["dev"] and r["e"] not in seen:
            seen.add(r["e"])
            accepted.append(r["e"])
    sem = [semantics_record(e) for e in accepted]

    # ---- disjointness ------------------------------------------------------------------------ #
    dis = [disjoint_record(g, t, n) for g, t, n in DISJOINT_HAND]
    dis += [disjoint_record(g, t) for g, t in random_disjoint(rng, 450 * S)]

    p1 = save("guards_parse", {"python": sys.version.split()[0], "cases": parse_recs})
    p2 = save("guards_semantics", {"type_envs": TYPE_ENVS, "value_envs": VALUE_ENVS, "cases": sem})
    p3 = save("guards_disjoint", {"cases": dis})
    msg = (f"guards: {len(parse_recs)} parse cases ({corpus_n} hand-written, "
           f"{sum(r['r'] == 'ok' for r in parse_recs)} accepted, {sum(r['dev'] for r in parse_recs)} JS deviations), "
           f"{len(sem)} semantic cases, {len(dis)} disjointness cases "
           f"({sum(1 for d in dis if d['status'] == 'COUNTEREXAMPLE')} counterexamples, "
           f"{sum(1 for d in dis if d['status'] == 'PROVEN')} proven)")
    if not args.no_unicode:
        p4 = save("guards_unicode", unicode_facts())
        msg += f"; unicode facts -> {p4.name}"
    print(msg)
    for p in (p1, p2, p3):
        print(f"  {p.name}: {p.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()
