from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Awaitable

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.azure import (
    AdvisorGateway,
    ConnectionContext,
    CostGateway,
    GraphGateway,
    HealthGateway,
    MonitorGateway,
    ResourceGraphGateway,
)
from app.models.inventory import ARM_TYPE_MAP
from app.repositories import (
    ActivityRepo,
    ConnectionRepo,
    CostRepo,
    ForecastRepo,
    IdentityRiskRepo,
    MetricRepo,
    NetworkExposureRepo,
    NetworkUsageRepo,
    RecommendationRepo,
    ResourceRepo,
    SecureScoreRepo,
    SecurityFindingRepo,
    SyncRunRepo,
)
from app.integrations.azure.advisor_security import SecurityGateway
from app.integrations.azure.monitor import EGRESS_METRICS, INGRESS_METRICS
from app.services.optimization_service import OptimizationService
from app.services.periods import full_month, last_n_days
from app.services.security_service import analyze_nsg_rules

log = logging.getLogger(__name__)

# Cap concurrent Azure calls per subscription to stay well inside ARM limits.
_METRIC_CONCURRENCY = 8


def _rollup_network_usage(
    samples: list[dict[str, Any]], resources: list[Any], subscription_id: str
) -> list[dict[str, Any]]:
    """Aggregate throughput samples into daily ingress/egress bytes per resource.

    Azure never bills inbound data, so ingress exists only as a metric. Rolling
    it up here is what lets the UI show volume moved alongside egress charges.
    """
    by_id = {r.azure_resource_id.lower(): r for r in resources}
    buckets: dict[tuple[str, Any], dict[str, Any]] = {}

    for sample in samples:
        metric = sample.get("metric")
        if metric not in (*INGRESS_METRICS, *EGRESS_METRICS):
            continue
        volume = sample.get("total")
        if volume is None:
            continue
        timestamp = sample.get("timestamp")
        if timestamp is None:
            continue
        resource_id = str(sample.get("azure_resource_id", "")).lower()
        day = timestamp.date() if hasattr(timestamp, "date") else timestamp
        key = (resource_id, day)
        resource = by_id.get(resource_id)
        bucket = buckets.setdefault(
            key,
            {
                "azure_resource_id": resource_id,
                "subscription_id": subscription_id,
                "resource_name": getattr(resource, "name", "") or "",
                "resource_type": getattr(resource, "resource_type", "") or "",
                "resource_group": getattr(resource, "resource_group", "") or "",
                "location": getattr(resource, "location", "") or "",
                "usage_date": day,
                "ingress_bytes": 0.0,
                "egress_bytes": 0.0,
                "source_metric": "azure_monitor",
            },
        )
        if metric in INGRESS_METRICS:
            bucket["ingress_bytes"] += float(volume)
        else:
            bucket["egress_bytes"] += float(volume)

    return list(buckets.values())


