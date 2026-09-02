/**
 * Commitment rules -- the terms Microsoft actually applies when you want out.
 *
 * This is reference material, not measurement, so it is deliberately separated
 * from everything else on the Commitments page: no figure here comes from the
 * tenant, and every claim carries a link to the Microsoft article it was taken
 * from. Somebody about to cancel a three-year reservation should be able to
 * check the rule themselves in one click, and the answer they read on this
 * screen should be the answer they find when they do.
 *
 * The estimator below is the one place the two meet. It is labelled an estimate
 * and shows its own arithmetic, because a refund figure that looks authoritative
 * and turns out to be wrong is worse than no figure at all.
 */
import { useMemo, useState } from 'react';
import {
  BookOpen, Calculator, ExternalLink, Info, Lock, Search, ShieldAlert, Wallet,
} from 'lucide-react';

import {
  CANCELLATION_CAP_USD, POSSIBLE_FEE_RATE, RULES, SOURCES, TOPICS, WEIGHT_LABEL,
  estimateRefund, findRules, sourceOf,
} from '../../utils/commitmentRules';
import { formatAmount } from '../../utils/currency';

const WEIGHT_STYLE = {
  blocker: { chip: 'bg-rose-500/15 text-rose-300', icon: Lock, tone: 'text-rose-400' },
  cost: { chip: 'bg-amber-500/15 text-amber-300', icon: Wallet, tone: 'text-amber-400' },
  note: { chip: 'bg-slate-700/60 text-slate-300', icon: Info, tone: 'text-slate-400' },
};

const usd = (v) => formatAmount(v, 'USD');

function Rule({ rule }) {
  const style = WEIGHT_STYLE[rule.weight] || WEIGHT_STYLE.note;
  const Glyph = style.icon;
  const source = sourceOf(rule);
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-start gap-2.5">
        <Glyph size={14} className={`mt-0.5 shrink-0 ${style.tone}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-slate-100">{rule.question}</p>
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${style.chip}`}>
              {WEIGHT_LABEL[rule.weight]}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{rule.answer}</p>
          {rule.example && (
            <p className="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
              <span className="font-medium text-slate-300">Worked example — </span>
              {rule.example}
            </p>
          )}
          {rule.caution && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/90">
              <ShieldAlert size={11} className="mt-0.5 shrink-0" />
              {rule.caution}
            </p>
          )}
          {source && (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
            >
              <ExternalLink size={10} />
              {source.title}
              {source.revised ? ` — Microsoft Learn, revised ${source.revised}` : ' — Microsoft Learn'}
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-slate-600">{hint}</span>}
    </label>
  );
}

const INPUT = 'mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 '
  + 'text-sm text-slate-100 outline-none focus:border-sky-600';

