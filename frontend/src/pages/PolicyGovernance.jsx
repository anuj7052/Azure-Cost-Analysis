import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock, FileCheck2, Scale } from 'lucide-react';
import { fetchPolicy } from '../api/client';
import {
  PageHeader, NeedsSelection, Failure, Coverage,
  ChangeStrip, Stat, Severity, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery, when } from '../components/Security/securityData';
import DetailPanel from '../components/Common/DetailPanel';
import { plainSeverity } from '../utils/securityLanguage';
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
  { key: 'non_compliant', label: 'Breaking the rules' },
  { key: 'exemptions', label: 'Exemptions' },
  { key: 'assignments', label: 'Rules in force' },
];

const TAB_KEYS = TABS.map(t => t.key);

const MISSING = 'Not available';

function value(v) {
  return v === null || v === undefined || v === '' ? MISSING : v;
}

/** Compliance said as an outcome, with Azure's own state kept beside it. */
function complianceSentence(state) {
  switch (String(state || '').toLowerCase()) {
    case 'noncompliant':
    case 'non-compliant':
      return 'This resource breaks the rule.';
    case 'compliant':
      return 'This resource follows the rule.';
    case 'exempt':
      return 'This resource has been excused from the rule.';
    case 'conflict':
      return 'Two rules disagree about this resource, so Azure could not decide.';
    default:
      return 'Azure did not say whether this resource follows the rule.';
  }
}

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

const GUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many rows are drawn before the reader asks for the rest. */
const ROW_CAP = 100;

