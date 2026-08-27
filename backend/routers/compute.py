"""
Compute intelligence — the VM fleet, what it costs, and what it actually did.

This endpoint joins four independent Azure sources, and the joining is the
whole value: none of them can answer the question alone.

  * **Resource Graph** — what VMs exist, their size, region and power state.
  * **Cost Management** — what each one cost last month.
  * **Azure Monitor** — what each one was actually doing.
  * **Retail Prices** — what the proposed smaller size would cost instead.

Every one of them can fail independently, and three of the four are optional.
A missing Monitor permission must produce a fleet list with "not enough data"
against each VM, not an error page — the inventory and the cost are still true
and still useful. Which sources succeeded is reported in `sources` so the UI
can say why a column is empty rather than showing a blank cell.
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user, require_workspace_admin
from core import db as db_module
from core.db import get_db
from services import azure_metrics, compute_intel, vm_resize
from services.analysis import resource_cost_index
from services.azure_errors import azure_error
from services.cost_client import query_costs
from services.orphaned import run_graph_query
from services.retail_prices import (
    best_vm_rates, fetch_prices, price_cache, vm_sku_filter,
)
from services.token_resolver import resolve_tenant_token

router = APIRouter(prefix="/api/compute", tags=["compute"])

log = logging.getLogger(__name__)

# Power state is a per-instance property, so it is only available through the
# `instanceView` expansion Resource Graph exposes as `properties.extended`.
# Without it every VM reads as "unknown" and stopped-but-billed VMs — the most
# valuable finding here — become undetectable.
VM_QUERY = """
resources
| where type =~ 'microsoft.compute/virtualMachines'
| extend powerState = tostring(properties.extended.instanceView.powerState.code)
| extend sku = tostring(properties.hardwareProfile.vmSize)
| extend osType = tostring(properties.storageProfile.osDisk.osType)
| project id, name, sku, location, resourceGroup, subscriptionId,
          powerState, osType, tags
