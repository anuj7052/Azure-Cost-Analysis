"""
Daily exchange rates, and what they explain.

Microsoft prices every Azure meter in USD. Every other currency shown by the
Retail Prices API, the pricing calculator and the invoice is a conversion of
that dollar figure. So a rupee unit rate can move by several percent in a month
while the underlying product price never changed at all — and telling a customer
"Azure put the price up" when the dollar moved is simply wrong.

This separates the two. Given a rate in local currency at two points in time and
the dollar rate on those days, the movement splits into:

  * the part explained by the exchange rate, and
  * the part left over, which is a real change to the product price.

Rates come from Frankfurter (https://frankfurter.dev), which republishes the
European Central Bank's daily reference rates. It needs no key and no account,
which matters because this has to work on a fresh install with nothing
configured.

The ECB publishes on working days only. Weekends and holidays have no rate at
all, so a missing day is carried forward from the last published one — which is
also what actually happens commercially, since a weekend transaction settles at
the previous working day's reference rate.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

import aiosqlite
import httpx

log = logging.getLogger(__name__)

FRANKFURTER_URL = "https://api.frankfurter.dev/v1"
SOURCE = "frankfurter/ecb"

# Azure's own pricing currency. Everything else is a conversion of it.
BASE = "USD"


def _iso(value: date) -> str:
    return value.isoformat()


def month_bounds(month: str) -> tuple[date, date]:
    """
    First and last day of a "YYYY-MM" month.

    A month in progress is truncated to today: asking for rates that have not
    been published yet returns nothing and reads as a gap in the data rather
    than as the future.
    """
    start = datetime.strptime(f"{month}-01", "%Y-%m-%d").date()
    if start.month == 12:
        end = date(start.year + 1, 1, 1) - timedelta(days=1)
    else:
        end = date(start.year, start.month + 1, 1) - timedelta(days=1)
    return start, min(end, date.today())


async def _stored(
    db: aiosqlite.Connection, quote: str, start: date, end: date
) -> Dict[str, float]:
    async with db.execute(
        """
        SELECT rate_day, rate FROM fx_rates
         WHERE base = ? AND quote = ? AND rate_day BETWEEN ? AND ?
         ORDER BY rate_day
        """,
        (BASE, quote, _iso(start), _iso(end)),
    ) as cursor:
        return {row["rate_day"]: row["rate"] for row in await cursor.fetchall()}


async def _store(db: aiosqlite.Connection, quote: str, rates: Dict[str, float]) -> None:
    await db.executemany(
        """
        INSERT INTO fx_rates (base, quote, rate_day, rate, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (base, quote, rate_day) DO UPDATE SET
            rate = excluded.rate, source = excluded.source
        """,
        [(BASE, quote, day, rate, SOURCE) for day, rate in rates.items()],
    )
    await db.commit()


async def _fetch(quote: str, start: date, end: date, timeout: float = 20.0) -> Dict[str, float]:
    """Published rates for a date range, keyed by day."""
    url = f"{FRANKFURTER_URL}/{_iso(start)}..{_iso(end)}"
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(url, params={"base": BASE, "symbols": quote})
        response.raise_for_status()
        payload = response.json()

    return {
        day: values[quote]
        for day, values in (payload.get("rates") or {}).items()
        if quote in values
    }


def _fill_forward(rates: Dict[str, float], start: date, end: date) -> List[Dict[str, Any]]:
    """
    One entry per calendar day, carrying the last published rate into gaps.

    The gaps are weekends and public holidays. Leaving them blank makes a chart
    look like the currency stopped existing, and interpolating would invent a
    rate nobody transacted at; carrying forward is what actually happens.
    """
    series: List[Dict[str, Any]] = []
    last: Optional[float] = None
    day = start

    while day <= end:
        key = _iso(day)
        published = rates.get(key)
        if published is not None:
            last = published
        if last is not None:
            series.append({
                "day": key,
                "rate": round(last, 6),
                "published": published is not None,
            })
        day += timedelta(days=1)

    return series


async def daily_rates(
    db: aiosqlite.Connection, quote: str, month: str
) -> Dict[str, Any]:
    """
    Every day's USD rate for a month, from the store, topped up from the ECB.

    Reads the store first. Historical reference rates never change once
    published, so a day already recorded is never fetched again — which keeps a
    panel that opens on every rate click from hitting an external API each time.
    """
    quote = (quote or "").upper()
    if quote == BASE:
        return {
            "base": BASE, "quote": BASE, "month": month, "series": [],
            "source": None,
            "note": "Azure prices in US dollars, so no conversion applies.",
        }

    start, end = month_bounds(month)
    if start > end:
        return {"base": BASE, "quote": quote, "month": month, "series": [],
                "source": SOURCE, "note": "That month has not started yet."}

    stored = await _stored(db, quote, start, end)

    # The ECB skips roughly two days in seven, so "fewer rows than days" is
    # normal and is not evidence of a gap. Refetching only when the newest
    # working day is missing avoids a request per page view.
    expected_working_days = sum(
        1 for i in range((end - start).days + 1)
        if (start + timedelta(days=i)).weekday() < 5
    )
    note = None
    if len(stored) < expected_working_days:
        try:
            fetched = await _fetch(quote, start, end)
            if fetched:
                await _store(db, quote, fetched)
                stored.update(fetched)
        except Exception as exc:
            log.warning("Could not fetch %s rates for %s: %s", quote, month, exc)
            if not stored:
                # A missing rate is not a zero rate. Saying so is the only
                # honest option — a conversion drawn from nothing would be
                # presented with the same confidence as a real one.
                note = (
                    "Exchange rates could not be read, so the currency effect "
                    "cannot be separated from the product price here."
                )

    return {
        "base": BASE,
        "quote": quote,
        "month": month,
        "series": _fill_forward(stored, start, end),
        "source": SOURCE,
        "source_url": "https://frankfurter.dev",
        "note": note,
    }


async def latest_rates(
    db: aiosqlite.Connection, quotes: List[str]
) -> Dict[str, Any]:
    """
    Today's USD rate for each of several currencies, in one read.

    This exists for the display-currency switch, which needs to convert money
    that Azure billed in one currency into whichever one the reader chose. That
    is a different question from `daily_rates`: it wants one number per
    currency, right now, for a handful of currencies at once — not a month of
    daily history for one of them.

    The rate is deliberately a single current one rather than a per-month
    historical rate. A converted figure is an indication of scale in a familiar
    unit, not a restatement of the invoice, and pretending otherwise by mixing
    a dozen historical rates into one total would produce a number that
    reconciles against nothing at all. `as_of` and `stale` are returned so the
    UI can say exactly that.

    A currency whose rate could not be established is simply absent from
    `rates`. It is never defaulted to 1.0, which would silently report dollars
    as rupees.
    """
    wanted = [q.upper() for q in quotes if q and q.upper() != BASE]
    out: Dict[str, float] = {BASE: 1.0}
    if not wanted:
        return {"base": BASE, "rates": out, "as_of": _iso(date.today()),
                "source": SOURCE, "stale": False, "note": None}

    today = date.today()
    fetched: Dict[str, float] = {}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{FRANKFURTER_URL}/latest",
                params={"base": BASE, "symbols": ",".join(sorted(set(wanted)))},
            )
            response.raise_for_status()
            payload = response.json()
        day = payload.get("date") or _iso(today)
        fetched = {
            quote.upper(): float(rate)
            for quote, rate in (payload.get("rates") or {}).items()
        }
        for quote, rate in fetched.items():
            await _store(db, quote, {day: rate})
    except Exception as exc:
        log.warning("Could not fetch latest FX rates: %s", exc)

    out.update(fetched)

    # Whatever the ECB did not answer for, fall back to the newest rate already
    # recorded. A rate from last week converts far better than no rate at all,
    # provided the page says how old it is.
    stale_from: Optional[str] = None
    missing = [q for q in wanted if q not in out]
    for quote in missing:
        row = await db.execute(
            "SELECT rate_day, rate FROM fx_rates WHERE base = ? AND quote = ? "
            "ORDER BY rate_day DESC LIMIT 1",
            (BASE, quote),
        )
        found = await row.fetchone()
        if found:
            out[quote] = float(found[1])
            stale_from = max(stale_from or "", str(found[0]))

    unresolved = [q for q in wanted if q not in out]
    return {
        "base": BASE,
        "rates": out,
        "as_of": _iso(today) if fetched else (stale_from or _iso(today)),
        "source": SOURCE,
        "source_url": "https://frankfurter.dev",
        "stale": not fetched,
        "note": (
            f"No exchange rate is available for {', '.join(unresolved)}, so "
            "amounts billed in it are left in their own currency."
            if unresolved else None
        ),
    }


def summarise(series: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Opening, closing, extremes and net movement of a daily rate series."""
    if not series:
        return {}

    first, last = series[0], series[-1]
    values = [point["rate"] for point in series]
    change = last["rate"] - first["rate"]

    return {
        "first_day": first["day"],
        "first_rate": first["rate"],
        "last_day": last["day"],
        "last_rate": last["rate"],
        "high": max(values),
        "low": min(values),
        "average": round(sum(values) / len(values), 6),
        "change": round(change, 6),
        "percent": round(change / first["rate"] * 100, 4) if first["rate"] else None,
    }


async def average_for_month(
    db: aiosqlite.Connection, quote: str, month: str
) -> Optional[float]:
    """
    The month's mean rate.

    A month's charges accrue across all its days, so the rate that converted
    them is closer to the month's average than to any single day's. Using the
    closing rate would attribute a whole month of movement to the last day.
    """
    data = await daily_rates(db, quote, month)
    series = data.get("series") or []
    if not series:
        return None
    return round(sum(p["rate"] for p in series) / len(series), 6)


def split_movement(
    old_rate_local: Optional[float],
    new_rate_local: Optional[float],
    old_fx: Optional[float],
    new_fx: Optional[float],
) -> Dict[str, Any]:
    """
    Attribute a local-currency rate movement to currency versus product price.

    Because a local price is `usd_price × fx`, holding the dollar price constant
    and moving only the exchange rate gives the currency's contribution. What is
    left is the product price moving, expressed in local currency so it can be
    added straight back to the other half.

    Returns `verdict: "unknown"` rather than guessing when a rate is missing.
    Attributing a movement to the dollar without knowing the dollar rate would
    produce a confident, checkable, wrong statement — the worst kind.
    """
    if old_rate_local is None or new_rate_local is None:
        return {"verdict": "unknown", "reason": "One of the two unit rates is missing."}

    total = new_rate_local - old_rate_local

    if not old_fx or not new_fx:
        return {
            "verdict": "unknown",
            "total": round(total, 8),
            "reason": "Exchange rates for these periods are not available.",
        }

    old_usd = old_rate_local / old_fx
    # Same dollar price, new exchange rate: everything this contributes is the
    # currency, by construction.
    fx_only = old_usd * new_fx
    currency_effect = fx_only - old_rate_local
    price_effect = new_rate_local - fx_only
    new_usd = new_rate_local / new_fx

    if abs(total) < 1e-12:
        verdict = "flat"
    elif abs(price_effect) < abs(currency_effect) * 0.2:
        verdict = "currency"
    elif abs(currency_effect) < abs(price_effect) * 0.2:
        verdict = "price"
    else:
        verdict = "both"

    return {
        "verdict": verdict,
        "total": round(total, 8),
        "currency_effect": round(currency_effect, 8),
        "price_effect": round(price_effect, 8),
        "old_usd": round(old_usd, 8),
        "new_usd": round(new_usd, 8),
        "usd_change_percent": round((new_usd - old_usd) / old_usd * 100, 4) if old_usd else None,
        "fx_change_percent": round((new_fx - old_fx) / old_fx * 100, 4) if old_fx else None,
        "old_fx": old_fx,
        "new_fx": new_fx,
    }
