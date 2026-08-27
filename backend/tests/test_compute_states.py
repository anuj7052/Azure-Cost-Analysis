"""
The states Compute Intelligence must tell apart.

Every test here pins a case that previously collapsed into "Not enough data",
"NaN" or a blank cell. They are grouped by the thing that goes wrong in the
real world, because that is how the bug reports arrive: "the cost column says
NaN", "everything says not enough data".
"""
import pytest

from routers.compute import _norm_id
from services import azure_metrics as m
from services import compute_intel as ci
from services.analysis import resource_cost_index


def cpu_metrics(**stats):
    """A Percentage CPU block shaped the way azure_metrics returns one."""
    base = {
        "avg": None, "max": None, "min": None,
        "p50": None, "p95": None, "p99": None,
        "points": 0, "expected": 720, "coverage": 0.0,
        "first": None, "last": None, "confident": False, "unit": "Percent",
    }
    base.update(stats)
    return {"Percentage CPU": base}


def vm(**over):
    base = {
        "id": "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1",
        "name": "vm1", "sku": "Standard_D8as_v5", "region": "centralindia",
        "resource_group": "rg", "subscription_id": "s1",
        "power_state": "PowerState/running", "os_type": "Linux",
        "monthly_cost": None,
    }
    base.update(over)
    return base


# ── the NaN bug ────────────────────────────────────────────────────────────


class TestCostIsAlwaysANumberOrNone:
    """
    `resource_cost_index` returns `{cost, service, meters}` per resource. The
    router used to assign that whole dict to `monthly_cost`, so the frontend
    formatted an object and rendered "₹NaN", and annualising it raised
    TypeError. Cost must arrive as a number or None, never a dict.
    """

    def test_a_cost_index_entry_is_unwrapped_to_its_number(self):
        out = ci.analyse_vm(vm(monthly_cost={"cost": 18240.0, "service": "VM", "meters": []}), {})
        assert out["monthly_cost"] == 18240.0
        assert out["annual_cost"] == pytest.approx(18240.0 * 12)

    def test_a_plain_number_still_works(self):
        out = ci.analyse_vm(vm(monthly_cost=1000.0), {})
        assert out["monthly_cost"] == 1000.0
        assert out["annual_cost"] == pytest.approx(12000.0)

    def test_missing_cost_is_none_not_zero(self):
        out = ci.analyse_vm(vm(monthly_cost=None), {})
        assert out["monthly_cost"] is None
        assert out["annual_cost"] is None

    def test_an_unusable_cost_value_becomes_none_rather_than_nan(self):
        out = ci.analyse_vm(vm(monthly_cost="not a number"), {})
        assert out["monthly_cost"] is None
        assert out["annual_cost"] is None

    def test_a_stopped_vm_with_a_dict_cost_does_not_raise(self):
        """This combination used to raise TypeError: dict * int."""
        out = ci.analyse_vm(
            vm(power_state="PowerState/stopped", monthly_cost={"cost": 500.0, "meters": []}),
            {},
        )
        assert out["savings"]["monthly"] == 500.0
        assert out["savings"]["annual"] == pytest.approx(6000.0)

    def test_a_stopped_vm_without_cost_claims_no_saving(self):
        out = ci.analyse_vm(vm(power_state="PowerState/stopped", monthly_cost=None), {})
        assert out["savings"]["monthly"] is None
        assert out["savings"]["basis"] == "cost_unavailable"


class TestResourceIdJoin:
    """Cost joins to inventory on resource id, and casing must not break it."""

    def test_casing_and_trailing_slash_are_normalised(self):
        assert _norm_id("/SUBSCRIPTIONS/S1/resourceGroups/RG/") == "/subscriptions/s1/resourcegroups/rg"

    def test_none_is_safe(self):
        assert _norm_id(None) == ""

    def test_graph_and_cost_management_casing_meet(self):
        graph_id = "/subscriptions/S1/resourceGroups/RG/providers/Microsoft.Compute/virtualMachines/VM1"
        index = resource_cost_index([{
            "ResourceId": "/SUBSCRIPTIONS/s1/RESOURCEGROUPS/rg/PROVIDERS/MICROSOFT.COMPUTE/VIRTUALMACHINES/vm1",
            "PreTaxCost": 42.0,
        }])
        assert index[_norm_id(graph_id)]["cost"] == 42.0


# ── the five "no data" causes ──────────────────────────────────────────────


