"""
Commitments.

The two failure modes worth testing are the ones that cost money in opposite
directions: reporting a healthy commitment as unused, which gets something
cancelled that people depend on, and reporting a missing number as zero, which
looks identical to a measured zero on screen.
"""
from datetime import datetime, timezone

import pytest

from services import commitments as c


TODAY = datetime(2026, 8, 30, tzinfo=timezone.utc)


def aggregate(grain, value):
    return {"grain": grain, "grainUnit": "days", "value": value,
            "valueUnit": "percentage"}


def reservation(name="ri-a", expiry="2027-03-15T00:00:00Z", used=None,
                quantity=10, sku="Standard_D8s_v5", state="Succeeded"):
    aggregates = [aggregate(g, used) for g in (1, 7, 30)] if used is not None else []
    return {
        "id": f"/providers/Microsoft.Capacity/reservationOrders/o1/reservations/{name}",
        "name": name,
        "location": "eastus2",
        "sku": {"name": sku},
        "properties": {
            "displayName": name,
            "reservedResourceType": "VirtualMachines",
            "term": "P3Y",
            "quantity": quantity,
            "provisioningState": state,
            "appliedScopeType": "Shared",
            "billingPlan": "Monthly",
            "renew": False,
            "expiryDateTime": expiry,
            "utilization": {"aggregates": aggregates},
        },
    }


def savings_plan(name="sp-a", expiry="2028-01-15T00:00:00Z", used=None, amount=58.33):
    aggregates = [aggregate(g, used) for g in (1, 7, 30)] if used is not None else []
    return {
        "id": f"/providers/Microsoft.BillingBenefits/savingsPlanOrders/o1/savingsPlans/{name}",
        "name": name,
        "sku": {"name": "Compute_Savings_Plan"},
        "properties": {
            "displayName": name,
            "term": "P3Y",
            "provisioningState": "Succeeded",
            "appliedScopeType": "Shared",
            "billingPlan": "P1M",
            "expiryDateTime": expiry,
            "commitment": {"amount": amount, "grain": "Hourly", "currencyCode": "USD"},
            "utilization": {"aggregates": aggregates},
        },
    }


class TestUtilisation:
    def test_reads_the_grain_that_was_asked_for(self):
        row = {"properties": {"utilization": {"aggregates": [
            aggregate(1, 68.0), aggregate(7, 79.1), aggregate(30, 90.3),
        ]}}}
        assert c.utilisation(row, 7) == 79.1
        assert c.utilisation(row, 30) == 90.3

    def test_a_grain_azure_did_not_publish_is_unknown_not_zero(self):
        # Zero utilisation is the argument for cancelling a commitment. A
        # missing number must never be able to make that argument.
        row = {"properties": {"utilization": {"aggregates": [aggregate(1, 68.0)]}}}
        assert c.utilisation(row, 30) is None

    def test_a_genuine_zero_survives(self):
        row = {"properties": {"utilization": {"aggregates": [aggregate(30, 0.0)]}}}
        assert c.utilisation(row, 30) == 0.0

    def test_a_commitment_with_no_aggregates_reports_nothing(self):
        assert c.utilisation({"properties": {}}, 30) is None
        assert c.utilisation({}, 30) is None

    def test_a_grain_measured_in_something_other_than_days_is_not_used(self):
        row = {"properties": {"utilization": {"aggregates": [
            {"grain": 30, "grainUnit": "hours", "value": 12.0},
        ]}}}
        assert c.utilisation(row, 30) is None


class TestExpiry:
    def test_counts_days_to_a_future_date(self):
        assert c.days_until("2026-09-20T00:00:00Z", TODAY) == 21

    def test_a_lapsed_commitment_counts_negative(self):
        assert c.days_until("2026-08-01T00:00:00Z", TODAY) == -29

    def test_an_unreadable_date_is_unknown_not_far_away(self):
        # "Expires in a long time" is the one reading that guarantees nobody
        # looks at it again.
        assert c.days_until("not a date", TODAY) is None
        assert c.days_until("", TODAY) is None
        assert c.days_until(None, TODAY) is None

    def test_reads_a_bare_calendar_date(self):
        assert c.days_until("2026-09-20", TODAY) == 21

    @pytest.mark.parametrize("days,band", [
        (-1, c.EXPIRED), (0, "critical"), (21, "critical"), (30, "critical"),
        (31, "warning"), (60, "warning"), (61, "watch"), (90, "watch"), (91, ""),
    ])
    def test_bands(self, days, band):
        assert c.expiry_band(days) == band

    def test_an_unknown_expiry_has_no_band(self):
        assert c.expiry_band(None) == ""


