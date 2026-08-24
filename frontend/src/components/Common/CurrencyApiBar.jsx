import { useState } from 'react';
import { Check, Copy, ExternalLink, TriangleAlert } from 'lucide-react';
import {
  RETAIL_PRICE_CURRENCIES, isCurrencyAware, retailPricesCurl, retailPricesUrl,
  supportsCurrency, withCurrency,
} from '../../utils/azureApis';

/**
 * Pick a currency, get the Microsoft endpoint for that currency.
 *
 * Every Azure price is *set* in USD and published in other currencies at a rate
 * Microsoft chooses. Those are separate published numbers, not a conversion the
 * caller can do — the INR price for a meter is not the USD price times today's
 * market rate, and treating it that way invents a discrepancy of around ten per
 * cent that does not exist.
 *
 * So verifying a unit rate means asking the Retail Prices API *in the currency
 * the invoice is denominated in*. This strip builds exactly that URL, live, for
 * whichever currency is selected, alongside the same query as curl.
 *
 * The billing currency is preselected because that is the one that reconciles
 * against the bill. Every other currency is offered because comparing two of
 * them is how you see the premium.
 */
export default function CurrencyApiBar({
  filter = '',
  billingCurrency = 'USD',
  links = [],
  historical = false,
  className = '',
}) {
  const initial = supportsCurrency(billingCurrency)
    ? String(billingCurrency).toUpperCase()
    : 'USD';

  const [currency, setCurrency] = useState(initial);
  const [copied, setCopied] = useState('');

  const url = retailPricesUrl({ filter, currency });
  const curl = retailPricesCurl({ filter, currency });

  const copy = (what, text) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(''), 1500);
    }).catch(() => setCopied(''));
  };

  const unsupported = Boolean(billingCurrency) && !supportsCurrency(billingCurrency);

  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-950/50 p-3 ${className}`}>
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        Verify this rate in another currency
      </p>

      <div className="mt-2 flex flex-wrap gap-1">
        {RETAIL_PRICE_CURRENCIES.map(({ code, label }) => {
          const active = code === currency;
          const isBilling = code === initial;
          return (
            <button
              key={code}
              type="button"
              onClick={() => setCurrency(code)}
              title={label}
              aria-pressed={active}
              className={`rounded-lg px-2 py-1 font-mono text-[11px] font-semibold transition ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800/70 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {code}
              {isBilling && <span className={`ml-1 ${active ? 'text-blue-100' : 'text-slate-600'}`}>•</span>}
            </button>
          );
        })}
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
        <span className="text-slate-400">•</span> marks the currency this subscription is billed in.
        Microsoft sets all Azure prices in USD, so a non-USD price is their published
        conversion, not a market one — the gap between two currencies here is the premium.
      </p>

      {unsupported && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          The Retail Prices API does not publish {String(billingCurrency).toUpperCase()}.
          Showing USD instead — comparing it with your bill needs a conversion this app will not guess.
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        <div className="flex items-start gap-2">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 flex-1 items-start gap-1.5 rounded-lg border border-slate-800 bg-slate-900 p-2 text-[10px] text-blue-400 transition hover:border-blue-500/30 hover:text-blue-300"
          >
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="break-all">{url}</span>
          </a>
          <button
            type="button"
            onClick={() => copy('url', url)}
            aria-label="Copy API URL"
            className="shrink-0 rounded-lg border border-slate-800 bg-slate-900 p-2 text-slate-500 transition hover:text-slate-200"
          >
            {copied === 'url'
              ? <Check className="h-3.5 w-3.5 text-emerald-400" />
              : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-2 text-[10px] text-slate-400">
            {curl}
          </pre>
          <button
            type="button"
            onClick={() => copy('curl', curl)}
            aria-label="Copy curl command"
            className="shrink-0 rounded-lg border border-slate-800 bg-slate-900 p-2 text-slate-500 transition hover:text-slate-200"
          >
            {copied === 'curl'
              ? <Check className="h-3.5 w-3.5 text-emerald-400" />
              : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <p className="mt-1.5 text-[10px] text-slate-600">
        No key needed — the Retail Prices API is public. Open it in a browser and you get
        the same JSON this page read.
      </p>

      {/* Every other source the panel cited, re-pointed at the same currency so
          the whole set of evidence moves together. Sources that have no
          currency parameter are kept — dropping them would hide evidence — but
          labelled, so nobody assumes they followed the selection. */}
      {links.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-2.5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Every source, in {currency}
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {links.map(link => {
              const aware = isCurrencyAware(link.url);
              return (
                <li key={link.url}>
                  <a
                    href={aware ? withCurrency(link.url, currency) : link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-1.5 text-[11px] text-blue-400 transition hover:text-blue-300"
                  >
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">
                      {link.label}
                      {aware
                        ? <span className="ml-1.5 rounded bg-blue-500/10 px-1 py-0.5 font-mono text-[9px] text-blue-300">{currency}</span>
                        : <span className="ml-1.5 rounded bg-slate-800 px-1 py-0.5 font-mono text-[9px] text-slate-500">no currency parameter</span>}
                      {link.note && (
                        <span className="block text-[10px] leading-relaxed text-slate-500">{link.note}</span>
                      )}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* The limitation that bites hardest on a month-over-month comparison. */}
      {historical && (
        <p className="mt-2.5 flex items-start gap-1.5 border-t border-slate-800 pt-2.5 text-[10px] leading-relaxed text-slate-500">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" aria-hidden="true" />
          <span>
            These links return <span className="text-slate-400">today&rsquo;s</span> published price.
            Microsoft has no endpoint for a past month, in any currency, so an earlier
            month cannot be re-checked at the source — the price history above is
            what this app recorded itself, and it starts the day it first read a price.
          </span>
        </p>
      )}
    </div>
  );
}
