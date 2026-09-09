"""
Azure Cost Management API client.
Handles the POST query endpoint, pagination, and columnar→dict normalization.

The Cost Management query API is aggressively rate limited (a handful of calls
per subscription per minute).  Fanning out across a dozen subscriptions from
several pages at once trips HTTP 429 almost immediately, so every request goes
through a shared concurrency gate, an automatic retry/backoff loop that honours
the `Retry-After` header, and a two-level response cache.

The cache is two levels because the two problems are different. In-process
memory answers the same question asked twice in one page load. The table behind
`cost_cache` answers it across restarts, deploys and instances, and knows the
difference between a period Azure has finished with and one still moving -- see
that module for why that distinction is where most of the saving comes from.
"""
import asyncio
import hashlib
import json
import logging
import os
import random
import re
import time
import httpx
from datetime import datetime, date
from dateutil.relativedelta import relativedelta
from typing import List, Dict, Any

from services import cost_cache


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
# 10 was still the binding constraint in the case people actually complain
# about: many subscriptions selected at once. Twelve subscriptions asking three
# questions each want 36 slots, so a global 10 re-imposed exactly the sequential
# waves this constant was raised to remove -- and it did so tenant-wide, where
# the quota is not.
#
# 24 is a burst ceiling, not a quota. The per-scope gate and the per-scope
# pacing below are what keep us inside Azure's actual limit; this only exists so
# a hundred-subscription estate cannot open a hundred sockets in one instant.
# Throttled requests are still retried, still honour Retry-After, and still fall
# back to cached data, so this trades a little more 429 risk for a large latency
# win rather than trading away correctness.
MAX_CONCURRENT_QUERIES = int(os.getenv("COST_MAX_CONCURRENT_QUERIES") or 24)
MAX_RETRIES = 3
MAX_RETRY_DELAY = 15.0
# A short cooldown is worth waiting out. Failing fast turns a two-second delay
# into a "2 subscriptions could not be read" banner and wrong totals, which is
# far worse for the user than a slightly slower page.
MAX_COOLDOWN_WAIT = 20.0
# The in-memory tier only has to survive one page load; the durable tier decides
# how long an answer really lives, and does it per period rather than by one
# flat number. Kept in step with it so the two cannot disagree about freshness.
CACHE_TTL_SECONDS = cost_cache.OPEN_TTL_SECONDS
# Stale entries stay usable so a throttled cold start still renders real numbers
# instead of an empty dashboard.
STALE_TTL_SECONDS = cost_cache.STALE_TTL_SECONDS

_query_gate = asyncio.Semaphore(MAX_CONCURRENT_QUERIES)
_cache: Dict[str, tuple[float, Any]] = {}
# Identical queries issued at the same moment (several pages mounting at once)
# share a single Azure call instead of each burning a rate-limit token.
_inflight: Dict[str, asyncio.Future] = {}

# When Azure throttles us, callers for *that scope* back off until this moment
# instead of queueing up more doomed requests (which is what makes the whole
# app hang).
#
# Keyed by scope, because Azure meters the Query API per scope. One tenant-wide
# cooldown meant a single busy subscription put every other subscription to
# sleep for 15 seconds it had done nothing to earn -- and since all the sleepers
# woke together and fired together, the cooldown was renewed before it ever
# expired. A newly added subscription could then never land a first successful
# read, so refreshing the page returned the same rate-limit message forever.
_throttled_until: Dict[str, float] = {}

# A few in-flight cost queries per scope.
#
# The global gate above limits how many cost queries run at once across the
# tenant; this limits how many run at once against a single subscription. It
# used to be one, chosen when the allowance was six a minute: at that rate five
# simultaneous questions to one subscription were not five answers, they were
# one answer and four 429s, which is why cost columns came back blank while the
# resource list beside them was complete.
#
# One is too strict now that the allowance is Azure's real figure rather than a
# fifth of it. A Cost Management query takes seconds, and a page that asks four
# of them was waiting the sum of four round trips when nothing was throttling
# it -- most of the "still loading" on the dashboard, BOQ and comparison pages
# was this queue, not Azure.
#
# Three, not unlimited. The pacing below decides *how often* we may ask; this
# decides how bursty a single moment is allowed to be, and a burst is what
# actually earns a 429. Three is small enough that a page's questions overlap
# without arriving as a spike, and the adaptive allowance still halves if that
# turns out to be wrong for an account.
SCOPE_CONCURRENCY = int(os.getenv("COST_SCOPE_CONCURRENCY") or 3)

