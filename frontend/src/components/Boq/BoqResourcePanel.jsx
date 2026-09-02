/**
 * From a service, to the machines under it, to one machine's whole story.
 *
 * Clicking "Virtual Machines" on the timeline gets you the list; clicking a
 * name in the list gets you that resource. The list is built entirely from the
 * billing rows already on the page, so it appears instantly and cannot
 * disagree with the totals it was opened from. The resource view goes further
 * than billing can — when it was created, what has changed it since, who did
 * it — and that costs a call to Azure, so it is only made when somebody asks
 * for one particular resource.
 *
 * Where Azure cannot answer, this says which part is missing and why. A blank
 * where a creation date should be reads as "nothing happened", and that is the
 * one thing it never means.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowLeft, Clock, ExternalLink, Loader2, Server, Trash2, User, X,
} from 'lucide-react';

import {
  fetchResourceTimeline, fetchServiceResources, searchResources,
} from '../../api/client';
import { formatAmount } from '../../utils/currency';
import { resourcesInService, summariseTimeline } from '../../utils/boqResources';

const when = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : d.toLocaleString();
};

/** A lifecycle date, with the honesty about it that the backend went to the trouble of computing. */
function Moment({ icon, label, value, tone = 'text-slate-200' }) {
  const Glyph = icon;
  return (
    <div className="flex items-start gap-2.5">
      <Glyph size={14} className="mt-0.5 shrink-0 text-slate-500" />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
        {value ? (
          <>
            <p className={`text-xs font-medium ${tone}`}>
              {when(value.at)}
              {value.exact === false && (
                <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-300">
                  at or before
                </span>
              )}
            </p>
            {value.by && (
              <p className="mt-0.5 truncate text-[11px] text-slate-500" title={value.by}>
                by {value.by}
              </p>
            )}
            {value.detail && (
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">{value.detail}</p>
            )}
          </>
        ) : (
          <p className="text-xs text-slate-600">Not available</p>
        )}
      </div>
    </div>
  );
}

/**
 * The list of resources billed under one service.
 *
 * Ordered by what they cost, because that is the order somebody works down.
 * The SKU is named on every row: two machines with the same name in different
 * groups are two machines, and two D8s in the same group are a different
 * problem from a D8 and a D2.
 *
 * The rows already on the page are tried first, and on an uploaded file they
 * are enough. On a plain login they are not: the query that feeds this page
 * asks Cost Management for usage quantities, and Azure will not return a
 * resource id alongside those, so every row arrives named only down to its
 * resource group. Rather than show an empty list, this asks the narrower
 * question for the one service that was clicked.
 */
