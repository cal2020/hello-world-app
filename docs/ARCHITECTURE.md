# AI Cost Inspector — architecture

AI Cost Inspector is a local tool. It imports AUDR agent-cost telemetry,
shows where a run's money went, explains every optimization *candidate* with
the evidence behind it, and measures the cost difference between two runs.

```
 browser (React)                FastAPI on 127.0.0.1               SQLite (.data/)
 ┌────────────────────┐  /api   ┌──────────────────────────────┐   ┌──────────────┐
 │ imports & runs     │ ──────▶ │ ingest: parse → AUDR schema  │   │ imports      │
 │ summary + timeline │         │   → sink rules → normalize   │──▶│ runs, calls  │
 │ findings           │ ◀────── │ analysis: KORA Doctor adapter│   │ findings     │
 │ evidence inspector │  JSON   │   + evidence + Decimal money │   │ comparisons  │
 │ compare / export   │         │ compare · report · demo      │   └──────────────┘
 └────────────────────┘         └──────────────────────────────┘
```

## Plan (build order)

1. Vertical slice: upload → parse/validate → KORA Doctor analysis → SQLite →
   run view with findings and evidence.
2. Around the slice: dismissal, comparison, reports, deletion, demo seeding.
3. Frontend polish: command palette, responsive layout, accessibility.
4. Validation: unit/integration tests, CLI parity tests, Playwright end to end,
   screenshots at desktop and phone widths, measured performance.

## Components

| Path | Responsibility |
| --- | --- |
| `backend/src/cost_inspector/ingest/parse.py` | Bounded decoding of one JSON object, a JSON array or JSONL. Floats parse as `Decimal`, `NaN`/`Infinity` are rejected, and every record keeps its source line. |
| `backend/src/cost_inspector/ingest/validate.py` | Validates each record against the vendored official AUDR v1.0.0 schema (Draft 2020-12) and turns schema errors into line-specific messages that say how to fix the problem. |
| `backend/src/cost_inspector/ingest/sink.py` | AUDR sink rules (§3.3): exact duplicate `record_id`s are dropped with a note, conflicting ones are errors, corrections replace the record they restate, voids leave the analysis. Shared merge keys and missing `attribution.environment` produce warnings. |
| `backend/src/cost_inspector/ingest/normalize.py` | Converts a record into a `CallRecord`. It drops `user_id`, `account_id`, `subscription_id`, `key_name` and `trace_id`. AUDR has no prompt content, so none can be stored. |
| `backend/src/cost_inspector/analysis/kora.py` | The only module that imports `kora_doctor`. It runs `analyze()` on records rebuilt from stored telemetry and re-derives each finding's evidence with the analyzer's own helpers. When re-derivation disagrees with the analyzer, it says so instead of showing evidence. |
| `backend/src/cost_inspector/money.py` | `Decimal` totals per currency, with unknown costs counted separately and never treated as zero. Includes percent change with an explicit zero-baseline rule. |
| `backend/src/cost_inspector/compare.py` | Compares two runs per scope (all calls / model calls) and per currency. The user's equivalence choice is required. |
| `backend/src/cost_inspector/views.py` | JSON shapes for the API. Lists (import and run views) carry light finding summaries; the full finding (evidence, affected calls, rule, limits, overlaps) is a separate request. Run and finding views load only the rows they show, through the `finding_calls` index. |
| `backend/src/cost_inspector/report.py` | Portable JSON report (versioned) and a self-contained HTML rendering of the same data. Rules and calls are listed once and referenced by category and `call_id`, so large imports do not repeat them per finding. |
| `backend/src/cost_inspector/store.py` | SQLite access, `PRAGMA user_version` migrations, transactional import/delete. |
| `frontend/src` | React 19 + TypeScript + Tailwind 4. Server state goes through TanStack Query. Selection lives in the URL, so a reload restores the view. |

## Data model

Every identifier is stable: it is derived deterministically from the import
and the AUDR identifiers.

- **Import**: one uploaded file. Stores the filename, SHA-256, format, record
  count, warnings, the analyzer revision and a `synthetic` flag.
- **TraceRun**: (`import`, `run.run_id`). Holds the name, run type, outcome and
  time span.
- **CallRecord**: one AUDR record. Holds its `record_id`, source line, ordinal,
  timing, resource, usage counters (`NULL` means *not reported*; `0` means
  *measured zero*), cost as a decimal string plus currency (`NULL` means
  *unknown*), labels and emitter.
- **Finding**: category, the analyzer's title and rationale, confidence,
  affected call IDs, run IDs, evidence (JSON), rule, limitations, the scenario
  ratio, and dismissal state with a note. Its ID is a hash of (import,
  category, affected record IDs, run IDs), so it survives re-analysis.
- **RunComparison**: baseline run, candidate run, the user's equivalence
  answer (`equivalent` / `not_equivalent` / `unsure`) and a note. The result
  is recomputed from stored telemetry each time it is read.

## Integrations

- **KORA Doctor** v0.1.0 at `7c54af8f1ddf891bfd05125fd1c345186c9cd62a`
  (Apache-2.0). Installed unmodified as a pinned git dependency in
  `backend/uv.lock`. Interfaces used: `kora_doctor.analyzer.analyze()`; the
  helpers `_usage_signature`, `_context_text`, `_token_total`,
  `_frontier_model` and the keyword/pattern constants for evidence; and the
  CLI `audit --json`, used only in parity tests.
- **AUDR** v1.0.0 at `95213e30568d4ffcdb4b6861358676778d9d8fd1`
  (Apache-2.0; NOTICE retained). The schema is vendored. The conformance
  fixtures, the multi-emitter example and KORA's samples are test fixtures.

## Labels the UI keeps apart

- **Observed**: values present in the telemetry, such as reported cost and
  token counters.
- **Candidate**: a heuristic flag worth reviewing. It is never shown as waste.
- **Scenario estimate**: KORA Doctor's fixed per-category ratios (100/80/70/
  50/50%). Each call uses only its maximum ratio, so overlapping findings
  never stack.
- **Measured change**: the difference between two recorded runs. It is
  labelled *measured* only when costs are complete and comparable and the
  user marked the runs as equivalent.

## Hardest uncertainties

1. **Evidence is not part of the analyzer's API.** A KORA `Finding` lists only
   record IDs. For repeated calls it omits the first (reference) occurrence.
   The adapter re-derives each group with the analyzer's own private helpers
   at the pinned revision, then checks that the regrouping reproduces the
   analyzer's record IDs exactly. The parity tests fail if the upstream
   changes.
2. **Multi-emitter records.** Records that share `(run_id, span_id)` describe
   one operation. KORA analyzes each record separately. This tool does not
   implement a sink merge; it warns when more than one record in a group
   asserts a cost, because the total could double count.
3. **`timing.event_time` semantics.** The spec text says both "invocation" and
   "completion". The official multi-emitter example treats it as completion,
   so the timeline draws `[event_time − duration_ms, event_time]` and states
   this rule in the UI.
4. **Money.** KORA sums floats. The inspector recomputes every total with
   `Decimal` from the original JSON text. KORA's float totals are used only
   to cross-check in tests.
