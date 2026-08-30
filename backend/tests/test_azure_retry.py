"""Tests for the shared Azure retry helper.

The behaviour worth pinning down is not "it retries" but *how long it waits*.
Ignoring Azure's Retry-After is what turns one throttled request into a queue
of them, so the header handling is tested more carefully than the loop.

No test sleeps: `sleep` is injected and records what it was asked to wait for.
"""
import httpx
import pytest

from services import azure_retry


def response(status: int, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status, headers=headers or {}, request=httpx.Request("GET", "https://example.test"))


class Recorder:
    """Stands in for asyncio.sleep and remembers the delays."""

    def __init__(self):
        self.waits: list[float] = []

    async def __call__(self, seconds: float):
        self.waits.append(seconds)


def sender(*responses):
    """A send callable that returns the given responses in order."""
    queue = list(responses)
    calls = []

    async def send():
        calls.append(True)
        return queue.pop(0) if len(queue) > 1 else queue[0]

    send.calls = calls
    return send


async def test_success_returns_immediately_without_waiting():
    send = sender(response(200))
    sleep = Recorder()

    result = await azure_retry.send_with_retry(send, sleep=sleep)

    assert result.status_code == 200
    assert len(send.calls) == 1
    assert sleep.waits == []


async def test_throttle_then_success():
    send = sender(response(429, {"Retry-After": "2"}), response(200))
    sleep = Recorder()

    result = await azure_retry.send_with_retry(send, sleep=sleep)

    assert result.status_code == 200
    assert len(send.calls) == 2
    assert sleep.waits == [2.0]


async def test_retry_after_header_is_obeyed_over_backoff():
    # Backoff for attempt 0 would be ~1s. Azure said 7, so 7 it is.
    delay = azure_retry.retry_delay(response(429, {"Retry-After": "7"}), 0)
    assert delay == 7.0


async def test_retry_after_is_clamped_to_max_delay():
    delay = azure_retry.retry_delay(response(429, {"Retry-After": "600"}), 0, max_delay=15.0)
    assert delay == 15.0


async def test_http_date_retry_after_falls_back_to_backoff():
    # A legal but unparsed form must not crash the caller.
    delay = azure_retry.retry_delay(
        response(429, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}), 1
    )
    assert 2.0 <= delay <= 3.0


async def test_backoff_grows_and_carries_jitter():
    first = azure_retry.retry_delay(response(429), 0)
    later = azure_retry.retry_delay(response(429), 3)
    assert 1.0 <= first <= 2.0
    assert 8.0 <= later <= 9.0


async def test_service_specific_header_is_read():
    delay = azure_retry.retry_delay(
        response(429, {"x-ms-ratelimit-microsoft.costmanagement-entity-retry-after": "4"}),
        0,
        extra_headers=("x-ms-ratelimit-microsoft.costmanagement-entity-retry-after",),
    )
    assert delay == 4.0


async def test_gives_up_after_retries_and_returns_the_throttled_response():
    send = sender(response(429))
    sleep = Recorder()

    result = await azure_retry.send_with_retry(send, retries=3, sleep=sleep)

    # The caller gets the 429 back so it can report throttling by name rather
    # than as an unexplained empty result.
    assert result.status_code == 429
    assert len(send.calls) == 3
    assert len(sleep.waits) == 2  # no wait after the final attempt


async def test_server_errors_are_retried_too():
    send = sender(response(503), response(200))
    sleep = Recorder()

    result = await azure_retry.send_with_retry(send, sleep=sleep)

    assert result.status_code == 200
    assert len(send.calls) == 2


async def test_client_errors_are_not_retried():
    # 403 means missing permission. Waiting will never grant it.
    for status in (400, 401, 403, 404):
        send = sender(response(status))
        sleep = Recorder()

        result = await azure_retry.send_with_retry(send, sleep=sleep)

        assert result.status_code == status
        assert len(send.calls) == 1
        assert sleep.waits == []


async def test_monitor_concurrency_gate_is_shared_across_callers():
    """Two concurrent collections must share one budget, not get one each.

    The limit that matters is Azure's, and Azure counts requests rather than
    callers. This used to be built per invocation, so two open tabs doubled it.
    """
    from services import azure_metrics

    azure_metrics._gate = None
    first = azure_metrics._shared_gate(azure_metrics.MAX_CONCURRENT)
    second = azure_metrics._shared_gate(azure_metrics.MAX_CONCURRENT)

    assert first is second
