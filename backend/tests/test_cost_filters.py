from unittest.mock import AsyncMock
import pytest
from services import cost_client
from routers import costs
from models.schemas import CostQueryRequest
from models.schemas import ServiceResourceRequest


@pytest.mark.asyncio
async def test_intersecting_filters_are_sent_to_azure(monkeypatch):
    query = AsyncMock(return_value=[])
    monkeypatch.setattr(cost_client, '_query_months', query)
    await cost_client.query_costs('token', 'sub', from_date='2026-08-15', to_date='2026-08-20',
        filters={'ServiceName': 'Bandwidth', 'ResourceGroupName': 'SAP', 'ResourceLocation': 'centralindia'})
    body = query.call_args.args[2]
    assert body['timePeriod']['from'].startswith('2026-08-15')
    assert body['timePeriod']['to'].startswith('2026-08-20')
    assert body['dataset']['filter'] == {'and': [
        {'dimensions': {'name': key, 'operator': 'In', 'values': [value]}}
        for key, value in [('ServiceName', 'Bandwidth'), ('ResourceGroupName', 'SAP'), ('ResourceLocation', 'centralindia')]
    ]}


@pytest.mark.asyncio
async def test_single_filter_does_not_use_one_element_and(monkeypatch):
    query = AsyncMock(return_value=[])
    monkeypatch.setattr(cost_client, '_query_months', query)
    await cost_client.query_costs('token', 'sub', from_date='2026-08-01', to_date='2026-08-31', filters={'ServiceName': 'Storage'})
    assert query.call_args.args[2]['dataset']['filter']['dimensions']['values'] == ['Storage']


@pytest.mark.asyncio
async def test_route_passes_filters_and_subscription_scope(monkeypatch):
    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    query = AsyncMock(return_value=[])
    monkeypatch.setattr(costs, 'query_costs', query)
    result = await costs.get_costs(CostQueryRequest(tenant_id='t', subscription_ids=['selected'], service='Bandwidth', resource_group='SAP'), {}, None)
    assert query.call_args.kwargs['subscription_id'] == 'selected'
    assert query.call_args.kwargs['filters'] == {'ServiceName': 'Bandwidth', 'ResourceGroupName': 'SAP'}
    assert result.coverage.succeeded_subscriptions == 1


@pytest.mark.asyncio
async def test_resource_drill_retains_identity_and_range(monkeypatch):
    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    rid = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm'
    query = AsyncMock(return_value=[{'ResourceId': rid, 'ServiceName': 'Virtual Machines', 'BillingMonth': '20260801', 'PreTaxCost': 12}])
    monkeypatch.setattr(costs, 'query_costs', query)
    result = await costs.get_service_resources(ServiceResourceRequest(tenant_id='t', subscription_ids=['sub'], service='Virtual Machines', resource_group='rg', from_date='2026-07-01', to_date='2026-09-14'), {}, None)
    assert result.rows[0].resource_id == rid
    assert result.rows[0].subscription_id == 'sub'
    assert query.call_args.kwargs['from_date'] == '2026-07-01'
    assert query.call_args.kwargs['filters']['ResourceGroupName'] == 'rg'
