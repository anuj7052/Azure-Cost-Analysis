"""
What is wrong with a network, read from its own configuration.

Two categories, kept apart on purpose, because they call for opposite reactions:

  * A **blocker** means traffic will not flow. Something is already broken, or
    will be the moment somebody depends on it. These are bugs.
  * A **exposure** means traffic *will* flow when it should not. Nothing is
    broken; that is exactly what makes it dangerous.

Mixing them into one "issues" list is the common mistake. It puts a peering
that has silently disconnected -- an outage waiting to be discovered -- next to
a management port open to the internet, and forces the reader to work out which
one is on fire.

Every finding is derived from configuration Azure returned. Nothing here probes,
sends a packet, or predicts. That boundary matters: this can prove a rule
*exists*, and it deliberately never claims a packet *would* be delivered,
because that depends on effective routes, service endpoints and peering transit
that only Azure can evaluate. Where that distinction bites, the finding says so.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

BLOCKER = "blocker"
EXPOSURE = "exposure"

CRITICAL = "critical"
HIGH = "high"
MEDIUM = "medium"
LOW = "low"

SEVERITY_ORDER = {CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3}

# The ports that turn "reachable from the internet" into "ownable from the
# internet". These are the remote-administration protocols; an open web port is
# usually the point of the service, an open RDP port almost never is.
ADMIN_PORTS = {
    22: "SSH",
    3389: "RDP",
    5985: "WinRM",
    5986: "WinRM over HTTPS",
    1433: "SQL Server",
    3306: "MySQL",
    5432: "PostgreSQL",
    6379: "Redis",
    27017: "MongoDB",
    9200: "Elasticsearch",
}

# Azure's own words for "anywhere on the internet". A rule using any of these as
# its source is open to the world, and they are not interchangeable strings a
# customer chose -- they are reserved service tags.
INTERNET_SOURCES = {"*", "0.0.0.0/0", "internet", "any", "::/0"}

# Subnets where the usual advice does not apply, and why. Telling somebody to
# put a restrictive NSG on GatewaySubnet is advice that breaks their VPN, so
# these are excluded rather than reported and then argued with.
RESERVED_SUBNETS = {
    "gatewaysubnet": (
        "Azure manages this subnet's traffic itself, and a restrictive network "
        "security group here breaks the gateway."
    ),
    "azurefirewallsubnet": (
        "Azure Firewall manages its own subnet, and does not support a network "
        "security group on it."
    ),
    "azurefirewallmanagementsubnet": (
        "Azure Firewall manages this subnet itself."
    ),
    "routeserversubnet": ("Azure Route Server manages this subnet itself."),
}


def _lower(value: Any) -> str:
    return str(value or "").strip().lower()


def _as_list(value: Any) -> List[str]:
    """Azure gives singular or plural for the same field depending on the API."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value if v is not None]
    return [str(value)]


def parse_ports(spec: Any) -> Optional[Set[int]]:
    """
    The concrete ports a rule covers.

    Returns `None` for "*", which means every port. That is deliberately not the
    same as the empty set: an empty set is a rule covering nothing, and treating
    "all ports" as "no ports" would make the single most dangerous rule shape
    invisible.

    Ranges are expanded only when small. A rule for 0-65535 is already known to
    be everything from its own shape, and materialising 65,536 integers to
    discover that would be slow for no gain.
    """
    ports: Set[int] = set()
    for item in _as_list(spec):
        token = item.strip()
        if not token:
            continue
        if token == "*":
            return None
        if "-" in token:
            low, _, high = token.partition("-")
            try:
                start, end = int(low), int(high)
            except ValueError:
                continue
            if start <= 0 and end >= 65535:
                return None
            if end - start > 4096:
                # Too wide to enumerate, but not literally everything. Recorded
                # by its endpoints so the caller can still reason about it.
                ports.update({start, end})
                continue
            ports.update(range(start, end + 1))
        else:
            try:
                ports.add(int(token))
            except ValueError:
                continue
    return ports


