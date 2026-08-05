from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date

from fastapi import APIRouter, Depends, Query

from app.auth.dependencies import CurrentUser, DbSession, require
from app.auth.rbac import Permission
from app.schemas import (
    BandwidthReportOut,
    CostDimensionsOut,
    DashboardOut,
    KeyedAmount,
    MeterBreakdownOut,
    Page,
    UsageLineOut,
)
from app.services import fx
from app.services.cost_service import CostService
from app.services.dashboard_service import DashboardService
from app.services.periods import Period, last_n_days, month_to_date

router = APIRouter(dependencies=[Depends(require(Permission.READ))])


@dataclass(frozen=True, slots=True)
class CostFilters:
    """Filters every cost view shares: time window, scope and display currency."""

    period: Period
    subscription_id: str | None
    currency: str | None
    explicit_period: bool


def _month_period(month: str) -> Period:
    """Expand `YYYY-MM` into a calendar month, never running past today."""
    year, mon = (int(part) for part in month.split("-"))
    start = date(year, mon, 1)
    end = date(year, mon, calendar.monthrange(year, mon)[1])
    today = date.today()
    return Period(start, min(end, today) if start <= today <= end else end)


def cost_filters(
    start: date | None = Query(None, description="Custom range start (inclusive)"),
    end: date | None = Query(None, description="Custom range end (inclusive)"),
    month: str | None = Query(
        None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$", description="Calendar month YYYY-MM"
    ),
    subscription_id: str | None = Query(
        None, max_length=64, description="Limit to one subscription; omit for all"
    ),
    currency: str | None = Query(
        None,
        pattern="^[A-Za-z]{3}$",
        description=f"Reporting currency, one of {', '.join(fx.SUPPORTED_CURRENCIES)}",
    ),
) -> CostFilters:
    explicit = True
    if start and end:
        period = Period(min(start, end), max(start, end))
    elif month:
        period = _month_period(month)
    else:
        period = month_to_date()
        explicit = False
    return CostFilters(
        period=period,
        subscription_id=subscription_id or None,
        currency=currency or None,
        explicit_period=explicit,
    )


Filters = Depends(cost_filters)


def _service(db, principal, filters: CostFilters) -> CostService:
    return CostService(
        db,
        principal.tenant_id,
        subscription_id=filters.subscription_id,
        currency=filters.currency,
    )


@router.get("/dashboard", response_model=DashboardOut, tags=["dashboard"])
async def dashboard(
    principal: CurrentUser, db: DbSession, filters: CostFilters = Filters
) -> DashboardOut:
    return await DashboardService(
        db,
        principal.tenant_id,
        subscription_id=filters.subscription_id,
        currency=filters.currency,
    ).build(filters.period)


@router.get("/costs/currencies", tags=["costs"])
async def cost_currencies():
    """Currencies the reporting layer can convert into."""
    return {"currencies": list(fx.SUPPORTED_CURRENCIES)}


@router.get("/costs/summary", tags=["costs"])
async def cost_summary(
    principal: CurrentUser, db: DbSession, filters: CostFilters = Filters
):
    service = _service(db, principal, filters)
    forecast, forecast_source = await service.forecast()
    return {
        "period_start": filters.period.start,
        "period_end": filters.period.end,
        "month_to_date": await service.total(filters.period),
        "month_to_date_amortized": await service.total(filters.period, amortized=True),
        "forecast": forecast,
        "forecast_source": forecast_source,
        "previous_month": await service.previous_month_total(),
    }


@router.get("/costs/breakdown", response_model=list[KeyedAmount], tags=["costs"])
async def cost_breakdown(
    principal: CurrentUser,
    db: DbSession,
    dimension: str = Query(
        "service",
        pattern="^(subscription|resource_group|resource_type|service|resource)$",
    ),
    limit: int = Query(20, ge=1, le=100),
    filters: CostFilters = Filters,
):
    return await _service(db, principal, filters).breakdown(
        dimension, filters.period, limit=limit
    )


@router.get("/costs/by-tag", response_model=list[KeyedAmount], tags=["costs"])
async def cost_by_tag(
    principal: CurrentUser,
    db: DbSession,
    tag_key: str = Query(min_length=1, max_length=128),
    limit: int = Query(20, ge=1, le=100),
    filters: CostFilters = Filters,
):
    return await _service(db, principal, filters).breakdown_by_tag(
        tag_key, filters.period, limit=limit
    )


@router.get("/costs/trend", tags=["costs"])
async def cost_trend(
    principal: CurrentUser,
    db: DbSession,
    days: int = Query(30, ge=7, le=365),
    filters: CostFilters = Filters,
):
    # An explicit window wins; `days` stays the default rolling view.
    period = filters.period if filters.explicit_period else last_n_days(days)
    return await _service(db, principal, filters).trend(period)


@router.get("/costs/anomalies", tags=["costs"])
async def cost_anomalies(
    principal: CurrentUser,
    db: DbSession,
    days: int = Query(30, ge=14, le=90),
    filters: CostFilters = Filters,
):
    return await _service(db, principal, filters).anomalies(last_n_days(days))


@router.get("/costs/meters", response_model=list[MeterBreakdownOut], tags=["costs"])
async def cost_meters(
    principal: CurrentUser,
    db: DbSession,
    meter_category: str | None = Query(None, max_length=128),
    resource_id: str | None = Query(None, max_length=1024),
    limit: int = Query(200, ge=1, le=1000),
    filters: CostFilters = Filters,
):
    """Every billing meter with its billed quantity, unit and effective price."""
    return await _service(db, principal, filters).meters(
        filters.period,
        meter_category=meter_category,
        azure_resource_id=resource_id,
        limit=limit,
    )


@router.get(
    "/costs/usage-details", response_model=Page[UsageLineOut], tags=["costs"]
)
async def cost_usage_details(
    principal: CurrentUser,
    db: DbSession,
    resource_id: str | None = Query(None, max_length=1024),
    meter_category: str | None = Query(None, max_length=128),
    search: str | None = Query(None, max_length=128),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    filters: CostFilters = Filters,
):
    """Raw Consumption usage-detail lines — the full, un-rolled-up billing grain."""
    return await _service(db, principal, filters).usage_lines(
        filters.period,
        azure_resource_id=resource_id,
        meter_category=meter_category,
        search=search,
        limit=limit,
        offset=offset,
    )


@router.get("/costs/bandwidth", response_model=BandwidthReportOut, tags=["costs"])
async def cost_bandwidth(
    principal: CurrentUser, db: DbSession, filters: CostFilters = Filters
):
    """Billed egress plus measured ingress/egress volume (ingress is never billed)."""
    return await _service(db, principal, filters).bandwidth(filters.period)


@router.get("/costs/dimensions", response_model=CostDimensionsOut, tags=["costs"])
async def cost_dimensions(
    principal: CurrentUser, db: DbSession, filters: CostFilters = Filters
):
    return await _service(db, principal, filters).dimensions()

