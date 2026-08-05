from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.auth.dependencies import CurrentUser, DbSession, require
from app.auth.rbac import Permission
from app.repositories import MetricRepo
from app.schemas import (
    MetricPoint,
    MetricSeriesOut,
    Page,
    ResourceDetailOut,
    ResourceOut,
)
from app.services.inventory_service import InventoryService

router = APIRouter(tags=["inventory"], dependencies=[Depends(require(Permission.READ))])


@router.get("/resources", response_model=Page[ResourceOut])
async def list_resources(
    principal: CurrentUser,
    db: DbSession,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    type: str | None = Query(None, alias="type"),
    subscription_id: str | None = None,
    resource_group: str | None = None,
    location: str | None = None,
    tag_key: str | None = None,
    tag_value: str | None = None,
    search: str | None = Query(None, max_length=200),
) -> Page[ResourceOut]:
    items, total = await InventoryService(db, principal.tenant_id).list_resources(
        limit=limit,
        offset=offset,
        resource_type=type,
        subscription_id=subscription_id,
        resource_group=resource_group,
        location=location,
        tag_key=tag_key,
        tag_value=tag_value,
        search=search,
    )
    return Page[ResourceOut](items=items, total=total, limit=limit, offset=offset)


@router.get("/resources/detail", response_model=ResourceDetailOut)
async def resource_detail(
    principal: CurrentUser,
    db: DbSession,
    resource_id: str = Query(min_length=10, max_length=1024, description="ARM resource id"),
) -> ResourceDetailOut:
    return await InventoryService(db, principal.tenant_id).detail(resource_id)


@router.get("/resources/metrics", response_model=MetricSeriesOut)
async def resource_metric(
    principal: CurrentUser,
    db: DbSession,
    resource_id: str = Query(min_length=10, max_length=1024),
    metric: str = Query(min_length=1, max_length=64),
    hours: int = Query(24, ge=1, le=720),
) -> MetricSeriesOut:
    points = await MetricRepo(db, principal.tenant_id).series(
        resource_id, metric, hours=hours
    )
    return MetricSeriesOut(
        metric=metric,
        points=[
            MetricPoint(
                timestamp=p.timestamp,
                average=float(p.average) if p.average is not None else None,
                maximum=float(p.maximum) if p.maximum is not None else None,
                total=float(p.total) if p.total is not None else None,
                unit=p.unit,
            )
            for p in points
        ],
    )
