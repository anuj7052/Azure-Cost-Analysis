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
        "INSERT INTO scans (user_id, tenant_id, status) VALUES (?, ?, ?)",
        (user_id, tenant_id, STATUS_RUNNING),
    )
    await db.commit()
    return cursor.lastrowid


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
                resource_group, subscription_id, location, sku, tags
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           SET status = ?, finished_at = datetime('now'),
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
