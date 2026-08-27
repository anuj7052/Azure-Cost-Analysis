"""
Resize a virtual machine — for real, against Azure, with the brakes on.

This module is the only place in the application that changes a customer's
infrastructure. Everything else reads. That asymmetry drives every decision
here:

  * A recommendation is not a plan. `preview()` answers "could this be done,
    and what would it cost?" and touches nothing. `execute()` is a separate
    call that will not run without an explicit confirmation flag.

  * Azure is asked, never assumed. Quota, SKU availability, SKU capabilities,
    prices and the caller's permissions are all read from Azure at the moment
    they are needed. Nothing is hardcoded and nothing is carried over from the
    frontend, which may be stale, wrong, or hostile.

  * A blocked answer is better than a wrong one. If Azure will not say whether
    there is quota, the preview reports that it could not verify quota and the
    resize stays disabled. There is no default of "probably fine".

  * The VM is re-read immediately before the first destructive call. A review
    screen the user has been looking at for five minutes is not evidence about
    the machine's current size, and resizing on stale information is how a
    tool ends up shrinking something a colleague just grew.

A resize is a genuine long-running operation with a stop and a start either
side of it, so it cannot complete inside a request. `execute()` starts a
background task and returns an operation id; the caller polls. The state lives
in the database rather than in memory so that a browser refresh — or a second
browser — can still see what is happening.
"""
import asyncio
import json
import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

import aiosqlite
import httpx

from services.azure_mgmt import MGMT_BASE
from services.retail_prices import (
    best_vm_rates, fetch_prices, price_cache, region_vm_rates, vm_sku_filter,
)

log = logging.getLogger(__name__)

# The hours in an average month Azure itself bills against, matching
# `compute_intel.estimate_savings` so the two never quote different figures.
HOURS_PER_MONTH = 730

# ── Azure API versions ──────────────────────────────────────────────────────
COMPUTE_API = "2024-07-01"
SKUS_API = "2021-07-01"
AUTHZ_API = "2022-04-01"

REQUEST_TIMEOUT = 60.0

# How long to keep asking Azure whether a stop/resize/start has finished.
# A resize of a large machine is minutes, not seconds; a machine that has not
# settled after this long is reported as timed out rather than assumed good.
POLL_INTERVAL_SECONDS = 5.0
POLL_TIMEOUT_SECONDS = 900.0

# The Azure control-plane action a caller needs to change a VM's size. Read
# permissions are not enough, and offering a button that will predictably fail
# is worse than not offering it.
WRITE_ACTION = "Microsoft.Compute/virtualMachines/write"


# ── operation states ────────────────────────────────────────────────────────
#
# Named states rather than a spinner. Each one tells the reader something
# different about what has happened to their machine and what is safe to do
# next — "Stopping" and "Resized, not started" are not the same situation, and
# a single "Loading…" flattens both into nothing.

VALIDATING = "VALIDATING"
QUOTA_CHECK = "QUOTA_CHECK"
SKU_CHECK = "SKU_CHECK"
AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
STOPPING = "STOPPING"
RESIZING = "RESIZING"
STARTING = "STARTING"
VERIFYING = "VERIFYING"
SUCCESS = "SUCCESS"
FAILED = "FAILED"
CANCELLED = "CANCELLED"

TERMINAL_STATES = frozenset({SUCCESS, FAILED, CANCELLED})

STATE_LABEL = {
    VALIDATING: "Validating configuration",
    QUOTA_CHECK: "Checking quota",
    SKU_CHECK: "Checking size availability",
    AWAITING_CONFIRMATION: "Awaiting confirmation",
    STOPPING: "Stopping VM",
    RESIZING: "Changing VM size",
    STARTING: "Starting VM",
    VERIFYING: "Verifying VM",
    SUCCESS: "Resize complete",
    FAILED: "Resize failed",
    CANCELLED: "Cancelled",
}

# The ordered checklist the progress view renders. Kept here so the backend
# owns the definition of "what happens" and the UI cannot invent a step.
STEP_SEQUENCE = [
    ("validate", "Validate configuration"),
    ("quota", "Check quota"),
    ("sku", "Check target size availability"),
    ("stop", "Stop VM"),
    ("resize", "Change VM size"),
    ("start", "Start VM"),
    ("verify", "Verify VM"),
]

STEP_PENDING = "pending"
STEP_ACTIVE = "active"
STEP_DONE = "done"
STEP_FAILED = "failed"
STEP_SKIPPED = "skipped"


def initial_steps() -> List[Dict[str, str]]:
    return [
        {"key": key, "label": label, "status": STEP_PENDING}
        for key, label in STEP_SEQUENCE
    ]


def _set_step(steps: List[Dict[str, str]], key: str, status: str) -> List[Dict[str, str]]:
    for step in steps:
        if step["key"] == key:
            step["status"] = status
    return steps


# ── small helpers ───────────────────────────────────────────────────────────


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def split_resource_id(resource_id: str) -> Dict[str, str]:
    """
    Pull the subscription, resource group and name out of an ARM id.

    Done by position rather than by regex so that a malformed id produces empty
    strings the caller can reject, instead of a confident match on the wrong
    segment.
    """
    parts = [p for p in (resource_id or "").split("/") if p]
    out = {"subscription_id": "", "resource_group": "", "name": "", "provider": ""}
    for index, part in enumerate(parts):
        lowered = part.lower()
        if lowered == "subscriptions" and index + 1 < len(parts):
            out["subscription_id"] = parts[index + 1]
        elif lowered == "resourcegroups" and index + 1 < len(parts):
            out["resource_group"] = parts[index + 1]
        elif lowered == "providers" and index + 2 < len(parts):
            out["provider"] = f"{parts[index + 1]}/{parts[index + 2]}"
    if parts:
        out["name"] = parts[-1]
    return out


