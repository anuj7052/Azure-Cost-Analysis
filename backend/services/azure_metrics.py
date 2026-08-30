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
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import quote, urlencode

import httpx

from services import azure_retry

log = logging.getLogger(__name__)

MGMT_BASE = "https://management.azure.com"
METRICS_API = "2019-07-01"
METRIC_DEFINITIONS_API = "2018-01-01"

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

# One gate for the whole process, not one per call.
#
# This used to be built inside collect_metrics, which meant the limit was four
# *per invocation*: two browser tabs, or the Compute page and the Estate page,
# each got their own four and Azure saw eight. The limit that matters is the
# one Azure enforces, and it counts requests, not callers.
#
# Created lazily because a Semaphore binds to the running event loop, and this
# module is imported before there is one.
_gate: asyncio.Semaphore | None = None
_gate_size = 0


def _shared_gate(size: int) -> asyncio.Semaphore:
    global _gate, _gate_size
    if _gate is None or _gate_size != size:
        _gate = asyncio.Semaphore(size)
        _gate_size = size
    return _gate

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
    "Disk Read Bytes",
    "Disk Write Bytes",
    "Disk Read Operations/Sec",
    "Disk Write Operations/Sec",
]

# Metrics the Azure *host* emits for every VM with no agent installed, versus
# metrics that only exist once the Azure Monitor Agent is running inside the
# guest.
#
# This distinction is the whole reason a running VM reported "Metric not
# published for this resource" while plainly having a CPU. Azure Monitor fails
# a metrics request **in its entirety** with HTTP 400 if any single requested
# name is not published for that resource. `Available Memory Bytes` is a guest
# metric, so on a VM without the agent it poisoned the same request that
# carried `Percentage CPU` — and the platform metric that was available came
# back as nothing. Asking only for what the resource actually publishes is the
# fix, which is what `fetch_metric_definitions` below exists to determine.
HOST_VM_METRICS = {
    "Percentage CPU",
    "Network In Total",
    "Network Out Total",
    "Disk Read Bytes",
    "Disk Write Bytes",
    "Disk Read Operations/Sec",
    "Disk Write Operations/Sec",
    "OS Disk IOPS Consumed Percentage",
    "Data Disk IOPS Consumed Percentage",
}

GUEST_VM_METRICS = {
    "Available Memory Bytes",
}

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


def desired_aggregations(metric: str) -> List[str]:
    """
    The aggregations this module will actually read for a metric.

    A counter is only ever summed. A gauge is read as an average, a peak and a
    trough. Nothing else is asked for, however much the catalogue offers:
    `metricDefinitions` reports `Total` as a supported aggregation for
    `Percentage CPU` — a meaningless sum of percentages — and the metrics
    endpoint then rejects the entire request for asking, blaming the metric
    names, every one of which is valid.
    """
    if metric in _COUNTER_METRICS:
        return ["Total"]
    return ["Average", "Maximum", "Minimum"]


# ───────────────────────────── telemetry status ─────────────────────────────
#
# One vocabulary for "why is this number missing", shared by the fetcher, the
# verdict engine and the UI.
#
# Nine states rather than a boolean because they demand different things of the
# reader: grant a role, wait for history to accumulate, retry after a throttle,
# install the agent, or do nothing at all because the machine is switched off.
# A single "no data" flag flattens all of that into something that reads like a
# bug in this application.

VALID = "VALID"                          # enough observations to act on
PARTIAL_DATA = "PARTIAL_DATA"            # real data, but a thin slice of the window
INSUFFICIENT_DATA = "INSUFFICIENT_DATA"  # observations exist, below the evidence bar
NO_DATA = "NO_DATA"                      # metric is published, Azure returned no points
NO_METRIC = "NO_METRIC"                  # the resource does not publish this metric
NO_ACCESS = "NO_ACCESS"                  # Microsoft.Insights/metrics/read denied
THROTTLED = "THROTTLED"                  # HTTP 429, window is incomplete
API_ERROR = "API_ERROR"                  # the request itself failed
NOT_RUNNING = "NOT_RUNNING"              # powered off; absence is expected

