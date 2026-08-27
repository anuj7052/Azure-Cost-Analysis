import { useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Users, Shield, Eye, Bot } from 'lucide-react';
import {
  fetchRoleAssignments,
  previewRevokeAccess,
  revokeAccess,
} from '../api/client';
import {
  PageHeader, NeedsSelection, Failure, Coverage,
  Stat, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery } from '../components/Security/securityData';
import { Principal, ScopePath, SubscriptionName, IdChip } from '../components/Common/Identity';
import DetailPanel from '../components/Common/DetailPanel';
import AccessChangeDialog from '../components/Security/AccessChangeDialog';
import DirectoryNotice from '../components/Security/DirectoryNotice';
import { plainRole, plainScope } from '../utils/securityLanguage';
import { useAppStore } from '../store/useAppStore';

/**
 * Principal-centric RBAC auditing.
 *
 * Azure indexes access by scope: open a resource group and it will tell you who
 * can touch it. That is the wrong orientation for the question people actually
 * ask, which is "what can this contractor reach?" — answering it in the portal
 * means visiting every scope by hand and keeping a tally.
 *
 * This page turns the same data inside out. One row per principal, every
 * assignment it holds, categorised by how much damage it could do.
 */

const PRIVILEGE = {
  critical: {
    label: 'Critical',
    tone: 'bg-red-950/50 text-red-300 border-red-500/30',
    hint: 'Owner or User Access Administrator — can grant access to others',
  },
  management: {
    label: 'Management',
    tone: 'bg-amber-950/40 text-amber-300 border-amber-500/30',
    hint: 'Can change resources but not grant access',
  },
  read: {
    label: 'Read',
    tone: 'bg-slate-800 text-slate-300 border-slate-700',
    hint: 'Can look but not change',
  },
};

const TYPE_ICON = {
  User: Users,
  Group: Shield,
  'Service principal': Bot,
};

const PRIVILEGE_KEYS = ['critical', 'management', 'read'];

/** Absent values are said out loud, because a blank cell reads as a zero. */
const MISSING = 'Not available';

function value(v) {
  return v === null || v === undefined || v === '' ? MISSING : v;
}

/**
 * A role said twice: what it lets somebody do, then the exact Azure name.
 *
 * The Azure name is never dropped — an administrator who has to find this
 * assignment in the portal can only search for the technical string.
 */
function RoleLabel({ roleName, permissions }) {
  const role = plainRole(roleName, permissions);
  return (
    <span className="inline-block min-w-0 align-top">
      <span className="flex items-center gap-1.5">
        <span className="text-slate-200">{role.plain}</span>
        {role.derived && (
          <span
            title="This wording was read from the role's own permission list rather than from its name. Azure does not tell us whether the role is built in or custom, so this badge does not claim either."
            className="rounded border border-slate-600/50 bg-slate-800/60 px-1 py-0.5 text-[10px] text-slate-400"
          >
            from permissions
          </span>
        )}
      </span>
      <span className="block font-mono text-[11px] text-slate-500">Azure role: {role.technical}</span>
    </span>
  );
}

/**
 * One sentence about risk, built only from the flags Azure actually returned.
 *
 * No score is invented here: when no role definition could be read the honest
 * answer is that nothing is known, not a reassuring low number.
 */
function riskSentence(assignments) {
  const known = assignments.filter(a => a?.permissions?.known);
  if (known.length === 0) {
    return 'What these roles permit could not be read from Azure, so nothing can be said about the risk either way.';
  }
  if (known.some(a => a.permissions.can_grant_access)) {
    return 'This account can give other people access, which means it can extend its own reach and anybody else\u2019s.';
  }
  if (known.some(a => a.permissions.can_delete)) {
    return 'This account can change and delete resources here, but cannot give anybody else access.';
  }
  if (known.some(a => a.permissions.can_write)) {
    return 'This account can create and change resources here, but cannot delete them or grant access.';
  }
  return 'Every role read for this account is read-only: it can look at resources but cannot change them.';
}

function Badge({ privilege }) {
  const meta = PRIVILEGE[privilege] || PRIVILEGE.read;
  return (
    <span className={`px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${meta.tone}`}>
      {meta.label}
    </span>
  );
}

/**
 * What a role can actually do, taken from its definition.
 *
 * A name is not a permission. A custom role called "Reader" holding a write
 * action is precisely the case a name-based check waves through, so the flags
 * shown here are read from the actions the definition grants.
 */
function CanBadges({ permissions }) {
  if (!permissions?.known) return <span className="text-slate-600">&mdash;</span>;

  const flags = [
    ['write', permissions.can_write],
    ['delete', permissions.can_delete],
    ['grant access', permissions.can_grant_access],
  ].filter(([, on]) => on);

  if (flags.length === 0) return <span className="text-slate-600">&mdash;</span>;

  return (
    <span className="flex flex-wrap gap-1">
      {flags.map(([label]) => (
        <span
          key={label}
          className="rounded border border-amber-500/30 bg-amber-950/40 px-1 py-0.5 text-[10px] text-amber-300"
        >
          {label}
        </span>
      ))}
    </span>
  );
}

