"""
Network findings.

The whole value of this list is that people trust it, so the tests below are
mostly about the two ways it could lose that: crying wolf (flagging a
configuration that is correct and required), and staying quiet about something
that matters. Both make the list worthless, and the first is the more likely.
"""
import pytest

from services import network_insights as ni


def rule(name="r", direction="Inbound", access="Allow", source="*",
         ports="*", protocol="Tcp", priority=100):
    return {
        "name": name,
        "properties": {
            "direction": direction,
            "access": access,
            "sourceAddressPrefix": source,
            "destinationPortRange": ports,
            "protocol": protocol,
            "priority": priority,
        },
    }


def nsg(name="nsg-a", rules=(), subnets=()):
    return {
        "id": f"/subscriptions/s1/providers/Microsoft.Network/networkSecurityGroups/{name}",
        "name": name,
        "type": "microsoft.network/networkSecurityGroups",
        "properties": {
            "securityRules": list(rules),
            "subnets": [{"id": s} for s in subnets],
        },
    }


def vnet(name="vnet-a", subnets=(), peerings=(), spaces=("10.0.0.0/16",)):
    return {
        "id": f"/subscriptions/s1/providers/Microsoft.Network/virtualNetworks/{name}",
        "name": name,
        "address_spaces": list(spaces),
        "subnets": list(subnets),
        "peerings": list(peerings),
    }


def subnet(name="snet-a", nsg_id="", prefix="10.0.1.0/24"):
    return {"id": f"/vnet/subnets/{name}", "name": name,
            "nsg_id": nsg_id, "prefix": prefix}


def peering(name="p", state="Connected", forwarded=False):
    return {"name": name, "state": state, "allow_forwarded_traffic": forwarded}


def route_table(name="rt-a", routes=()):
    return {
        "id": f"/subscriptions/s1/providers/Microsoft.Network/routeTables/{name}",
        "name": name,
        "properties": {"routes": list(routes)},
    }


def route(name="default", prefix="0.0.0.0/0", next_hop="Internet"):
    return {"name": name, "properties": {"addressPrefix": prefix,
                                         "nextHopType": next_hop}}


class TestPortParsing:
    def test_a_star_means_every_port_not_no_ports(self):
        # The distinction is the whole point. Treating "all ports" as an empty
        # set would make the single most dangerous rule shape invisible.
        assert ni.parse_ports("*") is None
        assert ni.parse_ports([]) == set()

    def test_reads_a_single_port(self):
        assert ni.parse_ports("22") == {22}

    def test_reads_a_list(self):
        assert ni.parse_ports(["22", "3389"]) == {22, 3389}

    def test_expands_a_small_range(self):
        assert ni.parse_ports("80-82") == {80, 81, 82}

    def test_a_full_range_is_recognised_as_everything(self):
        assert ni.parse_ports("0-65535") is None

    def test_a_wide_range_is_not_materialised(self):
        # 65k integers to learn something the endpoints already say.
        got = ni.parse_ports("1000-60000")
        assert got == {1000, 60000}

    def test_garbage_is_ignored_rather_than_raising(self):
        assert ni.parse_ports("not-a-port") == set()
        assert ni.parse_ports(None) == set()


class TestInternetExposure:
    @pytest.mark.parametrize("source", ["*", "0.0.0.0/0", "Internet", "any", "::/0"])
    def test_every_way_azure_spells_anywhere(self, source):
        assert ni.rule_is_open_to_internet(rule(source=source)) is True

    def test_a_specific_source_is_not_the_internet(self):
        assert ni.rule_is_open_to_internet(rule(source="10.0.0.0/8")) is False

    def test_outbound_rules_are_not_inbound_exposure(self):
        assert ni.rule_is_open_to_internet(rule(direction="Outbound")) is False

    def test_a_deny_rule_is_not_exposure(self):
        # Denying everything from the internet is the opposite of a finding.
        assert ni.rule_is_open_to_internet(rule(access="Deny")) is False

    def test_reads_the_plural_form_of_the_field(self):
        r = rule()
        r["properties"].pop("sourceAddressPrefix")
        r["properties"]["sourceAddressPrefixes"] = ["10.0.0.0/8", "*"]
        assert ni.rule_is_open_to_internet(r) is True


class TestAdminPorts:
    def test_ssh_is_named(self):
        everything, named = ni.exposed_admin_ports(rule(ports="22"))
        assert everything is False
        assert named == ["SSH"]

    def test_all_ports_is_reported_as_all_not_as_a_list(self):
        # "exposes SSH, RDP, WinRM..." would understate a rule that opens
        # everything by making it look like a list somebody chose.
        everything, named = ni.exposed_admin_ports(rule(ports="*"))
        assert everything is True
        assert named == []

    def test_a_web_port_is_not_an_admin_port(self):
        everything, named = ni.exposed_admin_ports(rule(ports="443"))
        assert everything is False
        assert named == []

    def test_databases_count_as_administrative(self):
        _, named = ni.exposed_admin_ports(rule(ports=["1433", "5432"]))
        assert named == ["SQL Server", "PostgreSQL"]