STATUS_LABEL = {
    VALID: "Telemetry available",
    PARTIAL_DATA: "Partial telemetry",
    INSUFFICIENT_DATA: "Insufficient data",
    # NO_DATA is about an empty window for a metric that exists; NO_METRIC is
    # about a metric that does not. The old "CPU metric unavailable" covered
    # both and so told the reader nothing about which to act on.
    NO_DATA: "Published · No data",
    NO_METRIC: "Not published",
    NO_ACCESS: "Access denied",
    THROTTLED: "Throttled",
    API_ERROR: "Query error",
    NOT_RUNNING: "VM is deallocated",
}

# Below this fraction of the window, a percentile describes a sample rather
# than a month, and is reported as partial rather than sound.
MIN_COVERAGE_FOR_CONFIDENCE = 50.0


# ───────────────────────────── metric definitions ─────────────────────────────


async def fetch_metric_definitions(
    client: httpx.AsyncClient,
    token: str,
    resource_id: str,
) -> Dict[str, Any]:
    """
    What this specific resource actually publishes.

    Azure Monitor has no partial mode: name one metric the resource does not
    publish and the entire request fails with HTTP 400, taking the metrics that
    *were* available down with it. So the only safe way to ask for metrics is
    to first ask what exists, then request the intersection.

    Returns `{"metrics": [...], "namespaces": [...], "aggregations": {...},
    "dimensions": {...}}` on success, or `{"error", "kind"}` on failure. Never
    raises: a definitions lookup that fails should degrade a single VM, not
    empty the page.
    """
    url = f"{MGMT_BASE}{resource_id}/providers/Microsoft.Insights/metricDefinitions"
    params = {"api-version": METRIC_DEFINITIONS_API}

    try:
        resp = await azure_retry.send_with_retry(
            lambda: client.get(url, params=params, headers=_headers(token),
                               timeout=PER_RESOURCE_TIMEOUT)
        )
        if resp.status_code == 403:
            return {"error": "Missing Monitoring Reader (Microsoft.Insights/metrics/read).",
                    "kind": NO_ACCESS, "status_code": 403}
        if resp.status_code == 429:
            # Still throttled after the retries above waited out Azure's own
            # Retry-After. Reported rather than retried further: this VM has a
            # named reason, and continuing to ask would throttle the rest.
            return {"error": "Azure Monitor throttled the metric definitions request.",
                    "kind": THROTTLED, "status_code": 429}
        resp.raise_for_status()

        names: List[str] = []
        namespaces: List[str] = []
        aggregations: Dict[str, List[str]] = {}
        dimensions: Dict[str, List[str]] = {}

        for definition in resp.json().get("value") or []:
            name = ((definition.get("name") or {}).get("value")
                    or (definition.get("name") or {}).get("localizedValue") or "")
            if not name:
                continue
            names.append(name)

            namespace = definition.get("namespace") or ""
            if namespace and namespace not in namespaces:
                namespaces.append(namespace)

            supported = [a for a in (definition.get("supportedAggregationTypes") or []) if a]
            if supported:
                aggregations[name] = supported

            dims = [
                ((d or {}).get("value") or (d or {}).get("localizedValue") or "")
                for d in (definition.get("dimensions") or [])
            ]
            dims = [d for d in dims if d]
            if dims:
                dimensions[name] = dims

        return {
            "metrics": names,
            "namespaces": namespaces,
            "aggregations": aggregations,
            "dimensions": dimensions,
            "status_code": resp.status_code,
        }

    except asyncio.TimeoutError:
        return {"error": "Azure Monitor did not respond in time.", "kind": API_ERROR}
    except httpx.HTTPError as exc:
        # The resource id and the failure, never the token.
        log.warning("metric definitions failed for %s: %s", resource_id, exc)
        return {"error": str(exc), "kind": API_ERROR}


