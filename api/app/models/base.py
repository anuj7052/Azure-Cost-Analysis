from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, JSON, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from app.core.db import Base

# Postgres in production, plain JSON on SQLite so the test suite can run
# against an in-memory database without a Postgres server.
JSONColumn = JSONB().with_variant(JSON(), "sqlite")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UUIDPrimaryKey:
    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )


class Timestamped:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class TenantScoped:
    """Every business table carries the Entra tenant id.

    The repository layer filters on this column for *every* read and write;
    it is the hard multi-tenancy boundary.
    """

    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    @declared_attr.directive
    def __table_args__(cls):  # noqa: N805
        return (Index(f"ix_{cls.__tablename__}_tenant", "tenant_id"),)


class BaseEntity(Base, UUIDPrimaryKey, Timestamped, TenantScoped):
    __abstract__ = True
