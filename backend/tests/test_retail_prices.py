"""
Microsoft's published prices.

These figures are shown next to a customer's real bill, so the failure that
matters is presenting a list price as though it were what they pay — or
inventing a discount percentage against a baseline that was never known.
"""
import pytest

from services.retail_prices import (
    build_filter,
    cheapest,
    compare_to_list,
    normalise,
)


def price_item(**overrides):
    base = {
        "currencyCode": "USD",
        "retailPrice": 0.096,
        "unitPrice": 0.096,
        "armRegionName": "eastus",
        "location": "US East",
        "meterName": "D2s v3",
        "productName": "Virtual Machines Dv3 Series",
        "skuName": "D2s v3",
        "serviceName": "Virtual Machines",
        "serviceFamily": "Compute",
        "unitOfMeasure": "1 Hour",
        "type": "Consumption",
        "armSkuName": "Standard_D2s_v3",
    }
    base.update(overrides)
    return base


class TestFilter:
    def test_it_builds_the_odata_microsoft_documents(self):
        f = build_filter(service_name="Virtual Machines", arm_region="eastus")

        assert "serviceName eq 'Virtual Machines'" in f
        assert "armRegionName eq 'eastus'" in f
        assert " and " in f

    def test_case_is_preserved_because_microsoft_matches_exactly(self):
        # From API version 2023-01-01 the filter is case sensitive, so
        # normalising the value here would silently return nothing.
        assert "'Virtual Machines'" in build_filter(service_name="Virtual Machines")

    def test_consumption_is_the_default_price_type(self):
        # Pay-as-you-go is the rate a bill is compared against; reservation
        # pricing answers a different question.
        assert "priceType eq 'Consumption'" in build_filter(service_name="X")

    def test_a_quote_in_a_value_cannot_break_the_query(self):
        assert "''" in build_filter(service_name="it's")

    def test_omitted_fields_produce_no_clause(self):
        assert "armRegionName" not in build_filter(service_name="X")


class TestNormalise:
    def test_the_fields_needed_for_comparison_survive(self):
        row = normalise(price_item())

        assert row["arm_sku_name"] == "Standard_D2s_v3"
        assert row["retail_price"] == 0.096
        assert row["unit_of_measure"] == "1 Hour"

    def test_savings_plan_rates_are_kept_when_present(self):
        row = normalise(price_item(savingsPlan=[
            {"term": "1 Year", "unitPrice": 0.07},
            {"term": "3 Years", "unitPrice": 0.05},
        ]))

        assert [p["term"] for p in row["savings_plans"]] == ["1 Year", "3 Years"]

    def test_a_meter_without_savings_plans_yields_an_empty_list(self):
        assert normalise(price_item())["savings_plans"] == []


class TestCheapest:
    def test_it_picks_the_lowest_published_rate(self):
        """
        Azure lists several meters for one size — Windows and Linux, spot and
        standard — so a result set is rarely a single number.
        """
        lowest = cheapest([
            normalise(price_item(retailPrice=0.19, productName="… Windows")),
            normalise(price_item(retailPrice=0.096, productName="… Linux")),
        ])

        assert lowest["retail_price"] == 0.096
        # The meter name travels with it, so nobody compares a Linux rate
        # against a Windows bill.
        assert "Linux" in lowest["product_name"]

    def test_unpriced_meters_are_ignored_rather_than_treated_as_free(self):
        lowest = cheapest([
            normalise(price_item(retailPrice=None)),
            normalise(price_item(retailPrice=0.5)),
        ])
        assert lowest["retail_price"] == 0.5

    def test_an_empty_result_has_no_cheapest(self):
        assert cheapest([]) is None


class TestComparison:
    def test_paying_under_list_is_reported_as_a_discount(self):
        result = compare_to_list(actual_rate=0.08, list_rate=0.10)

        assert result["verdict"] == "below_list"
        assert result["percent"] == -20.0

    def test_paying_over_list_is_reported_as_such(self):
        assert compare_to_list(0.12, 0.10)["verdict"] == "above_list"

    def test_a_negligible_difference_is_called_list_price(self):
        # Floating-point noise should not be presented as a 0.3% discount.
        assert compare_to_list(0.1001, 0.10)["verdict"] == "at_list"

    def test_an_unknown_list_price_yields_no_percentage(self):
        """
        A percentage against an unknown baseline has no meaning, and would be
        read as a discount that may not exist.
        """
        result = compare_to_list(0.08, None)

        assert result["percent"] is None
        assert result["verdict"] == "unknown"

    def test_an_unknown_actual_rate_yields_no_percentage(self):
        assert compare_to_list(None, 0.10)["verdict"] == "unknown"

    def test_a_zero_list_price_does_not_divide_by_zero(self):
        assert compare_to_list(0.08, 0.0)["verdict"] == "unknown"


@pytest.mark.asyncio
async def test_an_unfiltered_query_is_refused():
    """
    Microsoft's price list runs to hundreds of thousands of meters. Fetching it
    all would appear to hang, so refusing is friendlier than trying.
    """
    from services.retail_prices import fetch_prices

    with pytest.raises(ValueError):
        await fetch_prices("")
