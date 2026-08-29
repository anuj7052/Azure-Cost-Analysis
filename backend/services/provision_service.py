"""
Create Azure resources from this application instead of from the portal.

Everything else in the product reads; `vm_resize` changes one property of one
existing machine. This module brings new resources into existence and starts a
recurring charge, so the constraints are stricter than anywhere else:

  * **Azure decides who may do this, not us.** Every call travels on the
    signed-in user's own delegated token. There is no service principal, no
    stored credential and no elevation. If the person holds Reader on the
    subscription, Azure returns 403 and we show it; the application never
    needs its own idea of who is allowed to build what. That is the whole of
    the "RBAC-wise" requirement, and it is enforced by the party that owns the
    resources rather than by a check in our code that could be wrong.

  * **The model drafts; the person authorises.** The assistant fills in a
    specification and prices it. It cannot deploy. Deployment is a separate,
    explicitly confirmed request naming the exact draft, because a language
    model reading a sentence is not consent to spend money every month, and a
    prompt injected into a resource name must not be able to buy anything.

  * **Validate before create.** Azure's own template validation runs first. It
    checks the schema, the quota story and the caller's permissions without
    creating anything, so the common failures surface as a clear message
    rather than as a half-built resource group.

  * **Nothing is invented.** A missing field is reported as missing and a
    default is labelled as a suggestion. Prices come from the live retail
    price list; when the price list has no answer the cost reads "Not
    available" rather than a plausible number.

Secrets never pass through the assistant. A Linux VM is created with an SSH
*public* key, which is not a secret, and the key travels on the deploy request
rather than through the chat transcript.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

import aiosqlite
import httpx

from services.azure_mgmt import MGMT_BASE
from services.retail_prices import build_filter, cheapest, fetch_prices

log = logging.getLogger(__name__)

RESOURCES_API = "2021-04-01"
DEPLOYMENT_API = "2021-04-01"
REQUEST_TIMEOUT = 60.0

HOURS_PER_MONTH = 730
GIB_PER_MONTH = 1  # storage meters are already priced per GB-month

# States a deployment moves through. Named rather than a spinner, for the same
# reason `vm_resize` names its own: "validating" and "creating" tell the reader
# different things about what exists in their subscription right now.
VALIDATING = "VALIDATING"
CREATING = "CREATING"
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"

TERMINAL_STATES = frozenset({SUCCEEDED, FAILED})

STATE_LABEL = {
    VALIDATING: "Validating with Azure",
    CREATING: "Creating resources",
    SUCCEEDED: "Created",
    FAILED: "Failed",
}


# ── catalogue ───────────────────────────────────────────────────────────────
#
# What the assistant is allowed to build. A closed list rather than "whatever
# ARM accepts" is the point: it bounds what a confused or manipulated model
# can ask for, and it lets every field carry a human explanation and a
# defensible default. Adding a kind is a deliberate act with a template behind
# it, not a matter of the model knowing a resource type string.

CATALOG: Dict[str, Dict[str, Any]] = {
    "linux_vm": {
        "label": "Linux virtual machine",
        "summary": (
            "A Linux VM with everything it needs to be reachable: a virtual "
            "network, a subnet, a network security group allowing SSH, a "
            "public IP and a network interface."
        ),
        "fields": {
            "name": {
                "label": "VM name",
                "required": True,
                "help": "1-15 characters, letters, numbers and hyphens.",
            },
            "size": {
                "label": "VM size",
                "required": True,
                "suggest": "Standard_B2s",
                "help": (
                    "Standard_B2s is 2 vCPU / 4 GiB and burstable — a "
                    "reasonable starting point for a small workload."
                ),
            },
            "admin_username": {
                "label": "Admin username",
                "required": True,
                "suggest": "azureuser",
                "help": "Cannot be 'root', 'admin' or 'administrator'.",
            },
            "image": {
                "label": "OS image",
                "required": False,
                "suggest": "Ubuntu2204",
                "options": ["Ubuntu2204", "Ubuntu2404", "Debian12"],
            },
            "os_disk_gib": {
                "label": "OS disk size (GiB)",
                "required": False,
                "suggest": 30,
            },
            "allow_ssh_from": {
                "label": "Allow SSH from",
                "required": False,
                "suggest": "",
                "help": (
                    "A CIDR such as 203.0.113.4/32. Left empty, no inbound SSH "
                    "rule is created at all, which is the safe default: the "
                    "machine is built but not exposed."
                ),
            },
        },
        # Never asked through the chat. See the module docstring.
        "deploy_only_fields": ["ssh_public_key"],
    },
    "storage_account": {
        "label": "Storage account",
        "summary": "A general-purpose v2 storage account with public blob access disabled.",
        "fields": {
            "name": {
                "label": "Account name",
                "required": True,
                "help": "3-24 characters, lowercase letters and numbers only, globally unique.",
            },
            "sku": {
                "label": "Redundancy",
                "required": False,
                "suggest": "Standard_LRS",
                "options": ["Standard_LRS", "Standard_ZRS", "Standard_GRS"],
            },
            "access_tier": {
                "label": "Access tier",
                "required": False,
                "suggest": "Hot",
                "options": ["Hot", "Cool"],
            },
        },
        "deploy_only_fields": [],
    },
    "web_app": {
        "label": "Web app",
        "summary": "A Linux App Service plan and a web app running on it, with HTTPS enforced.",
        "fields": {
            "name": {
                "label": "App name",
                "required": True,
                "help": "Becomes <name>.azurewebsites.net, so it must be globally unique.",
            },
            "sku": {
                "label": "App Service plan size",
                "required": False,
                "suggest": "B1",
                "options": ["F1", "B1", "B2", "P1v3"],
                "help": "F1 is free but has a daily CPU quota and no Always On.",
            },
            "runtime": {
                "label": "Runtime",
                "required": False,
                "suggest": "PYTHON|3.12",
                "options": ["PYTHON|3.12", "NODE|22-lts", "DOTNETCORE|8.0"],
            },
        },
        "deploy_only_fields": [],
    },
}


def describe_catalog() -> List[Dict[str, Any]]:
    """The catalogue in the shape the assistant is shown."""
    return [
        {
            "kind": kind,
            "label": entry["label"],
            "summary": entry["summary"],
            "fields": [
                {
                    "name": name,
                    "label": f["label"],
                    "required": f["required"],
                    "suggested_default": f.get("suggest"),
                    "options": f.get("options"),
                    "help": f.get("help", ""),
                }
                for name, f in entry["fields"].items()
            ],
        }
        for kind, entry in CATALOG.items()
    ]


# ── validation ──────────────────────────────────────────────────────────────

_VM_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,13}[a-zA-Z0-9]$")
_STORAGE_NAME = re.compile(r"^[a-z0-9]{3,24}$")
_APP_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$")
_RG_NAME = re.compile(r"^[a-zA-Z0-9._()-]{1,90}$")
_LOCATION = re.compile(r"^[a-z0-9]{2,40}$")
_CIDR = re.compile(r"^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$")

RESERVED_USERNAMES = {"root", "admin", "administrator", "user", "test", "guest"}


class ProvisionError(Exception):
    """A refusal we can explain, as opposed to an Azure failure."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def _require_name(kind: str, name: str) -> str:
    name = (name or "").strip()
    if kind == "linux_vm" and not _VM_NAME.match(name):
        raise ProvisionError(
            f"'{name}' is not a valid VM name. Use 2-15 characters: letters, "
            f"numbers and hyphens, starting and ending with a letter or number."
        )
    if kind == "storage_account" and not _STORAGE_NAME.match(name):
        raise ProvisionError(
            f"'{name}' is not a valid storage account name. Use 3-24 "
            f"characters, lowercase letters and numbers only."
        )
    if kind == "web_app" and not _APP_NAME.match(name):
        raise ProvisionError(
            f"'{name}' is not a valid web app name. Use 3-60 characters: "
            f"letters, numbers and hyphens."
        )
    return name


