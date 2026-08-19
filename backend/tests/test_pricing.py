"""
Reserved vs on-demand spend.

This feature exists to answer "how much are we still buying at list price", so
the damaging failure is overstating commitment — telling someone their spend is
covered when it is not. The unknown-model and empty-spend cases are pinned
because both are easy to round in the flattering direction.
"""
from services.pricing import summarise_pricing


def row(model, cost, service="Virtual Machines", month="20260701", currency="INR"):
    return {
        "PricingModel": model,
        "PreTaxCost": cost,
        "ServiceName": service,
        "UsageDate": month,
        "Currency": currency,
    }


def test_spend_is_split_by_azures_own_pricing_model():
    result = summarise_pricing([
        row("Reservation", 100.0),
        row("OnDemand", 40.0),
        row("Spot", 10.0),
    ])

    assert result["reserved"] == 100.0
    assert result["on_demand"] == 40.0
    assert result["spot"] == 10.0
    assert result["total"] == 150.0


def test_savings_plan_counts_as_committed_alongside_reservations():
    """Both are bought ahead of use and managed as one commitment."""
    result = summarise_pricing([
        row("Reservation", 60.0),
        row("SavingsPlan", 40.0),
        row("OnDemand", 100.0),
    ])

    assert result["committed"] == 100.0
    assert result["committed_pct"] == 50.0


def test_rows_without_a_pricing_model_are_not_counted_as_on_demand():
    """
    Azure omits the dimension on some rows.

    Folding those into on-demand would overstate uncommitted spend — the exact
    number this feature is consulted for — so they stay labelled Unknown.
    """
    result = summarise_pricing([
        row("Reservation", 50.0),
        {"PreTaxCost": 25.0, "ServiceName": "Storage", "UsageDate": "20260701"},
    ])

    assert result["on_demand"] == 0.0
    assert result["by_model"]["Unknown"] == 25.0


def test_zero_spend_is_not_reported_as_fully_covered():
    """An empty subscription must not score 100% commitment."""
    result = summarise_pricing([])

    assert result["total"] == 0.0
    assert result["committed_pct"] is None


def test_missing_pricing_dimension_is_flagged_rather_than_drawn_as_zero():
    """
    Some scopes never return PricingModel at all.

    Showing that as "everything is on-demand" would invent a finding, so the
    caller is told the data is absent instead.
    """
    absent = summarise_pricing([
        {"PreTaxCost": 10.0, "ServiceName": "Storage", "UsageDate": "20260701"},
    ])
    present = summarise_pricing([row("OnDemand", 10.0)])

    assert absent["has_pricing_data"] is False
    assert present["has_pricing_data"] is True


def test_services_lead_with_the_biggest_uncommitted_spend():
    """That is where buying a reservation would pay for itself."""
    result = summarise_pricing([
        row("OnDemand", 10.0, service="Storage"),
        row("OnDemand", 900.0, service="Virtual Machines"),
        row("Reservation", 500.0, service="SQL Database"),
    ])

    assert [s["service"] for s in result["services"]][0] == "Virtual Machines"


def test_a_service_keeps_both_halves_of_its_spend():
    """Partial coverage is the normal case and must stay visible."""
    result = summarise_pricing([
        row("Reservation", 300.0, service="Virtual Machines"),
        row("OnDemand", 200.0, service="Virtual Machines"),
    ])

    vms = next(s for s in result["services"] if s["service"] == "Virtual Machines")
    assert vms["reserved"] == 300.0
    assert vms["on_demand"] == 200.0
    assert vms["total"] == 500.0


def test_months_are_split_and_ordered():
    result = summarise_pricing([
        row("Reservation", 10.0, month="20260801"),
        row("OnDemand", 20.0, month="20260701"),
    ])

    assert [m["month"] for m in result["months"]] == ["2026-07", "2026-08"]
    assert result["months"][0]["on_demand"] == 20.0
    assert result["months"][1]["reserved"] == 10.0


def test_an_unrecognised_model_keeps_its_own_name():
    """A new Azure pricing model must surface as itself, not inflate a total."""
    result = summarise_pricing([row("FutureModel", 15.0)])

    assert result["by_model"]["FutureModel"] == 15.0
    assert result["on_demand"] == 0.0
    assert result["reserved"] == 0.0


