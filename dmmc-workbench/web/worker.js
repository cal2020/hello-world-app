// Module worker: hosts Pyodide (the workbench's Python code), the Wasm-compiled OPA policies,
// and IndexedDB persistence. The main thread only renders HTML returned from here.
//
// Messages to the main thread:
//   {kind:"progress", text, state}   startup steps
//   {kind:"locked"}                  another tab holds the workbench; waiting for {kind:"takeover"}
//   {kind:"ready", persistent}       ready for requests
//   {kind:"startup-failed", text}    startup failed (the main thread offers to delete saved data)
//   {kind:"fatal", text}             this runtime has stopped serving requests
//   {id, ok, result | error}         reply to a request
//
// One live runtime per browser profile: each tab keeps its own in-memory copy of the saved state, so
// two tabs writing back would overwrite each other. The runtime holds an exclusive Web Lock. A second
// tab asks the holder (over a BroadcastChannel) to hand over; the holder finishes its queued work,
// saves, closes its storage and releases the lock, and only then does the new tab load the saved
// state. Stealing the lock is only a fallback for a holder that does not answer (frozen or crashed).
import { loadPyodide } from "./pyodide/pyodide.mjs";
import opaWasm from "./vendor/opa-wasm-browser.esm.js"; // the ESM build has only a default export

const { loadPolicy } = opaWasm;
const base = new URL("./", import.meta.url);
const IDB_NAME = "/persist"; // Emscripten's IDBFS names its IndexedDB database after the mount point
const LOCK = "dmmc-workbench-state";
const HANDOVER_TIMEOUT_MS = 15000;
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("dmmc-workbench") : null;
const policies = new Map();
let py = null;
let handle = null;
let persistent = false;
let lockState = "none"; // none | held | unsupported | lost
let releaseHeld = null;
let waiting = false; // showing "open in another tab"
let stopped = null; // text once this runtime has stopped serving requests

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

function stop(text) {
  if (stopped) return;
  stopped = text;
  closeStorage();
  post({ kind: "fatal", text });
}

function idbfsDbs() {
  try { return (py && py.FS && py.FS.filesystems.IDBFS.dbs) || {}; } catch { return {}; }
}

function closeStorage() {
  const dbs = idbfsDbs();
  for (const k of Object.keys(dbs)) { try { dbs[k].close(); } catch { /* ignore */ } delete dbs[k]; }
}

// Make every IndexedDB connection this runtime opens give way to a delete from elsewhere.
function guardStorage() {
  const dbs = idbfsDbs();
  for (const k of Object.keys(dbs)) {
    const db = dbs[k];
    if (db.__guarded) continue;
    db.__guarded = true;
    db.onversionchange = () => {
      try { db.close(); } catch { /* ignore */ }
      delete dbs[k];
      if (lockState === "held" || lockState === "unsupported") {
        stop("This browser's saved workbench data was deleted from another tab, so this tab has stopped. Reload to start again.");
      }
    };
  }
}

function syncfs(populate) {
  return new Promise((resolve, reject) => py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve())))
    .then(() => guardStorage());
}

async function fetchOk(path) {
  const r = await fetch(new URL(path, base));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r;
}

// --- the single-runtime lock -------------------------------------------------------------
function acquireLock(mode) { // "try" | "wait" | "steal" -> "held" | "busy" | "timeout" | "unsupported"
  if (!self.navigator || !navigator.locks) return Promise.resolve("unsupported");
  return new Promise((resolve) => {
    let granted = false;
    let opts;
    if (mode === "try") opts = { ifAvailable: true };
    else if (mode === "steal") opts = { steal: true };
    else opts = typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(HANDOVER_TIMEOUT_MS) } : {};
    navigator.locks
      .request(LOCK, opts, (lock) => {
        if (!lock) { resolve("busy"); return undefined; }
        granted = true;
        lockState = "held";
        resolve("held");
        return new Promise((r) => { releaseHeld = r; });
      })
      .catch((e) => {
        if (granted) { // stolen by an unanswered takeover: never write again
          lockState = "lost";
          stop("The workbench was opened in another tab, so this tab has stopped. Reload to use it here.");
        } else if (mode === "wait" && e && (e.name === "TimeoutError" || e.name === "AbortError")) {
          resolve("timeout");
        } else { // e.g. SecurityError when the browser blocks site storage: run without the lock
          resolve("unsupported");
        }
      });
  });
}

