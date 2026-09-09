import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  Plus, Download, ShieldCheck, KeyRound, Loader2, Check, ChevronDown,
  Building2, Fingerprint, Lock, ExternalLink, LogOut, Eye, EyeOff,
} from 'lucide-react';
import { addTenant, downloadSetupGuide } from '../api/client';
import { useLogin } from '../auth/hooks';
import { useAppStore } from '../store/useAppStore';
import PermissionsPanel from '../components/Common/PermissionsPanel';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Four sentences, not four paragraphs. Whoever is reading this is looking for
// the next click, and every extra line is one more thing between them and it.
const STEPS = [
  {
    title: 'Register an app',
    body: 'Entra ID → App registrations → New registration.',
    link: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    linkLabel: 'Open',
  },
  {
    title: 'Add a client secret',
    body: 'Certificates & secrets → New client secret. Copy the Value, not the Secret ID.',
  },
  {
    title: 'Give it two roles',
    body: 'On each subscription: Reader and Cost Management Reader. Both read-only.',
  },
  {
    title: 'Paste the details',
    body: 'Checked against Azure on submit, so a wrong value tells you straight away.',
  },
];

/**
 * A GUID copied out of the portal often arrives wrapped in whitespace or the
 * quotes of whatever it was pasted through. Rejecting that as "not a valid
 * GUID" is technically true and completely useless, so it is cleaned instead.
 */