_scope_gates: Dict[str, asyncio.Semaphore] = {}


def _scope_gate(scope: str) -> asyncio.Semaphore:
    gate = _scope_gates.get(scope)
    if gate is None:
        gate = asyncio.Semaphore(SCOPE_CONCURRENCY)
        _scope_gates[scope] = gate
    return gate


# ── Pacing ────────────────────────────────────────────────────────────────
#
# Everything above this point reacts to being throttled. Reacting is not
# enough: by the time a 429 arrives the request is already spent, the retry
# costs another one, and a scope that is being asked more often than Azure
# allows never escapes -- every wave of retries lands as the next wave of
# requests, so the account stays in the penalty box and cost columns stay
# blank however patiently we back off.
#
# So we pace instead. Each scope gets an allowance of queries per minute and
# waits its turn before sending, which means the limit is respected rather
# than discovered. Azure does not publish the exact figure and it varies by
# agreement, so the allowance is learned: it halves whenever a 429 gets
# through and creeps back up as queries succeed. An estate that is never
# throttled converges on the ceiling; one that is, settles just under
# whatever its real limit turns out to be.
#
# The ceiling is a starting guess, and it used to be six. That was five times
# stricter than the figure Microsoft documents for the Query API, and because
# the allowance can only ever creep *up to* the ceiling, six was not a cautious
# opening bid -- it was the permanent limit. A dashboard visit alone spends
# most of six queries per subscription, so the next page to ask anything waited
# out a full minute for a turn that Azure would have granted immediately. That
# minute was ours, not Azure's: nothing had been throttled and nothing had
# refused us.
#
# Thirty is what Microsoft states for Microsoft.CostManagement query calls per
# scope per minute. Opening there is safe precisely because the mechanism below
# is adaptive: the first genuine 429 halves it, and keeps halving, so an
# account whose real allowance is lower finds its own level within a couple of
# refusals instead of every account paying for that possibility forever.
SCOPE_RATE_PER_MINUTE = float(os.getenv("COST_SCOPE_QUERIES_PER_MINUTE") or 30)
MIN_SCOPE_RATE = 1.0
# Longer than MAX_COOLDOWN_WAIT: pacing is the normal, healthy path, so it is
# worth waiting a little longer for a turn than for a punishment to expire.
MAX_PACE_WAIT = 25.0
# ...unless there is nothing to fall back on. Refusing early is only kind when
# the caller has a cached answer to show instead; with an empty cache the same
# refusal produces a banner where a number should be, and the reader is asked
# to wait anyway - just without the page ever finishing on its own. A cold
# query is therefore allowed to sit in the queue for as long as its turn takes,
# up to the point where an HTTP client would give up regardless.
MAX_PATIENT_WAIT = 90.0

_scope_sent: Dict[str, List[float]] = {}
_scope_rate: Dict[str, float] = {}


def _rate_of(scope: str) -> float:
    return _scope_rate.get(scope, SCOPE_RATE_PER_MINUTE)


def _pace_wait(scope: str) -> float:
    """Seconds to wait before this scope may send another query."""
    now = time.time()
    window = [t for t in _scope_sent.get(scope, []) if now - t < 60.0]
    _scope_sent[scope] = window

    allowance = _rate_of(scope)
    if len(window) < allowance:
        return 0.0
    # The oldest query in the window has to age out before there is room.
    return max(0.0, 60.0 - (now - window[0]))


def _record_send(scope: str) -> None:
    _scope_sent.setdefault(scope, []).append(time.time())


def _penalise(scope: str) -> None:
    """A 429 got through, so the allowance was too generous. Halve it."""
    reduced = max(MIN_SCOPE_RATE, _rate_of(scope) / 2)
    if reduced != _rate_of(scope):
        logger.info(
            "Cost query allowance for %s reduced to %.1f/min after throttling", scope, reduced,
        )
    _scope_rate[scope] = reduced


def _reward(scope: str) -> None:
    """A query succeeded, so edge the allowance back towards the ceiling."""
    current = _rate_of(scope)
    if current < SCOPE_RATE_PER_MINUTE:
        _scope_rate[scope] = min(SCOPE_RATE_PER_MINUTE, current + 0.5)


