"""
The Retail Prices query itself.

These exist because the whole application reported "Azure publishes no price
for this size" for every VM in the fleet, and every test still passed. The
tests mocked the HTTP transport and never looked at the URL, so the one thing
that was wrong — the OData filter — was the one thing nothing asserted.

`armSkuName in ('a', 'b')` is valid-looking OData and the Retail Prices service
rejects it with 400. Verified against the live public endpoint.
"""
import pytest

from services import retail_prices as rp
from services.retail_prices import best_vm_rates, vm_sku_filter


class TestTheFilterAzureWillActuallyAccept:
    def test_several_sizes_are_joined_with_or_not_with_in(self):
        f = vm_sku_filter(["Standard_D4as_v5", "Standard_D2as_v5"], "centralindia")
        assert "armSkuName eq 'Standard_D2as_v5'" in f
        assert "armSkuName eq 'Standard_D4as_v5'" in f
        assert " or " in f
        # The exact construction that returns 400 from the live service.
        assert " in (" not in f

    def test_the_or_clause_is_bracketed_so_and_does_not_swallow_it(self):
        # Without the brackets, `A and B and x or y` parses as
        # `(A and B and x) or y` and the region filter stops applying to the
        # second size — which quietly prices one VM in the wrong region.
        f = vm_sku_filter(["Standard_A", "Standard_B"], "westeurope")
        assert "and (armSkuName eq 'Standard_A' or armSkuName eq 'Standard_B')" in f

    def test_it_pins_the_region_the_service_and_the_price_type(self):
        f = vm_sku_filter(["Standard_D2as_v5"], "centralindia")
        assert "serviceName eq 'Virtual Machines'" in f
        assert "armRegionName eq 'centralindia'" in f
        assert "type eq 'Consumption'" in f

    def test_duplicates_are_collapsed(self):
        f = vm_sku_filter(["Standard_D2as_v5", "Standard_D2as_v5"], "centralindia")
        assert f.count("armSkuName eq") == 1

    def test_no_sizes_or_no_region_asks_nothing(self):
        assert vm_sku_filter([], "centralindia") == ""
        assert vm_sku_filter(["Standard_D2as_v5"], "") == ""
        assert vm_sku_filter(["", "  "], "centralindia") == ""

    def test_a_quote_in_a_size_name_cannot_break_out_of_the_literal(self):
        f = vm_sku_filter(["Standard_D2' or '1' eq '1"], "centralindia")
        assert "''" in f


def item(sku, price, meter, product):
    return {
        "arm_sku_name": sku, "retail_price": price,
        "meter_name": meter, "product_name": product,
    }


# The exact shape the live endpoint returned for centralindia, which is where
# the ranking rules below come from.
LIVE = [
    item("Standard_D2as_v5", 14.1562, "D2as v5", "Virtual Machines Dasv5 Series Windows"),
    item("Standard_D2as_v5", 5.64335, "D2as v5 Low Priority", "Virtual Machines Dasv5 Series Windows"),
    item("Standard_D2as_v5", 1.061715, "D2as v5 Low Priority", "Virtual Machines Dasv5 Series"),
    item("Standard_D2as_v5", 14.1562, "D2as v5", "Dasv5 Series Cloud Services"),
    item("Standard_D2as_v5", 5.31814, "D2as v5", "Virtual Machines Dasv5 Series"),
    item("Standard_D2as_v5", 0.982804, "D2as v5 Spot", "Virtual Machines Dasv5 Series"),
    item("Standard_D4as_v5", 28.21675, "D4as v5", "Virtual Machines Dasv5 Series Windows"),
    item("Standard_D4as_v5", 10.61715, "D4as v5", "Virtual Machines Dasv5 Series"),
    item("Standard_D4as_v5", 28.21675, "D4as v5", "Dasv5 Series Cloud Services"),
]


