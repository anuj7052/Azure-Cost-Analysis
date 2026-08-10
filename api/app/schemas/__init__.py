from __future__ import annotations

from datetime import date, datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class Money(BaseModel):
    amount: float
    currency: str = "USD"


# --- auth / tenancy ---------------------------------------------------
class MeOut(BaseModel):
    tenant_id: str
    object_id: str
    email: str
    name: str
    role: str
    permissions: list[str]


class ConnectionIn(BaseModel):
    subscription_id: str = Field(min_length=36, max_length=64)
    display_name: str = Field(min_length=1, max_length=255)
    azure_tenant_id: str = Field(min_length=36, max_length=64)
    auth_mode: Literal["client_secret", "workload_identity", "managed_identity"] = (
        "workload_identity"
    )
    credential_ref: str = Field(default="", max_length=255)


class ConnectionOut(ORMModel):
    id: Any
    subscription_id: str
    display_name: str
    azure_tenant_id: str
    auth_mode: str
    state: str
    granted_roles: list[str] = []
    is_enabled: bool
    last_verified_at: datetime | None = None
    last_error: str | None = None


# --- dashboard --------------------------------------------------------
class KeyedAmount(BaseModel):
    key: str
    cost: float
    currency: str = "USD"


# --- detailed cost / billing lines ------------------------------------
class MeterBreakdownOut(BaseModel):
    """One aggregated billing meter, with the billed quantity behind the cost."""

    meter_category: str
    meter_subcategory: str
    meter: str
    meter_region: str
    unit_of_measure: str
    quantity: float
    cost: float
    effective_price: float
    currency: str = "USD"
    is_bandwidth: bool = False


class UsageLineOut(ORMModel):
    """A raw Consumption usage-detail line — nothing rolled up, nothing hidden."""

    usage_date: date
    subscription_id: str
    azure_resource_id: str
    resource_name: str
    resource_group: str
    resource_type: str
    resource_location: str
    service_name: str
    meter: str
    meter_id: str
    meter_category: str
    meter_subcategory: str
    meter_region: str
    service_family: str
    product: str
    part_number: str
    quantity: float
    unit_of_measure: str
    unit_price: float
    effective_price: float
    cost: float
    amortized_cost: float
    currency: str
    charge_type: str
    frequency: str
    pricing_model: str
    publisher_type: str
    benefit_name: str
    reservation_id: str
    additional_info: dict[str, Any] = {}
    tags: dict[str, Any] = {}


class DataTransferPoint(BaseModel):
    date: date
    billed_cost: float
    billed_quantity_gb: float
    ingress_bytes: float
    egress_bytes: float


class DataTransferResourceOut(BaseModel):
    azure_resource_id: str
    resource_name: str
    resource_type: str
    resource_group: str
    location: str
    ingress_bytes: float
    egress_bytes: float
    billed_cost: float
    ip_addresses: list[str] = []


class PublicIpOut(BaseModel):
    """A public IP, what it is bound to, and the traffic billed through it."""

    azure_resource_id: str
    name: str
    ip_address: str
    allocation_method: str
    version: str
    sku: str
    resource_group: str
    location: str
    attached_to_id: str
    attached_to_name: str
    is_attached: bool
    ingress_bytes: float = 0.0
    egress_bytes: float = 0.0
    billed_cost: float = 0.0


class BandwidthReportOut(BaseModel):
    """Billed egress next to the volume that actually moved.

    `ingress_bytes` has no cost counterpart: Azure does not charge for inbound
    data, so it is absent from Cost Management entirely and is sourced from
    Azure Monitor throughput metrics instead.
    """

    period_start: date
    period_end: date
    currency: str = "USD"
    total_billed_cost: float
    total_billed_quantity_gb: float
    total_ingress_bytes: float
    total_egress_bytes: float
    ingress_is_free: bool = True
    daily: list[DataTransferPoint]
    meters: list[MeterBreakdownOut]
    top_resources: list[DataTransferResourceOut]
    public_ips: list[PublicIpOut] = []


class CostDimensionsOut(BaseModel):
    meter_categories: list[str]
    meter_subcategories: list[str]
    charge_types: list[str]
    pricing_models: list[str]
    services: list[str]
    regions: list[str]


class DashboardOut(BaseModel):
    period_start: date
    period_end: date
    currency: str = "USD"
    month_to_date_cost: Money
    forecast_month_cost: Money
    forecast_source: str
    previous_month_cost: Money
    cost_change_pct: float
    total_resources: int
    resources_by_type: dict[str, int]
    health: dict[str, int]
    active_alerts: int
    secure_score_pct: float | None
    advisor_recommendations: int
    potential_monthly_savings: Money
    cost_by_subscription: list[KeyedAmount]
    cost_by_resource_group: list[KeyedAmount]
    cost_by_service: list[KeyedAmount]
    daily_trend: list[dict[str, Any]]
    last_sync_at: datetime | None


# --- inventory --------------------------------------------------------
class ResourceOut(ORMModel):
    id: Any
    azure_resource_id: str
    name: str
    resource_type: str
    subscription_id: str
    subscription_name: str
    resource_group: str
    location: str
    sku: str
    power_state: str
    health_state: str
    owner: str
    tags: dict[str, Any] = {}
    monthly_cost: float | None = None
    synced_at: datetime | None = None


class MetricPoint(BaseModel):
    timestamp: datetime
    average: float | None = None
    maximum: float | None = None
    total: float | None = None
    unit: str = ""


