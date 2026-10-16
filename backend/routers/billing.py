"""Customer billing workspace with private cloud originals and reviewed totals."""
import asyncio
import hashlib
import io
import json
import uuid
import zipfile
from decimal import Decimal
from datetime import date
from pathlib import Path
from urllib.parse import quote
from typing import Literal

import aiosqlite
import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user, require_workspace_admin
from core.config import settings
from core.db import get_db
from services import billing_invoices as invoices, billing_sharepoint as sp
from services import billing_blob as blob
from services import billing_ledger as ledger

router = APIRouter(prefix="/api/billing", tags=["Azure Billing"])


@router.get('/dashboard')
async def dashboard(from_date: date, to_date: date, currency: str = '', source: Literal['ledger', 'invoices'] = 'ledger', customer_id: str = '', user=Depends(get_current_user), db=Depends(get_db)):
    from services.billing_dashboard import load
    if to_date < from_date or (to_date - from_date).days > 3660:
        raise HTTPException(422, 'Choose an end date on or after the start date, within ten years.')
    if currency and (len(currency) != 3 or not currency.isalpha() or not currency.isupper()):
        raise HTTPException(422, 'Use a three-letter uppercase currency code.')
    if customer_id:
        await customer_for(db, user['account_id'], customer_id)
    result = await load(db, user['account_id'], from_date, to_date, currency, source, customer_id)
    return {**result, 'can_edit': bool(user.get('can_administer')), 'workspace_role': 'admin' if user.get('can_administer') else 'user'}


class CustomerInput(BaseModel):
    name: str = Field(min_length=1, max_length=150, pattern=r"\S")
    company: str = Field(default="", max_length=200)
    contact_email: str = Field(default="", max_length=254)
    notes: str = Field(default="", max_length=4000)


class ConnectionInput(BaseModel):
    site_url: str = Field(max_length=500)
    library: str = Field(default="Documents", min_length=1, max_length=150)
    folder: str = Field(default="", max_length=500)


class ReviewInput(BaseModel):
    invoice_number: str = Field(default="", max_length=150)
    period: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    net_amount: Decimal = Field(max_digits=18, decimal_places=4, allow_inf_nan=False)
    tax_amount: Decimal = Field(default=Decimal(0), max_digits=18, decimal_places=4, allow_inf_nan=False)


async def one(db, sql, params):
    async with db.execute(sql, params) as cursor:
        row = await cursor.fetchone()
    return dict(row) if row else None


async def customer_for(db, owner, customer_id):
    row = await one(db, "SELECT * FROM billing_customers WHERE id=? AND owner_id=?", (customer_id, owner))
    if not row:
        raise HTTPException(404, "Customer not found.")
    return row


async def documents_for(db, owner, customer_id):
    async with db.execute("SELECT * FROM billing_documents WHERE owner_id=? AND customer_id=? ORDER BY created_at DESC", (owner, customer_id)) as cursor:
        return [dict(row) for row in await cursor.fetchall()]


def document_output(row):
    return {**row, "storage_provider": "azure_blob" if row["drive_id"] == "azure-blob" else "sharepoint", "extraction": json.loads(row["extraction"])}


async def connection_for(db, owner):
    if blob.configured():
        blob.destination()
        return {"provider": "azure_blob", "drive_id": "azure-blob", "container": settings.BILLING_BLOB_CONTAINER}
    row = await one(db, "SELECT * FROM billing_connections WHERE owner_id=?", (owner,))
    if not row:
        raise HTTPException(409, "Configure and verify a SharePoint destination in Azure Billing before uploading.")
    return row


@router.get("/connection")
async def connection(user=Depends(get_current_user), db=Depends(get_db)):
    if blob.configured():
        row = await connection_for(db, user["account_id"])
    else:
        row = await one(db, "SELECT * FROM billing_connections WHERE owner_id=?", (user["account_id"],))
    return {"connection": row, "ocr_configured": bool(settings.BILLING_OCR_ENDPOINT and settings.BILLING_OCR_KEY), "can_edit": bool(user.get("can_administer"))}


@router.post("/storage/check")
async def check_storage(user=Depends(require_workspace_admin)):
    await blob.verify()
    return {"provider": "azure_blob", "status": "ready", "container": settings.BILLING_BLOB_CONTAINER}


@router.put("/connection")
async def connect(body: ConnectionInput, user=Depends(require_workspace_admin), db=Depends(get_db), graph_token: str = Header(default="", alias="X-Billing-Graph-Token")):
    async with httpx.AsyncClient(timeout=30) as client:
        await sp.verify_identity(client, graph_token, user)
        target = await sp.resolve_folder(client, graph_token, body.site_url, body.library, body.folder)
    await db.execute("""INSERT INTO billing_connections(owner_id,site_url,drive_id,folder_id,folder_url,connected_by)
        VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET site_url=excluded.site_url,
        drive_id=excluded.drive_id,folder_id=excluded.folder_id,folder_url=excluded.folder_url,
        connected_by=excluded.connected_by,updated_at=CURRENT_TIMESTAMP""", (user["account_id"], body.site_url, target["drive_id"], target["folder_id"], target["folder_url"], user["user_id"]))
    await db.commit()
    return {"connection": await connection_for(db, user["account_id"])}


