"""
Durable storage for Cost Management answers.

The Query API is the most aggressively throttled thing this application
touches, and it was the only expensive read with nowhere permanent to land.
The estate goes into `scan_resources`, list prices go into `price_snapshots`,
but a bill lived in a process dictionary mirrored to a JSON file in the system
temp directory. On App Service that directory is emptied on restart and is not
shared between instances, so in the deployment that actually matters the cache
was per-process and per-deploy: every release, every scale event and every idle
timeout sent the whole estate back to Azure from cold.

The idea this module is built around is that most of what we re-ask for cannot
have changed. Azure finalises a period and then stops amending it, so a query
for March asked in August will return exactly the same numbers today, tomorrow
and next year. Treating that identically to "this month so far" -- a flat ten
minute expiry over both -- meant the majority of every refresh was spent
re-downloading immutable history, and it was that traffic, not the live month,
that spent the rate limit.

So a window that Azure has finished with is kept until the cache needs the
room, and only the window still moving is short-lived.

What this deliberately does not do is interpret the payload. It stores whatever
the client fetched, keyed by the exact request, and hands the same bytes back.
Cost rows are the thing this product is trusted to report accurately, and a
cache that reshapes, merges or partially refreshes them is a place for numbers
to go quietly wrong. Splitting one query's window across a stored half and a
fetched half is exactly that kind of cleverness, and it is not worth it: the
throttle is counted per request, so half a window costs the same call as all
of it.
"""
from __future__ import annotations

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import aiosqlite

import core.db as db_module
from core.config import settings

logger = logging.getLogger(__name__)

# How long Azure keeps amending a period after it ends.
#
# Usage records arrive late -- a resource that ran on the 1st can post charges
# on the 3rd -- so "the window has ended" and "the window is final" are not the
# same day. Three days is the conservative reading of Azure's own guidance that
# data settles within 72 hours. Being wrong in this direction is cheap: the
# window is merely re-fetched a little longer than it needed to be. Being wrong
# the other way would pin a half-complete month in the cache for a month, which
# is the one failure this cache must not have.
SETTLING_DAYS = int(os.getenv("COST_CACHE_SETTLING_DAYS") or 3)

# A settled window is immutable, so this is a housekeeping bound rather than a
# correctness one -- it caps how long a row nobody asks for takes up space.
SETTLED_TTL_SECONDS = int(os.getenv("COST_CACHE_SETTLED_TTL") or 30 * 24 * 60 * 60)

# The still-moving window.
#
# Thirty minutes rather than the ten it used to be, for two reasons. Azure
# refreshes most subscriptions every few hours, so ten minutes was buying
# freshness that did not exist upstream. And the browser revalidates its own
# copy at fifteen minutes: with a ten minute server TTL every one of those
# background refreshes was guaranteed to find an expired entry and go to Azure,
# which made the two caches combine into no cache at all for anyone who left a
# tab open.
OPEN_TTL_SECONDS = int(os.getenv("COST_CACHE_OPEN_TTL") or 30 * 60)

# Kept usable well past expiry so a throttled or offline refresh still renders
# real numbers instead of an empty dashboard.
STALE_TTL_SECONDS = int(os.getenv("COST_CACHE_STALE_TTL") or 7 * 24 * 60 * 60)

# Rows are JSON blobs of unbounded width. A very large estate can produce a
# single response of many megabytes, and writing that on every query would
# trade an API limit for a disk one. Oversized answers stay in the in-process
# cache and simply are not persisted.
MAX_PAYLOAD_BYTES = int(os.getenv("COST_CACHE_MAX_PAYLOAD") or 4 * 1024 * 1024)
MAX_ROWS = int(os.getenv("COST_CACHE_MAX_ROWS") or 2000)

_AZURE_TIME = "%Y-%m-%dT%H:%M:%SZ"


