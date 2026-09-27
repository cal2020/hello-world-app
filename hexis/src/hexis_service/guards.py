"""Guard language: allowlisted parsing, static typing, evaluation, disjointness.

Supported subset (a Python-expression syntax parsed with ``ast`` and then
interpreted by this module; nothing is ever passed to ``eval``):

* names of declared variables; string, integer, number and boolean literals
* ``and`` / ``or`` / ``not`` over booleans
* ``==`` ``!=`` between operands of the same type (boolean never equals integer)
* ``<`` ``<=`` ``>`` ``>=`` between numbers
* ``x in [lit, ...]`` / ``x not in [...]`` over a finite literal list
* ``is_empty(x)`` for string/array variables

Anything else (attribute access, subscripts, other calls, lambdas,
comprehensions, arithmetic, chained comparisons) is rejected at parse time.
At run time an undefined variable or a type mismatch raises ``GuardError``;
it is never treated as ``False``.
"""
from __future__ import annotations

import ast
import itertools
from dataclasses import dataclass
from typing import Any

MAX_GUARD_CHARS = 400
MAX_AST_DEPTH = 12
MAX_LIST_LITERAL = 64
MAX_LITERAL_CHARS = 200
MAX_ENUMERATION = 20_000

PROVEN, COUNTEREXAMPLE, UNKNOWN = "PROVEN", "COUNTEREXAMPLE", "UNKNOWN"
_FUNCS = {"is_empty"}
_CMP = {ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=",
        ast.In: "in", ast.NotIn: "not in"}


class GuardError(ValueError):
    pass


def _value_type(v: Any) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    if v is None:
        return "null"
    return type(v).__name__


# ---------------------------------------------------------------- parse ---
def _depth(node: ast.AST) -> int:
    return 1 + max((_depth(c) for c in ast.iter_child_nodes(node)), default=0)


def parse(expr: str) -> ast.expr:
    if not isinstance(expr, str) or not expr.strip():
        raise GuardError("empty guard")
    if len(expr) > MAX_GUARD_CHARS:
        raise GuardError(f"guard longer than {MAX_GUARD_CHARS} characters")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise GuardError(f"syntax error: {exc.msg}") from None
    if _depth(tree) > MAX_AST_DEPTH:
        raise GuardError(f"guard nesting deeper than {MAX_AST_DEPTH}")
    _check_node(tree.body)
    return tree.body


def _check_node(node: ast.AST) -> None:
    if isinstance(node, ast.BoolOp):
        for v in node.values:
            _check_node(v)
    elif isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, ast.Not):
            raise GuardError("only 'not' is allowed as a unary operator")
        _check_node(node.operand)
    elif isinstance(node, ast.Compare):
        if len(node.ops) != 1:
            raise GuardError("chained comparisons are not allowed")
        if type(node.ops[0]) not in _CMP:
            raise GuardError(f"operator {type(node.ops[0]).__name__} is not allowed")
        _check_node(node.left)
        right = node.comparators[0]
        if isinstance(node.ops[0], (ast.In, ast.NotIn)):
            if not isinstance(right, (ast.List, ast.Tuple)):
                raise GuardError("membership requires a literal list")
            if len(right.elts) > MAX_LIST_LITERAL:
                raise GuardError("membership list too long")
            for e in right.elts:
                if not isinstance(e, ast.Constant):
                    raise GuardError("membership list must contain literals only")
                _check_node(e)
        else:
            _check_node(right)
    elif isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
            raise GuardError("function calls are not allowed (only is_empty)")
        if len(node.args) != 1 or node.keywords or not isinstance(node.args[0], ast.Name):
            raise GuardError("is_empty takes exactly one variable name")
    elif isinstance(node, ast.Name):
        if node.id in _FUNCS or node.id.startswith("__"):
            raise GuardError(f"name {node.id!r} is not allowed")
    elif isinstance(node, ast.Constant):
        if node.value is None or not isinstance(node.value, (bool, int, float, str)):
            raise GuardError("only string, number and boolean literals are allowed")
        if isinstance(node.value, str) and len(node.value) > MAX_LITERAL_CHARS:
            raise GuardError("string literal too long")
        if isinstance(node.value, int) and not isinstance(node.value, bool) and abs(node.value) > 10**12:
            raise GuardError("integer literal too large")
    else:
        raise GuardError(f"{type(node).__name__} is not allowed in a guard")