function StateRow({ item, onOpen }) {
  // Azure returns only the policy definition id for most compliance states,
  // never its display name, so `title` is frequently a bare GUID. Leading a row
  // with a GUID tells the reader nothing, while the resource name tells them
  // exactly which of their machines is affected. The id is kept, demoted to the
  // technical strip and labelled for what it is.
  const titleIsId = !item.title || GUID_ONLY.test(String(item.title).trim());
  const heading = titleIsId ? value(item.resource_name) : value(item.title);

  return (
    <button
      onClick={onOpen}
      className="w-full text-left border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition"
    >
      <div className="flex items-center gap-2 flex-wrap">
        {item.severity && <Severity level={item.severity} />}
        <span className="text-xs font-semibold text-slate-300">
          {item.severity ? plainSeverity(item.severity).plain : complianceSentence(item.compliance_state)}
        </span>
        <span className="font-mono text-[11px] text-slate-500">{value(item.compliance_state)}</span>
        {item.change === 'new' && (
          <span className="text-[10px] text-red-300 border border-red-500/30 rounded px-1.5 py-0.5">new</span>
        )}
      </div>
      <p className="text-sm font-semibold text-white mt-1.5">{heading}</p>
      {titleIsId && (
        <p className="text-xs text-slate-400 mt-0.5">
          {item.assignment_name
            ? `Breaks the rule "${item.assignment_name}"`
            : 'Breaks one of your organisation\u2019s rules'}
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
        {!titleIsId && (
          <span>Resource: <span className="text-slate-400">{value(item.resource_name)}</span></span>
        )}
        <span>Type: <span className="font-mono text-slate-400">{value(item.resource_type)}</span></span>
        {!titleIsId && item.assignment_name && (
          <span>Rule: <span className="text-slate-400">{item.assignment_name}</span></span>
        )}
        {titleIsId && item.title && (
          <span>Rule id: <span className="font-mono text-slate-400">{item.title}</span></span>
        )}
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

function StateDetail({ item }) {
  return (
    <>
      <Section title="Resource">
        <p className="text-sm text-slate-300 break-all">{value(item?.resource_name)}</p>
        <p className="font-mono text-[11px] text-slate-500">{value(item?.resource_type)}</p>
      </Section>

      <Section title="Rule it was measured against">
        <p className="text-sm text-slate-300">{value(item?.assignment_name || item?.policy_name || item?.title)}</p>
      </Section>

      <Section title="Where it stands">
        <p className="text-sm text-slate-300 leading-relaxed">{complianceSentence(item?.compliance_state)}</p>
        <p className="font-mono text-[11px] text-slate-500">Azure state: {value(item?.compliance_state)}</p>
      </Section>

      <Section title="Recommended action">
        <p className="text-sm text-slate-300 leading-relaxed">
          {item?.solution
            || 'Change this resource so it meets the rule, or record an exemption saying why it cannot.'}
        </p>
      </Section>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Technical details</p>
        <dl className="mt-2 space-y-1.5">
          {[
            ['Resource id', item?.resource_id],
            ['Policy assignment id', item?.assignment_id || item?.policy_assignment_id],
            ['Policy assignment name', item?.assignment_name],
            ['Compliance state', item?.compliance_state],
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

export default function PolicyGovernance() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const { data, error, failure, loading, lastUpdated, cached, loaded, run, ready } = useSecurityQuery(fetchPolicy, { source: 'policy' });
  const [searchParams] = useSearchParams();

  const [selected, setSelected] = useState(null);
  // ?tab=exemptions is a deep link from the overview; deriving the initial tab
  // avoids the state-setting effect the lint rules forbid.
  const [tab, setTab] = useState(() => {
    const wanted = searchParams.get('tab');
    return TAB_KEYS.includes(wanted) ? wanted : 'non_compliant';
  });
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const value = data?.[tab];
    return Array.isArray(value) ? value : [];
  }, [data, tab]);

  // Each list is read straight into a .length or a .map, so a body missing one
  // of them would take the whole page down and leave the reader with no
  // compliance picture at all.
  const nonCompliant = Array.isArray(data?.non_compliant) ? data.non_compliant : [];
  const expiringExemptions = Array.isArray(data?.expiring_exemptions) ? data.expiring_exemptions : [];
  const assignments = Array.isArray(data?.assignments) ? data.assignments : [];
  const exemptions = Array.isArray(data?.exemptions) ? data.exemptions : [];
  const summary = data?.summary || {};
  // The counts have lived at the top level and inside summary at different
  // points; a zero is a real reading here, so only an absent value falls back.
  const compliantCount = data?.compliant_count ?? summary.compliant_count ?? 0;
  const evaluatedCount = data?.evaluated_count ?? summary.evaluated_count ?? 0;
  const unenforcedCount = data?.unenforced_count ?? summary.unenforced_count ?? 0;
  const tabCounts = { non_compliant: nonCompliant.length, exemptions: exemptions.length, assignments: assignments.length };

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Policy Governance"
        subtitle="Which resources follow your organisation's rules. Compliance, rules and exemptions are captured together on every scan, so a rule quietly deleted or an exemption quietly lapsing does not go unseen."
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
          {data.truncated && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-4">
              <p className="text-xs leading-relaxed text-amber-200">
                {data.truncation_note} The compliance percentage below is
                therefore calculated over part of the estate only, and a rate
                drawn from a partial reading cannot be reported as the estate&rsquo;s.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat
              label="Compliance rate"
              value={data.compliance_rate === null ? '—' : `${data.compliance_rate}%`}
              tone="text-blue-300"
              hint={`${compliantCount} of ${evaluatedCount} evaluations`}
            />
            <Stat label="Non-compliant" value={nonCompliant.length} tone="text-red-300" />
            <Stat label="Assignments" value={assignments.length} />
            <Stat
              label="Not enforced"
              value={unenforcedCount}
              tone={unenforcedCount ? 'text-amber-300' : 'text-white'}
              hint="Reports compliance, blocks nothing"
            />
            <Stat
              label="Exemptions expiring"
              value={expiringExemptions.length}
              tone={expiringExemptions.length ? 'text-amber-300' : 'text-white'}
              hint="Within 30 days, including already lapsed"
            />
          </div>

          <Coverage coverage={data.coverage} errors={data.errors} />
          <ChangeStrip change={data.change} />

          {expiringExemptions.length > 0 && (
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
                {expiringExemptions.map((e, i) => <ExemptionRow key={e.key || i} item={e} />)}
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
              onChange={next => {
                setTab(next);
                // A cap lifted on one tab should not silently apply to the
                // next, which may be a far longer list.
                setShowAll(false);
              }}
              options={TABS.map(t => ({ ...t, count: tabCounts[t.key] }))}
            />

            {tab === 'assignments' && unenforcedCount > 0 && (
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
                /* Capped on first paint. Five hundred-odd rows is a real result
                   for this tenant, and rendering them all made the tab switch
                   visibly stutter. The count above is never capped, so the cap
                   changes what is drawn, not what is reported. */
                rows.slice(0, showAll ? rows.length : ROW_CAP).map((item, i) => {
                  if (tab === 'exemptions') return <ExemptionRow key={item.key || i} item={item} />;
                  if (tab === 'assignments') return <AssignmentRow key={item.key || i} item={item} />;
                  return <StateRow key={item.key || i} item={item} onOpen={() => setSelected(item)} />;
                })
              )}
              {!showAll && rows.length > ROW_CAP && (
                <button
                  onClick={() => setShowAll(true)}
                  className="w-full text-xs text-slate-300 border border-slate-800 hover:bg-slate-800/60 rounded-xl py-2.5 transition"
                >
                  Showing {ROW_CAP} of {rows.length} — show all
                </button>
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

      <DetailPanel
        open={Boolean(selected)}
        title={selected?.resource_name || 'Resource'}
        subtitle={selected ? complianceSentence(selected.compliance_state) : undefined}
        onClose={() => setSelected(null)}
      >
        {selected && <StateDetail item={selected} />}
      </DetailPanel>
    </div>
  );
}