def capabilities_from(available: Sequence[str]) -> Dict[str, Any]:
    """
    Which kinds of telemetry this resource can offer at all.

    Grouped rather than listed flat so the UI can say "CPU unavailable, network
    and disk available" — which tells an operator whether the machine is
    measurable in any sense, instead of just that one metric is missing.
    """
    names = [n for n in available if n]
    lowered = {n.lower() for n in names}

    def any_of(*needles: str) -> bool:
        return any(any(n in name for name in lowered) for n in needles)

    return {
        "percentage_cpu": "percentage cpu" in lowered,
        "memory": any_of("available memory"),
        "network": any_of("network in", "network out"),
        "disk": any_of("disk read", "disk write", "iops", "disk queue"),
        "available_metrics": sorted(names),
    }


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


def summarise(
    points: Iterable[Optional[float]],
    timestamps: Optional[Sequence[Optional[str]]] = None,
) -> Dict[str, Any]:
    """
    Collapse a raw Azure time series into the numbers a decision needs.

    `points` may contain None, and usually does — Azure emits null for any
    bucket where the resource reported nothing. Those are dropped rather than
    treated as zero, and `points` (the observed count) is returned so callers
    can see how much data the summary actually rests on.

    Azure returns one bucket per interval whether or not the resource reported
    in it, so the length of `points` is the expected count and the non-null
    subset is the observed one. The ratio is `coverage` — the difference
    between "this VM idled at 4%" and "this VM told us about 4% of the month"
    is the whole basis for trusting a resize, so it is measured rather than
    assumed.
    """
    raw = list(points)
    expected = len(raw)
    observed_pairs = [
        (raw[i], (timestamps[i] if timestamps and i < len(timestamps) else None))
        for i in range(expected)
        if raw[i] is not None
    ]
    observed = [float(v) for v, _ in observed_pairs]
    stamps = [t for _, t in observed_pairs if t]

    coverage = (len(observed) / expected * 100.0) if expected else None

    if not observed:
        return {
            "avg": None, "max": None, "min": None,
            "p50": None, "p95": None, "p99": None,
            "total": None,
            "points": 0,
            "expected": expected,
            "coverage": coverage,
            "first": None,
            "last": None,
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
        "expected": expected,
        "coverage": coverage,
        "first": min(stamps) if stamps else None,
        "last": max(stamps) if stamps else None,
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
        stamps: List[Optional[str]] = []
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
                stamps.append(datum.get("timeStamp") or datum.get("timestamp"))

        summary = summarise(points, stamps)
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
    verified: bool = False,
    aggregation: str = "",
    namespace: str = "",
) -> Dict[str, Any]:
    """
    Metrics for one resource.

    Returns `{"metrics": {...}}` on success, or `{"error": ..., "kind": ...}`
    on failure. Failure is never raised: one resource that a caller lacks
    `Microsoft.Insights/metrics/read` on must not empty the whole page, and a
    resource type that publishes none of the requested metrics is a normal,
    expected outcome rather than a fault.

    `verified` says that every name in `metric_names` was already confirmed
    present in this resource's `metricDefinitions`. It changes what an HTTP
    400 is allowed to mean: unverified, 400 genuinely suggests an unpublished
    metric; verified, that explanation is already disproved, so reporting it
    would contradict the capability list built from the same catalogue.
    """
    if not metric_names:
        return {"metrics": {}, "points": 0}

    names = list(metric_names)[:MAX_METRICS_PER_CALL]
    params = {
        "api-version": METRICS_API,
        "metricnames": ",".join(names),
        "timespan": _timespan(days, now),
        "interval": grain,
        # Azure applies one aggregation list to every metric in the call and
        # rejects the whole request if any one of them does not support an
        # entry. `Percentage CPU` has no Total, so the old fixed
        # "Average,Total" 400'd on every VM that had a CPU — the failure this
        # module was built to explain. Callers that know the catalogue pass
        # the supported set; the default stays conservative.
        "aggregation": aggregation or "Average",
    }
    if namespace:
        # Without an explicit namespace Azure resolves metric names against a
        # small legacy shim list — the one its 400 body calls "Valid metrics",
        # which omits `Network In Total`, `Available Memory Bytes` and every
        # IOPS percentage. `metricDefinitions` has no such fallback, so the two
        # endpoints appeared to disagree about metrics that plainly exist. They
        # never disagreed; they were being asked different questions.
        params["metricnamespace"] = namespace

    url = f"{MGMT_BASE}{resource_id}/providers/Microsoft.Insights/metrics"
    # Azure separates metric names with a literal comma. Percent-encoding it as
    # %2C makes the endpoint read the whole list as one metric name, which is
    # exactly what its 400 body reported — a singular "metric:" followed by
    # every name joined together, then a "Valid metrics:" list that contained
    # those same names. The two endpoints never disagreed; one request was
    # malformed. `httpx` encodes commas by default, so the query is built here.
    query = urlencode(params, safe=",", quote_via=quote)
    started = time.monotonic()

    def elapsed() -> float:
        return round((time.monotonic() - started) * 1000, 1)

    try:
        resp = await azure_retry.send_with_retry(
            lambda: client.get(f"{url}?{query}", headers=_headers(token),
                               timeout=PER_RESOURCE_TIMEOUT)
        )
        diagnostics = {
            "requested_metrics": names,
            "status_code": resp.status_code,
            "duration_ms": elapsed(),
        }
        if resp.status_code == 403:
            return {
                "error": "Missing Monitoring Reader (Microsoft.Insights/metrics/read).",
                "kind": NO_ACCESS,
                "metrics": {},
                "diagnostics": diagnostics,
            }
        if resp.status_code == 429:
            return {
                "error": "Azure Monitor throttled this request. Utilization is incomplete.",
                "kind": THROTTLED,
                "metrics": {},
                "diagnostics": diagnostics,
            }
        if resp.status_code == 400:
            # "Metric not found for this resource type". Reaching this after a
            # definitions lookup means Azure's own catalogue disagreed with its
            # metrics endpoint, so the body is logged — it names the offending
            # metric and is the only way to tell the two apart.
            log.warning(
                "metrics 400 for %s | requested=%s | verified=%s | body=%s",
                resource_id, names, verified, resp.text[:2000],
            )
            if verified:
                # The catalogue listed these metrics moments ago. Calling them
                # unpublished now would put two contradictory claims about the
                # same metric on the same screen.
                return {
                    "error": (
                        "Azure Monitor rejected a query for metrics its own catalogue "
                        "lists for this resource. The request failed; this is not "
                        "evidence about whether the metric exists."
                    ),
                    "kind": API_ERROR,
                    "metrics": {},
                    "diagnostics": {**diagnostics, "body": resp.text[:2000]},
                }
            return {
                "error": "This resource does not publish the requested metrics.",
                "kind": NO_METRIC,
                "metrics": {},
                "diagnostics": {**diagnostics, "body": resp.text[:2000]},
            }
        resp.raise_for_status()
        return {"metrics": parse_metric_response(resp.json()), "diagnostics": diagnostics}

    except asyncio.TimeoutError:
        return {
            "error": "Azure Monitor did not respond in time.",
            "kind": API_ERROR,
            "metrics": {},
            "diagnostics": {"requested_metrics": names, "duration_ms": elapsed()},
        }
    except httpx.HTTPError as exc:
        log.warning("metrics fetch failed for %s: %s", resource_id, exc)
        return {
            "error": str(exc),
            "kind": API_ERROR,
            "metrics": {},
            "diagnostics": {"requested_metrics": names, "duration_ms": elapsed()},
        }


