import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Banknote, CalendarClock,
  CheckCircle2, CircleDot, ExternalLink, HelpCircle, Loader2, MapPin, Minus,
  SearchX, Sigma, TrendingDown, TrendingUp, XCircle,
} from 'lucide-react';
import {
  Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import DetailPanel from './DetailPanel';
import { explainUnitRate } from '../../api/client';
import { formatRate } from '../../utils/currency';
import { exactAmount } from '../../utils/exact';

/**
 * A unit rate, taken apart.
 *
 * Two numbers claim to be "the price" of the same thing and they disagree: the
 * rate Azure billed (cost ÷ quantity, already net of every discount and
 * reservation) and the rate Microsoft publishes in the pricing calculator (list,
 * converted from dollars). Shown side by side with no account of the gap, the
 * reader concludes one of them is wrong — usually the one that costs them more.
 *
 * So the gap is attributed rather than displayed. The dollar moving and
 * Microsoft repricing a meter look identical in a local currency, and only one
 * of them is Azure's doing; conflating them turns a currency swing into an
 * accusation. Every claim carries a link back to the Microsoft source that
 * supports it, because "trust us" is not something a customer can take to their
 * finance team.
 */

// Only two outcomes are possible now, because a meter that fails region, SKU,
// variant or unit is not returned at all. "Close" no longer means "probably
// this one" — it means every field the billed line carried was verified, and
// the ones it did not carry could not be.
const CONFIDENCE = {
  exact: {
    label: 'Verified match',
    tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
    note: 'Region, SKU, meter name and unit all agree with the line you were billed for.',
  },
  close: {
    label: 'Partly verified',
    tone: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
    note: 'Everything the billed line carries agrees. The fields it does not carry are marked below and were not checked.',
  },
};

const CHECK_STATE = {
  match: { icon: CheckCircle2, tone: 'text-emerald-400' },
  // Not billed as its own field, but Microsoft's catalogue leaves nothing to
  // decide — every meter that matched carries the same value.
  resolved: { icon: CircleDot, tone: 'text-sky-400' },
  differs: { icon: XCircle, tone: 'text-red-400' },
  unknown: { icon: HelpCircle, tone: 'text-slate-500' },
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

function Big({ value, currency, unit, muted }) {
  if (value == null) {
    return <p className="text-xl font-bold text-slate-600">Not available</p>;
  }
  return (
    <p className={`text-2xl font-bold tabular-nums ${muted ? 'text-slate-300' : 'text-white'}`}>
      {formatRate(value, currency)}
      {unit && <span className="text-xs font-normal text-slate-500 ml-1.5">per {unit}</span>}
    </p>
  );
}

function Field({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className="text-slate-300 text-right break-words">{value}</span>
    </div>
  );
}

/**
 * Which currency the whole panel is stated in.
 *
 * Defaulting to dollars is a deliberate choice, not a preference. Microsoft
 * sets every Azure price in USD; a rupee price is that dollar figure times
 * somebody's exchange rate, and the invoice and the catalogue do not use the
 * same rate. Two numbers that look different in rupees are frequently the same
 * price, and the only way to see that is to look at the dollars.
 */
function CurrencyToggle({ value, onChange, billingCurrency, agree }) {
  if (billingCurrency === 'USD') return null;

  const options = [
    { id: 'USD', label: 'USD', hint: "Microsoft's own pricing currency" },
    { id: 'LOCAL', label: billingCurrency, hint: 'As it appears on the invoice' },
  ];

  return (
    <div className="flex items-center justify-between gap-3 bg-slate-800/40 border border-slate-800 rounded-xl px-3 py-2">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Show every figure in</p>
        <p className="text-[10px] text-slate-600 mt-0.5 leading-tight">
          {agree
            ? 'Both rates match. The percentage is the same either way.'
            : 'Azure prices are set in USD. Both sides are converted the same way.'}
        </p>
      </div>
      <div className="flex rounded-lg overflow-hidden border border-slate-700 shrink-0">
        {options.map(o => (
          <button
            key={o.id}
            type="button"
            title={o.hint}
            onClick={() => onChange(o.id)}
            className={`px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              value === o.id
                ? 'bg-blue-500/20 text-blue-200'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const VERDICT_STYLE = {
  identical: { icon: CheckCircle2, tone: 'text-emerald-300', box: 'bg-emerald-500/10 border-emerald-500/30' },
  discount: { icon: TrendingDown, tone: 'text-emerald-300', box: 'bg-emerald-500/10 border-emerald-500/30' },
  'above-list': { icon: AlertTriangle, tone: 'text-amber-300', box: 'bg-amber-500/10 border-amber-500/30' },
  unknown: { icon: HelpCircle, tone: 'text-slate-400', box: 'bg-slate-800/40 border-slate-700' },
  'no-bill': { icon: HelpCircle, tone: 'text-slate-400', box: 'bg-slate-800/40 border-slate-700' },
};

/**
 * The reconciliation: both currencies side by side, and the three exchange
 * rates involved.
 *
 * The two gap percentages are identical by construction, and that is the point
 * being demonstrated — the rates only looked different because each side was
 * being converted by someone else. Showing them agreeing is what turns "trust
 * us" into something the reader can check.
 *
 * The premium line is the finding most people have never seen: Microsoft's
 * published INR price for a meter divided by their published USD price for the
 * same meterId does not give the market rate. It gives theirs, and on live data
 * that has been 14% higher.
 */
function DollarCheck({ view, billingCurrency }) {
  if (!view || view.is_usd) return null;
  const { usd, billing } = view;
  if (usd.published_rate == null || usd.billed_rate == null) return null;

  const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
  const pad = (s, n) => String(s).padEnd(n);

  return (
    <>
      <pre className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-300 whitespace-pre-wrap leading-relaxed">
{`${pad('in USD', 8)}billed ${usd.billed_rate.toFixed(6)}   list ${usd.published_rate.toFixed(6)}   gap ${pct(usd.gap_percent)}
${pad(`in ${billingCurrency}`, 8)}billed ${billing.billed_rate?.toFixed(4) ?? '—'}   list ${
  billing.published_rate?.toFixed(4) ?? '—'
}   gap ${pct(billing.gap_percent)}
──────────────────────────────────────────────────
Microsoft's own rate   ${view.catalogue_fx ?? '—'}   (their ${billingCurrency} price ÷ their USD price)
this bill implies      ${view.implied_fx ?? '—'}   (billed ÷ USD list price)
market rate, ECB       ${view.market_fx ?? '—'}`}
      </pre>

      {view.fx_premium_percent != null && Math.abs(view.fx_premium_percent) >= 1 && (
        <p className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2.5 py-2 leading-relaxed">
          Microsoft converts this meter at {view.catalogue_fx} {billingCurrency} to the dollar
          while the market rate is {view.market_fx} — a{' '}
          <strong>{Math.abs(view.fx_premium_percent).toFixed(1)}% currency premium</strong>{' '}
          built into every {billingCurrency} price they publish. It applies to the billed figure
          and the list figure alike, so it does not affect the comparison above — but it is a real
          cost of being billed in {billingCurrency} rather than dollars, and it is not visible
          anywhere in Azure's own cost analysis.
        </p>
      )}

      {view.fx_basis === 'market' && (
        <p className="text-[10px] text-amber-300/90 leading-relaxed">
          Microsoft's {billingCurrency} price for this meter could not be read, so the bill was
          converted at the market rate. Microsoft normally converts several percent above market,
          so a small apparent premium here may be conversion rather than money.
        </p>
      )}
    </>
  );
}

/** The sentence that says which of the possible causes actually applies. */
function movementVerdict(movement, currency, months) {
  if (!movement || movement.verdict === 'unknown') {
    return {
      icon: AlertTriangle,
      tone: 'text-slate-400',
      text: movement?.reason
        || 'Not enough information to split this movement into currency and price.',
    };
  }

  const money = (v) => exactAmount(Math.abs(v), currency);
  const span = months.prev && months.curr ? `${months.prev} → ${months.curr}` : 'between the two months';

  if (movement.verdict === 'flat') {
    return { icon: Minus, tone: 'text-slate-400', text: `The unit rate did not move ${span}.` };
  }

  if (movement.verdict === 'currency') {
    return {
      icon: Banknote,
      tone: 'text-blue-300',
      text:
        `This is the exchange rate, not Azure. Microsoft sets the price in US dollars and it barely moved ` +
        `(${movement.old_usd?.toFixed(6)} → ${movement.new_usd?.toFixed(6)} USD, ` +
        `${movement.usd_change_percent > 0 ? '+' : ''}${movement.usd_change_percent?.toFixed(2)}%), ` +
        `while the ${currency} rate went ${movement.fx_change_percent > 0 ? 'up' : 'down'} ` +
        `${Math.abs(movement.fx_change_percent).toFixed(2)}%. ` +
        `Of the ${money(movement.total)} change, ${money(movement.currency_effect)} is currency.`,
    };
  }

  if (movement.verdict === 'price') {
    return {
      icon: movement.total > 0 ? TrendingUp : TrendingDown,
      tone: movement.total > 0 ? 'text-red-300' : 'text-emerald-300',
      text:
        `The product price itself moved. In US dollars — the currency Microsoft actually prices in — ` +
        `the rate went from ${movement.old_usd?.toFixed(6)} to ${movement.new_usd?.toFixed(6)} ` +
        `(${movement.usd_change_percent > 0 ? '+' : ''}${movement.usd_change_percent?.toFixed(2)}%). ` +
        `The exchange rate explains almost none of it.`,
    };
  }

  return {
    icon: AlertTriangle,
    tone: 'text-amber-300',
    text:
      `Both moved. Of the ${money(movement.total)} change ${span}, about ` +
      `${money(movement.currency_effect)} came from the exchange rate and ` +
      `${money(movement.price_effect)} from the price itself ` +
      `(${movement.old_usd?.toFixed(6)} → ${movement.new_usd?.toFixed(6)} USD).`,
  };
}

/** Why the billed rate is not the published one, when they differ. */
function listVerdict(against, published, currency) {
  if (!published) return null;
  if (against?.verdict === 'unknown') return null;

  if (against.verdict === 'at_list') {
    return {
      icon: CheckCircle2,
      tone: 'text-emerald-300',
      text: 'You are paying Microsoft\'s published list price for this meter — no discount, and no premium.',
    };
  }

  const gap = `${Math.abs(against.percent).toFixed(1)}% (${exactAmount(Math.abs(against.difference), currency)} per unit)`;

  if (against.verdict === 'below_list') {
    return {
      icon: ArrowDownRight,
      tone: 'text-emerald-300',
      text:
        `You are billed ${gap} under Microsoft's list price. That gap is a discount, a reservation or ` +
        `savings plan covering this meter, or an agreement rate negotiated on the account — the ` +
        `published price does not include any of them.`,
    };
  }

  return {
    icon: ArrowUpRight,
    tone: 'text-red-300',
    text:
      `You are billed ${gap} over Microsoft's list price. A billed rate above list usually means the ` +
      `comparison is against the wrong meter (a different OS, tier or region), or the charge includes ` +
      `something the meter price does not, such as licensing bundled into the same line.`,
  };
}

function FxChart({ fx, currency }) {
  const series = fx?.series || [];
  if (series.length < 2) return null;

  const summary = fx.summary || {};
  const up = (summary.change || 0) > 0;

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label={`Start (${summary.first_day?.slice(-2)})`} value={summary.first_rate?.toFixed(4)} />
        <Stat label={`End (${summary.last_day?.slice(-2)})`} value={summary.last_rate?.toFixed(4)} />
        <Stat label="Month low / high" value={`${summary.low?.toFixed(2)} – ${summary.high?.toFixed(2)}`} />
        <Stat
          label="Net move"
          value={`${up ? '+' : ''}${summary.percent?.toFixed(2)}%`}
          tone={up ? 'text-red-300' : 'text-emerald-300'}
        />
      </div>

      <div className="h-32 -ml-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="day"
              tick={{ fill: '#64748b', fontSize: 9 }}
              tickFormatter={(d) => d.slice(-2)}
              interval="preserveStartEnd"
              minTickGap={18}
            />
            <YAxis
              tick={{ fill: '#64748b', fontSize: 9 }}
              domain={['dataMin - 0.2', 'dataMax + 0.2']}
              tickFormatter={(v) => v.toFixed(1)}
              width={42}
            />
            <Tooltip
              contentStyle={{
                background: '#0f172a', border: '1px solid #1e293b',
                borderRadius: 10, fontSize: 11,
              }}
              labelStyle={{ color: '#94a3b8' }}
              formatter={(v, _n, p) => [
                `1 USD = ${v} ${currency}${p.payload.published ? '' : ' (carried forward)'}`,
                'Rate',
              ]}
            />
            <Line type="monotone" dataKey="rate" stroke="#60a5fa" strokeWidth={1.75} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] text-slate-600 leading-relaxed">
        European Central Bank reference rates, published on working days only — weekends and
        holidays carry the previous working day's rate forward, which is also how they settle
        commercially. Source: <a href="https://frankfurter.dev" target="_blank" rel="noreferrer" className="underline hover:text-slate-400">frankfurter.dev</a>.
      </p>
    </div>
  );
}

/**
 * The field-by-field evidence that the published meter is the billed one.
 *
 * A confidence badge asks to be believed. This shows the work: which fields
 * were compared, what each side said, and which ones the billed line simply
 * did not carry — because "not checked" and "checked and agreed" are different
 * claims and only one of them supports quoting a price difference.
 */
function MatchChecks({ checks }) {
  if (!checks?.length) return null;
  return (
    <div className="space-y-1.5">
      {checks.map(c => {
        const state = CHECK_STATE[c.state] || CHECK_STATE.unknown;
        const Icon = state.icon;
        return (
          <div key={c.field} className="flex items-start gap-2 text-[11px]">
            <Icon className={`w-3.5 h-3.5 shrink-0 mt-px ${state.tone}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-400 shrink-0">{c.field}</span>
                <span className="text-slate-200 text-right break-words">
                  {c.state === 'unknown'
                    ? <span className="text-slate-500">not on the billed line</span>
                    : c.got || '—'}
                </span>
              </div>
              {c.state === 'differs' && c.wanted && (
                <p className="text-[10px] text-red-300/80">Billed line says {c.wanted}.</p>
              )}
              {c.note && <p className="text-[10px] text-slate-500 leading-relaxed">{c.note}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Published meters that were rejected, and why.
 *
 * Naming them is what turns "nothing matched" from a shrug into a finding: the
 * usual reason is that the only published meter nearby is a Windows or Spot
 * variant, and seeing that is often the answer the reader actually wanted.
 */
function Rejected({ rows, currency }) {
  if (!rows?.length) return null;
  return (
    <div className="space-y-2 pt-2 border-t border-slate-800/70">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
        Closest published meters, and why they were not used
      </p>
      {rows.map((r, i) => (
        <div key={r.meter_id || i} className="text-[11px] bg-slate-950/50 border border-slate-800 rounded-lg px-2.5 py-2">
          <p className="text-slate-300">
            {r.meter_name}
            {r.region && <span className="text-slate-500"> · {r.region}</span>}
            {r.retail_price != null && (
              <span className="text-slate-400 tabular-nums float-right">
                {formatRate(r.retail_price, r.currency || currency)}
              </span>
            )}
          </p>
          {r.product_name && <p className="text-[10px] text-slate-500">{r.product_name}</p>}
          <p className="text-[10px] text-amber-300/80 mt-1">{r.why_not?.join('; ')}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Region chooser, shown only when the region is the one thing missing.
 *
 * Azure publishes a different price per region, so without a region there is no
 * single correct answer — and answering anyway is exactly the failure this
 * panel exists to avoid. Asking is one click and makes the rest exact.
 */
function RegionPicker({ options, currency, onPick }) {
  if (!options?.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold flex items-center gap-1.5">
        <MapPin className="w-3 h-3" /> Published in {options.length} regions — pick the one this runs in
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => (
          <button
            key={o.region}
            type="button"
            onClick={() => onPick(o.region)}
            className="text-[11px] px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800/60 text-slate-300 hover:border-blue-500/60 hover:text-white transition"
          >
            {o.region}
            <span className="text-slate-500 ml-1.5 tabular-nums">
              {formatRate(o.retail_price, currency)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'text-slate-200' }) {
  return (
    <div className="bg-slate-800/50 rounded-lg px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className={`text-xs font-bold mt-0.5 tabular-nums ${tone}`}>{value ?? '—'}</p>
    </div>
  );
}

/** "2021-11-01" → "4 years 9 months ago", for a date that is otherwise just digits. */
function ago(day) {
  if (!day) return '';
  const then = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return '';
  const months = Math.max(0, Math.round((Date.now() - then.getTime()) / 2629800000));
  if (months < 1) return 'this month';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return `${y} year${y === 1 ? '' : 's'}${m ? ` ${m} month${m === 1 ? '' : 's'}` : ''} ago`;
}

/**
 * Three years of this meter's price, dated, with what is *not* known marked.
 *
 * Microsoft publishes no price history — the Retail Prices API returns one row
 * per meter carrying only today's figure — so a complete three-year series
 * cannot be fetched from anywhere and any page claiming to show one is drawing
 * it from somewhere it should not. What does exist is assembled here from two
 * dated sources, each labelled with which one it came from:
 *
 *   * Microsoft's own `effectiveStartDate`, the date the current price began;
 *   * every movement this installation has observed since it started watching.
 *
 * The stretch between the start of the window and the first reading is drawn as
 * a gap rather than left blank, because a blank reads as "nothing happened".
 */
function PriceHistory({ history, currency }) {
  const timeline = history?.timeline || {};
  const events = timeline.events || [];
  const coverage = history?.coverage || {};
  const changes = events.filter(e => e.kind === 'change');

  return (
    <div className="space-y-2.5">
      {timeline.effective_from && (
        <div className="flex items-start gap-2.5 text-[11px] bg-slate-950/50 border border-slate-800 rounded-lg px-2.5 py-2">
          <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-px text-sky-400" />
          <p className="text-slate-300 leading-relaxed">
            Microsoft's current price took effect <strong className="text-white">{timeline.effective_from}</strong>
            {' '}({ago(timeline.effective_from)}) and it still carries that date, which is Microsoft's
            own statement that this meter has not been repriced since.
          </p>
        </div>
      )}

      {changes.length > 0 ? (
        <ol className="space-y-2">
          {changes.map((e, i) => {
            const up = e.direction === 'up';
            return (
              <li key={`${e.day}-${i}`} className="flex items-start gap-2.5 text-[11px]">
                <span className={`mt-0.5 shrink-0 ${up ? 'text-red-400' : 'text-emerald-400'}`}>
                  {up ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                </span>
                <div className="min-w-0">
                  <p className="text-slate-200 tabular-nums">
                    <span className="text-slate-400">{e.day}</span>
                    <span className="mx-1.5 text-slate-600">·</span>
                    {formatRate(e.old_price, currency)} → {formatRate(e.price, currency)}
                    <span className={`ml-1.5 font-semibold ${up ? 'text-red-400' : 'text-emerald-400'}`}>
                      {e.percent > 0 ? '+' : ''}{e.percent?.toFixed(2)}%
                    </span>
                  </p>
                  <p className="text-slate-500">
                    Price went {e.direction}. Previous reading {e.previous_reading}
                    {e.effective_from ? ` · Microsoft effective from ${e.effective_from}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[11px] text-slate-500 leading-relaxed">
          No price movement recorded for this meter since {timeline.from_day || 'the window began'}.
        </p>
      )}

      {/* What the timeline cannot speak for, stated rather than implied. */}
      <p className="text-[10px] text-slate-600 leading-relaxed">
        {timeline.watching_since
          ? `Watched here since ${timeline.watching_since}.`
          : 'Nothing has been recorded for this meter yet.'}
        {timeline.unobserved && (
          ` Between ${timeline.unobserved_from} and ${timeline.unobserved_to} nothing was recorded, so a change in that stretch would not appear above.`
        )}
        {' '}Microsoft offers no price-history endpoint, so a full three-year series cannot be
        fetched from anywhere — only the effective date above and what has been observed here
        ({coverage.readings?.toLocaleString() || 0} readings across{' '}
        {coverage.meters?.toLocaleString() || 0} meters).
      </p>
    </div>
  );
}

export default function UnitRatePanel({ item, currency, prevMonth, currMonth, onClose }) {
  // One state object rather than three. The panel has exactly three states —
  // asking, answered, failed — and holding them separately meant clearing them
  // one by one at the top of the effect, which is a synchronous re-render on
  // every open. Instead the answer is stamped with the question it answers, and
  // "still loading" is simply the stamp not matching the current question.
  const [answer, setAnswer] = useState({ key: null, data: null, error: null });

  // Live cost rows are grouped by service, resource group and meter — Azure
  // does not return a region on them. When the published price turns out to be
  // region-specific, the user supplies the region here and the lookup becomes
  // exact instead of guessed.
  const [regionPick, setRegionPick] = useState('');

  // Dollars by default. Microsoft publishes in USD and converts everything
  // else, so the dollar figures are the only pair where a difference means a
  // difference in price rather than in exchange rate.
  const [money, setMoney] = useState('USD');

  const region = regionPick || item?.region || '';

  const key = item
    ? [item.service, item.meter, item.sku, region, item.unit, currency, prevMonth, currMonth].join('|')
    : null;

  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;

    explainUnitRate({
      service_name: item.service || '',
      meter_name: item.meter || '',
      arm_sku_name: item.sku || '',
      arm_region: region,
      currency,
      unit_of_measure: item.unit || '',
      current_rate: item.curr_rate ?? null,
      previous_rate: item.prev_rate ?? null,
      current_month: currMonth || '',
      previous_month: prevMonth || '',
    })
      .then(result => { if (!cancelled) setAnswer({ key, data: result, error: null }); })
      .catch(err => {
        if (cancelled) return;
        const detail = err.response?.data?.detail || err.message || 'Lookup failed.';
        setAnswer({ key, data: null, error: detail });
      });

    return () => { cancelled = true; };
  }, [item, currency, prevMonth, currMonth, region, key]);

  if (!item) return null;

  const settled = answer.key === key;
  const loading = !settled;
  const data = settled ? answer.data : null;
  const error = settled ? answer.error : null;

  const published = data?.published;
  const confidence = CONFIDENCE[published?.match_confidence] || null;
  const movement = movementVerdict(data?.movement, currency, { prev: prevMonth, curr: currMonth });
  const MovementIcon = movement.icon;

  // Everything below is stated in one currency at a time. USD is the default
  // because it is the currency Azure prices are actually set in — the billing
  // currency is a conversion, and comparing two independently-converted numbers
  // manufactures a gap that is not a price difference.
  const cv = data?.currency_view;
  const inUsd = money === 'USD' || !cv || cv.is_usd;
  const shown = inUsd ? 'USD' : currency;
  const view = inUsd ? cv?.usd : cv?.billing;

  // The billed rate restated in whichever currency is on show. Falls back to
  // the raw billed figure so the panel still reads before the lookup returns.
  const billedRate = view?.billed_rate ?? (inUsd && currency !== 'USD' ? null : item.curr_rate);
  const publishedRate = view?.published_rate ?? null;
  const gap = inUsd ? data?.against_list : data?.against_list_local;
  const list = listVerdict(gap, published, shown);

  const verdict = cv?.verdict;
  const VerdictIcon = (VERDICT_STYLE[verdict?.code] || VERDICT_STYLE.unknown).icon;
  const verdictStyle = VERDICT_STYLE[verdict?.code] || VERDICT_STYLE.unknown;

  return (
    <DetailPanel
      open
      title="Unit rate"
      subtitle={[item.label || item.resource_name, item.meter].filter(Boolean).join(' · ')}
      onClose={onClose}
    >
      <CurrencyToggle
        value={money}
        onChange={setMoney}
        billingCurrency={currency}
        agree={cv?.usd?.matches}
      />
      {/* ── The answer, before the evidence ──
          "Why are these two numbers different" deserves a sentence at the top,
          not a conclusion the reader has to assemble from four sections. */}
      {verdict && (
        <div className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${verdictStyle.box}`}>
          <VerdictIcon className={`w-4 h-4 shrink-0 mt-0.5 ${verdictStyle.tone}`} />
          <div className="min-w-0">
            <p className={`text-xs font-semibold ${verdictStyle.tone}`}>{verdict.headline}</p>
            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{verdict.detail}</p>
          </div>
        </div>
      )}

      {/* ── 1. What Azure actually billed ── */}
      <Section
        title="1 · Live Azure unit rate"
        subtitle="Your effective rate: what Cost Management billed, divided by the quantity it billed. Already net of every discount, reservation and negotiated rate on the account."
        badge={!inUsd || currency === 'USD' ? null : (
          <span className="text-[10px] text-slate-500 whitespace-nowrap">converted from {currency}</span>
        )}
      >
        <Big value={billedRate} currency={shown} unit={item.unit} />
        {item.prev_rate != null && item.curr_rate != null && (
          <p className="text-[11px] text-slate-400 tabular-nums">
            {prevMonth}: {formatRate(item.prev_rate, currency)}
            <span className="text-slate-600 mx-1.5">→</span>
            {currMonth}: {formatRate(item.curr_rate, currency)}
            {currency !== 'USD' && <span className="text-slate-600"> (as billed)</span>}
          </p>
        )}
        <div className="pt-1 space-y-1 border-t border-slate-800/70">
          <Field label="Formula" value={`cost ÷ billed quantity (per ${item.unit || 'unit'})`} />
          <Field label="Source" value="Azure Cost Management" />
          <Field label="Meter" value={item.meter} />
          <Field label="Region" value={item.region} />
        </div>
      </Section>

      {/* ── 2. What Microsoft publishes ── */}
      <Section
        title="2 · Microsoft pricing calculator unit rate"
        subtitle="Microsoft's published list price for this exact meter, from the Retail Prices API the calculator itself is built on. A meter is only quoted here once its region, SKU, name and unit have been checked against the billed line — no discount of any kind is included."
        badge={confidence && (
          <span className={`text-[10px] font-semibold px-2 py-1 rounded-full border whitespace-nowrap ${confidence.tone}`}>
            {confidence.label}
          </span>
        )}
      >
        {loading && (
          <p className="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Reading Microsoft's published prices…
          </p>
        )}

        {error && <p className="text-xs text-red-300">{error}</p>}

        {data?.published_error && <p className="text-xs text-amber-300">{data.published_error}</p>}

        {published && (
          <>
            <Big value={publishedRate ?? published.retail_price} currency={shown}
                 unit={item.unit || published.unit_of_measure} muted />
            {published.unit_scale && published.unit_scale !== 1 && (
              <p className="text-[10px] text-slate-500">
                Microsoft lists this as {formatRate(published.retail_price, published.currency || 'USD')} per{' '}
                {published.unit_of_measure}; restated above on the billed line's unit (×{published.unit_scale}).
              </p>
            )}
            {confidence && <p className="text-[11px] text-slate-500">{confidence.note}</p>}

            <div className="pt-2 border-t border-slate-800/70 space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                Checked against the billed line
              </p>
              <MatchChecks checks={data.match_checks} />
            </div>

            <div className="pt-2 space-y-1 border-t border-slate-800/70">
              <Field label="Product" value={published.product_name} />
              <Field label="Price type" value={published.price_type} />
              <Field label="Effective from" value={published.effective_from?.slice(0, 10)} />
              <Field label="Microsoft meter ID" value={published.meter_id} />
              <Field
                label="Matched from"
                value={`${data.considered_count || data.candidate_count} published meters for this service`}
              />
              {data.same_price_regions > 1 && (
                <Field
                  label="Region"
                  value={`Priced the same in all ${data.same_price_regions} regions it is published in`}
                />
              )}
            </div>

            {data.is_converted_currency && (
              <p className="text-[10px] text-slate-400 bg-slate-800/60 border border-slate-700 rounded-lg px-2.5 py-2 leading-relaxed">
                Microsoft sets every Azure price in US dollars, and this meter was read from the
                catalogue in USD. The {currency} figure is Microsoft's conversion of it — a
                different conversion from the one applied to your invoice, which is why the two
                {' '}{currency} numbers can differ while the dollar prices are identical.
              </p>
            )}

            {/* Passed every check too, and priced differently — a real
                ambiguity, so it is shown rather than silently discarded. */}
            {data.alternatives?.length > 0 && (
              <div className="pt-2 border-t border-slate-800/70 space-y-1.5">
                <p className="text-[10px] uppercase tracking-wide text-amber-300/80 font-semibold">
                  {data.alternatives.length} other published meter{data.alternatives.length === 1 ? '' : 's'} passed
                  the same checks at a different price
                </p>
                {data.alternatives.map(a => (
                  <p key={a.meter_id} className="text-[11px] text-slate-400">
                    {a.product_name}
                    <span className="float-right tabular-nums text-slate-300">
                      {formatRate(a.retail_price, a.currency || currency)}
                    </span>
                  </p>
                ))}
                <p className="text-[10px] text-slate-600 leading-relaxed">
                  The lowest was quoted above. Microsoft offers this size under more than one
                  product and the billed line does not say which — check the product name before
                  quoting the difference.
                </p>
              </div>
            )}

            {/* Microsoft's own movements on this meter, newest first. */}
            <div className="pt-2 border-t border-slate-800/70 space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                Price movements — last 3 years
              </p>
              <PriceHistory history={data.price_history} currency={currency} />
            </div>
          </>
        )}

        {/* Not matched — say what stopped it, and offer the one thing that fixes it. */}
        {!loading && !published && !error && !data?.published_error && data && (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5">
              <SearchX className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" />
              <p className="text-xs text-amber-300 leading-relaxed">
                {data.match_reason
                  || 'No published meter matched this line closely enough to quote.'}
              </p>
            </div>
            <RegionPicker
              options={data.region_options}
              currency={currency}
              onPick={setRegionPick}
            />
            <Rejected rows={data.rejected} currency={currency} />
            <p className="text-[10px] text-slate-600 leading-relaxed">
              Nothing is shown here rather than the nearest meter, because a list price for a
              different region, SKU or operating system produces a discount or a premium that
              does not exist — and that number is the one that gets repeated.
            </p>
          </div>
        )}
      </Section>

      {/* ── Why the two disagree ── */}
      {list && (
        <Section
          title="Why the two rates differ"
          subtitle={
            cv && !cv.is_usd
              ? 'Compared in dollars first, because that is the only pair where both sides are a price rather than a price times somebody\u2019s exchange rate.'
              : 'The billed rate is net of your agreement; the published rate is list. A gap is expected — its direction is what matters.'
          }
        >
          <div className="flex items-start gap-2.5">
            <list.icon className={`w-4 h-4 shrink-0 mt-0.5 ${list.tone}`} />
            <p className={`text-xs leading-relaxed ${list.tone}`}>{list.text}</p>
          </div>

          {gap?.percent != null && (
            <pre className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-300 whitespace-pre-wrap leading-relaxed">
{`billed   ${exactAmount(billedRate, shown)}  per ${item.unit || 'unit'}
list     ${exactAmount(publishedRate, shown)}  per ${item.unit || 'unit'}
──────────────────────────
gap      ${exactAmount(gap.difference, shown)}  (${gap.percent > 0 ? '+' : ''}${gap.percent}%)`}
            </pre>
          )}

          {/* The reconciliation. Both currencies at once, and the exchange rate
              the bill implies against the market rate, so the claim that the
              gap is conversion can be checked rather than taken on trust. */}
          <DollarCheck view={cv} billingCurrency={currency} />

          {cv && !cv.is_usd && cv.usd?.matches && (
            <p className="text-[10px] text-slate-600 leading-relaxed">
              Both rates agree once they are on the same exchange rate. Whichever currency you
              switch to above, the percentage stays the same — that is what tells you the gap is
              a price question and not a conversion one.
            </p>
          )}
        </Section>
      )}

      {/* ── Currency vs product price ── */}
      {(prevMonth || currMonth) && (
        <Section
          title="Was it the dollar, or the price?"
          subtitle="A local-currency rate moves when the exchange rate moves, when Microsoft reprices the meter, or both. These look identical on a bill and only one of them is Azure's doing."
        >
          <div className="flex items-start gap-2.5">
            <MovementIcon className={`w-4 h-4 shrink-0 mt-0.5 ${movement.tone}`} />
            <p className={`text-xs leading-relaxed ${movement.tone}`}>{movement.text}</p>
          </div>

          {data?.movement?.currency_effect != null && (
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="From the exchange rate"
                value={exactAmount(data.movement.currency_effect, currency)}
                tone={data.movement.currency_effect > 0 ? 'text-red-300' : 'text-emerald-300'}
              />
              <Stat
                label="From the product price"
                value={exactAmount(data.movement.price_effect, currency)}
                tone={data.movement.price_effect > 0 ? 'text-red-300' : 'text-emerald-300'}
              />
            </div>
          )}
        </Section>
      )}

      {/* ── The dollar, day by day ── */}
      {data?.fx?.series?.length > 1 && (
        <Section
          title={`US dollar against ${currency}, day by day`}
          subtitle={`Every day of ${data.fx.month}. Azure prices are set in dollars, so this is the line that converts them into what you were charged.`}
        >
          <FxChart fx={data.fx} currency={currency} />
          {data.fx.previous?.summary?.average != null && (
            <p className="text-[11px] text-slate-400">
              {data.fx.previous.month} averaged {data.fx.previous.summary.average?.toFixed(4)},
              {' '}{data.fx.month} averaged {data.fx.summary?.average?.toFixed(4)} — the rates used
              to split the movement above.
            </p>
          )}
          {data.fx.note && <p className="text-[11px] text-amber-300">{data.fx.note}</p>}
        </Section>
      )}

      {/* ── Microsoft's own price changes ──
           Only shown standalone when there is no matched meter to hang it off,
           so the same list never appears twice on one panel. */}
      {!published && data?.price_history && (
        <Section
          title="Price history"
          subtitle="Every published price this app has read, and every time one moved. Microsoft offers no history endpoint, so this is the only record there is."
        >
          <PriceHistory history={data.price_history} currency={currency} />
        </Section>
      )}

      {/* ── Verify it at the source ── */}
      {data?.verify?.length > 0 && (
        <Section
          title="Check this against Microsoft"
          subtitle="Every figure above comes from one of these. Open them and you get the same numbers."
        >
          <ul className="space-y-2">
            {data.verify.map(link => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start gap-2 text-xs text-blue-400 hover:text-blue-300 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    {link.label}
                    <span className="block text-[10px] text-slate-500 leading-relaxed">{link.note}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {data.odata_filter && (
            <div className="pt-2 border-t border-slate-800/70">
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold flex items-center gap-1.5">
                <Sigma className="w-3 h-3" /> The filter that was queried
              </p>
              <pre className="mt-1 bg-slate-950/70 border border-slate-800 rounded-lg p-2.5 text-[10px] text-slate-400 whitespace-pre-wrap break-all">
                {data.odata_filter}
              </pre>
            </div>
          )}
        </Section>
      )}
    </DetailPanel>
  );
}
