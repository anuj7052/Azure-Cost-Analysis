"use client";

import { useQuery } from "@tanstack/react-query";

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
import { severityClass } from "@/lib/utils";

export default function SecurityPage() {
  const summary = useQuery({
    queryKey: ["security-summary"],
    queryFn: api.securitySummary,
  });
  const exposures = useQuery({
    queryKey: ["exposures"],
    queryFn: api.exposures,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Security &amp; networking</h1>

      {summary.isLoading ? (
        <Skeleton className="h-28" />
      ) : summary.error ? (
        <ErrorState message={(summary.error as Error).message} />
      ) : summary.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[
            [
              "Secure score",
              summary.data.secure_score_pct === null
                ? "—"
                : `${summary.data.secure_score_pct.toFixed(0)}%`,
            ],
            ["Expiring secrets (30d)", summary.data.expiring_secrets],
            ["Risky identities", summary.data.risky_identities],
            ["Users without MFA", summary.data.users_without_mfa],
            ["Open network exposures", summary.data.open_exposures],
            [
              "High severity findings",
              summary.data.findings_by_severity.High ?? 0,
            ],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <CardHeader>
                <CardTitle>{label}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>NSG rule exposures</CardTitle>
        </CardHeader>
        <CardContent>
          {exposures.isLoading ? (
            <Skeleton className="h-40" />
          ) : exposures.data?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2">Severity</th>
                    <th className="p-2">NSG</th>
                    <th className="p-2">Rule</th>
                    <th className="p-2">Source</th>
                    <th className="p-2">Ports</th>
                    <th className="p-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {exposures.data.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="p-2">
                        <Badge className={severityClass(e.severity)}>
                          {e.severity}
                        </Badge>
                      </td>
                      <td className="p-2">{e.nsg_name}</td>
                      <td className="p-2">{e.rule_name}</td>
                      <td className="p-2 text-muted-foreground">{e.source}</td>
                      <td className="p-2">{e.ports.join(", ")}</td>
                      <td className="p-2 text-muted-foreground">{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No risky NSG rules detected" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
