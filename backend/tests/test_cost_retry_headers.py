import httpx
import pytest
from services import cost_client


def test_all_cost_quotas_are_respected():
    response = httpx.Response(429, headers={
        'Retry-After': '1',
        'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after': '4',
        'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after': '60',
        'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after': '30',
    })
    assert cost_client._retry_delay(response, 0) == 60


@pytest.mark.asyncio
async def test_long_server_cooldown_is_not_retried_early(monkeypatch):
    from unittest.mock import AsyncMock
    monkeypatch.setattr(cost_client, '_throttled_until', {})
    monkeypatch.setattr(cost_client, '_pace_wait', lambda scope: 0)
    client = AsyncMock()
    client.post.return_value = httpx.Response(429, headers={'Retry-After': '120'}, request=httpx.Request('POST', 'https://example.com'))
    with pytest.raises(cost_client.RateLimited):
        await cost_client._post_query_serial(client, 'https://example.com', {}, {}, 'test-scope')
    client.post.assert_awaited_once()
    assert cost_client._cooldown_remaining('test-scope') > 119
