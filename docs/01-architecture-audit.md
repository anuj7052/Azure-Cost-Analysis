# Repository Audit — Azure Control & Intelligence Platform

Audit date: 2026-08-20
Baseline: **122 backend tests passing**, **69 frontend tests passing**.
Measured size: **9,143 backend LOC** (excl. venv), **13,407 frontend LOC** (src + tests).

This document is Step 1 of the §79 development process. Nothing here has been
changed yet — it records what exists today.

---

## 1. Current Architecture

```
Browser (React 19 + Vite 8)
   │  MSAL.js  →  Entra ID  →  Bearer token (aud = ARM or app client id)
   ▼
FastAPI (uvicorn, single process)
   │  auth/dependencies.get_current_user  → JWKS validation → local user upsert
   │  services/token_resolver             → session token | SP secret | delegated token
   ▼
Azure REST APIs (httpx, direct HTTP — no azure-mgmt SDK)
   │
   ▼
SQLite (aiosqlite, ./data/azure_cost.db)
```

There is **no queue, no worker, no scheduler, no cache server**. All Azure work
happens inline inside the HTTP request. The only cache is an in-process dict in
`services/cost_client.py` persisted to a JSON file in the temp directory.

### Layering

The code is already reasonably layered and `main.py` is only 77 lines — the
spec's warning about "one giant main.py" does **not** apply here.

| Layer | Location | Notes |
|---|---|---|
| Routing | `backend/routers/*` (13 modules) | Thin, delegate to services |
| Domain logic | `backend/services/*` (18 modules) | Where the real logic lives |
| Contracts | `backend/models/schemas.py` (631 lines) | Single file, pydantic |
| Persistence | `backend/core/db.py` (178 lines) | Raw SQL, hand-rolled migrations |
| Auth | `backend/auth/*` | JWKS validation + role gate |

Frontend is organised by **technical type** (`pages/`, `components/`, `utils/`,
`store/`), not by domain — the spec (§74) wants `modules/<domain>/`.

---

## 2. Existing Feature Map

| Feature | Status | Backing code |
|---|---|---|
| Dashboard (spend, burn rate, spikes, savings, RI vs PAYG) | Working | `routers/costs.py`, `services/analysis.py`, `pages/Dashboard.jsx` |
| Cost trends / 6-month | Working | `routers/costs.py`, `pages/CostTrends.jsx` |
| Month comparison | Working | `pages/Compare.jsx`, `utils/costVariance.js` |
| Cost proof / `#` exact toggle | Working | `utils/exact.js`, `components/Common/Amount.jsx`, `ExplainPanel.jsx` |
| Resource-group cost | Working | `routers/costs.py:/rg` |
| Service analysis | Working | `routers/services.py` |
| Pricing / reserved detail | Working | `services/pricing.py` |
| Anomalies (>20% MoM) | Working | `services/analysis.py`, `pages/Anomalies.jsx` |
| Bandwidth / data transfer | Working | `services/bandwidth.py` |
| Orphaned resources (8 rules) | Working | `services/orphaned.py` |
| BOQ import + compare | Working | `services/boq_parser.py`, `utils/boqCompare.js` |
| BOQ → Bicep/Terraform | Working | `services/iac_service.py` (446 lines) |
| BOQ chat assistant | Working | `services/boq_chat_service.py` |
| CSV/Excel import | Working | `services/csv_parser.py` |
| Snapshot engine (immutable) | Working | `services/scanner.py`, tables `scans`/`scan_resources` |
| Change tracking (diff) | Working, **new** | `services/changes.py`, `routers/changes.py` |
| Entity history | Working, **new** | `routers/changes.py:/history` |
| Global search (incl. historical) | Working | `services/search.py`, `routers/scans.py:search_router` |
| Multi-tenant connection | Working | `routers/tenants.py`, `services/azure_mgmt.py` |
| Session-token auth path | Working | `session_tokens` table |
| Admin center | Partial | `routers/admin.py` — users/stats only |
| BYO AI integration | Working | `services/integration_service.py` |
| Setup guide PDF | Working | `services/setup_guide.py` |

