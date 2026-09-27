#!/usr/bin/env python3
"""Build the static, in-browser workbench into build/web (for GitHub Pages or any static host).

Steps (any failure stops the build):
  0. Verify tools: the OPA binary must match the pinned SHA-256 and version; Python must be 3.11.4+.
  1. Record: run the acceptance suite and the scripted demo on the pinned OPA CLI while recording
     every Rego bundle touched (DMMC_OPA_RECORD).
  2. Compile: for each recorded bundle, compile the policy decision (if decisions were evaluated) and
     every independent test rule (if tests were run) to WebAssembly with the same OPA, using restricted
     capabilities where the CLI used them. `opa check` verdicts are recorded (they cannot run in Wasm).
  3. Cross-check: recompute every recorded decision batch and test run through Wasm (Node + the same
     opa-wasm library the browser loads) and require identical results. Recorded `opa check` verdicts
     and results with nothing to execute (an empty test suite) are reported separately, not as Wasm.
  4. Gate: run the full acceptance suite on the Wasm backend; all cases must pass.
  5. Assemble: Python sources + fixtures + schemas (app.zip), the Wasm registry, a vendored Pyodide
     subset (every file verified against pinned hashes), opa-wasm, the page shell, license texts and
     a build manifest with SHA-256 for every file.
  6. Optional (--e2e): serve the site locally and run tests/web_e2e.cjs in Chromium; the result is
     recorded in the manifest and a failure stops the build.

Output is reproducible for a given source tree: fixed work paths, relative file names inside the
Wasm modules, and fixed timestamps in app.zip.

Usage: python scripts/build_web.py [--pyodide-tarball PATH] [--e2e]
Requires: Python 3.11.4+, Node 18+, `npm ci` in web/, the pinned OPA (scripts/fetch_opa.sh);
Playwright with Chromium for --e2e.
"""
from __future__ import annotations

import argparse
import fnmatch
import functools
import glob
import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from workbench import config, opa  # noqa: E402

OUT = ROOT / "build" / "web"
WORK = ROOT / "build" / ".work"  # fixed path: keeps outputs byte-for-byte reproducible
CACHE = ROOT / "build" / "cache"
PYODIDE_VERSION = "314.0.7"
PYODIDE_URL = f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/pyodide-{PYODIDE_VERSION}.tar.bz2"
PYODIDE_SHA256 = "192b5864e6e6d30ab074861af800cb8b4acb0998ef0f9342c3367448aeb86645"
PYODIDE_CORE = {  # pinned per file; wheels are verified against the (pinned) lock file's sha256 entries
    "pyodide.mjs": "6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109",
    "pyodide.asm.mjs": "f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635",
    "pyodide.asm.wasm": "cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6",
    "python_stdlib.zip": "fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a",
    "pyodide-lock.json": "5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010",
}
# The browser build of @open-policy-agent/opa-wasm 1.10.0 as installed by `npm ci` from web/package-lock.json.
OPA_WASM_ESM_SHA256 = "08bd50f2df51aedfacf693154544067767d62b3db79a9aac2b7219fa16c3c8ad"
PY_PACKAGES = ["regex", "jsonschema"]  # jsonschema + regex: OSCAL schema validation (\p{..} patterns)
CLOCK = "2026-09-23T15:00:00Z"
ZIP_TIME = (2026, 1, 1, 0, 0, 0)
# Files the worker downloads on a first visit (for the size shown on the loading screen).
FIRST_LOAD_EXCLUDE = {"build-manifest.json", "THIRD_PARTY_NOTICES.md"}


def sh256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(cmd, env=None, cwd=ROOT):
    r = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-3000:], r.stderr[-3000:])
        raise SystemExit(f"command failed: {' '.join(map(str, cmd))[:300]}")
    return r


# 0 --------------------------------------------------------------------------------------

