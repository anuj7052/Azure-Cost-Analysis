"use client";

import { acquireToken } from "@/lib/msal";

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await acquireToken();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? "unknown_error",
      error.message ?? response.statusText,
    );
  }
  return body as T;
}

/** Filters shared by every cost-aware endpoint. */
export type CostQuery = {
  subscription_id?: string;
  currency?: string;
  /** Calendar month as YYYY-MM. Ignored when start+end are both set. */
  month?: string;
  start?: string;
  end?: string;
};

function buildQuery(
  filters: CostQuery = {},
  extra: Record<string, string | number | undefined> = {},
): string {
  const query = new URLSearchParams();
  const merged: Record<string, string | number | undefined> = {
    ...extra,
    subscription_id: filters.subscription_id,
    currency: filters.currency,
  };
  // A custom range takes precedence; sending both would be ambiguous.
  if (filters.start && filters.end) {
    merged.start = filters.start;
    merged.end = filters.end;
  } else if (filters.month) {
    merged.month = filters.month;
  }
  Object.entries(merged).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  return query.toString();
}

export const api = {
  dashboard: (filters?: CostQuery) =>
    apiFetch<Dashboard>(`/dashboard?${buildQuery(filters)}`),
  currencies: () => apiFetch<{ currencies: string[] }>("/costs/currencies"),
  me: () => apiFetch<Me>("/me"),
  connections: () => apiFetch<Connection[]>("/connections"),
  createConnection: (payload: {
    subscription_id: string;
    display_name: string;
    azure_tenant_id: string;
    auth_mode?: string;
  }) =>
    apiFetch<Connection>("/connections", {
      method: "POST",
      body: JSON.stringify({ auth_mode: "client_secret", ...payload }),
    }),
  verifyConnection: (connectionId: string) =>
    apiFetch<{
      state: string;
      granted_roles: string[];
      required_roles: string[];
      error: string | null;
    }>(`/connections/${connectionId}/verify`, { method: "POST" }),
  resources: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    );
    return apiFetch<Page<Resource>>(`/resources?${query}`);
  },
  resourceDetail: (resourceId: string) =>
    apiFetch<ResourceDetail>(
      `/resources/detail?resource_id=${encodeURIComponent(resourceId)}`,
    ),
  costTrend: (days = 30, filters?: CostQuery) =>
    apiFetch<TrendPoint[]>(`/costs/trend?${buildQuery(filters, { days })}`),
  costBreakdown: (dimension: string, limit = 10, filters?: CostQuery) =>
    apiFetch<KeyedAmount[]>(
      `/costs/breakdown?${buildQuery(filters, { dimension, limit })}`,
    ),
  anomalies: (filters?: CostQuery) =>
    apiFetch<CostAnomaly[]>(`/costs/anomalies?${buildQuery(filters)}`),
  costMeters: (
    params: { meter_category?: string; limit?: number } = {},
    filters?: CostQuery,
  ) =>
    apiFetch<MeterBreakdown[]>(
      `/costs/meters?${buildQuery(filters, {
        meter_category: params.meter_category,
        limit: params.limit ?? 200,
      })}`,
    ),
  usageDetails: (
    params: {
      meter_category?: string;
      search?: string;
      resource_id?: string;
      limit?: number;
      offset?: number;
    },
    filters?: CostQuery,
  ) => apiFetch<Page<UsageLine>>(`/costs/usage-details?${buildQuery(filters, params)}`),
  bandwidth: (filters?: CostQuery) =>
    apiFetch<BandwidthReport>(`/costs/bandwidth?${buildQuery(filters)}`),
  costDimensions: (filters?: CostQuery) =>
    apiFetch<CostDimensions>(`/costs/dimensions?${buildQuery(filters)}`),
  recommendations: () => apiFetch<Recommendation[]>("/recommendations"),
  dismissRecommendation: (id: string) =>
    apiFetch<Recommendation>(`/recommendations/${id}/dismiss`, {
      method: "POST",
    }),
  securitySummary: () => apiFetch<SecuritySummary>("/security/summary"),
  exposures: () => apiFetch<NetworkExposure[]>("/security/exposures"),
  alerts: () => apiFetch<Alert[]>("/alerts"),
  acknowledgeAlert: (id: string) =>
    apiFetch<Alert>(`/alerts/${id}/acknowledge`, { method: "POST" }),
  syncStatus: () => apiFetch<SyncStatus[]>("/sync/status"),
  triggerSync: (kind: string) =>
    apiFetch<{ queued: boolean }>(`/sync/${kind}`, { method: "POST" }),
  askAssistant: (question: string, resourceId?: string) =>
    apiFetch<AssistantAnswer>("/assistant/ask", {
      method: "POST",
      body: JSON.stringify({ question, resource_id: resourceId }),
    }),
  createReport: (reportType: string, exportFormat: string) =>
    apiFetch<ReportRun>("/reports", {
      method: "POST",
      body: JSON.stringify({
        report_type: reportType,
        export_format: exportFormat,
      }),
    }),
  reports: () => apiFetch<ReportRun[]>("/reports"),
};