def draft(kind: str, fields: Dict[str, Any]) -> Dict[str, Any]:
    """
    Fill a specification in, and say plainly what is still missing.

    Suggestions are applied to optional fields and *reported* rather than
    silently merged, so the person reviewing the draft can see which values
    they chose and which the assistant chose for them.
    """
    entry = CATALOG.get(kind)
    if entry is None:
        raise ProvisionError(
            f"'{kind}' is not something this assistant can create. "
            f"It can create: {', '.join(CATALOG)}."
        )

    fields = {k: v for k, v in (fields or {}).items() if v not in (None, "")}
    resolved: Dict[str, Any] = {}
    missing: List[Dict[str, Any]] = []
    assumed: List[Dict[str, Any]] = []

    for name, meta in entry["fields"].items():
        if name in fields:
            resolved[name] = fields[name]
            continue
        suggestion = meta.get("suggest")
        if meta["required"]:
            if suggestion in (None, ""):
                missing.append(
                    {"name": name, "label": meta["label"], "help": meta.get("help", "")}
                )
            else:
                resolved[name] = suggestion
                assumed.append(
                    {"name": name, "label": meta["label"], "value": suggestion,
                     "why": meta.get("help", "")}
                )
        elif suggestion not in (None, ""):
            resolved[name] = suggestion
            assumed.append(
                {"name": name, "label": meta["label"], "value": suggestion,
                 "why": meta.get("help", "")}
            )

    if "name" in resolved:
        resolved["name"] = _require_name(kind, str(resolved["name"]))

    if kind == "linux_vm":
        user = str(resolved.get("admin_username", "")).lower()
        if user in RESERVED_USERNAMES:
            raise ProvisionError(
                f"Azure rejects '{user}' as an admin username. Pick another one."
            )
        cidr = str(resolved.get("allow_ssh_from") or "")
        if cidr and not _CIDR.match(cidr):
            raise ProvisionError(
                f"'{cidr}' is not a CIDR range. Use something like 203.0.113.4/32."
            )
        try:
            resolved["os_disk_gib"] = int(resolved.get("os_disk_gib") or 30)
        except (TypeError, ValueError):
            raise ProvisionError("The OS disk size must be a whole number of GiB.") from None
        if not 30 <= resolved["os_disk_gib"] <= 4096:
            raise ProvisionError("The OS disk must be between 30 and 4096 GiB.")

    return {
        "kind": kind,
        "label": entry["label"],
        "fields": resolved,
        "missing": missing,
        "assumed": assumed,
        "ready": not missing,
    }