def verify_tools() -> dict:
    if not hasattr(tarfile, "data_filter"):
        raise SystemExit("Python 3.11.4 or later is required (tarfile extraction filters)")
    found, origin = config.opa_bin_with_origin()
    if not found:
        raise SystemExit("OPA not found: run scripts/fetch_opa.sh")
    b = Path(found).resolve()
    digest = sh256(b)
    version = subprocess.run([str(b), "version"], capture_output=True, text=True).stdout
    version = next((l.split(":", 1)[1].strip() for l in version.splitlines() if l.startswith("Version")), "")
    if digest != config.OPA_SHA256 or version != config.OPA_VERSION:
        raise SystemExit(f"OPA at {b} is {version} sha256 {digest}; the build requires the pinned "
                         f"{config.OPA_VERSION} {config.OPA_SHA256} (scripts/fetch_opa.sh)")
    os.environ["OPA_BIN"] = str(b)  # every later step, including subprocesses, uses this verified binary
    print(f"  OPA {version} sha256 {digest[:16]}… verified (found via {origin})")
    return {"source": origin, "version": version, "sha256": digest}  # no host paths in a published manifest


# Source files that ship. In a git checkout, what is on disk must be exactly what git tracks: steps 1-4
# verify the files on disk and step 5 packs them, so an untracked, ignored or deleted file would
# otherwise make the verified tree differ from the shipped one, or ship under a clean revision stamp.
PACKED = ("workbench", "eval", "fixtures", "schemas")
WEB_SOURCES = ("web/index.html", "web/main.js", "web/worker.js", "web/shell.css", "web/licenses")
NOT_SOURCE = ("__pycache__",)


def _on_disk(paths) -> set[str]:
    out = set()
    for rel in paths:
        p = ROOT / rel
        for f in ([p] if p.is_file() else p.rglob("*")):
            if f.is_file() and not any(part in NOT_SOURCE for part in f.parts):
                out.add(str(f.relative_to(ROOT)))
    return out


def check_source_tree() -> bool:
    """True in a git checkout whose shipped files match the index; False outside git (stamped unverified).
    Stops the build when files are tracked but missing, or present but untracked or ignored."""
    inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=ROOT, capture_output=True, text=True)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return False
    paths = (*PACKED, *WEB_SOURCES)
    r = subprocess.run(["git", "ls-files", "-z", "--", *paths], cwd=ROOT, capture_output=True, text=True, check=True)
    tracked = {f for f in r.stdout.split("\0") if f}
    disk = _on_disk(paths)
    missing, extra = sorted(tracked - disk), sorted(disk - tracked)
    if missing or extra:
        raise SystemExit("the files to ship differ from what git tracks; commit, add or remove them first\n"
                         + "".join(f"  tracked but missing on disk: {f}\n" for f in missing)
                         + "".join(f"  on disk but not tracked (untracked or ignored): {f}\n" for f in extra))
    return True


def missing_license_files(notices: str, shipped: set[str]) -> list[str]:
    """License files that the notices name but that are not shipped ('*' in a name is a wildcard)."""
    named = set(re.findall(r"[\w.*+-]+\.(?:txt|rst|md)\b", notices)) - {"SOURCES.md"}
    return sorted(n for n in named if not (n in shipped or ("*" in n and fnmatch.filter(shipped, n))))


def packed_files() -> list[Path]:
    """Files that go into app.zip: those on disk, which check_source_tree() matched against git."""
    return sorted(ROOT / f for f in _on_disk(PACKED))


def git_provenance() -> tuple[str, bool | None]:
    """Fail closed: outside a git checkout the revision is 'unknown' and cleanliness unknown (None)."""
    r1 = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True)
    r2 = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all", "--", "."], cwd=ROOT,
                        capture_output=True, text=True)
    if r1.returncode != 0 or r2.returncode != 0 or not r1.stdout.strip():
        return "unknown", None
    return r1.stdout.strip(), bool(r2.stdout.strip())


# 1 --------------------------------------------------------------------------------------

