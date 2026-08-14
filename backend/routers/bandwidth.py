from fastapi import APIRouter, Depends, HTTPException
import aiosqlite

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import BandwidthRequest, BandwidthResponse
from routers.costs import _get_token
from services.bandwidth import build_bandwidth_report
from services.cost_client import (
    gather_by_subscription,
    query_usage,
    summarise_errors,
)

router = APIRouter(prefix="/api/bandwidth", tags=["bandwidth"])


@router.post("", response_model=BandwidthResponse)
async def get_bandwidth(
    body: BandwidthRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Data-transfer (bandwidth) usage and spend across the selected subscriptions.
    Returns byte-accurate egress / ingress / intra-region volumes plus the
    charged amount, so the UI can show real GB / TB figures.
    """
    token = await _get_token(body.tenant_id, current_user, db)

    async def read_sub(sub_id: str):
        return await query_usage(
            token=token,
            subscription_id=sub_id,
            months=body.months,
            group_by=["MeterCategory", "MeterSubcategory", "Meter"],
            granularity=body.granularity,
            from_date=body.from_date,
            to_date=body.to_date,
        )

    all_records, errors = await gather_by_subscription(body.subscription_ids, read_sub)

    if not all_records and errors:
        raise HTTPException(status_code=502, detail=summarise_errors(errors, "bandwidth data"))

    report = build_bandwidth_report(all_records)
    report["errors"] = errors
    return BandwidthResponse(**report)
