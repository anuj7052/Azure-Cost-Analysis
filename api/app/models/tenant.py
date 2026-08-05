from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseEntity, JSONColumn


class Tenant(BaseEntity):
    """A customer organisation (one Entra ID directory)."""

    __tablename__ = "tenants"
    __table_args__ = (
        UniqueConstraint("tenant_id", name="uq_tenants_tenant_id"),
        Index("ix_tenants_tenant", "tenant_id"),
    )

    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    primary_domain: Mapped[str | None] = mapped_column(String(255))
    reporting_currency: Mapped[str] = mapped_column(String(3), default="USD")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    onboarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    connections: Mapped[list["SubscriptionConnection"]] = relationship(
        back_populates="tenant", cascade="all, delete-orphan"
    )


class SubscriptionConnection(BaseEntity):
    """An Azure subscription a customer has granted us least-privilege access to.

    We never persist the client secret: `credential_ref` is a Key Vault secret
    name, or empty when workload identity federation is used.
    """

    __tablename__ = "subscription_connections"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "subscription_id", name="uq_conn_tenant_subscription"
        ),
        Index("ix_conn_tenant_sub", "tenant_id", "subscription_id"),
    )

    tenant_pk: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE")
    )
    subscription_id: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    azure_tenant_id: Mapped[str] = mapped_column(String(64), nullable=False)
    credential_ref: Mapped[str] = mapped_column(String(255), default="")
    auth_mode: Mapped[str] = mapped_column(String(32), default="client_secret")
    granted_roles: Mapped[list] = mapped_column(JSONColumn, default=list)
    state: Mapped[str] = mapped_column(String(32), default="pending")
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    tenant: Mapped[Tenant] = relationship(back_populates="connections")


class User(BaseEntity):
    """A signed-in member of a tenant with an internal role."""

    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("tenant_id", "object_id", name="uq_users_tenant_object"),
        Index("ix_users_tenant", "tenant_id"),
    )

    object_id: Mapped[str] = mapped_column(String(64), nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), default="")
    role: Mapped[str] = mapped_column(String(32), default="Viewer")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class AuditLog(BaseEntity):
    """Append-only record of every mutating action and data access decision."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_tenant_time", "tenant_id", "created_at"),
        Index("ix_audit_tenant_action", "tenant_id", "action"),
    )

    actor_object_id: Mapped[str] = mapped_column(String(64), default="")
    actor_email: Mapped[str] = mapped_column(String(320), default="")
    actor_role: Mapped[str] = mapped_column(String(32), default="")
    action: Mapped[str] = mapped_column(String(128), nullable=False)
    target_type: Mapped[str] = mapped_column(String(64), default="")
    target_id: Mapped[str] = mapped_column(String(512), default="")
    outcome: Mapped[str] = mapped_column(String(32), default="success")
    request_id: Mapped[str] = mapped_column(String(64), default="")
    ip_address: Mapped[str] = mapped_column(String(64), default="")
    details: Mapped[dict] = mapped_column(JSONColumn, default=dict)


class SyncRun(BaseEntity):
    """Status of one background synchronisation pass."""

    __tablename__ = "sync_runs"
    __table_args__ = (Index("ix_sync_tenant_kind_time", "tenant_id", "kind", "created_at"),)

    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    state: Mapped[str] = mapped_column(String(32), default="running")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    items_synced: Mapped[int] = mapped_column(default=0)
    error: Mapped[str | None] = mapped_column(Text)
