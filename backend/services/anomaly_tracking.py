"""
Remembering what somebody already looked into.

An anomaly has no identity of its own. It is recomputed from billing data
every time the page loads, so there is no row to attach a status to — and
without one, a team of three investigates the same PostgreSQL spike three
times, and nobody can tell whether the silence on a finding means it was
handled or ignored.

The identity used here is a fingerprint of what the anomaly *is*: tenant,
subscription, service, resource and period. Recomputing the same change from
the same data yields the same key, so "Anuj marked this investigating" survives
a refresh. It deliberately does not include the amounts — a spike that grows
from ₹18,000 to ₹19,000 is the same spike, and resetting its status because a
number moved would defeat the point.

Everything is scoped to (tenant, user). Cost data is commercially sensitive and
a note reading "expected, production release" must never surface in another
tenant, so the scope is part of the key rather than a filter applied afterwards.
"""
import hashlib
import json
from typing import Any, Dict, List, Optional

import aiosqlite

STATUS_NEW = "new"
STATUS_INVESTIGATING = "investigating"
STATUS_ACKNOWLEDGED = "acknowledged"
STATUS_RESOLVED = "resolved"
STATUS_IGNORED = "ignored"

VALID_STATUSES = (
    STATUS_NEW,
    STATUS_INVESTIGATING,
    STATUS_ACKNOWLEDGED,
    STATUS_RESOLVED,
    STATUS_IGNORED,
)

MAX_COMMENT = 2000


def anomaly_key(
    tenant_id: str,
    subscription_id: str,
    service: str,
    resource_name: str = "",
    period: str = "",
) -> str:
    """
    A stable fingerprint for a cost change.

    Hashed rather than concatenated because the parts contain user-supplied
    resource names, and a delimiter-joined string breaks the moment a name
    contains the delimiter -- which is how two different anomalies end up
    sharing a status.
    """
    payload = json.dumps(
        [tenant_id or "", subscription_id or "", service or "", resource_name or "", period or ""],
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


async def statuses_for(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
) -> Dict[str, Dict[str, Any]]:
    """
    Every tracked status for this user and tenant, keyed by fingerprint.

    Read in one query and joined in memory. The alternative -- looking up each
    anomaly's status as the page renders it -- is a query per row, which is the
    N+1 pattern that makes a 200-row table take a second longer than it should.
    """
    cursor = await db.execute(
        "SELECT anomaly_key, status, updated_at FROM anomaly_tracking "
        "WHERE user_id = ? AND tenant_id = ?",
        (user_id, tenant_id),
    )
    rows = await cursor.fetchall()
    return {
        r["anomaly_key"]: {"status": r["status"], "updated_at": r["updated_at"]}
        for r in rows
    }


async def set_status(
    db: aiosqlite.Connection,
    *,
    user: Dict[str, Any],
    tenant_id: str,
    key: str,
    status: str,
    comment: str = "",
    subscription_id: str = "",
    service: str = "",
    resource_name: str = "",
    period: str = "",
) -> Dict[str, Any]:
    """
    Record a status change and the fact that somebody made it.

    The previous status is captured before the write so the history reads as
    "new to investigating" rather than just "investigating" -- which is the
    difference between a trail and a list.
    """
    if status not in VALID_STATUSES:
        raise ValueError(f"Unknown status: {status}")

    cursor = await db.execute(
        "SELECT status FROM anomaly_tracking WHERE user_id = ? AND tenant_id = ? AND anomaly_key = ?",
        (user["account_id"], tenant_id, key),
    )
    existing = await cursor.fetchone()
    previous = existing["status"] if existing else STATUS_NEW

    await db.execute(
        """
        INSERT INTO anomaly_tracking
            (anomaly_key, user_id, tenant_id, subscription_id, service,
             resource_name, period, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (tenant_id, user_id, anomaly_key)
        DO UPDATE SET status = excluded.status, updated_at = datetime('now')
        """,
        (
            key, user["account_id"], tenant_id, subscription_id, service,
            resource_name, period, status,
        ),
    )

    await db.execute(
        """
        INSERT INTO anomaly_events
            (anomaly_key, user_id, tenant_id, actor_name, actor_email,
             previous_status, new_status, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            key, user["account_id"], tenant_id,
            user.get("name") or "", user.get("email") or "",
            previous, status, (comment or "")[:MAX_COMMENT],
        ),
    )
    await db.commit()

    return {"anomaly_key": key, "status": status, "previous_status": previous}


async def history_for(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    key: str,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """The trail for one anomaly, newest first."""
    cursor = await db.execute(
        "SELECT actor_name, actor_email, previous_status, new_status, comment, created_at "
        "FROM anomaly_events WHERE user_id = ? AND tenant_id = ? AND anomaly_key = ? "
        "ORDER BY id DESC LIMIT ?",
        (user_id, tenant_id, key, limit),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


def apply_statuses(
    changes: List[Dict[str, Any]],
    statuses: Dict[str, Dict[str, Any]],
    tenant_id: str,
    period: str,
) -> List[Dict[str, Any]]:
    """
    Attach the fingerprint and any recorded status to each change.

    Untracked anomalies report `new` rather than an empty string: "nobody has
    touched this" is a real state and the filter bar needs to be able to select
    it.
    """
    out = []
    for change in changes:
        key = anomaly_key(
            tenant_id,
            change.get("subscription_id", ""),
            change.get("service", ""),
            change.get("resource_name", ""),
            period,
        )
        tracked: Optional[Dict[str, Any]] = statuses.get(key)
        out.append({
            **change,
            "anomaly_key": key,
            "status": tracked["status"] if tracked else STATUS_NEW,
            "status_updated_at": tracked["updated_at"] if tracked else None,
        })
    return out
