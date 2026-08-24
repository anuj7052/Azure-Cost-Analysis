"""
Bandwidth traffic tracking — which resource produced the data-transfer charge.

**The question.** A bandwidth bill says "Data Transfer Out — 412 GB". It does not
say which machine sent it, or what that machine is. So the only question a user
actually has — *why am I paying this?* — is unanswerable from the headline.

**The answer, in descending order of precision.** Azure will not always give the
finest breakdown, so this asks for the best available and reports which one it
got, rather than pretending they are equivalent:

  `resource`  — cost attributed to an individual resource id. We can name the
                virtual machine, gateway or storage account, and say what type
                it is. This is what we want.
  `group`     — cost attributed only to a resource group. We can name the group
                and every meter inside it, but not the machine.

**Every meter carries its own price.** For each meter on each resource the report
gives billed quantity, unit, cost, and the unit rate derived from them. A user
asking "which data, and what did it cost" gets a per-line answer, not a total.

**Public IPs are a bonus, not the basis.** Where the address inventory is
readable it is attached to the resources it serves, so an endpoint gets a name
*and* an address. Where it is not, the report is unaffected — the resource
breakdown never depended on it. This matters because the address inventory needs
a permission that billing does not, and an earlier version of this module made
the whole section vanish when that permission was missing.

**What Azure will not tell you at any price.** Per-flow detail — remote
addresses, ports, who downloaded what — lives in NSG flow logs, which must be
enabled in advance. If they were off, last month's flows were never recorded and
no API can recover them. The report says so rather than showing an empty table.
"""
from typing import Any, Dict, Iterable, List, Optional

GB = 1024 ** 3

# ARM type -> what to call it on screen. Anything unlisted falls back to the
# type's own last segment, which is usually readable enough.
RESOURCE_TYPES = {
    "microsoft.compute/virtualmachines": "Virtual machine",
    "microsoft.compute/virtualmachinescalesets": "VM scale set",
    "microsoft.network/loadbalancers": "Load balancer",
    "microsoft.network/applicationgateways": "Application gateway",
    "microsoft.network/azurefirewalls": "Firewall",
    "microsoft.network/virtualnetworkgateways": "VPN / ExpressRoute gateway",
    "microsoft.network/natgateways": "NAT gateway",
    "microsoft.network/publicipaddresses": "Public IP",
    "microsoft.network/bastionhosts": "Bastion",
    "microsoft.network/frontdoors": "Front Door",
    "microsoft.cdn/profiles": "CDN profile",
    "microsoft.storage/storageaccounts": "Storage account",
    "microsoft.sql/servers": "SQL server",
    "microsoft.web/sites": "App Service",
    "microsoft.containerservice/managedclusters": "Kubernetes cluster",
    "microsoft.documentdb/databaseaccounts": "Cosmos DB",
    "microsoft.cache/redis": "Redis cache",
    "microsoft.recoveryservices/vaults": "Recovery vault",
}

