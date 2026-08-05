from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.integrations.azure.cost import is_bandwidth_meter
from app.models.inventory import (
    ActivityLogEntry,
    BackupStatus,
    MetricSample,
    Resource,
)
from app.models.ops import Alert, Recommendation, SecurityFinding
from app.repositories import (
    ActivityRepo,
    AlertRepo,
    BackupRepo,
    CostRepo,
    MetricRepo,
    RecommendationRepo,
    ResourceRepo,
    SecurityFindingRepo,
)
from app.schemas import (
    ActivityOut,
    AlertOut,
    BackupOut,
    MeterBreakdownOut,
    MetricPoint,
    MetricSeriesOut,
    Money,
    RecommendationOut,
    ResourceDetailOut,
    ResourceOut,
    SecurityFindingOut,
)
from app.services.periods import last_n_days


class InventoryService:
    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.resources = ResourceRepo(session, tenant_id)
        self.metrics = MetricRepo(session, tenant_id)
        self.costs = CostRepo(session, tenant_id)
        self.activity = ActivityRepo(session, tenant_id)
        self.alerts = AlertRepo(session, tenant_id)
        self.backups = BackupRepo(session, tenant_id)
        self.findings = SecurityFindingRepo(session, tenant_id)
        self.recommendations = RecommendationRepo(session, tenant_id)

    def _filters(
        self,
        *,
        resource_type: str | None,
        subscription_id: str | None,
        resource_group: str | None,
        location: str | None,
        tag_key: str | None,
        tag_value: str | None,
        search: str | None,
    ) -> list[Any]:
        filters: list[Any] = []
        if resource_type:
            filters.append(Resource.resource_type == resource_type)
        if subscription_id:
            filters.append(Resource.subscription_id == subscription_id)
        if resource_group:
            filters.append(Resource.resource_group == resource_group)
        if location:
            filters.append(Resource.location == location)
        if tag_key and tag_value:
            filters.append(Resource.tags[tag_key].astext == tag_value)
        elif tag_key:
            filters.append(Resource.tags.has_key(tag_key))  # noqa: W601
        if search:
            filters.append(Resource.name.ilike(f"%{search}%"))
        return filters

    async def list_resources(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        resource_type: str | None = None,
        subscription_id: str | None = None,
        resource_group: str | None = None,
        location: str | None = None,
        tag_key: str | None = None,
        tag_value: str | None = None,
        search: str | None = None,
    ) -> tuple[list[ResourceOut], int]:
        filters = self._filters(
            resource_type=resource_type,
            subscription_id=subscription_id,
            resource_group=resource_group,
            location=location,
            tag_key=tag_key,
            tag_value=tag_value,
            search=search,
        )
        rows = await self.resources.list(
            limit=limit, offset=offset, filters=filters, order_by=desc(Resource.monthly_cost)
        )
        total = await self.resources.count(filters)
        return [ResourceOut.model_validate(r) for r in rows], total

    async def detail(self, azure_resource_id: str) -> ResourceDetailOut:
        """Everything the resource page needs, assembled from synced tables."""
        resource = await self.resources.by_arm_id(azure_resource_id)
        if resource is None:
            raise NotFoundError("Resource not found for this tenant.")

        period = last_n_days(30)
        cost_rows = await self.costs.grouped(
            "resource", period.start, period.end, limit=500
        )
        resource_cost = next(
            (r for r in cost_rows if r["key"] == azure_resource_id.lower()),
            {"cost": 0.0, "currency": "USD"},
        )

        daily = [
            {"date": row["date"].isoformat(), "cost": round(row["cost"], 2)}
            for row in await self.costs.daily_series(
                period.start, period.end, azure_resource_id=azure_resource_id
            )
        ]

        cost_meters = [
            MeterBreakdownOut(
                **row,
                is_bandwidth=is_bandwidth_meter(row["meter_category"], row["meter"]),
            )
            for row in await self.costs.meter_breakdown(
                period.start,
                period.end,
                azure_resource_id=azure_resource_id,
                limit=100,
            )
        ]

        metric_names = await self._available_metrics(azure_resource_id)
        series: list[MetricSeriesOut] = []
        for name in metric_names:
            points = await self.metrics.series(azure_resource_id, name, hours=24)
            series.append(
                MetricSeriesOut(
                    metric=name,
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
            )

        activity = await self.activity.list(
            limit=50,
            filters=[ActivityLogEntry.azure_resource_id == azure_resource_id.lower()],
            order_by=desc(ActivityLogEntry.event_time),
        )
        alerts = await self.alerts.list(
            limit=50,
            filters=[Alert.azure_resource_id == azure_resource_id.lower()],
            order_by=desc(Alert.triggered_at),
        )
        backup = await self.backups.find_one(
            BackupStatus.azure_resource_id == azure_resource_id
        )
        findings = await self.findings.list(
            limit=50,
            filters=[SecurityFinding.azure_resource_id == azure_resource_id.lower()],
        )
        recos = await self.recommendations.list(
            limit=50,
            filters=[
                Recommendation.azure_resource_id == azure_resource_id,
                Recommendation.state == "open",
            ],
            order_by=desc(Recommendation.estimated_monthly_savings),
        )

        return ResourceDetailOut(
            resource=ResourceOut.model_validate(resource),
            cost_last_30_days=Money(
                amount=round(float(resource_cost["cost"]), 2),
                currency=resource_cost.get("currency", "USD"),
            ),
            cost_daily=daily,
            cost_meters=cost_meters,
            metrics=series,
            dependencies=list(resource.dependencies or []),
            activity=[ActivityOut.model_validate(a) for a in activity],
            alerts=[AlertOut.model_validate(a) for a in alerts],
            backup=BackupOut.model_validate(backup) if backup else None,
            security_findings=[SecurityFindingOut.model_validate(f) for f in findings],
            recommendations=[RecommendationOut.model_validate(r) for r in recos],
        )

    async def _available_metrics(self, azure_resource_id: str) -> list[str]:
        since = datetime.now(timezone.utc) - timedelta(days=2)
        rows = await self.metrics.list(
            limit=500,
            filters=[
                MetricSample.azure_resource_id == azure_resource_id,
                MetricSample.timestamp >= since,
            ],
        )
        return sorted({row.metric for row in rows})
