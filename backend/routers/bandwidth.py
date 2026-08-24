from fastapi import APIRouter, Depends, HTTPException
import aiosqlite
import logging
from pydantic import BaseModel

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import BandwidthRequest, BandwidthResponse
from routers.costs import _get_token
from services.bandwidth import build_bandwidth_report, detect_unit_bytes, is_bandwidth_record
from services import bandwidth_traffic
from services.orphaned import run_graph_query
from services.cost_client import (
    gather_by_subscription,
    query_daily_usage,
    query_usage,
    summarise_errors,
)

router = APIRouter(prefix="/api/bandwidth", tags=["bandwidth"])

log = logging.getLogger(__name__)


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


class TrafficRequest(BaseModel):
    """Which addresses and resource groups produced the data-transfer charge."""
    tenant_id: str
    subscription_ids: list[str]
    months: int = 6
    from_date: str | None = None
    to_date: str | None = None


# Every public IP in the selected subscriptions, with what it is plugged into.
# Resource Graph answers this for all subscriptions in one call, which matters:
# listing them per subscription is a round trip each and was never going to fit
# inside a page load on a large account.
PUBLIC_IP_QUERY = """
resources
| where type =~ 'microsoft.network/publicipaddresses'
| project id, name, location, sku, properties, resourceGroup, subscriptionId
"""


@router.post("/traffic")
async def get_bandwidth_traffic(
    body: TrafficRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Trace a bandwidth charge back to the resource that produced it.

    Asks Cost Management to break the charge down by resource id, which names
    the actual virtual machine, gateway or storage account. Not every agreement
    will group a usage-quantity query that finely, so a 400 falls back to
    resource-group level rather than failing the page — and the response says
    which level it got, because "this VM" and "something in this group" are
    different answers and must not look alike.

    Public IP addresses are attached where they can be read, but they are an
    enrichment, not the basis: the resource breakdown stands without them.

    Per-connection detail — remote addresses, ports, protocols — is not returned
    because it does not exist unless NSG flow logs were enabled at the time. The
    response says so explicitly instead of appearing to have found nothing.
    """
    token = await _get_token(body.tenant_id, current_user, db)
    # Set to "group" by the fallback below. Read after the fan-out completes.
    level = "resource"

    async def read_sub(sub_id: str):
        nonlocal level

        async def at_group_level():
            return await query_usage(
                token=token,
                subscription_id=sub_id,
                months=body.months,
                group_by=["ResourceGroupName", "Meter", "MeterCategory"],
                granularity="Monthly",
                from_date=body.from_date,
                to_date=body.to_date,
            )

        try:
            rows = await query_usage(
                token=token,
                subscription_id=sub_id,
                months=body.months,
                # ResourceId names the individual machine. This is the whole
                # point of the endpoint, so it is tried first and every time.
                group_by=["ResourceId", "Meter"],
                granularity="Monthly",
                from_date=body.from_date,
                to_date=body.to_date,
            )
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status != 400:
                raise
            level = "group"
            log.info("ResourceId grouping refused for %s; falling back to group level", sub_id)
            return await at_group_level()

        # Some agreements accept the dimension and then return it empty. That
        # produces rows nothing can be attributed to, which looks identical to a
        # broken feature, so treat it as a refusal and ask again by group.
        if rows and not any(r.get("ResourceId") for r in rows):
            level = "group"
            log.info("ResourceId came back empty for %s; falling back to group level", sub_id)
            return await at_group_level()

        return rows

    records, errors = await gather_by_subscription(body.subscription_ids, read_sub)
    transfer = [r for r in records if is_bandwidth_record(r)]

    # A missing IP inventory costs us the addresses, nothing else. Resource
    # Graph needs a permission that Cost Management does not, and an earlier
    # version let that failure blank the entire section.
    ips = []
    ip_error = None
    try:
        rows = await run_graph_query(token, body.subscription_ids, PUBLIC_IP_QUERY)
        ips = [
            bandwidth_traffic.normalise_ip(row, row.get("subscriptionId", ""))
            for row in rows
        ]
    except Exception as exc:  # noqa: BLE001 - degraded mode is deliberate
        log.info("Public IP inventory unavailable: %s", exc)
        ip_error = (
            "Public IP addresses could not be read, so rows below are named by "
            "resource but carry no address. This needs Reader on the "
            "subscriptions; the charges themselves are unaffected."
        )

    if not transfer and errors:
        raise HTTPException(status_code=502, detail=summarise_errors(errors, "bandwidth traffic"))

    report = bandwidth_traffic.build_traffic_report(
        transfer, detect_unit_bytes, ips=ips, level=level
    )
    report["currency"] = next((r.get("Currency") for r in records if r.get("Currency")), "INR")
    report["errors"] = errors
    report["ip_error"] = ip_error
    return report


class ResourceDailyRequest(BaseModel):
    """
    One resource, day by day.

    `resource_id` is preferred; `resource_group` is the fallback for accounts
    where Cost Management would only attribute charges to a group. Sending both
    is allowed — the finer one wins — but sending neither is not, because an
    unfiltered daily query over a large subscription returns tens of thousands
    of rows to answer a question about one machine.
    """
    tenant_id: str
    subscription_ids: list[str]
    from_date: str
    to_date: str
    resource_id: str | None = None
    resource_group: str | None = None


@router.post("/resource-daily")
async def get_resource_daily(
    body: ResourceDailyRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    The daily shape of one resource's transfer cost.

    A monthly figure cannot tell a steady trickle from one bad afternoon, and
    the two have different causes and different fixes. Filtering happens
    server-side at Azure rather than here, because the alternative is pulling a
    whole subscription's daily rows to keep a handful.
    """
    if not body.resource_id and not body.resource_group:
        raise HTTPException(
            status_code=400,
            detail="Either resource_id or resource_group is required to scope the daily query.",
        )

    token = await _get_token(body.tenant_id, current_user, db)
    filters = (
        {"ResourceId": body.resource_id} if body.resource_id
        else {"ResourceGroupName": body.resource_group}
    )

    async def read_sub(sub_id: str):
        return await query_daily_usage(
            token=token,
            subscription_id=sub_id,
            from_date=body.from_date,
            to_date=body.to_date,
            filters=filters,
            group_by=["Meter"],
        )

    records, errors = await gather_by_subscription(body.subscription_ids, read_sub)
    transfer = [r for r in records if is_bandwidth_record(r)]

    if not transfer and errors:
        raise HTTPException(status_code=502, detail=summarise_errors(errors, "daily bandwidth"))

    series = bandwidth_traffic.build_daily_series(transfer, detect_unit_bytes)
    series["currency"] = next((r.get("Currency") for r in records if r.get("Currency")), "INR")
    series["errors"] = errors
    series["scope"] = body.resource_id or body.resource_group
    return series
