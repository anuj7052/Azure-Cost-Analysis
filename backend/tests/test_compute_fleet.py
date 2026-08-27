"""
The fleet the user actually has, and the failure it exposed.

Seven VMs: six deallocated, one running (`abhinav-vm`, Standard_D8as_v5 in
centralindia, ₹2,576.70/month). The running one reported no CPU at all — the
page said "Metric not published for this resource" and every CPU column was
blank, even though a running Azure VM always publishes host CPU.

The cause is pinned in `TestTheGuestMetricPoisonedTheRequest` below: Azure
Monitor fails a metrics request *in its entirety* if one requested metric is
not published for the resource, and the request included `Available Memory
Bytes`, which only exists once the guest agent is installed. One absent guest
metric therefore suppressed the platform metric that was available.
"""
import httpx
import pytest

from services import azure_metrics as m
from services import compute_intel as ci


def cpu_block(**stats):
    base = {
        "avg": None, "max": None, "min": None, "p50": None, "p95": None,
        "p99": None, "points": 0, "expected": 720, "coverage": 0.0,
        "first": None, "last": None, "confident": False, "unit": "Percent",
    }
    base.update(stats)
    return base


def abhinav_vm(**over):
    """The real running VM from the user's fleet."""
    base = {
        "id": "/subscriptions/sub-1/resourceGroups/testing-vm/providers/"
              "Microsoft.Compute/virtualMachines/abhinav-vm",
        "name": "abhinav-vm",
        "sku": "Standard_D8as_v5",
        "region": "centralindia",
        "resource_group": "testing-vm",
        "subscription_id": "sub-1",
        "power_state": "PowerState/running",
        "os_type": "Linux",
        "monthly_cost": 2576.70,
        "currency": "INR",
        "type": "microsoft.compute/virtualmachines",
    }
    base.update(over)
    return base


# ── the root cause ─────────────────────────────────────────────────────────


class TestTheGuestMetricPoisonedTheRequest:
    def test_available_memory_is_a_guest_metric_not_a_host_one(self):
        """
        The distinction that matters: host metrics need no agent, guest metrics
        do. Mixing them in one request makes the agent a prerequisite for CPU.
        """
        assert "Available Memory Bytes" in m.GUEST_VM_METRICS
        assert "Percentage CPU" in m.HOST_VM_METRICS
        assert not (m.HOST_VM_METRICS & m.GUEST_VM_METRICS)

    @pytest.mark.asyncio
    async def test_only_published_metrics_are_requested(self):
        """
        A VM with no guest agent publishes CPU, network and disk but not
        memory. The metrics request must ask for the first three and drop the
        fourth, rather than asking for all four and receiving nothing.
        """
        published = [
            "Percentage CPU", "Network In Total", "Network Out Total",
            "Disk Read Bytes", "Disk Write Bytes",
        ]
        asked = {"names": []}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/metricDefinitions"):
                return httpx.Response(200, json={
                    "value": [
                        {"name": {"value": n}, "namespace": "Microsoft.Compute/virtualMachines",
                         "supportedAggregationTypes": ["Average", "Maximum"]}
                        for n in published
                    ]
                })
            asked["names"] += request.url.params["metricnames"].split(",")
            return httpx.Response(200, json={"value": [{
                "name": {"value": "Percentage CPU"}, "unit": "Percent",
                "timeseries": [{"data": [
                    {"timeStamp": f"2026-08-{d:02d}T00:00:00Z", "average": 12.0}
                    for d in range(1, 29)
                ]}],
            }]})

        transport = httpx.MockTransport(handler)
        original = httpx.AsyncClient

        class Patched(original):
            def __init__(self, *a, **kw):
                kw["transport"] = transport
                super().__init__(*a, **kw)

        httpx.AsyncClient = Patched
        try:
            out = await m.fetch_many("token", [abhinav_vm()], days=30)
        finally:
            httpx.AsyncClient = original

        assert "Available Memory Bytes" not in asked["names"]
        assert "Percentage CPU" in asked["names"]

        result = out[abhinav_vm()["id"]]
        assert result.get("kind") is None
        assert result["metrics"]["Percentage CPU"]["points"] == 28
        assert result["capabilities"]["percentage_cpu"] is True
        assert result["capabilities"]["memory"] is False
        assert "Available Memory Bytes" in result["diagnostics"]["skipped_metrics"]
        assert "Percentage CPU" not in result["diagnostics"]["skipped_metrics"]

    @pytest.mark.asyncio
    async def test_a_resource_publishing_nothing_useful_says_so_precisely(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/metricDefinitions"):
                return httpx.Response(200, json={"value": []})
            raise AssertionError("metrics must not be requested when nothing is published")

        transport = httpx.MockTransport(handler)
        original = httpx.AsyncClient

        class Patched(original):
            def __init__(self, *a, **kw):
                kw["transport"] = transport
                super().__init__(*a, **kw)

        httpx.AsyncClient = Patched
        try:
            out = await m.fetch_many("token", [abhinav_vm()], days=30)
        finally:
            httpx.AsyncClient = original

        result = out[abhinav_vm()["id"]]
        assert result["kind"] == m.NO_METRIC
        assert result["capabilities"]["available_metrics"] == []

    @pytest.mark.asyncio
    async def test_a_denied_definitions_lookup_is_reported_as_access_not_absence(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"error": {"code": "AuthorizationFailed"}})

        transport = httpx.MockTransport(handler)
        original = httpx.AsyncClient

        class Patched(original):
            def __init__(self, *a, **kw):
                kw["transport"] = transport
                super().__init__(*a, **kw)

        httpx.AsyncClient = Patched
        try:
            out = await m.fetch_many("token", [abhinav_vm()], days=30)
        finally:
            httpx.AsyncClient = original

        assert out[abhinav_vm()["id"]]["kind"] == m.NO_ACCESS


