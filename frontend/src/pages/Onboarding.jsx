import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  Plus, Download, ShieldCheck, KeyRound, Loader2, Check, ChevronDown, ListOrdered,
  Building2, Fingerprint, Lock, ExternalLink, LogOut, Eye, EyeOff,
} from 'lucide-react';
import { addTenant, downloadSetupGuide } from '../api/client';
import { useLogin } from '../auth/hooks';
import { useAppStore } from '../store/useAppStore';
import PermissionsPanel from '../components/Common/PermissionsPanel';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Four fragments, not four paragraphs. Whoever opens this is looking for the
// next click, and every extra line is one more thing in front of it.
const STEPS = [
  ['Register an app', 'Entra ID → App registrations → New registration'],
  ['Add a client secret', 'Certificates & secrets → copy the Value, not the Secret ID'],
  ['Assign two roles', 'Reader and Cost Management Reader, on each subscription'],
  ['Paste them here', 'Checked against Azure on submit'],
];

const PORTAL = 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';

/**
 * A GUID copied out of the portal often arrives wrapped in whitespace or the
 * quotes of whatever it was pasted through. Rejecting that as "not a valid
 * GUID" is technically true and completely useless, so it is cleaned instead.
 */
const clean = (v) => v.trim().replace(/^["'<]+|[">']+$/g, '');

/** A titled row that opens. Used for both the things that are not the task. */
function Disclosure({ icon, label, open, onToggle, id, children }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 text-sm text-slate-300">{label}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div id={id} className="border-t border-slate-800 px-4 py-3.5">{children}</div>}
    </div>
  );
}

function Field({
  label, icon: Icon, value, onChange, type = 'text',
  placeholder, hint, error, action,
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label className="block text-xs font-medium text-slate-400">{label}</label>
        {action}
      </div>
      <div className="relative">
        {Icon && (
          <Icon className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        )}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={`w-full bg-slate-800 border rounded-lg ${Icon ? 'pl-9' : 'pl-3'} pr-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition ${
            error ? 'border-red-500/70 focus:border-red-500' : 'border-slate-700 focus:border-blue-500'
          }`}
        />
      </div>
      {error
        ? <p className="text-xs text-red-400 mt-1.5">{error}</p>
        : hint && <p className="text-xs text-slate-500 mt-1.5">{hint}</p>}
    </div>
  );
}

export default function Onboarding() {
  const me = useAppStore(s => s.me);
  const { logout } = useLogin();
  const loadMe = useAppStore(s => s.loadMe);
  const loadTenants = useAppStore(s => s.loadTenants);
  const addTenantToList = useAppStore(s => s.addTenantToList);

  // The directory they signed in from is almost always the one they are about
  // to connect, so it starts filled in. Left editable because "almost always"
  // is not always -- a partner connecting a customer's tenant needs to change it.
  const [form, setForm] = useState({
    tenant_name: '', tenant_id: me?.tenant_id || '', client_id: '', client_secret: '',
  });
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [touched, setTouched] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  // One at a time. Both panels are long, and opening the second while the
  // first is still expanded rebuilds the wall this page was meant to remove.
  const [panel, setPanel] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Both IDs are GUIDs, which makes pasting them into the wrong box very easy.
  // Checking the shape here turns a confusing Azure auth failure into a
  // pointed message before the request is even sent.
  const errors = {
    tenant_name: !form.tenant_name.trim() ? 'Give this connection a name.' : '',
    tenant_id: !form.tenant_id.trim()
      ? 'Required.'
      : GUID.test(form.tenant_id.trim()) ? '' : 'That is not a valid GUID.',
    client_id: !form.client_id.trim()
      ? 'Required.'
      : GUID.test(form.client_id.trim()) ? '' : 'That is not a valid GUID.',
    client_secret: !form.client_secret ? 'Required.' : '',
  };
  const valid = Object.values(errors).every(e => !e);

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;

    setSaving(true);
    try {
      const tenant = await addTenant({
        tenant_name: form.tenant_name.trim(),
        tenant_id: form.tenant_id.trim(),
        client_id: form.client_id.trim(),
        client_secret: form.client_secret,
      });
      addTenantToList(tenant);
      toast.success(`Connected "${tenant.tenant_name}"`);
      await Promise.all([loadMe(), loadTenants()]);
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Could not add that tenant.');
    } finally {
      setSaving(false);
    }
  };

  const getGuide = async () => {
    setDownloading(true);
    try {
      await downloadSetupGuide();
      toast.success('Setup guide downloaded');
    } catch {
      toast.error('Could not download the guide.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-slate-950 px-4 py-5 sm:px-6">
      {/* Ambient background — purely decorative */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -left-40 h-[32rem] w-[32rem] rounded-full opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #3b82f6 0%, transparent 65%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-52 -right-32 h-[34rem] w-[34rem] rounded-full opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #8b5cf6 0%, transparent 65%)' }}
      />

      <header className="relative flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600">
            <svg viewBox="0 0 96 96" className="h-4 w-4 fill-[#fff]">
              <path d="M33.4 6.4L10 73.8h19.3l13.6-36.1 14.1 25.2-10.2 10.9H66l17.8 17.7H96L57.3 6.4H33.4z" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight text-white">Cloudledger</span>
        </div>

        <div className="flex items-center gap-3">
          {me?.email && (
            <span className="hidden text-xs text-slate-500 sm:inline">{me.email}</span>
          )}
          <button
            onClick={logout}
            className="inline-flex items-center gap-1.5 text-xs text-slate-400 transition hover:text-white"
          >
            Sign out <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* One column, one task. The previous two-column layout put a page of
          explanation beside the four boxes that are the actual job, so the
          explanation read as the job. */}
      <main className="relative mx-auto w-full max-w-[27rem] flex-1 py-10 sm:py-14">
        <div className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-400">
            <ShieldCheck className="h-3 w-3" />
            Read-only
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">
            Connect your Azure tenant
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Four values from your app registration. About five minutes.
          </p>
        </div>

        <form
          onSubmit={submit}
          noValidate
          className="mt-6 space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl"
        >
          <Field
            label="Name this connection"
            icon={Building2}
            value={form.tenant_name}
            onChange={(v) => set('tenant_name', v)}
            placeholder="Production"
            error={touched ? errors.tenant_name : ''}
          />
          <Field
            label="Directory (tenant) ID"
            icon={Fingerprint}
            value={form.tenant_id}
            onChange={(v) => set('tenant_id', clean(v))}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            hint={
              me?.tenant_id && form.tenant_id === me.tenant_id
                ? 'The directory you signed in from.'
                : undefined
            }
            error={touched ? errors.tenant_id : ''}
          />
          <Field
            label="Application (client) ID"
            icon={KeyRound}
            value={form.client_id}
            onChange={(v) => set('client_id', clean(v))}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            error={touched ? errors.client_id : ''}
          />
          <Field
            label="Client secret"
            icon={Lock}
            // Hidden by default, but a secret is pasted rather than typed and a
            // row of dots cannot be checked against the clipboard. Whoever is
            // at this screen is alone with their own credential.
            type={showSecret ? 'text' : 'password'}
            value={form.client_secret}
            onChange={(v) => set('client_secret', v)}
            placeholder="Paste the secret Value"
            hint="The Value, not the Secret ID."
            error={touched ? errors.client_secret : ''}
            action={
              <button
                type="button"
                onClick={() => setShowSecret(v => !v)}
                className="inline-flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-300"
              >
                {showSecret
                  ? <><EyeOff className="h-3.5 w-3.5" />Hide</>
                  : <><Eye className="h-3.5 w-3.5" />Show</>}
              </button>
            }
          />

          <button
            type="submit"
            disabled={saving}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-[#fff] transition hover:bg-blue-500 disabled:opacity-50"
          >
            {saving
              ? <><Loader2 className="h-4 w-4 animate-spin" />Checking with Azure…</>
              : <><Plus className="h-4 w-4" />Connect tenant</>}
          </button>

          <div className="flex flex-wrap justify-center gap-x-3.5 gap-y-1">
            {['Cannot change anything', 'Revoke any time'].map(t => (
              <span key={t} className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                <Check className="h-3 w-3" />{t}
              </span>
            ))}
          </div>
        </form>

        {/* Everything that is not the form. Both answer a question asked once,
            and both were previously on screen for everybody, every time. */}
        <div className="mt-4 space-y-2">
          <Disclosure
            icon={<ListOrdered className="h-4 w-4 shrink-0 text-slate-500" />}
            label="Where do I find these?"
            id="onboarding-steps"
            open={panel === 'steps'}
            onToggle={() => setPanel(p => (p === 'steps' ? '' : 'steps'))}
          >
            <ol className="space-y-2.5">
              {STEPS.map(([title, body], i) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-800 text-[11px] font-semibold text-slate-400">
                    {i + 1}
                  </span>
                  <p className="min-w-0 text-sm text-slate-300">
                    {title}
                    <span className="block text-xs text-slate-500">{body}</span>
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-800 pt-3">
              <a
                href={PORTAL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
              >
                Open Azure portal <ExternalLink className="h-3 w-3" />
              </a>
              <button
                type="button"
                onClick={getGuide}
                disabled={downloading}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 transition hover:text-white disabled:opacity-60"
              >
                {downloading
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Download className="h-3 w-3" />}
                Setup guide (PDF)
              </button>
            </div>
          </Disclosure>

          <Disclosure
            icon={<ShieldCheck className="h-4 w-4 shrink-0 text-blue-400" />}
            label="What access this needs"
            id="onboarding-permissions"
            open={panel === 'permissions'}
            onToggle={() => setPanel(p => (p === 'permissions' ? '' : 'permissions'))}
          >
            <PermissionsPanel compact />
          </Disclosure>
        </div>

        {/* Someone whose colleague already connected the tenant does not need
            any of this, and would otherwise register a second application for
            an estate that is already being read. They arrive here only because
            the invitation had not been issued when they first signed in, so
            the way out is to look again. */}
        <p className="mt-5 text-center text-xs text-slate-500">
          Joining a colleague&rsquo;s workspace?{' '}
          <button
            type="button"
            onClick={() => loadMe()}
            className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
          >
            Check for an invitation
          </button>
        </p>
      </main>
    </div>
  );
}
