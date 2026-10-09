"""TEST_REPORT.md from recorded results only: JUnit files (host pytest, the suite inside the test image, Playwright),
the Compose smoke run and the performance measurement. Each MP §13 required check is mapped to the tests that cover
it and reported with their recorded outcomes; checks that cannot run here say so and why."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Case:
    id: str
    outcome: str  # passed | failed | error | skipped
    time: float
    message: str = ""


def read_junit(path: Path) -> list[Case]:
    root = ET.parse(path).getroot()
    out = []
    for suite in root.iter("testsuite"):
        project = suite.get("hostname") if suite.get("name", "").endswith(".ts") else None
        for tc in suite.iter("testcase"):
            cls, name = tc.get("classname", ""), tc.get("name", "")
            if project:  # Playwright: one suite per project
                cid = f"frontend/e2e/{cls}::{name} [{project}]"
            else:
                mod = cls.replace(".", "/")
                cid = f"{mod if mod.startswith('tests/') else 'tests/' + mod}.py::{name}"
            outcome, msg = "passed", ""
            for tag in ("failure", "error", "skipped"):
                el = tc.find(tag)
                if el is not None:
                    outcome = {"failure": "failed", "error": "error", "skipped": "skipped"}[tag]
                    msg = (el.get("message") or el.text or "").strip()
                    if tag == "skipped":
                        prop = tc.find("properties/property[@name='skip']")
                        msg = msg or (prop.get("value") if prop is not None else "")
                    break
            out.append(Case(cid, outcome, float(tc.get("time") or 0), msg))
    return out


# MP §13 required checks -> covering tests (prefix match: parametrized cases count individually)
CHECKS: list[tuple[str, str, list[str], str]] = [
    ("1", "Dataset reconciliation", ["tests/test_ingest.py::test_local_ingest_is_idempotent_and_complete",
                                     "tests/test_ingest.py::test_hf_ingest_metadata_then_lazy_media_with_faults"],
     "synthetic fixture and a local fake hub; the official release was unreachable (DATA_VALIDATION.json)"),
    ("2", "Round-trip fidelity", ["tests/test_ingest.py::test_local_ingest_is_idempotent_and_complete",
                                  "tests/test_supplemental.py::test_arb_trajectories_become_a_separate_scorable_dataset"], ""),
    ("3", "Preprocessing", ["tests/test_direct.py::test_payload_byte_identical_to_released_preprocessing",
                            "tests/test_direct.py::test_mosaic_row_major_order_padding_and_originals_untouched",
                            "tests/test_direct.py::test_long_trajectory_never_truncated"],
     "byte comparison against the released preprocessing code at the pinned commit"),
    ("4", "Score oracle", ["tests/test_scoring.py::test_score_oracles", "tests/test_scoring.py::test_balanced_accuracy_is_exact_fraction",
                           "tests/test_scoring.py::test_selection_subset_is_labelled_and_canonical_counts_missing"], ""),
    ("5", "Parsing", ["tests/test_parsing.py::"], "includes execution of the released parser functions"),
    ("6", "IDs", ["tests/test_scoring.py::test_duplicate_unknown_and_version_mismatch_are_rejected",
                  "tests/test_scoring.py::test_out_of_manifest_predictions_are_ignored_not_counted",
                  "tests/test_runs.py::test_crash_recovery_records_interrupted_and_never_duplicates_finals"], ""),
    ("7", "Category scoring", ["tests/test_scoring.py::test_category_scoring_requires_valid_failure_and_exact_match",
                               "tests/test_scoring.py::test_fuzzy_category_strings_are_not_matched",
                               "tests/test_ingest.py::test_untyped_negative_stays_untyped_and_manifests_score"], ""),
    ("8", "Leakage (runtime-enforced)", ["tests/test_isolation.py::", "tests/test_leakage.py::",
                                         "tests/test_app.py::test_catalogue_responses_never_carry_labels",
                                         "tests/test_app.py::test_capability_probe_runs_on_a_judge_worker_and_never_carries_secret_values"],
     "also inside the judge container: STACK_SMOKE.json → boundaries"),
    ("9", "Real model path", ["tests/test_agentic_replay.py::", "tests/test_runs.py::test_agentic_run_end_to_end_in_sandbox_and_scored",
                              "tests/test_runs.py::test_direct_run_end_to_end_against_fake_endpoint_and_scored"],
     "BLOCKED: no provider credentials, no budget and no official data here. The listed tests exercise every adapter "
     "with replayed harness outputs and local fake endpoints only"),
    ("10", "Fault recovery", ["tests/test_runs.py::test_crash_recovery_records_interrupted_and_never_duplicates_finals",
                              "tests/test_runs.py::test_killed_worker_process_resumes_without_duplicates",
                              "tests/test_runs.py::test_cancel_stops_running_attempts_and_resume_completes",
                              "tests/test_runs.py::test_pause_lets_running_attempts_finish",
                              "tests/test_runs.py::test_budget_reservation_pauses_and_resume_with_higher_budget",
                              "tests/test_runs.py::test_blocked_pauses_run_instead_of_mass_missing",
                              "tests/test_ingest.py::test_hf_ingest_metadata_then_lazy_media_with_faults",
                              "tests/test_direct.py::test_openai_compatible_wire_payload_and_error_mapping",
                              "tests/test_app.py::test_job_lease_expiry_reclaim_and_owner_checks"],
     "kill/restart a worker, interrupted download, throttling, failed media fetch, cancel, resume"),
    ("11", "API/UI", ["tests/test_app.py::", "tests/test_cli.py::", "frontend/e2e/workbench.spec.ts::"],
     "synthetic fixture plus the real supplemental imports; screenshots in evidence/screenshots"),
    ("12", "Performance", ["frontend/e2e/workbench.spec.ts::coverage, explorer, inspection, pair views"],
     "PERFORMANCE.json (release-scale synthetic catalogue); the viewer renders under 60 thumbnails of a 320-step item"),
    ("HF", "Hand-calculated score fixture (2 positive, 2 negative)",
     ["tests/test_scoring.py::test_hand_fixture_two_positive_two_negative",
      "tests/test_reference_crosscheck.py::test_hand_fixture_divergence_is_documented"], ""),
]


def _covers(prefix: str, case_id: str) -> bool:
    """``file::`` covers the whole file; ``file::name`` covers that test, its parameters and its Playwright projects."""
    if prefix.endswith("::"):
        return case_id.startswith(prefix)
    return case_id == prefix or case_id.startswith(prefix + "[") or case_id.startswith(prefix + " [")


def _matches(cases: list[Case], prefixes: list[str]) -> list[Case]:
    return [c for c in cases if any(_covers(p, c.id) for p in prefixes)]


def _counts(cases: list[Case]) -> dict[str, int]:
    out = {"passed": 0, "failed": 0, "error": 0, "skipped": 0}
    for c in cases:
        out[c.outcome] += 1
    return out


def render(suites: dict[str, tuple[str, list[Case]]], smoke: dict | None, perf: dict | None,
           timing: dict[str, dict] | None = None) -> str:
    lines = ["# Test report", "",
             "Generated from recorded results (`agenthorizon evidence tests`): JUnit files, `evidence/STACK_SMOKE.json` "
             "and `evidence/PERFORMANCE.json`. All data exercised here is synthetic test data or the real supplemental "
             "imports; no official AgentHorizon item and no live model was available (see REPRODUCTION_REPORT.md).", "",
             "## Suites", "", "| Suite | Environment | Tests | Passed | Failed | Errors | Skipped | Time (s) |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for label, (env, cases) in suites.items():
        k = _counts(cases)
        lines.append(f"| {label} | {env} | {len(cases)} | {k['passed']} | {k['failed']} | {k['error']} | {k['skipped']} | "
                     f"{sum(c.time for c in cases):.0f} |")
    lines += ["", "## MP §13 required checks", "",
              "| # | Check | Covering tests (" + " / ".join(suites) + ") | Outcome | Note |", "| --- | --- | --- | --- | --- |"]
    for num, name, prefixes, note in CHECKS:
        cells, outcome = [], "pass"
        for _label, (_env, cases) in suites.items():
            m = _matches(cases, prefixes)
            k = _counts(m)
            cells.append(f"{k['passed']}/{len(m)}" if m else "–")
            if k["failed"] or k["error"]:
                outcome = "**FAIL**"
        if not any(_matches(cases, prefixes) for _e, cases in suites.values()):
            outcome = "not run"
        if num == "9":
            outcome = "blocked (adapters " + ("pass" if outcome == "pass" else outcome) + ")"
        lines.append(f"| {num} | {name} | {' / '.join(cells)} | {outcome} | {note} |")
    skipped = [(label, c) for label, (_e, cases) in suites.items() for c in cases if c.outcome == "skipped"]
    failed = [(label, c) for label, (_e, cases) in suites.items() for c in cases if c.outcome in ("failed", "error")]
    lines += ["", "## Skipped", ""] + ([f"- {label}: `{c.id}` — {c.message or 'no reason recorded'}" for label, c in skipped]
                                       or ["None."])
    lines += ["", "## Failures", ""] + ([f"- {label}: `{c.id}` — {c.message[:300]}" for label, c in failed] or ["None."])
    if smoke:
        st = smoke.get("steps", {})
        lines += ["", "## Compose stack smoke test (`docker/smoke.py`)", "",
                  f"Result: **{'passed' if smoke.get('passed') else 'FAILED'}** ({smoke.get('generated_at')}). "
                  "Synthetic fixture and a fake endpoint (TEST ONLY), driven through the real API, workers and CLI.", ""]
        for k, v in st.items():
            lines.append(f"- `{k}`: {json.dumps(v)[:400]}")
        if smoke.get("error"):
            lines.append(f"- error: {smoke['error'][:500]}")
    if perf:
        lines += ["", "## Performance (`evidence/PERFORMANCE.json`)", "",
                  f"{perf.get('warning', '')}. Scale: {perf.get('scale')}; database {perf.get('database_size_bytes', 0) / 1e6:.0f} MB; "
                  f"environment: {perf.get('environment')}.", "",
                  "| Request | p50 (ms) | p95 (ms) | max (ms) | target p95 < 500 ms |", "| --- | ---: | ---: | ---: | --- |"]
        for name, r in perf.get("results", {}).items():
            lines.append(f"| {name} | {r['p50_ms']} | {r['p95_ms']} | {r['max_ms']} | {'met' if r['p95_ms'] < 500 else 'NOT met'} |")
    if timing:
        lines += ["", "First visible trajectory evidence (Playwright, fixture served locally, target < 1500 ms):", ""]
        for project, t in timing.items():
            lines.append(f"- {project}: first thumbnail {t.get('first_visible_thumbnail_ms')} ms; thumbnails rendered for a "
                         f"320-step item: {t.get('thumbnails_rendered')}")
    return "\n".join(lines) + "\n"
