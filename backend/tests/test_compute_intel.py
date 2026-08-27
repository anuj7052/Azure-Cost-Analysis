"""
Tests for metrics summarising and compute right-sizing.

The bias throughout: prove the module refuses to make a claim it cannot
support. Most of these tests assert an *absence* of a recommendation, because
that is the failure mode that costs a customer an outage.
"""
import pytest

from services import azure_metrics as m
from services import compute_intel as ci


# ───────────────────────────── statistics ─────────────────────────────

class TestSummarise:
    def test_nulls_are_not_zeros(self):
        """
        The central rule. Azure emits null for buckets with no data; counting
        those as zero turns a partially-reporting VM into an "idle" one.
        """
        summary = m.summarise([None, None, 50.0, None, 50.0])
        assert summary["avg"] == 50.0
        assert summary["points"] == 2

    def test_a_series_of_nothing_reports_nothing(self):
        summary = m.summarise([None, None, None])
        assert summary["avg"] is None
        assert summary["p95"] is None
        assert summary["points"] == 0
        assert summary["confident"] is False

    def test_empty_series_does_not_crash(self):
        assert m.summarise([])["points"] == 0

    def test_confidence_needs_enough_observations(self):
        assert m.summarise([1.0] * (m.MIN_POINTS_FOR_CONFIDENCE - 1))["confident"] is False
        assert m.summarise([1.0] * m.MIN_POINTS_FOR_CONFIDENCE)["confident"] is True

    def test_p95_alone_cannot_see_a_daily_peak(self):
        """
        The finding that shaped the classifier.

        A one-hour daily peak over a 30-day window is 30 of 720 hourly buckets
        — about 4%, which sits *below* the 95th percentile. So P95 reports the
        quiet baseline and the machine reads as oversized. P99 is above that 4%
        and still sees the peak, which is why the classifier vetoes on P99.
        """
        series = [2.0] * 95 + [90.0] * 5
        summary = m.summarise(series)
        assert summary["p95"] < 10, "P95 is blind to a 5% peak — this is the trap"
        assert summary["p99"] > 50, "P99 must still see it"
        assert summary["max"] == 90.0

    def test_percentile_of_one_point(self):
        assert m.percentile([7.0], 95) == 7.0

    def test_percentile_of_nothing_is_none(self):
        assert m.percentile([], 95) is None


class TestMetricSelection:
    def test_metric_names_are_chosen_by_resource_type(self):
        assert "Percentage CPU" in m.metrics_for("Microsoft.Compute/virtualMachines")
        assert m.metrics_for("Microsoft.Compute/virtualMachines") == m.metrics_for(
            "microsoft.compute/virtualmachines"
        )

    def test_an_unknown_type_asks_for_nothing(self):
        # Requesting a metric a provider does not publish fails the whole call,
        # so the safe answer for an unknown type is an empty list.
        assert m.metrics_for("Microsoft.Nonsense/widgets") == []

    def test_counters_are_summed_and_gauges_averaged(self):
        assert m.aggregation_for("Network In Total") == "Total"
        assert m.aggregation_for("Percentage CPU") == "Average"


class TestParseMetricResponse:
    def test_reads_azures_nested_envelope(self):
        payload = {
            "value": [{
                "name": {"value": "Percentage CPU"},
                "unit": "Percent",
                "timeseries": [{"data": [
                    {"timeStamp": "t1", "average": 10.0},
                    {"timeStamp": "t2", "average": 20.0},
                ]}],
            }]
        }
        parsed = m.parse_metric_response(payload)
        assert parsed["Percentage CPU"]["avg"] == 15.0
        assert parsed["Percentage CPU"]["unit"] == "Percent"

    def test_a_metric_with_no_data_is_present_but_empty(self):
        # Present-and-empty is a different fact from absent, and the UI needs
        # to be able to tell them apart.
        payload = {"value": [{"name": {"value": "Percentage CPU"},
                              "timeseries": [{"data": []}]}]}
        parsed = m.parse_metric_response(payload)
        assert parsed["Percentage CPU"]["points"] == 0

    def test_empty_payload_is_not_an_error(self):
        assert m.parse_metric_response({}) == {}


# ───────────────────────────── classification ─────────────────────────────

def cpu(p95, avg=None, points=200, p99=None):
    return {"Percentage CPU": {
        "p95": p95, "avg": avg if avg is not None else p95,
        "p99": p99 if p99 is not None else p95,
        "max": max(p95, p99 or 0),
        "points": points, "confident": points >= m.MIN_POINTS_FOR_CONFIDENCE,
    }}


