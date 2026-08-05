from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories import (
    AlertRepo,
    RecommendationRepo,
    ResourceRepo,
    SecureScoreRepo,
    SyncRunRepo,
)
from app.schemas import DashboardOut, Money
from app.services.cost_service import CostService
from app.services.periods import Period, month_to_date


class DashboardService:
    def __init__(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        subscription_id: str | None = None,
        currency: str | None = None,
    ) -> None:
        self.costs = CostService(
            session, tenant_id, subscription_id=subscription_id, currency=currency
        )
        scope = {"subscription_id": subscription_id}
        self.resources = ResourceRepo(session, tenant_id, **scope)
        self.alerts = AlertRepo(session, tenant_id, **scope)
        self.scores = SecureScoreRepo(session, tenant_id, **scope)
        self.recommendations = RecommendationRepo(session, tenant_id, **scope)
        self.syncs = SyncRunRepo(session, tenant_id, **scope)

    async def build(self, period: Period | None = None) -> DashboardOut:
        cost_period = period or month_to_date()
        mtd = await self.costs.total(cost_period)
        forecast, forecast_source = await self.costs.forecast()
        previous = await self.costs.previous_month_total()

        change_pct = (
            round((mtd.amount - previous.amount) / previous.amount * 100, 1)
            if previous.amount
            else 0.0
        )

        by_type = dict(await self.resources.count_by_type())
        savings = await self.recommendations.total_savings()
        currency = await self.costs.currency()
        last_sync = await self.syncs.latest("inventory")

        return DashboardOut(
            period_start=cost_period.start,
            period_end=cost_period.end,
            currency=currency,
            month_to_date_cost=mtd,
            forecast_month_cost=forecast,
            forecast_source=forecast_source,
            previous_month_cost=previous,
            cost_change_pct=change_pct,
            total_resources=sum(by_type.values()),
            resources_by_type=by_type,
            health=await self.resources.health_summary(),
            active_alerts=await self.alerts.active_count(),
            secure_score_pct=await self.scores.latest_percentage(),
            advisor_recommendations=await self.recommendations.count(),
            potential_monthly_savings=Money(
                amount=round(savings, 2), currency=currency
            ),
            cost_by_subscription=await self.costs.breakdown("subscription", cost_period),
            cost_by_resource_group=await self.costs.breakdown(
                "resource_group", cost_period, limit=10
            ),
            cost_by_service=await self.costs.breakdown(
                "service", cost_period, limit=10
            ),
            daily_trend=await self.costs.trend(cost_period),
            last_sync_at=last_sync.finished_at if last_sync else None,
        )