const clean = (v) => v.trim().replace(/^["'<]+|[">']+$/g, '');

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
          className={`w-full bg-slate-800 border rounded-xl ${Icon ? 'pl-9' : 'pl-3'} pr-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition ${
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
  // The permission list answers a question people ask once. On screen by
  // default it is thirteen entries of prose standing in front of a four-box
  // form, which is the actual task.
  const [showPermissions, setShowPermissions] = useState(false);

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
    <div className="min-h-screen bg-slate-950 relative overflow-hidden">
      {/* Ambient background — purely decorative */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -left-40 w-[36rem] h-[36rem] rounded-full blur-3xl opacity-20"
        style={{ background: 'radial-gradient(circle, #3b82f6 0%, transparent 65%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-52 -right-32 w-[38rem] h-[38rem] rounded-full blur-3xl opacity-20"
        style={{ background: 'radial-gradient(circle, #8b5cf6 0%, transparent 65%)' }}
      />

      <div className="relative max-w-6xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 mb-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
              <svg viewBox="0 0 96 96" className="w-5 h-5 fill-[#fff]">
                <path d="M33.4 6.4L10 73.8h19.3l13.6-36.1 14.1 25.2-10.2 10.9H66l17.8 17.7H96L57.3 6.4H33.4z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">Cloudledger</p>
              <p className="text-xs text-slate-500">Enterprise cost intelligence</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {me?.email && (
              <span className="hidden sm:inline text-xs text-slate-500">
                Signed in as <span className="text-slate-300">{me.email}</span>
              </span>
            )}
            <button
              onClick={logout}
              className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1.5"
            >
              Sign out <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1fr_460px] gap-8 items-start">
          {/* ── Left: what this is and how to prepare ── */}
          <div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-400 text-xs font-medium mb-4">
              <ShieldCheck className="w-3.5 h-3.5" />
              Read-only unless you grant more
            </span>

            <h1 className="text-3xl sm:text-4xl font-semibold text-white leading-tight">
              Connect your Azure tenant
            </h1>
            <p className="text-slate-400 mt-3 text-[15px] leading-relaxed max-w-lg">
              Create a read-only identity in your own tenant and paste it here.
              About five minutes. You can revoke it whenever you like.
            </p>

            {/* Someone whose colleague already connected the tenant does not
                need any of this, and would otherwise register a second
                application for an estate that is already being read. They
                arrive here only because the invitation had not been issued when
                they first signed in, so the way out is to look again. */}
            <p className="text-slate-500 mt-3 text-sm">
              Joining a colleague&rsquo;s workspace?{' '}
              <button
                type="button"
                onClick={() => loadMe()}
                className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
              >
                Check for an invitation
              </button>
            </p>

            <ol className="mt-8 space-y-2.5">
              {STEPS.map((s, i) => (
                <li
                  key={s.title}
                  className="flex gap-3.5 bg-slate-900/70 border border-slate-800 rounded-2xl px-4 py-3.5 backdrop-blur"
                >
                  <span className="w-6 h-6 mt-0.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold flex items-center justify-center shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">
                      {s.title}
                      {s.link && (
                        <a
                          href={s.link}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-blue-400 hover:text-blue-300"
                        >
                          {s.linkLabel} <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </p>
                    <p className="text-sm text-slate-400 mt-0.5 leading-relaxed">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                onClick={getGuide}
                disabled={downloading}
                className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white transition disabled:opacity-60"
              >
                {downloading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Download className="w-4 h-4" />}
                Setup guide (PDF)
              </button>
              <span className="text-xs text-slate-600">
                Not the Azure admin? Send them this — it holds nothing about your account.
              </span>
            </div>

            {/* Thirteen permissions with a paragraph each is the right amount
                of detail for the person who wants it and a wall for everyone
                else. It stays one click away rather than in the way. */}
            <div className="mt-8">
              <button
                type="button"
                onClick={() => setShowPermissions(v => !v)}
                aria-expanded={showPermissions}
                aria-controls="onboarding-permissions"
                className="flex w-full items-center gap-2.5 rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-left transition hover:border-slate-700"
              >
                <ShieldCheck className="h-4 w-4 shrink-0 text-blue-400" />
                <span className="min-w-0 flex-1 text-sm text-slate-300">
                  What access this needs, role by role
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${showPermissions ? 'rotate-180' : ''}`}
                />
              </button>

              {showPermissions && (
                <div id="onboarding-permissions" className="mt-3">
                  <PermissionsPanel compact />
                </div>
              )}
            </div>
          </div>

          {/* ── Right: the form ── */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl lg:sticky lg:top-10">
            <h2 className="text-lg font-semibold text-white">Add your tenant</h2>
            <p className="text-sm text-slate-400 mt-1 mb-5">
              Paste the values from your app registration.
            </p>

            <form onSubmit={submit} className="space-y-4" noValidate>
              <Field
                label="Name this connection"
                icon={Building2}
                value={form.tenant_name}
                onChange={(v) => set('tenant_name', v)}
                placeholder="Production"
                hint="A label for you — anything you like."
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
                    ? 'The directory you signed in from. Change it to connect a different one.'
                    : 'On the app registration overview page.'
                }
                error={touched ? errors.tenant_id : ''}
              />
              <Field
                label="Application (client) ID"
                icon={KeyRound}
                value={form.client_id}
                onChange={(v) => set('client_id', clean(v))}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                hint="On the same page, just below the tenant ID."
                error={touched ? errors.client_id : ''}
              />
              <Field
                label="Client secret"
                icon={Lock}
                // Hidden by default, but a secret is pasted rather than typed
                // and a row of dots cannot be checked against the clipboard.
                // Whoever is at this screen is alone with their own credential.
                type={showSecret ? 'text' : 'password'}
                value={form.client_secret}
                onChange={(v) => set('client_secret', v)}
                placeholder="Paste the secret Value"
                hint="The Value column, not the Secret ID."
                error={touched ? errors.client_secret : ''}
                action={
                  <button
                    type="button"
                    onClick={() => setShowSecret(v => !v)}
                    className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300"
                  >
                    {showSecret
                      ? <><EyeOff className="w-3.5 h-3.5" />Hide</>
                      : <><Eye className="w-3.5 h-3.5" />Show</>}
                  </button>
                }
              />

              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] font-semibold flex items-center justify-center gap-2 text-sm transition"
              >
                {saving
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Checking with Azure…</>
                  : <><Plus className="w-4 h-4" />Connect tenant</>}
              </button>

              <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-1">
                {['Read-only', 'Cannot change anything', 'Revoke any time'].map(t => (
                  <span key={t} className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                    <Check className="w-3 h-3" />{t}
                  </span>
                ))}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