class TestTelemetryStatesAreDistinguished:
    """
    Five different situations used to render identically as "Not enough data",
    leaving the reader no way to tell a permission gap from a new VM.
    """

    def test_permission_failure_names_the_missing_role(self):
        out = ci.classify(cpu_metrics(), power_state="running",
                          telemetry_error=ci.TELEMETRY_PERMISSION)
        assert out["telemetry"] == ci.TELEMETRY_PERMISSION
        assert "Monitoring Reader" in out["reason"]

    def test_throttling_is_reported_as_retryable(self):
        out = ci.classify(cpu_metrics(), power_state="running",
                          telemetry_error=ci.TELEMETRY_THROTTLED)
        assert out["telemetry"] == ci.TELEMETRY_THROTTLED
        assert "throttled" in out["reason"].lower()

    def test_a_failed_query_is_not_reported_as_low_usage(self):
        out = ci.classify(cpu_metrics(), power_state="running",
                          telemetry_error=ci.TELEMETRY_ERROR)
        assert out["telemetry"] == ci.TELEMETRY_ERROR
        assert "not a measurement" in out["reason"]

    def test_an_unpublished_metric_is_not_reported_as_idleness(self):
        out = ci.classify(cpu_metrics(), power_state="running",
                          telemetry_error=ci.TELEMETRY_UNSUPPORTED)
        assert out["telemetry"] == ci.TELEMETRY_UNSUPPORTED
        assert "not published" in out["reason"]

    def test_no_datapoints_is_its_own_state(self):
        out = ci.classify(cpu_metrics(points=0), power_state="running")
        assert out["telemetry"] == ci.TELEMETRY_NONE
        assert "not evidence of idleness" in out["reason"]

    def test_some_but_too_few_points_is_insufficient_not_absent(self):
        out = ci.classify(
            cpu_metrics(points=5, p95=10.0, confident=False), power_state="running",
        )
        assert out["telemetry"] == ci.TELEMETRY_INSUFFICIENT
        assert "5 CPU datapoints" in out["reason"]

    def test_a_deallocated_vm_reports_not_applicable_not_a_failure(self):
        out = ci.classify(cpu_metrics(), power_state="PowerState/deallocated")
        assert out["telemetry"] == ci.TELEMETRY_NOT_APPLICABLE

    def test_healthy_telemetry_reports_ok(self):
        out = ci.analyse_vm(
            vm(), cpu_metrics(p95=50.0, p99=60.0, avg=45.0, points=700, confident=True),
        )
        assert out["telemetry"]["state"] == ci.TELEMETRY_OK

    def test_every_state_has_a_readable_label(self):
        for state in (
            ci.TELEMETRY_OK, ci.TELEMETRY_INSUFFICIENT, ci.TELEMETRY_NONE,
            ci.TELEMETRY_PERMISSION, ci.TELEMETRY_THROTTLED,
            ci.TELEMETRY_UNSUPPORTED, ci.TELEMETRY_ERROR,
            ci.TELEMETRY_NOT_APPLICABLE, ci.TELEMETRY_PARTIAL,
        ):
            assert ci.TELEMETRY_LABEL[state]


# ── coverage ───────────────────────────────────────────────────────────────


class TestCoverage:
    """How much of the window the VM actually reported."""

    def test_coverage_is_observed_over_expected(self):
        summary = m.summarise([1.0, 2.0, None, None])
        assert summary["points"] == 2
        assert summary["expected"] == 4
        assert summary["coverage"] == pytest.approx(50.0)

    def test_full_coverage(self):
        assert m.summarise([1.0, 2.0])["coverage"] == pytest.approx(100.0)

    def test_no_points_is_zero_coverage_not_a_crash(self):
        summary = m.summarise([None, None])
        assert summary["points"] == 0
        assert summary["coverage"] == pytest.approx(0.0)
        assert summary["avg"] is None

    def test_an_empty_series_has_no_coverage_to_report(self):
        assert m.summarise([])["coverage"] is None

    def test_the_observation_window_is_carried(self):
        summary = m.summarise(
            [1.0, None, 3.0],
            ["2026-08-01T00:00:00Z", "2026-08-01T01:00:00Z", "2026-08-02T00:00:00Z"],
        )
        assert summary["first"] == "2026-08-01T00:00:00Z"
        assert summary["last"] == "2026-08-02T00:00:00Z"

    def test_timestamps_of_null_points_are_not_counted_as_observations(self):
        summary = m.summarise([None, 5.0], ["2026-08-01T00:00:00Z", "2026-08-05T00:00:00Z"])
        assert summary["first"] == "2026-08-05T00:00:00Z"

    def test_coverage_survives_the_parse(self):
        payload = {"value": [{
            "name": {"value": "Percentage CPU"}, "unit": "Percent",
            "timeseries": [{"data": [
                {"timeStamp": "2026-08-01T00:00:00Z", "average": 10.0},
                {"timeStamp": "2026-08-01T01:00:00Z"},
            ]}],
        }]}
        parsed = m.parse_metric_response(payload)["Percentage CPU"]
        assert parsed["points"] == 1
        assert parsed["expected"] == 2
        assert parsed["coverage"] == pytest.approx(50.0)

    def test_multiple_timeseries_are_aggregated_not_discarded(self):
        payload = {"value": [{
            "name": {"value": "Percentage CPU"}, "unit": "Percent",
            "timeseries": [
                {"data": [{"timeStamp": "t1", "average": 10.0}]},
                {"data": [{"timeStamp": "t2", "average": 20.0}]},
            ],
        }]}
        parsed = m.parse_metric_response(payload)["Percentage CPU"]
        assert parsed["points"] == 2
        assert parsed["avg"] == pytest.approx(15.0)


