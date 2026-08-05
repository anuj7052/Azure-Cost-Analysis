from __future__ import annotations

from datetime import date
from typing import Any, Iterable, Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.azure.cost import BANDWIDTH_METER_CATEGORIES, is_bandwidth_meter
from app.repositories import (
    CostRepo,
    ForecastRepo,
    NetworkUsageRepo,
    ResourceRepo,
    TenantRepo,
)
from app.schemas import (
    BandwidthReportOut,
    CostDimensionsOut,
    DataTransferPoint,
    DataTransferResourceOut,
    KeyedAmount,
    MeterBreakdownOut,
    Money,
    Page,
    PublicIpOut,
    UsageLineOut,
)
from app.services import fx
from app.services.periods import (
    Period,
    full_month,
    month_to_date,
    previous_month,
    run_rate_forecast,
)

_GB = 1024**3


def to_gb(byte_count: float) -> float:
    return byte_count / _GB


def _to_gb(quantity: float, unit_of_measure: str) -> float:
    """Normalise a billed data-transfer quantity to GB.

    Azure meters transfer in "1 GB", "10 GB", "1 TB" and similar units, so the
    raw quantity is meaningless without its unit of measure. Bandwidth meter
    categories also contain meters billed in non-data units (a static public IP
    is billed per "200 Hours"); those carry no transfer volume and must not be
    scaled into the GB total.
    """
    unit = (unit_of_measure or "").strip().lower()
    if "tb" in unit:
        multiplier = 1024.0
    elif "mb" in unit:
        multiplier = 1 / 1024
    elif "gb" in unit or not unit:
        # A missing unit is assumed to be GB; transfer meters are billed that way.
        multiplier = 1.0
    else:
        return 0.0
    factor = 1.0
    for token in unit.replace("/", " ").split():
        if token.replace(".", "", 1).isdigit():
            factor = float(token)
            break
    return quantity * factor * multiplier


