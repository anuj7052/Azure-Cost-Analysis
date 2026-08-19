from fastapi import APIRouter, Depends, HTTPException
import aiosqlite
from auth.dependencies import get_current_user
from services.token_resolver import resolve_tenant_token
from services.cost_client import (
    gather_by_subscription,
    query_costs,
    query_usage,
    friendly_error,
    summarise_errors,
)
from services.analysis import (
    aggregate_by_month,
    build_summary,
    aggregate_by_rg,
    aggregate_daily,
    to_cost_rows,
)
from models.schemas import (
    CostQueryRequest, CostQueryResponse,
    CostRow, CostRowsResponse,
    RgCostRequest, RgCostResponse, RgCostItem,
    DailyCostRequest, DailyCostResponse, DailyCostItem,
    PricingResponse, ReservedDetailResponse,
)
from services.pricing import summarise_pricing, reserved_detail
from core.db import get_db

router = APIRouter(prefix="/api/costs", tags=["costs"])


@router.post("", response_model=CostQueryResponse)
async def get_costs(
    body: CostQueryRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Query Azure Cost Management for the specified subscriptions over N months.
    Aggregates data from all subscriptions and returns analysis summary.
    """
    # Determine token
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    # Query each subscription and combine
    all_records = []
    errors = []
    for sub_id in body.subscription_ids:
        try:
            records = await query_costs(
                token=token,
                subscription_id=sub_id,
                months=body.months,
                group_by=body.group_by,
                from_date=getattr(body, 'from_date', None),
                to_date=getattr(body, 'to_date', None),
            )
            all_records.extend(records)
        except Exception as exc:
            errors.append({"subscription_id": sub_id, "error": friendly_error(exc)})

    if not all_records and errors:
        raise HTTPException(
            status_code=502,
            detail=summarise_errors(errors),
        )

    monthly = aggregate_by_month(all_records)
    summary = build_summary(monthly)
    return CostQueryResponse(**summary)


async def _get_token(body_tenant_id: str, current_user: dict, db: aiosqlite.Connection) -> str:
    """Helper: resolve token for a given tenant_id."""
    return await resolve_tenant_token(body_tenant_id, current_user, db)


@router.post("/rows", response_model=CostRowsResponse)
async def get_cost_rows(
    body: CostQueryRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Monthly cost *and usage quantity* per meter, flattened one row per month.

    This is the same shape the CSV/Excel import produces, so the month-over-month
    comparison works identically on live Azure data and on an uploaded file —
    including splitting a rise into "used more" versus "charged more per unit",
    which needs the quantity alongside the cost.
    """
    token = await _get_token(body.tenant_id, current_user, db)

    async def read_sub(sub_id: str):
        return await query_usage(
            token=token,
            subscription_id=sub_id,
            months=body.months,
            # Three dimensions is the most the Cost Management query API accepts,
            # and ResourceId is not one it will group a usage-quantity query by,
            # so the group name is the finest split available here.
            group_by=["ServiceName", "ResourceGroupName", "Meter"],
            granularity="Monthly",
            from_date=body.from_date,
            to_date=body.to_date,
        )

    records, errors = await gather_by_subscription(body.subscription_ids, read_sub)

    if not records and errors:
        raise HTTPException(status_code=502, detail=summarise_errors(errors, "cost detail"))

    rows = [CostRow(**r) for r in to_cost_rows(records)]
    months = sorted({r.month for r in rows})
    currency = next((r.get("Currency") for r in records if r.get("Currency")), "USD")
    return CostRowsResponse(rows=rows, months=months, currency=currency, errors=errors)


@router.post("/rg", response_model=RgCostResponse)
async def get_rg_costs(
    body: RgCostRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return total cost split by Resource Group for the given subscriptions."""
    token = await _get_token(body.tenant_id, current_user, db)

    all_records = []
    errors = []
    for sub_id in body.subscription_ids:
        try:
            records = await query_costs(
                token=token,
                subscription_id=sub_id,
                months=body.months,
                group_by=["ResourceGroupName", "ServiceName"],
                granularity="Monthly",
                from_date=getattr(body, 'from_date', None),
                to_date=getattr(body, 'to_date', None),
            )
            all_records.extend(records)
        except Exception as exc:
            errors.append({"subscription_id": sub_id, "error": friendly_error(exc)})

    if not all_records and errors:
        raise HTTPException(status_code=502, detail=summarise_errors(errors, "resource group costs"))

    rg_map = aggregate_by_rg(all_records)
    rg_items = [RgCostItem(**v) for v in rg_map.values()]
    total = round(sum(r.total for r in rg_items), 2)
    currency = rg_items[0].currency if rg_items else "USD"
    return RgCostResponse(resource_groups=rg_items, total=total, currency=currency)


@router.post("/daily", response_model=DailyCostResponse)
async def get_daily_costs(
    body: DailyCostRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return daily cost breakdown for the given subscriptions (last N months)."""
    token = await _get_token(body.tenant_id, current_user, db)

    group_by = ["ServiceName"]
    if body.resource_group:
        # We cannot filter by RG in the query body directly per Azure API constraints,
        # so we group by RG and filter post-query.
        group_by = ["ResourceGroupName", "ServiceName"]

    all_records = []
    errors = []
    for sub_id in body.subscription_ids:
        try:
            records = await query_costs(
                token=token,
                subscription_id=sub_id,
                months=body.months,
                group_by=group_by,
                granularity="Daily",
                from_date=getattr(body, 'from_date', None),
                to_date=getattr(body, 'to_date', None),
            )
            all_records.extend(records)
        except Exception as exc:
            errors.append({"subscription_id": sub_id, "error": friendly_error(exc)})

    if not all_records and errors:
        raise HTTPException(status_code=502, detail=summarise_errors(errors, "daily costs"))

    # Filter by resource group if requested
    if body.resource_group:
        rg_lower = body.resource_group.lower()
        all_records = [
            r for r in all_records
            if (r.get("ResourceGroupName") or r.get("ResourceGroup") or "").lower() == rg_lower
        ]

    daily_map = aggregate_daily(all_records)
    day_items = [DailyCostItem(**v) for v in daily_map.values()]
    total = round(sum(d.total for d in day_items), 2)
    currency = day_items[0].currency if day_items else "USD"
    return DailyCostResponse(days=day_items, total=total, currency=currency)


@router.post("/pricing", response_model=PricingResponse)
async def get_pricing_split(
    body: CostQueryRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Split spend into reserved, on-demand, spot and savings-plan.

    A single total answers "what did we spend" but not the question actually
    asked about reservations: how much is already committed, and how much is
    still being bought at list price.

    The split comes from Azure's PricingModel dimension rather than from meter
    names, because a VM meter looks identical whether or not a reservation
    happened to cover it.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    async def read_sub(sub_id: str):
        return await query_costs(
            token=token,
            subscription_id=sub_id,
            months=body.months,
            group_by=["PricingModel", "ServiceName"],
            granularity="Monthly",
            from_date=body.from_date,
            to_date=body.to_date,
        )

    records, errors = await gather_by_subscription(body.subscription_ids, read_sub)

    if not records and errors:
        raise HTTPException(
            status_code=502, detail=summarise_errors(errors, "reservation coverage")
        )

    return PricingResponse(**summarise_pricing(records), errors=errors)


@router.post("/pricing/reserved", response_model=ReservedDetailResponse)
async def get_reserved_detail(
    body: CostQueryRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Which resources the reservation actually paid for.

    "You spent X on reserved instances" is not actionable by itself; the next
    question is always *which* machines, in *which* resource group, on *which*
    SKU. This resolves each reserved charge back to the resource and meter
    behind it.

    Deliberately a separate endpoint rather than part of the pricing summary:
    it costs an extra Cost Management query per subscription, and Azure
    throttles those hard, so it only runs when somebody opens the detail.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    async def read_sub(sub_id: str):
        return await query_costs(
            token=token,
            subscription_id=sub_id,
            months=body.months,
            # Three dimensions is the maximum Cost Management accepts, so these
            # are the three that identify a charge: how it was priced, what it
            # was spent on, and which meter (the SKU) billed it.
            group_by=["PricingModel", "ResourceId", "Meter"],
            granularity="Monthly",
            from_date=body.from_date,
            to_date=body.to_date,
        )

    records, errors = await gather_by_subscription(body.subscription_ids, read_sub)

    if not records and errors:
        raise HTTPException(
            status_code=502, detail=summarise_errors(errors, "reservation detail")
        )

    return ReservedDetailResponse(**reserved_detail(records), errors=errors)
