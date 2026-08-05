"""
Azure Cost Management API client.
Handles the POST query endpoint, pagination, and columnar→dict normalization.

The Cost Management query API is aggressively rate limited (a handful of calls
per subscription per minute).  Fanning out across a dozen subscriptions from
several pages at once trips HTTP 429 almost immediately, so every request goes
through a shared concurrency gate, an automatic retry/backoff loop that honours
the `Retry-After` header, and a short-lived response cache.
"""
import asyncio
import hashlib
import json
import logging
import random
import time
import httpx
from datetime import datetime, date
from dateutil.relativedelta import relativedelta
from typing import List, Dict, Any


MGMT_BASE = "https://management.azure.com"
COST_API_VERSION = "2023-11-01"

logger = logging.getLogger(__name__)

# Azure allows very few concurrent Cost Management queries before throttling.
MAX_CONCURRENT_QUERIES = 3
MAX_RETRIES = 3
MAX_RETRY_DELAY = 15.0
CACHE_TTL_SECONDS = 600

_query_gate = asyncio.Semaphore(MAX_CONCURRENT_QUERIES)
_cache: Dict[str, tuple[float, Any]] = {}

# When Azure throttles us, every caller backs off until this moment instead of
# queueing up more doomed requests (which is what makes the whole app hang).
_throttled_until: float = 0.0


class RateLimited(RuntimeError):
    """Raised when Azure is actively throttling this tenant."""

    def __init__(self, retry_in: float):
        self.retry_in = max(1, int(retry_in))
        super().__init__(
            f"Azure Cost Management is rate limiting this account. Retry in ~{self.retry_in}s."
        )


def _cooldown_remaining() -> float:
    return max(0.0, _throttled_until - time.time())


def _start_cooldown(seconds: float) -> None:
    global _throttled_until
    _throttled_until = max(_throttled_until, time.time() + seconds)


def _cache_key(url: str, body: dict) -> str:
    raw = url + json.dumps(body, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _cache_get(key: str):
    hit = _cache.get(key)
    if not hit:
        return None
    expires_at, value = hit
    if expires_at < time.time():
        _cache.pop(key, None)
        return None
    return value


def _cache_get_stale(key: str):
    """Return a cached value even if expired - used as a throttling fallback."""
    hit = _cache.get(key)
    return hit[1] if hit else None


def _cache_put(key: str, value: Any) -> None:
    _cache[key] = (time.time() + CACHE_TTL_SECONDS, value)
    if len(_cache) > 500:  # keep the cache from growing unbounded
        now = time.time()
        for k, (exp, _) in list(_cache.items()):
            if exp < now:
                _cache.pop(k, None)


def _retry_delay(resp: httpx.Response | None, attempt: int) -> float:
    """Prefer the server's Retry-After hint, otherwise exponential backoff."""
    if resp is not None:
        for header in ("Retry-After", "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after"):
            value = resp.headers.get(header)
            if value:
                try:
                    return min(float(value), MAX_RETRY_DELAY)
                except ValueError:
                    pass
    return min(2 ** attempt, MAX_RETRY_DELAY) + random.uniform(0, 1)


async def _post_query(client: httpx.AsyncClient, url: str, headers: dict, body: dict) -> dict:
    """POST a Cost Management query, retrying through throttling responses."""
    cooldown = _cooldown_remaining()
    if cooldown:
        # Fail fast rather than adding to a queue Azure is already refusing.
        raise RateLimited(cooldown)

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        async with _query_gate:
            try:
                resp = await client.post(url, headers=headers, json=body)
            except httpx.TransportError as exc:      # transient network blip
                last_error = exc
                resp = None
            else:
                if resp.status_code < 400:
                    return resp.json()
                if resp.status_code not in (429, 500, 502, 503, 504):
                    resp.raise_for_status()
                last_error = httpx.HTTPStatusError(
                    f"Azure returned {resp.status_code}", request=resp.request, response=resp
                )
        delay = _retry_delay(resp, attempt)
        if resp is not None and resp.status_code == 429:
            _start_cooldown(delay)
        if attempt == MAX_RETRIES - 1:
            break
        logger.warning("Cost Management throttled (attempt %s), retrying in %.1fs", attempt + 1, delay)
        await asyncio.sleep(delay)

    if _cooldown_remaining():
        raise RateLimited(_cooldown_remaining())
    raise last_error or RuntimeError("Cost Management query failed")


async def _run_paged_query(url: str, headers: dict, body: dict, timeout: int) -> List[dict]:
    """Execute a (possibly paged) query, using the cache when still warm."""
    key = _cache_key(url, body)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    pages: List[dict] = []
    next_url = url
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            while next_url:
                data = await _post_query(client, next_url, headers, body)
                pages.append(data)
                next_url = data.get("properties", {}).get("nextLink")
    except RateLimited:
        stale = _cache_get_stale(key)
        if stale is not None:
            logger.warning("Serving stale cached cost data while Azure is throttling")
            return stale
        raise

    _cache_put(key, pages)
    return pages


def _build_date_range(months_back: int = 6) -> tuple[str, str]:
    """Return (from_date, to_date) strings for the last N complete months."""
    today = date.today()
    # End of previous month
    end = date(today.year, today.month, 1) - relativedelta(days=1)
    # Start of N months before that
    start = date(end.year, end.month, 1) - relativedelta(months=months_back - 1)
    return start.strftime("%Y-%m-%dT00:00:00Z"), end.strftime("%Y-%m-%dT23:59:59Z")


def _explicit_date_range(from_date: str, to_date: str) -> tuple[str, str]:
    """Convert YYYY-MM-DD strings to Azure API ISO datetime strings."""
    from datetime import datetime
    start = datetime.strptime(from_date, "%Y-%m-%d")
    end   = datetime.strptime(to_date,   "%Y-%m-%d")
    return start.strftime("%Y-%m-%dT00:00:00Z"), end.strftime("%Y-%m-%dT23:59:59Z")


def _columnar_to_records(response_data: dict) -> List[Dict[str, Any]]:
    """Convert Azure Cost API columnar response to list of dicts."""
    props = response_data.get("properties", {})
    columns = [c["name"] for c in props.get("columns", [])]
    rows = props.get("rows", [])
    return [dict(zip(columns, row)) for row in rows]


def friendly_error(exc: Exception) -> str:
    """Turn an httpx/Azure exception into something a user can act on."""
    if isinstance(exc, RateLimited):
        return (
            "Azure is rate limiting cost queries for this account. "
            f"Wait about {exc.retry_in}s and hit Refresh — or select fewer subscriptions."
        )
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status == 429:
        return "Azure rate limit reached (429) — too many cost queries in a short window. Wait a minute and refresh."
    if status in (401, 403):
        return "Access denied — the app registration needs the Cost Management Reader role on this subscription."
    if status == 404:
        return "Subscription not found, or Cost Management is not enabled for it."
    if status:
        return f"Azure returned HTTP {status}."
    return str(exc) or exc.__class__.__name__


def summarise_errors(errors: List[dict], what: str = "cost data") -> str:
    """One readable sentence instead of a raw list of stack-trace strings."""
    reasons = {e.get("error", "") for e in errors}
    prefix = f"Could not load {what} for {len(errors)} subscription(s)."
    if len(reasons) == 1:
        return f"{prefix} {reasons.pop()}"
    return prefix + " " + " ".join(sorted(reasons))


async def query_costs(
    token: str,
    subscription_id: str,
    months: int = 6,
    group_by: List[str] | None = None,
    granularity: str = "Monthly",
    from_date: str | None = None,
    to_date: str | None = None,
) -> List[Dict[str, Any]]:
    """
    Query Cost Management for a subscription over the last N months.
    Returns a flat list of records with columns as keys.
    """
    if group_by is None:
        group_by = ["ServiceName", "SubscriptionId"]

    if from_date and to_date:
        api_from, api_to = _explicit_date_range(from_date, to_date)
    else:
        api_from, api_to = _build_date_range(months)

    scope = f"/subscriptions/{subscription_id}"
    url = f"{MGMT_BASE}{scope}/providers/Microsoft.CostManagement/query?api-version={COST_API_VERSION}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {"from": api_from, "to": api_to},
        "dataset": {
            "granularity": granularity,
            "aggregation": {
                "totalCost": {"name": "PreTaxCost", "function": "Sum"}
            },
            "grouping": [
                {"type": "Dimension", "name": dim} for dim in group_by
            ],
        },
    }

    all_records: List[Dict[str, Any]] = []
    for page in await _run_paged_query(url, headers, body, timeout=60):
        all_records.extend(_columnar_to_records(page))

    return all_records


