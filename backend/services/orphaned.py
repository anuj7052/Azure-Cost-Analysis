"""
Find Azure resources that are still being billed but are attached to nothing.

The value of this feature is entirely in its precision. A list padded with
resources that turn out to be in use gets ignored after the first few false
alarms, so every rule here keys off a property Azure itself uses to express
"nothing is attached", never off a name, a tag or an age heuristic.

Each rule states the exact condition that makes the resource waste, so the UI
can explain *why* something was flagged rather than asking the user to trust a
number.
"""
from typing import Any, Dict, List

import httpx

MGMT_BASE = "https://management.azure.com"
GRAPH_URL = f"{MGMT_BASE}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01"

# Severity drives ordering in the UI: "certain waste" first, "probable" after.
CERTAIN = "certain"
LIKELY = "likely"


class OrphanRule:
    """One detection rule: a Resource Graph query plus how to describe a hit."""

    def __init__(self, key: str, title: str, severity: str, reason: str, query: str):
        self.key = key
        self.title = title
        self.severity = severity
        self.reason = reason
        self.query = query


# `managedBy` is set while a disk is attached to a VM, so an empty managedBy on
# an Unattached disk is Azure's own statement that nothing owns it.
UNATTACHED_DISKS = OrphanRule(
    key="unattached_disks",
    title="Unattached managed disks",
    severity=CERTAIN,
    reason="Disk is not attached to any virtual machine but is still billed for its provisioned size.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.compute/disks' "
        "| where properties.diskState =~ 'Unattached' "
        "| where isempty(managedBy) "
        "| extend sizeGb = toint(properties.diskSizeGB), "
        "         skuName = tostring(sku.name) "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags, "
        "          sizeGb, skuName"
    ),
)

# A public IP bills whenever it is reserved. Standard SKU addresses bill even
# when they are not associated with anything, which is the common surprise.
UNASSOCIATED_PUBLIC_IPS = OrphanRule(
    key="unassociated_public_ips",
    title="Unassociated public IP addresses",
    severity=CERTAIN,
    reason="Public IP is reserved and billed but not associated with any network interface, load balancer or gateway.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.network/publicipaddresses' "
        "| where isnull(properties.ipConfiguration) "
        "| where properties.publicIPAllocationMethod =~ 'Static' "
        "   or tostring(sku.name) =~ 'Standard' "
        "| extend skuName = tostring(sku.name), "
        "         ipAddress = tostring(properties.ipAddress) "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags, "
        "          skuName, ipAddress"
    ),
)

# A NIC with no virtualMachine and no private link binding is dead wiring. It is
# usually free itself, but it pins the IP and subnet it holds.
ORPHANED_NICS = OrphanRule(
    key="orphaned_nics",
    title="Orphaned network interfaces",
    severity=LIKELY,
    reason="Network interface is not attached to a virtual machine and holds IP configuration that blocks reuse.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.network/networkinterfaces' "
        "| where isnull(properties.virtualMachine) "
        "| where isnull(properties.privateEndpoint) "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags"
    ),
)

# An NSG attached to nothing enforces nothing. Free, but it is configuration
# debt that hides which rules are actually live.
UNUSED_NSGS = OrphanRule(
    key="unused_nsgs",
    title="Unused network security groups",
    severity=LIKELY,
    reason="Network security group is not attached to any subnet or network interface, so its rules are not enforced.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.network/networksecuritygroups' "
        "| where isnull(properties.subnets) or array_length(properties.subnets) == 0 "
        "| where isnull(properties.networkInterfaces) or array_length(properties.networkInterfaces) == 0 "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags"
    ),
)

# A stopped-but-allocated VM still bills full compute. "Deallocated" is free;
# "Stopped" is not, and the difference is invisible in the portal's VM list.
STOPPED_NOT_DEALLOCATED_VMS = OrphanRule(
    key="stopped_vms",
    title="Stopped (not deallocated) virtual machines",
    severity=CERTAIN,
    reason="VM is powered off but still allocated, so compute is billed at the full rate. Deallocate it to stop the charge.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.compute/virtualmachines' "
        "| extend powerState = tostring(properties.extended.instanceView.powerState.code) "
        "| where powerState =~ 'PowerState/stopped' "
        "| extend vmSize = tostring(properties.hardwareProfile.vmSize) "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags, "
        "          vmSize, powerState"
    ),
)

# A disk snapshot has no lifecycle of its own: nothing ever deletes it.
OLD_SNAPSHOTS = OrphanRule(
    key="old_snapshots",
    title="Snapshots older than 90 days",
    severity=LIKELY,
    reason="Snapshot has existed for over 90 days and is billed for its full size. Confirm it is still needed for recovery.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.compute/snapshots' "
        "| extend created = todatetime(properties.timeCreated) "
        "| where created < ago(90d) "
        "| extend sizeGb = toint(properties.diskSizeGB), "
        "         ageDays = toint(datetime_diff('day', now(), created)) "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags, "
        "          sizeGb, ageDays, created"
    ),
)

# An empty App Service plan keeps billing its instances with nothing deployed.
EMPTY_APP_SERVICE_PLANS = OrphanRule(
    key="empty_app_service_plans",
    title="Empty App Service plans",
    severity=CERTAIN,
    reason="App Service plan has no apps deployed but continues to bill for its reserved instances.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.web/serverfarms' "
        "| where toint(properties.numberOfSites) == 0 "
        "| extend skuName = tostring(sku.name), "
        "         skuTier = tostring(sku.tier), "
        "         workers = toint(sku.capacity) "
        "| where skuTier !~ 'Free' "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags, "
        "          skuName, skuTier, workers"
    ),
)