def names(expr: str) -> set[str]:
    return {n.id for n in ast.walk(parse(expr)) if isinstance(n, ast.Name) and n.id not in _FUNCS}


# ------------------------------------------------------------ typecheck ---
def typecheck(expr: str, var_types: dict[str, str]) -> None:
    """Raise GuardError unless the guard is a well-typed boolean over ``var_types``."""
    if _type(parse(expr), var_types) != "boolean":
        raise GuardError("guard must be a boolean expression")


def _type(node: ast.AST, vt: dict[str, str]) -> str:
    if isinstance(node, ast.Name):
        if node.id not in vt:
            raise GuardError(f"undeclared variable {node.id!r}")
        return vt[node.id]
    if isinstance(node, ast.Constant):
        return _value_type(node.value)
    if isinstance(node, ast.BoolOp):
        for v in node.values:
            if _type(v, vt) != "boolean":
                raise GuardError("and/or operands must be boolean")
        return "boolean"
    if isinstance(node, ast.UnaryOp):
        if _type(node.operand, vt) != "boolean":
            raise GuardError("'not' operand must be boolean")
        return "boolean"
    if isinstance(node, ast.Call):
        t = _type(node.args[0], vt)
        if t not in ("string", "array"):
            raise GuardError("is_empty applies to string or array variables")
        return "boolean"
    if isinstance(node, ast.Compare):
        op = _CMP[type(node.ops[0])]
        lt = _type(node.left, vt)
        right = node.comparators[0]
        if op in ("in", "not in"):
            for e in right.elts:
                if _value_type(e.value) != lt:
                    raise GuardError(f"membership literal {e.value!r} does not match type {lt}")
            return "boolean"
        rt = _type(right, vt)
        if op in ("==", "!="):
            numeric = {"integer", "number"}
            if lt != rt and not (lt in numeric and rt in numeric):
                raise GuardError(f"cannot compare {lt} with {rt}")
            return "boolean"
        if lt not in ("integer", "number") or rt not in ("integer", "number"):
            raise GuardError(f"ordering comparison requires numbers, got {lt} and {rt}")
        return "boolean"
    raise GuardError(f"{type(node).__name__} is not allowed")


# ------------------------------------------------------------- evaluate ---
def evaluate(expr: str, env: dict[str, Any]) -> bool:
    result = _eval(parse(expr), env)
    if not isinstance(result, bool):
        raise GuardError("guard did not produce a boolean")
    return result


def _eval(node: ast.AST, env: dict[str, Any]) -> Any:
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise GuardError(f"undefined variable {node.id!r}")
        return env[node.id]
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.BoolOp):
        is_and = isinstance(node.op, ast.And)
        for v in node.values:
            r = _eval(v, env)
            if not isinstance(r, bool):
                raise GuardError("and/or operand is not boolean")
            if is_and and not r:
                return False
            if not is_and and r:
                return True
        return is_and
    if isinstance(node, ast.UnaryOp):
        r = _eval(node.operand, env)
        if not isinstance(r, bool):
            raise GuardError("'not' operand is not boolean")
        return not r
    if isinstance(node, ast.Call):
        v = _eval(node.args[0], env)
        if not isinstance(v, (str, list)):
            raise GuardError("is_empty applied to a non string/array value")
        return len(v) == 0
    if isinstance(node, ast.Compare):
        op = _CMP[type(node.ops[0])]
        left = _eval(node.left, env)
        if op in ("in", "not in"):
            items = [e.value for e in node.comparators[0].elts]
            lt = _value_type(left)
            if any(_value_type(i) != lt for i in items):
                raise GuardError("membership type mismatch at run time")
            found = any(left == i for i in items)
            return found if op == "in" else not found
        right = _eval(node.comparators[0], env)
        lt, rt = _value_type(left), _value_type(right)
        numeric = {"integer", "number"}
        if op in ("==", "!="):
            if lt != rt and not (lt in numeric and rt in numeric):
                raise GuardError(f"cannot compare {lt} with {rt} at run time")
            return (left == right) if op == "==" else (left != right)
        if lt not in numeric or rt not in numeric:
            raise GuardError("ordering comparison on non-numbers at run time")
        return {"<": left < right, "<=": left <= right, ">": left > right, ">=": left >= right}[op]
    raise GuardError(f"{type(node).__name__} is not allowed")