class MetricSeriesOut(BaseModel):
    metric: str
    points: list[MetricPoint]


class ActivityOut(ORMModel):
    event_time: datetime
    operation: str
    status: str
    caller: str
    level: str
    description: str | None = None


class BackupOut(ORMModel):
    policy_name: str
    protection_state: str
    last_backup_status: str
    last_backup_time: datetime | None = None


class RecommendationOut(ORMModel):
    id: Any
    azure_resource_id: str
    resource_name: str
    rule: str
    category: str
    source: str
    impact: str
    confidence: str
    title: str
    recommended_action: str
    estimated_monthly_savings: float
    currency: str
    state: str
    evidence: dict[str, Any] = {}


class SecurityFindingOut(ORMModel):
    id: Any
    assessment_id: str
    azure_resource_id: str
    title: str
    severity: str
    status: str
    category: str
    remediation: str | None = None


class ResourceDetailOut(BaseModel):
    """Everything a resource page renders, in one round trip."""

    resource: ResourceOut
    cost_last_30_days: Money
    cost_daily: list[dict[str, Any]]
    cost_meters: list[MeterBreakdownOut] = []
    metrics: list[MetricSeriesOut]
    dependencies: list[str]
    activity: list[ActivityOut]
    alerts: list["AlertOut"]
    backup: BackupOut | None
    security_findings: list[SecurityFindingOut]
    recommendations: list[RecommendationOut]


# --- ops --------------------------------------------------------------
class AlertOut(ORMModel):
    id: Any
    rule: str
    rule_name: str
    azure_resource_id: str
    severity: str
    title: str
    description: str
    state: str
    triggered_at: datetime
    context: dict[str, Any] = {}


class AlertRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    kind: Literal[
        "budget_exceeded",
        "backup_failed",
        "vm_stopped",
        "high_cpu",
        "high_storage",
        "certificate_expiry",
        "security_incident",
    ]
    enabled: bool = True
    threshold: float | None = None
    window_minutes: int = Field(default=60, ge=5, le=10080)
    cooldown_minutes: int = Field(default=360, ge=5, le=10080)
    severity: Literal["low", "medium", "high", "critical"] = "medium"
    channels: list[Literal["in_app", "email", "webhook"]] = ["in_app"]
    recipients: list[str] = []
    scope: dict[str, Any] = {}


class NetworkExposureOut(ORMModel):
    id: Any
    nsg_name: str
    rule_name: str
    direction: str
    priority: int
    protocol: str
    source: str
    ports: list[Any] = []
    severity: str
    reason: str


class SecuritySummaryOut(BaseModel):
    secure_score_pct: float | None
    findings_by_severity: dict[str, int]
    expiring_secrets: int
    risky_identities: int
    users_without_mfa: int
    open_exposures: int


class ReportRequest(BaseModel):
    report_type: Literal[
        "cost_summary",
        "cost_detail",
        "bandwidth",
        "inventory",
        "optimization",
        "security",
        "alerts",
    ] = "cost_summary"
    export_format: Literal["pdf", "excel", "csv"] = "pdf"
    start: date | None = None
    end: date | None = None


class ReportRunOut(ORMModel):
    id: Any
    report_type: str
    export_format: str
    state: str
    blob_path: str
    error: str | None = None


class AssistantQuery(BaseModel):
    question: str = Field(min_length=3, max_length=1000)
    resource_id: str | None = None


class AssistantAnswer(BaseModel):
    answer: str
    used_tools: list[str]
    citations: list[dict[str, Any]]


# --- BOQ / infrastructure-as-code -------------------------------------
class BoqItemOut(BaseModel):
    service_category: str
    service_type: str
    custom_name: str = ""
    region: str = ""
    description: str = ""
    monthly_cost: float


class BoqOut(BaseModel):
    name: str
    file_name: str
    currency: str
    items: list[BoqItemOut]
    items_total: float
    infrastructure_subtotal: float | None = None
    managed_services: float | None = None
    support: float | None = None
    total_monthly: float


class PlannedResourceOut(BaseModel):
    kind: str
    name: str
    region: str
    count: int
    sku: str
    size_gib: int | None = None
    properties: dict[str, Any]
    source_line: str
    monthly_cost: float


class UnplannedLineOut(BaseModel):
    service_type: str
    custom_name: str = ""
    description: str = ""
    monthly_cost: float
    reason: str


class IacPlanOut(BaseModel):
    name: str
    currency: str
    resource_group: str
    location: str
    resources: list[PlannedResourceOut]
    needs_review: list[UnplannedLineOut]
    covered_monthly_cost: float
    total_monthly_cost: float


class IacTemplateOut(IacPlanOut):
    format: Literal["bicep", "terraform"]
    filename: str
    content: str


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class BoqChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    # The parsed BOQ from POST /boq/parse, echoed back by the client. Nothing is
    # persisted server-side, so the estimate never leaves the caller's session.
    boq: BoqOut | None = None
    history: list[ChatTurn] = Field(default_factory=list, max_length=20)
    resource_group: str = Field(default="rg-boq", max_length=90)


class ChatArtifactOut(BaseModel):
    format: str
    filename: str
    content: str


class BoqChatAnswer(BaseModel):
    answer: str
    used_tools: list[str]
    artifacts: list[ChatArtifactOut] = Field(default_factory=list)


ResourceDetailOut.model_rebuild()
