"""
Network topology assembly.

The risk this guards against is not a crash -- it is a diagram that looks right
and is wrong. A missed peering, a subnet attached to the wrong VNet, or a link
drawn to a network nobody can see are all silent failures that get trusted
during an incident, so most of what follows is about those.
"""
import pytest

from services import network_topology as nt


def vnet(name, sub="sub-1", rg="rg-net", location="eastus2", peerings=(), subnets=(),
         spaces=("10.0.0.0/16",), dns=()):
    return {
        "id": f"/subscriptions/{sub}/resourceGroups/{rg}"
               f"/providers/Microsoft.Network/virtualNetworks/{name}",
        "name": name,
        "type": "microsoft.network/virtualNetworks",
        "resourceGroup": rg,
        "subscriptionId": sub,
        "location": location,
        "properties": {
            "addressSpace": {"addressPrefixes": list(spaces)},
            "dhcpOptions": {"dnsServers": list(dns)},
            "subnets": list(subnets),
            "virtualNetworkPeerings": list(peerings),
        },
    }


def subnet(name, prefix="10.0.1.0/24", nsg="", route_table="", nat="",
           vnet_id="/subscriptions/sub-1/resourceGroups/rg-net"
                   "/providers/Microsoft.Network/virtualNetworks/vnet-a"):
    props = {"addressPrefix": prefix}
    if nsg:
        props["networkSecurityGroup"] = {"id": nsg}
    if route_table:
        props["routeTable"] = {"id": route_table}
    if nat:
        props["natGateway"] = {"id": nat}
    return {"id": f"{vnet_id}/subnets/{name}", "name": name, "properties": props}


def peering(remote_id, name="peer", state="Connected", **flags):
    return {
        "name": name,
        "properties": {
            "remoteVirtualNetwork": {"id": remote_id},
            "peeringState": state,
            **flags,
        },
    }


def nsg(name, sub="sub-1", rg="rg-net"):
    return {
        "id": f"/subscriptions/{sub}/resourceGroups/{rg}"
              f"/providers/Microsoft.Network/networkSecurityGroups/{name}",
        "name": name,
        "type": "microsoft.network/networkSecurityGroups",
        "resourceGroup": rg,
        "subscriptionId": sub,
        "location": "eastus2",
        "properties": {},
    }


VNET_A = ("/subscriptions/sub-1/resourceGroups/rg-net"
          "/providers/Microsoft.Network/virtualNetworks/vnet-a")
VNET_B = ("/subscriptions/sub-1/resourceGroups/rg-net"
          "/providers/Microsoft.Network/virtualNetworks/vnet-b")


class TestResourceKeys:
    def test_case_differences_do_not_create_two_nodes(self):
        # Azure returns the same id with different casing from different APIs.
        # Comparing them raw yields two nodes for one network and no peering
        # between them -- a picture that is wrong in a way nobody would notice.
        upper = VNET_A.replace("virtualNetworks", "virtualNetworks")
        lower = VNET_A.replace("virtualNetworks", "virtualnetworks")
        assert nt.resource_key(upper) == nt.resource_key(lower)

    def test_blank_id_is_blank_not_an_error(self):
        assert nt.resource_key(None) == ""
        assert nt.resource_key("") == ""


class TestVnetShape:
    def test_reads_address_spaces_and_counts(self):
        row = vnet("vnet-a", spaces=("192.168.40.0/24",), subnets=[subnet("snet-a")])
        out = nt.normalise_vnet(row)
        assert out["address_spaces"] == ["192.168.40.0/24"]
        assert out["subnet_count"] == 1
        assert out["peering_count"] == 0

    def test_empty_dns_list_means_azure_provided_not_missing(self):
        # An empty list is Azure's own resolver, which is a configuration, not
        # an absence. Showing it blank would read as a fault.
        out = nt.normalise_vnet(vnet("vnet-a"))
        assert out["dns_servers"] == []
        assert out["dns_label"] == "Azure Provided"

    def test_custom_dns_is_listed(self):
        out = nt.normalise_vnet(vnet("vnet-a", dns=("10.0.0.4", "10.0.0.5")))
        assert out["dns_label"] == "10.0.0.4, 10.0.0.5"

    def test_subnet_carries_what_is_attached_to_it(self):
        row = vnet("vnet-a", subnets=[
            subnet("snet-a", nsg="/nsg/one", route_table="/rt/one"),
        ])
        got = nt.normalise_vnet(row)["subnets"][0]
        assert got["nsg_id"] == "/nsg/one"
        assert got["route_table_id"] == "/rt/one"

    def test_a_subnet_without_an_nsg_reports_nothing_rather_than_inheriting(self):
        # Rolling the VNet's protections down onto every subnet would claim a
        # protection some subnets do not have.
        row = vnet("vnet-a", subnets=[subnet("bare")])
        assert nt.normalise_vnet(row)["subnets"][0]["nsg_id"] == ""

    def test_a_vnet_with_no_subnets_is_still_a_vnet(self):
        out = nt.normalise_vnet(vnet("vnet-empty"))
        assert out["subnet_count"] == 0
        assert out["subnets"] == []


