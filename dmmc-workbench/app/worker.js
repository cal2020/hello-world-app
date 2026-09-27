// Module worker: hosts Pyodide (the workbench's Python code), the Wasm-compiled OPA policies,
// and IndexedDB persistence. The main thread only renders HTML returned from here.
//
// Messages to the main thread:
//   {kind:"progress", text, state}   startup steps
//   {kind:"locked"}                  another tab holds the workbench; waiting for {kind:"takeover"}
//   {kind:"ready", persistent}       ready for requests
//   {kind:"startup-failed", text, canWipe}  startup failed (canWipe: this tab may delete the saved data)
//   {kind:"fatal", text}             this runtime has stopped serving requests
//   {id, ok, result | error}         reply to a request
//
// One live runtime per browser profile: each tab keeps its own in-memory copy of the saved state, so
// two tabs writing back would overwrite each other. The runtime holds an exclusive Web Lock. A second
// tab asks the holder (over a BroadcastChannel) to hand over; the holder finishes its queued work,
// saves, closes its storage and releases the lock, and only then does the new tab load the saved
// state. Stealing the lock is only a fallback for a holder that does not answer within 15 s (frozen, or
// busy with one long action). A holder whose lock was stolen never saves again, and a stopped runtime
// gives the lock up, so the next tab does not have to wait.
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
let myClientId = null; // this runtime's id in navigator.locks.query(), to tell if the lock was stolen
let waiting = false; // showing "open in another tab"
let stopped = null; // text once this runtime has stopped serving requests
let storageBusy = null; // settles when the FS.syncfs in flight (if any) has finished
let serving = false; // startup finished and "ready" was posted
let startupError = null; // an uncaught error during startup: startup is abandoned
let failStartup = null;
const startupAborted = new Promise((_, reject) => { failStartup = reject; });
startupAborted.catch(() => {});
function alive() { if (startupError) throw startupError; }

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

const STOLEN = "The workbench was opened in another tab, so this tab has stopped. Anything this tab was " +
  "still doing when that happened was not saved. Reload to use it here.";

const STOLEN_MID_SAVE = "The workbench was opened in another tab, so this tab has stopped. Its last change was " +
  "being saved at that moment, so it may appear in the other tab. Reload to use it here.";

// Stop serving for good. Storage is closed and the lock given up only once no save is in flight:
// closing an IDBFS connection in the middle of FS.syncfs throws inside IndexedDB callbacks.
function stop(text) {
  if (stopped) return;
  stopped = text;
  post({ kind: "fatal", text });
  storageIdle().then(() => { closeStorage(); releaseLock(); });
}

function releaseLock() {
  if (lockState === "held") lockState = "none";
  if (releaseHeld) { const r = releaseHeld; releaseHeld = null; r(); }
}

function idbfsDbs() {
  try { return (py && py.FS && py.FS.filesystems.IDBFS.dbs) || {}; } catch { return {}; }
}

function closeStorage() {
  const dbs = idbfsDbs();
  for (const k of Object.keys(dbs)) { try { dbs[k].close(); } catch { /* ignore */ } delete dbs[k]; }
}

// Make every IndexedDB connection this runtime opens give way to a delete from elsewhere (after any
// save in flight has finished).
function guardStorage() {
  const dbs = idbfsDbs();
  for (const k of Object.keys(dbs)) {
    const db = dbs[k];
    if (db.__guarded) continue;
    db.__guarded = true;
    db.onversionchange = () => {
      if (!stopped && (lockState === "held" || lockState === "unsupported")) {
        stop("This browser's saved workbench data was deleted from another tab, so this tab has stopped. Reload to start again.");
      }
      storageIdle().then(() => { try { db.close(); } catch { /* ignore */ } if (dbs[k] === db) delete dbs[k]; });
    };
  }
}

function syncfs(populate) {
  const p = new Promise((resolve, reject) => py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve())));
  const settled = p.then(() => {}, () => {});
  storageBusy = settled;
  settled.then(() => { if (storageBusy === settled) storageBusy = null; });
  return p.then(() => guardStorage());
}