class TestNsgFindings:
    def test_open_admin_port_is_high(self):
        found = ni.nsg_findings(nsg(rules=[rule(name="allow-ssh", ports="22")]))
        assert len(found) == 1
        assert found[0]["severity"] == ni.HIGH
        assert found[0]["category"] == ni.EXPOSURE
        assert "SSH" in found[0]["title"]

    def test_open_everything_is_critical(self):
        found = ni.nsg_findings(nsg(rules=[rule(name="allow-all", ports="*")]))
        assert found[0]["severity"] == ni.CRITICAL

    def test_a_locked_down_group_produces_nothing(self):
        found = ni.nsg_findings(nsg(rules=[
            rule(source="10.0.0.0/8", ports="22"),
            rule(access="Deny", ports="*"),
        ]))
        assert found == []

    def test_evidence_carries_the_priority_so_the_caveat_is_checkable(self):
        # The finding admits a higher-priority Deny could override it. That
        # admission is useless without the number to check against.
        found = ni.nsg_findings(nsg(rules=[rule(ports="22", priority=310)]))
        assert found[0]["evidence"]["priority"] == 310
        assert "Deny" in found[0]["caveat"]

    def test_a_group_with_no_rules_is_quiet(self):
        assert ni.nsg_findings(nsg()) == []


class TestSubnetFindings:
    def test_a_subnet_with_no_security_group_is_flagged(self):
        found = ni.subnet_findings(vnet(subnets=[subnet("snet-app")]))
        assert len(found) == 1
        assert found[0]["kind"] == "subnet_no_nsg"

    def test_a_protected_subnet_is_not_flagged(self):
        found = ni.subnet_findings(vnet(subnets=[subnet("snet-app", nsg_id="/nsg/a")]))
        assert found == []

    @pytest.mark.parametrize("name", [
        "GatewaySubnet", "AzureFirewallSubnet", "RouteServerSubnet",
    ])
    def test_azure_managed_subnets_are_not_flagged(self, name):
        # Telling somebody to put a restrictive NSG on GatewaySubnet is advice
        # that breaks their VPN. Advice that breaks things gets the whole list
        # ignored.
        assert ni.subnet_findings(vnet(subnets=[subnet(name)])) == []

    def test_reserved_subnet_match_ignores_case(self):
        assert ni.subnet_findings(vnet(subnets=[subnet("gatewaysubnet")])) == []

    def test_the_finding_admits_nic_level_groups_are_not_read(self):
        found = ni.subnet_findings(vnet(subnets=[subnet("snet-app")]))
        assert "network interface" in found[0]["caveat"]


class TestPeeringFindings:
    def test_a_disconnected_peering_is_a_blocker(self):
        # Nothing is exposed; something is broken. Different category, because
        # it calls for a different reaction.
        found = ni.peering_findings(vnet(peerings=[peering(state="Disconnected")]))
        assert found[0]["category"] == ni.BLOCKER
        assert found[0]["severity"] == ni.HIGH

    def test_a_connected_peering_is_not_a_finding(self):
        assert ni.peering_findings(vnet(peerings=[peering()])) == []

    def test_forwarded_traffic_is_noted_gently(self):
        # Required for hub-and-spoke. Flagging it loudly would be crying wolf
        # at the most common correct design in Azure.
        found = ni.peering_findings(vnet(peerings=[peering(forwarded=True)]))
        assert found[0]["severity"] == ni.LOW
        assert "normal and necessary" in found[0]["caveat"]

    def test_a_peering_with_no_state_is_not_guessed_at(self):
        found = ni.peering_findings(vnet(peerings=[peering(state="")]))
        assert found == []


class TestAddressOverlap:
    def test_two_networks_on_the_same_range_cannot_peer(self):
        found = ni.address_overlap_findings([
            vnet("vnet-a", spaces=("10.0.0.0/16",)),
            vnet("vnet-b", spaces=("10.0.0.0/16",)),
        ])
        assert len(found) == 1
        assert found[0]["category"] == ni.BLOCKER
        assert sorted(found[0]["evidence"]["networks"]) == ["vnet-a", "vnet-b"]

    def test_distinct_ranges_are_fine(self):
        found = ni.address_overlap_findings([
            vnet("vnet-a", spaces=("10.0.0.0/16",)),
            vnet("vnet-b", spaces=("10.1.0.0/16",)),
        ])
        assert found == []

    def test_partial_overlap_is_admitted_as_undetected(self):
        # Half-correct CIDR arithmetic would produce false alarms, so it is not
        # attempted -- but the gap is stated rather than hidden.
        found = ni.address_overlap_findings([
            vnet("vnet-a", spaces=("10.0.0.0/16",)),
            vnet("vnet-b", spaces=("10.0.0.0/16",)),
        ])
        assert "partially" in found[0]["caveat"]

    def test_one_network_alone_is_not_an_overlap(self):
        assert ni.address_overlap_findings([vnet("vnet-a")]) == []


