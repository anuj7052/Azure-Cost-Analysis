import { useEffect, useState } from 'react';
import {
  AlertTriangle, CalendarDays, Clock, Loader2, Power, PowerOff, TrendingUp, User,
} from 'lucide-react';
import {
  Bar, BarChart, Cell, ResponsiveContainer, ReferenceLine, Tooltip, XAxis, YAxis,
} from 'recharts';
import DetailPanel from './DetailPanel';
import { fetchUsageDetail } from '../../api/client';
import { formatAmount } from '../../utils/currency';
import { exactAmount } from '../../utils/exact';
import { useAppStore } from '../../store/useAppStore';

/**
 * A quantity, taken apart day by day.
 *
 * "720 → 738.98" is true and useless. The same 739 hours can be a machine that
 * ran continuously, a machine left on over one weekend that should have been
 * off, or a second instance that appeared for a day — three different problems
 * with three different fixes, and the monthly total cannot tell them apart.
 *
 * So the month is drawn as days. A full day, a partial day and a day off look
 * different at a glance, the cost of each is beside it, and the Activity Log's
 * start and stop operations are placed on the days they happened, with the
 * person who issued them. That turns "it used more hours" into "it was started
 * on the 14th at 08:12 by anna@ and never stopped".
 *
 * Two honest limits are shown rather than hidden. Cost Management reports
 * *billed* quantity, not power state — a resource can stop being billed for
 * reasons other than being switched off, so partial days are described as
 * "billed less than a full day" and not asserted as downtime. And Azure keeps
 * roughly 90 days of Activity Log, so an older month has no events at all,
 * which is said out loud because it looks identical to a month in which nobody
 * touched anything.
 */

const STATE_STYLE = {
  full: { fill: '#3b82f6', label: 'Full day', tone: 'text-blue-300' },
  partial: { fill: '#f59e0b', label: 'Part day', tone: 'text-amber-300' },
  high: { fill: '#a855f7', label: 'Above normal', tone: 'text-purple-300' },
  off: { fill: '#334155', label: 'Nothing billed', tone: 'text-slate-400' },
};

