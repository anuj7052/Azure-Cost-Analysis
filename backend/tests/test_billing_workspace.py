import io
from unittest.mock import AsyncMock

import aiosqlite
import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException, UploadFile
from openpyxl import load_workbook
from pydantic import ValidationError

from core import db as db_module
from routers import billing
from services import billing_invoices as invoices, billing_sharepoint as sp
from services import billing_blob as blob


def bill(kind, amount, **extra):
    return {"period": "2026-09", "currency": "INR", "kind": kind, "net_amount": amount, "tax_amount": "0", "status": "confirmed", "invoice_number": "INV", "filename": "invoice.pdf", "web_url": "https://example.sharepoint.com/doc", **extra}


def test_comparison_uses_distributor_only_and_decimal_arithmetic():
    row = invoices.comparison([bill("customer", "100.10"), bill("distributor", "80.05"), bill("azure_usage", "75.00")])[0]
    assert row["profit"] == "20.05"
    assert row["distributor_vs_usage"] == "5.05"
    assert row["margin_pct"] == "20.03"


def test_missing_pending_excluded_credits_and_currency_separation():
    rows = invoices.comparison([bill("customer", "100"), bill("customer", "-10"), bill("distributor", "200", status="needs_review", currency=""), bill("distributor", "5", status="void"), bill("distributor", "8", currency="USD")])
    inr = next(row for row in rows if row["currency"] == "INR")
    assert inr["customer"] == "90"
    assert inr["distributor"] is None and inr["profit"] is None
    assert inr["pending"] == 1
    assert invoices.comparison([bill("customer", "10", status="void")]) == []


def test_zero_is_known_and_zero_revenue_has_no_margin():
    row = invoices.comparison([bill("customer", "0"), bill("distributor", "0")])[0]
    assert row["profit"] == "0" and row["margin_pct"] is None


def test_review_rejects_nan_and_bad_period():
    for change in ({"net_amount": "NaN"}, {"period": "2026-13"}, {"currency": "rupees"}):
        with pytest.raises(ValidationError):
            billing.ReviewInput(**{"period": "2026-09", "currency": "INR", "net_amount": "100", **change})


def test_extraction_does_not_turn_gross_total_or_dollars_into_net_usd():
    assert invoices.suggestions("Invoice No: INV-9\nTotal: $120.00") == {"invoice_number": "INV-9"}
    values = invoices.suggestions("Subtotal INR 1,200.50\nTax amount INR 216.09")
    assert values["net_amount"] == "1200.50" and values["currency"] == "INR"


@pytest.mark.asyncio
async def test_scans_report_missing_ocr_configuration(monkeypatch):
    monkeypatch.setattr(invoices.settings, "BILLING_OCR_ENDPOINT", "")
    result, message = await invoices.extract_invoice(b"image", ".png")
    assert result["method"] == "manual"
    assert "requires Azure Document Intelligence" in message


def test_excel_does_not_execute_customer_fields():
    content = invoices.workbook({"name": '=HYPERLINK("bad")'}, [bill("customer", "10", invoice_number="=1+1")])
    book = load_workbook(io.BytesIO(content))
    assert book["Comparison"]["A2"].data_type == "s"
    assert book["Documents"]["C2"].data_type == "s"


@pytest.mark.parametrize("url", ["http://example.sharepoint.com", "https://evil.com/sites/a", "https://example.sharepoint.com@evil.com", "https://example.sharepoint.com/sites/../bad", "https://example.sharepoint.com/sites/a?token=x"])
def test_sharepoint_url_restrictions(url):
    with pytest.raises(HTTPException):
        sp.site_address(url)


@pytest.mark.asyncio
async def test_graph_identity_must_match_signed_in_user():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"id": "other"}))) as client:
        with pytest.raises(HTTPException) as exc:
            await sp.verify_identity(client, "test-token", {"user_id": "me"})
    assert exc.value.status_code == 403


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "billing.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        for owner in (1, 2):
            await db.execute("INSERT INTO users(id,azure_oid) VALUES(?,?)", (owner, f"user-{owner}"))
        await db.commit()
        yield db


@pytest.mark.asyncio
async def test_profiles_and_documents_are_workspace_scoped(db, monkeypatch):
    owner = {"account_id": 1, "user_id": "user-1", "can_administer": True}
    other = {"account_id": 2, "user_id": "user-2", "can_administer": True}
    customer = await billing.create_customer(billing.CustomerInput(name="Example"), owner, db)
    with pytest.raises(HTTPException) as exc:
        await billing.profile(customer["id"], other, db)
    assert exc.value.status_code == 404
    assert (await billing.customers(other, db))["items"] == []
    await db.execute("INSERT INTO billing_connections(owner_id,site_url,drive_id,folder_id,folder_url,connected_by) VALUES(?,?,?,?,?,?)", (1, "https://example.sharepoint.com/sites/Finance", "drive", "folder", "https://example.sharepoint.com/sites/Finance", "user-1"))
    await db.commit()
    monkeypatch.setattr(sp, "verify_identity", AsyncMock())
    upload = AsyncMock(return_value={"id": "item", "webUrl": "https://example.sharepoint.com/original.pdf"})
    monkeypatch.setattr(sp, "upload", upload)
    monkeypatch.setattr(invoices, "extract_invoice", AsyncMock(return_value=({"suggestions": {"net_amount": "100"}}, "Review it")))
    result = await billing.upload_document(customer["id"], "customer", "2026-09", UploadFile(io.BytesIO(b"test content"), filename="bill.pdf"), "test-token", owner, db)
    document = result["document"]
    assert document["status"] == "needs_review" and document["net_amount"] is None
    again = await billing.upload_document(customer["id"], "customer", "2026-09", UploadFile(io.BytesIO(b"test content"), filename="bill.pdf"), "test-token", owner, db)
    assert again["duplicate"] and upload.await_count == 1
    review = billing.ReviewInput(period="2026-09", currency="INR", net_amount="100")
    with pytest.raises(HTTPException) as exc:
        await billing.review_document(document["id"], review, other, db)
    assert exc.value.status_code == 404
    await billing.review_document(document["id"], review, owner, db)
    data = await billing.profile(customer["id"], owner, db)
    assert data["comparison"][0]["customer"] == "100"
    assert data["comparison"][0]["profit"] is None


