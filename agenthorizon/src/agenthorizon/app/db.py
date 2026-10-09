"""Database engines per service identity, and migrations.

Each process connects with the narrowest role it needs: the API as ``ah_api``, the judge worker as ``ah_worker``
(no access to the ``private`` schema), the trusted worker as ``ah_scorer``. Migrations run as the owner role.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url

from agenthorizon.config import Settings, get_settings

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
IDENTITIES = ("owner", "api", "worker", "scorer")
ROLE_FOR = {"api": "ah_api", "worker": "ah_worker", "scorer": "ah_scorer"}


def url_for(identity: str, settings: Settings | None = None) -> str:
    s = settings or get_settings()
    explicit = {"owner": s.database_url, "api": s.api_database_url, "worker": s.worker_database_url,
                "scorer": s.scorer_database_url}[identity]
    if explicit and identity != "owner":
        return explicit
    base = make_url(s.database_url)
    if identity == "owner":
        return base.render_as_string(hide_password=False)
    return base.set(username=ROLE_FOR[identity], password=None).render_as_string(hide_password=False) \
        if s.mode == "local" else _require(identity)


def _require(identity: str) -> str:
    raise RuntimeError(f"hosted mode requires an explicit database URL for the {identity} identity")


_ENGINES: dict[str, Engine] = {}


def _engine(url: str) -> Engine:
    e = _ENGINES.get(url)
    if e is None:
        e = _ENGINES[url] = create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=20)
    return e


def engine(identity: str, settings: Settings | None = None) -> Engine:
    if identity not in IDENTITIES:
        raise ValueError(identity)
    return _engine(url_for(identity, settings))


def dispose_all() -> None:
    for e in _ENGINES.values():
        e.dispose()
    _ENGINES.clear()


def alembic_config(url: str):
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return cfg


def migrate(settings: Settings | None = None, url: str | None = None) -> str:
    from alembic import command

    u = url or url_for("owner", settings)
    command.upgrade(alembic_config(u), "head")
    with create_engine(u).connect() as c:
        return c.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


def migration_head() -> str:
    from alembic.script import ScriptDirectory

    return ScriptDirectory.from_config(alembic_config("postgresql://x/y")).get_current_head()
