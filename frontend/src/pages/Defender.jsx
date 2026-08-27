import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldAlert, Siren } from 'lucide-react';
import { fetchDefender } from '../api/client';
import {
  PageHeader, NeedsSelection, Failure, Coverage,
  ChangeStrip, Stat, Severity, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery, when } from '../components/Security/securityData';
import DetailPanel from '../components/Common/DetailPanel';
import { plainSeverity } from '../utils/securityLanguage';
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

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const MISSING = 'Not available';

function value(v) {
  return v === null || v === undefined || v === '' ? MISSING : v;
}

/** Severity said the way a reader can act on it, with Azure's word kept. */
function SeverityLabel({ level }) {
  const plain = plainSeverity(level);
  return (
    <span className="flex items-center gap-2">
      {/* The badge already carries Azure's own word and its colour, so the
          plain phrasing is added beside it rather than printing the raw
          severity a second time. */}
      <Severity level={level} />
      <span className="text-xs font-semibold text-slate-300">{plain.plain}</span>
    </span>
  );
}

function Assessment({ item, onOpen }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <SeverityLabel level={item.severity} />
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
    </button>
  );
}

function Alert({ item, onOpen }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left border border-red-500/25 bg-red-950/20 hover:bg-red-950/35 rounded-xl p-3 transition"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Siren size={14} className="text-red-400" />
        <SeverityLabel level={item.severity} />
        <span className="font-mono text-[11px] text-slate-500">{value(item.category)}</span>
        <span className="text-[10px] text-slate-500">{item.status}</span>
      </div>
      <p className="text-sm font-semibold text-white mt-1.5">{value(item.title)}</p>
      {item.description && (
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">{item.description}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
        {item.resource_name && <span>Entity: <span className="text-slate-400">{item.resource_name}</span></span>}
        {item.last_updated && <span>{when(item.last_updated)}</span>}
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

function FindingDetail({ item, isAlert }) {
  // Alerts and assessments do not identify their target the same way. An
  // assessment carries a real Azure resource id; an alert carries Defender's
  // `compromisedEntity`, which is usually just a machine name. Labelling that
  // "Resource id" sends an administrator searching the portal for a string that
  // is not a resource id, so the two are named for what they actually are.
  const targetLabel = isAlert ? 'Affected entity' : 'Resource id';

  return (
    <>
      <Section title="Severity">
        <SeverityLabel level={item?.severity} />
        <p className="text-xs text-slate-500 leading-relaxed">{plainSeverity(item?.severity).tooltip}</p>
      </Section>

      <Section title="What Azure found">
        <p className="text-sm text-slate-300 leading-relaxed">{value(item?.description)}</p>
      </Section>

      <Section title="Recommended action">
        <p className="text-sm text-slate-300 leading-relaxed">{value(item?.solution)}</p>
      </Section>

      <Section title={isAlert ? 'Affected entity' : 'Affected resource'}>
        <p className="text-sm text-slate-300 break-all">{value(item?.resource_name)}</p>
      </Section>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Technical details</p>
        <dl className="mt-2 space-y-1.5">
          {[
            [targetLabel, item?.resource_id],
            [isAlert ? 'Alert key' : 'Assessment key', item?.assessment_key || item?.key],
            ['Subscription id', item?.subscription_id],
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

export default function Defender() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const { data, error, failure, loading, lastUpdated, cached, loaded, run, ready } = useSecurityQuery(fetchDefender, { source: 'defender' });
  const [searchParams] = useSearchParams();

  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(null);
  // ?tab=alerts and ?severity=high come from the overview's action centre, and
  // landing unfiltered would send the reader hunting for what was promised.
  const [view, setView] = useState(() => (
    searchParams.get('tab') === 'alerts' ? 'alerts' : 'assessments'
  ));
  const [severity, setSeverity] = useState(() => {
    const wanted = String(searchParams.get('severity') || '').toLowerCase();
    return SEVERITIES.includes(wanted) ? wanted : 'all';
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const base = tab === 'all'
      ? (Array.isArray(data.assessments) ? data.assessments : [])
      : (Array.isArray(data.change?.[tab]) ? data.change[tab] : []);
    if (severity === 'all') return base;
    return base.filter(f => String(f?.severity || '').toLowerCase() === severity);
  }, [data, tab, severity]);

  const summary = data?.summary || {};
  const score = data?.secure_score_overall;
  const allAlerts = useMemo(() => (
    Array.isArray(data?.alerts) ? data.alerts : []
  ), [data]);
  const alerts = useMemo(() => (
    severity === 'all'
      ? allAlerts
      : allAlerts.filter(a => String(a?.severity || '').toLowerCase() === severity)
  ), [allAlerts, severity]);
  const plans = data?.plan_coverage;

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Microsoft Defender"
        subtitle="What Microsoft's security service has found on your resources: settings that could be exploited, and warnings that something may already have happened."
        onRun={() => run({ force: true })}
        loading={loading}
        disabled={!ready}
        lastUpdated={lastUpdated}
        cached={cached}
        loaded={loaded}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && (
        <Failure kind={failure} message={error} onRetry={() => run({ force: true })} stale={Boolean(data)} />
      )}

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
            <Stat
              label="High severity"
              value={summary.high_count}
              tone="text-red-300"
              hint="Settings only — alerts are counted separately"
            />
            <Stat label="Healthy" value={data.healthy_count} tone="text-emerald-300" />
            <Stat
              label="Active alerts"
              value={allAlerts.length}
              tone={allAlerts.length ? 'text-red-300' : 'text-white'}
              hint="Counted apart from assessments"
            />
          </div>

          {/* Without this, an empty page is unreadable: a subscription with
              every Defender plan on the free tier produces no assessments at
              all, which looks identical to one that is genuinely clean. */}
          {plans && (plans.known === false || plans.unmonitored > 0) && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-4">
              <p className="text-xs leading-relaxed text-amber-200">{plans.note}</p>
            </div>
          )}

          {data.truncated && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-4">
              <p className="text-xs leading-relaxed text-amber-200">
                Azure returned more findings than this read follows, so the counts
                above cover only part of the estate. This reading was not saved as
                a baseline — storing it would make every unread finding look
                resolved next time.
              </p>
            </div>
          )}

          {score && score.note && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <p className="text-xs text-slate-400 leading-relaxed">{score.note}</p>
            </div>
          )}

          <Coverage coverage={data.coverage} errors={data.errors} />
          <ChangeStrip change={data.change} />

          {/* The two lists answer different questions and are never merged, so
              the switch chooses which one is on screen rather than blending. */}
          <Chips
            value={view}
            onChange={setView}
            options={[
              { key: 'assessments', label: 'Settings to fix', count: summary.total },
              { key: 'alerts', label: 'Security alerts', count: allAlerts.length },
            ]}
          />

          {view === 'alerts' && (
            <div className="bg-slate-900 border border-red-500/25 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Siren size={16} className="text-red-400" />
                <h2 className="text-sm font-semibold text-white">
                  Security alerts ({alerts.length})
                </h2>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Warnings that something suspicious may already have happened.
              </p>
              <p className="text-xs text-slate-400 leading-relaxed">{data.alert_note}</p>
              <div className="space-y-2">
                {alerts.length === 0 ? (
                  <Empty title="No alerts in this view">
                    An empty list is only good news if the coverage line above says
                    every subscription was read.
                  </Empty>
                ) : (
                  alerts.map((a, i) => (
                    <Alert key={a.key || i} item={a} onOpen={() => setSelected({ ...a, _kind: 'alert' })} />
                  ))
                )}
              </div>
            </div>
          )}

          {view === 'assessments' && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldAlert size={16} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Assessments</h2>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Settings on your resources that Microsoft says could be exploited.
            </p>

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
                    ...Object.entries(summary.by_severity || {}).map(([key, count]) => ({
                      key: String(key).toLowerCase(),
                      label: plainSeverity(key).plain,
                      count,
                    })),
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
                rows.map((item, i) => (
                  <Assessment
                    key={item.key || i}
                    item={item}
                    onOpen={() => setSelected({ ...item, _kind: 'assessment' })}
                  />
                ))
              )}
            </div>
          </div>
          )}

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

      <DetailPanel
        open={Boolean(selected)}
        title={selected?.title || 'Finding'}
        subtitle={selected?._kind === 'alert'
          ? 'Security alert — something suspicious may already have happened.'
          : 'Assessment — a setting Microsoft says could be exploited.'}
        onClose={() => setSelected(null)}
      >
        {selected && <FindingDetail item={selected} isAlert={selected._kind === 'alert'} />}
      </DetailPanel>
    </div>
  );
}
