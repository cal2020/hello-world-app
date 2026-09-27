"""Assemble the browser artifact: hexis.json, recorded.json and the Pyodide runtime files.

Usage: python3 web/build.py OUT_DIR PYODIDE_DIR
PYODIDE_DIR must contain pyodide.js, pyodide.asm.js, pyodide.asm.wasm, python_stdlib.zip,
pyodide-lock.json (npm package pyodide@0.26.4) and sqlite3-1.0.0.zip (from the 0.26.4 release).
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PYODIDE_FILES = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json",
                 "sqlite3-1.0.0.zip"]


def _zip_to_json(src: str, dst: str, binary_out: dict) -> None:
    """Artifacts serve no archives: text members go into one JSON file, the binary extension
    module is written separately (it is a WebAssembly module). The worker rebuilds the zip."""
    files = {}
    with zipfile.ZipFile(src) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            data = z.read(info)
            if info.filename in binary_out:
                with open(binary_out[info.filename], "wb") as fh:
                    fh.write(data)
                continue
            files[info.filename] = data.decode("utf-8")
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(files, fh, ensure_ascii=True, separators=(",", ":"))


def main(out: str, pyodide_dir: str) -> None:
    pdir = os.path.join(out, "pyodide")
    os.makedirs(pdir, exist_ok=True)
    for f in ("pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "pyodide-lock.json"):
        shutil.copy(os.path.join(pyodide_dir, f), os.path.join(pdir, f))
    _zip_to_json(os.path.join(pyodide_dir, "python_stdlib.zip"), os.path.join(pdir, "stdlib.json"), {})
    so = os.path.join(pdir, "_sqlite3.wasm")
    _zip_to_json(os.path.join(pyodide_dir, "sqlite3-1.0.0.zip"), os.path.join(pdir, "sqlite3.json"),
                 {"_sqlite3.so": so})
    with open(so, "rb") as fh:
        assert fh.read(4) == b"\0asm", "the sqlite extension is expected to be a wasm module"
    bundle = {}
    for sub in ("src", "examples", "schemas", "tests", "web"):
        for dirpath, _, files in os.walk(os.path.join(ROOT, sub)):
            if "__pycache__" in dirpath:
                continue
            for f in files:
                if f.endswith((".py", ".json", ".md", ".txt")):
                    p = os.path.join(dirpath, f)
                    with open(p, encoding="utf-8") as fh:
                        bundle[os.path.relpath(p, ROOT)] = fh.read()
    with open(os.path.join(out, "hexis.json"), "w", encoding="utf-8") as fh:
        json.dump(bundle, fh, ensure_ascii=True, separators=(",", ":"))
    sys.path.insert(0, os.path.join(ROOT, "src"))
    from hexis_service.demo import run_demo
    import tempfile, io, contextlib
    with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()):
        rep = run_demo(os.path.join(d, "demo"), quiet=True)
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True,
                            text=True).stdout.strip()
    with open(os.path.join(out, "recorded.json"), "w") as fh:
        json.dump({"commit": commit, "python": sys.version.split()[0], "lines": [
            ln.replace(d, "<data>") for ln in rep["transcript"]]}, fh)
    for f in ("worker.js", "index.html"):
        shutil.copy(os.path.join(HERE, f), os.path.join(out, f))
    shutil.copy(os.path.join(ROOT, "examples", "procurement_onboarding", "machine.efsm.json"),
                os.path.join(out, "machine.json"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
