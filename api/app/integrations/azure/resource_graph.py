from __future__ import annotations

import logging
from typing import Any

from azure.mgmt.resourcegraph.aio import ResourceGraphClient
from azure.mgmt.resourcegraph.models import (
    QueryRequest,
    QueryRequestOptions,
    ResultFormat,
)

from app.core.config import settings
from app.integrations.azure.credentials import ConnectionContext, credential_provider
from app.integrations.azure.retry import with_retry

log = logging.getLogger(__name__)

# --- KQL library -------------------------------------------------------
INVENTORY_QUERY = """
Resources
| where type in~ ({types})
| extend powerState = tostring(properties.extended.instanceView.powerState.code)
| project id, name, type, kind, location, resourceGroup, subscriptionId,
          tags, sku, properties, powerState,
          provisioningState = tostring(properties.provisioningState)
"""

UNATTACHED_DISKS = """
Resources
| where type =~ 'microsoft.compute/disks'
| where isnull(properties.managedBy) or properties.managedBy == ''
| project id, name, resourceGroup, subscriptionId, location,
          sizeGb = toint(properties.diskSizeGB), sku = tostring(sku.name), tags
"""

UNUSED_PUBLIC_IPS = """
Resources
| where type =~ 'microsoft.network/publicipaddresses'
| where isnull(properties.ipConfiguration)
| project id, name, resourceGroup, subscriptionId, location,
          sku = tostring(sku.name), tags
"""

OLD_SNAPSHOTS = """
Resources
| where type =~ 'microsoft.compute/snapshots'
| extend created = todatetime(properties.timeCreated)
| where created < ago({days}d)
| project id, name, resourceGroup, subscriptionId, location, created,
          sizeGb = toint(properties.diskSizeGB), tags
"""

EMPTY_RESOURCE_GROUPS = """
ResourceContainers
| where type =~ 'microsoft.resources/subscriptions/resourcegroups'
| project rgId = id, rgName = name, subscriptionId, location, tags
| join kind=leftouter (
    Resources | summarize resourceCount = count() by resourceGroup, subscriptionId
) on $left.rgName == $right.resourceGroup
| where isnull(resourceCount) or resourceCount == 0
| project id = rgId, name = rgName, subscriptionId, location, tags
"""

NSG_RULES = """
Resources
| where type =~ 'microsoft.network/networksecuritygroups'
| mv-expand rule = properties.securityRules
| project nsgId = id, nsgName = name, subscriptionId, resourceGroup,
          ruleName = tostring(rule.name),
          direction = tostring(rule.properties.direction),
          access = tostring(rule.properties.access),
          protocol = tostring(rule.properties.protocol),
          priority = toint(rule.properties.priority),
          sourcePrefix = tostring(rule.properties.sourceAddressPrefix),
          sourcePrefixes = rule.properties.sourceAddressPrefixes,
          destPort = tostring(rule.properties.destinationPortRange),
          destPorts = rule.properties.destinationPortRanges
"""

STOPPED_NOT_DEALLOCATED = """
Resources
| where type =~ 'microsoft.compute/virtualmachines'
| extend powerState = tostring(properties.extended.instanceView.powerState.code)
| where powerState =~ 'PowerState/stopped'
| project id, name, resourceGroup, subscriptionId, location,
          vmSize = tostring(properties.hardwareProfile.vmSize), tags
"""


class ResourceGraphGateway:
    """Bulk, cross-subscription queries. Preferred over per-resource ARM calls."""

    def __init__(self, ctx: ConnectionContext) -> None:
        self.ctx = ctx

    @with_retry()
    async def _page(
        self, client: ResourceGraphClient, query: str, skip_token: str | None
    ):
        request = QueryRequest(
            subscriptions=[self.ctx.subscription_id],
            query=query,
            options=QueryRequestOptions(
                result_format=ResultFormat.OBJECT_ARRAY,
                top=settings.AZURE_PAGE_SIZE,
                skip_token=skip_token,
            ),
        )
        return await client.resources(request)

    async def query(self, kql: str) -> list[dict[str, Any]]:
        """Run a KQL query, following `skip_token` until exhausted."""
        credential = await credential_provider.get(self.ctx)
        rows: list[dict[str, Any]] = []
        try:
            async with ResourceGraphClient(credential) as client:
                skip_token: str | None = None
                while True:
                    response = await self._page(client, kql, skip_token)
                    rows.extend(response.data or [])
                    skip_token = getattr(response, "skip_token", None)
                    if not skip_token:
                        break
        finally:
            await credential.close()
        return rows

    async def inventory(self, arm_types: list[str]) -> list[dict[str, Any]]:
        types = ", ".join(f"'{t}'" for t in arm_types)
        return await self.query(INVENTORY_QUERY.format(types=types))

    async def unattached_disks(self) -> list[dict[str, Any]]:
        return await self.query(UNATTACHED_DISKS)

    async def unused_public_ips(self) -> list[dict[str, Any]]:
        return await self.query(UNUSED_PUBLIC_IPS)

    async def old_snapshots(self, days: int = 90) -> list[dict[str, Any]]:
        return await self.query(OLD_SNAPSHOTS.format(days=days))

    async def empty_resource_groups(self) -> list[dict[str, Any]]:
        return await self.query(EMPTY_RESOURCE_GROUPS)

    async def nsg_rules(self) -> list[dict[str, Any]]:
        return await self.query(NSG_RULES)

    async def stopped_not_deallocated(self) -> list[dict[str, Any]]:
        return await self.query(STOPPED_NOT_DEALLOCATED)