# The aggregations worth asking for, in the order `parse_metric_response`
# prefers them. Anything Azure offers beyond these is not used here.
USEFUL_AGGREGATIONS = ["Average", "Maximum", "Minimum", "Total"]

# The one aggregation every Azure metric supports, used when a richer request
# is refused.
FALLBACK_AGGREGATION = "Average"

# Which aggregation a resource type was actually willing to serve, learned once
# and reused for the rest of the fleet.
_SERVED_AGGREGATION: Dict[str, str] = {}


def remember_served_aggregation(resource_type: str, aggregation: str) -> None:
    if resource_type and aggregation:
        _SERVED_AGGREGATION[resource_type.lower()] = aggregation


def served_aggregation_for(resource_type: str) -> str:
    return _SERVED_AGGREGATION.get((resource_type or "").lower(), "")


def valid_metrics_from_error(body: str) -> List[str]:
    """
    The metric names Azure names as acceptable in its own 400 body.

    On some providers the metrics endpoint accepts a smaller set than
    `metricDefinitions` advertises, and says so:

        "Failed to find metric configuration ... metric: <what was asked>,
         Valid metrics: Percentage CPU,Network In,Network Out,..."

    That list is the authoritative answer to a question the catalogue got
    wrong, so it is read rather than guessed at. The response is truncated for
    logging, so the final entry may be cut mid-name; callers intersect against
    what they asked for, which discards a partial name harmlessly.
    """
    marker = "Valid metrics:"
    if marker not in (body or ""):
        return []
    tail = body.split(marker, 1)[1]
    # The list runs to the end of the message; stop at the JSON string close.
    tail = tail.split('"')[0]
    return [name.strip() for name in tail.split(",") if name.strip()]


