"""
The classification rules behind the Anomalies page.

These exist because the previous detector was confidently wrong rather than
merely incomplete: it ranked by percentage, so its top row was reliably its
least important finding; it produced spikes out of rounding noise; and it
skipped growth from zero entirely, hiding the one change most likely to be a
deployment. Each of those is pinned below so it cannot come back.
"""
import pytest

from services.anomalies import (
    DIRECTION_DECREASE,
    DIRECTION_FLAT,
    DIRECTION_INCREASE,
    DIRECTION_NEW,
    DIRECTION_REMOVED,
    IMPACT_CRITICAL,
    IMPACT_HIGH,
    IMPACT_LOW,
    IMPACT_NONE,
    compare_periods,
    direction_of,
    impact_of,
    is_zero,
    pct_change,
    severity_of,
    split_changes,
    summarise,
)


def row(service, cost, sub="sub-a", **extra):
    return {"service": service, "subscription_id": sub, "cost": cost, **extra}


class TestPercentage:
    def test_an_ordinary_increase(self):
        assert pct_change(120, 100) == 20.0

    def test_growth_from_zero_has_no_percentage(self):
        # The alternatives all reached the screen at some point: `Infinity%`,
        # `NaN%`, and a literal 9999. "New" is the honest answer.
        assert pct_change(1250, 0) is None

    def test_growth_from_rounding_dust_has_no_percentage_either(self):
        # 0.001 is not zero to a computer and is zero to an invoice. Treating
        # it as a real baseline is what produced "+2,150%" on a fraction of a
        # rupee.
        assert pct_change(0.9, 0.001) is None

    def test_a_reduction_is_negative(self):
        assert pct_change(80, 100) == -20.0

    def test_a_negative_baseline_does_not_flip_the_sign(self):
        # Credits and refunds arrive as negative costs. Dividing by a negative
        # baseline without taking its magnitude reports a rise as a fall.
        assert pct_change(-50, -100) == 50.0


class TestZero:
    @pytest.mark.parametrize("value", [0, 0.0, 0.001, -0.004, None])
    def test_values_that_display_as_zero(self, value):
        assert is_zero(value)

    @pytest.mark.parametrize("value", [0.01, 1, -2.5])
    def test_values_that_do_not(self, value):
        assert not is_zero(value)


class TestDirection:
    def test_zero_to_zero_is_not_a_change(self):
        # The "Key Vault +200%, previous ₹0, current ₹0, increase ₹0" row.
        assert direction_of(0, 0) == DIRECTION_FLAT

    def test_zero_to_real_money_is_new(self):
        assert direction_of(1250, 0) == DIRECTION_NEW

    def test_real_money_to_zero_is_removed(self):
        assert direction_of(0, 8000) == DIRECTION_REMOVED

    def test_up_and_down(self):
        assert direction_of(120, 100) == DIRECTION_INCREASE
        assert direction_of(80, 100) == DIRECTION_DECREASE


class TestImpact:
    def test_a_tenth_of_the_bill_is_critical(self):
        assert impact_of(1000, 10000) == IMPACT_CRITICAL

    def test_a_rounding_error_has_no_impact(self):
        assert impact_of(0.001, 10000) == IMPACT_NONE

    def test_a_tiny_share_of_a_large_bill_is_low(self):
        assert impact_of(101, 1_000_000) == IMPACT_LOW

    def test_impact_is_symmetric_for_reductions(self):
        # A ₹1,000 drop matters as much as a ₹1,000 rise; only the story
        # differs.
        assert impact_of(-1000, 10000) == IMPACT_CRITICAL


class TestSeverity:
    def test_a_huge_percentage_on_a_trivial_amount_is_not_urgent(self):
        # ₹5 -> ₹106 is +2,020% and still ₹101. This is the single assertion
        # the old ranking most needed and did not have.
        assert severity_of(2020.0, IMPACT_LOW) == IMPACT_LOW

    def test_a_steep_rise_on_real_money_is_critical(self):
        assert severity_of(319.9, IMPACT_HIGH) == IMPACT_CRITICAL

    def test_a_modest_rise_on_a_large_amount_keeps_its_impact(self):
        assert severity_of(12.0, IMPACT_HIGH) == IMPACT_HIGH

    def test_noise_is_never_promoted(self):
        assert severity_of(5000.0, IMPACT_NONE) == IMPACT_NONE


