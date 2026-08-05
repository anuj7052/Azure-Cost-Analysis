"use client";

import { MsalProvider } from "@azure/msal-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";

import { CostFilterProvider } from "@/components/filters/cost-filter-context";
import { msalInstance, msalReady } from "@/lib/msal";

export function Providers({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<Error | null>(null);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  useEffect(() => {
    msalReady.then((error) => {
      setAuthError(error);
      setReady(true);
    });
  }, []);

  if (!ready) return null;

  return (
    <MsalProvider instance={msalInstance}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {authError ? (
            <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              Sign-in failed: {authError.message}
            </div>
          ) : null}
          <CostFilterProvider>{children}</CostFilterProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </MsalProvider>
  );
}
