from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Index, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseEntity, JSONColumn


class ResourceType:
    """Canonical short names mapped from ARM `type` values."""

    VIRTUAL_MACHINE = "virtual_machine"
    STORAGE_ACCOUNT = "storage_account"
    SQL_DATABASE = "sql_database"
    APP_SERVICE = "app_service"
    AKS_CLUSTER = "aks_cluster"
    FUNCTION_APP = "function_app"
    VIRTUAL_NETWORK = "virtual_network"
    NETWORK_SECURITY_GROUP = "network_security_group"
    LOAD_BALANCER = "load_balancer"
    PUBLIC_IP = "public_ip"
    NETWORK_INTERFACE = "network_interface"
    KEY_VAULT = "key_vault"
    RECOVERY_VAULT = "recovery_services_vault"
    DISK = "disk"
    SNAPSHOT = "snapshot"


ARM_TYPE_MAP: dict[str, str] = {
    "microsoft.compute/virtualmachines": ResourceType.VIRTUAL_MACHINE,
    "microsoft.storage/storageaccounts": ResourceType.STORAGE_ACCOUNT,
    "microsoft.sql/servers/databases": ResourceType.SQL_DATABASE,
    "microsoft.web/sites": ResourceType.APP_SERVICE,
    "microsoft.containerservice/managedclusters": ResourceType.AKS_CLUSTER,
    "microsoft.network/virtualnetworks": ResourceType.VIRTUAL_NETWORK,
    "microsoft.network/networksecuritygroups": ResourceType.NETWORK_SECURITY_GROUP,
    "microsoft.network/loadbalancers": ResourceType.LOAD_BALANCER,
    "microsoft.network/publicipaddresses": ResourceType.PUBLIC_IP,
    # NICs are free, but they carry the public IP -> virtual machine link that
    # lets bandwidth be attributed back to a specific address.
    "microsoft.network/networkinterfaces": ResourceType.NETWORK_INTERFACE,
    "microsoft.keyvault/vaults": ResourceType.KEY_VAULT,
    "microsoft.recoveryservices/vaults": ResourceType.RECOVERY_VAULT,
    "microsoft.compute/disks": ResourceType.DISK,
    "microsoft.compute/snapshots": ResourceType.SNAPSHOT,
}


