import { useMemo, useState } from 'react';
import {
  ChevronRight, ExternalLink, History, Info, RefreshCw,
} from 'lucide-react';
import DetailPanel from '../Common/DetailPanel';
import {
  GRAINS, KIND_FULL, MISSING, commitmentDetail, costUnavailableReason, dateLabel,
  expiryLabel, money, percent, termLabel, usedAt, utilisationBar, utilisationTone,
  wastageOf,
} from '../../utils/commitments';

/**
 * Everything Azure returned about one commitment.
 *
 * The inventory table answers a different question -- which of these is a
 * problem -- and the answer to "what exactly did we buy, and what is it
 * costing" does not fit in a row.
 *
 * Laid out as labelled pairs rather than a single column of rows. A commitment
 * has four facts people read together and compare against each other -- what it
 * is, how long it runs, when it started, when it ends -- and a stack of
 * full-width rows forces the eye down the page one fact at a time. Two columns
 * put the pair that belongs together on the same line.
 *
 * Nothing here is filled in. A value Azure did not return reads "Not
 * available", and the three figures extrapolated from a measured one say so
 * underneath rather than sitting beside the measured ones looking identical.
 */

const PORTAL_RESERVATIONS
  = 'https://portal.azure.com/#view/Microsoft_Azure_Reservations/ReservationsBrowseBlade';

/*
 * Three tabs rather than one long scroll. The panel now carries the term, the
 * amounts, the scopes, three utilisation windows and the cancellation rules,
 * and stacked in one column the rules -- the thing somebody opens this to read
 * before making a decision -- sat several screens below the fold.
 */
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'usage', label: 'Usage history' },
  { key: 'cancel', label: 'If you cancel' },
];

/** One labelled fact. Half a row in the pair grid. */
function Pair({ label, value, note }) {
  const missing = value === MISSING || value === undefined || value === null;
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p
        className={`mt-0.5 break-words text-sm ${missing ? 'text-slate-600' : 'text-slate-100'}`}
        title={typeof value === 'string' ? value : undefined}
      >
        {missing ? MISSING : value}
      </p>
      {note && <p className="mt-0.5 text-[10px] leading-snug text-slate-600">{note}</p>}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-3 border-b border-slate-800 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The same commitment measured over every window Azure publishes.
 *
 * One window can mislead in either direction -- a reservation bought last week
 * looks unused at thirty days, and one abandoned yesterday still looks healthy.
 * Seeing the three together is what separates the two.
 */
function Utilisation({ item }) {
  return (
    <div className="space-y-3">
      {GRAINS.map(({ key, label }) => {
        const used = usedAt(item, key);
        const known = used !== null && used !== undefined;
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-[11px] text-slate-500">{label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
              {known && (
                <div
                  className={`h-full rounded-full ${utilisationBar(used)}`}
                  style={{ width: `${Math.max(2, Math.min(100, used))}%` }}
                />
              )}
            </div>
            <span className={`w-20 text-right text-xs tabular-nums ${utilisationTone(used)}`}>
              {known ? percent(used) : MISSING}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function CommitmentDetail({
  item, grain, currency, onClose, children, initialTab = 'overview',
}) {
  const sections = useMemo(() => commitmentDetail(item, grain), [item, grain]);
  const [tab, setTab] = useState(initialTab);
  if (!item) return null;

  const ccy = item.currency || currency;
  const lost = wastageOf(item, grain);
  const scopes = (item.scopes || []).filter(Boolean);
  const noCost = costUnavailableReason(item);
  // Amounts is pulled out and drawn first because it is the section carrying
  // the warning; the rest keep the order the util returns them in.
  const amounts = sections.find(s => s.title === 'Amounts');
  const detail = sections.filter(s => s.title !== 'Amounts');

  return (
    <DetailPanel
      open
      title={item.name || 'Commitment'}
      onClose={onClose}
      eyebrow={(
        <span className="flex items-center gap-1">
          Commitments <ChevronRight size={11} className="text-slate-600" /> Details
        </span>
      )}
      subtitle={(
        <span className="font-mono text-[11px] text-slate-500">
          {KIND_FULL[item.kind] || item.kind} · {item.id || MISSING}
        </span>
      )}
      footer={(
        <div className="flex flex-col gap-2 sm:flex-row">
          {/* Renewal is a billing action Azure will not let this app take, so
              the button says where it lands rather than implying otherwise. */}
          <a
            href={PORTAL_RESERVATIONS}
            target="_blank"
            rel="noreferrer"
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500"
          >
            <RefreshCw size={14} /> Renew in Azure
          </a>
          <button
            type="button"
            onClick={() => setTab('usage')}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
          >
            <History size={14} /> View usage history
          </button>
        </div>
      )}
    >
      <div className="space-y-4">
        {/* The three numbers somebody opens this panel for, before the detail
            they open it to confirm. */}
        <div className="grid grid-cols-3 gap-2">
          {[
            ['Per month', money(item.monthly_cost, ccy), 'text-slate-100'],
            ['Wasted', money(lost, ccy), lost ? 'text-rose-400' : 'text-slate-100'],
            ['Time left', expiryLabel(item.days_to_expiry), 'text-slate-100'],
          ].map(([label, value, tone]) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
              <p className={`mt-1 text-sm font-semibold ${tone}`}>{value}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-1 border-b border-slate-800">
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition ${
                tab === t.key
                  ? 'border-sky-500 text-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="space-y-4">
            <Card title="Commitment overview">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <Pair label="Type" value={KIND_FULL[item.kind] || item.kind} />
                <Pair label="Duration" value={termLabel(item.term)} />
                <Pair label="Term start" value={dateLabel(item.purchase_date)} />
                <Pair label="Term end" value={dateLabel(item.expiry)} />
              </div>
            </Card>

            <Card title="Amounts">
              {/* Said once, above the five figures it explains. Every amount
                  collapsing to "Not available" together looks like a broken
                  page, and it is almost always a subscription selection. */}
              {noCost && (
                <div className="mb-3 flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                  <Info size={13} className="mt-0.5 shrink-0 text-amber-300" />
                  <p className="text-[11px] leading-relaxed text-amber-200/90">{noCost}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                {(amounts?.rows || []).map(([label, value, note]) => (
                  <Pair key={label} label={label} value={value} note={note} />
                ))}
              </div>
            </Card>

            {detail.map(section => (
              <Card key={section.title} title={section.title}>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  {section.rows.map(([label, value, note]) => (
                    <Pair key={label} label={label} value={value} note={note} />
                  ))}
                </div>
              </Card>
            ))}

            {/* Listed in full only when there is more than one, because a single
                scope is already shown above and repeating it reads as two
                facts. */}
            {scopes.length > 1 && (
              <Card title="Applied scopes">
                <ul className="space-y-1">
                  {scopes.map(scope => (
                    <li key={scope} className="break-all text-[11px] text-slate-400">{scope}</li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}

        {tab === 'usage' && (
          <Card title="Utilisation by window">
            <Utilisation item={item} />
          </Card>
        )}

        {tab === 'cancel' && (
          <div className="space-y-4">
            {children || (
              <p className="text-xs text-slate-500">
                Nothing specific to flag for this commitment.
              </p>
            )}
            <a
              href={PORTAL_RESERVATIONS}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300"
            >
              Open Reservations in the Azure portal <ExternalLink size={11} />
            </a>
          </div>
        )}
      </div>
    </DetailPanel>
  );
}
