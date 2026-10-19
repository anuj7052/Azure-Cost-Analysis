import { NavLink, useLocation } from 'react-router-dom';
import { SECTIONS, sectionForPath } from '../../nav';
import { useAppStore } from '../../store/useAppStore';
import DataQuality from '../Common/DataQuality';
import { readCache } from '../../utils/persistCache';

const cost = SECTIONS.find(section => section.key === 'cost');

/**
 * The five Cost pages as compact pills. Used inside the dashboard's status
 * strip, where it shares one row with the data-coverage readout.
 */
export function CostTabs({ items = cost.items, label = 'Cost workspace' }) {
  return (
    <nav aria-label={label} className="flex min-w-0 gap-1 overflow-x-auto">
      {items.map(({ to, label: text, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end || to === '/'}
          className={({ isActive }) => `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] ${
            isActive
              ? 'bg-[#ffedd5] font-semibold text-[#9a3412] ring-1 ring-[#fdba74]'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
          }`}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {text}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * One row above every Cost page: the five Cost tabs on the left and the data
 * coverage readout (complete/partial, last update, source) on the right.
 */
export function CostStrip({ className = '' }) {
  const live = useAppStore(state => state.costData?.coverage);
  const tenant = useAppStore(state => state.selectedTenantId);
  const subs = useAppStore(state => state.selectedSubscriptionIds);
  const months = useAppStore(state => state.months);
  const dateMode = useAppStore(state => state.dateMode);
  const fromDate = useAppStore(state => state.fromDate);
  const toDate = useAppStore(state => state.toDate);
  // Pages that never load the monthly summary still show its coverage when
  // this device already has it cached for the current selection. Read-only:
  // no Azure query is made from here.
  const coverage = live || (tenant && subs.length ? readCache(`costs:${JSON.stringify({
    tenant_id: tenant, subscription_ids: subs, months, include_reservation_context: true,
    ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
  })}`)?.value?.coverage : null);
  return <DataQuality coverage={coverage} leading={<CostTabs />} className={`bg-slate-900 shadow-sm ${className}`} />;
}

/** Pages that place the strip under their own title. */
const INLINE = new Set(['/', '/explorer', '/boq']);

/**
 * Cost pages that don't render the strip themselves get it above their content.
 */
export default function CostNavigation() {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);
  if (section && ['estate', 'security'].includes(section.key)) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900 px-2 py-1.5 shadow-sm">
          <CostTabs items={section.items} label={`${section.title} sections`} />
        </div>
      </div>
    );
  }
  if (INLINE.has(pathname) || section?.key !== 'cost') return null;
  return (
    <div className="mx-auto max-w-screen-2xl px-4 pt-4 sm:px-6 sm:pt-6">
      <CostStrip />
    </div>
  );
}
