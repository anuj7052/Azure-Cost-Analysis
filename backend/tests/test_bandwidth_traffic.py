"""
Tracing a bandwidth charge back to the resource that caused it.

The report has to survive every degraded case, because the degraded cases are
the common ones: no permission to list IP addresses, an agreement that will not
break costs down past the resource group, meters billed by the hour that carry
no volume at all. An earlier version returned nothing in some of these, which is
how "Data Track not found" happened. Most of these tests exist to keep the
section populated and self-explanatory when something is missing.
"""
import pytest

from services import bandwidth_traffic as bt
from services.bandwidth import detect_unit_bytes

GB = 1024 ** 3


def vm_id(name, group="rg-web", sub="sub-1"):
    return (
        f"/subscriptions/{sub}/resourceGroups/{group}"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


def charge(resource_id=None, group=None, cost=100.0, gb=20.0,
           meter="Data Transfer Out - GB", unit="1 GB", sub="sub-1"):
    rec = {
        "Meter": meter,
        "MeterCategory": "Bandwidth",
        "UnitOfMeasure": unit,
        "UsageQuantity": gb,
        "PreTaxCost": cost,
        "SubscriptionId": sub,
    }
    if resource_id:
        rec["ResourceId"] = resource_id
    if group:
        rec["ResourceGroupName"] = group
    return rec


def ip_resource(name, address, group, attached_to=None, sub="sub-1"):
    resource_id = (
        f"/subscriptions/{sub}/resourceGroups/{group}"
        f"/providers/Microsoft.Network/publicIPAddresses/{name}"
    )
    props = {
        "ipAddress": address,
        "publicIPAllocationMethod": "Static",
        "publicIPAddressVersion": "IPv4",
    }
    if attached_to:
        props["ipConfiguration"] = {"id": f"{attached_to}/ipConfigurations/ipconfig1"}
    return {
        "id": resource_id,
        "name": name,
        "location": "centralindia",
        "sku": {"name": "Standard"},
        "resourceGroup": group,
        "subscriptionId": sub,
        "properties": props,
    }


class TestResourceIdentity:
    def test_a_virtual_machine_is_named_and_typed(self):
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        row = report["rows"][0]
        assert row["name"] == "web01"
        assert row["kind"] == "Virtual machine"
        assert row["is_resource"] is True

    def test_the_resource_group_comes_from_the_arm_id(self):
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("web01", "rg-prod"))], detect_unit_bytes
        )
        assert report["rows"][0]["resource_group"] == "rg-prod"

    @pytest.mark.parametrize("arm_type,expected", [
        ("Microsoft.Network/loadBalancers", "Load balancer"),
        ("Microsoft.Storage/storageAccounts", "Storage account"),
        ("Microsoft.Network/natGateways", "NAT gateway"),
        ("Microsoft.Network/applicationGateways", "Application gateway"),
    ])
    def test_common_types_read_as_english(self, arm_type, expected):
        rid = f"/subscriptions/s/resourceGroups/g/providers/{arm_type}/thing"
        assert bt.friendly_type(rid) == expected

    def test_lowercased_resource_ids_still_match(self):
        """Cost Management sometimes returns the whole id in lower case."""
        assert bt.friendly_type(vm_id("web01").lower()) == "Virtual machine"

    def test_an_unlisted_type_still_gets_a_readable_name(self):
        rid = "/subscriptions/s/resourceGroups/g/providers/Microsoft.Foo/widgets/w1"
        assert bt.friendly_type(rid) == "Widget"

    def test_a_group_level_row_says_it_is_a_group(self):
        report = bt.build_traffic_report([charge(group="rg-web")], detect_unit_bytes, level="group")
        row = report["rows"][0]
        assert row["is_resource"] is False
        assert row["kind"] == "Resource group"
        assert row["name"] == "rg-web"


