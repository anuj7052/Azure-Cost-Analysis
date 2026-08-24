import { useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, Search, Unlock, Plug } from 'lucide-react';
import { Breadcrumb, Panel, PanelEmpty } from '../components/Layout/HubKit';
import CurrencyApiBar from '../components/Common/CurrencyApiBar';
import {
  API_GROUPS, AUTH_NONE, AZURE_API_CATALOG,
} from '../utils/azureApis';

/**
 * The API store room.
 *
 * Every number in this product is read from one of the endpoints listed here.
 * Publishing that list is not documentation for its own sake — it is the thing
 * that makes the rest of the app checkable. A cost tool that will not say where
 * a figure came from is asking to be believed rather than verified, and an
 * invoice dispute is exactly the moment when "trust us" stops being enough.
 *
 * So each entry carries the real host, the real path, the real api-version, and
 * what it is actually used for in this app. Where an endpoint is public it is
 * marked as such and linked live; where it needs a bearer token the path is
 * shown as a template rather than a link, because a URL that 401s helps nobody.
 *
 * Nothing secret belongs on this page. There are no keys, no tenant ids and no
 * private endpoints in the catalogue it renders.
 */

const AUTH_STYLE = {
  [AUTH_NONE]: {
    icon: Unlock,
    label: 'Public — no auth',
    chip: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  },
  bearer: {
    icon: KeyRound,
    label: 'Azure AD bearer token',
    chip: 'bg-slate-800 text-slate-400 ring-1 ring-slate-700',
  },
};

const METHOD_STYLE = {
  GET: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30',
  POST: 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30',
};

function Entry({ api }) {
  const [copied, setCopied] = useState(false);
  const auth = AUTH_STYLE[api.auth] || AUTH_STYLE.bearer;
  const AuthIcon = auth.icon;

  const full = api.apiVersion
    ? `https://${api.host}${api.path}?api-version=${api.apiVersion}`
    : `https://${api.host}${api.path}`;

  const copy = () => {
    navigator.clipboard?.writeText(full).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => setCopied(false));
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-800/30 p-3.5 transition hover:bg-slate-800/60">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-white">{api.name}</h3>
        {api.method && (
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${METHOD_STYLE[api.method] || METHOD_STYLE.GET}`}>
            {api.method}
          </span>
        )}
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${auth.chip}`}>
          <AuthIcon className="h-3 w-3" aria-hidden="true" />
          {auth.label}
        </span>
        {api.thirdParty && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-300 ring-1 ring-amber-500/30">
            not Microsoft
          </span>
        )}
      </div>

      <div className="mt-2 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-slate-800 bg-slate-950/70 p-2 font-mono text-[10px] text-slate-400">
          {full}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy the ${api.name} endpoint`}
          className="shrink-0 rounded-lg border border-slate-800 bg-slate-900 p-2 text-slate-500 transition hover:text-slate-200"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-slate-300">{api.usedFor}</p>
      {api.note && <p className="mt-1 text-xs leading-relaxed text-slate-500">{api.note}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <a
          href={api.docs}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-[11px] text-blue-400 transition hover:text-blue-300"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          Reference
        </a>
        {api.auth === AUTH_NONE && !api.thirdParty && (
          <a
            href={full}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400 transition hover:text-emerald-300"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            Open it live
          </a>
        )}
        {api.apiVersion && (
          <span className="font-mono text-[11px] text-slate-600">api-version {api.apiVersion}</span>
        )}
      </div>
    </div>
  );
}

export default function ApiCatalog() {
  const [group, setGroup] = useState('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return AZURE_API_CATALOG.filter((api) => {
      if (group !== 'all' && api.group !== group) return false;
      if (!needle) return true;
      return [api.name, api.host, api.path, api.usedFor, api.note]
        .join(' ').toLowerCase().includes(needle);
    });
  }, [group, query]);

  const publicCount = AZURE_API_CATALOG.filter(a => a.auth === AUTH_NONE).length;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6 p-6">
      <Breadcrumb items={[{ label: 'Home', to: '/' }, { label: 'Account', to: '/account' }, { label: 'API Catalog' }]} />

      <div className="flex items-start gap-3.5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
          <Plug className="h-5 w-5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">API Catalog</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
            Every Microsoft endpoint behind this app, with its real path and api-version.
            {' '}{publicCount} of {AZURE_API_CATALOG.length} need no authentication at all — open
            those in a browser and you get the same data these pages read.
          </p>
        </div>
      </div>

      <Panel
        title="Retail Prices, in any currency"
        action={<span className="font-mono text-[11px] text-emerald-400">no key needed</span>}
      >
        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          The one endpoint worth trying first. Pick a currency and the URL below becomes the
          exact query for that currency — Microsoft publishes a separate price per currency
          rather than converting, so this is the only way to check a non-USD rate honestly.
        </p>
        <CurrencyApiBar filter="serviceName eq 'Virtual Machines'" billingCurrency="USD" />
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" aria-hidden="true" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search endpoints, hosts or what they are used for…"
            className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2.5 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500/40 focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {[{ key: 'all', label: 'All' }, ...API_GROUPS].map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setGroup(key)}
              aria-pressed={group === key}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                group === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-900 text-slate-400 ring-1 ring-slate-800 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {rows.length === 0
          ? <PanelEmpty>No endpoint matches that search.</PanelEmpty>
          : rows.map(api => <Entry key={api.id} api={api} />)}
      </div>

      <p className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-xs leading-relaxed text-slate-500">
        Endpoints marked <span className="text-slate-300">Azure AD bearer token</span> are shown as
        templates, not links, because they need a subscription id and an access token — a link
        that returns 401 would be worse than no link. Nothing on this page is a secret: there are
        no keys, tenant ids or private endpoints in this catalogue, and none should ever be added.
      </p>
    </div>
  );
}