class TestPeerings:
    def test_reads_state_and_transit_flags(self):
        row = vnet("vnet-a", peerings=[peering(
            VNET_B, state="Connected",
            allowForwardedTraffic=True, allowGatewayTransit=True,
        )])
        got = nt.normalise_vnet(row)["peerings"][0]
        assert got["state"] == "Connected"
        assert got["allow_forwarded_traffic"] is True
        assert got["allow_gateway_transit"] is True
        assert got["use_remote_gateways"] is False

    def test_a_peering_is_drawn_once_not_twice(self):
        # Both sides declare it. Drawing both makes a duplicate line.
        a = nt.normalise_vnet(vnet("vnet-a", peerings=[peering(VNET_B)]))
        b = nt.normalise_vnet(vnet("vnet-b", peerings=[peering(VNET_A)]))
        index = {a["key"]: a, b["key"]: b}
        edges, external = nt.build_edges([a, b], index)
        peers = [e for e in edges if e["kind"] == "peering"]
        assert len(peers) == 1
        assert external == []

    def test_peering_to_an_unselected_subscription_is_reported_not_drawn(self):
        # Drawing a line to a network nobody can see invents a relationship;
        # dropping it silently hides one. It is listed instead.
        remote = ("/subscriptions/other/resourceGroups/rg"
                  "/providers/Microsoft.Network/virtualNetworks/vnet-far")
        a = nt.normalise_vnet(vnet("vnet-a", peerings=[peering(remote)]))
        edges, external = nt.build_edges([a], {a["key"]: a})
        assert [e for e in edges if e["kind"] == "peering"] == []
        assert external == [remote]

    def test_a_peering_with_no_remote_id_is_skipped_quietly(self):
        a = nt.normalise_vnet(vnet("vnet-a", peerings=[peering("")]))
        edges, external = nt.build_edges([a], {a["key"]: a})
        assert edges == []
        assert external == []


class TestAttachments:
    def test_subnet_nsg_becomes_an_edge(self):
        nsg_row = nsg("nsg-a")
        a = nt.normalise_vnet(vnet("vnet-a", subnets=[
            subnet("snet-a", nsg=nsg_row["id"]),
        ]))
        n = nt.normalise_resource(nsg_row)
        edges, _ = nt.build_edges([a], {a["key"]: a, n["key"]: n})
        found = [e for e in edges if e["kind"] == "nsg"]
        assert len(found) == 1
        assert found[0]["subnet"] == "snet-a"

    def test_a_resource_is_attached_to_the_vnet_that_owns_its_subnet(self):
        a = nt.normalise_vnet(vnet("vnet-a"))
        gateway = {
            "id": "/subscriptions/sub-1/resourceGroups/rg-net"
                  "/providers/Microsoft.Network/virtualNetworkGateways/gw-a",
            "name": "gw-a",
            "type": "microsoft.network/virtualNetworkGateways",
            "resourceGroup": "rg-net", "subscriptionId": "sub-1",
            "location": "eastus2", "properties": {},
        }
        g = nt.normalise_resource(gateway)
        g["subnet_id"] = f"{VNET_A}/subnets/GatewaySubnet"
        edges, _ = nt.build_edges([a], {a["key"]: a, g["key"]: g})
        assert any(e["target"] == g["key"] and e["kind"] == "gateway" for e in edges)

    def test_a_resource_with_no_subnet_is_left_unattached_not_guessed(self):
        a = nt.normalise_vnet(vnet("vnet-a"))
        n = nt.normalise_resource(nsg("nsg-loose"))
        n["subnet_id"] = ""
        edges, _ = nt.build_edges([a], {a["key"]: a, n["key"]: n})
        assert edges == []


class TestSubnetIdExtraction:
    def test_reads_an_ip_configuration(self):
        row = {"properties": {"ipConfigurations": [
            {"properties": {"subnet": {"id": f"{VNET_A}/subnets/snet-a"}}},
        ]}}
        assert nt._subnet_id_of(row) == f"{VNET_A}/subnets/snet-a"

    def test_reads_a_frontend_configuration(self):
        row = {"properties": {"frontendIPConfigurations": [
            {"properties": {"subnet": {"id": f"{VNET_A}/subnets/snet-lb"}}},
        ]}}
        assert nt._subnet_id_of(row) == f"{VNET_A}/subnets/snet-lb"

    def test_reads_a_direct_subnet(self):
        row = {"properties": {"subnet": {"id": f"{VNET_A}/subnets/snet-pe"}}}
        assert nt._subnet_id_of(row) == f"{VNET_A}/subnets/snet-pe"

    def test_an_unknown_shape_yields_nothing_rather_than_a_guess(self):
        assert nt._subnet_id_of({"properties": {"somethingElse": True}}) == ""
        assert nt._subnet_id_of({}) == ""