---

## 3. Database Map

Six tables. All in SQLite.

| Table | Owner column | Purpose |
|---|---|---|
| `users` | — | Local account, `azure_oid` unique, role, status |
| `service_principals` | `user_id` | **Client secret stored in plaintext** |
| `session_tokens` | `user_id` | **Access token stored in plaintext** |
| `user_integrations` | `user_id` | **API key stored in plaintext** |
| `scans` | `user_id` + `tenant_id` | Scan run header |
| `scan_resources` | via `scan_id` | Immutable snapshot rows |

Indexes present: `idx_scans_owner`, `idx_scan_resources_scan`,
`idx_scan_resources_name`, `idx_scan_resources_rid`.

### Schema limitations

1. **No organization/tenant table.** Isolation is per *user row*, not per
   organization. Two colleagues at the same customer cannot share data — and
   there is no construct for a customer at all. This blocks §41 and §59.
2. **`scan_resources` has no `properties` / `configuration` / `relationships`
   column.** The spec (§10) requires full config capture; today only
   `sku`, `tags`, `location`, `type` are stored. Change detection is therefore
   structurally limited to those fields.
3. **No `scan_resources` composite index on `(scan_id, resource_id)`** — the
   diff join in `services/changes.py` will degrade at scale.
4. **Hand-rolled migrations** in `_add_owner_column`. No version table, no
   down-migration, not idempotent across arbitrary version jumps. No Alembic.
5. **No tables at all** for: activity log, RBAC, policy, security findings,
   network topology, budgets, audit log, automation rules, ignore rules,
   notifications, plans/billing, schedules.
6. SQLite has a single writer. Concurrent scans across tenants will serialise
   and eventually hit `database is locked`.

---

## 4. API Map

All routes are unversioned (`/api/...`), not `/api/v1/...` as §43 requires.

| Prefix | Methods | Auth |
|---|---|---|
| `/api/me`, `/api/health` | GET | user / none |
| `/api/tenants` | GET, POST, POST `/token`, DELETE `/{id}` | user |
| `/api/subscriptions` | GET | user |
| `/api/costs` | POST, `/rows`, `/rg`, `/daily`, `/pricing`, `/pricing/reserved` | user |
| `/api/services` | GET | user |
| `/api/upload` | POST | user |
| `/api/bandwidth` | POST | user |
| `/api/boq` | `/parse`, `/plan`, `/generate`, `/generate/download`, `/chat`, `/chat/upload` | user |
| `/api/orphaned` | POST | user |
| `/api/scans` | POST, GET | user |
| `/api/search` | GET | user |
| `/api/changes` | GET, `/history` | user |
| `/api/integrations` | GET, POST, PATCH, DELETE | user |
| `/api/guide/setup.pdf` | GET | user |
| `/api/admin/*` | users, stats, user detail, patch, delete | admin |

### API gaps vs §43

Missing entirely: `/resource-groups`, `/resources`, `/history`, `/activity`,
`/budgets`, `/anomalies` (computed client-side today), `/rbac`, `/policies`,
`/security`, `/network`, `/optimization`, `/reservations`, `/automation`,
`/remediation`, `/reports`, `/audit`.

Missing cross-cutting concerns: **no pagination envelope**, **no rate limiting**,
**no request IDs**, **no consistent error schema**. Read-heavy endpoints use
`POST` (`/api/costs`, `/api/orphaned`, `/api/bandwidth`) which defeats HTTP
caching and is not REST-idiomatic.

---

## 5. Azure API Map

| Azure API | Version | Used by | Correctness |
|---|---|---|---|
| `Microsoft.CostManagement/query` | 2023-11-01 | `cost_client.py` | Correct API for cost |
| `Microsoft.ResourceGraph/resources` | 2022-10-01 | `cost_client.py`, `orphaned.py` | Correct API for inventory |
| `/tenants` | 2022-12-01 | `azure_mgmt.py` | Correct |
| `/subscriptions` | 2022-12-01 | `azure_mgmt.py` | Correct |