// Resolves once no save or load is in flight (or after a generous limit, should one never settle).
function storageIdle() {
  return storageBusy ? Promise.race([storageBusy, new Promise((r) => setTimeout(r, 30000))]) : Promise.resolve();
}

// Whether this runtime may still save: false once another tab has taken the lock, even if the
// lock-lost notice has not been delivered yet (a long synchronous action delays it).
async function stillHolding() {
  if (stopped) return false;
  if (lockState === "unsupported") return true;
  if (lockState !== "held") return false;
  if (!myClientId) return true;
  try {
    const held = (await navigator.locks.query()).held.find((l) => l.name === LOCK);
    return !stopped && lockState === "held" && !!held && held.clientId === myClientId;
  } catch {
    return !stopped && lockState === "held";
  }
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
      .request(LOCK, opts, async (lock) => {
        if (!lock) { resolve("busy"); return undefined; }
        if (startupError) { resolve("abandoned"); return undefined; } // startup gave up: let go at once
        granted = true;
        lockState = "held";
        const held = new Promise((r) => { releaseHeld = r; });
        try { // while this runtime holds the lock exclusively, the held entry is its own
          const mine = (await navigator.locks.query()).held.find((l) => l.name === LOCK);
          myClientId = (mine && mine.clientId) || null;
        } catch { myClientId = null; }
        resolve("held");
        return held;
      })
      .catch((e) => {
        if (granted) { // stolen by an unanswered takeover: never write again
          lockState = "lost";
          stop(storageBusy ? STOLEN_MID_SAVE : STOLEN);
        } else if (mode === "wait" && e && (e.name === "TimeoutError" || e.name === "AbortError")) {
          resolve("timeout");
        } else { // e.g. SecurityError when the browser blocks site storage: run without the lock
          resolve("unsupported");
        }
      });
  });
}

// Requests run one at a time, in order. A failing step never blocks the ones after it.
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn);
  queue = next.then(() => {}, () => {});
  return next;
}

if (channel) {
  channel.onmessage = (ev) => {
    if (!ev.data || ev.data.type !== "takeover-request" || lockState !== "held" || stopped) return;
    // Queued behind any request in progress, so its result is saved before the other tab loads, and
    // behind this runtime's own startup, so storage is never closed while it is still loading.
    enqueue(async () => {
      await ready.catch(() => {});
      stop("The workbench was moved to another tab, so this tab has stopped. Reload to use it here.");
    });
  };
}

