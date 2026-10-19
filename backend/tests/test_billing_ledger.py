import csv
import io

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import HTTPException

from core import db as db_module
from services import billing_ledger as ledger
from routers import billing_ledger as routes


def source(rows):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['Company Name', 'Details'] + [''] * 8 + ['April', '', '', '', 'May', '', '', ''])
    writer.writerow(['', 'Workload', 'PO ID', 'PO Date', 'Period Start', 'Period End', 'Frequency', 'Plan Name', 'Requirement ID', 'Distributor'] + ['Invoice ID', 'Amount', 'Redingtone Bill', 'Payment Status'] * 2)
    writer.writerows(rows)
    return output.getvalue().encode('utf-8-sig')


def test_inherits_company_preserves_notes_and_does_not_guess_shifted_amounts():
    content = source([
        ['Example Ltd', 'VM', '', '', '', '', 'Monthly', 'Plan', '', 'Supplier', 'INV-1', '₹1,23,456.78', '100.00', 'Done - TDS', '', '', '', ''],
        ['', 'DR VM', '', '', '', '', '', '', '', '', '', 'RI', '2,345.67', '', '', '', '', ''],
        ['Other Ltd', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ])
    data = ledger.parse_csv(content, 2026)
    assert data['company_count'] == 2 and data['workload_count'] == 3
    assert len(data['companies'][0]['workloads']) == 2
    entry = data['companies'][0]['workloads'][0]['entries'][0]
    assert entry['customer_amount'] == '123456.78'
    assert entry['payment_status'] == 'Done - TDS'
    assert entry['amount_basis'] == 'unspecified'
    ambiguous = data['companies'][0]['workloads'][1]['entries'][0]
    assert ambiguous['status'] == 'needs_review'
    assert ambiguous['customer_amount'] is None and ambiguous['distributor_amount'] is None
    assert ambiguous['raw_cells']['distributor'] == '2,345.67'
    assert data['companies'][1]['workloads'][0]['entries'][0]['customer_amount'] is None


@pytest.mark.parametrize('value,expected', [('₹1,23,456.78', '123456.78'), ('1,234,567.00', '1234567.00'), ('0', '0'), ('', None), ('-10.20', '-10.20')])
def test_money(value, expected):
    assert ledger.money(value) == expected


def test_no_inferred_profit_for_gross_unknown_missing_or_review_costs():
    row = {'period': '2026-04', 'currency': 'INR', 'customer_amount': '100', 'distributor_amount': '80', 'usage_amount': None, 'amount_basis': 'unspecified', 'status': 'recorded'}
    assert ledger.month_totals([row])[0]['profit'] is None
    row['amount_basis'] = 'net'
    assert ledger.month_totals([row])[0]['profit'] == '20'
    assert ledger.month_totals([row, {**row, 'distributor_amount': None}])[0]['profit'] is None
    assert ledger.month_totals([{**row, 'status': 'needs_review'}])[0]['customer_amount'] is None


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / 'ledger.db')
    monkeypatch.setattr(db_module, 'DB_PATH', path)
    await db_module.init_db()
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("INSERT INTO users(id,azure_oid) VALUES(1,'one'),(2,'two')")
        await db.commit()
        yield db


@pytest.mark.asyncio
async def test_import_crud_idempotency_isolation_and_new_year(db):
    content = source([['Example', 'VM'] + [''] * 8 + ['INV', '100.00', '80.00', 'Done']])
    preview = ledger.parse_csv(content, 2026)
    result = await ledger.commit_import(db, 1, 'one', preview, 'test.csv', 'blob/path')
    duplicate = await ledger.commit_import(db, 1, 'one', preview, 'test.csv', 'blob/path')
    assert duplicate['duplicate']
    customer = result['customer_ids'][0]
    profile = await ledger.customer_ledger(db, 1, customer)
    entry = profile['entries'][0]
    user = {'account_id': 1, 'user_id': 'one'}
    body = routes.EntryInput(period=entry['period'], currency='INR', customer_amount='120', distributor_amount='80', amount_basis='net')
    await routes.update_entry(entry['id'], body, user, db)
    assert (await ledger.customer_ledger(db, 1, customer))['months'][0]['profit'] == '40'
    with pytest.raises(HTTPException) as exc:
        await routes.update_entry(entry['id'], body, user, db)
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        await routes.profile_ledger(customer, {'account_id': 2}, db)
    assert exc.value.status_code == 404
    await routes.archive('entry', entry['id'], user, db)
    assert (await ledger.customer_ledger(db, 1, customer))['months'][0]['period'] == '2026-05'
    await routes.restore('entry', entry['id'], user, db)
    assert (await ledger.customer_ledger(db, 1, customer))['months'][0]['profit'] == '40'
    history = await routes.history('entry', entry['id'], user, db)
    assert len(history['items']) == 3
    await ledger.commit_import(db, 1, 'one', ledger.parse_csv(content, 2027), 'test.csv', 'blob/path')
    assert len((await ledger.customer_ledger(db, 1, customer))['entries']) == 4


@pytest.mark.asyncio
async def test_revised_import_conflict_rolls_back_all_new_customers(db):
    initial = source([['Existing', 'VM'] + [''] * 8])
    await ledger.commit_import(db, 1, 'one', ledger.parse_csv(initial, 2026), 'a.csv', 'blob/a')
    changed = source([['New company', 'App'] + [''] * 8, ['Existing', 'VM'] + [''] * 8])
    with pytest.raises(HTTPException):
        await ledger.commit_import(db, 1, 'one', ledger.parse_csv(changed, 2026), 'b.csv', 'blob/b')
    assert await ledger.one(db, "SELECT id FROM billing_customers WHERE name='New company'", ()) is None


