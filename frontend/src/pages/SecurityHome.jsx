import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheck, Lightbulb, ShieldAlert, Scale, ArrowRight, RefreshCw,
  KeyRound, Search, Lock, Layers, ListChecks, TrendingUp, BookOpen, Building2,
} from 'lucide-react';
import SectionHub from '../components/Layout/SectionHub';
import ScopeStrip from '../components/Layout/ScopeStrip';
import { KpiCard, Panel, PanelEmpty, MeterRow } from '../components/Layout/HubKit';
import { when } from '../components/Security/securityData';
import { fetchPostureSnapshots } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import {
  SOURCE, actionCentre, attentionList, correlatedResources, permissionGaps,
  searchSecurity, securityKpis, securityPosture, securityTrend,
  subscriptionSecurity, sourceState,
} from '../utils/securityModel';
import { GLOSSARY } from '../utils/securityLanguage';

/**
 * Access & Security overview — the command centre for the section.
 *
 * Two kinds of truth are shown here and they are never mixed. The snapshot row
 * is *history*: what was saved the last time somebody scanned, stamped with
 * when. Everything above it is *live*: findings read from Azure in this
 * session. Azure keeps no posture history of its own, so the snapshots are the
 * only record of the past, and live findings are the only description of now.
 * Presenting either as the other would be a lie about the age of a security
 * figure, which is the kind of lie that gets acted on.
 *
 * Azure is not read on mount. These calls fan out across four providers and
 * every selected subscription; firing them for somebody passing through would
 * burn rate limit and make the section feel broken. If another page has
 * already loaded them the cached answers appear immediately, because the store
 * is shared — otherwise the reader presses the button.
 *
 * Nothing here invents a number. A source that was denied contributes a named
 * permission gap, not a zero, and there is deliberately no single "security
 * score": a figure that blends identity hygiene with patch compliance moves for
 * reasons nobody can explain.
 */

const SNAPSHOT_SOURCES = [
  { kind: 'advisor', label: 'Advisor', icon: Lightbulb, to: '/advisor' },
  { kind: 'defender', label: 'Defender', icon: ShieldAlert, to: '/defender' },
  { kind: 'policy', label: 'Policy', icon: Scale, to: '/policy' },
  { kind: 'rbac', label: 'Role assignments', icon: ShieldCheck, to: '/role-assignments' },
];

const SEVERITY_STYLE = {
  critical: 'border-red-500/40 bg-red-950/50 text-red-200',
  high: 'border-red-500/30 bg-red-950/30 text-red-300',
  medium: 'border-amber-500/30 bg-amber-950/30 text-amber-300',
  low: 'border-slate-700 bg-slate-800/60 text-slate-300',
  info: 'border-slate-700 bg-slate-800/40 text-slate-400',
};

const KPI_TONE = { critical: 'danger', high: 'danger', good: 'good' };

const STAGE_MARK = {
  [SOURCE.OK]: '\u2713',
  [SOURCE.EMPTY]: '\u2713',
  [SOURCE.PARTIAL]: '\u25d0',
  [SOURCE.LOADING]: '\u25cf',
  [SOURCE.NO_ACCESS]: '\u2715',
  [SOURCE.THROTTLED]: '\u23f8',
  [SOURCE.NOT_LOADED]: '\u25cb',
};

const STAGE_TEXT = {
  [SOURCE.NOT_LOADED]: 'not read',
  [SOURCE.LOADING]: 'reading…',
  [SOURCE.NO_ACCESS]: 'access unavailable',
  [SOURCE.THROTTLED]: 'rate limited',
  [SOURCE.EMPTY]: 'read · nothing found',
  [SOURCE.OK]: 'read',
};

function Muted({ children }) {
  return <p className="text-xs leading-relaxed text-slate-500">{children}</p>;
}

