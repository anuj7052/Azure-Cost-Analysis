from datetime import date

import pytest
from fastapi import HTTPException

from services.billing_dashboard import aggregate, overlap, load
from routers.billing import dashboard
from tests.test_billing_ledger import db  # isolated schema fixture

CUSTOMERS = [{'id': 'c', 'name': 'Example'}]
WORKLOADS = [{'id': 'w', 'customer_id': 'c', 'frequency': 'Monthly'}]


def row(period='2026-10', **extra):
    return dict(customer_id='c', workload_id='w', period=period, currency='INR',
                customer_amount='3100', distributor_amount='1550', usage_amount=None,
                amount_basis='net', frequency='Monthly', status='recorded', **extra)


def report(records, first='2026-10-16', last='2026-11-16', source='ledger', currency='INR'):
    return aggregate(CUSTOMERS, WORKLOADS, records, date.fromisoformat(first), date.fromisoformat(last), currency, source)


def test_exact_range_is_32_days_not_two_months():
    november = {**row('2026-11'), 'customer_amount': '3000', 'distributor_amount': '1500'}
    result = report([row(), november])
    assert result['days'] == 32
    assert result['totals']['customer_amount'] == '3200.00'
    assert result['totals']['distributor_amount'] == '1600.00'
    assert result['totals']['profit'] == '1600.00'
    assert result['totals']['usage_amount'] is None
    assert result['prorated_count'] == 2
    assert [r['selected_days'] for r in result['months']] == [16, 16]


def test_leap_year_single_day_and_full_month():
    assert overlap('2024-02', date(2024, 2, 29), date(2024, 2, 29)) == (1, 29)
    leap = {**row('2024-02'), 'customer_amount': '2900'}
    assert report([leap], '2024-02-29', '2024-02-29')['totals']['customer_amount'] == '100.00'
    assert report([row()], '2026-10-01', '2026-10-31')['totals']['customer_amount'] == '3100.00'


def test_partial_one_time_unknown_and_invoice_amounts_are_unallocated():
    for frequency in ('One Time', ''):
        result = report([{**row(), 'frequency': frequency}])
        assert result['totals']['customer_amount'] is None
        assert result['unallocated_count'] == 1
    result = report([{**row(), 'frequency': '', 'status': 'confirmed'}], source='invoices')
    assert result['unallocated_count'] == 1


def test_credits_zero_missing_and_review_are_distinct():
    result = report([{**row(), 'customer_amount': '-310', 'distributor_amount': '0', 'usage_amount': '0'}])
    assert result['totals']['customer_amount'] == '-160.00'
    assert result['totals']['usage_amount'] == '0.00'
    unknown = report([{**row(), 'status': 'needs_review'}])
    assert unknown['review_count'] == 1
    assert unknown['totals']['customer_amount'] is None
    assert report([{**row(), 'amount_basis': 'unspecified'}])['totals']['profit'] is None
    assert report([row(), {**row(), 'distributor_amount': None}])['totals']['profit'] is None


def test_currencies_are_never_added():
    result = report([row(), {**row(), 'currency': 'USD'}], currency='')
    assert result['currency_required']
    assert all(value is None for value in result['totals'].values())
    assert all(row['customer_amount'] is None for row in result['customers'])
    assert report([row(), {**row(), 'currency': 'USD'}])['totals']['customer_amount'] == '1600.00'


def test_pending_documents_with_unknown_currency_remain_visible():
    result = report([{**row(), 'currency': '', 'status': 'needs_review'}])
    assert result['review_count'] == 1
    assert result['totals']['profit'] is None


@pytest.mark.asyncio
async def test_db_scope_and_archives(db):
    await db.execute("INSERT INTO billing_customers(id,owner_id,name) VALUES('c',1,'Visible'),('other',2,'Other workspace'),('deleted',1,'Deleted')")
    await db.execute("INSERT INTO billing_workloads(id,owner_id,customer_id,name,frequency) VALUES('w',1,'c','VM','Monthly'),('gone',1,'c','Deleted VM','Monthly')")
    await db.execute("INSERT INTO billing_archives(owner_id,entity_type,entity_id,archived_by) VALUES(1,'customer','deleted','test'),(1,'workload','gone','test')")
    await db.commit()
    result = await load(db, 1, date(2026, 10, 1), date(2026, 10, 31))
    assert result['customer_count'] == 1
    assert result['workload_count'] == 1
    assert result['customers'][0]['name'] == 'Visible'


@pytest.mark.asyncio
async def test_reader_dashboard_and_invalid_range(db):
    user = {'account_id': 1, 'can_administer': False}
    result = await dashboard(date(2026, 10, 1), date(2026, 10, 31), '', 'ledger', '', user, db)
    assert result['workspace_role'] == 'user' and result['can_edit'] is False
    with pytest.raises(HTTPException) as exc:
        await dashboard(date(2026, 11, 1), date(2026, 10, 1), '', 'ledger', '', user, db)
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_documents_and_ledger_are_not_combined(db):
    await db.execute("INSERT INTO billing_customers(id,owner_id,name) VALUES('c',1,'Company')")
    for key, kind, amount in [('a','customer','100'),('b','distributor','70'),('u','azure_usage','65')]:
        await db.execute("INSERT INTO billing_documents(id,owner_id,customer_id,kind,period,filename,sha256,drive_id,item_id,web_url,uploaded_by,status,currency,net_amount) VALUES(?,1,'c',?,'2026-10','file',?,'azure-blob','path','','test','confirmed','INR',?)", (key, kind, key, amount))
    await db.commit()
    result = await load(db, 1, date(2026,10,1), date(2026,10,31), source='invoices')
    assert result['totals']['profit'] == '30.00'
    assert result['totals']['usage_amount'] == '65.00'
    empty = await load(db, 1, date(2026,10,1), date(2026,10,31), source='ledger')
    assert empty['totals']['customer_amount'] is None
