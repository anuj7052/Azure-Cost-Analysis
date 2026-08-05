"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Coins, Layers, RotateCcw } from "lucide-react";

import {
  useCostFilters,
  type RangeMode,
} from "@/components/filters/cost-filter-context";
import { Button } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const CONTROL =
  "h-9 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring";

const MODES: { value: RangeMode; label: string }[] = [
  { value: "mtd", label: "Month to date" },
  { value: "month", label: "By month" },
  { value: "custom", label: "Custom range" },
];

/** Last 24 calendar months, newest first, as YYYY-MM. */
function recentMonths(count = 24): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

function monthLabel(value: string): string {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export function CostFilterBar({ className }: { className?: string }) {
  const { filters, setFilters, reset } = useCostFilters();

  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    staleTime: 300_000,
  });
  const currencies = useQuery({
    queryKey: ["currencies"],
    queryFn: api.currencies,
    staleTime: Infinity,
  });

  const subscriptions = connections.data ?? [];

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3",
        className,
      )}
    >
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Layers className="h-4 w-4" />
        <span className="sr-only">Subscription</span>
        <select
          className={cn(CONTROL, "min-w-[15rem]")}
          value={filters.subscriptionId}
          onChange={(e) => setFilters({ subscriptionId: e.target.value })}
        >
          <option value="">
            All subscriptions{subscriptions.length ? ` (${subscriptions.length})` : ""}
          </option>
          {subscriptions.map((c) => (
            <option key={c.subscription_id} value={c.subscription_id}>
              {c.display_name || c.subscription_id}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <CalendarRange className="h-4 w-4" />
        <span className="sr-only">Date range</span>
        <select
          className={CONTROL}
          value={filters.mode}
          onChange={(e) => setFilters({ mode: e.target.value as RangeMode })}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {filters.mode === "month" ? (
        <select
          aria-label="Month"
          className={CONTROL}
          value={filters.month}
          onChange={(e) => setFilters({ month: e.target.value })}
        >
          {recentMonths().map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
      ) : null}

      {filters.mode === "custom" ? (
        <div className="flex items-center gap-2">
          <input
            aria-label="Start date"
            type="date"
            className={CONTROL}
            value={filters.start}
            max={filters.end || undefined}
            onChange={(e) => setFilters({ start: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            aria-label="End date"
            type="date"
            className={CONTROL}
            value={filters.end}
            min={filters.start || undefined}
            onChange={(e) => setFilters({ end: e.target.value })}
          />
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Coins className="h-4 w-4" />
        <span className="sr-only">Currency</span>
        <select
          className={CONTROL}
          value={filters.currency}
          onChange={(e) => setFilters({ currency: e.target.value })}
        >
          <option value="">Default</option>
          {(currencies.data?.currencies ?? []).map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>

      <Button
        variant="ghost"
        className="ml-auto text-xs"
        onClick={reset}
        title="Reset filters"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Reset
      </Button>

      {filters.mode === "custom" && !(filters.start && filters.end) ? (
        <p className="w-full text-xs text-muted-foreground">
          Pick both a start and an end date — showing month to date until then.
        </p>
      ) : null}
    </div>
  );
}
