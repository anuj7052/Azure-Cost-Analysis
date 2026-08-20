import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  GitCompareArrows, PlusCircle, MinusCircle, PencilLine, Loader2, History,
  Clock, AlertTriangle, RadioTower, HelpCircle,
} from 'lucide-react';
import { fetchChanges, fetchEntityHistory, fetchScans, runScan } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import DetailPanel, { DetailStat } from '../components/Common/DetailPanel';
import { describeFieldChange, shortType, summariseChange } from '../utils/changeSummary';

const KIND = {
  added: { icon: PlusCircle, label: 'Added', tone: 'text-emerald-300', dot: 'bg-emerald-400' },
  removed: { icon: MinusCircle, label: 'Removed', tone: 'text-red-300', dot: 'bg-red-400' },
  modified: { icon: PencilLine, label: 'Modified', tone: 'text-amber-300', dot: 'bg-amber-400' },
};

function when(timestamp) {
  if (!timestamp) return '—';
  // SQLite stores UTC without a zone marker; without the Z the browser reads it
  // as local time and every scan appears hours out.
  const date = new Date(`${timestamp.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

/** One field that moved, rendered so the change is readable at a glance. */
function FieldChange({ change }) {
  if (change.tags) {
    const { added = {}, removed = {}, changed = {} } = change.tags;
    return (
      <div className="text-[11px] space-y-1">
        <p className="text-slate-400 font-medium">{change.label}</p>
        {Object.entries(changed).map(([key, v]) => (
          <p key={key} className="text-slate-300">
            <span className="text-slate-500">{key}:</span>{' '}
            <span className="text-red-300 line-through">{v.from}</span>{' → '}
            <span className="text-emerald-300">{v.to}</span>
          </p>
        ))}
        {Object.entries(added).map(([key, v]) => (
          <p key={key} className="text-emerald-300">+ {key}: {v}</p>
        ))}
        {Object.entries(removed).map(([key, v]) => (
          <p key={key} className="text-red-300">− {key}: {v}</p>
        ))}
      </div>
    );
  }

  return (
    <p className="text-[11px] text-slate-300">
      <span className="text-slate-500">{change.label}:</span>{' '}
      <span className="text-red-300 line-through">{change.from || '(empty)'}</span>
      {' → '}
      <span className="text-emerald-300">{change.to || '(empty)'}</span>
    </p>
  );
}

function ResourceRow({ item, kind, onOpen }) {
  const meta = KIND[kind];

  return (
    <button
      onClick={() => onOpen(item)}
      className="w-full text-left border border-slate-800 bg-slate-800/30 hover:bg-slate-800/60 rounded-xl p-3 transition"
    >
      <div className="flex items-start gap-2.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${meta.dot}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-100 font-medium truncate" title={item.name}>
            {item.name}
          </p>

          {/* The sentence comes first. A raw field diff is precise and means
              nothing to most people reading it; the exact values stay below
              for whoever needs them. */}
          <p className={`text-xs mt-0.5 ${meta.tone}`}>
            {summariseChange(item, kind)}
          </p>

          <p className="text-[11px] text-slate-500 truncate mt-1">
            {shortType(item.type)}
            {item.resource_group ? ` · ${item.resource_group}` : ''}
            {item.location ? ` · ${item.location}` : ''}
          </p>

          {item.changes?.length > 1 && (
            <div className="mt-2 space-y-1 border-l-2 border-slate-700 pl-2.5">
              {item.changes.map(c => <FieldChange key={c.field} change={c} />)}
            </div>
          )}
        </div>
        <History className="w-3.5 h-3.5 text-slate-600 shrink-0 mt-1" />
      </div>
    </button>
  );
}

function Section({ kind, items, onOpen }) {
  const meta = KIND[kind];
  const Icon = meta.icon;

  if (!items.length) return null;

  return (
    <section>
      <h3 className={`text-xs font-semibold uppercase tracking-wide mb-2 flex items-center gap-2 ${meta.tone}`}>
        <Icon className="w-4 h-4" />
        {meta.label} ({items.length})
      </h3>
      <div className="space-y-2">
        {items.map(item => (
          <ResourceRow key={item.resource_id} item={item} kind={kind} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

/**
 * Everything that ever happened to one resource.
 *
 * This is the view a diff cannot give: a diff says a VM was resized, a history
 * says it has been resized four times this quarter.
 */
function EntityHistory({ tenantId, resource }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchEntityHistory(tenantId, resource.resource_id)
      .then(result => { if (!cancelled) setData(result); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId, resource.resource_id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        Reading history…
      </div>
    );
  }

  if (!data?.events?.length) {
    return <p className="text-sm text-slate-400">No history recorded for this resource.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <DetailStat label="First seen" value={when(data.first_seen)} />
        <DetailStat label="Last seen" value={when(data.last_seen)} />
        <DetailStat label="Scans present in" value={data.scan_count} />
      </div>

      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-3">
          Timeline
        </h4>

        <ol className="space-y-3">
          {data.events.map((event, index) => {
            const meta = KIND[event.kind] || {
              label: 'First seen', dot: 'bg-blue-400', tone: 'text-blue-300',
            };
            return (
              <li key={`${event.scan_id}-${index}`} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={`w-2 h-2 rounded-full mt-1.5 ${meta.dot}`} />
                  {index < data.events.length - 1 && (
                    <span className="w-px flex-1 bg-slate-800 mt-1" />
                  )}
                </div>
                <div className="pb-1 min-w-0 flex-1">
                  <p className={`text-xs font-semibold ${meta.tone}`}>
                    {event.kind === 'first_seen' ? 'First seen' : meta.label}
                  </p>
                  <p className="text-[11px] text-slate-500">{when(event.at)}</p>
                  {!!event.changes?.length && (
                    <div className="mt-1.5 space-y-1.5">
                      {event.changes.map(c => (
                        <div key={c.field}>
                          <p className="text-[11px] text-slate-300">{describeFieldChange(c)}</p>
                          <FieldChange change={c} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Only scans where something moved are listed. Showing every scan
            would bury a handful of real events under hundreds of identical
            ones, which is how a history stops being read. */}
        <p className="text-[11px] text-slate-600 mt-4 leading-relaxed">
          Scans where nothing changed are omitted. This resource appears in{' '}
          {data.scan_count} scan{data.scan_count === 1 ? '' : 's'}.
        </p>
      </section>
    </>
  );
}

export default function Changes() {
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const [data, setData] = useState(null);
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [range, setRange] = useState({ from: '', to: '' });
  const [open, setOpen] = useState(null);
  const [help, setHelp] = useState(false);

  // Azure cannot be scanned in the future, so the pickers stop at today.
  const today = new Date().toISOString().slice(0, 10);

  const load = async (params = {}) => {
    if (!selectedTenantId) return;
    setLoading(true);
    try {
      const [diff, history] = await Promise.all([
        fetchChanges(selectedTenantId, params),
        fetchScans(selectedTenantId, 30),
      ]);
      setData(diff);
      setScans(history.filter(s => s.status === 'complete'));
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Could not load changes.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [selectedTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) {
      toast.error('Select a tenant and at least one subscription first.');
      return;
    }
    setScanning(true);
    try {
      const result = await runScan({
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
      });
      if (result.status === 'failed') toast.error(result.error || 'Scan failed.');
      else toast.success(`Captured ${result.resource_count} resources`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const applyRange = () => {
    if (!range.from || !range.to) return;
    load({ from_date: range.from, to_date: range.to });
  };

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Change Tracking</h1>
          <p className="text-slate-400 text-sm mt-1">
            What changed between two captures — and the full history of any resource
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHelp(h => !h)}
            className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm font-medium text-slate-300 transition hover:text-white"
          >
            <HelpCircle className="w-4 h-4" />
            How this works
          </button>
          <button
            onClick={scan}
            disabled={scanning}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
          >
            {scanning
              ? <><Loader2 className="w-4 h-4 animate-spin" />Scanning…</>
              : <><RadioTower className="w-4 h-4" />Scan now</>}
          </button>
        </div>
      </div>

      {help && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-white mb-1.5">How change tracking works</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Each scan photographs your whole estate and stores it. Comparing two
              photographs shows what is different between them. Azure only ever reports
              what exists right now, so these stored captures are the only place a
              "what changed" answer can come from.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-xl p-3">
              <p className="text-xs font-semibold text-emerald-300 mb-1">Added</p>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Present in the later capture but not the earlier one. Someone created it,
                or it came into scope.
              </p>
            </div>
            <div className="border border-red-500/30 bg-red-500/5 rounded-xl p-3">
              <p className="text-xs font-semibold text-red-300 mb-1">Removed</p>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                In the earlier capture, gone from the later one. Deleted, moved out of
                scope, or the credential lost access to it.
              </p>
            </div>
            <div className="border border-amber-500/30 bg-amber-500/5 rounded-xl p-3">
              <p className="text-xs font-semibold text-amber-300 mb-1">Modified</p>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                In both captures, but a tracked property differs — size, region, resource
                group, name or tags.
              </p>
            </div>
          </div>

          {/* The honest limit. Anyone comparing this to Azure's own change
              tracking will expect an actor, and finding out later that it was
              never available is worse than being told now. */}
          <div className="border border-slate-700 bg-slate-950/50 rounded-xl p-3.5">
            <p className="text-xs font-semibold text-slate-200 mb-1.5">
              What this cannot tell you: who made the change
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              This compares snapshots, so it sees the <em>result</em> of a change, never
              the actor. Two scans a day apart show a VM was resized; they cannot show who
              resized it, or that it was resized twice and put back. The identity lives in
              the Azure Activity Log, which is a separate source this page does not read
              yet.
            </p>
            <p className="text-[11px] text-slate-500 leading-relaxed mt-2">
              Until then, use the timestamps here to narrow the window, then open{' '}
              <span className="text-slate-300">Azure Portal → Monitor → Activity log</span>{' '}
              and filter to that resource and period. Azure retains 90 days of activity.
            </p>
          </div>

          <div className="border border-slate-700 bg-slate-950/50 rounded-xl p-3.5">
            <p className="text-xs font-semibold text-slate-200 mb-1.5">
              Resolution is limited by how often you scan
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Anything created and deleted between two scans is never seen at all. More
              frequent scans mean finer detail; scanning once a week means a week-shaped
              blind spot.
            </p>
          </div>
        </div>
      )}

      {!selectedTenantId && (
        <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-6 text-center">
          <p className="text-blue-300 font-medium">No tenant selected</p>
          <p className="text-slate-400 text-sm mt-1">Add a tenant from Settings to get started.</p>
        </div>
      )}

      {/* Two scans are the minimum a comparison can exist between. Saying so
          beats showing "0 changes", which would imply a stable estate. */}
      {data && !data.comparable && (
        <div className="bg-amber-950/30 border border-amber-500/30 rounded-2xl p-6">
          <div className="flex items-center gap-2 text-amber-300 font-medium text-sm">
            <AlertTriangle className="w-4 h-4" />
            Not enough scans to compare
          </div>
          <p className="text-slate-400 text-sm mt-1.5 leading-relaxed">
            Change tracking works by comparing two captures, so it needs at least two
            completed scans. Run <span className="text-slate-200">Scan now</span> again
            later — or after making a change — to see the difference.
          </p>
        </div>
      )}

      {/* Dates rather than scan ids: people ask "what changed last week", not
          "what changed between scan 41 and scan 47". Each date resolves to the
          capture that best represents it, and the header below always reports
          which two were actually compared. */}
      {selectedTenantId && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">From date</span>
            <input
              type="date"
              value={range.from}
              max={range.to || today}
              onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">To date</span>
            <input
              type="date"
              value={range.to}
              min={range.from || undefined}
              max={today}
              onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
            />
          </label>
          <button
            onClick={applyRange}
            disabled={!range.from || !range.to}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-3.5 py-1.5 text-xs font-semibold text-white transition"
          >
            Track changes
          </button>
          <button
            onClick={() => { setRange({ from: '', to: '' }); load(); }}
            className="text-xs text-slate-500 hover:text-slate-300 transition"
          >
            Latest two scans
          </button>

          {scans.length > 0 && (
            <span className="text-[11px] text-slate-600 ml-auto">
              {scans.length} scan{scans.length === 1 ? '' : 's'} stored
              {scans.length > 0 && ` · oldest ${when(scans[scans.length - 1].started_at)}`}
            </span>
          )}
        </div>
      )}

      {/* A range that resolved somewhere unexpected has to say so, or the
          answer cannot be trusted. */}
      {data?.note && (
        <div className="flex items-start gap-2 bg-amber-950/30 border border-amber-500/30 rounded-2xl p-3.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-slate-400 leading-relaxed">{data.note}</p>
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          Comparing scans…
        </div>
      )}

      {data?.comparable && (
        <>
          <div className="flex items-center gap-3 flex-wrap text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {when(data.before?.started_at)} → {when(data.after?.started_at)}
            </span>
            <span className="flex items-center gap-1.5">
              <GitCompareArrows className="w-3.5 h-3.5" />
              {data.total_changes} change{data.total_changes === 1 ? '' : 's'}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {['added', 'removed', 'modified'].map(kind => {
              const meta = KIND[kind];
              const Icon = meta.icon;
              return (
                <div key={kind} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 elevated">
                  <div className={`flex items-center gap-2 text-xs font-medium ${meta.tone}`}>
                    <Icon className="w-4 h-4" />
                    {meta.label}
                  </div>
                  <p className="mt-2 text-2xl font-semibold text-slate-100 tabular-nums">
                    {data[`${kind}_count`]}
                  </p>
                </div>
              );
            })}
          </div>

          {data.total_changes === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center">
              <GitCompareArrows className="w-9 h-9 text-slate-600 mx-auto mb-3" />
              <p className="text-white font-semibold">Nothing changed between these scans</p>
              <p className="text-slate-400 text-sm mt-1">
                Every resource is identical in both captures.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              <Section kind="added" items={data.added} onOpen={setOpen} />
              <Section kind="removed" items={data.removed} onOpen={setOpen} />
              <Section kind="modified" items={data.modified} onOpen={setOpen} />
            </div>
          )}

          <p className="text-xs text-slate-600 leading-relaxed">
            Click any resource to see its full history — every change ever recorded for
            it, not just this comparison.
          </p>
        </>
      )}

      <DetailPanel
        open={!!open}
        title={open?.name || 'Resource history'}
        subtitle={open?.resource_id}
        onClose={() => setOpen(null)}
      >
        {open && <EntityHistory tenantId={selectedTenantId} resource={open} />}
      </DetailPanel>
    </div>
  );
}
