#!/usr/bin/env python3
"""Build the static, in-browser workbench into build/web (for GitHub Pages or any static host).

What it does, in order (any failure stops the build):
  1. Record: run the acceptance suite and the scripted demo with the pinned OPA CLI while
     recording every Rego bundle touched (DMMC_OPA_RECORD).
  2. Compile: for each recorded bundle, compile the policy decision and each independent test
     rule to WebAssembly with the same pinned OPA (restricted capabilities where the CLI used them).
  3. Cross-check: evaluate every recorded CLI result again through Wasm (via Node and the same
     opa-wasm library the browser uses) and require identical outcomes.
  4. Gate: run the full acceptance suite on the Wasm backend; all cases must pass.
  5. Assemble: Python sources + fixtures + schemas (app.zip), the Wasm registry, a vendored
     Pyodide subset (checksum-pinned release), opa-wasm, the page shell, notices and a
     build manifest with SHA-256 for every file.

Usage: python scripts/build_web.py [--pyodide-tarball PATH]
Requires: Python 3.11+, Node 18+, `npm ci` in web/, the pinned OPA (scripts/fetch_opa.sh).
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from workbench import config, opa  # noqa: E402

OUT = ROOT / "build" / "web"
CACHE = ROOT / "build" / "cache"
PYODIDE_VERSION = "314.0.7"
PYODIDE_URL = f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/pyodide-{PYODIDE_VERSION}.tar.bz2"
PYODIDE_SHA256 = "192b5864e6e6d30ab074861af800cb8b4acb0998ef0f9342c3367448aeb86645"
PYODIDE_CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
PY_PACKAGES = ["regex", "jsonschema"]  # jsonschema + regex: OSCAL schema validation (\p{..} patterns)
CLOCK = "2026-09-23T15:00:00Z"


def sh256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(cmd, env=None, cwd=ROOT):
    print("  $", " ".join(str(c) for c in cmd))
    r = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-3000:], r.stderr[-3000:])
        raise SystemExit(f"command failed: {cmd}")
    return r


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

def compile_bundles(records: list[dict], opa_out: Path, tmp: Path) -> dict:
    opa_out.mkdir(parents=True, exist_ok=True)
    by_key: dict[str, list[dict]] = {}
    for r in records:
        by_key.setdefault(r["key"], []).append(r)
    bundles = {}
    for key, recs in sorted(by_key.items()):
        files, restricted = recs[0]["files"], recs[0]["restricted"]
        d = tmp / "bundles" / key[:16]
        d.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (d / name).write_text(text)
        paths = sorted(d.glob("*.rego"))
        assert opa.bundle_key(paths, restricted) == key, f"key mismatch for {key}"
        caps_args = []
        if restricted:
            caps_args = ["--capabilities", str(opa.restricted_capabilities(tmp / f"caps-{key[:8]}.json"))]
        chk = opa._cli_check(d, restricted)
        entry = {"files": sorted(files), "restricted": restricted, "check": chk,
                 "tests_module": None, "test_entrypoints": [], "decision_module": None}
        ops = {r["op"] for r in recs}
        if chk["ok"] and "test" in ops:
            eps = opa.test_rule_names(paths)
            entry["test_entrypoints"] = eps
            if eps:
                entry["tests_module"] = _build_wasm(paths, eps, caps_args, opa_out / f"{key[:24]}-tests.wasm", tmp)
        if chk["ok"] and "eval" in ops:
            entry["decision_module"] = _build_wasm(paths, [opa.DECISION_ENTRYPOINT], caps_args,
                                                   opa_out / f"{key[:24]}-decision.wasm", tmp)
        bundles[key] = entry
        print(f"  {key[:12]} files={entry['files']} restricted={restricted} compile_ok={chk['ok']} "
              f"tests={len(entry['test_entrypoints'])} decision={'yes' if entry['decision_module'] else 'no'}")
    reg = {"opa_version": config.OPA_VERSION, "opa_sha256": config.OPA_SHA256, "bundles": bundles,
           "note": "Rego compiled to Wasm at build time with the pinned OPA; see build-manifest.json"}
    (opa_out / "registry.json").write_text(json.dumps(reg, indent=1, sort_keys=True))
    return reg


def _build_wasm(paths, entrypoints, caps_args, dest: Path, tmp: Path) -> str:
    bundle = tmp / f"{dest.stem}.tar.gz"
    args = [opa._bin(), "build", "-t", "wasm", *caps_args]
    for e in entrypoints:
        args += ["-e", e]
    run(args + [str(p) for p in paths] + ["-o", str(bundle)])
    with tarfile.open(bundle) as t:
        m = next(x for x in t.getmembers() if x.name.lstrip("/") == "policy.wasm")
        dest.write_bytes(t.extractfile(m).read())
    return dest.name


# 3 --------------------------------------------------------------------------------------

def cross_check(records: list[dict], tmp: Path, opa_out: Path):
    os.environ["DMMC_OPA_BACKEND"] = "wasm"
    os.environ["DMMC_WASM_DIR"] = str(opa_out)
    opa._REGISTRY = None
    n = 0
    for r in records:
        d = tmp / "bundles" / r["key"][:16]
        if r["op"] == "check":
            got = opa.check(str(d), r["restricted"])
            ok = got["ok"] == r["result"]["ok"]
        elif r["op"] == "test":
            got = opa.test(str(d), r["restricted"])
            keys = ("passed", "failed", "errored", "skipped")
            ok = (all(got[k] == r["result"][k] for k in keys)
                  and sorted(got["failed_names"]) == sorted(r["result"]["failed_names"])
                  and bool(got.get("empty")) == bool(r["result"].get("empty"))
                  and (got["exit_code"] == 0) == (r["result"]["exit_code"] == 0))
        else:
            got = opa.eval_decisions([str(p) for p in sorted(d.glob("*.rego"))], r["query_pkg"], r["inputs"])
            ok = got == r["result"]
        if not ok:
            raise SystemExit(f"Wasm/CLI mismatch for {r['op']} {r['key'][:12]}:\n  cli={r['result']}\n  wasm={got}")
        n += 1
    os.environ["DMMC_OPA_BACKEND"] = "cli"
    print(f"  {n} recorded CLI results reproduced exactly through Wasm")
    return n


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
        print(f"  downloading {PYODIDE_URL}")
        urllib.request.urlretrieve(PYODIDE_URL, tb)
    if sh256(tb) != PYODIDE_SHA256:
        raise SystemExit(f"Pyodide tarball checksum mismatch: {tb}")
    ex = CACHE / f"pyodide-{PYODIDE_VERSION}"
    if not (ex / "pyodide" / "pyodide-lock.json").exists():
        with tarfile.open(tb) as t:
            t.extractall(ex, filter="data")
    return ex / "pyodide"


def vendor_pyodide(src: Path, dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    for f in PYODIDE_CORE:
        shutil.copy2(src / f, dest / f)
    lock = json.loads((src / "pyodide-lock.json").read_text())["packages"]
    norm = lambda n: n.lower().replace("_", "-")  # lock keys are normalised names; depends may not be
    lock = {norm(k): v for k, v in lock.items()}
    need, stack = set(), list(PY_PACKAGES)
    while stack:
        n = norm(stack.pop())
        if n in need:
            continue
        need.add(n)
        stack += lock[n].get("depends", [])
    for n in sorted(need):
        shutil.copy2(src / lock[n]["file_name"], dest / lock[n]["file_name"])
    return sorted(need)


def app_zip(dest: Path, opa_out: Path):
    rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--", "."], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        def add(path: Path):
            z.write(path, "dmmc-workbench/" + str(path.relative_to(ROOT)))
        for p in sorted((ROOT / "workbench").glob("*.py")):
            if p.name != "_build_info.py":
                add(p)
        z.writestr("dmmc-workbench/workbench/_build_info.py",
                   f'GIT_REVISION = "{rev}{"+local-changes" if dirty else ""}"\n')
        for p in ("eval/__init__.py", "eval/run_eval.py", "eval/expected.json"):
            add(ROOT / p)
        for base in ("fixtures", "schemas"):
            for p in sorted((ROOT / base).rglob("*")):
                if p.is_file():
                    add(p)
        z.write(opa_out / "registry.json", "dmmc-workbench/web-opa/registry.json")
    return rev, bool(dirty)


NOTICES = """# Third-party components in this static build