def _scope_of(url: str) -> str:
    """The billing scope a query is aimed at - what Azure actually meters."""
    match = re.search(r"/subscriptions/([^/?]+)", url)
    return match.group(1) if match else "tenant"


class RateLimited(RuntimeError):
    """
    Raised when a cost query cannot be sent yet.

    `paced` separates the two reasons, because they are not the same event and
    should never be reported as one. Azure refusing us is Azure's decision;
    our own queue holding a request back is ours, and telling a user that
    Azure is rate limiting them when Azure has said nothing of the kind sends
    them looking for a quota problem that does not exist.
    """

    def __init__(self, retry_in: float, paced: bool = False):
        self.retry_in = max(1, int(retry_in))
        self.paced = paced
        reason = (
            "Too many cost queries are already queued for this subscription."
            if paced else
            "Azure Cost Management is rate limiting this account."
        )
        super().__init__(f"{reason} Retry in ~{self.retry_in}s.")


def _cooldown_remaining(scope: str = "") -> float:
    now = time.time()
    if scope:
        return max(0.0, _throttled_until.get(scope, 0.0) - now)
    # No scope named: the longest wait anyone is currently serving.
    return max((v - now for v in _throttled_until.values()), default=0.0)


def cooldown_remaining() -> float:
    """Seconds until Azure will accept cost queries again (0 when not throttled)."""
    return _cooldown_remaining()


def _start_cooldown(scope: str, seconds: float) -> None:
    _throttled_until[scope] = max(_throttled_until.get(scope, 0.0), time.time() + seconds)


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


def _cache_put(key: str, value: Any, ttl: float = CACHE_TTL_SECONDS) -> None:
    _cache[key] = (time.time() + ttl, value)
    if len(_cache) > 500:  # keep the cache from growing unbounded
        # Only drop entries too old to serve as a throttling fallback; expired
        # but recent ones are exactly what rescues a blank dashboard.
        cutoff = time.time() - STALE_TTL_SECONDS + CACHE_TTL_SECONDS
        for k, (exp, _) in list(_cache.items()):
            if exp < cutoff:
                _cache.pop(k, None)


def _retry_delay(resp: httpx.Response | None, attempt: int) -> float:
    """Prefer the server's Retry-After hint, otherwise exponential backoff."""
    if resp is not None:
        for header in ("Retry-After", "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after"):
            value = resp.headers.get(header)
            if value:
                try:
                    # Azure sometimes answers a 429 with Retry-After: 0, which
                    # taken literally means "try again immediately" and is how a
                    # retry becomes another 429. A second is the floor.
                    return min(max(float(value), 1.0), MAX_RETRY_DELAY)
                except ValueError:
                    pass
    return min(2 ** attempt, MAX_RETRY_DELAY) + random.uniform(0, 1)


async def _post_query(
    client: httpx.AsyncClient, url: str, headers: dict, body: dict, patient: bool = False,
) -> dict:
    """POST a Cost Management query, retrying through throttling responses."""
    scope = _scope_of(url)
    async with _scope_gate(scope):
        return await _post_query_serial(client, url, headers, body, scope, patient)


async def _post_query_serial(
    client: httpx.AsyncClient, url: str, headers: dict, body: dict, scope: str,
    patient: bool = False,
) -> dict:
    """The query itself, with this scope's turn already taken."""
    pace_limit = MAX_PATIENT_WAIT if patient else MAX_PACE_WAIT
    cooldown = _cooldown_remaining(scope)
    if cooldown:
        if cooldown > (MAX_PATIENT_WAIT if patient else MAX_COOLDOWN_WAIT):
            # Too long to hold the request open; let the caller fall back to
            # cached data and tell the user when to retry.
            raise RateLimited(cooldown)
        # Wake at slightly different moments. Every waiter sleeping for exactly
        # the same duration means they all fire in the same millisecond, which
        # is how a cooldown renews itself indefinitely.
        logger.info("Waiting out %.1fs cost API cooldown", cooldown)
        await asyncio.sleep(cooldown + random.uniform(0, 1.5))

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        # Wait for this scope's turn before spending a request. Doing this
        # inside the retry loop matters: a retry is another query against the
        # same allowance, and retrying without pacing is what turns one 429
        # into a run of them.
        pause = _pace_wait(scope)
        if pause:
            if pause > pace_limit:
                raise RateLimited(pause, paced=True)
            logger.info("Pacing cost query for %s: waiting %.1fs for its turn", scope, pause)
            await asyncio.sleep(pause + random.uniform(0, 0.5))

        async with _query_gate:
            _record_send(scope)
            try:
                resp = await client.post(url, headers=headers, json=body)
            except httpx.TransportError as exc:      # transient network blip
                last_error = exc
                resp = None
            else:
                if resp.status_code < 400:
                    _reward(scope)
                    return resp.json()
                if resp.status_code not in (429, 500, 502, 503, 504):
                    resp.raise_for_status()
                last_error = httpx.HTTPStatusError(
                    f"Azure returned {resp.status_code}", request=resp.request, response=resp
                )
        delay = _retry_delay(resp, attempt)
        if resp is not None and resp.status_code == 429:
            _penalise(scope)
            _start_cooldown(scope, delay)
        if attempt == MAX_RETRIES - 1:
            break
        logger.warning("Cost Management throttled (attempt %s), retrying in %.1fs", attempt + 1, delay)
        await asyncio.sleep(delay)

    if _cooldown_remaining(scope):
        raise RateLimited(_cooldown_remaining(scope))
    raise last_error or RuntimeError("Cost Management query failed")