@router.get("/customers")
async def customers(user=Depends(get_current_user), db=Depends(get_db)):
    async with db.execute("SELECT c.*, a.entity_id IS NOT NULL AS archived FROM billing_customers c LEFT JOIN billing_archives a ON a.owner_id=c.owner_id AND a.entity_type='customer' AND a.entity_id=c.id WHERE c.owner_id=? ORDER BY c.name", (user["account_id"],)) as cursor:
        return {"items": [dict(row) for row in await cursor.fetchall()]}


@router.post("/customers", status_code=201)
async def create_customer(body: CustomerInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    key = str(uuid.uuid4())
    await db.execute("INSERT INTO billing_customers(id,owner_id,name,company,contact_email,notes) VALUES(?,?,?,?,?,?)", (key, user["account_id"], body.name.strip(), body.company, body.contact_email, body.notes))
    await db.commit()
    return await customer_for(db, user["account_id"], key)


@router.put("/customers/{customer_id}")
async def update_customer(customer_id: str, body: CustomerInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    previous = await customer_for(db, user["account_id"], customer_id)
    await db.execute("UPDATE billing_customers SET name=?,company=?,contact_email=?,notes=? WHERE id=? AND owner_id=?", (body.name.strip(), body.company, body.contact_email, body.notes, customer_id, user["account_id"]))
    await ledger.audit(db, user['account_id'], user['user_id'], 'customer', customer_id, 'update', previous, body.model_dump())
    await db.commit()
    return await customer_for(db, user["account_id"], customer_id)


@router.get("/customers/{customer_id}")
async def profile(customer_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    customer = await customer_for(db, user["account_id"], customer_id)
    documents = await documents_for(db, user["account_id"], customer_id)
    return {"customer": customer, "documents": [document_output(row) for row in documents], "comparison": invoices.comparison(documents)}


@router.post("/customers/{customer_id}/documents", status_code=201)
async def upload_document(customer_id: str, kind: Literal["customer", "distributor", "azure_usage"] = Form(...), period: str = Form(..., pattern=r"^\d{4}-(0[1-9]|1[0-2])$"), file: UploadFile = File(...), graph_token: str = Header(default="", alias="X-Billing-Graph-Token"), user=Depends(require_workspace_admin), db: aiosqlite.Connection = Depends(get_db)):
    owner = user["account_id"]
    await customer_for(db, owner, customer_id)
    destination = await connection_for(db, owner)
    filename = (file.filename or "invoice").replace("\\", "/").rsplit("/", 1)[-1][:180]
    extension = Path(filename).suffix.lower()
    if extension not in {".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".csv"}:
        raise HTTPException(422, "Upload a PDF, PNG, JPEG, XLSX or CSV file.")
    content = await file.read(10 * 1024 * 1024 + 1)
    if not content or len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "Upload a non-empty file up to 10 MB.")
    if extension == ".xlsx":
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                if sum(item.file_size for item in archive.infolist()) > 40 * 1024 * 1024:
                    raise HTTPException(413, "Expanded spreadsheet exceeds the 40 MB processing limit.")
        except zipfile.BadZipFile:
            raise HTTPException(422, "Invalid XLSX workbook.") from None
    digest = hashlib.sha256(content).hexdigest()
    existing = await one(db, "SELECT * FROM billing_documents WHERE owner_id=? AND customer_id=? AND kind=? AND sha256=?", (owner, customer_id, kind, digest))
    if existing:
        return {"document": document_output(existing), "duplicate": True}
    # Deterministic storage path makes a network retry overwrite the same bytes,
    # rather than creating another original. The database also rejects duplicates.
    key = str(uuid.uuid5(uuid.NAMESPACE_URL, f"billing:{owner}:{customer_id}:{kind}:{digest}"))
    if destination.get("provider") == "azure_blob":
        saved = await blob.upload(owner, customer_id, period, kind, digest + extension, content)
    else:
        async with httpx.AsyncClient(timeout=60) as client:
            await sp.verify_identity(client, graph_token, user)
            saved = await sp.upload(client, graph_token, destination, owner, customer_id, period, kind, digest + extension, content)
    await db.execute("""INSERT INTO billing_documents(id,owner_id,customer_id,kind,period,filename,sha256,drive_id,item_id,web_url,uploaded_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,customer_id,kind,sha256) DO NOTHING""", (key, owner, customer_id, kind, period, filename, digest, destination["drive_id"], saved["id"], saved.get("webUrl", ""), user["user_id"]))
    await db.commit()
    try:
        extracted, message = await asyncio.wait_for(invoices.extract_invoice(content, extension), timeout=55)
    except (TimeoutError, ValueError):
        extracted, message = {"method": "manual", "suggestions": {}}, "Original saved to cloud storage. Extraction timed out; review it and enter totals manually."
    await db.execute("UPDATE billing_documents SET extraction=?,extraction_message=? WHERE id=? AND owner_id=?", (json.dumps(extracted), message, key, owner))
    await db.commit()
    return {"document": document_output(await one(db, "SELECT * FROM billing_documents WHERE id=? AND owner_id=?", (key, owner))), "duplicate": False}


@router.get("/documents/{document_id}/download")
async def download_document(document_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    row = await one(db, "SELECT * FROM billing_documents WHERE id=? AND owner_id=?", (document_id, user["account_id"]))
    if not row:
        raise HTTPException(404, "Bill not found.")
    if row["drive_id"] != "azure-blob":
        raise HTTPException(409, "This original is in SharePoint. Use its original document link.")
    content = await blob.download(user["account_id"], row["customer_id"], row["item_id"])
    return Response(content, media_type="application/octet-stream", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(row['filename'], safe='')}", "Cache-Control": "no-store"})


@router.put("/documents/{document_id}/review")
async def review_document(document_id: str, body: ReviewInput, user=Depends(require_workspace_admin), db=Depends(get_db)):
    row = await one(db, "SELECT * FROM billing_documents WHERE id=? AND owner_id=?", (document_id, user["account_id"]))
    if not row:
        raise HTTPException(404, "Bill not found.")
    if row["status"] == "void":
        raise HTTPException(409, "This bill was excluded. Upload the corrected document instead.")
    if body.invoice_number.strip():
        duplicate = await one(db, "SELECT id FROM billing_documents WHERE owner_id=? AND customer_id=? AND kind=? AND invoice_number=? AND status='confirmed' AND id<>?", (user["account_id"], row["customer_id"], row["kind"], body.invoice_number.strip(), document_id))
        if duplicate:
            raise HTTPException(409, "This invoice number has already been confirmed for this customer and bill type.")
    try:
        await db.execute("UPDATE billing_documents SET invoice_number=?,period=?,currency=?,net_amount=?,tax_amount=?,status='confirmed',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=?", (body.invoice_number.strip(), body.period, body.currency, str(body.net_amount), str(body.tax_amount), user["user_id"], document_id, user["account_id"]))
        await db.commit()
    except Exception as exc:
        # Backstop the friendly precheck when two reviewers confirm at once.
        if isinstance(exc, aiosqlite.IntegrityError) or getattr(exc, "sqlstate", None) == "23505":
            await db.rollback()
            raise HTTPException(409, "This invoice number has already been confirmed.") from None
        raise
    return {"status": "confirmed"}


@router.post("/documents/{document_id}/exclude")
async def exclude_document(document_id: str, user=Depends(require_workspace_admin), db=Depends(get_db)):
    row = await one(db, "SELECT id FROM billing_documents WHERE id=? AND owner_id=?", (document_id, user["account_id"]))
    if not row:
        raise HTTPException(404, "Bill not found.")
    await db.execute("UPDATE billing_documents SET status='void',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=?", (user["user_id"], document_id, user["account_id"]))
    await db.commit()
    return {"status": "void"}


@router.get("/customers/{customer_id}/export")
async def export(customer_id: str, user=Depends(get_current_user), db=Depends(get_db)):
    customer = await customer_for(db, user["account_id"], customer_id)
    content = await asyncio.to_thread(invoices.workbook, customer, await documents_for(db, user["account_id"], customer_id), await ledger.customer_ledger(db, user['account_id'], customer_id))
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": 'attachment; filename="azure-billing.xlsx"'})


@router.post("/customers/{customer_id}/export-cloud")
@router.post("/customers/{customer_id}/export-sharepoint", include_in_schema=False)
async def export_sharepoint(customer_id: str, graph_token: str = Header(default="", alias="X-Billing-Graph-Token"), user=Depends(require_workspace_admin), db=Depends(get_db)):
    owner = user["account_id"]
    customer = await customer_for(db, owner, customer_id)
    destination = await connection_for(db, owner)
    content = await asyncio.to_thread(invoices.workbook, customer, await documents_for(db, owner, customer_id), await ledger.customer_ledger(db, owner, customer_id))
    filename = f"comparison-{uuid.uuid4().hex[:12]}.xlsx"
    if destination.get("provider") == "azure_blob":
        await blob.upload(owner, customer_id, "Reports", "comparison", filename, content)
        return {"provider": "azure_blob", "filename": filename}
    async with httpx.AsyncClient(timeout=60) as client:
        await sp.verify_identity(client, graph_token, user)
        saved = await sp.upload(client, graph_token, destination, owner, customer_id, "Reports", "comparison", filename, content)
    return {"provider": "sharepoint", "web_url": saved.get("webUrl", "")}
