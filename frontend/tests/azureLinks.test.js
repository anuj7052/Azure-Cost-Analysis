/**
 * Deep links and runnable queries.
 *
 * These exist so a figure can be checked at its source, which means a broken
 * link or a malformed query defeats the entire purpose — and both fail
 * silently, landing the user on an empty portal blade with no clue why.
 */
import { describe, expect, it } from 'vitest';

import {
  COST_API_VERSION,
  costQueryCliWithDebug,
  hasExplicitRange,
  costAnalysisLink,
  costQueryBody,
  costQueryCli,
  resourceGraphLink,
  resourceLookupKql,
} from '../src/utils/azureLinks';

describe('resourceGraphLink', () => {
  it('encodes the query so the portal arrives pre-filled', () => {
    const kql = "Resources | where name contains 'vm-api'";
    const link = resourceGraphLink(kql);

    expect(link).toContain('portal.azure.com');
    expect(link).toContain('ArgQueryBlade');
    // Newlines and pipes must survive encoding or the blade opens empty.
    expect(decodeURIComponent(link.split('/query/')[1])).toBe(kql);
  });

  it('survives a multi-line query', () => {
    const kql = 'Resources\n| where name contains \'x\'\n| project name';
    expect(decodeURIComponent(resourceGraphLink(kql).split('/query/')[1])).toBe(kql);
  });
});

describe('resourceLookupKql', () => {
  it('matches the resource case-insensitively', () => {
    // Azure disagrees with itself about casing between the billing and
    // inventory APIs, so an exact match silently returns nothing.
    const kql = resourceLookupKql({ resourceName: 'VM-API', resourceGroup: 'RG-Prod' });

    expect(kql).toContain("name contains 'VM-API'");
    expect(kql).toContain("resourceGroup =~ 'RG-Prod'");
  });

  it('escapes a quote instead of producing a broken query', () => {
    const kql = resourceLookupKql({ resourceName: "it's-prod" });
    expect(kql).toContain("\\'");
  });

  it('omits a filter that was not supplied', () => {
    const kql = resourceLookupKql({ resourceName: 'vm' });
    expect(kql).not.toContain('resourceGroup =~');
  });

  it('never claims to return a cost', () => {
    // Resource Graph holds no billing data; projecting a cost column would
    // imply the query verifies a charge, which it cannot.
    const kql = resourceLookupKql({ resourceName: 'vm' });
    expect(kql.toLowerCase()).not.toContain('cost');
  });
});

describe('costAnalysisLink', () => {
  it('scopes to the subscription when one is known', () => {
    const link = costAnalysisLink('sub-123');
    expect(decodeURIComponent(link)).toContain('/subscriptions/sub-123');
  });

  it('falls back to the unscoped blade rather than a wrong scope', () => {
    // A link scoped to the wrong subscription looks authoritative and shows
    // the wrong numbers, which is worse than making the user pick.
    expect(costAnalysisLink(null)).toContain('costanalysis');
    expect(costAnalysisLink(null)).not.toContain('subscriptions');
  });
});

describe('costQueryBody', () => {
  it('always emits concrete dates, never angle-bracket placeholders', () => {
    // "<from>" looked like something to fill in, but < and > are redirection
    // operators in PowerShell, so pasting them threw a parser error before
    // Azure was ever contacted.
    const period = costQueryBody({}).timePeriod;

    expect(period.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(period.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(period)).not.toContain('<');
  });

  it('honours an explicit range when one is given', () => {
    const period = costQueryBody({ fromDate: '2026-07-01', toDate: '2026-08-31' }).timePeriod;
    expect(period).toEqual({ from: '2026-07-01', to: '2026-08-31' });
  });

  it('groups by the three dimensions that identify a line item', () => {
    const dimensions = costQueryBody({}).dataset.grouping.map(g => g.name);
    expect(dimensions).toEqual(['ServiceName', 'ResourceGroupName', 'Meter']);
  });

  it('requests both cost and quantity, so the rate can be checked', () => {
    const aggregation = costQueryBody({}).dataset.aggregation;
    expect(aggregation.totalCost.name).toBe('PreTaxCost');
    expect(aggregation.usageQuantity.name).toBe('UsageQuantity');
  });

});

describe('costQueryCli', () => {
  it('is one line, because Cloud Shell runs PowerShell', () => {
    // A trailing "\\" is a bash continuation. PowerShell reads it as a broken
    // command and fails with "Missing expression after unary operator '--'".
    const cli = costQueryCli({ subscriptionId: 'sub-1' });

    expect(cli).not.toContain('\\\n');
    expect(cli.split('\n')).toHaveLength(1);
  });

  it('leaves the JSON body single-quoted so PowerShell keeps it literal', () => {
    const cli = costQueryCli({ subscriptionId: 'sub-1' });
    expect(cli).toContain(`--body '{`);
    expect(cli).toContain(`}'`);
  });

  it('is runnable as written', () => {
    const cli = costQueryCli({
      subscriptionId: 'sub-1',
      fromDate: '2026-07-01',
      toDate: '2026-08-31',
    });

    expect(cli).toContain('az rest --method post');
    expect(cli).toContain('/subscriptions/sub-1/providers/Microsoft.CostManagement/query');
    expect(cli).toContain(`api-version=${COST_API_VERSION}`);
    expect(cli).toContain('2026-07-01');
  });

  it('shows a placeholder rather than an empty subscription path', () => {
    // Safe here only because it sits inside a double-quoted URL, where
    // PowerShell treats the angle brackets as literal text.
    const cli = costQueryCli({});
    expect(cli).toContain('<subscription-id>');
    expect(cli).toMatch(/--url "[^"]*<subscription-id>[^"]*"/);
  });
});


describe('hasExplicitRange', () => {
  it('is only true when both ends are known', () => {
    expect(hasExplicitRange('2026-07-01', '2026-08-31')).toBe(true);
    expect(hasExplicitRange('2026-07-01', null)).toBe(false);
    expect(hasExplicitRange(null, null)).toBe(false);
  });
});


describe('costQueryCliWithDebug', () => {
  it('keeps the original request intact', () => {
    // A different request would report a retry window for something other than
    // the call that was actually throttled.
    const base = costQueryCli({ subscriptionId: 'sub-1' });
    expect(costQueryCliWithDebug({ subscriptionId: 'sub-1' })).toContain(base);
  });

  it('filters to the header that states the wait', () => {
    const cli = costQueryCliWithDebug({ subscriptionId: 'sub-1' });
    expect(cli).toContain('--debug');
    expect(cli.toLowerCase()).toContain('retry-after');
  });

  it('stays on one line so PowerShell accepts it', () => {
    expect(costQueryCliWithDebug({ subscriptionId: 'sub-1' }).split('\n')).toHaveLength(1);
  });
});
