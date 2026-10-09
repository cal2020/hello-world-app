# Validation

What was checked, how, and what the results were. Every number here was measured
on the machine below (on 2026-10-07, and on 2026-10-09 for the in-browser build and Claude
Code transcripts); none is an estimate.

**Machine:** Intel Xeon @ 2.80 GHz, 4 logical CPUs, 15.7 GiB RAM, Linux 6.18
(x86_64). Python 3.13.16 (uv 0.11.32), Node.js 22.22.0 (npm 10.9.4), headless
Chromium from Playwright 1.56.1.

## Checks

| Check | Command | Result |
| --- | --- | --- |
| Backend tests | `make test` (pytest) | 213 passed |
| Frontend tests | `make test` (Vitest) | 28 passed, 6 files |
| End to end | `make e2e` (Playwright, Chromium) | 14 passed |
| Lint and types | `make lint`: ruff, ruff format, mypy (strict), `tsc -b`, ESLint (type-checked) | clean |
| AUDR conformance | `tests/test_validate.py` | the validator agrees with all 38 official conformance cases |
| Analyzer parity | `tests/test_kora_parity.py` | identical findings to the `kora-doctor audit --json` CLI on 7 files |
| Accessibility | axe-core 4.14 (WCAG 2.0–2.2 A/AA and best practices), see below | 0 violations |
| In-browser build | `make browser-e2e` (Playwright, Chromium, static files served from a subfolder) | 8 passed; see [In-browser build](#in-browser-build) |
| Claude Code transcripts | `tests/test_claude_code.py`, `tests/test_pricing.py`, `claude-code.test.ts`, three e2e tests | see [Claude Code transcripts](#claude-code-transcripts) |

The end-to-end suite starts the real server on a throwaway database
(`frontend/e2e/.tmp`) and drives the built app the way a person would.

## Acceptance criteria

| Criterion | How it is verified |
| --- | --- |
| Upstream samples reproduce the CLI's findings | `test_findings_match_cli` imports KORA Doctor's three samples, the AUDR multi-emitter example and the three demo files, then compares category, title, rationale, confidence, record IDs, run IDs and ratio with the CLI's JSON for each finding. `test_rebuilt_records_analyze_like_the_original_file` checks that records rebuilt from storage analyze the same as the original file. `test_analyzer_is_the_pinned_upstream_release` pins version and commit. |
| Invalid JSONL reports the offending line | `test_invalid_jsonl_line_is_reported_with_line_and_column`, `test_upstream_malformed_fixture`, `test_nan_and_infinity_are_rejected_with_line`, `test_invalid_utf8_names_the_line`, `test_messages_name_line_field_and_fix`, the API test `test_invalid_file_is_rejected_with_line_specific_errors`, and the e2e test that uploads a broken file and reads the line numbers in the dialog. |
| A known-cost fixture produces exact totals | `test_known_costs_fixture_produces_exact_total` (decimal totals, no float drift), `test_money_is_stored_as_exact_text`, and `test_demo_matches_documented_totals` against the tables in `backend/src/cost_inspector/demo/README.md`. |
| Missing costs and mixed currencies stay explicit | `test_missing_costs_and_mixed_currencies_stay_explicit`, `test_zero_cost_run_is_complete_not_unknown`, `test_currencies_are_compared_separately`, `test_mixed_fixture_round_trip_through_report`; in the UI, `StatTiles.test.tsx` (unknown is never $0, one line per currency) and `format.test.ts` (currencies are listed, never summed). |
| Clicking a finding shows the right records and the actual evidence | `test_evidence.py` re-derives each kind of evidence (repeated call with its unflagged reference, cross-run reuse, keyword match with offsets, model tier and size, call sequence) and checks that evidence is withheld when re-derivation disagrees with the analyzer. `test_every_finding_has_derived_evidence_and_documented_ratio` covers every finding in the parity files. `test_targeted_views_match_a_full_import_computation` checks that the run and finding views, which load only nearby rows, agree with a computation over the whole import. The e2e test opens a finding and checks its records, evidence, rule and limits on screen. |
| Identical token counts are never described as identical prompts | `test_language.py` scans finding text, rule and limit text, comparison text and all frontend copy for prompt-identity and quality claims. `FindingEvidence.test.tsx` checks the "Matching counters are not proof" statement. |
| Before/after handles a zero or unknown baseline without implying equal quality | `test_zero_baseline_has_no_percentage`, `test_unknown_baseline_cost_is_not_comparable`, `test_unknown_tool_cost_still_allows_model_scope`, `test_not_equivalent_runs_are_an_observed_difference`, `test_equivalence_is_required`, `test_percent_change_rules`, `test_comparison_makes_no_quality_claim`, and `ComparisonResultView.test.tsx`. |
| Import, inspect, dismiss, reload, compare, export and delete work end to end | e2e tests 1–8; the API test `test_full_workflow_survives_reload` restarts the app on the same database. |
| An exported report is understandable without the app | `test_json_report_is_self_explanatory` (glossary, provenance, analyzer revision, rules, dismissal notes, calls referenced by ID), `test_html_report_is_standalone_and_escaped` (no scripts, no external assets, hostile text escaped), `test_report_lists_rules_once_and_html_caps_long_tables`, and the e2e test that downloads both formats and reads them. |
| Demo: two or more synthetic runs with documented costs, a repeated-call pattern, and a measured comparison without a production savings claim | `test_demo_seed_is_idempotent_and_labelled`, `test_demo_matches_documented_totals`, `test_demo_before_after_is_a_measured_change` (−USD 0.0264, −26.63%, labelled synthetic). |

Other requirements:

| Requirement | Verification |
| --- | --- |
| Loopback only; reject cross-origin changes | `test_cli_serve_refuses_public_bind`; `test_mutations_require_client_header_and_same_origin` (missing header, foreign `Origin`, `Sec-Fetch-Site: cross-site`, and a DNS-rebinding `Host` are all refused). Manual check through the Vite proxy: a same-origin write returned 201 and a foreign origin 403. |
| Validate imports; never treat uploaded text as code | `test_upload_limits`, `test_record_limit_is_enforced_before_parsing`, `test_deep_nesting_is_reported_not_raised`, `test_filenames_are_display_safe`, `test_html_report_is_standalone_and_escaped`. |
| Store normalized telemetry only | `test_identity_fields_are_never_stored_or_returned` reads the SQLite file directly. |
| Versioned persistence | `test_schema_version_is_recorded`, `test_newer_database_is_refused`, `test_failed_import_leaves_nothing_behind`. |
| Deleting data | `test_deleting_an_import_removes_its_comparisons`, `test_delete_run_reanalyzes_and_keeps_surviving_dismissals`, `test_cli_seed_reset_and_import`, and the e2e delete test. |
| Responsive layout | The e2e test at 390 × 844 checks that the page never scrolls sideways and that the inspector opens as a sheet that fits the viewport. |
| Keyboard | The e2e command-palette test opens, searches and navigates with the keyboard. The axe audit checks names, roles, labels and keyboard access to scroll regions. |

## Accessibility

axe-core 4.14.0 ran with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`
and `best-practice` rule tags on these states, in light and dark themes unless
noted: the welcome screen (dark), a run with a finding open, a run with a call open,
the comparison, an import overview with mixed currencies, a run with unknown costs,
the import dialog listing errors (dark), the command palette (light), a phone-width
run (light) and finding sheet (dark), and the HTML report.

The first audit found three problems, all now fixed:

- Timeline rows outside the selected finding were dimmed with opacity, which took
  their text to 3.0:1 (dark) and 2.3:1 (light). Now only the bars and icons fade;
  the text stays at the muted text color, which passes.
- Timeline row buttons had an `aria-label` that did not contain their visible text
  (WCAG 2.5.3). The name is now built from the visible text plus screen-reader-only
  context, for example "Step 2 claude-sonnet-4-5, model call, 880 ms, cost $0.0063,
  3 open findings, in the selected finding".
- The list of import errors scrolled but could not be focused, so keyboard users
  could not scroll it. It is now focusable and labelled.

The HTML report's links had no color in dark mode (1.9:1), and its light-theme
"Observed" tag was 4.2:1. Both now pass. The final audit reported no violations,
and the e2e suite now repeats the audit on three screens in both themes.

Motion: every animation and transition is disabled under
`prefers-reduced-motion: reduce`, and no motion is driven from JavaScript.

Not covered: testing with an actual screen reader, Windows High Contrast, and
browsers other than Chromium.

## Visual inspection

Screenshots were taken with Playwright at 1440 × 900 (light and dark) and at
390 × 844 (2× scale) and reviewed for layout, overflow, truncation and contrast.
The final set is in [screenshots/](screenshots/). Reviews led to fixes including:
the inspector sheet hidden off-screen on phones (screen-reader-only text escaping a
scroll container widened the page), a squeezed run header at narrow widths,
signature field names wrapping mid-word, and the timeline contrast issue above.

## Performance

The import limits are 8 MiB and 10,000 records per file. To measure at the limit,
`backend/scripts/generate_large_fixture.py` writes a deterministic synthetic file:
10,000 records, 6,025,488 bytes, 5 runs of 2,000 calls (SHA-256
`6347ccf5ad22c0e4a032d015e5b467af2eb309edf5665d37ec0a5f765c7a74ba`). Its repeated
usage signatures across runs make it a worst case for the analyzer: it produces
5,913 findings, many spanning all five runs.

### API

Method: `backend/scripts/measure_performance.py` against a server on a fresh
database. It times the full HTTP round trip from a local client (urllib over
loopback): 3 imports (each deleted before the next) and 7 requests per read
endpoint.

| Operation | Median | Min | Max | Response |
| --- | ---: | ---: | ---: | ---: |
| Import (upload, validate, analyze, store; 10,000 records) | 7,833 ms | 7,624 ms | 8,162 ms | 3,940 KiB |
| List imports | 113 ms | 92 ms | 122 ms | 8 KiB |
| Import detail (5,913 findings) | 1,224 ms | 1,142 ms | 1,306 ms | 3,940 KiB |
| Run detail (2,000 calls) | 995 ms | 887 ms | 1,048 ms | 3,464 KiB |
| Finding detail, median size (1 call) | 49 ms | 48 ms | 66 ms | 3 KiB |
| Finding detail, largest (1,496 calls) | 197 ms | 170 ms | 228 ms | 655 KiB |
| JSON report | 2,317 ms | 2,288 ms | 2,508 ms | 43,077 KiB |

Where import time goes, from an in-process profile of the same file: AUDR schema
validation about 5.3 s (about 0.5 ms per record, with the same `jsonschema` library
the AUDR reference runner uses), analysis and evidence about 0.5 s, normalization
about 0.5 s, parsing 0.17 s, sink rules 0.3 s, and the rest storage and the response.
The HTML report of this import is 19.3 MB and takes about 3 s to produce.

### Browser

Method: `frontend/scripts/measure-render.mjs` (headless Chromium, 1440 × 900, 5
runs each). "Run visible" is from navigation start until the run heading and the
first call row are in the DOM, including the API request. "Finding open" is from the
click until the evidence section is shown, for the finding with the most calls.

| Run | Run visible (median) | Largest finding open (median) |
| --- | ---: | ---: |
| Demo baseline, 11 calls | 456 ms | 114 ms |
| Synthetic load run, 2,000 calls | 1,638 ms | 560 ms |

### Changes made because of these measurements

- Evidence derivation was indexed by signature and run instead of scanning every
  record per finding: 4.8 s to 0.3 s for this file.
- Lists carry light finding summaries; the full evidence of one finding loads when
  it is opened. Run and finding views load only the rows they show, through the
  `finding_calls` index. A typical finding's API response went from about 1 s to
  49 ms, and opening a finding in the 2,000-call run from about 1.2 s to 0.6 s.
- Long lists in the inspector render 25 rows at a time, and money formatters are
  reused instead of rebuilt for every amount.
- Reports list each rule once and reference calls by ID instead of repeating them
  per finding (59.5 MB to 43 MB for this file), and the report is built from one
  load of the import (3.4 s to 1.6 s of build time).

## In-browser build

The in-browser build (`browser/`) runs the same FastAPI backend in Pyodide 314.0.7 inside a
Web Worker. Checks:

- `tests/test_browser_runtime.py` drives the request shim exactly as the worker does: the
  real API answers, the client-header check still refuses writes without it, uploads keep
  their percent-encoded file names, invalid files get line-numbered errors, reports keep
  their download headers, and data survives a restart on the same database file.
- Under Pyodide itself (Node, the same runtime files), every endpoint returned the same
  status codes as the server, and the demo totals matched the documented values exactly.
- `make browser-e2e` (8 tests) loads the static build from a subfolder in Chromium with no
  server, and checks: startup progress and that no API request reaches the network; the
  demo, evidence and a dismissal note surviving a reload (IndexedDB); comparison, saving
  and both report exports; line-numbered import errors and a valid import; a Claude Code
  transcript import; clearing saved data; the second-tab warning; and a phone-sized
  screen. axe-core reports no violations on the welcome screen, a run with a finding open,
  the transcript import and the second-tab screen.

Performance, measured with headless Chromium against the build served locally (medians of
3 runs each):

| Measure | In-browser build | Desktop version |
| --- | ---: | ---: |
| Startup to the app, empty cache | 6.6 s | — |
| Startup to the app, reload | 6.0 s | — |
| Import 2,000 records through the UI | 4.3 s | 1.6 s (native Python, same file) |
| First-visit download | 19.2 MB (before HTTP compression) | — |

Startup is mostly CPU work, not download: Pyodide itself takes about 3 s to start, and
importing FastAPI about 1 s more even from bytecode. Shipping bytecode compiled at build
time (`browser/precompile.mjs`) cut Python's import time from 3.4 s to 1.7 s; it is
limited to the 257 modules a first visit actually imports (2.1 MB).

## Claude Code transcripts

**Prices.** `backend/src/cost_inspector/pricing.py` holds Anthropic's first-party API list
prices, copied from <https://platform.claude.com/docs/en/about-claude/pricing> on
2026-10-09. `tests/test_pricing.py` checks every listed model against the page's published
multipliers (5-minute writes 1.25×, 1-hour writes 2×, cache reads 0.1× except 0.025× on
Claude Fable 5.1 and Claude Mythos 5.1 and 0.05× on Claude Opus 5.5 and Claude Sonnet 5.5),
plus fast mode, US-only inference (1.1× on Claude 4.6 and later only), Claude Haiku 5.5's
100,000-token threshold, dated model IDs, and that Bedrock and Vertex AI IDs stay unpriced.

**Conversion.** `tests/test_claude_code.py` uses a synthetic transcript
(`tests/fixtures/claude-code/session.jsonl`) with a request logged twice, a Claude Code
error message, a subagent, an unknown model ID, fast mode, web searches, a long prompt, a
saved cost figure and a cut-off last line. It checks: one record per request in time
order; deterministic UUIDv7 record IDs; AUDR token fields (thinking split from output);
per-component costs to the last digit; labels; every import note; that no prompt, reply,
command or path reaches the records; that the page's usage-only copy converts to
byte-identical records (so the same session imports once either way); rejection of
transcripts with no calls or too many; estimated labels in both report formats; and that
estimated runs compare only with estimated runs. `claude-code.test.ts` covers the page's
reader (detection, last-entry-wins in file order, no content, chunked lines). The e2e
tests import the fixture through the dialog in both builds, check what the page sent, and
post the full transcript to the API to confirm it is recognised as the same import.

**A real session.** The transcript of the session that built this feature (28 MB, written
by Claude Code 2.1.292–2.1.296 with Claude Opus 5.5) was converted and compared with the
cost figure Claude Code saved in it. Claude Code last saved its figure after 495 calls:

| For those 495 calls | Claude Code's own figure | This converter |
| --- | ---: | ---: |
| Input tokens | 5,068 | 990 |
| Output tokens (including thinking) | 911,597 | 894,626 |
| Cache read tokens | 210,676,187 | 207,749,150 |
| Cache write tokens | 2,196,303 | 2,188,446 (all 1-hour) |
| Cost | $77.96 | $76.95 (−1.3%) |

The converter's counts are slightly lower in every column, consistent with calls Claude
Code makes but doesn't log as responses in its transcript (the session had two context
compactions and a session-title call). Pricing the 1-hour cache writes at the 5-minute
rate would give $70.39 instead, so the duration split matters.

**Speed.** Importing the same transcript (614 calls by then) through the dialog took 2.7 s
in the desktop version and 3.3 s in the in-browser build, which sent no request to the
network. The first visit to the in-browser build still downloads 19.2 MB.

## Not verified

- openaudr.dev was unreachable from the build environment (the proxy refused it),
  so the AUDR schema and conformance cases come from the
  [openaudr/audr](https://github.com/openaudr/audr) repository at commit
  `95213e30568d4ffcdb4b6861358676778d9d8fd1`.
- Firefox, Safari and Windows were not tested.
- Claude Code transcripts were checked against versions 2.1.292–2.1.296 only; the format is
  internal to Claude Code and could change. Subscription billing was not compared, since
  transcripts don't record it.
- Performance was measured on one machine.
- The published GitHub Pages copy could not be loaded from the build environment (its
  network policy blocks `github.io`). The deployed files are the tested build, verified
  through the GitHub API.