if (channel) {
  channel.onmessage = (ev) => {
    if (!ev.data || ev.data.type !== "takeover-request" || lockState !== "held" || stopped) return;
    // Queued behind any request in progress, so its result is saved before the other tab loads.
    queue = queue.then(() => {
      stop("The workbench was moved to another tab, so this tab has stopped. Reload to use it here.");
      lockState = "none";
      if (releaseHeld) releaseHeld();
    });
  };
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

  let lock = await acquireLock("try");
  for (let i = 0; lock === "busy" && i < 6; i++) {
    // A tab that was just reloaded or closed may still be releasing the lock.
    await new Promise((r) => setTimeout(r, 250));
    lock = await acquireLock("try");
  }
  if (lock === "busy") {
    waiting = true;
    post({ kind: "locked" });
    await new Promise((r) => { takeoverRequested = r; });
    progress("Asking the other tab to save and hand over");
    if (channel) {
      channel.postMessage({ type: "takeover-request" });
      lock = await acquireLock("wait");
    }
    if (!channel || lock === "timeout") {
      progress("The other tab did not answer; taking over", "fail");
      lock = await acquireLock("steal");
    }
    waiting = false;
  }
  if (lock !== "held") lockState = "unsupported";

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
    (persistent && lockState === "unsupported" ? " This browser cannot stop two tabs from overwriting each other's saved state; use one tab." : "");
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

let takeoverRequested = null;
let queue = Promise.resolve();
const ready = init();
ready.catch((e) => {
  progress(`Startup failed: ${errText(e)}`, "fail");
  post({ kind: "startup-failed", text: errText(e) });
});

function mayWrite() {
  return persistent && !stopped && (lockState === "held" || lockState === "unsupported");
}

// Delete this browser's saved workbench data. Only the runtime that holds the workbench (or one that
// failed to start) does this, so no other tab can be writing at the same time.
async function wipe() {
  if (waiting) throw new Error("The workbench is open in another tab. Use it in this tab first, then delete.");
  closeStorage();
  const outcome = await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    let blockedTimer = null;
    req.onsuccess = () => { clearTimeout(blockedTimer); resolve("deleted"); };
    req.onerror = () => { clearTimeout(blockedTimer); reject(req.error || new Error("delete failed")); };
    // Other connections normally close themselves on versionchange. If one does not, the delete stays
    // queued by the browser and completes when that tab closes: say so, and stop saving here.
    req.onblocked = () => { blockedTimer = setTimeout(() => resolve("pending"), 5000); };
  });
  stop(outcome === "deleted"
    ? "Local data deleted. Reload the page to start again."
    : "Deletion is waiting for another tab of this site to close; it will complete then. This tab has stopped so that nothing new is saved and then deleted.");
  return outcome;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.kind === "takeover") { if (takeoverRequested) takeoverRequested(); return; }
  if (msg.kind === "wipe") {
    if (waiting) { // another tab holds the workbench; deleting underneath it would lose its work
      post({ id: msg.id, ok: false, error: "The workbench is open in another tab. Use it in this tab first, then delete." });
      return;
    }
    // Queued behind any request in progress, but not behind startup: this is also the way out of a
    // saved state that makes startup fail.
    const run = () => wipe().then((outcome) => post({ id: msg.id, ok: true, result: { outcome } }),
                                  (e) => post({ id: msg.id, ok: false, error: errText(e) }));
    ready.then(() => { queue = queue.then(run); }, run);
    return;
  }
  queue = queue.then(async () => {
    try {
      await ready;
    } catch (e) {
      post({ id: msg.id, ok: false, error: `The workbench did not start: ${errText(e)}` });
      return;
    }
    if (stopped) { post({ id: msg.id, ok: false, error: stopped, stopped: true }); return; }
    let out;
    try {
      const res = handle(msg.kind, msg.path, msg.form ? py.toPy(msg.form) : null, msg.actor, msg.referer || "/");
      out = res.toJs({ dict_converter: Object.fromEntries });
      res.destroy();
    } catch (e) {
      const text = errText(e);
      if (e instanceof RangeError || /fatally failed|can no longer be used/i.test(text)) {
        stop(`The in-browser Python runtime crashed (${text.slice(0, 200)}). Reload the page; your last saved state is kept.`);
        post({ id: msg.id, ok: false, error: stopped, stopped: true });
        return;
      }
      post({ id: msg.id, ok: false, error: text });
      return;
    }
    if (msg.kind === "post" && mayWrite()) {
      try { await syncfs(false); } catch (e) { out.warning = `This change could not be saved in the browser: ${errText(e)}`; }
    } else if (msg.kind === "post" && persistent) {
      out.warning = "This tab no longer holds the workbench, so this change was not saved.";
    }
    post({ id: msg.id, ok: true, result: out });
  });
};
