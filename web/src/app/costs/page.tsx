"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
import { formatMoney } from "@/lib/utils";

const DIMENSIONS = [
  { value: "service", label: "Service" },
  { value: "subscription", label: "Subscription" },
  { value: "resource_group", label: "Resource group" },
  { value: "resource_type", label: "Resource type" },
  { value: "resource", label: "Resource" },
];

export default function CostsPage() {
  const { query } = useCostFilters();
  const [dimension, setDimension] = useState("service");
  const [days, setDays] = useState(30);

  const trend = useQuery({
    queryKey: ["cost-trend", days, query],
    queryFn: () => api.costTrend(days, query),
  });
  const breakdown = useQuery({
    queryKey: ["cost-breakdown", dimension, query],
    queryFn: () => api.costBreakdown(dimension, 12, query),
  });
  const anomalies = useQuery({
    queryKey: ["cost-anomalies", query],
    queryFn: () => api.anomalies(query),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Cost analysis</h1>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <CostFilterBar />      <Card>
        <CardHeader>
          <CardTitle>Daily cost</CardTitle>
        </CardHeader>
        <CardContent>
          {trend.isLoading ? (
            <Skeleton className="h-60" />
          ) : trend.error ? (
            <ErrorState message={(trend.error as Error).message} />
          ) : trend.data?.length ? (
            <CostTrendChart data={trend.data} />
          ) : (
            <EmptyState title="No cost data" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Breakdown</CardTitle>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={dimension}
            onChange={(e) => setDimension(e.target.value)}
          >
            {DIMENSIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          {breakdown.isLoading ? (
            <Skeleton className="h-60" />
          ) : breakdown.data?.length ? (
            <>
              <BreakdownBarChart data={breakdown.data} />
              <BreakdownPieChart data={breakdown.data.slice(0, 8)} />
            </>
          ) : (
            <EmptyState title="No breakdown data" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cost anomalies</CardTitle>
        </CardHeader>
        <CardContent>
          {anomalies.isLoading ? (
            <Skeleton className="h-24" />
          ) : anomalies.data?.length ? (
            <ul className="space-y-2 text-sm">
              {anomalies.data.map((a) => (
                <li key={`${a.service}-${a.date}`} className="flex justify-between gap-4">
                  <span>
                    {a.service}{" "}
                    <span className="text-muted-foreground">on {a.date}</span>
                  </span>
                  <span className="text-amber-600">
                    {formatMoney(a.cost)} (+{formatMoney(a.delta)} vs baseline)
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No spend anomalies detected" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
