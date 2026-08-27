"""
Cost anomalies and reductions.

Built entirely on the cost data the rest of the app already fetches: the same
`query_usage` call, the same subscription authorisation, the same coverage
reporting. Nothing here issues a request per anomaly -- both periods are read
once, in parallel across subscriptions, and every figure on the page is derived
from those two reads. An anomaly page that costs one Azure call per finding is
a page that gets rate limited the moment it becomes useful.

The analysis itself lives in `services/anomalies.py` and the period arithmetic
in `services/cost_periods.py`, both of which are pure and tested. This module
is only plumbing: fetch, classify, attach status, report coverage.
"""
import logging
from datetime import date, datetime
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user
from core.db import get_db
from services import anomalies as engine
from services import anomaly_tracking as tracking
from services import cost_periods
from services.analysis import to_cost_rows
from services.cost_client import gather_by_subscription, query_usage, summarise_errors
from services.coverage import build_coverage
from services.token_resolver import resolve_tenant_token, subscription_names

router = APIRouter(prefix="/api/anomalies", tags=["anomalies"])

log = logging.getLogger(__name__)


class AnalyzeRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str]
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    comparison: str = cost_periods.COMPARE_PREVIOUS_MONTH
    threshold_pct: float = Field(default=engine.DEFAULT_THRESHOLD_PCT, ge=0, le=1000)


class StatusRequest(BaseModel):
    tenant_id: str
    anomaly_key: str
    status: str
    comment: str = ""
    subscription_id: str = ""
    service: str = ""
    resource_name: str = ""
    period: str = ""


def _parse_day(value: Optional[str], fallback: date) -> date:
    if not value:
        return fallback
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must be formatted YYYY-MM-DD.")


def _within(rows: List[Dict[str, Any]], start: date, end: date) -> List[Dict[str, Any]]:
    """
    Rows whose usage day falls inside a window.

    Cost Management is queried daily rather than monthly here precisely so a
    partial month can be trimmed to match its comparison window. A monthly
    granularity would make the equal-elapsed-days comparison impossible, which
    is what produced the phantom savings on every incomplete month.
    """
    lo, hi = start.isoformat(), end.isoformat()
    return [r for r in rows if lo <= (r.get("day") or "") <= hi]


@router.post("/analyze")
async def analyze(
    body: AnalyzeRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Classify every cost change between the selected window and its comparison.

    Both windows are fetched in a single pass per subscription: the query spans
    the earlier of the two starts to the later of the two ends, and the rows
    are split locally. Two separate round trips would double the load on an API
    that is already the first thing to rate limit.
    """
    # Authorisation is the token resolver's job and is never skipped: the
    # subscription ids arrive from the browser and are not trusted.
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    today = date.today()
    default_start, default_end = cost_periods.month_bounds(today)
    current_start = _parse_day(body.from_date, default_start)
    current_end = _parse_day(body.to_date, default_end)

    if current_end < current_start:
        raise HTTPException(status_code=400, detail="The end date is before the start date.")

    window = cost_periods.describe(current_start, current_end, body.comparison, today)
    prev_start = datetime.strptime(window["previous_start"], "%Y-%m-%d").date()
    prev_end = datetime.strptime(window["previous_end"], "%Y-%m-%d").date()
    effective_end = datetime.strptime(window["current_effective_end"], "%Y-%m-%d").date()

    span_start = min(current_start, prev_start)
    span_end = max(effective_end, prev_end)

    async def read_sub(sub_id: str):
        return await query_usage(
            token=token,
            subscription_id=sub_id,
            group_by=["ServiceName", "ResourceGroupName", "Meter"],
            granularity="Daily",
            from_date=span_start.isoformat(),
            to_date=span_end.isoformat(),
        )

    records, errors = await gather_by_subscription(body.subscription_ids, read_sub)

    if not records and errors:
        raise HTTPException(status_code=502, detail=summarise_errors(errors, "cost detail"))

    names = subscription_names(body.tenant_id, token)
    # `gather_by_subscription` already classifies failures as retryable; it just
    # has no way to know the names. A GUID in a failure banner tells the reader
    # nothing they can act on.
    for e in errors:
        if not e.get("subscription_name"):
            e["subscription_name"] = names.get(e.get("subscription_id", ""), "")
    rows = to_cost_rows(records)
    for r in rows:
        # A GUID is not a name. The id stays available for technical detail,
        # but nothing on this page leads with it.
        r["subscription_name"] = names.get(r.get("subscription_id", ""), "")

    current_rows = _within(rows, current_start, effective_end)
    previous_rows = _within(rows, prev_start, prev_end)

    dimensions = ("service", "subscription_id", "subscription_name", "resource_group", "resource_name", "region")
    changes = engine.compare_periods(
        current_rows,
        previous_rows,
        dimensions=dimensions,
        threshold_pct=body.threshold_pct,
    )
    buckets = engine.split_changes(changes, threshold_pct=body.threshold_pct)

    period_label = f"{current_start.isoformat()}..{effective_end.isoformat()}"
    statuses = await tracking.statuses_for(db, current_user["account_id"], body.tenant_id)
    for name in ("anomalies", "new_costs", "removed_costs", "reductions", "immaterial"):
        buckets[name] = tracking.apply_statuses(buckets[name], statuses, body.tenant_id, period_label)

    currency = next((r.get("Currency") for r in records if r.get("Currency")), "USD")

    return {
        **buckets,
        "summary": engine.summarise(buckets),
        "window": window,
        "currency": currency,
        "threshold_pct": body.threshold_pct,
        "coverage": build_coverage(body.subscription_ids, errors, source="Azure Cost Management"),
    }


@router.post("/status")
async def update_status(
    body: StatusRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Record that somebody triaged an anomaly, and who."""
    # Resolving the token proves the caller has this tenant before anything is
    # written against it. A status row is not sensitive on its own; a comment
    # attached to it very much is.
    await resolve_tenant_token(body.tenant_id, current_user, db)

    try:
        result = await tracking.set_status(
            db,
            user=current_user,
            tenant_id=body.tenant_id,
            key=body.anomaly_key,
            status=body.status,
            comment=body.comment,
            subscription_id=body.subscription_id,
            service=body.service,
            resource_name=body.resource_name,
            period=body.period,
        )
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Status must be one of: {', '.join(tracking.VALID_STATUSES)}.",
        )

    history = await tracking.history_for(
        db, current_user["account_id"], body.tenant_id, body.anomaly_key
    )
    return {**result, "history": history}


@router.get("/history")
async def get_history(
    tenant_id: str,
    anomaly_key: str,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """The activity trail for one anomaly, scoped to this tenant and user."""
    await resolve_tenant_token(tenant_id, current_user, db)
    history = await tracking.history_for(
        db, current_user["account_id"], tenant_id, anomaly_key
    )
    return {"anomaly_key": anomaly_key, "history": history}
