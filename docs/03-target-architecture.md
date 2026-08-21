# Target Architecture — Spec §79 Step 3

---

## 1. Runtime architecture

```
                         Internet
                            │
                    Azure Front Door  (WAF, TLS)
                            │
                   Application Gateway
                            │
              ┌─────────────┴─────────────┐
              │                           │
        Frontend (SWA /            Backend API
        Container App)            (FastAPI, N replicas)
                                          │
              ┌───────────────┬───────────┼───────────────┐
              │               │           │               │
        PostgreSQL         Redis      Service Bus      Key Vault
        (Flexible        (cache,       (scan jobs)    (secrets, DEK)
         Server)         rate limit)        │
                                            │
                                   Workers (Container Apps Job)
                                            │
                                      Azure REST APIs
```

**Deliberate choice: modular monolith, not microservices** (§75). One FastAPI
application with domain modules, plus a separate worker process that imports the
same domain code. Services get extracted only when a measured reason appears.

Managed Identity is used for Key Vault, PostgreSQL, and Service Bus. No
connection secrets in configuration.

---

## 2. Backend module layout (§73)

```
backend/
  app/
    core/           config, db session, security, pagination, errors, logging
    azure/          shared HTTP client: auth, retry, backoff, paging, throttle
    auth/           token validation, current-user, permissions
    organizations/  organization, membership, plan, feature flags
    tenants/        Azure tenant connections, credentials (Key Vault refs)
    subscriptions/
    resources/      resource explorer, relationships
    snapshots/      scan engine, immutable capture
    changes/        diff engine
    activity/       Azure Activity Log
    costs/          Cost Management, proof system
    budgets/
    anomalies/
    optimization/   right-sizing, storage, database, orphaned, advisor
    commitments/    reservations, savings plans
    rbac/
    policies/
    security/       Defender
    network/        topology
    automation/     rules engine
    remediation/    approval + execution + verification
    reports/
    iac/
    notifications/
    audit/
    ai/
    billing/        Marketplace SaaS fulfilment
  migrations/       Alembic
  tests/
```

Each module has the same shape:

```
<module>/
  router.py      HTTP surface only
  service.py     domain logic
  repository.py  data access (all queries org-scoped)
  models.py      SQLAlchemy
  schemas.py     pydantic contracts
  azure.py       Azure API calls for this domain (optional)
```

The existing `routers/` + `services/` modules migrate into this shape
incrementally. **No big-bang move.**

---

## 3. Frontend module layout (§74)

```
frontend/src/
  shared/     components, hooks, api client, formatting, proof panel
  modules/
    dashboard/ finops/ resources/ changes/ activity/ governance/
    security/ network/ optimization/ automation/ iac/ reports/
    ai/ settings/ admin/
```

Existing `utils/` (currency, exact, azureLinks, changeSummary) move to
`shared/` unchanged — they are covered by the 69 passing tests and must not
change behaviour.

---

## 4. Database schema (target)

### 4.1 Isolation model

Every business table carries `organization_id` (FK, `NOT NULL`, indexed first in
every composite index). Isolation is enforced in **three** layers:

1. **Repository layer** — every query goes through a base repository that
   requires an `organization_id` argument. There is no raw-session access.
2. **Request context** — `organization_id` is resolved from the authenticated
   identity only. Any `organization_id`/`tenant_id` in a request body or query
   string is ignored.
3. **PostgreSQL Row-Level Security** — defence in depth. `SET LOCAL
   app.current_org` per transaction; RLS policies on every table.

Unauthorised access returns `403` without revealing existence (§41).

### 4.2 Core tables

```
organizations        id, name, slug, plan, trial_ends_at, status, created_at
org_members          org_id, user_id, role (owner|admin|member|viewer), status
users                id, azure_oid UNIQUE, email, name, home_tenant_id, status
                     (platform-level; org role lives on org_members)

azure_tenants        id, org_id, tenant_id, display_name, auth_mode, status
azure_credentials    id, azure_tenant_id, kind (sp|token|cert|managed_identity),
                     client_id, secret_ref (Key Vault URI), expires_at,
                     last_verified_at
                     -- NO secret material in this table, ever
subscriptions        id, org_id, azure_tenant_id, subscription_id,
                     display_name, state, mg_path
management_groups    id, org_id, azure_tenant_id, mg_id, parent_mg_id, name
```

### 4.3 Snapshot / inventory (extends existing, §10)

```
scans                id, org_id, azure_tenant_id, trigger (manual|scheduled|api),
                     status, started_at, finished_at, resource_count,
                     error_code, error_detail, checkpoint
scan_resources       id, org_id, scan_id, resource_id, name, name_lower, type,
                     resource_group, subscription_id, location, sku,
                     tags JSONB, properties JSONB, configuration JSONB,
                     kind, managed_by, captured_at
resource_relations   id, org_id, scan_id, source_resource_id, target_resource_id,
                     relation_type, evidence
```

