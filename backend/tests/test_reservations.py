"""
Reserved Instance detection and Pay-as-you-go transitions.

The claim under test is narrow and deliberately modest: we can say what is
covering a line, and we can say when that changed. We cannot say a reservation
saved money *this month*, because under ActualCost the reservation was paid for
in a different month — so these tests also pin down what must never be claimed.
"""
import pytest

from services import reservations as ri


def rec(**kw):
    base = {
        "ServiceName": "Virtual Machines",
        "Meter": "D4as v5",
        "UsageQuantity": 744,
        "PreTaxCost": 100.0,
        "UsageDate": "2026-06-01",
        "UnitOfMeasure": "1 Hour",
    }
    base.update(kw)
    return base


class TestClassify:
    def test_azures_own_dimension_is_trusted_first(self):
        assert ri.classify(rec(PricingModel="Reservation")) == "reservation"
        assert ri.classify(rec(PricingModel="OnDemand")) == "on-demand"
        assert ri.classify(rec(PricingModel="SavingsPlan")) == "savings-plan"
        assert ri.classify(rec(PricingModel="Spot")) == "spot"

    def test_spelling_and_case_do_not_matter(self):
        assert ri.classify(rec(PricingModel="reservation")) == "reservation"
        assert ri.classify(rec(PricingModel="Savings Plan")) == "savings-plan"
        assert ri.classify(rec(PricingModel="ON DEMAND")) == "on-demand"

    def test_an_unrecognised_model_is_unknown_not_on_demand(self):
        """Guessing 'on-demand' would silently misreport a real commitment."""
        assert ri.classify(rec(PricingModel="SomethingNew")) == "unknown"

    def test_a_benefit_id_marks_a_reservation(self):
        assert ri.classify(rec(BenefitId="/providers/.../res-1")) == "reservation"

    def test_usage_with_no_cost_is_covered_by_something_else(self):
        """The always-available fallback when PricingModel is not offered."""
        assert ri.classify(rec(PreTaxCost=0.0, UsageQuantity=744)) == "unknown"

    def test_the_fallback_refuses_to_choose_between_ri_and_savings_plan(self):
        """
        Zero-cost usage cannot distinguish the two. Reporting 'reservation'
        would be a coin flip dressed up as a fact.
        """
        assert ri.classify(rec(PreTaxCost=0.0)) != "reservation"
        assert ri.classify(rec(PreTaxCost=0.0)) != "savings-plan"

    def test_ordinary_billed_usage_is_on_demand(self):
        assert ri.classify(rec(PreTaxCost=100.0, UsageQuantity=744)) == "on-demand"

    def test_zero_usage_and_zero_cost_is_not_a_reservation(self):
        assert ri.classify(rec(PreTaxCost=0.0, UsageQuantity=0)) == "on-demand"


class TestLabelling:
    def test_reserved_names_get_the_ri_suffix(self):
        assert ri.decorate("web-vm01", "reservation") == "web-vm01 (RI)"

    def test_savings_plan_and_spot_are_distinguished(self):
        assert ri.decorate("web-vm01", "savings-plan") == "web-vm01 (SP)"
        assert ri.decorate("web-vm01", "spot") == "web-vm01 (Spot)"

    def test_pay_as_you_go_names_are_left_alone(self):
        """A suffix on every row would make the tag meaningless."""
        assert ri.decorate("web-vm01", "on-demand") == "web-vm01"
        assert ri.decorate("web-vm01", "unknown") == "web-vm01"

    def test_labels_read_as_english(self):
        assert ri.label("on-demand") == "Pay-as-you-go"
        assert ri.label("reservation") == "Reserved Instance"

    def test_only_prepaid_models_count_as_committed(self):
        assert ri.is_committed("reservation")
        assert ri.is_committed("savings-plan")
        assert not ri.is_committed("spot")
        assert not ri.is_committed("on-demand")


class TestSummarise:
    def test_coverage_share_is_reported(self):
        summary = ri.summarise([
            rec(PricingModel="Reservation", UsageQuantity=750, PreTaxCost=0),
            rec(PricingModel="OnDemand", UsageQuantity=250, PreTaxCost=50),
        ])
        assert summary["coverage"]["committed_share"] == 0.75

    def test_a_meter_records_every_model_it_used(self):
        summary = ri.summarise([
            rec(PricingModel="Reservation", UsageQuantity=500, PreTaxCost=0),
            rec(PricingModel="OnDemand", UsageQuantity=244, PreTaxCost=40),
        ])
        assert summary["meters"][0]["models"] == ["on-demand", "reservation"]
        assert summary["meters"][0]["is_committed"] is True

    def test_months_are_ordered_and_unknown_is_dropped(self):
        summary = ri.summarise([
            rec(UsageDate="2026-07-01"),
            rec(UsageDate="2026-05-01"),
        ])
        assert summary["months"] == ["2026-05", "2026-07"]

    def test_an_empty_account_does_not_divide_by_zero(self):
        summary = ri.summarise([])
        assert summary["coverage"]["committed_share"] == 0.0
        assert summary["meters"] == []


