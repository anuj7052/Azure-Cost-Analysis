from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException

from services import billing_blob as blob


@pytest.fixture(autouse=True)
def storage(monkeypatch):
    monkeypatch.setattr(blob.settings, "BILLING_BLOB_ACCOUNT", "testaccount")
    monkeypatch.setattr(blob.settings, "BILLING_BLOB_CONTAINER", "billing-documents")
    monkeypatch.setattr(blob, "access_token", AsyncMock(return_value="test-token"))


def test_path_is_server_scoped():
    assert blob.blob_path(1, "c", "2026-10", "customer", "hash.pdf") == "workspace-1/customer-c/2026-10/customer/hash.pdf"
    with pytest.raises(HTTPException):
        blob.blob_path(1, "../../other", "2026-10", "customer", "hash.pdf")


@pytest.mark.asyncio
async def test_upload_download_bytes_and_no_public_link(monkeypatch):
    requests = []
    real_client = httpx.AsyncClient
    def respond(request):
        requests.append(request)
        return httpx.Response(201) if request.method == "PUT" else httpx.Response(200, content=b"original")
    monkeypatch.setattr(blob.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(respond)))
    saved = await blob.upload(1, "c", "2026-10", "customer", "hash.pdf", b"original")
    assert saved["webUrl"] == ""
    assert requests[0].headers["x-ms-blob-type"] == "BlockBlob"
    assert requests[0].content == b"original"
    assert await blob.download(1, "c", saved["id"]) == b"original"
    with pytest.raises(HTTPException) as exc:
        await blob.download(2, "c", saved["id"])
    assert exc.value.status_code == 403
    assert len(requests) == 2


@pytest.mark.asyncio
async def test_storage_denial_does_not_expose_response_or_token():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(403, text="internal detail"))) as client:
        with pytest.raises(HTTPException) as exc:
            await blob.request(client, "HEAD")
    assert "test-token" not in exc.value.detail
    assert "internal detail" not in exc.value.detail
    assert exc.value.status_code == 503
