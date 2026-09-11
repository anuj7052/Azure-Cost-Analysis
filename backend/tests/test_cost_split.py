"""
Cutting a cost query into the part Azure has finished with and the part it
has not.
"""
from datetime import datetime, timezone

from services import cost_cache


NOW = datetime(2026, 9, 11, 12, 0, 0, tzinfo=timezone.utc)


def _at(text):
    return text


class TestSplittingAtTheSettledBoundary:
    def test_it_separates_the_closed_months_from_the_open_one(self):
        settled, live = cost_cache.settled_split(
            "2026-04-01T00:00:00Z", "2026-09-11T23:59:59Z", now=NOW,
        )
        assert settled == ("2026-04-01T00:00:00Z", "2026-08-31T23:59:59Z")
        assert live == ("2026-09-01T00:00:00Z", "2026-09-11T23:59:59Z")

    def test_it_cuts_on_a_month_boundary_and_not_on_the_settling_cutoff(self):
        # Rows come back grouped by month. Cutting three days back from today
        # would return September from both halves, and the two would be summed
        # into a doubled figure -- a wrong total that looks entirely plausible.
        settled, live = cost_cache.settled_split(
            "2026-04-01T00:00:00Z", "2026-09-11T23:59:59Z", now=NOW,
        )
        assert settled[1].startswith("2026-08-31")
        assert live[0].startswith("2026-09-01")

    def test_the_halves_do_not_overlap_by_even_a_second(self):
        settled, live = cost_cache.settled_split(
            "2026-04-01T00:00:00Z", "2026-09-11T23:59:59Z", now=NOW,
        )
        assert settled[1] < live[0]

    def test_a_range_entirely_in_the_past_is_not_split(self):
        # It is already cacheable for thirty days as one query. Splitting it
        # would double the query count for no gain.
        settled, live = cost_cache.settled_split(
            "2026-01-01T00:00:00Z", "2026-03-31T23:59:59Z", now=NOW,
        )
        assert settled == ("2026-01-01T00:00:00Z", "2026-03-31T23:59:59Z")
        assert live is None

    def test_a_range_entirely_in_the_current_month_is_not_split(self):
        settled, live = cost_cache.settled_split(
            "2026-09-01T00:00:00Z", "2026-09-11T23:59:59Z", now=NOW,
        )
        assert settled is None
        assert live == ("2026-09-01T00:00:00Z", "2026-09-11T23:59:59Z")

    def test_early_in_a_month_the_previous_one_is_still_open(self):
        # On the 2nd, the settling window reaches back into last month, so
        # last month is still being amended and must not be pinned for thirty
        # days. That is the one failure this cache must not have.
        early = datetime(2026, 9, 2, 6, 0, 0, tzinfo=timezone.utc)
        settled, live = cost_cache.settled_split(
            "2026-06-01T00:00:00Z", "2026-09-02T23:59:59Z", now=early,
        )
        assert settled[1].startswith("2026-07-31")
        assert live[0].startswith("2026-08-01")

    def test_it_refuses_a_range_it_cannot_read(self):
        # Both None tells the caller to send the range unsplit. Guessing a
        # boundary from an unparseable date could drop a month silently.
        assert cost_cache.settled_split("not a date", "2026-09-11T00:00:00Z") == (None, None)
        assert cost_cache.settled_split("2026-09-01T00:00:00Z", "") == (None, None)

    def test_it_refuses_a_backwards_range(self):
        assert cost_cache.settled_split(
            "2026-09-11T00:00:00Z", "2026-04-01T00:00:00Z", now=NOW,
        ) == (None, None)

    def test_it_accepts_a_plain_date_as_well_as_a_timestamp(self):
        settled, live = cost_cache.settled_split("2026-04-01", "2026-09-11", now=NOW)
        assert settled[0] == "2026-04-01"
        assert live[1] == "2026-09-11"


class TestWhatTheSplitIsWorth:
    def test_the_closed_half_is_cached_far_longer_than_the_open_one(self):
        # The whole point. Unsplit, the closed months inherited the open TTL
        # and were re-read from the most throttled API in Azure every half
        # hour, forever.
        closed = {"timePeriod": {"from": "2026-04-01T00:00:00Z", "to": "2026-08-31T23:59:59Z"}}
        live = {"timePeriod": {"from": "2026-09-01T00:00:00Z", "to": "2026-09-11T23:59:59Z"}}
        assert cost_cache.ttl_for(closed, now=NOW) == cost_cache.SETTLED_TTL_SECONDS
        assert cost_cache.ttl_for(live, now=NOW) == cost_cache.OPEN_TTL_SECONDS
        assert cost_cache.SETTLED_TTL_SECONDS > cost_cache.OPEN_TTL_SECONDS

    def test_the_unsplit_range_really_was_treated_as_live(self):
        whole = {"timePeriod": {"from": "2026-04-01T00:00:00Z", "to": "2026-09-11T23:59:59Z"}}
        assert cost_cache.ttl_for(whole, now=NOW) == cost_cache.OPEN_TTL_SECONDS
