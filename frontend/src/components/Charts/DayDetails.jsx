import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Pencil, Search, StickyNote, Trash2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { createCostNote, deleteCostNote, fetchDayResources, listCostNotes, updateCostNote } from '../../api/client';
import { formatAmountFull } from '../../utils/currency';
import { friendlyError } from '../../utils/apiError';
import { NOTE_COLORS, noteColor, shiftDay, todayIso } from '../../utils/costNotes';

/**
 * One day, resource by resource, with the team's notes for that day.
 *
 * Opened from the dashboard's daily graph (?tab=day&date=YYYY-MM-DD) or
 * directly from the Cost Explorer tab. The list is what Azure billed for that
 * calendar day; notes explain why.
 */
export default function DayDetails() {
  const { selectedTenantId, selectedSubscriptionIds, subscriptions } = useAppStore();
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : shiftDay(today, -1);
  const setDate = next => setParams(previous => {
    const copy = new URLSearchParams(previous);
    copy.set('tab', 'day');
    copy.set('date', next);
    return copy;
  });
  const subsKey = selectedSubscriptionIds.join(',');

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setDate(shiftDay(date, -1))} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]" aria-label="Previous day"><ChevronLeft className="h-4 w-4" /></button>
          <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200">
            <CalendarDays className="h-4 w-4 text-[#ea580c]" aria-hidden="true" />
            <span className="sr-only">Date</span>
            <input type="date" value={date} max={today} onChange={e => e.target.value && setDate(e.target.value)} className="bg-transparent outline-none" />
          </label>
          <button type="button" onClick={() => setDate(shiftDay(date, 1))} disabled={date >= today} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]" aria-label="Next day"><ChevronRight className="h-4 w-4" /></button>
          <span className="text-sm text-slate-400">{new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </div>
        <ResourceList key={`${selectedTenantId}:${subsKey}:${date}`} date={date} tenantId={selectedTenantId} subscriptionIds={selectedSubscriptionIds} />
      </div>
      <NotesPanel key={`${selectedTenantId}:${subsKey}:${date}`} date={date} tenantId={selectedTenantId} subscriptionIds={selectedSubscriptionIds} subscriptions={subscriptions || []} />
    </div>
  );
}

