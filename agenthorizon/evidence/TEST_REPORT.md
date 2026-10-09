# Test report

Generated from recorded results (`agenthorizon evidence tests`): JUnit files, `evidence/STACK_SMOKE.json` and `evidence/PERFORMANCE.json`. All data exercised here is synthetic test data or the real supplemental imports; no official AgentHorizon item and no live model was available (see REPRODUCTION_REPORT.md).

## Suites

| Suite | Environment | Tests | Passed | Failed | Errors | Skipped | Time (s) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| host pytest | Linux 6.18.44-fc-v114, Python 3.13.16, postgres (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) | 152 | 152 | 0 | 0 | 0 | 123 |
| pytest in the test image | agenthorizon-test image (Ubuntu 24.04, Python 3.12, PostgreSQL 16) as uid 10001 with the judge worker's restrictions: cap_drop ALL, judge seccomp profile, systempaths=unconfined, no-new-privileges | 152 | 147 | 0 | 0 | 5 | 126 |
| Playwright (UI) | Chromium, desktop 1440x900 and Pixel 7 projects, against the e2e server (synthetic fixture, fake endpoint, real supplemental imports) | 10 | 8 | 0 | 0 | 2 | 54 |

## MP §13 required checks

| # | Check | Covering tests (host pytest / pytest in the test image / Playwright (UI)) | Outcome | Note |
| --- | --- | --- | --- | --- |
| 1 | Dataset reconciliation | 2/2 / 2/2 / – | pass | synthetic fixture and a local fake hub; the official release was unreachable (DATA_VALIDATION.json) |
| 2 | Round-trip fidelity | 2/2 / 2/2 / – | pass |  |
| 3 | Preprocessing | 5/5 / 5/5 / – | pass | byte comparison against the released preprocessing code at the pinned commit |
| 4 | Score oracle | 7/7 / 7/7 / – | pass |  |
| 5 | Parsing | 19/19 / 19/19 / – | pass | includes execution of the released parser functions |
| 6 | IDs | 4/4 / 4/4 / – | pass |  |
| 7 | Category scoring | 3/3 / 3/3 / – | pass |  |
| 8 | Leakage (runtime-enforced) | 42/42 / 42/42 / – | pass | also inside the judge container: STACK_SMOKE.json → boundaries |
| 9 | Real model path | 7/7 / 7/7 / – | blocked (adapters pass) | BLOCKED: no provider credentials, no budget and no official data here. The listed tests exercise every adapter with replayed harness outputs and local fake endpoints only |
| 10 | Fault recovery | 15/15 / 15/15 / – | pass | kill/restart a worker, interrupted download, throttling, failed media fetch, cancel, resume |
| 11 | API/UI | 9/9 / 9/9 / 8/10 | pass | synthetic fixture plus the real supplemental imports; screenshots in evidence/screenshots |
| 12 | Performance | – / – / 2/2 | pass | PERFORMANCE.json (release-scale synthetic catalogue); the viewer renders under 60 thumbnails of a 320-step item |
| HF | Hand-calculated score fixture (2 positive, 2 negative) | 2/2 / 2/2 / – | pass |  |

## Skipped

- pytest in the test image: `tests/test_packaging.py::test_compose_trust_boundaries` — needs the repository checkout (images carry src/ and tests/ only)
- pytest in the test image: `tests/test_packaging.py::test_harness_pins_agree_everywhere` — needs the repository checkout (images carry src/ and tests/ only)
- pytest in the test image: `tests/test_packaging.py::test_seccomp_profile_derivation` — needs the repository checkout (images carry src/ and tests/ only)
- pytest in the test image: `tests/test_traceability.py::test_every_reference_resolves` — needs the full repository checkout (container images carry src/ and tests/ only)
- pytest in the test image: `tests/test_traceability.py::test_committed_matrix_and_spec_are_current` — needs the full repository checkout (container images carry src/ and tests/ only)
- Playwright (UI): `frontend/e2e/workbench.spec.ts::experiment setup to monitor, score, results, export [mobile]` — one full run is enough; mobile layout is covered by screenshots
- Playwright (UI): `frontend/e2e/workbench.spec.ts::roles gate navigation and privileged views [mobile]` — role checks are viewport independent

## Failures

None.

## Compose stack smoke test (`docker/smoke.py`)

Result: **passed** (2026-10-09T23:25:39Z). Synthetic fixture and a fake endpoint (TEST ONLY), driven through the real API, workers and CLI.

