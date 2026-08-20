"""
What changed between two captures of the estate, and how one resource evolved.

Azure reports the present. A snapshot records a moment. The difference between
two snapshots is the only place "what changed" can come from, and it is the
question that actually gets asked — during an incident, in an audit, or when a
bill moves without explanation.

Two views, because they answer different questions:

  * a **diff** answers "what happened between Tuesday and today"
  * an **entity history** answers "what has ever happened to this one resource"

The second is the one people come back for. A diff tells you a VM resized; a
history tells you it has been resized four times this quarter, which is a
different conversation entirely.
"""
import json
from typing import Any, Dict, List, Optional, Tuple

import aiosqlite

# Fields compared to decide whether a resource changed.
#
# Deliberately not every column: `scan_id` and the row id differ on every scan
# by construction, so including them would report the entire estate as modified
# every time. These are the properties a person would call a change.
TRACKED_FIELDS = (
    "name",
    "type",
    "resource_group",
    "subscription_id",
    "location",
    "sku",
    "tags",
)

# Human labels, so the UI never has to translate column names.
FIELD_LABELS = {
    "name": "Name",
    "type": "Type",
    "resource_group": "Resource group",
    "subscription_id": "Subscription",
    "location": "Region",
    "sku": "SKU / size",
    "tags": "Tags",
}

ADDED = "added"
REMOVED = "removed"
MODIFIED = "modified"