def window_end(body: dict) -> datetime | None:
    """
    The last instant a query asks about, or None when it does not say.

    A body without an explicit period is using an Azure-relative timeframe such
    as MonthToDate, which by definition includes now and can therefore never be
    treated as settled.
    """
    period = (body or {}).get("timePeriod") or {}
    raw = period.get("to")
    if not raw:
        return None
    text = str(raw).strip()
    for fmt in (_AZURE_TIME, "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    # An unparseable period is not a reason to fail a cost query; it only means
    # this entry has to be treated as live.
    logger.debug("Unrecognised cost query period: %r", raw)
    return None


def is_settled(body: dict, now: datetime | None = None) -> bool:
    """Whether Azure has finished amending every day this query covers."""
    end = window_end(body)
    if end is None:
        return False
    now = now or datetime.now(timezone.utc)
    return end < now - timedelta(days=SETTLING_DAYS)


def ttl_for(body: dict, now: datetime | None = None) -> float:
    """How long an answer to this query may be served as fresh."""
    return SETTLED_TTL_SECONDS if is_settled(body, now) else OPEN_TTL_SECONDS


def scope_of(url: str) -> str:
    """
    The subscription a query was aimed at, for pruning and for support.

    Best effort and cosmetic -- nothing reads this back to decide what a caller
    is allowed to see. Isolation comes from the cache key, which is a hash of
    the full URL and body, so two tenants cannot collide on one entry.
    """
    marker = "/subscriptions/"
    if marker not in url:
        return ""
    return url.split(marker, 1)[1].split("/", 1)[0]


@asynccontextmanager
async def _connect():
    """
    A short-lived connection, opened the way `get_db` opens one.

    This runs underneath the router layer, where there is no request-scoped
    connection to borrow, and threading one through the twenty call sites that
    reach the cost client would be a much larger change than the caching is.
    """
    if settings.DB_BACKEND == "postgres":
        from core import pg, pg_auth

        raw = await pg_auth.connect(settings.DATABASE_URL)
        try:
            yield pg.Connection(raw)
        finally:
            await raw.close()
        return

    # A short busy timeout rather than the default of zero: cost queries finish
    # in parallel and would otherwise collide on the write lock. Caching is
    # best effort, so waiting briefly is right and waiting long is not.
    #
    # The path is read from core.db at call time rather than captured at import
    # so that it follows the same override every other database user follows.
    async with aiosqlite.connect(db_module.DB_PATH, timeout=5.0) as db:
        db.row_factory = aiosqlite.Row
        yield db


async def load(key: str) -> tuple[Any, bool] | None:
    """
    Return `(payload, fresh)` for a key, or None when nothing usable is stored.

    `fresh` distinguishes an answer good enough to serve directly from one that
    is only good enough to fall back on when Azure will not answer at all. The
    caller decides which of those it wants; both beat an empty dashboard.
    """
    try:
        async with _connect() as db:
            async with db.execute(
                "SELECT payload, expires_at, stored_at FROM cost_cache WHERE cache_key = ?",
                (key,),
            ) as cursor:
                row = await cursor.fetchone()
    except Exception as exc:
        # A cache that cannot be read must never be a cache that breaks the
        # page. Falling through to Azure is always a correct outcome here.
        logger.debug("Cost cache read failed: %s", exc)
        return None

    if not row:
        return None

    now = time.time()
    if now - (row["stored_at"] or 0) > STALE_TTL_SECONDS:
        return None
    try:
        return json.loads(row["payload"]), (row["expires_at"] or 0) > now
    except ValueError:
        return None


async def store(key: str, payload: Any, *, url: str, body: dict) -> None:
    """Persist an answer. Failure is logged and otherwise ignored."""
    try:
        encoded = json.dumps(payload, default=str)
    except (TypeError, ValueError) as exc:
        logger.debug("Cost payload not serialisable: %s", exc)
        return

    if len(encoded) > MAX_PAYLOAD_BYTES:
        logger.debug("Cost payload too large to persist (%d bytes)", len(encoded))
        return

    settled = is_settled(body)
    now = time.time()
    end = window_end(body)
    record = (
        key,
        scope_of(url),
        end.strftime("%Y-%m-%d") if end else "",
        encoded,
        1 if settled else 0,
        now,
        now + (SETTLED_TTL_SECONDS if settled else OPEN_TTL_SECONDS),
    )

    try:
        async with _connect() as db:
            # Portable upsert: both engines accept ON CONFLICT on a primary key,
            # and the alternative -- delete then insert -- leaves a window where
            # a concurrent reader sees no cached answer at all.
            await db.execute(
                """
                INSERT INTO cost_cache
                    (cache_key, scope, period_to, payload, settled, stored_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (cache_key) DO UPDATE SET
                    scope      = excluded.scope,
                    period_to  = excluded.period_to,
                    payload    = excluded.payload,
                    settled    = excluded.settled,
                    stored_at  = excluded.stored_at,
                    expires_at = excluded.expires_at
                """,
                record,
            )
            await db.commit()
    except Exception as exc:
        logger.debug("Cost cache write failed: %s", exc)


async def prune() -> int:
    """
    Drop what is no longer worth keeping. Returns the number of rows removed.

    Two passes with different reasoning. Anything past the stale horizon is
    useless to everyone and goes regardless. Beyond that the table is trimmed
    to a row count, evicting unsettled rows first: a live window will be
    re-fetched within the hour anyway, whereas a settled one is a call that
    never has to happen again.
    """
    cutoff = time.time() - STALE_TTL_SECONDS
    removed = 0
    try:
        async with _connect() as db:
            cursor = await db.execute("DELETE FROM cost_cache WHERE stored_at < ?", (cutoff,))
            removed += cursor.rowcount or 0

            async with db.execute("SELECT COUNT(*) AS n FROM cost_cache") as counter:
                row = await counter.fetchone()
            total = (row["n"] if row else 0) or 0

            if total > MAX_ROWS:
                cursor = await db.execute(
                    """
                    DELETE FROM cost_cache WHERE cache_key IN (
                        SELECT cache_key FROM cost_cache
                        ORDER BY settled ASC, stored_at ASC
                        LIMIT ?
                    )
                    """,
                    (total - MAX_ROWS,),
                )
                removed += cursor.rowcount or 0
            await db.commit()
    except Exception as exc:
        logger.debug("Cost cache prune failed: %s", exc)
        return removed
    return removed


async def stats() -> dict:
    """Counts for the admin view, so the cache can be seen rather than guessed at."""
    try:
        async with _connect() as db:
            async with db.execute(
                """
                SELECT COUNT(*) AS rows_total,
                       SUM(CASE WHEN settled = 1 THEN 1 ELSE 0 END) AS settled_rows,
                       SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS fresh_rows
                FROM cost_cache
                """,
                (time.time(),),
            ) as cursor:
                row = await cursor.fetchone()
    except Exception as exc:
        logger.debug("Cost cache stats failed: %s", exc)
        return {"rows": 0, "settled": 0, "fresh": 0, "available": False}

    return {
        "rows": (row["rows_total"] if row else 0) or 0,
        "settled": (row["settled_rows"] if row else 0) or 0,
        "fresh": (row["fresh_rows"] if row else 0) or 0,
        "available": True,
    }
