"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";

const TYPES = [
  "cost_summary",
  "cost_detail",
  "bandwidth",
  "inventory",
  "optimization",
  "security",
  "alerts",
];
const FORMATS = ["pdf", "excel", "csv"];

export default function ReportsPage() {
  const queryClient = useQueryClient();
  const [type, setType] = useState(TYPES[0]);
  const [format, setFormat] = useState(FORMATS[0]);

  const runs = useQuery({ queryKey: ["reports"], queryFn: api.reports });
  const create = useMutation({
    mutationFn: () => api.createReport(type, format),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reports"] }),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Reports</h1>

      <Card>
        <CardHeader>
          <CardTitle>Generate a report</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
          <Button disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Queuing…" : "Generate"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.isLoading ? (
            <Skeleton className="h-32" />
          ) : runs.data?.length ? (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-2">Type</th>
                  <th className="p-2">Format</th>
                  <th className="p-2">State</th>
                  <th className="p-2">Path</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((run) => (
                  <tr key={run.id} className="border-b last:border-0">
                    <td className="p-2">{run.report_type}</td>
                    <td className="p-2 uppercase">{run.export_format}</td>
                    <td className="p-2">{run.state}</td>
                    <td className="p-2 break-all text-muted-foreground">
                      {run.blob_path || run.error || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No reports generated yet" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
