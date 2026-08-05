"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { DataTransferChart } from "@/components/charts/charts";
import { CostFilterBar } from "@/components/filters/cost-filter-bar";
import { useCostFilters } from "@/components/filters/cost-filter-context";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@/components/ui/primitives";
import { api } from "@/lib/api";
import {
  formatBytes,
  formatMoney,
  formatPrice,
  formatQuantity,
} from "@/lib/utils";

type Tab = "meters" | "lines" | "bandwidth";

const TABS: { id: Tab; label: string }[] = [
  { id: "meters", label: "Meters" },
  { id: "lines", label: "Billing lines" },
  { id: "bandwidth", label: "Bandwidth & transfer" },
];

const PAGE_SIZE = 100;

export default function CostDetailsPage() {
  const { query } = useCostFilters();
  const [tab, setTab] = useState<Tab>("meters");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const dimensions = useQuery({
    queryKey: ["cost-dimensions", query],
    queryFn: () => api.costDimensions(query),
  });

  const meters = useQuery({
    queryKey: ["cost-meters", category, query],
    queryFn: () =>
      api.costMeters({ meter_category: category || undefined }, query),
    enabled: tab === "meters",
  });

  const lines = useQuery({
    queryKey: ["usage-details", category, search, offset, query],
    queryFn: () =>
      api.usageDetails(
        {
          meter_category: category || undefined,
          search: search || undefined,
          limit: PAGE_SIZE,
          offset,
        },
        query,
      ),
    enabled: tab === "lines",
  });

  const bandwidth = useQuery({
    queryKey: ["bandwidth", query],
    queryFn: () => api.bandwidth(query),
    enabled: tab === "bandwidth",
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Cost details</h1>
        <p className="text-sm text-muted-foreground">
          Every billing line at meter grain — including egress, inter-region
          transfer, request charges and reservation amortisation that the
          portal&apos;s default views roll up into a single service total.
        </p>
      </div>
      <CostFilterBar />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((item) => (
          <Button
            key={item.id}
            variant={tab === item.id ? "default" : "outline"}
            onClick={() => {
              setTab(item.id);
              setOffset(0);
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {tab !== "bandwidth" ? (
        <div className="flex flex-wrap gap-2">
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All meter categories</option>
            {dimensions.data?.meter_categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {tab === "lines" ? (
            <input
              className="h-9 flex-1 min-w-[220px] rounded-md border bg-background px-3 text-sm"
              placeholder="Search meter, product or resource…"
              value={search}
              maxLength={128}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          ) : null}
        </div>
      ) : null}

      {tab === "meters" ? (
        <Card>
          <CardHeader>
            <CardTitle>Billed meters</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {meters.isLoading ? (
              <Skeleton className="h-64" />
            ) : meters.error ? (
              <ErrorState message={(meters.error as Error).message} />
            ) : meters.data?.length ? (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Meter</th>
                    <th className="py-2 pr-3">Category</th>
                    <th className="py-2 pr-3">Region</th>
                    <th className="py-2 pr-3 text-right">Quantity</th>
                    <th className="py-2 pr-3 text-right">Unit price</th>
                    <th className="py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {meters.data.map((meter) => (
                    <tr
                      key={`${meter.meter_category}-${meter.meter}-${meter.meter_region}`}
                      className="border-t"
                    >
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <span>{meter.meter || "—"}</span>
                          {meter.is_bandwidth ? <Badge>transfer</Badge> : null}
                        </div>
                        {meter.meter_subcategory ? (
                          <span className="text-xs text-muted-foreground">
                            {meter.meter_subcategory}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{meter.meter_category || "—"}</td>
                      <td className="py-2 pr-3">{meter.meter_region || "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatQuantity(meter.quantity, meter.unit_of_measure)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatPrice(meter.effective_price, meter.currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(meter.cost, meter.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState
                title="No meter data yet"
                hint="Run a cost sync from Settings once a subscription is connected."
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      {tab === "lines" ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Raw billing lines
              {lines.data ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {lines.data.total.toLocaleString()} rows
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 overflow-x-auto">
            {lines.isLoading ? (
              <Skeleton className="h-64" />
            ) : lines.error ? (
              <ErrorState message={(lines.error as Error).message} />
            ) : lines.data?.items.length ? (
              <>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Resource</th>
                      <th className="py-2 pr-3">Meter</th>
                      <th className="py-2 pr-3">Charge</th>
                      <th className="py-2 pr-3 text-right">Quantity</th>
                      <th className="py-2 pr-3 text-right">Unit price</th>
                      <th className="py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.data.items.map((line, index) => (
                      <tr key={`${line.meter_id}-${index}`} className="border-t">
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {line.usage_date}
                        </td>
                        <td className="py-2 pr-3">
                          <div>{line.resource_name || "—"}</div>
                          <span className="text-xs text-muted-foreground">
                            {line.resource_group} · {line.resource_location}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <div>{line.meter}</div>
                          <span className="text-xs text-muted-foreground">
                            {line.meter_category}
                            {line.meter_subcategory
                              ? ` / ${line.meter_subcategory}`
                              : ""}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <Badge>{line.charge_type}</Badge>
                          {line.pricing_model ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              {line.pricing_model}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatQuantity(line.quantity, line.unit_of_measure)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatPrice(
                            line.effective_price || line.unit_price,
                            line.currency,
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatMoney(line.cost, line.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between text-sm">
                  <Button
                    variant="outline"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <span className="text-muted-foreground">
                    {offset + 1}–
                    {Math.min(offset + PAGE_SIZE, lines.data.total)} of{" "}
                    {lines.data.total.toLocaleString()}
                  </span>
                  <Button
                    variant="outline"
                    disabled={offset + PAGE_SIZE >= lines.data.total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </>
            ) : (
              <EmptyState title="No billing lines for this filter" />
            )}
          </CardContent>
        </Card>
      ) : null}

      {tab === "bandwidth" ? (
        bandwidth.isLoading ? (
          <Skeleton className="h-96" />
        ) : bandwidth.error ? (
          <ErrorState message={(bandwidth.error as Error).message} />
        ) : bandwidth.data ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs text-muted-foreground">Egress measured</p>
                  <p className="text-lg font-semibold">
                    {formatBytes(bandwidth.data.total_egress_bytes)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs text-muted-foreground">
                    Ingress measured (free)
                  </p>
                  <p className="text-lg font-semibold">
                    {formatBytes(bandwidth.data.total_ingress_bytes)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs text-muted-foreground">Billed transfer</p>
                  <p className="text-lg font-semibold">
                    {bandwidth.data.total_billed_quantity_gb.toFixed(2)} GB
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs text-muted-foreground">Transfer cost</p>
                  <p className="text-lg font-semibold">
                    {formatMoney(
                      bandwidth.data.total_billed_cost,
                      bandwidth.data.currency,
                    )}
                  </p>
                </CardContent>
              </Card>
            </div>

            <p className="text-xs text-muted-foreground">
              Azure does not charge for inbound data, so ingress never appears in
              Cost Management. The ingress and egress volumes here come from Azure
              Monitor throughput metrics; the cost line comes from billing.
            </p>

            <Card>
              <CardHeader>
                <CardTitle>Daily transfer volume vs. billed cost</CardTitle>
              </CardHeader>
              <CardContent>
                {bandwidth.data.daily.length ? (
                  <DataTransferChart data={bandwidth.data.daily} />
                ) : (
                  <EmptyState title="No transfer data for this period" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Top talkers</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {bandwidth.data.top_resources.length ? (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Resource</th>
                        <th className="py-2 pr-3">Public IP</th>
                        <th className="py-2 pr-3">Location</th>
                        <th className="py-2 pr-3 text-right">Ingress</th>
                        <th className="py-2 pr-3 text-right">Egress</th>
                        <th className="py-2 text-right">Total cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bandwidth.data.top_resources.map((item) => (
                        <tr key={item.azure_resource_id} className="border-t">
                          <td className="py-2 pr-3">
                            <div>{item.resource_name || "—"}</div>
                            <span className="text-xs text-muted-foreground">
                              {item.resource_group}
                            </span>
                          </td>
                          <td className="py-2 pr-3 tabular-nums">
                            {item.ip_addresses.length
                              ? item.ip_addresses.join(", ")
                              : "—"}
                          </td>
                          <td className="py-2 pr-3">{item.location || "—"}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatBytes(item.ingress_bytes)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatBytes(item.egress_bytes)}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {formatMoney(
                              item.billed_cost,
                              bandwidth.data.currency,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState
                    title="No network metrics yet"
                    hint="Ingress/egress volumes are collected by the metrics sync."
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Public IP addresses</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {bandwidth.data.public_ips.length ? (
                  <>
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="py-2 pr-3">IP address</th>
                          <th className="py-2 pr-3">Name</th>
                          <th className="py-2 pr-3">Attached to</th>
                          <th className="py-2 pr-3">SKU / allocation</th>
                          <th className="py-2 pr-3 text-right">Ingress</th>
                          <th className="py-2 pr-3 text-right">Egress</th>
                          <th className="py-2 text-right">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bandwidth.data.public_ips.map((ip) => (
                          <tr key={ip.azure_resource_id} className="border-t">
                            <td className="py-2 pr-3 font-medium tabular-nums">
                              {ip.ip_address || "—"}
                            </td>
                            <td className="py-2 pr-3">
                              <div>{ip.name}</div>
                              <span className="text-xs text-muted-foreground">
                                {ip.resource_group} · {ip.location}
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              {ip.is_attached ? (
                                ip.attached_to_name || "—"
                              ) : (
                                <Badge>idle — not attached</Badge>
                              )}
                            </td>
                            <td className="py-2 pr-3">
                              {[ip.sku, ip.allocation_method, ip.version]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {formatBytes(ip.ingress_bytes)}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {formatBytes(ip.egress_bytes)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoney(ip.billed_cost, bandwidth.data.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Azure meters throughput per resource, not per address, so
                      volume shown here is that of the machine the IP is bound
                      to. Per-flow detail (source/destination IP and port)
                      requires NSG or VNet flow logs.
                    </p>
                  </>
                ) : (
                  <EmptyState
                    title="No public IP addresses found"
                    hint="Public IPs are discovered by the inventory sync."
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Data-transfer meters</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {bandwidth.data.meters.length ? (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Meter</th>
                        <th className="py-2 pr-3">Region</th>
                        <th className="py-2 pr-3 text-right">Quantity</th>
                        <th className="py-2 text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bandwidth.data.meters.map((meter) => (
                        <tr
                          key={`${meter.meter}-${meter.meter_region}`}
                          className="border-t"
                        >
                          <td className="py-2 pr-3">{meter.meter}</td>
                          <td className="py-2 pr-3">{meter.meter_region || "—"}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatQuantity(meter.quantity, meter.unit_of_measure)}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {formatMoney(meter.cost, meter.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="No data-transfer meters billed in this period" />
                )}
              </CardContent>
            </Card>
          </div>
        ) : null
      ) : null}
    </div>
  );
}
