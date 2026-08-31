import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  Plus, Download, ShieldCheck, KeyRound, Loader2, Check,
  Building2, Fingerprint, Lock, ExternalLink, LogOut,
} from 'lucide-react';
import { addTenant, downloadSetupGuide } from '../api/client';
import { useLogin } from '../auth/hooks';
import { useAppStore } from '../store/useAppStore';
import PermissionsPanel from '../components/Common/PermissionsPanel';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STEPS = [
  {
    title: 'Register an application',
    body: 'In the Azure portal, open Microsoft Entra ID → App registrations → New registration.',
  },
  {
    title: 'Create a client secret',
    body: 'Under Certificates & secrets, add a secret and copy its Value — not the Secret ID. It is shown only once.',
  },
  {
    title: 'Assign the roles you are comfortable with',
    body: 'On each subscription, assign at least Reader and Cost Management Reader. The full list, and what each one unlocks, is below.',
  },
  {
    title: 'Paste the details here',
    body: 'Your credentials are verified against Azure the moment you submit, so mistakes surface immediately.',
  },
];

function Field({ label, icon: Icon, value, onChange, type = 'text', placeholder, hint, error }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
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

  const [form, setForm] = useState({
    tenant_name: '', tenant_id: '', client_id: '', client_secret: '',
  });
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [touched, setTouched] = useState(false);

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
              Connect your first Azure tenant
            </h1>
            <p className="text-slate-400 mt-3 text-[15px] leading-relaxed max-w-xl">
              To read your costs, this app needs a service principal — an identity in your own
              Azure tenant that you create, control and can revoke at any time. It takes about
              five minutes.
            </p>

            {/* Someone whose colleague already connected the tenant does not
                need any of the above, and would otherwise register a second
                application for an estate that is already being read. They
                arrive here only because the invitation had not been issued when
                they first signed in, so the way out is to look again. */}
            <p className="text-slate-500 mt-3 text-sm leading-relaxed max-w-xl">
              Already part of a team here?{' '}
              <button
                type="button"
                onClick={() => loadMe()}
                className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
              >
                Check for your invitation
              </button>{' '}
              instead — if someone has added you to their workspace, you do not need to
              register anything.
            </p>

            <div className="mt-8 space-y-3">
              {STEPS.map((s, i) => (
                <div
                  key={s.title}
                  className="flex gap-4 bg-slate-900/70 border border-slate-800 rounded-2xl p-4 backdrop-blur"
                >
                  <div className="w-7 h-7 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold flex items-center justify-center shrink-0">
                    {i + 1}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{s.title}</p>
                    <p className="text-sm text-slate-400 mt-0.5 leading-relaxed">{s.body}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={getGuide}
                disabled={downloading}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm font-medium text-white transition disabled:opacity-60"
              >
                {downloading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Download className="w-4 h-4" />}
                Download the setup guide (PDF)
              </button>
              <a
                href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
              >
                Open Azure portal <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>

            <p className="text-xs text-slate-500 mt-4 max-w-xl leading-relaxed">
              Not the person who administers Azure? Send them the PDF — it contains everything
              they need and nothing specific to your account.
            </p>

            <div className="mt-10">
              <PermissionsPanel />
            </div>
          </div>

          {/* ── Right: the form ── */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white">Add Service Principal Tenant</h2>
            <p className="text-sm text-slate-400 mt-1 mb-5">
              Paste the four values from your app registration.
            </p>

            <form onSubmit={submit} className="space-y-4" noValidate>
              <Field
                label="Tenant Name"
                icon={Building2}
                value={form.tenant_name}
                onChange={(v) => set('tenant_name', v)}
                placeholder="My Production Tenant"
                hint="A label for you — anything you like."
                error={touched ? errors.tenant_name : ''}
              />
              <Field
                label="Tenant ID (GUID)"
                icon={Fingerprint}
                value={form.tenant_id}
                onChange={(v) => set('tenant_id', v)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                hint="Directory (tenant) ID on the overview page."
                error={touched ? errors.tenant_id : ''}
              />
              <Field
                label="Client ID (App / Service Principal)"
                icon={KeyRound}
                value={form.client_id}
                onChange={(v) => set('client_id', v)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                hint="Application (client) ID, on the same page."
                error={touched ? errors.client_id : ''}
              />
              <Field
                label="Client Secret"
                icon={Lock}
                type="password"
                value={form.client_secret}
                onChange={(v) => set('client_secret', v)}
                placeholder="Enter client secret"
                hint="The secret Value, not the Secret ID."
                error={touched ? errors.client_secret : ''}
              />

              <div className="bg-slate-800/70 border border-slate-700/70 rounded-xl p-3">
                <p className="text-xs text-slate-400 leading-relaxed">
                  The service principal needs{' '}
                  <span className="text-slate-200 font-medium">Reader</span> and{' '}
                  <span className="text-slate-200 font-medium">Cost Management Reader</span>{' '}
                  roles on the target subscriptions.
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                  {['Cannot change anything', 'No access inside your resources', 'Revocable any time'].map(t => (
                    <span key={t} className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                      <Check className="w-3 h-3" />{t}
                    </span>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] font-semibold flex items-center justify-center gap-2 text-sm transition"
              >
                {saving
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Verifying with Azure…</>
                  : <><Plus className="w-4 h-4" />Add Tenant</>}
              </button>

              <p className="text-[11px] text-slate-600 text-center pt-1">
                A tenant connection is what this app reads your costs from, so it
                is required before the dashboard opens.
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
