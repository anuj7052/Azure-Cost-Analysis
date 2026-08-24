import { Link } from 'react-router-dom';
import { UserRound, Building2, ShieldCheck, FileUp, ArrowRight, Mail } from 'lucide-react';
import SectionHub from '../components/Layout/SectionHub';
import { KpiCard, Panel, PanelEmpty } from '../components/Layout/HubKit';
import { useAppStore } from '../store/useAppStore';

/**
 * Account overview.
 *
 * Everything shown here is already in the store — the signed-in account from
 * /me and the tenant list from /tenants — so the page costs nothing to open.
 *
 * The reference design for this screen also carried a billing-account panel
 * (account id, billing profile, invoice section, current balance, next invoice
 * date) and a compliance score. Those are deliberately absent: this app never
 * calls the Azure billing account API and computes no compliance score, so the
 * only way to render them would be to invent the values. A number a user might
 * act on must come from somewhere real or not appear at all.
 */

function initialsOf(name, email) {
  const source = (name || email || '').trim();
  if (!source) return '?';
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2)).toUpperCase();
}

export default function AccountHome() {
  const me = useAppStore(s => s.me);
  const tenants = useAppStore(s => s.tenants);
  const imported = useAppStore(s => s.imported);

  const list = tenants || [];
  const isAdmin = Boolean(me?.is_admin);

  return (
    <SectionHub
      sectionKey="account"
      breadcrumb={[{ label: 'Home', to: '/' }, { label: 'Account Overview' }]}
    >
      <Panel>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-slate-800 bg-slate-800/60 text-xl font-bold text-blue-300">
            {initialsOf(me?.name, me?.email)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-bold text-white">{me?.name || me?.email || 'Signed-in user'}</h2>
              <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${
                isAdmin
                  ? 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30'
                  : 'bg-slate-800 text-slate-400 ring-1 ring-slate-700'
              }`}>
                {me?.role || 'member'}
              </span>
              {me?.status && me.status !== 'active' && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-500/30">
                  {me.status}
                </span>
              )}
            </div>
            {me?.email && (
              <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-slate-500">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                {me.email}
              </p>
            )}
          </div>
          <Link
            to="/settings"
            className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            Account settings
          </Link>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          label="Connected tenants"
          icon={Building2}
          to="/settings"
          value={list.length.toLocaleString()}
          hint={list.length === 0 ? 'Connect one in Settings' : 'Scoped to your account only'}
          hintTone={list.length === 0 ? 'warn' : 'muted'}
          tone={list.length === 0 ? 'warn' : 'neutral'}
        />
        <KpiCard
          label="Access level"
          icon={ShieldCheck}
          to={isAdmin ? '/admin' : undefined}
          value={isAdmin ? 'Administrator' : 'Standard'}
          hint={isAdmin ? 'Admin Center is available to you' : 'Admin Center is not available'}
        />
        <KpiCard
          label="Data source"
          icon={FileUp}
          to="/settings"
          tone={imported ? 'info' : 'neutral'}
          value={imported ? 'Imported file' : 'Live Azure'}
          hint={imported
            ? 'An uploaded usage file takes precedence over live data'
            : 'Figures are read from the Azure Cost Management API'}
          hintTone={imported ? 'warn' : 'muted'}
        />
      </div>

      <Panel
        title="Tenants"
        icon={Building2}
        action={(
          <Link to="/settings" className="flex items-center gap-1 font-mono text-xs text-blue-400 transition hover:text-blue-300">
            Manage <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      >
        {list.length === 0 ? (
          <PanelEmpty>
            No Azure tenant is connected yet. Until one is, the only data this app can show is an
            imported usage file.
          </PanelEmpty>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {list.map((tenant) => (
              <div key={tenant.tenant_id} className="flex flex-wrap items-center gap-3 py-3">
                <UserRound className="h-4 w-4 shrink-0 text-slate-600" aria-hidden="true" />
                <span className="text-sm font-medium text-slate-200">{tenant.tenant_name || tenant.tenant_id}</span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  {tenant.tenant_id}
                </span>
                {tenant.source && (
                  <span className="ml-auto font-mono text-[11px] uppercase tracking-wide text-slate-500">
                    {tenant.source}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </SectionHub>
  );
}
