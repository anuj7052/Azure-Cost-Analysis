"use client";

import {
  AuthenticatedTemplate,
  UnauthenticatedTemplate,
  useMsal,
} from "@azure/msal-react";
import {
  Activity,
  BarChart3,
  Bell,
  Boxes,
  FileCode,
  FileText,
  LayoutDashboard,
  Lock,
  Moon,
  Network,
  Settings,
  Sparkles,
  Sun,
  TrendingDown,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { loginRequest, msalInstance } from "@/lib/msal";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/costs", label: "Costs", icon: BarChart3 },
  { href: "/costs/details", label: "Cost details", icon: Network },
  { href: "/optimization", label: "Optimization", icon: TrendingDown },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/security", label: "Security", icon: Lock },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/boq", label: "BOQ to code", icon: FileCode },
  { href: "/assistant", label: "Assistant", icon: Sparkles },
  { href: "/settings", label: "Settings", icon: Settings },
];

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-9 w-9" />;

  return (
    <Button
      variant="ghost"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {resolvedTheme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}

function SignInScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border p-8 text-center">
        <h1 className="text-xl font-semibold">Azure Cloud Insight</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in with your Microsoft Entra ID work account to view your Azure
          estate.
        </p>
        <Button
          className="mt-6 w-full"
          onClick={() => msalInstance.loginRedirect(loginRequest)}
        >
          Sign in with Microsoft
        </Button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { accounts } = useMsal();
  const account = accounts[0];

  return (
    <>
      <UnauthenticatedTemplate>
        <SignInScreen />
      </UnauthenticatedTemplate>

      <AuthenticatedTemplate>
        <div className="flex min-h-screen">
          <aside className="hidden w-60 shrink-0 border-r bg-card md:block">
            <div className="flex h-14 items-center px-5 font-semibold">
              Azure Cloud Insight
            </div>
            <nav className="space-y-1 p-3">
              {NAV.map(({ href, label, icon: Icon }) => {
                const active =
                  href === "/" ? pathname === "/" : pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                );
              })}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 items-center justify-between gap-4 border-b px-5">
              <span className="truncate text-sm text-muted-foreground">
                {account?.username}
              </span>
              <div className="flex items-center gap-2">
                <ThemeToggle />
                <Button
                  variant="outline"
                  onClick={() => msalInstance.logoutRedirect()}
                >
                  Sign out
                </Button>
              </div>
            </header>
            <main className="flex-1 overflow-x-hidden p-5">{children}</main>
          </div>
        </div>
      </AuthenticatedTemplate>
    </>
  );
}
