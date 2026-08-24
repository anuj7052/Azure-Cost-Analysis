import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Unlink, Layers, RefreshCw, ArrowRight } from 'lucide-react';
import SectionHub from '../components/Layout/SectionHub';
import ScopeStrip from '../components/Layout/ScopeStrip';
import { KpiCard, Panel, PanelEmpty } from '../components/Layout/HubKit';
import { useAppStore } from '../store/useAppStore';
import { formatAmount, formatAmountFull } from '../utils/currency';

/**
 * Estate overview.
 *
 * Every figure on this page comes from data the store has already loaded, or
 * from a load the user explicitly asked for with the Refresh button. Nothing
 * here is fetched on mount: resource-group costs and the orphaned-resource
 * sweep are both minute-scale Azure calls, and firing them because somebody
 * clicked a nav link would make the section feel broken.
 *
 * Where a figure has not been loaded the card shows a dash, never a zero.
 * "We have not looked" and "there is nothing there" are different answers and
 * the page must not blur them.
 */
export default function Estate() {
  const rgData = useAppStore(s => s.rgData);
  const rgLoading = useAppStore(s => s.rgLoading);
  const loadRgCosts = useAppStore(s => s.loadRgCosts);
  const orphanedData = useAppStore(s => s.orphanedData);
  const orphanedLoading = useAppStore(s => s.orphanedLoading);
  const loadOrphaned = useAppStore(s => s.loadOrphaned);
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const scoped = Boolean(selectedTenantId) && selectedSubscriptionIds.length > 0;
  const busy = rgLoading || orphanedLoading;

  const currency = rgData?.currency || orphanedData?.currency || 'INR';

  const groups = useMemo(() => {
    const list = rgData?.resource_groups || [];
    return [...list].sort((a, b) => (b.total || 0) - (a.total || 0));
  }, [rgData]);

  const refresh = () => {
    if (!scoped) return;
    loadRgCosts({ force: true });
    loadOrphaned({ force: true });
  };

  const actions = (
    <button
      type="button"
      onClick={refresh}
      disabled={!scoped || busy}
      className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
      {busy ? 'Loading…' : 'Refresh estate'}
    </button>
  );

  return (
    <SectionHub
      sectionKey="estate"
      breadcrumb={[{ label: 'Home', to: '/' }, { label: 'Estate Overview' }]}
      actions={actions}
    >
      <ScopeStrip />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          label="Resource groups"
          icon={Layers}
          to="/resource-groups"
          loading={rgLoading}
          value={groups.length ? groups.length.toLocaleString() : null}
          hint={rgData ? `${formatAmount(rgData.total, currency)} in the selected window` : 'Not loaded yet'}
        />
        <KpiCard
          label="Orphaned resources"
          icon={Unlink}
          to="/orphaned"
          tone={orphanedData?.total_count > 0 ? 'warn' : 'neutral'}
          loading={orphanedLoading}
          value={orphanedData ? orphanedData.total_count.toLocaleString() : null}
          hint={orphanedData
            ? (orphanedData.total_count > 0
              ? `${formatAmountFull(orphanedData.total_monthly_cost, currency)} / month recoverable`
              : 'Nothing unattached found')
            : 'Not scanned yet'}
          hintTone={orphanedData?.total_count > 0 ? 'warn' : 'muted'}
        />
        <KpiCard
          label="Estate spend"
          icon={Boxes}
          to="/trends"
          loading={rgLoading}
          value={rgData ? formatAmount(rgData.total, currency) : null}
          hint={rgData ? 'Sum across the groups below' : 'Not loaded yet'}
        />
      </div>

      <Panel
        title="Resource group distribution"
        icon={Layers}
        action={(
          <Link to="/resource-groups" className="flex items-center gap-1 font-mono text-xs text-blue-400 transition hover:text-blue-300">
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      >
        {!scoped ? (
          <PanelEmpty>Pick a tenant and at least one subscription to see the estate.</PanelEmpty>
        ) : !groups.length ? (
          <PanelEmpty>
            {rgLoading ? 'Loading resource groups…' : 'No resource group costs loaded. Use Refresh estate above.'}
          </PanelEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left font-mono text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-3 font-semibold">Resource group</th>
                  <th className="pb-2 pr-3 text-right font-semibold">Cost</th>
                  <th className="pb-2 text-right font-semibold">Share</th>
                </tr>
              </thead>
              <tbody>
                {groups.slice(0, 8).map((rg) => {
                  const pct = rgData.total > 0 ? (rg.total / rgData.total) * 100 : 0;
                  return (
                    <tr key={rg.rg_name} className="border-b border-slate-800/60 last:border-0">
                      <td className="py-2.5 pr-3 font-medium text-slate-200">{rg.rg_name}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-slate-300">
                        {formatAmountFull(rg.total, currency)}
                      </td>
                      <td className="py-2.5 text-right font-mono text-xs tabular-nums text-slate-500">
                        {pct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {groups.length > 8 && (
              <p className="mt-3 text-xs text-slate-500">
                Showing the 8 largest of {groups.length}. The full list is on Resource Groups.
              </p>
            )}
          </div>
        )}
      </Panel>
    </SectionHub>
  );
}
