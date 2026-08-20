/**
 * Deep links and runnable queries that let a figure be checked at its source.
 *
 * A number nobody can verify is worth very little in a conversation about an
 * invoice, so each of these opens the real tool with the real query already in
 * it rather than describing what to type.
 *
 * One honest limit runs through this file: **cost data is not KQL-queryable.**
 * Azure Cost Management is a REST API; KQL belongs to Resource Graph, which
 * describes what exists, not what it cost. So cost is verified through Cost
 * Analysis or a REST call, and KQL is offered only where it genuinely applies —
 * finding the resource behind a charge.
 */

const PORTAL = 'https://portal.azure.com/#';

/** Azure's own API version for Cost Management queries. */
export const COST_API_VERSION = '2023-03-01';

/**
 * Resource Graph Explorer, opened with the query already loaded.
 *
 * The portal reads the query from the URL fragment, so this genuinely arrives
 * pre-filled and one click from Run — no copying required.
 */
export function resourceGraphLink(kql) {
  return `${PORTAL}view/HubsExtension/ArgQueryBlade/query/${encodeURIComponent(kql)}`;
}

/** Cost Analysis, scoped to one subscription when we know which. */
export function costAnalysisLink(subscriptionId) {
  if (!subscriptionId) {
    return `${PORTAL}view/Microsoft_Azure_CostManagement/Menu/~/costanalysis`;
  }
  const scope = encodeURIComponent(`/subscriptions/${subscriptionId}`);
  return `${PORTAL}blade/Microsoft_Azure_CostManagement/Menu/open/costanalysis/scope/${scope}`;
}

/**
 * Cost analysis again, used when checking usage quantity rather than cost.
 *
 * Same blade — the Metric selector inside it is what switches between money and
 * quantity — but named separately so the calling code reads honestly.
 */
export function usageDetailsLink(subscriptionId) {
  return costAnalysisLink(subscriptionId);
}

/**
 * KQL that finds the resource a charge belongs to.
 *
 * This answers "where is this thing, and does it still exist" — not what it
 * cost. Presenting it as a cost query would be a lie, and the caller labels it
 * accordingly.
 *
 * Values are matched case-insensitively because Azure is inconsistent about
 * casing between the billing and inventory APIs.
 */
export function resourceLookupKql({ resourceName, resourceGroup }) {
  const lines = ['Resources'];

  if (resourceName) {
    // Billing rows often carry the meter rather than the resource name, so a
    // contains match is more forgiving than equality and still narrow enough.
    lines.push(`| where name contains '${escapeKql(resourceName)}'`);
  }
  if (resourceGroup) {
    lines.push(`| where resourceGroup =~ '${escapeKql(resourceGroup)}'`);
  }

  lines.push(
    '| project name, type, resourceGroup, subscriptionId, location,',
    '          sku = tostring(sku.name),',
    '          vmSize = tostring(properties.hardwareProfile.vmSize)',
    '| order by name asc',
  );

  return lines.join('\n');
}

/** A single quote would otherwise terminate the string literal in the query. */
function escapeKql(value) {
  return String(value).replace(/'/g, "\\'");
}

/**
 * The exact Cost Management request behind a figure, as an `az` command.
 *
 * Written as a single line on purpose. Cloud Shell defaults to PowerShell,
 * where the bash line-continuation `\` is not a continuation at all — it breaks
 * the command into fragments and produces "Missing expression after unary
 * operator '--'". One line runs unchanged in bash, zsh and PowerShell alike.
 *
 * The body is single-quoted so PowerShell treats it as a literal string and
 * leaves the JSON's double quotes intact.
 */
export function costQueryCli({ subscriptionId, fromDate, toDate }) {
  const sub = subscriptionId || '<subscription-id>';
  const body = costQueryBody({ fromDate, toDate });
  const url =
    `https://management.azure.com/subscriptions/${sub}` +
    `/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`;

  return `az rest --method post --url "${url}" --body '${JSON.stringify(body)}'`;
}

/**
 * The same request with `--debug`, used to read the throttling headers.
 *
 * A 429 is not a fixed penalty: Azure states the exact wait in a response
 * header. Guessing wastes time in one direction and re-triggers the limit in
 * the other, so the way to read the real number is offered rather than a
 * folk-remedy delay.
 */
export function costQueryCliWithDebug(options) {
  return `${costQueryCli(options)} --debug 2>&1 | Select-String -Pattern "retry-after"`;
}

/**
 * The request body, shown separately so the grouping is readable.
 *
 * Dates are always concrete. Angle-bracket placeholders looked like something
 * to fill in, but `<` and `>` are redirection operators in PowerShell, so
 * pasting them threw a parser error before Azure was ever contacted. When the
 * caller does not know the range, a sensible recent window is used instead and
 * the UI says so.
 */
export function costQueryBody({ fromDate, toDate }) {
  const { from, to } = resolveRange(fromDate, toDate);

  return {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from, to },
    dataset: {
      granularity: 'Monthly',
      aggregation: {
        totalCost: { name: 'PreTaxCost', function: 'Sum' },
        usageQuantity: { name: 'UsageQuantity', function: 'Sum' },
      },
      grouping: [
        { type: 'Dimension', name: 'ServiceName' },
        { type: 'Dimension', name: 'ResourceGroupName' },
        { type: 'Dimension', name: 'Meter' },
      ],
    },
  };
}

/** True when the caller supplied both ends of the range. */
export function hasExplicitRange(fromDate, toDate) {
  return Boolean(fromDate && toDate);
}

/**
 * Fall back to the last two whole months.
 *
 * Two months is the smallest window a month-over-month comparison can be
 * checked against, so a command run without an explicit range still returns
 * something meaningful rather than an error.
 */
function resolveRange(fromDate, toDate) {
  if (hasExplicitRange(fromDate, toDate)) {
    return { from: fromDate, to: toDate };
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  // Day 0 of the next month is the last day of this one, so the window always
  // ends on a real date rather than the 31st of a 30-day month.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}