# Public IPs attached to these are the usual egress points.
ATTACHMENT_KINDS = {
    "networkinterfaces": "Virtual machine",
    "loadbalancers": "Load balancer",
    "applicationgateways": "Application gateway",
    "azurefirewalls": "Firewall",
    "virtualnetworkgateways": "VPN / ExpressRoute gateway",
    "natgateways": "NAT gateway",
    "bastionhosts": "Bastion",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _segment(resource_id: str, key: str) -> str:
    """Pull a named segment out of an ARM resource id, case-insensitively."""
    parts = [p for p in _text(resource_id).split("/") if p]
    lowered = [p.lower() for p in parts]
    try:
        return parts[lowered.index(key.lower()) + 1]
    except (ValueError, IndexError):
        return ""


def type_of(resource_id: str) -> str:
    """
    The ARM type embedded in a resource id, lowercased.

    Cost Management returns resource ids in mixed case and sometimes lowercased
    wholesale, so every comparison downstream has to be case-insensitive.
    """
    parts = [p for p in _text(resource_id).split("/") if p]
    lowered = [p.lower() for p in parts]
    if "providers" not in lowered:
        return ""
    at = lowered.index("providers")
    if len(parts) < at + 3:
        return ""
    return f"{parts[at + 1]}/{parts[at + 2]}".lower()


def friendly_type(resource_id: str) -> str:
    """'Virtual machine' rather than 'microsoft.compute/virtualmachines'."""
    arm = type_of(resource_id)
    if not arm:
        return "Unknown"
    if arm in RESOURCE_TYPES:
        return RESOURCE_TYPES[arm]
    tail = arm.rsplit("/", 1)[-1].rstrip("s")
    return tail.replace("_", " ").capitalize() or "Unknown"


def attachment_of(ip: Dict[str, Any]) -> Dict[str, str]:
    """What a public IP is plugged into, or that it is plugged into nothing."""
    props = ip.get("properties") or {}
    config = props.get("ipConfiguration") or {}
    target = _text(config.get("id"))

    if not target:
        for key in ("natGateway", "publicIPPrefix"):
            nested = props.get(key) or {}
            if nested.get("id"):
                target = _text(nested["id"])
                break

    if not target:
        return {"kind": "Unattached", "name": "", "resource_id": ""}

    lowered = [p.lower() for p in target.split("/") if p]
    kind = "Attached"
    for token, friendly in ATTACHMENT_KINDS.items():
        if token in lowered:
            kind = friendly
            break

    name = ""
    for token in ATTACHMENT_KINDS:
        found = _segment(target, token)
        if found:
            name = found
            break
    if not name:
        name = target.rsplit("/", 1)[-1]

    return {"kind": kind, "name": name, "resource_id": target}


def normalise_ip(raw: Dict[str, Any], subscription_id: str = "") -> Dict[str, Any]:
    """One public IP resource, flattened to what the report needs."""
    props = raw.get("properties") or {}
    resource_id = _text(raw.get("id"))
    attachment = attachment_of(raw)

    return {
        "name": _text(raw.get("name")),
        "ip_address": _text(props.get("ipAddress")),
        "version": _text(props.get("publicIPAddressVersion")) or "IPv4",
        "allocation": _text(props.get("publicIPAllocationMethod")),
        "sku": (raw.get("sku") or {}).get("name") or "",
        "region": _text(raw.get("location")),
        "resource_group": _segment(resource_id, "resourceGroups") or _text(raw.get("resourceGroup")),
        "subscription_id": subscription_id or _segment(resource_id, "subscriptions"),
        "resource_id": resource_id,
        "fqdn": _text((props.get("dnsSettings") or {}).get("fqdn")),
        "attached_to": attachment["name"],
        "attached_kind": attachment["kind"],
        "attached_resource_id": attachment["resource_id"],
        "is_attached": attachment["kind"] != "Unattached",
    }


def _resource_id(rec: Dict[str, Any]) -> str:
    for key in ("ResourceId", "resourceId", "InstanceId", "instanceId"):
        found = _text(rec.get(key))
        if found:
            return found
    return ""


def _group_of(rec: Dict[str, Any]) -> str:
    for key in ("ResourceGroupName", "ResourceGroup", "resourceGroup"):
        found = _text(rec.get(key))
        if found:
            return found
    return _segment(_resource_id(rec), "resourceGroups")


def _rate(cost: float, quantity: float) -> Optional[float]:
    """Cost per billed unit, or None where there is no quantity to divide by."""
    return round(cost / quantity, 6) if quantity else None


def build_traffic_report(
    records: Iterable[Dict[str, Any]],
    unit_bytes,
    ips: Optional[List[Dict[str, Any]]] = None,
    level: str = "resource",
    flow_logs_enabled: bool = False,
) -> Dict[str, Any]:
    """
    Fold data-transfer charges into one row per resource (or per group).

    `unit_bytes` is injected rather than imported so this module does not need to
    know how a meter's unit maps to bytes — that judgement already lives in
    `services.bandwidth` and belongs in exactly one place.
    """
    ips = ips or []
    entries: Dict[str, Dict[str, Any]] = {}

    for rec in records:
        resource_id = _resource_id(rec)
        group = _group_of(rec) or "(no resource group)"

        # Key on the resource when Azure gave us one, otherwise on the group.
        # Mixed responses are possible, and keying on whichever is present keeps
        # both kinds of row addressable instead of collapsing them together.
        key = (resource_id or f"rg::{group}").lower()
        name = resource_id.rsplit("/", 1)[-1] if resource_id else group

        entry = entries.setdefault(key, {
            "key": key,
            "name": name,
            "resource_id": resource_id,
            "kind": friendly_type(resource_id) if resource_id else "Resource group",
            "resource_group": group,
            "region": _text(rec.get("ResourceLocation") or rec.get("resourceLocation")),
            "subscription_id": _text(rec.get("SubscriptionId")),
            "is_resource": bool(resource_id),
            "bytes": 0.0,
            "cost": 0.0,
            "_meters": {},
        })

        quantity = _num(rec.get("UsageQuantity") or rec.get("usageQuantity"))
        cost = _num(rec.get("PreTaxCost") or rec.get("totalCost") or rec.get("Cost"))
        size = quantity * unit_bytes(rec)
        unit = _text(rec.get("UnitOfMeasure") or rec.get("unitOfMeasure"))
        meter_name = _text(rec.get("Meter") or rec.get("MeterName")) or "Unknown meter"

        entry["bytes"] += size
        entry["cost"] += cost
        if not entry["region"]:
            entry["region"] = _text(rec.get("ResourceLocation") or rec.get("resourceLocation"))

        meter = entry["_meters"].setdefault(meter_name, {
            "meter": meter_name,
            "category": _text(rec.get("MeterCategory")) or "Bandwidth",
            "unit": unit,
            "quantity": 0.0,
            "bytes": 0.0,
            "cost": 0.0,
        })
        meter["quantity"] += quantity
        meter["bytes"] += size
        meter["cost"] += cost
        if not meter["unit"]:
            meter["unit"] = unit

    # Attach addresses to the resources they serve. Matching is by attachment
    # first (exact), then by resource group (indicative). An address matched only
    # by group is labelled as such so the two are never confused.
    by_attachment: Dict[str, Dict[str, Any]] = {}
    by_group: Dict[str, List[Dict[str, Any]]] = {}
    for ip in ips:
        if ip.get("attached_resource_id"):
            by_attachment[ip["attached_resource_id"].lower()] = ip
        by_group.setdefault((ip.get("resource_group") or "").lower(), []).append(ip)

    rows: List[Dict[str, Any]] = []
    for entry in entries.values():
        meters = sorted(entry.pop("_meters").values(), key=lambda m: m["cost"], reverse=True)
        entry["meters"] = [
            {
                **m,
                "quantity": round(m["quantity"], 4),
                "bytes": round(m["bytes"]),
                "gb": round(m["bytes"] / GB, 4) if m["bytes"] else 0.0,
                "cost": round(m["cost"], 4),
                "unit_rate": _rate(m["cost"], m["quantity"]),
                "cost_per_gb": _rate(m["cost"], m["bytes"] / GB) if m["bytes"] else None,
            }
            for m in meters
        ]
        entry["meter_count"] = len(meters)
        entry["top_meter"] = meters[0]["meter"] if meters else None
        entry["gb"] = round(entry["bytes"] / GB, 4) if entry["bytes"] else 0.0
        entry["bytes"] = round(entry["bytes"])
        entry["cost"] = round(entry["cost"], 2)
        entry["cost_per_gb"] = _rate(entry["cost"], entry["gb"]) if entry["gb"] else None

        addresses = _addresses_for(entry, by_attachment, by_group)
        entry["addresses"] = addresses
        entry["ip_list"] = [a["ip_address"] for a in addresses if a["ip_address"]]
        entry["explain"] = _explain(entry)
        entry["kql"] = kql_for(entry)
        rows.append(entry)

    rows.sort(key=lambda r: r["cost"], reverse=True)

    total_cost = sum(r["cost"] for r in rows)
    total_bytes = sum(r["bytes"] for r in rows)
    named = [r for r in rows if r["is_resource"]]
    idle_ips = [ip for ip in ips if not ip["is_attached"]]

    return {
        "level": level,
        "rows": rows,
        "totals": {
            "tracked_cost": round(total_cost, 2),
            "tracked_bytes": round(total_bytes),
            "tracked_gb": round(total_bytes / GB, 3) if total_bytes else 0.0,
            "row_count": len(rows),
            "named_resource_count": len(named),
            "ip_count": len(ips),
            "idle_ip_count": len(idle_ips),
        },
        "idle_ips": [
            {**ip, "note": "Reserved but attached to nothing. It bills hourly and "
                           "moves no data, so it is pure waste unless held deliberately."}
            for ip in idle_ips
        ],
        "flow_logs": flow_log_status(flow_logs_enabled),
        "method": _method(level),
    }


def _addresses_for(entry, by_attachment, by_group) -> List[Dict[str, Any]]:
    """Public IPs belonging to this row, exact matches first."""
    found: List[Dict[str, Any]] = []
    seen = set()

    exact = by_attachment.get((entry.get("resource_id") or "").lower())
    if exact:
        found.append({**exact, "match": "attached"})
        seen.add(exact["resource_id"])

    for ip in by_group.get((entry.get("resource_group") or "").lower(), []):
        if ip["resource_id"] in seen:
            continue
        found.append({**ip, "match": "same resource group"})
        seen.add(ip["resource_id"])

    return found[:6]


def _explain(entry: Dict[str, Any]) -> str:
    """One sentence a user can act on, specific to what this row actually is."""
    kind = entry["kind"]
    gb = entry["gb"]
    where = f" in {entry['resource_group']}" if entry["resource_group"] else ""

    if not entry["is_resource"]:
        return (
            f"Azure attributed this transfer to the resource group "
            f"{entry['name']} rather than to an individual resource, so the "
            "charge is shared by everything in it. The meters below show "
            "exactly what was billed."
        )

    if gb:
        return (
            f"{kind} '{entry['name']}'{where} moved {gb:,.2f} GB and was charged "
            f"{entry['cost']:,.2f}. The meters below break that down, each with "
            "its own billed quantity and rate."
        )
    return (
        f"{kind} '{entry['name']}'{where} was charged {entry['cost']:,.2f} for "
        "network meters billed by time or operation rather than by volume, so "
        "they carry no transfer size."
    )


def _method(level: str) -> str:
    if level == "resource":
        return (
            "Charges come from Cost Management grouped by resource id, so each "
            "row is an individual resource named by Azure. Quantity, unit and "
            "cost on every meter are billing facts; the unit rate is cost "
            "divided by billed quantity."
        )
    return (
        "Cost Management would not break these charges down past the resource "
        "group for this account, so each row is a group rather than a single "
        "resource. Every meter inside it is still shown exactly as billed."
    )


def flow_log_status(enabled: bool) -> Dict[str, Any]:
    """
    Whether per-flow detail (remote IPs, ports, protocols) can exist at all.

    This is the honest boundary of the report. Without NSG flow logs there is no
    record of who talked to whom — not hidden, not paywalled, simply never
    written. Saying so is more useful than an empty table.
    """
    if enabled:
        return {
            "available": True,
            "note": (
                "NSG flow logs are enabled, so per-connection detail — remote "
                "address, port and protocol — exists in the Log Analytics "
                "workspace and can be queried there."
            ),
        }
    return {
        "available": False,
        "note": (
            "Remote addresses and ports are not shown because they are not "
            "recorded unless NSG flow logs are enabled, and they cannot be "
            "recovered retrospectively. Everything above — the resource, the "
            "meter, the volume and the rate — comes from billing data and is "
            "unaffected."
        ),
        "how": (
            "Network Watcher -> NSG flow logs -> select the NSG -> enable, and "
            "send it to a Log Analytics workspace with Traffic Analytics on."
        ),
    }


# ---------------------------------------------------------------------------
# Day by day
# ---------------------------------------------------------------------------

def _day_key(rec: Dict[str, Any]) -> str:
    """
    Cost Management returns the day as an integer like 20260814, or as a date
    string, depending on granularity and API version. Both become YYYY-MM-DD so
    the series sorts and renders identically either way.
    """
    raw = rec.get("UsageDate") or rec.get("usageDate") or rec.get("Date") or ""
    text = str(raw).strip()
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return text[:10]


def build_daily_series(records: Iterable[Dict[str, Any]], unit_bytes) -> Dict[str, Any]:
    """
    One row per day for a single resource, with each day's meters kept apart.

    A monthly total cannot distinguish a steady trickle from one bad afternoon,
    and those have completely different causes and completely different fixes.
    The peak day is called out because it is usually the thing worth opening.
    """
    days: Dict[str, Dict[str, Any]] = {}

    for rec in records:
        day = _day_key(rec)
        if not day:
            continue

        quantity = _num(rec.get("UsageQuantity") or rec.get("usageQuantity"))
        cost = _num(rec.get("PreTaxCost") or rec.get("totalCost") or rec.get("Cost"))
        size = quantity * unit_bytes(rec)
        meter_name = _text(rec.get("Meter") or rec.get("MeterName")) or "Unknown meter"

        entry = days.setdefault(day, {"date": day, "bytes": 0.0, "cost": 0.0, "_meters": {}})
        entry["bytes"] += size
        entry["cost"] += cost

        meter = entry["_meters"].setdefault(meter_name, {
            "meter": meter_name,
            "unit": _text(rec.get("UnitOfMeasure") or rec.get("unitOfMeasure")),
            "quantity": 0.0,
            "bytes": 0.0,
            "cost": 0.0,
        })
        meter["quantity"] += quantity
        meter["bytes"] += size
        meter["cost"] += cost

    series = []
    for entry in sorted(days.values(), key=lambda d: d["date"]):
        meters = sorted(entry.pop("_meters").values(), key=lambda m: m["cost"], reverse=True)
        series.append({
            "date": entry["date"],
            "bytes": round(entry["bytes"]),
            "gb": round(entry["bytes"] / GB, 4) if entry["bytes"] else 0.0,
            "cost": round(entry["cost"], 4),
            "meters": [
                {
                    **m,
                    "quantity": round(m["quantity"], 4),
                    "bytes": round(m["bytes"]),
                    "gb": round(m["bytes"] / GB, 4) if m["bytes"] else 0.0,
                    "cost": round(m["cost"], 4),
                    "unit_rate": _rate(m["cost"], m["quantity"]),
                }
                for m in meters
            ],
        })

    total_cost = sum(d["cost"] for d in series)
    total_bytes = sum(d["bytes"] for d in series)
    charged = [d for d in series if d["cost"] > 0]
    peak = max(series, key=lambda d: d["cost"]) if series else None

    return {
        "days": series,
        "day_count": len(series),
        "charged_day_count": len(charged),
        "total_cost": round(total_cost, 2),
        "total_bytes": round(total_bytes),
        "total_gb": round(total_bytes / GB, 3) if total_bytes else 0.0,
        "average_cost": round(total_cost / len(charged), 4) if charged else 0.0,
        "peak": peak,
        "note": _daily_note(series, peak, total_cost),
    }


def _daily_note(series, peak, total_cost) -> str:
    """Say what the shape of the series means, since a chart alone does not."""
    if not series:
        return "Azure returned no daily rows for this resource in the selected period."
    if not peak or total_cost <= 0:
        return (
            "The daily rows exist but carry no cost, so this resource was not "
            "charged for data transfer on any day in the period."
        )

    share = peak["cost"] / total_cost if total_cost else 0
    if share >= 0.5:
        return (
            f"{peak['date']} alone accounts for {share:.0%} of this resource's "
            "transfer cost. That is a single event, not a steady pattern — look "
            "at what ran that day rather than at the workload as a whole."
        )
    if share >= 0.25:
        return (
            f"{peak['date']} is the heaviest day at {share:.0%} of the total — "
            "high enough to be worth explaining, but not a one-off spike."
        )
    return (
        "Cost is spread fairly evenly across the period, so this is ongoing "
        "traffic rather than a one-off event. Reducing it means changing the "
        "workload, not finding a bad day."
    )


# ---------------------------------------------------------------------------
# Where the data went — the queries that answer it
# ---------------------------------------------------------------------------

def _kql_str(value: Any) -> str:
    """
    Escape a value for use inside a double-quoted KQL literal.

    Resource names are not user input, but they do reach a query the user will
    run, and a name containing a quote or backslash would produce KQL that fails
    to parse for reasons nobody could see. Escaping is cheaper than explaining.
    """
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def kql_for(entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Ready-to-run KQL for tracing this resource's traffic to a destination.

    Billing data stops at "this resource sent 101 GB". Only flow logs say where
    it went, and those live in a Log Analytics workspace, not in any cost API —
    so the honest thing to hand over is the query, already scoped to this exact
    resource, that the user can paste into their own workspace.

    The IP addresses are embedded where known, because a generic query returns
    the whole estate and buries the resource being investigated. Both the
    current and the legacy Traffic Analytics schemas are offered: which one a
    workspace has depends on when flow logs were switched on, and that is not
    knowable from here.
    """
    name = entry.get("name") or ""
    group = entry.get("resource_group") or ""
    ips = [ip for ip in (entry.get("ip_list") or []) if ip]
    ip_filter = ", ".join(f'"{_kql_str(ip)}"' for ip in ips)

    where_src = (
        f"| where SrcIp in ({ip_filter})" if ip_filter
        else f'| where SrcVm has "{_kql_str(name)}" or DestVm has "{_kql_str(name)}"'
    )
    legacy_src = (
        f"| where SrcIP_s in ({ip_filter})" if ip_filter
        else f'| where VM_s has "{_kql_str(name)}"'
    )

    queries = [
        {
            "title": "Check flow logs recorded this resource",
            "table": "NTANetAnalytics",
            "purpose": (
                "Run this first. If it returns nothing, flow logs were not "
                "capturing this resource during the period and no query can "
                "recover it — the records were never written."
            ),
            "query": "\n".join([
                "NTANetAnalytics",
                '| where SubType == "FlowLog"',
                "| where TimeGenerated > ago(30d)",
                where_src,
                "| summarize Flows = count(), First = min(TimeGenerated), "
                "Last = max(TimeGenerated)",
            ]),
        },
        {
            "title": "Where the data went",
            "table": "NTANetAnalytics",
            "purpose": (
                "Top destinations by bytes sent. This is the query that turns a "
                "bandwidth charge into a list of who actually received the data."
            ),
            "query": "\n".join([
                "NTANetAnalytics",
                '| where SubType == "FlowLog"',
                "| where TimeGenerated > ago(30d)",
                where_src,
                '| where FlowDirection == "Outbound"',
                "| summarize GB = round(sum(BytesSrcToDest) / 1024.0 / 1024 / 1024, 2), "
                "Flows = count() by DestIp, DestPort, L7Protocol, DestRegion",
                "| sort by GB desc",
                "| take 50",
            ]),
        },
        {
            "title": "Egress by day",
            "table": "NTANetAnalytics",
            "purpose": (
                "Daily outbound volume, to line up against the daily cost above. "
                "If the two peaks fall on the same date, the billing spike and "
                "the traffic spike are the same event."
            ),
            "query": "\n".join([
                "NTANetAnalytics",
                '| where SubType == "FlowLog"',
                "| where TimeGenerated > ago(30d)",
                where_src,
                '| where FlowDirection == "Outbound"',
                "| summarize GB = round(sum(BytesSrcToDest) / 1024.0 / 1024 / 1024, 2) "
                "by bin(TimeGenerated, 1d)",
                "| sort by TimeGenerated asc",
            ]),
        },
        {
            "title": "Where the data went (legacy workspaces)",
            "table": "AzureNetworkAnalytics_CL",
            "purpose": (
                "The same answer for workspaces still on the older Traffic "
                "Analytics schema. Use this if the queries above report that "
                "the table does not exist."
            ),
            "query": "\n".join([
                "AzureNetworkAnalytics_CL",
                '| where SubType_s == "FlowLog"',
                "| where TimeGenerated > ago(30d)",
                legacy_src,
                '| where FlowDirection_s == "O"',
                "| summarize GB = round(sum(OutboundBytes_d) / 1024.0 / 1024 / 1024, 2), "
                "Flows = count() by DestIP_s, DestPort_d, L7Protocol_s",
                "| sort by GB desc",
                "| take 50",
            ]),
        },
    ]

    for query in queries:
        query["scope"] = f"{name}{f' in {group}' if group else ''}"
        query["matched_by"] = "public IP address" if ip_filter else "resource name"

    return queries