# What the metrics endpoint actually accepted, learned per resource *type*.
#
# The rejection is a property of the provider, not of any one machine, so the
# first VM to hit it pays for the discovery and every other VM of that type
# skips the doomed request. Without this the retry doubled the request count
# across the whole fleet and pushed the page past its timeout.
_ACCEPTED_METRICS: Dict[str, List[str]] = {}


def remember_accepted(resource_type: str, accepted: Sequence[str]) -> None:
    if resource_type and accepted:
        _ACCEPTED_METRICS[resource_type.lower()] = list(accepted)


def accepted_for(resource_type: str) -> List[str]:
    return _ACCEPTED_METRICS.get((resource_type or "").lower(), [])


def group_by_aggregation(
    names: Sequence[str],
    aggregations: Dict[str, List[str]],
) -> List[Tuple[str, List[str]]]:
    """
    Split metric names into groups that can legally share one request.

    Azure applies a single `aggregation` list to every metric in a call and
    rejects the entire request if one metric does not support one entry.
    `Percentage CPU` supports Average/Maximum/Minimum but not Total, while the
    byte counters support Total; asking for both together is an automatic 400.

    Grouping by supported-aggregation signature turns that guaranteed failure
    into two lawful requests. Metrics whose aggregations the catalogue did not
    report fall back to Average, which every Azure metric supports.

    The catalogue narrows the request; it never widens it. Only the
    aggregations this module reads are ever asked for, because an aggregation
    that is advertised but not served fails the whole call.
    """
    groups: Dict[Tuple[str, ...], List[str]] = {}
    for name in names:
        wanted = desired_aggregations(name)
        catalogue = aggregations.get(name)
        supported = [a for a in wanted if a in catalogue] if catalogue else []
        key = tuple(supported) if supported else ("Average",)
        groups.setdefault(key, []).append(name)
    return [(",".join(key), members) for key, members in groups.items()]


