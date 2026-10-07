"""Build golden/selftest.json: a sample of the Python golden vectors that the page embeds for its Self-test.

The page (app/60_selftest.js + app/62_checks.js) replays these vectors against the JS engine in the viewer's
browser. Every vector comes from a golden file that another generator wrote by running the real Python reference
(gen_canonical.py, gen_guards.py, gen_kernel.py, gen_runtime.py, gen_demo.py), so this script only samples:
it picks a deterministic, evenly spread subset of each file, small enough to keep the page under 1.5 MB (LIMIT below).

Contents (keys of selftest.json):
  sources          {key: golden file it was sampled from, with the total count there}
  canonical        canonical text + digest values (all), float reprs (sample), strict_loads verdicts (all),
                   sha256 and hmac-sha256 vectors (all)
  guards           parse verdicts and messages (sample), typecheck / evaluate / evaluate3 cases over the golden
                   type and value environments (sample), analyze_disjoint cases (sample)
  kernel           the packages the sample needs (normalized dumps + artifact hashes), select_edge,
                   fill_template and resolve_path vectors (sample), kernel random walks (sample)
  runtime          full transcripts of three service scenarios (ops + Python's results and snapshots)
  demo             the "full" demo scenario: say lines, summary, timer and id draw counts

Run: python golden/gen_selftest.py   (after the generators above; gen_all.py runs it in name order, after them)
"""

from __future__ import annotations

import json

from _common import GOLDEN, _check

LIMIT = 1_500_000  # bytes, compact JSON
RUNTIME_SCENARIOS = ["happy_path", "restart_while_waiting", "timeout_after_commit"]
KERNEL_PACKAGES = ["initial", "refined", "verified", "judge", "falsy", "falsy_ghost"]


def load(name: str):
    return json.loads((GOLDEN / f"{name}.json").read_text(encoding="utf-8"))


def spread(items: list, n: int) -> list:
    """n items evenly spread over the list (all of them when it is short), in their original order."""
    if len(items) <= n:
        return list(items)
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


def canonical_part(sources: dict) -> dict:
    g = load("canonical")
    sources["canonical"] = {"file": "canonical.json", "vectors": sum(len(g[k]) for k in ("canonical", "floats", "loads", "sha256", "hmac"))}
    return {
        "canonical": g["canonical"],
        "floats": spread(g["floats"], 160),
        "loads": g["loads"],
        "sha256": g["sha256"],
        "hmac": g["hmac"],
    }


def guards_part(sources: dict) -> dict:
    p = load("guards_parse")
    s = load("guards_semantics")
    d = load("guards_disjoint")
    sources["guards_parse"] = {"file": "guards_parse.json", "vectors": len(p["cases"])}
    sources["guards_semantics"] = {"file": "guards_semantics.json", "vectors": len(s["cases"])}
    sources["guards_disjoint"] = {"file": "guards_disjoint.json", "vectors": len(d["cases"])}
    # parse: Python verdicts the port reproduces exactly (no documented deviation, no \N escape, no UTF-16 input)
    plain = [c for c in p["cases"] if c["r"] in ("ok", "err") and not c.get("dev") and not c.get("nesc") and "e16" not in c]
    parse = [{k: c[k] for k in ("e", "r", "m", "vars", "note") if k in c} for c in spread(plain, 180)]
    # disjointness: drop the cases that exercise documented deviations (big integers, non-GuardError crashes)
    disjoint = [c for c in d["cases"] if "x" not in c and not c.get("big")]
    disjoint = [{k: c[k] for k in ("guards", "types", "status", "edges", "detail", "counterexample", "note") if k in c}
                for c in spread(disjoint, 90)]
    return {
        "parse": parse,
        "type_envs": s["type_envs"],
        "value_envs": s["value_envs"],
        "semantics": spread(s["cases"], 110),
        "disjoint": disjoint,
    }


def kernel_part(sources: dict) -> dict:
    k = load("kernel")
    keep = set(KERNEL_PACKAGES)
    walks = []
    total_walks = 0
    for f in k["walk_files"]:
        ws = load(f)["walks"]
        total_walks += len(ws)
        walks.extend(w for w in ws if w["pkg"] in keep and w["steps"])
    small = [w for w in walks if len(json.dumps(w)) <= 9000]
    sources["kernel"] = {"file": "kernel.json + " + ", ".join(f + ".json" for f in k["walk_files"]),
                         "vectors": len(k["select_edge"]) + len(k["fill_template"]) + len(k["resolve_path"]) + total_walks}
    return {
        "packages": {n: k["packages"][n] for n in KERNEL_PACKAGES},
        "artifact_hashes": {n: k["artifact_hashes"][n] for n in KERNEL_PACKAGES},
        "select_edge": spread([v for v in k["select_edge"] if v["pkg"] in keep], 120),
        "fill_template": spread(k["fill_template"], 120),
        "resolve_path": k["resolve_path"],
        "walks": spread(small, 24),
    }


def runtime_part(sources: dict) -> dict:
    idx = load("runtime")["index"]
    files = {e["name"]: e["file"] for e in idx}
    out = []
    for name in RUNTIME_SCENARIOS:
        sc = next(s for s in load(files[name])["scenarios"] if s["name"] == name)
        out.append({"name": name, "file": files[name], "ops": sc["ops"], "transcript": sc["transcript"]})
    sources["runtime"] = {"file": "runtime.json index (runtime_1..4.json)", "vectors": len(idx)}
    return {"scenarios": out}


def demo_part(sources: dict) -> dict:
    g = load("demo")
    full = next(s for s in g["scenarios"] if s["scenario"] == "full")
    sources["demo"] = {"file": "demo.json", "vectors": len(g["scenarios"])}
    return {"clock0": g["clock0"], "scenario": "full", "lines": full["lines"], "summary": full["summary"],
            "timer_calls": full["timer_calls"], "ids_used": full["ids_used"]}


def main() -> None:
    sources: dict = {}
    out = {
        "generator": "golden/gen_selftest.py",
        "canonical": canonical_part(sources),
        "guards": guards_part(sources),
        "kernel": kernel_part(sources),
        "runtime": runtime_part(sources),
        "demo": demo_part(sources),
    }
    out["sources"] = sources
    _check(out)
    text = json.dumps(out, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    size = len(text.encode("utf-8"))
    if size > LIMIT:
        raise SystemExit(f"selftest.json is {size} bytes, over the {LIMIT} byte budget: sample fewer vectors")
    (GOLDEN / "selftest.json").write_text(text + "\n", encoding="utf-8")
    print(f"selftest.json: {size} bytes")


if __name__ == "__main__":
    main()