class TestChoosingTheRateSomebodyWouldActuallyPay:
    def test_the_linux_on_demand_rate_is_chosen_for_a_linux_vm(self):
        rates = best_vm_rates(LIVE, windows=False)
        assert rates["standard_d2as_v5"] == pytest.approx(5.31814)
        assert rates["standard_d4as_v5"] == pytest.approx(10.61715)

    def test_the_windows_rate_is_chosen_for_a_windows_vm(self):
        rates = best_vm_rates(LIVE, windows=True)
        assert rates["standard_d2as_v5"] == pytest.approx(14.1562)
        assert rates["standard_d4as_v5"] == pytest.approx(28.21675)

    def test_spot_is_never_quoted_as_the_price_of_a_vm(self):
        # Spot is ~5x cheaper and can be evicted at any moment. Quoting it
        # would invent a saving that only exists for a workload that tolerates
        # being killed without warning.
        rates = best_vm_rates(LIVE, windows=False)
        assert rates["standard_d2as_v5"] > 0.982804

    def test_low_priority_is_never_quoted_either(self):
        rates = best_vm_rates(LIVE, windows=False)
        assert rates["standard_d2as_v5"] != pytest.approx(1.061715)

    def test_cloud_services_meters_are_not_virtual_machines(self):
        # Microsoft publishes classic Cloud Services under the same armSkuName
        # at the Windows rate. Letting them in skews the pool.
        only_cloud = [i for i in LIVE if "Cloud Services" in i["product_name"]]
        assert best_vm_rates(only_cloud, windows=False) == {}

    def test_a_windows_vm_is_never_priced_from_a_linux_meter(self):
        linux_only = [i for i in LIVE if "Windows" not in i["product_name"]
                      and "Cloud Services" not in i["product_name"]]
        assert best_vm_rates(linux_only, windows=True) == {}

    def test_keys_are_folded_so_azure_casing_cannot_lose_a_row(self):
        rates = best_vm_rates([item("STANDARD_D2AS_V5", 5.0, "m", "Virtual Machines")], False)
        assert "standard_d2as_v5" in rates

    def test_a_zero_or_missing_rate_is_not_a_price(self):
        rows = [
            item("Standard_X", 0, "m", "Virtual Machines"),
            item("Standard_Y", None, "m", "Virtual Machines"),
            item("Standard_Z", "free", "m", "Virtual Machines"),
        ]
        assert best_vm_rates(rows, windows=False) == {}

    def test_a_row_with_no_sku_name_is_skipped(self):
        assert best_vm_rates([item("", 5.0, "m", "Virtual Machines")], False) == {}


class TestTheFilterAzureRefusesWhenItIsTooLong:
    """
    Probed against the live public endpoint on 2026-08-26 for centralindia:

        15 names -> 200 OK   (filter length 628)
        20 names -> 400 "Invalid OData parameters supplied" (length 805)

    The size picker asked for 25 names at a time, so every batch was rejected
    and the page showed "Price not available" against all 753 sizes. The
    caller swallowed the error, exactly as it had for the two-name `in (...)`
    filter before it -- the same bug twice, because nothing pinned the shape of
    the request we actually send.
    """

    def test_the_documented_ceiling_is_below_the_one_azure_rejected(self):
        assert rp.MAX_SKUS_PER_FILTER <= 15

    def test_a_filter_at_the_ceiling_stays_within_the_length_azure_accepted(self):
        names = [f"Standard_D{i}ads_v5" for i in range(rp.MAX_SKUS_PER_FILTER)]
        assert len(rp.vm_sku_filter(names, "centralindia")) < 700

    def test_hundreds_of_sizes_are_asked_for_by_region_not_by_name(self):
        # The region filter is a fixed length whatever the estate looks like.
        f = rp.region_vm_filter("centralindia")
        assert "armSkuName" not in f
        assert "serviceName eq 'Virtual Machines'" in f
        assert "armRegionName eq 'centralindia'" in f
        assert "type eq 'Consumption'" in f

    def test_a_region_filter_needs_a_region(self):
        assert rp.region_vm_filter("") == ""

    def test_the_region_filter_escapes_quotes_like_every_other_one(self):
        assert "''" in rp.region_vm_filter("it's")

    def test_enough_pages_are_followed_to_cover_a_real_region(self):
        # centralindia alone returned 8 pages / ~7,100 meters.
        assert rp.REGION_MAX_PAGES >= 8