async def fetch_metrics_by_aggregation(
    client: httpx.AsyncClient,
    token: str,
    resource_id: str,
    names: Sequence[str],
    aggregations: Dict[str, List[str]],
    days: int = DEFAULT_WINDOW_DAYS,
    grain: str = DEFAULT_GRAIN,
    now: Optional[datetime] = None,
    namespace: str = "",
    resource_type: str = "",
) -> Dict[str, Any]:
    """
    Fetch verified metrics, one request per compatible aggregation group.

    A group that fails does not discard the groups that succeeded: losing disk
    counters is no reason to throw away the CPU history, which is the same
    all-or-nothing mistake that made a running VM look unmeasurable.
    """
    groups = group_by_aggregation(names, aggregations)
    learned = served_aggregation_for(resource_type)
    if learned:
        # A previous machine of this type already found out which aggregation
        # the provider will actually serve. Repeating its failed request once
        # per VM would spend the whole request budget relearning it.
        groups = [(learned, members) for _, members in groups]
    merged: Dict[str, Any] = {}
    diagnostics: Dict[str, Any] = {"groups": [], "duration_ms": 0}
    failures: List[Dict[str, Any]] = []

    for aggregation, members in groups:
        result = await fetch_resource_metrics(
            client, token, resource_id, members,
            days=days, grain=grain, now=now, verified=True,
            aggregation=aggregation, namespace=namespace,
        )
        group_diag = result.get("diagnostics") or {}
        diagnostics["groups"].append({
            "aggregation": aggregation,
            "metrics": list(members),
            "status_code": group_diag.get("status_code"),
        })
        diagnostics["duration_ms"] += group_diag.get("duration_ms") or 0
        if result.get("kind"):
            body = (result.get("diagnostics") or {}).get("body") or ""
            accepted = valid_metrics_from_error(body)
            remember_accepted(resource_type, accepted)
            retry = [n for n in members if n in accepted]
            if retry and len(retry) < len(members):
                # Azure named the subset it will serve. Asking again for only
                # that subset is the difference between losing every metric on
                # this machine and losing only the ones it genuinely refuses —
                # and `Percentage CPU` is almost always in the subset.
                result = await fetch_resource_metrics(
                    client, token, resource_id, retry,
                    days=days, grain=grain, now=now, verified=True,
                    aggregation=aggregation, namespace=namespace,
                )
                group_diag = result.get("diagnostics") or {}
                diagnostics["groups"].append({
                    "aggregation": aggregation,
                    "metrics": list(retry),
                    "status_code": group_diag.get("status_code"),
                    "retry_of": list(members),
                    "rejected": [n for n in members if n not in accepted],
                })
                diagnostics["duration_ms"] += group_diag.get("duration_ms") or 0

        if result.get("kind") and aggregation != FALLBACK_AGGREGATION:
            # Azure advertises `supportedAggregationTypes` that it will not
            # serve — it lists `Total` for `Percentage CPU`, a meaningless sum
            # of percentages — and rejects the whole request when one is asked
            # for. The rejection blames the metric names, every one of which is
            # valid, so the only way through is to ask again for the one
            # aggregation every Azure metric supports.
            result = await fetch_resource_metrics(
                client, token, resource_id, members,
                days=days, grain=grain, now=now, verified=True,
                aggregation=FALLBACK_AGGREGATION, namespace=namespace,
            )
            group_diag = result.get("diagnostics") or {}
            diagnostics["groups"].append({
                "aggregation": FALLBACK_AGGREGATION,
                "metrics": list(members),
                "status_code": group_diag.get("status_code"),
                "retry_of": list(members),
                "rejected_aggregation": aggregation,
            })
            diagnostics["duration_ms"] += group_diag.get("duration_ms") or 0
            if not result.get("kind"):
                remember_served_aggregation(resource_type, FALLBACK_AGGREGATION)

        if result.get("kind"):
            failures.append({**result, "aggregation": aggregation})
            continue
        merged.update(result.get("metrics") or {})

    out: Dict[str, Any] = {"metrics": merged, "diagnostics": diagnostics}
    if failures and not merged:
        # Everything failed, so the failure is the whole answer. The first is
        # reported because a uniform cause (403, throttling) produces uniform
        # failures, and the per-group detail is in diagnostics either way.
        first = failures[0]
        out["kind"] = first.get("kind")
        out["error"] = first.get("error")
        diagnostics["status_code"] = (first.get("diagnostics") or {}).get("status_code")
        diagnostics["body"] = (first.get("diagnostics") or {}).get("body")
    elif failures:
        # Some data arrived. Say so, and name what was lost.
        out["partial_failures"] = [
            {"aggregation": f.get("aggregation"), "kind": f.get("kind"), "error": f.get("error")}
            for f in failures
        ]
    return out


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

    Each entry of `resources` needs an `id` and a `type`. Every resource is
    asked what it publishes before it is asked for anything, because Azure
    Monitor fails a whole metrics request if one requested name is missing —
    so a single guest-only metric such as `Available Memory Bytes` would
    otherwise take `Percentage CPU` down with it on any VM without the agent.

    That costs one extra request per resource. It is bounded by the same
    semaphore and is worth it: without it a perfectly measurable VM reports no
    telemetry at all, which is the worst possible failure for a page whose
    entire purpose is measuring things.

    Returns `{resource id: result}`. A resource whose fetch failed is present
    with its error rather than missing, because a page that silently drops the
    resources it could not read shows a smaller, cleaner and wrong estate.
    """
    semaphore = _shared_gate(max_concurrent)
    results: Dict[str, Dict[str, Any]] = {}

    async with httpx.AsyncClient(timeout=PER_RESOURCE_TIMEOUT) as client:
        async def one(resource: Dict[str, Any]):
            resource_id = resource.get("id") or ""
            if not resource_id:
                return
            wanted = metrics_for(resource.get("type") or "")
            if not wanted:
                results[resource_id] = {
                    "metrics": {},
                    "kind": NO_METRIC,
                    "error": "No metrics are defined for this resource type.",
                    "capabilities": capabilities_from([]),
                }
                return

            async with semaphore:
                definitions = await fetch_metric_definitions(client, token, resource_id)

            if definitions.get("kind"):
                # Could not even read the catalogue. That failure is the whole
                # answer for this VM, and it is reported as itself rather than
                # as an absence of data.
                results[resource_id] = {
                    "metrics": {},
                    "kind": definitions["kind"],
                    "error": definitions.get("error"),
                    "capabilities": capabilities_from([]),
                    "diagnostics": {
                        "requested_metrics": wanted,
                        "available_metrics": [],
                        "status_code": definitions.get("status_code"),
                        "stage": "definitions",
                    },
                }
                return

            available = definitions.get("metrics") or []
            capabilities = capabilities_from(available)
            # Order preserved from `wanted` so CPU is never the name dropped by
            # the MAX_METRICS_PER_CALL cap.
            available_set = {a.lower() for a in available}
            ask = [name for name in wanted if name.lower() in available_set]

            # If this provider has already told us it serves a smaller set than
            # it advertises, believe it the first time rather than re-earning
            # the same 400 on every remaining machine.
            learned = accepted_for(resource.get("type") or "")
            if learned:
                learned_set = {n.lower() for n in learned}
                narrowed = [n for n in ask if n.lower() in learned_set]
                if narrowed:
                    ask = narrowed

            if not ask:
                results[resource_id] = {
                    "metrics": {},
                    "kind": NO_METRIC,
                    "error": "This resource publishes none of the metrics used for sizing.",
                    "capabilities": capabilities,
                    "namespaces": definitions.get("namespaces") or [],
                    "diagnostics": {
                        "requested_metrics": wanted,
                        "available_metrics": available,
                        "status_code": definitions.get("status_code"),
                        "stage": "definitions",
                    },
                }
                return

            async with semaphore:
                result = await fetch_metrics_by_aggregation(
                    client, token, resource_id, ask,
                    definitions.get("aggregations") or {},
                    days=days, grain=grain, now=now,
                    namespace=(definitions.get("namespaces") or [""])[0],
                    resource_type=resource.get("type") or "",
                )

            result["capabilities"] = capabilities
            result["namespaces"] = definitions.get("namespaces") or []
            result["aggregations"] = definitions.get("aggregations") or {}
            result["dimensions"] = definitions.get("dimensions") or {}
            diagnostics = result.get("diagnostics") or {}
            diagnostics.update({
                "requested_metrics": ask,
                "available_metrics": available,
                "skipped_metrics": [n for n in wanted if n.lower() not in available_set],
                # Kept apart from `status_code`, which is the metrics query.
                # Two requests are made per VM and a single status field cannot
                # say which of them is being described.
                "definitions_status": definitions.get("status_code"),
                "stage": "metrics",
            })
            result["diagnostics"] = diagnostics
            results[resource_id] = result

        await asyncio.gather(*(one(r) for r in resources), return_exceptions=True)

    return results