class Resource(BaseEntity):
    """A single Azure resource discovered through Resource Graph."""

    __tablename__ = "resources"
    __table_args__ = (
        UniqueConstraint("tenant_id", "azure_resource_id", name="uq_resource_tenant_arm"),
        Index("ix_resources_tenant_sub", "tenant_id", "subscription_id"),
        Index("ix_resources_tenant_type", "tenant_id", "resource_type"),
        Index("ix_resources_tenant_rg", "tenant_id", "resource_group"),
    )

    azure_resource_id: Mapped[str] = mapped_column(String(1024), nullable=False)
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    arm_type: Mapped[str] = mapped_column(String(255), default="")
    subscription_id: Mapped[str] = mapped_column(String(64), nullable=False)
    subscription_name: Mapped[str] = mapped_column(String(255), default="")
    resource_group: Mapped[str] = mapped_column(String(255), default="")
    location: Mapped[str] = mapped_column(String(64), default="")
    sku: Mapped[str] = mapped_column(String(128), default="")
    kind: Mapped[str] = mapped_column(String(128), default="")
    power_state: Mapped[str] = mapped_column(String(64), default="")
    provisioning_state: Mapped[str] = mapped_column(String(64), default="")
    health_state: Mapped[str] = mapped_column(String(64), default="unknown")
    owner: Mapped[str] = mapped_column(String(320), default="")
    tags: Mapped[dict] = mapped_column(JSONColumn, default=dict)
    properties: Mapped[dict] = mapped_column(JSONColumn, default=dict)
    dependencies: Mapped[list] = mapped_column(JSONColumn, default=list)
    monthly_cost: Mapped[float | None] = mapped_column(Numeric(18, 4))
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CostRecord(BaseEntity):
    """Daily cost at meter grain — the grain everything else aggregates from.

    One row per (day, resource, meter, charge type). Keeping the meter columns
    means nothing is hidden behind a service rollup: bandwidth/egress, inter-region
    transfer, request charges, reservation amortisation and marketplace fees are
    all individually queryable, with the billed quantity and unit price.
    """

    __tablename__ = "cost_records"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "subscription_id",
            "usage_date",
            "azure_resource_id",
            "meter_id",
            "meter",
            "charge_type",
            name="uq_cost_grain",
        ),
        Index("ix_cost_tenant_date", "tenant_id", "usage_date"),
        Index("ix_cost_tenant_sub_date", "tenant_id", "subscription_id", "usage_date"),
        Index("ix_cost_tenant_service", "tenant_id", "service_name"),
        Index("ix_cost_tenant_meter_cat", "tenant_id", "meter_category", "usage_date"),
        Index("ix_cost_tenant_resource", "tenant_id", "azure_resource_id", "usage_date"),
    )

    usage_date: Mapped[date] = mapped_column(Date, nullable=False)
    subscription_id: Mapped[str] = mapped_column(String(64), nullable=False)
    azure_resource_id: Mapped[str] = mapped_column(String(1024), default="")
    resource_name: Mapped[str] = mapped_column(String(255), default="")
    resource_group: Mapped[str] = mapped_column(String(255), default="")
    resource_type: Mapped[str] = mapped_column(String(255), default="")
    resource_location: Mapped[str] = mapped_column(String(64), default="")
    service_name: Mapped[str] = mapped_column(String(255), default="")

    # --- meter detail (what the portal's default views roll up and hide) ---
    meter: Mapped[str] = mapped_column(String(255), default="")
    meter_id: Mapped[str] = mapped_column(String(128), default="")
    meter_category: Mapped[str] = mapped_column(String(128), default="")
    meter_subcategory: Mapped[str] = mapped_column(String(128), default="")
    meter_region: Mapped[str] = mapped_column(String(64), default="")
    service_family: Mapped[str] = mapped_column(String(128), default="")
    product: Mapped[str] = mapped_column(String(512), default="")
    part_number: Mapped[str] = mapped_column(String(64), default="")

    # --- usage economics ---
    quantity: Mapped[float] = mapped_column(Numeric(24, 8), default=0)
    unit_of_measure: Mapped[str] = mapped_column(String(64), default="")
    unit_price: Mapped[float] = mapped_column(Numeric(18, 8), default=0)
    effective_price: Mapped[float] = mapped_column(Numeric(18, 8), default=0)

    cost: Mapped[float] = mapped_column(Numeric(18, 6), default=0)
    amortized_cost: Mapped[float] = mapped_column(Numeric(18, 6), default=0)
    currency: Mapped[str] = mapped_column(String(3), default="USD")

    # --- classification: Usage | Purchase | Refund | UnusedReservation | ... ---
    charge_type: Mapped[str] = mapped_column(String(32), default="Usage")
    frequency: Mapped[str] = mapped_column(String(32), default="")
    pricing_model: Mapped[str] = mapped_column(String(32), default="")  # OnDemand|Reservation|Spot
    publisher_type: Mapped[str] = mapped_column(String(32), default="")  # Azure|Marketplace|AWS
    benefit_name: Mapped[str] = mapped_column(String(255), default="")
    reservation_id: Mapped[str] = mapped_column(String(255), default="")

    additional_info: Mapped[dict] = mapped_column(JSONColumn, default=dict)
    tags: Mapped[dict] = mapped_column(JSONColumn, default=dict)


