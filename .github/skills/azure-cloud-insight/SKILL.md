---
name: azure-cloud-insight
description: 'Build or extend "Azure Cloud Insight", a multi-tenant Azure cloud management SaaS (Next.js + FastAPI). Use when adding Entra ID auth, Azure subscription onboarding via RBAC, inventory sync (Resource Graph/ARM), cost + forecast (Cost Management/Consumption), monitoring (Azure Monitor/Log Analytics), security (Defender, Secure Score), networking insights, optimization/rightsizing, alerts, reports (PDF/Excel/CSV), or the Azure OpenAI assistant. Triggers: azure dashboard, cost optimization, resource inventory, tenant onboarding, celery sync job, resource detail page.'
argument-hint: 'feature or module to build (e.g. "VM inventory page", "cost forecast API")'
---

# Azure Cloud Insight — Platform Build Workflow

Multi-tenant Azure management SaaS. Customers sign in with Microsoft Entra ID, connect subscriptions via least-privilege RBAC, and view inventory, cost, monitoring, security, networking, and optimization data.

## When to Use
- Adding a new Azure data domain (inventory, cost, security, networking, monitoring).
- Adding a resource type or resource detail page.
- Creating background sync jobs, reports, alerts, or the AI assistant.
- Reviewing whether a change meets the platform's architecture and security bar.

## Non-negotiable Constraints
- **Least privilege**: request `Reader` + `Cost Management Reader` only. Never request Contributor/Owner. Never store customer client secrets in the DB — use Azure Key Vault references or workload identity federation.
- **Tenant isolation**: every table, query, cache key, and API route is scoped by `tenant_id`. No cross-tenant reads, ever. Enforce in the repository layer, not the router.
- **RBAC**: `Admin` (manage tenants/connections/users), `Engineer` (read + trigger syncs + act on recommendations), `Viewer` (read-only). Enforce via a FastAPI dependency.
- **No live Azure calls in request path** for list/dashboard views — serve from synced Postgres tables + Redis cache. Live calls only for on-demand metric refresh.
- Async everywhere (`async def`, async SQLAlchemy, `httpx`/aio Azure SDK clients).

## Architecture
```
frontend/  Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + TanStack Query
backend/   FastAPI + SQLAlchemy 2.0 (async) + Postgres + Redis + Celery
infra/     Docker → Azure Container Apps, Azure DB for PostgreSQL, Azure Cache for Redis, Key Vault, Azure Monitor
```
Backend layering (Clean Architecture — do not skip a layer):
`routers/` (HTTP + auth deps) → `services/` (use cases) → `repositories/` (data access) → `integrations/azure/` (SDK clients) → `models/` (ORM) + `schemas/` (Pydantic).

## Procedure

### 1. Locate the domain
Identify which slice the request belongs to: auth, connections, inventory, cost, monitoring, security, networking, optimization, alerts, reports, assistant. Read the matching existing module before writing code.

### 2. Model the data
Add/extend ORM models with `tenant_id`, `subscription_id`, `azure_resource_id` (unique per tenant), `tags` JSONB, `synced_at`. Index `(tenant_id, subscription_id)` and `(tenant_id, resource_type)`. Write an Alembic migration.

### 3. Implement the Azure integration
- Prefer **Azure Resource Graph** (KQL) for any bulk/multi-subscription query — one call instead of N.
- Use ARM only for single-resource config detail; Azure Monitor for metrics; Cost Management/Consumption for cost; Advisor for recommendations; Defender for security; Resource Health/Service Health for status; Microsoft Graph for identity/MFA.
- Handle throttling: honor `Retry-After`, exponential backoff, and paginate every list call.
- See [Azure API reference](./references/azure-apis.md).

### 4. Sync via Celery, not requests
Add a Celery task with a beat schedule (inventory hourly, cost daily, metrics 15 min, security daily). Tasks must be idempotent upserts, per-tenant, resumable, and must record `sync_run` status + errors.

### 5. Expose the API
REST, versioned under `/api/v1`, Pydantic response models, pagination + filtering (`subscription_id`, `resource_group`, `type`, `tag`), OpenAPI documented. Emit an audit log row for every mutating call and every tenant-connection change.

### 6. Build the UI
- Dashboard KPIs: monthly cost, forecast, cost by subscription/RG/type/tag, resource count, health, active alerts, secure score, Advisor recommendations.
- Resource detail pages use the standard tab set: Configuration · Cost · Metrics · Tags · Owner · Dependencies · Activity Log · Alerts · Backup · Security · Recommendations.
- Server Components for initial load, TanStack Query for refresh; skeletons, empty states, and error boundaries required. Dark/light theme and responsive layout required.

### 7. Test
Unit tests for services with mocked Azure clients; integration tests against a test Postgres; a tenant-isolation test proving tenant A cannot read tenant B's rows.

### 8. Verify before finishing
- [ ] Every query filtered by `tenant_id`
- [ ] Role dependency applied to the route
- [ ] No secrets in code, logs, or DB
- [ ] Pagination + throttling handled
- [ ] Migration written
- [ ] Audit log emitted for mutations
- [ ] Tests added and passing
- [ ] Loading/empty/error UI states present

## Domain Details
- Cost, optimization rules, and savings math: [cost-and-optimization.md](./references/cost-and-optimization.md)
- Security, networking, alerts, reports, AI assistant: [operations.md](./references/operations.md)
