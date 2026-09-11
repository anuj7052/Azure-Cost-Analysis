"""
The two things that decide how long a metrics-heavy page takes: how many
requests may be in flight, and how many are asked at all.
"""
import httpx
import pytest

from services import azure_metrics


RESOURCE = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1"


def _definitions_body():
    return {
        "value": [
            {
                "name": {"value": "Percentage CPU"},
                "namespace": "Microsoft.Compute/virtualMachines",
                "supportedAggregationTypes": ["Average", "Maximum"],
            },
        ],
    }


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestCachingTheMetricCatalogue:
    """
    Every resource is asked what it publishes before it is asked for anything.
    That doubles the request count, and the answer almost never changes.
    """

    @pytest.mark.asyncio
    async def test_it_asks_azure_once_for_the_same_resource(self):
        calls = []

        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(200, json=_definitions_body())

        async with _client(handler) as client:
            first = await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)
            second = await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)

        assert len(calls) == 1
        assert first["metrics"] == ["Percentage CPU"]
        assert second["metrics"] == ["Percentage CPU"]

    @pytest.mark.asyncio
    async def test_it_still_asks_about_a_resource_it_has_not_seen(self):
        # A cache keyed too loosely would answer for one VM using another's
        # catalogue, and the page would request metrics that do not exist --
        # which Azure fails as a whole request, not per metric.
        calls = []

        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(200, json=_definitions_body())

        async with _client(handler) as client:
            await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)
            await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE + "-other")

        assert len(calls) == 2

    @pytest.mark.asyncio
    async def test_it_does_not_remember_a_refusal(self):
        # A 403 describes this moment, not this resource. Caching one would
        # keep the VM dark for the whole TTL after the permission that fixed
        # it was granted, and the person who granted it would see no change.
        codes = [403, 200]

        def handler(request):
            code = codes.pop(0)
            if code == 403:
                return httpx.Response(403, json={})
            return httpx.Response(200, json=_definitions_body())

        async with _client(handler) as client:
            refused = await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)
            retried = await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)

        assert refused["kind"] == azure_metrics.NO_ACCESS
        assert retried["metrics"] == ["Percentage CPU"]

    @pytest.mark.asyncio
    async def test_it_does_not_remember_being_throttled(self):
        # Throttling is even more clearly a fact about the moment than a 403.
        # The retry layer rides out a burst on its own, so reaching here at
        # all means Azure was still refusing after those retries -- and the
        # next page load is exactly when that is most likely to have passed.
        state = {"throttled": True}

        def handler(request):
            if state["throttled"]:
                return httpx.Response(429, json={})
            return httpx.Response(200, json=_definitions_body())

        async with _client(handler) as client:
            first = await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)
            state["throttled"] = False
            second = await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)

        assert first["kind"] == azure_metrics.THROTTLED
        assert second["metrics"] == ["Percentage CPU"]

    @pytest.mark.asyncio
    async def test_it_forgets_when_the_entry_has_aged_out(self, monkeypatch):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json=_definitions_body())

        clock = {"now": 1000.0}
        monkeypatch.setattr(azure_metrics.time, "monotonic", lambda: clock["now"])

        async with _client(handler) as client:
            await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)
            clock["now"] += azure_metrics.DEFINITIONS_TTL_SECONDS + 1
            await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)

        assert len(calls) == 2

    @pytest.mark.asyncio
    async def test_clearing_it_makes_the_next_read_real(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json=_definitions_body())

        async with _client(handler) as client:
            await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)
            azure_metrics.clear_definitions_cache()
            await azure_metrics.fetch_metric_definitions(client, "t", RESOURCE)

        assert len(calls) == 2


class TestHowManyRequestsRunAtOnce:
    def test_the_gate_is_wide_enough_to_matter(self):
        # Two requests per resource means a hundred VMs is two hundred
        # requests. At four at a time that was fifty sequential round trips,
        # which was most of the wait on the Compute and Estate pages.
        assert azure_metrics.MAX_CONCURRENT >= 8

    def test_the_gate_is_still_a_gate(self):
        # Unbounded would turn the fan-out into the burst that earns a 429,
        # and the retry layer would spend its time sleeping.
        assert azure_metrics.MAX_CONCURRENT <= 32

    def test_one_gate_is_shared_across_callers(self):
        # Two browser tabs must not each get their own allowance. Azure counts
        # requests, not callers.
        assert azure_metrics._shared_gate(azure_metrics.MAX_CONCURRENT) is \
            azure_metrics._shared_gate(azure_metrics.MAX_CONCURRENT)