class TestComparePeriods:
    def test_ranking_is_by_money_not_percentage(self):
        current = [row("Postgres", 23942), row("Functions", 106)]
        previous = [row("Postgres", 5701), row("Functions", 5)]

        result = compare_periods(current, previous)

        # Functions is up 2,020% and Postgres only 320%. Postgres added
        # ₹18,241 and Functions added ₹101, so Postgres comes first.
        assert result[0]["service"] == "Postgres"
        assert result[0]["delta"] == 18241.0
        assert result[1]["service"] == "Functions"

    def test_a_spike_is_attributed_to_the_subscription_it_happened_in(self):
        # The old code listed every subscription active that month against
        # every spike, which made the attribution meaningless.
        current = [row("Postgres", 20000, sub="kredily"), row("Postgres", 10, sub="tally")]
        previous = [row("Postgres", 100, sub="kredily"), row("Postgres", 10, sub="tally")]

        result = compare_periods(current, previous)
        biggest = result[0]

        assert biggest["subscription_id"] == "kredily"
        assert biggest["delta"] == 19900.0

    def test_a_new_cost_is_reported_rather_than_skipped(self):
        result = compare_periods([row("Functions", 1250)], [])

        assert len(result) == 1
        assert result[0]["direction"] == DIRECTION_NEW
        assert result[0]["pct_change"] is None
        assert result[0]["previous_cost"] == 0

    def test_a_removed_cost_is_reported(self):
        result = compare_periods([], [row("Virtual Machines", 8000)])

        assert result[0]["direction"] == DIRECTION_REMOVED
        assert result[0]["delta"] == -8000.0

    def test_zero_to_zero_carries_a_note_instead_of_a_severity(self):
        result = compare_periods([row("Key Vault", 0.0)], [row("Key Vault", 0.0)])

        assert result[0]["impact"] == IMPACT_NONE
        assert result[0]["note"] == "No material cost impact."

    def test_a_large_percentage_on_a_small_amount_says_so(self):
        current = [row("Functions", 106), row("Postgres", 20000)]
        previous = [row("Functions", 5), row("Postgres", 20000)]

        result = compare_periods(current, previous)
        functions = next(r for r in result if r["service"] == "Functions")

        assert functions["note"] == "Large percentage increase, but a small absolute impact."

    def test_a_small_percentage_on_a_large_amount_also_says_so(self):
        current = [row("Postgres", 22000)]
        previous = [row("Postgres", 20000)]

        result = compare_periods(current, previous)

        assert result[0]["note"] == "Small percentage change, but a large absolute impact."

    def test_costs_are_summed_across_resources_within_a_key(self):
        current = [row("Postgres", 100), row("Postgres", 150)]
        previous = [row("Postgres", 50)]

        result = compare_periods(current, previous)

        assert result[0]["current_cost"] == 250.0

    def test_empty_periods_produce_nothing_rather_than_an_error(self):
        assert compare_periods([], []) == []


class TestSplit:
    def _changes(self):
        current = [
            row("Postgres", 23942),
            row("Functions", 1250),
            row("Key Vault", 0.0),
            row("Storage", 900),
        ]
        previous = [
            row("Postgres", 5701),
            row("Functions", 0),
            row("Key Vault", 0.0),
            row("Storage", 3000),
            row("Virtual Machines", 8000),
        ]
        return compare_periods(current, previous)

    def test_each_kind_of_change_lands_in_its_own_bucket(self):
        b = split_changes(self._changes())

        assert [c["service"] for c in b["anomalies"]] == ["Postgres"]
        assert [c["service"] for c in b["new_costs"]] == ["Functions"]
        assert [c["service"] for c in b["removed_costs"]] == ["Virtual Machines"]
        assert [c["service"] for c in b["reductions"]] == ["Storage"]

    def test_noise_is_set_aside_rather_than_deleted(self):
        # Dropping it silently leaves the reader wondering why a service they
        # know about is missing from the page.
        b = split_changes(self._changes())

        assert [c["service"] for c in b["immaterial"]] == ["Key Vault"]

    def test_an_increase_below_the_threshold_is_not_an_anomaly(self):
        changes = compare_periods([row("Postgres", 10500)], [row("Postgres", 10000)])

        b = split_changes(changes)

        assert b["anomalies"] == []


class TestSummary:
    def test_savings_are_absent_rather_than_zero(self):
        b = split_changes(compare_periods([row("Storage", 900)], [row("Storage", 3000)]))

        s = summarise(b)

        # ₹0 reads as "we checked and found none". None reads as "this cannot
        # be established from billing data", which is the truth.
        assert s["verified_savings"] is None
        assert s["total_reduction"] == 2100.0

    def test_reductions_are_never_called_savings(self):
        b = split_changes(compare_periods([], [row("Virtual Machines", 8000)]))

        s = summarise(b)

        assert "savings" not in {k for k in s if k != "verified_savings"}
        assert s["total_reduction"] == 8000.0

    def test_the_largest_increase_is_the_largest_by_money(self):
        current = [row("Postgres", 23942), row("Functions", 106)]
        previous = [row("Postgres", 5701), row("Functions", 5)]

        s = summarise(split_changes(compare_periods(current, previous)))

        assert s["largest_increase"]["service"] == "Postgres"

    def test_an_empty_period_summarises_without_inventing_anything(self):
        s = summarise(split_changes([]))

        assert s["anomaly_count"] == 0
        assert s["largest_increase"] is None
        assert s["verified_savings"] is None
