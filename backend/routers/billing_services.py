"""Services activated inside a customer's subscription, with PO/BOQ, proof files and notes.

Gives a full trail: which service was switched on, under which PO and BOQ,
when, at what expected monthly cost, and the documents that prove it.
"""
import hashlib
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user, require_workspace_admin
from core.db import get_db
from services import billing_blob as blob, billing_ledger as ledger

router = APIRouter(prefix='/api/billing', tags=['Azure Billing services'])

FILE_KINDS = ('po', 'boq', 'approval', 'proof', 'other')
ALLOWED = {'.pdf', '.png', '.jpg', '.jpeg', '.xlsx', '.xls', '.csv', '.docx', '.doc', '.msg', '.eml', '.txt'}
MAX_FILE = 15 * 1024 * 1024
DATE = r'^(\d{4}-\d{2}-\d{2})?$'


class ServiceInput(BaseModel):
    workload_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=300, pattern=r'\S')
    po_number: str = Field(default='', max_length=200)
    po_date: str = Field(default='', pattern=DATE)
    boq_ref: str = Field(default='', max_length=300)
    activated_on: str = Field(default='', pattern=DATE)
    stopped_on: str = Field(default='', pattern=DATE)
    monthly_cost: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=4, allow_inf_nan=False)
    currency: str = Field(default='INR', pattern=r'^[A-Z]{3}$')
    status: Literal['planned', 'active', 'stopped'] = 'active'
    description: str = Field(default='', max_length=4000)


class NoteInput(BaseModel):
    body: str = Field(min_length=1, max_length=4000, pattern=r'\S')


FIELDS = ('workload_id', 'name', 'po_number', 'po_date', 'boq_ref', 'activated_on', 'stopped_on', 'monthly_cost', 'currency', 'status', 'description')


async def one(db, sql, args):
    async with db.execute(sql, args) as cursor:
        row = await cursor.fetchone()
    return dict(row) if row else None


async def service_for(db, owner, service_id):
    row = await one(db, 'SELECT * FROM billing_services WHERE owner_id=? AND id=?', (owner, service_id))
    if not row:
        raise HTTPException(404, 'Service not found.')
    return row


async def check_subscription(db, owner, customer_id, workload_id):
    work = await one(db, 'SELECT customer_id FROM billing_workloads WHERE owner_id=? AND id=?', (owner, workload_id))
    if not work or work['customer_id'] != customer_id:
        raise HTTPException(422, 'Choose a subscription that belongs to this customer.')


def values(body):
    data = body.model_dump()
    data['name'] = data['name'].strip()
    data['monthly_cost'] = None if data['monthly_cost'] is None else str(data['monthly_cost'])
    return [data[f].strip() if isinstance(data[f], str) else data[f] for f in FIELDS]