def record(tmp: Path) -> list[dict]:
    rec = tmp / "records"
    env = {"DMMC_OPA_BACKEND": "cli", "DMMC_OPA_RECORD": str(rec), "DMMC_NOW": CLOCK}
    run([sys.executable, "-c", "import sys; sys.path.insert(0,'.'); from eval import run_eval; "
         "r=run_eval.run_all(); s=r['summary']; print(s); sys.exit(0 if s['passed']==s['cases'] else 1)"],
        env={**env, "DMMC_DATA_DIR": str(tmp / "eval-data")})
    run([sys.executable, "-m", "workbench", "demo"], env={**env, "DMMC_DATA_DIR": str(tmp / "demo-data")})
    records = [json.loads(Path(f).read_text()) for f in sorted(glob.glob(str(rec / "*.json")))]
    print(f"  recorded {len(records)} OPA operations over {len({r['key'] for r in records})} bundles")
    return records


# 2 --------------------------------------------------------------------------------------

def _relativize(text: str, d: Path) -> str:
    return text.replace(str(d) + os.sep, "").replace(str(d), ".")


def _cli_in(d: Path, args: list[str]) -> subprocess.CompletedProcess:
    """Run OPA inside the bundle dir with relative paths, so outputs name files, not build paths."""
    return opa._run(args, cwd=str(d))


def compile_bundles(records: list[dict], opa_out: Path, tmp: Path) -> dict:
    opa_out.mkdir(parents=True, exist_ok=True)
    by_key: dict[str, list[dict]] = {}
    for r in records:
        by_key.setdefault(r["key"], []).append(r)
    caps_file = tmp / "restricted-capabilities.json"
    opa.restricted_capabilities(caps_file)
    bundles = {}
    for key, recs in sorted(by_key.items()):
        files, restricted = recs[0]["files"], recs[0]["restricted"]
        d = tmp / "bundles" / key[:16]
        d.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (d / name).write_text(text)
        paths = sorted(d.glob("*.rego"))
        assert opa.bundle_key(paths, restricted) == key, f"key mismatch for {key}"
        caps = ["--capabilities", str(caps_file)] if restricted else []
        chk = _cli_in(d, ["check", "--strict", *caps, *[p.name for p in paths]])
        entry = {"files": sorted(files), "restricted": restricted,
                 "check": {"ok": chk.returncode == 0, "stderr": _relativize(chk.stderr.strip()[:4000], d)},
                 "tests_compile": None, "tests_module": None, "test_entrypoints": [], "decision_module": None}
        ops = {r["op"] for r in recs}
        if "test" in ops:
            eps = opa.test_rule_names(paths)
            entry["test_entrypoints"] = eps
            if eps:  # compile outcome is what `opa test` sees (it does not use --strict)
                mod, err = _build_wasm(d, paths, eps, caps, opa_out / f"{key[:24]}-tests.wasm")
                entry["tests_module"], entry["tests_compile"] = mod, {"ok": mod is not None, "stderr": err}
        if "eval" in ops and entry["check"]["ok"]:
            mod, err = _build_wasm(d, paths, [opa.DECISION_ENTRYPOINT], caps, opa_out / f"{key[:24]}-decision.wasm")
            if mod is None:
                raise SystemExit(f"decision module failed to compile for {key[:12]}: {err}")
            entry["decision_module"] = mod
        bundles[key] = entry
        print(f"  {key[:12]} files={entry['files']} restricted={restricted} check_ok={entry['check']['ok']} "
              f"tests={len(entry['test_entrypoints'])} decision={'yes' if entry['decision_module'] else 'no'}")
    return bundles


