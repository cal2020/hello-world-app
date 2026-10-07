"""Runtime settings, read from ``ACI_*`` environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = PACKAGE_ROOT.parents[1]
REPO_ROOT = BACKEND_ROOT.parent

DEFAULT_DB_PATH = BACKEND_ROOT / ".data" / "inspector.sqlite3"
DEFAULT_STATIC_DIR = REPO_ROOT / "frontend" / "dist"

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def _int_env(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


def _list_env(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    return tuple(part.strip() for part in raw.split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    db_path: Path = DEFAULT_DB_PATH
    host: str = "127.0.0.1"
    port: int = 8765
    #: Upload cap. Uploads are streamed and rejected as soon as they exceed it.
    max_upload_bytes: int = 8 * 1024 * 1024
    #: Cap on AUDR records per file; bounds validation and analysis work.
    max_records: int = 10_000
    #: Cap on validation issues returned for one rejected file.
    max_reported_issues: int = 200
    static_dir: Path | None = DEFAULT_STATIC_DIR
    extra_allowed_hosts: tuple[str, ...] = field(default_factory=tuple)
    extra_allowed_origins: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_env(cls) -> Settings:
        db = os.environ.get("ACI_DB_PATH")
        static = os.environ.get("ACI_STATIC_DIR")
        return cls(
            db_path=Path(db).expanduser() if db else DEFAULT_DB_PATH,
            host=os.environ.get("ACI_HOST", "127.0.0.1"),
            port=_int_env("ACI_PORT", 8765, minimum=1, maximum=65535),
            max_upload_bytes=_int_env(
                "ACI_MAX_UPLOAD_BYTES", 8 * 1024 * 1024, minimum=1024, maximum=64 * 1024 * 1024
            ),
            max_records=_int_env("ACI_MAX_RECORDS", 10_000, minimum=1, maximum=50_000),
            static_dir=Path(static).expanduser() if static else DEFAULT_STATIC_DIR,
            extra_allowed_hosts=_list_env("ACI_ALLOWED_HOSTS"),
            extra_allowed_origins=_list_env("ACI_ALLOWED_ORIGINS"),
        )

    @property
    def allowed_hosts(self) -> list[str]:
        return [*LOOPBACK_HOSTS, "[::1]", *self.extra_allowed_hosts]

    @property
    def allowed_origins(self) -> set[str]:
        origins = set(self.extra_allowed_origins)
        for host in ("127.0.0.1", "localhost", "[::1]"):
            # The API itself and the Vite dev server (which proxies /api).
            for port in (self.port, 5173, 4173):
                origins.add(f"http://{host}:{port}")
        return origins
