# In-browser build (GitHub Pages)

The same Python workbench runs in the visitor's browser. No server is involved, and there is no shared state: each
visitor gets their own database stored in their browser. That is why the simulated identity menu is harmless on a
public page — nobody can approve anything on anyone else's behalf.

```
build/web/
  index.html, main.js, app.css   page shell; renders HTML returned by the worker; intercepts links and forms
  worker.js                      module Web Worker: Pyodide + OPA Wasm modules + IndexedDB persistence
  app.zip                        workbench/*.py, eval/, fixtures/, schemas/, the Wasm registry, _build_info.py
  opa/registry.json, *.wasm      Rego compiled to WebAssembly at build time, keyed by content digest
  pyodide/                       Pyodide 314.0.7 (Python 3.14) core + the 9 wheels needed for OSCAL validation
  licenses/, THIRD_PARTY_NOTICES.md  license texts for everything shipped (sources and checksums in licenses/SOURCES.md)
  vendor/opa-wasm-browser.esm.js @open-policy-agent/opa-wasm 1.10.0 (evaluates the compiled policies)
  build-manifest.json            git revision, code digest, verified tool hashes, cross-check counts, SHA-256 of every file
```

## How a click becomes a result

1. `main.js` intercepts a link or form and posts `{kind, path, form, actor}` to the worker.
2. The worker calls `WebApp.get`/`WebApp.post` in Python (`workbench/webapp.py`). That is the **same code** the local
   HTTP server (`workbench/server.py`) uses, so all authorization, freshness and review rules run there.
3. When a check needs OPA, `workbench/opa.py` (backend `wasm`) calls `globalThis.dmmcOpa.evaluate(...)`. That runs the
   compiled policy or test rule in `opa-wasm`, synchronously, inside the worker.
4. After every state-changing action the worker flushes the Emscripten filesystem to IndexedDB (`FS.syncfs`).
5. The worker returns the rendered header and main HTML. Every value interpolated into that HTML was escaped in Python.

Only one tab can run the workbench at a time. Each tab keeps its own in-memory copy of the saved state, so two tabs
writing back would overwrite each other. The worker holds an exclusive Web Lock, and a second tab offers to move
the workbench to itself. Moving is a handshake: the second tab asks over a BroadcastChannel, the first tab finishes
whatever it is doing, saves, closes its storage and releases the lock, and only then does the second tab load the
saved state. The second tab takes the lock by force only if the first tab does not answer within 15 seconds: it is
frozen, or busy with one long action (building a package for a very large pasted model can take that long). The first
tab then stops, and what it was still doing is not saved, so it cannot overwrite the new tab's state. Before each save
the worker asks the browser whether it still holds the lock, because a long action delays the lock-lost notice. It
says so on screen. The one exception is a save that had already started when the lock was taken: it completes, the
new tab may load its result, and the first tab says that instead. A tab that has stopped gives the lock up, so the next tab does not wait.

Deleting local data works only in the tab that holds the workbench (whether or not it finished starting). An
unexpected error during startup counts as a failed start. If it comes after the tab has taken the lock, the tab keeps
the lock and offers to delete the saved data, in case that data is the cause. If it comes earlier, the tab never takes
the lock, offers nothing, and the next tab starts normally. After startup, such an error stops the tab and releases
the lock. A tab
that is waiting, has handed over, or has stopped refuses, and so does the main-thread fallback used when the worker
never loaded, if another tab holds the lock. If another page keeps the data open, the page says the deletion is
pending and stops saving. If the browser blocks site storage, the workbench still runs but does not save, and says
so.

## What is live and what was fixed at build time

| Live in the browser | Fixed when the site was built |
|---|---|
| Model import (incl. pasted models), evidence applicability, all checks, drafting, validation, review, staleness, impact, exports, OSCAL schema validation, the 22-case acceptance suite | Compilation of Rego to Wasm: the browser cannot compile Rego |
| OPA **decisions** for any input, e.g. a pasted model's permissions | Which policy bundles exist as Wasm: the reviewed bundle, the variants the acceptance suite creates, and the generated candidate that compiles |
| The 15 independent Rego **test rules**, executed as Wasm entrypoints | **`opa check` verdicts** (compile errors included, such as the candidate that calls `http.send`). These are pinned-CLI results recorded in the registry, shown in the browser as recorded |

