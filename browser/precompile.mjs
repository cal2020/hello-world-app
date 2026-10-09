// Precompiles the Python bytecode the browser build needs at startup and on common requests.
//
//   node browser/precompile.mjs <build dir> <pyodide package>...
//
// Pyodide compiles every module from source on each page load, which takes seconds for
// FastAPI, pydantic and the rest. This runs the same Pyodide build once, loads the same
// packages and app bundle as the worker, boots the app and exercises the requests a first
// visit makes. Every module that got imported is then compiled to an unchecked-hash .pyc
// (valid however file timestamps change when unpacked) into <build dir>/bytecode.zip, which
// the worker unpacks before importing anything. Modules nobody imports are left out.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, ...packages] = process.argv.slice(2)
const out = resolve(dir ?? '')
const pyodideDir = join(out, 'pyodide')
const { loadPyodide } = await import(pathToFileURL(join(pyodideDir, 'pyodide.mjs')).href)
const py = await loadPyodide({ indexURL: `${pyodideDir}/` })
await py.loadPackage(packages, { messageCallback: () => {} })
py.unpackArchive(new Uint8Array(readFileSync(join(out, 'app.zip'))), 'zip', { extractDir: '/app' })
const summary = await py.runPythonAsync(`
import importlib.util, io, json, py_compile, site, sys, zipfile
from pathlib import Path

sys.path.insert(0, "/app")
from cost_inspector import browser_runtime

browser_runtime.boot("/tmp/precompile/inspector.sqlite3")
HEADERS = json.dumps({"X-Requested-With": "cost-inspector", "Content-Type": "application/json"})

async def call(method, target, body=None):
    meta, data = await browser_runtime.handle(method, target, HEADERS, body)
    return json.loads(meta)["status"], data

await call("GET", "/api/meta")
await call("POST", "/api/demo")
_, data = await call("GET", "/api/imports")
imports = json.loads(data)["imports"]
runs = [run["id"] for imp in imports for run in imp["runs"]]
_, data = await call("GET", f"/api/runs/{runs[0]}")
finding = json.loads(data)["findings"][0]["id"]
await call("GET", f"/api/imports/{imports[0]['id']}")
await call("GET", f"/api/findings/{finding}")
await call("PATCH", f"/api/findings/{finding}", json.dumps({"dismissed": True, "note": "x"}).encode())
await call("GET", f"/api/compare?baseline={runs[0]}&candidate={runs[1]}&equivalence=equivalent")
for fmt in ("json", "html"):
    await call("GET", f"/api/imports/{imports[0]['id']}/report?format={fmt}")
await call("POST", "/api/imports?filename=bad.jsonl", b"{}\\nnot json\\n")

roots = [Path(p) for p in site.getsitepackages()] + [Path("/app")]
sources = sorted(
    {
        Path(module.__file__)
        for module in list(sys.modules.values())
        if getattr(module, "__file__", None)
        and module.__file__.endswith(".py")
        and any(Path(module.__file__).is_relative_to(root) for root in roots)
    }
)
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w") as archive:
    for source in sources:
        cached = Path(importlib.util.cache_from_source(str(source)))
        py_compile.compile(
            str(source),
            cfile=str(cached),
            doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
        )
        info = zipfile.ZipInfo(str(cached).lstrip("/"), (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, cached.read_bytes())
Path("/tmp/bytecode.zip").write_bytes(buffer.getvalue())
f"{len(sources)} modules"
`)
writeFileSync(join(out, 'bytecode.zip'), py.FS.readFile('/tmp/bytecode.zip'))
console.log(`   bytecode.zip: ${summary}`)
