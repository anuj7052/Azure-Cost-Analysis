import { useMemo, useState } from 'react';
import { CalendarClock, FileCheck2, Scale } from 'lucide-react';
import { fetchPolicy } from '../api/client';
import {
  PageHeader, NeedsSelection, ErrorCard, Coverage,
  ChangeStrip, Stat, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery, when } from '../components/Security/securityData';
import { useAppStore } from '../store/useAppStore';

/**
 * Policy governance — change tracking, applied to Azure Policy.
 *
 * Azure Policy tells you today's compliance state and nothing else. It will not
 * tell you that an assignment was quietly deleted last Tuesday, that a resource
 * fell out of compliance the night an exemption lapsed, or how long it took
 * anyone to notice. Those are the questions an auditor asks, and none of them
 * has an endpoint.
 *
 * So compliance states, assignments and exemptions are captured together in one
 * snapshot and compared as a set. An assignment silently removed is exactly the
 * kind of change this page exists to catch, and it would be invisible if only
 * the compliance numbers were compared.
 */

const TABS = [
  { key: 'non_compliant', label: 'Non-compliant' },
  { key: 'exemptions', label: 'Exemptions' },
  { key: 'assignments', label: 'Assignments' },
];

function ExemptionRow({ item }) {
  const days = item.days_remaining;
  const expired = days !== null && days < 0;
  const soon = days !== null && days >= 0 && days <= 30;

  return (
    <div
      className={`border rounded-xl p-3 transition ${
        expired
          ? 'border-red-500/30 bg-red-950/20'
          : soon
            ? 'border-amber-500/30 bg-amber-950/20'
            : 'border-slate-800 bg-slate-800/30 hover:bg-slate-800/60'
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarClock size={14} className={expired ? 'text-red-400' : soon ? 'text-amber-400' : 'text-slate-500'} />
        <p className="text-sm font-semibold text-white">{item.name}</p>
        <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
          {item.category}
        </span>
      </div>

      <p className="text-xs mt-1.5 leading-relaxed">
        {days === null ? (
          <span className="text-slate-400">No expiry set — this exemption does not lapse on its own.</span>
        ) : expired ? (
          <span className="text-red-300">
            Expired {Math.abs(days)} day(s) ago. Anything it covered became
            non-compliant at that moment, whether or not anyone was told.
          </span>
        ) : (
          <span className={soon ? 'text-amber-300' : 'text-slate-400'}>
            {days} day(s) remaining — expires {when(item.expires_on)}.
          </span>
        )}
      </p>
    </div>
  );
}

function AssignmentRow({ item }) {
  return (
    <div className="border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-sm font-semibold text-white">{item.name}</p>
        {!item.enforced && (
          <span className="text-[10px] text-amber-300 border border-amber-500/30 bg-amber-950/40 rounded px-1.5 py-0.5">
            not enforced
          </span>
        )}
      </div>
      {item.description && (
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">{item.description}</p>
      )}
      <p className="text-[11px] text-slate-500 mt-2 font-mono truncate" title={item.scope}>
        {item.scope}
      </p>
      {item.not_scopes?.length > 0 && (
        <p className="text-[11px] text-slate-500 mt-1">
          {item.not_scopes.length} scope(s) excluded from this assignment.
        </p>
      )}
    </div>
  );
}

function StateRow({ item }) {
  return (
    <div className="border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-red-300 border border-red-500/30 bg-red-950/40 rounded px-1.5 py-0.5 uppercase tracking-wide font-semibold">
          {item.compliance_state}
        </span>
        {item.change === 'new' && (
          <span className="text-[10px] text-red-300 border border-red-500/30 rounded px-1.5 py-0.5">new</span>
        )}
      </div>
      <p className="text-sm font-semibold text-white mt-1.5">{item.title}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
        <span>Resource: <span className="text-slate-400">{item.resource_name}</span></span>
        <span>Type: <span className="text-slate-400">{item.resource_type}</span></span>
        {item.assignment_name && <span>Assignment: <span className="text-slate-400">{item.assignment_name}</span></span>}
      </div>
    </div>
  );
}

export default function PolicyGovernance() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const { data, error, loading, run, ready } = useSecurityQuery(fetchPolicy);

  const [tab, setTab] = useState('non_compliant');

  const rows = useMemo(() => (data ? data[tab] || [] : []), [data, tab]);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Policy Governance"
        subtitle="Compliance, assignments and exemptions captured together on every scan, so an assignment quietly deleted or an exemption quietly lapsing does not go unseen."
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
              label="Compliance rate"
              value={data.compliance_rate === null ? '—' : `${data.compliance_rate}%`}
              tone="text-blue-300"
              hint={`${data.compliant_count} of ${data.evaluated_count} evaluations`}
            />
            <Stat label="Non-compliant" value={data.non_compliant.length} tone="text-red-300" />
            <Stat label="Assignments" value={data.assignments.length} />
            <Stat
              label="Not enforced"
              value={data.unenforced_count}
              tone={data.unenforced_count ? 'text-amber-300' : 'text-white'}
              hint="Reports compliance, blocks nothing"
            />
            <Stat
              label="Exemptions expiring"
              value={data.expiring_exemptions.length}
              tone={data.expiring_exemptions.length ? 'text-amber-300' : 'text-white'}
              hint="Within 30 days, including already lapsed"
            />
          </div>

          <Coverage coverage={data.coverage} errors={data.errors} />
          <ChangeStrip change={data.change} />

          {data.expiring_exemptions.length > 0 && (
            <div className="bg-slate-900 border border-amber-500/25 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CalendarClock size={16} className="text-amber-400" />
                <h2 className="text-sm font-semibold text-white">Exemptions needing attention</h2>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Exemptions lapse silently. The resource becomes non-compliant that
                night and nothing connects the two events — which is why anything
                already expired is listed here rather than filed as history.
              </p>
              <div className="space-y-2">
                {data.expiring_exemptions.map((e, i) => <ExemptionRow key={e.key || i} item={e} />)}
              </div>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Scale size={16} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Full hierarchy</h2>
            </div>

            <Chips
              value={tab}
              onChange={setTab}
              options={TABS.map(t => ({ ...t, count: data[t.key]?.length }))}
            />

            {tab === 'assignments' && data.unenforced_count > 0 && (
              <p className="text-xs text-amber-300/80 leading-relaxed">{data.enforcement_note}</p>
            )}

            <div className="space-y-2">
              {rows.length === 0 ? (
                <Empty title="Nothing to show here">
                  {tab === 'non_compliant'
                    ? 'No non-compliant evaluations were returned. That is only good news if the coverage line above says every subscription was read.'
                    : 'Nothing of this kind was found on the subscriptions that could be read.'}
                </Empty>
              ) : (
                rows.map((item, i) => {
                  if (tab === 'exemptions') return <ExemptionRow key={item.key || i} item={item} />;
                  if (tab === 'assignments') return <AssignmentRow key={item.key || i} item={item} />;
                  return <StateRow key={item.key || i} item={item} />;
                })
              )}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-start gap-2.5">
              <FileCheck2 size={16} className="text-slate-500 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400 leading-relaxed">
                Assignments read here are those visible at subscription scope.
                Policies inherited from a management group apply to these
                resources but are defined above this level, and reading them
                needs permission at the management group itself — so an
                assignment enforcing a rule you can see the effect of may not
                appear in this list.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