- `stack_up_s`: 11.6
- `operator`: {"user": "smoke-operator", "role": "operator", "mode": "hosted"}
- `ingest`: {"dataset_version_id": "fixture-synthetic@local-12e2b585e02e+n1", "status": "ingested", "indexed": {"steps": 718, "assets": 718, "examples": 15, "manifests": 3, "gold_labels": 15, "grouping_rows": 15, "dataset_version_id": "fixture-synthetic@local-12e2b585e02e+n1"}}
- `judge_worker_presence`: {"worker_id": "judge@1f2eab29e78a:6", "isolation": {"ok": true, "detail": "user+mount+net+pid namespaces, pivot_root, capability drop"}, "credentials": ["ANTHROPIC_API_KEY"], "harness": {"codex": "codex-cli 0.162.1", "opencode": "1.18.35", "openhands": "OpenHands CLI 1.16.0", "gemini_cli": "0.63.0", "claude_code": "2.1.295 (Claude Code)"}}
- `plan_without_pinned_source`: {"status": 409, "code": "source_unavailable", "message": "pinned source agenthorizon-repo@8584a347370a is not checked out in /data/sources; run `agenthorizon sources checkout agenthorizon-repo` (admin/trusted side)"}
- `pinned_source_copied`: {"source_id": "agenthorizon-repo", "revision": "8584a347370ab1d92b908732cfabe72b3a23486d"}
- `agentic_plans`: {"claude_code": {"config": "claude_code:claude-opus-4.7", "harness_version": "2.1.295 (Claude Code)", "other_blocks": 0}, "codex": {"config": "codex:gpt-5.5", "harness_version": "codex-cli 0.162.1", "other_blocks": 2}, "gemini_cli": {"config": "gemini_cli:gemini-3.1-pro", "harness_version": "0.63.0", "other_blocks": 1}, "opencode": {"config": "opencode:qwen3.6-27b", "harness_version": "1.18.35", "
- `run`: {"run_id": "run-ea1e6ee0fc1e8d43bfce", "status": "completed", "task_states": {"completed": 4}, "classification": "test_fixture"}
- `score`: {"score_id": 1, "manifest_id": "fixture-synthetic@local-12e2b585e02e+n1:full-release"}
- `export`: {"sha256": "3991d90460b1bd55ba90b42daecbe1c8eb7ed3013f0e8c19b85423666c7443cf", "files": 11, "secret_values_found": []}
- `capability_probe`: {"source": "judge worker", "measured_by": "judge@1f2eab29e78a:6", "harness": {"claude_code": {"config": "claude_code:claude-opus-4.7", "installed": true, "version": "2.1.295 (Claude Code)", "isolation": true}, "codex": {"config": "codex:gpt-5.5", "installed": true, "version": "codex-cli 0.162.1", "isolation": true}, "gemini_cli": {"config": "gemini_cli:gemini-3.1-pro", "installed": true, "version"
- `boundaries`: {"judge_private_entries": 0, "trusted_private_entries": 1, "judge_db_private_read": "denied", "judge_cap_eff": "0000000000000000", "judge_docker_socket": "absent", "anthropic_key_present": {"worker-judge": "1", "worker-trusted": "0", "api": "0"}}

## Performance (`evidence/PERFORMANCE.json`)

SYNTHETIC catalogue rows at release scale; latency measurements only — not benchmark data. Scale: {'examples': 1373, 'steps': 129399, 'longest': 420}; database 88 MB; environment: {'cpu': 'Intel(R) Xeon(R) Processor @ 2.80GHz', 'cores': 4, 'python': '3.13.16', 'postgres': '16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)', 'client': 'httpx on the same host (loopback), sequential requests, warm caches'}.

| Request | p50 (ms) | p95 (ms) | max (ms) | target p95 < 500 ms |
| --- | ---: | ---: | ---: | --- |
| catalogue_first_page | 9.15 | 11.91 | 15.64 | met |
| catalogue_text_search | 11.8 | 14.79 | 18.02 | met |
| catalogue_filters | 8.13 | 10.85 | 13.33 | met |
| catalogue_deep_page | 9.45 | 11.52 | 13.46 | met |
| example_detail | 7.06 | 8.72 | 10.39 | met |
| step_window_longest | 12.1 | 16.8 | 18.84 | met |
| facets | 11.32 | 14.98 | 19.32 | met |

First visible trajectory evidence (Playwright, fixture served locally, target < 1500 ms):

- desktop: first thumbnail 194 ms; thumbnails rendered for a 320-step item: 15
- mobile: first thumbnail 213 ms; thumbnails rendered for a 320-step item: 15
