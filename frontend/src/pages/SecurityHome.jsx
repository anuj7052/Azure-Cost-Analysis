import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Lightbulb, ShieldAlert, Scale, ArrowRight, RefreshCw } from 'lucide-react';
import SectionHub from '../components/Layout/SectionHub';
import ScopeStrip from '../components/Layout/ScopeStrip';
import { KpiCard, Panel, PanelEmpty } from '../components/Layout/HubKit';
import { when } from '../components/Security/securityData';
import { fetchPostureSnapshots } from '../api/client';
import { useAppStore } from '../store/useAppStore';

/**
 * Access & Security overview.
 *
 * The obvious way to build this page is to run Advisor, Defender and Policy on
 * mount and show a live posture score. We do not, for the reason stated on
 * every page in this section: those calls fan out across four providers and
 * every selected subscription, and they are slow enough that a user who only
 * meant to pass through would think the app had hung.
 *
 * Instead this reads the *stored* snapshots — a single indexed SQLite query per
 * source, no Azure traffic at all. So the numbers here are explicitly historic:
 * each card is stamped with when the reading was taken, and a source that has
 * never been scanned says so rather than showing a reassuring zero. A security
 * overview that reports "0 findings" because nobody ever looked is worse than
 * no overview.
 */

const SOURCES = [
  { kind: 'advisor', label: 'Advisor', icon: Lightbulb, to: '/advisor' },
  { kind: 'defender', label: 'Defender', icon: ShieldAlert, to: '/defender' },
  { kind: 'policy', label: 'Policy', icon: Scale, to: '/policy' },
  { kind: 'rbac', label: 'Role assignments', icon: ShieldCheck, to: '/role-assignments' },
];

export default function SecurityHome() {
  const tenantId = useAppStore(s => s.selectedTenantId);

  const [latest, setLatest] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!tenantId) {
      setLatest({});
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all(SOURCES.map(source =>
      fetchPostureSnapshots({ tenant_id: tenantId, kind: source.kind })
        .then(result => [source.kind, result?.snapshots?.[0] || null])
        .catch(() => [source.kind, undefined]),
    ))
      .then((pairs) => {
        const next = {};
        let failed = 0;
        pairs.forEach(([kind, snapshot]) => {
          if (snapshot === undefined) failed += 1;
          else next[kind] = snapshot;
        });
        setLatest(next);
        setError(failed === SOURCES.length ? 'Could not read the snapshot history.' : null);
        setLoading(false);
      });
  }, [tenantId]);

  // Deferred by a tick rather than called inline: `load` flips the spinner on
  // synchronously, and doing that inside an effect body forces a second render
  // pass before the browser has painted the first one.
  useEffect(() => {
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  const scanned = SOURCES.filter(s => latest[s.kind]).length;

  const actions = (
    <button
      type="button"
      onClick={load}
      disabled={!tenantId || loading}
      className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-60"
    >
      <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
      Reload history
    </button>
  );

  return (
    <SectionHub
      sectionKey="security"
      breadcrumb={[{ label: 'Home', to: '/' }, { label: 'Access & Security' }]}
      actions={actions}
    >
      <ScopeStrip />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SOURCES.map((source) => {
          const snapshot = latest[source.kind];
          const high = snapshot?.high_count || 0;
          return (
            <KpiCard
              key={source.kind}
              label={source.label}
              icon={source.icon}
              to={source.to}
              loading={loading}
              tone={snapshot ? (high > 0 ? 'danger' : 'good') : 'neutral'}
              value={snapshot ? snapshot.finding_count.toLocaleString() : null}
              hint={snapshot
                ? `${high} high · read ${when(snapshot.captured_at)}`
                : 'Never scanned'}
              hintTone={snapshot ? (high > 0 ? 'danger' : 'good') : 'muted'}
            />
          );
        })}
      </div>

      <Panel title="Last reading per source" icon={ShieldCheck}>
        {!tenantId ? (
          <PanelEmpty>Pick a tenant to see its scan history.</PanelEmpty>
        ) : error ? (
          <PanelEmpty>{error}</PanelEmpty>
        ) : (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-slate-400">
              These counts are the last reading that was saved, not the state of Azure right
              now. Azure keeps no posture history of its own, so a saved snapshot is the only
              record of what the estate looked like on a past date — and the only thing that
              makes the change tracking on each page possible.
              {scanned < SOURCES.length && ` ${SOURCES.length - scanned} of ${SOURCES.length} sources have never been scanned.`}
            </p>
            <div className="divide-y divide-slate-800/60">
              {SOURCES.map((source) => {
                const snapshot = latest[source.kind];
                return (
                  <Link
                    key={source.kind}
                    to={source.to}
                    className="group -mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition hover:bg-slate-800/50"
                  >
                    <source.icon className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-blue-400" />
                    <span className="w-40 shrink-0 text-sm font-medium text-slate-200">{source.label}</span>
                    <span className="flex-1 font-mono text-xs text-slate-500">
                      {snapshot
                        ? `${snapshot.finding_count} findings · ${snapshot.high_count} high · ${when(snapshot.captured_at)}`
                        : 'no snapshot yet — open the page and press Run scan'}
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-slate-700 transition group-hover:translate-x-0.5 group-hover:text-blue-400" />
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </Panel>
    </SectionHub>
  );
}
