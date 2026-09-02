"""
Orphaned resource detection.

The risk this feature carries is a false positive: telling someone a disk is
unused when it is not. So the tests pin the shape of the output and, more
importantly, that a failing rule degrades to a partial result instead of
either failing the scan or silently reporting "nothing found".
"""
from __future__ import annotations

import pytest

from models.schemas import OrphanedRequest
from services import orphaned as orphaned_module
from services.orphaned import RULES, find_orphaned_resources


def test_every_rule_has_a_reason_the_ui_can_show():
    """A finding without an explanation is not actionable, so none may exist."""
    for rule in RULES:
        assert rule.reason, f"{rule.key} has no reason"
        assert rule.title, f"{rule.key} has no title"
        assert rule.severity in ("certain", "likely")


def test_rules_target_azures_own_detachment_signals():
    """
    Detection must key off provider state, never a name or a tag.

    A rule that guessed from naming conventions would flag production
    resources, which is the failure that makes people stop using the report.
    """
    disks = next(r for r in RULES if r.key == "unattached_disks")
    assert "diskState" in disks.query
    assert "managedBy" in disks.query

    ips = next(r for r in RULES if r.key == "unassociated_public_ips")
    assert "ipConfiguration" in ips.query

    vms = next(r for r in RULES if r.key == "stopped_vms")
    # Deallocated VMs are free; only "stopped" still bills. Flagging the wrong
    # one would tell users to fix something that costs nothing.
    assert "PowerState/stopped" in vms.query


@pytest.mark.asyncio
async def test_findings_are_joined_to_real_billed_cost(monkeypatch):
    async def fake_query(token, subs, query):
        if "microsoft.compute/disks" in query:
            return [{
                "id": "/subscriptions/s1/disks/Disk1",
                "name": "disk1",
                "type": "microsoft.compute/disks",
                "resourceGroup": "rg1",
                "subscriptionId": "s1",
                "location": "eastus",
                "sizeGb": 128,
                "skuName": "Premium_LRS",
            }]
        return []

    monkeypatch.setattr(orphaned_module, "run_graph_query", fake_query)

    # Cost Management lower-cases resource ids inconsistently against Resource
    # Graph, so the join must be case-insensitive or every price is lost.
    cost_index = {"/subscriptions/s1/disks/disk1": {"cost": 240.5}}

    result = await find_orphaned_resources("tok", ["s1"], cost_index)

    disks = next(c for c in result["categories"] if c["key"] == "unattached_disks")
    assert disks["count"] == 1
    assert disks["items"][0]["monthly_cost"] == 240.5
    assert disks["items"][0]["detail"] == "128 GB · Premium_LRS"
    assert result["total_monthly_cost"] == 240.5
    assert result["total_count"] == 1


@pytest.mark.asyncio
async def test_one_failing_rule_does_not_lose_the_other_findings(monkeypatch):
    """
    A tenant may deny read on a single provider.

    Failing the whole scan there would hide real waste the caller *can* see, so
    the failure is reported alongside the results rather than replacing them.
    """
    async def flaky(token, subs, query):
        if "publicipaddresses" in query:
            raise RuntimeError("AuthorizationFailed")
        if "microsoft.compute/disks" in query:
            return [{
                "id": "/subscriptions/s1/disks/d",
                "name": "d",
                "type": "microsoft.compute/disks",
                "resourceGroup": "rg",
                "subscriptionId": "s1",
                "location": "eastus",
            }]
        return []

    monkeypatch.setattr(orphaned_module, "run_graph_query", flaky)

    result = await find_orphaned_resources("tok", ["s1"], {})

    assert result["total_count"] == 1
    assert [e["rule"] for e in result["errors"]] == ["unassociated_public_ips"]


@pytest.mark.asyncio
async def test_missing_price_is_not_reported_as_zero(monkeypatch):
    """
    An unpriced finding must stay None.

    Rounding it to 0.0 would let a throttled billing query masquerade as "this
    resource is free", and the user would skip real waste.
    """
    async def one_disk(token, subs, query):
        if "microsoft.compute/disks" in query:
            return [{
                "id": "/subscriptions/s1/disks/d",
                "name": "d",
                "type": "microsoft.compute/disks",
                "resourceGroup": "rg",
                "subscriptionId": "s1",
                "location": "eastus",
            }]
        return []

    monkeypatch.setattr(orphaned_module, "run_graph_query", one_disk)

    result = await find_orphaned_resources("tok", ["s1"], {})
    disks = next(c for c in result["categories"] if c["key"] == "unattached_disks")

    assert disks["items"][0]["monthly_cost"] is None