# A load balancer with no backend pool members serves no traffic.
EMPTY_LOAD_BALANCERS = OrphanRule(
    key="empty_load_balancers",
    title="Load balancers with no backend targets",
    severity=LIKELY,
    reason="Load balancer has no backend pool members, so it cannot serve traffic while still billing for its SKU.",
    query=(
        "Resources "
        "| where type =~ 'microsoft.network/loadbalancers' "
        "| where isnull(properties.backendAddressPools) "
        "   or array_length(properties.backendAddressPools) == 0 "
        "| extend skuName = tostring(sku.name) "
        "| where skuName =~ 'Standard' "
        "| project id, name, type, resourceGroup, subscriptionId, location, tags, skuName"
    ),
)

RULES: List[OrphanRule] = [
    UNATTACHED_DISKS,
    STOPPED_NOT_DEALLOCATED_VMS,
    UNASSOCIATED_PUBLIC_IPS,
    EMPTY_APP_SERVICE_PLANS,
    OLD_SNAPSHOTS,
    EMPTY_LOAD_BALANCERS,
    ORPHANED_NICS,
    UNUSED_NSGS,
]

RULES_BY_KEY = {rule.key: rule for rule in RULES}


async def run_graph_query(
    token: str,
    subscription_ids: List[str],
    query: str,
) -> List[Dict[str, Any]]:
    """Run one Resource Graph query, following paging to the end."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body: Dict[str, Any] = {
        "subscriptions": subscription_ids,
        "query": query,
        "options": {"$top": 1000},
    }

    results: List[Dict[str, Any]] = []
    skip_token = None
    async with httpx.AsyncClient(timeout=60) as client:
        while True:
            if skip_token:
                body["options"]["$skipToken"] = skip_token
            resp = await client.post(GRAPH_URL, headers=headers, json=body)
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("data", []))
            skip_token = data.get("$skipToken")
            if not skip_token:
                break

    return results


def _describe(rule: OrphanRule, row: Dict[str, Any]) -> str:
    """A one-line detail that makes the finding actionable without a drill-down."""
    if rule.key == "unattached_disks":
        return f"{row.get('sizeGb') or '?'} GB · {row.get('skuName') or 'unknown SKU'}"
    if rule.key == "stopped_vms":
        return f"{row.get('vmSize') or 'unknown size'} · still allocated"
    if rule.key == "unassociated_public_ips":
        return f"{row.get('ipAddress') or 'no address'} · {row.get('skuName') or ''}".strip(" ·")
    if rule.key == "empty_app_service_plans":
        workers = row.get("workers") or 1
        return f"{row.get('skuName') or ''} · {workers} instance(s) · no apps".strip(" ·")
    if rule.key == "old_snapshots":
        return f"{row.get('sizeGb') or '?'} GB · {row.get('ageDays') or '?'} days old"
    if rule.key == "empty_load_balancers":
        return f"{row.get('skuName') or ''} · empty backend pool".strip(" ·")
    return ""


async def find_orphaned_resources(
    token: str,
    subscription_ids: List[str],
    cost_index: Dict[str, Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """
    Run every detection rule and return the findings grouped by category.

    `cost_index` maps a lowercased resource id to its recent billed cost. It is
    optional because a throttled billing query must not hide the inventory: the
    finding is still true without a price, it just cannot be ranked by money.

    One failing rule never fails the whole scan. A tenant that denies read on
    one provider should still see everything the other rules found, with the
    failure reported rather than silently swallowed.
    """
    cost_index = cost_index or {}
    categories: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    total_monthly_cost = 0.0
    total_count = 0

    for rule in RULES:
        try:
            rows = await run_graph_query(token, subscription_ids, rule.query)
        except Exception as exc:
            errors.append({"rule": rule.key, "error": str(exc)[:200]})
            continue

        items: List[Dict[str, Any]] = []
        category_cost = 0.0

        for row in rows:
            resource_id = (row.get("id") or "").lower()
            billed = cost_index.get(resource_id, {})
            cost = billed.get("cost")
            if cost:
                category_cost += cost

            items.append({
                "id": row.get("id", ""),
                "name": row.get("name", ""),
                "type": row.get("type", ""),
                "resource_group": row.get("resourceGroup", ""),
                "subscription_id": row.get("subscriptionId", ""),
                "location": row.get("location", ""),
                "tags": row.get("tags") or {},
                "detail": _describe(rule, row),
                "monthly_cost": cost,
            })

        # Most expensive first so the biggest saving is the first thing read.
        items.sort(key=lambda i: (i["monthly_cost"] is None, -(i["monthly_cost"] or 0.0)))

        total_monthly_cost += category_cost
        total_count += len(items)

        categories.append({
            "key": rule.key,
            "title": rule.title,
            "severity": rule.severity,
            "reason": rule.reason,
            "count": len(items),
            "monthly_cost": round(category_cost, 2),
            "items": items,
        })

    # Categories with real money attached lead, then by how many were found.
    categories.sort(key=lambda c: (-c["monthly_cost"], -c["count"]))

    return {
        "categories": categories,
        "total_count": total_count,
        "total_monthly_cost": round(total_monthly_cost, 2),
        "errors": errors,
    }
