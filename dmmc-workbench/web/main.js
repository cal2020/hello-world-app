// Main thread: routing and rendering only. All state and logic live in the worker (Python + Wasm).
// Pages are addressed as "#/path?query". The hash is kept exactly as the app's links encode it and is
// never decoded here: the Python side decodes the path and the query exactly once.
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const hdr = document.getElementById("hdr");
const main = document.getElementById("main");
const busy = document.getElementById("busy");
const busyText = document.getElementById("busy-text");
const srStatus = document.getElementById("sr-status");
const root = document.documentElement;
const IDB_NAME = "/persist";

let seq = 0;
const pending = new Map(); // id -> {resolve, reject, label}
let started = false;
let fatalShown = false; // once the runtime has stopped, its explanation stays on screen
let workerBroken = false; // the worker failed to load and cannot answer messages
let navGen = 0;
let shown = null;
let renders = 0;

function getActor() {
  try { return localStorage.getItem("dmmc-actor") || "bob"; } catch { return "bob"; }
}
function setActor(a) {
  try { localStorage.setItem("dmmc-actor", a); } catch { /* per-viewer convenience only */ }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function announce(text) {
  if (!srStatus) return;
  srStatus.textContent = "";
  setTimeout(() => { srStatus.textContent = text; }, 30);
}

// --- busy indicator: one counter for all in-flight calls, labelled by the oldest -----------
let busyTimer = null;
function updateBusy() {
  root.dataset.pending = String(pending.size);
  if (!pending.size) { clearTimeout(busyTimer); busyTimer = null; busy.hidden = true; return; }
  busyText.textContent = pending.values().next().value.label || "Working…";
  if (busy.hidden && !busyTimer) busyTimer = setTimeout(() => { busyTimer = null; if (pending.size) busy.hidden = false; }, 150);
}

function call(msg, label) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, label });
    updateBusy();
    worker.postMessage({ ...msg, id });
  });
}

worker.onmessage = (ev) => {
  const m = ev.data;
  switch (m.kind) {
    case "progress": {
      const list = document.getElementById("progress");
      if (!list) return;
      const li = document.createElement("li");
      li.textContent = m.text;
      if (m.state !== "step") li.className = m.state;
      list.appendChild(li);
      return;
    }
    case "locked":
      root.dataset.locked = "true";
      main.innerHTML = `<div class="card" role="alert"><h2 tabindex="-1">The workbench is open in another tab</h2>
        <p>Only one tab can use the saved state at a time, so that two tabs never overwrite each other's work.</p>
        <p><button type="button" id="takeover">Use it in this tab instead</button></p>
        <p class="small">The other tab finishes what it is doing, saves, and stops.</p></div>`;
      main.querySelector("h2").focus();
      document.getElementById("takeover").addEventListener("click", () => {
        worker.postMessage({ kind: "takeover" });
        main.innerHTML = `<div class="card" role="status"><p>Moving the workbench to this tab…</p><ol id="progress" class="small"></ol></div>`;
      });
      return;
    case "ready":
      started = true;
      root.dataset.locked = "false";
      root.dataset.persistent = String(m.persistent);
      navigate(currentPath(), { replace: true });
      return;
    case "startup-failed":
      showFatal(`The workbench could not start: ${m.text}`, { offerWipe: true });
      return;
    case "fatal":
      started = false;
      showFatal(m.text, { offerWipe: false });
      return;
    default: {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      updateBusy();
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    }
  }
};
worker.onerror = (e) => {
  workerBroken = true;
  for (const [id, p] of pending) { pending.delete(id); p.reject(new Error("the in-browser runtime did not load")); }
  updateBusy();
  showFatal(`The in-browser runtime stopped: ${e.message || "it failed to load"}`, { offerWipe: true });
};

function currentPath() {
  const h = location.hash.slice(1);
  return h.startsWith("/") ? h : "/";
}

function render(res) {
  root.dataset.renders = String(++renders); // lets tests and tools wait for a completed navigation
  if (res.header_html != null) hdr.innerHTML = res.header_html;
  main.innerHTML = res.main_html != null ? res.main_html : `<pre>${escapeHtml(res.body || "")}</pre>`;
  if (res.warning) main.insertAdjacentHTML("afterbegin", `<div class="msg err" role="alert">${escapeHtml(res.warning)}</div>`);
  document.title = `${res.title || "Workbench"} · DMMC Evidence Workbench`;
  // Focus the first result message when there is one, so screen-reader users hear it; otherwise the heading.
  const msg = main.querySelector(".msg");
  const target = msg || main.querySelector("h2");
  if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  if (msg) announce(Array.from(main.querySelectorAll(".msg")).map((m) => m.textContent).join(" "));
  window.scrollTo(0, 0);
}