# ── pricing ─────────────────────────────────────────────────────────────────

async def estimate_monthly(
    spec: Dict[str, Any], location: str, currency: str
) -> Dict[str, Any]:
    """
    What this will cost per month, from the live retail price list.

    Best effort by design. When the price list has no row for a SKU the answer
    is "Not available" — a resource whose price we could not read is not the
    same as a free one, and quoting a guess before someone presses Create
    would be the worst possible place to be wrong.
    """
    kind = spec["kind"]
    fields = spec["fields"]
    unknown = {"monthly": None, "currency": currency, "basis": "Not available"}

    try:
        if kind == "linux_vm":
            flt = build_filter(
                service_name="Virtual Machines",
                arm_sku_name=str(fields.get("size", "")),
                arm_region=location,
            )
            prices = [
                p for p in await fetch_prices(flt, currency)
                if "windows" not in (p.get("product_name") or "").lower()
                and "spot" not in (p.get("meter_name") or "").lower()
                and "low priority" not in (p.get("meter_name") or "").lower()
            ]
            row = cheapest(prices)
            if not row or not row.get("retail_price"):
                return unknown
            return {
                "monthly": round(row["retail_price"] * HOURS_PER_MONTH, 2),
                "currency": currency,
                "basis": f"{fields.get('size')} at {HOURS_PER_MONTH} hours/month, compute only",
                "note": "The OS disk and public IP are charged separately.",
            }

        if kind == "web_app":
            sku = str(fields.get("sku", ""))
            if sku == "F1":
                return {"monthly": 0.0, "currency": currency,
                        "basis": "F1 is the free App Service tier"}
            flt = build_filter(service_name="Azure App Service", arm_region=location)
            prices = [
                p for p in await fetch_prices(flt, currency)
                if sku.lower() in (p.get("sku_name") or "").lower()
                and "linux" in (p.get("product_name") or "").lower()
            ]
            row = cheapest(prices)
            if not row or not row.get("retail_price"):
                return unknown
            return {
                "monthly": round(row["retail_price"] * HOURS_PER_MONTH, 2),
                "currency": currency,
                "basis": f"App Service {sku} at {HOURS_PER_MONTH} hours/month",
            }

        if kind == "storage_account":
            # An empty storage account costs almost nothing; the bill follows
            # the data put into it, which nobody can know yet. Saying so is
            # more useful than a zero that looks like a promise.
            return {
                "monthly": None,
                "currency": currency,
                "basis": "Charged on the data stored and transactions used",
                "note": "An empty account costs almost nothing; the bill follows usage.",
            }
    except Exception:  # pragma: no cover - pricing must never block a draft
        log.warning("Could not price %s in %s", kind, location, exc_info=True)
        return unknown

    return unknown


