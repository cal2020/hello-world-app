// Runs the real hexis_service Python package inside Pyodide. Every file is served next to the page.
// Artifacts do not serve archives, so the two zips Pyodide expects (the standard library and the
// sqlite3 package) are rebuilt here from JSON + a .wasm file and handed to Pyodide's loader.
importScripts("pyodide/pyodide.js");
let py = null;
const base = new URL("./", self.location).href;

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(entries) { // entries: [[name, Uint8Array]] -> stored (uncompressed) zip
  const enc = new TextEncoder(), local = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = enc.encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true);
    local.push(new Uint8Array(h.buffer), n, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((a, x) => a + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...local, ...central, new Uint8Array(e.buffer)]);
}
const getJSON = async (p) => (await fetch(base + p)).json();
const textEntries = (obj) => Object.entries(obj).map(([k, v]) => [k, new TextEncoder().encode(v)]);

async function boot() {
  postMessage({ type: "progress", text: "Loading the Python runtime (about 20 MB)…" });
  const [stdlib, sqliteFiles, soBytes] = await Promise.all([
    getJSON("pyodide/stdlib.json"), getJSON("pyodide/sqlite3.json"),
    fetch(base + "pyodide/_sqlite3.wasm").then((r) => r.arrayBuffer())]);
  const built = {
    "python_stdlib.zip": makeZip(textEntries(stdlib)),
    "sqlite3-1.0.0.zip": makeZip([...textEntries(sqliteFiles), ["_sqlite3.so", new Uint8Array(soBytes)]]),
  };
  const realFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const name = url.split("?")[0].split("/").pop();
    if (built[name]) return Promise.resolve(new Response(built[name], { status: 200 }));
    return realFetch(input, init);
  };
  py = await loadPyodide({ indexURL: base + "pyodide/" });
  postMessage({ type: "progress", text: "Loading SQLite…" });
  await py.loadPackage("sqlite3", { checkIntegrity: false });
  postMessage({ type: "progress", text: "Unpacking the hexis source…" });
  const bundle = await getJSON("hexis.json");
  for (const [path, text] of Object.entries(bundle)) {
    const full = "/home/pyodide/hexis/" + path;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    py.FS.writeFile(full, text);
  }
  py.runPython([
    "import sys",
    "sys.path.insert(0, '/home/pyodide/hexis/src')",
    "sys.path.insert(0, '/home/pyodide/hexis/web')",
    "import session",
  ].join("\n"));
  postMessage({ type: "ready", python: py.runPython("import sys; sys.version.split()[0]") });
}

const ready = boot().catch((err) => postMessage({ type: "failed", error: String((err && err.message) || err) }));

onmessage = async (e) => {
  await ready;
  const { id, cmd, args } = e.data;
  if (!py) return postMessage({ type: "reply", id, reply: { ok: false, error: "runtime not loaded" } });
  try {
    const out = py.globals.get("session").dispatch(JSON.stringify({ cmd, args: args || {} }));
    postMessage({ type: "reply", id, reply: JSON.parse(out) });
  } catch (err) {
    postMessage({ type: "reply", id, reply: { ok: false, error: String((err && err.message) || err) } });
  }
};