def _build_wasm(d: Path, paths, entrypoints, caps, dest: Path):
    bundle = d.parent / f"{dest.stem}.tar.gz"
    args = ["build", "-t", "wasm", *caps]
    for e in entrypoints:
        args += ["-e", e]
    r = _cli_in(d, args + [p.name for p in paths] + ["-o", str(bundle)])
    if r.returncode != 0:  # `opa build` reports compile errors on stdout, `opa check` on stderr
        return None, _relativize((r.stderr.strip() or r.stdout.strip())[:4000], d)
    with tarfile.open(bundle) as t:
        m = next(x for x in t.getmembers() if x.name.lstrip("/") == "policy.wasm")
        dest.write_bytes(t.extractfile(m).read())
    return dest.name, ""


# 3 --------------------------------------------------------------------------------------

def cross_check(records: list[dict], tmp: Path, opa_out: Path) -> dict:
    os.environ["DMMC_OPA_BACKEND"] = "wasm"
    os.environ["DMMC_WASM_DIR"] = str(opa_out)
    opa._REGISTRY = None
    reg = opa._registry()["bundles"]
    counts = {"wasm_recomputed": 0, "check_verdicts_recorded": 0, "empty_or_uncompiled_suites": 0}
    for r in records:
        d = tmp / "bundles" / r["key"][:16]
        e = reg[r["key"]]
        if r["op"] == "check":
            got = opa.check(str(d), r["restricted"])
            ok = got["ok"] == r["result"]["ok"]
            counts["check_verdicts_recorded"] += 1
        elif r["op"] == "test":
            got = opa.test(str(d), r["restricted"])
            want = r["result"]
            ok = (all(got[k] == want[k] for k in ("passed", "failed", "errored", "skipped", "exit_code"))
                  and sorted(got["failed_names"]) == sorted(want["failed_names"])
                  and sorted(got["errored_names"]) == sorted(want["errored_names"])
                  and bool(got.get("empty")) == bool(want.get("empty")))
            counts["wasm_recomputed" if e.get("tests_module") else "empty_or_uncompiled_suites"] += 1
        else:
            got = opa.eval_decisions([str(p) for p in sorted(d.glob("*.rego"))], r["query_pkg"], r["inputs"])
            ok = got == r["result"]
            counts["wasm_recomputed"] += 1
        if not ok:
            raise SystemExit(f"Wasm/CLI mismatch for {r['op']} {r['key'][:12]}:\n  cli={r['result']}\n  wasm={got}")
    os.environ["DMMC_OPA_BACKEND"] = "cli"
    print(f"  {counts['wasm_recomputed']} decision batches and test runs recomputed through Wasm: identical; "
          f"{counts['check_verdicts_recorded']} opa check verdicts and {counts['empty_or_uncompiled_suites']} "
          f"empty/uncompiled suites carried as recorded")
    return {**counts, "total_records": len(records)}


# 4 --------------------------------------------------------------------------------------

def wasm_gate(opa_out: Path, tmp: Path) -> dict:
    r = run([sys.executable, "-c", "import sys,json; sys.path.insert(0,'.'); from eval import run_eval; "
             "r=run_eval.run_all(); print(json.dumps(r['summary'])); "
             "print(json.dumps([c['id'] for c in r['cases'] if not c['passed']]))"],
            env={"DMMC_OPA_BACKEND": "wasm", "DMMC_WASM_DIR": str(opa_out), "DMMC_NOW": CLOCK,
                 "DMMC_DATA_DIR": str(tmp / "gate-data")})
    lines = r.stdout.strip().splitlines()
    summary, failed = json.loads(lines[-2]), json.loads(lines[-1])
    if failed or summary["passed"] != summary["cases"]:
        raise SystemExit(f"acceptance suite on the Wasm backend failed: {failed}")
    print(f"  acceptance suite on Wasm backend: {summary['passed']}/{summary['cases']}")
    return summary


# 5 --------------------------------------------------------------------------------------

