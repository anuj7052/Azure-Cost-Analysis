import json
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
    await db.execute(f'INSERT INTO billing_workloads(id,owner_id,customer_id,{",".join(ledger.WORKLOAD_FIELDS)}) VALUES({",".join("?" for _ in range(13))})', (key, owner, customer_id, *values(body, ledger.WORKLOAD_FIELDS)))
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
    cursor = await db.execute(f'UPDATE billing_workloads SET {",".join(field+"=?" for field in ledger.WORKLOAD_FIELDS)},revision=revision+1 WHERE id=? AND owner_id=? AND revision=?', (*values(body, ledger.WORKLOAD_FIELDS), workload_id, owner, body.revision))
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
    await db.execute(f'INSERT INTO billing_ledger(id,owner_id,customer_id,workload_id,{",".join(ledger.ENTRY_FIELDS)},updated_by) VALUES({",".join("?" for _ in range(15))})', (key, owner, work['customer_id'], workload_id, *values(body, ledger.ENTRY_FIELDS), user['user_id']))
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
    cursor = await db.execute(f'UPDATE billing_ledger SET {",".join(field+"=?" for field in ledger.ENTRY_FIELDS)},updated_by=?,updated_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=? AND owner_id=? AND revision=?', (*values(body, ledger.ENTRY_FIELDS), user['user_id'], entry_id, owner, body.revision))
    if cursor.rowcount != 1:
        raise HTTPException(409, 'Entry changed elsewhere. Reload before saving to avoid losing another edit.')
    await ledger.audit(db, owner, user['user_id'], 'entry', entry_id, 'update', before, body.model_dump(mode='json'))
    await db.commit()
    return await ledger.get_entity(db, owner, 'entry', entry_id)


@router.post('/ledger/{kind}/{entity_id}/archive')
async def archive(kind: Literal['customer', 'workload', 'entry'], entity_id: str, user=Depends(require_workspace_admin), db=Depends(get_db)):
    before = await ledger.get_entity(db, user['account_id'], kind, entity_id)
    await db.execute('INSERT INTO billing_archives(owner_id,entity_type,entity_id,archived_by) VALUES(?,?,?,?) ON CONFLICT(owner_id,entity_type,entity_id) DO NOTHING', (user['account_id'], kind, entity_id, user['user_id']))
    await ledger.audit(db, user['account_id'], user['user_id'], kind, entity_id, 'archive', before, {'archived': True})
    await db.commit()
    return {'archived': True}


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
