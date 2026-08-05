from __future__ import annotations

import logging
from dataclasses import dataclass

from azure.identity.aio import (
    ClientSecretCredential,
    DefaultAzureCredential,
    WorkloadIdentityCredential,
)
from azure.keyvault.secrets.aio import SecretClient

from app.core.config import settings
from app.core.errors import AzureIntegrationError

log = logging.getLogger(__name__)

# Least-privilege roles we ask the customer to assign. Never Contributor/Owner.
REQUIRED_ROLES = ("Reader", "Cost Management Reader", "Security Reader")


@dataclass(frozen=True, slots=True)
class ConnectionContext:
    """Everything needed to talk to one customer subscription."""

    tenant_id: str
    azure_tenant_id: str
    subscription_id: str
    credential_ref: str = ""
    auth_mode: str = "client_secret"


class CredentialProvider:
    """Builds Azure credentials for a customer connection.

    Secrets are read from Azure Key Vault at call time and never persisted in
    our database or logs. Federated (workload identity) connections carry no
    secret at all and are the preferred mode.
    """

    def __init__(self) -> None:
        self._vault_credential = DefaultAzureCredential() if settings.KEY_VAULT_URI else None

    async def _read_secret(self, name: str) -> str:
        if not settings.KEY_VAULT_URI or self._vault_credential is None:
            raise AzureIntegrationError("KEY_VAULT_URI is not configured.")
        async with SecretClient(
            vault_url=settings.KEY_VAULT_URI, credential=self._vault_credential
        ) as client:
            secret = await client.get_secret(name)
        if not secret.value:
            raise AzureIntegrationError("Stored credential is empty.")
        return secret.value

    async def get(self, ctx: ConnectionContext):
        if ctx.auth_mode == "workload_identity":
            return WorkloadIdentityCredential(
                tenant_id=ctx.azure_tenant_id, client_id=settings.AZURE_CLIENT_ID
            )
        if ctx.auth_mode == "managed_identity":
            return DefaultAzureCredential()

        secret = (
            await self._read_secret(ctx.credential_ref)
            if ctx.credential_ref
            else settings.AZURE_CLIENT_SECRET
        )
        if not secret:
            raise AzureIntegrationError("No credential available for this connection.")
        return ClientSecretCredential(
            tenant_id=ctx.azure_tenant_id,
            client_id=settings.AZURE_CLIENT_ID,
            client_secret=secret,
        )

    async def close(self) -> None:
        if self._vault_credential is not None:
            await self._vault_credential.close()


credential_provider = CredentialProvider()