The codebase **correctly separates Resource Graph from Cost Management** (§47) —
this is already right and must be preserved.

Not yet used: Activity Log (`Microsoft.Insights/eventtypes/management/values`),
Authorization (`roleAssignments`, `roleDefinitions`), Policy
(`policyStates`, `policyAssignments`), Defender (`Microsoft.Security/assessments`,
`secureScores`), Advisor (`Microsoft.Advisor/recommendations`), Monitor Metrics,
Consumption (`reservationDetails`, `budgets`), Network Watcher / topology,
Management Groups.

### Throttling handling — already good

`cost_client.py` implements a concurrency semaphore (3), exponential backoff with
`Retry-After`, an in-flight request coalescer, a global cooldown gate, and a
disk-persisted stale-tolerant cache. This satisfies much of §48 for cost.
`orphaned.py` and `azure_mgmt.py` do **not** share this machinery — that is
duplicated/absent retry logic.

---

## 6. Security Assessment

Ordered by severity.

### CRITICAL

| # | Finding | Location | Impact |
|---|---|---|---|
| S1 | **Service principal client secrets stored in plaintext** | `service_principals.client_secret` | DB file read = full control of customer Azure tenants. Violates §38. |
| S2 | **Azure access tokens stored in plaintext** | `session_tokens.access_token` | Same. Violates §39. |
| S3 | **Third-party API keys stored in plaintext** | `user_integrations.api_key` | Customer OpenAI keys exfiltrable. |
| S4 | **No organization boundary** | schema-wide | There is no customer entity, so §41's "Customer A cannot access Customer B" is only accidentally satisfied by per-user scoping. Any future sharing feature will breach it. |

### HIGH

| # | Finding | Location | Impact |
|---|---|---|---|
| S5 | `APP_SECRET_KEY` defaults to `"change-this-secret"` | `core/config.py` | Ships insecure by default. Should refuse to start in production. |
| S6 | Token audience accepts ARM tokens | `token_validator.py:allowed_audiences` | An ARM token minted for *any* app the user consented to can call this API. Should prefer `api://{client_id}` only, in production. |
| S7 | No rate limiting on any endpoint | all routers | Trivial DoS; also amplifies into Azure throttling for the whole tenant. |
| S8 | No audit log | — | §42 entirely unimplemented. Credential changes, exports, deletions leave no trace. |
| S9 | No security headers / HTTPS enforcement | `main.py` | No HSTS, CSP, `X-Content-Type-Options`. |

### MEDIUM

| # | Finding | Impact |
|---|---|---|
| S10 | `CORSMiddleware` with `allow_methods=["*"]`, `allow_headers=["*"]`, `allow_credentials=True` | Over-broad; origins are pinned, so exploitable only if an origin is compromised. |
| S11 | No `.env.example`; `.env` handling unverified | §55 requires one with no real secrets. |
| S12 | No dependency / container / SAST scanning in CI (no CI at all) | §55. |
| S13 | Errors surfaced via `str(exc)[:300]` into `scans.error` | Can leak internal detail into API responses. |
| S14 | No token-in-log audit | §39 requires proof tokens are never logged. |

### Already correct — preserve

- SQL is **fully parameterised** everywhere inspected — no injection found.
- Every stored-credential lookup filters by `user_id` (`token_resolver.py`).
- `get_current_user` is the single choke point; suspension is enforced there.
- Admin emails come from environment, not the database — an admin cannot be
  self-minted through the app. This is a good design decision.
- `403` is returned for foreign tenants without leaking existence.

---

## 7. Technical Debt Assessment

| # | Debt | Cost of leaving it |
|---|---|---|
| D1 | Raw SQL + hand-rolled migrations, no ORM/Alembic | Every new table in this spec (≈25) multiplies the migration risk. **Blocks everything.** |
| D2 | `models/schemas.py` at 631 lines, all domains in one file | Will exceed 3,000 lines under this spec. |
| D3 | Retry/backoff logic lives only in `cost_client.py` | Every new Azure integration re-invents or omits it. Needs extraction to a shared `azure/http.py`. |
| D4 | Frontend organised by type, not domain | 14 new modules will make `pages/` unnavigable. |
| D5 | Anomaly rules and thresholds are hard-coded | §27 requires configurability. |
| D6 | Analysis computed per-request from live Azure calls | No materialisation; every page load re-queries Azure. |
| D7 | Unversioned API | Breaking changes have no escape hatch once customers exist. |
| D8 | `.pyc` files and `__pycache__` present in the tree | Check `.gitignore` coverage. |

