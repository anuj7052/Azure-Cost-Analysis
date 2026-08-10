# Azure Cost Analysis Dashboard

A full-stack web app for tracking Azure cloud costs across **multiple tenants and subscriptions** — with 6-month trend analysis, per-service breakdown, anomaly detection, a CSV upload fallback, and a BOQ-to-infrastructure-as-code generator.

**Stack**: Python FastAPI + React + Vite + TailwindCSS + Recharts + Azure AD (MSAL)

---

## Features

- **Microsoft Sign-In** — Login with your Azure AD account via MSAL popup
- **Multi-Tenant** — Add Service Principal credentials for any number of additional Azure tenants
- **6-Month Cost Trends** — Area chart showing spend per subscription over time
- **Service Breakdown** — Stacked bar chart + donut showing cost by Azure service
- **Anomaly Detection** — Automatic spike detection (>20% MoM increase) with explanations
- **Savings Detection** — Identifies services where costs decreased
- **Active Resource Inventory** — All Azure resources via Resource Graph API (paginated table)
- **CSV Upload** — Import Azure portal cost export CSVs as a fallback to live data
- **Tenant Comparison** — Side-by-side cost comparison across tenants

---

## Quick Start

### 1. Azure App Registration

1. Go to **Azure Portal** → **Azure Active Directory** → **App registrations** → **New registration**
2. Name: `Azure Cost Analysis`
3. Supported account types: **Accounts in any organizational directory (Multi-tenant)**
4. Redirect URI: **Single-page application (SPA)** → `http://localhost:5173`
5. After creation, note the **Application (client) ID**
6. Go to **API permissions** → **Add a permission** → **Azure Service Management** → **user_impersonation** (delegated)
7. Click **Grant admin consent**

For cross-tenant access with Service Principals, also create a **Client Secret** under **Certificates & Secrets**.

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

Frontend runs at: http://localhost:5173

---

### 4. Usage

1. Open `http://localhost:5173`
2. Click **Sign in with Microsoft**
3. Your Azure tenants and subscriptions will load automatically
4. Navigate the dashboard to see 6-month cost trends
5. Go to **Settings** to:
   - Add cross-tenant Service Principal credentials
   - Toggle which subscriptions to include
   - Upload an Azure cost export CSV

---

## Backend `.env` Reference

| Variable | Description |
|---|---|
| `AZURE_CLIENT_ID` | Your App Registration client ID |
| `AZURE_CLIENT_SECRET` | Client secret (only needed if using SP flows from backend) |
| `AZURE_TENANT_ID` | Your primary tenant ID (optional, defaults to `common`) |
| `APP_SECRET_KEY` | Random secret key for app security |
| `CORS_ORIGINS` | Allowed CORS origins (default: localhost:5173) |
| `DB_PATH` | SQLite database path (default: `./data/azure_cost.db`) |

## Frontend `.env` Reference

| Variable | Description |
|---|---|
| `VITE_AZURE_CLIENT_ID` | Your App Registration client ID |
| `VITE_AZURE_REDIRECT_URI` | OAuth redirect URI (default: `http://localhost:5173`) |

---

## Required Azure RBAC Permissions

The signed-in user (or Service Principal) needs:
- **Reader** role on the subscription (to list resources)
- **Cost Management Reader** role on the subscription (to query costs)

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
│   ├── main.py                    ← FastAPI app entry point
│   ├── requirements.txt
│   ├── .env.example
│   ├── auth/
│   │   ├── token_validator.py     ← Azure AD JWKS token validation
│   │   └── dependencies.py        ← FastAPI auth dependency
│   ├── routers/
│   │   ├── tenants.py             ← GET/POST/DELETE tenants
│   │   ├── subscriptions.py       ← GET subscriptions
│   │   ├── costs.py               ← POST cost analysis
│   │   ├── services.py            ← GET active resources
│   │   └── upload.py              ← POST CSV upload
│   ├── services/
│   │   ├── azure_mgmt.py          ← Azure management API calls
│   │   ├── cost_client.py         ← Cost Management API + Resource Graph
│   │   ├── analysis.py            ← MoM analysis, anomaly/savings detection
│   │   └── csv_parser.py          ← CSV normalization
│   └── core/
│       ├── config.py              ← pydantic-settings
│       └── db.py                  ← SQLite (aiosqlite)
└── frontend/
    └── src/
        ├── auth/                  ← MSAL config + AuthProvider
        ├── api/client.js          ← Axios with token interceptor
        ├── store/useAppStore.js   ← Zustand global state
        ├── components/
        │   ├── Charts/            ← CostTrendChart, ServiceBreakdownChart,
        │   │                         ServicePieChart, TenantComparisonChart
        │   ├── Cards/             ← KpiCard, AnomalyCard
        │   ├── Layout/            ← Sidebar, Topbar
        │   └── TenantManager/    ← AddTenantModal
        └── pages/
            ├── Dashboard.jsx
            ├── CostTrends.jsx
            ├── ServiceAnalysis.jsx
            ├── Anomalies.jsx
            └── Settings.jsx
```
