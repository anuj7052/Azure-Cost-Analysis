from unittest.mock import AsyncMock
import pytest
from services.analysis import aggregate_daily, aggregate_by_month, build_summary
from services.reservation_context import reservation_context
from models.schemas import DailyCostRequest
from routers import costs


def record(cost, model='Reservation', charge='Usage', service='Virtual Machines'):
    return dict(PreTaxCost=cost, PricingModel=model, ChargeType=charge, ServiceName=service,
                UsageDate=20260801, Currency='INR', SubscriptionId='sub')


def test_purchase_evidence_does_not_change_totals():
    rows = [record(5000, charge='Purchase'), record(0), record(80, model='OnDemand')]
    daily = aggregate_daily(rows)['2026-08-01']
    assert daily['total'] == 5080
    assert daily['reservation_context']['Virtual Machines']['purchase_cost'] == 5000
    monthly = build_summary(aggregate_by_month(rows))['months'][0]
    assert monthly['total_cost'] == 5080
    assert monthly['reservation_context'] == daily['reservation_context']


def test_never_infers_ri_from_expensive_service_name():
    assert reservation_context([record(50000, model='OnDemand', service='RI Virtual Machines')]) == {}
    assert reservation_context([record(0)])['Virtual Machines']['purchase_cost'] == 0
    assert reservation_context([record(-50, charge='Refund')])['Virtual Machines']['refund_cost'] == -50


@pytest.mark.asyncio
async def test_group_filter_keeps_three_billing_dimensions(monkeypatch):
    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    query = AsyncMock(return_value=[record(5000, charge='Purchase')])
    monkeypatch.setattr(costs, 'query_costs', query)
    response = await costs.get_daily_costs(DailyCostRequest(tenant_id='t', subscription_ids=['sub'], resource_group='rg', include_reservation_context=True), {}, None)
    assert query.call_args.kwargs['group_by'] == ['ServiceName', 'PricingModel', 'ChargeType']
    assert query.call_args.kwargs['filters'] == {'ResourceGroupName': 'rg'}
    assert response.total == 5000
    assert response.days[0].reservation_context['Virtual Machines']['purchase_cost'] == 5000
