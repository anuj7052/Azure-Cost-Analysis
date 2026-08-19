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


async def search_resources(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    query: str,
    include_deleted: bool = True,
) -> Dict[str, Any]:
    """
    Find resources by name across every scan this account owns.

    Scoping is by `user_id` in the SQL itself rather than by filtering after the
    fact, so one customer's search can never reach another's estate even if a
    tenant id were guessed.
    """
    term = (query or "").strip().lower()
    if not term:
        return {"results": [], "total": 0, "latest_scan_id": None, "truncated": False}

    current_scan = await latest_scan_id(db, user_id, tenant_id)
    if current_scan is None:
        # No completed scan means there is nothing to search yet. That is a
        # different answer to "nothing matched", and the caller needs to be able
        # to tell them apart to prompt for a first scan.
        return {"results": [], "total": 0, "latest_scan_id": None, "truncated": False}

    # Collapse a resource's rows across scans into one result: the estate has
    # one api-prod-03, not one per scan it survived. The window it was observed
    # in is what turns the row into an answer about time.
    async with db.execute(
        """
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
         WHERE s.user_id = ?
           AND s.tenant_id = ?
           AND s.status = 'complete'
           AND r.name_lower LIKE ?
         GROUP BY r.resource_id
         ORDER BY last_scan_id DESC, name ASC
         LIMIT ?
        """,
        (user_id, tenant_id, f"%{term}%", MAX_RESULTS + 1),
        # One extra row is fetched purely to detect truncation, so the UI can say
        # "narrow your search" instead of quietly hiding matches.
    ) as cursor:
        rows = await cursor.fetchall()

    truncated = len(rows) > MAX_RESULTS
    rows = rows[:MAX_RESULTS]

    results = []
    for row in rows:
        live = row["last_scan_id"] == current_scan
        if not live and not include_deleted:
            continue
        results.append(_row_to_resource(row, live))

    # Deleted resources lead: a live resource can be found in the portal, so the
    # ones only this tool can surface are the ones worth showing first.
    results.sort(key=lambda r: (r["live"], r["name"].lower()))

    return {
        "results": results,
        "total": len(results),
        "latest_scan_id": current_scan,
        "truncated": truncated,
    }
