"""Build the in-browser version of AI Cost Inspector: static files for GitHub Pages.

    cd backend && uv run --frozen python ../browser/build.py [--out DIR] [--tarball PATH]

The page runs the unchanged backend (cost_inspector, KORA Doctor, FastAPI) in Pyodide,
CPython compiled to WebAssembly, inside a Web Worker. Nothing is sent to a server.

Every downloaded byte is pinned: the Pyodide release tarball by SHA-256, and each Pyodide
package by the SHA-256 recorded in that release's lock file. Our own code and KORA Doctor
(pinned in backend/uv.lock) are bundled from the backend environment. The output folder,
<out>/ai-cost-inspector/, lists every file's SHA-256 in build-manifest.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile
from collections.abc import Iterable
from pathlib import Path

PYODIDE_VERSION = "314.0.7"
PYODIDE_URL = (
    f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/"
    f"pyodide-{PYODIDE_VERSION}.tar.bz2"
)
PYODIDE_SHA256 = "192b5864e6e6d30ab074861af800cb8b4acb0998ef0f9342c3367448aeb86645"
CORE_FILES = ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip")
LOCK_FILE = "pyodide-lock.json"
#: Top-level Pyodide packages the worker loads; their dependencies come from the lock file.
PACKAGES = ("fastapi", "jsonschema", "jinja2")

APP_DIR = "ai-cost-inspector"
ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
HERE = ROOT / "browser"
CACHE = Path.home() / ".cache" / "ai-cost-inspector"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)  # fixed timestamps keep app.zip reproducible


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_tarball(path: Path) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"   downloading {PYODIDE_URL}")
        partial = path.with_suffix(".part")
        with (
            urllib.request.urlopen(PYODIDE_URL, timeout=600) as response,
            partial.open("wb") as handle,
        ):
            shutil.copyfileobj(response, handle, 1 << 20)
        partial.rename(path)
    if sha256_file(path) != PYODIDE_SHA256:
        raise SystemExit(f"{path}: SHA-256 does not match the pinned Pyodide {PYODIDE_VERSION}")
    return path


def _read_members(tarball: Path, wanted: set[str]) -> dict[str, bytes]:
    """One sequential pass (bz2 cannot seek cheaply), keeping only the wanted file names."""
    found: dict[str, bytes] = {}
    with tarfile.open(tarball, "r:bz2") as tar:
        for member in tar:
            name = member.name.split("/", 1)[-1]
            if name in wanted and member.isfile():
                extracted = tar.extractfile(member)
                assert extracted is not None
                found[name] = extracted.read()
                if len(found) == len(wanted):
                    break
    missing = wanted - set(found)
    if missing:
        raise SystemExit(f"Not in the Pyodide release: {', '.join(sorted(missing))}")
    return found


def canonical(name: str) -> str:
    """PEP 503 name normalization; the lock's keys and dependency lists mix - and _."""
    return re.sub(r"[-_.]+", "-", name).lower()


def resolve_packages(lock: dict, names: Iterable[str]) -> dict[str, dict]:
    """Requested packages plus everything they depend on, per the lock file."""
    packages = {canonical(key): value for key, value in lock["packages"].items()}
    needed: dict[str, dict] = {}
    todo = [canonical(n) for n in names]
    while todo:
        name = canonical(todo.pop())
        if name in needed:
            continue
        if name not in packages:
            raise SystemExit(f"{name} is not a Pyodide {PYODIDE_VERSION} package")
        needed[name] = packages[name]
        todo += packages[name].get("depends", [])
    return needed


def pyodide_files(tarball: Path) -> tuple[Path, list[str]]:
    """Core runtime files and the needed wheels, verified, in a version-specific cache."""
    cache = CACHE / f"pyodide-{PYODIDE_VERSION}"
    lock_path = cache / LOCK_FILE
    if not lock_path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        lock_path.write_bytes(_read_members(fetch_tarball(tarball), {LOCK_FILE})[LOCK_FILE])
    lock = json.loads(lock_path.read_text())
    if lock["info"].get("version") not in (None, PYODIDE_VERSION):
        raise SystemExit(f"{lock_path}: lock file is for Pyodide {lock['info']['version']}")
    needed = resolve_packages(lock, PACKAGES)
    wheels = {p["file_name"]: p["sha256"] for p in needed.values()}
    missing = {n for n in (*CORE_FILES, *wheels) if not (cache / n).exists()}
    if missing:
        for name, data in _read_members(fetch_tarball(tarball), missing).items():
            (cache / name).write_bytes(data)
    for name, digest in wheels.items():
        if sha256_file(cache / name) != digest:
            raise SystemExit(f"{name}: SHA-256 does not match the Pyodide lock file")
    return cache, sorted(needed)


def _zip_tree(archive: zipfile.ZipFile, source: Path, prefix: str) -> None:
    for path in sorted(source.rglob("*")):
        if path.is_dir() or "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        info = zipfile.ZipInfo(f"{prefix}/{path.relative_to(source).as_posix()}", ZIP_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())


def bundle_app(destination: Path) -> dict[str, str]:
    """Our backend package and KORA Doctor, exactly as installed in the backend environment."""
    import kora_doctor

    import cost_inspector

    packages = {
        "cost_inspector": Path(cost_inspector.__file__).parent,
        "kora_doctor": Path(kora_doctor.__file__).parent,
    }
    with zipfile.ZipFile(destination, "w") as archive:
        for name, source in packages.items():
            _zip_tree(archive, source, name)
    return {"cost_inspector": cost_inspector.__version__, "kora_doctor": kora_doctor.__version__}