class CostService:
    """Read-side cost use cases. Serves synced data only — no live Azure calls.

    Azure bills each subscription in its billing account's own currency, so
    rows can be a mix of INR, USD and others. Every amount leaving this service
    is converted into a single reporting currency; raw sums would otherwise add
    rupees to dollars.
    """

    def __init__(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        subscription_id: str | None = None,
        currency: str | None = None,
    ) -> None:
        scope = {"subscription_id": subscription_id}
        self.costs = CostRepo(session, tenant_id, **scope)
        self.forecasts = ForecastRepo(session, tenant_id, **scope)
        self.network = NetworkUsageRepo(session, tenant_id, **scope)
        self.resources = ResourceRepo(session, tenant_id, **scope)
        self.tenants = TenantRepo(session, tenant_id)
        self.subscription_id = subscription_id
        self._currency_override = fx.normalise(currency) if currency else None
        self._currency: str | None = None

    async def currency(self) -> str:
        if self._currency_override:
            return self._currency_override
        if self._currency is None:
            tenant = await self.tenants.current()
            self._currency = fx.normalise(
                tenant.reporting_currency if tenant else "USD"
            )
        return self._currency

    async def _convert(self, amount: float, source: str | None) -> float:
        return fx.convert(amount, source, await self.currency())

    async def _sum_converted(self, rows: Iterable[Mapping[str, Any]]) -> float:
        target = await self.currency()
        return sum(fx.convert(r["cost"], r.get("currency"), target) for r in rows)

    async def total(self, period: Period, *, amortized: bool = False) -> Money:
        rows = await self.costs.totals_by_currency(
            period.start, period.end, amortized=amortized
        )
        total = await self._sum_converted(rows)
        return Money(amount=round(total, 2), currency=await self.currency())

    async def month_to_date(self, *, amortized: bool = False) -> Money:
        return await self.total(month_to_date(), amortized=amortized)

    async def forecast(self, period: Period | None = None) -> tuple[Money, str]:
        """Azure forecast when available, otherwise a labelled run-rate estimate."""
        month = period or full_month()
        forecast_total = await self.forecasts.month_total(month.start, month.end)
        currency = await self.currency()
        if forecast_total > 0:
            return Money(amount=round(forecast_total, 2), currency=currency), "azure"

        mtd = await self.total(Period(month.start, min(month.end, date.today())))
        return (
            Money(amount=run_rate_forecast(mtd.amount), currency=currency),
            "run_rate_estimate",
        )

    async def previous_month_total(self) -> Money:
        return await self.total(previous_month())

    async def breakdown(
        self, dimension: str, period: Period, *, limit: int = 20
    ) -> list[KeyedAmount]:
        rows = await self.costs.grouped(dimension, period.start, period.end, limit=limit)
        target = await self.currency()
        # Grouping includes currency, so one key can appear once per currency.
        merged: dict[str, float] = {}
        for row in rows:
            merged[row["key"]] = merged.get(row["key"], 0.0) + fx.convert(
                row["cost"], row.get("currency"), target
            )
        return [
            KeyedAmount(key=key, cost=round(cost, 2), currency=target)
            for key, cost in sorted(merged.items(), key=lambda kv: kv[1], reverse=True)[
                :limit
            ]
        ]

    async def breakdown_by_tag(
        self, tag_key: str, period: Period, *, limit: int = 20
    ) -> list[KeyedAmount]:
        rows = await self.costs.by_tag(tag_key, period.start, period.end, limit=limit)
        target = await self.currency()
        merged: dict[str, float] = {}
        for row in rows:
            merged[row["key"]] = merged.get(row["key"], 0.0) + fx.convert(
                row["cost"], row.get("currency"), target
            )
        return [
            KeyedAmount(key=key, cost=round(cost, 2), currency=target)
            for key, cost in sorted(merged.items(), key=lambda kv: kv[1], reverse=True)[
                :limit
            ]
        ]

    async def trend(self, period: Period) -> list[dict[str, Any]]:
        target = await self.currency()
        merged: dict[date, float] = {}
        for row in await self.costs.daily_series(period.start, period.end):
            merged[row["date"]] = merged.get(row["date"], 0.0) + fx.convert(
                row["cost"], row.get("currency"), target
            )
        return [
            {"date": day.isoformat(), "cost": round(cost, 2), "currency": target}
            for day, cost in sorted(merged.items())
        ]

    async def anomalies(self, period: Period, *, min_delta: float = 5.0) -> list[dict]:
        """Flag services whose latest daily cost exceeds mean + 2σ of the window.

        `min_delta` suppresses noise from inexpensive services where a small
        absolute change is a large relative one.
        """
        rows = await self.costs.service_daily_series(period.start, period.end)
        by_service: dict[str, dict[date, float]] = {}
        for row in rows:
            by_service.setdefault(row["service"], {})[row["date"]] = row["cost"]

        findings: list[dict] = []
        for service, series in by_service.items():
            if len(series) < 4:
                continue
            latest_date = max(series)
            latest = series[latest_date]
            history = [v for d, v in series.items() if d != latest_date]
            mean = sum(history) / len(history)
            variance = sum((v - mean) ** 2 for v in history) / len(history)
            sigma = variance**0.5
            threshold = mean + 2 * sigma
            delta = latest - mean
            if latest > threshold and delta >= min_delta:
                findings.append(
                    {
                        "service": service,
                        "date": latest_date.isoformat(),
                        "cost": round(latest, 2),
                        "baseline": round(mean, 2),
                        "delta": round(delta, 2),
                        "delta_pct": round(delta / mean * 100, 1) if mean else None,
                    }
                )
        return sorted(findings, key=lambda f: f["delta"], reverse=True)

    # --- meter-level detail -------------------------------------------
    async def meters(
        self,
        period: Period,
        *,
        meter_category: str | None = None,
        azure_resource_id: str | None = None,
        limit: int = 200,
    ) -> list[MeterBreakdownOut]:
        rows = await self.costs.meter_breakdown(
            period.start,
            period.end,
            meter_categories=[meter_category] if meter_category else None,
            azure_resource_id=azure_resource_id,
            limit=limit,
        )
        target = await self.currency()
        return [
            MeterBreakdownOut(
                **{
                    **row,
                    "cost": round(fx.convert(row["cost"], row["currency"], target), 4),
                    "effective_price": fx.convert(
                        row["effective_price"], row["currency"], target
                    ),
                    "currency": target,
                },
                is_bandwidth=is_bandwidth_meter(row["meter_category"], row["meter"]),
            )
            for row in rows
        ]

    async def usage_lines(
        self,
        period: Period,
        *,
        azure_resource_id: str | None = None,
        meter_category: str | None = None,
        search: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> Page[UsageLineOut]:
        rows, total = await self.costs.usage_lines(
            period.start,
            period.end,
            azure_resource_id=azure_resource_id,
            meter_category=meter_category,
            search=search,
            limit=limit,
            offset=offset,
        )
        target = await self.currency()
        items: list[UsageLineOut] = []
        for row in rows:
            line = UsageLineOut.model_validate(row)
            if line.currency != target:
                source = line.currency
                line = line.model_copy(
                    update={
                        "cost": fx.convert(line.cost, source, target),
                        "amortized_cost": fx.convert(
                            line.amortized_cost, source, target
                        ),
                        "unit_price": fx.convert(line.unit_price, source, target),
                        "effective_price": fx.convert(
                            line.effective_price, source, target
                        ),
                        "currency": target,
                    }
                )
            items.append(line)
        return Page[UsageLineOut](
            items=items,
            total=total,
            limit=limit,
            offset=offset,
        )

    async def dimensions(self) -> CostDimensionsOut:
        return CostDimensionsOut(
            meter_categories=await self.costs.distinct_values("meter_category"),
            meter_subcategories=await self.costs.distinct_values("meter_subcategory"),
            charge_types=await self.costs.distinct_values("charge_type"),
            pricing_models=await self.costs.distinct_values("pricing_model"),
            services=await self.costs.distinct_values("service_name"),
            regions=await self.costs.distinct_values("meter_region"),
        )

    async def bandwidth(self, period: Period) -> BandwidthReportOut:
        """Billed data transfer joined with measured ingress/egress volume."""
        categories = sorted(BANDWIDTH_METER_CATEGORIES)
        billed = await self.costs.bandwidth_daily(period.start, period.end, categories)
        volumes = await self.network.daily_totals(period.start, period.end)
        talkers = await self.network.top_talkers(period.start, period.end)
        meters = await self.meters(period, limit=500)
        bandwidth_meters = [m for m in meters if m.is_bandwidth]
        target = await self.currency()

        by_date: dict[date, dict[str, float]] = {}
        for row in billed:
            bucket = by_date.setdefault(
                row["date"], {"cost": 0.0, "gb": 0.0, "ingress": 0.0, "egress": 0.0}
            )
            bucket["cost"] += fx.convert(row["cost"], row.get("currency"), target)
            bucket["gb"] += _to_gb(row["quantity"], row["unit_of_measure"])
        for row in volumes:
            bucket = by_date.setdefault(
                row["date"], {"cost": 0.0, "gb": 0.0, "ingress": 0.0, "egress": 0.0}
            )
            bucket["ingress"] += row["ingress_bytes"]
            bucket["egress"] += row["egress_bytes"]

        daily = [
            DataTransferPoint(
                date=day,
                billed_cost=round(values["cost"], 4),
                billed_quantity_gb=round(values["gb"], 4),
                ingress_bytes=values["ingress"],
                egress_bytes=values["egress"],
            )
            for day, values in sorted(by_date.items())
        ]

        # Cost Management returns resource ids lower-cased while Resource Graph
        # preserves the original casing, so both sides are folded to match.
        cost_by_resource = {
            row.key.lower(): row.cost
            for row in await self.breakdown("resource", period, limit=1000)
        }

        attachments = await self.resources.public_ip_attachments()
        # Traffic is measured against the machine, so an address inherits the
        # volume of whatever it is bound to.
        volume_by_resource = {
            item["azure_resource_id"].lower(): item for item in talkers
        }
        ips_by_resource: dict[str, list[str]] = {}
        for entry in attachments:
            owner = (entry["attached_to_id"] or "").lower()
            if owner and entry["ip_address"]:
                ips_by_resource.setdefault(owner, []).append(entry["ip_address"])

        public_ips = [
            PublicIpOut(
                **entry,
                ingress_bytes=owner_volume.get("ingress_bytes", 0.0),
                egress_bytes=owner_volume.get("egress_bytes", 0.0),
                billed_cost=round(
                    cost_by_resource.get(entry["azure_resource_id"].lower(), 0.0), 2
                ),
            )
            for entry in attachments
            for owner_volume in [
                volume_by_resource.get((entry["attached_to_id"] or "").lower(), {})
            ]
        ]
        public_ips.sort(key=lambda ip: (-ip.egress_bytes, -ip.billed_cost, ip.name))

        top_resources = [
            DataTransferResourceOut(
                azure_resource_id=item["azure_resource_id"],
                resource_name=item["resource_name"],
                resource_type=item["resource_type"],
                resource_group=item["resource_group"],
                location=item["location"],
                ingress_bytes=item["ingress_bytes"],
                egress_bytes=item["egress_bytes"],
                billed_cost=round(
                    cost_by_resource.get(item["azure_resource_id"].lower(), 0.0), 2
                ),
                ip_addresses=sorted(
                    ips_by_resource.get(item["azure_resource_id"].lower(), [])
                ),
            )
            for item in talkers
        ]

        return BandwidthReportOut(
            period_start=period.start,
            period_end=period.end,
            currency=target,
            total_billed_cost=round(sum(p.billed_cost for p in daily), 2),
            total_billed_quantity_gb=round(sum(p.billed_quantity_gb for p in daily), 3),
            total_ingress_bytes=sum(p.ingress_bytes for p in daily),
            total_egress_bytes=sum(p.egress_bytes for p in daily),
            daily=daily,
            meters=bandwidth_meters,
            public_ips=public_ips,
            top_resources=top_resources,
        )
