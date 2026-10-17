import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listCostNotes } from '../api/client';
import { notesByDate } from '../utils/costNotes';
import { useAppStore } from '../store/useAppStore';
import { ErrorState } from '../components/ui';
import PricingSection from '../components/Cards/PricingSection';
import { CostStrip } from '../components/Layout/CostNavigation';
import {
  ServiceShare, SpendOverTime, SubscriptionSpend,
} from '../components/Charts/CostDashboardCharts';
import { buildSeries, dayLabel, monthLabel } from '../utils/costDashboardSeries';

/**
 * Cost dashboard: Reserved and Pay-as-you-go cards, then the graphs.
 *
 * The graphs follow the date picker — one calendar month is drawn day by day,
 * a longer range month by month. Deeper analysis lives in Cost Explorer,
 * reachable from the Cost workspace navigation.
 */
export default function Dashboard() {
  const {
    costData, costLoading: costsPending, costError, loadCosts,
    selectedSubscriptionIds, selectedTenantId, months, dateKey, dateMode, fromDate, toDate,
    subscriptions,
    pricingData, pricingLoading, pricingError, loadPricing,
    dailyData, dailyLoading, dailyError, dailyRg, loadDailyCosts,
    imported,
  } = useAppStore();

  const isCustom = dateMode === 'custom' && fromDate && toDate;
  // One calendar month selected → draw days; otherwise draw months.
  const singleMonth = isCustom ? fromDate.slice(0, 7) === toDate.slice(0, 7) : months === 1;
  const daily = singleMonth && !imported;
  const currency = costData?.months?.[0]?.currency || pricingData?.currency || 'INR';
  const ready = imported || (selectedTenantId && selectedSubscriptionIds.length > 0);

  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    useAppStore.getState().primeDashboardCache();
    // Costs first, then the rest, so the tenant is not throttled by a burst.
    (async () => {
      await loadCosts();
      if (cancelled || !useAppStore.getState().costData) return;
      await Promise.allSettled([loadPricing(), daily ? loadDailyCosts(null) : Promise.resolve()]);
    })();
    return () => { cancelled = true; };
  }, [ready, selectedTenantId, selectedSubscriptionIds.join(','), dateKey, daily]); // eslint-disable-line react-hooks/exhaustive-deps

  const series = useMemo(() => {
    if (daily) {
      // Daily rows filtered to a resource group belong to another page.
      const days = dailyRg ? [] : (dailyData?.days || []);
      return buildSeries(days.map(day => ({
        key: day.date, label: dayLabel(day.date), full: dayLabel(day.date), total: day.total, byService: day.by_service,
      })));
    }
    return buildSeries((costData?.months || []).map(month => ({
      key: month.month, label: monthLabel(month.month), full: monthLabel(month.month), total: month.total_cost, byService: month.by_service,
    })));
  }, [daily, dailyData, dailyRg, costData]);

  const navigate = useNavigate();
  const [notes, setNotes] = useState({});
  const noteRange = daily && series.rows.length ? `${series.rows[0].key}|${series.rows.at(-1).key}` : '';
  useEffect(() => {
    if (!noteRange || !selectedTenantId) return undefined;
    let live = true;
    const [from, to] = noteRange.split('|');
    listCostNotes({ tenant_id: selectedTenantId, from_date: from, to_date: to, subscription_ids: selectedSubscriptionIds })
      .then(list => { if (live) setNotes(notesByDate(list)); })
      .catch(() => { if (live) setNotes({}); });
    return () => { live = false; };
  }, [noteRange, selectedTenantId, selectedSubscriptionIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const subscriptionNames = useMemo(
    () => Object.fromEntries((subscriptions || []).map(sub => [sub.subscription_id, sub.display_name])),
    [subscriptions],
  );

  const periodLabel = isCustom ? `${fromDate} → ${toDate}` : months === 1 ? 'This month' : `Last ${months} months`;
  const seriesLoading = daily ? (dailyLoading || (costsPending && !dailyData)) : (costsPending && !costData);
  const costLoading = costsPending && !costData;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Cost dashboard</h1>
          <p className="mt-1 text-sm text-slate-400">
            {periodLabel}
            {selectedSubscriptionIds.length > 0 && ` · ${selectedSubscriptionIds.length} subscription${selectedSubscriptionIds.length > 1 ? 's' : ''}`}
            {` · ${currency} · ${daily ? 'daily view' : 'monthly view'}`}
          </p>
        </div>
      </header>

      <CostStrip />

      {costError && <ErrorState title="Could not load costs" message={costError} onRetry={() => loadCosts({ force: true })} />}

      {!selectedTenantId && !imported && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
          <p className="font-medium text-slate-100">No tenant selected</p>
          <p className="mt-1 text-sm text-slate-400">Add a tenant from Settings to get started, or import a cost file.</p>
        </div>
      )}

      <PricingSection
        variant="cards"
        data={pricingData}
        loading={pricingLoading || (costsPending && !pricingData)}
        error={pricingError}
        request={
          selectedTenantId && selectedSubscriptionIds.length
            ? {
                tenant_id: selectedTenantId,
                subscription_ids: selectedSubscriptionIds,
                months,
                ...(isCustom ? { from_date: fromDate, to_date: toDate } : {}),
              }
            : null
        }
      />

      <SpendOverTime
        key={`${dateKey}:${daily}`}
        series={series}
        daily={daily}
        loading={seriesLoading}
        error={daily ? dailyError : costError}
        currency={currency}
        onRetry={daily ? () => loadDailyCosts(null, { force: true }) : () => loadCosts({ force: true })}
        notes={daily ? notes : undefined}
        onSelect={daily && !imported ? day => navigate(`/explorer?tab=day&date=${day}`) : undefined}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <SubscriptionSpend months={costData?.months} names={subscriptionNames} loading={costLoading} currency={currency} />
        <ServiceShare series={series} loading={seriesLoading} currency={currency} />
      </div>
    </div>
  );
}