def rule_is_open_to_internet(rule: Dict[str, Any]) -> bool:
    """Whether an inbound Allow rule's source is the public internet."""
    props = rule.get("properties") or rule
    if _lower(props.get("direction")) != "inbound":
        return False
    if _lower(props.get("access")) != "allow":
        return False
    sources = {_lower(s) for s in (
        _as_list(props.get("sourceAddressPrefix"))
        + _as_list(props.get("sourceAddressPrefixes"))
    )}
    return bool(sources & INTERNET_SOURCES)


def exposed_admin_ports(rule: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """
    Which administration protocols an internet-facing rule exposes.

    Returns `(covers_everything, named_ports)`. The two are separate because
    they are different findings: a rule opening every port is worse than one
    opening SSH, and reporting the first as "exposes SSH, RDP, WinRM..." would
    understate it by making it look like a list somebody chose.
    """
    props = rule.get("properties") or rule
    ports = parse_ports(
        props.get("destinationPortRange") or props.get("destinationPortRanges")
    )
    if ports is None:
        return True, []
    named = [ADMIN_PORTS[p] for p in sorted(ports) if p in ADMIN_PORTS]
    return False, named


def _finding(
    category: str,
    kind: str,
    severity: str,
    title: str,
    detail: str,
    fix: str,
    resource_id: str = "",
    resource_name: str = "",
    evidence: Optional[Dict[str, Any]] = None,
    caveat: str = "",
) -> Dict[str, Any]:
    return {
        "category": category,
        "kind": kind,
        "severity": severity,
        "title": title,
        "detail": detail,
        "fix": fix,
        "resource_id": resource_id,
        "resource_name": resource_name,
        "evidence": evidence or {},
        # Every finding says how it could be wrong. A reviewer who has been
        # burned once by a false positive stops reading the whole list, so the
        # limits are stated up front rather than discovered.
        "caveat": caveat,
    }


def nsg_findings(nsg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Rules on one network security group that open it to the internet."""
    props = nsg.get("properties") or {}
    name = nsg.get("name") or ""
    nsg_id = nsg.get("id") or ""
    attached = [
        (s.get("id") or "") for s in (props.get("subnets") or [])
    ]
    out: List[Dict[str, Any]] = []

    for rule in props.get("securityRules") or []:
        if not rule_is_open_to_internet(rule):
            continue
        rule_props = rule.get("properties") or {}
        rule_name = rule.get("name") or ""
        everything, named = exposed_admin_ports(rule)
        evidence = {
            "rule": rule_name,
            "priority": rule_props.get("priority"),
            "protocol": rule_props.get("protocol") or "*",
            "source": rule_props.get("sourceAddressPrefix") or "",
            "ports": rule_props.get("destinationPortRange")
            or rule_props.get("destinationPortRanges") or "*",
            "attached_subnets": len(attached),
        }

        if everything:
            out.append(_finding(
                EXPOSURE, "nsg_all_ports_open", CRITICAL,
                f"{name} allows any port from the internet",
                f"Rule \"{rule_name}\" allows inbound traffic on every port from "
                "any address on the internet. Anything in the subnets this group "
                "protects is reachable from anywhere.",
                "Replace the source with the specific addresses that need to "
                "reach it, and the port range with the ports the service "
                "actually listens on.",
                nsg_id, name, evidence,
                caveat=(
                    "A higher-priority Deny rule above this one would override "
                    "it. Priorities are shown so you can check."
                ),
            ))
        elif named:
            out.append(_finding(
                EXPOSURE, "nsg_admin_port_open", HIGH,
                f"{name} exposes {', '.join(named)} to the internet",
                f"Rule \"{rule_name}\" allows {', '.join(named)} inbound from any "
                "address. These are remote-administration protocols: reaching "
                "them from the internet is how an estate gets taken over, and it "
                "is almost never the intended design.",
                "Use Azure Bastion or a jump host inside the network instead, or "
                "restrict the source to your own address ranges.",
                nsg_id, name, evidence,
                caveat=(
                    "A higher-priority Deny rule above this one would override "
                    "it. Priorities are shown so you can check."
                ),
            ))

    return out


def subnet_findings(vnet: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Subnets in one VNet with nothing filtering their traffic."""
    out: List[Dict[str, Any]] = []
    for subnet in vnet.get("subnets") or []:
        name = subnet.get("name") or ""
        lowered = _lower(name)
        if lowered in RESERVED_SUBNETS:
            continue
        if subnet.get("nsg_id"):
            continue
        out.append(_finding(
            EXPOSURE, "subnet_no_nsg", MEDIUM,
            f"{name} has no network security group",
            f"Subnet {name} in {vnet.get('name')} has no security group "
            "attached, so nothing filters traffic entering it beyond Azure's "
            "defaults. Azure's defaults permit anything inside the virtual "
            "network to reach anything else in it.",
            "Attach a security group to the subnet, even a permissive one, so "
            "there is a place to tighten later and a record of what was intended.",
            subnet.get("id") or "", name,
            {"vnet": vnet.get("name"), "prefix": subnet.get("prefix") or ""},
            caveat=(
                "A network interface inside the subnet can carry its own "
                "security group. Those are not read here, so a subnet listed "
                "may still be protected one level down."
            ),
        ))
    return out


def peering_findings(vnet: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Peerings that will not carry traffic, and ones that carry more than expected."""
    out: List[Dict[str, Any]] = []
    for peer in vnet.get("peerings") or []:
        state = _lower(peer.get("state"))
        name = peer.get("name") or ""

        if state and state != "connected":
            out.append(_finding(
                BLOCKER, "peering_not_connected", HIGH,
                f"Peering {name} is {peer.get('state')}, not Connected",
                f"{vnet.get('name')} declares a peering that Azure reports as "
                f"{peer.get('state')}. No traffic crosses it. This usually means "
                "the other side was deleted or never created its half — a "
                "peering only works when both networks declare it.",
                "Recreate the peering from the other network, or remove this "
                "half so the diagram stops implying a link that does not carry "
                "anything.",
                vnet.get("id") or "", vnet.get("name") or "",
                {"peering": name, "state": peer.get("state") or ""},
                caveat=(
                    "A peering can read as Disconnected for a few minutes while "
                    "it is being established."
                ),
            ))

        if peer.get("allow_forwarded_traffic"):
            out.append(_finding(
                EXPOSURE, "peering_forwarded_traffic", LOW,
                f"Peering {name} accepts forwarded traffic",
                f"{vnet.get('name')} accepts traffic that did not originate in "
                "the peered network. That is required for hub-and-spoke to work, "
                "and is a way for two spokes to reach each other through the hub "
                "if that was not intended.",
                "Expected on a hub. On a spoke, check whether it should be "
                "reaching its siblings.",
                vnet.get("id") or "", vnet.get("name") or "",
                {"peering": name},
                caveat=(
                    "This is normal and necessary in most hub-and-spoke designs. "
                    "It is listed as something to confirm, not to fix."
                ),
            ))

    return out


def address_overlap_findings(vnets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Networks whose address ranges collide.

    Azure refuses to peer two networks with overlapping ranges, so an overlap is
    a blocker for something the team has not tried yet rather than for anything
    that is failing now. It is worth knowing early, because the fix -- renumber
    a network -- gets more expensive with every resource added to it.

    Only exact range matches are reported. Detecting partial overlap properly
    needs real CIDR arithmetic, and a half-correct implementation here would
    produce false alarms that teach people to ignore the list.
    """
    seen: Dict[str, List[str]] = {}
    for vnet in vnets:
        for space in vnet.get("address_spaces") or []:
            seen.setdefault(space.strip(), []).append(vnet.get("name") or "")

    out: List[Dict[str, Any]] = []
    for space, names in sorted(seen.items()):
        if len(names) < 2:
            continue
        out.append(_finding(
            BLOCKER, "address_overlap", MEDIUM,
            f"{len(names)} networks share the range {space}",
            f"{', '.join(sorted(names))} all use {space}. Azure will refuse to "
            "peer any two of them while that is true, and a VPN or ExpressRoute "
            "reaching more than one of them cannot route between them.",
            "Renumber one of them before they grow. The cost of this fix rises "
            "with every resource inside the network.",
            "", space, {"networks": sorted(names), "range": space},
            caveat=(
                "Only identical ranges are compared. Two networks that partially "
                "overlap -- 10.0.0.0/16 and 10.0.1.0/24 -- also cannot peer, and "
                "are not detected here."
            ),
        ))
    return out


def route_findings(route_table: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Routes that send everything somewhere surprising."""
    props = route_table.get("properties") or {}
    name = route_table.get("name") or ""
    out: List[Dict[str, Any]] = []

    for route in props.get("routes") or []:
        route_props = route.get("properties") or {}
        prefix = str(route_props.get("addressPrefix") or "")
        next_hop = _lower(route_props.get("nextHopType"))
        if prefix not in {"0.0.0.0/0", "::/0"}:
            continue
        if next_hop != "internet":
            continue
        out.append(_finding(
            EXPOSURE, "default_route_to_internet", HIGH,
            f"{name} sends all traffic straight to the internet",
            f"Route \"{route.get('name')}\" sends everything not matched by a "
            "more specific route directly to the internet. If this estate has a "
            "firewall, traffic in the subnets using this table bypasses it "
            "entirely and is neither filtered nor logged.",
            "Point the default route at the firewall's private address instead, "
            "using the Virtual Appliance next hop.",
            route_table.get("id") or "", name,
            {"route": route.get("name") or "", "next_hop": "Internet"},
            caveat=(
                "This is the correct configuration for a network that is "
                "deliberately internet-facing and has no firewall."
            ),
        ))
    return out


def sort_findings(findings: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Blockers first, then by severity.

    Something already broken outranks something merely dangerous, because the
    broken thing has a person waiting on it.
    """
    return sorted(
        findings,
        key=lambda f: (
            0 if f["category"] == BLOCKER else 1,
            SEVERITY_ORDER.get(f["severity"], 9),
            f.get("resource_name", ""),
            f.get("title", ""),
        ),
    )


def summarise_findings(findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Counts by category and severity, for the header strip."""
    by_severity: Dict[str, int] = {}
    by_category: Dict[str, int] = {}
    for finding in findings:
        by_severity[finding["severity"]] = by_severity.get(finding["severity"], 0) + 1
        by_category[finding["category"]] = by_category.get(finding["category"], 0) + 1
    return {
        "total": len(findings),
        "blockers": by_category.get(BLOCKER, 0),
        "exposures": by_category.get(EXPOSURE, 0),
        "critical": by_severity.get(CRITICAL, 0),
        "high": by_severity.get(HIGH, 0),
        "medium": by_severity.get(MEDIUM, 0),
        "low": by_severity.get(LOW, 0),
        "by_severity": by_severity,
    }


def findings_note(findings: List[Dict[str, Any]], scanned: int) -> str:
    """
    One sentence about what this list is worth.

    A clean result is the dangerous case: it can mean a healthy network, or a
    token that could not read the rules. The wording never says "secure".
    """
    if not scanned:
        return (
            "No network resources were read, so nothing could be checked. This "
            "is not a clean result."
        )
    if not findings:
        return (
            "Nothing was found in the configuration that was read. That is not "
            "the same as secure: this checks security group rules, peering "
            "state, route tables and address ranges. It does not test whether "
            "any particular connection works."
        )
    blockers = sum(1 for f in findings if f["category"] == BLOCKER)
    if blockers:
        return (
            f"{blockers} of these will stop traffic flowing and are listed "
            "first. The rest allow traffic that may not be intended."
        )
    return (
        "Nothing here is broken. Everything listed allows traffic that is worth "
        "confirming was deliberate."
    )


def review_network(
    vnets: List[Dict[str, Any]],
    resources: List[Dict[str, Any]],
    raw_by_key: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Every finding across the topology that was read.

    `raw_by_key` carries the untouched Azure rows, because security rules and
    routes live in `properties` and are deliberately not copied onto the
    flattened diagram nodes -- the diagram does not need them, and carrying
    them would multiply the size of every response.
    """
    findings: List[Dict[str, Any]] = []

    for vnet in vnets:
        findings.extend(subnet_findings(vnet))
        findings.extend(peering_findings(vnet))

    findings.extend(address_overlap_findings(vnets))

    for resource in resources:
        raw = raw_by_key.get(resource["key"]) or {}
        if resource["kind"] == "nsg":
            findings.extend(nsg_findings(raw))
        elif resource["kind"] == "route_table":
            findings.extend(route_findings(raw))

    findings = sort_findings(findings)
    scanned = len(vnets) + len(resources)
    return {
        "findings": findings,
        "summary": summarise_findings(findings),
        "note": findings_note(findings, scanned),
    }
