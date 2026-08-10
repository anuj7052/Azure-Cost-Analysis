"""Turn a parsed BOQ into a deployable infrastructure plan.

The estimate describes *what was priced*, not *what to build*: a line reads
"Managed Disks, Premium SSD, LRS Redundancy, P40 Disk Type 1 Disks" and means
one 2 TiB premium disk. This module recovers that intent and emits Bicep and
Terraform for it.

Deliberately generation-only. Nothing here calls Azure or holds write
credentials — the customer reviews the output and runs it themselves, so the
platform never needs more than its read-only `Reader` +
`Cost Management Reader` grants.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Standard Azure managed-disk sizes, keyed by the number in the SKU (P30, E20…).
DISK_TIER_GIB = {
    1: 4, 2: 8, 3: 16, 4: 32, 6: 64, 10: 128, 15: 256, 20: 512,
    30: 1024, 40: 2048, 50: 4096, 60: 8192, 70: 16384, 80: 32767,
}
DISK_FAMILY = {"p": "Premium_LRS", "e": "StandardSSD_LRS", "s": "Standard_LRS"}

_DISK_SKU = re.compile(r"\b([PSE])(\d{1,2})\b")
_VM_SIZE = re.compile(r"\b([A-Z]{1,2}\d{1,3}[a-z]*(?:-\d{1,3}[a-z]*)?\s+v\d)\b", re.IGNORECASE)
_QTY = re.compile(r"(?<![A-Za-z0-9])(\d+)\s+(?:x\s*)?(?:disks?|instances?|instance\(s\)|vms?)\b", re.IGNORECASE)
_REDUNDANCY = re.compile(r"\b(LRS|ZRS|GRS|RAGRS|GZRS)\b", re.IGNORECASE)

# Service types that are configuration on an existing resource rather than a
# resource of their own, so generating a block for them would be wrong.
_NON_DEPLOYABLE = {
    "support": "Azure support plan — bought in the portal, not deployed.",
    "managed services": "A services retainer, not an Azure resource.",
    "azure ddos protection": "Tenant-level plan; attach to a VNet after review.",
}


def slugify(text: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:60] or fallback


def normalise_region(region: str) -> str:
    """"Central India" -> "centralindia"; already-normalised values pass through."""
    return re.sub(r"[^a-z0-9]", "", (region or "").lower()) or "centralindia"


@dataclass
class ResourceSpec:
    """One deployable resource recovered from a BOQ line."""

    kind: str
    name: str
    region: str
    count: int = 1
    sku: str = ""
    size_gib: int | None = None
    properties: dict[str, Any] = field(default_factory=dict)
    source_line: str = ""
    monthly_cost: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "name": self.name,
            "region": self.region,
            "count": self.count,
            "sku": self.sku,
            "size_gib": self.size_gib,
            "properties": self.properties,
            "source_line": self.source_line,
            "monthly_cost": self.monthly_cost,
        }


def _quantity(text: str) -> int:
    # The lookbehind keeps the SKU's own number out of it: in "S40 Disk Type 1
    # Disks" the quantity is 1, not 40.
    match = _QTY.search(text or "")
    return max(1, int(match.group(1))) if match else 1


def _classify(item: dict[str, Any]) -> ResourceSpec | tuple[None, str]:
    """Recover the resource a BOQ line describes, or say why it cannot be built."""
    service_type = (item.get("service_type") or "").strip()
    description = item.get("description") or ""
    haystack = f"{service_type} {description}"
    lowered = haystack.lower()
    region = normalise_region(item.get("region", ""))
    label = item.get("custom_name") or service_type
    cost = float(item.get("monthly_cost") or 0.0)

    for needle, reason in _NON_DEPLOYABLE.items():
        if needle in service_type.lower():
            return None, reason

    disk = _DISK_SKU.search(haystack)
    if disk and "disk" in lowered:
        family, tier = disk.group(1).lower(), int(disk.group(2))
        redundancy = _REDUNDANCY.search(haystack)
        sku = DISK_FAMILY.get(family, "Premium_LRS")
        if redundancy and redundancy.group(1).upper() == "ZRS":
            sku = sku.replace("_LRS", "_ZRS")
        return ResourceSpec(
            kind="managed_disk",
            name=slugify(label, f"disk-{family}{tier}"),
            region=region,
            count=_quantity(haystack),
            sku=sku,
            size_gib=DISK_TIER_GIB.get(tier),
            properties={"performance_tier": f"{family.upper()}{tier}"},
            source_line=haystack.strip(),
            monthly_cost=cost,
        )

    vm = _VM_SIZE.search(haystack)
    if vm and "virtual machine" in lowered:
        size = "Standard_" + vm.group(1).replace(" ", "_")
        return ResourceSpec(
            kind="virtual_machine",
            name=slugify(label, "vm"),
            region=region,
            count=_quantity(haystack),
            sku=size,
            properties={"os": "Linux" if "linux" in lowered else "Windows"},
            source_line=haystack.strip(),
            monthly_cost=cost,
        )

    if "storage account" in lowered or "blob storage" in lowered:
        redundancy = _REDUNDANCY.search(haystack)
        return ResourceSpec(
            kind="storage_account",
            name=re.sub(r"[^a-z0-9]", "", slugify(label, "storage"))[:24] or "boqstorage",
            region=region,
            sku=f"Standard_{(redundancy.group(1) if redundancy else 'LRS').upper()}",
            source_line=haystack.strip(),
            monthly_cost=cost,
        )

    if "public ip" in lowered or "ip address" in lowered:
        return ResourceSpec(
            kind="public_ip",
            name=slugify(label, "pip"),
            region=region,
            count=_quantity(haystack),
            sku="Standard",
            source_line=haystack.strip(),
            monthly_cost=cost,
        )

    if "virtual network" in lowered or "vnet" in lowered:
        return ResourceSpec(
            kind="virtual_network",
            name=slugify(label, "vnet"),
            region=region,
            properties={"address_space": "10.0.0.0/16", "subnet": "10.0.1.0/24"},
            source_line=haystack.strip(),
            monthly_cost=cost,
        )

    if "recovery" in lowered or "backup" in lowered or "site recovery" in lowered:
        return ResourceSpec(
            kind="recovery_vault",
            name=slugify(label, "rsv"),
            region=region,
            sku="Standard",
            source_line=haystack.strip(),
            monthly_cost=cost,
        )

    return None, (
        f"No deployable resource could be recovered from '{service_type}'. "
        "Add it to the template by hand."
    )


def build_plan(boq: dict[str, Any], resource_group: str = "rg-boq") -> dict[str, Any]:
    """Group a parsed BOQ into resources to deploy and lines that need review."""
    resources: list[ResourceSpec] = []
    review: list[dict[str, Any]] = []

    for item in boq.get("items", []):
        outcome = _classify(item)
        if isinstance(outcome, ResourceSpec):
            resources.append(outcome)
        else:
            review.append(
                {
                    "service_type": item.get("service_type", ""),
                    "custom_name": item.get("custom_name", ""),
                    "description": item.get("description", ""),
                    "monthly_cost": item.get("monthly_cost", 0.0),
                    "reason": outcome[1],
                }
            )

    # Names must be unique inside a resource group, so disambiguate collisions.
    seen: dict[str, int] = {}
    for spec in resources:
        seen[spec.name] = seen.get(spec.name, 0) + 1
        if seen[spec.name] > 1:
            spec.name = f"{spec.name}-{seen[spec.name]}"

    region = next((r.region for r in resources), "centralindia")
    covered = round(sum(r.monthly_cost for r in resources), 2)
    return {
        "name": boq.get("name", ""),
        "currency": boq.get("currency", "INR"),
        "resource_group": resource_group,
        "location": region,
        "resources": [r.as_dict() for r in resources],
        "needs_review": review,
        "covered_monthly_cost": covered,
        "total_monthly_cost": boq.get("total_monthly", covered),
    }


# --- emitters ---------------------------------------------------------


def _bicep_block(spec: dict[str, Any], index: int) -> str:
    kind, name, sym = spec["kind"], spec["name"], f"res{index}"
    loop = "" if spec["count"] == 1 else f"[for i in range(0, {spec['count']}): "
    close = "" if spec["count"] == 1 else "]"
    suffix = "" if spec["count"] == 1 else "-${i}"

    if kind == "managed_disk":
        return f"""resource {sym} 'Microsoft.Compute/disks@2023-04-02' = {loop}{{
  name: '{name}{suffix}'
  location: location
  sku: {{ name: '{spec["sku"]}' }}
  properties: {{
    creationData: {{ createOption: 'Empty' }}
    diskSizeGB: {spec["size_gib"]}
  }}
  tags: tags
}}{close}"""

    if kind == "storage_account":
        return f"""resource {sym} 'Microsoft.Storage/storageAccounts@2023-05-01' = {{
  name: '{name}'
  location: location
  sku: {{ name: '{spec["sku"]}' }}
  kind: 'StorageV2'
  properties: {{
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }}
  tags: tags
}}"""

    if kind == "public_ip":
        return f"""resource {sym} 'Microsoft.Network/publicIPAddresses@2023-11-01' = {loop}{{
  name: '{name}{suffix}'
  location: location
  sku: {{ name: 'Standard' }}
  properties: {{ publicIPAllocationMethod: 'Static' }}
  tags: tags
}}{close}"""

    if kind == "virtual_network":
        props = spec["properties"]
        return f"""resource {sym} 'Microsoft.Network/virtualNetworks@2023-11-01' = {{
  name: '{name}'
  location: location
  properties: {{
    addressSpace: {{ addressPrefixes: [ '{props["address_space"]}' ] }}
    subnets: [
      {{ name: 'default', properties: {{ addressPrefix: '{props["subnet"]}' }} }}
    ]
  }}
  tags: tags
}}"""

    if kind == "recovery_vault":
        return f"""resource {sym} 'Microsoft.RecoveryServices/vaults@2023-06-01' = {{
  name: '{name}'
  location: location
  sku: {{ name: 'Standard', tier: 'Standard' }}
  properties: {{}}
  tags: tags
}}"""

    # Virtual machines need an image, credentials and a NIC, which the estimate
    # never states. Emit the shape and make the gaps explicit instead of
    # guessing production values.
    return f"""// TODO: review before deploying — the BOQ does not state the image,