def is_virtual_machine(resource_id: str) -> bool:
    return (
        split_resource_id(resource_id)["provider"].lower()
        == "microsoft.compute/virtualmachines"
    )


def _capability(sku: Dict[str, Any], name: str) -> Optional[str]:
    for item in sku.get("capabilities") or []:
        if (item.get("name") or "").lower() == name.lower():
            return item.get("value")
    return None


def _as_int(value: Optional[str]) -> Optional[int]:
    try:
        return int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _as_float(value: Optional[str]) -> Optional[float]:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def describe_sku(sku: Optional[Dict[str, Any]], name: str = "") -> Dict[str, Any]:
    """
    The facts about a size that a person needs in order to approve a change.

    Every field is `None` when Azure did not return it. A missing vCPU count is
    reported as missing; it is never shown as zero, which would read as a real
    measurement of a machine with no processors.
    """
    if not sku:
        return {
            "name": name,
            "family": None,
            "vcpu": None,
            "memory_gb": None,
            "architecture": None,
            "generation": None,
            "max_data_disks": None,
            "temp_disk_gb": None,
            "premium_disk_supported": None,
            "accelerated_networking": None,
            "available": False,
        }
    temp_disk_mb = _as_float(_capability(sku, "MaxResourceVolumeMB"))
    return {
        "name": sku.get("name") or name,
        "family": sku.get("family"),
        "vcpu": _as_int(_capability(sku, "vCPUs")),
        "memory_gb": _as_float(_capability(sku, "MemoryGB")),
        "architecture": _capability(sku, "CpuArchitectureType"),
        "generation": _capability(sku, "HyperVGenerations"),
        "max_data_disks": _as_int(_capability(sku, "MaxDataDiskCount")),
        "temp_disk_gb": round(temp_disk_mb / 1024, 1) if temp_disk_mb else None,
        "premium_disk_supported": _capability(sku, "PremiumIO"),
        "accelerated_networking": _capability(sku, "AcceleratedNetworkingEnabled"),
        "available": True,
    }


# ── Azure reads ─────────────────────────────────────────────────────────────