class TestWastage:
    def test_unused_share_of_a_known_cost(self):
        assert c.wastage(1000.0, 90.0) == 100.0

    def test_a_fully_used_commitment_wastes_nothing(self):
        assert c.wastage(1000.0, 100.0) == 0.0

    def test_an_unknown_cost_gives_an_unknown_answer(self):
        # Half of this calculation is not better than none of it: on screen an
        # estimate built on a guessed cost is indistinguishable from a measured
        # one, and this number is what gets a commitment cancelled.
        assert c.wastage(None, 40.0) is None

    def test_an_unknown_utilisation_gives_an_unknown_answer(self):
        assert c.wastage(1000.0, None) is None

    def test_utilisation_above_a_hundred_does_not_produce_negative_waste(self):
        assert c.wastage(1000.0, 130.0) == 0.0


class TestNormalising:
    def test_a_reservation_carries_its_facts_through(self):
        out = c.normalise_reservation(reservation(used=90.3), TODAY)
        assert out["kind"] == c.RESERVATION
        assert out["sku"] == "Standard_D8s_v5"
        assert out["term"] == "P3Y"
        assert out["quantity"] == 10
        assert out["utilisation"][30] == 90.3

    def test_cost_starts_unknown_rather_than_zero(self):
        out = c.normalise_reservation(reservation(), TODAY)
        assert out["monthly_cost"] is None

    def test_a_savings_plan_reports_its_hourly_commitment(self):
        out = c.normalise_savings_plan(savings_plan(amount=58.33), TODAY)
        assert out["kind"] == c.SAVINGS_PLAN
        assert out["quantity"] == 58.33
        assert out["quantity_unit"] == "hourly"
        assert out["currency"] == "USD"

    def test_an_empty_row_does_not_raise(self):
        out = c.normalise_reservation({}, TODAY)
        assert out["name"] == ""
        assert out["days_to_expiry"] is None


class TestJoiningCost:
    def test_matches_a_commitment_to_its_measured_cost(self):
        items = [c.normalise_reservation(reservation("ri-a"), TODAY)]
        c.attach_costs(items, {"ri-a": 42580.90}, "USD")
        assert items[0]["monthly_cost"] == 42580.9
        assert items[0]["currency"] == "USD"

    def test_the_match_ignores_casing_and_padding(self):
        items = [c.normalise_reservation(reservation("RI-A"), TODAY)]
        c.attach_costs(items, {"  ri-a  ": 100.0}, "USD")
        assert items[0]["monthly_cost"] == 100.0

    def test_a_near_miss_is_not_joined(self):
        # Showing one commitment's money against another is a larger error than
        # showing no money at all.
        items = [c.normalise_reservation(reservation("ri-a"), TODAY)]
        c.attach_costs(items, {"ri-a-prod": 100.0}, "USD")
        assert items[0]["monthly_cost"] is None

    def test_a_commitment_with_no_cost_stays_unknown(self):
        items = [c.normalise_reservation(reservation("ri-a"), TODAY)]
        c.attach_costs(items, {}, "USD")
        assert items[0]["monthly_cost"] is None

    def test_the_resource_id_is_preferred_over_the_display_name(self):
        # A renamed commitment keeps its old name in past cost rows, so joining
        # on the name alone loses its money entirely.
        row = reservation("ri-a")
        row["properties"]["displayName"] = "renamed-yesterday"
        items = [c.normalise_reservation(row, TODAY)]
        c.attach_costs(items, {row["id"]: 500.0}, "USD")
        assert items[0]["monthly_cost"] == 500.0

    def test_the_trailing_guid_of_the_id_also_matches(self):
        # The two APIs disagree on how much of the path they return.
        row = reservation("ri-a")
        row["properties"]["displayName"] = "renamed-yesterday"
        items = [c.normalise_reservation(row, TODAY)]
        c.attach_costs(items, {"RI-A": 250.0}, "USD")
        assert items[0]["monthly_cost"] == 250.0

    def test_the_unused_portion_is_carried_when_azure_billed_it(self):
        items = [c.normalise_reservation(reservation("ri-a"), TODAY)]
        c.attach_costs(items, {"ri-a": {"cost": 1000.0, "unused": 250.0}}, "USD")
        assert items[0]["monthly_cost"] == 1000.0
        assert items[0]["measured_wastage"] == 250.0

    def test_no_measured_wastage_is_recorded_when_none_was_reported(self):
        # Absent must not become zero: "Azure billed no waste" and "we never
        # asked" are different answers and only one of them is reassuring.
        items = [c.normalise_reservation(reservation("ri-a"), TODAY)]
        c.attach_costs(items, {"ri-a": 1000.0}, "USD")
        assert items[0]["measured_wastage"] is None


