"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import type { CostQuery } from "@/lib/api";

export type RangeMode = "mtd" | "month" | "custom";

export type CostFilterState = {
  subscriptionId: string;
  currency: string;
  mode: RangeMode;
  /** YYYY-MM, used when mode === "month". */
  month: string;
  start: string;
  end: string;
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const DEFAULT_STATE: CostFilterState = {
  subscriptionId: "",
  currency: "",
  mode: "mtd",
  month: currentMonth(),
  start: "",
  end: "",
};

type ContextValue = {
  filters: CostFilterState;
  setFilters: (patch: Partial<CostFilterState>) => void;
  reset: () => void;
  /** Serialised form handed to the API client and used as a react-query key. */
  query: CostQuery;
};

const CostFilterContext = createContext<ContextValue | null>(null);

export function CostFilterProvider({ children }: { children: React.ReactNode }) {
  const [filters, setState] = useState<CostFilterState>(DEFAULT_STATE);

  const setFilters = useCallback((patch: Partial<CostFilterState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => setState(DEFAULT_STATE), []);

  const query = useMemo<CostQuery>(() => {
    const base: CostQuery = {
      subscription_id: filters.subscriptionId || undefined,
      currency: filters.currency || undefined,
    };
    if (filters.mode === "month" && filters.month) {
      return { ...base, month: filters.month };
    }
    // A custom range needs both ends; a half-filled range falls back to
    // month-to-date rather than sending a window the API would reject.
    if (filters.mode === "custom" && filters.start && filters.end) {
      return { ...base, start: filters.start, end: filters.end };
    }
    return base;
  }, [filters]);

  const value = useMemo(
    () => ({ filters, setFilters, reset, query }),
    [filters, setFilters, reset, query],
  );

  return (
    <CostFilterContext.Provider value={value}>
      {children}
    </CostFilterContext.Provider>
  );
}

export function useCostFilters(): ContextValue {
  const context = useContext(CostFilterContext);
  if (!context) {
    throw new Error("useCostFilters must be used inside a CostFilterProvider");
  }
  return context;
}
