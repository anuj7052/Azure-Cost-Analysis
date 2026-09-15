"""Route fan-out must overlap subscriptions and preserve incomplete coverage."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from routers import costs
from models.schemas import CostQueryRequest, DailyCostRequest, RgCostRequest


@pytest.mark.parametrize('handler,model', [
    (costs.get_costs, CostQueryRequest),
    (costs.get_daily_costs, DailyCostRequest),
    (costs.get_rg_costs, RgCostRequest),
])
def test_cost_routes_overlap_subscriptions(monkeypatch, handler, model):
    async def run():
        entered = set()
        both = asyncio.Event()

        async def query(**kwargs):
            entered.add(kwargs['subscription_id'])
            if len(entered) == 2:
                both.set()
            # A sequential route cannot release this barrier. No real Azure calls.
            await asyncio.wait_for(both.wait(), timeout=0.5)
            return []

        monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
        monkeypatch.setattr(costs, 'query_costs', query)
        response = await handler(model(tenant_id='t', subscription_ids=['a', 'b']), {}, None)
        assert response.coverage.succeeded_subscriptions == 2
        assert response.coverage.partial is False

    asyncio.run(run())


def test_daily_partial_result_reports_failed_subscription(monkeypatch):
    async def run():
        monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
        monkeypatch.setattr(costs, 'gather_by_subscription', AsyncMock(return_value=(
            [{'UsageDate': 20260901, 'PreTaxCost': 12, 'Currency': 'USD', 'ServiceName': 'Storage'}],
            [{'subscription_id': 'b', 'error': 'Forbidden', 'retryable': False}],
        )))
        response = await costs.get_daily_costs(
            DailyCostRequest(tenant_id='t', subscription_ids=['a', 'b']), {}, None,
        )
        assert response.total == 12
        assert response.coverage.partial is True
        assert response.coverage.failed_subscriptions == ['b']

    asyncio.run(run())
