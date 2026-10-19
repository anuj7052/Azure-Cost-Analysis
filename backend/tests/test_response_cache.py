from unittest.mock import AsyncMock

import pytest

from services import response_cache as rc


@pytest.mark.asyncio
async def test_second_identical_request_is_served_from_cache_and_refresh_bypasses_it():
    calls = []

    @rc.cached_endpoint('demo', ttl=60)
    async def handler(body, current_user):
        calls.append(body)
        return {'value': len(calls), 'coverage': {'partial': False}}

    user = {'account_id': 1, 'actor_id': 7}
    assert (await handler({'a': 1}, user))['value'] == 1
    assert (await handler({'a': 1}, user))['value'] == 1
    assert len(calls) == 1

    token = rc.refresh_requested.set(True)
    try:
        assert (await handler({'a': 1}, user))['value'] == 2
    finally:
        rc.refresh_requested.reset(token)
    assert (await handler({'a': 1}, user))['value'] == 2


@pytest.mark.asyncio
async def test_keys_separate_people_and_requests_and_partial_answers_are_not_kept():
    produce = AsyncMock(side_effect=lambda: {'errors': [{'subscription_id': 's'}]})

    @rc.cached_endpoint('demo2', ttl=60)
    async def handler(body, current_user):
        return await produce()

    await handler({'a': 1}, {'account_id': 1, 'actor_id': 1})
    await handler({'a': 1}, {'account_id': 1, 'actor_id': 1})
    assert produce.await_count == 2  # partial → never cached
    assert rc.make_key('x', {'account_id': 1, 'actor_id': 1}, {'a': 1}) != rc.make_key('x', {'account_id': 1, 'actor_id': 2}, {'a': 1})
    assert rc.make_key('x', {'account_id': 1, 'actor_id': 1}, {'a': 1}) != rc.make_key('x', {'account_id': 1, 'actor_id': 1}, {'a': 2})


def test_settled_periods_live_longer():
    assert rc.ttl_for({'to_date': '2020-01-31'}) == rc.SETTLED_TTL
    assert rc.ttl_for({}) == rc.OPEN_TTL