def pyodide_dist(tarball: Path | None) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    tb = tarball or CACHE / f"pyodide-{PYODIDE_VERSION}.tar.bz2"
    if not tb.exists():
        part = tb.with_suffix(tb.suffix + ".part")
        print(f"  downloading {PYODIDE_URL}")
        urllib.request.urlretrieve(PYODIDE_URL, part)
        if sh256(part) != PYODIDE_SHA256:
            part.unlink()
            raise SystemExit("downloaded Pyodide tarball does not match the pinned SHA-256")
        part.replace(tb)
    if sh256(tb) != PYODIDE_SHA256:
        raise SystemExit(f"Pyodide tarball checksum mismatch: {tb}")
    ex = CACHE / f"pyodide-{PYODIDE_VERSION}"
    if not (ex / ".complete").exists():
        for stale in CACHE.glob("pyodide-extract-*"):  # left by an interrupted earlier run
            shutil.rmtree(stale, ignore_errors=True)
        tmp = Path(tempfile.mkdtemp(prefix="pyodide-extract-", dir=CACHE))
        try:
            with tarfile.open(tb) as t:
                t.extractall(tmp, filter="data")
            (tmp / ".complete").write_text(PYODIDE_SHA256)
            if ex.exists():
                shutil.rmtree(ex)
            tmp.replace(ex)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
    return ex / "pyodide"


