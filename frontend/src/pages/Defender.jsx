import { useMemo, useState } from 'react';
import { ShieldAlert, Siren } from 'lucide-react';
import { fetchDefender } from '../api/client';
import {
  PageHeader, NeedsSelection, ErrorCard, Coverage,
  ChangeStrip, Stat, Severity, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery, when } from '../components/Security/securityData';
import { useAppStore } from '../store/useAppStore';

/**
 * Microsoft Defender for Cloud, aggregated and tracked over time.
 *
 * Two things are deliberately kept apart on this page, and they must never be
 * added together. An *assessment* says a resource could be exploited. An
 * *alert* says it may already have been. Sum them into one "findings" number
 * and a hundred configuration notes will bury one live intrusion signal — which
 * is precisely the failure mode security dashboards are famous for.
 *
 * Only assessments are compared between scans. An alert that stops appearing
 * was closed or aged out; that is not the same kind of "resolved" as a
 * misconfiguration actually being fixed, and reporting it as progress would be
 * a lie told in the most expensive possible place.
 */

const CHANGE_TABS = [
  { key: 'all', label: 'All open' },
  { key: 'new', label: 'New' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'persisting', label: 'Still open' },
];

function Assessment({ item }) {
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
      {item.description && (
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">{item.description}</p>
      )}
      {item.solution && (
        <p className="text-xs text-blue-300/80 mt-1.5 leading-relaxed">Fix: {item.solution}</p>
      )}
      {item.resource_name && (
        <p className="text-[11px] text-slate-500 mt-2">
          Resource: <span className="text-slate-400">{item.resource_name}</span>
        </p>
      )}
    </div>
  );
}

function Alert({ item }) {
  return (
    <div className="border border-red-500/25 bg-red-950/20 rounded-xl p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Siren size={14} className="text-red-400" />
        <Severity level={item.severity} />
        <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
          {item.category}
        </span>
        <span className="text-[10px] text-slate-500">{item.status}</span>
      </div>
      <p className="text-sm font-semibold text-white mt-1.5">{item.title}</p>
      {item.description && (
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">{item.description}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
        {item.resource_name && <span>Entity: <span className="text-slate-400">{item.resource_name}</span></span>}
        {item.last_updated && <span>{when(item.last_updated)}</span>}
      </div>
    </div>
  );
}

export default function Defender() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const { data, error, loading, run, ready } = useSecurityQuery(fetchDefender);

  const [tab, setTab] = useState('all');
  const [severity, setSeverity] = useState('all');

  const rows = useMemo(() => {
    if (!data) return [];
    const base = tab === 'all' ? data.assessments : (data.change?.[tab] || []);
    return severity === 'all' ? base : base.filter(f => f.severity === severity);
  }, [data, tab, severity]);

  const summary = data?.summary;
  const score = data?.secure_score_overall;

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Microsoft Defender"
        subtitle="Defender for Cloud findings across every selected subscription, with secure score and movement since the last reading."
        onRun={run}
        loading={loading}
        disabled={!ready}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <ErrorCard message={error} />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat
              label="Secure score"
              value={score ? `${score.percentage}%` : '—'}
              tone="text-blue-300"
              hint={score ? `${score.current} of ${score.max} points` : 'Not available on these subscriptions'}
            />
            <Stat label="Unhealthy" value={summary.total} tone="text-amber-300" />
            <Stat label="High severity" value={summary.high_count} tone="text-red-300" />
            <Stat label="Healthy" value={data.healthy_count} tone="text-emerald-300" />
            <Stat
              label="Active alerts"
              value={data.alerts.length}
              tone={data.alerts.length ? 'text-red-300' : 'text-white'}
              hint="Counted apart from assessments"
            />
          </div>

          {score && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <p className="text-xs text-slate-400 leading-relaxed">{score.note}</p>
            </div>
          )}

          <Coverage coverage={data.coverage} errors={data.errors} />
          <ChangeStrip change={data.change} />

          {data.alerts.length > 0 && (
            <div className="bg-slate-900 border border-red-500/25 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Siren size={16} className="text-red-400" />
                <h2 className="text-sm font-semibold text-white">
                  Security alerts ({data.alerts.length})
                </h2>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">{data.alert_note}</p>
              <div className="space-y-2">
                {data.alerts.map((a, i) => <Alert key={a.key || i} item={a} />)}
              </div>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldAlert size={16} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Assessments</h2>
            </div>

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
                  Severity
                </span>
                <Chips
                  value={severity}
                  onChange={setSeverity}
                  options={[
                    { key: 'all', label: 'All' },
                    ...Object.entries(summary.by_severity).map(([key, count]) => ({ key, label: key, count })),
                  ]}
                />
              </div>
            </div>

            <div className="space-y-2">
              {rows.length === 0 ? (
                <Empty title="Nothing here">
                  {tab === 'resolved'
                    ? 'Nothing was cleared since the previous reading.'
                    : 'No assessments match this view. An empty list is only good news if the coverage line above says everything was read.'}
                </Empty>
              ) : (
                rows.map((item, i) => <Assessment key={item.key || i} item={item} />)
              )}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <p className="text-xs text-slate-400 leading-relaxed">
              Only unhealthy assessments are listed. Healthy ones are counted but
              not shown — a large estate produces tens of thousands of them, and
              carrying those through the comparison would swamp every real
              change.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
