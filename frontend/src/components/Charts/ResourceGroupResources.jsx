import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, Search, X } from 'lucide-react';
import { fetchResourceGroupResources } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { formatAmountFull } from '../../utils/currency';
import { friendlyError } from '../../utils/apiError';
import { readCache, writeCache } from '../../utils/persistCache';

/*
 * Resource groups with every resource billed inside them, and how each was paid
 * for. Tags come from Azure's PricingModel (RI, PAYG, Savings plan, Spot) and
 * from the Site Recovery service name (DR / ASR) — never from resource names.
 */

const TAGS = {
  ri: ['RI', 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'],
  payg: ['PAYG', 'bg-[#ffedd5] text-[#9a3412] ring-[#fdba74]'],
  sp: ['Savings plan', 'bg-sky-500/15 text-sky-300 ring-sky-500/30'],
  spot: ['Spot', 'bg-slate-800 text-slate-300 ring-slate-700'],
  asr: ['DR / ASR', 'bg-violet-500/15 text-violet-300 ring-violet-500/30'],
};

function Tags({ types = [] }) {
  return types.map(type => (
    <span key={type} className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${TAGS[type][1]}`}>{TAGS[type][0]}</span>
  ));
}

const FILTERS = [['', 'All'], ['ri', 'RI'], ['payg', 'PAYG'], ['asr', 'DR / ASR']];

export default function ResourceGroupResources() {
  const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, subscriptions } = useAppStore();
  const subName = id => (subscriptions || []).find(sub => sub.subscription_id === id)?.display_name || '';
  const body = useMemo(() => ({
    tenant_id: selectedTenantId, subscription_ids: selectedSubscriptionIds, months,
    ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
  }), [selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate]);
  const key = `rg-resources:${JSON.stringify(body)}`;
  const [state, setState] = useState({ key: '', data: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let live = true;
    if (attempt === 0 && readCache(key)?.fresh) return undefined;
    fetchResourceGroupResources(body)
      .then(data => { writeCache(key, data); if (live) setState({ key, data, error: '' }); })
      .catch(err => { if (live) setState({ key, data: null, error: friendlyError(err) }); });
    return () => { live = false; };
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const cached = readCache(key);
  const current = state.key === key ? state : { data: cached?.fresh ? cached.value : null, error: '' };
  const { data, error } = current;
  const currency = data?.currency || 'INR';
  const money = v => formatAmountFull(v, currency);
  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => (data?.groups || [])
    .filter(g => !type || g.types.includes(type))
    .filter(g => !needle || [g.name, g.subscription_name || subName(g.subscription_id), ...g.resources.map(r => `${r.name} ${r.services.join(' ')}`)].join(' ').toLowerCase().includes(needle)),
  [data, type, needle, subscriptions]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
        <p className="text-sm text-red-400">{error}</p>
        <button type="button" onClick={() => { setState({ key: '', data: null, error: '' }); setAttempt(n => n + 1); }} className="mt-3 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Try again</button>
      </div>
    );
  }
  if (!data) {
    return <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-900 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Reading resource groups and resources from Azure…</div>;
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900" aria-labelledby="rg-resources-title">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 p-5">
        <div>
          <h2 id="rg-resources-title" className="text-base font-semibold text-slate-100">Resource groups</h2>
          <p className="mt-1 text-sm text-slate-400">{data.groups.length} groups · {money(data.total)} for the selected dates. Click a group to see every resource in it.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Payment type" className="inline-flex rounded-lg bg-slate-800/70 p-1">
            {FILTERS.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={type === value} onClick={() => setType(value)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${type === value ? 'bg-slate-900 text-[#c2410c] shadow-sm' : 'text-slate-400 hover:text-slate-100'}`}>{label}</button>
            ))}
          </div>
          <label className="flex h-8 items-center gap-2 rounded-md border border-slate-700 bg-slate-950 px-2.5">
            <Search className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a group or resource…" aria-label="Find a group or resource" className="w-48 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="text-slate-500 hover:text-slate-200"><X className="h-3.5 w-3.5" /></button>}
          </label>
        </div>
      </div>

      {!groups.length ? <p className="p-10 text-center text-sm text-slate-400">No resource groups match.</p> : (
        <ul className="divide-y divide-slate-800">
          {groups.map(g => {
            const id = `${g.subscription_id}:${g.name}`;
            const isOpen = open === id;
            const share = data.total ? (g.cost / data.total) * 100 : 0;
            const resources = isOpen ? g.resources.filter(r => (!type || r.types.includes(type)) && (!needle || `${r.name} ${r.services.join(' ')}`.toLowerCase().includes(needle) || g.name.toLowerCase().includes(needle))) : [];
            return (
              <li key={id}>
                <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-slate-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ea580c]">
                  <ChevronRight className={`h-4 w-4 shrink-0 text-[#ea580c] transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-100">{g.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                      <span>{g.subscription_level ? 'Billed at subscription level (support, marketplace, reservation purchases)' : `${g.resource_count} resource${g.resource_count === 1 ? '' : 's'}`}{(g.subscription_name || subName(g.subscription_id)) ? ` · ${g.subscription_name || subName(g.subscription_id)}` : ''}</span>
                      <Tags types={g.types} />
                    </p>
                  </div>
                  <div className="hidden w-32 shrink-0 sm:block"><div className="h-1.5 rounded-full bg-slate-800"><div className="h-1.5 rounded-full bg-[#EA580C]" style={{ width: `${Math.max(share, 0.5)}%` }} /></div></div>
                  <span className="w-14 shrink-0 text-right text-[11px] text-slate-500">{share.toFixed(1)}%</span>
                  <span className="w-32 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-100">{money(g.cost)}</span>
                </button>
                {isOpen && (
                  <div className="overflow-x-auto border-t border-slate-800 bg-slate-950/40">
                    <table className="w-full min-w-[40rem] text-sm">
                      <caption className="sr-only">Resources in {g.name}</caption>
                      <thead>
                        <tr className="text-left text-xs text-slate-500">
                          <th className="px-5 py-2 pl-12 font-medium">Resource</th>
                          <th className="px-3 py-2 font-medium">Service</th>
                          <th className="px-3 py-2 font-medium">Payment</th>
                          <th className="px-5 py-2 text-right font-medium">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resources.map(r => (
                          <tr key={r.resource_id || r.name} className="border-t border-slate-800/60">
                            <td className="px-5 py-2 pl-12"><p className="max-w-xs truncate font-medium text-slate-200" title={r.resource_id || r.name}>{r.name}</p>{r.type && <p className="text-[11px] text-slate-500">{r.type}</p>}</td>
                            <td className="px-3 py-2 text-xs text-slate-400">{r.services.join(', ')}</td>
                            <td className="px-3 py-2"><span className="flex flex-wrap gap-1"><Tags types={r.types} />{!r.types.length && <span className="text-[11px] text-slate-500">Not reported</span>}</span></td>
                            <td className="px-5 py-2 text-right tabular-nums text-slate-100">{money(r.cost)}</td>
                          </tr>
                        ))}
                        {!resources.length && <tr><td colSpan={4} className="px-5 py-4 pl-12 text-xs text-slate-500">No resources match this filter.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
