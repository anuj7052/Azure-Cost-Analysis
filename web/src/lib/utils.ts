import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMoney(amount: number, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: amount >= 1000 ? 0 : 2,
  }).format(amount);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(value: number) {
  if (!value) return "0 B";
  const exponent = Math.min(
    Math.floor(Math.log(Math.abs(value)) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled >= 100 || exponent === 0 ? 0 : 2)} ${BYTE_UNITS[exponent]}`;
}

export function formatQuantity(value: number, unit: string) {
  const digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) < 1 ? 4 : 2;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(value)}${unit ? ` ${unit}` : ""}`;
}

export function formatPrice(value: number, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 6,
  }).format(value);
}

export function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function severityClass(severity: string) {
  switch (severity.toLowerCase()) {
    case "critical":
      return "bg-red-600/10 text-red-600 border-red-600/20";
    case "high":
      return "bg-orange-500/10 text-orange-600 border-orange-500/20";
    case "medium":
      return "bg-amber-500/10 text-amber-600 border-amber-500/20";
    default:
      return "bg-slate-500/10 text-slate-600 border-slate-500/20";
  }
}

export function healthClass(state: string) {
  switch (state.toLowerCase()) {
    case "available":
      return "text-emerald-600";
    case "degraded":
      return "text-amber-600";
    case "unavailable":
      return "text-red-600";
    default:
      return "text-muted-foreground";
  }
}

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  virtual_machine: "Virtual Machines",
  storage_account: "Storage Accounts",
  sql_database: "SQL Databases",
  app_service: "App Services",
  aks_cluster: "AKS Clusters",
  function_app: "Function Apps",
  virtual_network: "Virtual Networks",
  network_security_group: "Network Security Groups",
  load_balancer: "Load Balancers",
  public_ip: "Public IPs",
  key_vault: "Key Vaults",
  recovery_services_vault: "Recovery Services Vaults",
  disk: "Disks",
  snapshot: "Snapshots",
};
