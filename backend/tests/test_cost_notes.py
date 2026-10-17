from unittest.mock import AsyncMock

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import HTTPException
from pydantic import ValidationError

from core import db as db_module
from routers import cost_notes as notes
from routers import costs


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / 'notes.db')
    monkeypatch.setattr(db_module, 'DB_PATH', path)
    await db_module.init_db()
    async with aiosqlite.connect(path) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("INSERT INTO users(id,azure_oid) VALUES(1,'one'),(2,'two'),(3,'three')")
        await conn.commit()
        yield conn


author = {'account_id': 1, 'actor_id': 1, 'name': 'Asha', 'can_administer': False}
colleague = {'account_id': 1, 'actor_id': 3, 'name': 'Ravi', 'can_administer': False}
admin = {'account_id': 1, 'actor_id': 2, 'name': 'Admin', 'can_administer': True}
outsider = {'account_id': 2, 'actor_id': 2, 'name': 'Other', 'can_administer': True}


async def listed(db, user, **kwargs):
    result = await notes.list_notes(tenant_id='t1', from_date='2026-10-01', to_date='2026-10-31', subscription_ids=kwargs.get('subs', []), user=user, db=db)
    return result['notes']


@pytest.mark.asyncio
async def test_notes_are_dated_scoped_and_editable_only_by_author_or_admin(db):
    first = await notes.create_note(notes.NoteInput(tenant_id='t1', note_date='2026-10-12', body='  Scaled AKS for load test  '), author, db)
    assert first['body'] == 'Scaled AKS for load test' and first['author_name'] == 'Asha' and first['can_edit']
    await notes.create_note(notes.NoteInput(tenant_id='t1', subscription_id='sub-b', note_date='2026-10-13', body='Sub B only'), author, db)
    await notes.create_note(notes.NoteInput(tenant_id='t1', note_date='2026-11-01', body='Next month'), author, db)

    assert [n['body'] for n in await listed(db, colleague)] == ['Scaled AKS for load test', 'Sub B only']
    assert [n['body'] for n in await listed(db, colleague, subs=['sub-a'])] == ['Scaled AKS for load test']
    assert await listed(db, outsider) == []
    assert (await listed(db, colleague))[0]['can_edit'] is False

    with pytest.raises(HTTPException) as denied:
        await notes.update_note(first['id'], notes.NoteUpdate(body='hijack'), colleague, db)
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as missing:
        await notes.delete_note(first['id'], outsider, db)
    assert missing.value.status_code == 404

    updated = await notes.update_note(first['id'], notes.NoteUpdate(body='Load test done', color='orange'), admin, db)
    assert updated['body'] == 'Load test done' and updated['color'] == 'orange'
    await notes.delete_note(first['id'], author, db)
    assert [n['body'] for n in await listed(db, author)] == ['Sub B only']


@pytest.mark.asyncio
async def test_note_validation(db):
    with pytest.raises(ValidationError):
        notes.NoteInput(tenant_id='t1', note_date='16-10-2026', body='x')
    with pytest.raises(ValidationError):
        notes.NoteInput(tenant_id='t1', note_date='2026-10-16', body='   ')
    with pytest.raises(ValidationError):
        notes.NoteInput(tenant_id='t1', note_date='2026-10-16', body='x', color='black')
    with pytest.raises(HTTPException):
        await notes.list_notes(tenant_id='t1', from_date='2026-10-31', to_date='2026-10-01', subscription_ids=[], user=author, db=db)


@pytest.mark.asyncio
async def test_day_resources_groups_by_resource_and_keeps_unattributed(monkeypatch):
    calls = []

    async def query(**kwargs):
        calls.append(kwargs)
        rid = '/subscriptions/s1/resourceGroups/rg-web/providers/Microsoft.Web/sites/shop'
        return [
            {'PreTaxCost': 10.5, 'ResourceId': rid, 'ServiceName': 'Azure App Service', 'UsageDate': 20261012, 'Currency': 'INR'},
            {'PreTaxCost': 2.0, 'ResourceId': rid.upper(), 'ServiceName': 'Bandwidth', 'UsageDate': 20261012, 'Currency': 'INR'},
            {'PreTaxCost': 4.0, 'ResourceId': '', 'ServiceName': 'Azure Support', 'UsageDate': 20261012, 'Currency': 'INR'},
            {'PreTaxCost': 0.0, 'ResourceId': '/x/zero', 'ServiceName': 'Storage', 'UsageDate': 20261012, 'Currency': 'INR'},
        ]

    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    monkeypatch.setattr(costs, 'query_costs', query)
    monkeypatch.setattr(costs, 'subscription_names', lambda tenant, token: {'s1': 'Production'})
    result = await costs.get_day_resources(costs.DayResourcesRequest(tenant_id='t', subscription_ids=['s1'], date='2026-10-12'), {}, None)

    assert calls[0]['from_date'] == calls[0]['to_date'] == '2026-10-12'
    assert result['total'] == 16.5 and result['currency'] == 'INR'
    shop, support = result['resources']
    assert shop['resource_name'] == 'shop' and shop['cost'] == 12.5 and shop['resource_group'] == 'rg-web'
    assert shop['services'] == ['Azure App Service', 'Bandwidth'] and shop['subscription_name'] == 'Production'
    assert support['resource_name'] == 'Unattributed charges' and support['cost'] == 4.0


