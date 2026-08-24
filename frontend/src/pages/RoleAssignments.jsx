import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Users, Shield, Eye, Bot } from 'lucide-react';
import { fetchRoleAssignments } from '../api/client';
import {
  PageHeader, NeedsSelection, ErrorCard, Coverage,
  Stat, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useSecurityQuery } from '../components/Security/securityData';
import { Principal, ScopePath } from '../components/Common/Identity';
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

function Badge({ privilege }) {
  const meta = PRIVILEGE[privilege] || PRIVILEGE.read;
  return (
    <span className={`px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${meta.tone}`}>
      {meta.label}
    </span>
  );
}

function PrincipalRow({ principal, open, onToggle }) {
  const Icon = TYPE_ICON[principal.principal_type] || Eye;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="border border-slate-800 bg-slate-800/30 rounded-xl transition hover:bg-slate-800/60">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 text-left"
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
          <p className="text-xs text-slate-500 mt-0.5">
            {principal.principal_type} · {principal.assignment_count} assignment(s) ·{' '}
            {principal.subscription_count} subscription(s) · widest scope: {principal.widest_scope}
          </p>
        </div>
      </button>

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
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="text-left font-semibold py-1.5">Role</th>
                  <th className="text-left font-semibold py-1.5">Privilege</th>
                  <th className="text-left font-semibold py-1.5">Scope level</th>
                  <th className="text-left font-semibold py-1.5">Scope</th>
                </tr>
              </thead>
              <tbody>
                {principal.assignments.map((a, i) => (
                  <tr key={i} className="border-t border-slate-800/80">
                    <td className="py-2 pr-3 text-slate-200">
                      {a.role_name}
                      {a.is_custom && (
                        <span className="ml-2 text-[10px] text-slate-500 border border-slate-700 rounded px-1 py-0.5">
                          custom
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3"><Badge privilege={a.privilege} /></td>
                    <td className="py-2 pr-3 text-slate-400">{a.scope_kind}</td>
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

export default function RoleAssignments() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const { data, error, loading, run, ready } = useSecurityQuery(fetchRoleAssignments);

  const [openKey, setOpenKey] = useState(null);
  const [privilege, setPrivilege] = useState('all');
  const [type, setType] = useState('all');

  const principals = useMemo(() => {
    const rows = data?.principals || [];
    return rows.filter(p =>
      (privilege === 'all' || p.top_privilege === privilege) &&
      (type === 'all' || p.principal_type === type)
    );
  }, [data, privilege, type]);

  const totals = data?.totals;

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader
        title="Role Assignments"
        subtitle="Start from a user, group or service principal and see every resource it can reach, categorised by how much damage the role could do."
        onRun={run}
        loading={loading}
        disabled={!ready}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <ErrorCard message={error} />}

      {data && (
        <>
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
                    ...Object.entries(totals.by_type).map(([key, count]) => ({ key, label: key, count })),
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
          </div>
        </>
      )}
    </div>
  );
}
