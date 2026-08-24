import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, RefreshCw, TrendingUp, Wallet } from 'lucide-react';
import SectionHub from '../components/Layout/SectionHub';
import ScopeStrip from '../components/Layout/ScopeStrip';
import { KpiCard, Panel, PanelEmpty } from '../components/Layout/HubKit';
import { useAppStore } from '../store/useAppStore';
import { formatAmount } from '../utils/currency';

/**
 * Cost overview — the landing page for the Cost section.
 *
 * Like the other section hubs, this reads only what the store has already
 * loaded. Nothing is fetched on mount: a Cost Management query is a
 * minute-scale call against Azure, and firing one because somebody clicked a
 * nav link would make the whole section feel broken.
 *
 * Where a figure has not been loaded the card shows a dash, never a zero.
 * "We have not looked yet" and "this is zero" are different answers, and a
 * cost page that blurs them is worse than one that stays blank.
 */
export default function CostHome() {
  const costData = useAppStore(s => s.costData);
  const costLoading = useAppStore(s => s.costLoading);
  const loadCosts = useAppStore(s => s.loadCosts);
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const scoped = Boolean(selectedTenantId) && selectedSubscriptionIds.length > 0;
  const currency = costData?.months?.[0]?.currency || 'INR';

  const services = useMemo(
    () => (costData?.top_services || []).slice(0, 6),
    [costData],
  );

  const latest = costData?.months?.at(-1);

  return (
    <SectionHub
      sectionKey="cost"
      actions={
        <button
          onClick={loadCosts}
          disabled={!scoped || costLoading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5
            text-xs font-medium text-slate-300 transition hover:bg-slate-800
            disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${costLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
          Refresh costs
        </button>
      }
    >
      <ScopeStrip />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Latest month"
          value={latest ? formatAmount(latest.total_cost, currency) : '—'}
          hint={latest ? latest.month : 'Not loaded yet'}
          icon={Wallet}
        />
        <KpiCard
          label="Services billing"
          value={costData?.top_services?.length ?? '—'}
          hint={costData ? 'Distinct Azure services with a charge' : 'Not loaded yet'}
          icon={TrendingUp}
        />
        <KpiCard
          label="Subscriptions in scope"
          value={selectedSubscriptionIds.length || '—'}
          hint={scoped ? 'Chosen in the scope picker' : 'Nothing selected'}
        />
      </div>

      <Panel
        title="Largest services"
        icon={TrendingUp}
      >
        {!scoped && (
          <PanelEmpty>
            Choose a tenant and at least one subscription to see where the money goes.
          </PanelEmpty>
        )}

        {scoped && !costData && (
          <PanelEmpty>
            Nothing loaded yet. Use Refresh costs above — this runs a Cost Management
            query against Azure and takes a moment.
          </PanelEmpty>
        )}

        {scoped && costData && services.length === 0 && (
          <PanelEmpty>
            No charges came back for this scope and period. That is Azure reporting
            zero usage, not a failure to read it.
          </PanelEmpty>
        )}

        {services.length > 0 && (
          <ul className="divide-y divide-slate-800">
            {services.map(svc => (
              <li key={svc.service} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-sm text-slate-300">{svc.service}</span>
                <span className="shrink-0 text-sm font-medium tabular-nums text-slate-100">
                  {formatAmount(svc.total_cost, currency)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {services.length > 0 && (
          <Link
            to="/services"
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300"
          >
            Every service, with the meters inside it
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </Panel>
    </SectionHub>
  );
}
