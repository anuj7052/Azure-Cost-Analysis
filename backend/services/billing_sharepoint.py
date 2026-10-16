"""Delegated Microsoft Graph storage. Tokens are forwarded, never persisted.

Only Graph URLs built here receive the token. User-supplied SharePoint URLs
are parsed into a hostname/site path, never used as HTTP destinations.
"""
from urllib.parse import quote, urlparse, unquote
import httpx
from fastapi import HTTPException

GRAPH = "https://graph.microsoft.com/v1.0"


def segment(value):
    return quote(str(value), safe="")


def site_address(url):
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or not host.endswith(".sharepoint.com") or
            parsed.username or parsed.password or parsed.port or parsed.query or parsed.fragment):
        raise HTTPException(422, "Enter the SharePoint site URL, for example https://company.sharepoint.com/sites/Finance. Choose the library and folder separately.")
    path = unquote(parsed.path).rstrip("/")
    if path and not (path.startswith("/sites/") or path.startswith("/teams/")):
        raise HTTPException(422, "Use the SharePoint site URL, not a file-sharing link.")
    if any(part in {".", ".."} for part in path.split("/")):
        raise HTTPException(422, "Invalid SharePoint site path.")
    return host, quote(path, safe="/")


async def graph(client, token, method, path, **kwargs):
    try:
        response = await client.request(method, GRAPH + path, headers={"Authorization": f"Bearer {token}"}, **kwargs)
    except httpx.HTTPError:
        raise HTTPException(502, "SharePoint could not be reached. Check the connection and retry.") from None
    if response.status_code in (401, 403):
        raise HTTPException(403, "SharePoint access was refused. Connect Microsoft with file access and check your permission on this library.")
    if response.status_code == 429:
        raise HTTPException(429, "Microsoft Graph is throttling requests. Wait before retrying.")
    if response.is_error:
        raise HTTPException(502, f"SharePoint request failed (HTTP {response.status_code}). Check the selected site, library and folder.")
    return response.json() if response.content else {}


async def verify_identity(client, token, user):
    if not token:
        raise HTTPException(403, "Connect Microsoft file access before uploading bills to SharePoint.")
    profile = await graph(client, token, "GET", "/me?$select=id")
    if not user.get("user_id") or profile.get("id", "").lower() != user["user_id"].lower():
        raise HTTPException(403, "Use the same Microsoft identity for this workspace and SharePoint.")


async def resolve_folder(client, token, site_url, library, folder):
    host, path = site_address(site_url)
    site = await graph(client, token, "GET", f"/sites/{host}:{path or '/'}")
    drives = await graph(client, token, "GET", f"/sites/{segment(site['id'])}/drives")
    matches = [d for d in drives.get("value", []) if str(d.get("name", "")).casefold() == library.casefold()]
    if len(matches) != 1:
        raise HTTPException(422, "Document library not found. Enter its exact display name (often Documents).")
    drive = matches[0]["id"]
    parts = [part for part in folder.strip("/").split("/") if part]
    if any(part in {".", ".."} for part in parts):
        raise HTTPException(422, "Invalid folder path.")
    suffix = ":/" + "/".join(segment(part) for part in parts) if parts else ""
    item = await graph(client, token, "GET", f"/drives/{segment(drive)}/root{suffix}")
    if "folder" not in item:
        raise HTTPException(422, "The selected destination is not a folder.")
    return {"drive_id": drive, "folder_id": item["id"], "folder_url": item.get("webUrl", site_url)}


async def ensure_folder(client, token, drive, parent, name):
    base = f"/drives/{segment(drive)}/items/{segment(parent)}"
    # Graph conflictBehavior=fail avoids duplicate directory trees on retries.
    try:
        response = await client.post(GRAPH + base + "/children", headers={"Authorization": f"Bearer {token}"}, json={"name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})
    except httpx.HTTPError:
        raise HTTPException(502, "SharePoint could not be reached. Retry the upload; identical originals are deduplicated.") from None
    if response.status_code == 409:
        item = await graph(client, token, "GET", f"{base}:/{segment(name)}")
    elif response.is_success:
        item = response.json()
    else:
        raise HTTPException(502, "Could not create the customer billing folder in SharePoint. Check write access.")
    if "folder" not in item:
        raise HTTPException(409, "A file already uses the required billing folder name.")
    return item["id"]


async def upload(client, token, connection, owner, customer, period, kind, filename, content):
    parent = connection["folder_id"]
    drive = connection["drive_id"]
    for name in ("Azure Billing", f"workspace-{owner}", f"customer-{customer}", period, kind):
        parent = await ensure_folder(client, token, drive, parent, name)
    return await graph(client, token, "PUT", f"/drives/{segment(drive)}/items/{segment(parent)}:/{segment(filename)}:/content", content=content)
