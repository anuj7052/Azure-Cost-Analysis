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
import os
import random
import tempfile
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
# A short cooldown is worth waiting out. Failing fast turns a two-second delay
# into a "2 subscriptions could not be read" banner and wrong totals, which is
# far worse for the user than a slightly slower page.
MAX_COOLDOWN_WAIT = 20.0
CACHE_TTL_SECONDS = 600
# Stale entries stay usable for a day so a throttled cold start still renders
# yesterday's numbers instead of an empty dashboard.
STALE_TTL_SECONDS = 24 * 60 * 60
CACHE_FILE = os.path.join(
    os.getenv("COST_CACHE_DIR") or tempfile.gettempdir(), "aca-cost-cache.json"
)

_query_gate = asyncio.Semaphore(MAX_CONCURRENT_QUERIES)
_cache: Dict[str, tuple[float, Any]] = {}
# Identical queries issued at the same moment (several pages mounting at once)
# share a single Azure call instead of each burning a rate-limit token.
_inflight: Dict[str, asyncio.Future] = {}

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


def cooldown_remaining() -> float:
    """Seconds until Azure will accept cost queries again (0 when not throttled)."""
    return _cooldown_remaining()


def _start_cooldown(seconds: float) -> None:
    global _throttled_until
    _throttled_until = max(_throttled_until, time.time() + seconds)


def _load_cache() -> None:
    """
    Restore the cache from disk. The dev server restarts on every code change and
    a cold, empty cache during a throttling window leaves the dashboard blank —
    persisting it means restarts no longer cost the user their data.
    """
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as fh:
            saved = json.load(fh)
    except (OSError, ValueError):
        return
    cutoff = time.time() - STALE_TTL_SECONDS
    for key, entry in (saved or {}).items():
        try:
            expires_at, stored_at, value = entry
        except (TypeError, ValueError):
            continue
        if stored_at >= cutoff:
            _cache[key] = (expires_at, value)


def _save_cache() -> None:
    try:
        now = time.time()
        payload = {k: [exp, now, val] for k, (exp, val) in _cache.items()}
        # Write via a temp file so a crash mid-write cannot corrupt the cache.
        directory = os.path.dirname(CACHE_FILE) or "."
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=directory, delete=False
        ) as fh:
            json.dump(payload, fh)
            tmp = fh.name
        os.replace(tmp, CACHE_FILE)
    except (OSError, TypeError, ValueError) as exc:
        logger.debug("Could not persist cost cache: %s", exc)


def _cache_key(url: str, body: dict) -> str:
    raw = url + json.dumps(body, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _cache_get(key: str):
    hit = _cache.get(key)
    if not hit:
        return None
    expires_at, value = hit
    if expires_at < time.time():
        return None
    return value


def _cache_get_stale(key: str):
    """Return a cached value even if expired - used as a throttling fallback."""
    hit = _cache.get(key)
    return hit[1] if hit else None


def _cache_put(key: str, value: Any) -> None:
    _cache[key] = (time.time() + CACHE_TTL_SECONDS, value)
    if len(_cache) > 500:  # keep the cache from growing unbounded
        # Only drop entries too old to serve as a throttling fallback; expired
        # but recent ones are exactly what rescues a blank dashboard.
        cutoff = time.time() - STALE_TTL_SECONDS + CACHE_TTL_SECONDS
        for k, (exp, _) in list(_cache.items()):
            if exp < cutoff:
                _cache.pop(k, None)
    _save_cache()


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
        if cooldown > MAX_COOLDOWN_WAIT:
            # Too long to hold the request open; let the caller fall back to
            # cached data and tell the user when to retry.
            raise RateLimited(cooldown)
        logger.info("Waiting out %.1fs cost API cooldown", cooldown)
        await asyncio.sleep(cooldown)

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

    # Several pages mounting at once ask for the same data. Let the first caller
    # do the work and have the rest await it, instead of firing duplicate
    # queries that only serve to trigger throttling.
    existing = _inflight.get(key)
    if existing is not None:
        return await asyncio.shield(existing)

    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    _inflight[key] = future
    try:
        pages = await _fetch_pages(url, headers, body, timeout, key)
    except BaseException as exc:
        if not future.done():
            future.set_exception(exc)
        # Nobody may be awaiting this future; stop asyncio warning about it.
        future.exception()
        raise
    else:
        if not future.done():
            future.set_result(pages)
        return pages
    finally:
        _inflight.pop(key, None)


async def _fetch_pages(url: str, headers: dict, body: dict, timeout: int, key: str) -> List[dict]:
    pages: List[dict] = []
    next_url = url
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            while next_url:
                data = await _post_query(client, next_url, headers, body)
                pages.append(data)
                next_url = data.get("properties", {}).get("nextLink")
    except Exception:
        # Throttling, a transport blip or an Azure 5xx should never blank the
        # dashboard when we still hold a recent answer.
        stale = _cache_get_stale(key)
        if stale is not None:
            logger.warning("Serving stale cached cost data (Azure unavailable or throttling)")
            return stale
        raise

    _cache_put(key, pages)
    return pages


# Warm the in-memory cache from the last run so restarts don't blank the UI.
_load_cache()


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


MAX_THROTTLE_WAIT = 45.0


async def gather_by_subscription(subscription_ids, fetch):
    """
    Run `fetch(sub_id)` for every subscription, returning (records, errors).

    Subscriptions that fail only because Azure was throttling get a second
    chance once the cooldown expires. Silently dropping them would understate
    every total on the page, which is far worse than a slower response.
    """
    records: List[Any] = []
    pending = list(subscription_ids)
    failed: List[tuple] = []

    for attempt in range(2):
        failed = []
        for sub_id in pending:
            try:
                records.extend(await fetch(sub_id))
            except Exception as exc:
                failed.append((sub_id, exc))

        if not failed or attempt == 1:
            break

        wait = _cooldown_remaining()
        if not 0 < wait <= MAX_THROTTLE_WAIT:
            break
        logger.info("Retrying %s throttled subscription(s) in %.0fs", len(failed), wait)
        await asyncio.sleep(wait + 1)
        pending = [s for s, _ in failed]

    errors = [{"subscription_id": s, "error": friendly_error(e)} for s, e in failed]
    return records, errors


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
            # Size lives in a different place for every provider: an object on
            # `sku` for most, but inside `properties` for VMs, disks and web
            # apps. Pulling all of them here means the table shows a real size
            # instead of a dash for the resources people care about most.
            "| extend skuName = tostring(sku.name), "
            "         skuTier = tostring(sku.tier), "
            "         skuSize = tostring(sku.size), "
            "         vmSize = tostring(properties.hardwareProfile.vmSize), "
            "         diskGb = tostring(properties.diskSizeGB), "
            "         diskTier = tostring(properties.tier) "
            "| project id, name, type, resourceGroup, subscriptionId, location, tags, "
            "          skuName, skuTier, skuSize, vmSize, diskGb, diskTier "
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
