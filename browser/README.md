# In-browser build

The in-browser build is the whole app as static files: open the page and the analysis runs
inside the browser tab, with nothing to install and no server. It is published on GitHub
Pages at <https://cal2020.github.io/hello-world-app/ai-cost-inspector/>.

## How it works

The page is the same React app as the desktop version. Instead of sending API requests over
the network, it hands them to a Web Worker that runs the unchanged Python backend in
[Pyodide](https://pyodide.org/), CPython compiled to WebAssembly:

```
page (React)  ──request──▶  worker: Pyodide ─▶ cost_inspector.browser_runtime ─▶ FastAPI app
              ◀─response──                       (ASGI call, no sockets)          │
                                                                                  ▼
                                                IndexedDB ◀── saved after ── SQLite file
                                                               each change   (in memory)
```

- `frontend/src/api/transport.ts` picks the transport. The desktop build uses `fetch`; the
  browser build (`vite build --mode browser`) uses `frontend/src/runtime/bridge.ts`, which
  turns each request into a worker message and each reply back into a standard `Response`.
- `frontend/src/runtime/worker.ts` loads Pyodide, FastAPI, jsonschema and Jinja2, our app
  bundle and KORA Doctor, restores the saved database from IndexedDB, and serves requests one
  at a time. After any request that can change data, it saves the database file back.
- `backend/src/cost_inspector/browser_runtime.py` passes each request to the FastAPI app as
  an ASGI call. Routing, validation, size limits, the client-header check and error handling
  are the production code. Pyodide has no threads, so FastAPI's thread pool is replaced by a
  direct call there.
- Claude Code transcripts are read by the page itself (`frontend/src/features/imports/claude-code.ts`),
  which keeps only model names, token counts and times before handing the result to the
  engine. A 28 MB transcript imports in about 3 seconds.
- A Web Lock lets one tab at a time own the saved data. A second tab says so instead of
  risking one tab overwriting the other's changes.
- The page has a Content Security Policy in a meta tag (GitHub Pages cannot send headers):
  scripts, workers and requests are same-origin only.

## Build, serve and test

```sh
make browser          # build into browser/dist/ai-cost-inspector
make browser-serve    # http://127.0.0.1:8790/ai-cost-inspector/
make browser-e2e      # Playwright suite against the static build, served from a subfolder
```

`make browser` runs `browser/build.py` in the backend environment:

1. Downloads the Pyodide 314.0.7 release tarball from GitHub (337 MB, once; cached in
   `~/.cache/ai-cost-inspector/`) and checks it against a pinned SHA-256.
2. Extracts the runtime files and the 20 wheels the app needs, each checked against the
   SHA-256 in the release's lock file.
3. Builds the web app with relative URLs, so it works from any folder.
4. Bundles `cost_inspector` and KORA Doctor (pinned in `backend/uv.lock`) into `app.zip`.
5. Runs `browser/precompile.mjs`: the same Pyodide boots the app in Node, exercises the
   requests a first visit makes, and compiles every module that got imported to bytecode
   (`bytecode.zip`), so the browser does not compile them from source on each visit.
6. Writes `NOTICES.md`, `licenses/` and `build-manifest.json`, which records the source
   commit, versions and every file's SHA-256.

To test a deployed copy: `E2E_BROWSER_URL=https://…/ai-cost-inspector/ make browser-e2e`.

## Deploying to GitHub Pages

The site is the `gh-pages` branch, shared with other projects. Deploy by replacing only the
`ai-cost-inspector/` folder:

```sh
git worktree add ../gh-pages origin/gh-pages      # once
rm -rf ../gh-pages/ai-cost-inspector
cp -r browser/dist/ai-cost-inspector ../gh-pages/
cd ../gh-pages && git add ai-cost-inspector && git commit -m "Deploy AI Cost Inspector" && git push origin HEAD:gh-pages
```

## Limits of the browser version

- **Startup.** About 6–7 seconds on the test machine, cold or warm cache, because Python
  itself starts inside the page. The first visit downloads about 19 MB.
- **Speed.** Analysis runs about 2–2.5 times slower than native Python: a 2,000-record
  import takes about 4 seconds instead of 1.6.
- **Storage.** Data lives in this browser's IndexedDB. Clearing site data, private windows,
  or the browser evicting storage under pressure remove it; export reports to keep results.
  The app's "Clear data saved in this browser" deletes it on purpose.
- **One tab at a time** can use the saved data.
- **Browser support.** Needs WebAssembly, module workers, IndexedDB and Web Locks: current
  Chrome, Edge, Firefox and Safari. The automated tests run in Chromium only.
