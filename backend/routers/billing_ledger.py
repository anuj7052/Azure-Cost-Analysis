import io
import json
import unicodedata
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user, require_workspace_admin
from core.db import get_db
from services import billing_blob as blob, billing_ledger as ledger

router = APIRouter(prefix='/api/billing', tags=['Azure Billing ledger'])


class WorkloadInput(BaseModel):
    name: str = Field(min_length=1, max_length=300, pattern=r'\S')
    po_id: str = Field(default='', max_length=200)
    po_date: str = Field(default='', max_length=200)
    period_start: str = Field(default='', max_length=200)
    period_end: str = Field(default='', max_length=200)
    frequency: str = Field(default='', max_length=100)
    plan_name: str = Field(default='', max_length=200)
    requirement_id: str = Field(default='', max_length=200)
    distributor: str = Field(default='', max_length=200)
    notes: str = Field(default='', max_length=4000)
    owner: str = Field(default='', max_length=200)
    revision: int = Field(default=1, ge=1)


class EntryInput(BaseModel):
    period: str = Field(pattern=r'^\d{4}-(0[1-9]|1[0-2])$')
    currency: str = Field(pattern=r'^[A-Z]{3}$')
    invoice_number: str = Field(default='', max_length=200)
    customer_amount: Decimal | None = Field(default=None, max_digits=18, decimal_places=4, allow_inf_nan=False)
    distributor_amount: Decimal | None = Field(default=None, max_digits=18, decimal_places=4, allow_inf_nan=False)
    usage_amount: Decimal | None = Field(default=None, max_digits=18, decimal_places=4, allow_inf_nan=False)
    payment_status: str = Field(default='', max_length=1000)
    notes: str = Field(default='', max_length=4000)
    amount_basis: Literal['unspecified', 'gross', 'net'] = 'unspecified'
    status: Literal['recorded', 'needs_review'] = 'recorded'
    distributor: str = Field(default='', max_length=120)
    revision: int = Field(default=1, ge=1)


def values(body, fields):
    data = body.model_dump()
    return [str(data[field]) if isinstance(data[field], Decimal) else data[field] for field in fields]


async def active_customer(db, owner, key):
    await ledger.get_entity(db, owner, 'customer', key)
    if await ledger.is_archived(db, owner, 'customer', key):
        raise HTTPException(409, 'Restore this customer before making changes.')


@router.post('/ledger/import')
async def import_csv(file: UploadFile = File(...), year: int = Form(..., ge=2000, le=2100), currency: str = Form('INR', pattern=r'^[A-Z]{3}$'), confirm: bool = Form(False), user=Depends(require_workspace_admin), db=Depends(get_db)):
    content = await file.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(413, 'The CSV must be smaller than 5 MB.')
    preview = ledger.parse_csv(content, year, currency)
    if not confirm:
        return preview
    prior = await ledger.one(db, 'SELECT id,summary FROM billing_imports WHERE owner_id=? AND source_hash=? AND billing_year=?', (user['account_id'], preview['source_hash'], year))
    if prior:
        return {**json.loads(prior['summary']), 'duplicate': True, 'import_id': prior['id']}
    if not blob.configured():
        raise HTTPException(409, 'Configure private Azure Blob storage before importing customer ledgers.')
    saved = await blob.upload(user['account_id'], 'ledger-imports', str(year), 'sources', preview['source_hash'] + '.csv', content)
    try:
        return await ledger.commit_import(db, user['account_id'], user['user_id'], preview, Path(file.filename or 'billing.csv').name, saved['id'])
    except Exception as exc:
        import aiosqlite
        if isinstance(exc, aiosqlite.IntegrityError) or getattr(exc, 'sqlstate', None) == '23505':
            raise HTTPException(409, 'Another import or edit created these records. Reload before retrying; existing records were not overwritten.') from None
        raise


