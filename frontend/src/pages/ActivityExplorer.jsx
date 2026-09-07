import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Activity, Loader2, User, AlertTriangle, XCircle, CheckCircle2, Filter, Clock,
} from 'lucide-react';
import { fetchActivity } from '../api/client';
import { describeResourceId } from '../utils/azureSku';
import { useAppStore } from '../store/useAppStore';

const WINDOWS = [1, 7, 30, 90];

function when(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function EventRow({ event, subscriptionName }) {
  const { name, service } = describeResourceId(event.resource_id);
  const facts = [
    service,
    event.resource_group && `Resource group ${event.resource_group}`,
    subscriptionName,
  ].filter(Boolean);

  return (
    <div className="border border-slate-800 bg-slate-800/30 rounded-xl p-3">
      <div className="flex items-start gap-2.5">
        {event.succeeded
          ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          : <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />}

        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-100">
            <span className="font-medium">{event.caller}</span>
            <span className="text-slate-400"> — {event.summary.toLowerCase()}</span>
            {name && <span className="text-slate-200"> {name}</span>}
          </p>

          {facts.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
              {facts.map((fact, i) => (
                <span key={fact}>
                  {i > 0 && <span className="mr-1.5 text-slate-600">·</span>}
                  {fact}
                </span>
              ))}
            </p>
          )}

          <p className="text-[11px] text-slate-500 mt-0.5">
            {when(event.at)}
            {!event.succeeded && (
              <span className="text-red-400"> · {event.status || 'Failed'}</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function Rank({ title, rows, labelKey }) {
  if (!rows?.length) return null;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
        {title}
      </h3>
      <div className="space-y-2">
        {rows.slice(0, 8).map(row => (
          <div key={row[labelKey]} className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-300 truncate" title={row[labelKey]}>
              {row[labelKey]}
            </span>
            <span className="text-sm text-slate-400 tabular-nums shrink-0">{row.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ActivityExplorer() {
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const subscriptions = useAppStore(s => s.subscriptions);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(7);
  const [writesOnly, setWritesOnly] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) {
      setData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchActivity(selectedTenantId, selectedSubscriptionIds, { days, writesOnly })
      .then(result => { if (!cancelled) setData(result); })
      .catch(err => {
        if (!cancelled) {
          const detail = err.response?.data?.detail || err.message;
          setError(detail);
          toast.error(detail);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [selectedTenantId, selectedSubscriptionIds.join(','), days, writesOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // A subscription is chosen by name everywhere else in this app, so the log
  // should name it too rather than make the reader match GUIDs by eye.
  const subscriptionNames = useMemo(() => Object.fromEntries(
    (subscriptions || []).map(s => [
      s.subscription_id,
      s.display_name || s.name || s.subscription_id,
    ]),
  ), [subscriptions]);

  const term = search.trim().toLowerCase();
  const events = (data?.events || []).filter(e => {
    if (!term) return true;
    const { name, service } = describeResourceId(e.resource_id);
    return [
      e.caller, e.summary, name, service, e.resource_group,
      subscriptionNames[e.subscription_id],
    ].some(field => String(field || '').toLowerCase().includes(term));
  });

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Activity Explorer</h1>
        <p className="text-slate-400 text-sm mt-1">
          Who changed what, and when — from the Azure Activity Log
        </p>
      </div>

      {!selectedTenantId && (
        <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-6 text-center">
          <p className="text-blue-300 font-medium">No tenant selected</p>
          <p className="text-slate-400 text-sm mt-1">Add a tenant from Settings to get started.</p>
        </div>
      )}

      {selectedTenantId && selectedSubscriptionIds.length === 0 && (
        <div className="bg-amber-950/30 border border-amber-500/30 rounded-2xl p-5">
          <p className="text-amber-300 font-medium text-sm">No subscriptions selected</p>
          <p className="text-slate-400 text-sm mt-1">
            Choose one or more subscriptions to read their activity.
          </p>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-slate-950 border border-slate-700 rounded-xl p-1">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                days === w ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {w === 1 ? '24h' : `${w}d`}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={writesOnly}
            onChange={e => setWritesOnly(e.target.checked)}
            className="accent-blue-500"
          />
          Changes only
        </label>

        <div className="relative flex-1 min-w-[200px]">
          <Filter className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by person, resource, service or subscription…"
            className="h-9 w-full rounded-xl border border-slate-700 bg-slate-950/60 pl-9 pr-3 text-xs text-white placeholder-slate-600 outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          Reading the Activity Log…
        </div>
      )}

      {error && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-2xl p-4 text-red-400 text-sm">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 elevated">
              <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                <Activity className="w-4 h-4" />
                {writesOnly ? 'Changes' : 'Operations'}
              </div>
              <p className="mt-2 text-2xl font-semibold text-slate-100 tabular-nums">{data.total}</p>
              <p className="mt-1 text-xs text-slate-500">in the last {data.window_days} days</p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 elevated">
              <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                <User className="w-4 h-4" />
                People and apps
              </div>
              <p className="mt-2 text-2xl font-semibold text-slate-100 tabular-nums">
                {data.callers?.length || 0}
              </p>
              <p className="mt-1 text-xs text-slate-500">made those changes</p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 elevated">
              <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                <XCircle className="w-4 h-4" />
                Failed attempts
              </div>
              <p className="mt-2 text-2xl font-semibold text-red-300 tabular-nums">{data.failed}</p>
              <p className="mt-1 text-xs text-slate-500">refused or errored</p>
            </div>
          </div>

          {data.errors?.length > 0 && (
            <div className="flex items-start gap-2 bg-amber-950/30 border border-amber-500/30 rounded-2xl p-3.5">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400 leading-relaxed">
                {data.errors.length} subscription(s) could not be read, so this list is
                partial. The credential needs the Reader role on each subscription.
              </p>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Rank title="Who changed the most" rows={data.callers} labelKey="caller" />
            <Rank title="Most common operations" rows={data.operations} labelKey="operation" />
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-300 mb-3">
              Timeline {term && <span className="text-slate-500">· {events.length} matching</span>}
            </h2>

            {events.length === 0 ? (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center">
                <Clock className="w-9 h-9 text-slate-600 mx-auto mb-3" />
                <p className="text-white font-semibold">
                  {term ? 'Nothing matches that filter' : 'No changes in this window'}
                </p>
                <p className="text-slate-400 text-sm mt-1">
                  {term
                    ? 'Try a different person, resource or operation.'
                    : 'Nothing was created, updated or deleted in the selected period.'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {events.slice(0, 200).map(event => (
                  <EventRow
                    key={`${event.id}-${event.at}`}
                    event={event}
                    subscriptionName={subscriptionNames[event.subscription_id]}
                  />
                ))}
                {events.length > 200 && (
                  <p className="text-[11px] text-slate-600 text-center pt-2">
                    Showing the 200 most recent of {events.length}.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Retention is a hard Azure limit, not a setting. Without saying so,
              an empty 90-day window reads as "nothing ever happened" rather
              than "Azure no longer holds the answer". */}
          <p className="text-xs text-slate-600 leading-relaxed">
            Azure retains about {data.retention_days} days of activity, so changes older
            than that cannot be attributed to anyone — the record no longer exists. The
            log covers control-plane operations only: something changed from inside a
            virtual machine leaves no entry here.
          </p>
        </>
      )}
    </div>
  );
}
