import { useEffect, useMemo, useState } from 'react';
import {
  Activity, ChevronDown, ChevronRight, Server, Globe, AlertTriangle, Info,
  CalendarDays, Terminal, Copy, Check,
} from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { fetchResourceDaily } from '../../api/client';
import { useBandwidthTraffic } from '../../hooks/useBandwidthTraffic';
import ResourceCostTable from './ResourceCostTable';
import { formatAmount, formatRate } from '../../utils/currency';

/**
 * Track bandwidth data — which resource moved it, and what every meter cost.
 *
 * This section must never disappear. The previous version returned null when no
 * tenant was selected, which is indistinguishable from a broken feature: the
 * user saw a heading that was documented to exist and nothing under it. Every
 * state here renders the section and says, in words, why it holds what it holds.
 */

const LEVEL_NOTE = {
  resource: {
    label: 'Resource level',
    tone: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    text: 'Azure attributed these charges to individual resources, so each row below is a specific machine or service.',
  },
  group: {
    label: 'Resource group level',
    tone: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    text: 'Azure would not break these charges down past the resource group for this account, so each row is a group rather than one resource.',
  },
};

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-100">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

/** Why the section is empty, said plainly rather than shown as a blank space. */
function Empty({ icon, title, children }) {
  return (
    <div className="flex gap-3 rounded-lg border border-slate-700/60 bg-slate-900/40 p-4">
      <div className="mt-0.5 shrink-0 text-slate-500">{icon}</div>
      <div>
        <div className="text-sm font-medium text-slate-200">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-slate-400">{children}</div>
      </div>
    </div>
  );
}