async def get_vm(client: httpx.AsyncClient, token: str, resource_id: str) -> Dict[str, Any]:
    """The VM as Azure currently sees it, including its live power state."""
    url = f"{MGMT_BASE}{resource_id}"
    resp = await client.get(
        url,
        params={"api-version": COMPUTE_API, "$expand": "instanceView"},
        headers=_headers(token),
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def vm_facts(vm: Dict[str, Any]) -> Dict[str, Any]:
    properties = vm.get("properties") or {}
    hardware = properties.get("hardwareProfile") or {}
    instance = properties.get("instanceView") or {}
    power = ""
    for status in instance.get("statuses") or []:
        code = status.get("code") or ""
        if code.startswith("PowerState/"):
            power = code.split("/", 1)[1]
    storage = properties.get("storageProfile") or {}
    os_disk = storage.get("osDisk") or {}
    return {
        "name": vm.get("name") or "",
        "region": vm.get("location") or "",
        "sku": hardware.get("vmSize") or "",
        "power_state": power or "unknown",
        "os_type": (os_disk.get("osType") or "").lower(),
        "provisioning_state": properties.get("provisioningState") or "",
        "data_disk_count": len(storage.get("dataDisks") or []),
        "zones": vm.get("zones") or [],
    }


async def list_skus(
    client: httpx.AsyncClient, token: str, subscription_id: str, region: str
) -> List[Dict[str, Any]]:
    """
    Every VM size Azure will offer this subscription in this region.

    The filter is applied server-side because the unfiltered catalogue is tens
    of thousands of entries. Restrictions are returned alongside each size and
    are the difference between "this size exists" and "you may deploy it".
    """
    url = f"{MGMT_BASE}/subscriptions/{subscription_id}/providers/Microsoft.Compute/skus"
    params = {"api-version": SKUS_API, "$filter": f"location eq '{region}'"}
    items: List[Dict[str, Any]] = []
    while url:
        resp = await client.get(url, params=params, headers=_headers(token),
                                timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        items.extend(
            item for item in data.get("value") or []
            if (item.get("resourceType") or "").lower() == "virtualmachines"
        )
        url = data.get("nextLink")
        params = {}
    return items


def find_sku(skus: List[Dict[str, Any]], name: str) -> Optional[Dict[str, Any]]:
    wanted = (name or "").lower()
    for sku in skus:
        if (sku.get("name") or "").lower() == wanted:
            return sku
    return None


def restriction_reason(sku: Optional[Dict[str, Any]], region: str, zones: List[str]) -> str:
    """
    Why this subscription may not deploy this size here, in Azure's words.

    A size can be listed for a region and still be refused — capacity holds,
    subscription-level offer restrictions, zone-specific shortages. Reading the
    restrictions is the difference between an honest "unavailable" and a resize
    that fails halfway with the machine already stopped.
    """
    if not sku:
        return "Azure does not offer this size in this region for this subscription."
    for restriction in sku.get("restrictions") or []:
        kind = (restriction.get("type") or "").lower()
        values = restriction.get("values") or []
        reason = restriction.get("reasonCode") or "Restricted"
        if kind == "location" and any(v.lower() == region.lower() for v in values):
            return f"Azure restricts this size in {region} for this subscription ({reason})."
        if kind == "zone":
            info = restriction.get("restrictionInfo") or {}
            blocked = {z for z in info.get("zones") or []}
            if zones and blocked and set(zones) & blocked:
                return (
                    f"Azure restricts this size in availability zone(s) "
                    f"{', '.join(sorted(set(zones) & blocked))} ({reason})."
                )
    return ""


async def get_quota(
    client: httpx.AsyncClient, token: str, subscription_id: str, region: str
) -> List[Dict[str, Any]]:
    url = (
        f"{MGMT_BASE}/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Compute/locations/{region}/usages"
    )
    resp = await client.get(url, params={"api-version": COMPUTE_API},
                            headers=_headers(token), timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.json().get("value") or []


def quota_for_family(usages: List[Dict[str, Any]], family: str) -> Optional[Dict[str, Any]]:
    wanted = (family or "").lower()
    for usage in usages:
        name = usage.get("name") or {}
        if (name.get("value") or "").lower() == wanted:
            return usage
    return None


def assess_quota(
    usages: List[Dict[str, Any]],
    current: Dict[str, Any],
    target: Dict[str, Any],
    region: str,
) -> Dict[str, Any]:
    """
    Whether the subscription has room for the target size.

    The check is performed even when shrinking. A resize inside one family
    releases the old cores before it claims the new ones, but a resize across
    families claims new cores against a quota that may be full, and the total
    regional core quota applies either way. Assuming a downsize is always safe
    is how a "saving" turns into a stopped machine that will not start.
    """
    family = target.get("family") or ""
    unverified = {
        "status": "unverified",
        "label": "Quota could not be verified",
        "region": region,
        "family": family or None,
        "current_usage": None,
        "limit": None,
        "available": None,
        "required": target.get("vcpu"),
        "note": "Azure did not return quota figures for this family, so the "
                "resize cannot be confirmed as safe.",
    }
    if not usages or not family:
        return unverified

    usage = quota_for_family(usages, family)
    if usage is None:
        return unverified

    limit = _as_int(usage.get("limit"))
    used = _as_int(usage.get("currentValue"))
    required = target.get("vcpu")
    if limit is None or used is None or required is None:
        return unverified

    # Cores already held by this machine come back when it is resized, but only
    # when both sizes bill against the same family quota.
    returned = current.get("vcpu") or 0 if (current.get("family") or "") == family else 0
    available = limit - used + returned

    ok = available >= required
    return {
        "status": "available" if ok else "insufficient",
        "label": "Quota available" if ok else "Quota insufficient",
        "region": region,
        "family": family,
        "family_label": ((usage.get("name") or {}).get("localizedValue")) or family,
        "current_usage": used,
        "limit": limit,
        "available": available,
        "required": required,
        "note": ""
        if ok
        else (
            f"{required} vCPU are needed and {available} are available in the "
            f"{family} quota for {region}."
        ),
    }


async def can_write(
    client: httpx.AsyncClient, token: str, resource_id: str
) -> Dict[str, Any]:
    """
    Whether the caller may actually change this VM.

    Asked of Azure rather than inferred from the fact that the user could read
    the machine. Reading costs and changing infrastructure are different rights
    and are routinely granted separately.
    """
    url = f"{MGMT_BASE}{resource_id}/providers/Microsoft.Authorization/permissions"
    try:
        resp = await client.get(url, params={"api-version": AUTHZ_API},
                                headers=_headers(token), timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        return {
            "status": "unverified",
            "label": "Permissions could not be verified",
            "allowed": False,
            "note": f"Azure did not return the permission list ({exc.__class__.__name__}).",
        }

    allowed = False
    for entry in resp.json().get("value") or []:
        actions = [a.lower() for a in entry.get("actions") or []]
        not_actions = [a.lower() for a in entry.get("notActions") or []]
        if any(_action_matches(a, WRITE_ACTION) for a in actions) and not any(
            _action_matches(a, WRITE_ACTION) for a in not_actions
        ):
            allowed = True
    return {
        "status": "allowed" if allowed else "denied",
        "label": "You may resize this VM" if allowed else "Resize unavailable",
        "allowed": allowed,
        "note": ""
        if allowed
        else (
            "You have permission to view this VM, but you do not have "
            "permission to modify it."
        ),
    }


def _action_matches(pattern: str, action: str) -> bool:
    """`*` and `Microsoft.Compute/*` both grant a specific write action."""
    pattern = pattern.strip().lower()
    action = action.lower()
    if pattern == "*":
        return True
    if pattern.endswith("/*"):
        return action.startswith(pattern[:-1])
    return pattern == action


# ── pricing ─────────────────────────────────────────────────────────────────


async def price_pair(
    current_sku: str,
    target_sku: str,
    region: str,
    os_type: str,
    currency: str,
    billed_monthly: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Monthly compute rate for both sizes, or an honest gap.

    Windows meters carry the licence, so the operating system decides which
    meter is the right one to quote. When a rate cannot be resolved the price
    is `None` and no saving is derived from it — a saving computed against a
    missing number is a guess wearing a currency symbol.

    List prices are what Azure publishes, not what this tenant pays: a
    reservation, a Hybrid Benefit licence or a part-month runtime can put the
    two a long way apart. So when the caller knows the metered cost, the
    published prices are used only for their *ratio*, and that ratio is applied
    to the real bill. A saving quoted larger than the bill it comes off is not
    a rounding error, it is a reason to distrust the whole page.
    """
    result = {
        "currency": currency,
        "current_monthly": None,
        "target_monthly": None,
        "billed_monthly": billed_monthly,
        "monthly_saving": None,
        "annual_saving": None,
        "basis": "price_unavailable",
        "note": "Azure Retail Prices did not return a rate for these sizes.",
    }

    odata = vm_sku_filter({current_sku, target_sku}, region)
    if not odata:
        return result

    # List prices are identical for every customer and change on the order of
    # months, so the review does not re-query a slow public endpoint each time
    # somebody opens it. Nothing tenant-specific is cached here.
    items = price_cache.get((odata, currency))
    if items is None:
        try:
            items = await fetch_prices(odata, currency=currency)
        except Exception as exc:  # pragma: no cover - network shape varies
            log.warning("retail price lookup failed for %s/%s: %s", current_sku, target_sku, exc)
            return result
        price_cache.put((odata, currency), items)

    best = best_vm_rates(items, windows=os_type.lower() == "windows")
    current_rate = best.get((current_sku or "").lower())
    target_rate = best.get((target_sku or "").lower())
    result["current_monthly"] = (
        round(current_rate * HOURS_PER_MONTH, 2) if current_rate is not None else None
    )
    result["target_monthly"] = (
        round(target_rate * HOURS_PER_MONTH, 2) if target_rate is not None else None
    )
    if current_rate is not None and target_rate is not None:
        if billed_monthly is not None and billed_monthly > 0 and current_rate > 0:
            reduction = max(0.0, 1.0 - (target_rate / current_rate))
            monthly = round(billed_monthly * reduction, 2)
            result["basis"] = "actual_cost_and_retail_ratio"
            result["note"] = (
                "Calculated by applying the published price difference between "
                "these two sizes to what this VM actually cost over the "
                "selected period."
            )
        else:
            monthly = round((current_rate - target_rate) * HOURS_PER_MONTH, 2)
            result["basis"] = "retail_prices"
            result["note"] = (
                "No billed cost was available for this VM, so this is a list-price "
                "estimate from Azure Retail Prices for this region and operating "
                "system. Your negotiated or reserved rates may differ."
            )
        result["monthly_saving"] = monthly
        result["annual_saving"] = round(monthly * 12, 2)
    elif current_rate is not None or target_rate is not None:
        result["basis"] = "partial_prices"
        result["note"] = (
            "Azure returned a rate for only one of the two sizes, so no saving "
            "can be calculated."
        )
    return result


# ── preview ─────────────────────────────────────────────────────────────────


async def preview(
    token: str,
    resource_id: str,
    target_sku: str,
    currency: str = "USD",
    billed_monthly: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Everything a person needs in order to decide, and nothing that changes Azure.

    This function performs only GETs. It is safe to call on every modal open,
    and its verdict is what gates the confirm button.
    """
    parts = split_resource_id(resource_id)
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        vm = await get_vm(client, token, resource_id)
        facts = vm_facts(vm)
        region = facts["region"]
        subscription_id = parts["subscription_id"]

        permission = await can_write(client, token, resource_id)

        skus: List[Dict[str, Any]] = []
        sku_error = ""
        try:
            skus = await list_skus(client, token, subscription_id, region)
        except httpx.HTTPError as exc:
            sku_error = f"Azure did not return the size catalogue ({exc.__class__.__name__})."

        usages: List[Dict[str, Any]] = []
        try:
            usages = await get_quota(client, token, subscription_id, region)
        except httpx.HTTPError as exc:
            log.warning("quota lookup failed for %s: %s", subscription_id, exc)

        current_raw = find_sku(skus, facts["sku"])
        target_raw = find_sku(skus, target_sku)
        current = describe_sku(current_raw, facts["sku"])
        target = describe_sku(target_raw, target_sku)

        blocked = restriction_reason(target_raw, region, facts["zones"])
        if sku_error:
            availability = {
                "status": "unverified",
                "label": "Availability could not be verified",
                "region": region,
                "note": sku_error,
            }
        elif target_raw is None:
            availability = {
                "status": "unavailable",
                "label": "Not available in this region",
                "region": region,
                "note": "This SKU is currently unavailable for this region/subscription.",
            }
        elif blocked:
            availability = {
                "status": "restricted",
                "label": "Restricted for this subscription",
                "region": region,
                "note": blocked,
            }
        else:
            availability = {
                "status": "available",
                "label": "Available",
                "region": region,
                "note": "",
            }

        quota = assess_quota(usages, current, target, region)
        pricing = await price_pair(
            facts["sku"], target_sku, region, facts["os_type"], currency,
            billed_monthly=billed_monthly,
        )

    compatibility = assess_compatibility(current, target, facts)

    blockers: List[str] = []
    if not permission["allowed"]:
        blockers.append(permission["note"] or permission["label"])
    if availability["status"] != "available":
        blockers.append(availability["note"] or availability["label"])
    if quota["status"] != "available":
        blockers.append(quota["note"] or quota["label"])
    if compatibility["status"] == "incompatible":
        blockers.extend(compatibility["issues"])
    if facts["sku"].lower() == (target_sku or "").lower():
        blockers.append("This VM is already running the recommended size.")

    return {
        "resource_id": resource_id,
        "vm": {
            "name": facts["name"],
            "region": region,
            "resource_group": parts["resource_group"],
            "subscription_id": subscription_id,
            "power_state": facts["power_state"],
            "os_type": facts["os_type"],
            "data_disk_count": facts["data_disk_count"],
        },
        "current": current,
        "target": target,
        "availability": availability,
        "quota": quota,
        "permission": permission,
        "compatibility": compatibility,
        "pricing": pricing,
        "downtime": {
            "required": True,
            "title": "VM downtime required",
            "detail": (
                "The VM must be stopped and deallocated before its size can be "
                "changed, and will be started again afterwards. Applications "
                "running on this VM will be temporarily unavailable."
            ),
            "duration": "Temporary downtime — Azure does not publish a "
                        "predictable duration for a resize.",
        },
        "cost_scope_note": (
            "Estimated savings apply to VM compute charges. Managed disks, "
            "public IPs, bandwidth and other attached resources may continue "
            "to incur charges."
        ),
        "plan": [label for _, label in STEP_SEQUENCE[3:]],
        "can_resize": not blockers,
        "blockers": blockers,
        "state": AWAITING_CONFIRMATION if not blockers else FAILED,
    }


def assess_compatibility(
    current: Dict[str, Any], target: Dict[str, Any], facts: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Whether the target size can host this machine as it is configured.

    Only checks that Azure gives a factual basis for are made. Where a
    capability was not returned the check is reported as unverified rather than
    quietly passed.
    """
    issues: List[str] = []
    unverified: List[str] = []

    if target.get("architecture") and current.get("architecture"):
        if target["architecture"] != current["architecture"]:
            issues.append(
                f"The target size uses {target['architecture']} while this VM "
                f"runs on {current['architecture']}. An operating system built "
                f"for one architecture will not boot on the other."
            )
    else:
        unverified.append("CPU architecture")

    max_disks = target.get("max_data_disks")
    if max_disks is None:
        unverified.append("data disk capacity")
    elif facts.get("data_disk_count", 0) > max_disks:
        issues.append(
            f"This VM has {facts['data_disk_count']} data disks but the target "
            f"size supports {max_disks}."
        )

    if current.get("generation") and target.get("generation"):
        current_gens = {g.strip() for g in current["generation"].split(",") if g.strip()}
        target_gens = {g.strip() for g in target["generation"].split(",") if g.strip()}
        if current_gens and target_gens and not (current_gens & target_gens):
            issues.append(
                f"The target size supports Hyper-V generation "
                f"{target['generation']} but this VM's size supports "
                f"{current['generation']}."
            )
    else:
        unverified.append("Hyper-V generation")

    if issues:
        status, label = "incompatible", "Not compatible with this VM"
    elif unverified:
        status, label = "unverified", "Partly verified"
    else:
        status, label = "compatible", "Compatible"

    return {
        "status": status,
        "label": label,
        "issues": issues,
        "unverified": unverified,
        "note": ""
        if not unverified
        else "Azure did not report " + ", ".join(unverified) + " for these sizes.",
    }


# ── long-running operations ─────────────────────────────────────────────────


async def _await_operation(
    client: httpx.AsyncClient, token: str, resp: httpx.Response
) -> Tuple[bool, str]:
    """
    Follow an Azure async operation to its real conclusion.

    A 202 means "accepted", not "done". Treating it as done is how a tool
    reports a successful resize on a machine that is still stopping.
    """
    if resp.status_code < 300 and resp.status_code != 202:
        return True, ""

    url = resp.headers.get("azure-asyncoperation") or resp.headers.get("location")
    if not url:
        return True, ""

    waited = 0.0
    while waited < POLL_TIMEOUT_SECONDS:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        waited += POLL_INTERVAL_SECONDS
        poll = await client.get(url, headers=_headers(token), timeout=REQUEST_TIMEOUT)
        if poll.status_code == 202:
            continue
        if poll.status_code >= 400:
            return False, f"Azure returned HTTP {poll.status_code}: {poll.text[:300]}"
        try:
            body = poll.json()
        except ValueError:
            return True, ""
        status = (body.get("status") or "").lower()
        if status in ("inprogress", "running", "accepted", ""):
            continue
        if status == "succeeded":
            return True, ""
        error = (body.get("error") or {}).get("message") or status
        return False, f"Azure reported {status}: {error}"
    return False, (
        f"Azure did not finish this operation within {int(POLL_TIMEOUT_SECONDS / 60)} minutes."
    )


async def _post_action(
    client: httpx.AsyncClient, token: str, resource_id: str, action: str
) -> Tuple[bool, str]:
    resp = await client.post(
        f"{MGMT_BASE}{resource_id}/{action}",
        params={"api-version": COMPUTE_API},
        headers=_headers(token),
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code >= 400:
        return False, f"Azure returned HTTP {resp.status_code}: {resp.text[:300]}"
    return await _await_operation(client, token, resp)


async def _patch_size(
    client: httpx.AsyncClient, token: str, resource_id: str, target_sku: str
) -> Tuple[bool, str]:
    resp = await client.patch(
        f"{MGMT_BASE}{resource_id}",
        params={"api-version": COMPUTE_API},
        headers=_headers(token),
        json={"properties": {"hardwareProfile": {"vmSize": target_sku}}},
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code >= 400:
        return False, f"Azure returned HTTP {resp.status_code}: {resp.text[:300]}"
    return await _await_operation(client, token, resp)


# ── audit records ───────────────────────────────────────────────────────────


async def create_operation(
    db: aiosqlite.Connection,
    current_user: dict,
    tenant_id: str,
    resource_id: str,
    plan: Dict[str, Any],
) -> str:
    """
    Open the audit record before anything is touched.

    Written first so that a crash mid-resize still leaves evidence that this
    application asked Azure to change the machine.
    """
    operation_id = uuid.uuid4().hex
    parts = split_resource_id(resource_id)
    pricing = plan.get("pricing") or {}
    await db.execute(
        """
        INSERT INTO vm_resize_operations (
            operation_id, user_id, tenant_id, subscription_id, resource_id,
            vm_name, region, old_sku, new_sku, old_power_state,
            old_monthly_price, new_monthly_price, estimated_monthly_saving,
            currency, state, steps
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            operation_id,
            current_user["account_id"],
            tenant_id,
            parts["subscription_id"],
            resource_id,
            (plan.get("vm") or {}).get("name") or parts["name"],
            (plan.get("vm") or {}).get("region") or "",
            (plan.get("current") or {}).get("name") or "",
            (plan.get("target") or {}).get("name") or "",
            (plan.get("vm") or {}).get("power_state") or "",
            pricing.get("current_monthly"),
            pricing.get("target_monthly"),
            pricing.get("monthly_saving"),
            pricing.get("currency") or "USD",
            VALIDATING,
            json.dumps(initial_steps()),
        ),
    )
    await db.commit()
    return operation_id


async def update_operation(
    db: aiosqlite.Connection, operation_id: str, **fields: Any
) -> None:
    if not fields:
        return
    if "steps" in fields and not isinstance(fields["steps"], str):
        fields["steps"] = json.dumps(fields["steps"])
    assignments = ", ".join(f"{key} = ?" for key in fields)
    await db.execute(
        f"UPDATE vm_resize_operations SET {assignments}, updated_at = datetime('now') "
        f"WHERE operation_id = ?",
        (*fields.values(), operation_id),
    )
    await db.commit()


async def read_operation(
    db: aiosqlite.Connection, operation_id: str, account_id: int
) -> Optional[Dict[str, Any]]:
    async with db.execute(
        "SELECT * FROM vm_resize_operations WHERE operation_id = ? AND user_id = ?",
        (operation_id, account_id),
    ) as cursor:
        row = await cursor.fetchone()
    return row_to_dict(row) if row else None


async def active_operation_for(
    db: aiosqlite.Connection, resource_id: str
) -> Optional[Dict[str, Any]]:
    """
    Any resize already under way on this machine, whoever started it.

    Deliberately not scoped to the caller: two people with access to the same
    VM double-clicking from different desks is exactly the collision this
    guards against.
    """
    placeholders = ", ".join("?" for _ in TERMINAL_STATES)
    async with db.execute(
        f"SELECT * FROM vm_resize_operations WHERE resource_id = ? "
        f"AND state NOT IN ({placeholders}) ORDER BY id DESC LIMIT 1",
        (resource_id, *sorted(TERMINAL_STATES)),
    ) as cursor:
        row = await cursor.fetchone()
    return row_to_dict(row) if row else None


async def history_for(
    db: aiosqlite.Connection, account_id: int, tenant_id: str, limit: int = 50
) -> List[Dict[str, Any]]:
    async with db.execute(
        "SELECT * FROM vm_resize_operations WHERE user_id = ? AND tenant_id = ? "
        "ORDER BY id DESC LIMIT ?",
        (account_id, tenant_id, limit),
    ) as cursor:
        rows = await cursor.fetchall()
    return [row_to_dict(row) for row in rows]


def row_to_dict(row: aiosqlite.Row) -> Dict[str, Any]:
    record = dict(row)
    try:
        record["steps"] = json.loads(record.get("steps") or "[]")
    except (TypeError, ValueError):
        record["steps"] = []
    record["state_label"] = STATE_LABEL.get(record.get("state", ""), record.get("state", ""))
    record["terminal"] = record.get("state") in TERMINAL_STATES
    return record


# ── execution ───────────────────────────────────────────────────────────────


async def run_resize(
    db_path: str,
    operation_id: str,
    token: str,
    resource_id: str,
    target_sku: str,
    expected_sku: str,
) -> None:
    """
    Stop, resize, start, verify — reporting each transition as it happens.

    Opens its own database connection because it outlives the request that
    started it. Every failure leaves the record in a state that names what did
    happen: a machine that was resized but would not start is not a failed
    resize, and telling the user it was would send them looking for the wrong
    problem.
    """
    conn = await aiosqlite.connect(db_path)
    conn.row_factory = aiosqlite.Row
    steps = initial_steps()

    async def fail(step: str, reason: str, **extra: Any) -> None:
        _set_step(steps, step, STEP_FAILED)
        await update_operation(
            conn, operation_id, state=FAILED, steps=steps,
            failure_reason=reason, completed_at=_now_sql(), **extra,
        )

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            # 11. Re-validate against Azure, not against the review screen.
            _set_step(steps, "validate", STEP_ACTIVE)
            await update_operation(conn, operation_id, state=VALIDATING, steps=steps)

            try:
                vm = await get_vm(client, token, resource_id)
            except httpx.HTTPError as exc:
                await fail("validate", f"The VM could not be read from Azure ({exc}).")
                return

            facts = vm_facts(vm)
            if facts["sku"].lower() != (expected_sku or "").lower():
                await fail(
                    "validate",
                    "VM configuration changed since this review. Please refresh "
                    "and review the resize again.",
                )
                return
            if facts["sku"].lower() == target_sku.lower():
                await fail("validate", "This VM is already running the target size.")
                return

            permission = await can_write(client, token, resource_id)
            if not permission["allowed"]:
                await fail("validate", permission["note"] or permission["label"])
                return
            _set_step(steps, "validate", STEP_DONE)

            # Quota and availability, re-read rather than carried over.
            parts = split_resource_id(resource_id)
            region = facts["region"]
            _set_step(steps, "quota", STEP_ACTIVE)
            await update_operation(conn, operation_id, state=QUOTA_CHECK, steps=steps)
            try:
                usages = await get_quota(client, token, parts["subscription_id"], region)
                skus = await list_skus(client, token, parts["subscription_id"], region)
            except httpx.HTTPError as exc:
                await fail("quota", f"Azure did not return quota or size information ({exc}).")
                return

            current_desc = describe_sku(find_sku(skus, facts["sku"]), facts["sku"])
            target_raw = find_sku(skus, target_sku)
            target_desc = describe_sku(target_raw, target_sku)
            quota = assess_quota(usages, current_desc, target_desc, region)
            if quota["status"] != "available":
                await fail("quota", quota["note"] or quota["label"])
                return
            _set_step(steps, "quota", STEP_DONE)

            _set_step(steps, "sku", STEP_ACTIVE)
            await update_operation(conn, operation_id, state=SKU_CHECK, steps=steps)
            blocked = restriction_reason(target_raw, region, facts["zones"])
            if target_raw is None or blocked:
                await fail("sku", blocked or
                           "This SKU is currently unavailable for this region/subscription.")
                return
            compatibility = assess_compatibility(current_desc, target_desc, facts)
            if compatibility["status"] == "incompatible":
                await fail("sku", "; ".join(compatibility["issues"]))
                return
            _set_step(steps, "sku", STEP_DONE)

            # 6-7. Stop -- but only a machine that is actually running.
            # A deallocated VM is resized in place: there is no downtime to
            # cause, and stopping it again would be a no-op round trip.
            was_running = facts["power_state"] == "running"
            _set_step(steps, "stop", STEP_ACTIVE)
            await update_operation(conn, operation_id, state=STOPPING, steps=steps)
            if was_running:
                ok, error = await _post_action(client, token, resource_id, "deallocate")
                if not ok:
                    await fail("stop", f"The VM could not be stopped. {error}")
                    return
            _set_step(steps, "stop", STEP_DONE)

            # 8. Resize.
            _set_step(steps, "resize", STEP_ACTIVE)
            await update_operation(conn, operation_id, state=RESIZING, steps=steps)
            ok, error = await _patch_size(client, token, resource_id, target_sku)
            if not ok:
                # The machine is stopped and unchanged. Say so, and put it back.
                _set_step(steps, "resize", STEP_FAILED)
                await update_operation(
                    conn, operation_id, state=FAILED, steps=steps,
                    final_power_state="deallocated",
                    failure_reason=(
                        f"The resize failed and the VM is currently stopped. {error}"
                    ),
                )
                return
            _set_step(steps, "resize", STEP_DONE)

            # 9-10. Start -- only to restore the state we found. Starting a
            # machine the user had deliberately stopped would begin charging
            # them for it, which is the opposite of what this page is for.
            _set_step(steps, "start", STEP_ACTIVE)
            await update_operation(conn, operation_id, state=STARTING, steps=steps)
            if was_running:
                started, start_error = await _post_action(client, token, resource_id, "start")
            else:
                started, start_error = True, ""
            _set_step(steps, "start", STEP_DONE if started else STEP_FAILED)

            # 11-12. Verify against Azure, never against our own intentions.
            _set_step(steps, "verify", STEP_ACTIVE)
            await update_operation(conn, operation_id, state=VERIFYING, steps=steps)
            try:
                final = vm_facts(await get_vm(client, token, resource_id))
            except httpx.HTTPError as exc:
                _set_step(steps, "verify", STEP_FAILED)
                await update_operation(
                    conn, operation_id, state=FAILED, steps=steps,
                    failure_reason=(
                        f"The resize was submitted but the VM could not be "
                        f"re-read to confirm it ({exc})."
                    ),
                )
                return

            resized = final["sku"].lower() == target_sku.lower()
            _set_step(steps, "verify", STEP_DONE if resized else STEP_FAILED)

            if resized and started:
                await update_operation(
                    conn, operation_id, state=SUCCESS, steps=steps,
                    new_sku=final["sku"], final_power_state=final["power_state"],
                    failure_reason="", completed_at=_now_sql(),
                )
            elif resized:
                await update_operation(
                    conn, operation_id, state=FAILED, steps=steps,
                    new_sku=final["sku"], final_power_state=final["power_state"],
                    failure_reason=(
                        f"Resize completed, but the VM could not be started. "
                        f"{start_error}"
                    ),
                    completed_at=_now_sql(),
                )
            else:
                await update_operation(
                    conn, operation_id, state=FAILED, steps=steps,
                    final_power_state=final["power_state"],
                    failure_reason=(
                        f"Azure reported no error, but the VM is still "
                        f"{final['sku']}. The resize did not take effect."
                    ),
                    completed_at=_now_sql(),
                )
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("resize %s failed", operation_id)
        await update_operation(
            conn, operation_id, state=FAILED, steps=steps,
            failure_reason=f"The resize stopped unexpectedly: {exc}",
        )
    finally:
        await conn.close()


def _now_sql() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ── choosing a size ─────────────────────────────────────────────────────────


async def list_resize_sizes(
    client: httpx.AsyncClient, token: str, resource_id: str
) -> List[Dict[str, Any]]:
    """
    The sizes Azure says *this* VM can be resized to, right now.

    This is not the regional catalogue. It is the list Azure computes from the
    cluster the machine is currently placed on, so it already accounts for
    hardware generation and local capacity. Offering the catalogue instead
    would present sizes that are certain to be refused at resize time.
    """
    url = f"{MGMT_BASE}{resource_id}/vmSizes"
    resp = await client.get(url, params={"api-version": COMPUTE_API},
                            headers=_headers(token), timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.json().get("value") or []


async def _rates_for(
    names: List[str], region: str, windows: bool, currency: str
) -> Dict[str, float]:
    """
    Hourly rate per size name, lower-cased, for whatever Azure could price.

    A region offers hundreds of sizes and Azure's pricing filter refuses more
    than about fifteen names at once -- asking for them in batches returned
    "Invalid OData parameters supplied" for every batch, which the UI then
    rendered, correctly but uselessly, as "Price not available" against every
    single size. So the whole region is fetched once and read from memory.
    """
    if not names:
        return {}
    by_os = await region_vm_rates(region, currency)
    return by_os.get(bool(windows), {})


async def resize_options(
    token: str,
    resource_id: str,
    currency: str = "USD",
    billed_monthly: Optional[float] = None,
    recommended_sku: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Every size this VM could move to, each with its own quota, availability and
    price, so the choice is the user's rather than the algorithm's.

    Nothing here is hardcoded: the sizes come from the VM, the capabilities and
    restrictions from the subscription's own catalogue, the quota from the
    subscription's usage, and the prices from Azure's published rates. A figure
    Azure did not return stays `None` and is rendered as unknown -- never as
    zero, which would read as a free machine.
    """
    parts = split_resource_id(resource_id)
    subscription_id = parts["subscription_id"]

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        vm = await get_vm(client, token, resource_id)
        facts = vm_facts(vm)
        region = facts["region"]

        sizes, skus, usages = await asyncio.gather(
            list_resize_sizes(client, token, resource_id),
            list_skus(client, token, subscription_id, region),
            get_quota(client, token, subscription_id, region),
            return_exceptions=True,
        )

    # Each source degrades on its own. Losing prices should not cost the user
    # the quota check, and losing quota should not hide the sizes.
    notes: List[str] = []
    if isinstance(sizes, Exception):
        log.warning("vmSizes unavailable for %s: %s", resource_id, sizes)
        sizes = []
        notes.append("Azure did not return the list of sizes this VM can move to.")
    if isinstance(skus, Exception):
        log.warning("sku catalogue unavailable in %s: %s", region, skus)
        skus = []
        notes.append("Size capabilities and regional restrictions could not be read.")
    if isinstance(usages, Exception):
        log.warning("quota unavailable in %s: %s", region, usages)
        usages = []
        notes.append("Quota could not be read, so headroom is shown as unverified.")

    names = [s.get("name") or "" for s in sizes if s.get("name")]
    if not names:
        names = [s.get("name") or "" for s in skus if s.get("name")]

    current_name = facts["sku"]
    if current_name and current_name.lower() not in {n.lower() for n in names}:
        names.append(current_name)

    try:
        rates = await _rates_for(
            names, region, facts["os_type"] == "windows", currency
        )
    except Exception as exc:  # pragma: no cover - network shape varies
        log.warning("pricing unavailable in %s: %s", region, exc)
        rates = {}
    if names and not rates:
        notes.append("Azure Retail Prices did not return rates for this region.")

    current_sku = find_sku(skus, current_name)
    current = describe_sku(current_sku, current_name)
    current_rate = rates.get(current_name.lower())
    recommended = (recommended_sku or "").lower()

    # `vmSizes` carries core and memory counts even when the catalogue does
    # not, so it fills the gaps rather than leaving a size undescribed.
    by_name = {(s.get("name") or "").lower(): s for s in sizes}

    options: List[Dict[str, Any]] = []
    for name in sorted(set(names), key=str.lower):
        catalogue = find_sku(skus, name)
        described = describe_sku(catalogue, name)
        fallback = by_name.get(name.lower()) or {}
        if described["vcpu"] is None:
            described["vcpu"] = fallback.get("numberOfCores")
        if described["memory_gb"] is None and fallback.get("memoryInMB"):
            described["memory_gb"] = round(fallback["memoryInMB"] / 1024, 1)
        if described["max_data_disks"] is None:
            described["max_data_disks"] = fallback.get("maxDataDiskCount")

        is_current = name.lower() == current_name.lower()
        restriction = restriction_reason(catalogue, region, facts["zones"]) if skus else ""
        quota = assess_quota(usages, current, described, region)
        compatibility = assess_compatibility(current, described, facts)

        rate = rates.get(name.lower())
        monthly = round(rate * HOURS_PER_MONTH, 2) if rate is not None else None

        # A saving is only meaningful against a bill. Where the bill is known
        # the published prices supply the ratio and nothing more; where it is
        # not, the list-price gap is shown and labelled as such.
        delta = None
        if rate is not None and current_rate is not None and not is_current:
            if billed_monthly is not None and billed_monthly > 0 and current_rate > 0:
                delta = round(billed_monthly * (1 - (rate / current_rate)), 2)
            else:
                delta = round((current_rate - rate) * HOURS_PER_MONTH, 2)

        blockers: List[str] = []
        if is_current:
            blockers.append("This VM is already running this size.")
        if restriction:
            blockers.append(restriction)
        if quota["status"] != "available":
            blockers.append(quota["note"] or quota["label"])
        if compatibility["status"] == "incompatible":
            blockers.extend(compatibility["issues"])

        vcpu = described["vcpu"]
        change = "same"
        if vcpu is not None and current["vcpu"] is not None:
            change = "smaller" if vcpu < current["vcpu"] else (
                "larger" if vcpu > current["vcpu"] else "same"
            )

        options.append({
            **described,
            "is_current": is_current,
            "is_recommended": name.lower() == recommended and not is_current,
            "change": change,
            "monthly_list_price": monthly,
            "estimated_monthly_delta": delta,
            "quota": {
                "status": quota["status"],
                "label": quota["label"],
                "available": quota["available"],
                "required": quota["required"],
            },
            "availability": {
                "status": "available" if not restriction else "unavailable",
                "label": "Available" if not restriction else "Not available",
                "note": restriction,
            },
            # A region can offer hundreds of sizes, so each one carries only
            # what the picker shows. The full compatibility breakdown is
            # re-derived by the preview for the single size actually chosen;
            # anything that would stop the resize is already in `blockers`.
            "compatibility_status": compatibility["status"],
            "selectable": not blockers,
            "blockers": blockers,
        })

    return {
        "resource_id": resource_id,
        "vm": {
            "name": facts["name"],
            "region": region,
            "resource_group": parts["resource_group"],
            "subscription_id": subscription_id,
            "power_state": facts["power_state"],
            "os_type": facts["os_type"],
        },
        "current": current,
        "currency": currency,
        "billed_monthly": billed_monthly,
        "price_basis": (
            "actual_cost_and_retail_ratio"
            if billed_monthly is not None and billed_monthly > 0 else "retail_prices"
        ),
        "options": options,
        "notes": notes,
        "source": "azure_vm_sizes" if sizes else "subscription_sku_catalogue",
    }
