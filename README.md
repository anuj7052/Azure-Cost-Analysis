# Cloudledger

**Know what Azure is costing you, and why it moved.**

A full-stack web app for tracking Azure cloud costs across **multiple tenants and subscriptions** — with 6-month trend analysis, per-service breakdown, anomaly detection, a CSV upload fallback, and a BOQ-to-infrastructure-as-code generator.

Every screen reads. Calls to Azure are made with the signed-in user's own delegated permissions, so the app can never see more than the person using it. The one feature that produces infrastructure writes a template for you to review and run — it holds no write credentials for your subscription.

**Stack**: Python FastAPI + React + Vite + TailwindCSS + Recharts + Azure AD (MSAL)

---

## Features

### Cost
- **6-month cost trends** — spend per subscription over time
- **Service breakdown** — cost by Azure service, stacked and as a share
- **Month compare** — any two months, or an exact from/to date range
- **Anomalies and savings** — month-on-month movement with the arithmetic shown
- **Activity explorer** and **change tracking** — what changed, by whom, and when
- **Bandwidth and egress** analysis
- **CSV upload** — Azure portal cost exports, as a fallback when live data is unavailable
- **Commitments** — reservations and savings plans

### Estate
- **Resource inventory** via Resource Graph
- **Orphaned resources** — unattached disks, idle public IPs and similar, each with the evidence that produced the finding
- **Network visualizer** with security insights
- **Compute intelligence** and right-sizing

### Access and identity
- **Role assignments** across subscriptions and management groups
- **Access optimization** — over-privileged, unused, over-scoped, redundant and sprawled grants
- **Access history**, **Advisor**, **Defender** and **Policy** views

### Build
- **BOQ to infrastructure-as-code** — a template you review and run yourself
- **Provisioning** for a small set of resource kinds, always preview-then-apply

Every screen reads by default. Nothing is changed in Azure without an explicit,
separately confirmed action.

---

## Quick Start

### 1. Azure App Registration

1. Go to **Azure Portal** → **Microsoft Entra ID** → **App registrations** → **New registration**
2. Name: `Cloudledger`
3. Supported account types: **Accounts in any organizational directory (Multi-tenant)**
4. Redirect URI: **Single-page application (SPA)** → `http://localhost:5174`
5. After creation, note the **Application (client) ID**
6. Go to **API permissions** → **Add a permission** and add, all **delegated**:
   - **Azure Service Management** → `user_impersonation`
   - **Microsoft Graph** → `User.Read`
   - **Microsoft Graph** → `Directory.Read.All` *(optional, see below)*
7. Click **Grant admin consent**

`Directory.Read.All` is what turns the GUIDs in role assignments into names. It
is delegated, so the app can never read more of a directory than the signed-in
person already could — but it does require a tenant administrator to consent.
Skip it and every account shows as a raw identifier; nothing else stops working.

For a customer connecting a tenant by service principal, the credentials come
from a **separate app registration in their own tenant**, created by them. That
registration authenticates with a client secret and never calls Graph, so it
does **not** need `Directory.Read.All`. Name resolution is consented against
*this* application, under **Enterprise applications**, in the customer's tenant.
The in-app setup guide walks through both.

---

### 2. Backend Setup

```bash
cd backend

# Copy and fill in environment variables
cp .env.example .env
# Edit .env: set AZURE_CLIENT_ID to your App Registration client ID

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the server
uvicorn main:app --reload --port 8000
```

Backend runs at: http://localhost:8000  
API docs: http://localhost:8000/docs

---

### 3. Frontend Setup

```bash
cd frontend

# Copy and fill in environment variables
cp .env.example .env
# Edit .env: set VITE_AZURE_CLIENT_ID to your App Registration client ID

# Install dependencies
npm install

# Start dev server
npm run dev
```

Frontend runs at: http://localhost:5174

---

### 4. Usage

1. Open `http://localhost:5174`
2. Click **Sign in with Microsoft**
3. Your Azure tenants and subscriptions will load automatically
4. Navigate the dashboard to see 6-month cost trends
5. Go to **Settings** to:
   - Add cross-tenant Service Principal credentials
   - Toggle which subscriptions to include
   - Upload an Azure cost export CSV

---

## Backend `.env` Reference

See `backend/.env.example` for the annotated version. The essentials:

| Variable | Description |
|---|---|
| `ENVIRONMENT` | `development`, `staging` or `production`. Production refuses to boot on a default signing key, a missing client id, or a plain-http CORS origin |
| `AZURE_CLIENT_ID` | Your App Registration client ID |
| `AZURE_CLIENT_SECRET` | Client secret, only needed for backend service principal flows |
| `AZURE_TENANT_ID` | Your primary tenant ID |
| `APP_SECRET_KEY` | At least 32 characters in production, and never the shipped default |
| `CORS_ORIGINS` | Comma separated. All must be https in production |
| `DB_PATH` | SQLite path. Development only — production targets PostgreSQL |
| `ADMIN_EMAILS` | Comma separated. Promoted to admin on next sign-in. Deliberately outside the database |
| `RATE_LIMIT_*` | Sliding window per caller, protecting the customer's Azure quota as much as this API |
| `OPENAI_*` | Optional assistant. A key set here is shared by every user of the deployment; per-account keys in Settings are preferred |