If Python asks for a bundle whose content digest was not compiled at build time, the Wasm backend raises
`OpaUnavailable` and the check becomes `ERROR`. It does not guess. Decisions and executed test rules are always
computed live in the browser. What comes from the build is recorded: `opa check` verdicts, and for a test bundle
that failed to compile or has no test rules, that outcome (an error, or an empty suite).

## How the Wasm path is verified (scripts/build_web.py)

0. **Tools and source tree.** The OPA binary must match the pinned SHA-256 and version 1.20.0. Every later step,
   including subprocesses, uses that verified binary. The manifest records where it was found (`OPA_BIN`,
   `.tools/opa` or `PATH`). The vendored `opa-wasm-browser.esm.js` must match its pinned SHA-256. In a git checkout,
   the shipped source files (`workbench/`, `eval/`, `fixtures/`, `schemas/`, the page shell and `web/licenses/`) on
   disk must be exactly the files git tracks. An untracked, ignored or deleted file stops the build, so what steps 1-4
   verify is what step 5 ships.
1. **Record.** The acceptance suite and the scripted demo run on the OPA CLI with `DMMC_OPA_RECORD` set. Every
   bundle, input and CLI result is written down (12 operations over 7 bundles in the last build).
2. **Compile.** Each recorded bundle is compiled with `opa build -t wasm`: the decision entrypoint where decisions
   were evaluated, and every test rule where tests were run. Restricted capabilities are used where the CLI used
   them. The candidate that calls `http.send` is rejected by `opa check`, so there is no Wasm for it.
3. **Cross-check.** Every recorded decision batch and test run is recomputed through Wasm with Node, using the same
   `opa-wasm-browser.esm.js` file the site ships. Pass and fail counts, failed and errored test names, exit codes and
   decision values must be identical, or the build stops. The build reports `opa check` verdicts and suites with
   nothing to execute separately; they are recorded, not recomputed. In the last build: 6 recomputed through Wasm
   and identical (3 decision batches, 3 test runs of 15 rules each); 5 check verdicts and 1 empty suite recorded.
4. **Gate.** The full acceptance suite runs on the Wasm backend and must pass 22 of 22.
5. **Assemble.** Every vendored Pyodide file is checked against a pinned SHA-256: the five core files are pinned
   individually, and the wheels against the pinned `pyodide-lock.json`. License texts are copied to `licenses/`,
   and the build stops if `THIRD_PARTY_NOTICES.md` names a license file that is not there.
6. **Browser end-to-end (`--e2e`).** Serves the built site and runs `tests/web_e2e.cjs` in Chromium, with every
   off-origin request blocked. It covers the five demo steps, denials, candidates, paste import, downloads, OSCAL
   validation, persistence across reload, the in-browser acceptance suite and phone-width layout. It also covers
   the single-tab lock: handover during an action; a forced takeover from a tab busy for longer than 15 seconds,
   whose late result must not be saved; deletion refused in waiting and stopped tabs; and a blocked deletion
   reported as pending. The result is recorded in `build-manifest.json`, and a failure stops the build. The published site
   was built with `--e2e`.

Builds are reproducible for a given source tree: fixed work paths, relative file names inside the Wasm modules, and
fixed timestamps in `app.zip`. `build-manifest.json` records the git revision. It gets a `+local-changes` suffix
when the working tree differs from the commit. Outside a git checkout it is `unknown+unverified`.

## Differences from the local server

- **Clock pinned to 2026-09-23 15:00 UTC**, so the fixture evidence (valid until 2027-06-30) stays applicable for
  visitors. The page says so.
- **SQLite** uses the DELETE journal instead of WAL, because Emscripten has no shared memory for WAL.
- **Acceptance case E13:** the sub-check that holds a lock from a second connection is reported as not applicable.
  File locks are no-ops in the single-threaded browser runtime. The optimistic head check in that case still runs.
- **Live model drafting** is unavailable. The `anthropic` package is not in the browser build, so the button shows
  the distinct failure path (`DraftingError`, no package written).
- **Code digest:** `_build_info.py` is generated into the bundle and excluded from the digest, so the About page's
  code digest can be compared with the source of the same revision.

## Build and test

Requires Python 3.11.4 or later, Node 18+, git (the shipped files must match what git tracks), and Playwright with
Chromium for `--e2e`.

```bash
./scripts/fetch_opa.sh && (cd web && npm ci)
.venv/bin/python scripts/build_web.py --e2e      # downloads Pyodide from its GitHub release once (checksum pinned)
DMMC_OPA_BACKEND=wasm DMMC_WASM_DIR=build/web/opa .venv/bin/python -m unittest tests.test_workbench
```
