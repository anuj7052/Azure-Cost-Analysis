"""
Network topology, read from Azure and assembled into a graph.

Every node and every edge here comes from a resource Azure returned. Nothing is
inferred from naming conventions, and nothing is drawn because it is usually
there -- a diagram that invents a peering, or omits one, is worse than no
diagram, because it will be trusted during an incident.

Where a relationship cannot be established the resource is still shown, sitting
unconnected, rather than being dropped. An orphaned subnet is a real thing to
see; a subnet silently missing from the picture looks like it does not exist.

The layout is deterministic -- the same estate produces the same picture every
time. A force-directed layout looks better and re-arranges itself on every load,
which makes two screenshots of the same network impossible to compare.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import httpx

from services import network_insights

MGMT_BASE = "https://management.azure.com"
GRAPH_API = "2022-10-01"
SOURCE = "network-topology"

# Resource Graph returns at most 1000 rows a page. Estates larger than this are
# paged through, but a ceiling is kept: past a few thousand network resources a
# single diagram stops being readable, and pretending otherwise just produces a
# slow page nobody can use.
PAGE_SIZE = 1000
MAX_NODES = 1500

# The network resource types this understands. Anything outside this list is not
# fetched at all, which keeps the query small and the response honest about what
# it covers.
NETWORK_TYPES = (
    "microsoft.network/virtualnetworks",
    "microsoft.network/virtualnetworkgateways",
    "microsoft.network/azurefirewalls",
    "microsoft.network/bastionhosts",
    "microsoft.network/natgateways",
    "microsoft.network/networksecuritygroups",
    "microsoft.network/routetables",
    "microsoft.network/publicipaddresses",
    "microsoft.network/loadbalancers",
    "microsoft.network/applicationgateways",
    "microsoft.network/privateendpoints",
    "microsoft.network/connections",
    "microsoft.network/virtualhubs",
    "microsoft.network/virtualwans",
)

# The vocabulary used in the legend. Kept in one place so the picture and the
# key beside it cannot drift apart.
EDGE_KINDS = {
    "peering": "Peering",
    "vwan": "VWAN Connection",
    "gateway": "Gateway / Public IP",
    "nsg": "Network Security Groups",
    "route_table": "Route Tables",
    "vpn": "VPN Connections",
    "bastion": "Azure Bastion",
    "nat": "NAT Gateway",
    "child": "Child Resource",
}

NODE_KIND = {
    "microsoft.network/virtualnetworks": "vnet",
    "microsoft.network/virtualnetworkgateways": "gateway",
    "microsoft.network/azurefirewalls": "firewall",
    "microsoft.network/bastionhosts": "bastion",
    "microsoft.network/natgateways": "nat",
    "microsoft.network/networksecuritygroups": "nsg",
    "microsoft.network/routetables": "route_table",
    "microsoft.network/publicipaddresses": "public_ip",
    "microsoft.network/loadbalancers": "load_balancer",
    "microsoft.network/applicationgateways": "app_gateway",
    "microsoft.network/privateendpoints": "private_endpoint",
    "microsoft.network/connections": "connection",
    "microsoft.network/virtualhubs": "virtual_hub",
    "microsoft.network/virtualwans": "virtual_wan",
}

# Subnets Azure reserves by name. Their presence is what makes a VNet a hub, and
# it is a fact about the platform rather than a guess about the customer's
# naming: only a gateway can live in GatewaySubnet, and Azure enforces that.
HUB_SUBNETS = {"gatewaysubnet", "azurefirewallsubnet", "azurebastionsubnet"}


def _lower(value: Any) -> str:
    return str(value or "").strip().lower()


def resource_key(resource_id: Any) -> str:
    """
    A comparable form of an Azure resource id.

    Azure is inconsistent about the case of resource ids -- the same VNet comes
    back as `.../virtualNetworks/vnet-a` from one API and
    `.../virtualnetworks/vnet-a` from another. Comparing them raw silently
    produces two nodes for one network and no peering between them.
    """
    return _lower(resource_id)


def _short_name(resource_id: Any) -> str:
    text = str(resource_id or "")
    return text.rsplit("/", 1)[-1] if "/" in text else text


def build_query(types: Iterable[str] = NETWORK_TYPES) -> str:
    """
    The Resource Graph query behind the whole picture.

    `properties` is projected in full because the relationships live inside it:
    peerings, subnet lists, address spaces, and the NSG and route table attached
    to each subnet are all nested there and are not available any other way.
    """
    quoted = ", ".join(f"'{t}'" for t in types)
    return (
        "Resources "
        f"| where type in ({quoted}) "
        "| project id, name, type, resourceGroup, subscriptionId, location, "
        "          tags, sku, properties "
        "| order by type asc, name asc"
    )


async def fetch_network_resources(
    token: str,
    subscription_ids: List[str],
    timeout: float = 60.0,
) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Every network resource in the selected subscriptions.

    Returns `(rows, truncated)`. Truncation is returned rather than logged
    because the page has to say so: a diagram that quietly stops at a limit
    looks like an estate that is smaller than it is.
    """
    if not subscription_ids:
        return [], False

    url = f"{MGMT_BASE}/providers/Microsoft.ResourceGraph/resources?api-version={GRAPH_API}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body: Dict[str, Any] = {
        "subscriptions": subscription_ids,
        "query": build_query(),
        "options": {"$top": PAGE_SIZE},
    }

    rows: List[Dict[str, Any]] = []
    skip_token: Optional[str] = None
    async with httpx.AsyncClient(timeout=timeout) as client:
        while True:
            if skip_token:
                body["options"]["$skipToken"] = skip_token
            response = await client.post(url, headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
            rows.extend(payload.get("data", []))
            skip_token = payload.get("$skipToken")
            if not skip_token or len(rows) >= MAX_NODES:
                break

    truncated = len(rows) > MAX_NODES or bool(skip_token)
    return rows[:MAX_NODES], truncated


def subnets_of(vnet: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    The subnets of one VNet, with whatever is attached to each.

    The NSG and route table are read per subnet rather than per VNet because
    that is where Azure applies them. Rolling them up to the VNet would suggest
    a protection that some subnets do not have.
    """
    props = vnet.get("properties") or {}
    out: List[Dict[str, Any]] = []
    for raw in props.get("subnets") or []:
        sub_props = raw.get("properties") or {}
        out.append({
            "id": raw.get("id") or "",
            "name": raw.get("name") or _short_name(raw.get("id")),
            "prefix": sub_props.get("addressPrefix") or "",
            "prefixes": list(sub_props.get("addressPrefixes") or []),
            "nsg_id": ((sub_props.get("networkSecurityGroup") or {}).get("id") or ""),
            "route_table_id": ((sub_props.get("routeTable") or {}).get("id") or ""),
            "nat_gateway_id": ((sub_props.get("natGateway") or {}).get("id") or ""),
        })
    return out


def peerings_of(vnet: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    The peerings declared on one VNet.

    A peering is declared on both sides, so walking every VNet produces each
    link twice. That is deliberate: the two halves can disagree -- one side
    Connected, the other Disconnected -- and that disagreement is a real fault
    worth surfacing rather than collapsing away.
    """
    props = vnet.get("properties") or {}
    out: List[Dict[str, Any]] = []
    for raw in props.get("virtualNetworkPeerings") or []:
        peer_props = raw.get("properties") or {}
        remote = (peer_props.get("remoteVirtualNetwork") or {}).get("id") or ""
        out.append({
            "name": raw.get("name") or _short_name(raw.get("id")),
            "remote_id": remote,
            "state": peer_props.get("peeringState") or "",
            "allow_forwarded_traffic": bool(peer_props.get("allowForwardedTraffic")),
            "allow_gateway_transit": bool(peer_props.get("allowGatewayTransit")),
            "use_remote_gateways": bool(peer_props.get("useRemoteGateways")),
        })
    return out


def address_spaces(vnet: Dict[str, Any]) -> List[str]:
    props = vnet.get("properties") or {}
    space = props.get("addressSpace") or {}
    return [str(p) for p in (space.get("addressPrefixes") or [])]


def dns_servers(vnet: Dict[str, Any]) -> List[str]:
    props = vnet.get("properties") or {}
    dhcp = props.get("dhcpOptions") or {}
    return [str(s) for s in (dhcp.get("dnsServers") or [])]


def normalise_vnet(row: Dict[str, Any]) -> Dict[str, Any]:
    """One VNet, flattened into what the diagram and the detail panel need."""
    subs = subnets_of(row)
    peers = peerings_of(row)
    spaces = address_spaces(row)
    servers = dns_servers(row)
    return {
        "id": row.get("id") or "",
        "key": resource_key(row.get("id")),
        "kind": "vnet",
        "name": row.get("name") or _short_name(row.get("id")),
        "type": "virtualNetworks",
        "resource_group": row.get("resourceGroup") or "",
        "subscription_id": row.get("subscriptionId") or "",
        "location": row.get("location") or "",
        "address_spaces": spaces,
        "subnet_count": len(subs),
        "peering_count": len(peers),
        # "Azure Provided" is what the portal says when the list is empty, and
        # it is the truth: an empty list means Azure's own resolver, not "no
        # DNS". Reporting it as blank would read as a misconfiguration.
        "dns_servers": servers,
        "dns_label": ", ".join(servers) if servers else "Azure Provided",
        "subnets": subs,
        "peerings": peers,
    }


def normalise_resource(row: Dict[str, Any]) -> Dict[str, Any]:
    """Any non-VNet network resource, flattened for the diagram."""
    kind = NODE_KIND.get(_lower(row.get("type")), "other")
    return {
        "id": row.get("id") or "",
        "key": resource_key(row.get("id")),
        "kind": kind,
        "name": row.get("name") or _short_name(row.get("id")),
        "type": str(row.get("type") or "").rsplit("/", 1)[-1],
        "resource_group": row.get("resourceGroup") or "",
        "subscription_id": row.get("subscriptionId") or "",
        "location": row.get("location") or "",
    }


def is_hub(vnet: Dict[str, Any], max_peerings: int) -> bool:
    """
    Whether a VNet is acting as a hub.

    Two independent signals, either of which is sufficient. A reserved subnet is
    the stronger one -- Azure only permits a gateway, firewall or Bastion in a
    subnet of that exact name, so its presence is a fact rather than a guess. The
    peering count is the weaker one and only counts when this VNet has strictly
    the most peerings in the estate; in a flat mesh with no clear centre, nothing
    is labelled a hub rather than picking one arbitrarily.
    """
    names = {_lower(s["name"]) for s in vnet.get("subnets") or []}
    if names & HUB_SUBNETS:
        return True
    return max_peerings > 1 and vnet.get("peering_count", 0) == max_peerings


def _edge(source: str, target: str, kind: str, **extra: Any) -> Dict[str, Any]:
    edge = {"source": source, "target": target, "kind": kind}
    edge.update(extra)
    return edge


def build_edges(
    vnets: List[Dict[str, Any]],
    resources: Dict[str, Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Every relationship that can be established from what was read.

    Returns `(edges, external_ids)`. An `external_id` is something a resource
    points at that was not in the scan -- a VNet peered from a subscription the
    reader did not select, most often. Those are returned separately so the page
    can say "this connects to something outside your selection" instead of
    drawing a line to nowhere or, worse, not drawing it at all.
    """
    known = set(resources)
    edges: List[Dict[str, Any]] = []
    external: Set[str] = set()
    seen_peers: Set[Tuple[str, str]] = set()

    for vnet in vnets:
        source = vnet["key"]

        for peer in vnet["peerings"]:
            remote = resource_key(peer["remote_id"])
            if not remote:
                continue
            if remote not in known:
                external.add(peer["remote_id"])
                continue
            # Both halves of a peering describe the same line. Drawing it once
            # keeps the picture readable; the pair is ordered so that the two
            # directions collapse to the same key.
            pair = tuple(sorted((source, remote)))
            if pair in seen_peers:
                continue
            seen_peers.add(pair)
            edges.append(_edge(
                source, remote, "peering",
                name=peer["name"],
                state=peer["state"],
                allow_forwarded_traffic=peer["allow_forwarded_traffic"],
                allow_gateway_transit=peer["allow_gateway_transit"],
                use_remote_gateways=peer["use_remote_gateways"],
            ))

        for subnet in vnet["subnets"]:
            for field, kind in (
                ("nsg_id", "nsg"),
                ("route_table_id", "route_table"),
                ("nat_gateway_id", "nat"),
            ):
                target = resource_key(subnet.get(field))
                if not target:
                    continue
                if target not in known:
                    external.add(subnet[field])
                    continue
                edges.append(_edge(source, target, kind, subnet=subnet["name"]))

    # Anything that sits in a subnet is attached to the VNet that owns it. The
    # subnet id carries the VNet id as its own prefix, which is how Azure models
    # containment and is more reliable than matching on names.
    for resource in resources.values():
        if resource["kind"] == "vnet":
            continue
        parent = _vnet_of_subnet(resource.get("subnet_id") or "")
        if parent and parent in known:
            edges.append(_edge(parent, resource["key"], _attach_kind(resource["kind"])))

    return edges, sorted(external)


def _attach_kind(node_kind: str) -> str:
    """Which legend entry an attached resource's line belongs to."""
    return {
        "gateway": "gateway",
        "bastion": "bastion",
        "nat": "nat",
        "connection": "vpn",
        "firewall": "gateway",
    }.get(node_kind, "child")


def _vnet_of_subnet(subnet_id: str) -> str:
    """The VNet a subnet id belongs to, or "" if it is not a subnet id."""
    key = resource_key(subnet_id)
    marker = "/subnets/"
    index = key.find(marker)
    return key[:index] if index > 0 else ""


def summarise(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Counts for the legend, taken from what was actually drawn."""
    by_kind: Dict[str, int] = {}
    for node in nodes:
        by_kind[node["kind"]] = by_kind.get(node["kind"], 0) + 1
    by_edge: Dict[str, int] = {}
    for edge in edges:
        by_edge[edge["kind"]] = by_edge.get(edge["kind"], 0) + 1
    return {
        "node_count": len(nodes),
        "edge_count": len(edges),
        "by_kind": by_kind,
        "by_edge_kind": by_edge,
    }


def topology_note(
    nodes: List[Dict[str, Any]],
    external: List[str],
    truncated: bool,
) -> str:
    """
    One sentence describing what this picture is and is not.

    Three distinct cases, because they call for three different responses: an
    empty result is a permission or selection problem, a truncated one needs a
    narrower selection, and a picture with external links needs more
    subscriptions selected before it can be read as complete.
    """
    if not nodes:
        return (
            "No network resources were returned for the selected subscriptions. "
            "That is either an estate with no virtual networks, or a token "
            "without Reader on the networking resources."
        )
    if truncated:
        return (
            "This estate has more network resources than one diagram can show. "
            "Only part of it is drawn -- select fewer subscriptions to see a "
            "complete picture of a smaller area."
        )
    if external:
        return (
            f"{len(external)} connection"
            f"{'' if len(external) == 1 else 's'} lead to networks outside the "
            "subscriptions you selected. They are listed but not drawn, because "
            "nothing is known about what is at the other end."
        )
    return (
        "Every connection shown was read from Azure. Peerings, security groups "
        "and route tables come from each network's own configuration, not from "
        "naming conventions."
    )


async def fetch_topology(
    token: str,
    subscription_ids: List[str],
) -> Dict[str, Any]:
    """
    The whole picture, assembled.

    A failure here returns an empty topology with an explanatory note rather
    than raising, matching the rest of the security pages: the surrounding page
    has filters and controls that should stay usable while one panel is broken.
    """
    try:
        rows, truncated = await fetch_network_resources(token, subscription_ids)
    except httpx.HTTPStatusError as exc:
        return _empty(
            f"Azure refused the network query (HTTP {exc.response.status_code}). "
            "Reading topology needs Reader on the networking resources."
        )
    except httpx.HTTPError as exc:
        return _empty(f"Azure could not be reached ({exc.__class__.__name__}).")

    vnets = [
        normalise_vnet(row) for row in rows
        if _lower(row.get("type")) == "microsoft.network/virtualnetworks"
    ]
    others = [
        normalise_resource(row) for row in rows
        if _lower(row.get("type")) != "microsoft.network/virtualnetworks"
    ]

    # Attached resources carry the subnet they sit in, which is what connects
    # them to a VNet. It is read here rather than in `normalise_resource` so
    # that function stays a pure reshaping of one row.
    by_id = {resource_key(r.get("id")): r for r in rows}
    for resource in others:
        resource["subnet_id"] = _subnet_id_of(by_id.get(resource["key"], {}))

    index: Dict[str, Dict[str, Any]] = {v["key"]: v for v in vnets}
    index.update({r["key"]: r for r in others})

    max_peerings = max((v["peering_count"] for v in vnets), default=0)
    for vnet in vnets:
        vnet["is_hub"] = is_hub(vnet, max_peerings)

    edges, external = build_edges(vnets, index)
    nodes = vnets + others

    review = network_insights.review_network(vnets, others, by_id)

    return {
        "nodes": nodes,
        "edges": edges,
        "external": external,
        "truncated": truncated,
        "summary": summarise(nodes, edges),
        "note": topology_note(nodes, external, truncated),
        "legend": EDGE_KINDS,
        "findings": review["findings"],
        "findings_summary": review["summary"],
        "findings_note": review["note"],
        "errors": [],
    }


def _subnet_id_of(row: Dict[str, Any]) -> str:
    """
    The subnet a network resource sits in.

    Every provider nests this somewhere different, so each known shape is tried
    in turn. An unknown shape yields "" and the resource is drawn unattached,
    which is honest -- better than attaching it to a VNet on a guess.
    """
    props = row.get("properties") or {}

    for config_field in ("ipConfigurations", "frontendIPConfigurations"):
        for config in props.get(config_field) or []:
            subnet = ((config.get("properties") or {}).get("subnet") or {}).get("id")
            if subnet:
                return subnet

    for direct in ("subnet", "gatewayIPConfiguration"):
        subnet = (props.get(direct) or {}).get("id")
        if subnet:
            return subnet

    # Azure Firewall states its subnet through its own IP configuration list,
    # under a different key again.
    for config in props.get("ipConfigurations") or []:
        subnet = ((config or {}).get("subnet") or {}).get("id")
        if subnet:
            return subnet

    return ""


def _empty(note: str) -> Dict[str, Any]:
    return {
        "nodes": [],
        "edges": [],
        "external": [],
        "truncated": False,
        "summary": summarise([], []),
        "note": note,
        "legend": EDGE_KINDS,
        "findings": [],
        "findings_summary": network_insights.summarise_findings([]),
        # Never "nothing found" on a failure. An empty list from a query that
        # did not run reads as a clean bill of health, which is the most
        # dangerous thing this page could say.
        "findings_note": network_insights.findings_note([], scanned=0),
        "errors": [note],
    }
