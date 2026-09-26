"""Guard language: allowlisted parsing, static typing, strict evaluation and disjointness analysis.

Compatible with upstream guard syntax (boolean and/or/not, comparisons, ``in`` over literal
lists, ``empty(x)``/``nonempty(x)``), evaluated by an AST visitor -- never ``eval``. Production
additions (brief §7.2): size/depth limits, static type checking that rejects bool/int coercion and
null comparisons, strict runtime type checks, and PROVEN / COUNTEREXAMPLE / UNKNOWN disjointness
analysis. Undefined variables and type errors raise :class:`GuardError`; they are never "false".
"""

from __future__ import annotations

import ast
import itertools
import math
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Optional

MAX_LEN = 512
MAX_DEPTH = 12
MAX_NODES = 64
MAX_LIST = 32
MAX_STR = 256
MAX_CONFIGS = 20_000

PREDICATES = ("empty", "nonempty")
_CMP = {
    ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=",
    ast.In: "in", ast.NotIn: "not in",
}
NUMERIC = ("integer", "number")


class GuardError(ValueError):
    """Invalid guard, type error, or evaluation failure (including undefined variables)."""


def _depth(node: ast.AST) -> int:
    kids = list(ast.iter_child_nodes(node))
    return 1 + (max(_depth(k) for k in kids) if kids else 0)


@lru_cache(maxsize=2048)
def parse(expr: str) -> ast.Expression:
    if not isinstance(expr, str) or not expr.strip():
        raise GuardError("empty guard (default edges have cond == '')")
    if len(expr) > MAX_LEN:
        raise GuardError(f"guard longer than {MAX_LEN} characters")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise GuardError(f"guard syntax error: {exc.msg}") from exc
    nodes = list(ast.walk(tree))
    if len(nodes) > MAX_NODES:
        raise GuardError(f"guard has more than {MAX_NODES} syntax nodes")
    if _depth(tree) > MAX_DEPTH:
        raise GuardError(f"guard AST deeper than {MAX_DEPTH}")
    _check(tree.body)
    return tree


def _check(node: ast.AST) -> None:
    if isinstance(node, ast.BoolOp):
        for v in node.values:
            _check(v)
    elif isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, ast.Not):
            raise GuardError("the only unary operator allowed is 'not'")
        _check(node.operand)
    elif isinstance(node, ast.Compare):
        for op in node.ops:
            if type(op) not in _CMP:
                raise GuardError(f"comparison operator not allowed: {type(op).__name__}")
        _check(node.left)
        for c in node.comparators:
            _check(c)
    elif isinstance(node, ast.Call):
        if not (isinstance(node.func, ast.Name) and node.func.id in PREDICATES):
            raise GuardError("only empty(x) / nonempty(x) calls are allowed")
        if len(node.args) != 1 or node.keywords or not isinstance(node.args[0], ast.Name):
            raise GuardError(f"{node.func.id} takes exactly one variable argument")
    elif isinstance(node, (ast.List, ast.Tuple)):
        if len(node.elts) > MAX_LIST:
            raise GuardError(f"literal list longer than {MAX_LIST}")
        for e in node.elts:
            if not isinstance(e, ast.Constant):
                raise GuardError("list literals may only contain constants")
            _check(e)
    elif isinstance(node, ast.Name):
        if node.id in PREDICATES or node.id.startswith("__"):
            raise GuardError(f"name not allowed: {node.id}")
    elif isinstance(node, ast.Constant):
        v = node.value
        if not isinstance(v, (str, int, float, bool)) or v is None:
            raise GuardError(f"constant not allowed: {v!r}")
        if isinstance(v, str) and len(v) > MAX_STR:
            raise GuardError("string literal too long")
        if isinstance(v, float) and not math.isfinite(v):
            raise GuardError("non-finite literal")
    else:
        raise GuardError(f"syntax node not allowed: {type(node).__name__}")


def vars_of(expr: str) -> set[str]:
    if not expr:
        return set()
    tree = parse(expr)
    out = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and n.id not in PREDICATES:
            out.add(n.id)
    return out


# --------------------------------------------------------------------------- #
# Static typing
# --------------------------------------------------------------------------- #
def _const_type(v: Any) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    return "string"


