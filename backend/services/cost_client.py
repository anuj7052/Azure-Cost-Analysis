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

# How many Cost Management queries may be in flight at once.
#
# This was 3, which was costing roughly two thirds of every cold dashboard
# load. Azure meters the Query API *per scope* — the quota that matters is
# "requests per minute against this subscription" — so nine queries aimed at
# nine different subscriptions are not competing with one another at all. A
# global gate of 3 turned a single wave into three sequential ones and made a
# ~20s read take ~70s.
#
# 10 keeps a ceiling on the damage a very large tenant can do in one burst
# while letting a normal estate resolve in a single wave. Requests that do get
# throttled are still retried, still honour Retry-After, and still fall back to
# cached data, so raising this trades a little more 429 risk for a large
# latency win rather than trading away correctness.
MAX_CONCURRENT_QUERIES = int(os.getenv("COST_MAX_CONCURRENT_QUERIES") or 10)
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
    """
    Return (from_date, to_date) covering the last N months *including* the
    current one, month-to-date.

    This used to end on the last day of the previous month, which meant the
    current month was never fetched at all. On the 24th of August, "last 6
    months" returned February through July: the tile labelled "Latest Month"
    showed July, the daily burn rate was computed from a month that had already
    finished, and there was no way to see what the estate had spent so far this
    month short of hand-typing a custom range.

    Excluding it was presumably meant to avoid comparing a part-month against
    whole ones. That is a real trap, but the honest fix is to label the partial
    month rather than to hide it — which the dashboard already does, it simply
    never had a partial month to label.
    """
    today = date.today()
    # Month-to-date. Azure has no data for the rest of the month yet, and
    # asking for it is harmless, but stopping at today keeps the cache key
    # stable within a day and makes the range self-describing.
    end = today
    # Count back from the *current* month, so months_back=6 on 24 Aug gives
    # 1 Mar - 24 Aug: five complete months plus the one in progress.
    start = date(today.year, today.month, 1) - relativedelta(months=months_back - 1)
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

# How long a whole multi-subscription read may take before we stop waiting and
# answer with what we have.
#
# This number exists to stay *under* the browser's own timeout. The client used
# to give up at 60s while this function could still be working, so the user saw
# "timeout of 60000ms exceeded" — an error with no subject, no cause and no
# suggested action, on a request that was often about to succeed. A server that
# always answers in time, even if the answer is "3 of 12 subscriptions were too
# slow", is strictly more useful than one that sometimes answers perfectly and
# sometimes not at all.
DEFAULT_GATHER_BUDGET = 100.0


async def gather_by_subscription(subscription_ids, fetch, budget: float = DEFAULT_GATHER_BUDGET):
    """
    Run `fetch(sub_id)` for every subscription, returning (records, errors).

    Subscriptions are read concurrently. They used to be read one after another,
    which is what made large accounts time out: a dozen subscriptions at four or
    five seconds each exceeded the browser's limit before Azure had done
    anything wrong. The HTTP layer already caps real parallelism at
    MAX_CONCURRENT_QUERIES, so fanning out here costs no extra rate-limit
    pressure — it just stops the slowest subscription from being charged for
    every subscription queued behind it.

    `budget` is a wall-clock ceiling for the whole operation. Whatever has not
    finished by then is reported as an error for that subscription rather than
    holding up the response. Partial data with a named gap beats no data.

    Subscriptions that fail only because Azure was throttling get a second
    chance once the cooldown expires, but only if the remaining budget actually
    covers the wait. Silently dropping them would understate every total on the
    page, which is far worse than a slower response.
    """
    deadline = time.monotonic() + budget
    records: List[Any] = []
    pending = list(subscription_ids)
    failed: List[tuple] = []

    async def read(sub_id):
        """Bound each subscription so one slow tenant cannot spend the whole budget."""
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("ran out of time before this subscription was read")
        return await asyncio.wait_for(fetch(sub_id), timeout=remaining)

    for attempt in range(2):
        failed = []
        results = await asyncio.gather(
            *(read(sub_id) for sub_id in pending), return_exceptions=True
        )
        for sub_id, result in zip(pending, results):
            if isinstance(result, BaseException):
                failed.append((sub_id, result))
            else:
                records.extend(result)

        if not failed or attempt == 1:
            break

        wait = _cooldown_remaining()
        # Only wait out a cooldown we can actually afford. Sleeping past the
        # deadline guarantees the timeout we are trying to avoid.
        if not 0 < wait <= MAX_THROTTLE_WAIT or time.monotonic() + wait >= deadline:
            break
        logger.info("Retrying %s throttled subscription(s) in %.0fs", len(failed), wait)
        await asyncio.sleep(wait + 1)
        pending = [s for s, _ in failed]

    errors = [error_entry(s, e) for s, e in failed]
    return records, errors