class TestMetricDefinitionParsing:
    @pytest.mark.asyncio
    async def test_namespaces_aggregations_and_dimensions_are_captured(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"value": [{
                "name": {"value": "Percentage CPU"},
                "namespace": "Microsoft.Compute/virtualMachines",
                "supportedAggregationTypes": ["Average", "Minimum", "Maximum"],
                "dimensions": [{"value": "VMName"}],
            }]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            out = await m.fetch_metric_definitions(client, "token", "/subscriptions/x/vm")

        assert out["metrics"] == ["Percentage CPU"]
        assert out["namespaces"] == ["Microsoft.Compute/virtualMachines"]
        assert out["aggregations"]["Percentage CPU"] == ["Average", "Minimum", "Maximum"]
        assert out["dimensions"]["Percentage CPU"] == ["VMName"]


# ── the four independent answers ───────────────────────────────────────────


class TestFourSeparateVerdicts:
    """
    The failure this replaces: one verdict answering four questions, so a VM
    that was definitely running and definitely costing ₹2,576.70 reported
    "not enough data" — discarding three answers we had in order to express
    the one we did not.
    """

    def test_a_running_vm_without_cpu_still_reports_running_and_costed(self):
        out = ci.analyse_vm(
            abhinav_vm(),
            {},
            telemetry_error=ci.TELEMETRY_UNSUPPORTED,
            capabilities=m.capabilities_from(["Network In Total", "Disk Read Bytes"]),
        )
        assert out["operational"]["status"] == ci.OP_RUNNING
        assert out["monthly_cost"] == 2576.70
        assert out["annual_cost"] == pytest.approx(30920.40, rel=1e-6)
        assert out["cost"]["currency"] == "INR"

    def test_right_sizing_says_cannot_determine_rather_than_guessing(self):
        out = ci.analyse_vm(
            abhinav_vm(), {}, telemetry_error=ci.TELEMETRY_UNSUPPORTED,
        )
        rs = out["right_sizing"]
        assert rs["status"] == ci.RS_CANNOT_DETERMINE
        assert rs["confidence"] == ci.CONF_NONE
        assert rs["recommendation"] is None
        assert "Percentage CPU telemetry is unavailable" in rs["reason"]
        assert "Verify Azure Monitor" in rs["recommended_action"]

    def test_cpu_stays_null_and_is_never_zero(self):
        out = ci.analyse_vm(abhinav_vm(), {}, telemetry_error=ci.TELEMETRY_UNSUPPORTED)
        cpu = out["utilization"]["cpu"]
        assert cpu == {"average": None, "p95": None, "p99": None, "peak": None, "min": None}

    def test_other_signals_are_reported_when_cpu_is_missing(self):
        """
        Network and disk telemetry make the VM partially measurable. Reporting
        that as "unavailable" would throw away real evidence that it is in use.
        """
        metrics = {
            "Network In Total": {"points": 700, "coverage": 97.2, "p95": 5_000_000.0},
            "Disk Read Bytes": {"points": 700, "coverage": 97.2, "p95": 1_000.0},
        }
        out = ci.analyse_vm(
            abhinav_vm(), metrics, telemetry_error=ci.TELEMETRY_UNSUPPORTED,
        )
        assert out["utilization"]["status"] == ci.UTIL_PARTIAL
        assert out["utilization"]["signals"]["network"]["available"] is True
        assert out["utilization"]["signals"]["disk"]["available"] is True
        assert out["utilization"]["signals"]["cpu"]["available"] is False

    def test_with_no_signals_at_all_utilization_is_unavailable(self):
        out = ci.analyse_vm(abhinav_vm(), {}, telemetry_error=ci.TELEMETRY_PERMISSION)
        assert out["utilization"]["status"] == ci.UTIL_UNAVAILABLE

    def test_capabilities_reach_the_response(self):
        caps = m.capabilities_from(["Network In Total", "Disk Read Bytes"])
        out = ci.analyse_vm(abhinav_vm(), {}, telemetry_error=ci.TELEMETRY_UNSUPPORTED,
                            capabilities=caps)
        assert out["telemetry"]["capabilities"]["percentage_cpu"] is False
        assert out["telemetry"]["capabilities"]["network"] is True
        assert out["telemetry"]["available_metrics"] == ["Disk Read Bytes", "Network In Total"]


class TestDeallocatedFleet:
    """The six deallocated VMs must not be described as idle or unmeasured."""

    def test_deallocated_reports_not_running_on_every_axis(self):
        out = ci.analyse_vm(abhinav_vm(power_state="PowerState/deallocated"), {})
        assert out["operational"]["status"] == ci.OP_DEALLOCATED
        assert out["utilization"]["status"] == ci.UTIL_NOT_APPLICABLE
        assert out["right_sizing"]["status"] == ci.RS_NOT_APPLICABLE
        assert out["telemetry"]["status"] == ci.TELEMETRY_NOT_APPLICABLE
        assert out["verdict"] == ci.DEALLOCATED

    def test_a_deallocated_vm_keeps_its_cost(self):
        out = ci.analyse_vm(abhinav_vm(power_state="PowerState/deallocated"), {})
        assert out["monthly_cost"] == 2576.70

    def test_the_explanation_names_what_is_still_billed(self):
        out = ci.analyse_vm(abhinav_vm(power_state="PowerState/deallocated"), {})
        reason = out["reason"].lower()
        assert "disk" in reason and "public ip" in reason

    def test_stopped_is_not_the_same_as_deallocated(self):
        out = ci.analyse_vm(abhinav_vm(power_state="PowerState/stopped"), {})
        assert out["operational"]["status"] == ci.OP_STOPPED
        assert out["right_sizing"]["status"] == ci.RS_DEALLOCATE
        assert out["savings"]["monthly"] == 2576.70


class TestConfidence:
    def test_only_priced_sound_telemetry_earns_high_confidence(self):
        assert ci.confidence_for(ci.RS_OVERSIZED, ci.TELEMETRY_OK, 97.0, priced=True) == ci.CONF_HIGH

    def test_thin_coverage_is_capped_at_medium(self):
        assert ci.confidence_for(ci.RS_OVERSIZED, ci.TELEMETRY_OK, 20.0, priced=True) == ci.CONF_MEDIUM

    def test_an_unpriced_recommendation_is_never_high(self):
        assert ci.confidence_for(ci.RS_OVERSIZED, ci.TELEMETRY_OK, 97.0, priced=False) == ci.CONF_MEDIUM

    def test_broken_telemetry_is_low(self):
        assert ci.confidence_for(ci.RS_OVERSIZED, ci.TELEMETRY_THROTTLED, None, priced=True) == ci.CONF_LOW

    def test_a_stopped_vm_needs_no_telemetry_to_be_certain(self):
        assert ci.confidence_for(ci.RS_DEALLOCATE, ci.TELEMETRY_NOT_APPLICABLE, None, priced=True) == ci.CONF_HIGH

    def test_nothing_to_recommend_carries_no_confidence(self):
        assert ci.confidence_for(ci.RS_CANNOT_DETERMINE, ci.TELEMETRY_NO_METRIC
                                 if hasattr(ci, "TELEMETRY_NO_METRIC") else ci.TELEMETRY_UNSUPPORTED,
                                 None, priced=False) == ci.CONF_NONE


class TestSavingsHonesty:
    def test_only_high_confidence_savings_reach_the_headline(self):
        analyses = [
            {"verdict": ci.UNDERUTILIZED, "action": "resize", "savings": {"monthly": 500.0},
             "right_sizing": {"status": ci.RS_OVERSIZED, "confidence": ci.CONF_HIGH},
             "operational": {"status": ci.OP_RUNNING}, "telemetry": {"status": ci.TELEMETRY_OK},
             "monthly_cost": 5000.0, "cost": {}},
            {"verdict": ci.UNDERUTILIZED, "action": "resize", "savings": {"monthly": 900.0},
             "right_sizing": {"status": ci.RS_OVERSIZED, "confidence": ci.CONF_LOW},
             "operational": {"status": ci.OP_RUNNING}, "telemetry": {"status": ci.TELEMETRY_OK},
             "monthly_cost": 9000.0, "cost": {}},
        ]
        out = ci.summarise_fleet(analyses)
        assert out["confident_monthly_savings"] == 500.0
        assert out["monthly_savings"] == 1400.0

    def test_the_users_actual_fleet_reports_no_opportunity_not_zero(self):
        """Six deallocated plus one unmeasurable running VM: nothing to claim."""
        analyses = [
            ci.analyse_vm(abhinav_vm(name=f"vm{i}", power_state="PowerState/deallocated"), {})
            for i in range(6)
        ] + [
            ci.analyse_vm(abhinav_vm(), {}, telemetry_error=ci.TELEMETRY_UNSUPPORTED)
        ]
        out = ci.summarise_fleet(analyses)

        assert out["total"] == 7
        assert out["deallocated"] == 6
        assert out["running"] == 1
        assert out["rightsizing_opportunities"] == 0
        assert out["telemetry_issues"] == 1
        assert out["assessed"] == 6
        assert out["monthly_savings"] is None
        assert out["confident_monthly_savings"] is None
        assert out["no_opportunity_note"] == (
            "No high-confidence optimization opportunity identified."
        )

    def test_cost_share_is_computed_without_any_telemetry(self):
        analyses = [
            ci.analyse_vm(abhinav_vm(monthly_cost=750.0), {},
                          telemetry_error=ci.TELEMETRY_UNSUPPORTED),
            ci.analyse_vm(abhinav_vm(monthly_cost=250.0), {},
                          telemetry_error=ci.TELEMETRY_UNSUPPORTED),
        ]
        ci.summarise_fleet(analyses)
        assert analyses[0]["cost"]["share_of_fleet"] == pytest.approx(75.0)
        assert analyses[1]["cost"]["share_of_fleet"] == pytest.approx(25.0)


class TestNoNaNEverLeavesTheBackend:
    @pytest.mark.parametrize("state", [
        "PowerState/running", "PowerState/deallocated", "PowerState/stopped", "",
    ])
    @pytest.mark.parametrize("error", [
        "", ci.TELEMETRY_UNSUPPORTED, ci.TELEMETRY_PERMISSION,
        ci.TELEMETRY_THROTTLED, ci.TELEMETRY_ERROR,
    ])
    def test_numeric_fields_are_numbers_or_none(self, state, error):
        out = ci.analyse_vm(
            abhinav_vm(power_state=state, monthly_cost={"cost": 10.0, "meters": []}),
            {}, telemetry_error=error,
        )
        numeric = [
            out["monthly_cost"], out["annual_cost"], out["cpu_avg"], out["cpu_p95"],
            out["cpu_p99"], out["cpu_max"], out["savings"].get("monthly"),
            out["telemetry"]["coverage"],
        ]
        for value in numeric:
            assert value is None or isinstance(value, (int, float))
            if isinstance(value, float):
                assert value == value  # not NaN

    @pytest.mark.parametrize("state", [
        "PowerState/running", "PowerState/deallocated", "PowerState/stopped", "",
    ])
    def test_every_axis_is_always_present_and_labelled(self, state):
        out = ci.analyse_vm(abhinav_vm(power_state=state), {})
        for axis in ("operational", "utilization", "right_sizing", "telemetry", "cost"):
            assert axis in out
        assert out["operational"]["label"]
        assert out["utilization"]["label"]
        assert out["right_sizing"]["label"]
        assert out["telemetry"]["label"]


class TestAssessedDoesNotMeanExamined:
    """
    "Assessed" answered two questions at once: measured, and provably off.
    A reader seeing "8 / 11 assessed" on a fleet of eight deallocated
    machines would reasonably conclude eight had their CPU examined. None
    had. The partition below keeps the two apart.
    """

    def fleet(self):
        # Eight off, three running of which none could be measured — the
        # shape the user reported from their own tenant.
        off = [
            ci.analyse_vm(abhinav_vm(name=f"off{i}", power_state="PowerState/deallocated"), {})
            for i in range(8)
        ]
        running = [
            ci.analyse_vm(abhinav_vm(name=f"run{i}"), {}, telemetry_error=ci.TELEMETRY_UNSUPPORTED)
            for i in range(3)
        ]
        return ci.summarise_fleet(off + running)

    def test_the_deallocated_are_not_counted_as_measured(self):
        out = self.fleet()
        assert out["telemetry_measured"] == 0
        assert out["verifiably_off"] == 8
        assert out["telemetry_unavailable"] == 3

    def test_the_three_counts_partition_the_fleet(self):
        out = self.fleet()
        total = (
            out["verifiably_off"]
            + out["telemetry_measured"]
            + out["telemetry_unavailable"]
        )
        assert total == out["total"] == 11

    def test_a_measured_running_vm_counts_as_measured(self):
        analyses = [
            ci.analyse_vm(abhinav_vm(), {"Percentage CPU": cpu_block(
                avg=42.0, max=61.0, p95=55.0, p99=58.0, points=720,
                coverage=100.0, confident=True,
            )}),
        ]
        out = ci.summarise_fleet(analyses)
        assert out["telemetry_measured"] == 1
        assert out["verifiably_off"] == 0
        assert out["telemetry_unavailable"] == 0

    def test_partial_telemetry_counts_as_measured_not_missing(self):
        """Some evidence is not the same as no evidence."""
        analyses = [
            ci.analyse_vm(
                abhinav_vm(),
                {"Percentage CPU": cpu_block(avg=12.0, points=100, coverage=13.0)},
                telemetry_error=ci.TELEMETRY_PARTIAL,
            ),
        ]
        out = ci.summarise_fleet(analyses)
        assert out["telemetry_measured"] == 1
        assert out["telemetry_unavailable"] == 0


class TestPublishedIsNotTheSameAsReporting:
    """
    KredilyTemp showed "CPU: Published" and "Percentage CPU is not published
    for this resource" in the same drawer. Two facts about one metric, read
    from two places, and flatly contradicting each other.

    Whether a metric exists and whether it returned datapoints are separate
    questions. These tests hold them apart.
    """

    def caps(self, **over):
        base = {"percentage_cpu": True, "memory": False, "network": True, "disk": True}
        base.update(over)
        return base

    def test_published_with_datapoints_reads_as_published(self):
        out = ci.analyse_vm(
            abhinav_vm(),
            {"Percentage CPU": cpu_block(
                avg=40.0, max=70.0, p95=62.0, p99=68.0, points=720,
                coverage=100.0, confident=True,
            )},
            capabilities=self.caps(),
        )
        cpu = out["utilization"]["signals"]["cpu"]
        assert cpu["status"] == ci.SIG_PUBLISHED_WITH_DATA
        assert cpu["label"] == "Published"

    def test_published_but_empty_window_is_not_called_unpublished(self):
        """The exact KredilyTemp case."""
        out = ci.analyse_vm(
            abhinav_vm(),
            {"Percentage CPU": cpu_block()},
            capabilities=self.caps(),
        )
        cpu = out["utilization"]["signals"]["cpu"]
        assert cpu["status"] == ci.SIG_PUBLISHED_NO_DATA
        assert cpu["label"] == "Published · No data"
        assert out["telemetry"]["status"] == ci.TELEMETRY_NONE
        assert "not published" not in out["telemetry"]["reason"].lower()

    def test_genuinely_unpublished_says_so(self):
        out = ci.analyse_vm(
            abhinav_vm(),
            {},
            telemetry_error=ci.TELEMETRY_UNSUPPORTED,
            capabilities=self.caps(percentage_cpu=False),
        )
        cpu = out["utilization"]["signals"]["cpu"]
        assert cpu["status"] == ci.SIG_NOT_PUBLISHED
        assert cpu["label"] == "Not published"

    def test_a_refused_query_is_never_reported_as_unpublished(self):
        """403 says nothing about whether the metric exists."""
        out = ci.analyse_vm(
            abhinav_vm(), {},
            telemetry_error=ci.TELEMETRY_PERMISSION,
            capabilities=None,
        )
        cpu = out["utilization"]["signals"]["cpu"]
        assert cpu["status"] == ci.TELEMETRY_PERMISSION
        assert cpu["label"] == "Access denied"

    def test_without_a_catalogue_nothing_is_claimed_unpublished(self):
        out = ci.analyse_vm(abhinav_vm(), {}, capabilities=None)
        for name in ("cpu", "network", "disk", "memory"):
            sig = out["utilization"]["signals"][name]
            assert sig["status"] != ci.SIG_NOT_PUBLISHED, name

    def test_a_deallocated_vm_reports_every_signal_as_not_running(self):
        out = ci.analyse_vm(
            abhinav_vm(power_state="PowerState/deallocated"), {},
            capabilities=self.caps(),
        )
        for name in ("cpu", "network", "disk", "memory"):
            assert out["utilization"]["signals"][name]["status"] == ci.SIG_NOT_RUNNING
            assert out["utilization"]["signals"][name]["label"] == "Not running"

    def test_signal_label_never_contradicts_the_telemetry_reason(self):
        """No drawer may assert a metric is published and unpublished at once."""
        cases = [
            (self.caps(), {}, ""),
            (self.caps(percentage_cpu=False), {}, ci.TELEMETRY_UNSUPPORTED),
            (self.caps(), {}, ci.TELEMETRY_PERMISSION),
            (self.caps(), {}, ci.TELEMETRY_THROTTLED),
            (self.caps(), {}, ci.TELEMETRY_ERROR),
        ]
        for caps, metrics, err in cases:
            out = ci.analyse_vm(
                abhinav_vm(), metrics, telemetry_error=err, capabilities=caps,
            )
            label = out["utilization"]["signals"]["cpu"]["label"]
            reason = (out["telemetry"]["reason"] or "").lower()
            if label == "Published · No data":
                assert "not published" not in reason
            if label == "Not published":
                assert "returned no datapoints" not in reason


class TestAVerifiedMetricCannotBeCalledUnpublished:
    """
    Once metricDefinitions has confirmed a metric exists, an HTTP 400 from the
    metrics endpoint cannot mean "not published" — that explanation is already
    disproved. Reporting it anyway is what produced the contradiction.
    """

    def transport(self):
        def handler(request):
            return httpx.Response(400, json={
                "code": "BadRequest",
                "message": "Failed to find metric configuration for provider",
            })
        return httpx.MockTransport(handler)

    @pytest.mark.asyncio
    async def test_verified_400_is_an_api_error(self):
        async with httpx.AsyncClient(transport=self.transport()) as client:
            out = await m.fetch_resource_metrics(
                client, "t", "/subscriptions/s/vm", ["Percentage CPU"], verified=True,
            )
        assert out["kind"] == m.API_ERROR
        assert "not published" not in out["error"].lower()

    @pytest.mark.asyncio
    async def test_unverified_400_may_still_mean_unpublished(self):
        async with httpx.AsyncClient(transport=self.transport()) as client:
            out = await m.fetch_resource_metrics(
                client, "t", "/subscriptions/s/vm", ["Percentage CPU"],
            )
        assert out["kind"] == m.NO_METRIC

    @pytest.mark.asyncio
    async def test_the_400_body_is_kept_for_diagnosis(self):
        async with httpx.AsyncClient(transport=self.transport()) as client:
            out = await m.fetch_resource_metrics(
                client, "t", "/subscriptions/s/vm", ["Percentage CPU"], verified=True,
            )
        assert "metric configuration" in out["diagnostics"]["body"]


class TestAggregationMismatchWasTheRealFourHundred:
    """
    Every running VM returned HTTP 400 even after the metric names were
    verified against metricDefinitions. The names were never the problem.

    Azure applies one `aggregation` list to every metric in a request and
    rejects the whole call if any metric does not support an entry. The code
    asked for "Average,Total" on every metric. `Percentage CPU` has no Total
    aggregation, so a VM with a CPU was guaranteed a 400 — which is exactly
    the set of machines that appeared unmeasurable.
    """

    AGGS = {
        "Percentage CPU": ["Average", "Maximum", "Minimum"],
        "Network In Total": ["Average", "Total"],
        "Network Out Total": ["Average", "Total"],
    }

    def test_cpu_is_not_grouped_with_total_only_metrics(self):
        groups = dict(
            (agg, names) for agg, names
            in m.group_by_aggregation(list(self.AGGS), self.AGGS)
        )
        cpu_group = [a for a, names in groups.items() if "Percentage CPU" in names][0]
        assert "Total" not in cpu_group
        assert "Average" in cpu_group

    def test_metrics_supporting_total_keep_it(self):
        groups = m.group_by_aggregation(list(self.AGGS), self.AGGS)
        net = [agg for agg, names in groups if "Network In Total" in names][0]
        assert "Total" in net

    def test_every_metric_lands_in_exactly_one_group(self):
        groups = m.group_by_aggregation(list(self.AGGS), self.AGGS)
        placed = [n for _, names in groups for n in names]
        assert sorted(placed) == sorted(self.AGGS)

    def test_an_unknown_metric_falls_back_to_average(self):
        """Average is supported by every Azure metric, so it can never 400."""
        groups = m.group_by_aggregation(["Mystery Metric"], {})
        assert groups == [("Average", ["Mystery Metric"])]

    @pytest.mark.asyncio
    async def test_a_failed_group_does_not_discard_a_successful_one(self):
        """Losing disk counters must not throw away the CPU history."""
        def handler(request):
            if "Network In Total" in request.url.params.get("metricnames", ""):
                # Refused however it is asked for, so no fallback can rescue it.
                return httpx.Response(400, json={"code": "BadRequest"})
            return httpx.Response(200, json={"value": [{
                "name": {"value": "Percentage CPU"},
                "unit": "Percent",
                "timeseries": [{"data": [
                    {"timeStamp": "2026-08-01T00:00:00Z", "average": 40.0},
                ]}],
            }]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            out = await m.fetch_metrics_by_aggregation(
                client, "t", "/subscriptions/s/vm",
                ["Percentage CPU", "Network In Total"], self.AGGS,
            )

        assert "Percentage CPU" in out["metrics"]
        assert not out.get("kind"), "a partial success must not be reported as a failure"
        assert out["partial_failures"]

    @pytest.mark.asyncio
    async def test_cpu_is_requested_without_the_total_aggregation(self):
        seen = []

        def handler(request):
            seen.append(request.url.params.get("aggregation", ""))
            return httpx.Response(200, json={"value": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await m.fetch_metrics_by_aggregation(
                client, "t", "/subscriptions/s/vm", ["Percentage CPU"], self.AGGS,
            )

        assert seen and all("Total" not in agg for agg in seen)

    @pytest.mark.asyncio
    async def test_total_failure_is_reported_as_a_failure(self):
        def handler(request):
            return httpx.Response(403, json={"code": "Forbidden"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            out = await m.fetch_metrics_by_aggregation(
                client, "t", "/subscriptions/s/vm", ["Percentage CPU"], self.AGGS,
            )
        assert out["kind"] == m.NO_ACCESS


class TestTheCatalogueAdvertisedAnAggregationItWouldNotServe:
    """
    The live 400 that cost every running VM its CPU history.

    `metricDefinitions` returned 200 and listed `Total` among the supported
    aggregations for `Percentage CPU`. The metrics endpoint then rejected the
    request and blamed the metric names — all of which were valid, and all of
    which the same catalogue had just published. The catalogue may narrow what
    is asked for; it may never widen it.
    """

    CATALOGUE = {
        # Exactly what Azure returned for abhinav-vm.
        "Percentage CPU": ["None", "Average", "Minimum", "Maximum", "Total"],
        "Network In Total": ["None", "Average", "Minimum", "Maximum", "Total"],
    }

    def test_total_is_never_requested_for_a_percentage(self):
        groups = m.group_by_aggregation(["Percentage CPU"], self.CATALOGUE)
        assert [g for g, _ in groups] == ["Average,Maximum,Minimum"]

    def test_a_counter_is_still_summed(self):
        groups = m.group_by_aggregation(["Network In Total"], self.CATALOGUE)
        assert [g for g, _ in groups] == ["Total"]

    def test_cpu_and_a_counter_never_share_a_request(self):
        groups = m.group_by_aggregation(
            ["Percentage CPU", "Network In Total"], self.CATALOGUE
        )
        assert len(groups) == 2
        for aggregation, members in groups:
            if "Percentage CPU" in members:
                assert "Total" not in aggregation

    def test_desired_aggregations_are_not_taken_from_the_catalogue(self):
        assert "Total" not in m.desired_aggregations("Percentage CPU")
        assert m.desired_aggregations("Network In Total") == ["Total"]

    @pytest.mark.asyncio
    async def test_a_refused_aggregation_is_retried_as_average(self):
        seen = []

        def handler(request):
            aggregation = request.url.params.get("aggregation", "")
            seen.append(aggregation)
            if aggregation != "Average":
                return httpx.Response(400, json={"code": "BadRequest"})
            return httpx.Response(200, json={"value": [{
                "name": {"value": "Percentage CPU"},
                "unit": "Percent",
                "timeseries": [{"data": [
                    {"timeStamp": "2026-08-01T00:00:00Z", "average": 40.0},
                ]}],
            }]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            out = await m.fetch_metrics_by_aggregation(
                client, "t", "/subscriptions/s/vm",
                ["Percentage CPU"], self.CATALOGUE,
            )

        assert "Percentage CPU" in out["metrics"]
        assert not out.get("kind")
        assert "Average" in seen

    @pytest.mark.asyncio
    async def test_the_retry_is_recorded_in_diagnostics(self):
        def handler(request):
            if request.url.params.get("aggregation", "") != "Average":
                return httpx.Response(400, json={"code": "BadRequest"})
            return httpx.Response(200, json={"value": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            out = await m.fetch_metrics_by_aggregation(
                client, "t", "/subscriptions/s/vm",
                ["Percentage CPU"], self.CATALOGUE,
            )

        retries = [g for g in out["diagnostics"]["groups"] if g.get("rejected_aggregation")]
        assert retries, "a reader must be able to see that a retry happened"
        assert retries[0]["aggregation"] == "Average"

    @pytest.mark.asyncio
    async def test_the_fleet_learns_the_served_aggregation_once(self):
        m._SERVED_AGGREGATION.clear()
        calls = []

        def handler(request):
            calls.append(request.url.params.get("aggregation", ""))
            if request.url.params.get("aggregation", "") != "Average":
                return httpx.Response(400, json={"code": "BadRequest"})
            return httpx.Response(200, json={"value": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            for _ in range(2):
                await m.fetch_metrics_by_aggregation(
                    client, "t", "/subscriptions/s/vm",
                    ["Percentage CPU"], self.CATALOGUE,
                    resource_type="microsoft.compute/virtualmachines",
                )

        m._SERVED_AGGREGATION.clear()
        # First VM pays for the discovery; the second must not repeat it.
        assert calls == ["Average,Maximum,Minimum", "Average", "Average"]


class TestTheCommaHadToReachAzureUnencoded:
    """
    The defect that cost every running VM its CPU history.

    `httpx` percent-encodes commas in query values, so `metricnames` arrived as
    one `%2C`-joined string. Azure read it as a single metric name and replied
    that it could not find a metric configuration for it — quoting the whole
    joined list after a singular "metric:", then listing the very same names
    under "Valid metrics:". The catalogue and the metrics endpoint had agreed
    all along; the request was malformed.
    """

    @pytest.mark.asyncio
    async def test_metric_names_are_separated_by_a_literal_comma(self):
        seen = {}

        def handler(request):
            seen["raw"] = str(request.url)
            return httpx.Response(200, json={"value": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await m.fetch_resource_metrics(
                client, "t", "/subscriptions/s/vm",
                ["Percentage CPU", "Disk Read Bytes"],
                aggregation="Average",
            )

        assert "Percentage%20CPU,Disk%20Read%20Bytes" in seen["raw"]
        assert "%2C" not in seen["raw"], "an encoded comma makes the list one metric name"

    @pytest.mark.asyncio
    async def test_a_single_metric_name_is_unaffected(self):
        seen = {}

        def handler(request):
            seen["names"] = request.url.params["metricnames"]
            return httpx.Response(200, json={"value": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await m.fetch_resource_metrics(
                client, "t", "/subscriptions/s/vm", ["Percentage CPU"],
                aggregation="Average",
            )

        assert seen["names"] == "Percentage CPU"

    @pytest.mark.asyncio
    async def test_the_aggregation_list_also_reaches_azure_unencoded(self):
        seen = {}

        def handler(request):
            seen["raw"] = str(request.url)
            return httpx.Response(200, json={"value": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await m.fetch_resource_metrics(
                client, "t", "/subscriptions/s/vm", ["Percentage CPU"],
                aggregation="Average,Maximum,Minimum",
            )

        assert "aggregation=Average,Maximum,Minimum" in seen["raw"]

    @pytest.mark.asyncio
    async def test_a_slash_in_a_metric_name_is_still_encoded(self):
        """`Disk Read Operations/Sec` must not be read as a path segment."""
        seen = {}

        def handler(request):
            seen["raw"] = str(request.url)
            return httpx.Response(200, json={"value": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await m.fetch_resource_metrics(
                client, "t", "/subscriptions/s/vm",
                ["Disk Read Operations/Sec"], aggregation="Average",
            )

        assert "Operations%2FSec" in seen["raw"]