def _cat(t: str) -> str:
    return "numeric" if t in NUMERIC else t


def typecheck(expr: str, var_types: dict[str, str]) -> list[str]:
    """Return a list of type errors (empty means well-typed boolean guard)."""
    errors: list[str] = []
    try:
        tree = parse(expr)
    except GuardError as exc:
        return [str(exc)]

    def typ(node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            if node.id not in var_types:
                errors.append(f"undeclared variable {node.id!r}")
                return "?"
            return var_types[node.id]
        if isinstance(node, ast.Constant):
            return _const_type(node.value)
        if isinstance(node, (ast.List, ast.Tuple)):
            kinds = {_cat(_const_type(e.value)) for e in node.elts}  # type: ignore[attr-defined]
            if len(kinds) > 1:
                errors.append("mixed-type list literal")
            return "list:" + (kinds.pop() if kinds else "empty")
        return "boolean" if bool_expr(node) else "?"

    def bool_expr(node: ast.AST) -> bool:
        if isinstance(node, ast.BoolOp):
            for v in node.values:
                if not bool_expr(v):
                    errors.append("operand of and/or must be boolean")
            return True
        if isinstance(node, ast.UnaryOp):
            if not bool_expr(node.operand):
                errors.append("operand of 'not' must be boolean")
            return True
        if isinstance(node, ast.Call):
            t = typ(node.args[0])
            if t not in ("string", "array", "object", "?"):
                errors.append(f"{node.func.id}() needs a string/array/object variable, got {t}")  # type: ignore
            return True
        if isinstance(node, ast.Compare):
            left = node.left
            for op, right in zip(node.ops, node.comparators):
                o = _CMP[type(op)]
                lt, rt = typ(left), typ(right)
                if "?" in (lt, rt):
                    pass
                elif o in ("in", "not in"):
                    if rt.startswith("list:"):
                        inner = rt[5:]
                        if inner != "empty" and inner != _cat(lt):
                            errors.append(f"'{o}' mixes {lt} with a list of {inner}")
                        if lt in ("array", "object", "boolean"):
                            errors.append(f"'{o}' left operand must be string or numeric, got {lt}")
                    elif rt == "array":
                        if lt not in ("string", "integer", "number"):
                            errors.append(f"'{o}' left operand must be scalar, got {lt}")
                    else:
                        errors.append(f"'{o}' needs a list literal or array variable on the right, got {rt}")
                elif o in ("<", "<=", ">", ">="):
                    if _cat(lt) != "numeric" or _cat(rt) != "numeric":
                        errors.append(f"ordering comparison needs numbers, got {lt} {o} {rt}")
                else:
                    if lt.startswith("list:") or rt.startswith("list:"):
                        errors.append("equality against a list literal is not allowed")
                    elif lt in ("array", "object") or rt in ("array", "object"):
                        errors.append("equality on array/object is not allowed; use empty()/nonempty()")
                    elif _cat(lt) != _cat(rt):
                        errors.append(f"type mismatch: {lt} {o} {rt} (no implicit coercion)")
                left = right
            return True
        if isinstance(node, ast.Name):
            t = typ(node)
            if t not in ("boolean", "?"):
                errors.append(f"variable {node.id!r} of type {t} used as a condition (no truthiness)")
            return True
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, bool):
                errors.append("non-boolean constant used as a condition")
            return True
        return False

    if not bool_expr(tree.body):
        errors.append("guard is not a boolean expression")
    return errors


# --------------------------------------------------------------------------- #
# Strict runtime evaluation
# --------------------------------------------------------------------------- #
class _Unknown:
    def __repr__(self) -> str:
        return "UNKNOWN"


UNKNOWN = _Unknown()


def _rt_cat(v: Any) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "numeric"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    if v is None:
        return "null"
    return "?"