class SyncService:
    """Orchestrates background synchronisation for one tenant.

    A failure on one subscription is recorded and skipped; it never aborts the
    whole tenant pass.
    """

    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.session = session
        self.tenant_id = tenant_id
        self.connections = ConnectionRepo(session, tenant_id)
        self.runs = SyncRunRepo(session, tenant_id)

    async def _run(
        self,
        kind: str,
        handler: Callable[[ConnectionContext], Awaitable[int]],
    ) -> dict[str, Any]:
        summary: dict[str, Any] = {"kind": kind, "subscriptions": [], "items": 0}
        for connection in await self.connections.enabled():
            ctx = ConnectionContext(
                tenant_id=self.tenant_id,
                azure_tenant_id=connection.azure_tenant_id,
                subscription_id=connection.subscription_id,
                credential_ref=connection.credential_ref,
                auth_mode=connection.auth_mode,
            )
            run = await self.runs.add(
                kind=kind,
                subscription_id=ctx.subscription_id,
                state="running",
                started_at=datetime.now(timezone.utc),
            )
            try:
                count = await handler(ctx)
                run.state = "succeeded"
                run.items_synced = count
                summary["items"] += count
                summary["subscriptions"].append(
                    {"subscription_id": ctx.subscription_id, "state": "succeeded", "items": count}
                )
            except Exception as exc:  # noqa: BLE001 - per-subscription isolation
                log.exception("sync failed", extra={"kind": kind, "sub": ctx.subscription_id})
                # A failed statement aborts the transaction, so roll back before
                # recording the outcome or the write itself fails and hides `exc`.
                await self.session.rollback()
                run = await self.runs.add(
                    kind=kind,
                    subscription_id=ctx.subscription_id,
                    state="failed",
                    started_at=run.started_at,
                )
                run.error = str(exc)[:2000]
                connection = await self.connections.get(connection.id)
                if connection is not None:
                    connection.last_error = str(exc)[:2000]
                summary["subscriptions"].append(
                    {"subscription_id": ctx.subscription_id, "state": "failed", "error": str(exc)}
                )
            finally:
                run.finished_at = datetime.now(timezone.utc)
                await self.session.flush()
        return summary

    # --- inventory ----------------------------------------------------
    async def sync_inventory(self) -> dict[str, Any]:
        return await self._run("inventory", self._sync_inventory_one)

    async def _sync_inventory_one(self, ctx: ConnectionContext) -> int:
        graph = ResourceGraphGateway(ctx)
        raw = await graph.inventory(list(ARM_TYPE_MAP.keys()))
        health = await HealthGateway().resource_health(ctx)

        rows = []
        for item in raw:
            arm_type = str(item.get("type", "")).lower()
            resource_id = str(item.get("id", ""))
            tags = item.get("tags") or {}
            properties = item.get("properties") or {}
            rows.append(
                {
                    "azure_resource_id": resource_id,
                    "name": item.get("name", ""),
                    "resource_type": ARM_TYPE_MAP.get(arm_type, "other"),
                    "arm_type": arm_type,
                    "subscription_id": item.get("subscriptionId", ctx.subscription_id),
                    "resource_group": item.get("resourceGroup") or "",
                    "location": item.get("location") or "",
                    "sku": str((item.get("sku") or {}).get("name", "") or ""),
                    "kind": item.get("kind") or "",
                    "power_state": item.get("powerState") or "",
                    "provisioning_state": item.get("provisioningState") or "",
                    "health_state": health.get(resource_id.lower(), "unknown"),
                    "owner": tags.get("owner") or tags.get("Owner") or "",
                    "tags": tags,
                    "properties": properties,
                    "dependencies": _dependencies(properties),
                    "synced_at": datetime.now(timezone.utc),
                }
            )
        return await ResourceRepo(self.session, self.tenant_id).upsert(rows)

    # --- cost ---------------------------------------------------------
    async def sync_cost(self, days: int = 35) -> dict[str, Any]:
        async def handler(ctx: ConnectionContext) -> int:
            period = last_n_days(days)
            gateway = CostGateway(ctx)

            # Preferred path: full meter-grain usage details (bandwidth/egress,
            # request charges, reservations and marketplace fees all included).
            rows: list[dict[str, Any]] = []
            try:
                rows = [
                    {**row, "subscription_id": ctx.subscription_id}
                    for row in await gateway.usage_details(period.start, period.end)
                ]
            except Exception as exc:  # noqa: BLE001 - fall back to the rollup query
                log.warning(
                    "usage details unavailable, falling back to cost query",
                    extra={"sub": ctx.subscription_id, "error": str(exc)[:200]},
                )

            if not rows:
                actual = await gateway.daily_costs(period.start, period.end)
                amortized = {
                    (r["usage_date"], r["azure_resource_id"], r["meter"]): r["cost"]
                    for r in await gateway.daily_costs(
                        period.start, period.end, amortized=True
                    )
                }
                rows = [
                    {
                        **row,
                        "subscription_id": ctx.subscription_id,
                        "amortized_cost": amortized.get(
                            (row["usage_date"], row["azure_resource_id"], row["meter"]),
                            row["cost"],
                        ),
                    }
                    for row in actual
                ]
            else:
                for row in rows:
                    row.setdefault("amortized_cost", row["cost"])

            count = await CostRepo(self.session, self.tenant_id).upsert(rows)

            month = full_month()
            try:
                forecast = await gateway.forecast(month.start, month.end)
            except Exception:  # noqa: BLE001 - forecast is best-effort
                forecast = []
            if forecast:
                await ForecastRepo(self.session, self.tenant_id).upsert(
                    [{**f, "subscription_id": ctx.subscription_id} for f in forecast]
                )
            return count

        return await self._run("cost", handler)

    # --- metrics ------------------------------------------------------
    async def sync_metrics(self, hours: int = 24) -> dict[str, Any]:
        async def handler(ctx: ConnectionContext) -> int:
            resources = await ResourceRepo(self.session, self.tenant_id).list(
                limit=500,
                filters=[],
            )
            targets = [
                r for r in resources if r.subscription_id == ctx.subscription_id
            ]
            gateway = MonitorGateway(ctx)
            semaphore = asyncio.Semaphore(_METRIC_CONCURRENCY)

            async def fetch(resource):
                async with semaphore:
                    try:
                        return await gateway.metrics(
                            resource.azure_resource_id, resource.resource_type, hours=hours
                        )
                    except Exception:  # noqa: BLE001 - one resource must not fail the pass
                        log.warning(
                            "metric fetch failed",
                            exc_info=True,
                            extra={"resource": resource.azure_resource_id},
                        )
                        return []

            batches = await asyncio.gather(*(fetch(r) for r in targets))
            rows = [sample for batch in batches for sample in batch]
            count = await MetricRepo(self.session, self.tenant_id).upsert(rows)

            transfer = _rollup_network_usage(rows, targets, ctx.subscription_id)
            if transfer:
                await NetworkUsageRepo(self.session, self.tenant_id).upsert(transfer)
            return count

        return await self._run("metrics", handler)

    # --- activity log --------------------------------------------------
    async def sync_activity(self, hours: int = 24) -> dict[str, Any]:
        async def handler(ctx: ConnectionContext) -> int:
            entries = await MonitorGateway(ctx).activity_log(hours=hours)
            repo = ActivityRepo(self.session, self.tenant_id)
            for entry in entries:
                await repo.add(**entry)
            return len(entries)

        return await self._run("activity", handler)

    # --- security ------------------------------------------------------
    async def sync_security(self) -> dict[str, Any]:
        async def handler(ctx: ConnectionContext) -> int:
            security = SecurityGateway(ctx)
            findings = await security.assessments()
            scores = await security.secure_scores()
            exposures = analyze_nsg_rules(await ResourceGraphGateway(ctx).nsg_rules())

            count = await SecurityFindingRepo(self.session, self.tenant_id).upsert(findings)
            await SecureScoreRepo(self.session, self.tenant_id).upsert(scores)
            await NetworkExposureRepo(self.session, self.tenant_id).upsert(exposures)

            try:
                identities = await GraphGateway(ctx).identity_posture()
                await IdentityRiskRepo(self.session, self.tenant_id).upsert(identities)
            except Exception:  # noqa: BLE001 - Graph consent may be missing
                log.warning("identity posture sync skipped", extra={"tenant": self.tenant_id})
            return count

        return await self._run("security", handler)

    # --- recommendations ------------------------------------------------
    async def sync_recommendations(self) -> dict[str, Any]:
        optimization = OptimizationService(self.session, self.tenant_id)

        async def handler(ctx: ConnectionContext) -> int:
            advisor_rows = await AdvisorGateway(ctx).recommendations()
            return await optimization.merge_advisor(advisor_rows)

        summary = await self._run("advisor", handler)
        summary["rule_findings"] = await optimization.evaluate()
        return summary


def _dependencies(properties: dict) -> list[str]:
    """Extract linked ARM ids (NICs, disks, subnets) from a resource payload."""
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "id" and isinstance(value, str) and value.startswith("/subscriptions/"):
                    found.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(properties)
    return sorted(set(found))[:50]