class TestClassify:
    def test_no_telemetry_is_never_called_idle(self):
        """
        The most important test in this file. A VM with no metrics looks
        identical to an idle one, and conflating them means telling somebody
        to delete a busy machine they simply cannot see.
        """
        result = ci.classify({}, power_state="running")
        assert result["verdict"] == ci.INSUFFICIENT_DATA
        assert result["verdict"] != ci.IDLE
        assert "not evidence" in result["reason"]

    def test_thin_telemetry_is_also_refused(self):
        result = ci.classify(cpu(1.0, points=3), power_state="running")
        assert result["verdict"] == ci.INSUFFICIENT_DATA

    def test_stopped_but_not_deallocated_is_flagged_without_metrics(self):
        result = ci.classify({}, power_state="PowerState/stopped")
        assert result["verdict"] == ci.STOPPED_BILLED
        assert result["confident"] is True
        assert "deallocated" in result["reason"]

    def test_deallocated_is_its_own_verdict_not_missing_data(self):
        """
        A deallocated VM used to report "not enough data", which is true about
        the telemetry and useless to the reader: nothing is missing and there is
        nothing to investigate. The machine is simply off.
        """
        result = ci.classify({}, power_state="PowerState/deallocated")
        assert result["verdict"] == ci.DEALLOCATED
        assert result["confident"] is True
        assert result["telemetry"] == ci.TELEMETRY_NOT_APPLICABLE
        assert "not billed for compute" in result["reason"]

    def test_a_deallocated_vm_is_never_called_idle(self):
        result = ci.classify({}, power_state="PowerState/deallocated")
        assert result["verdict"] != ci.IDLE

    def test_a_quiet_vm_is_idle(self):
        metrics = cpu(1.0)
        metrics["Network In Total"] = {"p95": 100.0, "points": 200, "confident": True}
        metrics["Network Out Total"] = {"p95": 100.0, "points": 200, "confident": True}
        assert ci.classify(metrics, power_state="running")["verdict"] == ci.IDLE

    def test_low_cpu_with_busy_network_is_not_idle(self):
        """A file server or gateway is CPU-light and genuinely in use."""
        metrics = cpu(1.0)
        metrics["Network In Total"] = {"p95": 500_000_000, "points": 200, "confident": True}
        metrics["Network Out Total"] = {"p95": 500_000_000, "points": 200, "confident": True}
        assert ci.classify(metrics, power_state="running")["verdict"] != ci.IDLE

    def test_a_spiky_vm_is_not_downsized(self):
        # Mean 6%, P95 90%. Judging on the mean would break this machine.
        assert ci.classify(cpu(90.0, avg=6.0), power_state="running")["verdict"] == ci.OVERUTILIZED

    def test_a_genuinely_oversized_vm_is_caught(self):
        assert ci.classify(cpu(12.0), power_state="running")["verdict"] == ci.UNDERUTILIZED

    def test_a_daily_peak_under_a_quiet_baseline_is_not_downsized(self):
        """
        The regression test for the P95 blind spot. Low P95, high P99 is a
        scheduled job or a daily busy hour. Halving this machine would break
        exactly the hour it exists for.
        """
        result = ci.classify(cpu(8.0, p99=92.0), power_state="running")
        assert result["verdict"] == ci.RIGHT_SIZED
        assert "99th percentile" in result["reason"]

    def test_a_nightly_batch_job_is_not_called_idle(self):
        metrics = cpu(1.0, p99=88.0)
        metrics["Network In Total"] = {"p95": 100.0, "points": 200, "confident": True}
        metrics["Network Out Total"] = {"p95": 100.0, "points": 200, "confident": True}
        result = ci.classify(metrics, power_state="running")
        assert result["verdict"] != ci.IDLE
        assert "recurring peak" in result["reason"]

    def test_a_flat_quiet_vm_is_still_downsized(self):
        """The veto must not swallow genuine findings."""
        assert ci.classify(cpu(12.0, p99=15.0), power_state="running")["verdict"] == ci.UNDERUTILIZED

    def test_a_busy_vm_is_left_alone(self):
        assert ci.classify(cpu(65.0), power_state="running")["verdict"] == ci.RIGHT_SIZED

    def test_memory_pressure_vetoes_a_cpu_downsize(self):
        """
        A machine bought for RAM always looks CPU-idle. Shrinking it on CPU
        evidence alone would starve it.
        """
        metrics = cpu(10.0)
        ram = 64 * 1024 ** 3
        metrics["Available Memory Bytes"] = {
            "min": 2 * 1024 ** 3, "points": 200, "confident": True,
        }
        result = ci.classify(metrics, power_state="running", ram_bytes=ram)
        assert result["verdict"] == ci.RIGHT_SIZED
        assert "memory" in result["reason"]

    def test_memory_headroom_uses_the_worst_moment_not_the_best(self):
        ram = 16 * 1024 ** 3
        metrics = {"Available Memory Bytes": {"min": 4 * 1024 ** 3, "max": 15 * 1024 ** 3}}
        assert ci.memory_headroom(metrics, ram) == pytest.approx(0.25)

    def test_memory_headroom_is_unknown_without_ram_size(self):
        assert ci.memory_headroom({"Available Memory Bytes": {"min": 1}}, None) is None