/** One resource, expandable into every meter billed against it. */
function ResourceRow({ row, currency, open, onToggle }) {
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-3 text-left hover:bg-slate-800/40"
      >
        <Chevron size={16} className="shrink-0 text-slate-500" />
        <Server size={16} className="shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-100">{row.name}</div>
          <div className="truncate text-[11px] text-slate-500">
            {row.kind}
            {row.resource_group && ` · ${row.resource_group}`}
            {row.region && ` · ${row.region}`}
            {` · ${row.meter_count} meter${row.meter_count === 1 ? '' : 's'}`}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold text-slate-100">
            {formatAmount(row.cost, currency)}
          </div>
          <div className="text-[11px] text-slate-500">
            {row.gb ? `${row.gb.toLocaleString()} GB` : 'no volume billed'}
            {row.cost_per_gb != null && ` · ${formatRate(row.cost_per_gb, currency)}/GB`}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-700/60 p-3">
          <p className="mb-3 text-xs leading-relaxed text-slate-400">{row.explain}</p>

          {/* Every meter with its own price — the per-line answer to
              "which data, and what did it cost". */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-3 font-medium">Meter</th>
                  <th className="pb-2 pr-3 text-right font-medium">Billed quantity</th>
                  <th className="pb-2 pr-3 text-right font-medium">Size</th>
                  <th className="pb-2 pr-3 text-right font-medium">Unit rate</th>
                  <th className="pb-2 pr-3 text-right font-medium">Per GB</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {row.meters.map((m) => (
                  <tr key={m.meter} className="border-b border-slate-800/60 last:border-0">
                    <td className="py-2 pr-3">
                      <div className="text-slate-200">{m.meter}</div>
                      <div className="text-[10px] text-slate-500">{m.category}</div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-300">
                      {m.quantity.toLocaleString()}
                      <span className="ml-1 text-[10px] text-slate-500">{m.unit}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-400">
                      {m.gb ? `${m.gb.toLocaleString()} GB` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-300">
                      {m.unit_rate == null ? (
                        <span className="text-slate-500" title="Azure reported no billed quantity, so there is no rate to divide out">
                          not billed per unit
                        </span>
                      ) : formatRate(m.unit_rate, currency)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-400">
                      {m.cost_per_gb == null ? '—' : formatRate(m.cost_per_gb, currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium text-slate-100">
                      {formatAmount(m.cost, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {row.addresses?.length > 0 && (
            <div className="mt-3 border-t border-slate-800/60 pt-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
                <Globe size={12} /> Public addresses
              </div>
              <div className="flex flex-wrap gap-2">
                {row.addresses.map((a) => (
                  <span
                    key={a.resource_id}
                    title={`${a.name} · matched by ${a.match}`}
                    className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 font-mono text-[11px] text-slate-300"
                  >
                    {a.ip_address || a.name}
                    <span className="ml-1.5 font-sans text-[10px] text-slate-500">{a.match}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* When it happened, and how to find out where it went. Both are
              fetched only on expand — a daily query per resource, run for every
              row up front, would be a large bill for data nobody looked at. */}
          <DailyTrack row={row} currency={currency} />
          <FlowQueries row={row} />
        </div>
      )}
    </div>
  );
}

/** One resource's cost, day by day, with the peak called out. */
function DailyTrack({ row, currency }) {
  const selectedTenantId = useAppStore((s) => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore((s) => s.selectedSubscriptionIds);
  const fromDate = useAppStore((s) => s.fromDate);
  const toDate = useAppStore((s) => s.toDate);
  const months = useAppStore((s) => s.months);

  // Cost Management needs an explicit window for a daily query. Where the page
  // is on a rolling "last N months" filter there is no start date to pass, so
  // one is derived from the same N — the alternative is refusing to load.
  const range = useMemo(() => {
    if (fromDate && toDate) return { from: fromDate, to: toDate };
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - (months || 1));
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }, [fromDate, toDate, months]);

  const [state, setState] = useState({ key: null, data: null, error: null });
  const key = `${row.key}::${range.from}::${range.to}`;

  useEffect(() => {
    let live = true;
    fetchResourceDaily({
      tenant_id: selectedTenantId,
      subscription_ids: selectedSubscriptionIds,
      from_date: range.from,
      to_date: range.to,
      resource_id: row.resource_id || null,
      resource_group: row.resource_id ? null : row.resource_group,
    })
      .then((res) => { if (live) setState({ key, data: res, error: null }); })
      .catch((err) => {
        if (live) {
          setState({
            key,
            data: null,
            error: err?.response?.data?.detail || err?.message || 'Daily detail unavailable.',
          });
        }
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const fresh = state.key === key;
  const daily = fresh ? state.data : null;
  const error = fresh ? state.error : null;
  const peakCost = daily?.days?.reduce((max, d) => Math.max(max, d.cost), 0) || 0;

  return (
    <div className="mt-3 border-t border-slate-800/60 pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
        <CalendarDays size={12} /> Daily data track
      </div>

      {!daily && !error && <div className="h-20 animate-pulse rounded bg-slate-800/40" />}
      {error && <p className="text-[11px] text-amber-400/80">{error}</p>}

      {daily && daily.days.length === 0 && (
        <p className="text-[11px] leading-relaxed text-slate-500">{daily.note}</p>
      )}

      {daily && daily.days.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap gap-4 text-[11px] text-slate-400">
            <span>
              <span className="text-slate-500">Charged days:</span> {daily.charged_day_count} of {daily.day_count}
            </span>
            <span>
              <span className="text-slate-500">Average per charged day:</span>{' '}
              {formatAmount(daily.average_cost, currency)}
            </span>
            {daily.peak && (
              <span>
                <span className="text-slate-500">Peak:</span> {daily.peak.date} ·{' '}
                {formatAmount(daily.peak.cost, currency)}
              </span>
            )}
          </div>

          <div className="max-h-56 overflow-y-auto rounded border border-slate-800/60">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-slate-900">
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Meters that day</th>
                  <th className="px-2 py-1.5 text-right font-medium">Size</th>
                  <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                  <th className="w-24 px-2 py-1.5 font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {daily.days.map((d) => (
                  <tr
                    key={d.date}
                    className={`border-t border-slate-800/60 ${
                      d.date === daily.peak?.date ? 'bg-amber-500/5' : ''
                    }`}
                  >
                    <td className="px-2 py-1.5 tabular-nums text-slate-300">{d.date}</td>
                    <td className="px-2 py-1.5 text-slate-500">
                      {d.meters.map((m) => m.meter).join(', ') || '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">
                      {d.gb ? `${d.gb.toFixed(2)} GB` : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-200">
                      {formatAmount(d.cost, currency)}
                    </td>
                    <td className="px-2 py-1.5">
                      {/* A bar makes a spike visible at a glance; the numbers
                          beside it are what you act on. */}
                      <div className="h-1.5 w-full rounded bg-slate-800">
                        <div
                          className={`h-1.5 rounded ${
                            d.date === daily.peak?.date ? 'bg-amber-400' : 'bg-sky-500'
                          }`}
                          style={{ width: peakCost ? `${(d.cost / peakCost) * 100}%` : '0%' }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{daily.note}</p>
        </>
      )}
    </div>
  );
}

/**
 * The queries that answer "where did the data actually go".
 *
 * Billing stops at "this resource sent 101 GB". Nothing in any cost API knows
 * the destination — that lives in flow logs, in the customer's own Log
 * Analytics workspace. So rather than pretend, hand over the exact query,
 * already scoped to this resource, and say where to run it.
 */
function FlowQueries({ row }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(null);
  const queries = row.kql || [];

  if (queries.length === 0) return null;

  const copy = (q) => {
    navigator.clipboard?.writeText(q.query).then(
      () => setCopied(q.title),
      () => setCopied(null),
    );
  };

  return (
    <div className="mt-3 border-t border-slate-800/60 pt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500 hover:text-slate-300"
      >
        <Terminal size={12} />
        Where did it go — {queries.length} KQL queries
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          <p className="text-[11px] leading-relaxed text-slate-500">
            Run these in <span className="text-slate-400">Log Analytics</span> —
            the workspace your NSG flow logs are sent to. They are already
            filtered to {row.name}, matched by {queries[0].matched_by}.
          </p>

          {queries.map((q) => (
            <div key={q.title} className="rounded border border-slate-800 bg-slate-950/60">
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-slate-200">{q.title}</div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{q.purpose}</div>
                </div>
                <button
                  type="button"
                  onClick={() => copy(q)}
                  className="flex shrink-0 items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-sky-500/50 hover:text-sky-300"
                >
                  {copied === q.title ? <Check size={11} /> : <Copy size={11} />}
                  {copied === q.title ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-[10px] leading-relaxed text-slate-300">
                {q.query}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BandwidthTrackPanel({ currency }) {
  const { ready, data, error, loading } = useBandwidthTraffic();
  const [openRow, setOpenRow] = useState(null);
  const level = LEVEL_NOTE[data?.level] || LEVEL_NOTE.resource;

  return (
    <div className="mt-6 rounded-xl border border-slate-700/60 bg-slate-800/40 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Activity size={18} className="text-sky-400" />
        <h3 className="text-base font-semibold text-slate-100">Track bandwidth data</h3>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-slate-400">
        Which resource moved the data, how much it moved, and what every meter
        charged for it — so the bandwidth line on your bill has a cause you can
        point at.
      </p>

      {/* Each of the following is a reason the section may be empty. None of
          them is allowed to render nothing. */}
      {!ready && (
        <Empty icon={<Info size={18} />} title="Nothing selected yet">
          Choose a tenant and at least one subscription in the top bar. This
          detail is read live from Azure, so it is not available for costs
          imported from a file — an uploaded export has no resource identity in it.
        </Empty>
      )}

      {loading && (
        <div className="animate-pulse space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 rounded-lg bg-slate-700/30" />
          ))}
        </div>
      )}

      {error && (
        <Empty icon={<AlertTriangle size={18} />} title="Could not read the detail">
          {error}
        </Empty>
      )}

      {data && (
        <>
          <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${level.tone}`}>
            <span className="font-semibold">{level.label}.</span>{' '}
            <span className="text-slate-300">{level.text}</span>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Tracked cost"
              value={formatAmount(data.totals.tracked_cost, currency)}
              hint="bandwidth charges traced below"
            />
            <Stat
              label="Tracked volume"
              value={`${(data.totals.tracked_gb || 0).toLocaleString()} GB`}
              hint="from meters billed by volume"
            />
            <Stat
              label="Resources named"
              value={data.totals.named_resource_count}
              hint={`of ${data.totals.row_count} row${data.totals.row_count === 1 ? '' : 's'}`}
            />
            <Stat
              label="Public IPs"
              value={data.totals.ip_count}
              hint={data.totals.idle_ip_count ? `${data.totals.idle_ip_count} attached to nothing` : 'all attached'}
            />
          </div>

          {data.ip_error && (
            <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {data.ip_error}
            </div>
          )}

          {data.rows.length === 0 ? (
            <Empty icon={<Info size={18} />} title="No bandwidth charges in this period">
              Azure returned no data-transfer meters for the selected
              subscriptions and dates. That is a real result, not a failure —
              widen the date range if you expected to see traffic.
            </Empty>
          ) : (
            <>
              {/* The answer in four columns, before any drilling down. Most
                  people want the name and the number, not the anatomy. */}
              <div className="mb-4 rounded-lg border border-slate-700/60 bg-slate-900/30 p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Overview — service, group, size and cost
                </div>
                <ResourceCostTable rows={data.rows} currency={currency} />
              </div>

              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Full breakdown — click any resource for every meter and rate
              </div>
              <div className="space-y-2">
                {data.rows.map((row) => (
                  <ResourceRow
                    key={row.key}
                    row={row}
                    currency={currency}
                    open={openRow === row.key}
                    onToggle={() => setOpenRow(openRow === row.key ? null : row.key)}
                  />
                ))}
              </div>
            </>
          )}

          {data.idle_ips?.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                <AlertTriangle size={14} /> Idle public IPs
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                {data.idle_ips[0].note}
              </p>
              <div className="flex flex-wrap gap-2">
                {data.idle_ips.map((ip) => (
                  <span
                    key={ip.resource_id}
                    title={`${ip.name} in ${ip.resource_group}`}
                    className="rounded border border-amber-500/30 bg-slate-900/60 px-2 py-1 font-mono text-[11px] text-amber-200"
                  >
                    {ip.ip_address || ip.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Say how the numbers were obtained, and where the data stops. */}
          <div className="mt-4 space-y-2 border-t border-slate-700/60 pt-3 text-[11px] leading-relaxed text-slate-500">
            <p>{data.method}</p>
            <p>{data.flow_logs.note}</p>
            {data.flow_logs.how && <p className="text-slate-600">{data.flow_logs.how}</p>}
          </div>
        </>
      )}
    </div>
  );
}
