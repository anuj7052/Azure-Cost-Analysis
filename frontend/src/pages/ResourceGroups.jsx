import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { formatAmount } from '../utils/currency';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { FolderOpen, TrendingUp, Calendar } from 'lucide-react';

export default function ResourceGroups() {
  const {
    selectedTenantId, selectedSubscriptionIds, months, dateKey,
    rgData, rgLoading, rgError, loadRgCosts,
    dailyData, dailyLoading, loadDailyCosts, dailyRg,
  } = useAppStore();

  const [selectedRg, setSelectedRg] = useState(null);
  const [drillView, setDrillView] = useState('monthly'); // 'monthly' | 'daily'

  useEffect(() => {
    if (selectedTenantId && selectedSubscriptionIds.length > 0) {
      loadRgCosts();
    }
  }, [selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedRg && drillView === 'daily') {
      loadDailyCosts(selectedRg);
    }
  }, [selectedRg, drillView]);

  const currency = rgData?.currency || 'INR';
  const fmt = (v) => formatAmount(v, currency);

  // Prepare monthly bar chart data for selected RG
  const monthlyChartData = selectedRg
    ? Object.entries(
        rgData?.resource_groups?.find(r => r.rg_name === selectedRg)?.by_month || {}
      ).map(([month, cost]) => ({ month, cost: parseFloat(cost.toFixed(2)) }))
    : [];

  // Prepare daily bar chart data
  const dailyChartData = (dailyData?.days || []).map(d => ({
    date: d.date.slice(5), // MM-DD
    cost: parseFloat(d.total.toFixed(2)),
  }));

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Resource Groups</h1>
        <p className="text-slate-400 text-sm mt-1">Cost breakdown by Azure Resource Group — click any row to drill down</p>
      </div>

      {!selectedTenantId && (
        <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-6 text-center">
          <p className="text-blue-300 font-medium">No tenant selected</p>
          <p className="text-slate-400 text-sm mt-1">Add a tenant from Settings to get started.</p>
        </div>
      )}

      {rgError && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">{rgError}</div>
      )}

      {/* RG table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-300">All Resource Groups</h2>
            <p className="text-xs text-slate-500 mt-0.5">Last {months} months combined</p>
          </div>
          {rgData && (
            <span className="text-xs text-slate-400">
              Total: <span className="text-white font-semibold">{fmt(rgData.total)}</span>
            </span>
          )}
        </div>

        {rgLoading ? (
          <div className="space-y-2">{[...Array(6)].map((_, i) => <div key={i} className="h-11 bg-slate-800 rounded-lg animate-pulse" />)}</div>
        ) : !rgData?.resource_groups?.length ? (
          <p className="text-slate-500 text-sm text-center py-8">No resource group data available</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800">
                  <th className="pb-2 font-medium">#</th>
                  <th className="pb-2 font-medium">Resource Group</th>
                  <th className="pb-2 font-medium text-right">Total Cost</th>
                  <th className="pb-2 font-medium text-right">% of Total</th>
                  <th className="pb-2 font-medium text-right">Top Service</th>
                </tr>
              </thead>
              <tbody>
                {rgData.resource_groups.map((rg, i) => {
                  const pct = rgData.total > 0 ? (rg.total / rgData.total * 100).toFixed(1) : 0;
                  const topSvc = Object.entries(rg.by_service || {}).sort((a, b) => b[1] - a[1])[0];
                  const isSelected = selectedRg === rg.rg_name;
                  return (
                    <tr
                      key={rg.rg_name}
                      onClick={() => setSelectedRg(isSelected ? null : rg.rg_name)}
                      className={`border-b border-slate-800/50 cursor-pointer transition ${
                        isSelected ? 'bg-blue-900/20 border-blue-700/30' : 'hover:bg-slate-800/30'
                      }`}
                    >
                      <td className="py-3 text-slate-500 text-xs">{i + 1}</td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-blue-400' : 'text-slate-500'}`} />
                          <span className={`font-medium ${isSelected ? 'text-blue-300' : 'text-slate-200'}`}>{rg.rg_name}</span>
                        </div>
                      </td>
                      <td className="py-3 text-right text-white font-semibold">{fmt(rg.total)}</td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 bg-slate-700 rounded-full h-1.5">
                            <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-slate-400 text-xs w-10 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="py-3 text-right text-slate-400 text-xs">
                        {topSvc ? `${topSvc[0]} (${fmt(topSvc[1])})` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drill-down panel */}
      {selectedRg && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-blue-400" />
                {selectedRg}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">Drill-down view</p>
            </div>
            {/* View toggle */}
            <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
              <button
                onClick={() => setDrillView('monthly')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${drillView === 'monthly' ? 'bg-blue-600/30 text-blue-300' : 'text-slate-400 hover:text-white'}`}
              >
                <TrendingUp className="w-3.5 h-3.5" /> Monthly
              </button>
              <button
                onClick={() => { setDrillView('daily'); loadDailyCosts(selectedRg); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${drillView === 'daily' ? 'bg-blue-600/30 text-blue-300' : 'text-slate-400 hover:text-white'}`}
              >
                <Calendar className="w-3.5 h-3.5" /> Daily (last 30d)
              </button>
            </div>
          </div>

          {drillView === 'monthly' && (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={monthlyChartData} margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => formatAmount(v, currency, true)} />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }}
                    labelStyle={{ color: '#e2e8f0', fontWeight: 600 }}
                    formatter={val => [fmt(val), 'Cost']}
                  />
                  <Bar dataKey="cost" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>

              {/* Service breakdown table */}
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">Services in this RG</p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {Object.entries(rgData.resource_groups.find(r => r.rg_name === selectedRg)?.by_service || {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([svc, cost], i) => {
                      const rgTotal = rgData.resource_groups.find(r => r.rg_name === selectedRg)?.total || 1;
                      const pct = (cost / rgTotal * 100).toFixed(1);
                      return (
                        <div key={i} className="flex items-center gap-3 text-xs">
                          <span className="text-slate-400 flex-1 truncate">{svc}</span>
                          <div className="w-24 bg-slate-700 rounded-full h-1.5">
                            <div className="bg-purple-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-white font-medium w-20 text-right">{fmt(cost)}</span>
                          <span className="text-slate-500 w-12 text-right">{pct}%</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            </>
          )}

          {drillView === 'daily' && (
            dailyLoading ? (
              <div className="h-[220px] bg-slate-800/40 rounded-xl animate-pulse" />
            ) : !dailyChartData.length ? (
              <p className="text-slate-500 text-sm text-center py-8">No daily data available for this resource group</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dailyChartData} margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => formatAmount(v, currency, true)} />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }}
                    labelStyle={{ color: '#e2e8f0', fontWeight: 600 }}
                    formatter={val => [fmt(val), 'Daily Cost']}
                  />
                  <Bar dataKey="cost" fill="#06b6d4" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )
          )}
        </div>
      )}
    </div>
  );
}
