"""
Building a BOQ from a live subscription.

This produces a document people quote from, so the damaging failure is a total
that looks complete while quietly excluding resources — or a unit rate averaged
over things that were never priced.
"""
from services.boq_builder import build_boq, to_csv_rows


def resource(name="vm-1", *, service="Virtual Machines", sku="D2s v3",
             location="eastus", cost=100.0, rg="rg-prod",
             type_id="Microsoft.Compute/virtualMachines"):
    return {
        "name": name,
        "type": type_id,
        "resource_group": rg,
        "location": location,
        "sku": sku,
        "size": "",
        "tier": "",
        "service": service,
        "cost": cost,
    }


class TestGrouping:
    def test_identical_resources_become_one_line_with_a_quantity(self):
        """A quotation lists ten identical VMs once, not ten times."""
        boq = build_boq([resource("vm-1"), resource("vm-2"), resource("vm-3")])

        assert boq["line_count"] == 1
        assert boq["items"][0]["quantity"] == 3
        assert boq["items"][0]["monthly_cost"] == 300.0

    def test_the_same_spec_in_another_region_is_a_separate_line(self):
        # Region determines the rate, so merging them would invent an average
        # price that matches neither.
        boq = build_boq([
            resource("vm-1", location="eastus"),
            resource("vm-2", location="westeurope"),
        ])

        assert boq["line_count"] == 2

    def test_different_sizes_stay_apart(self):
        boq = build_boq([resource("vm-1", sku="D2s v3"), resource("vm-2", sku="D4s v3")])
        assert boq["line_count"] == 2

    def test_the_most_expensive_line_comes_first(self):
        """A quotation is read top-down; the money should be at the top."""
        boq = build_boq([
            resource("cheap", service="Storage", sku="LRS", cost=5.0),
            resource("pricey", service="Virtual Machines", sku="D8s v3", cost=900.0),
        ])

        assert boq["items"][0]["service"] == "Virtual Machines"


class TestPricing:
    def test_the_unit_rate_ignores_unpriced_resources(self):
        """
        Dividing by the full quantity would understate the rate whenever some
        of the group had no cost reported, making the quote look cheaper than
        the invoice.
        """
        boq = build_boq([
            resource("vm-1", cost=100.0),
            resource("vm-2", cost=100.0),
            resource("vm-3", cost=None),
        ])
        item = boq["items"][0]

        assert item["quantity"] == 3
        assert item["priced_quantity"] == 2
        assert item["unit_monthly_cost"] == 100.0

    def test_an_entirely_unpriced_line_has_no_unit_rate(self):
        # Zero would read as free; None says the price is unknown.
        boq = build_boq([resource("vm-1", cost=None)])
        assert boq["items"][0]["unit_monthly_cost"] is None

    def test_unpriced_resources_are_counted_so_the_total_can_be_qualified(self):
        boq = build_boq([resource("vm-1", cost=100.0), resource("vm-2", cost=None)])
        assert boq["unpriced_count"] == 1

    def test_the_yearly_figure_is_twelve_months_of_current_spend(self):
        boq = build_boq([resource("vm-1", cost=100.0)])
        assert boq["total_yearly"] == 1200.0


class TestServiceNaming:
    def test_the_billed_service_name_is_preferred(self):
        boq = build_boq([resource(service="Virtual Machines")])
        assert boq["items"][0]["service"] == "Virtual Machines"

    def test_the_resource_type_is_the_fallback(self):
        """
        A resource with no billed cost still belongs in the BOQ, so it needs a
        readable name rather than being dropped or labelled "Unknown".
        """
        boq = build_boq([resource(service="", type_id="Microsoft.Compute/virtualMachines")])
        assert boq["items"][0]["service"] == "Virtual Machines"

    def test_a_resource_with_no_spec_is_labelled_standard(self):
        item = build_boq([{**resource(), "sku": "", "size": "", "tier": ""}])["items"][0]
        assert item["spec"] == "Standard"


class TestExclusions:
    def test_resource_groups_are_not_quoted_as_line_items(self):
        """
        They carry no charge of their own; including them pads the document
        without adding information.
        """
        boq = build_boq([
            resource("vm-1"),
            {**resource("rg"), "type": "Microsoft.Resources/subscriptions/resourceGroups"},
        ])

        assert boq["resource_count"] == 1


class TestExport:
    def test_the_header_names_the_currency(self):
        # A column of bare numbers is unusable in a quotation.
        rows = to_csv_rows(build_boq([resource()], currency="INR"))
        assert any("INR" in cell for cell in rows[0])

    def test_a_total_row_closes_the_document(self):
        rows = to_csv_rows(build_boq([resource(cost=100.0)]))
        assert rows[-1][0] == "TOTAL"
        assert rows[-1][5] == "100.00"

    def test_an_unknown_unit_rate_exports_as_blank_not_zero(self):
        # "0.00" in a quotation reads as free and would be quoted as such.
        rows = to_csv_rows(build_boq([resource(cost=None)]))
        assert rows[1][4] == ""
