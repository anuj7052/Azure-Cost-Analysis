from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseEntity, JSONColumn


class Recommendation(BaseEntity):
    """Cost/performance optimisation finding, from our rules or Azure Advisor."""

    __tablename__ = "recommendations"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "azure_resource_id", "rule", name="uq_reco_resource_rule"
        ),
        Index("ix_reco_tenant_savings", "tenant_id", "estimated_monthly_savings"),
        Index("ix_reco_tenant_state", "tenant_id", "state"),
    )

    azure_resource_id: Mapped[str] = mapped_column(String(1024), nullable=False)
    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    resource_name: Mapped[str] = mapped_column(String(512), default="")
    rule: Mapped[str] = mapped_column(String(64), nullable=False)
    category: Mapped[str] = mapped_column(String(32), default="Cost")
    source: Mapped[str] = mapped_column(String(32), default="rules")  # rules|advisor
    impact: Mapped[str] = mapped_column(String(16), default="medium")
    confidence: Mapped[str] = mapped_column(String(16), default="medium")
    title: Mapped[str] = mapped_column(String(512), default="")
    evidence: Mapped[dict] = mapped_column(JSONColumn, default=dict)
    recommended_action: Mapped[str] = mapped_column(Text, default="")
    estimated_monthly_savings: Mapped[float] = mapped_column(Numeric(18, 4), default=0)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    state: Mapped[str] = mapped_column(String(32), default="open")  # open|dismissed|done
    dismissed_by: Mapped[str] = mapped_column(String(320), default="")
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SecurityFinding(BaseEntity):
    __tablename__ = "security_findings"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "assessment_id", "azure_resource_id", name="uq_finding_grain"
        ),
        Index("ix_finding_tenant_sev", "tenant_id", "severity"),
    )

    assessment_id: Mapped[str] = mapped_column(String(512), nullable=False)
    azure_resource_id: Mapped[str] = mapped_column(String(1024), default="")
    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(String(512), default="")
    severity: Mapped[str] = mapped_column(String(16), default="Low")
    status: Mapped[str] = mapped_column(String(32), default="Unhealthy")
    category: Mapped[str] = mapped_column(String(64), default="")
    remediation: Mapped[str | None] = mapped_column(Text)
    first_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SecureScore(BaseEntity):
    __tablename__ = "secure_scores"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "subscription_id", "captured_on", name="uq_score_grain"
        ),
    )

    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    captured_on: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    current_score: Mapped[float] = mapped_column(Numeric(9, 3), default=0)
    max_score: Mapped[float] = mapped_column(Numeric(9, 3), default=0)
    percentage: Mapped[float] = mapped_column(Numeric(6, 3), default=0)


class ExpiringSecret(BaseEntity):
    """Key Vault certificate/secret/key nearing expiry."""

    __tablename__ = "expiring_secrets"
    __table_args__ = (
        UniqueConstraint("tenant_id", "item_id", name="uq_secret_item"),
        Index("ix_secret_tenant_expiry", "tenant_id", "expires_on"),
    )

    item_id: Mapped[str] = mapped_column(String(1024), nullable=False)
    vault_name: Mapped[str] = mapped_column(String(255), default="")
    item_name: Mapped[str] = mapped_column(String(255), default="")
    item_type: Mapped[str] = mapped_column(String(32), default="secret")
    expires_on: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    days_remaining: Mapped[int] = mapped_column(default=0)


class IdentityRisk(BaseEntity):
    __tablename__ = "identity_risks"
    __table_args__ = (UniqueConstraint("tenant_id", "user_object_id", name="uq_identity_user"),)

    user_object_id: Mapped[str] = mapped_column(String(64), nullable=False)
    user_principal_name: Mapped[str] = mapped_column(String(320), default="")
    risk_level: Mapped[str] = mapped_column(String(16), default="none")
    risk_state: Mapped[str] = mapped_column(String(32), default="none")
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_privileged: Mapped[bool] = mapped_column(Boolean, default=False)
    last_sign_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class NetworkExposure(BaseEntity):
    """Result of NSG rule analysis: a port reachable from too broad a source."""

    __tablename__ = "network_exposures"
    __table_args__ = (
        UniqueConstraint("tenant_id", "nsg_id", "rule_name", name="uq_exposure_rule"),
        Index("ix_exposure_tenant_sev", "tenant_id", "severity"),
    )

    nsg_id: Mapped[str] = mapped_column(String(1024), nullable=False)
    nsg_name: Mapped[str] = mapped_column(String(255), default="")
    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    rule_name: Mapped[str] = mapped_column(String(255), nullable=False)
    direction: Mapped[str] = mapped_column(String(16), default="Inbound")
    priority: Mapped[int] = mapped_column(default=0)
    protocol: Mapped[str] = mapped_column(String(16), default="*")
    source: Mapped[str] = mapped_column(String(255), default="*")
    ports: Mapped[list] = mapped_column(JSONColumn, default=list)
    severity: Mapped[str] = mapped_column(String(16), default="medium")
    reason: Mapped[str] = mapped_column(Text, default="")


class AlertRule(BaseEntity):
    __tablename__ = "alert_rules"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_alert_rule_name"),)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    threshold: Mapped[float | None] = mapped_column(Numeric(18, 4))
    window_minutes: Mapped[int] = mapped_column(default=60)
    cooldown_minutes: Mapped[int] = mapped_column(default=360)
    severity: Mapped[str] = mapped_column(String(16), default="medium")
    channels: Mapped[list] = mapped_column(JSONColumn, default=list)
    recipients: Mapped[list] = mapped_column(JSONColumn, default=list)
    scope: Mapped[dict] = mapped_column(JSONColumn, default=dict)


class Alert(BaseEntity):
    __tablename__ = "alerts"
    __table_args__ = (
        Index("ix_alerts_tenant_state", "tenant_id", "state"),
        Index("ix_alerts_tenant_time", "tenant_id", "triggered_at"),
    )

    rule: Mapped[str] = mapped_column(String(64), nullable=False)
    rule_name: Mapped[str] = mapped_column(String(255), default="")
    azure_resource_id: Mapped[str] = mapped_column(String(1024), default="")
    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    severity: Mapped[str] = mapped_column(String(16), default="medium")
    title: Mapped[str] = mapped_column(String(512), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    state: Mapped[str] = mapped_column(String(32), default="active")
    triggered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    context: Mapped[dict] = mapped_column(JSONColumn, default=dict)


class ReportSchedule(BaseEntity):
    __tablename__ = "report_schedules"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_report_name"),)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_type: Mapped[str] = mapped_column(String(64), default="cost_summary")
    export_format: Mapped[str] = mapped_column(String(16), default="pdf")
    cron: Mapped[str] = mapped_column(String(64), default="0 8 * * 1")
    recipients: Mapped[list] = mapped_column(JSONColumn, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[str] = mapped_column(String(32), default="never_run")


class ReportRun(BaseEntity):
    __tablename__ = "report_runs"
    __table_args__ = (Index("ix_report_runs_tenant_time", "tenant_id", "created_at"),)

    report_type: Mapped[str] = mapped_column(String(64), default="cost_summary")
    export_format: Mapped[str] = mapped_column(String(16), default="pdf")
    state: Mapped[str] = mapped_column(String(32), default="queued")
    blob_path: Mapped[str] = mapped_column(String(1024), default="")
    requested_by: Mapped[str] = mapped_column(String(320), default="")
    error: Mapped[str | None] = mapped_column(Text)