// admin credentials or network placement for this virtual machine.
// resource {sym} 'Microsoft.Compute/virtualMachines@2024-03-01' = {loop}{{
//   name: '{name}{suffix}'
//   location: location
//   properties: {{ hardwareProfile: {{ vmSize: '{spec["sku"]}' }} }}
// }}{close}"""


def to_bicep(plan: dict[str, Any]) -> str:
    header = f"""// Generated from the Azure Pricing Calculator estimate: {plan["name"]}
// Review every value before deploying. Estimated cost of the generated
// resources: {plan["covered_monthly_cost"]} {plan["currency"]} per month.
targetScope = 'resourceGroup'

param location string = '{plan["location"]}'
param tags object = {{
  source: 'boq'
  estimate: '{plan["name"][:120]}'
}}
"""
    blocks = [_bicep_block(r, i) for i, r in enumerate(plan["resources"])]
    review = "".join(
        f"\n// NEEDS REVIEW: {r['service_type']} — {r['reason']}" for r in plan["needs_review"]
    )
    return "\n\n".join([header, *blocks]) + review + "\n"


def _terraform_block(spec: dict[str, Any], index: int) -> str:
    kind, name, sym = spec["kind"], spec["name"], f"res{index}"
    count = "" if spec["count"] == 1 else f"\n  count               = {spec['count']}"
    suffix = "" if spec["count"] == 1 else "-${count.index}"

    if kind == "managed_disk":
        return f"""resource "azurerm_managed_disk" "{sym}" {{{count}
  name                 = "{name}{suffix}"
  location             = var.location
  resource_group_name  = azurerm_resource_group.this.name
  storage_account_type = "{spec["sku"]}"
  create_option        = "Empty"
  disk_size_gb         = {spec["size_gib"]}
  tags                 = var.tags
}}"""

    if kind == "storage_account":
        tier, replication = spec["sku"].split("_", 1)
        return f"""resource "azurerm_storage_account" "{sym}" {{
  name                          = "{name}"
  location                      = var.location
  resource_group_name           = azurerm_resource_group.this.name
  account_tier                  = "{tier}"
  account_replication_type      = "{replication}"
  min_tls_version               = "TLS1_2"
  public_network_access_enabled = false
  tags                          = var.tags
}}"""

    if kind == "public_ip":
        return f"""resource "azurerm_public_ip" "{sym}" {{{count}
  name                = "{name}{suffix}"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}}"""

    if kind == "virtual_network":
        props = spec["properties"]
        return f"""resource "azurerm_virtual_network" "{sym}" {{
  name                = "{name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = ["{props["address_space"]}"]
  tags                = var.tags
}}

resource "azurerm_subnet" "{sym}_default" {{
  name                 = "default"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.{sym}.name
  address_prefixes     = ["{props["subnet"]}"]
}}"""

    if kind == "recovery_vault":
        return f"""resource "azurerm_recovery_services_vault" "{sym}" {{
  name                = "{name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "Standard"
  soft_delete_enabled = true
  tags                = var.tags
}}"""

    return f"""# TODO: review before deploying — the BOQ does not state the image,
# admin credentials or network placement for this virtual machine ({spec["sku"]}).
# resource "azurerm_linux_virtual_machine" "{sym}" {{
#   name                = "{name}"
#   size                = "{spec["sku"]}"
# }}"""