# ── ARM template ────────────────────────────────────────────────────────────

_IMAGES = {
    "Ubuntu2204": {"publisher": "Canonical", "offer": "0001-com-ubuntu-server-jammy",
                   "sku": "22_04-lts-gen2", "version": "latest"},
    "Ubuntu2404": {"publisher": "Canonical", "offer": "ubuntu-24_04-lts",
                   "sku": "server", "version": "latest"},
    "Debian12": {"publisher": "Debian", "offer": "debian-12",
                 "sku": "12-gen2", "version": "latest"},
}


def _vm_resources(f: Dict[str, Any], location: str, ssh_key: str) -> List[Dict[str, Any]]:
    name = f["name"]
    vnet, nsg, pip, nic = f"{name}-vnet", f"{name}-nsg", f"{name}-ip", f"{name}-nic"
    image = _IMAGES.get(str(f.get("image", "Ubuntu2204")), _IMAGES["Ubuntu2204"])
    cidr = str(f.get("allow_ssh_from") or "")

    # No source range means no inbound rule. A network security group with no
    # rules still denies inbound by default, so the machine is created but
    # not reachable from the internet until someone says from where.
    rules = []
    if cidr:
        rules.append({
            "name": "allow-ssh",
            "properties": {
                "priority": 300, "protocol": "Tcp", "access": "Allow",
                "direction": "Inbound", "sourceAddressPrefix": cidr,
                "sourcePortRange": "*", "destinationAddressPrefix": "*",
                "destinationPortRange": "22",
            },
        })

    return [
        {
            "type": "Microsoft.Network/networkSecurityGroups", "apiVersion": "2023-11-01",
            "name": nsg, "location": location,
            "properties": {"securityRules": rules},
        },
        {
            "type": "Microsoft.Network/virtualNetworks", "apiVersion": "2023-11-01",
            "name": vnet, "location": location,
            "dependsOn": [f"[resourceId('Microsoft.Network/networkSecurityGroups', '{nsg}')]"],
            "properties": {
                "addressSpace": {"addressPrefixes": ["10.20.0.0/16"]},
                "subnets": [{
                    "name": "default",
                    "properties": {
                        "addressPrefix": "10.20.1.0/24",
                        "networkSecurityGroup": {
                            "id": f"[resourceId('Microsoft.Network/networkSecurityGroups', '{nsg}')]"
                        },
                    },
                }],
            },
        },
        {
            "type": "Microsoft.Network/publicIPAddresses", "apiVersion": "2023-11-01",
            "name": pip, "location": location,
            "sku": {"name": "Standard"},
            "properties": {"publicIPAllocationMethod": "Static"},
        },
        {
            "type": "Microsoft.Network/networkInterfaces", "apiVersion": "2023-11-01",
            "name": nic, "location": location,
            "dependsOn": [
                f"[resourceId('Microsoft.Network/virtualNetworks', '{vnet}')]",
                f"[resourceId('Microsoft.Network/publicIPAddresses', '{pip}')]",
            ],
            "properties": {
                "ipConfigurations": [{
                    "name": "ipconfig1",
                    "properties": {
                        "privateIPAllocationMethod": "Dynamic",
                        "subnet": {
                            "id": f"[resourceId('Microsoft.Network/virtualNetworks/subnets', '{vnet}', 'default')]"
                        },
                        "publicIPAddress": {
                            "id": f"[resourceId('Microsoft.Network/publicIPAddresses', '{pip}')]"
                        },
                    },
                }]
            },
        },
        {
            "type": "Microsoft.Compute/virtualMachines", "apiVersion": "2024-07-01",
            "name": name, "location": location,
            "dependsOn": [f"[resourceId('Microsoft.Network/networkInterfaces', '{nic}')]"],
            "properties": {
                "hardwareProfile": {"vmSize": f["size"]},
                "storageProfile": {
                    "imageReference": image,
                    "osDisk": {
                        "createOption": "FromImage",
                        "diskSizeGB": f["os_disk_gib"],
                        "managedDisk": {"storageAccountType": "Premium_LRS"},
                    },
                },
                "osProfile": {
                    "computerName": name,
                    "adminUsername": f["admin_username"],
                    "linuxConfiguration": {
                        # Password authentication is not offered at all. There
                        # is no field for it, so there is no way for a weak one
                        # to reach Azure from here.
                        "disablePasswordAuthentication": True,
                        "ssh": {"publicKeys": [{
                            "path": f"/home/{f['admin_username']}/.ssh/authorized_keys",
                            "keyData": ssh_key,
                        }]},
                    },
                },
                "networkProfile": {"networkInterfaces": [{
                    "id": f"[resourceId('Microsoft.Network/networkInterfaces', '{nic}')]"
                }]},
            },
        },
    ]