function Section({ title, subtitle, badge, children }) {
  return (
    <section className="border border-slate-800 rounded-2xl overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 py-3 bg-slate-800/40 border-b border-slate-800">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {subtitle && <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{subtitle}</p>}
        </div>
        {badge}
      </header>
      <div className="px-4 py-3.5 space-y-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, tone = 'text-slate-200', hint }) {
  return (
    <div className="bg-slate-800/50 rounded-lg px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className={`text-xs font-bold mt-0.5 tabular-nums ${tone}`}>{value ?? '—'}</p>
      {hint && <p className="text-[9px] text-slate-600 mt-0.5 leading-tight">{hint}</p>}
    </div>
  );
}

/** The sentence that says what shape this month actually was. */
function shapeOf(summary, currency) {
  if (!summary || !summary.days_in_month) return null;

  const { days_off: off, days_partial: partial, days_above_normal: high, days_in_month: total } = summary;
  const unit = summary.is_duration ? 'hours' : 'units';

  if (!summary.days_billed) {
    return { icon: PowerOff, tone: 'text-slate-400', text: 'Nothing was billed on this meter in this month.' };
  }
  if (!off && !partial && !high) {
    return {
      icon: Clock,
      tone: 'text-blue-300',
      text: `Billed at the same level on all ${total} days — this ran continuously, with no day off and no day short.`,
    };
  }

  const parts = [];
  if (off) parts.push(`${off} day${off === 1 ? '' : 's'} with nothing billed`);
  if (partial) parts.push(`${partial} part-day${partial === 1 ? '' : 's'}`);
  if (high) parts.push(`${high} day${high === 1 ? '' : 's'} above the normal level`);

  const saved = summary.avoided_cost
    ? ` The ${summary.unbilled_hours ? `${summary.unbilled_hours} ${unit}` : `${summary.unbilled_units} ${unit}`} not billed were worth about ${exactAmount(summary.avoided_cost, currency)} at this line's own rate.`
    : '';

  return {
    icon: high ? TrendingUp : PowerOff,
    tone: high ? 'text-purple-300' : 'text-amber-300',
    text: `${parts.join(', ')} out of ${total}.${saved}`,
  };
}

function UsageChart({ days, summary, currency }) {
  if (!days?.length) return null;
  const full = summary?.full_day_quantity || 0;

  return (
    <div className="h-40 -ml-2">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={days} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="day"
            tick={{ fill: '#64748b', fontSize: 9 }}
            tickFormatter={(d) => d.slice(-2)}
            interval="preserveStartEnd"
            minTickGap={14}
          />
          <YAxis
            tick={{ fill: '#64748b', fontSize: 9 }}
            width={38}
            tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)}
          />
          {full > 0 && (
            <ReferenceLine
              y={full}
              stroke="#475569"
              strokeDasharray="3 3"
              label={{ value: 'normal day', fill: '#64748b', fontSize: 9, position: 'insideTopRight' }}
            />
          )}
          <Tooltip
            cursor={{ fill: '#1e293b60' }}
            contentStyle={{
              background: '#0f172a', border: '1px solid #1e293b',
              borderRadius: 10, fontSize: 11,
            }}
            labelStyle={{ color: '#94a3b8' }}
            formatter={(v, _n, p) => [
              `${v} ${summary?.unit || 'units'}${p.payload.hours != null ? ` · ${p.payload.hours} h` : ''}` +
              ` · ${formatAmount(p.payload.cost, currency)}` +
              (p.payload.events?.length ? ` · ${p.payload.events.length} power event(s)` : ''),
              STATE_STYLE[p.payload.state]?.label || 'Billed',
            ]}
          />
          <Bar dataKey="quantity" radius={[2, 2, 0, 0]}>
            {days.map(d => (
              <Cell key={d.day} fill={STATE_STYLE[d.state]?.fill || '#3b82f6'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function DayTable({ days, summary, currency }) {
  return (
    <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-800">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-slate-900">
          <tr className="text-left text-slate-500">
            <th className="py-1.5 px-2.5 font-medium">Day</th>
            <th className="py-1.5 px-2.5 font-medium text-right">
              {summary?.is_duration ? 'Hours' : 'Quantity'}
            </th>
            <th className="py-1.5 px-2.5 font-medium text-right">Cost</th>
            <th className="py-1.5 px-2.5 font-medium">What happened</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {days.map(d => {
            const style = STATE_STYLE[d.state] || STATE_STYLE.full;
            return (
              <tr key={d.day} className={d.state === 'off' ? 'bg-slate-950/40' : ''}>
                <td className="py-1.5 px-2.5 text-slate-400 tabular-nums whitespace-nowrap">
                  {d.day.slice(5)}
                </td>
                <td className={`py-1.5 px-2.5 text-right tabular-nums ${style.tone}`}>
                  {summary?.is_duration && d.hours != null ? d.hours : d.quantity}
                </td>
                <td className="py-1.5 px-2.5 text-right tabular-nums text-slate-300">
                  {formatAmount(d.cost, currency)}
                </td>
                <td className="py-1.5 px-2.5 text-slate-500">
                  {d.events?.length ? (
                    <span className="space-y-0.5 block">
                      {d.events.map((e, i) => (
                        <span key={i} className="flex items-center gap-1.5">
                          {e.state === 'off'
                            ? <PowerOff className="w-3 h-3 text-amber-400 shrink-0" />
                            : <Power className="w-3 h-3 text-emerald-400 shrink-0" />}
                          <span className="text-slate-300">{e.time}</span>
                          <span>{e.action}</span>
                          {e.caller && e.caller !== 'Unknown' && (
                            <span className="text-slate-600 truncate">· {e.caller}</span>
                          )}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-slate-700">{style.label}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MonthBlock({ block, currency }) {
  const { summary, days, activity, month } = block;
  const shape = shapeOf(summary, currency);
  const ShapeIcon = shape?.icon;

  return (
    <Section
      title={month}
      subtitle={
        summary?.is_duration
          ? `Billed per ${summary.unit}. A "normal" day on this line is ${summary.full_day_hours ?? summary.full_day_quantity} hours${summary.instances ? ` — about ${summary.instances} instance${summary.instances === 1 ? '' : 's'} running the full 24.` : '.'}`
          : `Billed per ${summary?.unit || 'unit'}. A "normal" day on this line is ${summary?.full_day_quantity ?? '—'}.`
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat
          label={summary?.is_duration ? 'Total hours' : 'Total quantity'}
          value={summary?.is_duration ? summary.total_hours : summary?.total_quantity}
        />
        <Stat label="Total cost" value={formatAmount(summary?.total_cost, currency)} />
        <Stat
          label="Days billed"
          value={`${summary?.days_billed ?? 0} / ${summary?.days_in_month ?? 0}`}
          hint={summary?.days_off ? `${summary.days_off} with nothing billed` : null}
        />
        <Stat
          label="Not billed"
          value={summary?.avoided_cost ? formatAmount(summary.avoided_cost, currency) : '—'}
          tone="text-emerald-300"
          hint="Worth, at this line's rate"
        />
      </div>

      {shape && (
        <div className="flex items-start gap-2.5">
          <ShapeIcon className={`w-4 h-4 shrink-0 mt-0.5 ${shape.tone}`} />
          <p className={`text-xs leading-relaxed ${shape.tone}`}>{shape.text}</p>
        </div>
      )}

      <UsageChart days={days} summary={summary} currency={currency} />

      <DayTable days={days} summary={summary} currency={currency} />

      {activity?.note && (
        <p className="flex items-start gap-2 text-[10px] text-amber-300/90 leading-relaxed">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          {activity.note}
        </p>
      )}
      {activity?.covered && !activity.events && (
        <p className="flex items-start gap-2 text-[10px] text-slate-600 leading-relaxed">
          <User className="w-3 h-3 shrink-0 mt-0.5" />
          {activity.requested === false
            ? 'The Activity Log was skipped to get this back in time, so the days below have no '
              + 'operations against them. The quantities and costs are unaffected.'
            : 'No start, stop or deallocate operations were recorded for this resource group in '
              + 'this month. The daily figures above are still exact — they just have no operation '
              + 'behind them, which usually means the shape came from usage rather than someone acting.'}
        </p>
      )}
    </Section>
  );
}

export default function QuantityPanel({ item, currency, prevMonth, currMonth, onClose }) {
  const [answer, setAnswer] = useState({ key: null, data: null, error: null });

  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const subsKey = selectedSubscriptionIds.join(',');

  const months = [prevMonth, currMonth].filter(Boolean);
  const key = item ? [item.key, months.join('|'), subsKey, selectedTenantId].join('::') : null;

  useEffect(() => {
    if (!item || !selectedTenantId || !months.length) return undefined;
    let cancelled = false;

    const request = (includeActivity) => ({
      tenant_id: selectedTenantId,
      subscription_ids: selectedSubscriptionIds,
      months,
      service: item.service || '',
      meter: item.meter || '',
      resource_group: item.resource_group || '',
      unit_of_measure: item.unit || '',
      include_activity: includeActivity,
    });

    // The daily cost read is the part that cannot be skipped; the Activity Log
    // is the part that is slow on a large estate. If the whole thing runs out
    // of time, ask again without the log rather than showing nothing — a usage
    // curve with no names on it still answers most of the question, and the
    // panel says which half is missing.
    fetchUsageDetail(request(true))
      .catch(err => {
        const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
        if (cancelled || !timedOut) throw err;
        return fetchUsageDetail(request(false));
      })
      .then(result => { if (!cancelled) setAnswer({ key, data: result, error: null }); })
      .catch(err => {
        if (cancelled) return;
        const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
        const detail = timedOut
          ? 'Azure did not answer in time. This usually means a very large subscription — '
            + 'narrowing to a single subscription, or picking one month instead of two, will help.'
          : err.response?.data?.detail || err.message || 'Could not read daily usage.';
        setAnswer({ key, data: null, error: detail });
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!item) return null;

  const settled = answer.key === key;
  const loading = !settled;
  const data = settled ? answer.data : null;
  const error = settled ? answer.error : null;
  const money = data?.currency || currency;

  return (
    <DetailPanel
      open
      title="Quantity, day by day"
      subtitle={[item.label || item.resource_name, item.meter].filter(Boolean).join(' · ')}
      onClose={onClose}
    >
      <Section
        title="What was billed, and when"
        subtitle="Azure bills usage per day. The monthly figure on the comparison is the sum of the days below — which is where a weekend left running or a machine shut down mid-month becomes visible."
      >
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label={`${prevMonth || 'Previous'} quantity`}
            value={item.prev_qty}
            hint={item.unit}
          />
          <Stat
            label={`${currMonth || 'Current'} quantity`}
            value={item.curr_qty}
            hint={item.unit}
          />
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Cost Management reports what was <em>billed</em>, not what was powered on. A day short of
          the usual figure means Azure charged for less than a full day — usually a deallocation,
          sometimes a resize, occasionally a meter that simply stopped applying. The operations
          below say which, where the Activity Log still has them.
        </p>
      </Section>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-slate-400 px-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Reading daily usage from Azure…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-300 px-1">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="leading-relaxed">{error}</p>
        </div>
      )}

      {data?.months?.map(block => (
        <MonthBlock key={block.month} block={block} currency={money} />
      ))}

      {data?.errors?.length > 0 && (
        <p className="text-[10px] text-amber-300/80 px-1 leading-relaxed">
          {data.errors.length} subscription(s) could not be read, so the days above may be short.
        </p>
      )}

      {data && (
        <Section
          title="How this was read"
          subtitle="So the same figures can be reproduced outside this app."
        >
          <div className="space-y-1 text-[11px]">
            {Object.entries(data.filters || {}).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <span className="text-slate-500">{k}</span>
                <span className="text-slate-300 text-right break-words">{v}</span>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-slate-500">Granularity</span>
              <span className="text-slate-300">Daily</span>
            </div>
          </div>
          <p className="flex items-start gap-2 text-[10px] text-slate-600 leading-relaxed">
            <CalendarDays className="w-3 h-3 shrink-0 mt-0.5" />
            Azure Cost Management query API, ActualCost, summing PreTaxCost and UsageQuantity per
            day for the filters above. Power operations come from the Azure Activity Log for the
            same resource group.
          </p>
        </Section>
      )}
    </DetailPanel>
  );
}
