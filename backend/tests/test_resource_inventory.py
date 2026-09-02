"""
Joining inventory to money.

Resource Graph and Cost Management disagree about the casing of a resource id,
and the size of a resource lives in a different field for every provider. Both
are easy to get subtly wrong and both show up as a table full of dashes, so
they are pinned down here.
"""
from datetime import date

from routers.services import _describe_sku
from services.analysis import latest_billing_month, resource_cost_index


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


# ── Which month a "monthly cost" is actually from ──────────────────────────
#
# The bug these pin down: a one-month Cost Management query means month-to-
# date, so on the 1st of a month it covers a single day, and Azure is a day or
# two behind on billing anyway. Every orphaned resource came back unpriced and
# the page read as though nothing was costing anything.

def _row(month, cost, resource_id="/x/vm1"):
    return {
        "ResourceId": resource_id,
        "BillingMonth": f"{month.replace('-', '')}01",
        "PreTaxCost": cost,
        "ServiceName": "Virtual Machines",
        "Meter": "Compute",
    }


def test_the_last_complete_month_is_preferred_over_the_one_in_progress():
    running = date.today().strftime("%Y-%m")
    month, partial = latest_billing_month([_row("2026-07", 100.0), _row(running, 3.0)])
    assert month == "2026-07"
    assert partial is False


def test_a_part_month_is_used_only_when_it_is_all_there_is_and_is_flagged():
    running = date.today().strftime("%Y-%m")
    month, partial = latest_billing_month([_row(running, 3.0)])
    assert month == running
    assert partial is True


def test_no_billed_records_name_no_month_at_all():
    # Distinct from "nothing was billed": the caller must be able to say which.
    assert latest_billing_month([]) == ("", False)
    assert latest_billing_month([_row("2026-07", 0.0)]) == ("", False)


def test_a_monthly_cost_is_one_month_not_the_sum_of_the_query():
    # Two months are fetched so the last complete one always exists. Summing
    # them would report a resource costing twice what it costs to run.
    rows = [_row("2026-07", 100.0), _row("2026-08", 120.0)]
    assert resource_cost_index(rows)["/x/vm1"]["cost"] == 220.0
    assert resource_cost_index(rows, month="2026-08")["/x/vm1"]["cost"] == 120.0


def test_meters_are_confined_to_the_chosen_month_too():
    rows = [
        _row("2026-07", 100.0),
        {**_row("2026-08", 120.0), "Meter": "Compute"},
        {**_row("2026-08", 15.0), "Meter": "Disk"},
    ]
    entry = resource_cost_index(rows, month="2026-08")["/x/vm1"]
    assert entry["cost"] == 135.0
    assert [m["cost"] for m in entry["meters"]] == [120.0, 15.0]


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
