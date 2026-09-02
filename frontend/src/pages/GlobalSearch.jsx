import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Search, Loader2, RadioTower, History, Boxes, AlertTriangle, Clock,
} from 'lucide-react';
import { runScan, fetchScans, searchResources } from '../api/client';
import { useAppStore } from '../store/useAppStore';

/** Azure type ids are verbose; the last segment is the part people recognise. */
function shortType(type) {
  if (!type) return '—';
  const parts = type.split('/');
  return parts[parts.length - 1];
}

function when(timestamp) {
  if (!timestamp) return '—';
  // SQLite stores UTC without a zone marker; without the Z the browser reads it
  // as local time and every scan appears hours out.
  const date = new Date(`${timestamp.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function ResultRow({ item }) {
  return (
    <tr className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
      <td className="px-5 py-3">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.live ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-slate-100 font-medium truncate max-w-[240px]" title={item.name}>
            {item.name}
          </span>
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5 truncate max-w-[320px]" title={item.resource_id}>
          {item.resource_id}
        </p>
      </td>
      <td className="px-3 py-3 text-slate-400" title={item.type}>{shortType(item.type)}</td>
      <td className="px-3 py-3 text-slate-400 truncate max-w-[150px]">{item.resource_group || '—'}</td>
      <td className="px-3 py-3 text-slate-400">{item.location || '—'}</td>
      <td className="px-3 py-3">
        {item.live
          ? <span className="text-[11px] px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">Current</span>
          : (
            <span
              className="text-[11px] px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-300"
              title={`Last seen in the scan of ${when(item.last_seen)}`}
            >
              Deleted
            </span>
          )}
      </td>
      <td className="px-5 py-3 text-right text-slate-500 text-xs whitespace-nowrap">
        {when(item.last_seen)}
      </td>
    </tr>
  );
}

export default function GlobalSearch() {
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const [searchParams] = useSearchParams();
  // The top bar navigates here with the term in the URL, which also makes a
  // search a shareable link rather than something that only exists in one
  // person's browser.
  const [query, setQuery] = useState(() => searchParams.get('q') || '');
  const [includeDeleted, setIncludeDeleted] = useState(true);
  const [data, setData] = useState(null);
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scans, setScans] = useState([]);

  const loadScans = async () => {
    if (!selectedTenantId) return;
    try {
      setScans(await fetchScans(selectedTenantId));
    } catch {
      // Scan history is context, not the point of the page. Failing to load it
      // must not block searching.
    }
  };

  useEffect(() => { loadScans(); }, [selectedTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Searching again from the top bar while already on this page changes only
  // the URL, so without this the box would keep the first term and the second
  // search would appear to do nothing.
  const fromUrl = searchParams.get('q') || '';
  useEffect(() => {
    if (fromUrl) setQuery(fromUrl);
  }, [fromUrl]);

  // Debounced so typing a resource name does not fire a request per keystroke.
  const timer = useRef();
  useEffect(() => {
    clearTimeout(timer.current);
    const term = query.trim();

    if (term.length < 2) {
      setData(null);
      return;
    }

    timer.current = setTimeout(async () => {
      if (!selectedTenantId) return;
      setSearching(true);
      try {
        setData(await searchResources(selectedTenantId, term, includeDeleted));
      } catch (err) {
        toast.error(err.response?.data?.detail || err.message || 'Search failed.');
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer.current);
  }, [query, includeDeleted, selectedTenantId]);

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
      if (result.status === 'failed') {
        toast.error(result.error || 'The scan could not complete.');
      } else {
        toast.success(`Captured ${result.resource_count} resources`);
      }
      await loadScans();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const lastScan = scans.find(s => s.status === 'complete');
  const neverScanned = data && data.latest_scan_id == null;
  const deletedCount = (data?.results || []).filter(r => !r.live).length;

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Global Search</h1>
          <p className="text-slate-400 text-sm mt-1">
            Find any resource by name across every subscription — including ones already deleted
          </p>
        </div>

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

      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          {lastScan
            ? `Last scan ${when(lastScan.started_at)} · ${lastScan.resource_count} resources`
            : 'No completed scan yet'}
        </span>
        {scans.length > 1 && (
          <span className="flex items-center gap-1.5">
            <History className="w-3.5 h-3.5" />
            {scans.length} scans stored
          </span>
        )}
      </div>

      {/* Search box */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by resource name…"
            spellCheck={false}
            autoFocus
            className="h-12 w-full rounded-xl border border-slate-700 bg-slate-950/60 pl-11 pr-4 text-sm text-white placeholder-slate-600 outline-none transition focus:border-blue-500"
          />
          {searching && (
            <Loader2 className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-500" />
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-400 w-fit cursor-pointer">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={e => setIncludeDeleted(e.target.checked)}
            className="accent-blue-500"
          />
          Include deleted resources
        </label>
      </div>

      {!selectedTenantId && (
        <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-6 text-center">
          <p className="text-blue-300 font-medium">No tenant selected</p>
          <p className="text-slate-400 text-sm mt-1">Add a tenant from Settings to get started.</p>
        </div>
      )}

      {/* "Never scanned" and "no match" are different problems and need
          different prompts — otherwise a new user reads "no results" and
          concludes the tool is broken. */}
      {neverScanned && (
        <div className="bg-amber-950/30 border border-amber-500/30 rounded-2xl p-6">
          <div className="flex items-center gap-2 text-amber-300 font-medium text-sm">
            <AlertTriangle className="w-4 h-4" />
            Nothing has been captured yet
          </div>
          <p className="text-slate-400 text-sm mt-1.5 leading-relaxed">
            Search reads from stored snapshots, not live Azure, which is how it can find
            deleted resources. Run your first scan to build the index.
          </p>
        </div>
      )}

      {data && !neverScanned && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-800 flex-wrap">
            <p className="text-sm text-slate-300">
              <span className="font-semibold text-white">{data.total}</span> result{data.total === 1 ? '' : 's'}
              {deletedCount > 0 && (
                <span className="text-slate-500"> · {deletedCount} deleted</span>
              )}
            </p>
            {data.truncated && (
              <p className="text-xs text-amber-400">
                Showing the first 200 — narrow your search to see the rest
              </p>
            )}
          </div>

          {data.results.length === 0 ? (
            <div className="p-10 text-center">
              <Boxes className="w-9 h-9 text-slate-600 mx-auto mb-3" />
              <p className="text-slate-300 font-medium">No resource matches “{query.trim()}”</p>
              <p className="text-slate-500 text-sm mt-1">
                It may never have existed, or it was deleted before your first scan.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/40 text-xs text-slate-500">
                    <th className="text-left font-medium px-5 py-2.5">Resource</th>
                    <th className="text-left font-medium px-3 py-2.5">Type</th>
                    <th className="text-left font-medium px-3 py-2.5">Resource group</th>
                    <th className="text-left font-medium px-3 py-2.5">Location</th>
                    <th className="text-left font-medium px-3 py-2.5">State</th>
                    <th className="text-right font-medium px-5 py-2.5">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map(item => (
                    <ResultRow key={item.resource_id} item={item} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {query.trim().length === 1 && (
        <p className="text-xs text-slate-500">Enter at least two characters.</p>
      )}
    </div>
  );
}
