from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
import json
import re

from core.pagination import PageInfo


# ── Accounts / admin ───────────────────────────────────────────────────────

INTEGRATION_KINDS = ("openai", "azure_openai", "webhook", "custom")


class Integration(BaseModel):
    """A customer-supplied endpoint. The key is never returned, only a hint."""
    id: int
    label: str
    kind: str
    base_url: str = ""
    model: str = ""
    enabled: bool = True
    has_key: bool = False
    key_hint: str = ""
    created_at: Optional[str] = None


class CreateIntegrationRequest(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    kind: str = "openai"
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    enabled: bool = True

    @field_validator("kind")
    @classmethod
    def _kind(cls, v: str) -> str:
        if v not in INTEGRATION_KINDS:
            raise ValueError(f"kind must be one of {', '.join(INTEGRATION_KINDS)}")
        return v

    @field_validator("base_url")
    @classmethod
    def _base_url(cls, v: str) -> str:
        v = (v or "").strip()
        # Anything other than https would send the customer's own key over the
        # wire in the clear. localhost is allowed for development gateways.
        if v and not (v.startswith("https://") or v.startswith("http://localhost")):
            raise ValueError("base_url must start with https://")
        return v


class UpdateIntegrationRequest(BaseModel):
    label: Optional[str] = Field(default=None, min_length=1, max_length=60)
    kind: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None      # omit to keep the stored key
    enabled: Optional[bool] = None

    @field_validator("kind")
    @classmethod
    def _kind(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in INTEGRATION_KINDS:
            raise ValueError(f"kind must be one of {', '.join(INTEGRATION_KINDS)}")
        return v

    @field_validator("base_url")
    @classmethod
    def _base_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if v and not (v.startswith("https://") or v.startswith("http://localhost")):
            raise ValueError("base_url must start with https://")
        return v


class UserSummary(BaseModel):
    id: int
    email: str
    name: str
    role: str                      # "user" | "admin"
    status: str                    # "active" | "suspended"
    azure_tenant_id: str = ""
    created_at: Optional[str] = None
    last_login_at: Optional[str] = None
    tenant_count: int = 0
    # Whatever the person typed into their profile. Entra sign-in tokens carry
    # no phone number, so this is empty until they fill it in, and the admin
    # centre says "Not available" rather than inventing one.
    phone: str = ""
    login_count: int = 0
    # Whole days since the account was created. This is account age, not days
    # of measured usage -- the app does not record a per-day activity log, so
    # calling it "days active" would claim more than is known.
    days_since_registered: Optional[int] = None
    # "Administrator" or "Standard", plus who they belong to when they are an
    # invited member rather than a workspace owner.
    access_level: str = "Standard"
    is_owner: bool = True
    owner_email: str = ""
    team_size: int = 0


class TeamMember(BaseModel):
    id: Optional[int] = None
    email: str
    name: str = ""
    phone: str = ""
    state: str                     # "accepted" | "pending"
    account_status: str = ""
    joined_at: Optional[str] = None
    last_login_at: Optional[str] = None
    login_count: int = 0
    invitation_id: Optional[int] = None


class TeamOverview(BaseModel):
    is_owner: bool
    owner_email: str = ""
    limit: int
    used: int
    remaining: int
    accepted: int
    pending: int
    members: List[TeamMember] = []


class InviteRequest(BaseModel):
    email: str


class ProfileUpdate(BaseModel):
    phone: Optional[str] = None

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, v):
        if v is None:
            return v
        v = v.strip()
        if len(v) > 32:
            raise ValueError("Phone number is too long.")
        # Deliberately permissive: country formats vary far too much to
        # validate properly, and rejecting a real number is worse than storing
        # an odd one. Only characters that could not belong are refused.
        if v and not all(c.isdigit() or c in " +-()" for c in v):
            raise ValueError("Phone number can only contain digits and + - ( ) spaces.")
        return v


class UserConnection(BaseModel):
    tenant_id: str
    tenant_name: str
    source: str                    # "service_principal" | "session_token"
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    account: Optional[str] = None


class UserDetail(UserSummary):
    connections: List[UserConnection] = []


class UpdateUserRequest(BaseModel):
    role: Optional[str] = None
    status: Optional[str] = None

    @field_validator("role")
    @classmethod
    def valid_role(cls, v):
        if v is not None and v not in ("user", "admin"):
            raise ValueError("role must be 'user' or 'admin'")
        return v

    @field_validator("status")
    @classmethod
    def valid_status(cls, v):
        if v is not None and v not in ("active", "suspended"):
            raise ValueError("status must be 'active' or 'suspended'")
        return v


# ── Tenant / Subscription ──────────────────────────────────────────────────

class TenantInfo(BaseModel):
    tenant_id: str
    tenant_name: str
    source: str = "delegated"  # "delegated" | "service_principal" | "session_token"
    expires_at: Optional[str] = None      # session tokens only
    account: Optional[str] = None         # who the session token belongs to
    subscription_count: Optional[int] = None


class SubscriptionInfo(BaseModel):
    subscription_id: str
    display_name: str
    tenant_id: str
    state: str


class AddSessionTokenRequest(BaseModel):
    """A raw Azure management access token pasted by the user."""
    access_token: str
    tenant_name: Optional[str] = None

    @field_validator("access_token")
    @classmethod
    def strip_bearer(cls, v: str) -> str:
        """Accept whatever the user pasted and dig the raw JWT out of it.

        People paste the whole `az account get-access-token` JSON blob far more
        often than the bare token, so pull `accessToken` out of it rather than
        making them edit the text by hand.
        """
        v = (v or "").strip()

        # Whole JSON output from `az account get-access-token`.
        if v.startswith("{"):
            try:
                blob = json.loads(v)
            except ValueError:
                raise ValueError(
                    "That looks like JSON but it could not be parsed. Paste the full "
                    "output of `az account get-access-token`, or just the accessToken value."
                )
            token = blob.get("accessToken") or blob.get("access_token")
            if not token:
                raise ValueError("That JSON has no 'accessToken' field.")
            v = str(token).strip()

        v = v.strip().strip('"').strip("'").strip()
        if v.lower().startswith("bearer "):
            v = v[7:].strip()
        # A token copied out of a terminal can arrive with wrapped lines; a JWT
        # never contains whitespace, so anything in the middle is safe to drop.
        v = "".join(v.split())
        if not v:
            raise ValueError("Access token is required")
        return v


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


# ── Pricing model (reserved vs on-demand) ──────────────────────────────────

class PricingServiceSplit(BaseModel):
    service: str
    total: float
    reserved: float = 0.0
    on_demand: float = 0.0
    spot: float = 0.0
    savings_plan: float = 0.0


class PricingMonthSplit(BaseModel):
    month: str
    reserved: float = 0.0
    on_demand: float = 0.0
    spot: float = 0.0
    savings_plan: float = 0.0
    total: float = 0.0


class PricingResponse(BaseModel):
    currency: str = "USD"
    total: float = 0.0
    reserved: float = 0.0
    savings_plan: float = 0.0
    spot: float = 0.0
    on_demand: float = 0.0
    committed: float = 0.0
    # None when there is no spend at all. Zero spend is not full coverage, and
    # reporting 100% for an empty subscription would be actively misleading.
    committed_pct: Optional[float] = None
    by_model: dict = {}
    services: List[PricingServiceSplit] = []
    months: List[PricingMonthSplit] = []
    # False when Azure never returned the PricingModel dimension — the split
    # cannot be drawn and the UI has to say why rather than show zeroes.
    has_pricing_data: bool = False
    errors: List[dict] = []


class ReservedMeter(BaseModel):
    name: str
    cost: float


class ReservedResource(BaseModel):
    resource_id: str
    # "Unattributed" when Azure bills the reservation at the scope rather than
    # against a specific resource — a real case, not a parsing failure.
    name: str
    resource_group: str = ""
    subscription_id: str = ""
    resource_type: str = ""
    service: str = ""
    cost: float = 0.0
    # The meter name carries the SKU (e.g. "D2s v3"), which is what a renewal
    # decision turns on, so meters are kept rather than summed away.
    meters: List[ReservedMeter] = []


class ReservedDetailResponse(BaseModel):
    currency: str = "USD"
    total: float = 0.0
    resource_count: int = 0
    resources: List[ReservedResource] = []
    errors: List[dict] = []


# ── Scans and search ───────────────────────────────────────────────────────

class ScanRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str]


