"""Shared fixtures. Every dataset built here is synthetic TEST DATA, never benchmark content."""

from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def reference_checkout() -> Path:
    """Pinned checkout of the authors' repository (fetched through git if absent)."""
    try:
        from agenthorizon.sources.cache import checkout

        return checkout("agenthorizon-repo").path
    except Exception as exc:  # pragma: no cover - depends on network
        pytest.skip(f"authors' repository unavailable: {exc}")


def load_reference_functions(path: Path, names: list[str], prelude: str = "import json\nimport re\n") -> types.SimpleNamespace:
    """Compile selected pure functions from a pinned reference file without importing the module.

    The functions are string/dict processing only (reviewed); nothing else from the file is executed.
    """
    tree = ast.parse(path.read_text())
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    missing = set(names) - {n.name for n in nodes}
    assert not missing, f"reference functions not found: {missing}"
    mod = ast.Module(body=nodes, type_ignores=[])
    ns: dict = {}
    exec(compile(prelude, "<prelude>", "exec"), ns)
    exec(compile(mod, str(path), "exec"), ns)
    return types.SimpleNamespace(**{n: ns[n] for n in names})


def run_reference_script(script: Path, args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    return subprocess.run([sys.executable, "-I", str(script), *args], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=120)


@pytest.fixture()
def tmpdir_path(tmp_path: Path) -> Path:
    return tmp_path


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj))


def copytree(src: Path, dst: Path) -> None:
    shutil.copytree(src, dst, dirs_exist_ok=True)


@pytest.fixture(scope="session")
def pg_cluster():
    """A throwaway local PostgreSQL cluster with migrations applied (skipped when binaries are absent)."""
    import socket
    import tempfile

    from agenthorizon.app.db import dispose_all, migrate
    from agenthorizon.app.pgcluster import LocalCluster, pg_bindir

    if pg_bindir() is None:
        pytest.skip("PostgreSQL server binaries not available")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    root = Path(tempfile.mkdtemp(prefix="ahpg-"))
    os.chmod(root, 0o755)
    cluster = LocalCluster(root / "pg", port=port).ensure()
    migrate(url=cluster.url())
    yield cluster
    dispose_all()
    cluster.stop()
    shutil.rmtree(root, ignore_errors=True)
