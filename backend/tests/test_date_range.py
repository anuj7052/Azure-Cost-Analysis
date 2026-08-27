"""
The rolling date range must include the month currently in progress.

It did not, for a long time, and the symptom was subtle enough to survive:
every tile still rendered, the numbers were all internally consistent, and the
only clue was that "Latest Month" was always the month before last. A dashboard
that silently reports stale-but-plausible figures is worse than one that
reports nothing, so these tests exist to make the omission loud.
"""
from datetime import date

import pytest
from dateutil.relativedelta import relativedelta

from services.cost_client import _build_date_range


def _parse(value: str) -> date:
    return date.fromisoformat(value[:10])


class TestRollingRangeIncludesCurrentMonth:
    def test_range_ends_today_not_last_month(self):
        """The whole point: today must be inside the window."""
        start, end = _build_date_range(6)
        assert _parse(end) == date.today()

    def test_start_is_the_first_of_a_month(self):
        """Partial leading months would skew every month-over-month figure."""
        start, _ = _build_date_range(6)
        assert _parse(start).day == 1

    @pytest.mark.parametrize("months", [1, 2, 3, 6, 12, 24])
    def test_span_covers_exactly_n_calendar_months(self, months):
        """
        months_back counts calendar months including the current one, so
        months_back=1 means "this month so far" rather than "all of last month".
        """
        start, end = _build_date_range(months)
        today = date.today()
        expected_start = date(today.year, today.month, 1) - relativedelta(months=months - 1)
        assert _parse(start) == expected_start
        assert _parse(end) == today

    def test_single_month_starts_on_the_first_of_this_month(self):
        start, end = _build_date_range(1)
        today = date.today()
        assert _parse(start) == date(today.year, today.month, 1)
        assert _parse(end) == today

    def test_current_month_is_never_excluded(self):
        """
        The exact regression this file was written for: the old implementation
        ended on the last day of the previous month, so the current month was
        absent from every rolling query.
        """
        today = date.today()
        for months in (1, 3, 6, 12):
            start, end = _build_date_range(months)
            first_of_this_month = date(today.year, today.month, 1)
            assert _parse(start) <= first_of_this_month
            assert _parse(end) >= first_of_this_month

    def test_start_is_never_after_end(self):
        for months in (1, 2, 6, 12, 36):
            start, end = _build_date_range(months)
            assert _parse(start) <= _parse(end)


class TestRangeFormatting:
    def test_uses_azure_iso_timestamps(self):
        start, end = _build_date_range(6)
        assert start.endswith("T00:00:00Z")
        assert end.endswith("T23:59:59Z")

    def test_end_covers_the_whole_of_today(self):
        """
        Truncating to T00:00:00 would drop everything billed today, which on the
        first of a month means the current month reads as zero.
        """
        _, end = _build_date_range(6)
        assert end.endswith("T23:59:59Z")