# ───────────────────────────── SKU arithmetic ─────────────────────────────

class TestSkuMath:
    @pytest.mark.parametrize("sku,family,vcpu,version", [
        ("Standard_D8s_v5", "D", 8, "v5"),
        ("Standard_E16as_v5", "E", 16, "v5"),
        ("Standard_F4", "F", 4, ""),
    ])
    def test_parses_standard_sizes(self, sku, family, vcpu, version):
        parsed = ci.parse_sku(sku)
        assert parsed["family"] == family
        assert parsed["vcpu"] == vcpu
        assert parsed["version"] == version

    @pytest.mark.parametrize("sku", ["", "D8s_v5", "NotASize", "Basic_A0"])
    def test_refuses_to_parse_what_it_does_not_understand(self, sku):
        assert ci.parse_sku(sku) is None

    def test_constrained_core_sizes_are_left_alone(self):
        """
        `Standard_E8-4s_v5` bills 8 cores and licenses 4. Halving it is a
        licensing decision, not a sizing one, so no recommendation is made.
        """
        assert ci.parse_sku("Standard_E8-4s_v5") is None
        assert ci.smaller_sku("Standard_E8-4s_v5") is None

    def test_halves_within_the_family(self):
        assert ci.smaller_sku("Standard_D8s_v5") == "Standard_D4s_v5"
        assert ci.smaller_sku("Standard_E16as_v5") == "Standard_E8as_v5"

    def test_will_not_go_below_two_vcpu(self):
        # Below 2 the family naming stops being regular.
        assert ci.smaller_sku("Standard_D2s_v3") is None

    def test_never_changes_family(self):
        # Moving D -> E changes the memory-per-core ratio, which is a workload
        # decision this module has no basis to make.
        assert ci.smaller_sku("Standard_D16s_v5").startswith("Standard_D")


class TestSavings:
    PRICES = {"Standard_D8s_v5": 0.40, "Standard_D4s_v5": 0.20}

    def test_savings_come_from_two_real_prices(self):
        # D8s is published at 0.40 and D4s at 0.20 — half. Applied to the VM's
        # real 300/month bill, not to 730 hours of list price.
        out = ci.estimate_savings(300.0, "Standard_D8s_v5", "Standard_D4s_v5", self.PRICES)
        assert out["monthly"] == pytest.approx(150.0)
        assert out["annual"] == pytest.approx(1800.0)
        assert out["basis"] == "actual_cost_and_retail_ratio"

    def test_a_saving_can_never_exceed_the_bill_it_comes_off(self):
        """
        Observed live: a VM billed at ₹2,650 a month was reported as saving
        ₹20,598 a month, because the difference between two list prices was
        taken over a full 730 hours while the bill was for a machine that ran
        for part of the month at a discounted rate.

        A saving larger than the entire cost of the thing being changed does
        not read as an error, it reads as a tool that cannot count.
        """
        out = ci.estimate_savings(
            2650.76, "Standard_D8as_v5", "Standard_D4as_v5",
            {"Standard_D8as_v5": 21.234, "Standard_D4as_v5": 10.617},
        )
        assert out["monthly"] <= 2650.76
        assert out["monthly"] == pytest.approx(2650.76 * 0.5, rel=1e-3)

    def test_the_sku_casing_azure_used_does_not_lose_the_price(self):
        """
        Resource Graph, Cost Management and the pricing catalogue disagree
        about how to capitalise a size name. An exact-match lookup silently
        dropped the row, which the UI then reported as "no published price".
        """
        out = ci.estimate_savings(
            300.0, "STANDARD_D8S_V5", "standard_d4s_v5",
            {"Standard_D8s_v5": 0.40, "Standard_D4s_v5": 0.20},
        )
        assert out["monthly"] == pytest.approx(150.0)

    def test_without_a_billed_cost_it_falls_back_to_list_price_and_says_so(self):
        out = ci.estimate_savings(None, "Standard_D8s_v5", "Standard_D4s_v5", self.PRICES)
        assert out["monthly"] == pytest.approx(0.20 * 730)
        assert out["basis"] == "retail_prices"
        assert "list-price" in out["note"]

    def test_no_price_means_no_number_rather_than_a_guess(self):
        """
        Halving the cost because the vCPU halved is wrong — Azure SKU pricing
        is not linear in vCPU count. Better to show nothing.
        """
        out = ci.estimate_savings(300.0, "Standard_D8s_v5", "Standard_D4s_v5", {})
        assert out["monthly"] is None
        assert out["basis"] == "price_unavailable"
        assert "guess" in out["note"]

    def test_no_target_size_means_no_saving(self):
        assert ci.estimate_savings(300.0, "Standard_D2s_v3", None, self.PRICES)["monthly"] is None

    def test_savings_are_never_negative(self):
        out = ci.estimate_savings(
            300.0, "Standard_D4s_v5", "Standard_D8s_v5",
            {"Standard_D4s_v5": 0.20, "Standard_D8s_v5": 0.40},
        )
        assert out["monthly"] == 0.0