class ScanSummary(BaseModel):
    id: int
    tenant_id: str
    status: str                     # "running" | "complete" | "failed"
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    resource_count: int = 0
    error: Optional[str] = None


class SearchResult(BaseModel):
    resource_id: str
    name: str
    type: str
    resource_group: str
    subscription_id: str
    location: str
    sku: str = ""
    tags: dict = {}
    # False means the resource was present in an earlier scan but not the latest
    # one — the deleted-resource case the Azure portal cannot answer at all.
    live: bool
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None


class SearchResponse(BaseModel):
    results: List[SearchResult]
    total: int
    # None means no completed scan exists yet, which is a different answer to
    # "nothing matched" and needs a different prompt in the UI.
    latest_scan_id: Optional[int] = None
    truncated: bool = False
    # Additive: existing callers ignore it, paging callers use it. Optional so
    # the field can appear without breaking any current consumer.
    page: Optional[PageInfo] = None


# ── Microsoft published (retail) prices ────────────────────────────────────

class SavingsPlanPrice(BaseModel):
    term: Optional[str] = None
    unit_price: Optional[float] = None


class RetailPrice(BaseModel):
    # Microsoft's stable identity for a meter. Names get reworded and regions
    # renamed, so price history keys on this rather than on anything readable.
    meter_id: str = ""
    sku_id: str = ""
    product_id: str = ""
    meter_name: str = ""
    sku_name: str = ""
    arm_sku_name: str = ""
    product_name: str = ""
    service_name: str = ""
    service_family: str = ""
    region: str = ""
    location: str = ""
    unit_of_measure: str = ""
    retail_price: Optional[float] = None
    unit_price: Optional[float] = None
    currency: str = "USD"
    price_type: str = ""
    reservation_term: Optional[str] = None
    savings_plans: List[SavingsPlanPrice] = []
    effective_from: Optional[str] = None


