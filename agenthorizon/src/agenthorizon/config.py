"""Runtime configuration (environment-driven, prefix ``AH_``).

Secrets are never given defaults here and are never serialized into exports or logs.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AH_", env_file=None, extra="ignore")

    # Deployment mode. "local" = single-user, loopback-only, implicit operator role.
    mode: Literal["local", "hosted"] = "local"

    var_dir: Path = Field(default=PROJECT_ROOT / "var")

    # Application database (API + orchestration). The private/gold schema is only readable by the
    # scorer/research identity; judge-staging workers should use ``worker_database_url``.
    # ``database_url`` is the owner/migration identity; service identities default to the same server with the
    # ah_api / ah_worker / ah_scorer roles in local mode and must be explicit in hosted mode.
    database_url: str = "postgresql+psycopg://agenthorizon@/agenthorizon?host=" + str(PROJECT_ROOT / "var" / "pg" / "socket") + "&port=5433"
    api_database_url: str | None = None
    worker_database_url: str | None = None
    scorer_database_url: str | None = None
    local_pg_port: int = 5433
    session_ttl_hours: int = 12
    media_url_secret: SecretStr | None = None  # HMAC key for signed media URLs (generated per process if unset)

    api_host: str = "127.0.0.1"
    api_port: int = 8765

    # Remote sources
    hf_endpoint: str = "https://huggingface.co"
    hf_token: SecretStr | None = None
    download_concurrency: int = 4
    download_timeout_s: float = 120.0
    storage_limit_bytes: int | None = None  # refuse transfers that would exceed this budget

    # Judge execution
    isolation_backend: Literal["unshare", "none"] = "unshare"
    judge_task_timeout_s: int = 1800  # mirrors the authors' per-trajectory subprocess timeout
    egress_allowlist_extra: list[str] = Field(default_factory=list)

    # Hosted mode auth bootstrap token for the first operator (hashed on first use)
    bootstrap_operator_token: SecretStr | None = None

    @property
    def sources_dir(self) -> Path:
        return self.var_dir / "sources"

    @property
    def datasets_dir(self) -> Path:
        return self.var_dir / "datasets"

    @property
    def media_dir(self) -> Path:
        return self.var_dir / "media"

    @property
    def runs_dir(self) -> Path:
        return self.var_dir / "runs"

    @property
    def exports_dir(self) -> Path:
        return self.var_dir / "exports"

    @property
    def private_dir(self) -> Path:
        """Scorer-only storage (gold labels, pair mappings). Never mounted into judge sandboxes."""
        return self.var_dir / "private"

    @property
    def reports_dir(self) -> Path:
        """Reports generated at runtime (capabilities, audits, inventories); preferred over the committed evidence/."""
        return self.var_dir / "reports"

    @property
    def tools_dir(self) -> Path:
        return self.var_dir / "tools"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