def _storage_resources(f: Dict[str, Any], location: str) -> List[Dict[str, Any]]:
    return [{
        "type": "Microsoft.Storage/storageAccounts", "apiVersion": "2023-05-01",
        "name": f["name"], "location": location,
        "sku": {"name": f.get("sku", "Standard_LRS")},
        "kind": "StorageV2",
        "properties": {
            "accessTier": f.get("access_tier", "Hot"),
            "minimumTlsVersion": "TLS1_2",
            "supportsHttpsTrafficOnly": True,
            # Anonymous container access is the single most common way a
            # storage account leaks. It is off, and there is no field to
            # turn it on from the assistant.
            "allowBlobPublicAccess": False,
        },
    }]


def _web_app_resources(f: Dict[str, Any], location: str) -> List[Dict[str, Any]]:
    name = f["name"]
    plan = f"{name}-plan"
    sku = f.get("sku", "B1")
    return [
        {
            "type": "Microsoft.Web/serverfarms", "apiVersion": "2023-12-01",
            "name": plan, "location": location,
            "sku": {"name": sku},
            "kind": "linux",
            "properties": {"reserved": True},
        },
        {
            "type": "Microsoft.Web/sites", "apiVersion": "2023-12-01",
            "name": name, "location": location,
            "dependsOn": [f"[resourceId('Microsoft.Web/serverfarms', '{plan}')]"],
            "properties": {
                "serverFarmId": f"[resourceId('Microsoft.Web/serverfarms', '{plan}')]",
                "httpsOnly": True,
                "siteConfig": {
                    "linuxFxVersion": f.get("runtime", "PYTHON|3.12"),
                    "minTlsVersion": "1.2",
                    "ftpsState": "Disabled",
                },
            },
        },
    ]


def build_template(
    specs: List[Dict[str, Any]], location: str, ssh_key: str = ""
) -> Dict[str, Any]:
    if not _LOCATION.match(location or ""):
        raise ProvisionError(f"'{location}' is not a valid Azure region name.")

    resources: List[Dict[str, Any]] = []
    for spec in specs:
        kind = spec["kind"]
        fields = spec["fields"]
        if kind == "linux_vm":
            if not ssh_key.strip():
                raise ProvisionError(
                    "A Linux VM needs an SSH public key. Paste the contents of "
                    "your id_rsa.pub or id_ed25519.pub — it is a public key, "
                    "not a secret, and it is the only way in once the machine "
                    "is built."
                )
            if not ssh_key.strip().startswith(("ssh-rsa ", "ssh-ed25519 ", "ecdsa-sha2-")):
                raise ProvisionError(
                    "That does not look like an SSH public key. It should "
                    "start with 'ssh-rsa' or 'ssh-ed25519'."
                )
            resources += _vm_resources(fields, location, ssh_key.strip())
        elif kind == "storage_account":
            resources += _storage_resources(fields, location)
        elif kind == "web_app":
            resources += _web_app_resources(fields, location)
        else:
            raise ProvisionError(f"'{kind}' is not something this assistant can create.")

    return {
        "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        "contentVersion": "1.0.0.0",
        "parameters": {},
        "resources": resources,
    }