---

## 8. Performance Assessment

Target (§66): hundreds of subscriptions, 100k+ resources, millions of snapshot
rows. Current design will not reach it.

| # | Bottleneck | Detail |
|---|---|---|
| P1 | **Synchronous scans inside HTTP requests** | `POST /api/scans` runs the full estate scan in-request. Times out well before 100k resources. Violates §44. |
| P2 | **SQLite single-writer** | Concurrent scans serialise; `database is locked` under load. |
| P3 | **No pagination on any list endpoint** | `/api/search`, `/api/changes`, scan listings return unbounded results into browser memory. Violates §66. |
| P4 | `record_resources` builds the entire resource list in memory then one `executemany` | 100k rows × full JSON in RAM per scan. |
| P5 | Change diff loads two full scans into memory | Should be a SQL-side join with pagination. |
| P6 | Missing `(scan_id, resource_id)` composite index | Diff and history queries do repeated index-then-lookup. |
| P7 | Cache is per-process, in-memory | Cannot scale to more than one backend replica. Needs Redis. |
| P8 | No incremental scans | Every scan is a full estate capture. |

---

## 9. Test Assessment

**191 tests total, all passing.** Good coverage of pure logic; near-zero coverage
of the things this spec cares most about.

| Area | Backend | Frontend |
|---|---|---|
| Cost rows / pricing | `test_cost_rows.py`, `test_pricing.py` | `currency.test.js`, `exact.test.js` |
| Change detection | `test_changes.py` (396 lines) | `changeSummary.test.js` |
| Snapshots / scans | `test_scans.py` | — |
| Orphaned | `test_orphaned.py` | — |
| BOQ + IaC | `test_boq_iac.py` | — |
| Integrations | `test_integrations.py` | — |
| Admin | `test_admin_accounts.py` | — |
| Resource inventory | `test_resource_inventory.py` | — |
| Azure links | — | `azureLinks.test.js` |

### Gaps (§53)

- **No cross-tenant / IDOR tests.** This is the single most important missing
  test category given §41 and §80.
- No authentication-bypass or authorization-bypass tests.
- No token-validation tests (JWKS mocking).
- No secret-leakage tests.
- No error-state tests asserting "Unavailable" instead of `0` (§46) — this is a
  *correctness* guarantee the spec calls critical and it is currently unverified.
- No React component/page tests at all — all 69 frontend tests are pure utility
  functions. No loading/error/empty-state coverage.
- No Azure API mocking harness for HTTP-level behaviour (429, 403, pagination).

---

## 10. Honest Assessment vs Spec

**What is already strong and must be preserved:**

1. The immutable snapshot design (§10) is correct and already implemented.
2. Resource Graph vs Cost Management separation (§47) is correct.
3. Cost throttling/backoff/caching (§48) is genuinely production-quality.
4. The proof/explain system (§6) already exists and works.
5. Per-user credential scoping is consistently applied.
6. Test discipline is real — 191 passing tests with meaningful assertions.

**What is genuinely missing, not merely incomplete:**

Of the 22 capability areas in §1, **7 exist** (FinOps, Cost, Inventory,
Snapshots, Change Tracking, BOQ, IaC), **1 is partial** (Multi-tenant), and
**14 do not exist in any form** (Activity, RBAC, Policy, Security, Network,
Optimization, Right-sizing, Reservations, Budgets, Automation, Remediation,
Reporting, Audit, AI-investigation).

**The blocking dependency is the data layer.** Nothing in §13–§35 can be built
responsibly on SQLite with hand-rolled migrations and no organization entity.
Attempting the feature list before the migration would require rewriting every
feature afterwards.
