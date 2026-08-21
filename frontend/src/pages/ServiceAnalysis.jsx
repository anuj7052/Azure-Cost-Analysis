import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { formatAmount } from '../utils/currency';
import ServiceBreakdownChart from '../components/Charts/ServiceBreakdownChart';
import { Search } from 'lucide-react';
import BoqGenerator from '../components/Boq/BoqGenerator';

const RESOURCE_TYPE_SHORT = (type) => type.split('/').slice(1).join('/') || type;

export default function ServiceAnalysis() {
  const { costData, costLoading, activeServices, servicesLoading, servicesError, loadServices, selectedTenantId, selectedSubscriptionIds, dateKey } = useAppStore();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  useEffect(() => {
    if (selectedTenantId && selectedSubscriptionIds.length > 0) loadServices();
  }, [selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = activeServices.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.type.toLowerCase().includes(search.toLowerCase())
  );
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Build service cost map from latest month. Keyed by Azure service name,
  // which is what a resource's `service` field carries — matching on the
  // resource *type* never hit, so every row used to show a dash.
  const latestMonth = costData?.months?.at(-1);
  const serviceCostMap = latestMonth?.by_service || {};
  const currency = activeServices[0]?.currency || costData?.currency || 'USD';

  // Group active resources by service type
  const typeGroups = {};
  activeServices.forEach(s => {
    const t = s.type;
    typeGroups[t] = (typeGroups[t] || 0) + 1;
  });
  const topTypes = Object.entries(typeGroups).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Service Analysis</h1>
        <p className="text-slate-400 text-sm mt-1">Cost breakdown by service + all active Azure resources</p>
      </div>

      {/* The services running in a subscription are exactly what a BOQ is
          written from, so the generator belongs on the page that lists them
          as well as on the BOQ page. */}
      <BoqGenerator />

      {servicesError && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-4">
          <p className="text-sm font-medium text-red-300">Could not load resources</p>
          <p className="text-xs text-slate-400 mt-1">{servicesError}</p>
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Monthly Cost by Service</h2>
          <ServiceBreakdownChart months={costData?.months || []} loading={costLoading} currency={costData?.currency || 'USD'} />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Active Resource Types</h2>
          {servicesLoading ? (
            <div className="space-y-2">{[...Array(8)].map((_, i) => <div key={i} className="h-8 bg-slate-800 rounded animate-pulse" />)}</div>
          ) : topTypes.length === 0 ? (
            <p className="text-slate-500 text-sm text-center py-8">No resource data. Check permissions.</p>
          ) : (
            <div className="space-y-2">
              {topTypes.map(([type, count]) => {
                const maxCount = topTypes[0][1];
                const pct = (count / maxCount) * 100;
                return (
                  <div key={type} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <span className="text-xs text-slate-300 truncate">{RESOURCE_TYPE_SHORT(type)}</span>
                        <span className="text-xs text-slate-500 shrink-0 ml-2">{count}</span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded-full">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Service × cost table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
          <h2 className="text-sm font-semibold text-slate-300">Active Resources</h2>
          <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-400">
            <Search className="w-3.5 h-3.5" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by name or type…"
              className="bg-transparent outline-none text-white placeholder-slate-600 w-48"
            />
          </div>
          <span className="text-xs text-slate-500">{filtered.length} resources</span>
        </div>

        {servicesLoading ? (
          <div className="space-y-2">{[...Array(10)].map((_, i) => <div key={i} className="h-10 bg-slate-800 rounded-lg animate-pulse" />)}</div>
        ) : paged.length === 0 ? (
          <p className="text-slate-500 text-sm text-center py-8">No resources found</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-800">
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium">Type</th>
                    <th className="pb-2 font-medium">SKU / size</th>
                    <th className="pb-2 font-medium">Billed for</th>
                    <th className="pb-2 font-medium">Resource Group</th>
                    <th className="pb-2 font-medium">Location</th>
                    <th className="pb-2 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((s, i) => {
                    // Live data now carries the resource's own billed cost;
                    // fall back to its service total only when Cost Management
                    // has nothing for that resource id.
                    const serviceCost = s.cost ?? serviceCostMap[s.service] ?? null;
                    return (
                      <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/30 align-top">
                        <td className="py-2.5 text-slate-200 font-medium truncate max-w-[220px]" title={s.name}>
                          {s.name}
                        </td>
                        <td className="py-2.5 text-xs text-slate-400">
                          {RESOURCE_TYPE_SHORT(s.type)}
                          {s.service && s.service !== s.type && (
                            <span className="block text-[10px] text-slate-600">{s.service}</span>
                          )}
                        </td>
                        <td className="py-2.5 text-xs whitespace-nowrap">
                          {s.sku || s.size || s.tier ? (
                            <>
                              {s.sku && (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-700 text-[#fff]">{s.sku}</span>
                              )}
                              {s.size && <span className="text-slate-300 ml-1.5">{s.size}</span>}
                              {s.tier && <span className="block text-[10px] text-slate-600">{s.tier}</span>}
                            </>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="py-2.5 text-xs text-slate-500 max-w-[220px]">
                          {s.meters?.length ? (
                            <>
                              <span className="text-slate-400">{s.meters[0].name}</span>
                              {s.meters.length > 1 && (
                                <span className="block text-[10px] text-slate-600">
                                  +{s.meters.length - 1} more meter{s.meters.length > 2 ? 's' : ''}
                                </span>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td className="py-2.5 text-slate-500 text-xs">{s.resource_group}</td>
                        <td className="py-2.5 text-slate-500 text-xs">{s.location}</td>
                        <td className="py-2.5 text-right text-slate-400 text-xs">
                          {serviceCost != null ? formatAmount(serviceCost, currency) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pageCount > 1 && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 text-xs rounded-lg bg-slate-800 text-slate-400 hover:text-white disabled:opacity-40 transition">
                  Previous
                </button>
                <span className="text-xs text-slate-500">Page {page} of {pageCount}</span>
                <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page === pageCount} className="px-3 py-1.5 text-xs rounded-lg bg-slate-800 text-slate-400 hover:text-white disabled:opacity-40 transition">
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