# ── Azure calls ─────────────────────────────────────────────────────────────

def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _azure_message(response: httpx.Response, fallback: str) -> str:
    """Pull Azure's own explanation out, because ours is always vaguer."""
    try:
        body = response.json()
    except ValueError:
        return fallback
    error = body.get("error") or body
    parts = []
    message = error.get("message")
    if message:
        parts.append(str(message))
    for detail in (error.get("details") or [])[:3]:
        if isinstance(detail, dict) and detail.get("message"):
            parts.append(str(detail["message"]))
    return " ".join(parts) or fallback


async def ensure_resource_group(
    token: str, subscription_id: str, name: str, location: str
) -> bool:
    """
    Create the resource group if it is not already there. Returns True if it
    was created, so the caller can tell the person what changed on their behalf.
    """
    if not _RG_NAME.match(name or ""):
        raise ProvisionError(f"'{name}' is not a valid resource group name.")

    url = (f"{MGMT_BASE}/subscriptions/{subscription_id}/resourcegroups/"
           f"{name}?api-version={RESOURCES_API}")
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        existing = await client.get(url, headers=_headers(token))
        if existing.status_code == 200:
            return False
        if existing.status_code == 403:
            raise ProvisionError(
                _azure_message(existing, "Azure refused to read that resource group."),
                status_code=403,
            )
        created = await client.put(
            url, headers=_headers(token), json={"location": location}
        )
        if created.status_code >= 400:
            raise ProvisionError(
                _azure_message(created, "Azure refused to create the resource group."),
                status_code=created.status_code if created.status_code == 403 else 400,
            )
    return True


async def validate(
    token: str, subscription_id: str, resource_group: str,
    deployment_name: str, template: Dict[str, Any],
) -> None:
    """
    Ask Azure whether this deployment would work, without creating anything.

    This is the permission check as well as the schema check. Azure evaluates
    the caller's RBAC here, so a Reader is told so before any resource exists
    rather than halfway through.
    """
    url = (f"{MGMT_BASE}/subscriptions/{subscription_id}/resourcegroups/{resource_group}"
           f"/providers/Microsoft.Resources/deployments/{deployment_name}/validate"
           f"?api-version={DEPLOYMENT_API}")
    body = {"properties": {"mode": "Incremental", "template": template}}
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.post(url, headers=_headers(token), json=body)

    if response.status_code == 403:
        raise ProvisionError(
            _azure_message(
                response,
                "Your Azure account does not have permission to create these "
                "resources. Ask for the Contributor role on this subscription "
                "or resource group.",
            ),
            status_code=403,
        )
    if response.status_code >= 400:
        raise ProvisionError(
            _azure_message(response, "Azure rejected this deployment."),
            status_code=400,
        )

    # A 200 can still carry a validation error in the body.
    try:
        payload = response.json()
    except ValueError:
        return
    if isinstance(payload, dict) and payload.get("error"):
        raise ProvisionError(
            _azure_message(response, "Azure rejected this deployment."), status_code=400
        )


async def start_deployment(
    token: str, subscription_id: str, resource_group: str,
    deployment_name: str, template: Dict[str, Any],
) -> None:
    url = (f"{MGMT_BASE}/subscriptions/{subscription_id}/resourcegroups/{resource_group}"
           f"/providers/Microsoft.Resources/deployments/{deployment_name}"
           f"?api-version={DEPLOYMENT_API}")
    body = {"properties": {"mode": "Incremental", "template": template}}
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.put(url, headers=_headers(token), json=body)
    if response.status_code >= 400:
        raise ProvisionError(
            _azure_message(response, "Azure refused to start the deployment."),
            status_code=403 if response.status_code == 403 else 400,
        )


