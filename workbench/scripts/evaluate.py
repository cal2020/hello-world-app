"""Run the evaluation and write eval/results.json + EVALUATION.md from ACTUAL results.

  .venv/bin/python scripts/evaluate.py            # fixture + deterministic (no model API)
  LWB_EVAL_LIVE=1 .venv/bin/python scripts/evaluate.py   # also a live-model run, if configured

Separates: integration correctness (unit/integration tests), relationship proposals
(deterministic baseline vs scripted fixture vs optional live model), and local timings.
"""
import datetime
import io
import json
import os
import pathlib
import platform
import statistics
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LWB_QUIET", "1")

from lucidwb.stack import Stack  # noqa: E402
from lucidwb.util import code_version  # noqa: E402
from scripts.client import Client  # noqa: E402
from scripts.seed import seed  # noqa: E402

GOLD = json.loads((ROOT / "fixtures/eval/gold_links.json").read_text())


def run_tests():
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), top_level_dir=str(ROOT))
    cases = []

    def walk(s):
        for t in s:
            if isinstance(t, unittest.TestSuite):
                walk(t)
            else:
                cases.append(t.id())
    walk(suite)  # before running: the runner releases finished tests
    buf = io.StringIO()
    res = unittest.TextTestRunner(stream=buf, verbosity=2).run(suite)
    failed = {t.id() for t, _ in res.failures + res.errors}
    return {"ran": res.testsRun, "failed": sorted(failed), "skipped": len(res.skipped),
            "cases": [{"id": c, "passed": c not in failed} for c in sorted(cases)]}


def score(proposals, labels):
    by = {}
    for p in proposals:
        by.setdefault(p["record"]["id"], []).append(p)
    rows, ev_total, ev_valid = [], 0, 0
    agg = {"records": 0, "positives": 0, "correct_links": 0, "false_links": 0, "missed_links": 0,
           "no_match_correct": 0, "no_match_cases": 0, "flagged_ambiguous": 0, "rejected_by_validation": 0,
           "predicate_correct": 0, "predicate_judged": 0, "needs_review": 0}
    for rid, gold in labels.items():
        ps = by.get(rid, [])
        for p in ps:
            for e in p["evidence"]:
                ev_total += 1
                ev_valid += 1 if e.get("valid") else 0
        valid = [p for p in ps if p["validation"] == "valid" and p["target"]]
        invalid = [p for p in ps if p["validation"] not in ("valid", "no_match_suggested")]
        targets = [p["target"]["source_id"] for p in valid]
        agg["records"] += 1
        agg["rejected_by_validation"] += len(invalid)
        agg["needs_review"] += len([p for p in ps if p["validation"] in ("valid", "no_match_suggested")])
        if len(valid) > 1:
            agg["flagged_ambiguous"] += 1
        false = [t for t in targets if t != gold]
        agg["false_links"] += len(false)
        for p in valid:
            if p["target"]["source_id"] == gold:
                agg["predicate_judged"] += 1
                agg["predicate_correct"] += int(p["predicate"] == GOLD["predicate"])
        if gold is None:
            agg["no_match_cases"] += 1
            agg["no_match_correct"] += int(not targets)
            outcome = "correct_no_link" if not targets else "false_link"
        else:
            agg["positives"] += 1
            hit = gold in targets
            agg["correct_links"] += int(hit)
            agg["missed_links"] += int(not hit)
            outcome = ("correct" if hit and not false else "correct_plus_competing" if hit else
                       "wrong_target" if targets else "missed")
        rows.append({"record": rid, "gold": gold, "valid_targets": targets, "outcome": outcome,
                     "invalid_proposals": [p["validation"] for p in invalid]})
    agg["citation_validity"] = f"{ev_valid}/{ev_total}"
    agg["recall"] = f"{agg['correct_links']}/{agg['positives']}"
    n_pred = agg["correct_links"] + agg["false_links"]
    agg["precision_of_valid_candidates"] = f"{agg['correct_links']}/{n_pred}" if n_pred else "n/a"
    agg["accepted_incorrect_links"] = "not measured (no human review in this run)"
    agg["review_time"] = "not measured (no human reviewers)"
    return {"summary": agg, "per_record": rows}


def relationship_eval(live):
    out = {}
    var = tempfile.mkdtemp(prefix="lwb-eval-")
    s = Stack(var, wb_port=0, consumer_port=0, start_worker=False)
    try:
        seed(s.wb_url)
        carol, alice = Client(s.wb_url, "demo-carol"), Client(s.wb_url, "demo-alice")
        carol.import_fixture("model/A_initial.json")
        carol.import_fixture("records/cmms_heldout.json")
        methods = [("deterministic", None), ("model", "fixture")] + ([("model", "live")] if live else [])
        for split, spec in GOLD["splits"].items():
            for method, mode in methods:
                st, run, _ = alice.post("/manage/projects/ehm/proposal-runs",
                                        {"method": method, "mode": mode, "record_source": spec["record_source"]})
                key = method if not mode else f"model:{mode}"
                if st != 201 or run["status"] != "completed":
                    out.setdefault(split, {})[key] = {"status": "failed", "error": run.get("error") if isinstance(run, dict) else st}
                    continue
                r = score(run["proposals"], spec["labels"])
                r["run"] = {"run_id": run["run_id"], "provider": run["provider"], "model": run["model"],
                            "elapsed_ms": run["stats"]["elapsed_ms"], "label": run.get("label")}
                out.setdefault(split, {})[key] = r
    finally:
        s.close()
    return out


