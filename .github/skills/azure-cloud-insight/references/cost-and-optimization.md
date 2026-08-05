# Cost & Optimization

## Cost Model
- Store daily granularity rows: `(tenant_id, subscription_id, date, resource_id, resource_group, service_name, meter, cost, currency, tags)`.
- Always store the currency; never sum across currencies. Normalize display via a single tenant-level reporting currency.
- Use **amortized** cost for reservation-aware reporting; expose actual vs amortized as a toggle.
- Month-to-date + forecast: prefer the Cost Management `forecast` endpoint; fall back to linear run-rate (`MTD / elapsed_days * days_in_month`) and label it as an estimate.
- Anomaly detection: rolling 7-day baseline per service; flag when today's cost > baseline mean + 2σ and delta > a minimum absolute threshold to avoid noise on cheap services.

## Optimization Rules
Each rule outputs: `resource_id`, `rule`, `evidence`, `estimated_monthly_savings`, `confidence`, `recommended_action`.

| Rule | Detection | Savings |
|---|---|---|
| Idle VM | Avg CPU < 5% AND max network < threshold over 14 days | Full VM compute cost |
| Oversized VM | P95 CPU < 40% and P95 memory < 50% over 14 days | Current SKU − next smaller SKU price |
| Unattached disk | `managedBy == null` | Full disk cost |
| Unused public IP | Not associated to NIC/LB/gateway | Full IP cost |
| Empty resource group | Zero resources for > 7 days | 0 (hygiene only) |
| Old snapshot | Age > 90 days | Full snapshot storage cost |
| Low-utilization SQL/App Service | DTU/CPU < 20% over 14 days | Tier downgrade delta |
| Stopped-not-deallocated VM | Power state `stopped` (not `deallocated`) | Full compute cost |

Rules run as a nightly Celery task over synced metrics — never call Azure live per rule. Merge with Azure Advisor cost recommendations and de-duplicate by `resource_id + category`, preferring Advisor's savings figure when present.

## Presentation
- Rank recommendations by estimated monthly savings descending.
- Show total potential savings as a headline KPI with a breakdown by rule.
- Every recommendation must be dismissible per tenant, with the dismissal audit-logged and honored on subsequent runs.