function PrincipalRow({ principal, open, onToggle, onOpenDetails }) {
  const Icon = TYPE_ICON[principal.principal_type] || Eye;
  const Chevron = open ? ChevronDown : ChevronRight;
  const assignments = Array.isArray(principal.assignments) ? principal.assignments : [];
  const widest = plainScope(principal.widest_scope);

  return (
    <div className="border border-slate-800 bg-slate-800/30 rounded-xl transition hover:bg-slate-800/60">
      <div className="flex items-center gap-2 p-3">
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Chevron size={16} className="text-slate-500 shrink-0" />
          <Icon size={16} className="text-slate-400 shrink-0" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-white truncate">
                <Principal item={principal} />
              </p>
              <Badge privilege={principal.top_privilege} />
              {!principal.resolved && (
                <span className="text-[10px] text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">
                  object id only
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {/* Lower-casing only the first character. A blanket toLowerCase
                  turns "Your entire Azure account" into "azure account", which
                  reads as a typo in the middle of a security finding. */}
              Can reach {widest.plain.charAt(0).toLowerCase() + widest.plain.slice(1)} ·{' '}
              {value(principal.assignment_count)} assignment(s) ·{' '}
              {value(principal.subscription_count)} subscription(s)
            </p>
            <p className="font-mono text-[11px] text-slate-500">
              {principal.principal_type || 'Unknown principal type'} · widest scope: {value(principal.widest_scope)}
            </p>
          </div>
        </button>
        <button
          onClick={onOpenDetails}
          className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800"
        >
          Details
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {principal.principal_type === 'Group' && (
            <p className="text-xs text-amber-300/80 leading-relaxed border border-amber-500/20 bg-amber-950/20 rounded-lg p-2.5">
              This is a group. Everyone inside it inherits every assignment below,
              and those members are not listed here — expanding membership needs
              Microsoft Graph directory read consent, which this app does not
              hold. Read this row as &ldquo;everyone in this group&rdquo;.
            </p>
          )}

          <div className="overflow-x-auto">
            <p className="text-[11px] text-slate-500 leading-relaxed mb-2">
              The &ldquo;Can&rdquo; column is read from each role definition&rsquo;s actions rather
              than its name &mdash; a custom role called &ldquo;Reader&rdquo; that holds a write
              action is exactly what a name-based check misses.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="text-left font-semibold py-1.5">Role</th>
                  <th className="text-left font-semibold py-1.5">Privilege</th>
                  <th className="text-left font-semibold py-1.5">Can</th>
                  <th className="text-left font-semibold py-1.5">Scope level</th>
                  <th className="text-left font-semibold py-1.5">Scope</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a, i) => (
                  <tr key={i} className="border-t border-slate-800/80">
                    <td className="py-2 pr-3 text-slate-200">
                      <RoleLabel roleName={a.role_name} permissions={a.permissions} />
                    </td>
                    <td className="py-2 pr-3"><Badge privilege={a.privilege} /></td>
                    <td className="py-2 pr-3"><CanBadges permissions={a.permissions} /></td>
                    <td className="py-2 pr-3">
                      <span className="block text-slate-300">{plainScope(a.scope_kind).plain}</span>
                      <span className="block font-mono text-[11px] text-slate-500">{value(a.scope_kind)}</span>
                    </td>
                    <td className="py-2 text-xs text-slate-500 truncate max-w-md">
                      <ScopePath scope={a.scope} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** A block of raw Azure identifiers, kept last and kept complete. */
function Technical({ rows }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Technical details</p>
      <dl className="mt-2 space-y-1.5">
        {rows.map(([label, val]) => (
          <div key={label} className="flex flex-wrap gap-x-2">
            <dt className="text-[11px] text-slate-500">{label}</dt>
            <dd className="font-mono text-[11px] text-slate-400 break-all">{value(val)}</dd>
          </div>
        ))}
      </dl>
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

function PrincipalDetail({ principal, onRevoke }) {
  const assignments = useMemo(
    () => (Array.isArray(principal?.assignments) ? principal.assignments : []),
    [principal],
  );
  const first = assignments[0] || {};

  // Grouped by role, not listed per assignment. An account holding Owner on
  // forty resource groups produced forty identical cards, which buried the one
  // line that actually mattered -- the custom role sitting among them with
  // powers its name does not suggest.
  const byRole = useMemo(() => {
    const groups = new Map();
    for (const a of assignments) {
      const key = a.role_name || 'Unknown role';
      const entry = groups.get(key) || { roleName: key, permissions: a.permissions, places: [] };
      entry.places.push(a);
      groups.set(key, entry);
    }
    return [...groups.values()].sort((x, y) => y.places.length - x.places.length);
  }, [assignments]);

  return (
    <>
      <Section title="Who">
        <p className="text-sm font-semibold text-white">
          <Principal item={principal} />
        </p>
        <p className="text-xs text-slate-400">{value(principal?.principal_type)}</p>
        {(principal?.user_principal_name || principal?.email) && (
          <p className="text-xs text-slate-400">{principal.user_principal_name || principal.email}</p>
        )}
        <IdChip value={principal?.principal_id} />
      </Section>

      <Section title="What can they do">
        {byRole.length === 0 ? (
          <p className="text-xs text-slate-500">{MISSING}</p>
        ) : (
          <div className="space-y-2">
            {byRole.map(group => (
              <div key={group.roleName} className="border border-slate-800 bg-slate-800/30 rounded-xl p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <RoleLabel roleName={group.roleName} permissions={group.permissions} />
                  <span className="shrink-0 font-mono text-[11px] text-slate-500">
                    {group.places.length} place{group.places.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-1.5"><CanBadges permissions={group.permissions} /></div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Where">
        <div className="space-y-1.5">
          {byRole.length === 0 && <p className="text-xs text-slate-500">{MISSING}</p>}
          {byRole.map(group => (
            <div key={group.roleName} className="text-xs text-slate-400">
              <p className="text-slate-300">{group.roleName}</p>
              {group.places.slice(0, 8).map((a, i) => (
                <div key={i} className="mt-1 pl-3">
                  <p>{plainScope(a.scope_kind).plain}</p>
                  <ScopePath scope={a.scope} className="text-[11px]" />
                  {a.subscription_id && (
                    <p className="text-[11px] text-slate-500">
                      <SubscriptionName id={a.subscription_id} />
                    </p>
                  )}
                  {/* Offered only where there is an assignment id to act on.
                      A button that cannot possibly work is worse than none. */}
                  {(a.assignment_id || a.id) && (
                    <button
                      onClick={() => onRevoke({
                        assignmentId: a.assignment_id || a.id,
                        roleName: group.roleName,
                        principalName: principal?.principal_name || principal?.display_name || '',
                      })}
                      className="mt-1 rounded-md border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 transition hover:bg-red-950/40"
                    >
                      Remove this access
                    </button>
                  )}
                </div>
              ))}
              {group.places.length > 8 && (
                <p className="mt-1 pl-3 text-[11px] text-slate-600">
                  and {group.places.length - 8} more place(s)
                </p>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="How risky">
        <p className="text-sm text-slate-300 leading-relaxed">{riskSentence(assignments)}</p>
      </Section>

      <Technical
        rows={[
          ['Assignment id', first.assignment_id || first.id],
          ['Role definition id', first.role_definition_id],
          ['Scope', first.scope],
          ['Principal id', principal?.principal_id],
        ]}
      />
    </>
  );
}

export default function RoleAssignments() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const { data, error, failure, loading, lastUpdated, cached, loaded, run, ready } = useSecurityQuery(fetchRoleAssignments, { source: 'role-assignments' });
  const [searchParams] = useSearchParams();

  const [openKey, setOpenKey] = useState(null);
  const [selected, setSelected] = useState(null);
  const [revoking, setRevoking] = useState(null);
  // The overview's action centre links here already filtered, so the deep link
  // has to be honoured on the first render rather than after one.
  const [privilege, setPrivilege] = useState(() => {
    const wanted = searchParams.get('filter');
    return PRIVILEGE_KEYS.includes(wanted) ? wanted : 'all';
  });
  const [type, setType] = useState('all');

  // Access Optimization links here to answer "what else can this account do?",
  // which is the question a reviewer asks immediately after reading a finding.
  // Filtering by object id rather than by name is deliberate: the name may be
  // unresolved, and two accounts can share a display name, but the id cannot.
  const focusPrincipal = searchParams.get('principal') || '';

  const principals = useMemo(() => {
    const rows = Array.isArray(data?.principals) ? data.principals : [];
    return rows.filter(p =>
      (privilege === 'all' || p.top_privilege === privilege) &&
      (type === 'all' || p.principal_type === type) &&
      (!focusPrincipal || p.principal_id === focusPrincipal)
    );
  }, [data, privilege, type, focusPrincipal]);

  // Totals are read straight into the stat tiles and the filter chips, so a
  // response missing them would blank the page rather than show a smaller one.
  const totals = data?.totals || {};
  const byType = totals.by_type || {};

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Role Assignments"
        subtitle="Who has access to what, and how much they can do. Start from a user, group or service principal and see every resource it can reach."
        onRun={() => run({ force: true })}
        loading={loading}
        disabled={!ready}
        lastUpdated={lastUpdated}
        cached={cached}
        loaded={loaded}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <Failure kind={failure} message={error} onRetry={() => run({ force: true })} stale={Boolean(data)} />}

      {data && focusPrincipal && (
        // A filter applied by a link, with nothing on screen to say so, is
        // indistinguishable from a page that lost most of its data.
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-blue-500/25 bg-blue-950/20 px-4 py-3">
          <p className="text-xs text-blue-200/85">
            Showing one account only, opened from an access finding.
          </p>
          <Link
            to="/role-assignments"
            className="text-xs font-medium text-blue-300 underline underline-offset-2"
          >
            Show all accounts
          </Link>
        </div>
      )}

      {data && (
        <DirectoryNotice
          directory={data.directory}
          onResolved={() => run({ force: true })}
        />
      )}

      {data && (
        <>
          {data.truncated && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-4">
              <p className="text-xs leading-relaxed text-amber-200">{data.truncation_note}</p>
            </div>
          )}

          {data.definitions_read === false && (
            <p className="text-xs text-slate-500 leading-relaxed">
              Role definitions could not be read, so roles appear by id and
              custom-role detection is unavailable on this reading.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Principals" value={totals.principal_count} />
            <Stat label="Assignments" value={totals.assignment_count} />
            <Stat
              label="Critical"
              value={totals.critical_count}
              tone="text-red-300"
              hint="Can grant access to others"
            />
            <Stat label="Management" value={totals.management_count} tone="text-amber-300" />
            <Stat label="Read only" value={totals.read_count} />
          </div>

          <Coverage coverage={data.coverage} errors={data.errors} />

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex flex-wrap gap-4">
              <div className="space-y-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Privilege
                </span>
                <Chips
                  value={privilege}
                  onChange={setPrivilege}
                  options={[
                    { key: 'all', label: 'All', count: totals.principal_count },
                    { key: 'critical', label: 'Critical', count: totals.critical_count },
                    { key: 'management', label: 'Management', count: totals.management_count },
                    { key: 'read', label: 'Read', count: totals.read_count },
                  ]}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Principal type
                </span>
                <Chips
                  value={type}
                  onChange={setType}
                  options={[
                    { key: 'all', label: 'All' },
                    ...Object.entries(byType).map(([key, count]) => ({ key, label: key, count })),
                  ]}
                />
              </div>
            </div>

            <div className="space-y-2">
              {principals.length === 0 ? (
                <Empty title="No principals match these filters">
                  Every assignment read is still counted in the totals above —
                  only the list is filtered.
                </Empty>
              ) : (
                principals.map((p) => (
                  <PrincipalRow
                    key={p.principal_id || p.principal_name}
                    principal={p}
                    open={openKey === (p.principal_id || p.principal_name)}
                    onOpenDetails={() => setSelected(p)}
                    onToggle={() =>
                      setOpenKey(openKey === (p.principal_id || p.principal_name)
                        ? null
                        : (p.principal_id || p.principal_name))
                    }
                  />
                ))
              )}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
            <p className="text-xs text-slate-400 leading-relaxed">{data.note}</p>
            <p className="text-xs text-slate-400 leading-relaxed">{data.nested_group_note}</p>
            {totals.unresolved_count > 0 && (
              <p className="text-xs text-slate-500">
                {totals.unresolved_count} principal(s) appear as an object id rather than a name.
              </p>
            )}
            {/* Why the names are missing decides what the reader should do
                about it. "No consent" is an administrator's task; "no token"
                resolves itself on the next sign-in. */}
            {data.directory?.reason === 'no_token' && (
              <p className="text-xs text-slate-500 leading-relaxed">
                Names could not be read from your directory during this scan, so
                some accounts are shown by object id.
              </p>
            )}
          </div>
        </>
      )}

      <DetailPanel
        open={Boolean(selected)}
        title="Access held by this principal"
        subtitle="Everything read for this account, in plain words first and Azure's own terms beneath."
        onClose={() => setSelected(null)}
      >
        {selected && <PrincipalDetail principal={selected} onRevoke={setRevoking} />}
      </DetailPanel>

      <AccessChangeDialog
        open={Boolean(revoking)}
        title="Remove access"
        verb="remove"
        loadPreview={() => previewRevokeAccess({
          tenant_id: tenantId,
          assignment_id: revoking.assignmentId,
          principal_name: revoking.principalName,
          role_name: revoking.roleName,
        })}
        apply={() => revokeAccess({
          tenant_id: tenantId,
          assignment_id: revoking.assignmentId,
          principal_name: revoking.principalName,
          role_name: revoking.roleName,
          confirmation: true,
        })}
        onApplied={() => run({ force: true })}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
