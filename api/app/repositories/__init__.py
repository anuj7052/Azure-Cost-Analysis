from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Sequence

from sqlalchemy import Numeric, cast, desc, func, select

from app.models.inventory import (
    ActivityLogEntry,
    BackupStatus,
    CostForecast,
    CostRecord,
    MetricSample,
    NetworkUsageRecord,
    Resource,
    ResourceType,
)
from app.models.ops import (
    Alert,
    AlertRule,
    ExpiringSecret,
    IdentityRisk,
    NetworkExposure,
    Recommendation,
    ReportRun,
    ReportSchedule,
    SecureScore,
    SecurityFinding,
)
from app.models.tenant import AuditLog, SubscriptionConnection, SyncRun, Tenant, User
from app.repositories.base import TenantRepository


class TenantRepo(TenantRepository[Tenant]):
    model = Tenant

    async def current(self) -> Tenant | None:
        return await self.find_one()


class ConnectionRepo(TenantRepository[SubscriptionConnection]):
    model = SubscriptionConnection

    async def enabled(self) -> Sequence[SubscriptionConnection]:
        return await self.list(
            limit=500, filters=[SubscriptionConnection.is_enabled.is_(True)]
        )

    async def by_subscription(self, subscription_id: str):
        return await self.find_one(
            SubscriptionConnection.subscription_id == subscription_id
        )


class UserRepo(TenantRepository[User]):
    model = User


class AuditRepo(TenantRepository[AuditLog]):
    model = AuditLog

    async def record(self, **values: Any) -> AuditLog:
        return await self.add(**values)


class SyncRunRepo(TenantRepository[SyncRun]):
    model = SyncRun

    async def latest(self, kind: str) -> SyncRun | None:
        stmt = (
            self._base_select()
            .where(SyncRun.kind == kind)
            .order_by(desc(SyncRun.created_at))
            .limit(1)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()


class ResourceRepo(TenantRepository[Resource]):
    model = Resource

    async def by_arm_id(self, azure_resource_id: str) -> Resource | None:
        return await self.find_one(Resource.azure_resource_id == azure_resource_id)

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "azure_resource_id"]
        )

    async def count_by_type(self) -> list[tuple[str, int]]:
        stmt = (
            select(Resource.resource_type, func.count())
            .where(*self._scope())
            .group_by(Resource.resource_type)
            .order_by(desc(func.count()))
        )
        return [(r[0], int(r[1])) for r in (await self.session.execute(stmt)).all()]

    async def health_summary(self) -> dict[str, int]:
        stmt = (
            select(Resource.health_state, func.count())
            .where(*self._scope())
            .group_by(Resource.health_state)
        )
        return {r[0]: int(r[1]) for r in (await self.session.execute(stmt)).all()}

    async def public_ip_attachments(self) -> list[dict]:
        """Every public IP with the address and the resource actually using it.

        Azure models the link indirectly: a public IP points at a NIC *IP
        configuration*, and the NIC points at the virtual machine. Walking both
        hops here is what lets bandwidth be reported per address rather than
        per opaque resource id.
        """
        stmt = select(Resource).where(
            *self._scope(),
            Resource.resource_type.in_(
                [ResourceType.PUBLIC_IP, ResourceType.NETWORK_INTERFACE]
            ),
        )
        rows = list((await self.session.execute(stmt)).scalars().all())

        # NIC id (lower-cased for comparison) -> the machine it is attached to.
        nic_owner: dict[str, str] = {}
        for nic in rows:
            if nic.resource_type != ResourceType.NETWORK_INTERFACE:
                continue
            owner = ((nic.properties or {}).get("virtualMachine") or {}).get("id")
            if owner:
                nic_owner[nic.azure_resource_id.lower()] = owner

        attachments: list[dict] = []
        for ip in rows:
            if ip.resource_type != ResourceType.PUBLIC_IP:
                continue
            props = ip.properties or {}
            config_id = (props.get("ipConfiguration") or {}).get("id") or ""
            # Trim "/ipConfigurations/<name>" to get the parent NIC or LB.
            parent = config_id.rsplit("/ipConfigurations/", 1)[0] if config_id else ""
            attached_to = nic_owner.get(parent.lower(), parent)
            attachments.append(
                {
                    "azure_resource_id": ip.azure_resource_id,
                    "name": ip.name,
                    "ip_address": props.get("ipAddress") or "",
                    "allocation_method": props.get("publicIPAllocationMethod") or "",
                    "version": props.get("publicIPAddressVersion") or "IPv4",
                    "sku": ip.sku,
                    "resource_group": ip.resource_group,
                    "location": ip.location,
                    "attached_to_id": attached_to,
                    "attached_to_name": attached_to.rsplit("/", 1)[-1] if attached_to else "",
                    "is_attached": bool(config_id),
                }
            )
        return attachments