@router.get('/customers/{customer_id}/ledger')
async def profile_ledger(customer_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    await ledger.get_entity(db, user['account_id'], 'customer', customer_id)
    return await ledger.customer_ledger(db, user['account_id'], customer_id)


@router.post('/customers/{customer_id}/workloads', status_code=201)
async def create_workload(customer_id: str, body: WorkloadInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    await active_customer(db, owner, customer_id)
    key = str(uuid.uuid4())
    await db.execute(f'INSERT INTO billing_workloads(id,owner_id,customer_id,{",".join(ledger.WORKLOAD_FIELDS)},owner) VALUES({",".join("?" for _ in range(14))})', (key, owner, customer_id, *values(body, ledger.WORKLOAD_FIELDS), body.owner.strip()))
    await ledger.audit(db, owner, user['user_id'], 'workload', key, 'create', {}, body.model_dump(mode='json'))
    await db.commit()
    return await ledger.get_entity(db, owner, 'workload', key)


@router.put('/workloads/{workload_id}')
async def update_workload(workload_id: str, body: WorkloadInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    before = await ledger.get_entity(db, owner, 'workload', workload_id)
    await active_customer(db, owner, before['customer_id'])
    if await ledger.is_archived(db, owner, 'workload', workload_id):
        raise HTTPException(409, 'Restore this workload before editing.')
    cursor = await db.execute(f'UPDATE billing_workloads SET {",".join(field+"=?" for field in ledger.WORKLOAD_FIELDS)},owner=?,revision=revision+1 WHERE id=? AND owner_id=? AND revision=?', (*values(body, ledger.WORKLOAD_FIELDS), body.owner.strip(), workload_id, owner, body.revision))
    if cursor.rowcount != 1:
        raise HTTPException(409, 'Workload changed elsewhere. Reload before saving.')
    await ledger.audit(db, owner, user['user_id'], 'workload', workload_id, 'update', before, body.model_dump(mode='json'))
    await db.commit()
    return await ledger.get_entity(db, owner, 'workload', workload_id)


@router.post('/workloads/{workload_id}/entries', status_code=201)
async def create_entry(workload_id: str, body: EntryInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    work = await ledger.get_entity(db, owner, 'workload', workload_id)
    await active_customer(db, owner, work['customer_id'])
    if await ledger.is_archived(db, owner, 'workload', workload_id):
        raise HTTPException(409, 'Restore this workload before adding a month.')
    if await ledger.one(db, 'SELECT id FROM billing_ledger WHERE owner_id=? AND workload_id=? AND period=?', (owner, workload_id, body.period)):
        raise HTTPException(409, 'This workload already has an entry for that month. Edit or restore it instead.')
    key = str(uuid.uuid4())
    await db.execute(f'INSERT INTO billing_ledger(id,owner_id,customer_id,workload_id,{",".join(ledger.ENTRY_FIELDS)},distributor,updated_by) VALUES({",".join("?" for _ in range(16))})', (key, owner, work['customer_id'], workload_id, *values(body, ledger.ENTRY_FIELDS), body.distributor.strip(), user['user_id']))
    await ledger.audit(db, owner, user['user_id'], 'entry', key, 'create', {}, body.model_dump(mode='json'))
    await db.commit()
    return await ledger.get_entity(db, owner, 'entry', key)


@router.put('/ledger/entries/{entry_id}')
async def update_entry(entry_id: str, body: EntryInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    before = await ledger.get_entity(db, owner, 'entry', entry_id)
    await active_customer(db, owner, before['customer_id'])
    if await ledger.is_archived(db, owner, 'entry', entry_id) or await ledger.is_archived(db, owner, 'workload', before['workload_id']):
        raise HTTPException(409, 'Restore the entry and its workload before editing.')
    other = await ledger.one(db, 'SELECT id FROM billing_ledger WHERE owner_id=? AND workload_id=? AND period=? AND id<>?', (owner, before['workload_id'], body.period, entry_id))
    if other:
        raise HTTPException(409, 'That month already exists for this workload.')
    cursor = await db.execute(f'UPDATE billing_ledger SET {",".join(field+"=?" for field in ledger.ENTRY_FIELDS)},distributor=?,updated_by=?,updated_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=? AND owner_id=? AND revision=?', (*values(body, ledger.ENTRY_FIELDS), body.distributor.strip(), user['user_id'], entry_id, owner, body.revision))
    if cursor.rowcount != 1:
        raise HTTPException(409, 'Entry changed elsewhere. Reload before saving to avoid losing another edit.')
    await ledger.audit(db, owner, user['user_id'], 'entry', entry_id, 'update', before, body.model_dump(mode='json'))
    await db.commit()
    return await ledger.get_entity(db, owner, 'entry', entry_id)


BULK_HEADERS = ('Customer', 'Subscription', 'Owner')


def _bulk_rows(content: bytes):
    """Customer / Subscription / Owner rows from a CSV, headers matched loosely."""
    import csv
    text = content.decode('utf-8-sig', errors='replace')
    reader = csv.reader(io.StringIO(text))
    header = [cell.strip().lower() for cell in next(reader, [])]
    def find(*names):
        return next((i for i, cell in enumerate(header) if cell in names), None)
    col_c, col_s, col_o = find('customer', 'customer name', 'company', 'company name'), find('subscription', 'subscription name', 'workload'), find('owner', 'subscription owner', 'account manager')
    if col_c is None:
        raise HTTPException(422, 'The file needs a "Customer" column. Optional columns: "Subscription", "Owner".')
    rows = []
    for number, row in enumerate(reader, start=2):
        cell = lambda i: (row[i].strip() if i is not None and i < len(row) else '')  # noqa: E731
        if cell(col_c):
            rows.append({'row': number, 'customer': cell(col_c)[:150], 'subscription': cell(col_s)[:300], 'owner': cell(col_o)[:200]})
    if len(rows) > 5000:
        raise HTTPException(413, 'Import at most 5,000 rows at a time.')
    return rows


@router.post('/customers/bulk')
async def bulk_import_customers(file: UploadFile = File(...), user=Depends(require_workspace_admin), db=Depends(get_db)):
    """
    Create customers and subscriptions in bulk and set subscription owners.

    Existing names are matched case-insensitively and reused, so importing the
    same file twice changes nothing; a non-empty Owner updates the owner.
    """
    content = await file.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(413, 'The file is larger than 5 MB.')
    rows = _bulk_rows(content)
    owner = user['account_id']
    async with db.execute('SELECT id,name FROM billing_customers WHERE owner_id=?', (owner,)) as cursor:
        customers = {row[1].strip().lower(): row[0] for row in await cursor.fetchall()}
    async with db.execute('SELECT id,customer_id,name,owner FROM billing_workloads WHERE owner_id=?', (owner,)) as cursor:
        subs = {(row[1], row[2].strip().lower()): (row[0], row[3]) for row in await cursor.fetchall()}
    summary = {'rows': len(rows), 'customers_created': 0, 'subscriptions_created': 0, 'owners_updated': 0}
    for row in rows:
        key = row['customer'].lower()
        if key not in customers:
            customers[key] = str(uuid.uuid4())
            await db.execute('INSERT INTO billing_customers(id,owner_id,name) VALUES(?,?,?)', (customers[key], owner, row['customer']))
            summary['customers_created'] += 1
        if not row['subscription']:
            continue
        sub_key = (customers[key], row['subscription'].lower())
        if sub_key not in subs:
            sub_id = str(uuid.uuid4())
            await db.execute('INSERT INTO billing_workloads(id,owner_id,customer_id,name,owner) VALUES(?,?,?,?,?)', (sub_id, owner, customers[key], row['subscription'], row['owner']))
            subs[sub_key] = (sub_id, row['owner'])
            summary['subscriptions_created'] += 1
        elif row['owner'] and subs[sub_key][1] != row['owner']:
            await db.execute('UPDATE billing_workloads SET owner=?,revision=revision+1 WHERE id=? AND owner_id=?', (row['owner'], subs[sub_key][0], owner))
            subs[sub_key] = (subs[sub_key][0], row['owner'])
            summary['owners_updated'] += 1
    await ledger.audit(db, owner, user['user_id'], 'customer', 'bulk', 'import', {}, summary)
    await db.commit()
    return summary


@router.get('/customers-export.csv')
async def export_customers_csv(user=Depends(get_current_user), db=Depends(get_db)):
    """Customer / Subscription / Owner, one row per subscription — re-importable."""
    import csv
    from fastapi.responses import Response
    async with db.execute(
        "SELECT c.name, w.name, w.owner FROM billing_customers c LEFT JOIN billing_workloads w ON w.customer_id=c.id AND w.owner_id=c.owner_id "
        "WHERE c.owner_id=? ORDER BY c.name, w.name", (user['account_id'],),
    ) as cursor:
        rows = await cursor.fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(BULK_HEADERS)
    for customer, subscription, sub_owner in rows:
        # A leading =, +, - or @ would run as a formula in Excel.
        cells = [str(v or '') for v in (customer, subscription, sub_owner)]
        writer.writerow([("'" + v) if v and v[0] in '=+-@' else v for v in cells])
    return Response(out.getvalue(), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="customers.csv"'})


@router.get('/distributors')
async def list_distributors(user=Depends(get_current_user), db=Depends(get_db)):
    """Default distributors plus every name this workspace has used."""
    from services.billing_schema import DEFAULT_DISTRIBUTORS
    async with db.execute("SELECT DISTINCT distributor FROM billing_ledger WHERE owner_id=? AND distributor<>'' UNION SELECT DISTINCT distributor FROM billing_workloads WHERE owner_id=? AND distributor<>''", (user['account_id'], user['account_id'])) as cursor:
        used = [row[0] for row in await cursor.fetchall()]
    seen, names = set(), []
    for name in [*DEFAULT_DISTRIBUTORS, *sorted(used, key=str.lower)]:
        if name.strip().lower() not in seen:
            seen.add(name.strip().lower())
            names.append(name.strip())
    return {'distributors': names}


@router.post('/ledger/{kind}/{entity_id}/archive')
async def archive(kind: Literal['customer', 'workload', 'entry'], entity_id: str, user=Depends(require_workspace_admin), db=Depends(get_db)):
    before = await ledger.get_entity(db, user['account_id'], kind, entity_id)
    await db.execute('INSERT INTO billing_archives(owner_id,entity_type,entity_id,archived_by) VALUES(?,?,?,?) ON CONFLICT(owner_id,entity_type,entity_id) DO NOTHING', (user['account_id'], kind, entity_id, user['user_id']))
    await ledger.audit(db, user['account_id'], user['user_id'], kind, entity_id, 'archive', before, {'archived': True})
    await db.commit()
    return {'archived': True}


@router.delete('/ledger/{kind}/{entity_id}')
async def delete_permanently(kind: Literal['customer', 'workload', 'entry'], entity_id: str, confirm_name: str = '', user=Depends(require_workspace_admin), db=Depends(get_db)):
    """
    Permanently delete a customer, subscription or monthly entry.

    A customer must be confirmed by typing its exact name, and cannot be
    deleted while it has uploaded invoice documents — archive it instead, so
    stored originals are never left without a record.
    """
    owner = user['account_id']
    before = await ledger.get_entity(db, owner, kind, entity_id)
    if kind == 'customer':
        def norm(text):
            return ' '.join(unicodedata.normalize('NFKC', str(text or '')).split()).casefold()
        if norm(confirm_name) not in ('delete', norm(before['name'])):
            raise HTTPException(422, 'Type DELETE to confirm deletion.')
        if await ledger.one(db, 'SELECT id FROM billing_documents WHERE owner_id=? AND customer_id=?', (owner, entity_id)):
            raise HTTPException(409, 'This customer has uploaded invoices. Archive it instead so the original files stay on record.')
        async with db.execute('SELECT id FROM billing_ledger WHERE owner_id=? AND customer_id=?', (owner, entity_id)) as cursor:
            entry_ids = [row[0] for row in await cursor.fetchall()]
        async with db.execute('SELECT id FROM billing_workloads WHERE owner_id=? AND customer_id=?', (owner, entity_id)) as cursor:
            workload_ids = [row[0] for row in await cursor.fetchall()]
        await db.execute('DELETE FROM billing_ledger WHERE owner_id=? AND customer_id=?', (owner, entity_id))
        await db.execute('DELETE FROM billing_workloads WHERE owner_id=? AND customer_id=?', (owner, entity_id))
        await db.execute('DELETE FROM billing_customers WHERE owner_id=? AND id=?', (owner, entity_id))
        for kind_, ids in (('entry', entry_ids), ('workload', workload_ids), ('customer', [entity_id])):
            for key in ids:
                await db.execute('DELETE FROM billing_archives WHERE owner_id=? AND entity_type=? AND entity_id=?', (owner, kind_, key))
        removed = {'entries': len(entry_ids), 'subscriptions': len(workload_ids)}
    elif kind == 'workload':
        cursor = await db.execute('DELETE FROM billing_ledger WHERE owner_id=? AND workload_id=?', (owner, entity_id))
        removed = {'entries': cursor.rowcount}
        await db.execute('DELETE FROM billing_workloads WHERE owner_id=? AND id=?', (owner, entity_id))
        await db.execute("DELETE FROM billing_archives WHERE owner_id=? AND entity_type='workload' AND entity_id=?", (owner, entity_id))
    else:
        await db.execute('DELETE FROM billing_ledger WHERE owner_id=? AND id=?', (owner, entity_id))
        await db.execute("DELETE FROM billing_archives WHERE owner_id=? AND entity_type='entry' AND entity_id=?", (owner, entity_id))
        removed = {'entries': 1}
    await ledger.audit(db, owner, user['user_id'], kind, entity_id, 'delete', before, removed)
    await db.commit()
    return {'deleted': True, **removed}


@router.post('/ledger/{kind}/{entity_id}/restore')
async def restore(kind: Literal['customer', 'workload', 'entry'], entity_id: str, user=Depends(require_workspace_admin), db=Depends(get_db)):
    await ledger.get_entity(db, user['account_id'], kind, entity_id)
    await db.execute('DELETE FROM billing_archives WHERE owner_id=? AND entity_type=? AND entity_id=?', (user['account_id'], kind, entity_id))
    await ledger.audit(db, user['account_id'], user['user_id'], kind, entity_id, 'restore', {'archived': True}, {'archived': False})
    await db.commit()
    return {'archived': False}


@router.get('/ledger/{kind}/{entity_id}/history')
async def history(kind: Literal['customer', 'workload', 'entry'], entity_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    await ledger.get_entity(db, user['account_id'], kind, entity_id)
    async with db.execute('SELECT * FROM billing_changes WHERE owner_id=? AND entity_type=? AND entity_id=? ORDER BY created_at DESC LIMIT 100', (user['account_id'], kind, entity_id)) as cursor:
        return {'items': [dict(row) for row in await cursor.fetchall()]}
