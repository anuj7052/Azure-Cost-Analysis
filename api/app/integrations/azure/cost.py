from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timezone
from typing import Any

from azure.mgmt.consumption.aio import ConsumptionManagementClient
from azure.mgmt.costmanagement.aio import CostManagementClient

from app.integrations.azure.credentials import ConnectionContext, credential_provider
from app.integrations.azure.retry import with_retry

log = logging.getLogger(__name__)

_GROUPINGS = [
    {"type": "Dimension", "name": "ResourceId"},
    {"type": "Dimension", "name": "ServiceName"},
]

# Meter categories that represent data transfer. Azure bills egress under these;
# ingress is free and therefore never appears in any cost dataset.
BANDWIDTH_METER_CATEGORIES = {
    "bandwidth",
    "content delivery network",
    "azure front door service",
    "virtual network",
    "vpn gateway",
    "expressroute",
    "traffic manager",
}

# Substrings that identify a data-transfer meter regardless of category, e.g.
# "Data Transfer Out - Inter Region", "Geo-Replication Data transfer",
# "Standard Data Transfer Out", "Zone 1 Egress".
BANDWIDTH_METER_HINTS = (
    "data transfer",
    "data xfer",
    "egress",
    "ingress",
    "bandwidth",
    "inter-region",
    "inter region",
    "geo-replication",
    "peering",
)


def is_bandwidth_meter(meter_category: str, meter_name: str) -> bool:
    """True when a billing line is data transfer rather than compute/storage."""
    if (meter_category or "").strip().lower() in BANDWIDTH_METER_CATEGORIES:
        return True
    haystack = f"{meter_category} {meter_name}".lower()
    return any(hint in haystack for hint in BANDWIDTH_METER_HINTS)


def _scope(subscription_id: str) -> str:
    return f"/subscriptions/{subscription_id}"


def _parse_resource_id(resource_id: str) -> dict[str, str]:
    """Pull resource group / provider type / name out of an ARM resource id."""
    parts = [p for p in (resource_id or "").split("/") if p]
    out = {"group": "", "type": "", "name": ""}
    lowered = [p.lower() for p in parts]
    if "resourcegroups" in lowered:
        index = lowered.index("resourcegroups")
        if index + 1 < len(parts):
            out["group"] = parts[index + 1]
    if "providers" in lowered:
        index = lowered.index("providers")
        tail = parts[index + 1 :]
        if len(tail) >= 3:
            out["type"] = f"{tail[0]}/{tail[1]}"
            out["name"] = tail[-1]
    return out


