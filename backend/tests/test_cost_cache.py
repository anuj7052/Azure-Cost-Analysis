"""
The durable cost cache.

Two things are being protected here, and they pull in opposite directions.

The first is the saving: an answer about a period Azure has finished with must
survive restarts and must not be thrown away on a ten minute timer, because
re-asking for immutable history is what was spending the rate limit.

The second is the safety: a period that is still moving must never be mistaken
for a finished one. Pinning a half-complete month for thirty days would report
a partial bill as a final one, which is a worse failure than any amount of
throttling. Most of what follows is about that boundary.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import cost_cache, cost_client


NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


def body_ending(when: datetime | str) -> dict:
    text = when if isinstance(when, str) else when.strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {"from": "2026-01-01T00:00:00Z", "to": text},
    }


@pytest_asyncio.fixture
async def store(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    yield path


# ── Deciding whether Azure can still change its mind ───────────────────────

class TestSettling:
    def test_a_period_that_ended_months_ago_is_settled(self):
        assert cost_cache.is_settled(body_ending(datetime(2026, 3, 31, tzinfo=timezone.utc)), NOW)

    def test_a_period_ending_today_is_not_settled(self):
        """The current month is still accruing; caching it long reports a partial bill as final."""
        assert not cost_cache.is_settled(body_ending(NOW), NOW)

    def test_a_period_that_ended_yesterday_is_not_yet_settled(self):
        """
        Usage records arrive late. A resource that ran on the 30th can post its
        charge on the 1st, so "the window closed" and "the number is final" are
        different days and only the second one may be cached long.
        """
        yesterday = NOW - timedelta(days=1)
        assert not cost_cache.is_settled(body_ending(yesterday), NOW)

    def test_the_settling_boundary_is_honoured_exactly(self):
        just_inside = NOW - timedelta(days=cost_cache.SETTLING_DAYS, seconds=1)
        just_outside = NOW - timedelta(days=cost_cache.SETTLING_DAYS, seconds=-1)
        assert cost_cache.is_settled(body_ending(just_inside), NOW)
        assert not cost_cache.is_settled(body_ending(just_outside), NOW)

    def test_a_relative_timeframe_is_never_settled(self):
        """
        MonthToDate and friends carry no explicit period. They include now by
        definition, so the only safe reading of a missing period is "still moving".
        """
        assert not cost_cache.is_settled({"timeframe": "MonthToDate"}, NOW)

    def test_an_unparseable_period_is_never_settled(self):
        assert not cost_cache.is_settled(body_ending("not-a-date"), NOW)

    def test_a_plain_date_is_understood(self):
        assert cost_cache.is_settled(body_ending("2026-03-31"), NOW)

    def test_settled_answers_outlive_open_ones_by_a_wide_margin(self):
        settled = cost_cache.ttl_for(body_ending(datetime(2026, 3, 31, tzinfo=timezone.utc)), NOW)
        open_window = cost_cache.ttl_for(body_ending(NOW), NOW)
        assert settled > open_window * 10

    def test_an_open_window_outlives_the_browsers_own_refresh(self):
        """
        The frontend revalidates its copy at fifteen minutes. A server TTL below
        that guarantees every background refresh reaches Azure, which is how two
        working caches combine into no cache at all.
        """
        assert cost_cache.ttl_for(body_ending(NOW), NOW) > 15 * 60


# ── Surviving the restart ──────────────────────────────────────────────────

class TestRoundTrip:
    @pytest.mark.asyncio
    async def test_an_answer_comes_back_the_way_it_went_in(self, store):
        pages = [{"properties": {"rows": [[12.5, "2026-03", "USD"]]}}]
        await cost_cache.store("k1", pages, url="/subscriptions/s1/x", body=body_ending("2026-03-31"))

        loaded = await cost_cache.load("k1")

        assert loaded is not None
        payload, fresh = loaded
        assert payload == pages
        assert fresh

    @pytest.mark.asyncio
    async def test_an_unknown_key_is_a_miss_rather_than_an_error(self, store):
        assert await cost_cache.load("never-stored") is None

    @pytest.mark.asyncio
    async def test_storing_the_same_key_twice_replaces_rather_than_duplicates(self, store):
        body = body_ending("2026-03-31")
        await cost_cache.store("k1", [{"v": 1}], url="/subscriptions/s1", body=body)
        await cost_cache.store("k1", [{"v": 2}], url="/subscriptions/s1", body=body)

        payload, _ = await cost_cache.load("k1")
        assert payload == [{"v": 2}]

        async with aiosqlite.connect(store) as db:
            async with db.execute("SELECT COUNT(*) FROM cost_cache") as cursor:
                assert (await cursor.fetchone())[0] == 1

    @pytest.mark.asyncio
    async def test_an_expired_open_window_is_returned_but_marked_not_fresh(self, store):
        """
        Expiry means "ask again", not "forget". A throttled refresh still has to
        put real numbers on the screen, and last hour's are far better than none.
        """
        await cost_cache.store("k1", [{"v": 1}], url="/s", body=body_ending(NOW))
        async with aiosqlite.connect(store) as db:
            await db.execute("UPDATE cost_cache SET expires_at = 1")
            await db.commit()

        payload, fresh = await cost_cache.load("k1")
        assert payload == [{"v": 1}]
        assert not fresh

    @pytest.mark.asyncio
    async def test_an_answer_past_the_stale_horizon_is_gone(self, store):
        await cost_cache.store("k1", [{"v": 1}], url="/s", body=body_ending(NOW))
        async with aiosqlite.connect(store) as db:
            await db.execute("UPDATE cost_cache SET stored_at = 1, expires_at = 1")
            await db.commit()

        assert await cost_cache.load("k1") is None

    @pytest.mark.asyncio
    async def test_an_oversized_answer_is_skipped_rather_than_written(self, store, monkeypatch):
        """Trading an API limit for a disk limit is not a trade worth making."""
        monkeypatch.setattr(cost_cache, "MAX_PAYLOAD_BYTES", 32)

        await cost_cache.store("k1", [{"v": "x" * 500}], url="/s", body=body_ending(NOW))

        assert await cost_cache.load("k1") is None

    @pytest.mark.asyncio
    async def test_two_tenants_asking_differently_do_not_share_a_row(self, store):
        await cost_cache.store("key-a", [{"tenant": "a"}], url="/subscriptions/aaa", body=body_ending(NOW))
        await cost_cache.store("key-b", [{"tenant": "b"}], url="/subscriptions/bbb", body=body_ending(NOW))

        payload_a, _ = await cost_cache.load("key-a")
        payload_b, _ = await cost_cache.load("key-b")
        assert payload_a == [{"tenant": "a"}]
        assert payload_b == [{"tenant": "b"}]


# ── Keeping the table from growing forever ─────────────────────────────────

class TestPruning:
    @pytest.mark.asyncio
    async def test_pruning_removes_what_is_past_the_stale_horizon(self, store):
        await cost_cache.store("old", [{"v": 1}], url="/s", body=body_ending(NOW))
        async with aiosqlite.connect(store) as db:
            await db.execute("UPDATE cost_cache SET stored_at = 1")
            await db.commit()

        assert await cost_cache.prune() == 1
        assert await cost_cache.load("old") is None

    @pytest.mark.asyncio
    async def test_pruning_keeps_what_is_still_useful(self, store):
        await cost_cache.store("fresh", [{"v": 1}], url="/s", body=body_ending(NOW))

        await cost_cache.prune()

        assert await cost_cache.load("fresh") is not None

    @pytest.mark.asyncio
    async def test_a_live_window_is_evicted_before_a_settled_one(self, store, monkeypatch):
        """
        A live window will be re-fetched within the hour whatever we do. A
        settled one is a call that never has to happen again, so when the table
        is full it is the live rows that should go.
        """
        monkeypatch.setattr(cost_cache, "MAX_ROWS", 1)
        await cost_cache.store("settled", [{"v": 1}], url="/s", body=body_ending("2026-03-31"))
        await cost_cache.store("live", [{"v": 2}], url="/s", body=body_ending(NOW))

        await cost_cache.prune()

        assert await cost_cache.load("settled") is not None
        assert await cost_cache.load("live") is None


# ── Failing without taking the page down ───────────────────────────────────

class TestResilience:
    @pytest.mark.asyncio
    async def test_a_missing_database_is_a_miss_not_an_exception(self, tmp_path, monkeypatch):
        """
        Every caller of this module is on the path to rendering a bill. A cache
        that raises turns a slow page into a broken one, and going to Azure is
        always a correct outcome here.
        """
        monkeypatch.setattr(db_module, "DB_PATH", str(tmp_path / "nonexistent" / "no.db"))

        assert await cost_cache.load("k1") is None
        await cost_cache.store("k1", [{"v": 1}], url="/s", body=body_ending(NOW))
        assert await cost_cache.prune() == 0

    @pytest.mark.asyncio
    async def test_an_unserialisable_payload_is_declined_quietly(self, store):
        await cost_cache.store("k1", [{"when": object()}], url="/s", body=body_ending(NOW))

        # `default=str` handles most things; what matters is that nothing raised
        # and that a later read is coherent either way.
        loaded = await cost_cache.load("k1")
        assert loaded is None or isinstance(loaded[0], list)


class TestScope:
    def test_the_subscription_is_recorded_for_support(self):
        url = "https://management.azure.com/subscriptions/abc-123/providers/Microsoft.CostManagement/query"
        assert cost_cache.scope_of(url) == "abc-123"

    def test_a_url_without_a_subscription_records_nothing(self):
        assert cost_cache.scope_of("https://management.azure.com/providers/x") == ""


# ── What the whole thing is for ────────────────────────────────────────────

class TestThroughTheClient:
    """
    The cache read from where it actually matters: the cost client.

    Everything above tests the store in isolation, which would happily pass
    while the client ignored it. These count Azure calls instead, because the
    number of Azure calls is the entire point.
    """

    @pytest_asyncio.fixture(autouse=True)
    async def clean(self, store, monkeypatch):
        cost_client._cache.clear()
        cost_client._inflight.clear()
        monkeypatch.setattr(cost_client, "_throttled_until", 0.0)
        # httpx reads proxy settings from the environment when the client is
        # constructed, which happens before the stubbed request is ever sent.
        # A developer machine behind a proxy would otherwise fail these tests
        # for a reason that has nothing to do with caching.
        for name in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy",
                     "HTTPS_PROXY", "https_proxy"):
            monkeypatch.delenv(name, raising=False)
        yield
        cost_client._cache.clear()

    @staticmethod
    def _counting_azure(monkeypatch):
        calls = []

        async def fake_post(client, url, headers, body):
            calls.append(url)
            return {"properties": {"columns": [{"name": "PreTaxCost"}], "rows": [[1.0]]}}

        monkeypatch.setattr(cost_client, "_post_query", fake_post)
        return calls

    URL = "https://management.azure.com/subscriptions/s1/providers/Microsoft.CostManagement/query"

    @pytest.mark.asyncio
    async def test_the_same_question_twice_is_one_azure_call(self, monkeypatch):
        calls = self._counting_azure(monkeypatch)
        body = body_ending("2026-03-31")

        await cost_client._run_paged_query(self.URL, {}, body, timeout=5)
        await cost_client._run_paged_query(self.URL, {}, body, timeout=5)

        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_a_restart_does_not_cost_another_azure_call(self, monkeypatch):
        """
        The failure this whole change exists to fix. The in-process cache is
        gone after a deploy or a scale event, and on App Service the old
        temp-file copy was gone with it, so every restart re-read the estate
        from Azure at exactly the moment several instances were starting.
        """
        calls = self._counting_azure(monkeypatch)
        body = body_ending("2026-03-31")

        await cost_client._run_paged_query(self.URL, {}, body, timeout=5)
        cost_client._cache.clear()          # the restart
        await cost_client._run_paged_query(self.URL, {}, body, timeout=5)

        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_a_settled_period_is_kept_far_longer_than_a_live_one(self, monkeypatch, store):
        """
        The saving, stated as the number it depends on: a finished month is
        stored with an expiry weeks out, not minutes, because nothing about it
        can change.
        """
        self._counting_azure(monkeypatch)
        await cost_client._run_paged_query(self.URL, {}, body_ending("2026-03-31"), timeout=5)

        async with aiosqlite.connect(store) as db:
            async with db.execute("SELECT settled, expires_at, stored_at FROM cost_cache") as cur:
                settled, expires_at, stored_at = await cur.fetchone()

        assert settled == 1
        assert expires_at - stored_at == pytest.approx(cost_cache.SETTLED_TTL_SECONDS)

    @pytest.mark.asyncio
    async def test_a_live_window_is_refetched_once_it_expires(self, monkeypatch, store):
        """
        The other half of the guarantee. Durability must not turn into staleness
        for the month somebody is actually watching.
        """
        calls = self._counting_azure(monkeypatch)
        body = body_ending(datetime.now(timezone.utc))

        await cost_client._run_paged_query(self.URL, {}, body, timeout=5)
        cost_client._cache.clear()
        async with aiosqlite.connect(store) as db:
            await db.execute("UPDATE cost_cache SET expires_at = 1")
            await db.commit()

        await cost_client._run_paged_query(self.URL, {}, body, timeout=5)

        assert len(calls) == 2

    @pytest.mark.asyncio
    async def test_a_throttled_refresh_serves_the_stored_answer(self, monkeypatch, store):
        """
        A 429 must not blank the dashboard when a real answer is on disk.
        """
        calls = self._counting_azure(monkeypatch)
        body = body_ending(datetime.now(timezone.utc))
        await cost_client._run_paged_query(self.URL, {}, body, timeout=5)

        cost_client._cache.clear()
        async with aiosqlite.connect(store) as db:
            await db.execute("UPDATE cost_cache SET expires_at = 1")
            await db.commit()

        async def refuse(client, url, headers, body):
            calls.append(url)
            raise cost_client.RateLimited(30)

        monkeypatch.setattr(cost_client, "_post_query", refuse)

        pages = await cost_client._run_paged_query(self.URL, {}, body, timeout=5)

        assert pages, "a stored answer should have rescued the page"
        assert pages[0]["properties"]["rows"] == [[1.0]]