class CostForecast(BaseEntity):
    __tablename__ = "cost_forecasts"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "subscription_id", "forecast_date", name="uq_forecast_grain"
        ),
        Index("ix_forecast_tenant_date", "tenant_id", "forecast_date"),
    )

    subscription_id: Mapped[str] = mapped_column(String(64), nullable=False)
    forecast_date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(18, 4), default=0)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    source: Mapped[str] = mapped_column(String(32), default="azure")  # azure|run_rate
    confidence: Mapped[str] = mapped_column(String(16), default="medium")


class MetricSample(BaseEntity):
    """Time-series point for a resource metric (CPU, memory, disk, network...)."""

    __tablename__ = "metric_samples"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "azure_resource_id",
            "metric",
            "timestamp",
            name="uq_metric_grain",
        ),
        Index("ix_metric_tenant_res_metric", "tenant_id", "azure_resource_id", "metric"),
        Index("ix_metric_tenant_time", "tenant_id", "timestamp"),
    )

    azure_resource_id: Mapped[str] = mapped_column(String(1024), nullable=False)
    metric: Mapped[str] = mapped_column(String(64), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    average: Mapped[float | None] = mapped_column(Numeric(18, 6))
    maximum: Mapped[float | None] = mapped_column(Numeric(18, 6))
    minimum: Mapped[float | None] = mapped_column(Numeric(18, 6))
    total: Mapped[float | None] = mapped_column(Numeric(18, 6))
    unit: Mapped[str] = mapped_column(String(32), default="")


class NetworkUsageRecord(BaseEntity):
    """Daily ingress/egress volume per resource, in bytes.

    Ingress is almost always free, so it never appears in Cost Management at all.
    These rows come from Azure Monitor throughput metrics and are what make
    "how much data actually moved" answerable next to "what was billed".
    """

    __tablename__ = "network_usage_records"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "azure_resource_id", "usage_date", name="uq_network_usage_grain"
        ),
        Index("ix_netusage_tenant_date", "tenant_id", "usage_date"),
    )

    azure_resource_id: Mapped[str] = mapped_column(String(1024), nullable=False)
    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    resource_name: Mapped[str] = mapped_column(String(255), default="")
    resource_type: Mapped[str] = mapped_column(String(64), default="")
    resource_group: Mapped[str] = mapped_column(String(255), default="")
    location: Mapped[str] = mapped_column(String(64), default="")
    usage_date: Mapped[date] = mapped_column(Date, nullable=False)
    ingress_bytes: Mapped[float] = mapped_column(Numeric(24, 2), default=0)
    egress_bytes: Mapped[float] = mapped_column(Numeric(24, 2), default=0)
    source_metric: Mapped[str] = mapped_column(String(64), default="")


class ActivityLogEntry(BaseEntity):
    __tablename__ = "activity_log_entries"
    __table_args__ = (
        Index("ix_activity_tenant_res_time", "tenant_id", "azure_resource_id", "event_time"),
    )

    azure_resource_id: Mapped[str] = mapped_column(String(1024), default="")
    subscription_id: Mapped[str] = mapped_column(String(64), default="")
    event_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    operation: Mapped[str] = mapped_column(String(512), default="")
    status: Mapped[str] = mapped_column(String(64), default="")
    caller: Mapped[str] = mapped_column(String(320), default="")
    level: Mapped[str] = mapped_column(String(32), default="")
    description: Mapped[str | None] = mapped_column(Text)


class BackupStatus(BaseEntity):
    __tablename__ = "backup_statuses"
    __table_args__ = (
        UniqueConstraint("tenant_id", "azure_resource_id", name="uq_backup_resource"),
    )

    azure_resource_id: Mapped[str] = mapped_column(String(1024), nullable=False)
    vault_id: Mapped[str] = mapped_column(String(1024), default="")
    policy_name: Mapped[str] = mapped_column(String(255), default="")
    protection_state: Mapped[str] = mapped_column(String(64), default="unknown")
    last_backup_status: Mapped[str] = mapped_column(String(64), default="unknown")
    last_backup_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
