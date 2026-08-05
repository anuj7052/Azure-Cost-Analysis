"""Initial schema for Azure Cloud Insight.

Generated from app.models metadata. Run `alembic upgrade head` to apply.

Revision ID: 0001_initial
Revises:
"""
from __future__ import annotations

from alembic import op

from app.core.db import Base
from app import models  # noqa: F401  (registers tables)

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