class RetailPriceResponse(BaseModel):
    prices: List[RetailPrice] = []
    count: int = 0
    # Azure lists several meters per size (Windows/Linux, spot/standard), so the
    # cheapest is surfaced with its meter name rather than presented as "the"
    # price for that size.
    cheapest: Optional[RetailPrice] = None
    currency: str = "USD"
    # Echoed so the caller can reproduce the query against Microsoft's docs.
    odata_filter: str = ""
    # True for any non-USD currency: Microsoft prices in USD and converts for
    # reference only, so those figures are estimates.
    is_reference_currency: bool = False


# ── BOQ generated from a live subscription ─────────────────────────────────

class GeneratedBoqItem(BaseModel):
    service: str
    spec: str
    region: str
    quantity: int
    # None when Cost Management reported nothing for any resource in the group.
    # Not the same as free — the query may simply have been throttled.
    unit_monthly_cost: Optional[float] = None
    monthly_cost: float = 0.0
    resource_groups: List[str] = []
    examples: List[str] = []
    priced_quantity: int = 0


class GeneratedBoqResponse(BaseModel):
    items: List[GeneratedBoqItem] = []
    currency: str = "USD"
    total_monthly: float = 0.0
    # A projection of current spend, not a commitment.
    total_yearly: float = 0.0
    resource_count: int = 0
    line_count: int = 0
    # How many resources carried no billed cost, so the total can be read
    # honestly rather than as complete.
    unpriced_count: int = 0


# ── Activity log (who changed what) ────────────────────────────────────────

class ActivityEvent(BaseModel):
    id: str = ""
    at: str = ""
    # A user principal name for a person, a GUID for a service principal.
    # "an application did this" is a different answer to "we do not know".
    caller: str = "Unknown"
    operation: str = ""
    summary: str = ""
    status: str = ""
    succeeded: bool = True
    resource_id: str = ""
    resource_group: str = ""
    subscription_id: str = ""
    level: str = ""
    is_write: bool = False


class ActivityCount(BaseModel):
    caller: Optional[str] = None
    operation: Optional[str] = None
    count: int = 0


class ActivityResponse(BaseModel):
    events: List[ActivityEvent] = []
    total: int = 0
    failed: int = 0
    callers: List[ActivityCount] = []
    operations: List[ActivityCount] = []
    # Azure keeps roughly 90 days. Older changes have an actor that no longer
    # exists anywhere, which the UI has to say rather than show an empty list.
    retention_days: int = 90
    window_days: int = 7
    errors: List[dict] = []


# ── Change tracking ────────────────────────────────────────────────────────

class TagChange(BaseModel):
    added: dict = {}
    removed: dict = {}
    changed: dict = {}


class FieldChange(BaseModel):
    field: str
    label: str
    # Populated for scalar fields; tags carry a per-key breakdown instead,
    # because a whole-blob before/after is unreadable once there are more than
    # a couple of tags.
    from_: Optional[str] = Field(default=None, alias="from")
    to: Optional[str] = None
    tags: Optional[TagChange] = None

    model_config = {"populate_by_name": True}


