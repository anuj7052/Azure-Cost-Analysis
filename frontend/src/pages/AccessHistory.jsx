/**
 * Every access change made through this application.
 *
 * This page exists because "who gave the contractor Owner, and when" is a
 * question that gets asked after something has gone wrong, when nobody
 * remembers and the Azure activity log has already rolled off. It is written
 * once, at the moment of the change, and never edited afterwards.
 *
 * Failures are shown alongside successes and are arguably the more interesting
 * record: a refused attempt to grant Owner on production is exactly the event
 * an investigation is looking for, and a history that quietly dropped it would
 * be worse than no history at all, because it would look complete.
 *
 * The list is scoped in the query itself to the signed-in account and the
 * selected tenant, so it can only ever show this customer's own administration.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Clock, Loader2 } from 'lucide-react';
import { fetchAccessHistory } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { friendlyError } from '../utils/apiError';
import { PageHeader, Empty, ErrorCard } from '../components/Security/SecurityShell';
import { SubscriptionName } from '../components/Common/Identity';

const ACTION_LABEL = {
  access_granted: 'Access given',
  access_removed: 'Access removed',
};

function Outcome({ result }) {
  if (result === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
        <Check size={12} /> Applied
      </span>
    );
  }
  if (result === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-400">
        <AlertTriangle size={12} /> Refused
      </span>
    );
  }
  // A row that was opened and never closed. The process did not get to record
  // an outcome, which is itself worth showing rather than guessing at.
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-400">
      <Clock size={12} /> Unconfirmed
    </span>
  );
}

function when(value) {
  if (!value) return 'Not available';
  const parsed = new Date(value.includes('Z') ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function AccessHistory() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  // One settled result rather than four independent flags. Loading is derived
  // by asking whether what we hold was loaded for the tenant now selected,
  // which also means a tenant switch cannot briefly show the previous
  // customer's history while the new request is in flight.
  const [settled, setSettled] = useState({ tenant: null, events: [], note: '', error: '' });
  const loading = Boolean(tenantId) && settled.tenant !== tenantId;
  const { events, note, error } = settled;

  useEffect(() => {
    if (!tenantId) return undefined;
    let live = true;

    fetchAccessHistory({ tenant_id: tenantId })
      .then(data => {
        if (!live) return;
        setSettled({
          tenant: tenantId,
          events: Array.isArray(data.events) ? data.events : [],
          note: data.note || '',
          error: '',
        });
      })
      .catch(err => {
        if (live) setSettled({ tenant: tenantId, events: [], note: '', error: friendlyError(err) });
      });

    return () => { live = false; };
  }, [tenantId]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Change history"
        subtitle="Access changes made through this application, newest first."
      />

      {error && <ErrorCard message={error} />}

      {loading && (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 size={14} className="animate-spin" /> Reading history…
        </p>
      )}

      {!loading && !error && events.length === 0 && (
        <Empty title="No access changes have been made through this application yet." />
      )}

      {events.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="p-3 font-semibold">When</th>
                <th className="p-3 font-semibold">Who did it</th>
                <th className="p-3 font-semibold">What</th>
                <th className="p-3 font-semibold">To whom</th>
                <th className="p-3 font-semibold">Before</th>
                <th className="p-3 font-semibold">After</th>
                <th className="p-3 font-semibold">Where</th>
                <th className="p-3 font-semibold">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map(event => (
                <tr key={event.event_id} className="border-b border-slate-800/60 align-top">
                  <td className="p-3 text-slate-400 whitespace-nowrap">{when(event.created_at)}</td>
                  <td className="p-3">
                    <p className="text-slate-200">{event.actor_name || 'Not recorded'}</p>
                    <p className="text-[11px] text-slate-500">{event.actor_email}</p>
                  </td>
                  <td className="p-3 text-slate-300">
                    {ACTION_LABEL[event.action] || event.action}
                  </td>
                  <td className="p-3">
                    <p className="text-slate-200">
                      {event.target_name || (
                        <span className="font-mono text-[11px] text-slate-500">
                          {event.target_id ? `${event.target_id.slice(0, 8)}…` : 'Not recorded'}
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] capitalize text-slate-500">{event.target_kind}</p>
                  </td>
                  <td className="p-3 text-slate-400">{event.previous_state || '—'}</td>
                  <td className="p-3 text-slate-400">{event.new_state || '—'}</td>
                  <td className="p-3 text-slate-400">
                    {event.subscription_id
                      ? <SubscriptionName id={event.subscription_id} />
                      : '—'}
                  </td>
                  <td className="p-3">
                    <Outcome result={event.result} />
                    {event.failure_reason && (
                      <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-red-300/70">
                        {event.failure_reason}
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-slate-600">
                      {event.event_id.slice(0, 12)}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {note && (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-xs leading-relaxed text-slate-400">
          {note}
        </p>
      )}
    </div>
  );
}
