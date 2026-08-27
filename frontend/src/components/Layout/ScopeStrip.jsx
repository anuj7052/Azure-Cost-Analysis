import { useMsal } from '@azure/msal-react';
import { useAppStore } from '../../store/useAppStore';
import { tenantLabel } from '../../utils/tenantName';

/**
 * What the pages below are currently looking at.
 *
 * Every page in the app reads the tenant and subscriptions chosen in the top
 * bar, and every one of them returns an empty screen when nothing is selected.
 * Saying so once, up front, is cheaper than the user opening four pages and
 * concluding the app is broken.
 *
 * Reads only what the shell has already loaded — this must never fire a request
 * of its own, or a landing page becomes slower than the page it links to.
 */
export default function ScopeStrip() {
  const { accounts } = useMsal();
  const tenants = useAppStore(s => s.tenants);
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const subscriptions = useAppStore(s => s.subscriptions);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const imported = useAppStore(s => s.imported);

  const tenant = tenants?.find(t => t.tenant_id === selectedTenantId);
  const selectedCount = selectedSubscriptionIds?.length || 0;
  const totalCount = subscriptions?.length || 0;

  if (imported) {
    return (
      <p className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-xs leading-relaxed text-slate-400">
        Reading an imported usage file. Pages that query Azure directly — access,
        security and activity — still need a connected tenant.
      </p>
    );
  }

  if (!selectedTenantId) {
    return (
      <p className="rounded-2xl border border-blue-500/30 bg-blue-950/40 px-4 py-3 text-sm text-blue-200">
        No Azure tenant is selected yet. Choose one in the bar above, or connect
        one in Settings, and these pages will have something to show.
      </p>
    );
  }

  return (
    <p className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-xs leading-relaxed text-slate-400">
      Showing <span className="text-slate-200">{tenantLabel(tenant, accounts?.[0]?.username)}</span>
      {' · '}
      <span className={selectedCount === 0 ? 'text-amber-300' : 'text-slate-200'}>
        {selectedCount} of {totalCount} subscription{totalCount === 1 ? '' : 's'}
      </span>
      {selectedCount === 0
        ? ' — select at least one in the bar above, or every page below will come back empty.'
        : ' selected in the bar above. Every page in this section uses that selection.'}
    </p>
  );
}