## Frontend `.env` Reference

| Variable | Description |
|---|---|
| `VITE_AZURE_CLIENT_ID` | Your App Registration client ID |
| `VITE_AZURE_TENANT_ID` | Use `organizations` so customers from any tenant can sign in |
| `VITE_AZURE_REDIRECT_URI` | OAuth redirect URI (default: `http://localhost:5174`) |

---

## Multi-tenancy and data isolation

This is a platform, not a hosted view of one directory. Every customer connects
their own tenant with their own credentials.

- Tenant credentials are stored against the account that entered them, with a
  `UNIQUE (user_id, tenant_id)` constraint and `ON DELETE CASCADE`
- Every read and write of `service_principals` and `session_tokens` is scoped by
  `user_id`. There is no path that returns another account's tenant
- Client IDs and secrets are never pooled, shared or reused between accounts
- `backend/tests/test_tenant_isolation.py` covers this

**Known limitation:** client secrets and cached bearer tokens are currently
stored in plain text. Isolation between accounts holds, but anyone with direct
database access can read them. Encryption at rest is not yet implemented.

---

## Required Azure RBAC Permissions

Assigned on each subscription you want to track. The signed-in user's own
permissions apply for delegated calls; a connected service principal needs them
directly.

**Minimum — cost reporting**

| Role | Why |
|---|---|
| Reader | List resources and subscriptions |
| Cost Management Reader | Query cost and usage |

**Full read — everything the app reports on**

| Role | Why |
|---|---|
| Security Reader | Defender findings and secure score |
| Monitoring Reader | Metrics and activity data |
| Management Group Reader | Assignments above subscription level |

**Write — only if you want the features that act**

| Role | Why |
|---|---|
| Tag Contributor | Apply tags |
| Virtual Machine Contributor | Resize a VM |
| Contributor | Deploy from a BOQ template |
| Role Based Access Control Administrator | Remove or downgrade a role assignment |

Grant the write roles only if you want those features, scope them as narrowly as
you can, and note that the app always previews an action before applying it.
`Owner` is never required.

---

## CSV Export Format (for upload)

Export from Azure Portal → **Cost Management** → **Export** or **Download usage + charges**.

Supported column names (case-insensitive):
- Date / UsageDate / BillingPeriodStartDate
- ServiceName / MeterCategory / ConsumedService
- SubscriptionId / SubscriptionGuid
- ResourceGroup / ResourceGroupName
- PreTaxCost / Cost / ExtendedCost / CostInBillingCurrency
- Currency / BillingCurrency

---

## Project Structure

```
azure-cost-analysis/
├── backend/
│   ├── main.py                    ← FastAPI entry point, /api/me
│   ├── auth/                      ← Entra JWKS validation, auth dependency
│   ├── core/
│   │   ├── config.py              ← pydantic-settings, exported as `settings`
│   │   ├── db.py                  ← SQLite (aiosqlite) / PostgreSQL (asyncpg)
│   │   ├── middleware.py          ← error envelope, rate limit, security headers
│   │   └── versioning.py          ← mounts every router at /api and /api/v1
│   ├── routers/                   ← costs, scans, access, orphaned, boq, admin…
│   ├── services/
│   │   ├── cost_client.py         ← Cost Management + Resource Graph
│   │   ├── analysis.py            ← month-on-month, anomalies, savings
│   │   ├── access_review.py       ← access optimization findings
│   │   ├── orphaned.py            ← orphan rules and their evidence
│   │   ├── graph_identity.py      ← GUID → person, group or managed identity
│   │   ├── permissions_manifest.py← the single source of truth for permissions
│   │   ├── setup_guide.py         ← the onboarding PDF, generated at request time
│   │   └── token_resolver.py      ← pasted token → delegated → service principal
│   └── tests/                     ← pytest, run from backend/
└── frontend/
    └── src/
        ├── auth/                  ← MSAL config + AuthProvider
        ├── api/client.js          ← axios, baseURL /api/v1, token interceptors
        ├── store/                 ← Zustand state and theme
        ├── components/            ← Charts, Cards, Layout, Security, Boq, Common
        ├── pages/                 ← one file per route
        └── utils/                 ← pure logic, where the tests live
```

Testable logic lives in `src/utils/*.js` rather than in components: the frontend
suite runs without a DOM environment.

**Running the suites**

```bash
cd backend  && ./.venv/bin/python -m pytest -q
cd frontend && npx vitest run && npx vite build
```


## Deployment

`https://azure-cost-analysis-anuj.azurewebsites.net`

Every push to `main` builds the SPA, runs both test suites, and deploys to Azure
App Service via `.github/workflows/deploy-azure.yml`. A failing test stops the
deploy, and the run only passes once `/api/health` answers on the live site.

GitHub authenticates to Azure with OIDC federated credentials on the
`id-github-deploy` managed identity, which is scoped to the single web app. No
Azure password or publish profile is stored in this repository.

The frontend build is served by FastAPI from `backend/static`, which is
generated during the deploy and is not committed.
