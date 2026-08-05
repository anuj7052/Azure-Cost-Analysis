"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Button,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import {
  RESOURCE_TYPE_LABELS,
  formatMoney,
  healthClass,
} from "@/lib/utils";

const PAGE_SIZE = 25;

export default function InventoryPage() {
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ["resources", type, search, offset],
    queryFn: () =>
      api.resources({ type, search, limit: PAGE_SIZE, offset }),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Inventory</h1>

      <div className="flex flex-wrap gap-2">
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All resource types</option>
          {Object.entries(RESOURCE_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="h-9 flex-1 min-w-48 rounded-md border bg-background px-3 text-sm"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-96" />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title="No resources found"
          hint="Connect a subscription and run an inventory sync."
        />
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="p-3">Name</th>
                      <th className="p-3">Type</th>
                      <th className="p-3">Resource group</th>
                      <th className="p-3">Location</th>
                      <th className="p-3">Health</th>
                      <th className="p-3 text-right">Monthly cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((resource) => (
                      <tr
                        key={resource.id}
                        className="border-b last:border-0 hover:bg-muted/40"
                      >
                        <td className="p-3 font-medium">
                          <Link
                            href={`/inventory/detail?id=${encodeURIComponent(resource.azure_resource_id)}`}
                            className="hover:underline"
                          >
                            {resource.name}
                          </Link>
                        </td>
                        <td className="p-3">
                          <Badge>
                            {RESOURCE_TYPE_LABELS[resource.resource_type] ??
                              resource.resource_type}
                          </Badge>
                        </td>
                        <td className="p-3 text-muted-foreground">
                          {resource.resource_group}
                        </td>
                        <td className="p-3 text-muted-foreground">
                          {resource.location}
                        </td>
                        <td
                          className={`p-3 ${healthClass(resource.health_state)}`}
                        >
                          {resource.health_state}
                        </td>
                        <td className="p-3 text-right">
                          {resource.monthly_cost
                            ? formatMoney(resource.monthly_cost)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of{" "}
              {data.total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