| order by name asc
"""


class ComputeRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str] = Field(default_factory=list)
    # 30 days matches Azure Monitor's 1-minute retention and gives a stable
    # P99. Shorter windows make the periodic-peak veto unreliable.
    days: int = Field(default=30, ge=7, le=90)
    currency: str = "USD"


def _norm_id(resource_id: Optional[str]) -> str:
    """
    A resource id in the one form both sides of the join agree on.

    Resource Graph and Cost Management disagree about the casing of every
    segment, and Cost Management sometimes appends a trailing slash. Matching
    on the raw string loses most rows silently, which looks exactly like an
    estate that costs nothing. Joining on the id rather than the VM name
    matters too: names are only unique within a resource group, so two VMs
    called `web-01` in different groups would otherwise share one cost.
    """
    return (resource_id or "").strip().rstrip("/").lower()


async def _fleet(token: str, subscription_ids: List[str]) -> List[Dict[str, Any]]:
    """The VM inventory, normalised into the shape `compute_intel` expects."""
    rows = await run_graph_query(token, subscription_ids, VM_QUERY)
    return [{
        "id": row.get("id"),
        "name": row.get("name"),
        "sku": row.get("sku") or "",
        "region": row.get("location") or "",
        "resource_group": row.get("resourceGroup") or "",
        "subscription_id": row.get("subscriptionId") or "",
        "power_state": row.get("powerState") or "",
        "os_type": row.get("osType") or "",
        "tags": row.get("tags") or {},
        # Resource Graph carries the type in lower case, which is what
        # `metrics_for` matches on.
        "type": "microsoft.compute/virtualmachines",
    } for row in rows]


async def _price_lookup(
    skus: List[str], region: str, currency: str
) -> Dict[bool, Dict[str, float]]:
    """
    Hourly retail rates for the sizes involved in a recommendation, by OS.

    One request per region, not one per region *and* operating system. The
    published meters for both operating systems come back in the same response,
    so splitting the query doubled the number of round-trips to a slow public
    API and pushed the whole page past its 60-second budget. The response is
    filtered twice instead.

    Returns `{False: linux_rates, True: windows_rates}`, each keyed lower-case.
    A partial map simply means fewer priced recommendations, which
    `estimate_savings` already handles honestly.
    """
    odata = vm_sku_filter(skus, region)
    if not odata:
        return {False: {}, True: {}}

    cached = price_cache.get((odata, currency, "by_os"))
    if cached is not None:
        return cached

    try:
        items = await fetch_prices(odata, currency=currency)
    except Exception as exc:
        log.warning("retail price lookup failed for %s: %s", region, exc)
        return {False: {}, True: {}}

    rates = {
        False: best_vm_rates(items, windows=False),
        True: best_vm_rates(items, windows=True),
    }
    price_cache.put((odata, currency, "by_os"), rates)
    return rates


@router.post("")
async def analyse_compute(
    body: ComputeRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    The VM fleet with a right-sizing verdict and an evidenced saving per machine.

    Read-only. Nothing here resizes, stops or deletes anything — the actions are
    described so an owner can carry them out in the portal or in their own IaC,
    which is where the change belongs and where it will be audited.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    sources = {"inventory": "ok", "cost": "ok", "metrics": "ok", "prices": "ok"}

    try:
        fleet = await _fleet(token, body.subscription_ids)
    except Exception as exc:
        # Inventory is the one source with no fallback. Without it there is no
        # list to annotate, so this is the only failure that ends the request.
        raise azure_error(exc, "your virtual machines")

    if not fleet:
        return {
            "vms": [], "summary": compute_intel.summarise_fleet([]),
            "currency": body.currency, "sources": sources,
            "note": "No virtual machines were found in the selected subscriptions.",
        }

    # ── cost, per resource ──
    cost_records: List[Dict[str, Any]] = []
    for sub_id in body.subscription_ids:
        try:
            cost_records.extend(await query_costs(
                token=token, subscription_id=sub_id, months=1,
                group_by=["ResourceId", "ServiceName"], granularity="Monthly",
            ))
        except Exception as exc:
            log.warning("compute cost lookup failed for %s: %s", sub_id, exc)
            sources["cost"] = "partial"

    cost_index = resource_cost_index(cost_records)
    currency = next((r.get("Currency") for r in cost_records if r.get("Currency")),
                    body.currency)

    # `resource_cost_index` is keyed by lower-cased resource id and its values
    # are `{cost, service, meters}` — a dict, not a number. Assigning the whole
    # entry to `monthly_cost` is what put "₹NaN" in the cost column and made
    # every annualisation fail, since a dict cannot be multiplied by 12.
    matched = 0
    for vm in fleet:
        entry = cost_index.get(_norm_id(vm["id"]))
        vm["monthly_cost"] = entry.get("cost") if isinstance(entry, dict) else None
        if vm["monthly_cost"] is not None:
            matched += 1

    if cost_records and not matched:
        # Cost came back but joined to nothing — that is a broken join, not an
        # estate that costs nothing, and it must not read as "free".
        log.warning(
            "compute cost join matched 0 of %d VMs against %d cost rows",
            len(fleet), len(cost_records),
        )
        sources["cost"] = "unmatched"

    # ── utilization ──
    metrics_by_id: Dict[str, Dict[str, Any]] = {}
    errors_by_id: Dict[str, str] = {}
    caps_by_id: Dict[str, Dict[str, Any]] = {}
    diag_by_id: Dict[str, Dict[str, Any]] = {}
    try:
        raw = await azure_metrics.fetch_many(token, fleet, days=body.days)
        metrics_by_id = {rid: (r.get("metrics") or {}) for rid, r in raw.items()}
        # The per-VM failure reason used to be discarded here, which is why a
        # permission gap, a throttle and a genuinely new VM all surfaced as the
        # same "Not enough data". Kept per resource so each row can say why.
        errors_by_id = {
            rid: (r.get("kind") or "")
            for rid, r in raw.items()
            if r.get("kind")
        }
        caps_by_id = {rid: (r.get("capabilities") or {}) for rid, r in raw.items()}

        names_by_id = {vm["id"]: vm.get("name") or "" for vm in fleet}
        subs_by_id = {vm["id"]: vm.get("subscription_id") or "" for vm in fleet}
        for rid, result in raw.items():
            diagnostics = dict(result.get("diagnostics") or {})
            diagnostics.update({
                "resource_id": rid,
                "namespaces": result.get("namespaces") or [],
                "window_days": body.days,
                "grain": azure_metrics.DEFAULT_GRAIN,
                "error": result.get("error"),
                "error_code": result.get("kind"),
            })
            diag_by_id[rid] = diagnostics

            # Structured, greppable, and free of anything sensitive — the
            # bearer token is never part of this record.
            if result.get("kind"):
                log.warning(
                    "compute telemetry unavailable | vm=%s | subscription=%s | "
                    "resource=%s | status=%s | requested=%s | available=%s | reason=%s",
                    names_by_id.get(rid, "?"), subs_by_id.get(rid, "?"), rid,
                    diagnostics.get("status_code"),
                    diagnostics.get("requested_metrics"),
                    diagnostics.get("available_metrics"),
                    result.get("kind"),
                )

        kinds = set(errors_by_id.values())
        if azure_metrics.NO_ACCESS in kinds:
            sources["metrics"] = "permission"
        elif azure_metrics.THROTTLED in kinds:
            sources["metrics"] = "partial"
    except Exception as exc:
        log.warning("metrics fetch failed: %s", exc)
        sources["metrics"] = "error"
        errors_by_id = {vm["id"]: azure_metrics.API_ERROR for vm in fleet}

    # ── prices for the proposed targets ──
    # Grouped by region only. The same size costs a different amount in each
    # region, so a single fleet-wide lookup would silently apply one region's
    # price everywhere — but both operating systems' meters arrive in the same
    # response, so the OS split is done on the result rather than by asking
    # twice.
    by_region: Dict[str, List[str]] = {}
    for vm in fleet:
        target = compute_intel.smaller_sku(vm["sku"])
        if target:
            by_region.setdefault(vm["region"], []).extend([vm["sku"], target])

    price_lookups = await asyncio.gather(*(
        _price_lookup(skus, region, currency)
        for region, skus in by_region.items()
    ), return_exceptions=True)

    empty = {False: {}, True: {}}
    prices_by_region: Dict[str, Dict[bool, Dict[str, float]]] = {}
    for region, result in zip(by_region.keys(), price_lookups):
        prices_by_region[region] = result if isinstance(result, dict) else empty
    if by_region and not any(
        any(by_os.values()) for by_os in prices_by_region.values()
    ):
        sources["prices"] = "unavailable"

    def _prices_for(vm: Dict[str, Any]) -> Dict[str, float]:
        """
        The rate card for this VM's operating system.

        A Windows meter carries the licence and costs roughly 2.5x the Linux
        rate for the same silicon, so quoting one size's Windows price against
        another's Linux price would be arithmetic on two different products.
        """
        by_os = prices_by_region.get(vm["region"], empty)
        windows = (vm.get("os_type") or "").lower() == "windows"
        return by_os.get(windows, {})

    analyses = [
        compute_intel.analyse_vm(
            {**vm, "currency": currency},
            metrics_by_id.get(vm["id"], {}),
            _prices_for(vm),
            telemetry_error=errors_by_id.get(vm["id"], ""),
            capabilities=caps_by_id.get(vm["id"]),
            diagnostics=diag_by_id.get(vm["id"]),
        )
        for vm in fleet
    ]
    analyses.sort(key=compute_intel.sort_key)

    # `summarise_fleet` also fills each VM's share of the fleet cost, so it
    # must run before the response is assembled.
    summary = compute_intel.summarise_fleet(analyses)
    analysed = summary["assessed"]

    return {
        "vms": analyses,
        "summary": summary,
        "currency": currency,
        "window_days": body.days,
        "sources": sources,
        # Partial success is the normal case on a large estate, so it is
        # reported as a count rather than failing the page.
        "coverage": {
            "total": len(analyses),
            "analysed": analysed,
            "not_analysed": len(analyses) - analysed,
        },
        "note": (
            "Verdicts are based on the 95th and 99th percentile of CPU over the "
            f"last {body.days} days. A machine with a low 95th percentile but a high "
            "99th has a recurring peak and is deliberately not proposed for a "
            "downsize. Machines Azure publishes no CPU metric for are listed with "
            "their cost and whatever other telemetry exists, and are never guessed at."
        ),
    }


# ── VM resize ───────────────────────────────────────────────────────────────
#
# The only write path in this application. It is split into two endpoints on
# purpose: a preview that cannot change anything, and an execution that will
# not run without an explicit confirmation. A recommendation must never be able
# to modify a customer's estate by itself.


class ResizePreviewRequest(BaseModel):
    tenant_id: str
    resource_id: str
    target_sku: str
    currency: str = "USD"
    # What Cost Management actually billed for this VM over the selected
    # window. Sent by the fleet page so the review quotes the same saving the
    # table does. Optional: without it the review falls back to list prices
    # and says so, rather than inventing a figure.
    billed_monthly: Optional[float] = None


class ResizeRequest(BaseModel):
    tenant_id: str
    resource_id: str
    target_sku: str
    # The user's explicit "yes". Defaulting this to True would make an
    # accidental request destructive, so it defaults to False and is checked.
    confirmation: bool = False
    currency: str = "USD"


def _guard_resource(resource_id: str) -> None:
    if not vm_resize.is_virtual_machine(resource_id):
        raise HTTPException(
            status_code=400,
            detail="This endpoint only resizes virtual machines.",
        )


@router.post("/resize/preview")
async def preview_resize(
    body: ResizePreviewRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    Read-only. Answers whether this resize is possible and what it would cost.

    Nothing here modifies Azure, so it is safe to call whenever the review
    screen opens. Its `can_resize` verdict is what enables the confirm button;
    the same checks are repeated server-side before anything is touched, so a
    frontend that ignores the verdict still cannot force a bad resize.
    """
    _guard_resource(body.resource_id)
    token = await resolve_tenant_token(body.tenant_id, current_user, db)
    try:
        plan = await vm_resize.preview(
            token, body.resource_id, body.target_sku, body.currency,
            billed_monthly=body.billed_monthly,
        )
    except Exception as exc:
        raise azure_error(exc, "this virtual machine")

    running = await vm_resize.active_operation_for(db, body.resource_id)
    if running:
        plan["can_resize"] = False
        plan["blockers"] = [
            "A resize is already running on this VM."
        ] + plan["blockers"]
        plan["active_operation_id"] = running["operation_id"]
    return plan