function showFatal(text, { offerWipe }) {
  fatalShown = true;
  root.dataset.renders = String(++renders);
  main.innerHTML = `<div class="card" role="alert"><p class="bad" tabindex="-1">${escapeHtml(text)}</p>
    <p>Reload the page to try again. A recorded walkthrough is at <a href="../">the walkthrough page</a>.</p>
    ${offerWipe ? '<p><button type="button" id="wipe-retry">Delete this browser\'s saved workbench data and reload</button></p>' : ""}</div>`;
  main.querySelector("p.bad").focus();
  const b = document.getElementById("wipe-retry");
  if (b) b.addEventListener("click", () => wipeAndReload(b));
}

function failed(e, gen) {
  // A stopped runtime has already explained itself; keep that message instead of a raw error.
  if (fatalShown || gen !== navGen) return;
  showFatal(e.message, { offerWipe: false });
}

async function navigate(path, { replace = false, gen = ++navGen, warning = null } = {}) {
  if (!started) return;
  try {
    const res = await call({ kind: "get", path, actor: getActor() }, "Loading…");
    if (gen !== navGen) return; // a newer navigation or action has started
    if (res.status === 303 && res.location) return navigate(res.location, { replace, gen, warning });
    const target = "#" + path;
    if (replace) history.replaceState(null, "", target);
    else if (location.hash !== target) history.pushState(null, "", target);
    shown = path;
    if (warning) res.warning = warning;
    render(res);
  } catch (e) {
    failed(e, gen);
  }
}

async function submit(form) {
  const gen = ++navGen;
  const action = form.getAttribute("action") || "/act";
  const data = Object.fromEntries(new FormData(form).entries());
  const label = data.action === "run_eval" ? "Running the 22 acceptance scenarios…" :
                data.action === "build" ? "Running checks and drafting…" : "Working…";
  try {
    const res = await call({ kind: "post", path: action, form: data, actor: getActor(), referer: currentPath() }, label);
    if (res.set_actor) setActor(res.set_actor);
    if (res.warning) announce(res.warning);
    if (gen !== navGen) return; // the user moved on while this ran; its effect is in the app's state
    // A save warning must survive the redirect to the result page.
    if (res.status === 303 && res.location) return navigate(res.location, { gen, warning: res.warning || null });
    render(res);
  } catch (e) {
    failed(e, gen);
  }
}

async function download(path) {
  try {
    const res = await call({ kind: "get", path, actor: getActor() }, "Preparing download…");
    if (res.status !== 200) return navigate(path);
    const blob = new Blob([res.body], { type: res.ctype });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    let name = path.split("/").pop();
    try { name = decodeURIComponent(name); } catch { /* keep the encoded name */ }
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    failed(e, navGen);
  }
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith("/") || href.startsWith("//")) return;
  e.preventDefault();
  href.startsWith("/files/") ? download(href) : navigate(href);
});

document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.closest("#hdr, #main")) return;
  e.preventDefault();
  submit(form);
});

// Back/forward and typed-in hashes. pushState (used by navigate) does not fire hashchange.
window.addEventListener("hashchange", () => { if (currentPath() !== shown) navigate(currentPath(), { replace: true }); });

// --- deleting local data: a deliberate two-step action that a double click cannot trigger ---
function deleteFromMainThread() {
  // Used only when the worker never loaded (so nothing in this tab holds the data open).
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    let t = null;
    req.onsuccess = () => { clearTimeout(t); resolve("deleted"); };
    req.onerror = () => { clearTimeout(t); reject(req.error || new Error("delete failed")); };
    req.onblocked = () => { t = setTimeout(() => resolve("pending"), 5000); };
  });
}

async function wipeAndReload(button) {
  button.disabled = true;
  let outcome;
  try {
    outcome = workerBroken ? await deleteFromMainThread() : (await call({ kind: "wipe" }, "Deleting local data…")).outcome;
  } catch (e) {
    button.disabled = false;
    announce(`Could not delete local data: ${e.message}`);
    button.parentElement.querySelectorAll(".wipe-error").forEach((n) => n.remove());
    button.insertAdjacentHTML("afterend", `<span class="bad wipe-error" role="alert"> ${escapeHtml(e.message)}</span>`);
    return;
  }
  try { localStorage.removeItem("dmmc-actor"); } catch { /* ignore */ }
  if (outcome === "pending") return; // the worker has stopped and shown why; nothing to reload into yet
  worker.terminate(); // releases the single-tab lock before the page starts a new runtime
  location.replace(location.pathname);
}

const wipeBtn = document.getElementById("wipe");
const WIPE_LABEL = wipeBtn.textContent;
let armedAt = 0;
let disarmTimer = null;
function disarm() { armedAt = 0; wipeBtn.textContent = WIPE_LABEL; clearTimeout(disarmTimer); }
wipeBtn.addEventListener("click", (e) => {
  const now = performance.now();
  if (!armedAt) {
    armedAt = now;
    wipeBtn.textContent = "Click again within 5 seconds to delete all workbench data in this browser";
    announce(wipeBtn.textContent);
    disarmTimer = setTimeout(disarm, 5000);
    return;
  }
  if (e.detail > 1 || now - armedAt < 600) return; // a double click is not a confirmation
  disarm();
  wipeAndReload(wipeBtn);
});
wipeBtn.addEventListener("blur", () => { if (armedAt) disarm(); });
