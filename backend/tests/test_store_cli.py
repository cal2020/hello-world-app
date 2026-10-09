"""Storage guarantees and the command line."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from conftest import FIXTURES, KORA_SAMPLES

from cost_inspector import cli
from cost_inspector.config import Settings
from cost_inspector.importer import import_bytes
from cost_inspector.store import SCHEMA_VERSION, Store, StoreError


def test_schema_version_is_recorded(store: Store) -> None:
    with sqlite3.connect(store.path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION


def test_newer_database_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "future.sqlite3"
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA user_version = 99")
    with pytest.raises(StoreError, match="newer than this app supports"):
        Store(path)


def test_failed_import_leaves_nothing_behind(
    store: Store, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("interrupted")

    monkeypatch.setattr(Store, "_write_findings", boom)
    with pytest.raises(RuntimeError):
        import_bytes(
            store, settings, (KORA_SAMPLES / "inefficient_agent.jsonl").read_bytes(), "x.jsonl"
        )
    with sqlite3.connect(store.path) as conn:
        for table in ("imports", "runs", "calls", "findings"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0  # noqa: S608


def test_money_is_stored_as_exact_text(store: Store, settings: Settings) -> None:
    import_bytes(store, settings, (KORA_SAMPLES / "multi_step.jsonl").read_bytes(), "m.jsonl")
    with sqlite3.connect(store.path) as conn:
        types = {row[0] for row in conn.execute("SELECT typeof(cost_total) FROM calls")}
    assert types <= {"text", "null"}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db = tmp_path / "cli.sqlite3"
    monkeypatch.setenv("ACI_DB_PATH", str(db))
    return db


def test_cli_seed_reset_and_import(env: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["seed-demo"]) == 0
    assert cli.main(["seed-demo"]) == 0
    assert "0 import(s) added, 3 present" in capsys.readouterr().out
    assert cli.main(["reset-demo"]) == 0
    assert "Removed 3 demo import(s); seeded 3" in capsys.readouterr().out
    assert cli.main(["reset"]) == 2  # requires --yes
    assert cli.main(["reset", "--yes"]) == 0
    assert cli.main(["import", str(KORA_SAMPLES / "malformed.jsonl")]) == 1
    err = capsys.readouterr().err
    assert "line 1: Invalid JSON" in err
    assert cli.main(["import", str(KORA_SAMPLES / "simple.jsonl")]) == 0
    assert cli.main(["import", str(KORA_SAMPLES / "simple.jsonl")]) == 1  # duplicate


def test_cli_serve_refuses_public_bind(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["serve", "--host", "0.0.0.0"]) == 2  # noqa: S104
    assert "binds to loopback only" in capsys.readouterr().err


def test_cli_imports_large_claude_code_transcripts(
    env: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Transcripts are mostly conversation text, so the upload cap doesn't apply to them.
    monkeypatch.setenv("ACI_MAX_UPLOAD_BYTES", "1024")
    assert cli.main(["import", str(KORA_SAMPLES / "simple.jsonl")]) == 2
    assert "byte limit" in capsys.readouterr().err
    assert cli.main(["import", str(FIXTURES / "claude-code" / "session.jsonl")]) == 0
    out = capsys.readouterr().out
    assert "Imported 8 record(s)" in out
    assert "Costs are estimates" in out
