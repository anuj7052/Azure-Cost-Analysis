import pytest
from fastapi import HTTPException

from routers import billing as customer_routes, billing_ledger as ledger_routes, billing_services as routes
from tests.test_billing_ledger import db  # noqa: F401  (fixture)

USER = {'account_id': 1, 'user_id': 'one', 'actor_id': 1, 'email': 'a@b.c'}


class FakeUpload:
    def __init__(self, name, data):
        self.filename, self._data = name, data

    async def read(self, n=-1):
        return self._data


@pytest.fixture
def store(monkeypatch):
    blobs = {}

    async def upload(owner, customer, period, kind, filename, content):
        path = f'workspace-{owner}/customer-{customer}/{period}/{kind}/{filename}'
        blobs[path] = content
        return {'id': path}

    async def download(owner, customer, path):
        return blobs[path]

    async def delete(owner, customer, path):
        blobs.pop(path, None)

    monkeypatch.setattr(routes.blob, 'upload', upload)
    monkeypatch.setattr(routes.blob, 'download', download)
    monkeypatch.setattr(routes.blob, 'delete', delete)
    return blobs


@pytest.mark.asyncio
async def test_service_trail_with_po_files_and_notes(db, store):  # noqa: F811
    c = await customer_routes.create_customer(customer_routes.CustomerInput(name='Trail Co'), USER, db)
    w = await ledger_routes.create_workload(c['id'], ledger_routes.WorkloadInput(name='Prod'), USER, db)
    s = await routes.create_service(c['id'], routes.ServiceInput(workload_id=w['id'], name='Azure SQL', po_number='PO-77', po_date='2026-06-01', boq_ref='BOQ v2 line 4', activated_on='2026-06-05', monthly_cost='12000'), USER, db)
    f = await routes.upload_service_file(s['id'], 'po', FakeUpload('po.pdf', b'%PDF'), USER, db)
    n = await routes.add_note(s['id'], routes.NoteInput(body='Activated after customer email approval'), USER, db)
    listed = (await routes.list_services(c['id'], USER, db))['items'][0]
    assert listed['po_number'] == 'PO-77' and listed['monthly_cost'] == '12000'
    assert [x['id'] for x in listed['files']] == [f['id']] and listed['notes'][0]['author'] == 'a@b.c'
    assert (await routes.download_service_file(f['id'], USER, db)).body == b'%PDF'
    # Subscription with service documents cannot be silently deleted.
    with pytest.raises(HTTPException) as err:
        await ledger_routes.delete_permanently('workload', w['id'], '', USER, db)
    assert err.value.status_code == 409
    await routes.delete_note(n['id'], USER, db)
    assert (await routes.delete_service(s['id'], USER, db))['deleted'] and not store
    assert (await routes.list_services(c['id'], USER, db))['items'] == []


@pytest.mark.asyncio
async def test_service_must_use_customers_own_subscription(db, store):  # noqa: F811
    a = await customer_routes.create_customer(customer_routes.CustomerInput(name='A'), USER, db)
    b = await customer_routes.create_customer(customer_routes.CustomerInput(name='B'), USER, db)
    wb = await ledger_routes.create_workload(b['id'], ledger_routes.WorkloadInput(name='B sub'), USER, db)
    with pytest.raises(HTTPException) as err:
        await routes.create_service(a['id'], routes.ServiceInput(workload_id=wb['id'], name='X'), USER, db)
    assert err.value.status_code == 422
    with pytest.raises(HTTPException):
        await routes.upload_service_file('nope', 'po', FakeUpload('a.exe', b'x'), USER, db)