# Preview stays open to the whole workspace: it only reads. Executing the
# resize restarts a live virtual machine, so it is the owner's call.
@router.post("/resize", dependencies=[Depends(require_workspace_admin)])
async def start_resize(
    body: ResizeRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    Start a real resize, in the background, after re-checking everything.

    The request returns an operation id rather than a result: stopping,
    resizing and starting a machine takes minutes, and holding an HTTP
    connection open for that is a promise neither end can keep. Progress is
    read back from the database, so a browser refresh — or a colleague's
    browser — sees the same truthful state.

    Note what is *not* taken from the request body: the current size, the
    price, the quota, the region. Only the resource id and the desired size
    cross the wire, and both are re-validated against Azure before the first
    destructive call.
    """
    _guard_resource(body.resource_id)
    if not body.confirmation:
        raise HTTPException(
            status_code=400,
            detail="A resize requires explicit confirmation.",
        )

    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    running = await vm_resize.active_operation_for(db, body.resource_id)
    if running:
        raise HTTPException(
            status_code=409,
            detail=(
                "A resize is already running on this VM. Wait for it to finish "
                "before starting another."
            ),
        )

    try:
        plan = await vm_resize.preview(
            token, body.resource_id, body.target_sku, body.currency
        )
    except Exception as exc:
        raise azure_error(exc, "this virtual machine")

    if not plan["can_resize"]:
        raise HTTPException(status_code=409, detail=" ".join(plan["blockers"]))

    operation_id = await vm_resize.create_operation(
        db, current_user, body.tenant_id, body.resource_id, plan
    )

    # The background task opens its own connection: this one closes with the
    # request, long before the resize finishes.
    asyncio.create_task(
        vm_resize.run_resize(
            db_module.DB_PATH,
            operation_id,
            token,
            body.resource_id,
            plan["target"]["name"],
            plan["current"]["name"],
        )
    )

    return {
        "operation_id": operation_id,
        "state": vm_resize.VALIDATING,
        "state_label": vm_resize.STATE_LABEL[vm_resize.VALIDATING],
        "steps": vm_resize.initial_steps(),
        "vm_name": plan["vm"]["name"],
        "old_sku": plan["current"]["name"],
        "new_sku": plan["target"]["name"],
    }


@router.get("/resize/operations/{operation_id}")
async def resize_status(
    operation_id: str,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    Where a resize has actually got to.

    Scoped to the caller's own account, so an operation id guessed from
    somewhere else reveals nothing.
    """
    record = await vm_resize.read_operation(
        db, operation_id, current_user["account_id"]
    )
    if record is None:
        raise HTTPException(status_code=404, detail="No such resize operation.")
    return record


@router.get("/resize/history")
async def resize_history(
    tenant_id: str,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """Every resize this account has performed in this tenant."""
    records = await vm_resize.history_for(
        db, current_user["account_id"], tenant_id
    )
    return {"operations": records, "count": len(records)}


class ResizeOptionsRequest(BaseModel):
    tenant_id: str
    resource_id: str
    currency: str = "USD"
    # The VM's metered cost, so each option's saving is expressed against the
    # real bill rather than against a published rate nobody actually paid.
    billed_monthly: Optional[float] = None
    # Purely so the algorithm's suggestion can be marked in the list. The user
    # remains free to pick any size Azure will accept.
    recommended_sku: Optional[str] = None


@router.post("/resize/options")
async def resize_options(
    body: ResizeOptionsRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    Read-only. Every size this VM can move to, with quota, availability and price.

    This exists so a user can evaluate a size the right-sizing algorithm never
    suggested -- including a larger one, because a machine that is too small is
    also a problem worth fixing. Every value is read from this tenant's own
    subscription at request time; nothing is precomputed or shared between
    tenants.
    """
    _guard_resource(body.resource_id)
    token = await resolve_tenant_token(body.tenant_id, current_user, db)
    try:
        return await vm_resize.resize_options(
            token,
            body.resource_id,
            currency=body.currency,
            billed_monthly=body.billed_monthly,
            recommended_sku=body.recommended_sku,
        )
    except Exception as exc:
        raise azure_error(exc, "this virtual machine")
