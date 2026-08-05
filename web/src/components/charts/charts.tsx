"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  DataTransferPoint,
  KeyedAmount,
  MetricSeries,
  TrendPoint,
} from "@/lib/api";
import { formatBytes, formatMoney } from "@/lib/utils";

const PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 11 };

export function CostTrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="date" tick={AXIS} tickLine={false} />
        <YAxis tick={AXIS} tickLine={false} width={60} />
        <Tooltip formatter={(v: number) => formatMoney(v)} />
        <Area
          type="monotone"
          dataKey="cost"
          stroke="#3b82f6"
          fill="url(#costFill)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function BreakdownBarChart({ data }: { data: KeyedAmount[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} />
        <YAxis
          type="category"
          dataKey="key"
          tick={AXIS}
          width={150}
          tickLine={false}
        />
        <Tooltip formatter={(v: number) => formatMoney(v)} />
        <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
          {data.map((_, index) => (
            <Cell key={index} fill={PALETTE[index % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BreakdownPieChart({ data }: { data: KeyedAmount[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={data}
          dataKey="cost"
          nameKey="key"
          innerRadius={55}
          outerRadius={95}
          paddingAngle={2}
        >
          {data.map((_, index) => (
            <Cell key={index} fill={PALETTE[index % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => formatMoney(v)} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function MetricChart({ series }: { series: MetricSeries }) {
  const data = series.points.map((p) => ({
    time: new Date(p.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    value: p.average ?? p.total ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="time" tick={AXIS} tickLine={false} minTickGap={40} />
        <YAxis tick={AXIS} tickLine={false} width={50} />
        <Tooltip />
        <Line
          type="monotone"
          dataKey="value"
          stroke="#10b981"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function DataTransferChart({ data }: { data: DataTransferPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="date" tick={AXIS} tickLine={false} minTickGap={24} />
        <YAxis
          yAxisId="bytes"
          tick={AXIS}
          tickLine={false}
          width={70}
          tickFormatter={(v: number) => formatBytes(v)}
        />
        <YAxis
          yAxisId="cost"
          orientation="right"
          tick={AXIS}
          tickLine={false}
          width={70}
          tickFormatter={(v: number) => formatMoney(v)}
        />
        <Tooltip
          formatter={(value: number, name: string) =>
            name === "Billed egress cost"
              ? formatMoney(value)
              : formatBytes(value)
          }
        />
        <Legend />
        <Bar
          yAxisId="bytes"
          dataKey="ingress_bytes"
          name="Ingress (free)"
          fill="#10b981"
          radius={[3, 3, 0, 0]}
        />
        <Bar
          yAxisId="bytes"
          dataKey="egress_bytes"
          name="Egress (measured)"
          fill="#3b82f6"
          radius={[3, 3, 0, 0]}
        />
        <Line
          yAxisId="cost"
          type="monotone"
          dataKey="billed_cost"
          name="Billed egress cost"
          stroke="#f59e0b"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
