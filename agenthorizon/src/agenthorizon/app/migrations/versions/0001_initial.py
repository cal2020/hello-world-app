"""Initial schema: catalogue, jobs, runs, scores, reviews, audit (public) and labels (private).

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-09
"""

from alembic import op

from agenthorizon.app.schema import GRANTS_SQL, PRIVATE, metadata

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(f"CREATE SCHEMA IF NOT EXISTS {PRIVATE}")
    op.execute(f"REVOKE ALL ON SCHEMA {PRIVATE} FROM PUBLIC")
    metadata.create_all(bind=bind)
    op.execute(GRANTS_SQL)


def downgrade() -> None:
    bind = op.get_bind()
    metadata.drop_all(bind=bind)
    op.execute(f"DROP SCHEMA IF EXISTS {PRIVATE} CASCADE")
