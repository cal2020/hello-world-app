// Main thread: routing and rendering only. All state and logic live in the worker (Python + Wasm).
// Pages are addressed as "#/path?query"; links and forms rendered by the Python app use plain
// "/path" URLs and are intercepted here.
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const hdr = document.getElementById("hdr");
const main = document.getElementById("main");
const busy = document.getElementById("busy");
const busyText = document.getElementById("busy-text");
const progress = document.getElementById("progress");

let seq = 0;
const pending = new Map();
let started = false;

function getActor() {
  try { return localStorage.getItem("dmmc-actor") || "bob"; } catch { return "bob"; }
}
function setActor(a) {
  try { localStorage.setItem("dmmc-actor", a); } catch { /* per-viewer convenience only */ }
}

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.kind === "progress") {
    if (!progress) return;
    const li = document.createElement("li");
    li.textContent = m.text;
    if (m.state !== "step") li.className = m.state;
    progress.appendChild(li);
    if (m.text === "Ready" && !started) {
      started = true;
      navigate(currentPath(), { replace: true });
    }
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
};
worker.onerror = (e) => showFatal(`The in-browser runtime stopped: ${e.message || "unknown error"}`);

function call(msg, label) {
  const id = ++seq;
  document.documentElement.dataset.pending = String(pending.size + 1);
  const t = setTimeout(() => { busyText.textContent = label || "Working…"; busy.hidden = false; }, 150);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  }).finally(() => {
    clearTimeout(t);
    busy.hidden = true;
    document.documentElement.dataset.pending = String(pending.size);
  });
}

function currentPath() {
  const h = decodeURIComponent(location.hash.slice(1));
  return h.startsWith("/") ? h : "/";
}

let renders = 0;
function render(res) {
  document.documentElement.dataset.renders = String(++renders); // lets tests and tools wait for a completed navigation
  if (res.header_html != null) hdr.innerHTML = res.header_html;
  if (res.main_html != null) main.innerHTML = res.main_html;
  else main.innerHTML = `<pre>${escapeHtml(res.body || "")}</pre>`;
  document.title = `${res.title || "Workbench"} · DMMC Evidence Workbench`;
  const h2 = main.querySelector("h2");
  if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: true }); }
  window.scrollTo(0, 0);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showFatal(text) {
  main.innerHTML = `<div class="card"><p class="bad">${escapeHtml(text)}</p><p>Reload the page to try again. A recorded walkthrough is at <a href="../">the walkthrough page</a>.</p></div>`;
}

async function navigate(path, { replace = false } = {}) {
  if (!started) return;
  try {
    let res = await call({ kind: "get", path, actor: getActor() });
    if (res.status === 303 && res.location) return navigate(res.location, { replace });
    const target = "#" + path;
    if (replace) history.replaceState(null, "", target);
    else if (location.hash !== target) history.pushState(null, "", target);
    shown = path;
    render(res);
  } catch (e) {
    showFatal(e.message);
  }
}

async function submit(form) {
  const action = form.getAttribute("action") || "/act";
  const data = Object.fromEntries(new FormData(form).entries());
  const label = data.action === "run_eval" ? "Running the 22 acceptance scenarios…" :
                data.action === "build" ? "Running checks and drafting…" : "Working…";
  try {
    const res = await call({ kind: "post", path: action, form: data, actor: getActor(), referer: currentPath() }, label);
    if (res.set_actor) setActor(res.set_actor);
    if (res.status === 303 && res.location) return navigate(res.location);
    render(res);
  } catch (e) {
    showFatal(e.message);
  }
}

async function download(path) {
  const res = await call({ kind: "get", path, actor: getActor() });
  if (res.status !== 200) return navigate(path);
  const blob = new Blob([res.body], { type: res.ctype });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = decodeURIComponent(path.split("/").pop());
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
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
let shown = null;
window.addEventListener("hashchange", () => { if (currentPath() !== shown) navigate(currentPath(), { replace: true }); });

document.getElementById("wipe").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (b.dataset.confirm !== "1") {
    b.dataset.confirm = "1";
    b.textContent = "Click again to delete all workbench data stored in this browser";
    return;
  }
  await call({ kind: "wipe" }, "Deleting local data…");
  try { localStorage.removeItem("dmmc-actor"); } catch { /* ignore */ }
  location.hash = "";
  location.reload();
});
