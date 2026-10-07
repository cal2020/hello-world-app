# Validation

Measured on 2026-10-07 in a Linux x86_64 container (4 vCPU, kernel 6.18), with Node 22.22.0, git 2.43.0 and Zit 0.1.1 built from crates.io. The container's file system has **no copy-on-write support**, so every workspace was a plain checkout (Zit's documented fallback, detected and shown in the UI). APFS and btrfs/XFS reflink paths were not exercised.

## How to reproduce

```sh
npm ci && npm run setup:zit
npm run build     # typecheck + UI build
npm test          # 57 tests: unit, real-engine integration, browser e2e
```

The integration and end-to-end tests create every repository, `ZIT_HOME` and data directory under a fresh `mkdtemp` directory, and delete it afterwards. They pass `SWITCHYARD_ALLOWED_ROOTS` set to that directory, so they cannot register or touch any other repository. The browser test needs `dist/` (from `npm run build`) and a Chromium. It uses `/opt/pw-browsers/...` or `CHROMIUM_PATH`, and is skipped when either is missing. The integration tests are skipped when Zit is missing.

Latest run: **9 files, 57 tests passed, 30 s wall clock**. The full suite was also run twice in a row with no failures, to check for flakiness.

## Acceptance criteria

| Criterion (from the brief) | Evidence |
|---|---|
| Two independent workspaces in a disposable repository, genuine state after a UI reload | `integration: creates two independent workspaces whose state survives a restart` restarts the server and compares with `zit status` directly. `e2e: accepts a change … after reload` reloads the browser. |
| Conflicting claims refused or surfaced consistently with the engine | `integration: surfaces claim conflicts exactly as Zit decides them` covers same symbol, whole file vs symbol, different symbol (granted), all-or-nothing refusal, and unsafe input rejected before the engine. The demo also shows Zit refusing dana's claim. |
| Changes in separate files reviewed and integrated using engine checks | `integration: integrates changes in separate files through engine checks`: the second change is composed onto the moved current, with checks re-run by Zit. |
| A failing check blocks acceptance and preserves the candidate | `integration: a failing check blocks acceptance and keeps the candidate intact` checks that current is unchanged, the change is still pending, the diff and evidence are available, and a second accept is refused. `e2e: asks for approval … then runs the failing check` checks the Accept button is disabled. |
| Overlap fixture warns correctly without calling every overlap a conflict | `integration: warns about overlap without calling it a conflict …`: a same-file, different-symbol pair is level `file` with no engine verdict and both land. A same-symbol pair becomes a Zit **conflict** once the other side lands. `board.test.ts` covers the pure overlap rules. |
| Repeated clicks or racing requests cannot accept a stale candidate twice; interruptions leave recoverable state | `integration: racing accepts …`: two simultaneous accepts give one `202` and one `409 busy`; a review against an old current gives `409 stale-review`; re-accepting gives `409`. `integration: two accepts of different changes queued at once …`. `integration: cancels a long check …` (cancels in under 8 s; no evidence stored). `integration: marks operations interrupted by a restart …`. |
| Integration tests only against disposable repositories | See *How to reproduce*; `integration: refuses repositories outside the allowed roots and inside Zit's storage`. |
| Show the exact command before first execution; never derive a command from task text | `integration: requires approval of the exact commands …` (a forged approval key is refused) and `integration: a change that declares a new command needs a new approval`. `e2e` exercises the approval dialog. `commands.test.ts` checks that changing a command's text invalidates its approval. |
| Bounded, redacted output | `redact.test.ts`: tokens, keys, URL credentials, private keys, environment secrets, ANSI escapes, size bounds. |
| Explicit action before discarding or disposing; no unrelated files deleted | `integration: requires naming the target …` (wrong or missing confirmation gives `400`; the repository files are untouched after dispose). |
| Disable actions from real engine state; refresh after every mutation | `board.test.ts: enables accept only for an eligible, fully recorded change`. The UI invalidates its queries after every action and polls every 2.5 s. |

Other checks:

- `http.test.ts`: Host allow-list, Origin comparison, the header requirement, JSON-only mutations, and actionable path errors.
- `store.test.ts`: persistence, concurrent updates, refusing a newer schema, migrating version 0.
- Work started outside Switchyard with `zit materialise --session …` appears as a CLI task (`integration: shows work started with the Zit CLI …`).

## Visual inspection

`npm run screenshots` drove Chromium against the running demo. Results are in `docs/screenshots/`:

- 1440×900 dark and light themes: board, inspector (checks and diff tabs), overlaps and checks views.
- 390×844 phone: board and inspector. Measured horizontal page overflow: **0 px**. Lanes stack vertically, and the inspector becomes a full-width sheet with its action bar pinned.

Problems found this way and fixed:

- The translucent inspector was unreadable on phones.
- Lane counters were truncated on phones.
- The overlap list truncated resource names.
- Vite inlined font subsets as `data:` URIs, which the CSP blocked. Inlining is now disabled rather than loosening the CSP.
- A new task's inspector closed itself before the refreshed state arrived. The e2e test caught this.

## Bugs found by the integration tests and fixed

- A task whose change was accepted but whose clean workspace was still open showed as *Editing*. It now shows as *Accepted (workspace still open)*.
- Two simultaneous accept requests could both start a job. Zit's atomic ref update still prevented a double landing, but the request-level guard now reserves the change synchronously.
- Background job bookkeeping could leak unhandled rejections when the data directory disappeared. Store errors during jobs are now caught and logged.

## Not measured or not verified

- No performance targets are given for this project. None are claimed. The `zit status` poll on the 4-task demo was not timed separately.
- Copy-on-write workspace sharing (see above).
- Agents launched by `git zit run` were not run, because no agent credentials were used. The CLI-task path was tested with `zit materialise` and a session id instead.
- macOS was not tested.
- The upstream GitHub repository and getzit.org were not reachable from the build environment. The published crate source (0.1.1) was read instead, and its JSON shapes were verified by running the binary.