`scan_resources` is **append-only** — this preserves the existing immutability
guarantee. Partition by `captured_at` (monthly range partitions) once volume
requires it (§66).

Indexes:
```
(org_id, scan_id, resource_id)        -- diff join (fixes P6)
(org_id, resource_id, captured_at)    -- entity history
(org_id, name_lower)                  -- search
(org_id, type, subscription_id)       -- explorer filters
GIN (tags)                            -- tag queries
```

### 4.4 New domain tables

```
activity_events      org_id, azure_tenant_id, event_id, correlation_id, caller,
                     caller_type, operation_name, resource_id, subscription_id,
                     resource_group, status, sub_status, event_timestamp,
                     claims JSONB, http_request JSONB
change_events        org_id, from_scan_id, to_scan_id, resource_id, change_type,
                     field_path, before JSONB, after JSONB, detected_at,
                     activity_event_id NULL   -- §13 correlation
role_assignments     org_id, azure_tenant_id, assignment_id, principal_id,
                     principal_type, principal_display, role_definition_id,
                     role_name, scope, scope_type, captured_at
policy_states        org_id, assignment_id, definition_id, initiative_id,
                     resource_id, compliance_state, scope, captured_at
security_findings    org_id, assessment_id, resource_id, severity, category,
                     state, description, remediation, captured_at
secure_scores        org_id, subscription_id, score, max_score, captured_at
advisor_recs         org_id, rec_id, category, impact, resource_id,
                     description, savings_amount, currency, captured_at
metrics_samples      org_id, resource_id, metric, aggregation, value, unit,
                     window_start, window_end
budgets              org_id, scope_type, scope_value, amount, currency, period,
                     thresholds JSONB, forecast_threshold, notify JSONB
anomalies            org_id, kind, scope, detected_at, magnitude, baseline,
                     observed, explanation JSONB, status
recommendations      org_id, source (internal|advisor), category, resource_id,
                     title, evidence JSONB, estimated_saving, confidence,
                     effort, risk, status
automation_rules     org_id, name, condition JSONB, action JSONB, mode
                     (recommend|approve|execute), enabled
remediation_jobs     org_id, recommendation_id, requested_by, approved_by,
                     action JSONB, state, result JSONB, verified_at
ignore_rules         org_id, target_type, target_value, reason, created_by,
                     expires_at
audit_log            org_id, actor_user_id, action, object_type, object_id,
                     before JSONB, after JSONB, ip, result, created_at
                     -- append-only; REVOKE UPDATE/DELETE
notifications        org_id, channel, target, events JSONB, enabled
scan_schedules       org_id, azure_tenant_id, cadence, next_run_at, enabled
data_states          -- not a table: an enum on every returned value
```

### 4.5 Data state enum (§54, §46)

Every value returned by the API carries a state, never a bare number:

```
confirmed | estimated | unavailable | permission_required | throttled
         | stale | historical | unknown
```

`unavailable`, `permission_required`, and `throttled` **must never** serialise
to `0`. This is enforced by a shared response type and asserted by tests.

---

## 5. API architecture (§43)

Base path `/api/v1`. Existing `/api/*` routes are kept as aliases during
migration so the frontend never breaks, then deprecated with a sunset header.

**Standard list envelope:**
```json
{
  "items": [],
  "page": {"cursor": "...", "next_cursor": "...", "limit": 50, "has_more": true},
  "meta": {"request_id": "...", "data_state": "confirmed", "as_of": "..."}
}
```

**Standard error envelope:**
```json
{
  "error": {
    "code": "azure_throttled",
    "message": "Azure Cost Management is rate limiting this account.",
    "detail": {"retry_after_seconds": 14},
    "request_id": "..."
  }
}
```

Codes: `unauthenticated`, `forbidden`, `not_found`, `validation_failed`,
`azure_throttled`, `azure_permission_required`, `azure_unavailable`,
`plan_limit_reached`, `internal_error`.

Cross-cutting middleware: request ID, structured logging, rate limiting
(Redis token bucket, per-org and per-user), security headers, org context.

Read endpoints currently using `POST` (`/api/costs`, `/api/orphaned`,
`/api/bandwidth`) get `GET` equivalents under `/api/v1` with query parameters.

---

## 6. Azure API client (§48)

A single shared client in `app/azure/` that every domain uses:

- Credential resolution (session token → SP via Key Vault → delegated)
- Per-tenant concurrency gate
- Exponential backoff honouring `Retry-After`
- Global cooldown on 429 (lifted from `cost_client.py`, generalised)
- Automatic `nextLink` / `$skipToken` pagination
- Request coalescing for identical in-flight queries
- Redis-backed response cache with stale tolerance
- Classifies failures into data states rather than swallowing them:
  `403 → permission_required`, `429 → throttled`, `5xx → unavailable`

The existing `cost_client.py` logic is the **reference implementation** and is
generalised, not rewritten from scratch.

---

## 7. Queue & scheduler architecture (§44, §45)