def _as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _parse_additional_info(value: Any) -> dict[str, Any]:
    """`additionalInfo` arrives as a JSON string (VM size, disk tier, region pair)."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except ValueError:
            return {"raw": value[:1000]}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {}


def _period(start: date, end: date) -> dict[str, Any]:
    return {
        "from_property": datetime.combine(start, time.min, tzinfo=timezone.utc),
        "to": datetime.combine(end, time.max, tzinfo=timezone.utc),
    }


class CostGateway:
    """Cost Management + Consumption. Aggressively throttled — call serially."""

    def __init__(self, ctx: ConnectionContext) -> None:
        self.ctx = ctx

    @with_retry()
    async def _usage(self, client: CostManagementClient, payload: dict) -> Any:
        return await client.query.usage(scope=_scope(self.ctx.subscription_id), parameters=payload)

    async def daily_costs(
        self, start: date, end: date, *, amortized: bool = False
    ) -> list[dict[str, Any]]:
        """Daily actual (or amortized) cost grouped by resource/service."""
        payload = {
            "type": "AmortizedCost" if amortized else "ActualCost",
            "timeframe": "Custom",
            "time_period": _period(start, end),
            "dataset": {
                "granularity": "Daily",
                "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"}},
                "grouping": _GROUPINGS,
            },
        }
        credential = await credential_provider.get(self.ctx)
        try:
            async with CostManagementClient(credential) as client:
                result = await self._usage(client, payload)
        finally:
            await credential.close()
        return self._normalize(result)

    @staticmethod
    def _normalize(result: Any) -> list[dict[str, Any]]:
        columns = [c.name for c in (result.columns or [])]
        rows: list[dict[str, Any]] = []
        for raw in result.rows or []:
            record = dict(zip(columns, raw))
            usage_date = record.get("UsageDate")
            if isinstance(usage_date, int):
                parsed = datetime.strptime(str(usage_date), "%Y%m%d").date()
            elif isinstance(usage_date, str):
                parsed = datetime.fromisoformat(usage_date.replace("Z", "+00:00")).date()
            else:
                continue
            resource_id = (record.get("ResourceId") or "").lower()
            parts = _parse_resource_id(resource_id)
            rows.append(
                {
                    "usage_date": parsed,
                    "azure_resource_id": resource_id,
                    "resource_name": parts["name"],
                    "resource_group": record.get("ResourceGroupName") or parts["group"],
                    "resource_type": record.get("ResourceType") or parts["type"],
                    "service_name": record.get("ServiceName") or "",
                    "meter": record.get("Meter") or record.get("ServiceName") or "",
                    "cost": float(record.get("Cost") or record.get("totalCost") or 0),
                    "currency": record.get("Currency") or "USD",
                }
            )
        return rows

    @with_retry()
    async def forecast(self, start: date, end: date) -> list[dict[str, Any]]:
        """Azure-native forecast. Callers fall back to run-rate if this is empty."""
        payload = {
            "type": "ActualCost",
            "timeframe": "Custom",
            "time_period": _period(start, end),
            "dataset": {
                "granularity": "Daily",
                "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"}},
            },
            "include_actual_cost": False,
            "include_fresh_partial_cost": True,
        }
        credential = await credential_provider.get(self.ctx)
        try:
            async with CostManagementClient(credential) as client:
                result = await client.forecast.usage(
                    scope=_scope(self.ctx.subscription_id), parameters=payload
                )
        finally:
            await credential.close()

        columns = [c.name for c in (result.columns or [])]
        out: list[dict[str, Any]] = []
        for raw in result.rows or []:
            record = dict(zip(columns, raw))
            raw_date = record.get("UsageDate")
            if raw_date is None:
                continue
            out.append(
                {
                    "forecast_date": datetime.strptime(str(raw_date), "%Y%m%d").date(),
                    "amount": float(record.get("Cost") or 0),
                    "currency": record.get("Currency") or "USD",
                    "source": "azure",
                    "confidence": "high",
                }
            )
        return out

    async def usage_details(
        self, start: date, end: date, *, max_rows: int = 200_000
    ) -> list[dict[str, Any]]:
        """Full meter-grain usage from the Consumption API.

        This is the un-rolled-up dataset behind Cost Management: one line per
        day / resource / meter, with billed quantity, unit of measure, unit and
        effective price, charge type, pricing model and reservation attribution.
        Egress, inter-region transfer, request charges and marketplace fees all
        surface here even though the portal's default views collapse them into a
        single service total.
        """
        filt = (
            f"properties/usageStart ge '{start.isoformat()}' and "
            f"properties/usageEnd le '{end.isoformat()}'"
        )
        credential = await credential_provider.get(self.ctx)
        rows: list[dict[str, Any]] = []
        try:
            async with ConsumptionManagementClient(
                credential, self.ctx.subscription_id
            ) as client:
                pages = client.usage_details.list(
                    scope=_scope(self.ctx.subscription_id),
                    expand="meterDetails,additionalProperties",
                    filter=filt,
                    metric="ActualCost",
                )
                async for item in pages:
                    row = self._normalize_usage_detail(item)
                    if row is not None:
                        rows.append(row)
                    if len(rows) >= max_rows:
                        log.warning(
                            "usage detail cap reached",
                            extra={"subscription": self.ctx.subscription_id, "cap": max_rows},
                        )
                        break
        finally:
            await credential.close()
        return rows

    @staticmethod
    def _normalize_usage_detail(item: Any) -> dict[str, Any] | None:
        """Flatten Legacy and Modern usage detail shapes into one row."""
        usage_date = getattr(item, "date", None) or getattr(item, "usage_start", None)
        if usage_date is None:
            return None
        if isinstance(usage_date, datetime):
            usage_date = usage_date.date()

        details = getattr(item, "meter_details", None)
        meter_name = getattr(details, "meter_name", "") or ""
        meter_category = (
            getattr(details, "meter_category", None)
            or getattr(item, "consumed_service", "")
            or ""
        )
        resource_id = (getattr(item, "instance_id", None) or getattr(item, "resource_id", "") or "")
        parts = _parse_resource_id(resource_id)

        # Legacy uses `cost`, modern uses `cost_in_billing_currency`.
        cost = getattr(item, "cost", None)
        if cost is None:
            cost = getattr(item, "cost_in_billing_currency", None)
        currency = (
            getattr(item, "billing_currency", None)
            or getattr(item, "billing_currency_code", None)
            or getattr(item, "currency", None)
            or "USD"
        )

        return {
            "usage_date": usage_date,
            "azure_resource_id": resource_id.lower(),
            "resource_name": getattr(item, "resource_name", "") or parts["name"],
            "resource_group": getattr(item, "resource_group", "") or parts["group"],
            "resource_type": getattr(item, "resource_type", "") or parts["type"],
            "resource_location": getattr(item, "resource_location", "") or "",
            "service_name": (
                getattr(item, "consumed_service", "")
                or getattr(details, "service_family", "")
                or meter_category
            ),
            "meter": meter_name or meter_category,
            "meter_id": str(getattr(item, "meter_id", "") or ""),
            "meter_category": meter_category,
            "meter_subcategory": getattr(details, "meter_sub_category", "") or "",
            "meter_region": getattr(details, "meter_region", "") or "",
            "service_family": getattr(details, "service_family", "") or "",
            "product": getattr(item, "product", "") or "",
            "part_number": getattr(item, "part_number", "") or "",
            "quantity": _as_float(getattr(item, "quantity", 0)),
            "unit_of_measure": getattr(details, "unit_of_measure", "")
            or getattr(item, "unit_of_measure", "")
            or "",
            "unit_price": _as_float(getattr(item, "unit_price", 0)),
            "effective_price": _as_float(getattr(item, "effective_price", 0)),
            "cost": _as_float(cost),
            "currency": str(currency)[:3].upper(),
            "charge_type": getattr(item, "charge_type", "") or "Usage",
            "frequency": getattr(item, "frequency", "") or "",
            "pricing_model": getattr(item, "pricing_model", "") or "",
            "publisher_type": getattr(item, "publisher_type", "") or "",
            "benefit_name": getattr(item, "benefit_name", "") or "",
            "reservation_id": getattr(item, "reservation_id", "") or "",
            "additional_info": _parse_additional_info(
                getattr(item, "additional_info", None)
            ),
            "tags": dict(getattr(item, "tags", None) or {}),
        }