@pytest.mark.asyncio
async def test_resource_groups_lists_resources_with_pricing_tags(monkeypatch):
    rid = '/subscriptions/s1/resourceGroups/rg-sap/providers/Microsoft.Compute/virtualMachines/hana'

    async def query(**kwargs):
        assert kwargs['group_by'] == ['ResourceId', 'ServiceName', 'PricingModel']
        return [
            {'PreTaxCost': 100, 'ResourceId': rid, 'ServiceName': 'Virtual Machines', 'PricingModel': 'Reservation', 'Currency': 'INR'},
            {'PreTaxCost': 20, 'ResourceId': rid, 'ServiceName': 'Virtual Machines', 'PricingModel': 'OnDemand', 'Currency': 'INR'},
            {'PreTaxCost': 5, 'ResourceId': '/subscriptions/s1/resourceGroups/RG-SAP/providers/Microsoft.RecoveryServices/vaults/v', 'ServiceName': 'Azure Site Recovery', 'PricingModel': 'OnDemand', 'Currency': 'INR'},
            {'PreTaxCost': 9, 'ResourceId': '', 'ServiceName': 'Azure Support', 'PricingModel': 'OnDemand', 'Currency': 'INR'},
        ]

    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    monkeypatch.setattr(costs, 'query_costs', query)
    monkeypatch.setattr(costs, 'subscription_names', lambda tenant, token: {'s1': 'Prod'})
    result = await costs.get_resource_group_resources(costs.GroupResourcesRequest(tenant_id='t', subscription_ids=['s1']), {}, None)

    assert result['total'] == 134
    sap, none = result['groups']
    assert sap['name'] == 'rg-sap' and sap['cost'] == 125 and sap['types'] == ['ri', 'payg', 'asr'] and sap['resource_count'] == 2
    assert sap['resources'][0] == {**sap['resources'][0], 'name': 'hana', 'cost': 120, 'types': ['ri', 'payg']}
    assert none['name'] == 'No resource group' and none['subscription_level'] and none['subscription_name'] == 'Prod'


@pytest.mark.asyncio
async def test_daily_split_by_pricing_model_and_resource_group(monkeypatch):
    async def query(**kwargs):
        dim = kwargs['group_by'][0]
        return [{'PreTaxCost': 3, 'UsageDate': 20261001, dim: 'Reservation' if dim == 'PricingModel' else 'rg-a', 'Currency': 'INR'},
                {'PreTaxCost': 2, 'UsageDate': 20261001, dim: 'OnDemand' if dim == 'PricingModel' else '', 'Currency': 'INR'}]

    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    monkeypatch.setattr(costs, 'query_costs', query)
    monkeypatch.setattr(costs, 'subscription_names', lambda tenant, token: {})
    pm = await costs.get_daily_split(costs.DailySplitRequest(tenant_id='t', subscription_ids=['s'], split_by='pricing_model'), {}, None)
    assert pm['days'] == [{'date': '2026-10-01', 'total': 5, 'split': {'Reserved (RI)': 3, 'Pay-as-you-go': 2}}]
    rg = await costs.get_daily_split(costs.DailySplitRequest(tenant_id='t', subscription_ids=['s'], split_by='resource_group'), {}, None)
    assert rg['days'][0]['split'] == {'rg-a': 3, 'No resource group': 2}


@pytest.mark.asyncio
async def test_billing_category_returns_partial_zero_when_some_subscriptions_fail(monkeypatch):
    async def query(**kwargs):
        if kwargs['subscription_id'] == 'slow':
            raise TimeoutError('Azure did not answer in time')
        return []

    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    monkeypatch.setattr(costs, 'query_costs', query)
    result = await costs.get_billing_category(costs.BillingCategoryRequest(tenant_id='t', subscription_ids=['ok', 'slow'], category='ri'), {}, None)
    assert result['total'] == 0 and result['coverage']['partial'] is True and len(result['errors']) == 1
    with pytest.raises(HTTPException):
        await costs.get_billing_category(costs.BillingCategoryRequest(tenant_id='t', subscription_ids=['slow'], category='ri'), {}, None)


@pytest.mark.asyncio
async def test_billing_category_daily_rows_carry_their_date(monkeypatch):
    seen = {}

    async def query(**kwargs):
        seen.update(kwargs)
        return [{'PreTaxCost': 4, 'UsageDate': 20261012, 'ResourceId': '/subscriptions/s/resourceGroups/rg/providers/x/y/vm', 'ServiceName': 'Virtual Machines', 'Meter': 'D2s v5', 'Currency': 'INR'}]

    monkeypatch.setattr(costs, 'resolve_tenant_token', AsyncMock(return_value='token'))
    monkeypatch.setattr(costs, 'query_costs', query)
    result = await costs.get_billing_category(costs.BillingCategoryRequest(tenant_id='t', subscription_ids=['s'], category='payg', granularity='Daily'), {}, None)
    assert seen['granularity'] == 'Daily' and seen['filters'] == {'PricingModel': 'OnDemand'}
    assert result['rows'][0]['date'] == '2026-10-12' and result['total'] == 4


def test_hiding_security_findings_is_admin_only():
    from auth.dependencies import require_workspace_admin
    from routers import security
    for route in security.router.routes:
        if route.path.endswith('/access-ignores') and route.methods & {'POST', 'DELETE'}:
            calls = [d.call for d in route.dependant.dependencies]
            assert require_workspace_admin in calls, route.methods
