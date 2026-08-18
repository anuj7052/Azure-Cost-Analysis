"""
Joining inventory to money.

Resource Graph and Cost Management disagree about the casing of a resource id,
and the size of a resource lives in a different field for every provider. Both
are easy to get subtly wrong and both show up as a table full of dashes, so
they are pinned down here.
"""
from routers.services import _describe_sku
from services.analysis import resource_cost_index


def test_resource_ids_match_regardless_of_casing():
    index = resource_cost_index([
        {"ResourceId": "/SUBSCRIPTIONS/A/RESOURCEGROUPS/RG/PROVIDERS/X/vm1",
         "PreTaxCost": 10.0, "ServiceName": "Virtual Machines", "Meter": "D2s v3"},
    ])
    assert index["/subscriptions/a/resourcegroups/rg/providers/x/vm1"]["cost"] == 10.0


def test_costs_and_meters_accumulate_per_resource():
    index = resource_cost_index([
        {"ResourceId": "/x/vm1", "PreTaxCost": 10.0, "ServiceName": "Virtual Machines", "Meter": "Compute"},
        {"ResourceId": "/x/vm1", "PreTaxCost": 2.5, "ServiceName": "Virtual Machines", "Meter": "Disk"},
        {"ResourceId": "/x/vm1", "PreTaxCost": 40.0, "ServiceName": "Virtual Machines", "Meter": "Compute"},
    ])
    entry = index["/x/vm1"]
    assert entry["cost"] == 52.5
    assert entry["service"] == "Virtual Machines"
    # Priciest meter first, so the table can show the one that identifies it.
    assert [m["name"] for m in entry["meters"]] == ["Compute", "Disk"]
    assert entry["meters"][0]["cost"] == 50.0


def test_rows_without_a_resource_id_are_ignored():
    assert resource_cost_index([{"PreTaxCost": 5.0, "ServiceName": "Storage"}]) == {}


def test_vm_size_comes_from_properties():
    spec = _describe_sku({"vmSize": "Standard_D2s_v3"})
    assert spec["sku"] == "Standard_D2s_v3"


def test_disk_capacity_is_reported_as_a_size():
    spec = _describe_sku({"skuName": "Premium_LRS", "diskGb": "512", "diskTier": "P20"})
    assert spec == {"sku": "Premium_LRS", "size": "512 GB", "tier": "P20"}


def test_sku_object_is_used_when_present():
    spec = _describe_sku({"skuName": "Standard", "skuSize": "S1", "skuTier": "Standard"})
    assert spec == {"sku": "Standard", "size": "S1", "tier": "Standard"}


def test_a_resource_with_no_size_information_is_blank_not_wrong():
    assert _describe_sku({}) == {"sku": "", "size": "", "tier": ""}
