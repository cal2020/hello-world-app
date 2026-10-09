"""Small I/O helpers: atomic writes, JSONL, UTC timestamps."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utcnow() -> datetime:
    return datetime.now(UTC)


def utcnow_iso() -> str:
    return utcnow().isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_write_bytes(path: str | Path, data: bytes, mode: int = 0o644) -> None:
    """Write via a temp file in the same directory and rename, so readers never see partial files."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".partial", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def atomic_write_text(path: str | Path, text: str, mode: int = 0o644) -> None:
    atomic_write_bytes(path, text.encode("utf-8"), mode=mode)


def atomic_write_json(path: str | Path, obj: Any, *, indent: int | None = 2) -> None:
    atomic_write_text(path, json.dumps(obj, indent=indent, ensure_ascii=False, sort_keys=False) + "\n")


def read_jsonl(path: str | Path) -> Iterator[tuple[int, Any]]:
    """Yield (line_number, parsed) for each non-blank line; raises with the line number on bad JSON."""
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                yield n, json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{n}: invalid JSON ({exc.msg})") from exc


def write_jsonl(path: str | Path, rows: Iterable[Any]) -> int:
    lines = [json.dumps(r, ensure_ascii=False, sort_keys=True) for r in rows]
    atomic_write_text(path, "".join(line + "\n" for line in lines))
    return len(lines)
