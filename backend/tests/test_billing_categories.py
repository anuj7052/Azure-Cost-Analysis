from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from routers import costs
from services.billing_categories import category_detail, is_site_recovery


@pytest.mark.parametrize("service,meter,expected", [
    ("Azure Site Recovery", "Protected instance", True),
    ("Recovery Services", "ASR protected instances", True),
    ("Backup", "GRS storage", False),
    ("Virtual Machines", "DR VM", False),
    ("Storage", "Disaster recovery disk", False),
    ("Storage", "ASRReplica", False),
])
def test_asr_needs_explicit_billing_evidence(service, meter, expected):
    assert is_site_recovery({"ServiceName": service, "Meter": meter}) is expected


def test_detail_preserves_zero_ri_refunds_and_unattributed_purchases():
    records = [
        {"ServiceName": "VM", "ResourceId": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm", "Cost": 0, "UsageDate": 20260901, "Currency": "INR"},
        {"ServiceName": "VM", "Cost": 100, "UsageDate": 20260901, "Currency": "INR"},
        {"ServiceName": "VM", "PreTaxCost": -20, "UsageDate": 20260901, "Currency": "INR"},
    ]
    result = category_detail(records, "ri")
    assert result["total"] == 80
    assert len(result["rows"]) == 3
    assert result["resource_count"] == 1
    assert result["unattributed_cost"] == 80
    assert result["months"] == ["2026-09"]
    assert next(row for row in result["rows"] if row["resource_id"])["resource_group"] == "rg"


def test_asr_excludes_backup_and_currency_totals_cannot_be_mixed():
    result = category_detail([{"ServiceName": "Azure Site Recovery", "Cost": 5}, {"ServiceName": "Backup", "Cost": 99}], "asr")
    assert result["total"] == 5
    with pytest.raises(ValueError, match="different billing currencies"):
        category_detail([{"Currency": "USD"}, {"Currency": "INR"}], "payg")


@pytest.mark.asyncio
@pytest.mark.parametrize("category,filters", [("payg", {"PricingModel": "OnDemand"}), ("ri", {"PricingModel": "Reservation"}), ("asr", {})])
async def test_endpoint_applies_model_filter_at_azure_and_preserves_scope(monkeypatch, category, filters):
    monkeypatch.setattr(costs, "resolve_tenant_token", AsyncMock(return_value="test-token"))
    query = AsyncMock(return_value=[{"ServiceName": "Azure Site Recovery", "Cost": 12, "Currency": "USD"}])
    monkeypatch.setattr(costs, "query_costs", query)
    request = costs.BillingCategoryRequest(tenant_id="t", subscription_ids=["s"], category=category, from_date="2026-09-01", to_date="2026-09-30")
    result = await costs.get_billing_category(request, {}, None)
    kwargs = query.call_args.kwargs
    assert kwargs["filters"] == filters
    assert kwargs["group_by"] == ["ResourceId", "ServiceName", "Meter"]
    assert kwargs["from_date"] == "2026-09-01"
    assert result["rows"][0]["subscription_id"] == "s"
    assert result["total"] == 12


@pytest.mark.asyncio
async def test_failures_never_fall_back_to_unfiltered_costs(monkeypatch):
    monkeypatch.setattr(costs, "resolve_tenant_token", AsyncMock(return_value="test-token"))
    query = AsyncMock(side_effect=RuntimeError("PricingModel unsupported"))
    monkeypatch.setattr(costs, "query_costs", query)
    with pytest.raises(HTTPException) as exc:
        await costs.get_billing_category(costs.BillingCategoryRequest(tenant_id="t", subscription_ids=["s"]), {}, None)
    assert exc.value.status_code == 502
    assert query.await_count == 1


def test_unknown_category_is_rejected():
    with pytest.raises(ValidationError):
        costs.BillingCategoryRequest(tenant_id="t", subscription_ids=["s"], category="all")


@pytest.mark.asyncio
async def test_partial_subscription_result_is_labelled(monkeypatch):
    monkeypatch.setattr(costs, "resolve_tenant_token", AsyncMock(return_value="test-token"))

    async def query(**kwargs):
        if kwargs["subscription_id"] == "missing":
            raise RuntimeError("Subscription unavailable")
        return [{"ServiceName": "VM", "Cost": 3, "Currency": "USD"}]

    monkeypatch.setattr(costs, "query_costs", query)
    result = await costs.get_billing_category(costs.BillingCategoryRequest(tenant_id="t", subscription_ids=["working", "missing"]), {}, None)
    assert result["total"] == 3
    assert result["coverage"]["partial"] is True
    assert result["errors"][0]["subscription_id"] == "missing"
