import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Users, Bot, UsersRound, Layers, MapPin, Boxes, FolderOpen, Clock,
  ShieldAlert, Copy, TrendingDown, EyeOff, Eye, ExternalLink, X, Loader2,
  UserMinus, ArrowDownWideNarrow, Info,
} from 'lucide-react';
import {
  fetchAccessReview, acceptAccessFinding, restoreAccessFinding,
  fetchAssignableRoles, previewRevokeAccess, revokeAccess,
  previewDowngradeAccess, downgradeAccess,
} from '../api/client';
import {
  PageHeader, NeedsSelection, ErrorCard, Failure, Coverage, Empty, Caveats,
} from '../components/Security/SecurityShell';
import AccessChangeDialog from '../components/Security/AccessChangeDialog';
import { useSecurityQuery } from '../components/Security/securityData';
import RightSizing from '../components/Security/RightSizing';
import DirectoryNotice from '../components/Security/DirectoryNotice';
import { useAppStore } from '../store/useAppStore';
import {
  OPTIMIZATION_KINDS, KIND_LABEL, PRINCIPAL_TYPES, ROLE_TYPES, SORTS,
  shown, asDate, idleLabel, operationChips, scopeLabel, scopeChip,
  filterFindings, principalRows, findingsFor, subscriptionOptions,
  managementGroupOptions, actionability, roleIdFor,
} from '../utils/accessOptimization';

/**
 * Access optimisation — which grants look like they should not exist.
 *
 * RBAC only ever accumulates. People join projects and collect roles, leave and
 * keep them, get Owner for one afternoon of setup and hold it for three years.
 * Azure will list all of it and has no opinion about any of it.
 *
 * The opinion comes from the Activity Log, the only place that records who
 * actually *used* what — and that has one hard limit this page repeats
 * everywhere: Azure keeps 90 days. Access exercised less often than the window
 * looks identical to access nobody has touched in years, and telling somebody
 * to revoke the former is how a quarterly billing job dies at 2am.
 *
 * The layout is a two-column review rather than a feed. A feed sorted by
 * severity scatters one person's eleven findings across four screens, and the
 * decision being made here is about a person, not about a finding — "does Amber
 * still need this" is answered once, with everything she holds in view.
 */

const KIND_ICON = {
  unused: Clock,
  stale: TrendingDown,
  'over-privileged': ShieldAlert,
  'over-scoped': Layers,
  sprawl: Boxes,
  redundant: Copy,
};

const KIND_TONE = {
  unused: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  stale: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  'over-privileged': 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  'over-scoped': 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  sprawl: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  redundant: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300',
};

const ROLE_TONE = {
  critical: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
  management: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
  read: 'border-slate-600 bg-slate-700/40 text-slate-300',
};

const SEVERITY_DOT = {
  critical: 'bg-rose-500',
  high: 'bg-rose-400',
  medium: 'bg-amber-400',
  low: 'bg-sky-400',
};

const PRINCIPAL_ICON = {
  User: Users,
  Group: UsersRound,
  'Service principal': Bot,
  'Managed identity': Bot,
};

const SCOPE_ICON = {
  'Management Group': Layers,
  'Tenant Root': Layers,
  Subscription: MapPin,
  'Resource Group': FolderOpen,
  Resource: Boxes,
};

const WINDOWS = [7, 30, 90];

const CARD_SORTS = [
  { key: 'kind', label: 'Optimization type' },
  { key: 'severity', label: 'Severity' },
  { key: 'role', label: 'Role' },
];

function Chip({ tone, icon: Icon, children }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {Icon && <Icon size={11} />}
      {children}
    </span>
  );
}

/**
 * One labelled line of a card.
 *
 * Rendered as a two-column grid rather than a definition list because every
 * value here is short and the labels have to line up down the card — the eye
 * scans the values, not the labels, and ragged labels defeat that.
 */
function Line({ label, children, tone = 'text-slate-200' }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-[3px]">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className={`text-[11px] leading-relaxed break-words ${tone}`}>{children}</span>
    </div>
  );
}

function Select({ label, value, onChange, children }) {
  return (
    <label className="block min-w-[9rem]">
      <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-800/50 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-600"
      >
        {children}
      </select>
    </label>
  );
}

