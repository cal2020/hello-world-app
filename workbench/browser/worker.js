// Module worker: runs the workbench's Python code in Pyodide and answers the page's requests.
// Messages in:  {kind:"request", id, method, path, headers, body(ArrayBuffer|null)}  {kind:"tick"}
// Messages out: {kind:"progress", text}  {kind:"ready", seconds}  {kind:"failed", text}
//               {kind:"response", id, status, headers, body(ArrayBuffer)}
import { loadPyodide } from "./pyodide/pyodide.mjs";

const base = new URL("./", import.meta.url);
const post = (m, transfer) => self.postMessage(m, transfer || []);
let runtime = null;
const queue = [];

async function start() {
  const t0 = performance.now();
  const manifest = await (await fetch(new URL("build-manifest.json", base))).json();
  post({ kind: "progress", text: "Loading Python (Pyodide " + manifest.pyodide.version + ")…" });
  const py = await loadPyodide({ indexURL: new URL("pyodide/", base).href });
  post({ kind: "progress", text: "Loading packages…" });
  await py.loadPackage(manifest.pyodide.packages, { messageCallback: () => {} });
  for (const w of manifest.wheels) await py.loadPackage(new URL("wheels/" + w, base).href, { messageCallback: () => {} });
  post({ kind: "progress", text: "Starting the workbench and the mock consumer…" });
  const zip = await (await fetch(new URL("app.zip", base))).arrayBuffer();
  py.unpackArchive(zip, "zip", { extractDir: "/app" });
  py.runPython(`import sys; sys.path.insert(0, "/app")`);
  runtime = py.pyimport("browser.runtime");
  runtime.boot("/app", manifest.source.commit);
  post({ kind: "ready", seconds: Math.round((performance.now() - t0) / 100) / 10 });
  while (queue.length) handle(queue.shift());
}

function handle(m) {
  if (m.kind === "tick") { if (runtime) runtime.tick(); return; }
  try {
    const body = m.body ? new Uint8Array(m.body) : undefined; // undefined arrives in Python as None
    const out = runtime.handle(m.method, m.path, JSON.stringify(m.headers || {}), body);
    const meta = JSON.parse(out.get(0));
    const bytes = out.get(1).toJs();
    out.destroy();
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    post({ kind: "response", id: m.id, status: meta.status, headers: meta.headers, body: buf }, [buf]);
  } catch (e) {
    const text = new TextEncoder().encode(JSON.stringify({ error: { code: "browser_runtime_error", message: String(e && e.message || e).slice(0, 500) } }));
    post({ kind: "response", id: m.id, status: 500, headers: { "Content-Type": "application/json" }, body: text.buffer }, [text.buffer]);
  }
}

self.onmessage = (ev) => { if (runtime) handle(ev.data); else if (ev.data.kind !== "tick") queue.push(ev.data); };
start().catch((e) => post({ kind: "failed", text: String(e && e.message || e).slice(0, 800) }));
