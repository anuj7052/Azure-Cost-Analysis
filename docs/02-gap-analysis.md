# Gap Analysis — Spec §79 Step 2

Legend:
- **Existing** — implemented and working today
- **Partial** — some of it works, materially incomplete
- **Missing** — no implementation exists
- **Refactor** — exists but must be restructured before it can carry the spec
- **Risk** — security or performance defect

Effort: S (≤1 change), M (multi-file), L (new subsystem), XL (new subsystem + infra)

---

## Foundations (must precede feature work)

| § | Capability | State | Effort | Notes |
|---|---|---|---|---|
| 40 | PostgreSQL + SQLAlchemy + Alembic | Missing | XL | Blocks §13–§35. Highest priority. |
| 41 | Organization entity + tenant isolation at query layer | Partial / Risk | L | Isolation is per-*user*, not per-*organization*. No `organizations` table. |
| 38 | Key Vault for secrets, encryption at rest | Missing / **Critical risk** | L | Plaintext SP secrets, tokens, API keys. |
| 42 | Immutable audit log | Missing | M | Nothing recorded today. |
| 43 | `/api/v1` versioning, pagination, error envelope, request IDs, rate limiting | Missing | M | All routes unversioned and unpaginated. |
| 44 | Queue + workers | Missing | XL | Scans run in-request. |
| 45 | Scheduled scanning | Missing | L | Spec marks this high priority. Depends on §44. |
| 46 | Errors never become zero | Partial | M | Cost path handles it; other paths untested. No tests assert it. |
| 48 | Shared retry/backoff/pagination | Partial / Refactor | M | Excellent in `cost_client.py`, absent elsewhere. Extract to shared client. |
| 49 | Observability | Missing | M | No structured logging, metrics, or correlation IDs. |
| 55 | Security hardening (headers, `.env.example`, scanning) | Missing | M | |
| 56 | Docker / Compose | Missing | M | |
| 73 | Backend domain modules | Refactor | M | Current layering is decent; needs domain grouping as it grows. |
| 74 | Frontend domain modules | Refactor | M | Currently organised by type. |

---

## Existing features — preserve, then extend

| § | Capability | State | Effort | Notes |
|---|---|---|---|---|
| 3 | Dashboard calculations | Existing | S | **Preserve formulas exactly.** Extend presentation only. |
| 4 | Global search incl. historical | Existing | M | Needs pagination; extend to users/activity/policies (§70). |
| 5 | Cost analysis | Existing | M | Missing: tag/department/environment/project cost, forecast, budget, variance. |
| 6 | Cost proof system | Existing | S | Strong. Extend to new data sources. |
| 7 | Month comparison | Partial | M | Variance categories exist; rate-vs-usage split needs Cost Management amortised data. |
| 8 | BOQ vs actual | Existing | S | |
| 9 | BOQ → IaC | Existing | S | Add syntax validation. |
| 10 | Snapshot engine | Existing / Refactor | L | Correct design. Must add `properties`, `configuration`, `relationships` columns. |
| 11 | Change tracking | Existing | M | Limited to sku/tags/location by schema. Widens once §10 stores config. |
| 12 | Resource history | Existing | S | Timeline exists via `/api/changes/history`. |
| 21 | Orphaned detection (8 rules) | Existing | S | Preserve rules. Add evidence/last-activity fields. |
| 27 | Anomaly engine | Partial | M | Hard-coded 20% MoM. Needs configurable thresholds + more detectors. |
| 37 | Entra ID / MSAL auth | Existing / Risk | M | Works. Audience policy needs tightening (S6). |
| 61 | Admin center | Partial | M | Users + stats only. Missing orgs, jobs, health, billing. |
| 77 | Honest-limitation behaviour | Existing | S | **Preserve.** Removed ≠ Deleted, unpriced ≠ free, throttled ≠ zero. |

---

## Missing capability areas

| § | Capability | Azure API required | Effort |
|---|---|---|---|
| 13 | Activity Explorer | `Microsoft.Insights/eventtypes/management/values` | L |
| 14 | Management groups | `Microsoft.Management/managementGroups` | M |
| 15 | Resource Explorer | Resource Graph + per-provider ARM GET | L |
| 16 | Relationship engine | Derived from resource properties | L |
| 17 | Network topology | ARM network providers | L |
| 18 | RBAC / Access Explorer | `Microsoft.Authorization/roleAssignments`, `roleDefinitions`, Graph | L |
| 19 | Policy Center | `Microsoft.PolicyInsights/policyStates`, `policyAssignments` | L |
| 20 | Security Center | `Microsoft.Security/assessments`, `secureScores` | L |
| 22 | VM right-sizing | `Microsoft.Insights/metrics` | L |
| 23 | Storage optimization | Resource Graph + Metrics | M |
| 24 | Database optimization | Metrics per DB provider | M |
| 25 | Reservation / Commitment Center | `Microsoft.Consumption/reservationDetails`, `reservationSummaries` | L |
| 26 | Budget Center | `Microsoft.Consumption/budgets` + local | M |
| 28 | Cost + Change correlation | Internal join (flagship) | L |
| 29 | Azure Advisor | `Microsoft.Advisor/recommendations` | M |
| 30 | Automation rules | Internal | L |
| 31 | Remediation w/ approval | ARM write APIs | XL |
| 32 | IaC from live resources | ARM export + generator | M |
| 33 | Reporting (daily/weekly/exec) | Internal | L |
| 34 | Azure Control Score | Internal, evidence-backed | M |
| 35 | "What should I fix first?" | Internal prioritisation | M |
| 36 | AI assistant (evidence-backed) | Internal + BYO LLM | L |
| 63 | Ignore / exception rules | Internal | M |
| 64 | Data retention | Internal | M |
| 65 | Backup / DR | Infra | M |
| 71 | Export system | Internal | M |
| 72 | Notifications (email/Teams/webhook) | Internal | M |
| 58–60 | Marketplace, onboarding, plans | Marketplace SaaS Fulfilment API | XL |

---

## Broken / Risk register (ordered)

| ID | Item | Severity | Fix in stage |
|---|---|---|---|
| S1 | Plaintext SP client secrets | Critical | 2 |
| S2 | Plaintext Azure access tokens | Critical | 2 |
| S3 | Plaintext third-party API keys | Critical | 2 |
| S4 | No organization boundary | Critical | 1 |
| S5 | Insecure default `APP_SECRET_KEY` | High | 0 |
| S6 | ARM tokens accepted as API audience | High | 2 |
| S7 | No rate limiting | High | 0 |
| S8 | No audit log | High | 2 |
| S9 | No security headers | High | 0 |
| P1 | Scans block HTTP requests | High | 3 |
| P2 | SQLite single-writer | High | 1 |
| P3 | No pagination | High | 0 |
| D1 | No ORM / Alembic | High | 1 |
| T1 | No cross-tenant/IDOR tests | High | 0 |
| T2 | No error-state (`≠ 0`) tests | High | 0 |

---

## Sequencing conclusion

Stage 0 items (headers, rate limiting, pagination envelope, `.env.example`,
API versioning, isolation tests) are **independent of the database migration**
and can land immediately without risk to the 191 passing tests.

Everything from §13 onward depends on Stage 1 (PostgreSQL + organizations).
Building features before Stage 1 means rewriting them after it.
