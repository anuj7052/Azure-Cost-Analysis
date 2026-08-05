from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
import re


# ── Tenant / Subscription ──────────────────────────────────────────────────

class TenantInfo(BaseModel):
    tenant_id: str
    tenant_name: str
    source: str = "delegated"  # "delegated" | "service_principal"


class SubscriptionInfo(BaseModel):
    subscription_id: str
    display_name: str
    tenant_id: str
    state: str


class AddTenantRequest(BaseModel):
    tenant_id: str
    tenant_name: str
    client_id: str
    client_secret: str

    @field_validator("tenant_id")
    @classmethod
    def validate_tenant_id(cls, v: str) -> str:
        # Basic GUID format validation
        pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        if not re.match(pattern, v):
            raise ValueError("tenant_id must be a valid GUID")
        return v

    @field_validator("client_id")
    @classmethod
    def validate_client_id(cls, v: str) -> str:
        pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        if not re.match(pattern, v):
            raise ValueError("client_id must be a valid GUID")
        return v

    @field_validator("client_secret")
    @classmethod
    def validate_secret_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("client_secret cannot be empty")
        return v


# ── Cost Query ─────────────────────────────────────────────────────────────

class CostQueryRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str]
    months: int = Field(default=6, ge=1, le=24)
    from_date: Optional[str] = None   # ISO date "YYYY-MM-DD" (overrides months)
    to_date: Optional[str] = None     # ISO date "YYYY-MM-DD" (overrides months)
    group_by: List[str] = Field(
        default=["ServiceName", "SubscriptionId"]
    )


class MonthlyCost(BaseModel):
    month: str          # "2026-01"
    total_cost: float
    currency: str = "USD"
    by_service: dict    # { "Virtual Machines": 1234.56, ... }
    by_subscription: dict


class CostQueryResponse(BaseModel):
    months: List[MonthlyCost]
    total_6m: float
    mom_change_pct: Optional[float]   # latest vs previous month
    top_services: List[dict]          # [{ name, cost, mom_change_pct }]
    anomalies: List[dict]             # [{ service, month, pct_change, reason }]
    savings: List[dict]               # [{ service, month, pct_change }]


# ── Services ───────────────────────────────────────────────────────────────

class ActiveService(BaseModel):
    name: str
    type: str
    resource_group: str
    subscription_id: str
    location: str
    tags: dict = {}


# ── CSV Upload ─────────────────────────────────────────────────────────────

class UploadedCostRecord(BaseModel):
    month: str
    service_name: str
    resource_group: str
    subscription_id: str
    cost: float
    currency: str


# ── Resource Group ─────────────────────────────────────────────────────────

class RgCostRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str]
    months: int = Field(default=6, ge=1, le=24)
    from_date: Optional[str] = None
    to_date: Optional[str] = None


class RgCostItem(BaseModel):
    rg_name: str
    total: float
    currency: str
    by_service: dict
    by_month: dict  # { "2026-01": 1234.56 }


class RgCostResponse(BaseModel):
    resource_groups: List[RgCostItem]
    total: float
    currency: str


# ── Daily Cost ─────────────────────────────────────────────────────────────

class DailyCostRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str]
    months: int = Field(default=1, ge=1, le=6)
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    resource_group: Optional[str] = None  # if set, filter by this RG


class DailyCostItem(BaseModel):
    date: str        # "2026-01-15"
    total: float
    currency: str
    by_service: dict


class DailyCostResponse(BaseModel):
    days: List[DailyCostItem]
    total: float
    currency: str


# ── Bandwidth / Data Transfer ──────────────────────────────────────────────

class BandwidthRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str]
    months: int = Field(default=6, ge=1, le=24)
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    granularity: str = "Monthly"   # "Monthly" | "Daily"


class BandwidthMeter(BaseModel):
    meter: str
    category: str
    direction: str        # egress | ingress | intra | other
    bytes: float
    quantity: float
    cost: float


class BandwidthMonth(BaseModel):
    month: str
    egress_bytes: float
    ingress_bytes: float
    intra_bytes: float
    other_bytes: float
    total_bytes: float
    cost: float


class BandwidthSubscription(BaseModel):
    subscription_id: str
    bytes: float
    cost: float
    egress_bytes: float = 0
    egress_cost: float = 0
    ingress_bytes: float = 0
    ingress_cost: float = 0
    intra_bytes: float = 0
    intra_cost: float = 0
    other_bytes: float = 0
    other_cost: float = 0
    cost_per_gb: float = 0
    meter_count: int = 0
    top_meter: Optional[str] = None


class BandwidthResponse(BaseModel):
    currency: str
    total_bytes: float
    total_cost: float
    cost_per_gb: float
    mom_change_pct: Optional[float] = None
    egress_bytes: float
    egress_cost: float
    ingress_bytes: float
    ingress_cost: float
    intra_bytes: float
    intra_cost: float
    other_bytes: float
    other_cost: float
    months: List[BandwidthMonth]
    meters: List[BandwidthMeter]
    by_subscription: List[BandwidthSubscription]
    errors: List[dict] = []