def to_terraform(plan: dict[str, Any]) -> str:
    header = f"""# Generated from the Azure Pricing Calculator estimate: {plan["name"]}
# Review every value before running `terraform apply`. Estimated cost of the
# generated resources: {plan["covered_monthly_cost"]} {plan["currency"]} per month.

terraform {{
  required_providers {{
    azurerm = {{
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }}
  }}
}}

provider "azurerm" {{
  features {{}}
}}

variable "location" {{
  type    = string
  default = "{plan["location"]}"
}}

variable "resource_group_name" {{
  type    = string
  default = "{plan["resource_group"]}"
}}

variable "tags" {{
  type    = map(string)
  default = {{
    source = "boq"
  }}
}}

resource "azurerm_resource_group" "this" {{
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}}"""
    blocks = [_terraform_block(r, i) for i, r in enumerate(plan["resources"])]
    review = "".join(
        f"\n# NEEDS REVIEW: {r['service_type']} — {r['reason']}" for r in plan["needs_review"]
    )
    return "\n\n".join([header, *blocks]) + review + "\n"


def render(plan: dict[str, Any], fmt: str) -> str:
    if fmt == "bicep":
        return to_bicep(plan)
    if fmt == "terraform":
        return to_terraform(plan)
    raise ValueError("Unsupported format. Use 'bicep' or 'terraform'.")
