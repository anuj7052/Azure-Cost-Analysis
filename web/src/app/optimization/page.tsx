"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { formatMoney, severityClass } from "@/lib/utils";

const RULE_LABELS: Record<string, string> = {
  idle_vm: "Idle VM",
  oversized_vm: "Oversized VM",
  stopped_not_deallocated: "Stopped, not deallocated",
  unattached_disk: "Unattached disk",
  unused_public_ip: "Unused public IP",
  old_snapshot: "Old snapshot",
  low_utilization_database: "Low-utilization database",
};

export default function OptimizationPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["recommendations"],
    queryFn: api.recommendations,
  });

  const dismiss = useMutation({
    mutationFn: api.dismissRecommendation,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["recommendations"] }),
  });

  const total =
    data?.reduce((sum, r) => sum + r.estimated_monthly_savings, 0) ?? 0;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Cost optimization</h1>

      <Card>
        <CardHeader>
          <CardTitle>Estimated monthly savings</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-semibold text-emerald-600">
            {formatMoney(total)}
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-64" />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data?.length ? (
        <EmptyState
          title="No optimization findings"
          hint="Findings are generated nightly from metrics and inventory."
        />
      ) : (
        <div className="space-y-3">
          {data.map((reco) => (
            <Card key={reco.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 pt-5">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={severityClass(reco.impact)}>
                      {RULE_LABELS[reco.rule] ?? reco.rule}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      confidence: {reco.confidence}
                    </span>
                  </div>
                  <p className="font-medium">{reco.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {reco.recommended_action}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    {reco.azure_resource_id}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <p className="text-lg font-semibold text-emerald-600">
                    {formatMoney(reco.estimated_monthly_savings, reco.currency)}
                    /mo
                  </p>
                  <Button
                    variant="outline"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(reco.id)}
                  >
                    Dismiss
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