@router.get('/customers/{customer_id}/services')
async def list_services(customer_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    owner = user['account_id']
    await ledger.get_entity(db, owner, 'customer', customer_id)
    async with db.execute('SELECT * FROM billing_services WHERE owner_id=? AND customer_id=? ORDER BY activated_on DESC, created_at DESC', (owner, customer_id)) as cursor:
        services = [dict(r) for r in await cursor.fetchall()]
    ids = [s['id'] for s in services]
    files, notes = {}, {}
    if ids:
        marks = ','.join('?' for _ in ids)
        async with db.execute(f'SELECT id,service_id,kind,filename,size,uploaded_by,created_at FROM billing_service_files WHERE owner_id=? AND service_id IN ({marks}) ORDER BY created_at DESC', (owner, *ids)) as cursor:
            for r in await cursor.fetchall():
                files.setdefault(r['service_id'], []).append(dict(r))
        async with db.execute(f'SELECT id,service_id,body,author,created_at FROM billing_service_notes WHERE owner_id=? AND service_id IN ({marks}) ORDER BY created_at DESC', (owner, *ids)) as cursor:
            for r in await cursor.fetchall():
                notes.setdefault(r['service_id'], []).append(dict(r))
    for s in services:
        s['files'] = files.get(s['id'], [])
        s['notes'] = notes.get(s['id'], [])
    return {'items': services, 'file_kinds': list(FILE_KINDS)}


@router.post('/customers/{customer_id}/services', status_code=201)
async def create_service(customer_id: str, body: ServiceInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    await ledger.get_entity(db, owner, 'customer', customer_id)
    await check_subscription(db, owner, customer_id, body.workload_id)
    key = str(uuid.uuid4())
    await db.execute(f'INSERT INTO billing_services(id,owner_id,customer_id,{",".join(FIELDS)},created_by) VALUES(?,?,?,{",".join("?" for _ in FIELDS)},?)', (key, owner, customer_id, *values(body), user['user_id']))
    await ledger.audit(db, owner, user['user_id'], 'service', key, 'create', {}, body.model_dump(mode='json'))
    await db.commit()
    return {**await service_for(db, owner, key), 'files': [], 'notes': []}


@router.put('/services/{service_id}')
async def update_service(service_id: str, body: ServiceInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    before = await service_for(db, owner, service_id)
    await check_subscription(db, owner, before['customer_id'], body.workload_id)
    await db.execute(f'UPDATE billing_services SET {",".join(f + "=?" for f in FIELDS)},updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND id=?', (*values(body), owner, service_id))
    await ledger.audit(db, owner, user['user_id'], 'service', service_id, 'update', before, body.model_dump(mode='json'))
    await db.commit()
    return await service_for(db, owner, service_id)


@router.delete('/services/{service_id}')
async def delete_service(service_id: str, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    before = await service_for(db, owner, service_id)
    async with db.execute('SELECT item_id FROM billing_service_files WHERE owner_id=? AND service_id=?', (owner, service_id)) as cursor:
        paths = [r[0] for r in await cursor.fetchall()]
    for path in paths:
        await blob.delete(owner, before['customer_id'], path)
    await db.execute('DELETE FROM billing_service_files WHERE owner_id=? AND service_id=?', (owner, service_id))
    await db.execute('DELETE FROM billing_service_notes WHERE owner_id=? AND service_id=?', (owner, service_id))
    await db.execute('DELETE FROM billing_services WHERE owner_id=? AND id=?', (owner, service_id))
    await ledger.audit(db, owner, user['user_id'], 'service', service_id, 'delete', before, {'files_removed': len(paths)})
    await db.commit()
    return {'deleted': True}


@router.post('/services/{service_id}/files', status_code=201)
async def upload_service_file(service_id: str, kind: Literal[FILE_KINDS] = Form('proof'), file: UploadFile = File(...), user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    service = await service_for(db, owner, service_id)
    filename = (file.filename or 'document').replace('\\', '/').rsplit('/', 1)[-1][:180]
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED:
        raise HTTPException(422, 'Upload a PDF, image, Office document, CSV, email or text file.')
    content = await file.read(MAX_FILE + 1)
    if not content or len(content) > MAX_FILE:
        raise HTTPException(413, 'Upload a non-empty file up to 15 MB.')
    key = str(uuid.uuid4())
    digest = hashlib.sha256(content).hexdigest()[:16]
    saved = await blob.upload(owner, service['customer_id'], 'services', f'service-{service_id}', f'{key}-{digest}{extension}', content)
    await db.execute('INSERT INTO billing_service_files(id,owner_id,customer_id,service_id,kind,filename,item_id,size,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?)', (key, owner, service['customer_id'], service_id, kind, filename, saved['id'], len(content), user['user_id']))
    await ledger.audit(db, owner, user['user_id'], 'service_file', key, 'create', {}, {'service_id': service_id, 'kind': kind, 'filename': filename})
    await db.commit()
    return await one(db, 'SELECT id,service_id,kind,filename,size,uploaded_by,created_at FROM billing_service_files WHERE id=?', (key,))


@router.get('/service-files/{file_id}/download')
async def download_service_file(file_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    owner = user['account_id']
    row = await one(db, 'SELECT * FROM billing_service_files WHERE owner_id=? AND id=?', (owner, file_id))
    if not row:
        raise HTTPException(404, 'Document not found.')
    content = await blob.download(owner, row['customer_id'], row['item_id'])
    return Response(content, media_type='application/octet-stream', headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quote(row['filename'], safe='')}", 'Cache-Control': 'no-store'})


@router.delete('/service-files/{file_id}')
async def delete_service_file(file_id: str, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    row = await one(db, 'SELECT * FROM billing_service_files WHERE owner_id=? AND id=?', (owner, file_id))
    if not row:
        raise HTTPException(404, 'Document not found.')
    await blob.delete(owner, row['customer_id'], row['item_id'])
    await db.execute('DELETE FROM billing_service_files WHERE owner_id=? AND id=?', (owner, file_id))
    await ledger.audit(db, owner, user['user_id'], 'service_file', file_id, 'delete', {'filename': row['filename'], 'service_id': row['service_id']}, {})
    await db.commit()
    return {'deleted': True}


@router.post('/services/{service_id}/notes', status_code=201)
async def add_note(service_id: str, body: NoteInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    await service_for(db, owner, service_id)
    key = str(uuid.uuid4())
    author = user.get('email') or user.get('name') or user['user_id']
    await db.execute('INSERT INTO billing_service_notes(id,owner_id,service_id,body,author) VALUES(?,?,?,?,?)', (key, owner, service_id, body.body.strip(), author))
    await db.commit()
    return await one(db, 'SELECT id,service_id,body,author,created_at FROM billing_service_notes WHERE id=?', (key,))


@router.delete('/service-notes/{note_id}')
async def delete_note(note_id: str, user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user['account_id']
    row = await one(db, 'SELECT * FROM billing_service_notes WHERE owner_id=? AND id=?', (owner, note_id))
    if not row:
        raise HTTPException(404, 'Note not found.')
    await db.execute('DELETE FROM billing_service_notes WHERE owner_id=? AND id=?', (owner, note_id))
    await ledger.audit(db, owner, user['user_id'], 'service_note', note_id, 'delete', row, {})
    await db.commit()
    return {'deleted': True}
