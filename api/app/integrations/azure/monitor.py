from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from azure.mgmt.monitor.aio import MonitorManagementClient

from app.integrations.azure.credentials import ConnectionContext, credential_provider
from app.integrations.azure.retry import with_retry

log = logging.getLogger(__name__)

# Canonical metric name -> Azure Monitor metric per resource family.
METRIC_MAP: dict[str, dict[str, str]] = {
    "virtual_machine": {
        "cpu": "Percentage CPU",
        "disk_read": "Disk Read Bytes",
        "disk_write": "Disk Write Bytes",
        "network_in": "Network In Total",
        "network_out": "Network Out Total",
        "memory_available": "Available Memory Bytes",
    },
    "app_service": {
        "cpu": "CpuTime",
        "memory": "MemoryWorkingSet",
        "response_time": "HttpResponseTime",
        "requests": "Requests",
        "availability": "HealthCheckStatus",
        "network_in": "BytesReceived",
        "network_out": "BytesSent",
    },
    "sql_database": {
        "cpu": "cpu_percent",
        "storage": "storage_percent",
        "dtu": "dtu_consumption_percent",
    },
    "storage_account": {
        "capacity": "UsedCapacity",
        "transactions": "Transactions",
        "availability": "Availability",
        "response_time": "SuccessE2ELatency",
        "network_in": "Ingress",
        "network_out": "Egress",
    },
    "aks_cluster": {
        "cpu": "node_cpu_usage_percentage",
        "memory": "node_memory_working_set_percentage",
        "network_in": "node_network_in_bytes",
        "network_out": "node_network_out_bytes",
    },
    "function_app": {
        "requests": "Requests",
        "response_time": "HttpResponseTime",
        "network_in": "BytesReceived",
        "network_out": "BytesSent",
    },
    "load_balancer": {
        "network_in": "ByteCount",
        "availability": "VipAvailability",
    },
    "public_ip": {
        "network_in": "ByteCount",
        "packets": "PacketCount",
    },
    "vpn_gateway": {
        "network_in": "TunnelIngressBytes",
        "network_out": "TunnelEgressBytes",
        "availability": "TunnelAverageBandwidth",
    },
    "application_gateway": {
        "network_in": "BytesReceived",
        "network_out": "BytesSent",
        "requests": "TotalRequests",
        "response_time": "ApplicationGatewayTotalTime",
    },
}

# Canonical metrics carrying data-transfer volume, in bytes.
INGRESS_METRICS = ("network_in",)
EGRESS_METRICS = ("network_out",)

# Every Azure metric supports an hourly grain, so it is a safe second attempt.
_FALLBACK_INTERVAL = "PT1H"


def _iso_utc(value: datetime) -> str:
    """Format an instant the way the Monitor `timespan` parameter requires.

    `datetime.isoformat()` yields a `+00:00` offset, and the `+` is decoded as a
    space once it reaches the query string, so Azure rejects the whole interval
    with `Detected invalid time interval input`. The `Z` suffix avoids it.
    """
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class MonitorGateway:
    def __init__(self, ctx: ConnectionContext) -> None:
        self.ctx = ctx

    @with_retry()
    async def _list(self, client: MonitorManagementClient, **kwargs: Any) -> Any:
        return await client.metrics.list(**kwargs)

    async def metrics(
        self,
        azure_resource_id: str,
        resource_type: str,
        *,
        hours: int = 24,
        interval: str = "PT15M",
    ) -> list[dict[str, Any]]:
        """Fetch the canonical metric set for one resource."""
        wanted = METRIC_MAP.get(resource_type)
        if not wanted:
            return []

        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=hours)
        timespan = f"{_iso_utc(start)}/{_iso_utc(end)}"

        credential = await credential_provider.get(self.ctx)
        samples: list[dict[str, Any]] = []
        try:
            async with MonitorManagementClient(
                credential, self.ctx.subscription_id
            ) as client:
                # Azure requires every metric in one call to share a time grain,
                # and coarse metrics (e.g. storage UsedCapacity, hourly only)
                # otherwise reject the whole batch. Fall back to a grain that
                # all of them accept rather than losing the resource entirely.
                candidates = [interval] + [
                    i for i in (_FALLBACK_INTERVAL,) if i != interval
                ]
                response = None
                for candidate in candidates:
                    try:
                        response = await self._list(
                            client,
                            resource_uri=azure_resource_id,
                            timespan=timespan,
                            interval=candidate,
                            metricnames=",".join(wanted.values()),
                            aggregation="Average,Maximum,Minimum,Total",
                        )
                        break
                    except Exception:
                        if candidate == candidates[-1]:
                            raise
                        log.debug(
                            "metric interval rejected, retrying coarser",
                            extra={
                                "resource": azure_resource_id,
                                "interval": candidate,
                            },
                        )
                reverse = {v: k for k, v in wanted.items()}
                for metric in response.value or []:
                    canonical = reverse.get(metric.name.value, metric.name.value)
                    for series in metric.timeseries or []:
                        for point in series.data or []:
                            if point.average is None and point.total is None:
                                continue
                            samples.append(
                                {
                                    "azure_resource_id": azure_resource_id,
                                    "metric": canonical,
                                    "timestamp": point.time_stamp,
                                    "average": point.average,
                                    "maximum": point.maximum,
                                    "minimum": point.minimum,
                                    "total": point.total,
                                    "unit": str(metric.unit),
                                }
                            )
        finally:
            await credential.close()
        return samples

    async def activity_log(self, *, hours: int = 24) -> list[dict[str, Any]]:
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=hours)
        filt = (
            f"eventTimestamp ge '{start.isoformat()}' and "
            f"eventTimestamp le '{end.isoformat()}'"
        )
        credential = await credential_provider.get(self.ctx)
        entries: list[dict[str, Any]] = []
        try:
            async with MonitorManagementClient(
                credential, self.ctx.subscription_id
            ) as client:
                async for item in client.activity_logs.list(filter=filt):
                    entries.append(
                        {
                            "azure_resource_id": (item.resource_id or "").lower(),
                            "subscription_id": self.ctx.subscription_id,
                            "event_time": item.event_timestamp,
                            "operation": getattr(item.operation_name, "value", "") or "",
                            "status": getattr(item.status, "value", "") or "",
                            "caller": item.caller or "",
                            "level": str(item.level or ""),
                            "description": item.description or "",
                        }
                    )
        finally:
            await credential.close()
        return entries
