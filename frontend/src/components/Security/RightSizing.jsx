import { useMemo, useState } from 'react';
import { ArrowDownRight, Check, HelpCircle, ShieldCheck } from 'lucide-react';
import { Principal, ScopePath } from '../Common/Identity';
import { Chips, Empty, Stat } from './SecurityShell';

/**
 * Role right-sizing: what the work actually needed.
 *
 * This answers the question a director asks and an access list cannot: if this
 * person only ever read things, why do they hold Owner? The backend compares
 * the tier of the role held against the highest kind of operation the Activity
 * Log recorded for that principal, and the difference is privilege being
 * carried for no observed reason.
 *
 * The interface is deliberately built around what the evidence supports.
 * `keep` rows are shown, not hidden, because a review that only ever lists
 * problems gives no sense of how much of the estate is fine. `review` rows are
 * kept visually distinct from `downgrade` rows because they are a question,
 * not a recommendation — the Activity Log records reads unreliably and no
 * data-plane traffic at all, so silence never becomes an instruction to revoke.
 */

const ACTION = {
  downgrade: {
    label: 'Smaller role would do',
    icon: ArrowDownRight,
    chip: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
    bar: 'border-l-amber-500',
  },
  review: {
    label: 'Needs a human',
    icon: HelpCircle,
    chip: 'bg-slate-800 text-slate-400 ring-1 ring-slate-700',
    bar: 'border-l-slate-600',
  },
  keep: {
    label: 'Correctly sized',
    icon: Check,
    chip: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    bar: 'border-l-emerald-500',
  },
};

const CONFIDENCE = {
  high: 'text-emerald-400',
  medium: 'text-amber-400',
  low: 'text-slate-500',
  none: 'text-slate-600',
};

function Row({ item }) {
  const meta = ACTION[item.action] || ACTION.review;
  const Icon = meta.icon;

  return (
    <div className={`rounded-xl border border-slate-800 border-l-4 bg-slate-800/30 p-3 transition hover:bg-slate-800/60 ${meta.bar}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="text-sm font-semibold text-white">
          <Principal item={item} />
        </span>
        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${meta.chip}`}>
          {meta.label}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 font-medium text-slate-200">
          {item.granted_role || 'Unknown role'}
        </span>
        {item.action === 'downgrade' && (
          <>
            <ArrowDownRight className="h-4 w-4 text-amber-400" aria-hidden="true" />
            <span className="rounded-lg bg-emerald-500/15 px-2 py-1 font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
              {item.recommended_role}
            </span>
          </>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-slate-400">{item.reason}</p>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-slate-500">
        <span>On <ScopePath scope={item.scope} className="text-[11px]" /></span>
        <span>{item.evidence.operations.toLocaleString()} ops</span>
        <span>{item.evidence.writes.toLocaleString()} changes</span>
        <span>{item.evidence.rbac.toLocaleString()} access grants</span>
        <span className={CONFIDENCE[item.confidence] || 'text-slate-500'}>
          {item.confidence} confidence
        </span>
      </div>
    </div>
  );
}

export default function RightSizing({ sizing }) {
  const [action, setAction] = useState('downgrade');

  const all = useMemo(() => sizing?.recommendations || [], [sizing]);
  const rows = useMemo(
    () => (action === 'all' ? all : all.filter(r => r.action === action)),
    [all, action],
  );

  if (!sizing) return null;
  const totals = sizing.totals || {};
  const byAction = totals.by_action || {};

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <ShieldCheck className="h-4 w-4 text-blue-400" aria-hidden="true" />
          Role right-sizing
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Every assignment, with the smallest role that would have covered the work
          actually recorded against it.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Assignments checked" value={totals.total || 0} />
        <Stat
          label="Could be smaller"
          value={totals.downgradable || 0}
          tone="text-amber-300"
        />
        <Stat
          label="Excess grant power"
          value={totals.excess_grant_power || 0}
          tone="text-red-300"
          hint="Owner-class roles held by someone never seen granting access"
        />
        <Stat label="Correctly sized" value={byAction.keep || 0} tone="text-emerald-300" />
      </div>

      <Chips
        value={action}
        onChange={setAction}
        options={[
          { key: 'downgrade', label: ACTION.downgrade.label, count: byAction.downgrade || 0 },
          { key: 'review', label: ACTION.review.label, count: byAction.review || 0 },
          { key: 'keep', label: ACTION.keep.label, count: byAction.keep || 0 },
          { key: 'all', label: 'All', count: totals.total || 0 },
        ]}
      />

      <div className="space-y-2">
        {rows.length === 0 ? (
          <Empty title="Nothing in this category">
            {action === 'downgrade'
              ? 'No assignment was seen doing less than the role it holds allows. Check the coverage line above before reading that as a clean result.'
              : 'Try another category.'}
          </Empty>
        ) : (
          rows.slice(0, 100).map((item, i) => <Row key={`${item.principal_id}-${item.scope}-${i}`} item={item} />)
        )}
      </div>

      {rows.length > 100 && (
        <p className="text-xs text-slate-500">
          Showing the first 100 of {rows.length}. Narrow the category to see the rest.
        </p>
      )}

      <p className="border-t border-slate-800 pt-3 text-xs leading-relaxed text-slate-500">
        {sizing.note}
      </p>
    </section>
  );
}