export default function SecurityHome() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const selectedIds = useAppStore(s => s.selectedSubscriptionIds);
  const subscriptions = useAppStore(s => s.subscriptions);

  const advisorData = useAppStore(s => s.advisorData);
  const defenderData = useAppStore(s => s.defenderData);
  const policyData = useAppStore(s => s.policyData);
  const accessData = useAppStore(s => s.accessData);
  const rolesData = useAppStore(s => s.rolesData);
  const postureLoading = useAppStore(s => s.postureLoading);
  const postureError = useAppStore(s => s.postureError);
  const accessLoading = useAppStore(s => s.accessLoading);
  const accessError = useAppStore(s => s.accessError);
  const loadPosture = useAppStore(s => s.loadPosture);
  const loadAccess = useAppStore(s => s.loadAccess);

  const [latest, setLatest] = useState({});
  const [history, setHistory] = useState({});
  const [trendKind, setTrendKind] = useState('defender');
  const [trendDays, setTrendDays] = useState(30);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [lastRead, setLastRead] = useState(null);
  const [query, setQuery] = useState('');

  const scoped = Boolean(tenantId) && selectedIds.length > 0;

  const loadHistory = useCallback(() => {
    if (!tenantId) {
      setLatest({});
      setHistory({});
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    Promise.all(SNAPSHOT_SOURCES.map(source =>
      fetchPostureSnapshots({ tenant_id: tenantId, kind: source.kind })
        .then(result => [source.kind, Array.isArray(result?.snapshots) ? result.snapshots : []])
        .catch(() => [source.kind, undefined]),
    ))
      .then((pairs) => {
        const next = {};
        const series = {};
        let failed = 0;
        pairs.forEach(([kind, snapshots]) => {
          if (snapshots === undefined) failed += 1;
          else {
            next[kind] = snapshots[0] || null;
            series[kind] = snapshots;
          }
        });
        setLatest(next);
        setHistory(series);
        setHistoryError(failed === SNAPSHOT_SOURCES.length ? 'Could not read the snapshot history.' : null);
        setHistoryLoading(false);
      });
  }, [tenantId]);

  // Deferred by a tick rather than called inline: `loadHistory` flips a spinner
  // on synchronously, and doing that inside an effect body forces a second
  // render pass before the browser has painted the first one.
  useEffect(() => {
    const id = setTimeout(loadHistory, 0);
    return () => clearTimeout(id);
  }, [loadHistory]);

  const readAzure = useCallback(async (force) => {
    if (!scoped) return;
    const opts = force ? { force: true } : {};
    // Sequential rather than parallel. The access review reads the Activity Log
    // on top of RBAC and is far heavier than the posture call; running both
    // fan-outs at once against the same subscriptions is the fastest way to be
    // throttled by Azure.
    await loadPosture(opts);
    await loadAccess(opts);
    setLastRead(new Date());
    loadHistory();
  }, [scoped, loadPosture, loadAccess, loadHistory]);

  const sources = useMemo(() => ({
    advisor: sourceState('advisor', advisorData, { loading: postureLoading, error: postureError }),
    defender: sourceState('defender', defenderData, { loading: postureLoading, error: postureError }),
    policy: sourceState('policy', policyData, { loading: postureLoading, error: postureError }),
    access: sourceState('access', accessData, { loading: accessLoading, error: accessError }),
    rbac: sourceState('rbac', rolesData, { loading: accessLoading, error: accessError }),
  }), [advisorData, defenderData, policyData, accessData, rolesData,
    postureLoading, postureError, accessLoading, accessError]);

  const payload = useMemo(() => ({
    advisor: advisorData, defender: defenderData, policy: policyData,
    access: accessData, rbac: rolesData,
  }), [advisorData, defenderData, policyData, accessData, rolesData]);

  const kpis = useMemo(() => securityKpis(sources, payload), [sources, payload]);
  const posture = useMemo(() => securityPosture(sources, payload), [sources, payload]);
  const attention = useMemo(() => attentionList(sources, payload, 12), [sources, payload]);
  const correlated = useMemo(() => correlatedResources(sources, payload, 8), [sources, payload]);
  const gaps = useMemo(() => permissionGaps(sources), [sources]);
  const results = useMemo(() => searchSecurity(sources, payload, query), [sources, payload, query]);
  const actionsToTake = useMemo(() => actionCentre(sources, payload), [sources, payload]);

  const selectedSubs = useMemo(
    () => (subscriptions || []).filter(s => selectedIds.includes(s.subscription_id)),
    [subscriptions, selectedIds],
  );
  const perSubscription = useMemo(
    () => subscriptionSecurity(sources, payload, selectedSubs),
    [sources, payload, selectedSubs],
  );

  // The trend is drawn from saved snapshots, never from the live read: Azure
  // keeps no posture history, so a point on this chart only exists because
  // somebody scanned on that day.
  const trend = useMemo(
    () => securityTrend(history[trendKind], trendDays),
    [history, trendKind, trendDays],
  );

  const anyLive = Object.values(sources).some(s => s.state !== SOURCE.NOT_LOADED);
  const busy = postureLoading || accessLoading;
  const subLabel = subscriptions?.length
    ? `${selectedIds.length} of ${subscriptions.length} subscriptions`
    : `${selectedIds.length} subscription(s)`;

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] text-slate-500">
        {lastRead ? `Read ${lastRead.toLocaleTimeString()}` : 'Azure not read yet'}
      </span>
      <button
        type="button"
        onClick={() => readAzure(anyLive)}
        disabled={!scoped || busy}
        className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
      >
        <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        {busy ? 'Reading Azure…' : anyLive ? 'Refresh' : 'Read Azure now'}
      </button>
    </div>
  );

  return (
    <SectionHub
      sectionKey="security"
      breadcrumb={[{ label: 'Home', to: '/' }, { label: 'Access & Security' }]}
      actions={actions}
    >
      <ScopeStrip />

      <Panel title="Sources" icon={Layers}>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {Object.values(sources).map(source => (
              <Link
                key={source.key}
                to={source.route || '#'}
                className="flex items-center gap-2 font-mono text-[11px] text-slate-400 transition hover:text-blue-300"
              >
                <span className="w-3 text-center text-slate-500">{STAGE_MARK[source.state]}</span>
                <span className="text-slate-300">{source.label}</span>
                <span className="text-slate-600">
                  {source.state === SOURCE.PARTIAL
                    ? `${source.read}/${source.requested} subs`
                    : STAGE_TEXT[source.state]}
                </span>
              </Link>
            ))}
          </div>
          <Muted>
            Scope: {subLabel}. Nothing on this page is read from Azure until you ask
            for it — every source above fans out across each selected subscription.
            A source marked “not read” is not a statement that it is clean.
          </Muted>
        </div>
      </Panel>

      <Panel title="Search access & security" icon={Search}>
        <div className="space-y-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Principal, resource, policy or recommendation…"
            aria-label="Search access and security"
            className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
          />
          {!results ? (
            <Muted>
              Searches only what has been read into this page. Type at least two characters.
            </Muted>
          ) : results.rows.length === 0 ? (
            <div className="space-y-1">
              <PanelEmpty>Nothing loaded matches “{results.query}”.</PanelEmpty>
              {results.note && <Muted>{results.note}</Muted>}
            </div>
          ) : (
            <div className="space-y-1">
              {results.rows.map(row => (
                <Link
                  key={row.id}
                  to={row.route || '#'}
                  className="group flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-800/50"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{row.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-slate-500">{row.type}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-700 transition group-hover:text-blue-400" />
                </Link>
              ))}
              <Muted>
                Showing {results.rows.length} of {results.total} match(es).
                {results.note ? ` ${results.note}` : ''}
              </Muted>
            </div>
          )}
        </div>
      </Panel>

      {kpis.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map(card => (
            <KpiCard
              key={card.id}
              label={card.label}
              value={typeof card.value === 'number' ? card.value.toLocaleString() : card.value}
              to={card.route}
              tone={KPI_TONE[card.tone] || 'neutral'}
              hint={card.partial ? card.readNote : card.hint}
              hintTone={card.partial ? 'warn' : 'muted'}
            />
          ))}
        </div>
      )}

      {actionsToTake.length > 0 && (
        <Panel title="What to do first" icon={ListChecks}>
          <div className="space-y-2">
            {actionsToTake.map((item, index) => (
              <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 font-mono text-[11px] text-slate-400">
                    {index + 1}
                  </span>
                  <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${SEVERITY_STYLE[item.severity] || SEVERITY_STYLE.low}`}>
                    {item.severity}
                  </span>
                  <span className="text-sm font-semibold text-slate-100">{item.title}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{item.impact}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">{item.action}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="truncate font-mono text-[11px] text-slate-600">{item.resource}</span>
                  <Link
                    to={item.route}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:border-blue-500/40 hover:text-blue-300"
                  >
                    {item.cta}
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            ))}
            <Muted>
              Each button opens the page already filtered to the rows it counted.
              Sources that could not be read contribute nothing here, so this is a
              list of work rather than a claim that the rest is fine.
            </Muted>
          </div>
        </Panel>
      )}

      {gaps.length > 0 && (
        <Panel title="What could not be read" icon={Lock}>
          <div className="space-y-3">
            <Muted>
              These sources are missing or incomplete. Findings they would have
              produced are absent from every count on this page, which is not the
              same as those findings not existing.
            </Muted>
            {gaps.map(gap => (
              <div key={gap.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-200">{gap.label}</span>
                  <span className="rounded border border-amber-500/30 bg-amber-950/30 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-300">
                    {gap.state === SOURCE.PARTIAL ? `partial ${gap.complete}` : STAGE_TEXT[gap.state]}
                  </span>
                </div>
                {gap.note && <p className="mt-1 text-xs leading-relaxed text-slate-400">{gap.note}</p>}
                {gap.permissions.length > 0 && (
                  <p className="mt-1 font-mono text-[11px] text-amber-300/80">
                    Needs: {gap.permissions.join(' · ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="What needs attention" icon={ShieldAlert}>
        {!anyLive ? (
          <PanelEmpty>
            Azure has not been read yet in this session. Press “Read Azure now” above.
          </PanelEmpty>
        ) : attention.rows.length === 0 ? (
          <div className="space-y-1">
            <PanelEmpty>Nothing was flagged by the sources that could be read.</PanelEmpty>
            {gaps.length > 0 && (
              <Muted>
                {gaps.length} source(s) could not be read in full, so this is not a
                clean bill of health for the whole estate.
              </Muted>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {attention.rows.map(row => (
              <Link
                key={row.key}
                to={row.route || '#'}
                className="group block rounded-xl border border-slate-800 bg-slate-900/60 p-3 transition hover:border-slate-700"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${SEVERITY_STYLE[row.severity] || SEVERITY_STYLE.low}`}>
                    {row.severity}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">{row.category}</span>
                  {row.affected > 1 && (
                    <span className="font-mono text-[11px] text-slate-500">
                      {row.affected} occurrences
                    </span>
                  )}
                  <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-700 transition group-hover:text-blue-400" />
                </div>
                <p className="mt-1 text-sm text-slate-200">{row.title}</p>
                {row.resource && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{row.resource}</p>
                )}
                {row.where && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-600">{row.where}</p>
                )}
                {row.reason && (
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">{row.reason}</p>
                )}
                {row.action && (
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">{row.action}</p>
                )}
              </Link>
            ))}
            <Muted>
              Showing {attention.rows.length} of {attention.total}, worst first.
              Repeats of one Azure finding across subscriptions are collapsed into a
              single row rather than crowding out distinct problems.
            </Muted>
          </div>
        )}
      </Panel>

      <Panel title="Posture" icon={ShieldCheck}>
        <div className="space-y-3">
          {posture.map(dim => (
            <div key={dim.key} className="space-y-1">
              {dim.score === null ? (
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm text-slate-300">{dim.name}</span>
                  <span className="font-mono text-xs text-slate-500">{dim.verdict}</span>
                </div>
              ) : (
                <MeterRow
                  label={dim.name}
                  pct={dim.score}
                  note={`${dim.score}%`}
                  noteTone={dim.score >= 80 ? 'good' : dim.score >= 50 ? 'warn' : 'danger'}
                  colour={dim.score >= 80 ? 'bg-emerald-500' : dim.score >= 50 ? 'bg-amber-500' : 'bg-red-500'}
                />
              )}
              {/* The basis is always shown. A posture bar without the sentence
                  explaining what it counted is a decoration, not a measurement. */}
              <Muted>{dim.measures}. {dim.basis}</Muted>
              {dim.partial && (
                <Muted>
                  Some subscriptions could not be read, so this covers only part of
                  the selected estate.
                </Muted>
              )}
            </div>
          ))}
          <Muted>
            Each dimension is measured separately and there is no combined score.
            Identity hygiene and patch compliance do not average into anything
            meaningful, and a security number nobody can explain is one nobody
            should act on.
          </Muted>
        </div>
      </Panel>

      {correlated.rows.length > 0 && (
        <Panel title="Resources flagged by more than one source" icon={KeyRound}>
          <div className="space-y-2">
            {correlated.rows.map(row => (
              <div key={row.resourceId} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="truncate text-sm text-slate-200">{row.name}</p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                  {row.issueCount} issue(s) · {row.sources.join(' · ')}
                </p>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
                  {row.issues.join(' · ')}
                </p>
              </div>
            ))}
            <Muted>
              {correlated.total} resource(s) appear in more than one source. These are
              listed rather than scored: a machine flagged by Defender, Policy and
              Advisor has three specific problems with three specific fixes, and
              combining them into one number would hide all three.
            </Muted>
          </div>
        </Panel>
      )}

      {perSubscription.length > 0 && anyLive && (
        <Panel title="By subscription" icon={Building2}>
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left font-mono text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3 font-semibold">Subscription</th>
                    <th className="py-2 pr-3 text-right font-semibold">Security</th>
                    <th className="py-2 pr-3 text-right font-semibold">Rules broken</th>
                    <th className="py-2 pr-3 text-right font-semibold">Suggestions</th>
                    <th className="py-2 pr-3 text-right font-semibold">Access</th>
                    <th className="py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {perSubscription.map(row => (
                    <tr key={row.id} className="border-b border-slate-800/60 last:border-0">
                      <td className="py-2 pr-3">
                        <span className="text-slate-200">{row.name}</span>
                        {!row.complete && (
                          <span
                            className="ml-2 font-mono text-[10px] text-amber-400"
                            title={`Not known for: ${row.unknownSources.join(', ')}`}
                          >
                            partial
                          </span>
                        )}
                      </td>
                      <Cell cell={row.defender} />
                      <Cell cell={row.policy} />
                      <Cell cell={row.advisor} />
                      <Cell cell={row.access} />
                      <td className="py-2 text-right font-mono text-slate-200">
                        {row.issues === null ? <span className="text-slate-600">—</span> : row.issues.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Muted>
              A dash means that source could not be read for that subscription. It
              is not a zero — a subscription nobody was allowed to look at sorts to
              the bottom of this table rather than the top.
            </Muted>
          </div>
        </Panel>
      )}

      <Panel
        title="Trend"
        icon={TrendingUp}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={trendKind}
              onChange={(e) => setTrendKind(e.target.value)}
              aria-label="Trend source"
              className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-300"
            >
              {SNAPSHOT_SOURCES.map(s => (
                <option key={s.kind} value={s.kind}>{s.label}</option>
              ))}
            </select>
            <select
              value={trendDays}
              onChange={(e) => setTrendDays(Number(e.target.value))}
              aria-label="Trend period"
              className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-300"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>3 months</option>
              <option value={180}>6 months</option>
              <option value={365}>12 months</option>
            </select>
          </div>
        )}
      >
        {!trend.ready ? (
          <div className="space-y-1">
            <PanelEmpty>{trend.note}</PanelEmpty>
            <Muted>
              Azure keeps no history of its own posture, so a point appears here
              only because somebody ran a scan on that day. History will build up
              as this page is used.
            </Muted>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-2xl font-bold text-white">
                {trend.series[trend.series.length - 1].total.toLocaleString()}
              </span>
              <span className={`font-mono text-xs ${trend.direction === 'down' ? 'text-emerald-400' : trend.direction === 'up' ? 'text-red-400' : 'text-slate-500'}`}>
                {trend.change > 0 ? '+' : ''}{trend.change.toLocaleString()} since the first reading
              </span>
            </div>
            <div className="flex items-end gap-1" role="img" aria-label={trend.note}>
              {trend.series.map((point) => {
                const peak = Math.max(...trend.series.map(p => p.total)) || 1;
                return (
                  <div
                    key={point.at}
                    title={`${point.date}: ${point.total} finding(s)${point.partial ? ' (partial reading)' : ''}`}
                    className={`min-w-[6px] flex-1 rounded-t ${point.partial ? 'bg-amber-600/70' : 'bg-blue-600/70'}`}
                    style={{ height: `${Math.max(4, (point.total / peak) * 72)}px` }}
                  />
                );
              })}
            </div>
            <Muted>{trend.note} Readings Azure truncated are left out entirely, because a partial reading plotted next to a complete one looks like a sudden improvement.</Muted>
          </div>
        )}
      </Panel>

      <Panel title="Last saved reading per source" icon={ShieldCheck}>
        {!tenantId ? (
          <PanelEmpty>Pick a tenant to see its scan history.</PanelEmpty>
        ) : historyError ? (
          <PanelEmpty>{historyError}</PanelEmpty>
        ) : (
          <div className="space-y-2">
            <Muted>
              History, not current state. Azure keeps no posture history of its own,
              so a saved snapshot is the only record of what the estate looked like
              on a past date — and the only thing that makes the change tracking on
              each page possible.
            </Muted>
            <div className="divide-y divide-slate-800/60">
              {SNAPSHOT_SOURCES.map((source) => {
                const snapshot = latest[source.kind];
                const Icon = source.icon;
                return (
                  <Link
                    key={source.kind}
                    to={source.to}
                    className="group -mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition hover:bg-slate-800/50"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-blue-400" />
                    <span className="w-40 shrink-0 text-sm font-medium text-slate-200">{source.label}</span>
                    <span className="flex-1 font-mono text-xs text-slate-500">
                      {historyLoading && !snapshot
                        ? 'reading history…'
                        : snapshot
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

      <Panel title="What do these words mean?" icon={BookOpen}>
        <div className="space-y-2">
          <Muted>
            These pages say things plainly first and keep the Azure term alongside,
            so that anybody can read a finding and an administrator can still search
            the portal for the exact wording.
          </Muted>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
            {GLOSSARY.map(entry => (
              <div key={entry.term} className="border-b border-slate-800/60 pb-2">
                <dt className="font-mono text-[11px] uppercase tracking-wide text-slate-400">{entry.term}</dt>
                <dd className="mt-0.5 text-xs leading-relaxed text-slate-500">{entry.plain}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Panel>
    </SectionHub>
  );
}

/**
 * One count in the per-subscription table.
 *
 * Split out purely so that the dash case cannot drift: a source that could not
 * be read for this subscription must render as unknown in every column, and a
 * genuine zero must render as a zero.
 */
function Cell({ cell }) {
  if (!cell.known) {
    return (
      <td className="py-2 pr-3 text-right">
        <span className="font-mono text-slate-600" title="Not read for this subscription">—</span>
      </td>
    );
  }
  return (
    <td className="py-2 pr-3 text-right">
      <span className={`font-mono ${cell.count > 0 ? 'text-amber-300' : 'text-slate-500'}`}>
        {cell.count.toLocaleString()}
      </span>
    </td>
  );
}
