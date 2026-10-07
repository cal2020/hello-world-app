"""Golden vectors for HX.eval (src/90_eval.js): the real ``evals/run_eval.py``.

``run_eval.main()`` is imported (not shelled out) and run with:
  * ``run_eval.ManualClock`` starting at 1790000000.25;
  * ``time.perf_counter`` returning ``0.125 * n`` on its n-th call;
  * ``uuid.uuid4`` = gen_runtime's ``seq_uuids`` (``HX.env.make_seq_ids(1)``); ``_common.deterministic_uuids()`` makes
    every run id ``run_0000000000000000`` and the second run collides (deviations/runtime.md);
  * ``run_eval.HERE`` pointed at a temporary directory holding the task file of the variant, ``--out`` a temporary
    directory, and ``git rev-parse`` answered with a fixed commit.

Recorded per variant: ``results.json`` without ``environment``, the ``report.md`` lines (the commit line is kept: the
JS test renders it from a result carrying the same fixed commit), or the exception ``main()`` raised. Plus unit vectors
for ``dev_overlap`` and ``summarize``.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import random
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from _common import ROOT, ints, write

from hexis_service.demo import reference as R
from hexis_service.demo.env import ManualClock

CLOCK0 = 1790000000.25
COMMIT = "0123456789abcdef0123456789abcdef01234567"

spec = importlib.util.spec_from_file_location("run_eval_mod", ROOT / "evals" / "run_eval.py")
EV = importlib.util.module_from_spec(spec)
spec.loader.exec_module(EV)
HELDOUT = json.loads((ROOT / "evals" / "heldout_tasks.json").read_text())


@contextmanager
def seq_uuids(start: int = 1):
    counter = {"n": start}
    real = uuid.uuid4

    def fake():
        n = counter["n"]
        counter["n"] += 1
        return uuid.UUID(hex=f"{n:016x}{n:016x}")

    uuid.uuid4 = fake
    try:
        yield counter
    finally:
        uuid.uuid4 = real


class _Proc:
    stdout = COMMIT + "\n"


class _Subprocess:
    @staticmethod
    def run(*a, **k):
        return _Proc()


@contextmanager
def patched(task_doc: dict):
    n = {"n": 0}

    def fake_timer() -> float:
        n["n"] += 1
        return 0.125 * n["n"]

    class Clock(ManualClock):
        def __init__(self, t: float = CLOCK0):
            super().__init__(t)

    saved = (EV.ManualClock, EV.HERE, EV.subprocess, time.perf_counter, sys.argv)
    with tempfile.TemporaryDirectory() as tmp:
        here = Path(tmp) / "evals"
        here.mkdir()
        (here / "heldout_tasks.json").write_text(json.dumps(task_doc))
        out = Path(tmp) / "out"
        EV.ManualClock, EV.HERE, EV.subprocess, time.perf_counter = Clock, here, _Subprocess, fake_timer
        sys.argv = ["run_eval.py", "--out", str(out)]
        try:
            with seq_uuids() as ids:
                yield out, n, ids
        finally:
            EV.ManualClock, EV.HERE, EV.subprocess, time.perf_counter, sys.argv = saved


def run_variant(name: str, tasks: list) -> dict:
    doc = {"tasks": tasks}
    with patched(doc) as (out, timer, ids):
        error = None
        try:
            EV.main()
        except Exception as exc:  # noqa: BLE001
            error = [type(exc).__name__, str(exc)]
        res = json.loads((out / "results.json").read_text()) if (out / "results.json").exists() else None
        report = (out / "report.md").read_text() if (out / "report.md").exists() else None
    if res is not None:
        env = res.pop("environment")
        assert env["git_commit"] == COMMIT
    return {"name": name, "tasks_json": json.dumps(tasks), "result": ints(res) if res is not None else None,
            "report": report.split("\n") if report is not None else None, "error": error,
            "timer_calls": timer["n"], "ids_used": ids["n"] - 1}


# ---------------------------------------------------------------------------------------------------------------- #
# task variants
# ---------------------------------------------------------------------------------------------------------------- #
BASE = HELDOUT["tasks"]
SUPPLIERS = ["SUP-20077", "SUP-10042", "SUP-40002", "SUP-55555", "SUP-10043", "SUP-30001", "SUP-40003", "SUP-77777"]
DOCS = ["DOC-W9-20077", "DOC-W9-10042", "DOC-FORM-10042", "DOC-NOT-UPLOADED", "DOC-INJECT-30001", "DOC-LATE-40002",
        "DOC-STILL-MISSING"]
EXPECTS = ["verified", "review", "unverified", "fallback", "weird"]


def perturb(rng: random.Random, t: dict, i: int) -> dict:
    t = copy.deepcopy(t)
    t["id"] = f"{t['id']}~{i}" if rng.random() < 0.8 else t["id"]  # sometimes a duplicate id
    r = rng.random()
    if r < 0.15:
        t["input"]["supplier_ref"] = rng.choice(SUPPLIERS)
    elif r < 0.25:
        t["input"]["document_ids"] = rng.sample(DOCS, rng.randint(1, 2))
    if rng.random() < 0.2:
        t["oracle"]["expect"] = rng.choice(EXPECTS)
    if rng.random() < 0.2 and t["oracle"]["fields"]:
        k = rng.choice(sorted(t["oracle"]["fields"]))
        t["oracle"]["fields"][k] = "WRONG " + k
    if rng.random() < 0.1:
        t["oracle"]["fields"]["country"] = rng.choice(["DE", "GB", "XX"])
    if rng.random() < 0.15:
        t["responses"] = {"input": {"document_ids": rng.sample(DOCS, rng.randint(1, 2))}}
    return t


def variants() -> list:
    out = [("heldout", BASE), ("no_overlap", [t for t in BASE if t["id"] != "H3-missing-then-supplied"]),
           ("only_overlap", [t for t in BASE if t["id"] == "H3-missing-then-supplied"]),
           ("reversed", list(reversed(BASE)))]
    by = {t["id"]: t for t in BASE}

    def ren(t, i, **oracle):
        t = copy.deepcopy(t)
        t["id"] = f"{t['id']}#{i}"
        t["oracle"].update(oracle)
        return t
    # 8 tasks: 5/8 and 1/8 ratios are exact binary ties for ".2f" (Python rounds half to even: 0.62, 0.12)
    out.append(("eighths", [by["H4-registry-conflict"], by["H1-complete"], by["H2-repairable-email"],
                            by["H6-injection-in-document"], ren(by["H6-injection-in-document"], 1)]
                + [ren(by["H5-unrepairable"], i, expect="verified") for i in range(3)]))
    for seed in (5101, 5102, 5103, 5104):
        rng = random.Random(seed)
        out.append((f"random_{seed}", [perturb(rng, rng.choice(BASE), i) for i in range(rng.randint(5, 9))]))
    return out


# ---------------------------------------------------------------------------------------------------------------- #
# unit vectors
# ---------------------------------------------------------------------------------------------------------------- #
def exc_name(fn):
    try:
        return {"value": fn()}
    except Exception as exc:  # noqa: BLE001
        return {"error": [type(exc).__name__, str(exc)]}


def overlap_vectors() -> list:
    devs = {"missing": R.missing_docs_trace(), "shortcut": R.shortcut_trace(), "forbidden": R.forbidden_write_trace(),
            "duplicate": R.duplicate_write_trace()}
    rng = random.Random(5150)
    tasks = [copy.deepcopy(t) for t in BASE]
    tasks += [{"id": "no-input"}, {"id": "empty", "input": {}}, {"id": "resp-none", "input": {"supplier_ref": "X"},
                                                                   "responses": {}},
              {"id": "resp-input-none", "input": {}, "responses": {"input": {}}},
              {"id": "late-only", "input": {"supplier_ref": "SUP-1"},
               "responses": {"input": {"document_ids": ["DOC-LATE-40002", "DOC-A", "DOC-LATE-40002"]}}},
              {"id": "both", "input": {"supplier_ref": "SUP-40002"},
               "responses": {"input": {"document_ids": ["Z", "DOC-LATE-40002"]}}},
              # non-dict tasks: Python's subscript TypeError wording
              "input", ["x"], 5, None]
    for i in range(40):
        t = {"id": f"r{i}", "input": {}}
        if rng.random() < 0.7:
            t["input"]["supplier_ref"] = rng.choice(SUPPLIERS + ["SUP-10042"])
        if rng.random() < 0.5:
            t["responses"] = {"input": {"document_ids": rng.sample(DOCS, rng.randint(0, 3))}}
        tasks.append(t)
    out = []
    for dn, dev in devs.items():
        for t in tasks:
            out.append({"dev": dn, "task": t, **exc_name(lambda: EV.dev_overlap(t, dev))})
    return out


def summarize_vectors() -> list:
    rng = random.Random(5160)
    keys = ["business_success", "procedural_conformance", "terminal_honest", "fallback_outcome", "entered_fallback"]
    out = [{"rows": [], "value": ints(EV.summarize([]))}]
    for _ in range(60):
        rows = []
        for _ in range(rng.randint(1, 13)):
            r = {k: rng.random() < 0.6 for k in keys}
            r.update(duplicate_writes=rng.randint(0, 2), human_interactions=rng.randint(0, 6),
                     steps=rng.randint(0, 40), model_calls=rng.randint(0, 5))
            rows.append(r)
        out.append({"rows": rows, "value": ints(EV.summarize(rows))})
    # mixed int / float steps: CPython 3.12 sum() compensates float items only (int items join the running double
    # uncompensated once a float has appeared)
    base = {k: True for k in keys}
    base.update(duplicate_writes=0, human_interactions=0, model_calls=0)
    mixes = [[26, 0.1, 0.1, -3], [0.1, 0.2, 0.3, 4], [3, 0.1, 0.2, 0.3], [1, 1e-16, 1e-16, 1, 1e-16],
             [0.1] * 7 + [5], [123456789012, 0.1, -123456789012, 0.2], [2.5, 1, 0.7, 2, 0.1]]
    for _ in range(30):
        mixes.append([rng.choice([rng.randint(-50, 50), round(rng.uniform(-50, 50), rng.randint(1, 6)), 0.1,
                                  1111111111111111, 0.3]) for _ in range(rng.randint(2, 9))])
    for steps in mixes:
        steps = [x for x in steps if not (isinstance(x, float) and x.is_integer())] or [0.5]
        rows = [dict(base, steps=x) for x in steps]
        rows[0]["human_interactions"] = 0.1
        out.append({"rows": rows, "value": ints(EV.summarize(rows))})
    return out


def fmt2_vectors() -> list:
    """``format(v, '.2f')`` (the report's fmt2) over exact binary ties, huge magnitudes and random doubles; values as
    ``repr`` text (integral floats cannot be stored as JSON numbers)."""
    import struct
    rng = random.Random(2468)
    xs = [500000000000000.125, 1000000000000000.125, 0.125, 0.375, 2.675, 1.005, -0.125, -0.0, 0.0, 5e-324, 1e300,
          1.7976931348623157e308, 0.005, 0.015, 0.025, 123.455, 2.0 ** 52 + 0.5, 2.0 ** 53, 1e21, 1e22, 9e13 + 0.125,
          1e15 + 0.125, 2.0 ** 50 - 0.125]
    while len(xs) < 600:
        k = rng.random()
        if k < 0.3:
            x = struct.unpack("d", struct.pack("Q", rng.getrandbits(64)))[0]
        elif k < 0.7:
            x = rng.randint(-10 ** 8, 10 ** 8) / 8 * rng.choice([1, 1e-3, 1e3, 1e10, 1e14, 1e15, 1e16])
        else:
            x = rng.uniform(-1e6, 1e6)
        if x == x and abs(x) != float("inf"):
            xs.append(x)
    return [[repr(x), format(x, ".2f")] for x in xs]


def main() -> None:
    runs = [run_variant(n, t) for n, t in variants()]
    write("eval", {"clock0": CLOCK0, "commit": COMMIT, "heldout": HELDOUT, "runs": runs,
                   "dev_overlap": overlap_vectors(), "summarize": summarize_vectors(),
                   "fmt2": fmt2_vectors()})
    for r in runs:
        print(r["name"], r["error"], r["timer_calls"], r["ids_used"], file=sys.stderr)


if __name__ == "__main__":
    main()
