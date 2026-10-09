"""Alembic environment: migrations run as the owner role against ``sqlalchemy.url``."""

from alembic import context
from sqlalchemy import create_engine

from agenthorizon.app.schema import metadata

target_metadata = metadata


def run_migrations_online() -> None:
    url = context.config.get_main_option("sqlalchemy.url")
    engine = create_engine(url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, include_schemas=True)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
