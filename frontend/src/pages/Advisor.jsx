import { useMemo, useState } from 'react';
import { fetchAdvisor } from '../api/client';
import {
  PageHeader, NeedsSelection, ErrorCard, Coverage,
  ChangeStrip, Stat, Severity, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery, when } from '../components/Security/securityData';
import { useAppStore } from '../store/useAppStore';
import { formatAmount } from '../utils/currency';

/**
 * Azure Advisor, aggregated across subscriptions and tracked over time.
 *
 * Advisor is per-subscription in the portal, which means an estate of a dozen
 * subscriptions is a dozen separate lists and no way to see the whole. Worse,
 * it is a pure snapshot: it will tell you what it thinks today and has no
 * record of what it thought last month, so the only question leadership ever
 * asks — are we getting better — has no answer available from Azure at all.
 *
 * Both are fixed the same way: read every subscription at once, and write down
 * every reading so the next one has a baseline.
 */

const CHANGE_TABS = [
  { key: 'all', label: 'All open' },
  { key: 'new', label: 'New' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'persisting', label: 'Still open' },
];

function Recommendation({ item, currency }) {
  return (
    <div className="border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition">
      <div className="flex items-center gap-2 flex-wrap">
        <Severity level={item.severity} />
        <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
          {item.category}
        </span>
        {item.change === 'new' && (
          <span className="text-[10px] text-red-300 border border-red-500/30 bg-red-950/40 rounded px-1.5 py-0.5">
            new
          </span>
        )}
        {item.change === 'resolved' && (
          <span className="text-[10px] text-emerald-300 border border-emerald-500/30 bg-emerald-950/40 rounded px-1.5 py-0.5">
            resolved
          </span>
        )}
      </div>

      <p className="text-sm font-semibold text-white mt-1.5">{item.title}</p>
      {item.solution && (
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">{item.solution}</p>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
        {item.resource_name && (
          <span>Resource: <span className="text-slate-400">{item.resource_name}</span></span>
        )}
        {typeof item.annual_saving === 'number' && (
          <span>
            Advisor&rsquo;s estimated annual saving:{' '}
            <span className="text-emerald-300">
              {formatAmount(item.annual_saving, item.currency || currency)}
            </span>
          </span>
        )}
        {item.last_updated && <span>Updated {when(item.last_updated)}</span>}
      </div>
    </div>
  );
}

export default function Advisor() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const currency = useAppStore(s => s.costData?.currency) || 'INR';
  const { data, error, loading, run, ready } = useSecurityQuery(fetchAdvisor);

  const [tab, setTab] = useState('all');
  const [category, setCategory] = useState('all');

  const rows = useMemo(() => {
    if (!data) return [];
    const base = tab === 'all' ? data.findings : (data.change?.[tab] || []);
    return category === 'all' ? base : base.filter(f => f.category === category);
  }, [data, tab, category]);

  const summary = data?.summary;

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Azure Advisor"
        subtitle="Every Advisor recommendation across every selected subscription, in one list — and what changed since the last time this ran."
        onRun={run}
        loading={loading}
        disabled={!ready}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <ErrorCard message={error} />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Recommendations" value={summary.total} />
            <Stat label="High impact" value={summary.high_count} tone="text-red-300" />
            <Stat
              label="Categories"
              value={Object.keys(summary.by_category).length}
            />
            <Stat
              label="Advisor's estimated saving"
              value={summary.annual_saving ? formatAmount(summary.annual_saving, currency) : '—'}
              tone="text-emerald-300"
              hint="Per year, and only from recommendations that carried a figure"
            />
          </div>

          <Coverage coverage={data.coverage} errors={data.errors} />
          <ChangeStrip change={data.change} />

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex flex-wrap gap-4">
              <div className="space-y-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  View
                </span>
                <Chips
                  value={tab}
                  onChange={setTab}
                  options={CHANGE_TABS.map(t => ({
                    ...t,
                    count: t.key === 'all' ? summary.total : data.change?.[`${t.key}_count`],
                  }))}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Category
                </span>
                <Chips
                  value={category}
                  onChange={setCategory}
                  options={[
                    { key: 'all', label: 'All' },
                    ...Object.entries(summary.by_category).map(([key, count]) => ({ key, label: key, count })),
                  ]}
                />
              </div>
            </div>

            <div className="space-y-2">
              {rows.length === 0 ? (
                <Empty title="Nothing here">
                  {tab === 'resolved'
                    ? 'Nothing was cleared since the previous reading.'
                    : 'No recommendations match this view. Check the coverage line above before reading that as good news.'}
                </Empty>
              ) : (
                rows.map((item, i) => <Recommendation key={item.key || i} item={item} currency={currency} />)
              )}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <p className="text-xs text-slate-400 leading-relaxed">
              Savings figures are Advisor&rsquo;s own estimates, carried through
              unchanged and not recalculated here. They assume the change is made
              and nothing else moves, which is rarely true — treat the total as a
              ranking signal rather than a forecast.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