class TestWastageOf:
    def test_azures_own_figure_wins_over_the_derived_one(self):
        item = c.normalise_reservation(reservation("ri-a", used=50.0), TODAY)
        item["monthly_cost"] = 1000.0
        item["measured_wastage"] = 120.0
        assert c.wastage_of(item, 30) == (120.0, "measured")

    def test_it_falls_back_to_cost_times_the_unused_share(self):
        item = c.normalise_reservation(reservation("ri-a", used=60.0), TODAY)
        item["monthly_cost"] = 1000.0
        assert c.wastage_of(item, 30) == (400.0, "derived")

    def test_a_measured_figure_survives_missing_utilisation(self):
        # The whole point of preferring the billed number: it exists in tenants
        # where the utilisation API returns nothing at all.
        item = c.normalise_reservation(reservation("ri-a"), TODAY)
        item["measured_wastage"] = 75.0
        assert c.wastage_of(item, 30) == (75.0, "measured")

    def test_nothing_known_stays_unknown(self):
        item = c.normalise_reservation(reservation("ri-a"), TODAY)
        assert c.wastage_of(item, 30) == (None, "")


class TestSummary:
    def build(self, *specs):
        items = []
        for name, used, cost, expiry in specs:
            item = c.normalise_reservation(reservation(name, expiry, used), TODAY)
            item["monthly_cost"] = cost
            items.append(item)
        return items

    def test_weights_utilisation_by_money(self):
        # A large underused reservation and a tiny well-used one must not count
        # equally, or the headline hides the expensive problem.
        items = self.build(
            ("big", 50.0, 10000.0, "2027-01-01T00:00:00Z"),
            ("small", 100.0, 100.0, "2027-01-01T00:00:00Z"),
        )
        out = c.summarise(items, 30)
        assert out["utilisation"] == 50.5
        assert "weighted" in out["utilisation_basis"]

    def test_falls_back_to_a_plain_average_and_says_so(self):
        items = self.build(
            ("a", 50.0, None, "2027-01-01T00:00:00Z"),
            ("b", 100.0, None, "2027-01-01T00:00:00Z"),
        )
        out = c.summarise(items, 30)
        assert out["utilisation"] == 75.0
        assert "plain average" in out["utilisation_basis"]

    def test_reports_how_many_commitments_the_money_covers(self):
        items = self.build(
            ("a", 50.0, 100.0, "2027-01-01T00:00:00Z"),
            ("b", 50.0, None, "2027-01-01T00:00:00Z"),
        )
        out = c.summarise(items, 30)
        assert out["costed"] == 1
        assert out["active"] == 2

    def test_spend_is_unknown_when_nothing_was_costed(self):
        items = self.build(("a", 50.0, None, "2027-01-01T00:00:00Z"))
        assert c.summarise(items, 30)["monthly_spend"] is None

    def test_wastage_is_unknown_when_nothing_can_be_computed(self):
        items = self.build(("a", None, None, "2027-01-01T00:00:00Z"))
        assert c.summarise(items, 30)["wastage"] is None

    def test_expired_commitments_are_excluded_from_the_headline(self):
        items = self.build(
            ("live", 90.0, 100.0, "2027-01-01T00:00:00Z"),
            ("gone", 10.0, 100.0, "2026-01-01T00:00:00Z"),
        )
        out = c.summarise(items, 30)
        assert out["active"] == 1
        assert out["expired"] == 1
        assert out["utilisation"] == 90.0

    def test_names_the_nearest_expiry(self):
        items = self.build(
            ("later", 90.0, 100.0, "2027-01-01T00:00:00Z"),
            ("sooner", 90.0, 100.0, "2026-09-20T00:00:00Z"),
        )
        out = c.summarise(items, 30)
        assert out["next_expiry_name"] == "sooner"
        assert out["next_expiry_days"] == 21

    def test_counts_the_underused(self):
        items = self.build(
            ("bad", 68.0, 100.0, "2027-01-01T00:00:00Z"),
            ("fine", 95.0, 100.0, "2027-01-01T00:00:00Z"),
        )
        assert c.summarise(items, 30)["underused"] == 1

    def test_an_empty_estate_summarises_without_raising(self):
        out = c.summarise([], 30)
        assert out["total"] == 0
        assert out["utilisation"] is None