class TestRouteFindings:
    def test_a_default_route_to_the_internet_bypasses_the_firewall(self):
        found = ni.route_findings(route_table(routes=[route()]))
        assert len(found) == 1
        assert found[0]["severity"] == ni.HIGH

    def test_a_default_route_to_an_appliance_is_correct(self):
        found = ni.route_findings(route_table(routes=[
            route(next_hop="VirtualAppliance"),
        ]))
        assert found == []

    def test_a_specific_route_to_the_internet_is_not_a_default_route(self):
        found = ni.route_findings(route_table(routes=[
            route(prefix="20.1.2.0/24"),
        ]))
        assert found == []

    def test_it_admits_this_is_correct_for_some_designs(self):
        found = ni.route_findings(route_table(routes=[route()]))
        assert "no firewall" in found[0]["caveat"]


class TestOrdering:
    def test_blockers_come_before_exposures(self):
        # Something already broken has a person waiting on it. Something merely
        # dangerous does not.
        low_blocker = ni._finding(ni.BLOCKER, "k", ni.LOW, "t", "d", "f")
        critical_exposure = ni._finding(ni.EXPOSURE, "k", ni.CRITICAL, "t", "d", "f")
        out = ni.sort_findings([critical_exposure, low_blocker])
        assert out[0]["category"] == ni.BLOCKER

    def test_within_a_category_severity_decides(self):
        low = ni._finding(ni.EXPOSURE, "k", ni.LOW, "a", "d", "f")
        high = ni._finding(ni.EXPOSURE, "k", ni.CRITICAL, "b", "d", "f")
        out = ni.sort_findings([low, high])
        assert out[0]["severity"] == ni.CRITICAL

    def test_ordering_is_stable_for_identical_findings(self):
        items = [
            ni._finding(ni.EXPOSURE, "k", ni.HIGH, "t", "d", "f", resource_name="b"),
            ni._finding(ni.EXPOSURE, "k", ni.HIGH, "t", "d", "f", resource_name="a"),
        ]
        assert [f["resource_name"] for f in ni.sort_findings(items)] == ["a", "b"]


class TestNotes:
    def test_nothing_scanned_is_never_reported_as_clean(self):
        # An empty list from a query that did not run reads as a clean bill of
        # health. That is the most dangerous sentence this page could print.
        note = ni.findings_note([], scanned=0)
        assert "not a clean result" in note

    def test_a_clean_scan_refuses_to_say_secure(self):
        note = ni.findings_note([], scanned=12)
        assert "secure" in note
        assert "not the same as secure" in note

    def test_blockers_are_called_out_first(self):
        note = ni.findings_note(
            [ni._finding(ni.BLOCKER, "k", ni.HIGH, "t", "d", "f")], scanned=5,
        )
        assert "stop traffic flowing" in note

    def test_exposures_only_says_nothing_is_broken(self):
        note = ni.findings_note(
            [ni._finding(ni.EXPOSURE, "k", ni.HIGH, "t", "d", "f")], scanned=5,
        )
        assert "Nothing here is broken" in note


class TestSummary:
    def test_counts_both_axes(self):
        findings = [
            ni._finding(ni.BLOCKER, "k", ni.HIGH, "t", "d", "f"),
            ni._finding(ni.EXPOSURE, "k", ni.CRITICAL, "t", "d", "f"),
            ni._finding(ni.EXPOSURE, "k", ni.HIGH, "t", "d", "f"),
        ]
        got = ni.summarise_findings(findings)
        assert got["total"] == 3
        assert got["blockers"] == 1
        assert got["exposures"] == 2
        assert got["critical"] == 1
        assert got["high"] == 2

    def test_empty_summarises_to_zeroes(self):
        got = ni.summarise_findings([])
        assert got["total"] == 0 and got["blockers"] == 0


class TestEveryFindingIsActionable:
    def test_each_one_carries_a_fix_and_an_admission(self):
        # A finding with no fix is a complaint, and one with no caveat invites
        # the reader to trust it further than it deserves.
        found = (
            ni.nsg_findings(nsg(rules=[rule(ports="22")]))
            + ni.subnet_findings(vnet(subnets=[subnet("snet-a")]))
            + ni.peering_findings(vnet(peerings=[peering(state="Disconnected")]))
            + ni.route_findings(route_table(routes=[route()]))
            + ni.address_overlap_findings([vnet("a"), vnet("b")])
        )
        assert found
        for finding in found:
            assert finding["fix"], finding["kind"]
            assert finding["caveat"], finding["kind"]
            assert finding["detail"], finding["kind"]
            assert finding["category"] in {ni.BLOCKER, ni.EXPOSURE}
            assert finding["severity"] in ni.SEVERITY_ORDER
