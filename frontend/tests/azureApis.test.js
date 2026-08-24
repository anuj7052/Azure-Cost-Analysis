import { describe, it, expect } from 'vitest';
import {
  AZURE_API_CATALOG, AUTH_NONE, API_GROUPS, RETAIL_PRICE_CURRENCIES,
  apiById, apisInGroup, isCurrencyAware, retailPricesCurl, retailPricesUrl,
  supportsCurrency, withCurrency,
} from '../src/utils/azureApis.js';

/*
 * The property that matters: a currency-specific verification link must
 * actually ask Microsoft for that currency. Azure publishes a separate price
 * per currency rather than converting, so a link that silently falls back to
 * USD would show a rate that cannot be reconciled with a non-USD invoice.
 */

describe('supportsCurrency', () => {
  it('accepts the documented codes, case-insensitively', () => {
    expect(supportsCurrency('INR')).toBe(true);
    expect(supportsCurrency('inr')).toBe(true);
    expect(supportsCurrency('USD')).toBe(true);
  });

  it('rejects codes the Retail Prices API does not publish', () => {
    // The API answers in USD for an unknown code instead of erroring, which is
    // exactly the quiet wrong answer this guard exists to surface.
    expect(supportsCurrency('AED')).toBe(false);
    expect(supportsCurrency('')).toBe(false);
    expect(supportsCurrency(null)).toBe(false);
  });
});

describe('retailPricesUrl', () => {
  it('omits currencyCode for USD, which is the endpoint default', () => {
    const url = retailPricesUrl({ currency: 'USD' });
    expect(url).not.toContain('currencyCode');
    expect(url).toContain('api-version=2023-01-01-preview');
  });

  it('sets currencyCode for every other currency', () => {
    expect(retailPricesUrl({ currency: 'INR' })).toContain('currencyCode=INR');
    expect(retailPricesUrl({ currency: 'eur' })).toContain('currencyCode=EUR');
  });

  it('encodes the OData filter rather than pasting it raw', () => {
    const url = retailPricesUrl({ filter: "serviceName eq 'Virtual Machines'", currency: 'GBP' });
    expect(url).not.toContain("serviceName eq 'Virtual Machines'");
    expect(decodeURIComponent(url)).toContain("serviceName eq 'Virtual Machines'");
  });

  it('encodes spaces as %20, never as +', () => {
    // A literal `+` is valid inside a meter name, so form-encoding a space as
    // `+` would make the two indistinguishable to the API.
    const url = retailPricesUrl({ filter: "serviceName eq 'Virtual Machines'" });
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
  });

  it('always points at the public Microsoft host', () => {
    expect(retailPricesUrl({})).toMatch(/^https:\/\/prices\.azure\.com\/api\/retail\/prices\?/);
  });
});

describe('retailPricesCurl', () => {
  it('wraps the same URL in single quotes so the shell keeps the $filter', () => {
    const curl = retailPricesCurl({ filter: "armRegionName eq 'westeurope'", currency: 'EUR' });
    expect(curl.startsWith("curl -s '")).toBe(true);
    expect(curl).toContain('currencyCode=EUR');
  });
});

describe('withCurrency', () => {
  const base = "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=skuName%20eq%20'D4as%20v5'";

  it('re-points a Retail Prices link at another currency', () => {
    expect(withCurrency(base, 'INR')).toContain('currencyCode=INR');
  });

  it('replaces an existing currencyCode instead of appending a second one', () => {
    const inr = withCurrency(base, 'INR');
    const eur = withCurrency(inr, 'EUR');
    expect(eur).toContain('currencyCode=EUR');
    expect(eur).not.toContain('INR');
    expect(eur.match(/currencyCode=/g)).toHaveLength(1);
  });

  it('strips currencyCode for USD, the endpoint default', () => {
    expect(withCurrency(withCurrency(base, 'INR'), 'USD')).not.toContain('currencyCode');
  });

  it('preserves the filter through a rewrite, spaces and all', () => {
    const out = withCurrency(base, 'JPY');
    expect(decodeURIComponent(out)).toContain("skuName eq 'D4as v5'");
    expect(out).not.toContain('+');
  });

  it('leaves links that have no currency parameter completely alone', () => {
    // Rewriting these would produce a URL that looks currency-specific and is
    // not, which is the one failure mode worth guarding.
    const docs = 'https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices';
    expect(withCurrency(docs, 'INR')).toBe(docs);
    expect(withCurrency('https://azure.microsoft.com/pricing/calculator/', 'INR'))
      .toBe('https://azure.microsoft.com/pricing/calculator/');
  });

  it('returns junk unchanged rather than throwing', () => {
    expect(withCurrency('not a url', 'INR')).toBe('not a url');
    expect(withCurrency('', 'INR')).toBe('');
  });
});

describe('isCurrencyAware', () => {
  it('is true only for the endpoint that accepts currencyCode', () => {
    expect(isCurrencyAware('https://prices.azure.com/api/retail/prices?api-version=x')).toBe(true);
    expect(isCurrencyAware('https://azure.microsoft.com/pricing/calculator/')).toBe(false);
    expect(isCurrencyAware('https://learn.microsoft.com/azure/virtual-machines/sizes')).toBe(false);
    expect(isCurrencyAware('nonsense')).toBe(false);
  });

  it('agrees with the URLs retailPricesUrl produces', () => {
    expect(isCurrencyAware(retailPricesUrl({ currency: 'INR' }))).toBe(true);
  });
});

describe('the catalogue', () => {
  it('gives every entry a unique id', () => {
    const ids = AZURE_API_CATALOG.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts every entry in a declared group', () => {
    const groups = new Set(API_GROUPS.map(g => g.key));
    for (const api of AZURE_API_CATALOG) {
      expect(groups.has(api.group)).toBe(true);
    }
  });

  it('documents every entry and says what it is used for', () => {
    for (const api of AZURE_API_CATALOG) {
      expect(api.docs).toMatch(/^https:\/\//);
      expect(api.usedFor.length).toBeGreaterThan(10);
    }
  });

  it('contains no credentials, tenant ids or query secrets', () => {
    const blob = JSON.stringify(AZURE_API_CATALOG).toLowerCase();
    for (const forbidden of ['client_secret', 'api-key', 'apikey', 'authorization:', 'bearer ey']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it('marks the Retail Prices API as public and currency-aware', () => {
    const retail = apiById('retail-prices');
    expect(retail.auth).toBe(AUTH_NONE);
    expect(retail.currencyAware).toBe(true);
  });

  it('flags the one non-Microsoft dependency', () => {
    expect(apiById('frankfurter').thirdParty).toBe(true);
  });

  it('returns nothing for an unknown id rather than throwing', () => {
    expect(apiById('nope')).toBeNull();
  });

  it('filters by group in declaration order', () => {
    const pricing = apisInGroup('pricing');
    expect(pricing.length).toBeGreaterThan(0);
    expect(pricing.every(a => a.group === 'pricing')).toBe(true);
  });
});

describe('RETAIL_PRICE_CURRENCIES', () => {
  it('lists USD first, since it is the currency Azure prices are set in', () => {
    expect(RETAIL_PRICE_CURRENCIES[0].code).toBe('USD');
  });

  it('every listed code is reported as supported', () => {
    for (const { code, label } of RETAIL_PRICE_CURRENCIES) {
      expect(supportsCurrency(code)).toBe(true);
      expect(label.length).toBeGreaterThan(2);
    }
  });
});