def _parse_tags(raw: str) -> Dict[str, str]:
    try:
        value = json.loads(raw or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _tag_diff(before: str, after: str) -> Optional[Dict[str, Any]]:
    """
    Describe a tag change key by key.

    Reporting the whole JSON blob as "before -> after" is technically accurate
    and useless: nobody can spot which of fifteen tags moved. Governance work is
    almost entirely about individual tags, so the comparison happens per key.
    """
    old, new = _parse_tags(before), _parse_tags(after)
    if old == new:
        return None

    added = {k: v for k, v in new.items() if k not in old}
    removed = {k: v for k, v in old.items() if k not in new}
    changed = {
        k: {"from": old[k], "to": new[k]}
        for k in old.keys() & new.keys()
        if old[k] != new[k]
    }

    return {"added": added, "removed": removed, "changed": changed}


def _row_to_resource(row: aiosqlite.Row) -> Dict[str, Any]:
    return {
        "resource_id": row["resource_id"],
        "name": row["name"],
        "type": row["type"],
        "resource_group": row["resource_group"],
        "subscription_id": row["subscription_id"],
        "location": row["location"],
        "sku": row["sku"],
        "tags": _parse_tags(row["tags"]),
    }


def diff_rows(
    before_rows: List[aiosqlite.Row],
    after_rows: List[aiosqlite.Row],
) -> Dict[str, Any]:
    """
    Compare two sets of captured resources.

    Matching is on the resource id, lower-cased: Azure is inconsistent about
    casing between APIs, and matching the raw string would report the same
    resource as both removed and added — a phantom change on every scan.
    """
    before = {r["resource_id"].lower(): r for r in before_rows}
    after = {r["resource_id"].lower(): r for r in after_rows}

    added = [_row_to_resource(after[k]) for k in after.keys() - before.keys()]
    removed = [_row_to_resource(before[k]) for k in before.keys() - after.keys()]

    modified = []
    for key in before.keys() & after.keys():
        changes = compare_resource(before[key], after[key])
        if changes:
            entry = _row_to_resource(after[key])
            entry["changes"] = changes
            modified.append(entry)

    added.sort(key=lambda r: r["name"].lower())
    removed.sort(key=lambda r: r["name"].lower())
    modified.sort(key=lambda r: r["name"].lower())

    return {
        "added": added,
        "removed": removed,
        "modified": modified,
        "added_count": len(added),
        "removed_count": len(removed),
        "modified_count": len(modified),
        "total_changes": len(added) + len(removed) + len(modified),
    }


def compare_resource(before: aiosqlite.Row, after: aiosqlite.Row) -> List[Dict[str, Any]]:
    """Field-level changes between two captures of the same resource."""
    changes: List[Dict[str, Any]] = []

    for field in TRACKED_FIELDS:
        old, new = before[field], after[field]

        if field == "tags":
            tag_change = _tag_diff(old, new)
            if tag_change:
                changes.append({
                    "field": field,
                    "label": FIELD_LABELS[field],
                    "tags": tag_change,
                })
            continue

        if (old or "") != (new or ""):
            changes.append({
                "field": field,
                "label": FIELD_LABELS.get(field, field),
                "from": old,
                "to": new,
            })

    return changes


async def _scan_rows(db: aiosqlite.Connection, scan_id: int) -> List[aiosqlite.Row]:
    async with db.execute(
        "SELECT * FROM scan_resources WHERE scan_id = ?", (scan_id,)
    ) as cursor:
        return await cursor.fetchall()


async def _owned_scan(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    scan_id: int,
) -> Optional[aiosqlite.Row]:
    """
    Ownership is checked in SQL for every scan touched.

    A scan id is a small integer and therefore trivially guessable, so this is
    the boundary that stops one customer diffing another customer's estate.
    """
    async with db.execute(
        """
        SELECT * FROM scans
         WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'complete'
        """,
        (scan_id, user_id, tenant_id),
    ) as cursor:
        return await cursor.fetchone()


async def recent_scans(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    limit: int = 30,
) -> List[aiosqlite.Row]:
    async with db.execute(
        """
        SELECT * FROM scans
         WHERE user_id = ? AND tenant_id = ? AND status = 'complete'
         ORDER BY id DESC LIMIT ?
        """,
        (user_id, tenant_id, limit),
    ) as cursor:
        return await cursor.fetchall()


async def scan_on_or_before(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    date: str,
) -> Optional[aiosqlite.Row]:
    """
    The estate as it stood on a given date.

    Scans happen at moments, questions are asked about days — "what did this
    look like on the 3rd" has no exact scan behind it unless one happened to run
    then. The last scan on or before the date is the honest answer: it is the
    most recent state known at that point.

    The date is compared as `date <= 'YYYY-MM-DD 23:59:59'` so a scan taken at
    any time on the chosen day still counts as being on that day.
    """
    async with db.execute(
        """
        SELECT * FROM scans
         WHERE user_id = ? AND tenant_id = ? AND status = 'complete'
           AND started_at <= ?
         ORDER BY started_at DESC, id DESC
         LIMIT 1
        """,
        (user_id, tenant_id, f"{date} 23:59:59"),
    ) as cursor:
        return await cursor.fetchone()


async def first_scan_on_or_after(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    date: str,
) -> Optional[aiosqlite.Row]:
    """
    The earliest capture from a date onwards.

    Used as a fallback when a date precedes every scan: reporting "no data"
    would be technically right and unhelpful, so the nearest available capture
    is offered and the response says which one was actually used.
    """
    async with db.execute(
        """
        SELECT * FROM scans
         WHERE user_id = ? AND tenant_id = ? AND status = 'complete'
           AND started_at >= ?
         ORDER BY started_at ASC, id ASC
         LIMIT 1
        """,
        (user_id, tenant_id, f"{date} 00:00:00"),
    ) as cursor:
        return await cursor.fetchone()


def _empty_diff(**extra) -> Dict[str, Any]:
    return {
        "added": [], "removed": [], "modified": [],
        "added_count": 0, "removed_count": 0, "modified_count": 0,
        "total_changes": 0,
        "before": None, "after": None,
        "comparable": False,
        "note": None,
        **extra,
    }


async def diff_by_date(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    from_date: str,
    to_date: str,
) -> Dict[str, Any]:
    """
    Compare the estate between two dates.

    Each date is resolved to the capture that best represents it, and the
    response always reports which scans were actually used. A date range that
    silently resolved to something else would make the answer impossible to
    trust — the whole point of the comparison is knowing what was compared.
    """
    before_row = await scan_on_or_before(db, user_id, tenant_id, from_date)
    if before_row is None:
        # The date predates every capture; use the earliest one there is.
        before_row = await first_scan_on_or_after(db, user_id, tenant_id, from_date)

    after_row = await scan_on_or_before(db, user_id, tenant_id, to_date)

    if before_row is None or after_row is None:
        return _empty_diff(
            note="No completed scan exists in or before this date range.",
        )

    if before_row["id"] == after_row["id"]:
        # Both dates land on the same capture, so nothing *can* have changed
        # between them. Reporting a clean "0 changes" would imply a stable
        # estate rather than a gap in scanning.
        return _empty_diff(
            before={"id": before_row["id"], "started_at": before_row["started_at"]},
            after={"id": after_row["id"], "started_at": after_row["started_at"]},
            note=(
                "Both dates resolve to the same scan, so there is nothing to compare. "
                "Scan more often, or widen the range."
            ),
        )

    result = diff_rows(
        await _scan_rows(db, before_row["id"]),
        await _scan_rows(db, after_row["id"]),
    )
    result["before"] = {"id": before_row["id"], "started_at": before_row["started_at"]}
    result["after"] = {"id": after_row["id"], "started_at": after_row["started_at"]}
    result["comparable"] = True
    result["note"] = None
    return result


async def diff_scans(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    before_id: Optional[int] = None,
    after_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Diff two scans, defaulting to the two most recent.

    Returns an empty diff rather than raising when there is only one scan: a new
    user has nothing to compare yet, which is a state to explain rather than an
    error to report.
    """
    scans = await recent_scans(db, user_id, tenant_id, limit=2 if not (before_id and after_id) else 30)

    if before_id is None or after_id is None:
        if len(scans) < 2:
            return _empty_diff(
                note="At least two completed scans are needed to compare.",
            )
        after_row, before_row = scans[0], scans[1]
    else:
        before_row = await _owned_scan(db, user_id, tenant_id, before_id)
        after_row = await _owned_scan(db, user_id, tenant_id, after_id)
        if not before_row or not after_row:
            return _empty_diff(note="Those scans are not available.")

    result = diff_rows(
        await _scan_rows(db, before_row["id"]),
        await _scan_rows(db, after_row["id"]),
    )
    result["before"] = {"id": before_row["id"], "started_at": before_row["started_at"]}
    result["after"] = {"id": after_row["id"], "started_at": after_row["started_at"]}
    result["comparable"] = True
    result["note"] = None
    return result


async def entity_history(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    resource_id: str,
) -> Dict[str, Any]:
    """
    Every change ever recorded for one resource.

    This is the view a diff cannot give: a diff says a VM was resized, a history
    says it has been resized four times this quarter. Consecutive captures are
    compared in order, and only the scans where something actually changed are
    reported — listing every scan would bury four real events under two hundred
    identical ones.
    """
    async with db.execute(
        """
        SELECT r.*, s.id AS scan_id, s.started_at
          FROM scan_resources r
          JOIN scans s ON s.id = r.scan_id
         WHERE s.user_id = ? AND s.tenant_id = ? AND s.status = 'complete'
           AND LOWER(r.resource_id) = LOWER(?)
         ORDER BY s.id ASC
        """,
        (user_id, tenant_id, resource_id),
    ) as cursor:
        rows = await cursor.fetchall()

    if not rows:
        return {"resource": None, "events": [], "first_seen": None, "last_seen": None}

    events: List[Dict[str, Any]] = [{
        "scan_id": rows[0]["scan_id"],
        "at": rows[0]["started_at"],
        "kind": "first_seen",
        "changes": [],
    }]

    for previous, current in zip(rows, rows[1:]):
        changes = compare_resource(previous, current)
        if changes:
            events.append({
                "scan_id": current["scan_id"],
                "at": current["started_at"],
                "kind": MODIFIED,
                "changes": changes,
            })

    # Absence from the latest scan is itself an event, and the most important
    # one — but it can only be claimed against a completed scan.
    latest = await recent_scans(db, user_id, tenant_id, limit=1)
    if latest and rows[-1]["scan_id"] != latest[0]["id"]:
        events.append({
            "scan_id": latest[0]["id"],
            "at": latest[0]["started_at"],
            "kind": REMOVED,
            "changes": [],
        })

    events.reverse()  # newest first: the last thing that happened is the question

    return {
        "resource": _row_to_resource(rows[-1]),
        "events": events,
        "first_seen": rows[0]["started_at"],
        "last_seen": rows[-1]["started_at"],
        "scan_count": len(rows),
    }
