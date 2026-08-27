"""
Comparing an unfinished month against a finished one.

This is the bug that made every service look like it was getting cheaper: on
27 August the page measured 27 days of August against 31 days of July and
reported the eight missing days as a saving. It was wrong in the same direction
almost every day of the month, which is the kind of wrong that gets believed.
"""
from datetime import date

from services.cost_periods import (
    COMPARE_PREVIOUS_MONTH,
    COMPARE_PREVIOUS_PERIOD,
    COMPARE_SAME_MONTH_LAST_YEAR,
    comparison_window,
    describe,
    is_partial,
    month_bounds,
)


class TestPartialMonth:
    def test_a_month_in_progress_is_partial(self):
        assert is_partial(date(2026, 8, 31), today=date(2026, 8, 27))

    def test_a_finished_month_is_not(self):
        assert not is_partial(date(2026, 7, 31), today=date(2026, 8, 27))


class TestPreviousMonth:
    def test_an_incomplete_august_is_compared_with_an_equal_slice_of_july(self):
        start, end = comparison_window(
            date(2026, 8, 1), date(2026, 8, 31), COMPARE_PREVIOUS_MONTH, today=date(2026, 8, 27)
        )

        # Not 1-31 July. Twenty-seven days against twenty-seven days.
        assert (start, end) == (date(2026, 7, 1), date(2026, 7, 27))

    def test_a_complete_month_is_compared_with_a_complete_month(self):
        start, end = comparison_window(
            date(2026, 7, 1), date(2026, 7, 31), COMPARE_PREVIOUS_MONTH, today=date(2026, 8, 27)
        )

        assert (start, end) == (date(2026, 6, 1), date(2026, 6, 30))

    def test_a_long_month_does_not_borrow_days_from_the_next_one(self):
        # 31 elapsed days of March against February would otherwise run to
        # "2 March" and count the same days twice.
        start, end = comparison_window(
            date(2026, 3, 1), date(2026, 3, 31), COMPARE_PREVIOUS_MONTH, today=date(2026, 3, 31)
        )

        assert (start, end) == (date(2026, 2, 1), date(2026, 2, 28))


class TestPreviousPeriod:
    def test_the_window_immediately_before_this_one(self):
        start, end = comparison_window(
            date(2026, 8, 21), date(2026, 8, 27), COMPARE_PREVIOUS_PERIOD, today=date(2026, 8, 27)
        )

        assert (start, end) == (date(2026, 8, 14), date(2026, 8, 20))

    def test_it_spans_a_month_boundary_without_complaint(self):
        start, end = comparison_window(
            date(2026, 8, 1), date(2026, 8, 7), COMPARE_PREVIOUS_PERIOD, today=date(2026, 8, 27)
        )

        assert (start, end) == (date(2026, 7, 25), date(2026, 7, 31))


class TestSameMonthLastYear:
    def test_it_looks_back_twelve_months(self):
        start, end = comparison_window(
            date(2026, 8, 1), date(2026, 8, 31), COMPARE_SAME_MONTH_LAST_YEAR, today=date(2026, 8, 27)
        )

        assert (start, end) == (date(2025, 8, 1), date(2025, 8, 27))

    def test_february_29_does_not_become_an_invalid_date(self):
        start, _ = comparison_window(
            date(2024, 2, 29), date(2024, 2, 29), COMPARE_SAME_MONTH_LAST_YEAR, today=date(2024, 2, 29)
        )

        assert start == date(2023, 2, 28)


class TestMonthBounds:
    def test_a_thirty_one_day_month(self):
        assert month_bounds(date(2026, 8, 14)) == (date(2026, 8, 1), date(2026, 8, 31))

    def test_a_leap_february(self):
        assert month_bounds(date(2024, 2, 10)) == (date(2024, 2, 1), date(2024, 2, 29))

    def test_december_rolls_into_the_next_year(self):
        assert month_bounds(date(2026, 12, 5)) == (date(2026, 12, 1), date(2026, 12, 31))


class TestDescribe:
    def test_a_partial_period_explains_itself(self):
        d = describe(date(2026, 8, 1), date(2026, 8, 31), COMPARE_PREVIOUS_MONTH, today=date(2026, 8, 27))

        assert d["partial"] is True
        assert d["days_compared"] == 27
        assert d["previous_start"] == "2026-07-01"
        assert d["previous_end"] == "2026-07-27"
        # The reader is told, in words, what was measured against what.
        assert "like for like" in d["note"]

    def test_a_complete_period_needs_no_caveat(self):
        d = describe(date(2026, 7, 1), date(2026, 7, 31), COMPARE_PREVIOUS_MONTH, today=date(2026, 8, 27))

        assert d["partial"] is False
        assert d["note"] == ""

    def test_the_measured_end_is_reported_separately_from_the_requested_one(self):
        d = describe(date(2026, 8, 1), date(2026, 8, 31), COMPARE_PREVIOUS_MONTH, today=date(2026, 8, 27))

        # What was asked for and what exists are different on a partial month,
        # and the page needs both to avoid claiming coverage it does not have.
        assert d["current_end"] == "2026-08-31"
        assert d["current_effective_end"] == "2026-08-27"