export function ServiceResources({
  service, rows, query, currency, onPick, onBack, onClose,
}) {
  const local = useMemo(() => resourcesInService(rows, service), [rows, service]);
  // A listing with an unnamed remainder and no named resources is what the
  // quantity query produces; that is the case worth a second call, not a
  // service that genuinely has nothing under it.
  const askAzure = !!service && !!query && !local?.resources?.length;

  const [remote, setRemote] = useState({ for: null, rows: null, error: '' });
  const loading = askAzure && remote.for !== service;

  useEffect(() => {
    if (!askAzure) return undefined;
    let alive = true;
    (async () => {
      try {
        const data = await fetchServiceResources({ ...query, service });
        if (alive) setRemote({ for: service, rows: data?.rows || [], error: '' });
      } catch (err) {
        if (alive) {
          setRemote({
            for: service,
            rows: null,
            error: err.response?.data?.detail || err.message,
          });
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAzure, service, JSON.stringify(query || {})]);

  const fetched = useMemo(
    () => (remote.for === service ? resourcesInService(remote.rows, service) : null),
    [remote, service],
  );
  const listing = local?.resources?.length ? local : fetched;

  if (!service) return null;
  const fmt = (v) => formatAmount(v, currency);

  const head = (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-slate-200" title={service}>
          {service}
        </h2>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {listing
            ? `${listing.resources.length} resource${listing.resources.length === 1 ? '' : 's'} billed, ${fmt(listing.total)} in total. Pick one to see when it was created and what has changed it since.`
            : 'Finding the resources billed under this service.'}
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        {onBack && (
          <button
            onClick={onBack}
            className="rounded-lg border border-slate-700 p-1 text-slate-400 transition hover:border-slate-500 hover:text-white"
            aria-label="Back"
          >
            <ArrowLeft size={13} />
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-700 p-1 text-slate-400 transition hover:border-slate-500 hover:text-white"
          aria-label="Close"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900">
        {head}
        <p className="flex items-center gap-2 px-5 py-8 text-xs text-slate-500">
          <Loader2 size={14} className="animate-spin" />
          Asking Azure which resources this service billed for.
        </p>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900">
        {head}
        <p className="px-5 py-6 text-xs leading-relaxed text-slate-400">
          {remote.error
            ? `Azure could not break this service down by resource: ${remote.error}`
            : 'Azure billed this service without naming a resource against any of it. Some meters — bandwidth, support and most marketplace charges — are billed at the subscription and have no resource behind them.'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900">
      {head}

      {listing.unnamed > 0 && (
        <p className="border-b border-slate-800 px-5 py-2 text-[11px] text-amber-400/80">
          {fmt(listing.unnamed)} of this service is billed without a resource name and cannot be
          listed below. Some meters bill at the subscription rather than at a resource.
        </p>
      )}

      <ul className="max-h-96 divide-y divide-slate-800 overflow-y-auto">
        {listing.resources.map(r => (
          <li key={r.key}>
            <button
              onClick={() => onPick?.(r)}
              className="flex w-full items-start gap-3 px-5 py-2.5 text-left transition hover:bg-slate-800/40"
            >
              <Server size={13} className="mt-1 shrink-0 text-slate-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-100" title={r.name}>
                  {r.name}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                  {[r.sku, r.group, r.region].filter(Boolean).join(' · ') || 'No further detail billed'}
                </p>
                {r.skuChanges.length > 0 && (
                  <p className="mt-0.5 text-[10px] text-amber-400/80">
                    Changed size in {r.skuChanges[r.skuChanges.length - 1].month}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs font-semibold tabular-nums text-slate-200">{fmt(r.total)}</p>
                <p className="text-[10px] tabular-nums text-slate-600">
                  {r.share}% · {r.monthsBilled} month{r.monthsBilled === 1 ? '' : 's'}
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One resource: what it cost here, and what Azure knows about its life.
 *
 * The billing half is drawn from rows the page already had. The lifecycle half
 * needs the full Azure resource id, which billing does not carry, so the name
 * is looked up against the scan history first. If it has never been scanned
 * there is no history to show, and that is said plainly rather than shown as
 * an empty list.
 */
export function ResourceDetail({ resource, tenantId, currency, onBack, onClose }) {
  // The key the state belongs to travels with it, so switching resource reads
  // as loading without having to blank the state first -- setting state at the
  // top of an effect just to clear it costs an extra render of the wrong data.
  const [state, setState] = useState({ for: null, error: '', data: null, id: null });
  const loading = state.for !== resource?.key;
  const fmt = (v) => formatAmount(v, currency);

  useEffect(() => {
    let alive = true;
    const key = resource?.key;
    const settle = (next) => { if (alive) setState({ for: key, ...next }); };

    (async () => {
      if (!tenantId || !resource?.name) {
        settle({
          data: null,
          id: null,
          error: 'No tenant is selected, so the change history cannot be read.',
        });
        return;
      }
      try {
        // Billing knows the name; the timeline needs the full ARM id. The scan
        // index is the only thing that holds both.
        const found = await searchResources(tenantId, resource.name);
        const hits = found?.results || found?.resources || [];
        const match = hits.find(
          h => String(h.name || '').toLowerCase() === resource.name.toLowerCase(),
        ) || hits[0];

        if (!match?.resource_id) {
          settle({
            data: null,
            id: null,
            error: 'This resource has never appeared in a scan, so there is no '
              + 'change history for it. Run a scan on this tenant and it will be '
              + 'tracked from then on.',
          });
          return;
        }

        const timeline = await fetchResourceTimeline(tenantId, match.resource_id);
        settle({ error: '', id: match.resource_id, data: summariseTimeline(timeline) });
      } catch (err) {
        settle({
          data: null,
          id: null,
          error: err?.response?.data?.detail || err?.message || 'Could not read the history.',
        });
      }
    })();

    return () => { alive = false; };
  }, [tenantId, resource?.key, resource?.name]);

  const life = loading ? null : state.data;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-100" title={resource.name}>
            {resource.name}
          </h2>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">
            {[resource.sku, resource.group, resource.region].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={onBack}
            className="rounded-lg border border-slate-700 p-1 text-slate-400 transition hover:border-slate-500 hover:text-white"
            aria-label="Back to the service"
          >
            <ArrowLeft size={13} />
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-700 p-1 text-slate-400 transition hover:border-slate-500 hover:text-white"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── What this page's own billing rows say ─────────────────────────── */}
      <div className="border-b border-slate-800 px-5 py-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Cost in this period</p>
            <p className="text-lg font-semibold tabular-nums text-slate-100">{fmt(resource.total)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Billed</p>
            <p className="text-sm tabular-nums text-slate-300">
              {resource.firstMonth}
              {resource.lastMonth !== resource.firstMonth && ` to ${resource.lastMonth}`}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Share of service</p>
            <p className="text-sm tabular-nums text-slate-300">{resource.share}%</p>
          </div>
        </div>

        {resource.months.length > 1 && (
          <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
            {resource.months.map(m => (
              <li key={m.month} className="tabular-nums">
                {m.month} <span className="text-slate-300">{fmt(m.cost)}</span>
              </li>
            ))}
          </ul>
        )}

        {resource.meters.length > 1 && (
          <div className="mt-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Meters</p>
            <ul className="mt-1 space-y-0.5">
              {resource.meters.map(m => (
                <li key={m.name} className="flex justify-between gap-3 text-[11px]">
                  <span className="truncate text-slate-400">{m.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {fmt(m.cost)}
                    {m.quantity > 0 && ` · ${m.quantity} ${m.unit}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* The one structural change billing can prove without help from Azure. */}
      {resource.skuChanges.length > 0 && (
        <div className="border-b border-slate-800 px-5 py-3">
          <p className="text-[10px] uppercase tracking-wide text-amber-400/80">
            Size changed, according to the meters it was billed on
          </p>
          <ul className="mt-1.5 space-y-1">
            {resource.skuChanges.map(c => (
              <li key={c.month} className="text-[11px] text-slate-400">
                <span className="tabular-nums text-slate-500">{c.month}</span>{' '}
                {c.from} → <span className="text-slate-200">{c.to}</span>
                <span className={c.delta > 0 ? 'ml-2 text-rose-400' : 'ml-2 text-emerald-400'}>
                  {c.delta > 0 ? '+' : '−'}{fmt(Math.abs(c.delta))} a month
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── What Azure and our own scans know about its life ──────────────── */}
      {loading && (
        <p className="flex items-center justify-center gap-2 px-5 py-8 text-xs text-slate-500">
          <Loader2 size={13} className="animate-spin" />
          Reading the change history…
        </p>
      )}

      {!loading && state.error && (
        <p className="flex items-start gap-2 px-5 py-5 text-[11px] leading-relaxed text-slate-500">
          <AlertCircle size={13} className="mt-0.5 shrink-0 text-amber-400" />
          {state.error}
        </p>
      )}

      {!loading && life?.known && (
        <>
          <div className="grid grid-cols-1 gap-4 border-b border-slate-800 px-5 py-3.5 sm:grid-cols-3">
            <Moment icon={Clock} label="Created" value={life.created} />
            <Moment icon={User} label="Last changed" value={life.lastChanged} />
            {life.stillPresent
              ? (
                <div className="flex items-start gap-2.5">
                  <Server size={14} className="mt-0.5 shrink-0 text-slate-500" />
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Status</p>
                    <p className="text-xs font-medium text-emerald-400">Still present</p>
                    <p className="mt-0.5 text-[10px] text-slate-600">
                      Seen in the scan of {when(life.lastSeen)}
                    </p>
                  </div>
                </div>
              )
              : <Moment icon={Trash2} label="Deleted" value={life.deleted} tone="text-rose-400" />}
          </div>

          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              {life.changeCount === 0
                ? 'Change history'
                : `${life.changeCount} recorded change${life.changeCount === 1 ? '' : 's'} across ${life.scanCount} scans`}
            </p>

            {life.changeCount === 0 ? (
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                Nothing about this resource has changed between any two scans. That is a
                finding, not a gap — it has been scanned {life.scanCount} time
                {life.scanCount === 1 ? '' : 's'}.
              </p>
            ) : (
              <ul className="mt-2 max-h-64 space-y-2.5 overflow-y-auto">
                {life.modifications.map(m => (
                  <li key={m.at} className="border-l-2 border-slate-800 pl-3">
                    <p className="text-[11px] tabular-nums text-slate-400">{when(m.at)}</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {m.changes.map(c => (
                        <li key={c.field} className="text-[11px] text-slate-500">
                          <span className="text-slate-300">{c.field}</span>
                          {': '}
                          <span className="text-slate-500">{String(c.from ?? 'not set')}</span>
                          {' → '}
                          <span className="text-slate-200">{String(c.to ?? 'not set')}</span>
                        </li>
                      ))}
                    </ul>
                    {m.candidates.length > 0 && (
                      <p className="mt-0.5 text-[10px] text-slate-600">
                        {m.candidates.length === 1
                          ? `Activity Log: ${m.candidates[0].caller || 'unattributed'}`
                          : `${m.candidates.length} Activity Log writes fall in this window — any of them could be the cause.`}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {life.activityCoversFrom && (
              <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                The Azure Activity Log only reaches back to {when(life.activityCoversFrom)}.
                Anything before that has a change recorded but no name against it.
              </p>
            )}

            {life.notes.map(note => (
              <p key={note} className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-400/70">
                <AlertCircle size={11} className="mt-0.5 shrink-0" />
                {note}
              </p>
            ))}
          </div>
        </>
      )}

      {!loading && life && !life.known && (
        <p className="px-5 py-5 text-[11px] leading-relaxed text-slate-500">
          This resource is billed but has never appeared in a completed scan, so there is no
          history to show. It may have been deleted before the first scan ran.
        </p>
      )}

      {state.id && (
        <div className="border-t border-slate-800 px-5 py-2.5">
          <a
            href={`https://portal.azure.com/#@/resource${state.id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
          >
            Open in the Azure portal <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}