async def deployment_status(
    token: str, subscription_id: str, resource_group: str, deployment_name: str
) -> Tuple[str, str, List[Dict[str, str]]]:
    """Azure's own view: (state, message, created resources)."""
    base = (f"{MGMT_BASE}/subscriptions/{subscription_id}/resourcegroups/{resource_group}"
            f"/providers/Microsoft.Resources/deployments/{deployment_name}")
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.get(
            f"{base}?api-version={DEPLOYMENT_API}", headers=_headers(token)
        )
        if response.status_code >= 400:
            return CREATING, "", []
        props = (response.json() or {}).get("properties") or {}
        state = str(props.get("provisioningState") or "")

        if state == "Succeeded":
            resources = [
                {"id": r.get("id", ""), "name": r.get("id", "").rsplit("/", 1)[-1]}
                for r in (props.get("outputResources") or [])
                if r.get("id")
            ]
            return SUCCEEDED, "", resources
        if state == "Failed":
            error = props.get("error") or {}
            message = str(error.get("message") or "Azure reported the deployment failed.")
            for detail in (error.get("details") or [])[:3]:
                if isinstance(detail, dict) and detail.get("message"):
                    message += " " + str(detail["message"])
            return FAILED, message, []
    return CREATING, "", []


# ── record keeping ──────────────────────────────────────────────────────────

async def record(
    db: aiosqlite.Connection, account_id: int, actor_id: Optional[int],
    tenant_id: str, subscription_id: str, resource_group: str, location: str,
    specs: List[Dict[str, Any]], estimated_monthly: Optional[float], currency: str,
) -> Dict[str, Any]:
    deployment_id = uuid.uuid4().hex
    # Azure requires the deployment name to be unique and stable; deriving it
    # from our own id keeps the two records tied together in both directions.
    deployment_name = f"aca-{deployment_id[:20]}"
    await db.execute(
        """INSERT INTO provision_deployments
               (id, account_id, actor_id, tenant_id, subscription_id, resource_group,
                location, deployment_name, spec_json, state, estimated_monthly, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (deployment_id, account_id, actor_id, tenant_id, subscription_id, resource_group,
         location, deployment_name, json.dumps(specs), VALIDATING, estimated_monthly, currency),
    )
    await db.commit()
    return {"id": deployment_id, "deployment_name": deployment_name}


async def set_state(
    db: aiosqlite.Connection, deployment_id: str, state: str,
    message: str = "", resources: Optional[List[Dict[str, str]]] = None,
) -> None:
    finished = "CURRENT_TIMESTAMP" if state in TERMINAL_STATES else "finished_at"
    await db.execute(
        f"""UPDATE provision_deployments
               SET state = ?, message = ?, resources_json = ?, finished_at = {finished}
             WHERE id = ?""",
        (state, message, json.dumps(resources or []), deployment_id),
    )
    await db.commit()


def to_public(row: aiosqlite.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "subscription_id": row["subscription_id"],
        "resource_group": row["resource_group"],
        "location": row["location"],
        "state": row["state"],
        "state_label": STATE_LABEL.get(row["state"], row["state"]),
        "message": row["message"],
        "spec": json.loads(row["spec_json"] or "[]"),
        "resources": json.loads(row["resources_json"] or "[]"),
        "estimated_monthly": row["estimated_monthly"],
        "currency": row["currency"],
        "created_at": row["created_at"],
        "finished_at": row["finished_at"],
    }


async def get_deployment(
    db: aiosqlite.Connection, account_id: int, deployment_id: str
) -> Optional[Dict[str, Any]]:
    async with db.execute(
        "SELECT * FROM provision_deployments WHERE id = ? AND account_id = ?",
        (deployment_id, account_id),
    ) as cursor:
        row = await cursor.fetchone()
    return to_public(row) if row else None


async def list_deployments(
    db: aiosqlite.Connection, account_id: int, limit: int = 20
) -> List[Dict[str, Any]]:
    async with db.execute(
        """SELECT * FROM provision_deployments WHERE account_id = ?
           ORDER BY created_at DESC LIMIT ?""",
        (account_id, limit),
    ) as cursor:
        return [to_public(row) for row in await cursor.fetchall()]