class TestHubDetection:
    def test_a_gateway_subnet_makes_it_a_hub(self):
        # Azure only permits a gateway in a subnet of this exact name, so this
        # is a platform fact rather than a naming-convention guess.
        v = nt.normalise_vnet(vnet("vnet-hub", subnets=[subnet("GatewaySubnet")]))
        assert nt.is_hub(v, max_peerings=0) is True

    @pytest.mark.parametrize("name", ["AzureFirewallSubnet", "AzureBastionSubnet"])
    def test_other_reserved_subnets_also_mark_a_hub(self, name):
        v = nt.normalise_vnet(vnet("vnet-hub", subnets=[subnet(name)]))
        assert nt.is_hub(v, max_peerings=0) is True

    def test_reserved_subnet_match_ignores_case(self):
        v = nt.normalise_vnet(vnet("vnet-hub", subnets=[subnet("gatewaysubnet")]))
        assert nt.is_hub(v, max_peerings=0) is True

    def test_the_most_peered_network_is_a_hub(self):
        v = nt.normalise_vnet(vnet("vnet-hub", peerings=[
            peering(VNET_B, name="p1"), peering(VNET_A, name="p2"),
        ]))
        assert nt.is_hub(v, max_peerings=2) is True

    def test_a_flat_mesh_has_no_hub_rather_than_an_arbitrary_one(self):
        # Every network peered to one other. Naming one of them the hub would
        # be a coin toss presented as an architecture.
        v = nt.normalise_vnet(vnet("vnet-a", peerings=[peering(VNET_B)]))
        assert nt.is_hub(v, max_peerings=1) is False

    def test_an_isolated_network_is_not_a_hub(self):
        v = nt.normalise_vnet(vnet("vnet-alone"))
        assert nt.is_hub(v, max_peerings=0) is False


class TestNotes:
    def test_empty_result_points_at_permissions(self):
        note = nt.topology_note([], [], truncated=False)
        assert "Reader" in note

    def test_truncated_result_asks_for_a_narrower_selection(self):
        note = nt.topology_note([{"kind": "vnet"}], [], truncated=True)
        assert "fewer subscriptions" in note

    def test_external_links_are_named_and_counted(self):
        note = nt.topology_note([{"kind": "vnet"}], ["/one"], truncated=False)
        assert "1 connection" in note

    def test_external_plural_reads_correctly(self):
        note = nt.topology_note([{"kind": "vnet"}], ["/one", "/two"], truncated=False)
        assert "2 connections" in note

    def test_a_clean_result_says_where_the_lines_came_from(self):
        note = nt.topology_note([{"kind": "vnet"}], [], truncated=False)
        assert "read from Azure" in note


class TestSummary:
    def test_counts_what_was_drawn(self):
        nodes = [{"kind": "vnet"}, {"kind": "vnet"}, {"kind": "nsg"}]
        edges = [{"kind": "peering"}, {"kind": "nsg"}, {"kind": "peering"}]
        got = nt.summarise(nodes, edges)
        assert got["node_count"] == 3
        assert got["by_kind"] == {"vnet": 2, "nsg": 1}
        assert got["by_edge_kind"] == {"peering": 2, "nsg": 1}

    def test_an_empty_estate_summarises_to_zero_not_to_an_error(self):
        assert nt.summarise([], []) == {
            "node_count": 0, "edge_count": 0, "by_kind": {}, "by_edge_kind": {},
        }


class TestQuery:
    def test_every_declared_type_is_asked_for(self):
        query = nt.build_query()
        for kind in nt.NETWORK_TYPES:
            assert f"'{kind}'" in query

    def test_properties_are_projected_because_the_links_live_there(self):
        # Peerings, subnets and address spaces are only available inside
        # `properties`. Without it the diagram would have nodes and no edges.
        assert "properties" in nt.build_query()


class TestLegend:
    def test_every_edge_kind_produced_has_a_legend_entry(self):
        # A line on the diagram with no key is a line nobody can read.
        produced = {nt._attach_kind(k) for k in nt.NODE_KIND.values()}
        produced |= {"peering", "nsg", "route_table", "nat"}
        assert produced <= set(nt.EDGE_KINDS)
