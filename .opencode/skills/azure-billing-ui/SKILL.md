---
name: azure-billing-ui
description: Use when building Azure Billing CRM dashboards, date-range filters or financial tables in this project; applies shadcn/ui composition with the existing app theme and permission model.
---

# Azure Billing UI

- Use shadcn/ui source components where appropriate; read the official registry
  before adding a component. Adapt TypeScript to this repository's JSX. Preserve
  the shadcn MIT attribution and avoid a global theme reset or overwriting the
  existing `components/ui/index.jsx` library.
- Billing-specific primitives live in `frontend/src/components/billing-ui/`.
  Compose cards with header/title/description/content. Use real labels, native
  date inputs, keyboard navigation, focus indicators and semantic tables.
- Resolve colours through existing slate/blue/emerald/rose tokens so light/dark
  modes both remain readable. Use tabular numerals for monetary columns.
- Dashboard scope is the signed-in workspace, never an arbitrary owner id from
  the browser. Readers can view; only `require_workspace_admin` routes mutate.
- All amounts are calculated server-side with Decimal. Never add currencies.
  Missing amounts stay null; zero is a known amount. Pending/review records are
  disclosed rather than silently counted. No fabricated savings or profits.
- Invoice-document and imported-ledger totals are separate sources; never add
  them together. Taxes and amount basis must be visible.
- Monthly source data cannot establish actual daily charges. Exact inclusive
  ranges prorate recurring monthly amounts by overlap days/calendar month days,
  explicitly marked estimates. Never charge two whole months for Oct 16–Nov 16.
  Unknown/one-time timing remains unallocated for partial months.
- Keep filters and selection in the URL and guard stale async responses. Include
  loading, empty, failure, partial-data, reset and refresh states.
- Test date boundaries, leap years, negative credits, currency/source isolation,
  missing amounts and archived customers/workloads. Run relevant build and SEO
  checks. Verify UI in Ego Lite without altering real customer amounts.
- Never put credentials, uploaded invoices or customer CSVs in this skill or Git.