# ---------------------------------------------------------- disjointness ---
@dataclass
class Analysis:
    result: str
    detail: str = ""
    witness: dict | None = None


def _domain(var: str, vtype: str, enums: dict[str, list], guards: list[ast.AST]) -> list | None:
    """A finite set of representative values that is complete for the given guards, or None."""
    if var in enums:
        return list(enums[var])
    consts: list[Any] = []
    for g in guards:
        for node in ast.walk(g):
            if isinstance(node, ast.Compare):
                sides = [node.left, *node.comparators]
                if not any(isinstance(s, ast.Name) and s.id == var for s in sides):
                    continue
                other = [s for s in sides if not (isinstance(s, ast.Name) and s.id == var)]
                for o in other:
                    if isinstance(o, ast.Name):
                        return None  # variable-to-variable comparison: not analysed
                    if isinstance(o, ast.Constant):
                        consts.append(o.value)
                    elif isinstance(o, (ast.List, ast.Tuple)):
                        consts.extend(e.value for e in o.elts)
    if vtype == "boolean":
        return [False, True]
    if vtype == "integer":
        pts = {0}
        for c in consts:
            if isinstance(c, int) and not isinstance(c, bool):
                pts.update({c - 1, c, c + 1})
        return sorted(pts)
    if vtype == "string":
        uses_empty = any(isinstance(n, ast.Call) and n.args[0].id == var for g in guards for n in ast.walk(g))
        vals = {c for c in consts if isinstance(c, str)} | {"\u0000other"}
        if uses_empty:
            vals.add("")
        return sorted(vals)
    return None


def disjoint(guard_a: str, guard_b: str, var_types: dict[str, str], enums: dict[str, list] | None = None) -> Analysis:
    """Decide whether two guards can both be true.

    Exhaustive over representative domains, which is a proof when every
    variable is boolean, enumerated, or compared only against literals.
    Otherwise UNKNOWN (never treated as a proof).
    """
    enums = enums or {}
    ta, tb = parse(guard_a), parse(guard_b)
    vars_ = sorted(names(guard_a) | names(guard_b))
    domains = []
    for v in vars_:
        d = _domain(v, var_types.get(v, ""), enums, [ta, tb])
        if d is None:
            return Analysis(UNKNOWN, f"variable {v!r} ({var_types.get(v)}) is outside the decidable fragment")
        domains.append(d)
    total = 1
    for d in domains:
        total *= len(d)
    if total > MAX_ENUMERATION:
        return Analysis(UNKNOWN, f"analysis budget exceeded ({total} assignments)")
    for combo in itertools.product(*domains):
        env = dict(zip(vars_, combo))
        try:
            if _eval(ta, env) is True and _eval(tb, env) is True:
                return Analysis(COUNTEREXAMPLE, "both guards hold", env)
        except GuardError as exc:
            return Analysis(UNKNOWN, f"evaluation error during analysis: {exc}")
    return Analysis(PROVEN, f"checked {total} representative assignments")