def build_frontend(out: Path) -> None:
    # Developer tooling: fixed arguments, tools from PATH.
    subprocess.run(  # noqa: S603
        ["npm", "run", "build:browser", "--", "--outDir", str(out), "--emptyOutDir"],  # noqa: S607
        cwd=FRONTEND,
        check=True,
    )


def precompile(out: Path) -> None:
    """bytecode.zip: .pyc files compiled by this Pyodide build, so pages skip compiling."""
    subprocess.run(  # noqa: S603
        ["node", str(HERE / "precompile.mjs"), str(out), *PACKAGES],  # noqa: S607
        check=True,
    )


def source_commit() -> dict[str, object]:
    def git(*args: str) -> str:
        return subprocess.run(  # noqa: S603
            ["git", *args],  # noqa: S607
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    return {
        "commit": git("rev-parse", "HEAD"),
        "uncommitted_changes": bool(git("status", "--porcelain")),
    }


def write_notices(out: Path, packages: dict[str, dict], versions: dict[str, str]) -> None:
    shutil.copytree(HERE / "licenses", out / "licenses")
    shutil.copy(
        ROOT / "backend/tests/fixtures/kora-doctor/LICENSE",
        out / "licenses/KORA-Doctor-LICENSE.txt",
    )
    shutil.copy(
        ROOT / "backend/src/cost_inspector/ingest/audr/LICENSE", out / "licenses/AUDR-LICENSE.txt"
    )
    shutil.copy(
        ROOT / "backend/src/cost_inspector/ingest/audr/NOTICE", out / "licenses/AUDR-NOTICE.txt"
    )
    lines = [
        "# Third-party notices (browser build)",
        "",
        "This folder is the in-browser build of AI Cost Inspector. Besides the web app's own",
        "dependencies (see THIRD_PARTY_NOTICES.md in the source repository), it redistributes the",
        "components below. License texts are in [licenses/](licenses/); Python wheels also carry",
        "their own license metadata.",
        "",
        "| Component | Version | License | Where |",
        "| --- | --- | --- | --- |",
        f"| Pyodide | {PYODIDE_VERSION} | MPL-2.0 (source: "
        "https://github.com/pyodide/pyodide) | pyodide/ |",
        "| CPython (inside Pyodide), with incorporated software | 3.14.2 | PSF-2.0 and the "
        "notices in CPython-3.14.2-incorporated-software.rst | pyodide/ |",
        "| Emscripten runtime, musl, LLVM libc++/libc++abi/compiler-rt, HACL*, SQLite, "
        "bzip2, Zstandard (inside Pyodide) | emsdk 5.0.3 | MIT / NCSA; MIT; Apache-2.0 with "
        "LLVM exception; MIT; public domain; bzip2; BSD-3-Clause | pyodide/ |",
        f"| KORA Doctor | {versions['kora_doctor']} | Apache-2.0 | app.zip (kora_doctor/) |",
        "| AUDR v1.0.0 JSON Schema | 1.0.0 | Apache-2.0, with NOTICE | app.zip "
        "(cost_inspector/ingest/audr/) |",
    ]
    lines += [
        f"| Python package `{name}` | {p['version']} | see the wheel's metadata "
        f"| pyodide/{p['file_name']} |"
        for name, p in sorted(packages.items())
    ]
    (out / "NOTICES.md").write_text("\n".join(lines) + "\n")


def build(out_root: Path, tarball: Path) -> Path:
    out = out_root / APP_DIR
    print("1. Pyodide runtime and packages")
    cache, _ = pyodide_files(tarball)
    lock = json.loads((cache / LOCK_FILE).read_text())
    packages = resolve_packages(lock, PACKAGES)

    print("2. Web app")
    build_frontend(out)

    print("3. Python runtime files")
    (out / "pyodide").mkdir()
    for name in (*CORE_FILES, LOCK_FILE, *(p["file_name"] for p in packages.values())):
        shutil.copy(cache / name, out / "pyodide" / name)

    print("4. App bundle and precompiled bytecode")
    versions = bundle_app(out / "app.zip")
    precompile(out)

    print("5. Notices and manifest")
    write_notices(out, packages, versions)
    files = {
        path.relative_to(out).as_posix(): sha256_file(path)
        for path in sorted(out.rglob("*"))
        if path.is_file()
    }
    manifest = {
        "app": {"name": "AI Cost Inspector", "version": versions["cost_inspector"]},
        "source": source_commit(),
        "analyzer": {"name": "KORA Doctor", "version": versions["kora_doctor"]},
        "pyodide": {
            "version": PYODIDE_VERSION,
            "tarball_sha256": PYODIDE_SHA256,
            "packages": sorted(PACKAGES),
            "resolved": {name: packages[name]["version"] for name in sorted(packages)},
        },
        "files": files,
    }
    (out / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    size = sum((out / name).stat().st_size for name in files)
    print(f"Built {out} ({len(files)} files, {size / 1e6:.1f} MB)")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--out", type=Path, default=HERE / "dist", help="output root (default: browser/dist)"
    )
    parser.add_argument(
        "--tarball",
        type=Path,
        default=CACHE / f"pyodide-{PYODIDE_VERSION}.tar.bz2",
        help="Pyodide release tarball; downloaded and verified if missing",
    )
    args = parser.parse_args()
    build(args.out.resolve(), args.tarball.expanduser())


if __name__ == "__main__":
    main()
