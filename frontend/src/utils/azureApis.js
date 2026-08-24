/**
 * The Microsoft APIs this app talks to, and how to call them yourself.
 *
 * Two jobs:
 *
 * 1. Build a *live* Azure Retail Prices URL for a chosen currency, so a unit
 *    rate on screen can be checked against Microsoft's own endpoint in the
 *    currency the invoice is actually denominated in. Microsoft sets every
 *    Azure price in USD and converts from there, so the INR price and the USD
 *    price for the same meter are two different published numbers — asking the
 *    API in the wrong currency produces a mismatch that looks like a bug in
 *    this app and is not.
 *
 * 2. Catalogue every public Microsoft endpoint behind this product, with its
 *    real api-version, what authentication it needs, and which page depends on
 *    it. An analysis tool that will not say where its numbers came from is
 *    asking to be trusted rather than checked.
 *
 * Everything here is a documented public endpoint. No key, secret or private
 * URL appears in this file, and none should ever be added to it.
 */

export const RETAIL_PRICES_URL = 'https://prices.azure.com/api/retail/prices';
export const RETAIL_PRICES_API_VERSION = '2023-01-01-preview';

/**
 * The currencies the Retail Prices API accepts for `currencyCode`.
 *
 * This is Microsoft's documented list, not every currency in the world. Asking
 * for one that is not here returns USD silently, which is exactly the kind of
 * quiet wrong answer this app exists to prevent — so an unsupported currency is
 * flagged rather than passed through.
 */
export const RETAIL_PRICE_CURRENCIES = [
  { code: 'USD', label: 'US dollar' },
  { code: 'AUD', label: 'Australian dollar' },
  { code: 'BRL', label: 'Brazilian real' },
  { code: 'CAD', label: 'Canadian dollar' },
  { code: 'CHF', label: 'Swiss franc' },
  { code: 'CNY', label: 'Chinese yuan' },
  { code: 'DKK', label: 'Danish krone' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'Pound sterling' },
  { code: 'INR', label: 'Indian rupee' },
  { code: 'JPY', label: 'Japanese yen' },
  { code: 'KRW', label: 'South Korean won' },
  { code: 'NOK', label: 'Norwegian krone' },
  { code: 'NZD', label: 'New Zealand dollar' },
  { code: 'RUB', label: 'Russian rouble' },
  { code: 'SEK', label: 'Swedish krona' },
  { code: 'TWD', label: 'New Taiwan dollar' },
];

const SUPPORTED = new Set(RETAIL_PRICE_CURRENCIES.map(c => c.code));

/** True when the Retail Prices API will actually honour this currency code. */
export function supportsCurrency(code) {
  return SUPPORTED.has(String(code || '').trim().toUpperCase());
}

/**
 * True when re-pointing this URL at another currency changes what it returns.
 *
 * Only the Retail Prices API is listed. The pricing calculator and the docs
 * pages do have currency selectors, but they are chosen inside the page rather
 * than through a documented query parameter, so rewriting their URLs would be
 * guessing. A link that silently ignores the currency it claims to carry is
 * worse than one that admits it has none.
 */
export function isCurrencyAware(url) {
  try {
    return new URL(url).hostname === 'prices.azure.com';
  } catch {
    return false;
  }
}

/**
 * The same URL, asking for a different currency.
 *
 * Returns the URL untouched when it is not currency-aware, so callers can map
 * over a mixed list of links without having to sort them first.
 */
export function withCurrency(url, currency) {
  if (!isCurrencyAware(url)) return url;

  const code = String(currency || 'USD').trim().toUpperCase();
  try {
    const parsed = new URL(url);
    // USD is the endpoint default, so the parameter is dropped rather than set
    // — it keeps the URL honest for anyone reading it rather than clicking it.
    if (code && code !== 'USD') parsed.searchParams.set('currencyCode', code);
    else parsed.searchParams.delete('currencyCode');

    // `searchParams.toString()` form-encodes spaces as `+`, which is ambiguous
    // inside an OData `$filter` where a literal plus is legal. Same reasoning
    // as `retailPricesUrl`.
    const query = [...parsed.searchParams.entries()]
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    return `${parsed.origin}${parsed.pathname}?${query}`;
  } catch {
    return url;
  }
}

/**
 * A ready-to-open Retail Prices API URL.
 *
 * `currencyCode` is omitted for USD because that is the endpoint's default and
 * a URL with fewer moving parts is easier for somebody to check by eye.
 */
export function retailPricesUrl({ filter = '', currency = 'USD', apiVersion = RETAIL_PRICES_API_VERSION } = {}) {
  const code = String(currency || 'USD').trim().toUpperCase();

  // Built by hand rather than with URLSearchParams, which form-encodes spaces
  // as `+`. That is correct for a form body and ambiguous in a `$filter`, where
  // a literal plus is a valid character in a meter name. `%20` has exactly one
  // meaning, so it is the only safe encoding here.
  const parts = [`api-version=${encodeURIComponent(apiVersion)}`];
  if (code && code !== 'USD') parts.push(`currencyCode=${encodeURIComponent(code)}`);
  if (filter) parts.push(`$filter=${encodeURIComponent(filter)}`);

  return `${RETAIL_PRICES_URL}?${parts.join('&')}`;
}