def timings(n=5):
    res = {"import_A_ms": [], "build_ms": [], "consumer_checks_ms": [], "activate_ms": [], "delivery_ms": []}
    for _ in range(n):
        var = tempfile.mkdtemp(prefix="lwb-time-")
        s = Stack(var, wb_port=0, consumer_port=0, start_worker=False)
        try:
            seed(s.wb_url)
            c = Client(s.wb_url, "demo-carol")
            t = time.perf_counter(); c.import_fixture("model/A_initial.json"); res["import_A_ms"].append((time.perf_counter() - t) * 1000)
            t = time.perf_counter(); _, r, _ = c.post("/manage/projects/ehm/releases", {"projection_id": "equipment-health", "version": "1.0.0"}); res["build_ms"].append((time.perf_counter() - t) * 1000)
            t = time.perf_counter(); c.post(f"/manage/releases/{r['release_id']}/consumer-checks"); res["consumer_checks_ms"].append((time.perf_counter() - t) * 1000)
            t = time.perf_counter(); c.post(f"/manage/releases/{r['release_id']}/activate", {"expected_active_release_id": None, "reason": "timing"}); res["activate_ms"].append((time.perf_counter() - t) * 1000)
            t = time.perf_counter()
            for _ in range(10):
                if not s.app.worker.deliver_pass(force=True):
                    break
            res["delivery_ms"].append((time.perf_counter() - t) * 1000)
        finally:
            s.close()
    return {k: {"n": len(v), "median": round(statistics.median(v), 1), "max": round(max(v), 1)} for k, v in res.items()}


IC_TITLES = [
    ("IC01", "Exact repeated import", "Identity.test_IC01"),
    ("IC02", "Rename with stable ID", "Identity.test_IC02"),
    ("IC03", "Similar names, different projects", "Identity.test_IC03"),
    ("IC04", "Same revision, different content", "Identity.test_IC04"),
    ("IC05", "Partial export omits an element", "Identity.test_IC05"),
    ("IC06", "Explicit deletion / complete-scope removal", "Identity.test_IC06"),
    ("IC07", "Out-of-order revision / missing delta parent", "Identity.test_IC07"),
    ("IC08", "Unit / predicate-direction change", "Contracts.test_IC08"),
    ("IC09", "Missing instance value", "Contracts.test_IC09"),
    ("IC10", "Removed required property definition", "Contracts.test_IC10"),
    ("IC11", "New field or enum value", "Contracts.test_IC11"),
    ("IC12", "Permission change between proposal and commit", "Links.test_IC12"),
    ("IC13", "Stale ETag or changed evidence", "Links.test_IC13"),
    ("IC14", "Concurrent head update during acceptance", "Links.test_IC14"),
    ("IC15", "Same operation key, different request", "Links.test_IC15"),
    ("IC16", "Lost acknowledgment after commit", "test_IC16"),
    ("IC17", "Duplicate or older outbox event", "Delivery.test_IC17"),
    ("IC18", "Forged source instructions or invalid citation", "Links.test_IC18"),
    ("IC19", "Failed activation and rollback", "Delivery.test_IC19"),
]


