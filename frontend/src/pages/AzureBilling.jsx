import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Building2, CheckCircle2, Download, Plus, Search, Upload, Settings, Trash2 } from 'lucide-react';
import * as api from '../api/client';
import { errorMessage } from '../utils/apiError';
import { billingMoney, billingMonth, documentStatus } from '../utils/billingPresentation';
import BillingLedger, { LedgerImport } from '../components/Common/BillingLedger';
import BillingServices from '../components/Common/BillingServices';
import { BillingPage, BillingNotice, BillingEmpty, billingInput as input, billingButton as primary, billingSecondary as secondary, billingPanel as panel } from '../components/billing-ui/workspace';

const TYPES = { customer: 'Customer invoice', distributor: 'Distributor invoice', azure_usage: 'Azure usage bill' };

function Field({ label, ...props }) {
  return <label className="block text-sm text-slate-400">{label}<input className={input} {...props} /></label>;
}

function SharePointLink({ url }) {
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.sharepoint.com')) return null; } catch { return null; }
  return <a href={url} target="_blank" rel="noreferrer noopener" className={secondary}>Open original <ArrowUpRight size={14} /></a>;
}

function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Review({ document, onSaved }) {
  const suggestion = document.extraction?.suggestions || {};
  const [form, setForm] = useState({ invoice_number: document.invoice_number || suggestion.invoice_number || '', period: document.period, currency: document.currency || suggestion.currency || '', net_amount: document.net_amount ?? suggestion.net_amount ?? '', tax_amount: document.tax_amount ?? suggestion.tax_amount ?? '0' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="mt-5 space-y-4 border-t border-slate-800 pt-5" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.reviewBillingDocument(document.id, form); onSaved(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }}>
    <p className="text-sm text-slate-300">Check these amounts against the original bill before saving. Credit notes should use negative amounts.</p>
    <div className="grid gap-4 sm:grid-cols-2">{[['invoice_number', 'Invoice number', 'text'], ['period', 'Billing month', 'month'], ['currency', 'Currency, e.g. INR', 'text'], ['net_amount', 'Amount before tax', 'number'], ['tax_amount', 'Tax', 'number']].map(([key, label, type]) => <Field key={key} label={label} type={type} required={key !== 'invoice_number'} step={type === 'number' ? '.0001' : undefined} pattern={key === 'currency' ? '[A-Z]{3}' : undefined} value={form[key]} onChange={e => setForm({ ...form, [key]: key === 'currency' ? e.target.value.toUpperCase() : e.target.value })} />)}</div>
    {error && <BillingNotice error>{error}</BillingNotice>}<button className={primary} disabled={busy}>{busy ? 'Saving…' : 'Confirm amounts'}</button>
  </form>;
}

function CompanyForm({ initial, onSave, busy, onCancel }) {
  const [form, setForm] = useState(initial || { name: '', company: '', contact_email: '', notes: '' });
  return <form className="space-y-5" onSubmit={e => { e.preventDefault(); onSave(form); }}>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Customer name" required maxLength={150} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /><Field label="Company / legal name" maxLength={200} value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} /><Field label="Contact email" type="email" maxLength={254} value={form.contact_email} onChange={e => setForm({ ...form, contact_email: e.target.value })} /></div>
    <label className="block text-sm text-slate-400">Notes<textarea className={input} rows={3} maxLength={4000} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
    <div className="flex gap-3"><button className={primary} disabled={busy}>{busy ? 'Saving…' : initial ? 'Save company details' : 'Create customer'}</button>{onCancel && <button className={secondary} type="button" onClick={onCancel} disabled={busy}>Cancel</button>}</div>
  </form>;
}

function StorageSettings({ settings, onReload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ site_url: '', library: 'Documents', folder: '' });
  const run = async fn => { setBusy(true); setError(''); setMessage(''); try { await fn(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  const blob = settings?.connection?.provider === 'azure_blob';
  return <BillingPage title="Billing settings" description="Manage where original bills are saved and how invoice amounts are extracted.">
    {error && <BillingNotice error>{error}</BillingNotice>}{message && <BillingNotice>{message}</BillingNotice>}
    <div className="grid gap-5 lg:grid-cols-2"><section className={panel}><CheckCircle2 className="mb-4 text-blue-400" size={24} /><h2 className="text-lg font-semibold">Document storage</h2><p className="mt-2 text-sm leading-7 text-slate-400">{blob ? 'Bills are saved privately in Azure cloud. Only people with access to this workspace can download them through the app.' : settings?.connection ? 'Bills are saved to your connected SharePoint library.' : 'Storage needs to be connected before you can upload bills.'}</p><p className="mt-4 text-sm font-medium text-slate-200">{settings?.connection ? 'Configured' : 'Setup required'}</p>{settings?.can_edit && blob && <button className={`${secondary} mt-5`} disabled={busy} onClick={() => run(async () => { await api.checkBillingStorage(); setMessage('Connection checked. Azure storage is available.'); })}>Check connection</button>}{!blob && settings?.connection?.folder_url && <div className="mt-5"><SharePointLink url={settings.connection.folder_url} /></div>}</section>
      <section className={panel}><FileScanIcon /><h2 className="text-lg font-semibold">Read amounts from bills</h2><p className="mt-2 text-sm leading-7 text-slate-400">{settings?.ocr_configured ? 'Scanned bills can be read automatically. Always check the extracted amounts before confirming them.' : 'Text-based bills can be read. Scanned-image reading needs setup; you can still enter amounts yourself.'}</p><p className="mt-4 text-sm font-medium text-slate-200">{settings?.ocr_configured ? 'Automatic scan reading configured' : 'Manual review available'}</p></section></div>
    {!blob && settings?.can_edit && <details className={panel}><summary className="cursor-pointer font-semibold">Connect SharePoint instead</summary><button className={`${secondary} mt-4`} disabled={busy} onClick={() => run(async () => { await api.connectBillingMicrosoft(); setMessage('Microsoft access connected. Save the destination below.'); })}>Connect Microsoft file access</button><form className="mt-5 space-y-4" onSubmit={e => { e.preventDefault(); run(async () => { await api.saveBillingConnection(form); await onReload(); setMessage('Storage destination saved.'); }); }}><Field label="SharePoint site URL" type="url" required value={form.site_url} onChange={e => setForm({ ...form, site_url: e.target.value })} /><Field label="Library" required value={form.library} onChange={e => setForm({ ...form, library: e.target.value })} /><Field label="Folder (optional)" value={form.folder} onChange={e => setForm({ ...form, folder: e.target.value })} /><button className={primary} disabled={busy}>Verify and save</button></form></details>}
    {!settings?.can_edit && <BillingNotice>You can view billing information. Ask a workspace administrator to change these settings.</BillingNotice>}
  </BillingPage>;
}

function FileScanIcon() { return <Upload className="mb-4 text-blue-400" size={24} />; }

function CustomerProfile({ customer, settings, onCustomerChanged }) {
  const [params, setParams] = useSearchParams();
  const view = ['monthly', 'services', 'bills', 'details'].includes(params.get('view')) ? params.get('view') : 'monthly';
  const setView = next => setParams(previous => { const p = new URLSearchParams(previous); p.set('view', next); p.delete('review'); return p; });
  const [data, setData] = useState(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState('customer');
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [file, setFile] = useState(null);
  const [fileVersion, setFileVersion] = useState(0);
  const [review, setReview] = useState('');
  const [onlyReview, setOnlyReview] = useState(params.get('review') === '1' && view === 'bills');
  const [showExcluded, setShowExcluded] = useState(false);
  const canEdit = settings.can_edit && !customer.archived;
  useEffect(() => { let live = true; api.getBillingCustomer(customer.id).then(result => { if (live) { setData(result); setError(''); } }).catch(err => { if (live) setError(errorMessage(err)); }); return () => { live = false; }; }, [customer.id, revision]);
  const run = async fn => { setBusy(true); setError(''); setMessage(''); try { await fn(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  const refresh = () => { setReview(''); setRevision(v => v + 1); };
  const pending = data?.documents.filter(d => d.status === 'needs_review').length || 0;
  const documents = (data?.documents || []).filter(d => (showExcluded || d.status !== 'void') && (!onlyReview || d.status === 'needs_review'));
  return <BillingPage title={customer.name} description={customer.contact_email || 'Monthly billing, invoices and company details.'} actions={<><Link className={secondary} to="/azure-billing"><ArrowLeft size={15} />All customers</Link><button className={secondary} disabled={busy} onClick={() => run(async () => saveFile(await api.exportBillingWorkbook(customer.id), 'billing-report.xlsx'))}><Download size={15} />Export report</button>{canEdit && <button className={primary} onClick={() => { setView('bills'); setUploading(true); }}><Plus size={16} />Upload bill</button>}</>}>
    {!!customer.archived && <BillingNotice>This customer is archived. Restore it in Company details to make changes.</BillingNotice>}
    {error && <BillingNotice error>{error}</BillingNotice>}{message && <BillingNotice>{message}</BillingNotice>}
    <nav aria-label="Customer sections" className="flex flex-wrap gap-2">{[['monthly', 'Monthly billing'], ['services', 'Services & POs'], ['bills', `Bills & uploads${pending ? ` (${pending} to check)` : ''}`], ['details', 'Company details']].map(([key, label]) => <button key={key} aria-pressed={view === key} onClick={() => setView(key)} className={view === key ? primary : secondary}>{label}</button>)}</nav>
    {view === 'monthly' && <BillingLedger customerId={customer.id} canEdit={canEdit} initialReview={params.get('review') === '1'} initialMonth={params.get('month') || ''} />}
    {view === 'services' && <BillingServices customerId={customer.id} canEdit={canEdit} />}
    {view === 'details' && <section className={panel}><h2 className="mb-5 text-lg font-semibold">Company details</h2>{canEdit ? <CompanyForm key={customer.name} initial={{ name: customer.name, company: customer.company, contact_email: customer.contact_email, notes: customer.notes }} busy={busy} onSave={form => run(async () => { await api.updateBillingCustomer(customer.id, form); await onCustomerChanged(); setMessage('Company details saved.'); })} /> : <dl className="space-y-4 text-sm">{[['Company', customer.company], ['Contact', customer.contact_email], ['Notes', customer.notes]].map(([label, value]) => <div key={label}><dt className="text-slate-400">{label}</dt><dd className="mt-1 whitespace-pre-wrap">{value || 'Not entered'}</dd></div>)}</dl>}{settings.can_edit && <details className="mt-8 border-t border-slate-800 pt-5"><summary className="cursor-pointer text-sm text-slate-400">{customer.archived ? 'Restore customer' : 'Archive customer'}</summary><p className="mt-3 text-sm text-slate-400">Archived customers leave the active list. Their bills and history are kept, and they can be restored.</p><button className={`${secondary} mt-4`} disabled={busy} onClick={() => { if (customer.archived || window.confirm('Archive this customer? You can restore it later.')) run(async () => { await api.archiveBillingItem('customer', customer.id, !!customer.archived); await onCustomerChanged(); }); }}>{customer.archived ? 'Restore customer' : 'Archive customer'}</button></details>}</section>}
    {view === 'bills' && <>
      {!data && !error && <p role="status">Loading bills…</p>}
      {uploading && canEdit && <form className={`${panel} space-y-5`} onSubmit={e => { e.preventDefault(); run(async () => { const form = new FormData(); form.append('file', file); form.append('kind', kind); form.append('period', period); const result = await api.uploadBillingDocument(customer.id, form, settings.connection?.provider); setMessage(result.duplicate ? 'This bill is already saved. No duplicate was added.' : 'Bill saved. Check the extracted amounts below.'); setRevision(v => v + 1); setReview(result.document.id); setUploading(false); setFile(null); setFileVersion(v => v + 1); setOnlyReview(false); }); }}><h2 className="text-lg font-semibold">Upload a bill</h2><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm text-slate-400">Bill type<select className={input} value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><Field label="Billing month" type="month" required value={period} onChange={e => setPeriod(e.target.value)} /></div><label className="block rounded-xl border-2 border-dashed border-slate-700 p-6 text-center"><Upload className="mx-auto mb-3 text-blue-400" size={24} /><span className="block text-sm font-medium">Choose the original bill</span><span className="mt-1 block text-xs text-slate-400">PDF, photo, Excel or CSV · up to 10 MB · one invoice per file</span><input key={fileVersion} className="mx-auto mt-4 block max-w-full text-sm" type="file" required accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx" onChange={e => setFile(e.target.files[0] || null)} /></label>{!settings.connection && <BillingNotice>Document storage needs setup. Open Billing settings before uploading.</BillingNotice>}<div className="flex gap-3"><button className={primary} disabled={busy || !file || !settings.connection}>{busy ? 'Saving and reading bill…' : 'Save bill'}</button><button className={secondary} type="button" disabled={busy} onClick={() => setUploading(false)}>Cancel</button></div></form>}
      <div className="flex flex-wrap items-center justify-between gap-3"><label className="text-sm text-slate-400"><input type="checkbox" checked={onlyReview} onChange={e => setOnlyReview(e.target.checked)} /> Only bills to check ({pending})</label><label className="text-xs text-slate-500"><input type="checkbox" checked={showExcluded} onChange={e => setShowExcluded(e.target.checked)} /> Include excluded bills</label></div>
      {data && !documents.length && <BillingEmpty title={onlyReview ? 'No bills waiting for review' : 'No bills here yet'} action={canEdit && !onlyReview ? <button className={primary} onClick={() => setUploading(true)}>Upload first bill</button> : null}>{onlyReview ? 'Switch off the filter to see all bills.' : 'Upload customer, distributor and Azure usage invoices to compare reviewed amounts.'}</BillingEmpty>}
      {documents.map(doc => <article key={doc.id} className={panel}><div className="flex flex-wrap items-start justify-between gap-4"><div><span className={`rounded-md px-2 py-1 text-xs font-medium ${doc.status === 'needs_review' ? 'bg-amber-500/10 text-amber-300' : 'bg-slate-800 text-slate-300'}`}>{documentStatus(doc.status)}</span><h3 className="mt-3 break-all font-semibold">{doc.filename}</h3><p className="mt-1 text-sm text-slate-400">{TYPES[doc.kind]} · {billingMonth(doc.period)}</p><p className="mt-3 text-lg font-semibold tabular-nums">{billingMoney(doc.net_amount, doc.currency || 'INR')}</p></div><div className="flex flex-wrap gap-2">{doc.storage_provider === 'azure_blob' ? <button className={secondary} disabled={busy} onClick={() => run(async () => saveFile(await api.downloadBillingDocument(doc.id), doc.filename))}>Download original</button> : <SharePointLink url={doc.web_url} />}{canEdit && doc.status !== 'void' && <button className={primary} onClick={() => setReview(review === doc.id ? '' : doc.id)}>{review === doc.id ? 'Close review' : doc.status === 'needs_review' ? 'Check amounts' : 'Edit amounts'}</button>}</div></div>{review === doc.id && <Review document={doc} onSaved={refresh} />}<details className="mt-4 text-xs text-slate-400"><summary className="cursor-pointer">Reading details & more actions</summary><p className="mt-3 leading-6">{doc.extraction_message}</p>{canEdit && doc.status !== 'void' && <button className="mt-3 text-rose-400" disabled={busy} onClick={() => { if (window.confirm('Exclude this bill from totals? The original document will be kept.')) run(async () => { await api.excludeBillingDocument(doc.id); refresh(); }); }}>Exclude from totals</button>}</details></article>)}
      {!!data?.comparison.length && <details className={panel}><summary className="cursor-pointer font-semibold">Compare reviewed invoices</summary><p className="mt-3 text-sm text-slate-400">Customer amount before tax minus distributor amount before tax. Azure usage is a reference, not another expense. Separate from monthly billing records.</p><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Month', 'Customer', 'Distributor', 'Azure usage', 'Profit / loss', 'To check'].map(label => <th key={label} className="whitespace-nowrap p-3 text-xs text-slate-400">{label}</th>)}</tr></thead><tbody>{data.comparison.map(row => <tr key={`${row.period}:${row.currency}`} className="border-t border-slate-800"><td className="p-3 whitespace-nowrap">{billingMonth(row.period)}</td>{['customer', 'distributor', 'azure_usage', 'profit'].map(key => <td key={key} className="whitespace-nowrap p-3 tabular-nums">{billingMoney(row[key], row.currency)}</td>)}<td className="p-3">{row.pending}</td></tr>)}</tbody></table></div></details>}
      {canEdit && settings.connection && <button className={secondary} disabled={busy} onClick={() => run(async () => { await api.exportBillingCloud(customer.id, settings.connection.provider); setMessage('Report saved to your customer’s cloud folder.'); })}>Save report to cloud</button>}
    </>}
  </BillingPage>;
}

export default function AzureBilling() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const id = params.get('customer') || '';
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const load = useCallback(async () => { const [list, config] = await Promise.all([api.listBillingCustomers(), api.getBillingConnection()]); setCustomers(list.items); setSettings(config); }, []);
  useEffect(() => { let live = true; Promise.all([api.listBillingCustomers(), api.getBillingConnection()]).then(([list, config]) => { if (live) { setCustomers(list.items); setSettings(config); } }).catch(err => { if (live) setError(errorMessage(err)); }); return () => { live = false; }; }, []);
  const run = async fn => { setBusy(true); setError(''); try { await fn(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  if (!settings) return <BillingPage title="Azure Billing" description="Your customer billing workspace.">{error ? <><BillingNotice error>{error}</BillingNotice><button className={secondary} onClick={() => run(load)}>Try again</button></> : <p role="status">Loading workspace…</p>}</BillingPage>;
  if (location.pathname.endsWith('/settings')) return <StorageSettings settings={settings} onReload={load} />;
  const customer = customers.find(item => item.id === id);
  if (customer) return <CustomerProfile key={id} customer={customer} settings={settings} onCustomerChanged={load} />;
  const canDelete = !!settings.can_edit;
  const onDelete = item => {
    const typed = window.prompt(`Permanently delete "${item.name}", its subscriptions and all its monthly entries?\n\nThis cannot be undone. Type DELETE to confirm:`);
    if (typed == null) return;
    if (typed.trim().toUpperCase() !== 'DELETE') { setError('You did not type DELETE, so nothing was deleted.'); return; }
    run(async () => { const r = await api.deleteBillingItem('customer', item.id, 'DELETE'); await load(); setError(''); window.alert(`Deleted ${item.name} (${r.subscriptions} subscriptions, ${r.entries} monthly entries).`); });
  };
  const shown = customers.filter(item => (showArchived ? !!item.archived : !item.archived) && `${item.name} ${item.company} ${item.contact_email}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <BillingPage title="Customers" description="Choose a company to see its monthly billing or add a new bill." actions={settings.can_edit && <><button className={secondary} onClick={() => setImporting(v => !v)}><Upload size={16} />Import spreadsheet</button><button className={primary} onClick={() => setAdding(v => !v)}><Plus size={16} />Add customer</button></>}>
    {error && <BillingNotice error>{error}</BillingNotice>}{id && !customer && <BillingNotice error>That customer could not be found in this workspace.</BillingNotice>}
    {adding && settings.can_edit && <section className={panel}><h2 className="mb-5 text-lg font-semibold">New customer</h2><CompanyForm busy={busy} onCancel={() => setAdding(false)} onSave={async form => run(async () => { const created = await api.createBillingCustomer(form); await load(); setParams({ customer: created.id }); setAdding(false); })} /></section>}
    {importing && settings.can_edit && <LedgerImport onImported={load} />}
    {!settings.connection && <BillingNotice>Connect document storage before uploading bills. <Link to="/azure-billing/settings" className="text-blue-400 underline">Open settings</Link></BillingNotice>}
    <div className="flex flex-wrap items-center justify-between gap-4"><label className="relative block w-full max-w-md"><Search className="pointer-events-none absolute left-3 top-3 text-slate-500" size={18} /><input aria-label="Search customers" placeholder="Search by company or contact…" className={`${input} mt-0 pl-10`} value={search} onChange={e => setSearch(e.target.value)} /></label><div className="flex items-center gap-4 text-sm text-slate-400"><span>{shown.length} {showArchived ? 'archived' : 'active'} customers</span><label><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Archived</label></div></div>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map(item => <Link key={item.id} to={`/azure-billing?customer=${encodeURIComponent(item.id)}`} className={`${panel} group transition hover:border-blue-500/60 focus-visible:ring-2 focus-visible:ring-blue-500`}><div className="flex items-start justify-between gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-400"><Building2 size={20} /></span><span className="flex items-center gap-1">{canDelete && <button type="button" aria-label={`Delete ${item.name}`} title="Delete customer" onClick={event => { event.preventDefault(); event.stopPropagation(); onDelete(item); }} className="rounded-md p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-400 focus-visible:ring-2 focus-visible:ring-red-400"><Trash2 size={16} /></button>}<ArrowUpRight size={18} className="text-slate-500 group-hover:text-blue-400" /></span></div><h2 className="mt-4 text-base font-semibold leading-6">{item.name}</h2><p className="mt-2 text-sm text-slate-400">{item.contact_email || (item.company !== item.name ? item.company : '') || 'View monthly billing and invoices'}</p><p className="mt-5 text-sm font-medium text-blue-400">{item.archived ? 'Open archived customer' : 'Open customer'} →</p></Link>)}</div>
    {!shown.length && <BillingEmpty title={search ? 'No matching customers' : showArchived ? 'No archived customers' : 'Add your first customer'} action={search ? <button className={secondary} onClick={() => setSearch('')}>Clear search</button> : null}>{search ? 'Try a different company name or contact.' : 'Customer profiles keep bills, monthly amounts and notes together.'}</BillingEmpty>}
    <p className="flex items-center gap-2 text-xs text-slate-500"><Settings size={14} />{settings.can_edit ? 'You can manage customers and bills.' : 'You have read-only access.'} Storage and extraction settings are separate from your billing records.</p>
  </BillingPage>;
}