class TestPerMeterPricing:
    """The user asked for every meter's price, not just a total."""

    def test_each_meter_carries_quantity_unit_cost_and_rate(self):
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("web01"), cost=100.0, gb=20.0)],
            detect_unit_bytes,
        )
        meter = report["rows"][0]["meters"][0]
        assert meter["quantity"] == 20.0
        assert meter["unit"] == "1 GB"
        assert meter["cost"] == 100.0
        assert meter["unit_rate"] == 5.0

    def test_several_meters_on_one_resource_are_kept_apart(self):
        report = bt.build_traffic_report([
            charge(resource_id=vm_id("web01"), meter="Data Transfer Out - GB", cost=100.0, gb=20.0),
            charge(resource_id=vm_id("web01"), meter="Data Transfer In - GB", cost=0.0, gb=50.0),
        ], detect_unit_bytes)
        row = report["rows"][0]
        assert row["meter_count"] == 2
        assert {m["meter"] for m in row["meters"]} == {
            "Data Transfer Out - GB", "Data Transfer In - GB"
        }

    def test_the_dearest_meter_is_listed_first(self):
        report = bt.build_traffic_report([
            charge(resource_id=vm_id("web01"), meter="cheap", cost=5.0, gb=1.0),
            charge(resource_id=vm_id("web01"), meter="dear", cost=500.0, gb=90.0),
        ], detect_unit_bytes)
        assert report["rows"][0]["meters"][0]["meter"] == "dear"

    def test_a_meter_with_no_quantity_reports_no_rate_rather_than_zero(self):
        """
        A rate of zero would read as "this is free". None reads as "there is no
        rate to state", which is the truth for an hourly gateway charge.
        """
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("gw"), cost=800.0, gb=0.0, unit="1 Hour")],
            detect_unit_bytes,
        )
        assert report["rows"][0]["meters"][0]["unit_rate"] is None

    def test_a_time_billed_meter_carries_no_transfer_volume(self):
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("gw"), cost=800.0, gb=744, unit="1 Hour")],
            detect_unit_bytes,
        )
        row = report["rows"][0]
        assert row["bytes"] == 0
        assert "no transfer size" in row["explain"]

    def test_quantities_for_the_same_meter_are_summed_not_replaced(self):
        report = bt.build_traffic_report([
            charge(resource_id=vm_id("web01"), cost=50.0, gb=10.0),
            charge(resource_id=vm_id("web01"), cost=50.0, gb=10.0),
        ], detect_unit_bytes)
        meter = report["rows"][0]["meters"][0]
        assert meter["quantity"] == 20.0
        assert meter["cost"] == 100.0


class TestAddresses:
    def test_an_address_in_the_same_group_is_offered(self):
        ips = [bt.normalise_ip(ip_resource("pip-web", "20.40.1.5", "rg-web"))]
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("web01"))], detect_unit_bytes, ips=ips
        )
        addresses = report["rows"][0]["addresses"]
        assert addresses[0]["ip_address"] == "20.40.1.5"

    def test_a_group_matched_address_is_labelled_as_indicative(self):
        """
        An address in the same group is a hint, not proof. Labelling it keeps it
        distinguishable from an exact attachment match.
        """
        ips = [bt.normalise_ip(ip_resource("pip-web", "20.40.1.5", "rg-web"))]
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("web01"))], detect_unit_bytes, ips=ips
        )
        assert report["rows"][0]["addresses"][0]["match"] == "same resource group"

    def test_the_report_stands_without_any_addresses_at_all(self):
        """
        The address inventory needs a permission billing does not. Losing it must
        cost the addresses and nothing else — this is the regression that made
        the whole section disappear.
        """
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        row = report["rows"][0]
        assert row["name"] == "web01"
        assert row["cost"] == 100.0
        assert row["addresses"] == []

    def test_an_idle_address_is_reported_as_waste(self):
        ips = [bt.normalise_ip(ip_resource("pip-spare", "20.40.1.9", "rg-web"))]
        report = bt.build_traffic_report([], detect_unit_bytes, ips=ips)
        assert report["totals"]["idle_ip_count"] == 1
        assert "waste" in report["idle_ips"][0]["note"]

    def test_an_unattached_address_is_recognised(self):
        out = bt.normalise_ip(ip_resource("pip-spare", "20.40.1.9", "rg-web"))
        assert out["is_attached"] is False
        assert out["attached_kind"] == "Unattached"


