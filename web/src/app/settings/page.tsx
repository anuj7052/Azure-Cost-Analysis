"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

const SYNC_KINDS = [
  "inventory",
  "cost",
  "metrics",
  "activity",
  "security",
  "recommendations",
];

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [subscriptionId, setSubscriptionId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
  });
  const status = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    refetchInterval: 15_000,
  });

  const trigger = useMutation({
    mutationFn: api.triggerSync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sync-status"] }),
  });

  const create = useMutation({
    mutationFn: api.createConnection,
    onSuccess: () => {
      setSubscriptionId("");
      setDisplayName("");
      queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
  });

  const verify = useMutation({
    mutationFn: api.verifyConnection,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  const canManage = me.data?.permissions.includes("connections:manage");
  const canSync = me.data?.permissions.includes("sync:trigger");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Signed in as</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {me.isLoading ? (
            <Skeleton className="h-12" />
          ) : me.data ? (
            <>
              <p className="font-medium">{me.data.name || me.data.email}</p>
              <p className="text-muted-foreground">
                Role: {me.data.role} · Tenant: {me.data.tenant_id}
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected subscriptions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {connections.isLoading ? (
            <Skeleton className="h-24" />
          ) : connections.data?.length ? (
            connections.data.map((connection) => (
              <div
                key={connection.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium">{connection.display_name}</p>
                  <p className="break-all text-xs text-muted-foreground">
                    {connection.subscription_id}
                  </p>
                  {connection.last_error ? (
                    <p className="text-xs text-destructive">
                      {connection.last_error}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {connection.granted_roles.map((role) => (
                    <Badge key={role}>{role}</Badge>
                  ))}
                  <Badge>{connection.state}</Badge>
                  {canManage ? (
                    <Button
                      variant="outline"
                      disabled={verify.isPending}
                      onClick={() => verify.mutate(String(connection.id))}
                    >
                      Verify
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <EmptyState
              title="No subscriptions connected"
              hint={
                canManage
                  ? "Assign the app's service principal Reader + Cost Management Reader, then add the subscription."
                  : "Ask an administrator to connect a subscription."
              }
            />
          )}

          {canManage ? (
            <form
              className="space-y-2 rounded-md border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                create.mutate({
                  subscription_id: subscriptionId.trim(),
                  display_name: displayName.trim() || subscriptionId.trim(),
                  azure_tenant_id: me.data?.tenant_id ?? "",
                });
              }}
            >
              <p className="text-sm font-medium">Add a subscription</p>
              <div className="flex flex-wrap gap-2">
                <input
                  required
                  className="min-w-[22rem] flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Subscription ID (GUID)"
                  value={subscriptionId}
                  onChange={(event) => setSubscriptionId(event.target.value)}
                />
                <input
                  className="min-w-[12rem] flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Display name (optional)"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? "Adding…" : "Add"}
                </Button>
              </div>
              {create.isError ? (
                <p className="text-xs text-destructive">
                  {(create.error as Error).message}
                </p>
              ) : null}
              {verify.isError ? (
                <p className="text-xs text-destructive">
                  {(verify.error as Error).message}
                </p>
              ) : null}
            </form>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data synchronisation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {status.isLoading ? (
            <Skeleton className="h-32" />
          ) : (
            status.data?.map((run) => (
              <div
                key={run.kind}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <div>
                  <p className="font-medium capitalize">{run.kind}</p>
                  <p className="text-xs text-muted-foreground">
                    {run.state} · {formatDateTime(run.finished_at)} ·{" "}
                    {run.items_synced} items
                  </p>
                  {run.error ? (
                    <p className="text-xs text-destructive">{run.error}</p>
                  ) : null}
                </div>
                {canSync && SYNC_KINDS.includes(run.kind) ? (
                  <Button
                    variant="outline"
                    disabled={trigger.isPending}
                    onClick={() => trigger.mutate(run.kind)}
                  >
                    Sync now
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