class TestTransitions:
    def _moved_to_ri(self):
        return ri.summarise([
            rec(UsageDate="2026-06-01", PricingModel="OnDemand",
                UsageQuantity=744, PreTaxCost=744.0),
            rec(UsageDate="2026-07-01", PricingModel="Reservation",
                UsageQuantity=744, PreTaxCost=0.0),
        ])

    def test_a_move_onto_a_reservation_is_detected(self):
        moves = ri.transitions(self._moved_to_ri())
        assert len(moves) == 1
        assert moves[0]["direction"] == "to-committed"
        assert moves[0]["from_model"] == "on-demand"
        assert moves[0]["to_model"] == "reservation"

    def test_the_move_is_described_in_plain_english(self):
        move = ri.transitions(self._moved_to_ri())[0]
        assert "Pay-as-you-go" in move["headline"]
        assert "Reserved Instance" in move["headline"]

    def test_a_move_off_a_reservation_is_detected(self):
        summary = ri.summarise([
            rec(UsageDate="2026-06-01", PricingModel="Reservation",
                UsageQuantity=744, PreTaxCost=0.0),
            rec(UsageDate="2026-07-01", PricingModel="OnDemand",
                UsageQuantity=744, PreTaxCost=744.0),
        ])
        move = ri.transitions(summary)[0]
        assert move["direction"] == "to-on-demand"
        assert "no longer covered" in move["detail"]

    def test_avoided_cost_is_never_called_a_saving(self):
        """
        The reservation was bought in another month. Calling the difference a
        saving would count the purchase twice.
        """
        move = ri.transitions(self._moved_to_ri())[0]
        assert move["avoided_on_demand_cost"] is not None
        assert "saving" not in move["detail"].lower() or "not money saved" in move["detail"]
        assert "not money saved this month" in move["detail"]

    def test_avoided_cost_uses_the_previous_on_demand_rate(self):
        move = ri.transitions(self._moved_to_ri())[0]
        assert move["on_demand_rate"] == 1.0        # 744.0 / 744 hours
        assert move["avoided_on_demand_cost"] == 744.0

    def test_the_cost_drop_is_reported_alongside(self):
        move = ri.transitions(self._moved_to_ri())[0]
        assert move["cost_before"] == 744.0
        assert move["cost_after"] == 0.0
        assert move["cost_change"] == -744.0

    def test_small_drift_is_not_reported_as_a_transition(self):
        """
        Reservations never cover usage exactly. A couple of percent of movement
        every month would make the report cry wolf.
        """
        summary = ri.summarise([
            rec(UsageDate="2026-06-01", PricingModel="Reservation",
                UsageQuantity=730, PreTaxCost=0.0),
            rec(UsageDate="2026-06-01", PricingModel="OnDemand",
                UsageQuantity=14, PreTaxCost=14.0),
            rec(UsageDate="2026-07-01", PricingModel="Reservation",
                UsageQuantity=744, PreTaxCost=0.0),
        ])
        assert ri.transitions(summary) == []

    def test_steady_pay_as_you_go_reports_nothing(self):
        summary = ri.summarise([
            rec(UsageDate="2026-06-01", PricingModel="OnDemand"),
            rec(UsageDate="2026-07-01", PricingModel="OnDemand"),
        ])
        assert ri.transitions(summary) == []

    def test_a_single_month_cannot_produce_a_transition(self):
        summary = ri.summarise([rec(UsageDate="2026-07-01", PricingModel="Reservation")])
        assert ri.transitions(summary) == []

    def test_biggest_money_movement_is_listed_first(self):
        summary = ri.summarise([
            rec(Meter="small", UsageDate="2026-06-01", PricingModel="OnDemand",
                UsageQuantity=10, PreTaxCost=10.0),
            rec(Meter="small", UsageDate="2026-07-01", PricingModel="Reservation",
                UsageQuantity=10, PreTaxCost=0.0),
            rec(Meter="large", UsageDate="2026-06-01", PricingModel="OnDemand",
                UsageQuantity=1000, PreTaxCost=5000.0),
            rec(Meter="large", UsageDate="2026-07-01", PricingModel="Reservation",
                UsageQuantity=1000, PreTaxCost=0.0),
        ])
        moves = ri.transitions(summary)
        assert [m["meter"] for m in moves] == ["large", "small"]