class CostRepo(TenantRepository[CostRecord]):
    model = CostRecord

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows,
            conflict_columns=[
                "tenant_id",
                "subscription_id",
                "usage_date",
                "azure_resource_id",
                "meter_id",
                "meter",
                "charge_type",
            ],
        )

    async def total_between(self, start: date, end: date, *, amortized: bool = False) -> float:
        column = CostRecord.amortized_cost if amortized else CostRecord.cost
        stmt = select(func.coalesce(func.sum(column), 0)).where(
            *self._scope(),
            CostRecord.usage_date >= start,
            CostRecord.usage_date <= end,
        )
        return float((await self.session.execute(stmt)).scalar_one())

    async def totals_by_currency(
        self, start: date, end: date, *, amortized: bool = False
    ) -> list[dict]:
        """Totals split per billing currency so callers can convert before summing."""
        column = CostRecord.amortized_cost if amortized else CostRecord.cost
        stmt = (
            select(CostRecord.currency, func.coalesce(func.sum(column), 0))
            .where(
                *self._scope(),
                CostRecord.usage_date >= start,
                CostRecord.usage_date <= end,
            )
            .group_by(CostRecord.currency)
        )
        return [
            {"currency": r[0], "cost": float(r[1] or 0)}
            for r in (await self.session.execute(stmt)).all()
        ]

    async def grouped(
        self,
        dimension: str,
        start: date,
        end: date,
        *,
        limit: int = 20,
        amortized: bool = False,
    ) -> list[dict]:
        """Aggregate cost by subscription / resource group / type / service."""
        column_map = {
            "subscription": CostRecord.subscription_id,
            "resource_group": CostRecord.resource_group,
            "resource_type": CostRecord.resource_type,
            "service": CostRecord.service_name,
            "resource": CostRecord.azure_resource_id,
            "meter": CostRecord.meter,
            "meter_category": CostRecord.meter_category,
            "meter_subcategory": CostRecord.meter_subcategory,
            "meter_region": CostRecord.meter_region,
            "location": CostRecord.resource_location,
            "product": CostRecord.product,
            "charge_type": CostRecord.charge_type,
            "pricing_model": CostRecord.pricing_model,
            "publisher_type": CostRecord.publisher_type,
            "service_family": CostRecord.service_family,
            "benefit": CostRecord.benefit_name,
        }
        if dimension not in column_map:
            raise ValueError(f"Unsupported cost dimension: {dimension}")
        group_col = column_map[dimension]
        amount = CostRecord.amortized_cost if amortized else CostRecord.cost

        stmt = (
            select(group_col, func.sum(amount), CostRecord.currency)
            .where(
                *self._scope(),
                CostRecord.usage_date >= start,
                CostRecord.usage_date <= end,
            )
            .group_by(group_col, CostRecord.currency)
            .order_by(desc(func.sum(amount)))
            .limit(limit)
        )
        return [
            {"key": r[0] or "(untagged)", "cost": float(r[1] or 0), "currency": r[2]}
            for r in (await self.session.execute(stmt)).all()
        ]

    async def by_tag(self, tag_key: str, start: date, end: date, limit: int = 20) -> list[dict]:
        tag_value = CostRecord.tags[tag_key].astext
        stmt = (
            select(tag_value, func.sum(CostRecord.cost), CostRecord.currency)
            .where(
                *self._scope(),
                CostRecord.usage_date >= start,
                CostRecord.usage_date <= end,
            )
            .group_by(tag_value, CostRecord.currency)
            .order_by(desc(func.sum(CostRecord.cost)))
            .limit(limit)
        )
        return [
            {"key": r[0] or "(untagged)", "cost": float(r[1] or 0), "currency": r[2]}
            for r in (await self.session.execute(stmt)).all()
        ]

    async def daily_series(
        self, start: date, end: date, *, azure_resource_id: str | None = None
    ) -> list[dict]:
        filters = [
            *self._scope(),
            CostRecord.usage_date >= start,
            CostRecord.usage_date <= end,
        ]
        if azure_resource_id:
            filters.append(CostRecord.azure_resource_id == azure_resource_id.lower())
        stmt = (
            select(CostRecord.usage_date, func.sum(CostRecord.cost), CostRecord.currency)
            .where(*filters)
            .group_by(CostRecord.usage_date, CostRecord.currency)
            .order_by(CostRecord.usage_date)
        )
        return [
            {"date": r[0], "cost": float(r[1] or 0), "currency": r[2]}
            for r in (await self.session.execute(stmt)).all()
        ]

    async def service_daily_series(self, start: date, end: date) -> list[dict]:
        stmt = (
            select(
                CostRecord.service_name,
                CostRecord.usage_date,
                func.sum(cast(CostRecord.cost, Numeric)),
            )
            .where(
                *self._scope(),
                CostRecord.usage_date >= start,
                CostRecord.usage_date <= end,
            )
            .group_by(CostRecord.service_name, CostRecord.usage_date)
        )
        return [
            {"service": r[0], "date": r[1], "cost": float(r[2] or 0)}
            for r in (await self.session.execute(stmt)).all()
        ]

    # --- meter-level detail -------------------------------------------
    async def meter_breakdown(
        self,
        start: date,
        end: date,
        *,
        meter_categories: Sequence[str] | None = None,
        azure_resource_id: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Cost AND billed quantity per meter — the un-rolled-up billing lines."""
        filters = [
            *self._scope(),
            CostRecord.usage_date >= start,
            CostRecord.usage_date <= end,
        ]
        if meter_categories:
            filters.append(
                func.lower(CostRecord.meter_category).in_(
                    [c.lower() for c in meter_categories]
                )
            )
        if azure_resource_id:
            filters.append(CostRecord.azure_resource_id == azure_resource_id.lower())

        stmt = (
            select(
                CostRecord.meter_category,
                CostRecord.meter_subcategory,
                CostRecord.meter,
                CostRecord.meter_region,
                CostRecord.unit_of_measure,
                func.sum(CostRecord.quantity),
                func.sum(CostRecord.cost),
                func.avg(func.nullif(CostRecord.effective_price, 0)),
                CostRecord.currency,
            )
            .where(*filters)
            .group_by(
                CostRecord.meter_category,
                CostRecord.meter_subcategory,
                CostRecord.meter,
                CostRecord.meter_region,
                CostRecord.unit_of_measure,
                CostRecord.currency,
            )
            .order_by(desc(func.sum(CostRecord.cost)))
            .limit(limit)
        )
        return [
            {
                "meter_category": r[0] or "",
                "meter_subcategory": r[1] or "",
                "meter": r[2] or "",
                "meter_region": r[3] or "",
                "unit_of_measure": r[4] or "",
                "quantity": float(r[5] or 0),
                "cost": float(r[6] or 0),
                "effective_price": float(r[7] or 0),
                "currency": r[8],
            }
            for r in (await self.session.execute(stmt)).all()
        ]

    async def usage_lines(
        self,
        start: date,
        end: date,
        *,
        azure_resource_id: str | None = None,
        meter_category: str | None = None,
        search: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[CostRecord], int]:
        """Raw billing lines, paged — every column Azure gave us."""
        filters = [
            *self._scope(),
            CostRecord.usage_date >= start,
            CostRecord.usage_date <= end,
        ]
        if azure_resource_id:
            filters.append(CostRecord.azure_resource_id == azure_resource_id.lower())
        if meter_category:
            filters.append(func.lower(CostRecord.meter_category) == meter_category.lower())
        if search:
            pattern = f"%{search.lower()}%"
            filters.append(
                func.lower(CostRecord.meter).like(pattern)
                | func.lower(CostRecord.product).like(pattern)
                | func.lower(CostRecord.resource_name).like(pattern)
            )

        total = int(
            (
                await self.session.execute(
                    select(func.count()).select_from(CostRecord).where(*filters)
                )
            ).scalar_one()
        )
        stmt = (
            select(CostRecord)
            .where(*filters)
            .order_by(desc(CostRecord.usage_date), desc(CostRecord.cost))
            .limit(limit)
            .offset(offset)
        )
        return list((await self.session.execute(stmt)).scalars().all()), total

    async def bandwidth_daily(
        self, start: date, end: date, meter_categories: Sequence[str]
    ) -> list[dict]:
        """Daily billed data-transfer cost and volume."""
        stmt = (
            select(
                CostRecord.usage_date,
                func.sum(CostRecord.cost),
                func.sum(CostRecord.quantity),
                CostRecord.unit_of_measure,
                CostRecord.currency,
            )
            .where(
                *self._scope(),
                CostRecord.usage_date >= start,
                CostRecord.usage_date <= end,
                func.lower(CostRecord.meter_category).in_(
                    [c.lower() for c in meter_categories]
                ),
            )
            .group_by(
                CostRecord.usage_date, CostRecord.unit_of_measure, CostRecord.currency
            )
            .order_by(CostRecord.usage_date)
        )
        return [
            {
                "date": r[0],
                "cost": float(r[1] or 0),
                "quantity": float(r[2] or 0),
                "unit_of_measure": r[3] or "",
                "currency": r[4],
            }
            for r in (await self.session.execute(stmt)).all()
        ]

    async def distinct_values(self, column: str, limit: int = 200) -> list[str]:
        allowed = {
            "meter_category": CostRecord.meter_category,
            "meter_subcategory": CostRecord.meter_subcategory,
            "charge_type": CostRecord.charge_type,
            "pricing_model": CostRecord.pricing_model,
            "service_name": CostRecord.service_name,
            "meter_region": CostRecord.meter_region,
        }
        if column not in allowed:
            raise ValueError(f"Unsupported dimension: {column}")
        col = allowed[column]
        stmt = (
            select(col)
            .where(*self._scope(), col != "")
            .distinct()
            .order_by(col)
            .limit(limit)
        )
        return [r[0] for r in (await self.session.execute(stmt)).all()]


class NetworkUsageRepo(TenantRepository[NetworkUsageRecord]):
    model = NetworkUsageRecord

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "azure_resource_id", "usage_date"]
        )

    async def daily_totals(self, start: date, end: date) -> list[dict]:
        stmt = (
            select(
                NetworkUsageRecord.usage_date,
                func.sum(NetworkUsageRecord.ingress_bytes),
                func.sum(NetworkUsageRecord.egress_bytes),
            )
            .where(
                *self._scope(),
                NetworkUsageRecord.usage_date >= start,
                NetworkUsageRecord.usage_date <= end,
            )
            .group_by(NetworkUsageRecord.usage_date)
            .order_by(NetworkUsageRecord.usage_date)
        )
        return [
            {
                "date": r[0],
                "ingress_bytes": float(r[1] or 0),
                "egress_bytes": float(r[2] or 0),
            }
            for r in (await self.session.execute(stmt)).all()
        ]

    async def top_talkers(self, start: date, end: date, limit: int = 20) -> list[dict]:
        stmt = (
            select(
                NetworkUsageRecord.azure_resource_id,
                NetworkUsageRecord.resource_name,
                NetworkUsageRecord.resource_type,
                NetworkUsageRecord.resource_group,
                NetworkUsageRecord.location,
                func.sum(NetworkUsageRecord.ingress_bytes),
                func.sum(NetworkUsageRecord.egress_bytes),
            )
            .where(
                *self._scope(),
                NetworkUsageRecord.usage_date >= start,
                NetworkUsageRecord.usage_date <= end,
            )
            .group_by(
                NetworkUsageRecord.azure_resource_id,
                NetworkUsageRecord.resource_name,
                NetworkUsageRecord.resource_type,
                NetworkUsageRecord.resource_group,
                NetworkUsageRecord.location,
            )
            .order_by(desc(func.sum(NetworkUsageRecord.egress_bytes)))
            .limit(limit)
        )
        return [
            {
                "azure_resource_id": r[0],
                "resource_name": r[1],
                "resource_type": r[2],
                "resource_group": r[3],
                "location": r[4],
                "ingress_bytes": float(r[5] or 0),
                "egress_bytes": float(r[6] or 0),
            }
            for r in (await self.session.execute(stmt)).all()
        ]


class ForecastRepo(TenantRepository[CostForecast]):
    model = CostForecast

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "subscription_id", "forecast_date"]
        )

    async def month_total(self, start: date, end: date) -> float:
        stmt = select(func.coalesce(func.sum(CostForecast.amount), 0)).where(
            *self._scope(),
            CostForecast.forecast_date >= start,
            CostForecast.forecast_date <= end,
        )
        return float((await self.session.execute(stmt)).scalar_one())


class MetricRepo(TenantRepository[MetricSample]):
    model = MetricSample

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows,
            conflict_columns=["tenant_id", "azure_resource_id", "metric", "timestamp"],
        )

    async def series(
        self, azure_resource_id: str, metric: str, hours: int = 24
    ) -> list[MetricSample]:
        since = datetime.now(timezone.utc) - timedelta(hours=hours)
        stmt = (
            self._base_select()
            .where(
                MetricSample.azure_resource_id == azure_resource_id,
                MetricSample.metric == metric,
                MetricSample.timestamp >= since,
            )
            .order_by(MetricSample.timestamp)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def aggregate(
        self, azure_resource_id: str, metric: str, days: int
    ) -> dict[str, float | None]:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        stmt = select(
            func.avg(MetricSample.average),
            func.max(MetricSample.maximum),
            func.percentile_cont(0.95).within_group(MetricSample.average),
            func.count(),
        ).where(
            *self._scope(),
            MetricSample.azure_resource_id == azure_resource_id,
            MetricSample.metric == metric,
            MetricSample.timestamp >= since,
        )
        row = (await self.session.execute(stmt)).one()
        return {
            "avg": float(row[0]) if row[0] is not None else None,
            "max": float(row[1]) if row[1] is not None else None,
            "p95": float(row[2]) if row[2] is not None else None,
            "samples": int(row[3]),
        }


class ActivityRepo(TenantRepository[ActivityLogEntry]):
    model = ActivityLogEntry


class BackupRepo(TenantRepository[BackupStatus]):
    model = BackupStatus

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "azure_resource_id"]
        )


class RecommendationRepo(TenantRepository[Recommendation]):
    model = Recommendation

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "azure_resource_id", "rule"]
        )

    async def open_items(self, limit: int = 100) -> Sequence[Recommendation]:
        return await self.list(
            limit=limit,
            filters=[Recommendation.state == "open"],
            order_by=desc(Recommendation.estimated_monthly_savings),
        )

    async def dismissed_keys(self) -> set[tuple[str, str]]:
        stmt = select(Recommendation.azure_resource_id, Recommendation.rule).where(
            *self._scope(),
            Recommendation.state == "dismissed",
        )
        return {(r[0], r[1]) for r in (await self.session.execute(stmt)).all()}

    async def total_savings(self) -> float:
        stmt = select(
            func.coalesce(func.sum(Recommendation.estimated_monthly_savings), 0)
        ).where(
            *self._scope(),
            Recommendation.state == "open",
        )
        return float((await self.session.execute(stmt)).scalar_one())


class SecurityFindingRepo(TenantRepository[SecurityFinding]):
    model = SecurityFinding

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows,
            conflict_columns=["tenant_id", "assessment_id", "azure_resource_id"],
        )

    async def severity_counts(self) -> dict[str, int]:
        stmt = (
            select(SecurityFinding.severity, func.count())
            .where(
                *self._scope(),
                SecurityFinding.status != "Healthy",
            )
            .group_by(SecurityFinding.severity)
        )
        return {r[0]: int(r[1]) for r in (await self.session.execute(stmt)).all()}


class SecureScoreRepo(TenantRepository[SecureScore]):
    model = SecureScore

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "subscription_id", "captured_on"]
        )

    async def latest_percentage(self) -> float | None:
        stmt = (
            select(func.avg(SecureScore.percentage))
            .where(*self._scope())
            .where(
                SecureScore.captured_on
                >= datetime.now(timezone.utc) - timedelta(days=2)
            )
        )
        value = (await self.session.execute(stmt)).scalar_one_or_none()
        return float(value) if value is not None else None


class ExpiringSecretRepo(TenantRepository[ExpiringSecret]):
    model = ExpiringSecret

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(rows, conflict_columns=["tenant_id", "item_id"])


class IdentityRiskRepo(TenantRepository[IdentityRisk]):
    model = IdentityRisk

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "user_object_id"]
        )


class NetworkExposureRepo(TenantRepository[NetworkExposure]):
    model = NetworkExposure

    async def upsert(self, rows: list[dict]) -> int:
        return await self.upsert_many(
            rows, conflict_columns=["tenant_id", "nsg_id", "rule_name"]
        )


class AlertRepo(TenantRepository[Alert]):
    model = Alert

    async def active(self, limit: int = 100) -> Sequence[Alert]:
        return await self.list(
            limit=limit,
            filters=[Alert.state == "active"],
            order_by=desc(Alert.triggered_at),
        )

    async def active_count(self) -> int:
        return await self.count([Alert.state == "active"])

    async def find_active(self, rule: str, azure_resource_id: str) -> Alert | None:
        return await self.find_one(
            Alert.rule == rule,
            Alert.azure_resource_id == azure_resource_id,
            Alert.state == "active",
        )


class AlertRuleRepo(TenantRepository[AlertRule]):
    model = AlertRule

    async def enabled(self) -> Sequence[AlertRule]:
        return await self.list(limit=200, filters=[AlertRule.enabled.is_(True)])


class ReportScheduleRepo(TenantRepository[ReportSchedule]):
    model = ReportSchedule


class ReportRunRepo(TenantRepository[ReportRun]):
    model = ReportRun