class ChangedResource(BaseModel):
    resource_id: str
    name: str
    type: str = ""
    resource_group: str = ""
    subscription_id: str = ""
    location: str = ""
    sku: str = ""
    tags: dict = {}
    changes: List[FieldChange] = []


class ScanRef(BaseModel):
    id: int
    started_at: Optional[str] = None


class ChangeDiffResponse(BaseModel):
    added: List[ChangedResource] = []
    removed: List[ChangedResource] = []
    modified: List[ChangedResource] = []
    added_count: int = 0
    removed_count: int = 0
    modified_count: int = 0
    total_changes: int = 0
    before: Optional[ScanRef] = None
    after: Optional[ScanRef] = None
    # False when fewer than two completed scans exist. A new user has nothing to
    # compare yet, which is a state to explain rather than an error.
    comparable: bool = False
    # Why a comparison could not be made, or which capture a date resolved to.
    # A range that silently resolved elsewhere would be impossible to trust.
    note: Optional[str] = None


class HistoryEvent(BaseModel):
    scan_id: int
    at: Optional[str] = None
    kind: str                      # "first_seen" | "modified" | "removed"
    changes: List[FieldChange] = []


class EntityHistoryResponse(BaseModel):
    resource: Optional[ChangedResource] = None
    events: List[HistoryEvent] = []
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    scan_count: int = 0


# ── Orphaned resources ─────────────────────────────────────────────────────

class OrphanedRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str]


class OrphanedItem(BaseModel):
    id: str
    name: str
    type: str
    resource_group: str
    subscription_id: str
    location: str
    tags: dict = {}
    detail: str = ""
    # None means "Cost Management did not report a charge for this resource",
    # which is not the same as "it is free" — the query may have been throttled.
    monthly_cost: Optional[float] = None


class OrphanedCategory(BaseModel):
    key: str
    title: str
    severity: str            # "certain" | "likely"
    reason: str
    count: int
    monthly_cost: float
    items: List[OrphanedItem]


class OrphanedResponse(BaseModel):
    categories: List[OrphanedCategory]
    total_count: int
    total_monthly_cost: float
    currency: str = "USD"
    errors: List[dict] = []


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


class Coverage(BaseModel):
    """
    What a result actually covers.

    Any subscription can fail on its own, and the total is still a number that
    looks like an answer. It is only the answer for the subscriptions that
    responded, so every aggregate says which those were.
    """
    source: str = "Azure Cost Management"
    fetched_at: Optional[str] = None
    requested_subscriptions: int = 0
    succeeded_subscriptions: int = 0
    failed_subscriptions: List[str] = []
    partial: bool = False
    errors: List[dict] = []


class CostQueryResponse(BaseModel):
    months: List[MonthlyCost]
    total_6m: float
    mom_change_pct: Optional[float]   # latest vs previous month
    top_services: List[dict]          # [{ name, cost, mom_change_pct }]
    anomalies: List[dict]             # [{ service, month, pct_change, reason }]
    savings: List[dict]               # [{ service, month, pct_change }]
    # Never omitted. A total with no coverage cannot be told apart from a
    # complete one, which is exactly the confusion this field exists to stop.
    coverage: Optional[Coverage] = None


class CostRow(BaseModel):
    """One month of one meter — the granularity month-over-month analysis needs."""
    month: str                        # "2026-07"
    cost: float
    quantity: float = 0.0
    unit_of_measure: str = ""
    service: str = ""
    meter: str = ""
    resource_group: str = ""
    resource_name: str = ""
    subscription_id: str = ""
    region: str = ""


class CostRowsResponse(BaseModel):
    rows: List[CostRow]
    months: List[str]
    currency: str = "USD"
    errors: List[dict] = []


# ── Services ───────────────────────────────────────────────────────────────

class ServiceMeter(BaseModel):
    name: str
    cost: float


class ActiveService(BaseModel):
    name: str
    type: str
    resource_group: str
    subscription_id: str
    location: str
    tags: dict = {}
    # Size and price of the resource. All optional: Resource Graph does not
    # report a SKU for every provider, and Cost Management only knows about
    # resources that have actually been billed.
    sku: str = ""
    size: str = ""
    tier: str = ""
    service: str = ""
    cost: Optional[float] = None
    currency: str = "USD"
    meters: List[ServiceMeter] = []


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
