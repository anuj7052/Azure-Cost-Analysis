"""
One resource, end to end: when it appeared, everything that changed it, what it
cost around each change, and who did it.

This lives apart from `/api/changes` on purpose. That router is documented as
never calling Azure and therefore never being throttled, and it earns real
value from that -- it answers even when Cost Management is refusing everyone
else. Bolting a cost lookup onto it would quietly cost it that property.

So the split is: `/api/changes` for the fast, always-available diff, and this
for the enriched drill-down that someone opened deliberately and is willing to
wait a moment for. Both cost and Activity Log enrichment are best effort. A
timeline without prices is still a timeline; failing the whole request because
Cost Management was busy would throw away the part that was never at risk.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth.dependencies import get_current_user
from core.db import get_db
from services import changes as changes_svc
from services import lifecycle as lifecycle_svc
from services import resource_cost as cost_svc
from services.activity import MAX_RETENTION_DAYS, fetch_activity, normalise
from services.cost_client import friendly_error, query_usage
from services.token_resolver import resolve_tenant_token

router = APIRouter(prefix="/api/timeline", tags=["timeline"])

log = logging.getLogger(__name__)

# How much spend history to pull for a single resource. Twelve months is what
# Cost Management reliably keeps at resource granularity; asking for more
# returns a shorter answer with no indication that it was truncated.
MONTHLY_LOOKBACK_MONTHS = 12

# Daily is opt-in and deliberately short. A day-by-day query grouped by
# ResourceId is the most throttle-prone read in the app, and ninety days of it
# already covers every change the Activity Log can name.
DAILY_LOOKBACK_DAYS = 90


class ResourceTimelineRequest(BaseModel):
    tenant_id: str
    resource_id: str
    # Monthly answers "what does this cost now, and did the resize move it".
    # Daily answers "did the bill step up on the exact day it changed", which
    # is a different and more expensive question.
    granularity: str = cost_svc.MONTHLY
    include_cost: bool = True
    include_activity: bool = True


def _iso_day(value: datetime) -> str:
    return value.strftime("%Y-%m-%d")


async def _load_cost(
    token: str,
    subscription_id: str,
    resource_id: str,
    granularity: str,
) -> tuple[List[Dict[str, Any]], str, str]:
    """
    Spend for one resource, with the currency and any failure reason.

    The filter is applied here rather than in the query because Cost Management
    will not filter on ResourceId -- it will only group by it. So the whole
    subscription's rows come back and `cost_series` keeps the ones that match.
    That is wasteful, and it is the only option Azure offers.
    """
    now = datetime.now(timezone.utc)
    if granularity == cost_svc.DAILY:
        records = await query_usage(
            token=token,
            subscription_id=subscription_id,
            group_by=["ResourceId"],
            granularity="Daily",
            from_date=_iso_day(now - timedelta(days=DAILY_LOOKBACK_DAYS)),
            to_date=_iso_day(now),
        )
    else:
        records = await query_usage(
            token=token,
            subscription_id=subscription_id,
            months=MONTHLY_LOOKBACK_MONTHS,
            group_by=["ResourceId"],
            granularity="Monthly",
        )

    currency = next((r.get("Currency") for r in records if r.get("Currency")), "USD")
    return records, currency, ""


@router.post("/resource")
async def resource_timeline(
    body: ResourceTimelineRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    The full history of one resource, from snapshots plus Azure's own records.

    The snapshot history is the spine and it always works -- it is read from
    our own database and covers the entire life of the resource, including
    after Azure has forgotten it existed. Cost and the Activity Log are hung
    off that spine where they can reach, and where they cannot, the response
    says so rather than leaving a blank that reads as "nothing happened".
    """
    account_id = current_user["account_id"]

    history = await changes_svc.entity_history(
        db=db,
        user_id=account_id,
        tenant_id=body.tenant_id,
        resource_id=body.resource_id,
    )

    if not history.get("resource"):
        return {
            "resource": None,
            "events": [],
            "lifecycle": None,
            "cost": {"series": [], "summary": cost_svc.summarise([]), "currency": "USD"},
            "notes": ["This resource has never appeared in a completed scan."],
        }

    events = history["events"]
    resource = history["resource"]
    notes: List[str] = []

    # The scan in which the resource stopped appearing, if it has gone. The
    # history reports it as a REMOVED event, which is the only record we have
    # of a deletion once Azure has dropped it.
    removed_at = next(
        (e["at"] for e in events if e.get("kind") == changes_svc.REMOVED),
        None,
    )

    subscription_id = (
        cost_svc.subscription_of(body.resource_id)
        or resource.get("subscription_id")
        or ""
    )

    token: Optional[str] = None
    if (body.include_cost or body.include_activity) and subscription_id:
        try:
            token = await resolve_tenant_token(body.tenant_id, current_user, db)
        except Exception as exc:
            log.warning("Timeline token resolution failed: %s", exc)
            notes.append(
                "Could not reach Azure for this tenant, so costs and the "
                "Activity Log are missing. The change history below is "
                "complete and comes from your own scans."
            )

    # ── Activity Log ───────────────────────────────────────────────────────
    activity: List[Dict[str, Any]] = []
    covers_from: Optional[str] = None

    if token and body.include_activity:
        covers_from = (
            datetime.now(timezone.utc) - timedelta(days=MAX_RETENTION_DAYS)
        ).isoformat()
        try:
            raw = await fetch_activity(
                token=token,
                subscription_id=subscription_id,
                resource_id=body.resource_id,
                days=MAX_RETENTION_DAYS,
                select=[
                    "eventTimestamp", "operationName", "status", "caller",
                    "resourceId", "eventDataId", "level", "resourceGroupName",
                    "subscriptionId",
                ],
            )
            activity = [normalise(entry) for entry in raw]
        except Exception as exc:
            covers_from = None
            log.warning("Timeline activity lookup failed: %s", exc)
            notes.append(
                "The Azure Activity Log could not be read, so changes below "
                "are not attributed to a person."
            )

    # ── Cost ───────────────────────────────────────────────────────────────
    series: List[Dict[str, Any]] = []
    currency = "USD"

    if token and body.include_cost:
        try:
            records, currency, _ = await _load_cost(
                token, subscription_id, body.resource_id, body.granularity,
            )
            series = cost_svc.cost_series(records, body.resource_id, body.granularity)
            if not series:
                notes.append(
                    "Azure reports no cost against this resource id. Some "
                    "services bill at the parent resource instead, and free "
                    "tiers bill nothing at all."
                )
        except Exception as exc:
            log.warning("Timeline cost lookup failed: %s", exc)
            notes.append(f"Costs are missing: {friendly_error(exc)}")

    # ── Join ───────────────────────────────────────────────────────────────
    events = lifecycle_svc.attach_activity(events, activity)
    events = cost_svc.attach_cost(events, series, body.granularity)

    life = lifecycle_svc.build_lifecycle(
        first_seen=history.get("first_seen"),
        last_seen=history.get("last_seen"),
        properties=resource.get("properties"),
        removed_at=removed_at,
        activity=activity,
        activity_covers_from=covers_from,
    )

    return {
        "resource": resource,
        "events": events,
        "lifecycle": life,
        "scan_count": history.get("scan_count", 0),
        "first_seen": history.get("first_seen"),
        "last_seen": history.get("last_seen"),
        "cost": {
            "series": series,
            "summary": cost_svc.summarise(series),
            "currency": currency,
            "granularity": body.granularity,
        },
        "notes": notes,
    }
