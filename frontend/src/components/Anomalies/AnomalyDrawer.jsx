import { useEffect, useState } from 'react';
import {
  TrendingUp, TrendingDown, Sparkles, CircleSlash, Minus,
  ExternalLink, Loader2, AlertTriangle,
} from 'lucide-react';
import DetailPanel from '../Common/DetailPanel';
import { formatAmount, formatAmountFull } from '../../utils/currency';
import { setAnomalyStatus, fetchAnomalyHistory } from '../../api/client';
import { friendlyError } from '../../utils/apiError';
import {
  possibleCauses, severityLabel, severityHint, directionLabel, STATUSES,
} from '../../utils/anomalyView';

const DIRECTION_ICON = {
  increase: TrendingUp,
  decrease: TrendingDown,
  new: Sparkles,
  removed: CircleSlash,
  flat: Minus,
};

const STATUS_LABEL = {
  new: 'Not looked at yet',
  investigating: 'Being looked into',
  acknowledged: 'Known and expected',
  resolved: 'Dealt with',
  ignored: 'Not worth chasing',
};

function Figure({ label, value, currency, hint }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">
        {/* An absence is written out. A dash invites the reader to assume zero. */}
        {value == null ? <span className="text-slate-500 text-sm">Not available</span> : formatAmountFull(value, currency)}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

/**
 * Everything known about one cost change, and the only place it can be triaged.
 *
 * The drawer exists because a table row can carry an amount but not an
 * argument. Whether a ₹18,000 increase matters depends on what else moved with
 * it, and that context does not fit in a cell.
 */
export default function AnomalyDrawer({ open, row, currency, tenantId, siblings, onClose, onStatusChange }) {
  const [history, setHistory] = useState([]);
  const [historyState, setHistoryState] = useState('idle');
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const key = row?.anomaly_key;

  useEffect(() => {
    if (!open || !key || !tenantId) return undefined;
    let live = true;
    setHistoryState('loading');
    setError('');
    fetchAnomalyHistory(tenantId, key)
      .then((data) => { if (live) { setHistory(data.history || []); setHistoryState('ready'); } })
      .catch((e) => { if (live) { setHistoryState('error'); setError(friendlyError(e)); } });
    return () => { live = false; };
  }, [open, key, tenantId]);

  useEffect(() => { setComment(''); }, [key]);

  if (!row) return null;

  const Icon = DIRECTION_ICON[row.direction] || Minus;
  const rising = (row.delta || 0) > 0;
  const causes = possibleCauses(row);

  // Same service, other subscriptions. A spike in one place reads very
  // differently once you can see whether it happened everywhere at once.
  const elsewhere = (siblings || []).filter(
    (s) => s.service === row.service && s.subscription_id !== row.subscription_id,
  );

  const save = async (status) => {
    setSaving(true);
    setError('');
    try {
      const result = await setAnomalyStatus({
        tenant_id: tenantId,
        anomaly_key: key,
        status,
        comment,
        subscription_id: row.subscription_id || '',
        service: row.service || '',
        resource_name: row.resource_name || '',
      });
      setHistory(result.history || []);
      setComment('');
      onStatusChange?.(key, status);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailPanel
      open={open}
      onClose={onClose}
      title={row.service || 'Cost change'}
      subtitle={row.resource_name || row.resource_group || row.subscription_name || ''}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${rising ? 'text-red-400' : 'text-emerald-400'}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">
              {directionLabel(row.direction)}
              {row.pct_change != null && ` by ${Math.abs(row.pct_change).toFixed(1)}%`}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              {severityLabel(row.severity)} — {severityHint(row.severity)}
            </p>
            {row.note && <p className="mt-1 text-xs text-slate-400">{row.note}</p>}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Figure label="Previous period" value={row.previous_cost} currency={currency} />
          <Figure label="This period" value={row.current_cost} currency={currency} />
          <Figure
            label="Change"
            value={row.delta}
            currency={currency}
            hint={row.pct_change == null ? 'No previous cost to compare against' : null}
          />
        </div>

        <section>
          <h3 className="text-sm font-semibold text-white">Possible causes</h3>
          {/* Billing data records that spend moved, never why. Everything below
              is phrased as a possibility because that is all it can be. */}
          <p className="mt-0.5 text-[11px] text-slate-500">
            Azure billing does not record a reason. These are possibilities based on the figures, not confirmed causes.
          </p>
          <ul className="mt-2 space-y-1.5">
            {causes.map((c) => (
              <li key={c} className="flex gap-2 text-xs text-slate-300">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-600" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>

        {elsewhere.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold text-white">The same service elsewhere</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {row.service} also changed in {elsewhere.length} other subscription{elsewhere.length === 1 ? '' : 's'} this period.
            </p>
            <div className="mt-2 space-y-1">
              {elsewhere.slice(0, 6).map((s) => (
                <div key={s.anomaly_key} className="flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-2 text-xs">
                  <span className="truncate text-slate-300">{s.subscription_name || s.subscription_id}</span>
                  <span className={(s.delta || 0) > 0 ? 'text-red-300' : 'text-emerald-300'}>
                    {(s.delta || 0) > 0 ? '+' : ''}{formatAmount(s.delta, currency)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h3 className="text-sm font-semibold text-white">Mark this</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Saved for your account in this tenant, so nobody re-investigates something you have already closed.
          </p>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Optional note — what you found, or why this is expected"
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={saving}
                onClick={() => save(s)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  (row.status || 'new') === s
                    ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600 hover:text-white'
                }`}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          {saving && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </p>
          )}
          {error && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-red-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {error}
            </p>
          )}
        </section>

        <section>
          <h3 className="text-sm font-semibold text-white">Activity</h3>
          {historyState === 'loading' && <p className="mt-1 text-xs text-slate-500">Loading…</p>}
          {historyState !== 'loading' && history.length === 0 && (
            <p className="mt-1 text-xs text-slate-500">Nobody has recorded anything against this yet.</p>
          )}
          <ol className="mt-2 space-y-2">
            {history.map((h, i) => (
              <li key={`${h.created_at}-${i}`} className="rounded-lg bg-slate-900/60 px-3 py-2">
                <p className="text-xs text-slate-300">
                  <span className="font-medium text-white">{h.actor_name || h.actor_email || 'Someone'}</span>
                  {' '}moved this from {STATUS_LABEL[h.previous_status] || h.previous_status}
                  {' '}to {STATUS_LABEL[h.new_status] || h.new_status}
                </p>
                {h.comment && <p className="mt-0.5 text-xs text-slate-400">“{h.comment}”</p>}
                <p className="mt-0.5 text-[11px] text-slate-600">{h.created_at}</p>
              </li>
            ))}
          </ol>
        </section>

        <details className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-400">Technical details</summary>
          <dl className="mt-2 space-y-1 text-[11px] text-slate-500">
            <div><dt className="inline text-slate-600">Subscription id: </dt><dd className="inline break-all">{row.subscription_id || 'Not available'}</dd></div>
            <div><dt className="inline text-slate-600">Resource group: </dt><dd className="inline">{row.resource_group || 'Not available'}</dd></div>
            <div><dt className="inline text-slate-600">Region: </dt><dd className="inline">{row.region || 'Not available'}</dd></div>
            <div><dt className="inline text-slate-600">Tracking id: </dt><dd className="inline break-all">{key}</dd></div>
          </dl>
          {row.subscription_id && (
            <a
              href={`https://portal.azure.com/#@/resource/subscriptions/${row.subscription_id}/overview`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300"
            >
              Open this subscription in the Azure portal <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </details>
      </div>
    </DetailPanel>
  );
}
