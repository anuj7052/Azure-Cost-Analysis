"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { formatDateTime, severityClass } from "@/lib/utils";

export default function AlertsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["alerts"],
    queryFn: api.alerts,
    refetchInterval: 30_000,
  });

  const acknowledge = useMutation({
    mutationFn: api.acknowledgeAlert,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Alerts</h1>

      {isLoading ? (
        <Skeleton className="h-64" />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data?.length ? (
        <EmptyState title="No active alerts" hint="Rules are evaluated every 20 minutes." />
      ) : (
        <div className="space-y-3">
          {data.map((alert) => (
            <Card key={alert.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 pt-5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge className={severityClass(alert.severity)}>
                      {alert.severity}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(alert.triggered_at)}
                    </span>
                  </div>
                  <p className="mt-1 font-medium">{alert.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {alert.description}
                  </p>
                  {alert.azure_resource_id ? (
                    <p className="break-all text-xs text-muted-foreground">
                      {alert.azure_resource_id}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  disabled={acknowledge.isPending}
                  onClick={() => acknowledge.mutate(alert.id)}
                >
                  Acknowledge
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
