# Azure Cloud Insight

Multi-tenant Azure cloud management SaaS. Customers sign in with Microsoft Entra
ID, connect Azure subscriptions with least-privilege RBAC, and get inventory,
cost, monitoring, security, networking and optimization insight in one dashboard.

```
api/   FastAPI + SQLAlchemy (async) + Celery      -> REST API, sync jobs, rule engines
web/   Next.js 15 + TypeScript + Tailwind         -> dashboard UI
```

> The earlier Vite/React + FastAPI prototype remains in `backend/` and `frontend/`.
> The production platform lives in `api/` and `web/`.

## Architecture

```
web (Next.js)  --Bearer(Entra ID)-->  api (FastAPI)
                                        |
              routers -> services -> repositories -> Postgres
                                        |
                              integrations/azure (Resource Graph, Cost
                              Management, Monitor, Advisor, Defender, Graph)
                                        ^
                              Celery worker + beat (background sync)
```

Layering rules:
- Routers do HTTP and authorization only.
- Services hold use-case logic.
- Repositories are the **only** place that builds SQL, and every query is filtered by `tenant_id`.
- Integrations wrap Azure SDKs with retry, pagination and throttling handling.

## Security model

| Concern | Approach |
|---|---|
| Sign-in | Entra ID OIDC, multi-tenant (`organizations`), auth-code + PKCE in the browser |
| API auth | Bearer access token; signature, issuer, audience and expiry validated per issuing tenant |
| Tenant isolation | `tenant_id` on every table, enforced in `TenantRepository`; proven by `tests/test_tenant_isolation.py` |
| Roles | Admin / Engineer / Viewer mapped from Entra app roles, defaulting to Viewer |
| Azure access | `Reader` + `Cost Management Reader` (+ `Security Reader`) only — never Contributor/Owner |
| Secrets | Azure Key Vault or workload identity federation; never in Postgres or logs |
| Audit | Append-only `audit_logs` row for every mutating action |
| Transport | Security headers, CORS allow-list, non-root containers |
| AI | The model gets a fixed read-only tool surface; it cannot query the DB or Azure directly |

## Running locally

```bash
cp api/.env.example api/.env
cp web/.env.local.example web/.env.local
# fill in AZURE_CLIENT_ID / secret / API_AUDIENCE in both files

docker compose up --build
```

- API + OpenAPI docs: http://localhost:8000/docs
- Web: http://localhost:3000

Without Docker:

```bash
cd api && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
alembic upgrade head
uvicorn app.main:app --reload
celery -A app.workers.celery_app.celery_app worker --loglevel=INFO
celery -A app.workers.celery_app.celery_app beat --loglevel=INFO

cd ../web && npm install && npm run dev
```

## Onboarding a subscription

1. A customer Global Admin consents to the multi-tenant app.
2. They assign the app's service principal, at subscription (or management group) scope:
   `Reader`, `Cost Management Reader`, and `Security Reader` for Defender data.
3. In **Settings → Connected subscriptions**, an Admin adds the subscription id.
4. `POST /api/v1/connections/{id}/verify` probes Resource Graph and lists granted roles.
5. Background sync starts on the next beat tick, or immediately via **Sync now**.

## Background jobs

| Job | Schedule | Source |
|---|---|---|
| inventory | hourly | Resource Graph + Resource Health |
| metrics | every 15 min | Azure Monitor |
| cost | daily 02:00 | Cost Management (actual + amortized + forecast) |
| activity | every 6 h | Activity Log |
| security | daily 03:00 | Defender, NSG analysis, Microsoft Graph |
| recommendations | daily 04:00 | Advisor + local rule engine |
| alerts | every 20 min | rule engine over synced data |
| scheduled reports | hourly | cron per schedule |

All syncs are idempotent upserts, isolated per subscription — one failing
subscription is recorded in `sync_runs` and does not abort the tenant pass.

## Cost detail and data transfer

Cost sync reads the **Consumption usage-details** API, not just the Cost
Management rollup, so every billing line is stored at its real grain: day ×
resource × meter × charge type, with billed quantity, unit of measure, unit and
effective price, pricing model, publisher type and reservation attribution.
Charges that the portal's default views collapse into one service total —
egress, inter-region transfer, geo-replication, request charges, unused
reservation and marketplace fees — are individually queryable and exportable.

Data transfer is reported two ways side by side:

- **Billed egress** from the bandwidth meters (`/costs/bandwidth`).
- **Measured ingress and egress bytes** rolled up daily per resource from Azure
  Monitor throughput metrics (`Network In/Out Total`, storage `Ingress`/`Egress`,
  `BytesReceived`/`BytesSent`, `TunnelIngressBytes`/`TunnelEgressBytes`).

Azure does not charge for inbound data, so ingress has no billing line anywhere
in Cost Management; the metric rollup is the only way to see it. Costs fall back
to the aggregated Cost Management query if the Consumption API is unavailable
for a subscription.

## Optimization rules

Idle VM · oversized VM · stopped-not-deallocated VM · unattached disk · unused
public IP · old snapshot · low-utilization database · empty resource group.
Each finding carries evidence, confidence and estimated monthly savings, and can
be dismissed per tenant (dismissals are honored on later runs and audit-logged).

## API surface (`/api/v1`)

| Area | Endpoints |
|---|---|
| Tenancy | `GET /me`, `GET/POST /connections`, `POST /connections/{id}/verify`, `DELETE /connections/{id}` |
| Dashboard | `GET /dashboard` |
| Costs | `/costs/summary`, `/costs/breakdown`, `/costs/by-tag`, `/costs/trend`, `/costs/anomalies` |
| Cost detail | `/costs/meters`, `/costs/usage-details`, `/costs/bandwidth`, `/costs/dimensions` |
| Inventory | `/resources`, `/resources/detail`, `/resources/metrics` |
| Optimization | `/recommendations`, `/recommendations/savings`, `POST /recommendations/{id}/dismiss` |
| Security | `/security/summary`, `/security/exposures`, `/security/open-ports` |
| Alerts | `/alerts`, `POST /alerts/{id}/acknowledge`, `GET/POST /alert-rules` |
| Sync | `POST /sync/{kind}`, `GET /sync/status` |
| Reports | `POST /reports`, `GET /reports` |
| Assistant | `POST /assistant/ask` |

## Testing

```bash
cd api
pytest          # unit + tenant-isolation tests
ruff check .    # lint
mypy app        # types
```

## Deploying to Azure

- **Azure Container Apps** — one app each for `api`, `worker`, `beat`, `web`.
- **Azure Database for PostgreSQL Flexible Server** — private endpoint.
- **Azure Cache for Redis** — broker, result backend and rate limiting.
- **Azure Key Vault** — app and per-connection secrets, read with managed identity.
- **Azure Monitor / Application Insights** — logs are JSON with `request_id` and `tenant_id`.
- **Azure Blob Storage** — report artifacts, delivered via short-lived SAS links.