async function init() {
  progress("Loading OPA policies compiled to WebAssembly");
  const reg = await (await fetchOk("opa/registry.json")).json();
  alive();
  const modules = new Set();
  for (const b of Object.values(reg.bundles)) {
    if (b.tests_module) modules.add(b.tests_module);
    if (b.decision_module) modules.add(b.decision_module);
  }
  for (const m of modules) {
    const p = await loadPolicy(await (await fetchOk(`opa/${m}`)).arrayBuffer());
    alive();
    p.setData({});
    policies.set(m, p);
  }
  progress(`Loaded ${modules.size} Wasm policy modules (OPA ${reg.opa_version})`, "done");

  progress("Starting Python (Pyodide)");
  py = await loadPyodide({ indexURL: new URL("pyodide/", base).href });
  await py.loadPackage(["regex", "jsonschema"], { messageCallback: () => {} });
  alive();
  progress(`Python ${py.runPython("import sys; sys.version.split()[0]")} ready`, "done");

  progress("Unpacking workbench code and fixtures");
  const zip = await (await fetchOk("app.zip")).arrayBuffer();
  alive();
  py.unpackArchive(zip, "zip", { extractDir: "/app" });

  let lock = await acquireLock("try");
  alive();
  for (let i = 0; lock === "busy" && i < 6; i++) {
    // A tab that was just reloaded or closed may still be releasing the lock.
    await new Promise((r) => setTimeout(r, 250));
    lock = await acquireLock("try");
    alive();
  }
  if (lock === "busy") {
    waiting = true;
    post({ kind: "locked" });
    await new Promise((r) => { takeoverRequested = r; });
    alive();
    progress("Asking the other tab to save and hand over");
    if (channel) {
      channel.postMessage({ type: "takeover-request" });
      lock = await acquireLock("wait");
      alive();
    }
    if (!channel || lock === "timeout") {
      progress("The other tab did not answer within 15 seconds; taking over (anything it was still doing is not saved)", "fail");
      lock = await acquireLock("steal");
      alive();
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
    if (startupError) throw startupError;
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
  alive();
  if (mayWrite() && await stillHolding()) await syncfs(false);
  alive();
  if (stopped) return; // taken over (or deleted) during startup; the reason has been shown
  serving = true;
  progress("Ready", "done");
  post({ kind: "ready", persistent });
}

// An uncaught error (none is expected). During startup it makes startup fail; the runtime keeps the
// lock it may hold, so that deleting a saved state that breaks startup stays possible. Afterwards it
// stops the runtime with an explanation instead of leaving it half-working.
self.addEventListener("error", (e) => {
  e.preventDefault();
  const text = String(e.message || "unknown error").slice(0, 200);
  storageBusy = null; // most likely the storage operation in flight threw; it will not finish now
  if (!serving) {
    if (!startupError && !stopped) {
      startupError = new Error(`internal error (${text})`);
      failStartup(startupError);
    }
    return;
  }
  stop(`The in-browser runtime hit an internal error (${text}). Reload the page; what was last saved in this browser is kept.`);
});

let takeoverRequested = null;
const ready = Promise.race([init(), startupAborted]);
ready.catch((e) => {
  progress(`Startup failed: ${errText(e)}`, "fail");
  post({ kind: "startup-failed", text: errText(e), canWipe: !stopped && (lockState === "held" || lockState === "unsupported") });
});

function mayWrite() {
  return persistent && !stopped && (lockState === "held" || lockState === "unsupported");
}

// Deleting this browser's saved workbench data is allowed only in the runtime that holds the workbench
// (whether or not it finished starting), so no other tab can be using the data at the same time.
function wipeRefusal() {
  if (waiting) return "The workbench is open in another tab. Use it in this tab first, then delete.";
  if (stopped) return "This tab no longer runs the workbench. Delete from the tab that has it, or reload this tab first.";
  if (lockState !== "held" && lockState !== "unsupported") {
    return "This tab did not start far enough to delete the saved data safely. Close the other tabs of this site and reload.";
  }
  return null;
}

async function wipe() {
  const refusal = wipeRefusal();
  if (refusal) throw new Error(refusal);
  await storageIdle();
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
  return outcome;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.kind === "takeover") { if (takeoverRequested) takeoverRequested(); return; }
  if (msg.kind === "wipe") {
    const refusal = waiting && wipeRefusal();
    if (refusal) { post({ id: msg.id, ok: false, error: refusal }); return; }
    // Queued behind any request in progress, and run even if startup failed: this is also the way out
    // of a saved state that makes startup fail.
    // The reply goes out before this runtime stops, so the page sees the outcome rather than the stop.
    const run = () => wipe().then((outcome) => {
      post({ id: msg.id, ok: true, result: { outcome } });
      stop(outcome === "deleted"
        ? "Local data deleted. Reload the page to start again."
        : "Deletion is waiting for another tab of this site to close; it will complete then. This tab has stopped so that nothing new is saved and then deleted.");
    }, (e) => post({ id: msg.id, ok: false, error: errText(e) }));
    ready.then(() => enqueue(run), () => enqueue(run));
    return;
  }
  enqueue(async () => {
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
    if (msg.kind === "post" && persistent) {
      // A long action can outlast another tab's 15 s handover wait; that tab then owns the saved state.
      if (mayWrite() && (await stillHolding()) && mayWrite()) {
        try { await syncfs(false); } catch (e) { out.warning = `This change could not be saved in the browser: ${errText(e)}`; }
      } else {
        out.warning = "This tab no longer holds the workbench, so this change was not saved.";
      }
    }
    post({ id: msg.id, ok: true, result: out });
  }).catch((e) => post({ id: msg.id, ok: false, error: errText(e) }));
};
