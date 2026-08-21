"""
Search across the estate, including resources that no longer exist.

Searching what is live is the easy half and Azure already does it. The half that
matters here is the deleted resource: "there was a VM called api-prod-03, when
did it disappear?" is unanswerable in the portal, and is exactly the question
asked during an incident or an audit.

A resource is treated as deleted when it appears in some earlier scan but not in
the latest completed one. That definition is only trustworthy because
`latest_scan_id` ignores partial scans — comparing against a half-finished
capture would report most of the estate as deleted.
"""
import json
from typing import Any, Dict, List

import aiosqlite

from services.scanner import latest_scan_id

# One query returning several hundred rows is already past the point where a
# person reads them; beyond that the cost is all in transfer and rendering.
MAX_RESULTS = 200


def _row_to_resource(row: aiosqlite.Row, live: bool) -> Dict[str, Any]:
    try:
        tags = json.loads(row["tags"] or "{}")
    except ValueError:
        tags = {}

    return {
        "resource_id": row["resource_id"],
        "name": row["name"],
        "type": row["type"],
        "resource_group": row["resource_group"],
        "subscription_id": row["subscription_id"],
        "location": row["location"],
        "sku": row["sku"],
        "tags": tags,
        "live": live,
        "first_seen": row["first_seen"],
        "last_seen": row["last_seen"],
    }


def _empty(limit: int, offset: int) -> Dict[str, Any]:
    return {
        "results": [],
        "total": 0,
        "latest_scan_id": None,
        "truncated": False,
        "page": {
            "limit": limit,
            "offset": offset,
            "total": None,
            "has_more": False,
            "next_offset": None,
        },
    }


async def search_resources(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    query: str,
    include_deleted: bool = True,
    limit: int = MAX_RESULTS,
    offset: int = 0,
) -> Dict[str, Any]:
    """
    Find resources by name across every scan this account owns.

    Scoping is by `user_id` in the SQL itself rather than by filtering after the
    fact, so one customer's search can never reach another's estate even if a
    tenant id were guessed.

    Paging is applied in SQL after the ordering, so the deleted-first ordering
    that this feature exists for survives across pages. `truncated` is kept for
    the existing caller and now means "there is a page after this one".
    """
    limit = max(1, min(limit, MAX_RESULTS))
    offset = max(0, offset)

    term = (query or "").strip().lower()
    if not term:
        return _empty(limit, offset)

    current_scan = await latest_scan_id(db, user_id, tenant_id)
    if current_scan is None:
        # No completed scan means there is nothing to search yet. That is a
        # different answer to "nothing matched", and the caller needs to be able
        # to tell them apart to prompt for a first scan.
        return _empty(limit, offset)

    # Collapse a resource's rows across scans into one result: the estate has
    # one api-prod-03, not one per scan it survived. The window it was observed
    # in is what turns the row into an answer about time.
    #
    # Ordering and filtering both happen in SQL, before the limit. Sorting by
    # scan id put live resources first, so on any estate with more matches than
    # the limit the deleted ones fell off the end — silently removing the only
    # results this feature exists to produce.
    having = "" if include_deleted else "HAVING MAX(r.scan_id) = :current_scan"

    async with db.execute(
        f"""
        SELECT r.resource_id,
               MAX(r.name)            AS name,
               MAX(r.type)            AS type,
               MAX(r.resource_group)  AS resource_group,
               MAX(r.subscription_id) AS subscription_id,
               MAX(r.location)        AS location,
               MAX(r.sku)             AS sku,
               MAX(r.tags)            AS tags,
               MIN(s.started_at)      AS first_seen,
               MAX(s.started_at)      AS last_seen,
               MAX(r.scan_id)         AS last_scan_id
          FROM scan_resources r
          JOIN scans s ON s.id = r.scan_id
         WHERE s.user_id = :user_id
           AND s.tenant_id = :tenant_id
           AND s.status = 'complete'
           AND r.name_lower LIKE :term
         GROUP BY r.resource_id
         {having}
         ORDER BY CASE WHEN MAX(r.scan_id) = :current_scan THEN 1 ELSE 0 END ASC,
                  name ASC
         LIMIT :limit OFFSET :offset
        """,
        {
            "user_id": user_id,
            "tenant_id": tenant_id,
            "term": f"%{term}%",
            "current_scan": current_scan,
            # One extra row is fetched purely to detect a further page, so the
            # UI can offer "load more" instead of quietly hiding matches. It
            # costs one row rather than a second COUNT over the same predicate.
            "limit": limit + 1,
            "offset": offset,
        },
    ) as cursor:
        rows = await cursor.fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]

    results = [
        _row_to_resource(row, row["last_scan_id"] == current_scan)
        for row in rows
    ]

    return {
        "results": results,
        "total": len(results),
        "latest_scan_id": current_scan,
        "truncated": has_more,
        "page": {
            "limit": limit,
            "offset": offset,
            # Deliberately unknown rather than 0: counting every match means a
            # second full scan of the snapshot table, and a wrong total is worse
            # than an absent one.
            "total": None,
            "has_more": has_more,
            "next_offset": offset + limit if has_more else None,
        },
    }