# ───────────────────────────── whole-VM analysis ─────────────────────────────

class TestAnalyseVm:
    PRICES = {"Standard_D8s_v5": 0.40, "Standard_D4s_v5": 0.20}

    def vm(self, **kw):
        base = {
            "id": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1",
            "name": "vm1", "sku": "Standard_D8s_v5", "region": "centralindia",
            "power_state": "running", "monthly_cost": 300.0,
        }
        base.update(kw)
        return base

    def test_an_oversized_vm_gets_a_named_target_and_a_priced_saving(self):
        out = ci.analyse_vm(self.vm(), cpu(10.0), self.PRICES)
        assert out["verdict"] == ci.UNDERUTILIZED
        assert out["recommended_sku"] == "Standard_D4s_v5"
        assert out["action"] == "resize"
        assert out["savings"]["monthly"] == pytest.approx(150.0)

    def test_a_stopped_vm_is_told_to_deallocate(self):
        out = ci.analyse_vm(self.vm(power_state="PowerState/stopped"), {})
        assert out["action"] == "deallocate"
        assert out["savings"]["monthly"] == 300.0

    def test_a_vm_with_no_data_gets_no_action(self):
        out = ci.analyse_vm(self.vm(), {})
        assert out["action"] == "none"
        assert out["recommended_sku"] is None
        assert out["savings"]["monthly"] is None

    def test_an_unrecognised_sku_yields_advice_without_a_fake_target(self):
        out = ci.analyse_vm(self.vm(sku="Standard_E8-4s_v5"), cpu(10.0), self.PRICES)
        assert out["verdict"] == ci.UNDERUTILIZED
        assert out["recommended_sku"] is None
        assert out["action"] == "review"

    def test_an_overloaded_vm_is_investigated_not_resized(self):
        out = ci.analyse_vm(self.vm(), cpu(95.0), self.PRICES)
        assert out["action"] == "investigate"
        assert out["savings"]["monthly"] is None

    def test_the_evidence_count_is_carried_through(self):
        out = ci.analyse_vm(self.vm(), cpu(10.0, points=137), self.PRICES)
        assert out["metric_points"] == 137


class TestFleetSummary:
    def test_unpriced_recommendations_do_not_inflate_the_total(self):
        analyses = [
            {"verdict": ci.UNDERUTILIZED, "confident": True, "action": "resize",
             "savings": {"monthly": 100.0}},
            {"verdict": ci.UNDERUTILIZED, "confident": True, "action": "resize",
             "savings": {"monthly": None}},
        ]
        out = ci.summarise_fleet(analyses)
        assert out["monthly_savings"] == 100.0
        assert out["priced_recommendations"] == 1
        assert out["unpriced_recommendations"] == 1

    def test_low_confidence_savings_are_reported_separately(self):
        """The confident figure is the one safe to show a finance team."""
        analyses = [
            {"verdict": ci.IDLE, "confident": True, "action": "review_for_deletion",
             "right_sizing": {"status": ci.RS_IDLE, "confidence": ci.CONF_HIGH},
             "savings": {"monthly": 100.0}},
            {"verdict": ci.IDLE, "confident": False, "action": "review_for_deletion",
             "right_sizing": {"status": ci.RS_IDLE, "confidence": ci.CONF_LOW},
             "savings": {"monthly": 900.0}},
        ]
        out = ci.summarise_fleet(analyses)
        assert out["monthly_savings"] == 1000.0
        assert out["confident_monthly_savings"] == 100.0

    def test_an_empty_fleet_reports_no_opportunity_rather_than_zero(self):
        """
        "₹0 of savings" claims the fleet was examined and found perfect. None
        says no opportunity was identified, which is the honest answer for an
        estate that is mostly deallocated or unmeasurable.
        """
        out = ci.summarise_fleet([])
        assert out["total"] == 0
        assert out["monthly_savings"] is None
        assert out["annual_savings"] is None
        assert out["no_opportunity_note"]

    def test_sorting_leads_with_money_at_stake(self):
        items = [
            {"verdict": ci.RIGHT_SIZED, "name": "c", "savings": {}},
            {"verdict": ci.STOPPED_BILLED, "name": "a", "savings": {"monthly": 10.0}},
            {"verdict": ci.IDLE, "name": "b", "savings": {"monthly": 500.0}},
        ]
        ordered = sorted(items, key=ci.sort_key)
        assert [i["name"] for i in ordered] == ["a", "b", "c"]
