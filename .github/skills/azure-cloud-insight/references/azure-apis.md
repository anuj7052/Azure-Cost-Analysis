# Azure API Reference

| Need | API / SDK | Notes |
|---|---|---|
| Bulk inventory across subscriptions | Azure Resource Graph (`azure-mgmt-resourcegraph`) | KQL; `$skipToken` pagination; max 1000 rows/page |
| Single resource config | Azure Resource Manager (`azure-mgmt-resource`) | Use only for detail views |
| Actual + amortized cost | Cost Management `query` / `forecast` | Grouping: SubscriptionId, ResourceGroup, ResourceType, TagKey |
| Usage detail / reservations | Consumption API | Daily granularity; heavy — run nightly |
| Metrics | Azure Monitor `metrics.list` | CPU/Disk/Network built-in; memory needs guest agent / Log Analytics |
| Logs, traffic analytics | Log Analytics `query` | KQL against workspace |
| Rightsizing / idle | Azure Advisor `recommendations.list` | Categories: Cost, Performance, HighAvailability, Security |
| Health | Resource Health + Service Health (`azure-mgmt-resourcehealth`) | |
| Security posture | Defender for Cloud (`azure-mgmt-security`) | assessments, secureScores, subAssessments |
| Identity, MFA, risky users | Microsoft Graph | `/users`, `/identityProtection/riskyUsers`, auth methods |

## Auth Model
- App is multi-tenant Entra ID app (OIDC, auth code + PKCE for the SPA/Next.js layer).
- Customer admin grants consent, then assigns the app's service principal `Reader` + `Cost Management Reader` at the subscription (or MG) scope.
- Backend uses `ClientSecretCredential` / federated credential from Key Vault, with `tenant_id` per connection. Cache tokens per tenant in Redis until expiry − 5 min.

## Resilience Rules
- Retry on 429/503 honoring `Retry-After`; exponential backoff with jitter; cap at 5 attempts.
- Cost Management is aggressively throttled — serialize per subscription, never fan out wide.
- Always follow `nextLink`/`$skipToken`; never assume a single page.
- Partial failure of one subscription must not fail the whole tenant sync; record per-subscription status.

## Resource Types to Cover
Virtual Machines, Storage Accounts, SQL Databases, App Services, AKS, Function Apps, VNets, NSGs, Load Balancers, Public IPs, Key Vaults, Recovery Services Vaults, Managed Disks, Snapshots.
