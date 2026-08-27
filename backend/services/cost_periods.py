"""
Which two windows are being compared, and saying so out loud.

The old page compared whole calendar months. On the 27th of August that meant
27 days of August against 31 days of July, and reported the shortfall as a
cost reduction — every service appeared to be getting cheaper, every month,
until the month ended. It was not a rounding problem or an edge case: for
roughly 29 days out of every 30 the headline figure was wrong in the same
direction, which is worse than being wrong at random because it is persuasive.

Two things fix it. Compare equal numbers of elapsed days, and put both date
ranges on screen so the reader can check the comparison rather than trust it.
`Aug 1-27 vs Jul 1-27` is a sentence somebody can disagree with; "vs last
month" is not.
"""
from datetime import date, timedelta
from typing import Any, Dict, Optional, Tuple

COMPARE_PREVIOUS_PERIOD = "previous_period"
COMPARE_PREVIOUS_MONTH = "previous_month"
COMPARE_SAME_MONTH_LAST_YEAR = "same_month_last_year"


def _shift_months(value: date, months: int) -> date:
    """Move a date by whole months, clamping to the end of a shorter month."""
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    # 31 March minus one month is 28 or 29 February, not "31 February".
    last_day = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(value.day, last_day))


def month_bounds(anchor: date) -> Tuple[date, date]:
    start = anchor.replace(day=1)
    end = _shift_months(start, 1) - timedelta(days=1)
    return start, end


def is_partial(period_end: date, today: date) -> bool:
    """True when the window runs past today and so is still being billed into."""
    return period_end >= today


def comparison_window(
    current_start: date,
    current_end: date,
    mode: str,
    today: Optional[date] = None,
) -> Tuple[date, date]:
    """
    The window to compare against, trimmed to the same number of elapsed days.

    The trim is the whole point. Without it an incomplete current period is
    measured against a complete previous one, and the missing days read as a
    saving that nobody made.
    """
    today = today or date.today()
    # Only days that have actually been billed count towards the length. A
    # window ending in the future has not happened yet.
    effective_end = min(current_end, today)
    elapsed = (effective_end - current_start).days

    if mode == COMPARE_PREVIOUS_MONTH:
        prev_start = _shift_months(current_start.replace(day=1), -1)
    elif mode == COMPARE_SAME_MONTH_LAST_YEAR:
        prev_start = _shift_months(current_start, -12)
    else:
        # A window of the same length, immediately before this one.
        prev_start = current_start - timedelta(days=elapsed + 1)

    prev_month_end = month_bounds(prev_start)[1]
    prev_end = prev_start + timedelta(days=max(elapsed, 0))

    if mode in (COMPARE_PREVIOUS_MONTH, COMPARE_SAME_MONTH_LAST_YEAR):
        # Never run past the end of the month being compared against: 31 days
        # of elapsed January must not borrow days from February.
        prev_end = min(prev_end, prev_month_end)

    return prev_start, prev_end


def describe(
    current_start: date,
    current_end: date,
    mode: str = COMPARE_PREVIOUS_PERIOD,
    today: Optional[date] = None,
) -> Dict[str, Any]:
    """
    Both windows, plus the sentence explaining them.

    Returned as data rather than rendered text so the page can lay it out, but
    the wording lives here so every surface says the same thing.
    """
    today = today or date.today()
    prev_start, prev_end = comparison_window(current_start, current_end, mode, today)
    partial = is_partial(current_end, today)
    effective_end = min(current_end, today)

    note = ""
    if partial:
        note = (
            f"The current period is still in progress. It is compared against "
            f"the same number of days in the previous period "
            f"({prev_start.isoformat()} to {prev_end.isoformat()}) so the "
            f"comparison is like for like."
        )

    return {
        "current_start": current_start.isoformat(),
        "current_end": current_end.isoformat(),
        # What was actually measured, which on a partial month is not the same
        # as what was asked for.
        "current_effective_end": effective_end.isoformat(),
        "previous_start": prev_start.isoformat(),
        "previous_end": prev_end.isoformat(),
        "comparison": mode,
        "partial": partial,
        "days_compared": (effective_end - current_start).days + 1,
        "note": note,
    }