class TestExpiringSoon:
    def test_lists_only_what_lapses_inside_the_window(self):
        items = [
            c.normalise_reservation(reservation("soon", "2026-09-20T00:00:00Z"), TODAY),
            c.normalise_reservation(reservation("later", "2028-01-01T00:00:00Z"), TODAY),
        ]
        assert [i["name"] for i in c.expiring_soon(items)] == ["soon"]

    def test_soonest_first(self):
        items = [
            c.normalise_reservation(reservation("b", "2026-11-01T00:00:00Z"), TODAY),
            c.normalise_reservation(reservation("a", "2026-09-05T00:00:00Z"), TODAY),
        ]
        assert [i["name"] for i in c.expiring_soon(items)] == ["a", "b"]

    def test_already_expired_is_not_expiring_soon(self):
        # It is not a deadline any more, it is a fact, and mixing the two turns
        # the urgent list into a history list.
        items = [c.normalise_reservation(reservation("gone", "2026-01-01T00:00:00Z"), TODAY)]
        assert c.expiring_soon(items) == []


class TestSorting:
    def test_worst_utilisation_first(self):
        items = [
            c.normalise_reservation(reservation("good", used=99.0), TODAY),
            c.normalise_reservation(reservation("bad", used=40.0), TODAY),
        ]
        assert [i["name"] for i in c.sort_commitments(items, 30)] == ["bad", "good"]

    def test_unknown_utilisation_sinks_rather_than_floats(self):
        # A commitment Azure has not measured yet is not the worst performer,
        # and putting it top wastes the position the eye lands on.
        items = [
            c.normalise_reservation(reservation("unknown"), TODAY),
            c.normalise_reservation(reservation("bad", used=40.0), TODAY),
        ]
        assert [i["name"] for i in c.sort_commitments(items, 30)] == ["bad", "unknown"]


class TestRecommendations:
    def test_passes_azure_arithmetic_through_untouched(self):
        row = {"id": "/r1", "properties": {
            "skuName": "Standard_D8s_v5", "term": "P3Y", "lookBackPeriod": "Last30Days",
            "recommendedQuantity": 12, "netSavings": 8912.40,
            "costWithNoReservedInstances": 21389.76,
            "totalCostWithReservedInstances": 12477.36, "currencyCode": "USD",
        }}
        out = c.normalise_recommendation(row)
        assert out["net_savings"] == 8912.40
        assert out["quantity"] == 12
        assert out["savings_percent"] == 41.7

    def test_a_missing_saving_is_unknown_not_zero(self):
        out = c.normalise_recommendation({"properties": {"skuName": "x"}})
        assert out["net_savings"] is None
        assert out["savings_percent"] is None

    def test_a_zero_baseline_does_not_divide(self):
        out = c.normalise_recommendation({"properties": {
            "netSavings": 10.0, "costWithNoReservedInstances": 0,
        }})
        assert out["savings_percent"] is None


class TestNote:
    def test_a_failed_read_is_never_reported_as_having_none(self):
        note = c.note([], {"active": 0, "total": 0}, ["boom"])
        assert "not the same as having none" in note

    def test_a_genuinely_empty_tenant_says_so_plainly(self):
        note = c.note([], {"active": 0, "total": 0}, [])
        assert "pay-as-you-go" in note

    def test_says_how_much_of_the_estate_the_money_covers(self):
        note = c.note([{}], {"active": 4, "total": 4, "costed": 2,
                             "utilisation_basis": ""}, [])
        assert "2 of them" in note


class TestWindow:
    def test_the_cost_window_matches_the_utilisation_window(self):
        # Reading 90% used against a cost covering eleven days would make the
        # wastage figure wrong by a factor of three.
        start, end = c.month_window(TODAY)
        assert start.startswith("2026-07-31")
        assert end.startswith("2026-08-30")
