// Module worker: hosts Pyodide (the workbench's Python code), the Wasm-compiled OPA policies,
// and IndexedDB persistence. The main thread only renders HTML returned from here.
import { loadPyodide } from "./pyodide/pyodide.mjs";
import opaWasm from "./vendor/opa-wasm-browser.esm.js"; // the ESM build has only a default export

const { loadPolicy } = opaWasm;

const base = new URL("./", import.meta.url);
const policies = new Map();
let py = null;
let handle = null;

// Called synchronously from Python (workbench/opa.py, _JsBridge).
self.dmmcOpa = {
  evaluate(module, entrypoint, inputJson) {
    const p = policies.get(module);
    if (!p) throw new Error(`Wasm module not loaded: ${module}`);
    return JSON.stringify(p.evaluate(JSON.parse(inputJson), entrypoint));
  },
};

const progress = (text, state = "step") => self.postMessage({ kind: "progress", text, state });

function syncfs(populate) {
  return new Promise((resolve, reject) => py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve())));
}

async function fetchOk(path) {
  const r = await fetch(new URL(path, base));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r;
}

async function init() {
  progress("Loading OPA policies compiled to WebAssembly");
  const reg = await (await fetchOk("opa/registry.json")).json();
  const modules = new Set();
  for (const b of Object.values(reg.bundles)) {
    if (b.tests_module) modules.add(b.tests_module);
    if (b.decision_module) modules.add(b.decision_module);
  }
  for (const m of modules) {
    const p = await loadPolicy(await (await fetchOk(`opa/${m}`)).arrayBuffer());
    p.setData({});
    policies.set(m, p);
  }
  progress(`Loaded ${modules.size} Wasm policy modules (OPA ${reg.opa_version})`, "done");

  progress("Starting Python (Pyodide)");
  py = await loadPyodide({ indexURL: new URL("pyodide/", base).href });
  await py.loadPackage(["regex", "jsonschema"], { messageCallback: () => {} });
  progress(`Python ${py.runPython("import sys; sys.version.split()[0]")} ready`, "done");

  progress("Unpacking workbench code and fixtures");
  const zip = await (await fetchOk("app.zip")).arrayBuffer();
  py.unpackArchive(zip, "zip", { extractDir: "/app" });

  progress("Restoring this browser's saved state");
  py.FS.mkdirTree("/persist");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/persist");
  await syncfs(true);

  const note =
    "Running entirely in this browser tab. Python runs on Pyodide; state is saved only in this browser (IndexedDB). " +
    `OPA decisions and the independent Rego tests execute live from WebAssembly compiled at site build by OPA ${reg.opa_version}. ` +
    "The demo clock is pinned to 2026-09-23 15:00 UTC so the fixture evidence stays within its validity window.";
  py.globals.set("RUNTIME_NOTE", note);
  py.runPython(`
import os, sys
os.environ["DMMC_DATA_DIR"] = "/persist/state"
os.environ["DMMC_WASM_DIR"] = "/app/dmmc-workbench/web-opa"
os.environ["DMMC_OPA_BACKEND"] = "wasm"
os.environ.setdefault("DMMC_NOW", "2026-09-23T15:00:00Z")
sys.path.insert(0, "/app/dmmc-workbench")
from workbench.webapp import WebApp
_app = WebApp(runtime_note=RUNTIME_NOTE)

def _handle(kind, path, form, actor, referer):
    if kind == "get":
        r = _app.get(path, actor)
    else:
        r = _app.post(path, {str(k): str(v) for k, v in form.items()} if form is not None else {}, actor, referer)
    return r.as_dict()
`);
  handle = py.globals.get("_handle");
  await syncfs(false);
  progress("Ready", "done");
}

const ready = init().catch((e) => {
  progress(`Startup failed: ${e && e.message ? e.message : e}`, "fail");
  throw e;
});

let queue = Promise.resolve();
self.onmessage = (ev) => {
  const msg = ev.data;
  queue = queue.then(async () => {
    try {
      await ready;
      if (msg.kind === "wipe") {
        py.runPython("import shutil, os; _app.conn.close(); shutil.rmtree('/persist/state', ignore_errors=True)");
        await syncfs(false);
        self.postMessage({ id: msg.id, ok: true, result: { wiped: true } });
        return;
      }
      const res = handle(msg.kind, msg.path, msg.form ? py.toPy(msg.form) : null, msg.actor, msg.referer || "/");
      const out = res.toJs({ dict_converter: Object.fromEntries });
      res.destroy();
      if (msg.kind === "post") await syncfs(false);
      self.postMessage({ id: msg.id, ok: true, result: out });
    } catch (e) {
      self.postMessage({ id: msg.id, ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
};