# ── the response contract ──────────────────────────────────────────────────


class TestResponseContract:
    """The UI renders these fields directly, so they must always be present."""

    REQUIRED = [
        "id", "name", "sku", "region", "resource_group", "subscription_id",
        "power_state", "monthly_cost", "annual_cost", "verdict",
        "verdict_label", "severity", "confident", "reason",
        "cpu_avg", "cpu_p95", "cpu_p99", "cpu_max",
        "recommended_sku", "action", "savings", "telemetry",
    ]

    @pytest.mark.parametrize("state", ["running", "deallocated", "stopped", ""])
    def test_every_field_exists_in_every_power_state(self, state):
        out = ci.analyse_vm(vm(power_state=state), cpu_metrics())
        for field in self.REQUIRED:
            assert field in out, f"{field} missing for power state {state!r}"

    def test_telemetry_block_is_complete(self):
        out = ci.analyse_vm(vm(), cpu_metrics(points=700, p95=10.0, confident=True))
        for field in ("metric", "state", "label", "observed_points",
                      "expected_points", "coverage", "first_observed",
                      "last_observed"):
            assert field in out["telemetry"]

    def test_cpu_stats_are_carried_for_a_judged_vm(self):
        out = ci.analyse_vm(
            vm(),
            cpu_metrics(avg=18.4, p95=42.1, p99=81.7, max=94.2, points=700, confident=True),
        )
        assert out["cpu_avg"] == pytest.approx(18.4)
        assert out["cpu_p95"] == pytest.approx(42.1)
        assert out["cpu_p99"] == pytest.approx(81.7)
        assert out["cpu_max"] == pytest.approx(94.2)

    def test_cpu_stats_are_none_never_zero_when_absent(self):
        out = ci.analyse_vm(vm(), cpu_metrics())
        for field in ("cpu_avg", "cpu_p95", "cpu_p99", "cpu_max"):
            assert out[field] is None

    def test_power_state_is_normalised_for_display(self):
        assert ci.analyse_vm(vm(power_state="PowerState/running"), {})["power_state"] == "running"
        assert ci.analyse_vm(vm(power_state="PowerState/deallocated"), {})["power_state"] == "deallocated"
        assert ci.analyse_vm(vm(power_state=""), {})["power_state"] == "unknown"
        assert ci.analyse_vm(vm(power_state="PowerState/weird"), {})["power_state"] == "unknown"


# ── ordering ───────────────────────────────────────────────────────────────


class TestFleetOrdering:
    def test_costly_findings_lead_and_unknowns_trail(self):
        items = [
            {"verdict": ci.INSUFFICIENT_DATA, "name": "d", "savings": {}, "monthly_cost": 0},
            {"verdict": ci.RIGHT_SIZED, "name": "c", "savings": {}, "monthly_cost": 0},
            {"verdict": ci.DEALLOCATED, "name": "b", "savings": {}, "monthly_cost": 0},
            {"verdict": ci.STOPPED_BILLED, "name": "a", "savings": {"monthly": 10}, "monthly_cost": 10},
        ]
        ordered = [i["name"] for i in sorted(items, key=ci.sort_key)]
        assert ordered == ["a", "b", "c", "d"]

    def test_an_unpriced_fleet_still_leads_with_the_expensive_machines(self):
        items = [
            {"verdict": ci.IDLE, "name": "cheap", "savings": {}, "monthly_cost": 5.0},
            {"verdict": ci.IDLE, "name": "pricey", "savings": {}, "monthly_cost": 900.0},
        ]
        assert [i["name"] for i in sorted(items, key=ci.sort_key)] == ["pricey", "cheap"]

    def test_deallocated_outranks_not_enough_data(self):
        assert ci.VERDICT_ORDER.index(ci.DEALLOCATED) < ci.VERDICT_ORDER.index(ci.INSUFFICIENT_DATA)