def vendor_pyodide(src: Path, dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    for f, want in PYODIDE_CORE.items():
        if sh256(src / f) != want:
            raise SystemExit(f"Pyodide file {f} does not match its pinned SHA-256")
        shutil.copy2(src / f, dest / f)
    norm = lambda n: n.lower().replace("_", "-")  # lock keys are normalised names; depends may not be
    lock = {norm(k): v for k, v in json.loads((src / "pyodide-lock.json").read_text())["packages"].items()}
    need, stack = set(), list(PY_PACKAGES)
    while stack:
        n = norm(stack.pop())
        if n in need:
            continue
        need.add(n)
        stack += lock[n].get("depends", [])
    for n in sorted(need):
        f = lock[n]["file_name"]
        if sh256(src / f) != lock[n]["sha256"]:
            raise SystemExit(f"wheel {f} does not match the sha256 in the pinned pyodide-lock.json")
        shutil.copy2(src / f, dest / f)
    return sorted(need)


def app_zip(dest: Path, opa_out: Path, rev: str, dirty: bool | None):
    stamp = rev + ("+local-changes" if dirty else "" if dirty is False else "+unverified")

    def add(z, arcname: str, data: bytes):
        zi = zipfile.ZipInfo(arcname, date_time=ZIP_TIME)
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        z.writestr(zi, data)

    with zipfile.ZipFile(dest, "w") as z:
        for p in packed_files():
            if p.name == "_build_info.py":
                continue
            add(z, "dmmc-workbench/" + str(p.relative_to(ROOT)), p.read_bytes())
        add(z, "dmmc-workbench/workbench/_build_info.py", f'GIT_REVISION = "{stamp}"\n'.encode())
        add(z, "dmmc-workbench/web-opa/registry.json", (opa_out / "registry.json").read_bytes())
    return stamp


NOTICES = """# Third-party components in this static build

License texts are in [licenses/](licenses/) (sources and checksums: [licenses/SOURCES.md](licenses/SOURCES.md)).

| Component | Version | License | Where it is |
|---|---|---|---|
| Pyodide | {pyodide} | MPL-2.0 | pyodide/ |
| CPython (inside Pyodide), with incorporated expat, libffi, zlib, libmpdec, mimalloc, zstd bindings | {python} | PSF-2.0 and notices in CPython-*-incorporated-software.rst | pyodide/pyodide.asm.wasm, python_stdlib.zip |
| HACL* (CPython's hash implementations, inside Pyodide) | — | MIT (HACL-star-MIT-LICENSE.txt) | pyodide/pyodide.asm.wasm |
| Emscripten runtime and system libraries: musl libc, libc++abi, compiler-rt (inside Pyodide) | emsdk 5.0.3 | MIT / University of Illinois NCSA; musl MIT; LLVM Apache-2.0 with LLVM exception | pyodide/pyodide.asm.mjs, pyodide.asm.wasm |
| SQLite (inside Pyodide) | — | Public domain | pyodide/pyodide.asm.wasm |
| bzip2, Zstandard (inside Pyodide) | — | bzip2 license; BSD-3-Clause | pyodide/pyodide.asm.wasm |
| Open Policy Agent Wasm runtime (compiled into each policy module) | {opa} | Apache-2.0 | opa/*.wasm |
| RE2, libmpdec, LLVM libc++ (inside OPA's Wasm runtime; libc++ also inside Pyodide) | — | BSD-3-Clause; BSD-2-Clause (see CPython incorporated software); Apache-2.0 with LLVM exception | opa/*.wasm, pyodide/pyodide.asm.wasm |
| @open-policy-agent/opa-wasm | {opawasm} | Apache-2.0 | vendor/opa-wasm-browser.esm.js |
| sprintf-js, yaml (bundled inside opa-wasm) | {sprintfjs}, {yaml} | BSD-3-Clause; ISC | vendor/opa-wasm-browser.esm.js |
{wheels}
| NIST OSCAL component-definition JSON Schema | 1.2.3 | Public domain (NIST) | app.zip |
| NIST SP 800-53 Rev 5.2.0 catalog excerpt (OSCAL) | 5.2.0 | Public domain (NIST) | app.zip |
"""


# 6 --------------------------------------------------------------------------------------

def e2e(out: Path) -> dict:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    handler = functools.partial(Quiet, directory=str(out))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as srv:
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        npm_root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
        r = subprocess.run(["node", str(ROOT / "tests" / "web_e2e.cjs"), f"http://127.0.0.1:{port}/"], cwd=ROOT,
                           env={**os.environ, "NODE_PATH": npm_root}, capture_output=True, text=True, timeout=900)
        srv.shutdown()
    last = (r.stdout.strip().splitlines() or ["(no output)"])[-1]
    print(f"  {last}")
    if r.returncode != 0:
        print(r.stdout[-4000:], r.stderr[-2000:])
        raise SystemExit("browser end-to-end test failed")
    return {"result": last, "script": "tests/web_e2e.cjs"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pyodide-tarball", type=Path)
    ap.add_argument("--e2e", action="store_true", help="run the browser end-to-end test on the built site")
    a = ap.parse_args()
    if not (ROOT / "web" / "node_modules" / "@open-policy-agent" / "opa-wasm").exists():
        raise SystemExit("run `npm ci` in web/ first")
    print("0. verify tools and source tree")
    opa_info = verify_tools()
    esm = ROOT / "web" / "node_modules" / "@open-policy-agent" / "opa-wasm" / "dist" / "opa-wasm-browser.esm.js"
    if sh256(esm) != OPA_WASM_ESM_SHA256:
        raise SystemExit(f"{esm.relative_to(ROOT)} does not match its pinned SHA-256 (run `npm ci` in web/)")
    rev, dirty = git_provenance() if check_source_tree() else ("unknown", None)
    missing = missing_license_files(NOTICES, {p.name for p in (ROOT / "web" / "licenses").iterdir()})
    if missing:  # checked again on the generated notices in step 5
        raise SystemExit(f"THIRD_PARTY_NOTICES names license files that are not in web/licenses: {missing}")
    for d in (OUT, WORK):
        if d.exists():
            shutil.rmtree(d)
    OUT.mkdir(parents=True)
    WORK.mkdir(parents=True)
    opa_out = OUT / "opa"
    print("1. record OPA use (CLI)")
    records = record(WORK)
    print("2. compile recorded bundles to Wasm")
    bundles = compile_bundles(records, opa_out, WORK)
    reg = {"opa_version": opa_info["version"], "opa_sha256": opa_info["sha256"], "bundles": bundles,
           "note": "Rego compiled to Wasm at build time with the verified OPA binary; check verdicts are CLI results"}
    (opa_out / "registry.json").write_text(json.dumps(reg, indent=1, sort_keys=True))
    print("3. cross-check Wasm against recorded CLI results")
    cross = cross_check(records, WORK, opa_out)
    print("4. acceptance suite on the Wasm backend")
    gate = wasm_gate(opa_out, WORK)
    print("5. assemble static site")
    wheels = vendor_pyodide(pyodide_dist(a.pyodide_tarball), OUT / "pyodide")
    stamp = app_zip(OUT / "app.zip", opa_out, rev, dirty)
    vend = OUT / "vendor"
    vend.mkdir()
    nm = ROOT / "web" / "node_modules"
    shutil.copy2(esm, vend / "opa-wasm-browser.esm.js")
    shutil.copytree(ROOT / "web" / "licenses", OUT / "licenses", ignore=shutil.ignore_patterns(*NOT_SOURCE, "*.pyc"))
    ver = lambda pkg: json.loads((nm / pkg / "package.json").read_text())["version"]
    for f in ("main.js", "worker.js"):
        shutil.copy2(ROOT / "web" / f, OUT / f)
    from workbench.webapp import CSS
    (OUT / "app.css").write_text(CSS + (ROOT / "web" / "shell.css").read_text())
    lock = {k.lower().replace("_", "-"): v
            for k, v in json.loads((OUT / "pyodide" / "pyodide-lock.json").read_text())["packages"].items()}
    wheel_rows = "\n".join(f"| Python package `{w}` | {lock[w]['version']} | see the wheel's metadata | pyodide/{lock[w]['file_name']} |"
                           for w in wheels)
    py_version = json.loads((OUT / "pyodide" / "pyodide-lock.json").read_text())["info"]["python"]
    notices = NOTICES.format(
        pyodide=PYODIDE_VERSION, python=py_version, opa=opa_info["version"], opawasm=ver("@open-policy-agent/opa-wasm"),
        sprintfjs=ver("sprintf-js"), yaml=ver("yaml"), wheels=wheel_rows)
    missing = missing_license_files(notices, {p.name for p in (OUT / "licenses").iterdir()})
    if missing:
        raise SystemExit(f"THIRD_PARTY_NOTICES names license files that are not shipped: {missing}")
    (OUT / "THIRD_PARTY_NOTICES.md").write_text(notices)
    # index.html last: the loading screen states the real first-visit download size.
    first = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file()
                and p.name not in FIRST_LOAD_EXCLUDE and "licenses" not in p.parts)
    first += len((ROOT / "web" / "index.html").read_bytes())
    mb = f"{first / 1e6:.0f}"
    (OUT / "index.html").write_text((ROOT / "web" / "index.html").read_text().replace("{{FIRST_LOAD_MB}}", mb))
    manifest = {
        "git_revision": stamp, "workbench_code_digest": config.code_digest(),
        "python_build_host": sys.version.split()[0],
        "pyodide": {"version": PYODIDE_VERSION, "python": py_version, "tarball_sha256": PYODIDE_SHA256,
                    "core_files_verified": sorted(PYODIDE_CORE), "packages": wheels},
        "opa": {**opa_info, "bundles": len(bundles), "cross_check": cross},
        "opa_wasm_js": ver("@open-policy-agent/opa-wasm"),
        "acceptance_suite_on_wasm_backend": gate,
        "demo_clock": CLOCK,
        "first_visit_bytes": first,
    }
    if a.e2e:
        print("6. browser end-to-end test")
        manifest["browser_e2e"] = e2e(OUT)
    manifest["files_sha256"] = {str(p.relative_to(OUT)): sh256(p) for p in sorted(OUT.rglob("*")) if p.is_file()}
    (OUT / "build-manifest.json").write_text(json.dumps(manifest, indent=1))
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"built {OUT} ({len(manifest['files_sha256']) + 1} files, first visit {first / 1e6:.1f} MB); git {stamp}")


if __name__ == "__main__":
    main()