class TestOrderingAndTotals:
    def test_the_most_expensive_resource_is_first(self):
        report = bt.build_traffic_report([
            charge(resource_id=vm_id("small"), cost=10.0, gb=2.0),
            charge(resource_id=vm_id("large"), cost=900.0, gb=180.0),
        ], detect_unit_bytes)
        assert [r["name"] for r in report["rows"]] == ["large", "small"]

    def test_totals_match_the_sum_of_the_rows(self):
        report = bt.build_traffic_report([
            charge(resource_id=vm_id("a"), cost=100.0, gb=20.0),
            charge(resource_id=vm_id("b"), cost=250.0, gb=50.0),
        ], detect_unit_bytes)
        assert report["totals"]["tracked_cost"] == 350.0
        assert report["totals"]["named_resource_count"] == 2

    def test_volume_is_converted_from_the_billed_unit(self):
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("web01"), gb=100.0)], detect_unit_bytes
        )
        assert report["rows"][0]["gb"] == pytest.approx(100.0, abs=0.01)

    def test_resource_and_group_rows_are_not_collapsed_together(self):
        """A mixed response must keep both kinds addressable."""
        report = bt.build_traffic_report([
            charge(resource_id=vm_id("web01"), cost=100.0),
            charge(group="rg-other", cost=40.0),
        ], detect_unit_bytes)
        assert len(report["rows"]) == 2


class TestDisclosure:
    def test_the_level_is_always_stated(self):
        assert bt.build_traffic_report([], detect_unit_bytes)["level"] == "resource"
        assert bt.build_traffic_report([], detect_unit_bytes, level="group")["level"] == "group"

    def test_group_level_does_not_claim_to_name_a_resource(self):
        method = bt.build_traffic_report([], detect_unit_bytes, level="group")["method"]
        assert "not break these charges down past the resource" in method

    def test_missing_flow_logs_are_explained_not_left_blank(self):
        status = bt.flow_log_status(False)
        assert status["available"] is False
        assert "cannot be recovered" in status["note"]
        assert status["how"]

    def test_missing_flow_logs_do_not_undermine_the_billing_data(self):
        assert "unaffected" in bt.flow_log_status(False)["note"]

    def test_every_row_explains_itself_in_a_sentence(self):
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        assert "web01" in report["rows"][0]["explain"]

    def test_an_empty_account_produces_a_valid_empty_report(self):
        report = bt.build_traffic_report([], detect_unit_bytes)
        assert report["rows"] == []
        assert report["totals"]["tracked_cost"] == 0
        assert report["flow_logs"]["available"] is False


def day(date, cost=10.0, gb=2.0, meter="Data Transfer Out - GB"):
    return {
        "UsageDate": date,
        "Meter": meter,
        "MeterCategory": "Bandwidth",
        "UnitOfMeasure": "1 GB",
        "UsageQuantity": gb,
        "PreTaxCost": cost,
    }


