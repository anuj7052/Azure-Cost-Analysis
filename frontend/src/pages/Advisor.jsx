import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchAdvisor } from '../api/client';
import {
  PageHeader, NeedsSelection, Failure, Coverage,
  ChangeStrip, Stat, Severity, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery, when } from '../components/Security/securityData';
import DetailPanel from '../components/Common/DetailPanel';
import { plainAdvisorCategory, plainSeverity } from '../utils/securityLanguage';
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

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const MISSING = 'Not available';

function value(v) {
  return v === null || v === undefined || v === '' ? MISSING : v;
}

function Recommendation({ item, currency, onOpen }) {
  const category = plainAdvisorCategory(item.category);

  return (
    <button
      onClick={onOpen}
      className="w-full text-left border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Severity level={item.severity} />
        <span className="text-xs font-semibold text-slate-300">{category.plain}</span>
        <span className="font-mono text-[11px] text-slate-500">{value(item.category)}</span>
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

      <p className="text-sm font-semibold text-white mt-1.5">{value(item.title)}</p>
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
    </button>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{title}</p>
      {children}
    </div>
  );
}

function RecommendationDetail({ item, currency }) {
  const category = plainAdvisorCategory(item?.category);
  const saving = typeof item?.annual_saving === 'number'
    ? formatAmount(item.annual_saving, item.currency || currency)
    : 'Financial impact not available';

  return (
    <>
      <Section title="What this is about">
        <p className="text-sm text-slate-300">{category.plain}</p>
        <p className="font-mono text-[11px] text-slate-500">Azure category: {value(item?.category)}</p>
      </Section>

      <Section title="Why it matters">
        <p className="text-sm text-slate-300 leading-relaxed">
          {item?.description || item?.problem || category.why || MISSING}
        </p>
      </Section>

      <Section title="Recommended action">
        <p className="text-sm text-slate-300 leading-relaxed">{value(item?.solution)}</p>
      </Section>

      <Section title="Saving">
        <p className="text-sm text-emerald-300">{saving}</p>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Advisor&rsquo;s own estimate, carried through unchanged.
        </p>
      </Section>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Technical details</p>
        <dl className="mt-2 space-y-1.5">
          {[
            ['Resource id', item?.resource_id],
            ['Category', item?.category],
            ['Severity', item?.severity],
            ['Recommendation id', item?.recommendation_id || item?.key],
          ].map(([label, val]) => (
            <div key={label} className="flex flex-wrap gap-x-2">
              <dt className="text-[11px] text-slate-500">{label}</dt>
              <dd className="font-mono text-[11px] text-slate-400 break-all">{value(val)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

export default function Advisor() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const currency = useAppStore(s => s.costData?.currency) || 'INR';
  const { data, error, failure, loading, lastUpdated, cached, loaded, run, ready } = useSecurityQuery(fetchAdvisor, { source: 'advisor' });
  const [searchParams] = useSearchParams();

  const [tab, setTab] = useState('all');
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState(null);
  // Deep links from the overview arrive already narrowed; deriving the initial
  // state keeps that promise without a state-setting effect.
  const [severity, setSeverity] = useState(() => {
    const wanted = String(searchParams.get('severity') || '').toLowerCase();
    return SEVERITIES.includes(wanted) ? wanted : 'all';
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const all = Array.isArray(data.findings) ? data.findings : [];
    const change = data.change?.[tab];
    const base = tab === 'all' ? all : (Array.isArray(change) ? change : []);
    return base.filter(f =>
      (category === 'all' || f.category === category) &&
      (severity === 'all' || String(f.severity || '').toLowerCase() === severity)
    );
  }, [data, tab, category, severity]);

  // A partial body from the backend must degrade to an empty panel rather than
  // a blank page -- a security screen that fails to render says nothing at all,
  // which reads as nothing being wrong.
  const summary = data?.summary || {};
  const byCategory = summary.by_category || {};

  // Counted from the findings, because the summary carries no severity split
  // and a chip must never show a number it did not derive from what it filters.
  const severityCounts = useMemo(() => {
    const all = Array.isArray(data?.findings) ? data.findings : [];
    return all.reduce((acc, f) => {
      const key = String(f?.severity || '').toLowerCase();
      if (key) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }, [data]);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Azure Advisor"
        subtitle="Microsoft's own suggestions for saving money, tightening security and keeping services online — every subscription in one list, and what changed since the last run."
        onRun={() => run({ force: true })}
        loading={loading}
        disabled={!ready}
        lastUpdated={lastUpdated}
        cached={cached}
        loaded={loaded}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <Failure kind={failure} message={error} onRetry={() => run({ force: true })} stale={Boolean(data)} />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Recommendations" value={summary.total} />
            <Stat label="High impact" value={summary.high_count} tone="text-red-300" />
            <Stat
              label="Categories"
              value={Object.keys(byCategory).length}
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
                    ...Object.entries(byCategory).map(([key, count]) => ({
                      key,
                      label: plainAdvisorCategory(key).plain,
                      count,
                    })),
                  ]}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Severity
                </span>
                <Chips
                  value={severity}
                  onChange={setSeverity}
                  options={[
                    { key: 'all', label: 'All' },
                    ...SEVERITIES
                      .filter(s => severityCounts[s])
                      .map(s => ({ key: s, label: plainSeverity(s).plain, count: severityCounts[s] })),
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
                rows.map((item, i) => (
                  <Recommendation
                    key={item.key || i}
                    item={item}
                    currency={currency}
                    onOpen={() => setSelected(item)}
                  />
                ))
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

      <DetailPanel
        open={Boolean(selected)}
        title={selected?.title || 'Recommendation'}
        subtitle={selected ? plainAdvisorCategory(selected.category).plain : undefined}
        onClose={() => setSelected(null)}
      >
        {selected && <RecommendationDetail item={selected} currency={currency} />}
      </DetailPanel>
    </div>
  );
}
