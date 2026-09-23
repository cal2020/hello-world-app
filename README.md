# Evidence-grounded procedure workbench (interview prototype)

A small, working prototype of a system that helps experts **develop and evaluate candidate procedures**. Each step carries its assumptions, supporting evidence, open questions and review status. When a source requirement changes, the system identifies which conclusions need reassessment.

The seed scenario is a **synthetic, non-combat maintenance inspection** of an invented "PSK-7 portable sensor kit". Every device, requirement, record and person is fictional. The prototype demonstrates an engineering workflow similar in shape to tactics, techniques and procedures (TTP) development. It is **not** an Air Force process, a TTP, or a validated procedure, and it approves nothing operationally.

> AI proposes; code checks; qualified reviewers decide. The only states are `DRAFT`, `NEEDS_REVIEW`, `REVIEWED_FOR_DEMO`, `REJECTED` and `STALE`. No state means approved or authorized.

## What is real and what is simulated

| Part | Status |
|---|---|
| Source store, revisions, hashes, manifests | Implemented and tested (SQLite through `node:sqlite`) |
| Deterministic checks (citations, gaps, conflicts, calibration date math, requirement coverage) | Implemented and tested |
| Review state machine, judgments, decisions bound to digest + source manifest, revocation, export gate | Implemented and tested |
| Change-impact analysis | Implemented and tested |
| Idempotent operations, crash-after-commit retry, restart persistence | Implemented and tested at process level |
| **Generator: `fixture`** | **SIMULATED.** A deterministic program that stands in for a model. It includes one seeded error by default. It is not AI. |
| Generator: `baseline` | A deterministic template that serves as the comparison baseline |
| Generator: `anthropic` (Claude via `@anthropic-ai/sdk`) | Implemented but **not exercised**: no credentials in the build environment. Without a key, a run fails explicitly and is never replaced by fixture output. |
| System-model data (`MODEL-PSK7`) | **SIMULATED** hand-written JSON export. No Cameo or other modeling-tool connection. |
| Identities | Four fixed demo tokens. They show an authorization boundary; they are not authentication. |

## Run it

Requires Node.js 22.13 or later (uses built-in `node:sqlite`). No paid service is needed.

```bash
npm install
npm run demo:reset          # fresh DB with the 8 synthetic sources (data/workbench.db)
npm start                   # builds the UI and serves UI + API on http://localhost:8787
```

Development mode: run `npm run server` and `npm run dev` in two terminals. The Vite dev server on :5173 proxies `/api` to :8787.

Other commands:

```bash
npm test                    # 18 tests: workflow, boundaries, crash/retry, restart, eval gate
npm run eval                # runs the evaluation suite; writes docs/EVALUATION_REPORT.md
npm run demo:walkthrough    # prints the full demo path from a fresh in-memory workbench (CLI fallback)
npm run demo:reset -- --stage=draft     # start with a generated first draft
npm run demo:reset -- --stage=reviewed  # start with an accepted candidate, ready for the requirement change
```

To try the live model, set `ANTHROPIC_API_KEY` (optionally `WORKBENCH_MODEL`) before `npm start` and choose "Live model (Claude)". The live path is unverified; see `docs/GAPS.md`.

## Five-minute path

See [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md). In brief:

1. **Sources**: eight synthetic snapshots, each with a stable id, revision and content hash.
2. **Generate**: the draft shows steps, claims, citations, assumptions, a hypothesis, a declared conflict and missing evidence. Accepting it is blocked, and the reasons are listed.
3. **Import the corrected inspection log**: v1 becomes `STALE`. Regenerate; the seeded unsupported step is still there. The reviewer opens the passage, judges the claim unsupported, removes the step (which creates a new version), judges the remaining claims, and accepts.
4. **Import REQ-002 rev B** (calibration window 180 → 90 days): the accepted version becomes `STALE`. The impact view lists the three affected claims and the one affected step, shows calibration PASS → FAIL, and shows that the decision no longer applies. Export-as-reviewed is refused.
5. **Runs & evaluation / History**: run manifests, the evaluation (including an intentionally failing case), and the hash-chained audit log.

## Layout

```
server/            node:http API + services (no framework)
  workbench.js     pipeline, state machine, review gate, impact analysis, export
  checks.js        deterministic validation
  sources.js       immutable snapshots, manifests, permitted retrieval
  ops.js           idempotent operations, demo identities, permissions
  audit.js         append-only hash-chained events
  evaluation.js    evaluation runner
  providers/       fixture (simulated), baseline (template), anthropic (live, optional)
src/workbench/     browser UI (vanilla JS, Vite)
fixtures/          synthetic scenario, inbox changes, evaluation cases and declared criteria
test/              node:test suites
docs/              architecture, demo script, evaluation report, gaps, interview packet
```

The original greeting-card starter app remains available at `/greeting-card.html`.

## Documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, responsibility boundaries, data model
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md): five-minute demonstration
- [`docs/EVALUATION_REPORT.md`](docs/EVALUATION_REPORT.md): generated from actual executed cases
- [`docs/GAPS.md`](docs/GAPS.md): what is simulated, untested, or needs domain expertise
- [`docs/INTERVIEW_PACKET.md`](docs/INTERVIEW_PACKET.md): interview preparation packet