def test_model_names_are_matched_regardless_of_casing():
    result = summarise_pricing([row("reservation", 10.0), row("ondemand", 5.0)])

    assert result["reserved"] == 10.0
    assert result["on_demand"] == 5.0


def test_currency_is_taken_from_the_billing_data():
    result = summarise_pricing([row("OnDemand", 10.0, currency="INR")])
    assert result["currency"] == "INR"


# ── Reserved resource detail ───────────────────────────────────────────────

from services.pricing import parse_resource_id, reserved_detail

VM_ID = ("/subscriptions/sub-1/resourceGroups/rg-prod/providers/"
         "Microsoft.Compute/virtualMachines/vm-api-01")


def detail_row(model, cost, resource_id=VM_ID, meter="D2s v3", service="Virtual Machines"):
    return {
        "PricingModel": model,
        "PreTaxCost": cost,
        "ResourceId": resource_id,
        "Meter": meter,
        "ServiceName": service,
        "Currency": "INR",
    }


def test_resource_id_yields_the_parts_a_person_needs_to_find_the_resource():
    parsed = parse_resource_id(VM_ID)

    assert parsed["subscription_id"] == "sub-1"
    assert parsed["resource_group"] == "rg-prod"
    assert parsed["name"] == "vm-api-01"
    assert "virtualMachines" in parsed["resource_type"]


def test_a_malformed_id_still_yields_something_identifiable():
    """An empty row would leave the user with a cost and nothing to act on."""
    parsed = parse_resource_id("/subscriptions/sub-1/weird")
    assert parsed["name"] == "weird"


def test_reserved_detail_names_the_vm_group_and_sku():
    result = reserved_detail([detail_row("Reservation", 500.0)])

    resource = result["resources"][0]
    assert resource["name"] == "vm-api-01"
    assert resource["resource_group"] == "rg-prod"
    assert resource["subscription_id"] == "sub-1"
    assert resource["meters"][0]["name"] == "D2s v3"
    assert result["total"] == 500.0


def test_only_reserved_charges_appear_in_reserved_detail():
    """On-demand spend in this list would misrepresent what the RI covered."""
    result = reserved_detail([
        detail_row("Reservation", 500.0),
        detail_row("OnDemand", 900.0, resource_id=VM_ID.replace("vm-api-01", "vm-api-02")),
    ])

    assert result["resource_count"] == 1
    assert result["resources"][0]["name"] == "vm-api-01"


def test_the_same_resource_is_not_split_by_id_casing():
    """
    Azure varies the casing of resource ids between APIs. Matching on the raw
    string would list one machine twice and halve each figure.
    """
    result = reserved_detail([
        detail_row("Reservation", 300.0, resource_id=VM_ID),
        detail_row("Reservation", 200.0, resource_id=VM_ID.upper()),
    ])

    assert result["resource_count"] == 1
    assert result["resources"][0]["cost"] == 500.0


def test_meters_are_kept_per_resource_and_ordered_by_cost():
    """The priciest meter is the one that identifies the SKU."""
    result = reserved_detail([
        detail_row("Reservation", 50.0, meter="Premium SSD"),
        detail_row("Reservation", 400.0, meter="D2s v3"),
    ])

    meters = result["resources"][0]["meters"]
    assert [m["name"] for m in meters] == ["D2s v3", "Premium SSD"]


def test_the_most_expensive_resource_is_listed_first():
    other = VM_ID.replace("vm-api-01", "vm-batch-09")
    result = reserved_detail([
        detail_row("Reservation", 100.0, resource_id=VM_ID),
        detail_row("Reservation", 800.0, resource_id=other),
    ])

    assert [r["name"] for r in result["resources"]] == ["vm-batch-09", "vm-api-01"]


def test_a_reservation_billed_at_scope_is_labelled_not_dropped():
    """
    Some reservation charges carry no resource id at all. Dropping them would
    make the detail total disagree with the headline figure.
    """
    result = reserved_detail([
        {"PricingModel": "Reservation", "PreTaxCost": 250.0, "ResourceId": "",
         "Meter": "D2s v3", "ServiceName": "Virtual Machines"},
    ])

    assert result["total"] == 250.0
    assert result["resources"][0]["name"] == "Unattributed"