/** The equivalent curl, for pasting into a terminal or a ticket. */
export function retailPricesCurl(options) {
  return `curl -s '${retailPricesUrl(options)}'`;
}

/**
 * The Azure Pricing Calculator, which is the human-facing view of the same
 * catalogue. It carries its own currency selector rather than a URL parameter,
 * so this returns the plain page and the caller says which currency to pick.
 */
export const CALCULATOR_URL = 'https://azure.microsoft.com/pricing/calculator/';

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const AUTH_NONE = 'none';
export const AUTH_BEARER = 'bearer';

export const API_GROUPS = [
  { key: 'pricing', label: 'Pricing & rates' },
  { key: 'cost', label: 'Cost & usage' },
  { key: 'inventory', label: 'Resources & inventory' },
  { key: 'security', label: 'Access & security' },
  { key: 'identity', label: 'Identity' },
  { key: 'reference', label: 'Reference data' },
];

/**
 * Every Microsoft endpoint this product depends on.
 *
 * `path` is written as a template with `{placeholders}` rather than a working
 * URL, because most of these need a subscription id and a bearer token and a
 * copy-pasteable link that 401s helps nobody. `docs` always points at
 * Microsoft's own reference for that operation.
 */
export const AZURE_API_CATALOG = [
  {
    id: 'retail-prices',
    group: 'pricing',
    name: 'Azure Retail Prices',
    method: 'GET',
    host: 'prices.azure.com',
    path: '/api/retail/prices',
    apiVersion: RETAIL_PRICES_API_VERSION,
    auth: AUTH_NONE,
    currencyAware: true,
    usedFor: 'Published list prices behind every unit-rate explanation and the BOQ comparison.',
    docs: 'https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices',
    note: 'Unauthenticated and open to anyone. This is the same catalogue the Pricing Calculator reads.',
  },
  {
    id: 'pricing-calculator',
    group: 'pricing',
    name: 'Azure Pricing Calculator',
    method: 'GET',
    host: 'azure.microsoft.com',
    path: '/pricing/calculator/',
    apiVersion: '',
    auth: AUTH_NONE,
    currencyAware: true,
    usedFor: 'The estimate a BOQ is normally built from. Not an API — listed because it is the other side of every BOQ-vs-actual comparison.',
    docs: 'https://azure.microsoft.com/pricing/calculator/',
    note: 'Its currency selector is in the page, not the URL. Pick the same currency and region or the comparison is meaningless.',
  },
  {
    id: 'cost-query',
    group: 'cost',
    name: 'Cost Management — Query usage',
    method: 'POST',
    host: 'management.azure.com',
    path: '/subscriptions/{subscriptionId}/providers/Microsoft.CostManagement/query',
    apiVersion: '2023-11-01',
    auth: AUTH_BEARER,
    usedFor: 'Every actual-cost figure in the app: Dashboard, Cost Trends, Month Compare, Services, Resource Groups.',
    docs: 'https://learn.microsoft.com/rest/api/cost-management/query/usage',
    note: 'Amortised vs actual is a request parameter, not a default. The two disagree wherever reservations exist.',
  },
  {
    id: 'usage-details',
    group: 'cost',
    name: 'Consumption — Usage details',
    method: 'GET',
    host: 'management.azure.com',
    path: '/subscriptions/{subscriptionId}/providers/Microsoft.Consumption/usageDetails',
    apiVersion: '2023-11-01',
    auth: AUTH_BEARER,
    usedFor: 'Row-level usage: meter names, quantities and unit rates behind the Bandwidth and BOQ pages.',
    docs: 'https://learn.microsoft.com/rest/api/consumption/usage-details/list',
    note: 'The only source of per-meter quantity. Cost Management query returns money, not units.',
  },
  {
    id: 'resource-graph',
    group: 'inventory',
    name: 'Resource Graph',
    method: 'POST',
    host: 'management.azure.com',
    path: '/providers/Microsoft.ResourceGraph/resources',
    apiVersion: '2022-10-01',
    auth: AUTH_BEARER,
    usedFor: 'Resource inventory and the orphaned-resource sweep — unattached disks, idle public IPs.',
    docs: 'https://learn.microsoft.com/rest/api/azureresourcegraph/resourcegraph/resources/resources',
    note: 'KQL over the whole estate in one call. Far cheaper than walking every provider.',
  },
  {
    id: 'activity-log',
    group: 'inventory',
    name: 'Monitor — Activity Log',
    method: 'GET',
    host: 'management.azure.com',
    path: '/subscriptions/{subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values',
    apiVersion: '2015-04-01',
    auth: AUTH_BEARER,
    usedFor: 'Change Tracking, Activity Explorer, and the usage evidence behind access right-sizing.',
    docs: 'https://learn.microsoft.com/rest/api/monitor/activity-logs/list',
    note: 'Retains 90 days maximum, records writes reliably and reads only patchily, and no data-plane traffic at all.',
  },
  {
    id: 'role-assignments',
    group: 'security',
    name: 'Authorization — Role assignments',
    method: 'GET',
    host: 'management.azure.com',
    path: '/subscriptions/{subscriptionId}/providers/Microsoft.Authorization/roleAssignments',
    apiVersion: '2022-04-01',
    auth: AUTH_BEARER,
    usedFor: 'The Role Assignments page and every access-review finding.',
    docs: 'https://learn.microsoft.com/rest/api/authorization/role-assignments/list-for-subscription',
    note: 'Returns principal object ids, not names. Resolving them to people needs Microsoft Graph consent this app does not hold.',
  },
  {
    id: 'advisor',
    group: 'security',
    name: 'Advisor — Recommendations',
    method: 'GET',
    host: 'management.azure.com',
    path: '/subscriptions/{subscriptionId}/providers/Microsoft.Advisor/recommendations',
    apiVersion: '2023-01-01',
    auth: AUTH_BEARER,
    usedFor: 'The Advisor page: cost, security, reliability and operational recommendations.',
    docs: 'https://learn.microsoft.com/rest/api/advisor/recommendations/list',
    note: 'Reports only the present tense. The history on the Advisor page comes from snapshots this app stores itself.',
  },
  {
    id: 'defender',
    group: 'security',
    name: 'Defender for Cloud — Assessments & alerts',
    method: 'GET',
    host: 'management.azure.com',
    path: '/subscriptions/{subscriptionId}/providers/Microsoft.Security/assessments',
    apiVersion: '2020-01-01',
    auth: AUTH_BEARER,
    usedFor: 'The Defender page: secure score, assessments and active alerts.',
    docs: 'https://learn.microsoft.com/rest/api/defenderforcloud/assessments/list',
    note: 'Assessments and alerts are different things and are never added together here.',
  },
  {
    id: 'policy-states',
    group: 'security',
    name: 'Policy Insights — Policy states',
    method: 'POST',
    host: 'management.azure.com',
    path: '/subscriptions/{subscriptionId}/providers/Microsoft.PolicyInsights/policyStates/latest/summarize',
    apiVersion: '2019-10-01',
    auth: AUTH_BEARER,
    usedFor: 'The Policy & Governance page: compliance state, assignments and exemptions.',
    docs: 'https://learn.microsoft.com/rest/api/policy-insights/policy-states/summarize-for-subscription',
    note: 'Compliance is evaluated on a schedule, so a state can lag a fix by up to 24 hours.',
  },
  {
    id: 'subscriptions',
    group: 'inventory',
    name: 'Resource Manager — Subscriptions',
    method: 'GET',
    host: 'management.azure.com',
    path: '/subscriptions',
    apiVersion: '2022-12-01',
    auth: AUTH_BEARER,
    usedFor: 'The subscription picker. Also the only place subscription display names come from — which is why this app can show a name instead of a GUID.',
    docs: 'https://learn.microsoft.com/rest/api/resources/subscriptions/list',
    note: 'Returns only subscriptions the signed-in identity can already see.',
  },
  {
    id: 'entra-token',
    group: 'identity',
    name: 'Microsoft Entra ID — Token endpoint',
    method: 'POST',
    host: 'login.microsoftonline.com',
    path: '/{tenantId}/oauth2/v2.0/token',
    apiVersion: '',
    auth: AUTH_NONE,
    usedFor: 'Exchanging your sign-in for an ARM access token. Every bearer-token call above depends on it.',
    docs: 'https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow',
    note: 'Tokens are scoped to https://management.azure.com/.default and are never written to disk by this app.',
  },
  {
    id: 'frankfurter',
    group: 'reference',
    name: 'Frankfurter — Reference FX rates',
    method: 'GET',
    host: 'api.frankfurter.dev',
    path: '/v1/latest',
    apiVersion: '',
    auth: AUTH_NONE,
    usedFor: 'The market exchange rate shown beside Microsoft’s own rate on the unit-rate panel.',
    docs: 'https://frankfurter.dev/',
    note: 'Not a Microsoft service, and deliberately never used to convert a price — only to show how far Microsoft’s catalogue rate sits from the market.',
    thirdParty: true,
  },
];

/** A single catalogue entry by id. */
export function apiById(id) {
  return AZURE_API_CATALOG.find(entry => entry.id === id) || null;
}

/** Catalogue entries for one group, in declaration order. */
export function apisInGroup(group) {
  return AZURE_API_CATALOG.filter(entry => entry.group === group);
}