async def _run_paged_query(url: str, headers: dict, body: dict, timeout: int) -> List[dict]:
    """Execute a (possibly paged) query, using the cache when still warm."""
    key = _cache_key(url, body)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    # Nothing in this process, but this process is not the only one that has
    # ever asked. A restart, a deploy or a second instance all arrive here with
    # an empty dictionary and a database that already holds the answer.
    stored = await cost_cache.load(key)
    if stored is not None:
        payload, fresh = stored
        if fresh:
            _cache_put(key, payload, cost_cache.ttl_for(body))
            return payload

        # Not fresh, but this scope is currently being punished. Queueing
        # behind a cooldown only to re-ask a question we already have a recent
        # answer to spends a request we cannot spare and delays the page for
        # nothing. A number from a few minutes ago beats a blank column, and
        # the next unthrottled load will refresh it.
        #
        # Only a cooldown, not ordinary pacing: waiting a few seconds for a
        # turn is the healthy path, and skipping the refetch every time the
        # queue is busy would quietly turn durability into staleness.
        scope = _scope_of(url)
        if _cooldown_remaining(scope):
            logger.info("Serving recent cached cost data for %s rather than queue", scope)
            _cache_put(key, payload, cost_cache.ttl_for(body))
            return payload

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
        # Nothing cached anywhere, so a refusal here leaves the caller with no
        # answer at all. Wait for the turn instead of failing fast.
        pages = await _fetch_pages(url, headers, body, timeout, key, patient=stored is None)
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


async def _fetch_pages(
    url: str, headers: dict, body: dict, timeout: int, key: str, patient: bool = False,
) -> List[dict]:
    pages: List[dict] = []
    next_url = url
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            while next_url:
                data = await _post_query(client, next_url, headers, body, patient)
                pages.append(data)
                next_url = data.get("properties", {}).get("nextLink")
    except Exception:
        # Throttling, a transport blip or an Azure 5xx should never blank the
        # dashboard when we still hold a recent answer. Memory first because it
        # is free, then the durable copy, which is the one that survives the
        # restart that a throttling incident so often triggers.
        stale = _cache_get_stale(key)
        if stale is None:
            stored = await cost_cache.load(key)
            stale = stored[0] if stored else None
        if stale is not None:
            logger.warning("Serving stale cached cost data (Azure unavailable or throttling)")
            return stale
        raise

    _cache_put(key, pages, cost_cache.ttl_for(body))
    await cost_cache.store(key, pages, url=url, body=body)
    return pages


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


def _parse_api_date(text: str) -> date | None:
    """The calendar day an Azure period boundary falls on, or None if unreadable."""
    head = str(text or "").strip()[:10]
    try:
        return datetime.strptime(head, "%Y-%m-%d").date()
    except ValueError:
        return None