function Estimator({ items, currency }) {
  const [commitment, setCommitment] = useState('');
  const [termMonths, setTermMonths] = useState(36);
  const [purchasedOn, setPurchasedOn] = useState('');
  const [cancelledUsd, setCancelledUsd] = useState('');
  const [usdRate, setUsdRate] = useState('1');

  // Reservations Azure told us about can fill in the two fields that are facts
  // rather than opinions: when it was bought and how long for. The commitment
  // amount is left blank on purpose -- Azure reports an amortised cost, not the
  // purchase price the refund is calculated from, and quietly substituting one
  // for the other would produce a refund figure that is wrong in a way nobody
  // could see.
  const prefillable = (items || []).filter(
    i => i.kind === 'reservation' && i.purchase_date && /^P\d+Y$/i.test(String(i.term || '')),
  );

  function prefill(id) {
    const item = prefillable.find(i => i.id === id);
    if (!item) return;
    setPurchasedOn(String(item.purchase_date).slice(0, 10));
    setTermMonths(Number(String(item.term).match(/\d+/)[0]) * 12);
  }

  const result = useMemo(() => estimateRefund({
    totalCommitment: Number(commitment),
    termMonths: Number(termMonths),
    purchasedOn,
    cancelledUsd: Number(cancelledUsd) || 0,
    usdRate: Number(usdRate) || 1,
  }), [commitment, termMonths, purchasedOn, cancelledUsd, usdRate]);

  const cur = currency || 'USD';
  const money = (v) => formatAmount(v, cur);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-800 px-5 py-3">
        <Calculator size={14} className="text-slate-400" />
        <div>
          <h3 className="text-sm font-semibold text-slate-200">What would cancelling cost?</h3>
          <p className="text-[11px] text-slate-500">
            Microsoft's own arithmetic, applied to numbers you supply. An estimate, not a quote —
            the portal is the only place the real figure exists.
          </p>
        </div>
      </div>

      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {prefillable.length > 0 && (
          <Field label="Fill from a reservation" hint="Sets the purchase date and term only.">
            <select className={INPUT} defaultValue="" onChange={e => prefill(e.target.value)}>
              <option value="">Choose…</option>
              {prefillable.map(i => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={`Total term commitment (${cur})`}
          hint="The whole term, not the monthly payment.">
          <input className={INPUT} type="number" min="0" inputMode="decimal"
            value={commitment} onChange={e => setCommitment(e.target.value)} placeholder="108000" />
        </Field>
        <Field label="Term">
          <select className={INPUT} value={termMonths}
            onChange={e => setTermMonths(Number(e.target.value))}>
            <option value={12}>1 year</option>
            <option value={36}>3 years</option>
            <option value={60}>5 years</option>
          </select>
        </Field>
        <Field label="Purchased on" hint="Refunds are counted in whole days, UTC.">
          <input className={INPUT} type="date" value={purchasedOn}
            onChange={e => setPurchasedOn(e.target.value)} />
        </Field>
        <Field label="Already cancelled (USD, last 12 months)"
          hint="Everything cancelled under the same billing profile or enrolment.">
          <input className={INPUT} type="number" min="0" inputMode="decimal"
            value={cancelledUsd} onChange={e => setCancelledUsd(e.target.value)} placeholder="0" />
        </Field>
        {cur !== 'USD' && (
          <Field label={`1 ${cur} in USD`} hint="The cap is stated in USD, so the conversion is yours to make.">
            <input className={INPUT} type="number" min="0" step="0.0001" inputMode="decimal"
              value={usdRate} onChange={e => setUsdRate(e.target.value)} />
          </Field>
        )}
      </div>

      {!result ? (
        <p className="border-t border-slate-800 px-5 py-4 text-xs text-slate-500">
          Enter the total commitment, the term and the purchase date to see what a refund
          would come to today.
        </p>
      ) : (
        <div className="border-t border-slate-800">
          <div className="grid divide-y divide-slate-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="px-5 py-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Refunded today</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-400">
                {money(result.refundNow)}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                {result.remainingDays} of {result.termDays} days unused. {money(result.consumed)} has
                been consumed.
              </p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                Early termination fee
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">
                {money(result.feeChargedToday)}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">
                Microsoft is not charging one today. If the {Math.round(POSSIBLE_FEE_RATE * 100)}%
                fee it has reserved the right to charge were enabled, you would lose{' '}
                {money(result.possibleFee)} and receive {money(result.refundIfFeeApplied)}.
              </p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                Against the {usd(CANCELLATION_CAP_USD)} cap
              </p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${
                result.withinCap ? 'text-slate-100' : 'text-rose-400'}`}>
                {usd(result.cancelledCommitmentUsd)}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                {result.withinCap
                  ? `Inside the ${usd(result.remainingCapUsd)} you have left in the rolling `
                    + '12-month window.'
                  : `Over by ${usd(result.capShortfallUsd)} — Azure will refuse this refund.`}
              </p>
              {!result.withinCap && result.cancellableOn && (
                <p className="mt-1 text-[11px] text-slate-400">
                  It comes under the cap around{' '}
                  {result.cancellableOn.toISOString().slice(0, 10)}, once enough of the
                  commitment has been consumed.
                </p>
              )}
            </div>
          </div>
          <p className="border-t border-slate-800 px-5 py-3 text-[11px] leading-relaxed text-slate-500">
            Straight-line by day, which is how Microsoft describes the calculation. Two things
            can move the real figure: refunds are worked out on the lower of your purchase price
            or the current price, and Red Hat, SUSE and pre-purchase plans cannot be refunded at
            all.{' '}
            <a href={SOURCES.refund.url} target="_blank" rel="noreferrer"
              className="text-sky-400 hover:text-sky-300">
              Read the policy
            </a>.
          </p>
        </div>
      )}
    </div>
  );
}

export default function CommitmentRules({ items = [], currency }) {
  const [topic, setTopic] = useState('all');
  const [query, setQuery] = useState('');

  const shown = useMemo(() => findRules(RULES, { topic, query }), [topic, query]);
  const counts = useMemo(() => {
    const map = { all: RULES.length };
    for (const t of TOPICS) map[t.key] = RULES.filter(r => r.topic === t.key).length;
    return map;
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-2.5">
        <BookOpen size={16} className="mt-0.5 shrink-0 text-slate-400" />
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Cancellation, exchange and refund rules
          </h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-500">
            Every rule below is quoted from Microsoft's published policy with a link to the
            article it came from. Nothing here is inferred. Two answers surprise most people:
            savings plans cannot be cancelled at all, and the widely quoted 12% cancellation
            penalty is a fee Microsoft has reserved the right to charge and has not switched on.
          </p>
        </div>
      </div>

      <Estimator items={items} currency={currency} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search the rules…"
            className="w-56 rounded-lg border border-slate-700 bg-slate-950 py-1.5 pl-7 pr-2.5 text-xs text-slate-100 outline-none focus:border-sky-600"
          />
        </div>
        {[{ key: 'all', label: 'Everything' }, ...TOPICS].map(t => (
          <button
            key={t.key}
            onClick={() => setTopic(t.key)}
            className={`rounded-lg px-2.5 py-1.5 text-xs transition ${
              topic === t.key
                ? 'bg-sky-500/15 text-sky-300'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {t.label}
            <span className="ml-1.5 text-[10px] text-slate-600">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 px-5 py-8 text-center text-xs text-slate-500">
          No rule matches “{query}”. Try the topic tabs — the wording here follows Microsoft's.
        </p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {shown.map(rule => <Rule key={rule.id} rule={rule} />)}
        </ul>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3">
        <p className="text-[11px] font-medium text-slate-400">Sources</p>
        <ul className="mt-1.5 space-y-1">
          {Object.values(SOURCES).map(s => (
            <li key={s.id}>
              <a href={s.url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300">
                <ExternalLink size={10} /> {s.title}
                {s.revised ? <span className="text-slate-600">— revised {s.revised}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