class TestDailySeries:
    def test_days_come_back_in_date_order(self):
        out = bt.build_daily_series(
            [day(20260803), day(20260801), day(20260802)], detect_unit_bytes
        )
        assert [d["date"] for d in out["days"]] == ["2026-08-01", "2026-08-02", "2026-08-03"]

    def test_azures_integer_dates_are_turned_into_real_dates(self):
        """Cost Management returns 20260814, which is not a date anyone can read."""
        out = bt.build_daily_series([day(20260814)], detect_unit_bytes)
        assert out["days"][0]["date"] == "2026-08-14"

    def test_string_dates_are_accepted_too(self):
        out = bt.build_daily_series([day("2026-08-14T00:00:00")], detect_unit_bytes)
        assert out["days"][0]["date"] == "2026-08-14"

    def test_several_meters_on_one_day_are_kept_apart(self):
        out = bt.build_daily_series([
            day(20260801, cost=10.0, meter="Data Transfer Out - GB"),
            day(20260801, cost=4.0, meter="Data Transfer In - GB"),
        ], detect_unit_bytes)
        assert len(out["days"]) == 1
        assert out["days"][0]["cost"] == 14.0
        assert len(out["days"][0]["meters"]) == 2

    def test_the_peak_day_is_identified(self):
        out = bt.build_daily_series([
            day(20260801, cost=10.0),
            day(20260802, cost=900.0),
            day(20260803, cost=12.0),
        ], detect_unit_bytes)
        assert out["peak"]["date"] == "2026-08-02"

    def test_a_dominant_day_is_called_a_single_event(self):
        """
        A spike and a steady spend need different investigations, so the note
        must not describe them the same way.
        """
        out = bt.build_daily_series([
            day(20260801, cost=10.0),
            day(20260802, cost=900.0),
        ], detect_unit_bytes)
        assert "single event" in out["note"]

    def test_even_spending_is_described_as_ongoing(self):
        out = bt.build_daily_series(
            [day(20260801 + i, cost=10.0) for i in range(10)], detect_unit_bytes
        )
        assert "ongoing" in out["note"]

    def test_the_average_ignores_days_with_no_charge(self):
        """
        Dividing by calendar days understates a workload that only runs on
        weekdays, and the understatement grows with the size of the window.
        """
        out = bt.build_daily_series([
            day(20260801, cost=100.0),
            day(20260802, cost=0.0, gb=0.0),
        ], detect_unit_bytes)
        assert out["charged_day_count"] == 1
        assert out["average_cost"] == 100.0

    def test_an_empty_period_says_so_rather_than_crashing(self):
        out = bt.build_daily_series([], detect_unit_bytes)
        assert out["days"] == []
        assert out["peak"] is None
        assert "no daily rows" in out["note"]

    def test_rows_without_a_date_are_skipped(self):
        out = bt.build_daily_series([{"UsageQuantity": 5, "PreTaxCost": 5}], detect_unit_bytes)
        assert out["days"] == []


class TestKqlQueries:
    def test_every_row_carries_runnable_queries(self):
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        queries = report["rows"][0]["kql"]
        assert len(queries) >= 3
        assert all(q["query"].strip() for q in queries)

    def test_the_query_is_scoped_by_ip_when_one_is_known(self):
        """A query that returns the whole estate buries the resource in question."""
        ips = [bt.normalise_ip(ip_resource("pip-web", "20.40.1.5", "rg-web"))]
        report = bt.build_traffic_report(
            [charge(resource_id=vm_id("web01"))], detect_unit_bytes, ips=ips
        )
        where = report["rows"][0]["kql"][0]
        assert '"20.40.1.5"' in where["query"]
        assert where["matched_by"] == "public IP address"

    def test_it_falls_back_to_the_resource_name_without_an_ip(self):
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        first = report["rows"][0]["kql"][0]
        assert "web01" in first["query"]
        assert first["matched_by"] == "resource name"

    def test_the_first_query_checks_the_data_exists(self):
        """
        Running a destination query against a workspace with no flow logs
        returns nothing and looks like the resource sent nothing. The check has
        to come first or the empty result will be misread.
        """
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        assert "Check flow logs" in report["rows"][0]["kql"][0]["title"]

    def test_both_the_current_and_legacy_schemas_are_offered(self):
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        tables = {q["table"] for q in report["rows"][0]["kql"]}
        assert "NTANetAnalytics" in tables
        assert "AzureNetworkAnalytics_CL" in tables

    def test_a_destination_query_actually_groups_by_destination(self):
        report = bt.build_traffic_report([charge(resource_id=vm_id("web01"))], detect_unit_bytes)
        dest = next(q for q in report["rows"][0]["kql"] if q["title"] == "Where the data went")
        assert "DestIp" in dest["query"]
        assert "Outbound" in dest["query"]

    def test_quotes_in_a_resource_name_cannot_break_the_query(self):
        """
        Resource names are not user input here, but they reach a query string,
        and a name containing a quote would silently produce invalid KQL.
        """
        queries = bt.kql_for({"name": 'web"01', "resource_group": "rg", "ip_list": []})
        assert 'web\\"01' in queries[0]["query"]
