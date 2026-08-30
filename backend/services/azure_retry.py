"""Retrying an Azure call that came back 429.

Cost Management has had its own retry loop for a long time, because it is the
API that throttles first and everybody noticed. The other four Azure APIs this
app calls -- Monitor metrics, Resource Graph, the Activity Log and Retail
Prices -- had none at all. A single 429 from any of them turned into an empty
panel, and on a large estate Monitor is by far the busiest of the five: two
calls per virtual machine against an API that is metered per subscription.

That is the difference this module exists to remove. It is deliberately small
and has no opinion about the request itself, so each caller keeps its own
client, headers, timeout and error handling and only borrows the waiting.

Azure answers a 429 with a Retry-After header saying how long to wait. Guessing
instead of reading it is what turns one throttled request into a queue of them,
so the header is preferred whenever it is present and understandable.
"""
from __future__ import annotations

import asyncio
import random
from typing import Awaitable, Callable, Iterable, Optional

import httpx

# Three attempts total. Azure's own guidance is that a throttle clears in
# seconds; a request that is still refused after three waits is being refused
# for a reason that waiting will not fix, and continuing to ask is what turns
# one slow page into a tenant-wide cooldown.
DEFAULT_RETRIES = 3

# No single wait longer than this, however long Azure asks for. A minute of
# silence is indistinguishable from a hung page to the person looking at it,
# and the caller's own timeout is usually shorter anyway.
MAX_DELAY_SECONDS = 15.0

# 429 is the throttle itself. The 5xx family is included because Azure returns
# 503 under load in situations where another provider would have returned 429,
# and both clear the same way.
RETRY_STATUSES = (429, 500, 502, 503, 504)


def retry_delay(
    response: Optional[httpx.Response],
    attempt: int,
    *,
    max_delay: float = MAX_DELAY_SECONDS,
    extra_headers: Iterable[str] = (),
) -> float:
    """How long to wait before attempt number ``attempt`` (0-based).

    Azure's answer is preferred over any calculation of ours. Several services
    also send their own differently named variant of the same hint, which is
    what ``extra_headers`` is for.

    Falls back to exponential backoff with jitter. The jitter matters more than
    it looks: without it a fan-out across twelve subscriptions is throttled
    together, waits the same two seconds, and retries together.
    """
    if response is not None:
        for header in ("Retry-After", *extra_headers):
            value = response.headers.get(header)
            if not value:
                continue
            try:
                seconds = float(value)
            except (TypeError, ValueError):
                # Retry-After may legally be an HTTP date. Parsing it is not
                # worth it here; falling through to backoff is a safe answer.
                continue
            if seconds >= 0:
                return min(seconds, max_delay)
    return min(2 ** attempt, max_delay) + random.uniform(0, 1)


async def send_with_retry(
    send: Callable[[], Awaitable[httpx.Response]],
    *,
    retries: int = DEFAULT_RETRIES,
    max_delay: float = MAX_DELAY_SECONDS,
    extra_headers: Iterable[str] = (),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> httpx.Response:
    """Call ``send`` until it stops being throttled, then return its response.

    ``send`` is re-invoked rather than a prepared request being re-sent, so a
    caller that mints a fresh token or signs each attempt keeps working.

    The final response is returned as-is, throttled or not. Deciding what a
    still-refused request means belongs to the caller, which knows whether an
    empty result is a legitimate answer or a failure worth reporting.

    ``sleep`` is injectable so tests can prove the waiting happens without
    actually waiting.
    """
    response: httpx.Response | None = None
    for attempt in range(retries):
        response = await send()
        if response.status_code not in RETRY_STATUSES:
            return response
        if attempt == retries - 1:
            break
        await sleep(retry_delay(response, attempt, max_delay=max_delay,
                               extra_headers=extra_headers))
    assert response is not None  # retries >= 1, so send() ran at least once
    return response
