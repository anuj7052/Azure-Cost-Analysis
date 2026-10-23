import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { CalendarCheck, Download, FileText, Loader2, MessageSquare, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react';
import * as api from '../../api/client';
import { errorMessage } from '../../utils/apiError';

/*
 * Subscription → services trail. Each service records the PO and BOQ it was
 * activated under, when, its expected monthly cost, the proof documents and a
 * running notes log — so every cost can be traced back to its approval.
 */

const KINDS = { po: 'PO', boq: 'BOQ', approval: 'Approval / email', proof: 'Proof', other: 'Other' };
const STATUS = { planned: ['Planned', 'bg-slate-700/40 text-slate-300'], active: ['Active', 'bg-emerald-500/10 text-emerald-500'], stopped: ['Stopped', 'bg-rose-500/10 text-rose-400'] };
const EMPTY = { name: '', po_number: '', po_date: '', boq_ref: '', activated_on: '', stopped_on: '', monthly_cost: '', currency: 'INR', status: 'active', description: '' };
const field = 'mt-1.5 h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]';
const btn = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50';
const primary = `${btn} bg-[#ea580c] text-[#ffffff] hover:bg-[#c2410c]`;
const ghost = `${btn} border border-slate-700 text-slate-300 hover:border-[#ea580c] hover:text-[#c2410c]`;
const money = (v, c = 'INR') => (v == null || v === '' ? '—' : `${c} ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = d => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const when = d => (d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const size = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function ServiceForm({ initial, subscriptions, onSave, onCancel, busy }) {
  const [form, setForm] = useState(initial);
  const set = patch => setForm(f => ({ ...f, ...patch }));
  const input = (key, label, props = {}) => <label className="block text-xs text-slate-400">{label}<input className={field} value={form[key] ?? ''} onChange={e => set({ [key]: e.target.value })} {...props} /></label>;
  return (
    <form className="space-y-4 rounded-xl border border-[#fdba74] bg-slate-900 p-5" onSubmit={e => { e.preventDefault(); onSave({ ...form, monthly_cost: form.monthly_cost === '' ? null : form.monthly_cost }); }}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-xs text-slate-400">Subscription<select required className={field} value={form.workload_id} onChange={e => set({ workload_id: e.target.value })}><option value="">Choose…</option>{subscriptions.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        {input('name', 'Service name', { required: true, placeholder: 'e.g. Azure SQL Database, VM D4s v5' })}
        <label className="block text-xs text-slate-400">Status<select className={field} value={form.status} onChange={e => set({ status: e.target.value })}>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {input('po_number', 'PO number', { placeholder: 'e.g. PO-2026-0142' })}
        {input('po_date', 'PO date', { type: 'date' })}
        {input('boq_ref', 'BOQ reference', { placeholder: 'e.g. BOQ v3 · line 12' })}
        {input('activated_on', 'Activated on', { type: 'date' })}
        {form.status === 'stopped' && input('stopped_on', 'Stopped on', { type: 'date' })}
        {input('monthly_cost', 'Expected monthly cost (INR)', { type: 'number', min: 0, step: '0.01', placeholder: '0.00' })}
      </div>
      <label className="block text-xs text-slate-400">Description<textarea rows={2} className={`${field} h-auto py-2`} value={form.description} onChange={e => set({ description: e.target.value })} placeholder="What was activated and why" /></label>
      <div className="flex justify-end gap-2"><button type="button" className={ghost} onClick={onCancel}>Cancel</button><button className={primary} disabled={busy || !form.name.trim() || !form.workload_id}>{busy && <Loader2 size={15} className="animate-spin" />}Save service</button></div>
    </form>
  );
}

function ServiceCard({ service, subName, canEdit, onChanged, onEdit, onDeleted }) {
  const [kind, setKind] = useState('po');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const [status, statusClass] = STATUS[service.status] || STATUS.active;
  const act = async (fn, ok) => { setBusy(true); try { await fn(); if (ok) toast.success(ok); await onChanged(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); } };
  const upload = files => act(async () => { for (const f of files) await api.uploadBillingServiceFile(service.id, kind, f); if (fileRef.current) fileRef.current.value = ''; }, files.length > 1 ? `${files.length} documents uploaded` : 'Document uploaded');
  const download = async f => { try { const blob = await api.downloadBillingServiceFile(f.id); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = f.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e) { toast.error(errorMessage(e)); } };
  const missing = [!service.po_number && 'PO', !service.files.some(f => f.kind === 'po') && 'PO document'].filter(Boolean);
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold text-slate-100">{service.name}</h3><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}>{status}</span>{missing.length > 0 && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">Missing: {missing.join(', ')}</span>}</div>
          <p className="mt-1 text-xs text-slate-500">Subscription: {subName}</p>
        </div>
        {canEdit && <div className="flex gap-1"><button type="button" className="rounded p-1.5 text-slate-500 hover:text-[#c2410c]" aria-label="Edit service" onClick={onEdit}><Pencil size={15} /></button><button type="button" className="rounded p-1.5 text-slate-500 hover:text-red-400" aria-label="Delete service" onClick={() => window.confirm(`Delete "${service.name}" with its ${service.files.length} document(s) and ${service.notes.length} note(s)? This cannot be undone.`) && act(async () => { await api.deleteBillingService(service.id); onDeleted(); }, 'Service deleted')}><Trash2 size={15} /></button></div>}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {[['PO number', service.po_number || '—'], ['PO date', day(service.po_date)], ['BOQ', service.boq_ref || '—'], ['Activated', day(service.activated_on)], [service.status === 'stopped' ? 'Stopped' : 'Monthly cost', service.status === 'stopped' ? day(service.stopped_on) : money(service.monthly_cost, service.currency)], ['Documents', service.files.length]].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5 break-words font-medium text-slate-200">{v}</dd></div>)}
      </dl>
      {service.description && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-400">{service.description}</p>}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Paperclip size={13} />Documents & proof</h4>
          {canEdit && <div className="mt-2 flex flex-wrap items-center gap-2"><select aria-label="Document type" value={kind} onChange={e => setKind(e.target.value)} className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-200">{Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><input ref={fileRef} type="file" multiple className="hidden" onChange={e => e.target.files?.length && upload([...e.target.files])} /><button type="button" className={ghost} disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}Upload</button></div>}
          {!service.files.length ? <p className="mt-2 text-xs text-slate-500">No documents yet. Upload the PO, BOQ or approval email as proof.</p> : <ul className="mt-2 divide-y divide-slate-800 rounded-lg border border-slate-800">{service.files.map(f => <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm"><FileText size={15} className="shrink-0 text-[#ea580c]" /><span className="rounded bg-[#ffedd5] px-1.5 text-[11px] font-medium text-[#9a3412]">{KINDS[f.kind] || f.kind}</span><span className="min-w-0 flex-1 truncate text-slate-200" title={f.filename}>{f.filename}</span><span className="hidden text-xs text-slate-500 sm:inline">{size(f.size)} · {when(f.created_at)}</span><button type="button" aria-label={`Download ${f.filename}`} onClick={() => download(f)} className="rounded p-1 text-slate-500 hover:text-[#c2410c]"><Download size={14} /></button>{canEdit && <button type="button" aria-label={`Delete ${f.filename}`} onClick={() => window.confirm(`Delete ${f.filename}?`) && act(() => api.deleteBillingServiceFile(f.id), 'Document deleted')} className="rounded p-1 text-slate-500 hover:text-red-400"><X size={14} /></button>}</li>)}</ul>}
        </section>
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><MessageSquare size={13} />Notes</h4>
          {canEdit && <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); if (note.trim()) act(async () => { await api.addBillingServiceNote(service.id, note.trim()); setNote(''); }, 'Note added'); }}><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Approved by Ravi on call, PO to follow" className="h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]" /><button className={ghost} disabled={busy || !note.trim()}>Add</button></form>}
          {!service.notes.length ? <p className="mt-2 text-xs text-slate-500">No notes yet.</p> : <ol className="mt-2 space-y-2">{service.notes.map(n => <li key={n.id} className="rounded-lg border-l-2 border-[#ea580c] bg-slate-800/40 px-3 py-2"><p className="whitespace-pre-wrap text-sm text-slate-200">{n.body}</p><p className="mt-1 flex items-center justify-between text-[11px] text-slate-500"><span>{n.author} · {when(n.created_at)}</span>{canEdit && <button type="button" aria-label="Delete note" onClick={() => window.confirm('Delete this note?') && act(() => api.deleteBillingServiceNote(n.id))} className="hover:text-red-400"><Trash2 size={12} /></button>}</p></li>)}</ol>}
        </section>
      </div>
    </article>
  );
}

export default function BillingServices({ customerId, canEdit }) {
  const [ledger, setLedger] = useState(null);
  const [items, setItems] = useState(null);
  const [sub, setSub] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const load = async () => { const d = await api.listBillingServices(customerId); setItems(d.items || []); };
  useEffect(() => {
    let live = true;
    Promise.all([api.getBillingLedger(customerId), api.listBillingServices(customerId)])
      .then(([l, s]) => { if (live) { setLedger(l); setItems(s.items || []); } })
      .catch(e => { if (live) { toast.error(errorMessage(e)); setItems([]); setLedger({ workloads: [] }); } });
    return () => { live = false; };
  }, [customerId]);
  const subscriptions = useMemo(() => (ledger?.workloads || []).filter(w => !w.archived), [ledger]);
  const subName = id => subscriptions.find(w => w.id === id)?.name || 'Unknown subscription';
  const q = query.trim().toLowerCase();
  const shown = (items || []).filter(s => (!sub || s.workload_id === sub) && (!q || [s.name, s.po_number, s.boq_ref, s.description, ...s.notes.map(n => n.body), ...s.files.map(f => f.filename)].some(v => (v || '').toLowerCase().includes(q))));
  const activeCost = shown.filter(s => s.status === 'active').reduce((t, s) => t + (Number(s.monthly_cost) || 0), 0);
  const save = async body => {
    setBusy(true);
    try {
      if (editing === 'new') await api.createBillingService(customerId, body); else await api.updateBillingService(editing.id, body);
      toast.success(editing === 'new' ? 'Service added' : 'Service updated');
      setEditing(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  if (!items || !ledger) return <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" />Loading services…</p>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[['Services', shown.length], ['Active', shown.filter(s => s.status === 'active').length], ['Active monthly cost', money(activeCost)]].map(([k, v]) => <div key={k} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">{k}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-100">{v}</p></div>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setSub('')} className={!sub ? primary : ghost}>All subscriptions</button>
        {subscriptions.map(w => <button key={w.id} type="button" onClick={() => setSub(w.id)} className={sub === w.id ? primary : ghost}>{w.name} <span className="text-xs opacity-70">({items.filter(s => s.workload_id === w.id).length})</span></button>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search service, PO, BOQ, note or file…" className="h-10 w-full max-w-sm rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]" />
        {canEdit && editing == null && <button type="button" className={primary} disabled={!subscriptions.length} title={subscriptions.length ? '' : 'Add a subscription first'} onClick={() => setEditing('new')}><Plus size={15} />Add service</button>}
      </div>
      {editing && <ServiceForm key={editing === 'new' ? 'new' : editing.id} busy={busy} subscriptions={subscriptions} initial={editing === 'new' ? { ...EMPTY, workload_id: sub || subscriptions[0]?.id || '' } : { ...EMPTY, ...Object.fromEntries(Object.entries(editing).map(([k, v]) => [k, v ?? ''])) }} onSave={save} onCancel={() => setEditing(null)} />}
      {!subscriptions.length && <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">This customer has no subscription yet. Add one on the Add entry page, then track its services here.</p>}
      {subscriptions.length > 0 && !shown.length && <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400"><CalendarCheck className="mx-auto mb-2 text-[#ea580c]" size={22} />{q ? 'No service matches your search.' : 'No services tracked yet. Add the first service with its PO and BOQ.'}</p>}
      {shown.map(s => <ServiceCard key={s.id} service={s} subName={subName(s.workload_id)} canEdit={canEdit} onChanged={load} onEdit={() => { setEditing(s); window.scrollTo({ top: 0, behavior: 'smooth' }); }} onDeleted={() => setItems(list => list.filter(x => x.id !== s.id))} />)}
    </div>
  );
}
