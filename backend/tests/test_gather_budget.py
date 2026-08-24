"""
Multi-subscription reads must finish inside the browser's patience.

The failure these tests exist to prevent is "timeout of 60000ms exceeded": the
browser gave up while the server was still reading subscriptions one at a time.
Nothing was broken — the work was simply queued badly — but the user saw an
error with no cause and no remedy.

Two guarantees are asserted here:
  1. Subscriptions are read concurrently, so N slow subscriptions cost roughly
     one subscription's time, not N times it.
  2. The whole read is bounded. When Azure will not answer, the response is
     partial data plus a named reason, never an unbounded wait.
"""
import asyncio
import time

import pytest

from services.cost_client import gather_by_subscription


class TestConcurrency:
    """Subscriptions are read in parallel, not one after another."""

    @pytest.mark.asyncio
    async def test_ten_slow_subscriptions_do_not_take_ten_times_as_long(self):
        async def slow(sub_id):
            await asyncio.sleep(0.1)
            return [{"SubscriptionId": sub_id}]

        subs = [f"sub-{i}" for i in range(10)]
        started = time.monotonic()
        records, errors = await gather_by_subscription(subs, slow)
        elapsed = time.monotonic() - started

        assert errors == []
        assert len(records) == 10
        # Serially this is 1.0s. Concurrently it is ~0.1s. The generous ceiling
        # keeps the test honest on a loaded CI box while still failing loudly if
        # the loop ever goes back to awaiting one subscription at a time.
        assert elapsed < 0.5, f"reads appear to be serial: took {elapsed:.2f}s"

    @pytest.mark.asyncio
    async def test_every_subscription_is_still_read(self):
        seen = []

        async def record(sub_id):
            seen.append(sub_id)
            return [{"SubscriptionId": sub_id}]

        await gather_by_subscription(["a", "b", "c"], record)
        assert sorted(seen) == ["a", "b", "c"]


class TestBudget:
    """The read is bounded, and what it drops it explains."""

    @pytest.mark.asyncio
    async def test_a_hanging_subscription_cannot_hang_the_response(self):
        async def never(sub_id):
            await asyncio.sleep(3600)

        started = time.monotonic()
        records, errors = await gather_by_subscription(["stuck"], never, budget=0.2)
        elapsed = time.monotonic() - started

        assert elapsed < 1.0
        assert records == []
        assert len(errors) == 1

    @pytest.mark.asyncio
    async def test_a_timeout_is_explained_not_left_blank(self):
        """
        TimeoutError has an empty str(). Passed through unexamined it rendered as
        a subscription name next to nothing at all.
        """
        async def never(sub_id):
            await asyncio.sleep(3600)

        _, errors = await gather_by_subscription(["stuck"], never, budget=0.1)
        message = errors[0]["error"]

        assert message.strip(), "a timeout must not produce an empty reason"
        assert "time" in message.lower()
        # It must tell the user what to actually do about it.
        assert "fewer subscriptions" in message or "date range" in message

    @pytest.mark.asyncio
    async def test_slow_subscriptions_do_not_discard_the_fast_ones(self):
        """Partial data beats no data — the working subscriptions still report."""
        async def mixed(sub_id):
            if sub_id == "slow":
                await asyncio.sleep(3600)
            return [{"SubscriptionId": sub_id, "cost": 10}]

        records, errors = await gather_by_subscription(
            ["fast-1", "slow", "fast-2"], mixed, budget=0.3
        )

        assert sorted(r["SubscriptionId"] for r in records) == ["fast-1", "fast-2"]
        assert [e["subscription_id"] for e in errors] == ["slow"]

    @pytest.mark.asyncio
    async def test_ordinary_failures_are_still_reported_per_subscription(self):
        async def boom(sub_id):
            if sub_id == "bad":
                raise RuntimeError("Azure said no")
            return [{"SubscriptionId": sub_id}]

        records, errors = await gather_by_subscription(["good", "bad"], boom)

        assert [r["SubscriptionId"] for r in records] == ["good"]
        assert errors[0]["subscription_id"] == "bad"
        assert "Azure said no" in errors[0]["error"]

    @pytest.mark.asyncio
    async def test_an_empty_selection_is_not_an_error(self):
        async def unused(sub_id):  # pragma: no cover - must never run
            raise AssertionError("should not be called")

        records, errors = await gather_by_subscription([], unused)
        assert records == []
        assert errors == []
