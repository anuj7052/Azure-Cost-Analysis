from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True, slots=True)
class Period:
    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


def month_to_date(today: date | None = None) -> Period:
    today = today or date.today()
    return Period(today.replace(day=1), today)


def full_month(today: date | None = None) -> Period:
    today = today or date.today()
    last = calendar.monthrange(today.year, today.month)[1]
    return Period(today.replace(day=1), today.replace(day=last))


def previous_month(today: date | None = None) -> Period:
    today = today or date.today()
    end = today.replace(day=1) - timedelta(days=1)
    return Period(end.replace(day=1), end)


def last_n_days(n: int, today: date | None = None) -> Period:
    today = today or date.today()
    return Period(today - timedelta(days=n - 1), today)


def run_rate_forecast(month_to_date_cost: float, today: date | None = None) -> float:
    """Linear projection used when the Azure forecast API returns nothing."""
    today = today or date.today()
    elapsed = today.day
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    if elapsed == 0:
        return 0.0
    return round(month_to_date_cost / elapsed * days_in_month, 2)