@pytest.mark.asyncio
async def test_expensive_findings_are_listed_first(monkeypatch):
    async def many(token, subs, query):
        if "microsoft.compute/disks" in query:
            return [
                {"id": "/s/cheap", "name": "cheap", "type": "d", "resourceGroup": "rg",
                 "subscriptionId": "s1", "location": "eastus"},
                {"id": "/s/pricey", "name": "pricey", "type": "d", "resourceGroup": "rg",
                 "subscriptionId": "s1", "location": "eastus"},
            ]
        return []

    monkeypatch.setattr(orphaned_module, "run_graph_query", many)

    result = await find_orphaned_resources(
        "tok", ["s1"], {"/s/cheap": {"cost": 5.0}, "/s/pricey": {"cost": 900.0}}
    )
    disks = next(c for c in result["categories"] if c["key"] == "unattached_disks")

    assert [i["name"] for i in disks["items"]] == ["pricey", "cheap"]


# ── Why the cost column is empty ───────────────────────────────────────────
#
# An empty cost column has two causes that look identical on screen and mean
# opposite things: Cost Management refused to answer, or it answered and there
# was nothing billed. The first means "look again later", the second means the
# findings can be acted on. The endpoint has to say which.

@pytest.mark.asyncio
async def test_a_failed_billing_query_is_reported_not_swallowed(monkeypatch):
    from routers import orphaned as router_module

    async def refuse(**kwargs):
        raise PermissionError("Cost Management Reader is not assigned")

    async def no_findings(token, subs, cost_index=None):
        return {"categories": [], "total_count": 0, "total_monthly_cost": 0.0, "errors": []}

    async def fake_token(*a, **k):
        return "tok"

    monkeypatch.setattr(router_module, "query_costs", refuse)
    monkeypatch.setattr(router_module, "find_orphaned_resources", no_findings)
    monkeypatch.setattr(router_module, "resolve_tenant_token", fake_token)
    monkeypatch.setattr(router_module, "subscription_names", lambda *a: {"s1": "Production"})

    body = OrphanedRequest(tenant_id="t", subscription_ids=["s1"])
    result = await router_module.get_orphaned_resources(body, {"id": 1}, None)

    assert len(result.cost_errors) == 1
    # Named, because a GUID does not tell the reader which subscription to fix.
    assert result.cost_errors[0]["subscription_name"] == "Production"
    assert result.priced_count == 0
    assert result.cost_month == ""


@pytest.mark.asyncio
async def test_a_billing_query_that_answers_with_nothing_reports_no_error(monkeypatch):
    from routers import orphaned as router_module

    async def empty(**kwargs):
        return []

    async def no_findings(token, subs, cost_index=None):
        return {"categories": [], "total_count": 0, "total_monthly_cost": 0.0, "errors": []}

    async def fake_token(*a, **k):
        return "tok"

    monkeypatch.setattr(router_module, "query_costs", empty)
    monkeypatch.setattr(router_module, "find_orphaned_resources", no_findings)
    monkeypatch.setattr(router_module, "resolve_tenant_token", fake_token)
    monkeypatch.setattr(router_module, "subscription_names", lambda *a: {})

    body = OrphanedRequest(tenant_id="t", subscription_ids=["s1"])
    result = await router_module.get_orphaned_resources(body, {"id": 1}, None)

    assert result.cost_errors == []
    assert result.priced_count == 0


@pytest.mark.asyncio
async def test_a_monthly_cost_is_one_month_of_the_two_that_were_fetched(monkeypatch):
    from routers import orphaned as router_module

    async def two_months(**kwargs):
        return [
            {"ResourceId": "/s/disk1", "BillingMonth": "20260701",
             "PreTaxCost": 100.0, "ServiceName": "Storage", "Meter": "P10",
             "Currency": "INR"},
            {"ResourceId": "/s/disk1", "BillingMonth": "20260801",
             "PreTaxCost": 120.0, "ServiceName": "Storage", "Meter": "P10",
             "Currency": "INR"},
        ]

    seen = {}

    async def capture(token, subs, cost_index=None):
        seen["index"] = cost_index
        return {"categories": [], "total_count": 0, "total_monthly_cost": 0.0, "errors": []}

    async def fake_token(*a, **k):
        return "tok"

    monkeypatch.setattr(router_module, "query_costs", two_months)
    monkeypatch.setattr(router_module, "find_orphaned_resources", capture)
    monkeypatch.setattr(router_module, "resolve_tenant_token", fake_token)
    monkeypatch.setattr(router_module, "subscription_names", lambda *a: {})

    body = OrphanedRequest(tenant_id="t", subscription_ids=["s1"])
    result = await router_module.get_orphaned_resources(body, {"id": 1}, None)

    # August, not 220 -- the sum of the window would be double a month's cost.
    assert seen["index"]["/s/disk1"]["cost"] == 120.0
    assert result.cost_month == "2026-08"
    assert result.cost_partial is False
    assert result.priced_count == 1
    assert result.currency == "INR"