function ResourceList({ date, tenantId, subscriptionIds }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const subsKey = subscriptionIds.join(',');

  useEffect(() => {
    let live = true;
    fetchDayResources({ tenant_id: tenantId, subscription_ids: subscriptionIds, date })
      .then(data => { if (live) setState({ loading: false, data, error: '' }); })
      .catch(err => { if (live) setState({ loading: false, data: null, error: friendlyError(err) }); });
    return () => { live = false; };
  }, [tenantId, subsKey, date, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, loading, error } = state;
  const currency = data?.currency || 'INR';
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = data?.resources || [];
    return needle
      ? all.filter(r => [r.resource_name, r.resource_group, r.subscription_name, ...r.services].join(' ').toLowerCase().includes(needle))
      : all;
  }, [data, query]);
  const total = Number(data?.total) || 0;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="day-resources-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="day-resources-title" className="text-base font-semibold text-slate-100">Where the money went</h2>
          <p className="mt-1 text-sm text-slate-400">Every resource Azure billed on this day, highest first.</p>
        </div>
        {data && <div className="text-right"><p className="text-xs text-slate-500">Day total</p><p className="text-xl font-bold tabular-nums text-slate-100">{formatAmountFull(total, currency)}</p></div>}
      </div>

      {data?.errors?.length > 0 && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/30 p-2.5 text-xs text-amber-300">Some subscriptions could not be read, so this list is partial.</p>}

      <label className="mt-4 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3">
        <Search className="h-4 w-4 text-slate-500" aria-hidden="true" />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a resource, group or service…" aria-label="Find a resource" className="h-10 w-full bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="text-slate-500 hover:text-slate-200"><X className="h-4 w-4" /></button>}
      </label>

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Reading this day from Azure…</div>
        ) : error ? (
          <div className="py-12 text-center"><p className="text-sm text-red-400">{error}</p><button type="button" onClick={() => { setState({ loading: true, data: null, error: '' }); setAttempt(n => n + 1); }} className="mt-3 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Try again</button></div>
        ) : !rows.length ? (
          <p className="py-12 text-center text-sm text-slate-400">{query ? 'No resources match this search.' : 'Azure reported no charges for this day yet. Costs can take up to 24–48 hours to appear.'}</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {rows.map(r => {
              const pct = total > 0 ? (r.cost / total) * 100 : 0;
              return (
                <li key={`${r.subscription_id}:${r.resource_id || r.services.join()}`} className="py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-100" title={r.resource_id || r.resource_name}>{r.resource_name}</p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {r.services.join(', ')}
                        {r.resource_group && ` · ${r.resource_group}`}
                        {r.subscription_name && ` · ${r.subscription_name}`}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums text-slate-100">{formatAmountFull(r.cost, currency)}</p>
                      <p className="text-[11px] text-slate-500">{pct.toFixed(1)}%</p>
                    </div>
                  </div>
                  <div className="mt-2 h-1 rounded-full bg-slate-800"><div className="h-1 rounded-full bg-[#EA580C]" style={{ width: `${Math.max(pct, 0.5)}%` }} /></div>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && !error && rows.length > 0 && <p className="mt-3 text-xs text-slate-500">{rows.length} of {data.resources.length} resources</p>}
      </div>
    </section>
  );
}

function NotesPanel({ date, tenantId, subscriptionIds, subscriptions }) {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [color, setColor] = useState('yellow');
  const [scope, setScope] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const subsKey = subscriptionIds.join(',');
  const names = Object.fromEntries(subscriptions.map(s => [s.subscription_id, s.display_name]));

  useEffect(() => {
    let live = true;
    listCostNotes({ tenant_id: tenantId, from_date: date, to_date: date, subscription_ids: subscriptionIds })
      .then(list => { if (live) setNotes(list); })
      .catch(err => { if (live) { setNotes([]); setError(friendlyError(err)); } });
    return () => { live = false; };
  }, [tenantId, subsKey, date]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async event => {
    event.preventDefault();
    if (!draft.trim()) return;
    setSaving(true);
    setError('');
    try {
      const note = await createCostNote({ tenant_id: tenantId, subscription_id: scope, note_date: date, body: draft.trim(), color });
      setNotes(list => [...(list || []), note]);
      setDraft('');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async (note, body) => {
    try {
      const updated = await updateCostNote(note.id, { body });
      setNotes(list => list.map(n => (n.id === note.id ? updated : n)));
      setEditing(null);
    } catch (err) { setError(friendlyError(err)); }
  };

  const remove = async note => {
    if (!window.confirm('Delete this note?')) return;
    try {
      await deleteCostNote(note.id);
      setNotes(list => list.filter(n => n.id !== note.id));
    } catch (err) { setError(friendlyError(err)); }
  };

  return (
    <aside className="h-fit rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="day-notes-title">
      <h2 id="day-notes-title" className="flex items-center gap-2 text-base font-semibold text-slate-100"><StickyNote className="h-4 w-4 text-[#ea580c]" aria-hidden="true" />Notes for this day</h2>
      <p className="mt-1 text-sm text-slate-400">Record what changed so anyone reviewing this day knows why.</p>

      <form onSubmit={add} className="mt-4 space-y-2">
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={2000} placeholder="e.g. Scaled the AKS pool to 6 nodes for a load test" aria-label="New note" className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus-visible:ring-2 focus-visible:ring-[#ea580c]" />
        <div className="flex flex-wrap items-center gap-2">
          <select value={scope} onChange={e => setScope(e.target.value)} aria-label="Note applies to" className="h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200">
            <option value="">Whole tenant</option>
            {subscriptionIds.map(id => <option key={id} value={id}>{names[id] || 'Unnamed subscription'}</option>)}
          </select>
          <div className="flex gap-1" role="radiogroup" aria-label="Note colour">
            {NOTE_COLORS.map(c => (
              <button key={c.key} type="button" role="radio" aria-checked={color === c.key} aria-label={c.label} onClick={() => setColor(c.key)} className={`h-6 w-6 rounded-full border-2 ${color === c.key ? 'border-slate-200' : 'border-transparent'}`} style={{ background: c.dot }} />
            ))}
          </div>
        </div>
        <button type="submit" disabled={saving || !draft.trim()} className="w-full rounded-lg bg-[#EA580C] px-4 py-2 text-sm font-semibold text-white hover:bg-[#c2410c] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] focus-visible:ring-offset-2">{saving ? 'Saving…' : 'Add note'}</button>
      </form>

      {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}

      <div className="mt-5 space-y-3">
        {notes === null ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading notes…</div>
        ) : !notes.length ? (
          <p className="text-sm text-slate-500">No notes for this day yet.</p>
        ) : notes.map(note => {
          const tone = noteColor(note.color);
          return (
            <article key={note.id} className="rounded-xl p-3.5 shadow-sm" style={{ background: tone.bg, color: tone.text, borderLeft: `4px solid ${tone.dot}` }}>
              {editing === note.id ? (
                <EditNote note={note} onCancel={() => setEditing(null)} onSave={save} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{note.body}</p>
              )}
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] opacity-80">
                <span className="truncate">{note.author_name}{note.subscription_id ? ` · ${names[note.subscription_id] || 'Unnamed subscription'}` : ' · whole tenant'}</span>
                {note.can_edit && editing !== note.id && (
                  <span className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => setEditing(note.id)} aria-label="Edit note" className="rounded p-1 hover:bg-black/10"><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => remove(note)} aria-label="Delete note" className="rounded p-1 hover:bg-black/10"><Trash2 className="h-3.5 w-3.5" /></button>
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}

function EditNote({ note, onCancel, onSave }) {
  const [value, setValue] = useState(note.body);
  return (
    <div className="space-y-2">
      <textarea value={value} onChange={e => setValue(e.target.value)} rows={3} maxLength={2000} aria-label="Edit note" className="w-full rounded-lg border border-black/10 bg-white/70 p-2 text-sm text-[#1f2937] outline-none" />
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 hover:bg-black/10">Cancel</button>
        <button type="button" disabled={!value.trim()} onClick={() => onSave(note, value.trim())} className="rounded bg-black/80 px-2 py-1 font-semibold text-white disabled:opacity-50">Save</button>
      </div>
    </div>
  );
}
