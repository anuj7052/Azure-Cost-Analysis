"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  PiggyBank,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";

import {
  BreakdownBarChart,
  BreakdownPieChart,
  CostTrendChart,
} from "@/components/charts/charts";
import { CostFilterBar } from "@/components/filters/cost-filter-bar";
import { useCostFilters } from "@/components/filters/cost-filter-context";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/utils";

function Kpi({
  title,
  value,
  hint,
  icon: Icon,
}: {
  title: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {hint ? (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { query } = useCostFilters();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", query],
    queryFn: () => api.dashboard(query),
    refetchInterval: 60_000,
  });

  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Overview</h1>
        {data ? (
          <span className="text-xs text-muted-foreground">
            Last synced {formatDateTime(data.last_sync_at)}
          </span>
        ) : null}
      </div>
      <CostFilterBar />
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-5">
        {header}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  if (error)
    return (
      <div className="space-y-5">
        {header}
        <ErrorState message={(error as Error).message} />
      </div>
    );
  if (!data)
    return (
      <div className="space-y-5">
        {header}
        <EmptyState title="No data yet" />
      </div>
    );

  const changeLabel =
    data.cost_change_pct >= 0
      ? `+${data.cost_change_pct}% vs last month`
      : `${data.cost_change_pct}% vs last month`;

  return (
    <div className="space-y-5">
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi
          title="Selected period"
          icon={Wallet}
          value={formatMoney(
            data.month_to_date_cost.amount,
            data.month_to_date_cost.currency,
          )}
          hint={`${data.period_start} → ${data.period_end} · ${changeLabel}`}
        />
        <Kpi
          title="Forecast this month"
          icon={TrendingUp}
          value={formatMoney(
            data.forecast_month_cost.amount,
            data.forecast_month_cost.currency,
          )}
          hint={
            data.forecast_source === "azure"
              ? "Azure Cost Management forecast"
              : "Run-rate estimate"
          }
        />
        <Kpi
          title="Potential savings"
          icon={PiggyBank}
          value={formatMoney(
            data.potential_monthly_savings.amount,
            data.potential_monthly_savings.currency,
          )}
          hint={`${data.advisor_recommendations} recommendations`}
        />
        <Kpi
          title="Resources"
          icon={Boxes}
          value={formatNumber(data.total_resources)}
          hint={`${Object.keys(data.resources_by_type).length} resource types`}
        />
        <Kpi
          title="Active alerts"
          icon={AlertTriangle}
          value={formatNumber(data.active_alerts)}
          hint={`${data.health.available ?? 0} resources healthy`}
        />
        <Kpi
          title="Secure score"
          icon={ShieldCheck}
          value={
            data.secure_score_pct === null
              ? "—"
              : `${data.secure_score_pct.toFixed(0)}%`
          }
          hint="Microsoft Defender for Cloud"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily cost — selected period</CardTitle>
        </CardHeader>
        <CardContent>
          {data.daily_trend.length ? (
            <CostTrendChart data={data.daily_trend} />
          ) : (
            <EmptyState
              title="No cost data yet"
              hint="Run a cost sync from Settings once a subscription is connected."
            />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cost by service</CardTitle>
          </CardHeader>
          <CardContent>
            {data.cost_by_service.length ? (
              <BreakdownPieChart data={data.cost_by_service} />
            ) : (
              <EmptyState title="No service costs yet" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cost by subscription</CardTitle>
          </CardHeader>
          <CardContent>
            {data.cost_by_subscription.length ? (
              <BreakdownBarChart data={data.cost_by_subscription} />
            ) : (
              <EmptyState title="No subscription costs yet" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cost by resource group</CardTitle>
          </CardHeader>
          <CardContent>
            {data.cost_by_resource_group.length ? (
              <BreakdownBarChart data={data.cost_by_resource_group} />
            ) : (
              <EmptyState title="No resource group costs yet" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