def write_report(r):
    L = []
    L.append("# Evaluation report (generated)\n")
    L.append(f"Generated {r['generated_at']} by `scripts/evaluate.py` at code version `{r['code_version']}` "
             f"on Python {r['python']} / {r['platform']}. Every number below comes from this run. "
             "Synthetic fixtures only. Results are about this prototype's behavior on these cases, "
             "not about production reliability, standards conformance, Cameo compatibility or real-model quality.\n")
    t = r["tests"]
    L.append("## 1. Integration correctness (independent negative tests)\n")
    L.append(f"Test suite: **{t['ran'] - len(t['failed'])}/{t['ran']} passed**, {t['skipped']} skipped. "
             "Each test drives the real HTTP API of a fresh local stack (workbench server and consumer server "
             "on loopback ports inside the test process, separate SQLite files).\n")
    L.append("| Case | Required outcome (from brief) | Test(s) | Result |\n|---|---|---|---|")
    for cid, title, frag in IC_TITLES:
        ms = [c for c in t["cases"] if frag in c["id"]]
        ok = ms and all(c["passed"] for c in ms)
        L.append(f"| {cid} | {title} | {', '.join(c['id'].split('.')[-1] for c in ms) or '—'} | "
                 f"{'pass' if ok else ('**FAIL**' if ms else 'not executed')} |")
    extra = [c for c in t["cases"] if not any(f in c["id"] for _, _, f in IC_TITLES)]
    L.append(f"\nAdditional tests ({len(extra)}): " + ", ".join(
        f"{c['id'].split('.')[-1]} ({'pass' if c['passed'] else 'FAIL'})" for c in extra) + "\n")
    if t["failed"]:
        L.append("**Failures:** " + ", ".join(t["failed"]) + "\n")

    L.append("## 2. Relationship proposals\n")
    L.append("Gold labels: `fixtures/eval/gold_links.json` (authored from the record texts; proposers never read it). "
             "12 records: 6 dev (`cmms`), 6 held-out (`cmms-heldout`), including 4 records where the correct answer "
             "is *no link*. **This is an MVP engineering set, not a statistically meaningful sample.**\n")
    L.append("* `deterministic` = exact serial-number match + a curated alias table (the practical baseline).\n"
             "* `model:fixture` = hand-authored scripted outputs with deliberate faults. It tests the validation and "
             "review mechanics. **It says nothing about real model quality** (the author of the script also wrote "
             "the gold labels).\n"
             "* `model:live` = a real Claude call. " + ("Included below." if r["live_requested"] else
                                                       "**Not executed in this run** (no credentials configured); no live-model quality claim is made.") + "\n")
    L.append("| Split | Method | Recall (gold links found) | False links among valid candidates | Correct no-link | "
             "Records flagged ambiguous | Proposals rejected by validation | Citation validity | Predicate correct |\n"
             "|---|---|---|---|---|---|---|---|---|")
    for split, methods in r["relationships"].items():
        for m, res in methods.items():
            if res.get("status") == "failed":
                L.append(f"| {split} | {m} | run failed: {res.get('error')} | | | | | | |")
                continue
            s = res["summary"]
            L.append(f"| {split} | {m} | {s['recall']} | {s['false_links']} | {s['no_match_correct']}/{s['no_match_cases']} | "
                     f"{s['flagged_ambiguous']} | {s['rejected_by_validation']} | {s['citation_validity']} | "
                     f"{s['predicate_correct']}/{s['predicate_judged']} |")
    L.append("\nPer-record outcomes:\n")
    for split, methods in r["relationships"].items():
        for m, res in methods.items():
            if res.get("status") == "failed":
                continue
            L.append(f"* **{split} / {m}**: " + "; ".join(
                f"{x['record']}→{x['outcome']}" + (f" (invalid: {', '.join(x['invalid_proposals'])})" if x['invalid_proposals'] else "")
                for x in res["per_record"]))
    L.append("\nNot measured: accepted-incorrect links and review time (no human reviewers took part). "
             "Reviewer effort proxy = proposals needing a decision, recorded in `eval/results.json`.\n")

    L.append("## 3. Local timings\n")
    L.append("Wall-clock on this machine, loopback HTTP, SQLite. Each step was measured on a fresh stack, n runs. "
             "These are local development numbers, not a production latency claim.\n")
    L.append("| Step | n | median ms | max ms |\n|---|---|---|---|")
    for k, v in r["timings"].items():
        L.append(f"| {k} | {v['n']} | {v['median']} | {v['max']} |")
    L.append("\n## 4. Readiness gate\n")
    blockers = []
    if t["failed"]:
        blockers.append("test failures")
    L.append("Readiness requires: working consumer, persisted restart/recovery, versioned traceable contracts, visible "
             "ambiguity, independent negative tests, rejected stale/unauthorized mutations, reliable local "
             "activation/rollback; and zero seeded unauthorized effects, duplicate consumer effects or undetected "
             "incompatible activations.\n")
    L.append(f"**Gate result for this run: {'PASS' if not blockers else 'BLOCKED: ' + ', '.join(blockers)}** "
             "(covers exactly the cases above).\n")
    (ROOT / "EVALUATION.md").write_text("\n".join(L) + "\n")


def main():
    live = os.environ.get("LWB_EVAL_LIVE") == "1"
    r = {"generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
         "code_version": code_version(), "python": platform.python_version(), "platform": platform.system(),
         "live_requested": live}
    print("running tests…"); r["tests"] = run_tests()
    print("relationship eval…"); r["relationships"] = relationship_eval(live)
    print("timings…"); r["timings"] = timings()
    (ROOT / "eval").mkdir(exist_ok=True)
    (ROOT / "eval" / "results.json").write_text(json.dumps(r, indent=1))
    write_report(r)
    print(f"tests {r['tests']['ran'] - len(r['tests']['failed'])}/{r['tests']['ran']} passed; wrote EVALUATION.md")


if __name__ == "__main__":
    main()
