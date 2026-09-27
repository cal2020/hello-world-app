// Module worker: hosts Pyodide (the workbench's Python code), the Wasm-compiled OPA policies,
// and IndexedDB persistence. The main thread only renders HTML returned from here.
//
// Messages to the main thread:
//   {kind:"progress", text, state}   startup steps
//   {kind:"locked"}                  another tab holds the workbench; waiting for {kind:"takeover"}
//   {kind:"ready", persistent}       ready for requests
//   {kind:"startup-failed", text}    startup failed (the main thread offers to delete saved data)
//   {kind:"fatal", text}             this runtime can no longer serve requests
//   {id, ok, result | error}         reply to a request
import { loadPyodide } from "./pyodide/pyodide.mjs";
import opaWasm from "./vendor/opa-wasm-browser.esm.js"; // the ESM build has only a default export

const { loadPolicy } = opaWasm;
const base = new URL("./", import.meta.url);
const IDB_NAME = "/persist"; // Emscripten's IDBFS names its IndexedDB database after the mount point
const LOCK = "dmmc-workbench-state";
const policies = new Map();
let py = null;
let handle = null;
let persistent = false;
let dead = null;

// Called synchronously from Python (workbench/opa.py, _JsBridge).
self.dmmcOpa = {
  evaluate(module, entrypoint, inputJson) {
    const p = policies.get(module);
    if (!p) throw new Error(`Wasm module not loaded: ${module}`);
    return JSON.stringify(p.evaluate(JSON.parse(inputJson), entrypoint));
  },
};

const post = (m) => self.postMessage(m);
const progress = (text, state = "step") => post({ kind: "progress", text, state });
const errText = (e) => String((e && e.message) || e);

function die(text) {
  if (dead) return;
  dead = text;
  post({ kind: "fatal", text });
}

function syncfs(populate) {
  return new Promise((resolve, reject) => py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve())));
}

async function fetchOk(path) {
  const r = await fetch(new URL(path, base));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r;
}

// --- one live runtime per browser profile ----------------------------------------------
// Each tab has its own in-memory copy of the saved state; two tabs writing back would overwrite
// each other. An exclusive Web Lock makes a second tab wait until the user moves the workbench to it.
let takeover = null;
function acquireLock(steal) {
  if (!self.navigator || !navigator.locks) return Promise.resolve("unsupported");
  return new Promise((resolve) => {
    navigator.locks
      .request(LOCK, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) { resolve("busy"); return undefined; }
        resolve("held");
        return new Promise(() => {}); // hold until this worker ends
      })
      .catch(() => die("The workbench was opened in another tab, so this tab has stopped. Reload to use it here."));
  });
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
  py.unpackArchive(await (await fetchOk("app.zip")).arrayBuffer(), "zip", { extractDir: "/app" });

  let lock = await acquireLock(false);
  for (let i = 0; lock === "busy" && i < 6; i++) {
    // A tab that was just reloaded or closed may still be releasing the lock.
    await new Promise((r) => setTimeout(r, 250));
    lock = await acquireLock(false);
  }
  if (lock === "busy") {
    post({ kind: "locked" });
    await new Promise((r) => { takeover = r; });
    lock = await acquireLock(true);
  }

  progress("Restoring this browser's saved state");
  py.FS.mkdirTree("/persist");
  try {
    py.FS.mount(py.FS.filesystems.IDBFS, {}, "/persist");
    await syncfs(true);
    persistent = true;
  } catch (e) {
    try { py.FS.unmount("/persist"); } catch { /* not mounted */ }
    py.FS.mkdirTree("/persist");
    progress("This browser does not allow this site to save data, so changes last only until the tab is closed", "fail");
  }

  const note =
    "Running entirely in this browser tab. Python runs on Pyodide; " +
    (persistent ? "state is saved only in this browser (IndexedDB). " : "this browser blocks site storage, so state is not saved. ") +
    `OPA decisions and the independent Rego tests execute live from WebAssembly compiled at site build by OPA ${reg.opa_version}; ` +
    "opa check verdicts were recorded at build time. " +
    "The demo clock is pinned to 2026-09-23 15:00 UTC so the fixture evidence stays within its validity window." +
    (lock === "unsupported" ? " This browser cannot stop two tabs from overwriting each other's saved state; use one tab." : "");
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
  if (persistent) await syncfs(false);
  progress("Ready", "done");
  post({ kind: "ready", persistent });
}

const ready = init();
ready.catch((e) => {
  progress(`Startup failed: ${errText(e)}`, "fail");
  post({ kind: "startup-failed", text: errText(e) });
});

// Delete this browser's saved workbench data. Works even when startup failed.
async function wipe() {
  try { if (handle) py.runPython("_app.conn.close()"); } catch { /* already closed */ }
  try {
    const dbs = py && py.FS && py.FS.filesystems.IDBFS.dbs;
    for (const k in dbs || {}) { try { dbs[k].close(); } catch { /* ignore */ } delete dbs[k]; }
  } catch { /* IDBFS never opened */ }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("the saved data is still open in another tab; close it and try again"));
  });
  dead = dead || "Local data deleted. Reload the page to start again.";
}

let queue = Promise.resolve();
self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.kind === "takeover") { if (takeover) takeover(); return; }
  if (msg.kind === "wipe") {
    // Not queued behind startup: this is the way out of a broken saved state.
    wipe().then(() => post({ id: msg.id, ok: true, result: { wiped: true } }),
                (e) => post({ id: msg.id, ok: false, error: errText(e) }));
    return;
  }
  queue = queue.then(async () => {
    try {
      await ready;
    } catch (e) {
      post({ id: msg.id, ok: false, error: `The workbench did not start: ${errText(e)}` });
      return;
    }
    if (dead) { post({ id: msg.id, ok: false, error: dead }); return; }
    let out;
    try {
      const res = handle(msg.kind, msg.path, msg.form ? py.toPy(msg.form) : null, msg.actor, msg.referer || "/");
      out = res.toJs({ dict_converter: Object.fromEntries });
      res.destroy();
    } catch (e) {
      const text = errText(e);
      if (e instanceof RangeError || /fatally failed|can no longer be used/i.test(text)) {
        die(`The in-browser Python runtime crashed (${text.slice(0, 200)}). Reload the page; your last saved state is kept.`);
      }
      post({ id: msg.id, ok: false, error: text });
      return;
    }
    if (msg.kind === "post" && persistent) {
      try { await syncfs(false); } catch (e) { out.warning = `This change could not be saved in the browser: ${errText(e)}`; }
    }
    post({ id: msg.id, ok: true, result: out });
  });
};
