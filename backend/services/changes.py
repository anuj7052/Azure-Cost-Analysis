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

# Property paths that change on their own and mean nothing to a reader.
#
# Azure rewrites these without anybody touching the resource: timestamps tick,
# etags are regenerated on any internal write, provisioning state settles from
# Updating to Succeeded, and lease or health fields reflect the moment the scan
# ran rather than a decision someone made. Reporting them turns every scan into
# a wall of changes and trains people to ignore the page.
#
# Matched on the last segment of the path, case-insensitively, so it applies at
# any depth without listing every provider's nesting.
NOISE_KEYS = frozenset({
    "etag",
    "timecreated",
    "lastmodifiedtime",
    "lastmodifiedat",
    "changedtime",
    "provisioningstate",
    "leasestatus",
    "diskstate",
    "uniqueid",
    "resourceguid",
    "lastkeyrotationtimestamp",
    "creationdata",
    "healthstatus",
    "statuses",
})

# How deep a configuration bag is walked, and how many differences are kept.
#
# Both are guards against one pathological resource. A Data Factory pipeline or
# a large NSG can nest a long way and produce thousands of differences; without
# a limit, one such resource would dominate the response and the page.
MAX_PROPERTY_DEPTH = 6
MAX_PROPERTY_CHANGES = 40