def month_segments(api_from: str, api_to: str, today: date | None = None) -> List[tuple[str, str]]:
    """
    Break a monthly range into one segment per finished month, plus the live tail.

    Selecting more months used to cost more *every single time*, because the
    range was asked as one query and one query is one cache entry. A six-month
    range ends today, today is not settled, so the whole six months expired
    after thirty minutes and all of it was downloaded again -- five months of
    history that Azure had finished amending and would never change. Worse,
    changing the selection from three months to six was a total miss: a
    different range is a different key, so the three months already held were
    re-fetched alongside the three new ones.

    Asked per month, a finished month is its own entry with its own thirty-day
    life. Widening the selection then fetches only the months that were not
    already asked for, and a revisit fetches only the month still in progress.

    The tail is deliberately left whole rather than split further: those months
    are still moving, so splitting them would buy no cache life and only spend
    more requests.

    A month counts as finished only once its last day is older than the cache's
    settling window, so the boundary is conservative -- early in a month, the
    month just gone is still treated as live.

    Only valid for Monthly granularity. Azure aggregates within the period it is
    given, so a query bounded to one calendar month returns that month's total
    unchanged; the same is not true of a range cut at an arbitrary day.
    """
    start = _parse_api_date(api_from)
    end = _parse_api_date(api_to)
    if start is None or end is None or start > end:
        return [(api_from, api_to)]

    today = today or date.today()
    cutoff = today - relativedelta(days=cost_cache.SETTLING_DAYS)

    settled: List[tuple[str, str]] = []
    tail_start: date | None = None
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        month_from = max(cursor, start)
        month_to = min(cursor + relativedelta(months=1) - relativedelta(days=1), end)
        if tail_start is None and month_to < cutoff:
            settled.append((
                month_from.strftime("%Y-%m-%dT00:00:00Z"),
                month_to.strftime("%Y-%m-%dT23:59:59Z"),
            ))
        elif tail_start is None:
            tail_start = month_from
        cursor += relativedelta(months=1)

    if tail_start is not None:
        settled.append((tail_start.strftime("%Y-%m-%dT00:00:00Z"), api_to))

    return settled or [(api_from, api_to)]


async def _query_months(
    url: str, headers: dict, body: dict, timeout: int, granularity: str,
) -> List[Dict[str, Any]]:
    """
    Run a monthly query as one request per finished month, and flatten the rows.

    A failing segment fails the whole read rather than returning what did
    arrive. Each segment is a distinct set of months, so quietly dropping one
    would not produce a slower answer or a smaller one -- it would produce a
    total that looks complete and is short by a month.
    """
    period = body.get("timePeriod") or {}
    segments = (
        month_segments(period.get("from"), period.get("to"))
        if granularity == "Monthly" and period.get("from") and period.get("to")
        else [(period.get("from"), period.get("to"))]
    )

    async def run(seg: tuple[str, str]) -> List[Dict[str, Any]]:
        seg_body = body if len(segments) == 1 else {
            **body, "timePeriod": {"from": seg[0], "to": seg[1]},
        }
        pages = await _run_paged_query(url, headers, seg_body, timeout=timeout)
        return [rec for page in pages for rec in _columnar_to_records(page)]

    chunks = await asyncio.gather(*(run(seg) for seg in segments))
    return [rec for chunk in chunks for rec in chunk]


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


def friendly_error(exc: Exception, retry_after: int = 0) -> str:
    """
    Turn an httpx/Azure exception into something a user can act on.

    `retry_after` is the delay the page will actually wait before trying again.
    It is passed in rather than read off the exception because the two used to
    disagree: the exception knew Azure had asked for four seconds, the retry
    timer knew four seconds was never going to be long enough and waited five,
    and the reader was told a number that no part of the system was using. A
    countdown on screen is a promise; it has to be the same number the code is
    counting.
    """
    if isinstance(exc, RateLimited):
        wait = retry_after or exc.retry_in
        if getattr(exc, "paced", False):
            # Our own queue, not Azure's refusal. Saying otherwise sends people
            # to the Azure portal to look for a quota that is not the problem.
            return (
                "This subscription has more cost queries queued than it can send "
                f"in one minute. It will be read again in about {wait}s. "
                "Selecting fewer subscriptions or a narrower date range asks less "
                "of it at once."
            )
        return (
            "Azure is rate limiting cost queries for this account. "
            f"This subscription will be read again automatically in about {wait}s. "
            "Refreshing sooner will not help - it asks Azure the same question "
            "again and restarts the wait."
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
        "error": friendly_error(exc, retry_after),
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

    return await _query_months(url, headers, body, timeout=60, granularity=granularity)


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

    records = await _query_months(url, headers, body, timeout=90, granularity=granularity)
    for rec in records:
        rec["SubscriptionId"] = rec.get("SubscriptionId") or subscription_id
    return records


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
