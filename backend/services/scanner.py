"""
Point-in-time capture of a tenant's Azure estate.

Azure only ever reports what exists *now*. Every question worth asking about
infrastructure — what changed, what was deleted, what did this look like during
the incident — needs a record of what existed *then*, and nothing in Azure keeps
one for you.

So a scan writes an immutable snapshot. Rows are never updated: a resource that
changes produces a new row in the next scan and the previous one stays exactly
as captured. That immutability is the whole feature; without it there is no
history to compare against and "deleted resource" cannot be expressed at all.
"""
import json
import logging
from typing import Any, Dict, List

import aiosqlite

from services.cost_client import query_active_resources

log = logging.getLogger(__name__)

STATUS_RUNNING = "running"
STATUS_COMPLETE = "complete"
STATUS_FAILED = "failed"

# Largest configuration bag stored per resource, in characters.
#
# A snapshot multiplies: every resource, every scan, kept forever. Most
# properties bags are two or three kilobytes, but a few resource types -- large
# network security groups, App Service site configs, Data Factory pipelines --
# run to hundreds. Those are the ones that would quietly turn a snapshot table
# into the largest thing in the database.
#
# An oversized bag is dropped rather than truncated. Truncated JSON does not
# parse, and a half-stored bag would diff against the next scan's full one and
# report a change that did not happen. Storing nothing is visibly nothing.
MAX_PROPERTIES_CHARS = 32_000


def _properties_of(row: Dict[str, Any]) -> str:
    """
    The provider's configuration bag, as JSON text, ready to store.

    Kept verbatim rather than filtered. Noisy keys are excluded when a diff is
    computed, not here: what is stored is what Azure reported, so the raw view
    stays trustworthy and the definition of "noise" can change later without
    reducing history that was already captured.
    """
    value = row.get("properties")
    if not isinstance(value, dict) or not value:
        return ""

    try:
        text = json.dumps(value, sort_keys=True)
    except (TypeError, ValueError):
        return ""

    return "" if len(text) > MAX_PROPERTIES_CHARS else text


def _sku_of(row: Dict[str, Any]) -> str:
    """
    One readable size for a resource.

    Every provider puts this somewhere different — VMs under hardwareProfile,
    disks in diskSizeGB, everything else on the sku object — so it is flattened
    once here rather than in each feature that displays it.
    """
    for key in ("skuName", "vmSize", "skuSize"):
        value = (row.get(key) or "").strip()
        if value:
            return value

    disk_gb = (row.get("diskGb") or "").strip()
    return f"{disk_gb} GB" if disk_gb else ""


async def start_scan(db: aiosqlite.Connection, user_id: int, tenant_id: str) -> int:
    """Open a scan row so a failure halfway through is still visible as one."""
    cursor = await db.execute(
        "INSERT INTO scans (user_id, tenant_id, status) VALUES (?, ?, ?) RETURNING id",
        (user_id, tenant_id, STATUS_RUNNING),
    )
    # Read before committing. `lastrowid` is a SQLite-only idea, and on SQLite
    # the commit can reset the cursor out from under the fetch.
    scan_id = (await cursor.fetchone())[0]
    await db.commit()
    return scan_id


async def record_resources(
    db: aiosqlite.Connection,
    scan_id: int,
    resources: List[Dict[str, Any]],
) -> int:
    """Write the captured resources as immutable rows for this scan."""
    rows = [
        (
            scan_id,
            r.get("id") or "",
            r.get("name") or "",
            (r.get("name") or "").lower(),
            r.get("type") or "",
            r.get("resourceGroup") or "",
            r.get("subscriptionId") or "",
            r.get("location") or "",
            _sku_of(r),
            json.dumps(r.get("tags") or {}),
            _properties_of(r),
        )
        for r in resources
        # A resource with no id cannot be matched against another scan, so it
        # could never take part in change tracking. Storing it would inflate
        # counts while contributing nothing.
        if r.get("id")
    ]

    if rows:
        await db.executemany(
            """
            INSERT INTO scan_resources (
                scan_id, resource_id, name, name_lower, type,
                resource_group, subscription_id, location, sku, tags, properties
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

    return len(rows)


async def finish_scan(
    db: aiosqlite.Connection,
    scan_id: int,
    resource_count: int,
    error: str | None = None,
):
    await db.execute(
        """
        UPDATE scans
           SET status = ?, finished_at = CURRENT_TIMESTAMP,
               resource_count = ?, error = ?
         WHERE id = ?
        """,
        (STATUS_FAILED if error else STATUS_COMPLETE, resource_count, error, scan_id),
    )
    await db.commit()


async def run_scan(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    token: str,
    subscription_ids: List[str],
) -> Dict[str, Any]:
    """
    Capture the estate and store it as one snapshot.

    A failure is recorded on the scan row rather than raised away, so a tenant
    that loses read access shows a failed scan with the reason instead of
    silently having no history for that day.
    """
    scan_id = await start_scan(db, user_id, tenant_id)

    try:
        resources = await query_active_resources(token, subscription_ids)
    except Exception as exc:
        await finish_scan(db, scan_id, 0, str(exc)[:300])
        return {"scan_id": scan_id, "status": STATUS_FAILED, "resource_count": 0,
                "error": str(exc)[:300]}

    count = await record_resources(db, scan_id, resources)
    await finish_scan(db, scan_id, count)

    return {"scan_id": scan_id, "status": STATUS_COMPLETE, "resource_count": count,
            "error": None}


async def latest_scan_id(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
) -> int | None:
    """
    The most recent successful scan.

    Only completed scans count: a failed or in-flight scan holds a partial
    estate, and treating it as current would report every resource it had not
    reached yet as deleted.
    """
    async with db.execute(
        """
        SELECT id FROM scans
         WHERE user_id = ? AND tenant_id = ? AND status = ?
         ORDER BY id DESC LIMIT 1
        """,
        (user_id, tenant_id, STATUS_COMPLETE),
    ) as cursor:
        row = await cursor.fetchone()

    return row["id"] if row else None