async def query_usage(
    token: str,
    subscription_id: str,
    months: int = 6,
    group_by: List[str] | None = None,
    granularity: str = "Monthly",
    from_date: str | None = None,
    to_date: str | None = None,
) -> List[Dict[str, Any]]:
    """
    Same as `query_costs` but also aggregates UsageQuantity, so callers can
    reason about consumed units (GB / TB of data transfer, hours, etc.).
    """
    if group_by is None:
        group_by = ["MeterCategory", "MeterSubcategory", "Meter"]

    if from_date and to_date:
        api_from, api_to = _explicit_date_range(from_date, to_date)
    else:
        api_from, api_to = _build_date_range(months)

    scope = f"/subscriptions/{subscription_id}"
    url = f"{MGMT_BASE}{scope}/providers/Microsoft.CostManagement/query?api-version={COST_API_VERSION}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {"from": api_from, "to": api_to},
        "dataset": {
            "granularity": granularity,
            "aggregation": {
                "totalCost": {"name": "PreTaxCost", "function": "Sum"},
                "usageQuantity": {"name": "UsageQuantity", "function": "Sum"},
            },
            "grouping": [{"type": "Dimension", "name": dim} for dim in group_by],
        },
    }

    all_records: List[Dict[str, Any]] = []
    for page in await _run_paged_query(url, headers, body, timeout=90):
        for rec in _columnar_to_records(page):
            rec["SubscriptionId"] = rec.get("SubscriptionId") or subscription_id
            all_records.append(rec)

    return all_records


async def query_active_resources(
    token: str,
    subscription_ids: List[str],
) -> List[Dict[str, Any]]:
    """
    Use Azure Resource Graph to list all active resources across subscriptions.
    """
    url = f"{MGMT_BASE}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {
        "subscriptions": subscription_ids,
        "query": (
            "Resources "
            "| where type != 'microsoft.resources/subscriptions/resourcegroups' "
            "| project name, type, resourceGroup, subscriptionId, location, tags "
            "| order by type asc"
        ),
        "options": {"$top": 1000},
    }

    results = []
    skip_token = None
    async with httpx.AsyncClient(timeout=60) as client:
        while True:
            if skip_token:
                body["options"]["$skipToken"] = skip_token
            resp = await client.post(url, headers=headers, json=body)
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("data", []))
            skip_token = data.get("$skipToken")
            if not skip_token:
                break

    return results
