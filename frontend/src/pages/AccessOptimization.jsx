import { useMemo, useState } from 'react';
import { fetchAccessReview } from '../api/client';
import {
  PageHeader, NeedsSelection, ErrorCard, Coverage,
  Stat, Severity, Empty, Chips, Caveats,
} from '../components/Security/SecurityShell';
import { useSecurityQuery } from '../components/Security/securityData';
import RightSizing from '../components/Security/RightSizing';
import { ScopePath } from '../components/Common/Identity';
import { useAppStore } from '../store/useAppStore';

/**
 * Access optimisation — which grants look like they should not exist.
 *
 * RBAC only ever accumulates. People join projects and collect roles, leave and
 * keep them, get Owner for one afternoon of setup and hold it for three years.
 * Azure will happily list all of it and has no opinion about any of it.
 *
 * The opinion has to come from somewhere else: the Activity Log, which is the
 * only place that records who actually *used* what. That evidence has one hard
 * limit and this page states it everywhere — Azure keeps 90 days. Access
 * exercised less often than the window looks identical to access nobody has
 * touched in years, and telling somebody to revoke the former is how a
 * quarterly billing job dies at 2am.
 */

const KIND_LABEL = {
  unused: 'Unused',
  stale: 'Stale',
  'over-privileged': 'Over-privileged',
  'over-scoped': 'Over-scoped',
  sprawl: 'Sprawl',
  redundant: 'Redundant',
};

const KIND_EXPLAINER = {
  unused: 'No recorded activity at all in the window.',
  stale: 'Active once, but not recently.',
  'over-privileged': 'Holds the power to grant access and never uses it.',
  'over-scoped': 'Granted across a scope far wider than the work observed.',
  sprawl: 'The same role granted separately across many subscriptions.',
  redundant: 'Already covered by a broader assignment — removing it changes nothing.',
};

const WINDOWS = [7, 30, 90];

function Finding({ finding }) {
  return (
    <div className="border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Severity level={finding.severity} />
            <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
              {KIND_LABEL[finding.kind] || finding.kind}
            </span>
          </div>
          <p className="text-sm font-semibold text-white mt-1.5">{finding.headline}</p>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{finding.detail}</p>

          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
            <span>Role: <span className="text-slate-400">{finding.role_name}</span></span>
            {finding.scope && <span>On <ScopePath scope={finding.scope} className="text-[11px]" /></span>}
            {finding.scope_kind && <span>Scope: <span className="text-slate-400">{finding.scope_kind}</span></span>}
            {finding.evidence && <span>Evidence: <span className="text-slate-400">{finding.evidence}</span></span>}
            {finding.subscriptions && (
              <span>Across: <span className="text-slate-400">{finding.subscriptions.length} subscriptions</span></span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AccessOptimization() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const { data, error, loading, run, ready } = useSecurityQuery(fetchAccessReview);

  const [windowDays, setWindowDays] = useState(30);
  const [kind, setKind] = useState('all');

  const findings = useMemo(() => {
    const rows = data?.findings || [];
    return kind === 'all' ? rows : rows.filter(f => f.kind === kind);
  }, [data, kind]);

  const totals = data?.totals;
  const evidence = data?.evidence;

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Access Optimization"
        subtitle="Role assignments judged against evidence of use. Everything below is a candidate for review, not a verdict — each finding carries the evidence it rests on and the reason it might be wrong."
        onRun={() => run({ window_days: windowDays, stale_days: Math.max(Math.floor(windowDays / 2), 7) })}
        loading={loading}
        disabled={!ready}
      />

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
          Usage window
        </span>
        <div className="mt-2">
          <Chips
            value={windowDays}
            onChange={setWindowDays}
            options={WINDOWS.map(d => ({ key: d, label: `${d} days` }))}
          />
        </div>
        <p className="text-xs text-slate-500 mt-2 leading-relaxed">
          How far back the Activity Log is read. Azure retains 90 days and no
          more, so a longer view is not available from this API at any price.
          A wider window is slower but produces far fewer false &ldquo;unused&rdquo; findings.
        </p>
      </div>

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <ErrorCard message={error} />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Assignments read" value={totals.assignment_count} />
            <Stat label="Findings" value={totals.finding_count} />
            <Stat label="High severity" value={totals.high_count} tone="text-red-300" />
            <Stat
              label="Principals affected"
              value={totals.principals_with_findings}
              hint={`${evidence.active_principals} were active in the window`}
            />
          </div>

          <Coverage coverage={data.coverage} errors={data.errors} />

          <RightSizing sizing={data.right_sizing} />

          {!evidence.available && (
            <ErrorCard message={evidence.note} />
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <Chips
              value={kind}
              onChange={setKind}
              options={[
                { key: 'all', label: 'All findings', count: totals.finding_count },
                ...Object.keys(KIND_LABEL)
                  .filter(k => totals.by_kind[k])
                  .map(k => ({ key: k, label: KIND_LABEL[k], count: totals.by_kind[k] })),
              ]}
            />

            {kind !== 'all' && (
              <p className="text-xs text-slate-500">{KIND_EXPLAINER[kind]}</p>
            )}

            <div className="space-y-2">
              {findings.length === 0 ? (
                <Empty title="Nothing flagged in this category">
                  That is a statement about the assignments that were read
                  successfully. Check the coverage line above before reading it
                  as a clean result.
                </Empty>
              ) : (
                findings.map((f, i) => <Finding key={i} finding={f} />)
              )}
            </div>
          </div>

          {evidence.available && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <p className="text-xs text-slate-400 leading-relaxed">{evidence.note}</p>
            </div>
          )}

          <Caveats items={data.caveats} />
        </>
      )}
    </div>
  );
}