def _parse_properties(raw: Any) -> Optional[Dict[str, Any]]:
    """
    The stored configuration bag, or None when there is nothing to compare.

    None and `{}` mean different things here. None means the bag was never
    captured — the resource has none, it was too large to store, or the
    snapshot predates the column. `{}` would mean Azure genuinely reported an
    empty bag. Collapsing the two would make every old snapshot look as though
    every property had just been deleted.
    """
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _readable(value: Any) -> str:
    """One line describing a value, for a table cell."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, str)):
        return str(value)
    try:
        return json.dumps(value, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _walk(old: Any, new: Any, path: str, depth: int, out: List[Dict[str, Any]]):
    """Collect leaf differences between two configuration bags."""
    if len(out) >= MAX_PROPERTY_CHANGES:
        return

    last = path.rsplit(".", 1)[-1].lower()
    if last in NOISE_KEYS:
        return

    if isinstance(old, dict) and isinstance(new, dict) and depth < MAX_PROPERTY_DEPTH:
        for key in sorted(old.keys() | new.keys()):
            _walk(old.get(key), new.get(key), f"{path}.{key}" if path else key,
                  depth + 1, out)
        return

    if old == new:
        return

    # Lists are compared whole rather than element by element. Azure reorders
    # them freely, so positional matching invents changes; and a person reading
    # "the firewall rules changed" alongside both versions is better served
    # than by a list of index numbers that may not correspond to anything.
    out.append({
        "field": path,
        "label": path,
        "from": _readable(old),
        "to": _readable(new),
    })


def compare_properties(before: Any, after: Any) -> List[Dict[str, Any]]:
    """
    Differences inside the provider's configuration bag.

    This is where the interesting changes live — public network access turned
    on, TLS minimum lowered, a backup policy removed. None of it is visible in
    the flattened columns, which can only ever say that a resource exists.
    """
    old, new = _parse_properties(before), _parse_properties(after)

    # Either side missing means there is nothing trustworthy to compare. Saying
    # nothing is correct; inventing a change from absent data is not.
    if old is None or new is None:
        return []

    out: List[Dict[str, Any]] = []
    _walk(old, new, "", 0, out)
    return out


def _row_value(row: Any, column: str) -> Any:
    """
    Read a column that may not exist on this row.

    Snapshots taken before a column was added still have to be readable, and
    sqlite3.Row raises rather than returning None for an unknown key.
    """
    try:
        return row[column]
    except (IndexError, KeyError):
        return None


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
        "properties": _parse_properties(_row_value(row, "properties")),
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


# ── ignoring expected changes ───────────────────────────────────────────────
#
# A rule with an empty `field` silences the whole resource. A rule naming a
# field silences only that one, which is the common case: a pipeline that
# rewrites `tags` nightly should not also hide the day someone deletes the
# resource.

WHOLE_RESOURCE = ""


async def list_ignores(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
) -> List[aiosqlite.Row]:
    async with db.execute(
        """
        SELECT * FROM change_ignores
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY id DESC
        """,
        (user_id, tenant_id),
    ) as cursor:
        return await cursor.fetchall()


async def add_ignore(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    resource_id: str,
    field: str = WHOLE_RESOURCE,
    note: str = "",
    created_by: str = "",
) -> None:
    """
    Record that a change is expected.

    Re-ignoring something already ignored is not an error — the person is
    asking for a state, not queuing an event — so a repeat updates the note
    instead of failing.
    """
    await db.execute(
        """
        INSERT INTO change_ignores (user_id, tenant_id, resource_id, field, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, tenant_id, resource_id, field)
        DO UPDATE SET note = excluded.note
        """,
        (user_id, tenant_id, resource_id.lower(), field, note[:300], created_by),
    )
    await db.commit()


async def remove_ignore(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    resource_id: str,
    field: str = WHOLE_RESOURCE,
) -> int:
    cursor = await db.execute(
        """
        DELETE FROM change_ignores
         WHERE user_id = ? AND tenant_id = ? AND resource_id = ? AND field = ?
        """,
        (user_id, tenant_id, resource_id.lower(), field),
    )
    await db.commit()
    return cursor.rowcount or 0


def _ignore_index(rules: List[aiosqlite.Row]) -> Dict[str, set]:
    index: Dict[str, set] = {}
    for rule in rules:
        index.setdefault(rule["resource_id"].lower(), set()).add(rule["field"])
    return index


def apply_ignores(
    diff: Dict[str, Any],
    rules: List[aiosqlite.Row],
    show_ignored: bool = False,
) -> Dict[str, Any]:
    """
    Mark, and optionally hide, changes the owner has said are expected.

    Every entry is labelled `ignored` whether or not it is being shown, so the
    UI can grey out a suppressed row rather than making it vanish with no
    explanation. Counts are recomputed from what survives, because a headline
    of 40 changes above a list of 3 is worse than no headline.
    """
    index = _ignore_index(rules)
    result = dict(diff)
    ignored_total = 0

    for bucket in (ADDED, REMOVED, MODIFIED):
        kept = []
        for entry in diff.get(bucket, []):
            fields = index.get(entry["resource_id"].lower(), set())
            entry = dict(entry)

            if WHOLE_RESOURCE in fields:
                entry["ignored"] = True
            elif bucket == MODIFIED and fields:
                # A partly-ignored resource is not an ignored resource. Drop the
                # silenced fields; if anything is left, it is still a change.
                surviving = [c for c in entry.get("changes", [])
                             if c["field"] not in fields]
                entry["ignored"] = not surviving
                if surviving:
                    entry["changes"] = surviving
            else:
                entry["ignored"] = False

            if entry["ignored"]:
                ignored_total += 1
                if not show_ignored:
                    continue
            kept.append(entry)

        result[bucket] = kept

    visible = {b: [e for e in result[b] if not e.get("ignored")]
               for b in (ADDED, REMOVED, MODIFIED)}
    result["added_count"] = len(visible[ADDED])
    result["removed_count"] = len(visible[REMOVED])
    result["modified_count"] = len(visible[MODIFIED])
    result["total_changes"] = sum(len(v) for v in visible.values())
    result["ignored_count"] = ignored_total
    return result


# ── grouping ────────────────────────────────────────────────────────────────

GROUP_KEYS = {
    "subscription": "subscription_id",
    "resource_group": "resource_group",
    "type": "type",
    "location": "location",
}


def group_counts(diff: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
    """
    Added, removed and modified counts per subscription, group, type or region.

    Computed here rather than in the browser so the numbers on the page and the
    numbers in an export are the same numbers, and so a large estate does not
    have to ship every resource just to render a summary.
    """
    column = GROUP_KEYS.get(key)
    if not column:
        return []

    buckets: Dict[str, Dict[str, Any]] = {}
    for bucket in (ADDED, REMOVED, MODIFIED):
        for entry in diff.get(bucket, []):
            if entry.get("ignored"):
                continue
            name = entry.get(column) or "Unassigned"
            row = buckets.setdefault(
                name, {"key": name, "added": 0, "removed": 0, "modified": 0}
            )
            row[bucket] += 1

    rows = list(buckets.values())
    for row in rows:
        row["total"] = row["added"] + row["removed"] + row["modified"]
    rows.sort(key=lambda r: (-r["total"], r["key"].lower()))
    return rows


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

    # Appended after the tracked columns, never before: a person scanning the
    # list should see "Region" and "SKU / size" first, because those are the
    # ones they can name. The property paths are the detail underneath.
    changes.extend(compare_properties(
        _row_value(before, "properties"), _row_value(after, "properties")
    ))

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
