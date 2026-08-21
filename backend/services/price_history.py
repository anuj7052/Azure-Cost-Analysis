"""
Microsoft's published prices, remembered.

The Retail Prices API answers one question only: what is this meter's list price
*right now*. There is no history endpoint, no "as at" parameter, and no archive.
So "did Microsoft put this up?" — the question everyone asks the moment a unit
rate moves — is unanswerable unless the earlier reading was written down at the
time. Once a reading is missed it cannot be recovered from Microsoft at any
later date.

That makes this store append-only and deliberately greedy. Every price the app
reads for any reason is recorded, including prices nobody asked about, because
the value of a reading is only realised months later when something moves and
there is a baseline to compare against.

Two tables, because they answer different questions at different frequencies:

  * `price_snapshots` — every reading, with the untouched response body. Written
    constantly, read rarely.
  * `price_changes` — the readings where the price differed from the one before.
    Written rarely, read constantly.

The second is derivable from the first, but only by scanning and diffing every
reading of a meter. Materialising the rare event once at write time is cheaper
than recomputing it on every view.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import aiosqlite

log = logging.getLogger(__name__)

# Below this, a difference is floating-point noise or a rounding change in
# Microsoft's own output, not a repricing. Reporting those as price changes
# would bury the real ones.
MIN_RELATIVE_CHANGE = 1e-9


def _key(item: Dict[str, Any]) -> tuple:
    """
    What identifies a meter across readings.

    `meterId` alone is not enough: the same meter is returned once per currency
    and once per price type (consumption, reservation, savings plan), and those
    are different prices that must not be diffed against each other.
    """
    return (
        item.get("meter_id") or "",
        (item.get("currency") or "USD").upper(),
        item.get("price_type") or "",
    )


async def _latest(
    db: aiosqlite.Connection, meter_id: str, currency: str, price_type: str
) -> Optional[aiosqlite.Row]:
    async with db.execute(
        """
        SELECT retail_price, observed_at
          FROM price_snapshots
         WHERE meter_id = ? AND currency = ? AND price_type = ?
         ORDER BY observed_at DESC, id DESC
         LIMIT 1
        """,
        (meter_id, currency, price_type),
    ) as cursor:
        return await cursor.fetchone()


async def record_prices(
    db: aiosqlite.Connection,
    prices: List[Dict[str, Any]],
    raw_items: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, int]:
    """
    Record a batch of readings and note any that moved.

    Never raises. Recording history is a side effect of answering a price
    question, and failing the user's request because a bookkeeping write failed
    would trade the thing they asked for against the thing they did not.

    Returns counts so a caller can log or surface them, not because anything
    depends on them.
    """
    raw_by_meter: Dict[str, Dict[str, Any]] = {}
    for raw in raw_items or []:
        meter = raw.get("meterId") or ""
        if meter:
            raw_by_meter.setdefault(f"{meter}|{raw.get('type', '')}", raw)

    recorded = 0
    changed = 0

    try:
        for item in prices:
            meter_id, currency, price_type = _key(item)
            if not meter_id:
                # Without a stable identity a reading cannot be compared to
                # anything later, so storing it would only grow the table.
                continue

            price = item.get("retail_price")
            if price is None:
                continue

            previous = await _latest(db, meter_id, currency, price_type)
            raw = raw_by_meter.get(f"{meter_id}|{price_type}") or item

            await db.execute(
                """
                INSERT INTO price_snapshots (
                    meter_id, sku_id, product_id, service_name, product_name,
                    sku_name, arm_sku_name, meter_name, arm_region, currency,
                    price_type, unit_of_measure, retail_price, unit_price,
                    effective_from, raw
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    meter_id,
                    item.get("sku_id") or "",
                    item.get("product_id") or "",
                    item.get("service_name") or "",
                    item.get("product_name") or "",
                    item.get("sku_name") or "",
                    item.get("arm_sku_name") or "",
                    item.get("meter_name") or "",
                    item.get("region") or "",
                    currency,
                    price_type,
                    item.get("unit_of_measure") or "",
                    price,
                    item.get("unit_price"),
                    item.get("effective_from") or "",
                    json.dumps(raw, default=str),
                ),
            )
            recorded += 1

            if previous is None or previous["retail_price"] is None:
                continue

            old = float(previous["retail_price"])
            if old == price:
                continue
            if old and abs(price - old) / abs(old) < MIN_RELATIVE_CHANGE:
                continue

            await db.execute(
                """
                INSERT INTO price_changes (
                    meter_id, currency, price_type, service_name, meter_name,
                    arm_region, old_price, new_price, direction, percent,
                    previous_at, effective_from
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    meter_id,
                    currency,
                    price_type,
                    item.get("service_name") or "",
                    item.get("meter_name") or "",
                    item.get("region") or "",
                    old,
                    price,
                    "up" if price > old else "down",
                    round((price - old) / old * 100, 4) if old else None,
                    previous["observed_at"],
                    item.get("effective_from") or "",
                ),
            )
            changed += 1

        await db.commit()
    except Exception as exc:  # pragma: no cover - bookkeeping must not break reads
        log.warning("Could not record price history: %s", exc)
        return {"recorded": recorded, "changed": changed, "failed": 1}

    return {"recorded": recorded, "changed": changed, "failed": 0}


async def series_for_meter(
    db: aiosqlite.Connection,
    meter_id: str,
    currency: str = "USD",
    price_type: str = "Consumption",
    limit: int = 400,
) -> List[Dict[str, Any]]:
    """
    Every distinct price this meter has been observed at, oldest first.

    Consecutive identical readings are collapsed: a meter read daily for a year
    at an unchanged price is one line on a chart, not three hundred and
    sixty-five, and the repetition tells the reader nothing.
    """
    async with db.execute(
        """
        SELECT retail_price, observed_at, effective_from, unit_of_measure
          FROM price_snapshots
         WHERE meter_id = ? AND currency = ? AND price_type = ?
         ORDER BY observed_at ASC, id ASC
         LIMIT ?
        """,
        (meter_id, currency.upper(), price_type, limit),
    ) as cursor:
        rows = await cursor.fetchall()

    series: List[Dict[str, Any]] = []
    for row in rows:
        price = row["retail_price"]
        if series and series[-1]["price"] == price:
            series[-1]["observed_until"] = row["observed_at"]
            continue
        series.append({
            "price": price,
            "observed_at": row["observed_at"],
            "observed_until": row["observed_at"],
            "effective_from": row["effective_from"],
            "unit_of_measure": row["unit_of_measure"],
        })
    return series


async def changes_for_meter(
    db: aiosqlite.Connection,
    meter_id: str,
    currency: str = "USD",
    price_type: str = "Consumption",
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Times this meter was repriced, most recent first."""
    async with db.execute(
        """
        SELECT old_price, new_price, direction, percent, previous_at,
               changed_at, effective_from
          FROM price_changes
         WHERE meter_id = ? AND currency = ? AND price_type = ?
         ORDER BY changed_at DESC, id DESC
         LIMIT ?
        """,
        (meter_id, currency.upper(), price_type, limit),
    ) as cursor:
        return [dict(row) for row in await cursor.fetchall()]


async def timeline_for_meter(
    db: aiosqlite.Connection,
    meter_id: str,
    currency: str = "USD",
    price_type: str = "Consumption",
    years: int = 3,
    effective_from: Optional[str] = None,
) -> Dict[str, Any]:
    """
    A dated account of this meter's price over the last `years` years.

    Microsoft publishes no price history. The Retail Prices API returns one row
    per meter carrying only today's price, so the honest answer to "when did
    this go up" is assembled from two sources and neither is complete on its
    own:

      * `effectiveStartDate` — Microsoft's own statement of when the current
        price took effect. It is one dated fact, and usually the *oldest* one
        available: a meter effective since 2021 has not been repriced since,
        which is itself the answer to the question.
      * this installation's own readings — every price observed since it
        started watching, and every time one moved.

    Between the two there is a gap: the years before observation began and
    after the effective date, where a price could have moved and back again
    unseen. That gap is returned as data rather than papered over, because a
    timeline that looks complete and is not will be read as "Microsoft never
    changed this", which is a claim nobody here can make.
    """
    horizon = (datetime.now(timezone.utc) - timedelta(days=365 * years)).strftime("%Y-%m-%d")

    changes = await changes_for_meter(db, meter_id, currency, price_type, limit=500)
    series = await series_for_meter(db, meter_id, currency, price_type)

    events: List[Dict[str, Any]] = []

    # Microsoft's own dated anchor, when it falls inside the window.
    effective = effective_from or (series[0]["effective_from"] if series else None)
    if effective:
        day = str(effective)[:10]
        events.append({
            "day": day,
            "kind": "effective",
            "direction": None,
            "price": series[0]["price"] if series else None,
            "source": "Microsoft — effectiveStartDate",
            "detail": "Microsoft's published price for this meter took effect on this date.",
            "in_window": day >= horizon,
        })

    for change in changes:
        day = str(change.get("changed_at") or "")[:10]
        if day < horizon:
            continue
        events.append({
            "day": day,
            "kind": "change",
            "direction": change.get("direction"),
            "old_price": change.get("old_price"),
            "price": change.get("new_price"),
            "percent": change.get("percent"),
            "effective_from": str(change.get("effective_from") or "")[:10],
            "previous_reading": str(change.get("previous_at") or "")[:16],
            "source": "Observed here",
            "detail": (
                f"Microsoft's published price went {change.get('direction')} "
                f"from {change.get('old_price')} to {change.get('new_price')}."
            ),
            "in_window": True,
        })

    events.sort(key=lambda e: e["day"], reverse=True)

    watching_since = series[0]["observed_at"][:10] if series else None
    return {
        "years": years,
        "from_day": horizon,
        "events": events,
        "effective_from": str(effective)[:10] if effective else None,
        # When observation began for *this* meter, not for the store as a whole.
        "watching_since": watching_since,
        # The stretch inside the requested window that nothing can speak for.
        "unobserved_from": horizon,
        "unobserved_to": watching_since,
        "unobserved": bool(watching_since and watching_since > horizon),
        "distinct_prices": len(series),
    }


async def recent_changes(
    db: aiosqlite.Connection,
    currency: str = "USD",
    direction: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """Everything that was repriced lately, across all meters."""
    sql = [
        "SELECT meter_id, service_name, meter_name, arm_region, old_price,",
        "       new_price, direction, percent, changed_at, effective_from",
        "  FROM price_changes WHERE currency = ?",
    ]
    params: List[Any] = [currency.upper()]
    if direction in {"up", "down"}:
        sql.append("AND direction = ?")
        params.append(direction)
    sql.append("ORDER BY changed_at DESC, id DESC LIMIT ?")
    params.append(limit)

    async with db.execute(" ".join(sql), params) as cursor:
        return [dict(row) for row in await cursor.fetchall()]


async def coverage(db: aiosqlite.Connection) -> Dict[str, Any]:
    """
    How much history exists.

    A price chart drawn from two days of readings looks the same as one drawn
    from two years, so the extent of what is known has to be stated alongside
    it — otherwise "no change" reads as a fact about Azure rather than a fact
    about how long we have been watching.
    """
    async with db.execute(
        """
        SELECT COUNT(*) AS readings,
               COUNT(DISTINCT meter_id) AS meters,
               MIN(observed_at) AS first_seen,
               MAX(observed_at) AS last_seen
          FROM price_snapshots
        """
    ) as cursor:
        row = await cursor.fetchone()

    async with db.execute("SELECT COUNT(*) AS n FROM price_changes") as cursor:
        changes = (await cursor.fetchone())["n"]

    return {
        "readings": row["readings"] or 0,
        "meters": row["meters"] or 0,
        "first_seen": row["first_seen"],
        "last_seen": row["last_seen"],
        "changes": changes,
    }
