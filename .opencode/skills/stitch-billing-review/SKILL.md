---
name: stitch-billing-review
description: Use when the user requests Stitch MCP design review or generation for Azure Billing; produce simple finance-focused UI recommendations without sharing customer data or credentials.
---

# Stitch billing design review

## Connection

The official remote MCP server is `https://stitch.googleapis.com/mcp`.
Project `opencode.json` enables it and resolves the `X-Goog-Api-Key` header from
`~/.config/opencode/secrets/stitch-api-key`, outside the repository.
Never include the credential itself in skills, prompts, logs, source or Git.
The credential file must be readable only by its owner (0600) and its directory
must be 0700. OpenCode needs restarting after MCP configuration changes.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "stitch": {
      "type": "remote",
      "url": "https://stitch.googleapis.com/mcp",
      "enabled": true,
      "headers": {
        "X-Goog-Api-Key": "{file:~/.config/opencode/secrets/stitch-api-key}"
      }
    }
  }
}
```

Existing private review project: `15126684122816412549`.
Overview screen: `ae5d6ed656cd43599bc8e4efcd037082`.
Cost dashboard screen: `93251ab7a2a7433680899ceba8cb8c2d` — source of the Cost
underline tabs and chart palette `#EA580C #0284C7 #F59E0B #0D9488 #4F46E5
#8B5CF6`, Other `#94A3B8` (see `frontend/src/utils/costDashboardSeries.js`).
Reuse this project for follow-up reviews rather than creating duplicates.

## Review brief

Design for non-technical finance users. Keep three primary KPIs: Customer
billed, Distributor cost, Profit/loss. Keep customer/service counts and Azure
usage in a compact secondary strip. Never invent profits from missing data.

Navigation: Overview, Customers, Settings. Customer detail: Monthly billing,
Bills & uploads, Company details. Keep sources, technical IDs, archives and
audit history on demand. Add clear review shortcuts and useful empty states.
Keep exact-day proration and the separation of ledger versus invoice sources.

Use fictional company names and synthetic amounts only in Stitch. Do not send
real CSVs, original invoices, customer financial data, tokens or keys.
Inspect the available MCP tool schemas before invoking generation. Generate one
desktop design at a time; report the resulting project/screen IDs. Review the
result before adapting it to React/shadcn and the existing light/dark tokens.

## Approval boundary

The user requires local review before publication. Keep subsequent application
and MCP-config changes local; do not commit, push or deploy without fresh user
approval. Verify localhost in Ego Lite and leave both existing dev servers up.
