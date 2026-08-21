# Implementation Roadmap — Spec §79 / §76

Every stage is independently shippable, keeps the 191 existing tests green, and
removes no working functionality.

Per §83, each change within a stage follows: explain → identify files →
smallest safe change → tests → run → fix regressions → verify security →
verify tenant isolation → verify Azure behaviour → document.

---

## Stage 0 — Safety net (no schema change, no behaviour change)

Lands first because it is independent of the database migration and makes every
later stage verifiable.

1. `.env.example` with no real secrets; refuse to boot in production with the
   default `APP_SECRET_KEY`.
2. Security headers middleware (HSTS, CSP, `X-Content-Type-Options`,
   `Referrer-Policy`, `X-Frame-Options`).
3. Request ID middleware + structured JSON logging + token-scrubbing log filter.
4. Standard error envelope and error codes.
5. Rate limiting (in-process now, Redis in Stage 3).
6. `/api/v1` router mounting, with `/api/*` kept as working aliases.
7. Pagination envelope on `/api/search`, `/api/scans`, `/api/changes`.
8. **Cross-tenant isolation test suite** (parameterised over the route table).
9. **Data-state test suite** — Azure 403/429/5xx never yields `0`.
10. Tighten token audience policy in production.

Exit: 191 tests still green, plus the two new suites. No user-visible change.

---

## Stage 1 — Data foundation (§40, §41)

1. Introduce SQLAlchemy models mirroring the current six tables exactly.
2. Introduce Alembic; baseline migration matches the live SQLite schema.
3. Add `organizations` + `org_members`; migrate every existing user into a
   personal organization so nothing is lost.
4. Add `organization_id` to all business tables; backfill from `user_id`.
5. Base repository requiring `organization_id`; remove all raw session access.
6. Resolve `organization_id` from the authenticated identity only — reject any
   client-supplied value.
7. PostgreSQL support with connection pooling; SQLite retained for dev/tests.
8. Row-Level Security policies as defence in depth.
9. Add missing indexes, including `(org_id, scan_id, resource_id)`.

Exit: same features, PostgreSQL-capable, isolation enforced in three layers.

---

## Stage 2 — Secrets & audit (§38, §39, §42)

1. `azure_credentials` table storing **only** Key Vault secret URIs.
2. Key Vault client via Managed Identity; dev-only envelope encryption fallback.
3. One-time migration of existing plaintext secrets into Key Vault, then
   overwrite the plaintext columns.
4. Session-token encryption, expiry enforcement, revocation, usage audit.
5. Append-only `audit_log` (`REVOKE UPDATE, DELETE`) + audit middleware.
6. Secret-leakage tests: no token or secret in any response body or log line.

Exit: Critical findings S1, S2, S3 closed.

---

## Stage 3 — Async scanning & scheduling (§44, §45)

1. Extract the shared Azure HTTP client from `cost_client.py` into
   `app/azure/`; migrate `orphaned.py` and `azure_mgmt.py` onto it.
2. Queue abstraction (Redis dev / Service Bus prod).
3. Worker process; `POST /api/v1/scans` returns `202` with a job handle.
4. Checkpointed, resumable, paginated scans.
5. `scan_schedules` + scheduler (hourly → weekly → custom).
6. Post-scan pipeline: diff → recommendations → notify.
7. Docker Compose: frontend, backend, worker, scheduler, PostgreSQL, Redis.

Exit: P1 and P2 closed. Customers stop pressing Scan manually.

---

## Stage 4 — Unified resource model (§10, §15, §16)

1. Extend `scan_resources` with `properties`, `configuration`, `kind`,
   `managed_by`, `captured_at`.
2. Relationship extraction into `resource_relations` (VM→NIC→NSG→Subnet→VNet,
   VM→disks, AppGw→backend pool, Private Endpoint→DNS→VNet).
3. Resource Explorer API + Resource Detail page shell with tabs (§69).
4. Widen change detection to configuration fields now that they are stored.
5. Point-in-time query API.

---

## Stage 5 — Activity Explorer (§13)

1. Activity Log ingestion into `activity_events`.
2. Correlation of activity events to `change_events` by resource + time window.
3. Activity Explorer UI; "who changed this" on every resource.
4. Honest handling: activity retention is 90 days in Azure — older changes show
   `unavailable`, not "nobody".

---

## Stage 6 — Cost + Change correlation (§28) — flagship

1. Attribute cost deltas to: new resources, removed resources, SKU change,
   usage change, rate change, data transfer.
2. Link each cause to resource → change → activity event → cost calculation.
3. Extend the existing proof panel to explain each attribution.
4. Dashboard "cost increased because…" with full drill-through.

This is the product differentiator (§68) and is deliberately sequenced as soon
as its three dependencies (resources, changes, activity) exist.

---

## Stage 7 — Governance & identity (§18, §19, §14)

RBAC / Access Explorer, "why does this user have access", Policy Center with
compliance drill-down, management group hierarchy.

## Stage 8 — Security (§20)

Defender assessments, secure score, severity triage. Absent permission renders
`permission_required` — never a clean bill of health.

## Stage 9 — Network (§17)

Topology graph, node drill-through.

## Stage 10 — Optimization (§21–§25, §29)

Right-sizing from Monitor metrics, storage, database, commitments, Advisor
merged with internal rules and clearly source-labelled. Existing orphaned rules
preserved and enriched with evidence.

## Stage 11 — Budgets, anomalies, scoring, priorities (§26, §27, §34, §35)

Budget Center, configurable anomaly thresholds, Azure Control Score with a
published formula and per-category evidence, "What should I fix first?".

## Stage 12 — Automation & remediation (§30, §31, §63)

Rules in recommend mode first. Approval → execute → verify → audit. Ignore rules
with expiry and audit trail. Read-only remains the default (§78).

## Stage 13 — Reporting, export, notifications (§33, §71, §72)

Daily / weekly / executive reports; CSV, Excel, JSON, PDF; email, Teams,
webhook.

## Stage 14 — AI assistant (§36)

Evidence-backed only. The model may cite platform data and must label every
statement `fact | estimate | recommendation | unknown`. It may not call Azure
directly and may not answer from parametric knowledge about the customer's
estate.

## Stage 15 — Marketplace (§58–§62)

SaaS fulfilment API, subscription lifecycle, plans and feature flags, trials,
onboarding flow, admin center, documentation set.

Marketplace compliance is **not claimed** until independently validated (§58).

---

## Frontend navigation (§50) — introduced progressively

The full navigation tree is built as its backend lands. Sections without data
are not shown as empty shells.

Current pages map as:

| Today | Target section |
|---|---|
| Dashboard | Dashboard |
| CostTrends, Compare, Anomalies, ServiceAnalysis, Bandwidth, Boq | FinOps |
| ResourceGroups, GlobalSearch | Resources |
| Changes | Changes |
| Orphaned | FinOps → Optimization |
| Deploy | IaC |
| Settings, Admin | Settings |

---

## Standing constraints

- No fabricated Azure data (§54).
- `null` never becomes `0`; throttled never becomes `0`; missing permission
  never becomes "no findings" (§46, §77).
- Removed ≠ deleted (§77).
- Spend coverage ≠ capacity coverage (§77).
- Default read-only; writes require explicit approval and produce audit records
  (§78).
- Existing dashboard cost formulas are preserved as-is (§3).
- 191 existing tests are a hard regression gate.