@pytest.mark.asyncio
async def test_failed_sharepoint_save_does_not_create_invoice(db, monkeypatch):
    owner = {"account_id": 1, "user_id": "user-1"}
    customer = await billing.create_customer(billing.CustomerInput(name="Example"), owner, db)
    monkeypatch.setattr(billing, "connection_for", AsyncMock(return_value={}))
    monkeypatch.setattr(sp, "verify_identity", AsyncMock())
    monkeypatch.setattr(sp, "upload", AsyncMock(side_effect=HTTPException(502, "Unavailable")))
    with pytest.raises(HTTPException):
        await billing.upload_document(customer["id"], "customer", "2026-09", UploadFile(io.BytesIO(b"test"), filename="bill.pdf"), "test-token", owner, db)
    assert await billing.documents_for(db, 1, customer["id"]) == []


@pytest.mark.asyncio
async def test_ocr_uses_invoice_subtotal_and_keeps_confidence(monkeypatch):
    monkeypatch.setattr(invoices.settings, "BILLING_OCR_ENDPOINT", "https://test.cognitiveservices.azure.com")
    monkeypatch.setattr(invoices.settings, "BILLING_OCR_KEY", "test-only")
    real_client = httpx.AsyncClient
    calls = []

    def respond(request):
        calls.append(request)
        if request.method == "POST":
            return httpx.Response(202, headers={"operation-location": "https://test.cognitiveservices.azure.com/operations/1"})
        return httpx.Response(200, json={"status": "succeeded", "analyzeResult": {"documents": [{"fields": {
            "SubTotal": {"valueCurrency": {"amount": 100, "currencyCode": "INR"}, "confidence": 0.94},
            "TotalTax": {"valueCurrency": {"amount": 18}, "confidence": 0.91},
            "InvoiceTotal": {"valueCurrency": {"amount": 118}},
        }}]}})

    monkeypatch.setattr(invoices.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(respond)))
    result, _ = await invoices.extract_invoice(b"scan", ".png")
    assert result["suggestions"]["net_amount"] == "100"
    assert result["suggestions"]["tax_amount"] == "18"
    assert result["confidence"]["net_amount"] == 0.94
    assert calls[0].url.params["api-version"] == "2024-11-30"


def test_mutating_routes_require_workspace_admin():
    from auth.dependencies import require_workspace_admin
    for route in billing.router.routes:
        if route.methods & {"POST", "PUT", "DELETE"}:
            assert require_workspace_admin in [dependency.call for dependency in route.dependant.dependencies], route.path


@pytest.mark.asyncio
async def test_sharepoint_upload_creates_correct_tree_and_stores_original():
    requests = []

    def respond(request):
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(201, json={"id": f"folder-{len(requests)}", "folder": {}})
        return httpx.Response(201, json={"id": "original", "webUrl": "https://test.sharepoint.com/doc"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await sp.upload(client, "test-token", {"drive_id": "d", "folder_id": "root"}, 1, "customer-a", "2026-09", "customer", "hash.pdf", b"original-bytes")
    import json
    assert [json.loads(request.content)["name"] for request in requests[:-1]] == ["Azure Billing", "workspace-1", "customer-customer-a", "2026-09", "customer"]
    assert requests[-1].content == b"original-bytes"
    assert result["id"] == "original"


@pytest.mark.asyncio
async def test_blob_upload_needs_no_graph_consent_and_download_checks_owner(db, monkeypatch):
    user = {"account_id": 1, "user_id": "user-1"}
    customer = await billing.create_customer(billing.CustomerInput(name="Cloud customer"), user, db)
    monkeypatch.setattr(blob.settings, "BILLING_BLOB_ACCOUNT", "testaccount")
    saved = AsyncMock(return_value={"id": f"workspace-1/customer-{customer['id']}/2026-10/customer/test.csv", "webUrl": ""})
    monkeypatch.setattr(blob, "upload", saved)
    graph = AsyncMock(side_effect=AssertionError("Graph must not be used for Blob storage"))
    monkeypatch.setattr(sp, "verify_identity", graph)
    content = b"Invoice No: TEST-1\nSubtotal INR 12.00"
    result = await billing.upload_document(customer["id"], "customer", "2026-10", UploadFile(io.BytesIO(content), filename="test.csv"), "", user, db)
    assert result["document"]["storage_provider"] == "azure_blob"
    assert result["document"]["web_url"] == ""
    assert result["document"]["extraction"]["suggestions"]["net_amount"] == "12.00"
    download = AsyncMock(return_value=content)
    monkeypatch.setattr(blob, "download", download)
    with pytest.raises(HTTPException) as exc:
        await billing.download_document(result["document"]["id"], {"account_id": 2}, db)
    assert exc.value.status_code == 404
    download.assert_not_called()
    response = await billing.download_document(result["document"]["id"], user, db)
    assert response.body == content
    assert response.headers["cache-control"] == "no-store"
