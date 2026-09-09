"""
Monthly cost queries are asked one finished month at a time.

The point of the split is cache life: a month Azure has stopped amending can be
kept for weeks, whereas the range it used to be bundled into ended today and so
expired every half hour. These tests exist because the split is only worth
having if it is invisible in the answer -- the same months, once each, whatever
the boundaries -- and a fault there would not look like a bug. It would look
like a total that is simply wrong.
"""
from datetime import date

import pytest

from services import cost_client
from services.cost_client import month_segments


def days(segments):
    """The set of calendar days each segment claims, for overlap checks."""
    out = []
    for start, end in segments:
        out.append((cost_client._parse_api_date(start), cost_client._parse_api_date(end)))
    return out


class TestMonthSegments:
    def test_finished_months_are_asked_for_separately(self):
        segments = month_segments(
            "2026-03-01T00:00:00Z", "2026-08-24T23:59:59Z", today=date(2026, 8, 24),
        )
        # March through July are done with; August is still running and stays
        # as the tail rather than becoming a sixth entry that would expire
        # just as fast as the range it replaced.
        assert len(segments) == 6
        assert segments[0] == ("2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z")
        assert segments[4] == ("2026-07-01T00:00:00Z", "2026-07-31T23:59:59Z")
        assert segments[-1] == ("2026-08-01T00:00:00Z", "2026-08-24T23:59:59Z")

    def test_the_split_covers_the_range_exactly_once(self):
        segments = month_segments(
            "2026-03-01T00:00:00Z", "2026-08-24T23:59:59Z", today=date(2026, 8, 24),
        )
        spans = days(segments)
        assert spans[0][0] == date(2026, 3, 1)
        assert spans[-1][1] == date(2026, 8, 24)
        for (_, earlier_end), (later_start, _) in zip(spans, spans[1:]):
            # No gap and no overlap. A gap loses a day's spend; an overlap
            # counts it twice, and both produce a plausible-looking total.
            assert later_start.toordinal() == earlier_end.toordinal() + 1

    def test_a_recently_ended_month_is_still_treated_as_live(self):
        # On the 2nd, Azure has not finished amending the month just gone, so
        # caching it for thirty days would pin a figure that is still moving.
        segments = month_segments(
            "2026-06-01T00:00:00Z", "2026-09-02T23:59:59Z", today=date(2026, 9, 2),
        )
        assert segments[-1][0] == "2026-08-01T00:00:00Z"
        assert len(segments) == 3

    def test_a_range_inside_one_live_month_is_left_alone(self):
        period = ("2026-09-01T00:00:00Z", "2026-09-08T23:59:59Z")
        assert month_segments(*period, today=date(2026, 9, 8)) == [period]

    def test_a_partial_first_month_keeps_its_own_start(self):
        segments = month_segments(
            "2026-03-14T00:00:00Z", "2026-05-20T23:59:59Z", today=date(2026, 8, 1),
        )
        assert segments[0][0] == "2026-03-14T00:00:00Z"

    def test_an_unreadable_period_is_asked_as_one_query(self):
        # Never a reason to fail a cost read -- it only means we cannot prove
        # any part of it is settled.
        period = ("MonthToDate", "MonthToDate")
        assert month_segments(*period) == [period]


class TestQueryMonths:
    @pytest.mark.asyncio
    async def test_every_segment_is_asked_and_the_rows_are_concatenated(self, monkeypatch):
        asked = []

        async def fake_paged(url, headers, body, timeout):
            asked.append(body["timePeriod"])
            return [{"properties": {
                "columns": [{"name": "PreTaxCost"}, {"name": "BillingMonth"}],
                "rows": [[1.0, body["timePeriod"]["from"][:7]]],
            }}]

        monkeypatch.setattr(cost_client, "_run_paged_query", fake_paged)

        body = {
            "timePeriod": {"from": "2026-03-01T00:00:00Z", "to": "2026-08-24T23:59:59Z"},
            "dataset": {"granularity": "Monthly"},
        }
        records = await cost_client._query_months(
            "https://example/query", {}, body, timeout=60, granularity="Monthly",
        )

        assert len(asked) == len(records) > 1
        assert len({r["BillingMonth"] for r in records}) == len(records)

    @pytest.mark.asyncio
    async def test_a_failing_segment_fails_the_whole_read(self, monkeypatch):
        """
        A partial answer here is not a smaller answer, it is a wrong one: the
        months that did arrive add up to a total the page presents as complete.
        """
        async def fake_paged(url, headers, body, timeout):
            if body["timePeriod"]["from"].startswith("2026-05"):
                raise RuntimeError("throttled")
            return [{"rows": [], "columns": []}]

        monkeypatch.setattr(cost_client, "_run_paged_query", fake_paged)

        body = {
            "timePeriod": {"from": "2026-03-01T00:00:00Z", "to": "2026-08-24T23:59:59Z"},
            "dataset": {"granularity": "Monthly"},
        }
        with pytest.raises(RuntimeError):
            await cost_client._query_months(
                "https://example/query", {}, body, timeout=60, granularity="Monthly",
            )

    @pytest.mark.asyncio
    async def test_daily_granularity_is_never_split(self, monkeypatch):
        asked = []

        async def fake_paged(url, headers, body, timeout):
            asked.append(body["timePeriod"])
            return []

        monkeypatch.setattr(cost_client, "_run_paged_query", fake_paged)

        body = {
            "timePeriod": {"from": "2026-03-01T00:00:00Z", "to": "2026-08-24T23:59:59Z"},
            "dataset": {"granularity": "Daily"},
        }
        await cost_client._query_months(
            "https://example/query", {}, body, timeout=60, granularity="Daily",
        )
        # Day rows are what the timeline is built from; cutting the range would
        # change nothing about them except how many requests it takes.
        assert len(asked) == 1
