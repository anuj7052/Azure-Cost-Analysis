"""
Orphaned resource detection.

The risk this feature carries is a false positive: telling someone a disk is
unused when it is not. So the tests pin the shape of the output and, more
importantly, that a failing rule degrades to a partial result instead of
either failing the scan or silently reporting "nothing found".
"""
from __future__ import annotations

import pytest

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

    monkeypatch.setattr(orphaned_module, "_run_graph_query", fake_query)

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

    monkeypatch.setattr(orphaned_module, "_run_graph_query", flaky)

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

    monkeypatch.setattr(orphaned_module, "_run_graph_query", one_disk)

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

    monkeypatch.setattr(orphaned_module, "_run_graph_query", many)

    result = await find_orphaned_resources(
        "tok", ["s1"], {"/s/cheap": {"cost": 5.0}, "/s/pricey": {"cost": 900.0}}
    )
    disks = next(c for c in result["categories"] if c["key"] == "unattached_disks")

    assert [i["name"] for i in disks["items"]] == ["pricey", "cheap"]