/** Severity counts beside a name, as coloured pills. */
function SeverityPills({ severities }) {
  const order = ['critical', 'high', 'medium', 'low'];
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {order.filter(s => severities[s]).map(s => (
        <span
          key={s}
          title={`${severities[s]} ${s} severity finding(s)`}
          className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold text-slate-950 ${SEVERITY_DOT[s]}`}
        >
          {severities[s]}
        </span>
      ))}
    </div>
  );
}

function PrincipalRow({ row, active, onSelect }) {
  const Icon = PRINCIPAL_ICON[row.principal_type] || Users;
  return (
    <button
      onClick={onSelect}
      className={`w-full border-b border-slate-800/70 px-3 py-2.5 text-left transition ${
        active ? 'bg-sky-500/10 border-l-2 border-l-sky-400' : 'border-l-2 border-l-transparent hover:bg-slate-800/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={13} className="shrink-0 text-emerald-400" />
        <span className={`truncate text-xs ${row.resolved ? 'text-slate-200' : 'text-slate-400 italic'}`}>
          {row.principal_name || 'Name unavailable'}
        </span>
        {row.hidden > 0 && (
          <EyeOff size={11} className="ml-auto shrink-0 text-slate-600" title={`${row.hidden} accepted`} />
        )}
      </div>
      <SeverityPills severities={row.severities} />
    </button>
  );
}

/**
 * The measured half of a card.
 *
 * Every row here is omitted when the value is unknown rather than printed as a
 * zero. "0 operations" is a finding; "we never read the log" is a different
 * one, and a card that renders them the same way is the reason somebody revokes
 * access that was never measured.
 */
function Usage({ usage }) {
  if (!usage) return null;
  const chips = operationChips(usage.operations);
  const idle = idleLabel(usage.days_inactive);

  return (
    <>
      {usage.last_used && <Line label="Last used">{asDate(usage.last_used)}</Line>}
      {idle && <Line label="Days inactive" tone="text-slate-300">{idle}</Line>}
      {usage.rbac_inactive === true && (
        <Line label="RBAC inactive" tone="text-slate-300">
          Never used — held the power to grant access and did not use it
        </Line>
      )}
      {typeof usage.activity_count === 'number' && (
        <Line label="Activity count">{usage.activity_count.toLocaleString()} operations</Line>
      )}
      {chips.length > 0 && (
        <Line label="Operations">
          <span className="flex flex-wrap gap-1">
            {chips.map(c => (
              <span
                key={c.key}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  c.count > 0 ? 'bg-slate-700/70 text-slate-200' : 'bg-slate-800/60 text-slate-500'
                }`}
              >
                {c.label}
                <span className="rounded bg-slate-900/70 px-1">{c.count}</span>
              </span>
            ))}
          </span>
        </Line>
      )}
    </>
  );
}

function FindingCard({ finding, tenantId, onHide, onRestore, busy, onRevoke, onDowngrade, resolving }) {
  const Icon = KIND_ICON[finding.kind] || ShieldAlert;
  const chip = scopeChip(finding);
  const ScopeIcon = SCOPE_ICON[chip] || MapPin;
  const where = scopeLabel(finding);
  const privilege = String(finding.privilege || 'read').toLowerCase();
  const recommendation = finding.recommendation;
  const act = actionability(finding);
  const downgradeTo = recommendation?.action === 'downgrade'
    ? recommendation.recommended_role
    : '';

  return (
    <div className={`rounded-xl border p-3.5 transition ${
      finding.hidden
        ? 'border-slate-800 bg-slate-900/40 opacity-60'
        : 'border-slate-800 bg-slate-800/30 hover:border-slate-700'
    }`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon size={13} className="text-slate-400" />
        <Chip tone={KIND_TONE[finding.kind] || KIND_TONE.redundant}>
          {KIND_LABEL[finding.kind] || finding.kind}
        </Chip>
        <Chip tone="border-slate-700 bg-slate-800/60 text-slate-300" icon={ScopeIcon}>{chip}</Chip>
        <Chip tone={ROLE_TONE[privilege] || ROLE_TONE.read}>{shown(finding.role_name)}</Chip>
        {finding.is_custom && (
          <Chip tone="border-slate-700 bg-slate-800/60 text-slate-400">Custom role</Chip>
        )}

        <button
          onClick={finding.hidden ? onRestore : onHide}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" />
            : finding.hidden ? <Eye size={11} /> : <EyeOff size={11} />}
          {finding.hidden ? 'Unhide' : 'Hide'}
        </button>
      </div>

      <p className="mt-2.5 text-xs font-semibold leading-snug text-white">
        {shown(finding.headline)}
      </p>

      <div className="mt-2 border-t border-slate-800 pt-2">
        {finding.assigned_at && <Line label="Assigned">{asDate(finding.assigned_at)}</Line>}
        <Usage usage={finding.usage} />
        {where && (
          <Line label="Where">
            {where}
            {finding.subscription_name && where !== finding.subscription_name && (
              <span className="text-slate-500"> · {finding.subscription_name}</span>
            )}
          </Line>
        )}
        {finding.covered_by && (
          <Line label="Redundancy" tone="text-amber-300/90">
            Already granted at a broader scope — removing this changes nobody&rsquo;s access
          </Line>
        )}
        <Line label="Details" tone="text-slate-300">{shown(finding.detail)}</Line>
        <Line label="Evidence" tone="text-amber-300/90">{shown(finding.evidence)}</Line>
        {recommendation?.reason && (
          <Line label="Explanation" tone="text-amber-300/90">{recommendation.reason}</Line>
        )}
        {recommendation && (
          <Line label="Recommendation" tone="text-slate-200">
            {recommendation.action === 'downgrade' && recommendation.recommended_role
              ? `Downgrade to ${recommendation.recommended_role}`
              : recommendation.action === 'keep' ? 'Keep — the role matches the work observed'
                : recommendation.action === 'remove' ? 'Remove this role assignment'
                  : 'Review with the owner before changing anything'}
            <span className="ml-1 text-slate-500">
              (confidence: {recommendation.confidence})
            </span>
          </Line>
        )}
        {finding.hidden && (
          <Line label="Accepted" tone="text-slate-400">
            {finding.hidden_note || 'No reason was recorded.'}
          </Line>
        )}
      </div>

      {/* Changing access is offered here, but never as the first thing the eye
          lands on and never without a preview. The dialog behind both of these
          re-runs every check server-side and, for a dangerous role, asks the
          person to type the account name — the evidence above is what the
          decision is supposed to rest on. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          to={`/activity?tenant=${encodeURIComponent(tenantId || '')}&caller=${encodeURIComponent(finding.principal_upn || finding.principal_id || '')}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800"
        >
          <ExternalLink size={11} /> View in Activity Explorer
        </Link>
        <Link
          to={`/access-identity?view=assignments&principal=${encodeURIComponent(finding.principal_id || '')}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800"
        >
          <ExternalLink size={11} /> View in Role Assignments
        </Link>

        {act.can && downgradeTo && (
          <button
            onClick={onDowngrade}
            disabled={resolving}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
          >
            {resolving ? <Loader2 size={11} className="animate-spin" /> : <ArrowDownWideNarrow size={11} />}
            Downgrade to {downgradeTo}
          </button>
        )}

        {act.can && (
          <button
            onClick={onRevoke}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/50 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-medium text-rose-200 transition hover:bg-rose-500/20"
          >
            <UserMinus size={11} /> Revoke access
          </button>
        )}
      </div>

      {(act.reason || act.warning) && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
          <Info size={11} className="mt-0.5 shrink-0" />
          {act.reason || act.warning}
        </p>
      )}
    </div>
  );
}

export default function AccessOptimization() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const [searchParams] = useSearchParams();

  const [windowDays, setWindowDays] = useState(30);
  const [showHidden, setShowHidden] = useState(false);
  // Off by default. Reading the hierarchy needs Management Group Reader, which
  // is granted separately from subscription access — turning it on for
  // everybody would put a permission error in front of the majority of users to
  // serve the minority who have it.
  const [includeGroups, setIncludeGroups] = useState(false);

  // Every one of these is part of the request, so every one is part of the
  // cache key. Switching the window from 30 days to 90 asks Azure a different
  // question and must not be answered from the 30-day entry.
  const {
    data, error, failure, loading, lastUpdated, cached, loaded, run, ready,
  } = useSecurityQuery(fetchAccessReview, {
    source: 'access-review',
    params: {
      window_days: windowDays,
      stale_days: Math.max(Math.floor(windowDays / 2), 7),
      include_management_groups: includeGroups,
      show_hidden: showHidden,
    },
  });

  const [kind, setKind] = useState('all');
  const [principalType, setPrincipalType] = useState('all');
  const [roleType, setRoleType] = useState('all');
  const [scope, setScope] = useState('all');
  const [managementGroup, setManagementGroup] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('most');
  const [cardSort, setCardSort] = useState('kind');
  const [selected, setSelected] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [revoking, setRevoking] = useState(null);
  const [downgrading, setDowngrading] = useState(null);
  const [resolvingRole, setResolvingRole] = useState('');

  const allFindings = useMemo(
    () => (Array.isArray(data?.findings) ? data.findings : []),
    [data],
  );

  const filtered = useMemo(
    () => filterFindings(allFindings, {
      kind, principalType, roleType, scope, managementGroup, query,
    }),
    [allFindings, kind, principalType, roleType, scope, managementGroup, query],
  );

  const rows = useMemo(() => principalRows(filtered, sort), [filtered, sort]);

  // Falls back to the first row rather than clearing, so narrowing the filters
  // never leaves the right-hand pane empty while the left-hand list is full.
  const active = useMemo(
    () => rows.find(r => r.key === selected) || rows[0] || null,
    [rows, selected],
  );

  const cards = useMemo(
    () => (active ? findingsFor(filtered, active.key, cardSort) : []),
    [filtered, active, cardSort],
  );

  const subscriptions = useMemo(() => subscriptionOptions(allFindings), [allFindings]);
  const groups = useMemo(() => managementGroupOptions(allFindings), [allFindings]);

  // The overview links straight to the high-severity view; honouring it only on
  // first render means a reader who then clears the filter is not fighting the
  // URL for the rest of the session.
  useEffect(() => {
    const wanted = String(searchParams.get('kind') || '').toLowerCase();
    if (OPTIMIZATION_KINDS.some(k => k.key === wanted)) setKind(wanted);
  }, [searchParams]);

  async function hide(finding, wholePrincipal) {
    const key = wholePrincipal ? `p:${finding.principal_id}` : finding.finding_key;
    setBusyKey(key);
    try {
      await acceptAccessFinding({
        tenant_id: tenantId,
        principal_id: finding.principal_id,
        finding_key: wholePrincipal ? '' : finding.finding_key,
        note: '',
      });
      toast.success(wholePrincipal ? 'Principal hidden from this review' : 'Finding accepted');
      await run({ force: true });
    } catch {
      toast.error('Could not save that. Nothing was hidden.');
    } finally {
      setBusyKey('');
    }
  }

  async function restore(finding, wholePrincipal) {
    const key = wholePrincipal ? `p:${finding.principal_id}` : finding.finding_key;
    setBusyKey(key);
    try {
      await restoreAccessFinding(
        tenantId, finding.principal_id, wholePrincipal ? '' : finding.finding_key,
      );
      toast.success('Back in the review');
      await run({ force: true });
    } catch {
      toast.error('Could not restore that.');
    } finally {
      setBusyKey('');
    }
  }

  /**
   * Open the downgrade dialog, having first found the role Azure actually
   * offers at that scope.
   *
   * The recommendation names a tier — "Reader", "Contributor" — not a role id,
   * and a tenant can rename or withhold either. Resolving it here means a role
   * that is not on offer produces a plain sentence now, rather than a dialog
   * that opens and then fails on apply.
   */
  async function openDowngrade(finding) {
    setResolvingRole(finding.finding_key);
    try {
      const { roles } = await fetchAssignableRoles({
        tenant_id: tenantId, scope: finding.scope,
      });
      const wanted = finding.recommendation?.recommended_role;
      const roleId = roleIdFor(roles, wanted);
      if (!roleId) {
        toast.error(`Azure does not offer "${wanted}" at this scope, so it cannot be granted here.`);
        return;
      }
      setDowngrading({ finding, roleId, roleName: wanted });
    } catch {
      toast.error('Could not read the roles available at this scope.');
    } finally {
      setResolvingRole('');
    }
  }

  const totals = data?.totals || {};
  const evidence = data?.evidence || {};

  const hierarchy = data?.management_groups || {};
  const hiddenCount = data?.hidden_count || 0;

  return (
    <div className="p-6 space-y-4 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Access Optimization"
        subtitle="Identify over-privileged and unused permissions. Every finding is a candidate for review, not a verdict — it carries the evidence it rests on and the reason it might be wrong."
        onRun={() => run({ force: true })}
        loading={loading}
        disabled={!ready}
        lastUpdated={lastUpdated}
        cached={cached}
        loaded={loaded}
      />

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Time window" value={String(windowDays)} onChange={v => setWindowDays(Number(v))}>
            {WINDOWS.map(d => <option key={d} value={d}>Last {d} days</option>)}
          </Select>

          <Select label="Principal type" value={principalType} onChange={setPrincipalType}>
            <option value="all">All</option>
            {PRINCIPAL_TYPES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Select>

          <Select label="Role type" value={roleType} onChange={setRoleType}>
            <option value="all">All</option>
            {ROLE_TYPES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </Select>

          <Select label="Optimization" value={kind} onChange={setKind}>
            <option value="all">All</option>
            {OPTIMIZATION_KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
          </Select>

          <Select label="Subscription" value={scope} onChange={setScope}>
            <option value="all">All subscriptions</option>
            {subscriptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>

          {groups.length > 0 && (
            <Select label="Management group" value={managementGroup} onChange={setManagementGroup}>
              <option value="all">All groups</option>
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
            </Select>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-4 pb-1">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={includeGroups}
                onChange={e => setIncludeGroups(e.target.checked)}
                className="accent-sky-500"
              />
              Management groups
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={e => setShowHidden(e.target.checked)}
                className="accent-sky-500"
              />
              Show hidden
              {hiddenCount > 0 && (
                <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                  {hiddenCount}
                </span>
              )}
            </label>
          </div>
        </div>

        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search access findings"
          placeholder="Search by person, application, role, subscription or resource"
          className="mt-3 w-full rounded-xl border border-slate-800 bg-slate-800/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-600"
        />

        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          The window is how far back the Activity Log is read. Azure retains 90
          days and no more, so a longer view is not available from this API at
          any price. A wider window is slower but produces far fewer false
          &ldquo;unused&rdquo; findings.
          {includeGroups && hierarchy.note ? ` ${hierarchy.note}` : ''}
        </p>
      </div>

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && (
        <Failure kind={failure} message={error} onRetry={() => run({ force: true })} stale={Boolean(data)} />
      )}

      {data && <DirectoryNotice directory={data.directory} onResolved={() => run({ force: true })} />}
      {data && <Coverage coverage={data.coverage} errors={data.errors} />}
      {data && evidence.available === false && evidence.note && <ErrorCard message={evidence.note} />}

      {data && (
        <>
          <RightSizing sizing={data.right_sizing} />

          <div className="flex flex-col gap-3 lg:flex-row">
            {/* Principals */}
            <div className="flex w-full flex-col rounded-2xl border border-slate-800 bg-slate-900 lg:w-72 lg:shrink-0">
              <div className="border-b border-slate-800 px-3 py-2.5">
                <p className="text-xs font-semibold text-white">Principals</p>
                <select
                  value={sort}
                  onChange={e => setSort(e.target.value)}
                  aria-label="Sort principals"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-800/50 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-slate-600"
                >
                  {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              <div className="max-h-[38rem] overflow-y-auto">
                {rows.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-slate-500">
                    No principals match these filters.
                  </p>
                ) : rows.map(row => (
                  <PrincipalRow
                    key={row.key}
                    row={row}
                    active={active?.key === row.key}
                    onSelect={() => setSelected(row.key)}
                  />
                ))}
              </div>
              <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
                {rows.length} of {totals.principals_with_findings ?? rows.length} principal(s)
              </div>
            </div>

            {/* Recommendations */}
            <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-slate-800 bg-slate-900">
              <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2.5">
                <p className="text-xs font-semibold text-white">Optimization Recommendations</p>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  Sort by
                  <select
                    value={cardSort}
                    onChange={e => setCardSort(e.target.value)}
                    className="rounded-lg border border-slate-800 bg-slate-800/50 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-slate-600"
                  >
                    {CARD_SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </label>

                {active && (
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => {
                        const anyHidden = cards.some(c => c.hidden);
                        const sample = cards[0];
                        if (!sample) return;
                        return anyHidden ? restore(sample, true) : hide(sample, true);
                      }}
                      disabled={busyKey === `p:${active.principal_id}` || cards.length === 0}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
                    >
                      {busyKey === `p:${active.principal_id}`
                        ? <Loader2 size={11} className="animate-spin" />
                        : <EyeOff size={11} />}
                      {cards.some(c => c.hidden) ? 'Unhide principal' : 'Hide principal'}
                    </button>
                    <button
                      onClick={() => setSelected('')}
                      aria-label="Clear selection"
                      className="rounded-lg border border-slate-800 p-1.5 text-slate-500 transition hover:bg-slate-800"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </div>

              {active && (
                <div className="border-b border-slate-800 px-4 py-2">
                  <p className="text-[11px] text-slate-500">
                    {active.principal_type}:{' '}
                    <span className={active.resolved ? 'text-slate-300' : 'text-slate-400 italic'}>
                      {active.principal_name || 'Name unavailable'}
                    </span>
                    {active.principal_upn && (
                      <span className="ml-1 break-all text-slate-600">{active.principal_upn}</span>
                    )}
                  </p>
                </div>
              )}

              <div className="max-h-[38rem] space-y-2.5 overflow-y-auto p-3">
                {cards.length === 0 ? (
                  <Empty title="Nothing flagged here">
                    That is a statement about the assignments that were read
                    successfully. Check the coverage line above before reading
                    it as a clean result.
                  </Empty>
                ) : cards.map(card => (
                  <FindingCard
                    key={card.finding_key || `${card.kind}:${card.assignment_id}`}
                    finding={card}
                    tenantId={tenantId}
                    busy={busyKey === card.finding_key}
                    onHide={() => hide(card, false)}
                    onRestore={() => restore(card, false)}
                    onRevoke={() => setRevoking(card)}
                    onDowngrade={() => openDowngrade(card)}
                    resolving={resolvingRole === card.finding_key}
                  />
                ))}
              </div>

              <div className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
                Showing {cards.length} optimization{cards.length === 1 ? '' : 's'} of{' '}
                {filtered.length} matching this filter, from {totals.finding_count ?? 0} found.
                {hiddenCount > 0 && !showHidden && ` ${hiddenCount} accepted and hidden.`}
              </div>
            </div>
          </div>

          {evidence.available && evidence.note && (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <p className="text-xs leading-relaxed text-slate-400">{evidence.note}</p>
            </div>
          )}

          <Caveats items={data.caveats} />
        </>
      )}

      <AccessChangeDialog
        open={Boolean(revoking)}
        title="Remove access"
        verb="remove"
        loadPreview={() => previewRevokeAccess({
          tenant_id: tenantId,
          assignment_id: revoking.assignment_id,
          principal_name: revoking.principal_name,
          role_name: revoking.role_name,
        })}
        apply={() => revokeAccess({
          tenant_id: tenantId,
          assignment_id: revoking.assignment_id,
          principal_name: revoking.principal_name,
          role_name: revoking.role_name,
          confirmation: true,
        })}
        onApplied={() => run({ force: true })}
        onClose={() => setRevoking(null)}
      />

      <AccessChangeDialog
        open={Boolean(downgrading)}
        title="Replace this role with a smaller one"
        verb="change"
        loadPreview={() => previewDowngradeAccess({
          tenant_id: tenantId,
          assignment_id: downgrading.finding.assignment_id,
          role_definition_id: downgrading.roleId,
          principal_name: downgrading.finding.principal_name,
          from_role_name: downgrading.finding.role_name,
          to_role_name: downgrading.roleName,
        })}
        apply={() => downgradeAccess({
          tenant_id: tenantId,
          assignment_id: downgrading.finding.assignment_id,
          role_definition_id: downgrading.roleId,
          principal_name: downgrading.finding.principal_name,
          from_role_name: downgrading.finding.role_name,
          to_role_name: downgrading.roleName,
          confirmation: true,
        })}
        onApplied={() => run({ force: true })}
        onClose={() => setDowngrading(null)}
      />
    </div>
  );
}
