"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { CostTrendChart, MetricChart } from "@/components/charts/charts";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import {
  formatDateTime,
  formatMoney,
  formatQuantity,
  healthClass,
  severityClass,
} from "@/lib/utils";

const TABS = [
  "Configuration",
  "Cost",
  "Metrics",
  "Tags",
  "Dependencies",
  "Activity",
  "Alerts",
  "Backup",
  "Security",
  "Recommendations",
] as const;

function DetailView() {
  const params = useSearchParams();
  const resourceId = params.get("id") ?? "";
  const [tab, setTab] = useState<(typeof TABS)[number]>("Configuration");

  const { data, isLoading, error } = useQuery({
    queryKey: ["resource-detail", resourceId],
    queryFn: () => api.resourceDetail(resourceId),
    enabled: Boolean(resourceId),
    refetchInterval: 60_000,
  });

  if (!resourceId) return <EmptyState title="No resource selected" />;
  if (isLoading) return <Skeleton className="h-96" />;
  if (error) return <ErrorState message={(error as Error).message} />;
  if (!data) return <EmptyState title="Resource not found" />;

  const { resource } = data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{resource.name}</h1>
        <p className="text-xs text-muted-foreground">
          {resource.resource_group} · {resource.location} ·{" "}
          <span className={healthClass(resource.health_state)}>
            {resource.health_state}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={`px-3 py-2 text-sm ${
              tab === name
                ? "border-b-2 border-primary font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {tab === "Configuration" && (
        <Card>
          <CardContent className="grid gap-3 pt-5 sm:grid-cols-2">
            {[
              ["Resource id", resource.azure_resource_id],
              ["Type", resource.resource_type],
              ["Subscription", resource.subscription_id],
              ["SKU", resource.sku || "—"],
              ["Power state", resource.power_state || "—"],
              ["Owner", resource.owner || "—"],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="break-all text-sm">{value}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {tab === "Cost" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>
                Last 30 days ·{" "}
                {formatMoney(
                  data.cost_last_30_days.amount,
                  data.cost_last_30_days.currency,
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.cost_daily.length ? (
                <CostTrendChart data={data.cost_daily} />
              ) : (
                <EmptyState title="No cost data for this resource" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Charges by meter</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {data.cost_meters.length ? (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Meter</th>
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3 text-right">Quantity</th>
                      <th className="py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cost_meters.map((meter) => (
                      <tr
                        key={`${meter.meter}-${meter.meter_region}`}
                        className="border-t"
                      >
                        <td className="py-2 pr-3">
                          {meter.meter}
                          {meter.is_bandwidth ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              data transfer
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3">{meter.meter_category || "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatQuantity(meter.quantity, meter.unit_of_measure)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatMoney(meter.cost, meter.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState title="No meter-level charges for this resource" />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "Metrics" && (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.metrics.length ? (
            data.metrics.map((series) => (
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
            ))
          ) : (
            <EmptyState
              title="No metrics collected"
              hint="Metrics sync runs every 15 minutes."
            />
          )}
        </div>
      )}

      {tab === "Tags" && (
        <Card>
          <CardContent className="flex flex-wrap gap-2 pt-5">
            {Object.entries(resource.tags ?? {}).length ? (
              Object.entries(resource.tags).map(([k, v]) => (
                <Badge key={k}>
                  {k}: {v}
                </Badge>
              ))
            ) : (
              <EmptyState title="No tags" />
            )}
          </CardContent>
        </Card>
      )}

      {tab === "Dependencies" && (
        <Card>
          <CardContent className="space-y-1 pt-5 text-sm">
            {data.dependencies.length ? (
              data.dependencies.map((dep) => (
                <p key={dep} className="break-all text-muted-foreground">
                  {dep}
                </p>
              ))
            ) : (
              <EmptyState title="No linked resources detected" />
            )}
          </CardContent>
        </Card>
      )}

      {tab === "Activity" && (
        <Card>
          <CardContent className="pt-5">
            {data.activity.length ? (
              <ul className="space-y-2 text-sm">
                {data.activity.map((entry, index) => (
                  <li key={index} className="flex justify-between gap-4">
                    <span>{entry.operation}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {entry.status} · {formatDateTime(entry.event_time)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No recent activity" />
            )}
          </CardContent>
        </Card>
      )}

      {tab === "Alerts" && (
        <Card>
          <CardContent className="space-y-2 pt-5">
            {data.alerts.length ? (
              data.alerts.map((alert) => (
                <div key={alert.id} className="flex items-center gap-3 text-sm">
                  <Badge className={severityClass(alert.severity)}>
                    {alert.severity}
                  </Badge>
                  <span>{alert.title}</span>
                </div>
              ))
            ) : (
              <EmptyState title="No alerts for this resource" />
            )}
          </CardContent>
        </Card>
      )}

      {tab === "Backup" && (
        <Card>
          <CardContent className="pt-5 text-sm">
            {data.backup ? (
              <div className="space-y-1">
                <p>Policy: {data.backup.policy_name || "—"}</p>
                <p>Protection: {data.backup.protection_state}</p>
                <p>Last backup: {data.backup.last_backup_status}</p>
                <p className="text-muted-foreground">
                  {formatDateTime(data.backup.last_backup_time)}
                </p>
              </div>
            ) : (
              <EmptyState title="This resource is not protected by a backup policy" />
            )}
          </CardContent>
        </Card>
      )}

      {tab === "Security" && (
        <Card>
          <CardContent className="space-y-2 pt-5">
            {data.security_findings.length ? (
              data.security_findings.map((finding) => (
                <div key={finding.id} className="flex items-start gap-3 text-sm">
                  <Badge className={severityClass(finding.severity)}>
                    {finding.severity}
                  </Badge>
                  <div>
                    <p>{finding.title}</p>
                    {finding.remediation ? (
                      <p className="text-xs text-muted-foreground">
                        {finding.remediation}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState title="No security findings" />
            )}
          </CardContent>
        </Card>
      )}

      {tab === "Recommendations" && (
        <Card>
          <CardContent className="space-y-3 pt-5">
            {data.recommendations.length ? (
              data.recommendations.map((reco) => (
                <div key={reco.id} className="text-sm">
                  <div className="flex justify-between gap-4">
                    <p className="font-medium">{reco.title}</p>
                    <p className="shrink-0 text-emerald-600">
                      {formatMoney(
                        reco.estimated_monthly_savings,
                        reco.currency,
                      )}
                      /mo
                    </p>
                  </div>
                  <p className="text-muted-foreground">
                    {reco.recommended_action}
                  </p>
                </div>
              ))
            ) : (
              <EmptyState title="No optimization findings" />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function ResourceDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <DetailView />
    </Suspense>
  );
}
