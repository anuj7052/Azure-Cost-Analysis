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


def test_resource_group_is_recovered_from_the_resource_id():
    """
    Only three grouping dimensions are allowed, so the query asks for ResourceId
    and the group name has to be read back out of it.
    """
    rec = _record(ResourceId="/subscriptions/s/resourceGroups/rg-backup/providers/x/vaults/v1")
    del rec["ResourceGroupName"]
    (row,) = to_cost_rows([rec])
    assert row["resource_group"] == "rg-backup"


def test_resource_group_casing_in_the_id_does_not_matter():
    rec = _record(ResourceId="/subscriptions/s/RESOURCEGROUPS/rg-backup/providers/x/vaults/v1")
    del rec["ResourceGroupName"]
    (row,) = to_cost_rows([rec])
    assert row["resource_group"] == "rg-backup"


def test_the_explicit_group_dimension_still_wins_when_present():
    (row,) = to_cost_rows([
        _record(ResourceId="/subscriptions/s/resourceGroups/other/providers/x/vm/a")
    ])
    assert row["resource_group"] == "rg-sap"


def test_a_charge_with_no_resource_id_does_not_invent_a_group():
    rec = _record()
    del rec["ResourceGroupName"]
    (row,) = to_cost_rows([rec])
    assert row["resource_group"] == ""


def test_costs_are_not_silently_rounded_away():
    """Small per-meter charges must survive; they add up across hundreds of rows."""
    (row,) = to_cost_rows([_record(PreTaxCost=0.0007, UsageQuantity=0)])
    assert row["cost"] == 0.0007


class TestRetryableErrors:
    """
    A partial result used to say "wait about 4s and hit Refresh". That is fine
    advice for a person and useless to the page, which could not press its own
    button. These pin the machine-readable half of the answer.
    """

    def test_a_throttle_says_when_to_come_back(self):
        from services.cost_client import RateLimited, error_entry

        entry = error_entry("sub-1", RateLimited(retry_in=45))

        assert entry["retryable"] is True
        assert entry["retry_after_seconds"] == 45
        assert entry["subscription_id"] == "sub-1"

    def test_a_very_short_wait_is_padded(self):
        from services.cost_client import MIN_RETRY_AFTER, RateLimited, error_entry

        # RateLimited clamps its own wait to one second. Coming back that fast
        # is how a retry becomes a second throttle.
        entry = error_entry("sub-1", RateLimited(retry_in=1))

        assert entry["retry_after_seconds"] == MIN_RETRY_AFTER

    def test_a_timeout_is_worth_another_go(self):
        from services.cost_client import error_entry

        entry = error_entry("sub-1", TimeoutError())

        assert entry["retryable"] is True
        assert entry["retry_after_seconds"] > 0

    def test_a_missing_role_is_not_retried_for_ever(self):
        import httpx
        from services.cost_client import error_entry

        request = httpx.Request("GET", "https://management.azure.com/")
        response = httpx.Response(403, request=request)
        exc = httpx.HTTPStatusError("denied", request=request, response=response)

        entry = error_entry("sub-1", exc)

        # Retrying a permission failure on a timer is a spin loop, not
        # resilience: it will refuse identically for ever.
        assert entry["retryable"] is False
        assert entry["retry_after_seconds"] == 0
        assert "Cost Management Reader" in entry["error"]

    def test_the_message_no_longer_asks_the_user_to_press_refresh(self):
        from services.cost_client import RateLimited, error_entry

        entry = error_entry("sub-1", RateLimited(retry_in=45))

        assert "automatically" in entry["error"]
        assert "hit Refresh" not in entry["error"]