@pytest.mark.asyncio
async def test_simple_entry_flow_stores_distributor_per_month_and_lists_names(db):
    from routers import billing as customer_routes
    user = {'account_id': 1, 'user_id': 'one', 'actor_id': 1}
    customer = await customer_routes.create_customer(customer_routes.CustomerInput(name='Acme Ltd'), user, db)
    sub = await routes.create_workload(customer['id'], routes.WorkloadInput(name='Acme Prod'), user, db)
    assert sub['po_id'] == '' and sub['distributor'] == ''
    entry = await routes.create_entry(sub['id'], routes.EntryInput(period='2026-10', currency='INR', invoice_number='INV-9', customer_amount='1200', distributor_amount='900', distributor='Savex'), user, db)
    assert entry['distributor'] == 'Savex' and entry['invoice_number'] == 'INV-9'
    await routes.update_entry(entry['id'], routes.EntryInput(period='2026-10', currency='INR', customer_amount='1200', distributor_amount='950', distributor='Acme Distribution', revision=entry['revision']), user, db)
    names = (await routes.list_distributors(user, db))['distributors']
    assert names[:4] == ['Savex', 'Redington', 'Tata', 'Ingram'] and 'Acme Distribution' in names
    assert (await routes.list_distributors({'account_id': 2}, db))['distributors'] == ['Savex', 'Redington', 'Tata', 'Ingram']


@pytest.mark.asyncio
async def test_bulk_customer_import_is_idempotent_sets_owners_and_exports(db):
    from starlette.datastructures import UploadFile as StarletteUpload
    user = {'account_id': 1, 'user_id': 'one', 'actor_id': 1}
    csv_bytes = 'Customer,Subscription,Owner\nAcme,Acme Prod,Ravi\nAcme,Acme Dev,\nBeta,,\n=Evil,Sub,Asha\n'.encode()
    first = await routes.bulk_import_customers(StarletteUpload(io.BytesIO(csv_bytes), filename='c.csv'), user, db)
    assert first == {'rows': 4, 'customers_created': 3, 'subscriptions_created': 3, 'owners_updated': 0}
    again = await routes.bulk_import_customers(StarletteUpload(io.BytesIO(csv_bytes), filename='c.csv'), user, db)
    assert again['customers_created'] == 0 and again['subscriptions_created'] == 0
    owners = 'customer,subscription,owner\nACME,acme dev,Meera\n'.encode()
    assert (await routes.bulk_import_customers(StarletteUpload(io.BytesIO(owners), filename='o.csv'), user, db))['owners_updated'] == 1
    text = (await routes.export_customers_csv(user, db)).body.decode()
    assert text.splitlines()[0] == 'Customer,Subscription,Owner'
    assert 'Acme,Acme Dev,Meera' in text and "'=Evil,Sub,Asha" in text and 'Beta,,' in text
    with pytest.raises(HTTPException):
        await routes.bulk_import_customers(StarletteUpload(io.BytesIO(b'Name\nx\n'), filename='bad.csv'), user, db)


@pytest.mark.asyncio
async def test_permanent_delete_needs_confirmation_and_cascades(db):
    from routers import billing as customer_routes
    user = {'account_id': 1, 'user_id': 'one', 'actor_id': 1}
    customer = await customer_routes.create_customer(customer_routes.CustomerInput(name='Unused Co'), user, db)
    sub = await routes.create_workload(customer['id'], routes.WorkloadInput(name='Sub A'), user, db)
    other = await routes.create_workload(customer['id'], routes.WorkloadInput(name='Sub B'), user, db)
    e1 = await routes.create_entry(sub['id'], routes.EntryInput(period='2026-09', currency='INR', customer_amount='10'), user, db)
    await routes.create_entry(other['id'], routes.EntryInput(period='2026-09', currency='INR', customer_amount='5'), user, db)

    assert (await routes.delete_permanently('entry', e1['id'], '', user, db))['entries'] == 1
    assert (await routes.delete_permanently('workload', other['id'], '', user, db))['entries'] == 1
    with pytest.raises(HTTPException) as wrong:
        await routes.delete_permanently('customer', customer['id'], 'unused', user, db)
    assert wrong.value.status_code == 422
    with pytest.raises(HTTPException):
        await routes.delete_permanently('customer', customer['id'], 'Unused Co', {'account_id': 2, 'user_id': 'x'}, db)
    result = await routes.delete_permanently('customer', customer['id'], 'Unused Co', user, db)
    assert result == {'deleted': True, 'entries': 0, 'subscriptions': 1}
    with pytest.raises(HTTPException) as gone:
        await routes.profile_ledger(customer['id'], user, db)
    assert gone.value.status_code == 404


@pytest.mark.asyncio
async def test_customer_with_uploaded_invoices_cannot_be_deleted(db):
    from routers import billing as customer_routes
    user = {'account_id': 1, 'user_id': 'one', 'actor_id': 1}
    customer = await customer_routes.create_customer(customer_routes.CustomerInput(name='Docs Co'), user, db)
    await db.execute("INSERT INTO billing_documents(id,owner_id,customer_id,kind,period,filename,sha256,drive_id,item_id,web_url,uploaded_by) VALUES('d1',1,?,'customer','2026-09','a.pdf','x','blob','p','','one')", (customer['id'],))
    await db.commit()
    with pytest.raises(HTTPException) as kept:
        await routes.delete_permanently('customer', customer['id'], 'Docs Co', user, db)
    assert kept.value.status_code == 409
