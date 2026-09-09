"""
Activity Explorer — who changed what, and when.

Reads the Azure Activity Log, which is the only source that records the actor
behind a change. Snapshot diffs elsewhere in this app see results; this sees
the operations that produced them.
"""
import logging
from typing import List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import ActivityResponse
from services.activity import MAX_RETENTION_DAYS, clamp_window, fetch_activity, summarise_activity
from services.token_resolver import resolve_tenant_token

router = APIRouter(prefix="/api/activity", tags=["activity"])

log = logging.getLogger(__name__)


def _azure_reason(exc: Exception) -> str:
    """
    What Azure said, in preference to what httpx said about it.

    `str(exc)` on an HTTPStatusError is "Client error '403 Forbidden' for url
    ..." followed by the whole request URL, which buries the one sentence that
    matters under a query string. The response body carries Azure's own
    message, and Azure's message names the action and scope it refused.
    """
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            payload = response.json()
        except Exception:
            payload = None
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])[:400]
            if isinstance(payload.get("message"), str):
                return payload["message"][:400]
    return str(exc)[:400]


def _why_unreadable(errors: list[dict], statuses: set[int]) -> str:
    """
    One sentence naming the actual obstacle.

    This used to assert the Reader role was missing whatever had happened --
    for a throttle, an expired token, a subscription that had been moved to
    another tenant, all of them. Someone told to grant a role they had already
    granted has been sent to fix the wrong thing, and will trust the next
    message less. The status code is known here, so it is used.
    """
    count = len(errors)
    plural = "" if count == 1 else "s"
    lead = f"Could not read the Activity Log for {count} subscription{plural}."
    reason = errors[0].get("error") or ""

    if 403 in statuses or 401 in statuses:
        return (
            f"{lead} Azure refused the read, which needs the Reader role on the "
            "subscription — it carries Microsoft.Insights/eventtypes/values/read. "
            f"Azure said: {reason}"
        )
    if 429 in statuses:
        return (
            f"{lead} Azure is rate limiting this tenant. This is temporary and "
            "the permissions are not the problem."
        )
    if any(s and s >= 500 for s in statuses):
        return (
            f"{lead} Azure itself returned an error, so this is not something "
            f"granting a role would fix. Azure said: {reason}"
        )
    # No status at all means the request never got an HTTP answer: a timeout,
    # a DNS failure, a token that could not be obtained.
    return f"{lead} {reason}" if reason else lead


@router.get("", response_model=ActivityResponse)
async def get_activity(
    tenant_id: str = Query(...),
    subscription_ids: List[str] = Query(...),
    days: int = Query(7, ge=1, le=MAX_RETENTION_DAYS),
    resource_id: Optional[str] = Query(None, description="Limit to one resource"),
    resource_group: Optional[str] = Query(
        None,
        description=(
            "Limit to one resource group. Ignored when resource_id is given, "
            "which is narrower."
        ),
    ),
    writes_only: bool = Query(True),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Control-plane operations across the selected subscriptions.

    One subscription failing does not fail the request: a tenant may grant
    activity read on some subscriptions and not others, and returning what is
    readable beats returning nothing. The shortfall is reported rather than
    silently swallowed, because a short list looks identical to a quiet week.

    Narrowing by resource group is worth exposing because Azure applies it
    itself. Reading a group's history by pulling the whole subscription and
    discarding the rest costs the same quota as every other caller's read and
    is slow enough to time out on a large estate - and asking per resource
    instead would turn one request into dozens.
    """
    token = await resolve_tenant_token(tenant_id, current_user, db)

    entries = []
    errors = []
    statuses: set[int] = set()
    for subscription_id in subscription_ids:
        try:
            entries.extend(await fetch_activity(
                token=token,
                subscription_id=subscription_id,
                days=days,
                resource_id=resource_id,
                resource_group=resource_group,
            ))
        except Exception as exc:
            log.warning("Activity read failed for %s: %s", subscription_id, exc)
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status:
                statuses.add(status)
            errors.append({
                "subscription_id": subscription_id,
                "status": status,
                "error": _azure_reason(exc),
            })

    if not entries and errors:
        raise HTTPException(status_code=502, detail=_why_unreadable(errors, statuses))

    summary = summarise_activity(entries, writes_only=writes_only)
    summary["window_days"] = clamp_window(days)
    summary["errors"] = errors
    return summary
