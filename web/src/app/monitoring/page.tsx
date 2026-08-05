"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { MetricChart } from "@/components/charts/charts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { RESOURCE_TYPE_LABELS, healthClass } from "@/lib/utils";

export default function MonitoringPage() {
  const [selected, setSelected] = useState<string>("");

  const resources = useQuery({
    queryKey: ["monitorable-resources"],
    queryFn: () => api.resources({ type: "virtual_machine", limit: 50 }),
  });

  const detail = useQuery({
    queryKey: ["monitor-detail", selected],
    queryFn: () => api.resourceDetail(selected),
    enabled: Boolean(selected),
    refetchInterval: 60_000, // live refresh
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Monitoring</h1>

      <select
        className="h-9 w-full max-w-md rounded-md border bg-background px-3 text-sm"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">Select a resource…</option>
        {resources.data?.items.map((r) => (
          <option key={r.id} value={r.azure_resource_id}>
            {r.name} ({RESOURCE_TYPE_LABELS[r.resource_type] ?? r.resource_type})
          </option>
        ))}
      </select>

      {!selected ? (
        <EmptyState title="Pick a resource to see live metrics" />
      ) : detail.isLoading ? (
        <Skeleton className="h-64" />
      ) : detail.data?.metrics.length ? (
        <>
          <p className="text-xs text-muted-foreground">
            Health:{" "}
            <span className={healthClass(detail.data.resource.health_state)}>
              {detail.data.resource.health_state}
            </span>{" "}
            · refreshes every 60s
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {detail.data.metrics.map((series) => (
              <Card key={series.metric}>
                <CardHeader>
                  <CardTitle className="capitalize">
                    {series.metric.replace(/_/g, " ")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <MetricChart series={series} />
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title="No metrics for this resource"
          hint="Metrics sync runs every 15 minutes."
        />
      )}
    </div>
  );
}
