import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Check, Download, FileUp, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  bulkImportBillingCustomers, createBillingCustomer, deleteBillingItem, exportBillingCustomersCsv, getBillingLedger, listBillingCustomers, listBillingDistributors,
  saveBillingEntry, saveBillingWorkload, updateBillingCustomer, listBillingExtraCharges, createBillingExtraCharge, deleteBillingExtraCharge,
} from '../api/client';
import { errorMessage } from '../utils/apiError';
import { useCanAdminister } from '../hooks/useCanAdminister';
import { BillingPage } from '../components/billing-ui/workspace';
import { Card, CardContent } from '../components/billing-ui/card';
import { Button, Input, Label, NativeSelect } from '../components/shadcn';

/*
 * One simple form for the monthly billing record:
 *   customer → subscription → month → invoice number → our billing amount
 *   → distributor → distributor amount.
 * New customers, subscriptions and distributor names are added inline. If the
 * subscription already has that month, the form edits it instead of failing.
 */

const thisMonth = () => new Date().toISOString().slice(0, 7);
const money = (value, currency) => (value == null || value === '' ? '—'
  : `${currency} ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const monthName = key => {
  const [y, m] = String(key).split('-').map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleString('en', { month: 'short', year: 'numeric' }) : key;
};

function AddInline({ placeholder, onAdd, busy, onCancel, initial = '', label = 'Add' }) {
  const [value, setValue] = useState(initial);
  const submit = () => { if (value.trim()) onAdd(value.trim()); };
  // A div, not a form: it sits inside the entry form, and nested forms are invalid.
  return (
    <div className="mt-2 flex gap-2">
      <Input autoFocus value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') onCancel(); }} placeholder={placeholder} aria-label={placeholder} />
      <Button type="button" size="sm" className="h-9" onClick={submit} disabled={busy || !value.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Check />}{label}</Button>
      <Button type="button" size="sm" variant="ghost" className="h-9" onClick={onCancel} aria-label="Cancel"><X /></Button>
    </div>
  );
}

const EXTRA_TYPES = ['Implementation', 'Migration', 'Consulting', 'Support', 'Licence', 'Training', 'Other'];
const EXTRA_EMPTY = { charge_type: 'Implementation', description: '', period: new Date().toISOString().slice(0, 7), invoice_number: '', amount: '', amount_basis: 'gross' };

function ExtraCharges({ customerId, customerName, canEdit }) {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState(EXTRA_EMPTY);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    listBillingExtraCharges(customerId).then(d => { if (live) setItems(d.items || []); }).catch(e => { if (live) { setItems([]); toast.error(errorMessage(e)); } });
    return () => { live = false; };
  }, [customerId]);
  const set = patch => setForm(f => ({ ...f, ...patch }));
  const add = async () => {
    if (!(Number(form.amount) > 0)) { toast.error('Enter an amount above zero'); return; }
    setBusy(true);
    try {
      const saved = await createBillingExtraCharge(customerId, { ...form, currency: 'INR', description: form.description.trim(), invoice_number: form.invoice_number.trim() });
      setItems(list => [saved, ...(list || [])].sort((a, b) => b.period.localeCompare(a.period)));
      setForm(f => ({ ...EXTRA_EMPTY, period: f.period, charge_type: f.charge_type, amount_basis: f.amount_basis }));
      toast.success('Extra charge added');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async item => {
    if (!window.confirm(`Delete the ${item.charge_type} charge for ${monthName(item.period)}? This cannot be undone.`)) return;
    try { await deleteBillingExtraCharge(item.id); setItems(list => list.filter(i => i.id !== item.id)); toast.success('Extra charge deleted'); } catch (e) { toast.error(errorMessage(e)); }
  };
  const total = (items || []).reduce((sum, i) => sum + Number(i.amount || 0), 0);
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Extra charges{customerName ? ` · ${customerName}` : ''}</h2>
          <p className="mt-1 text-sm text-slate-400">One-off charges such as implementation, migration or consulting. They count in this customer's billing, with no distributor cost.</p>
        </div>
        {items?.length > 0 && <div className="text-right text-xs"><p className="text-slate-500">Total extra</p><p className="font-semibold tabular-nums text-slate-100">{money(total, 'INR')}</p></div>}
      </div>
      {canEdit && <div className="grid gap-3 border-b border-slate-800 p-5 sm:grid-cols-2 lg:grid-cols-[10rem_minmax(0,1fr)_9rem_9rem_10rem_auto] lg:items-end">
        <div><Label htmlFor="ex-type">Type</Label><NativeSelect id="ex-type" className="mt-1.5" value={form.charge_type} onChange={e => set({ charge_type: e.target.value })}>{EXTRA_TYPES.map(t => <option key={t}>{t}</option>)}</NativeSelect></div>
        <div><Label htmlFor="ex-desc">Description</Label><Input id="ex-desc" className="mt-1.5" value={form.description} onChange={e => set({ description: e.target.value })} placeholder="e.g. SAP migration setup" /></div>
        <div><Label htmlFor="ex-month">Month</Label><Input id="ex-month" className="mt-1.5" type="month" value={form.period} onChange={e => set({ period: e.target.value })} /></div>
        <div><Label htmlFor="ex-invoice">Invoice number</Label><Input id="ex-invoice" className="mt-1.5" value={form.invoice_number} onChange={e => set({ invoice_number: e.target.value })} placeholder="INV-1042" /></div>
        <div><Label htmlFor="ex-amount">Amount (INR)</Label><Input id="ex-amount" className="mt-1.5" type="number" min="0" step="0.01" inputMode="decimal" value={form.amount} onChange={e => set({ amount: e.target.value })} placeholder="0.00" />
          <select aria-label="Tax" value={form.amount_basis} onChange={e => set({ amount_basis: e.target.value })} className="mt-1 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200"><option value="gross">Tax included</option><option value="net">Before tax</option></select></div>
        <Button type="button" className="h-10" disabled={busy || !form.amount || !form.period} onClick={add}>{busy ? <Loader2 className="animate-spin" /> : <Plus />}Add charge</Button>
      </div>}
      {items == null ? <p className="flex items-center gap-2 p-6 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p> : !items.length ? <p className="p-6 text-center text-sm text-slate-400">No extra charges yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead><tr className="border-b border-slate-800 text-left text-xs text-slate-500">{['Month', 'Type', 'Description', 'Invoice', 'Amount', ''].map(h => <th key={h} className={`px-4 py-2.5 font-medium ${h === 'Amount' ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
            <tbody>{items.map(i => (
              <tr key={i.id} className="border-b border-slate-800/60 last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 text-slate-200">{monthName(i.period)}</td>
                <td className="px-4 py-2.5"><span className="rounded-full bg-[#ffedd5] px-2 py-0.5 text-xs font-medium text-[#9a3412]">{i.charge_type}</span></td>
                <td className="max-w-[16rem] truncate px-4 py-2.5 text-slate-300" title={i.description}>{i.description || '—'}</td>
                <td className="px-4 py-2.5 text-slate-400">{i.invoice_number || '—'}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-100">{money(i.amount, i.currency)}<span className="ml-1 text-[10px] text-slate-500">{i.amount_basis === 'net' ? 'before tax' : 'incl. tax'}</span></td>
                <td className="px-4 py-2.5 text-right">{canEdit && <button type="button" aria-label="Delete extra charge" onClick={() => remove(i)} className="rounded p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const EMPTY = { period: thisMonth(), invoice_number: '', customer_amount: '', distributor: '', distributor_amount: '', currency: 'INR', amount_basis: 'net' };

export default function BillingEntries() {
  const canEdit = useCanAdminister();
  const [params, setParams] = useSearchParams();
  const [customers, setCustomers] = useState(null);
  const [customerId, setCustomerId] = useState(params.get('customer') || '');
  const [ledger, setLedger] = useState(null);
  const [workloadId, setWorkloadId] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [distributors, setDistributors] = useState(['Savex', 'Redington', 'Tata', 'Ingram', 'Tech Data']);
  const [adding, setAdding] = useState(params.get('new') === 'customer' ? 'customer' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportCsv = async () => {
    try { download(await exportBillingCustomersCsv(), 'customers.csv'); } catch (e) { toast.error(errorMessage(e)); }
  };
  const template = () => download(new Blob(['Customer,Subscription,Owner\nAcme Ltd,Acme Production,Ravi Kumar\nAcme Ltd,Acme Dev,Ravi Kumar\nBeta Corp,Beta Main,Meera Shah\n'], { type: 'text/csv' }), 'customers-template.csv');
  const importCsv = async file => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await bulkImportBillingCustomers(file);
      toast.success(`${r.rows} rows · ${r.customers_created} new customers · ${r.subscriptions_created} new subscriptions · ${r.owners_updated} owners updated`);
      const d = await listBillingCustomers();
      setCustomers((d.items || []).filter(c => !c.archived));
      if (customerId) setLedger(await getBillingLedger(customerId));
    } catch (e) { toast.error(errorMessage(e)); } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  useEffect(() => {
    listBillingCustomers().then(d => setCustomers((d.items || []).filter(c => !c.archived))).catch(e => setError(errorMessage(e)));
    listBillingDistributors().then(d => setDistributors(d.distributors)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!customerId) return undefined;
    let live = true;
    getBillingLedger(customerId).then(d => {
      if (!live) return;
      setLedger(d);
      const subs = (d.workloads || []).filter(w => !w.archived);
      setWorkloadId(current => (subs.some(w => w.id === current) ? current : subs[0]?.id || ''));
    }).catch(e => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [customerId]);

  const subscriptions = useMemo(() => (ledger?.workloads || []).filter(w => !w.archived), [ledger]);
  const entries = useMemo(() => (ledger?.entries || []).filter(e => !e.archived).sort((a, b) => b.period.localeCompare(a.period)), [ledger]);
  const existing = entries.find(e => e.workload_id === workloadId && e.period === form.period);
  const profit = form.customer_amount !== '' && form.distributor_amount !== '' ? Number(form.customer_amount) - Number(form.distributor_amount) : null;
  const set = patch => setForm(prev => ({ ...prev, ...patch }));

  const chooseCustomer = id => {
    setCustomerId(id);
    setLedger(null);
    setParams(prev => { const next = new URLSearchParams(prev); if (id) next.set('customer', id); else next.delete('customer'); return next; }, { replace: true });
  };

  const addCustomer = async name => {
    setBusy(true);
    try {
      const created = await createBillingCustomer({ name });
      setCustomers(list => [...(list || []), created].sort((a, b) => a.name.localeCompare(b.name)));
      chooseCustomer(created.id);
      setAdding('');
      toast.success(`Customer ${name} added`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const addSubscription = async name => {
    setBusy(true);
    try {
      const created = await saveBillingWorkload(customerId, null, { name });
      setLedger(prev => ({ ...prev, workloads: [...(prev?.workloads || []), created] }));
      setWorkloadId(created.id);
      setAdding('');
      toast.success(`Subscription ${name} added`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const addDistributor = name => {
    setDistributors(list => (list.some(d => d.toLowerCase() === name.toLowerCase()) ? list : [...list, name]));
    set({ distributor: name });
    setAdding('');
  };

  const renameCustomer = async name => {
    const current = (customers || []).find(c => c.id === customerId);
    if (!current || name === current.name) { setAdding(''); return; }
    setBusy(true);
    try {
      const saved = await updateBillingCustomer(customerId, { name, company: current.company || '', contact_email: current.contact_email || '', notes: current.notes || '' });
      setCustomers(list => (list || []).map(c => (c.id === customerId ? { ...c, ...saved } : c)).sort((a, b) => a.name.localeCompare(b.name)));
      setAdding('');
      toast.success('Customer renamed');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const renameSubscription = async name => {
    const sub = subscriptions.find(w => w.id === workloadId);
    if (!sub || name === sub.name) { setAdding(''); return; }
    setBusy(true);
    try {
      const fields = ['po_id', 'po_date', 'period_start', 'period_end', 'frequency', 'plan_name', 'requirement_id', 'distributor', 'notes'];
      const body = { name, owner: sub.owner || '', revision: sub.revision, ...Object.fromEntries(fields.map(f => [f, sub[f] ?? ''])) };
      await saveBillingWorkload(customerId, sub.id, body);
      setLedger(await getBillingLedger(customerId));
      setAdding('');
      toast.success('Subscription renamed');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const removeEntry = async entry => {
    if (!window.confirm(`Delete the ${monthName(entry.period)} entry for ${subName(entry.workload_id)}? This cannot be undone.`)) return;
    try { await deleteBillingItem('entry', entry.id); setLedger(await getBillingLedger(customerId)); toast.success('Entry deleted'); } catch (e) { toast.error(errorMessage(e)); }
  };
  const removeSubscription = async () => {
    const sub = subscriptions.find(w => w.id === workloadId);
    if (!sub) return;
    const count = entries.filter(e => e.workload_id === sub.id).length;
    if (!window.confirm(`Delete subscription "${sub.name}" and its ${count} monthly entr${count === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
    try { await deleteBillingItem('workload', sub.id); setWorkloadId(''); setLedger(await getBillingLedger(customerId)); toast.success('Subscription deleted'); } catch (e) { toast.error(errorMessage(e)); }
  };

  const edit = entry => {
    setWorkloadId(entry.workload_id);
    setForm({
      period: entry.period, invoice_number: entry.invoice_number || '', customer_amount: entry.customer_amount ?? '',
      distributor: entry.distributor || '', distributor_amount: entry.distributor_amount ?? '', currency: entry.currency || 'INR',
      amount_basis: entry.amount_basis === 'gross' ? 'gross' : 'net',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const save = async event => {
    event.preventDefault();
    if (!workloadId) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        ...form,
        invoice_number: form.invoice_number.trim(),
        customer_amount: form.customer_amount === '' ? null : form.customer_amount,
        distributor_amount: form.distributor_amount === '' ? null : form.distributor_amount,
        ...(existing ? { revision: existing.revision, notes: existing.notes || '', payment_status: existing.payment_status || '', usage_amount: existing.usage_amount } : {}),
      };
      await saveBillingEntry(workloadId, existing?.id, body);
      setLedger(await getBillingLedger(customerId));
      if (form.distributor) addDistributor(form.distributor);
      toast.success(existing ? 'Entry updated' : 'Entry saved');
      setForm(prev => ({ ...EMPTY, period: prev.period, distributor: prev.distributor, currency: prev.currency, amount_basis: prev.amount_basis }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const subName = id => subscriptions.find(w => w.id === id)?.name || (ledger?.workloads || []).find(w => w.id === id)?.name || '—';
  const totals = entries.reduce((t, e) => ({ billed: t.billed + (Number(e.customer_amount) || 0), cost: t.cost + (Number(e.distributor_amount) || 0) }), { billed: 0, cost: 0 });
  const currency = entries[0]?.currency || form.currency;

  return (
    <BillingPage
      title="Add billing entry"
      description="Pick the customer and subscription, then record the month: invoice number, what you billed, and what the distributor charged."
      actions={<>
        <Button variant="outline" size="sm" onClick={template}><Download />Template</Button>
        <Button variant="outline" size="sm" onClick={exportCsv}><Download />Export CSV</Button>
        {canEdit && <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}><FileUp />Import CSV</Button>}
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={e => importCsv(e.target.files?.[0])} />
      </>}
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card>
          <CardContent className="p-5 sm:p-6">
            <form onSubmit={save} className="space-y-4">
              <div>
                <div className="flex items-center justify-between"><Label htmlFor="be-customer">1 · Customer</Label>{canEdit && adding !== 'customer' && <button type="button" onClick={() => setAdding('customer')} className="inline-flex items-center gap-1 text-xs font-medium text-[#c2410c] hover:underline"><Plus className="h-3 w-3" />New customer</button>}</div>
                <NativeSelect id="be-customer" className="mt-1.5" value={customerId} onChange={e => chooseCustomer(e.target.value)} disabled={!customers}>
                  <option value="">{customers ? 'Choose a customer' : 'Loading…'}</option>
                  {(customers || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </NativeSelect>
                {canEdit && customerId && !adding && <button type="button" onClick={() => setAdding('rename-customer')} className="mt-1.5 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-[#c2410c]"><Pencil className="h-3 w-3" />Rename customer</button>}
                {adding === 'customer' && <AddInline placeholder="Customer name" busy={busy} onAdd={addCustomer} onCancel={() => setAdding('')} />}
                {adding === 'rename-customer' && <AddInline placeholder="New customer name" label="Save" initial={(customers || []).find(c => c.id === customerId)?.name || ''} busy={busy} onAdd={renameCustomer} onCancel={() => setAdding('')} />}
              </div>

              <div>
                <div className="flex items-center justify-between"><Label htmlFor="be-sub">2 · Subscription</Label>{canEdit && customerId && adding !== 'sub' && <button type="button" onClick={() => setAdding('sub')} className="inline-flex items-center gap-1 text-xs font-medium text-[#c2410c] hover:underline"><Plus className="h-3 w-3" />New subscription</button>}</div>
                <NativeSelect id="be-sub" className="mt-1.5" value={workloadId} onChange={e => setWorkloadId(e.target.value)} disabled={!customerId || !ledger}>
                  <option value="">{!customerId ? 'Choose a customer first' : !ledger ? 'Loading…' : subscriptions.length ? 'Choose a subscription' : 'No subscriptions yet — add one'}</option>
                  {subscriptions.map(w => <option key={w.id} value={w.id}>{w.name}{w.owner ? ` · ${w.owner}` : ''}</option>)}
                </NativeSelect>
                {canEdit && workloadId && !adding && <div className="mt-1.5 flex gap-4"><button type="button" onClick={() => setAdding('rename-sub')} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-[#c2410c]"><Pencil className="h-3 w-3" />Rename subscription</button><button type="button" onClick={removeSubscription} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-400"><Trash2 className="h-3 w-3" />Delete this subscription</button></div>}
                {adding === 'rename-sub' && <AddInline placeholder="New subscription name" label="Save" initial={subscriptions.find(w => w.id === workloadId)?.name || ''} busy={busy} onAdd={renameSubscription} onCancel={() => setAdding('')} />}
                {adding === 'sub' && <AddInline placeholder="Subscription name" busy={busy} onAdd={addSubscription} onCancel={() => setAdding('')} />}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div><Label htmlFor="be-month">3 · Month</Label><Input id="be-month" className="mt-1.5" type="month" required value={form.period} onChange={e => set({ period: e.target.value })} /></div>
                <div><Label htmlFor="be-invoice">4 · Invoice number</Label><Input id="be-invoice" className="mt-1.5" value={form.invoice_number} onChange={e => set({ invoice_number: e.target.value })} placeholder="e.g. INV-1042" /></div>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
                <div><Label htmlFor="be-billed">5 · Our billing amount</Label><Input id="be-billed" className="mt-1.5 tabular-nums" type="number" step="0.01" inputMode="decimal" value={form.customer_amount} onChange={e => set({ customer_amount: e.target.value })} placeholder="0.00" /></div>
                <div><Label htmlFor="be-currency">Currency</Label><NativeSelect id="be-currency" className="mt-1.5" value={form.currency} onChange={e => set({ currency: e.target.value })}>{['INR', 'USD', 'EUR', 'GBP'].map(c => <option key={c}>{c}</option>)}</NativeSelect></div>
              </div>

              <div>
                <div className="flex items-center justify-between"><Label>6 · Distributor</Label>{adding !== 'dist' && <button type="button" onClick={() => setAdding('dist')} className="inline-flex items-center gap-1 text-xs font-medium text-[#c2410c] hover:underline"><Plus className="h-3 w-3" />Add distributor</button>}</div>
                <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label="Distributor">
                  {distributors.map(name => (
                    <button key={name} type="button" role="radio" aria-checked={form.distributor === name} onClick={() => set({ distributor: form.distributor === name ? '' : name })}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${form.distributor === name ? 'border-[#fdba74] bg-[#ffedd5] text-[#9a3412]' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}>{name}</button>
                  ))}
                </div>
                {adding === 'dist' && <AddInline placeholder="Distributor name" onAdd={addDistributor} onCancel={() => setAdding('')} />}
              </div>

              <div><Label htmlFor="be-dist-amt">7 · Distributor amount</Label><Input id="be-dist-amt" className="mt-1.5 tabular-nums" type="number" step="0.01" inputMode="decimal" value={form.distributor_amount} onChange={e => set({ distributor_amount: e.target.value })} placeholder="0.00" /></div>

              <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5">
                <span className="text-xs text-slate-400">Profit for this month</span>
                <span className={`text-sm font-semibold tabular-nums ${profit == null ? 'text-slate-500' : profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{profit == null ? 'Enter both amounts' : money(profit, form.currency)}</span>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="text-xs text-slate-400">Amounts are{' '}
                  <select value={form.amount_basis} onChange={e => set({ amount_basis: e.target.value })} className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200">
                    <option value="net">before tax</option><option value="gross">including tax</option>
                  </select>
                </label>
                {existing && <span className="text-xs text-amber-300">This month exists — saving updates it</span>}
              </div>

              {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
              <Button type="submit" className="w-full" disabled={!canEdit || busy || !workloadId}>
                {busy ? <Loader2 className="animate-spin" /> : <Check />}{existing ? 'Update entry' : 'Save entry'}
              </Button>
              {!canEdit && <p className="text-center text-xs text-slate-500">Workspace admins only</p>}
            </form>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 p-5">
            <div>
              <h2 className="text-base font-semibold text-slate-100">{customerId ? (customers || []).find(c => c.id === customerId)?.name || 'Entries' : 'Entries'}</h2>
              <p className="mt-1 text-sm text-slate-400">{customerId ? `${entries.length} month${entries.length === 1 ? '' : 's'} recorded · click a row to edit` : 'Choose a customer to see their months.'}</p>
            </div>
            {entries.length > 0 && <div className="flex gap-5 text-right text-xs"><div><p className="text-slate-500">Billed</p><p className="font-semibold tabular-nums text-slate-100">{money(totals.billed, currency)}</p></div><div><p className="text-slate-500">Distributor</p><p className="font-semibold tabular-nums text-slate-100">{money(totals.cost, currency)}</p></div><div><p className="text-slate-500">Profit</p><p className={`font-semibold tabular-nums ${totals.billed - totals.cost >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(totals.billed - totals.cost, currency)}</p></div></div>}
          </div>
          {!customerId ? null : !ledger ? <p className="flex items-center gap-2 p-8 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p> : !entries.length ? <p className="p-8 text-center text-sm text-slate-400">No months recorded yet. Use the form to add the first one.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead><tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  {['Month', 'Subscription', 'Invoice', 'Our billing', 'Distributor', 'Distributor amount', 'Profit', ''].map(h => <th key={h} className={`px-4 py-2.5 font-medium ${['Our billing', 'Distributor amount', 'Profit'].includes(h) ? 'text-right' : ''}`}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {entries.map(e => {
                    const p = e.customer_amount != null && e.distributor_amount != null ? Number(e.customer_amount) - Number(e.distributor_amount) : null;
                    const active = e.workload_id === workloadId && e.period === form.period;
                    return (
                      <tr key={e.id} onClick={() => edit(e)} className={`cursor-pointer border-b border-slate-800/60 hover:bg-slate-800/40 ${active ? 'bg-[#ffedd5]/10' : ''}`}>
                        <td className="whitespace-nowrap px-4 py-2.5 text-slate-200">{monthName(e.period)}</td>
                        <td className="max-w-[12rem] truncate px-4 py-2.5 text-slate-300" title={subName(e.workload_id)}>{subName(e.workload_id)}</td>
                        <td className="px-4 py-2.5 text-slate-400">{e.invoice_number || '—'}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-100">{money(e.customer_amount, e.currency)}</td>
                        <td className="px-4 py-2.5 text-slate-300">{e.distributor || '—'}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-100">{money(e.distributor_amount, e.currency)}</td>
                        <td className={`whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums ${p == null ? 'text-slate-500' : p >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{p == null ? '—' : money(p, e.currency)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right"><Pencil className="inline h-3.5 w-3.5 text-slate-500" aria-label="Edit" />{canEdit && <button type="button" aria-label="Delete entry" title="Delete entry" onClick={ev => { ev.stopPropagation(); removeEntry(e); }} className="ml-2 rounded p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="inline h-3.5 w-3.5" /></button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {customerId && <ExtraCharges customerId={customerId} customerName={(customers || []).find(c => c.id === customerId)?.name || ''} canEdit={canEdit} />}
    </BillingPage>
  );
}
