# Azure Billing — local design review

Baseline pushed to GitHub: `76692ec`. Changes after that commit require user
approval before another push or deployment.

## Design goal

A non-technical billing user should find the period, billed amount, cost and
next action without understanding Azure infrastructure terminology.

### Keep visible
- Three primary amounts: Customer billed, Distributor cost, Profit/loss.
- Date/month selection and a customer filter.
- A compact line for customer count, service count and Azure usage reference.
- A customer table with search and an actionable Needs attention filter.
- Clear missing-data labels; incomplete profit must not look like zero profit.

### Show on demand
- Monthly breakdown, currency/source options and calculation rules.
- Per-customer monthly entries, invoices, payment notes and editable details.
- Original source cells, audit history, archives and storage settings.

### Remove from the overview
- Duplicate KPI cards and repeated role/count banners.
- Unrelated Azure tenant/subscription filters.
- Technical identifiers, full source data and destructive controls.
- Claims of payment collection, overdue balances or profit based on incomplete data.

## Stitch connection status

Verified official documentation: https://stitch.withgoogle.com/docs/mcp/setup

The project has an enabled remote MCP definition for
`https://stitch.googleapis.com/mcp`, with `X-Goog-Api-Key` resolved from a private
file outside the repository. No credential is included in the project or skill.
Quit and restart OpenCode to load the enabled server and new review skill.

Connection verified with MCP initialize and tools/list. A temporary MCP client
generated one private desktop concept using fictional data only. The generation
request timed out, but the screen completed and was recovered via list_screens
without repeating generation. The design was inspected in Ego Lite.

- Project: https://stitch.withgoogle.com/projects/15126684122816412549
- Screen: `ae5d6ed656cd43599bc8e4efcd037082` — Billing Overview - Cloudledger
- Adopted: compact table toolbar, reset, attention count/badges, explicit customer
  opening affordance, result count, collapsed supporting details below the table.
- Rejected: invented reconciliation status, inconsistent sample totals, stale
  financial-year labels, extra table columns, and automatic profit assertions.
  Existing server calculations, permissions and actual data remain authoritative.
- Stitch suggested a Sample Cedar detail screen and a dark-mode preview; neither
  additional generation has been requested.

Suggested Stitch brief (use fictional data only):

> Design a quiet, professional billing overview for non-technical finance staff.
> Three primary cards: Customer billed, Distributor cost, Profit/loss. Show
> Not ready if costs are incomplete. Compact secondary row: customers,
> subscriptions/services and Azure usage reference. A single period/customer
> filter row. Main area: searchable customer table with attention indicators
> and Open customer links. Monthly breakdown and advanced calculation options
> collapsed. Navigation: Overview, Customers, Settings. Light/dark support,
> responsive 390px mobile, readable text, no fake revenue-growth claims, no
> decorative charts or cloud-infrastructure controls. Use only fictional names
> and amounts. Preserve separate ledger and reviewed-invoice sources.