| Component | Version | License | Source |
|---|---|---|---|
| Pyodide (CPython for WebAssembly) | {pyodide} | MPL-2.0 (Pyodide); PSF-2.0 (CPython) | https://github.com/pyodide/pyodide |
| Open Policy Agent (compiler used at build time; policies compiled to Wasm) | {opa} | Apache-2.0 | https://github.com/open-policy-agent/opa |
| @open-policy-agent/opa-wasm (browser evaluator) | {opawasm} | Apache-2.0 | https://github.com/open-policy-agent/npm-opa-wasm |
{wheels}
| NIST OSCAL component-definition JSON Schema | 1.2.3 | Public domain (NIST) | https://github.com/usnistgov/OSCAL |
| NIST SP 800-53 Rev 5.2.0 catalog excerpt (OSCAL) | 5.2.0 | Public domain (NIST) | https://github.com/usnistgov/oscal-content |
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pyodide-tarball", type=Path)
    a = ap.parse_args()
    if not (ROOT / "web" / "node_modules" / "@open-policy-agent" / "opa-wasm").exists():
        raise SystemExit("run `npm ci` in web/ first")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    opa_out = OUT / "opa"
    with tempfile.TemporaryDirectory(prefix="dmmc-build-") as t:
        tmp = Path(t)
        print("1. record OPA use (CLI)")
        records = record(tmp)
        print("2. compile recorded bundles to Wasm")
        reg = compile_bundles(records, opa_out, tmp)
        print("3. cross-check Wasm against recorded CLI results")
        n_checked = cross_check(records, tmp, opa_out)
        print("4. acceptance suite on the Wasm backend")
        gate = wasm_gate(opa_out, tmp)
    print("5. assemble static site")
    wheels = vendor_pyodide(pyodide_dist(a.pyodide_tarball), OUT / "pyodide")
    rev, dirty = app_zip(OUT / "app.zip", opa_out)
    vend = OUT / "vendor"
    vend.mkdir()
    ow = ROOT / "web" / "node_modules" / "@open-policy-agent" / "opa-wasm"
    shutil.copy2(ow / "dist" / "opa-wasm-browser.esm.js", vend / "opa-wasm-browser.esm.js")
    shutil.copy2(ow / "LICENSE", vend / "opa-wasm-LICENSE")
    opawasm_version = json.loads((ow / "package.json").read_text())["version"]
    for f in ("index.html", "main.js", "worker.js"):
        shutil.copy2(ROOT / "web" / f, OUT / f)
    from workbench.webapp import CSS
    (OUT / "app.css").write_text(CSS + (ROOT / "web" / "shell.css").read_text())
    lock = {k.lower().replace("_", "-"): v
            for k, v in json.loads((OUT / "pyodide" / "pyodide-lock.json").read_text())["packages"].items()}
    wheel_rows = "\n".join(f"| Python package `{w}` | {lock[w]['version']} | see package metadata | {lock[w]['file_name']} |"
                           for w in wheels)
    (OUT / "THIRD_PARTY_NOTICES.md").write_text(NOTICES.format(pyodide=PYODIDE_VERSION, opa=config.OPA_VERSION,
                                                               opawasm=opawasm_version, wheels=wheel_rows))
    files = {str(p.relative_to(OUT)): sh256(p) for p in sorted(OUT.rglob("*")) if p.is_file()}
    manifest = {
        "git_revision": rev, "working_tree_dirty": dirty, "workbench_code_digest": config.code_digest(),
        "pyodide": {"version": PYODIDE_VERSION, "tarball_sha256": PYODIDE_SHA256, "packages": wheels},
        "opa": {"version": config.OPA_VERSION, "binary_sha256": config.OPA_SHA256, "bundles": len(reg["bundles"]),
                "recorded_results_cross_checked": n_checked},
        "opa_wasm_js": opawasm_version,
        "acceptance_suite_on_wasm_backend": gate,
        "demo_clock": CLOCK,
        "files_sha256": files,
    }
    (OUT / "build-manifest.json").write_text(json.dumps(manifest, indent=1))
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"built {OUT} ({len(files) + 1} files, {size / 1e6:.1f} MB); git {rev}{' (dirty)' if dirty else ''}")


if __name__ == "__main__":
    main()
