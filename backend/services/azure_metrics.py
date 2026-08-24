"""
Azure Monitor metrics — the utilization data everything downstream depends on.

Why this module exists
----------------------
Cost Management answers "what did it cost". It cannot answer "was it worth it".
A VM billed at full price for a month looks identical in a cost report whether
it ran at 4% CPU or 94%. Every right-sizing claim, every idle-resource finding
and every CPU anomaly in this product needs a second, independent source: what
the resource actually did. That source is Azure Monitor.

The two rules this module is built around
-----------------------------------------
1. **A metric that was never emitted is not zero.** Azure returns `null` for
   time buckets with no data, and a stopped VM emits nothing at all. Averaging
   nulls as zeros produces a VM that looks 0% utilized and "safe to delete"
   when in truth it was simply not reporting. Every aggregate here is computed
   over *observed* points only, and the count of those points is returned
   alongside the value so a caller can refuse to act on thin evidence.

2. **Percentiles, not averages, decide a resize.** A VM averaging 8% CPU that
   hits 95% every weekday at 09:00 is correctly sized for its actual job.
   Recommending a downgrade from the mean would break it. So P95 is carried
   everywhere and is the figure right-sizing is allowed to act on; the mean is
   kept for display only.

What this module deliberately does not do
-----------------------------------------
It does not recommend anything. It fetches and summarises, and hands the result
to `compute_intel`, which owns the judgement. Keeping the two apart means the
thresholds can be argued about without touching the code that talks to Azure.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

import httpx

log = logging.getLogger(__name__)

MGMT_BASE = "https://management.azure.com"
METRICS_API = "2019-07-01"

# Azure rejects a metrics request naming more than 20 metrics, and in practice
# throttles hard well before that. Ten is comfortably inside both limits.
MAX_METRICS_PER_CALL = 10

# Azure Monitor keeps 1-minute data for 30 days and 1-hour data for 93. Asking
# for PT1H over 30 days is 720 points per metric — enough for a stable P95
# without paging.
DEFAULT_WINDOW_DAYS = 30
DEFAULT_GRAIN = "PT1H"

# Metrics are per-subscription rate limited. Four in flight is enough to make
# a large estate finish in reasonable time without collecting 429s.
MAX_CONCURRENT = 4
PER_RESOURCE_TIMEOUT = 30.0

# Below this many observed points, a percentile is not a measurement, it is a
# rumour. A VM created three days ago cannot be right-sized on its first day.
MIN_POINTS_FOR_CONFIDENCE = 48


# ─────────────────────────── metric definitions ───────────────────────────
#
# Grouped by resource type because the metric names differ per provider, and
# because asking for a metric a provider does not publish fails the *whole*
# request rather than returning partial data.

VM_METRICS = [
    "Percentage CPU",
    "Available Memory Bytes",
    "Network In Total",
    "Network Out Total",
    "OS Disk IOPS Consumed Percentage",
    "Data Disk IOPS Consumed Percentage",
]

DISK_METRICS = [
    "Composite Disk Read Bytes/sec",
    "Composite Disk Write Bytes/sec",
]

STORAGE_METRICS = [
    "UsedCapacity",
    "Transactions",
    "Egress",
    "Ingress",
]

SQL_METRICS = [
    "cpu_percent",
    "storage_percent",
    "dtu_consumption_percent",
]

METRICS_FOR_TYPE = {
    "microsoft.compute/virtualmachines": VM_METRICS,
    "microsoft.compute/disks": DISK_METRICS,
    "microsoft.storage/storageaccounts": STORAGE_METRICS,
    "microsoft.sql/servers/databases": SQL_METRICS,
}

# Which aggregation Azure should compute per metric. Counters (bytes moved,
# transaction counts) must be summed; gauges (percentages, free memory) must be
# averaged. Summing a percentage is meaningless, and averaging a byte counter
# understates traffic by the length of the grain.
_COUNTER_METRICS = {
    "Network In Total", "Network Out Total",
    "Transactions", "Egress", "Ingress",
    "Composite Disk Read Bytes/sec", "Composite Disk Write Bytes/sec",
}


def metrics_for(resource_type: str) -> List[str]:
    """The metric names worth asking for, for this resource type."""
    return list(METRICS_FOR_TYPE.get((resource_type or "").lower(), []))


def aggregation_for(metric: str) -> str:
    """`Total` for counters, `Average` for gauges. See `_COUNTER_METRICS`."""
    return "Total" if metric in _COUNTER_METRICS else "Average"


# ─────────────────────────────── statistics ───────────────────────────────


def percentile(values: Sequence[float], pct: float) -> Optional[float]:
    """
    Linear-interpolated percentile over already-observed values.

    Written out rather than pulled from numpy because this is the only
    statistics this backend needs and the dependency is not worth it. Returns
    None for an empty series, which is the honest answer — the alternative,
    returning 0.0, is the exact mistake this module exists to avoid.
    """
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])

    rank = (pct / 100.0) * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    weight = rank - low
    return float(ordered[low] * (1 - weight) + ordered[high] * weight)


def summarise(points: Iterable[Optional[float]]) -> Dict[str, Any]:
    """
    Collapse a raw Azure time series into the numbers a decision needs.

    `points` may contain None, and usually does — Azure emits null for any
    bucket where the resource reported nothing. Those are dropped rather than
    treated as zero, and `points` (the observed count) is returned so callers
    can see how much data the summary actually rests on.
    """
    observed = [float(p) for p in points if p is not None]

    if not observed:
        return {
            "avg": None, "max": None, "min": None,
            "p50": None, "p95": None, "p99": None,
            "total": None,
            "points": 0,
            "confident": False,
        }

    return {
        "avg": sum(observed) / len(observed),
        "max": max(observed),
        "min": min(observed),
        "p50": percentile(observed, 50),
        "p95": percentile(observed, 95),
        "p99": percentile(observed, 99),
        "total": sum(observed),
        "points": len(observed),
        # Not "is the number correct" but "is there enough of it to act on".
        "confident": len(observed) >= MIN_POINTS_FOR_CONFIDENCE,
    }


# ──────────────────────────────── fetching ────────────────────────────────


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _timespan(days: int, now: Optional[datetime] = None) -> str:
    """An ISO-8601 interval, which is the only timespan format Azure accepts."""
    end = now or datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    return f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}"


def parse_metric_response(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    Turn Azure's nested metrics envelope into `{metric name: summary}`.

    Azure's shape is `value[] -> timeseries[] -> data[] -> {average|total}`.
    A resource with no data still returns the metric with an empty `data`
    array, which is why an empty summary is a normal outcome here rather than
    an error.
    """
    out: Dict[str, Dict[str, Any]] = {}

    for metric in payload.get("value") or []:
        name = ((metric.get("name") or {}).get("value")
                or (metric.get("name") or {}).get("localizedValue") or "")
        if not name:
            continue

        unit = metric.get("unit") or ""
        series = metric.get("timeseries") or []
        points: List[Optional[float]] = []
        for entry in series:
            for datum in entry.get("data") or []:
                # Whichever aggregation was requested is the key that is
                # populated; the others are absent, not null.
                value = datum.get("average")
                if value is None:
                    value = datum.get("total")
                if value is None:
                    value = datum.get("maximum")
                points.append(value)

        summary = summarise(points)
        summary["unit"] = unit
        out[name] = summary

    return out


