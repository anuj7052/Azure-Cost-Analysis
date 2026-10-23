"""Private app-owned Blob storage. No account keys, SAS URLs or public blobs.

Production uses App Service's managed identity. Development can explicitly opt
into the developer's Azure CLI identity for this container only, never for ARM
tenant queries. All resource paths are built by the server after workspace checks.
"""
import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from core.config import settings

MAX_BYTES = 10 * 1024 * 1024
_token = ""
_expires = 0.0


def configured():
    return bool(settings.BILLING_BLOB_ACCOUNT)


def destination():
    account, container = settings.BILLING_BLOB_ACCOUNT, settings.BILLING_BLOB_CONTAINER
    if not re.fullmatch(r"[a-z0-9]{3,24}", account or "") or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]", container or "") or "--" in container:
        raise HTTPException(503, "Azure Billing Blob storage is not configured correctly.")
    return f"https://{account}.blob.core.windows.net/{container}"


async def access_token():
    global _token, _expires
    if _token and time.time() < _expires:
        return _token
    endpoint, header = os.getenv("IDENTITY_ENDPOINT"), os.getenv("IDENTITY_HEADER")
    try:
        if endpoint and header:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(endpoint, params={"resource": "https://storage.azure.com/", "api-version": "2019-08-01"}, headers={"X-IDENTITY-HEADER": header})
                response.raise_for_status()
                data = response.json()
                token, expiry = data["access_token"], float(data["expires_on"])
        elif settings.ENVIRONMENT == "development" and settings.BILLING_BLOB_LOCAL_CLI:
            process = await asyncio.create_subprocess_exec("az", "account", "get-access-token", "--resource", "https://storage.azure.com/", "--output", "json", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), 20)
            except TimeoutError:
                process.kill()
                await process.communicate()
                raise ValueError("Token timeout") from None
            if process.returncode:
                raise ValueError("CLI unavailable")
            data = json.loads(stdout)
            token, expiry = data["accessToken"], float(data.get("expires_on") or time.time() + 600)
        else:
            raise ValueError("No storage identity")
    except (httpx.HTTPError, ValueError, KeyError, OSError):
        raise HTTPException(503, "Azure storage identity is unavailable. Check the app managed identity and its container access.") from None
    _token, _expires = token, expiry - 300
    return token


def blob_path(owner, customer, period, kind, filename):
    parts = [f"workspace-{int(owner)}", f"customer-{customer}", period, kind, filename]
    if any(not re.fullmatch(r"[A-Za-z0-9_.-]+", part) or part in {".", ".."} for part in parts):
        raise HTTPException(422, "Invalid billing storage path.")
    return "/".join(parts)


def headers(token):
    return {"Authorization": f"Bearer {token}", "x-ms-version": "2023-11-03", "x-ms-date": datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")}


async def request(client, method, path="", **kwargs):
    url = destination() + ("/" + quote(path, safe="/") if path else "")
    auth_headers = headers(await access_token())
    auth_headers.update(kwargs.pop("headers", {}))
    try:
        response = await client.request(method, url, headers=auth_headers, **kwargs)
    except httpx.HTTPError:
        raise HTTPException(502, "Azure Blob Storage could not be reached. Retry the request.") from None
    if response.status_code in (401, 403):
        raise HTTPException(503, "Storage access denied. The app identity needs Storage Blob Data Contributor on the billing container.")
    if response.status_code == 404:
        raise HTTPException(404, "Billing document or storage container not found.")
    if response.is_error:
        raise HTTPException(502, f"Azure Blob Storage returned HTTP {response.status_code}. Retry later.")
    return response


async def verify():
    async with httpx.AsyncClient(timeout=30) as client:
        await request(client, "HEAD", params={"restype": "container"})


async def upload(owner, customer, period, kind, filename, content):
    path = blob_path(owner, customer, period, kind, filename)
    async with httpx.AsyncClient(timeout=60) as client:
        await request(client, "PUT", path, headers={"x-ms-blob-type": "BlockBlob", "Content-Type": "application/octet-stream"}, content=content)
    # Prefix distinguishes Blob originals from existing SharePoint rows without
    # rewriting old documents. No publicly usable URL is persisted or returned.
    return {"drive_id": "azure-blob", "id": path, "webUrl": ""}


async def download(owner, customer, path):
    prefix = f"workspace-{int(owner)}/customer-{customer}/"
    if not path.startswith(prefix) or any(part in {".", "..", ""} for part in path.split("/")):
        raise HTTPException(403, "This billing document belongs to another workspace.")
    async with httpx.AsyncClient(timeout=60) as client:
        response = await request(client, "GET", path)
    if len(response.content) > MAX_BYTES:
        raise HTTPException(413, "Document exceeds the download size limit.")
    return response.content


async def delete(owner, customer, path):
    prefix = f"workspace-{int(owner)}/customer-{customer}/"
    if not path.startswith(prefix) or any(part in {".", "..", ""} for part in path.split("/")):
        raise HTTPException(403, "This billing document belongs to another workspace.")
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            await request(client, "DELETE", path)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