```
Scheduler (APScheduler in dev / Container Apps Job cron in prod)
   │  reads scan_schedules where next_run_at <= now
   ▼
Service Bus queue  (Redis list in dev)
   │  message: {org_id, azure_tenant_id, scan_type, checkpoint}
   ▼
Worker pool
   │  1. discover subscriptions
   │  2. Resource Graph page-by-page → checkpointed writes
   │  3. finish scan → emit scan.completed
   ▼
Post-scan pipeline (chained jobs)
   diff → activity correlation → cost correlation → recommendations → notify
```

Checkpointing means a worker crash resumes rather than restarts (§48).
A scan that fails partway is recorded as `failed` with the reason — it is never
treated as "the estate is now empty" (§77).

Cadences: hourly, 6h, 12h, daily, weekly, custom cron.

---

## 8. Secret handling (§38, §39)

```
Credential written  →  Key Vault secret  →  DB stores only the secret URI
Credential read     →  Managed Identity  →  Key Vault  →  in-memory only
```

- No secret material in PostgreSQL, ever.
- Dev fallback: envelope encryption with a local DEK from `.env` — clearly
  marked as development-only and refused when `ENVIRONMENT=production`.
- Session tokens: encrypted, expiry enforced, revocable, usage audited, never
  logged, never returned by any API. A log-scrubbing filter redacts anything
  matching a JWT shape.
- Preference order: Managed Identity → Workload Identity → Certificate →
  Client secret.
- Requested Azure role is **Reader** by default. Write roles are opt-in per
  remediation capability, never requested up front (§78).

---

## 9. Read-only by default (§78)

The platform is an observer. Every write path requires all six steps:

```
permission check → user authorization → explicit confirmation
    → execution → verification → immutable audit record
```

Automation ships in `recommend` mode only. `execute` mode requires the
organization owner to enable it per rule, and each execution still creates an
approval record.

---

## 10. Azure permissions matrix (§79 Step 3)

Minimum viable connection is **Reader at the subscription or management group
scope**. Everything below is additive and optional; when a permission is absent
the corresponding feature reports `permission_required`, never zero (§46).

| Capability | Role / permission | Scope | Required |
|---|---|---|---|
| Resource inventory, search, snapshots | `Reader` | Subscription / MG | Yes |
| Cost analysis, trends, BOQ actuals | `Cost Management Reader` | Subscription / Billing account | Yes |
| Activity Explorer | `Reader` (`Microsoft.Insights/eventtypes/read`) | Subscription | Recommended |
| VM / DB right-sizing metrics | `Monitoring Reader` | Subscription | Optional |
| RBAC / Access Explorer | `Microsoft.Authorization/*/read` (in `Reader`) | Subscription / MG | Optional |
| Principal display names (users, groups, SPs) | Graph `Directory.Read.All` (application) | Tenant | Optional |
| Policy Center | `Microsoft.PolicyInsights/*/read` | Subscription / MG | Optional |
| Security Center / Defender | `Security Reader` | Subscription | Optional |
| Advisor recommendations | `Reader` (`Microsoft.Advisor/*/read`) | Subscription | Optional |
| Reservations / Savings Plans | `Reservations Reader` or billing-scope reader | Billing account / Tenant | Optional |
| Budgets (read) | `Cost Management Reader` | Subscription | Optional |
| Management group hierarchy | `Management Group Reader` | Tenant root | Optional |
| Network topology | `Reader` (+ `Network Contributor` only for topology API) | Subscription | Optional |
| **Remediation — resize VM** | `Virtual Machine Contributor` | Resource | Opt-in |
| **Remediation — delete orphan** | `Contributor` on target type | Resource | Opt-in |
| **Remediation — policy** | `Resource Policy Contributor` | Subscription | Opt-in |
| **Remediation — RBAC** | `User Access Administrator` | Subscription | Opt-in, discouraged |

`Owner` is never requested (§38).

---

## 11. Observability (§49)

- Structured JSON logs with `request_id`, `org_id`, `scan_id`, `correlation_id`.
  `org_id` is logged; secrets and tokens are scrubbed by a logging filter.
- Metrics: Azure API latency/failure by provider, queue depth, scan duration,
  scan failure rate, DB pool saturation, request latency.
- Admin health dashboard: API, DB, workers, queue, Azure connections, last scan
  per tenant, failed scans.

---

## 12. Testing strategy (§53)

Non-negotiable additions before any feature work:

1. **Cross-tenant isolation suite** — for every org-scoped endpoint, assert
   org A receives `403`/empty for org B's identifiers. Parameterised over the
   full route table so new routes are covered automatically.
2. **Data-state suite** — Azure returns 403/429/500 → response is
   `permission_required`/`throttled`/`unavailable`, never `0`.
3. **Azure HTTP mock harness** — pagination, `Retry-After`, partial failure.
4. **Auth suite** — expired token, wrong audience, wrong issuer, suspended user.
5. **Frontend** — loading/error/empty states for every page.

The existing 191 tests are a regression gate. Any change that breaks them is
reverted, not accommodated.