# ── Structured evidence ────────────────────────────────────────────────────
#
# The projected Graph columns used to be squashed into one free-text line and
# then dropped. Keeping them structured is what lets the detail panel show why
# a finding is a finding, so these tests pin that they survive the round trip
# and that nothing is invented to fill a gap.

from services.orphaned import _evidence, _age_days, INVENTORY  # noqa: E402


class TestEvidence:
    def test_projected_columns_are_kept_with_readable_labels(self):
        out = _evidence({"sizeGb": 128, "skuName": "Premium_LRS"})
        assert out == {"Size (GB)": 128, "SKU": "Premium_LRS"}

    def test_absent_columns_are_dropped_rather_than_shown_blank(self):
        # A row reading "SKU: " looks like missing data about the resource
        # rather than a column this rule never projected.
        out = _evidence({"sizeGb": 8, "skuName": None, "vmSize": ""})
        assert out == {"Size (GB)": 8}

    def test_a_genuine_zero_is_kept(self):
        assert _evidence({"workers": 0}) == {"Instances": 0}

    def test_unknown_columns_are_ignored(self):
        assert _evidence({"somethingElse": "x"}) == {}

    def test_an_empty_row_yields_nothing(self):
        assert _evidence({}) == {}


class TestAgeDays:
    def test_it_reads_the_age_the_query_computed(self):
        assert _age_days({"ageDays": 115}) == 115

    def test_it_accepts_a_string_from_the_json_payload(self):
        assert _age_days({"ageDays": "115"}) == 115

    def test_it_returns_none_when_the_rule_did_not_compute_one(self):
        # Azure does not record when a resource became detached, so any number
        # here for the other rules would be invented.
        assert _age_days({}) is None
        assert _age_days({"ageDays": None}) is None
        assert _age_days({"ageDays": ""}) is None

    def test_garbage_does_not_become_a_number(self):
        assert _age_days({"ageDays": "soon"}) is None


class TestItemShape:
    @pytest.mark.asyncio
    async def test_findings_carry_their_rule_and_evidence(self, monkeypatch):
        async def fake_query(token, subs, query):
            if "diskState" not in query:
                return []
            return [{
                "id": "/subscriptions/s1/rg/a/disks/d1",
                "name": "d1",
                "type": "microsoft.compute/disks",
                "resourceGroup": "rg-a",
                "subscriptionId": "s1",
                "location": "eastus",
                "sizeGb": 128,
                "skuName": "Premium_LRS",
            }]

        monkeypatch.setattr(orphaned_module, "run_graph_query", fake_query)
        result = await find_orphaned_resources("t", ["s1"])

        found = [i for c in result["categories"] for i in c["items"]]
        assert len(found) == 1
        item = found[0]

        # Regrouping by subscription flattens the categories away, so the rule
        # has to travel on the item or the finding loses its meaning.
        assert item["rule"] == "unattached_disks"
        assert item["rule_title"]
        assert item["severity"] == "certain"
        assert item["reason"]
        assert item["evidence"] == {"Size (GB)": 128, "SKU": "Premium_LRS"}
        assert item["age_days"] is None

    @pytest.mark.asyncio
    async def test_every_finding_says_it_came_from_inventory(self, monkeypatch):
        """
        No rule reads a metric today.

        "Inventory-based" is a stronger claim than "we saw no traffic", and a
        future metrics rule must not inherit that credibility by default.
        """
        async def fake_query(token, subs, query):
            return [{"id": "/x", "name": "x", "subscriptionId": "s1"}]

        monkeypatch.setattr(orphaned_module, "run_graph_query", fake_query)
        result = await find_orphaned_resources("t", ["s1"])

        found = [i for c in result["categories"] for i in c["items"]]
        assert found
        assert all(i["method"] == INVENTORY for i in found)
