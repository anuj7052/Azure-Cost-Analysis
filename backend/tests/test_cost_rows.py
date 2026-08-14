"""
The month-over-month comparison and the BOQ match both read `to_cost_rows`.
A wrong figure here shows up as a wrong amount on screen, so the mapping from
Azure's columnar response to our row shape is pinned down by tests.
"""
from __future__ import annotations

from services.analysis import to_cost_rows


def _record(**overrides):
    base = {
        "ServiceName": "Virtual Machines",
        "ResourceGroupName": "rg-sap",
        "Meter": "D8s v3",
        "UsageDate": 20260701,
        "PreTaxCost": 1234.5,
        "UsageQuantity": 744.0,
        "UnitOfMeasure": "1 Hour",
        "SubscriptionId": "sub-1",
        "Currency": "INR",
    }
    base.update(overrides)
    return base


def test_maps_cost_and_quantity():
    (row,) = to_cost_rows([_record()])
    assert row["month"] == "2026-07"
    assert row["cost"] == 1234.5
    assert row["quantity"] == 744.0
    assert row["unit_of_measure"] == "1 Hour"
    assert row["service"] == "Virtual Machines"
    assert row["resource_group"] == "rg-sap"
    assert row["meter"] == "D8s v3"


def test_drops_rows_with_no_cost_and_no_usage():
    """Azure emits many zero rows; they would render as meaningless blank lines."""
    assert to_cost_rows([_record(PreTaxCost=0, UsageQuantity=0)]) == []


def test_keeps_zero_cost_rows_that_still_consumed_units():
    """Free egress is genuinely useful — it must not vanish from the report."""
    (row,) = to_cost_rows([_record(PreTaxCost=0, UsageQuantity=12.0)])
    assert row["quantity"] == 12.0


def test_accepts_iso_dates_as_well_as_yyyymmdd():
    (row,) = to_cost_rows([_record(UsageDate="2026-07-01")])
    assert row["month"] == "2026-07"


def test_falls_back_when_azure_omits_service_name():
    """Usage queries return MeterCategory instead of ServiceName."""
    rec = _record()
    del rec["ServiceName"]
    rec["MeterCategory"] = "Bandwidth"
    (row,) = to_cost_rows([rec])
    assert row["service"] == "Bandwidth"


def test_missing_service_never_blanks_the_row():
    rec = _record()
    del rec["ServiceName"]
    (row,) = to_cost_rows([rec])
    assert row["service"] == "Unknown"


def test_resource_name_comes_from_the_last_segment_of_the_resource_id():
    (row,) = to_cost_rows([
        _record(ResourceId="/subscriptions/s/resourceGroups/rg/providers/x/vm/mmshdb01")
    ])
    assert row["resource_name"] == "mmshdb01"


def test_costs_are_not_silently_rounded_away():
    """Small per-meter charges must survive; they add up across hundreds of rows."""
    (row,) = to_cost_rows([_record(PreTaxCost=0.0007, UsageQuantity=0)])
    assert row["cost"] == 0.0007
