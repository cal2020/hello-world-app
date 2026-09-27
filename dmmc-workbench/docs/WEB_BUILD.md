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
  vendor/opa-wasm-browser.esm.js @open-policy-agent/opa-wasm 1.10.0 (evaluates the compiled policies)
  build-manifest.json            git revision, code digest, pinned versions and checksums, SHA-256 of every file
  THIRD_PARTY_NOTICES.md
```

## How a click becomes a result

1. `main.js` intercepts a link or form and posts `{kind, path, form, actor}` to the worker.
2. The worker calls `WebApp.get`/`WebApp.post` in Python (`workbench/webapp.py`): the **same code** the local HTTP
   server (`workbench/server.py`) uses. All authorization, freshness and review rules run there.
3. When a check needs OPA, `workbench/opa.py` (backend `wasm`) calls `globalThis.dmmcOpa.evaluate(...)`, which runs
   the compiled policy or test rule in `opa-wasm`, synchronously, inside the worker.
4. After every state-changing action the worker flushes the Emscripten filesystem to IndexedDB (`FS.syncfs`).
5. The worker returns the rendered header and main HTML. Every interpolated value was escaped in Python.

## What is live and what was fixed at build time

| Live in the browser | Fixed when the site was built |
|---|---|
| Model import (incl. pasted models), evidence applicability, all checks, drafting, validation, review, staleness, impact, exports, OSCAL schema validation, the 22-case acceptance suite | Compilation of Rego to Wasm (the browser cannot compile Rego) |
| OPA **decisions** for any input (e.g. a pasted model's permissions) | The set of policy bundles that exist as Wasm: the reviewed bundle, the variants the acceptance suite creates, the two candidate policies |
| The 15 independent Rego **test rules**, executed as Wasm entrypoints | `opa check` verdicts for those bundles (recorded from the pinned CLI) |

If Python asks for a bundle whose content digest was not compiled at build time, the Wasm backend raises
`OpaUnavailable` and the check becomes `ERROR`. It never guesses and never falls back to recorded results.

## How the Wasm path is verified (scripts/build_web.py)

1. **Record.** The acceptance suite and the scripted demo run on the pinned OPA CLI (1.20.0, SHA-256 verified) with
   `DMMC_OPA_RECORD` set. Every bundle, input and CLI result is written down.
2. **Compile.** Each recorded bundle is compiled with `opa build -t wasm`. Restricted capabilities are used where the
   CLI used them (candidates), so a candidate calling `http.send` fails to compile in both paths.
3. **Cross-check.** Every recorded CLI result (check, test counts and failed test names, decision outputs) is
   recomputed through Wasm, using Node and the same `opa-wasm` library as the browser. Any difference stops the build.
   Last build: 12 of 12 identical.
4. **Gate.** The full acceptance suite runs on the Wasm backend. It must pass 22 of 22.
5. **Browser end-to-end** (`tests/web_e2e.cjs`, 35 checks). Drives the real UI in Chromium with every off-origin
   request blocked: the five demo steps, denials, candidates, paste import, downloads, OSCAL validation,
   persistence across reload, the in-browser acceptance suite, and phone-width layout.

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

```bash
./scripts/fetch_opa.sh && (cd web && npm ci)
.venv/bin/python scripts/build_web.py            # downloads Pyodide from its GitHub release once (checksum pinned)
python3 -m http.server -d build/web 8822 &
NODE_PATH=$(npm root -g) node tests/web_e2e.cjs http://127.0.0.1:8822/
DMMC_OPA_BACKEND=wasm DMMC_WASM_DIR=build/web/opa .venv/bin/python -m unittest tests.test_workbench
```
