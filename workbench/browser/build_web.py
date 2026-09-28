#!/usr/bin/env python3
"""Build the live, in-browser workbench (static files for GitHub Pages or any static host).

  .venv/bin/python browser/build_web.py [--out DIR] [--pyodide-tarball PATH] [--e2e]

The page is the real workbench UI (web/index.html, web/app.js, web/style.css). Its API calls go to a Web
Worker that runs the workbench and the mock consumer as Python in Pyodide (browser/runtime.py). Every
downloaded file is pinned: the Pyodide release tarball and its core files by SHA-256, the Pyodide wheels by
the (pinned) lock file's hashes, and the pure-Python wheels by SHA-256. The output includes license texts
and a build manifest with the SHA-256 of every file.

--e2e serves the output locally and drives the five-minute flow in headless Chromium (Node Playwright).
"""
import argparse
import hashlib
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BROWSER = ROOT / "browser"
CACHE = ROOT / "var" / "browser-cache"

PYODIDE_VERSION = "314.0.7"
PYODIDE_URL = f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/pyodide-{PYODIDE_VERSION}.tar.bz2"
PYODIDE_SHA256 = "192b5864e6e6d30ab074861af800cb8b4acb0998ef0f9342c3367448aeb86645"
PYODIDE_CORE = {
    "pyodide.mjs": "6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109",
    "pyodide.asm.mjs": "f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635",
    "pyodide.asm.wasm": "cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6",
    "python_stdlib.zip": "fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a",
    "pyodide-lock.json": "5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010",
}
# Top-level Pyodide packages the app loads (dependencies are resolved from the lock file).
PY_PACKAGES = ["jsonschema", "pyyaml", "requests", "lazy-object-proxy"]
# Pure-Python wheels not in the Pyodide distribution, pinned to the versions in requirements.txt.
PURE_WHEELS = {
    "jsonschema_path-0.3.4-py3-none-any.whl": "f502191fdc2b22050f9a81c9237be9d27145b9001c55842bece5e94e382e52f8",
    "pathable-0.4.4-py3-none-any.whl": "5ae9e94793b6ef5a4cbe0a7ce9dbbefc1eec38df253763fd0aeeacf2762dbbc2",
    "rfc3339_validator-0.1.4-py2.py3-none-any.whl": "24f6ec1eda14ef823da9e36ec7113124b39c04d50a4d3d3a3c2859577e7791fa",
    "openapi_schema_validator-0.6.3-py3-none-any.whl": "f3b9870f4e556b5a62a1c39da72a6b4b16f3ad9c73dc80084b1b11e74ba148a3",
    "openapi_spec_validator-0.7.1-py3-none-any.whl": "3c81825043f24ccbcd2f4b149b11e8231abce5ba84f37065e14ec947d8f4e959",
}
APP_DIRS = ["lucidwb", "consumer_app", "fixtures", "browser/runtime.py", "browser/__init__.py"]
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, dest, expected):
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"  downloading {url}")
        with urllib.request.urlopen(url, timeout=600) as r:
            dest.write_bytes(r.read())
    got = sha(dest.read_bytes())
    if got != expected:
        raise SystemExit(f"{dest.name}: sha256 {got} does not match the pinned {expected}")
    return dest


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def build(out, tarball):
    commit = git("rev-parse", "--short=12", "HEAD") or "unknown"
    dirty = bool(git("status", "--porcelain", "--", "lucidwb", "consumer_app", "fixtures", "browser", "web"))
    if out.exists():
        shutil.rmtree(out)
    (out / "pyodide").mkdir(parents=True)
    (out / "wheels").mkdir()

    print("1. Pyodide runtime")
    tar = tarfile.open(fetch(PYODIDE_URL, tarball, PYODIDE_SHA256))
    top = tar.getmembers()[0].name.split("/")[0]
    read = lambda name: tar.extractfile(f"{top}/{name}").read()  # noqa: E731
    for name, digest in PYODIDE_CORE.items():
        data = read(name)
        if sha(data) != digest:
            raise SystemExit(f"{name}: sha256 mismatch against the pinned value")
        (out / "pyodide" / name).write_bytes(data)
    lock = json.loads((out / "pyodide" / "pyodide-lock.json").read_text())["packages"]
    need, todo = {}, list(PY_PACKAGES)
    while todo:
        name = todo.pop().lower().replace("_", "-")
        if name in need:
            continue
        need[name] = lock[name]
        todo += lock[name].get("depends", [])
    for name, p in sorted(need.items()):
        data = read(p["file_name"])
        if sha(data) != p["sha256"]:
            raise SystemExit(f"{p['file_name']}: sha256 does not match the lock file")
        (out / "pyodide" / p["file_name"]).write_bytes(data)
    print(f"   core + {len(need)} packages verified")

    print("2. Pure-Python wheels")
    for name, digest in PURE_WHEELS.items():
        src = CACHE / "wheels" / name
        if not src.exists():
            project, version = name.split("-")[:2]
            src.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([sys.executable, "-m", "pip", "download", "-q", "--no-deps", "--only-binary=:all:",
                            "-d", str(src.parent), f"{project.replace('_', '-')}=={version}"], check=True)
        if sha(src.read_bytes()) != digest:
            raise SystemExit(f"{name}: sha256 mismatch against the pinned value")
        shutil.copy(src, out / "wheels" / name)

    print("3. App bundle")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        files = []
        for rel in APP_DIRS:
            p = ROOT / rel
            files += [p] if p.is_file() else [f for f in p.rglob("*") if f.is_file()]
        for f in sorted(files):
            if "__pycache__" in f.parts or f.suffix == ".pyc":
                continue
            info = zipfile.ZipInfo(str(f.relative_to(ROOT)), ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, f.read_bytes())
    (out / "app.zip").write_bytes(buf.getvalue())

    print("4. Page")
    index = (ROOT / "web" / "index.html").read_text()
    body = index[index.index("<body>") + len("<body>"):index.index('<script src="/web/app.js">')]
    shutil.copy(ROOT / "web" / "app.js", out / "app.js")
    shutil.copy(ROOT / "web" / "style.css", out / "style.css")
    for f in ("main.js", "worker.js"):
        shutil.copy(BROWSER / f, out / f)
    shutil.copytree(BROWSER / "licenses", out / "licenses")
    for name in PURE_WHEELS:  # the pure wheels' own license files
        with zipfile.ZipFile(out / "wheels" / name) as z:
            for n in z.namelist():
                if ".dist-info/" in n and ("LICENSE" in n.upper() or "COPYING" in n.upper()):
                    (out / "licenses" / f"{name.split('-')[0]}-{pathlib.PurePath(n).name}").write_bytes(z.read(n))
    notices = ["# Third-party components in this static build", "",
               "License texts are in [licenses/](licenses/). Wheels also carry their own license metadata.", "",
               "| Component | Version | License | Where |", "|---|---|---|---|",
               f"| Pyodide | {PYODIDE_VERSION} | MPL-2.0 | pyodide/ |",
               "| CPython (inside Pyodide) with incorporated software | 3.14.2 | PSF-2.0 and notices in CPython-*-incorporated-software.rst | pyodide/ |",
               "| Emscripten runtime, musl, LLVM libc++/libc++abi/compiler-rt, HACL*, SQLite, bzip2, Zstandard (inside Pyodide) | emsdk 5.0.3 | MIT / NCSA; MIT; Apache-2.0 with LLVM exception; MIT; public domain; bzip2; BSD-3-Clause | pyodide/ |"]
    notices += [f"| Python package `{n}` | {p['version']} | see the wheel's metadata | pyodide/{p['file_name']} |"
                for n, p in sorted(need.items())]
    notices += [f"| Python package `{n.split('-')[0]}` | {n.split('-')[1]} | see licenses/ and the wheel's metadata | wheels/{n} |"
                for n in PURE_WHEELS]
    (out / "THIRD_PARTY_NOTICES.md").write_text("\n".join(notices) + "\n")
    first_load = sum(f.stat().st_size for f in out.rglob("*") if f.is_file() and "licenses" not in f.parts)
    html = (BROWSER / "shell.html").read_text().replace("<!--__APP_BODY__-->", body)
    (out / "index.html").write_text(html.replace("__SIZE__", str(round(first_load / 1e6))))

    manifest = {"source": {"commit": commit + ("+dirty" if dirty else ""), "repo_path": "workbench/"},
                "pyodide": {"version": PYODIDE_VERSION, "packages": PY_PACKAGES,
                            "tarball_sha256": PYODIDE_SHA256},
                "wheels": list(PURE_WHEELS)}
    manifest["files"] = {str(f.relative_to(out)): sha(f.read_bytes())
                         for f in sorted(out.rglob("*")) if f.is_file()}
    (out / "build-manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"   {out}: {len(manifest['files'])} files, {total // 1024} KB (commit {manifest['source']['commit']})")
    return manifest


def e2e(out):
    print("5. End-to-end check in Chromium")
    r = subprocess.run(["node", str(BROWSER / "e2e.cjs"), str(out)], capture_output=True, text=True, timeout=600)
    print(r.stdout[-4000:], r.stderr[-2000:])
    if r.returncode != 0:
        raise SystemExit("end-to-end check failed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "var" / "browser-build"))
    ap.add_argument("--pyodide-tarball", default=str(CACHE / f"pyodide-{PYODIDE_VERSION}.tar.bz2"))
    ap.add_argument("--e2e", action="store_true")
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    build(out, pathlib.Path(a.pyodide_tarball))
    if a.e2e:
        e2e(out)