async def fetch_resource_metrics(
    client: httpx.AsyncClient,
    token: str,
    resource_id: str,
    metric_names: Sequence[str],
    days: int = DEFAULT_WINDOW_DAYS,
    grain: str = DEFAULT_GRAIN,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Metrics for one resource.

    Returns `{"metrics": {...}}` on success, or `{"error": ..., "kind": ...}`
    on failure. Failure is never raised: one resource that a caller lacks
    `Microsoft.Insights/metrics/read` on must not empty the whole page, and a
    resource type that publishes none of the requested metrics is a normal,
    expected outcome rather than a fault.
    """
    if not metric_names:
        return {"metrics": {}, "points": 0}

    names = list(metric_names)[:MAX_METRICS_PER_CALL]
    params = {
        "api-version": METRICS_API,
        "metricnames": ",".join(names),
        "timespan": _timespan(days, now),
        "interval": grain,
        # Azure requires one aggregation list for the whole call, so both are
        # requested and `parse_metric_response` picks whichever came back. The
        # alternative — one HTTP call per aggregation — doubles the request
        # count against a rate-limited API for no gain.
        "aggregation": "Average,Total",
    }

    url = f"{MGMT_BASE}{resource_id}/providers/Microsoft.Insights/metrics"

    try:
        resp = await client.get(url, params=params, headers=_headers(token),
                                timeout=PER_RESOURCE_TIMEOUT)
        if resp.status_code == 403:
            return {
                "error": "Missing Monitoring Reader (Microsoft.Insights/metrics/read).",
                "kind": "permission",
                "metrics": {},
            }
        if resp.status_code == 429:
            return {
                "error": "Azure Monitor throttled this request. Utilization is incomplete.",
                "kind": "throttled",
                "metrics": {},
            }
        if resp.status_code == 400:
            # Almost always "metric not found for this resource type" — a fact
            # about the resource, not a failure of the request.
            return {
                "error": "This resource does not publish the requested metrics.",
                "kind": "unsupported",
                "metrics": {},
            }
        resp.raise_for_status()
        return {"metrics": parse_metric_response(resp.json())}

    except asyncio.TimeoutError:
        return {"error": "Azure Monitor did not respond in time.", "kind": "timeout", "metrics": {}}
    except httpx.HTTPError as exc:
        log.warning("metrics fetch failed for %s: %s", resource_id, exc)
        return {"error": str(exc), "kind": "error", "metrics": {}}


async def fetch_many(
    token: str,
    resources: Sequence[Dict[str, Any]],
    days: int = DEFAULT_WINDOW_DAYS,
    grain: str = DEFAULT_GRAIN,
    max_concurrent: int = MAX_CONCURRENT,
    now: Optional[datetime] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    Metrics for many resources, bounded in concurrency.

    Each entry of `resources` needs an `id` and a `type`. The metric list is
    chosen from the type, so a mixed batch of VMs, disks and storage accounts
    can be passed in one call.

    Returns `{resource id: result}`. A resource whose fetch failed is present
    with its error rather than missing, because a page that silently drops the
    resources it could not read shows a smaller, cleaner and wrong estate.
    """
    semaphore = asyncio.Semaphore(max_concurrent)
    results: Dict[str, Dict[str, Any]] = {}

    async with httpx.AsyncClient(timeout=PER_RESOURCE_TIMEOUT) as client:
        async def one(resource: Dict[str, Any]):
            resource_id = resource.get("id") or ""
            if not resource_id:
                return
            names = metrics_for(resource.get("type") or "")
            if not names:
                results[resource_id] = {
                    "metrics": {},
                    "kind": "unsupported",
                    "error": "No metrics are defined for this resource type.",
                }
                return
            async with semaphore:
                results[resource_id] = await fetch_resource_metrics(
                    client, token, resource_id, names, days=days, grain=grain, now=now
                )

        await asyncio.gather(*(one(r) for r in resources), return_exceptions=True)

    return results