def _cmp(o: str, a: Any, b: Any) -> bool:
    if o in ("in", "not in"):
        if not isinstance(b, list):
            raise GuardError(f"right operand of '{o}' is not a list")
        ca = _rt_cat(a)
        if ca not in ("string", "numeric"):
            raise GuardError(f"left operand of '{o}' has type {ca}")
        hit = any(_rt_cat(x) == ca and x == a for x in b)
        return hit if o == "in" else not hit
    ca, cb = _rt_cat(a), _rt_cat(b)
    if o in ("<", "<=", ">", ">="):
        if ca != "numeric" or cb != "numeric":
            raise GuardError(f"ordering comparison on {ca} and {cb}")
        return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[o]
    if ca != cb or ca in ("array", "object", "null"):
        raise GuardError(f"equality between {ca} and {cb} is not allowed")
    return (a == b) if o == "==" else (a != b)


def _pred(name: str, v: Any) -> bool:
    if not isinstance(v, (str, list, dict)):
        raise GuardError(f"{name}() applied to {_rt_cat(v)}")
    return (len(v) == 0) if name == "empty" else (len(v) > 0)


def _eval(node: ast.AST, env: dict, unknown_ok: bool) -> Any:
    if isinstance(node, ast.BoolOp):
        is_and = isinstance(node.op, ast.And)
        saw_unknown = False
        for v in node.values:
            r = _eval(v, env, unknown_ok)
            if r is UNKNOWN:
                saw_unknown = True
                continue
            if not isinstance(r, bool):
                raise GuardError("non-boolean operand of and/or")
            if is_and and not r:
                return False
            if not is_and and r:
                return True
        return UNKNOWN if saw_unknown else is_and
    if isinstance(node, ast.UnaryOp):
        r = _eval(node.operand, env, unknown_ok)
        if r is UNKNOWN:
            return UNKNOWN
        if not isinstance(r, bool):
            raise GuardError("non-boolean operand of not")
        return not r
    if isinstance(node, ast.Compare):
        left = _eval(node.left, env, unknown_ok)
        result: Any = True
        for op, comp in zip(node.ops, node.comparators):
            right = _eval(comp, env, unknown_ok)
            if left is UNKNOWN or right is UNKNOWN:
                result = UNKNOWN
            elif not _cmp(_CMP[type(op)], left, right):
                return False
            left = right
        return result
    if isinstance(node, ast.Call):
        v = _eval(node.args[0], env, unknown_ok)
        return UNKNOWN if v is UNKNOWN else _pred(node.func.id, v)  # type: ignore[attr-defined]
    if isinstance(node, (ast.List, ast.Tuple)):
        return [e.value for e in node.elts]  # type: ignore[attr-defined]
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise GuardError(f"guard uses undefined variable {node.id!r}")
        v = env[node.id]
        if v is UNKNOWN and not unknown_ok:
            raise GuardError(f"variable {node.id!r} has no observed value")
        if v is not UNKNOWN and not isinstance(v, bool) and isinstance(node.ctx, ast.Load) \
                and _is_bare_condition(node):
            raise GuardError(f"variable {node.id!r} used as a condition is not boolean")
        return v
    if isinstance(node, ast.Constant):
        return node.value
    raise GuardError(f"unexpected node {type(node).__name__}")


def _is_bare_condition(node: ast.Name) -> bool:  # refined by _mark_parents
    return getattr(node, "_bare", False)


@lru_cache(maxsize=2048)
def _prepared(expr: str) -> ast.Expression:
    tree = parse(expr)
    body = tree.body

    def mark(n: ast.AST, cond_ctx: bool) -> None:
        if isinstance(n, ast.Name):
            n._bare = cond_ctx  # type: ignore[attr-defined]
        elif isinstance(n, ast.BoolOp):
            for v in n.values:
                mark(v, True)
        elif isinstance(n, ast.UnaryOp):
            mark(n.operand, True)
        else:
            for k in ast.iter_child_nodes(n):
                mark(k, False)

    mark(body, True)
    return tree


def evaluate(expr: str, env: dict) -> bool:
    """Strict evaluation: returns a bool or raises :class:`GuardError`."""
    r = _eval(_prepared(expr).body, env, unknown_ok=False)
    if not isinstance(r, bool):
        raise GuardError("guard did not evaluate to a boolean")
    return r


def evaluate3(expr: str, env: dict) -> Optional[bool]:
    """Kleene three-valued evaluation for structural replay: ``None`` means unknown."""
    r = _eval(_prepared(expr).body, env, unknown_ok=True)
    return None if r is UNKNOWN else bool(r)