def friendly_error(exc: Exception) -> str:
    """Turn an httpx/Azure exception into something a user can act on."""
    if isinstance(exc, RateLimited):
        return (
            "Azure is rate limiting cost queries for this account. "
            f"This subscription will be read again automatically in about {exc.retry_in}s."
        )
    # asyncio.TimeoutError is an alias of TimeoutError on 3.11+, and both carry
    # an empty str(), which used to surface as a blank reason next to the
    # subscription name — the least useful message possible.
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, httpx.ReadTimeout, httpx.ConnectTimeout)):
        return (
            "Azure did not answer in time for this subscription. The other "
            "subscriptions below are complete. Narrow the date range or select "
            "fewer subscriptions, then refresh."
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


# How long to tell the client to wait when Azure throttled us but did not say
# for how long. Long enough that the retry is not simply throttled again.
DEFAULT_RETRY_AFTER = 30

# A floor under whatever Azure asked for. `RateLimited` clamps its own wait to a
# minimum of one second, and coming back after one second is how a retry becomes
# a second throttle -- the margin costs the reader four seconds and saves a
# round trip that was never going to succeed.
MIN_RETRY_AFTER = 5


def error_entry(
    subscription_id: str,
    exc: Exception,
    names: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    """
    A per-subscription failure the client can act on without reading English.

    The message alone was enough for a human and useless to the code: the page
    could tell somebody to wait four seconds and press Refresh, but could not
    press it itself. Saying *whether* a retry is worth making, and *when*, is
    what lets a throttled subscription fill itself in without the reader having
    to babysit the page.

    Only throttling and timeouts are marked retryable. A missing Cost
    Management Reader role will refuse identically for ever, and retrying it on
    a timer would be a spin loop dressed up as resilience.
    """
    retry_after = 0
    retryable = False

    if isinstance(exc, RateLimited):
        stated = int(getattr(exc, "retry_in", 0) or DEFAULT_RETRY_AFTER)
        retry_after = max(MIN_RETRY_AFTER, stated)
        retryable = True
    elif isinstance(exc, (asyncio.TimeoutError, TimeoutError, httpx.ReadTimeout, httpx.ConnectTimeout)):
        # A timeout is usually load, not a permanent condition, but it is also
        # not a promise from Azure about when it will be over -- hence a fixed
        # pause rather than a number invented to look precise.
        retry_after = DEFAULT_RETRY_AFTER
        retryable = True
    elif getattr(getattr(exc, "response", None), "status_code", None) == 429:
        retry_after = DEFAULT_RETRY_AFTER
        retryable = True

    return {
        "subscription_id": subscription_id,
        # A GUID is an identifier, not a name. Saying which subscription is
        # missing is the whole point of listing it, and "c604c07b-..." tells the
        # reader nothing they can act on. A miss falls back to the id rather
        # than inventing a name.
        "subscription_name": (names or {}).get(subscription_id, ""),
        "error": friendly_error(exc),
        "retryable": retryable,
        "retry_after_seconds": retry_after,
    }


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


async def query_daily_usage(
    token: str,
    subscription_id: str,
    from_date: str,
    to_date: str,
    filters: Dict[str, str] | None = None,
    group_by: List[str] | None = None,
    timeout: int = 90,
) -> List[Dict[str, Any]]:
    """
    One row per day for a narrowly filtered slice of usage.

    The monthly rows elsewhere answer "what did this cost"; only a daily series
    answers "when was it running". A month of 738 hours against a month of 720
    is a number nobody can act on — the same total spread as 24 hours every day,
    or 24 hours on twenty days and nothing on the rest, are completely different
    situations with completely different fixes.

    Filtered server-side rather than fetched and narrowed here. A daily,
    unfiltered query over a large subscription returns tens of thousands of rows
    to answer a question about one meter, and Cost Management throttles hard
    enough that the waste is felt.
    """
    scope = f"/subscriptions/{subscription_id}"
    url = f"{MGMT_BASE}{scope}/providers/Microsoft.CostManagement/query?api-version={COST_API_VERSION}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    clauses = [
        {"dimensions": {"name": name, "operator": "In", "values": [value]}}
        for name, value in (filters or {}).items()
        if value
    ]

    dataset: Dict[str, Any] = {
        "granularity": "Daily",
        "aggregation": {
            "totalCost": {"name": "PreTaxCost", "function": "Sum"},
            "usageQuantity": {"name": "UsageQuantity", "function": "Sum"},
        },
        "grouping": [
            {"type": "Dimension", "name": dim}
            for dim in (group_by or ["ServiceName", "Meter"])
        ],
    }
    if clauses:
        # Cost Management rejects a one-element "and", so a single filter is
        # passed on its own.
        dataset["filter"] = clauses[0] if len(clauses) == 1 else {"and": clauses}

    api_from, api_to = _explicit_date_range(from_date, to_date)
    body = {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {"from": api_from, "to": api_to},
        "dataset": dataset,
    }

    records: List[Dict[str, Any]] = []
    for page in await _run_paged_query(url, headers, body, timeout=timeout):
        for rec in _columnar_to_records(page):
            rec["SubscriptionId"] = rec.get("SubscriptionId") or subscription_id
            records.append(rec)

    return records


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
            # `properties` is the provider's own configuration bag, and it is
            # the only place a change like "public network access was turned
            # on" or "TLS was downgraded" can be seen. Projecting it makes the
            # snapshot large, which is the price of being able to answer what
            # actually changed instead of only that something did.
            "| project id, name, type, resourceGroup, subscriptionId, location, tags, "
            "          skuName, skuTier, skuSize, vmSize, diskGb, diskTier, properties "
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
