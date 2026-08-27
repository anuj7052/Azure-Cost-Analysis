import { useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { fetchAccessReview } from '../api/client';
import {
  PageHeader, NeedsSelection, ErrorCard, Failure, Coverage,
  Stat, Severity, Empty, Chips, Caveats,
} from '../components/Security/SecurityShell';
import { useSecurityQuery } from '../components/Security/securityData';
import RightSizing from '../components/Security/RightSizing';
import DirectoryNotice from '../components/Security/DirectoryNotice';
import { ScopePath } from '../components/Common/Identity';
import DetailPanel from '../components/Common/DetailPanel';
import { plainAccessKind, plainSeverity } from '../utils/securityLanguage';
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

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const MISSING = 'Not available';

function value(v) {
  return v === null || v === undefined || v === '' ? MISSING : v;
}

/**
 * Where this access applies, in the fewest words that stay accurate.
 *
 * The backend already parsed the scope, so this only has to choose between the
 * fields it returned. A resource is named by itself, a resource group by its
 * name and subscription, and a subscription by its display name -- never by the
 * hundred-character path or the GUID underneath it.
 */
function whereLabel(finding) {
  if (finding?.scope_label) return finding.scope_label;
  if (finding?.subscription_name) return finding.subscription_name;
  return '';
}

function Field({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <div className="mt-0.5 text-xs text-slate-200 break-words">{children}</div>
    </div>
  );
}

function Finding({ finding, onOpen }) {
  const kind = plainAccessKind(finding.kind);
  const severity = plainSeverity(finding.severity);
  const where = whereLabel(finding);
  // A name we could not resolve is said plainly rather than replaced by the
  // object id. "Name unavailable" tells the reader Azure did not give us the
  // name; a GUID tells them nothing and looks like a name.
  const named = finding.resolved !== false;

  return (
    // A div, not a button. The card carries its own actions, and a button
    // inside a button is invalid markup that browsers resolve by dropping the
    // inner one -- which is how card actions silently stop working.
    <div className="w-full text-left border border-slate-800 bg-slate-800/30 rounded-xl p-3.5 transition hover:border-slate-700">
      <div className="flex items-center gap-2 flex-wrap">
        <Severity level={finding.severity} />
        <span className="text-xs font-semibold text-slate-300">{severity.plain}</span>
      </div>

      <p className="text-sm font-semibold text-white mt-2 leading-snug">
        {value(finding.headline)}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <Field label="User or service">
          <span className={named ? '' : 'text-slate-400 italic'}>
            {value(finding.principal_name)}
          </span>
          {finding.principal_upn && (
            <p className="text-[11px] text-slate-500 break-all">{finding.principal_upn}</p>
          )}
          <p className="text-[11px] text-slate-500">{value(finding.principal_type)}</p>
        </Field>

        <Field label="Access permission">
          {value(finding.role_name)}
          {finding.role_meaning && (
            <p className="text-[11px] text-slate-500 leading-relaxed">{finding.role_meaning}</p>
          )}
        </Field>

        <Field label="Where this access applies">
          {where || MISSING}
          {finding.subscription_name && where !== finding.subscription_name && (
            <p className="text-[11px] text-slate-500">{finding.subscription_name}</p>
          )}
          {finding.resource_type && (
            <p className="text-[11px] text-slate-500">{finding.resource_type}</p>
          )}
        </Field>
      </div>

      <div className="mt-3 border-t border-slate-800 pt-2.5 space-y-1.5">
        <p className="text-xs text-slate-400 leading-relaxed">
          <span className="text-slate-500">Evidence: </span>{value(finding.evidence)}
        </p>
        <p className="text-xs text-slate-400 leading-relaxed">
          <span className="text-slate-500">Why this matters: </span>{kind.why}
        </p>
        {kind.caution && (
          <p className="text-[11px] text-amber-300/70 leading-relaxed">{kind.caution}</p>
        )}
      </div>

      {/* No "Remove access" here. Revoking is a decision that needs the
          evidence in front of you, so the card sends you to look rather than
          offering a one-click way to take someone's access away by accident. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={onOpen}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800"
        >
          View details
        </button>
        {finding.principal_id && (
          <Link
            to={`/role-assignments?principal=${encodeURIComponent(finding.principal_id)}`}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
          >
            Review access
          </Link>
        )}
      </div>
    </div>
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

function FindingDetail({ finding, windowDays }) {
  const kind = plainAccessKind(finding?.kind);
  // Collapsed by default. An administrator who needs the ids can open this in
  // one click; a business owner reviewing access should never have to see them.
  const [technical, setTechnical] = useState(false);

  return (
    <>
      <Section title="Who">
        <p className="text-sm font-semibold text-white">{value(finding?.principal_name)}</p>
        <p className="text-xs text-slate-400">{value(finding?.principal_type)}</p>
        {finding?.principal_upn && (
          <p className="text-xs text-slate-400 break-all">{finding.principal_upn}</p>
        )}
        {finding?.resolved === false && (
          <p className="text-xs text-amber-300/70 leading-relaxed">
            Azure did not return a name for this account. Its identifier is in
            technical details below.
          </p>
        )}
      </Section>

      <Section title="Access">
        <p className="text-sm text-slate-200">{value(finding?.role_name)}</p>
        {finding?.role_meaning && (
          <p className="text-xs text-slate-400 leading-relaxed">{finding.role_meaning}</p>
        )}
      </Section>

      <Section title="Where it applies">
        <p className="text-sm text-slate-200">{whereLabel(finding) || MISSING}</p>
        {finding?.scope_sentence && (
          <p className="text-xs text-slate-400 leading-relaxed">{finding.scope_sentence}</p>
        )}
        {finding?.resource_group && (
          <p className="text-xs text-slate-500">Resource group: {finding.resource_group}</p>
        )}
        {finding?.subscription_name && (
          <p className="text-xs text-slate-500">Subscription: {finding.subscription_name}</p>
        )}
      </Section>

      <Section title="Activity">
        <p className="text-sm text-slate-300 leading-relaxed">{value(finding?.evidence)}</p>
        <p className="text-xs text-slate-500">
          Activity window: {finding?.window_days ?? windowDays} days
        </p>
      </Section>

      <Section title="Why this was flagged">
        <p className="text-sm text-slate-300 leading-relaxed">{value(finding?.detail)}</p>
        <p className="text-xs text-slate-400 leading-relaxed">{kind.why}</p>
      </Section>

      <Section title="Recommendation">
        <p className="text-sm text-slate-300 leading-relaxed">{kind.action}</p>
        {kind.caution && (
          <p className="text-xs text-amber-300/70 leading-relaxed">{kind.caution}</p>
        )}
      </Section>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <button
          onClick={() => setTechnical(t => !t)}
          aria-expanded={technical}
          className="flex w-full items-center justify-between text-[10px] uppercase tracking-wide text-slate-500 font-semibold"
        >
          Technical details
          <span className="text-slate-600">{technical ? 'Hide' : 'Show'}</span>
        </button>
        {technical && (
          <dl className="mt-2 space-y-1.5">
            {[
              // Azure's own vocabulary, kept verbatim, because this panel is
              // for the administrator who has to match these values against the
              // portal or a script. Everywhere above it, plain words are used.
              ['Account ID (principal id)', finding?.principal_id],
              ['Role definition ID', finding?.role_definition_id],
              ['Assignment ID', finding?.assignment_id],
              ['Scope path', finding?.scope],
              ['Subscription ID', finding?.subscription_id],
              ['Activity window (days)', finding?.window_days ?? windowDays],
            ].map(([label, val]) => (
              <div key={label} className="flex flex-wrap gap-x-2">
                <dt className="text-[11px] text-slate-500">{label}</dt>
                <dd className="font-mono text-[11px] text-slate-400 break-all">{value(val)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  );
}

export default function AccessOptimization() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const [searchParams] = useSearchParams();

  const [windowDays, setWindowDays] = useState(30);
  // The window is part of the request, so it has to be part of the cache key:
  // switching from 30 days to 90 asks Azure a different question and must not
  // be answered from the 30-day entry.
  const {
    data, error, failure, loading, lastUpdated, cached, loaded, run, ready,
  } = useSecurityQuery(fetchAccessReview, {
    source: 'access-review',
    params: { window_days: windowDays, stale_days: Math.max(Math.floor(windowDays / 2), 7) },
  });

  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [principalKind, setPrincipalKind] = useState('all');
  const [subscription, setSubscription] = useState('all');
  // Honoured on first render: the overview links straight to the high-severity
  // view, and an unfiltered landing would hide the very findings it promised.
  const [severity, setSeverity] = useState(() => {
    const wanted = String(searchParams.get('severity') || '').toLowerCase();
    return SEVERITIES.includes(wanted) ? wanted : 'all';
  });

  const allFindings = useMemo(
    () => (Array.isArray(data?.findings) ? data.findings : []),
    [data],
  );

  // The subscription filter lists names, not GUIDs. Built from the findings
  // themselves so it can only ever offer subscriptions the user actually
  // selected -- it cannot widen the scope by accident.
  const subscriptionOptions = useMemo(() => {
    const seen = new Map();
    for (const f of allFindings) {
      if (!f.subscription_id) continue;
      if (!seen.has(f.subscription_id)) {
        seen.set(f.subscription_id, f.subscription_name || 'Unnamed subscription');
      }
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allFindings]);

  const findings = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allFindings.filter(f => {
      if (kind !== 'all' && f.kind !== kind) return false;
      if (severity !== 'all' && String(f.severity || '').toLowerCase() !== severity) return false;
      if (subscription !== 'all' && f.subscription_id !== subscription) return false;
      if (principalKind !== 'all') {
        if (String(f.principal_type || '').toLowerCase() !== principalKind) return false;
      }
      if (!needle) return true;
      // Searchable by what is displayed *and* by the identifiers underneath,
      // so an administrator holding a GUID from an Azure alert can still find
      // the finding even though the page never shows that GUID to anyone else.
      return [
        f.principal_name, f.principal_upn, f.principal_type,
        f.role_name, f.scope_label, f.subscription_name,
        f.resource_name, f.resource_group, f.headline,
        f.principal_id, f.subscription_id, f.scope,
      ].some(v => String(v || '').toLowerCase().includes(needle));
    });
  }, [allFindings, kind, severity, subscription, principalKind, query]);

  // Everything below reads through these containers, so a partial body must
  // narrow the page rather than remove it -- an access review that fails to
  // render is indistinguishable from one that found nothing.
  const totals = data?.totals || {};
  const evidence = data?.evidence || {};
  const byKind = totals.by_kind || {};
  const rightSizing = data?.right_sizing;

  // Counted from the findings themselves: the backend summary has no severity
  // breakdown, and inventing one would put a number next to a chip that filters
  // on something else.
  const severityCounts = useMemo(() => {
    return allFindings.reduce((acc, f) => {
      const key = String(f?.severity || '').toLowerCase();
      if (key) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }, [allFindings]);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Access Optimization"
        subtitle="Access that may no longer be needed. Each finding is a candidate for review, not a verdict — it carries the evidence it rests on and the reason it might be wrong."
        onRun={() => run({ force: true })}
        loading={loading}
        disabled={!ready}
        lastUpdated={lastUpdated}
        cached={cached}
        loaded={loaded}
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

      {data && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search access findings"
            placeholder="Search by person, application, role, subscription or resource"
            className="w-full rounded-xl border border-slate-800 bg-slate-800/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-600"
          />
          <div className="flex flex-wrap gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                User or service
              </p>
              <select
                value={principalKind}
                onChange={e => setPrincipalKind(e.target.value)}
                aria-label="Filter by account type"
                className="mt-1 rounded-lg border border-slate-800 bg-slate-800/40 px-2 py-1 text-xs text-slate-200 outline-none"
              >
                <option value="all">All accounts</option>
                <option value="user">People</option>
                <option value="group">Groups</option>
                <option value="service principal">Applications</option>
                <option value="managed identity">Managed identities</option>
              </select>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                Subscription
              </p>
              <select
                value={subscription}
                onChange={e => setSubscription(e.target.value)}
                aria-label="Filter by subscription"
                className="mt-1 max-w-[16rem] rounded-lg border border-slate-800 bg-slate-800/40 px-2 py-1 text-xs text-slate-200 outline-none"
              >
                <option value="all">All subscriptions</option>
                {subscriptionOptions.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>
          {(query || principalKind !== 'all' || subscription !== 'all') && (
            <p className="text-xs text-slate-500">
              Showing {findings.length} of {allFindings.length} finding(s).
            </p>
          )}
        </div>
      )}

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <Failure kind={failure} message={error} onRetry={() => run({ force: true })} stale={Boolean(data)} />}

      {data && (
        <DirectoryNotice
          directory={data.directory}
          onResolved={() => run({ force: true })}
        />
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Assignments read" value={totals.assignment_count} />
            <Stat label="Findings" value={totals.finding_count} />
            <Stat label="High severity" value={totals.high_count} tone="text-red-300" />
            <Stat
              label="Principals affected"
              value={totals.principals_with_findings}
              hint={
                typeof evidence.active_principals === 'number'
                  ? `${evidence.active_principals} were active in the window`
                  : undefined
              }
            />
          </div>

          <Coverage coverage={data.coverage} errors={data.errors} />

          <RightSizing sizing={rightSizing} />

          {evidence.available === false && evidence.note && (
            <ErrorCard message={evidence.note} />
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <Chips
              value={kind}
              onChange={setKind}
              options={[
                { key: 'all', label: 'All findings', count: totals.finding_count },
                ...Object.keys(KIND_LABEL)
                  .filter(k => byKind[k])
                  .map(k => ({ key: k, label: KIND_LABEL[k], count: byKind[k] })),
              ]}
            />

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
                findings.map((f, i) => (
                  <Finding key={i} finding={f} onOpen={() => setSelected(f)} />
                ))
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

      <DetailPanel
        open={Boolean(selected)}
        title={plainAccessKind(selected?.kind).title}
        subtitle={selected?.headline || undefined}
        onClose={() => setSelected(null)}
      >
        {selected && <FindingDetail finding={selected} windowDays={windowDays} />}
      </DetailPanel>
    </div>
  );
}