# --------------------------------------------------------------------------- #
# Disjointness analysis
# --------------------------------------------------------------------------- #
@dataclass
class Analysis:
    status: str  # PROVEN | COUNTEREXAMPLE | UNKNOWN
    detail: str = ""
    counterexample: dict = field(default_factory=dict)
    edges: tuple = ()


def _constants_by_var(tree: ast.AST) -> tuple[dict[str, set], bool]:
    """Collect constants each variable is compared against. Second value False if a construct
    outside the enumerable fragment appears (variable-to-variable comparison, ``in`` array var)."""
    consts: dict[str, set] = {}
    ok = True
    for n in ast.walk(tree):
        if isinstance(n, ast.Compare):
            operands = [n.left, *n.comparators]
            for a, b in zip(operands, operands[1:]):
                names = [x for x in (a, b) if isinstance(x, ast.Name)]
                if len(names) == 2:
                    ok = False
                for x, y in ((a, b), (b, a)):
                    if isinstance(x, ast.Name):
                        if isinstance(y, ast.Constant):
                            consts.setdefault(x.id, set()).add(y.value)
                        elif isinstance(y, (ast.List, ast.Tuple)):
                            consts.setdefault(x.id, set()).update(e.value for e in y.elts)  # type: ignore
        elif isinstance(n, ast.Name) and n.id not in PREDICATES:
            consts.setdefault(n.id, set())
    return consts, ok


def _domain(t: str, cs: set) -> list:
    if t == "boolean":
        return [True, False]
    if t == "string":
        return sorted({c for c in cs if isinstance(c, str)} | {"", "\u0000other"})
    if t in ("array",):
        return [[], ["\u0000x"]]
    if t == "object":
        return [{}, {"\u0000k": 0}]
    nums = sorted({float(c) for c in cs if isinstance(c, (int, float)) and not isinstance(c, bool)})
    if t == "integer":
        vals = {0}
        for c in nums:
            vals.update({math.floor(c) - 1, math.floor(c), math.ceil(c), math.ceil(c) + 1})
        return sorted(vals)
    vals_f = {0.0}
    for i, c in enumerate(nums):
        vals_f.update({c - 1, c, c + 1})
        if i + 1 < len(nums):
            vals_f.add((c + nums[i + 1]) / 2)
    return sorted(vals_f)


def analyze_disjoint(guards: list[str], var_types: dict[str, str]) -> Analysis:
    """Decide whether the guarded edges of one state are pairwise mutually exclusive."""
    if len(guards) < 2:
        return Analysis("PROVEN", "fewer than two guarded edges")
    consts: dict[str, set] = {}
    for g in guards:
        try:
            c, ok = _constants_by_var(parse(g))
        except GuardError as exc:
            return Analysis("UNKNOWN", f"unparseable guard: {exc}")
        if not ok:
            return Analysis("UNKNOWN", f"guard {g!r} compares two variables; outside the enumerable fragment")
        for k, v in c.items():
            consts.setdefault(k, set()).update(v)
    names = sorted(consts)
    domains = []
    for n in names:
        if n not in var_types:
            return Analysis("UNKNOWN", f"undeclared variable {n!r}")
        domains.append(_domain(var_types[n], consts[n]))
    total = 1
    for d in domains:
        total *= len(d)
    if total > MAX_CONFIGS:
        return Analysis("UNKNOWN", f"{total} configurations exceed analysis bound {MAX_CONFIGS}")
    for combo in itertools.product(*domains):
        env = dict(zip(names, combo))
        true_edges = []
        for i, g in enumerate(guards):
            try:
                if evaluate(g, env):
                    true_edges.append(i)
            except GuardError as exc:
                return Analysis("UNKNOWN", f"evaluation error during analysis: {exc}")
        if len(true_edges) > 1:
            return Analysis("COUNTEREXAMPLE", f"guards {true_edges} are simultaneously true",
                            {k: v for k, v in env.items()}, tuple(true_edges))
    return Analysis("PROVEN", f"exhaustive over {total} representative configurations")