// --- types mirroring the API schemas ---------------------------------
export interface Money {
  amount: number;
  currency: string;
}
export interface KeyedAmount {
  key: string;
  cost: number;
  currency: string;
}
export interface TrendPoint {
  date: string;
  cost: number;
}
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface Me {
  tenant_id: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
}
export interface Connection {
  id: string;
  subscription_id: string;
  display_name: string;
  state: string;
  granted_roles: string[];
  is_enabled: boolean;
  last_error: string | null;
}
export interface Dashboard {
  period_start: string;
  period_end: string;
  currency: string;
  month_to_date_cost: Money;
  forecast_month_cost: Money;
  forecast_source: string;
  previous_month_cost: Money;
  cost_change_pct: number;
  total_resources: number;
  resources_by_type: Record<string, number>;
  health: Record<string, number>;
  active_alerts: number;
  secure_score_pct: number | null;
  advisor_recommendations: number;
  potential_monthly_savings: Money;
  cost_by_subscription: KeyedAmount[];
  cost_by_resource_group: KeyedAmount[];
  cost_by_service: KeyedAmount[];
  daily_trend: TrendPoint[];
  last_sync_at: string | null;
}
export interface Resource {
  id: string;
  azure_resource_id: string;
  name: string;
  resource_type: string;
  subscription_id: string;
  resource_group: string;
  location: string;
  sku: string;
  power_state: string;
  health_state: string;
  owner: string;
  tags: Record<string, string>;
  monthly_cost: number | null;
}
export interface MetricPoint {
  timestamp: string;
  average: number | null;
  maximum: number | null;
  total: number | null;
  unit: string;
}
export interface MetricSeries {
  metric: string;
  points: MetricPoint[];
}
export interface Recommendation {
  id: string;
  azure_resource_id: string;
  resource_name: string;
  rule: string;
  title: string;
  recommended_action: string;
  estimated_monthly_savings: number;
  currency: string;
  impact: string;
  confidence: string;
  state: string;
  evidence: Record<string, unknown>;
}
export interface SecurityFinding {
  id: string;
  title: string;
  severity: string;
  status: string;
  remediation: string | null;
}
export interface Alert {
  id: string;
  rule: string;
  title: string;
  description: string;
  severity: string;
  state: string;
  azure_resource_id: string;
  triggered_at: string;
}
export interface ResourceDetail {
  resource: Resource;
  cost_last_30_days: Money;
  cost_daily: TrendPoint[];
  cost_meters: MeterBreakdown[];
  metrics: MetricSeries[];
  dependencies: string[];
  activity: {
    event_time: string;
    operation: string;
    status: string;
    caller: string;
  }[];
  alerts: Alert[];
  backup: {
    policy_name: string;
    protection_state: string;
    last_backup_status: string;
    last_backup_time: string | null;
  } | null;
  security_findings: SecurityFinding[];
  recommendations: Recommendation[];
}
export interface SecuritySummary {
  secure_score_pct: number | null;
  findings_by_severity: Record<string, number>;
  expiring_secrets: number;
  risky_identities: number;
  users_without_mfa: number;
  open_exposures: number;
}
export interface NetworkExposure {
  id: string;
  nsg_name: string;
  rule_name: string;
  direction: string;
  priority: number;
  protocol: string;
  source: string;
  ports: (string | number)[];
  severity: string;
  reason: string;
}
export interface MeterBreakdown {
  meter_category: string;
  meter_subcategory: string;
  meter: string;
  meter_region: string;
  unit_of_measure: string;
  quantity: number;
  cost: number;
  effective_price: number;
  currency: string;
  is_bandwidth: boolean;
}
export interface UsageLine {
  usage_date: string;
  subscription_id: string;
  azure_resource_id: string;
  resource_name: string;
  resource_group: string;
  resource_type: string;
  resource_location: string;
  service_name: string;
  meter: string;
  meter_id: string;
  meter_category: string;
  meter_subcategory: string;
  meter_region: string;
  service_family: string;
  product: string;
  part_number: string;
  quantity: number;
  unit_of_measure: string;
  unit_price: number;
  effective_price: number;
  cost: number;
  amortized_cost: number;
  currency: string;
  charge_type: string;
  frequency: string;
  pricing_model: string;
  publisher_type: string;
  benefit_name: string;
  reservation_id: string;
  additional_info: Record<string, unknown>;
  tags: Record<string, string>;
}
export interface DataTransferPoint {
  date: string;
  billed_cost: number;
  billed_quantity_gb: number;
  ingress_bytes: number;
  egress_bytes: number;
}
export interface DataTransferResource {
  azure_resource_id: string;
  resource_name: string;
  resource_type: string;
  resource_group: string;
  location: string;
  ingress_bytes: number;
  egress_bytes: number;
  billed_cost: number;
  ip_addresses: string[];
}
export interface PublicIp {
  azure_resource_id: string;
  name: string;
  ip_address: string;
  allocation_method: string;
  version: string;
  sku: string;
  resource_group: string;
  location: string;
  attached_to_id: string;
  attached_to_name: string;
  is_attached: boolean;
  ingress_bytes: number;
  egress_bytes: number;
  billed_cost: number;
}
export interface BandwidthReport {
  period_start: string;
  period_end: string;
  currency: string;
  total_billed_cost: number;
  total_billed_quantity_gb: number;
  total_ingress_bytes: number;
  total_egress_bytes: number;
  ingress_is_free: boolean;
  daily: DataTransferPoint[];
  meters: MeterBreakdown[];
  top_resources: DataTransferResource[];
  public_ips: PublicIp[];
}
export interface CostDimensions {
  meter_categories: string[];
  meter_subcategories: string[];
  charge_types: string[];
  pricing_models: string[];
  services: string[];
  regions: string[];
}
export interface CostAnomaly {
  service: string;
  date: string;
  cost: number;
  baseline: number;
  delta: number;
  delta_pct: number | null;
}
export interface SyncStatus {
  kind: string;
  state: string;
  finished_at: string | null;
  items_synced: number;
  error: string | null;
}
export interface AssistantAnswer {
  answer: string;
  used_tools: string[];
  citations: { tool: string; data: unknown }[];
}
export interface ReportRun {
  id: string;
  report_type: string;
  export_format: string;
  state: string;
  blob_path: string;
  error: string | null;
}
