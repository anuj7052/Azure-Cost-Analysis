import { useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Copy, KeyRound } from 'lucide-react';
import { addSessionToken } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { inspectToken, timeLeft } from '../../utils/accessToken';
import Modal from '../Common/Modal';
import toast from 'react-hot-toast';

const CLI_COMMAND = 'az account get-access-token --resource https://management.azure.com';

export default function AddSessionTokenModal({ onClose }) {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rejected, setRejected] = useState('');
  const addTenantToList = useAppStore(s => s.addTenantToList);
  const setSelectedTenant = useAppStore(s => s.setSelectedTenant);

  // Checked as it is typed rather than on submit. The four ways a paste goes
  // wrong are all readable from the text itself, so making somebody wait for a
  // round trip to be told they pasted a Graph token is a delay that buys
  // nothing. An empty box is not an error -- it is just not started yet.
  const verdict = useMemo(
    () => (token.trim() ? inspectToken(token) : null),
    [token],
  );
  const invalid = Boolean(verdict && !verdict.ok);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(CLI_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not reach the clipboard — select the command and copy it by hand.');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Belt and braces: the button is disabled while the token is invalid, but a
    // form can still be submitted with Enter.
    if (!verdict?.ok) {
      toast.error(verdict?.error || 'Paste a token to continue.');
      return;
    }
    setSaving(true);
    setRejected('');
    try {
      const tenant = await addSessionToken({
        access_token: verdict.token,
        ...(name.trim() ? { tenant_name: name.trim() } : {}),
      });
      addTenantToList(tenant);
      // Switch to it straight away — the point of pasting a token is to see
      // that tenant's data, not to add it to a list and then hunt for it.
      await setSelectedTenant(tenant.tenant_id);
      toast.success(
        `Connected "${tenant.tenant_name}"` +
        (tenant.subscription_count != null ? ` — ${tenant.subscription_count} subscription(s)` : '')
      );
      onClose();
    } catch (err) {
      // Azure can refuse a token that reads perfectly well — revoked, or with
      // no subscriptions it may see. That answer belongs next to the field it
      // is about, not in a toast that disappears before it can be acted on.
      const detail = err.response?.data?.detail || err.message;
      setRejected(typeof detail === 'string' ? detail : 'Azure refused that token.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Sign in with a session token"
      subtitle="No app registration needed — paste a token from a session you already have"
      icon={KeyRound}
      onClose={onClose}
      busy={saving}
      footer={
        // The two actions live in the footer so they stay on screen. Before,
        // they were the last thing in a tall form and were the first thing to
        // fall off the bottom of a laptop screen — leaving a dialog that could
        // be filled in but not submitted.
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 disabled:opacity-50 transition text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="session-token-form"
            disabled={saving || !verdict?.ok}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] font-semibold flex items-center justify-center gap-2 text-sm transition"
          >
            <KeyRound className="w-4 h-4" />
            {saving ? 'Verifying…' : 'Connect'}
          </button>
        </div>
      }
    >
      <div className="bg-slate-800 rounded-xl p-3 mb-4">
        <p className="text-xs text-slate-400 mb-2">
          Run this in Azure Cloud Shell or a local terminal, then paste the whole output below — or just the <code className="text-slate-300">accessToken</code> value:
        </p>
        <div className="flex items-stretch gap-2">
          <code className="flex-1 min-w-0 text-[11px] text-blue-300 bg-slate-950/60 rounded-lg px-3 py-2 break-all">
            {CLI_COMMAND}
          </code>
          <button
            type="button"
            onClick={copyCommand}
            title="Copy the command"
            aria-label="Copy the command"
            className={`shrink-0 flex items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition ${
              copied
                ? 'border-emerald-500/40 text-emerald-300'
                : 'border-slate-700 text-slate-300 hover:border-slate-600 hover:text-white'
            }`}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* The submit button sits in the footer, outside this element, so the
          form is addressed by id rather than by containment. */}
      <form id="session-token-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Access token</label>
          <textarea
            value={token}
            onChange={e => { setToken(e.target.value); setRejected(''); }}
            rows={5}
            aria-invalid={invalid}
            placeholder={'{ "accessToken": "eyJ0eXAiOiJKV1QiLCJhbGciOi..." }  — or just the token'}
            className={`w-full bg-slate-800 border rounded-xl px-3 py-2.5 text-xs font-mono text-white placeholder-slate-600 focus:outline-none transition resize-none ${
              invalid
                ? 'border-red-500/60 focus:border-red-500'
                : 'border-slate-700 focus:border-blue-500'
            }`}
          />

          {/* The verdict on what was pasted, said as soon as it can be said. */}
          {!verdict && (
            <p className="text-[11px] text-slate-600 mt-1">
              The tenant, account and expiry are read from the token itself.
            </p>
          )}

          {invalid && (
            <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-red-200">{verdict.error}</p>
                {verdict.hint && (
                  <p className="text-[11px] text-red-200/70 mt-0.5 leading-relaxed">{verdict.hint}</p>
                )}
              </div>
            </div>
          )}

          {verdict?.ok && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.07] p-2.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs text-emerald-200">
                  Valid management token{verdict.account ? ` for ${verdict.account}` : ''}.
                </p>
                <p className="text-[11px] text-emerald-200/70 mt-0.5 break-all">
                  Tenant {verdict.tenantId}
                  {verdict.expiresAt ? ` · expires in ${timeLeft(verdict.expiresAt)}` : ''}
                </p>
                {verdict.expiringSoon && (
                  <p className="text-[11px] text-amber-300/90 mt-1">
                    That is almost gone — it will likely expire mid-query. Worth generating a
                    fresh one before connecting.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Azure's own refusal. A token can read perfectly well here and
              still be revoked, or see no subscriptions at all. */}
          {rejected && (
            <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-200 leading-relaxed">
                <span className="font-medium">Azure refused it — </span>{rejected}
              </p>
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">
            Display name <span className="text-slate-600">(optional)</span>
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Client production tenant"
            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition"
          />
        </div>

        <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 leading-relaxed">
          A session token is a live credential and usually expires in about an hour.
          It is stored so queries keep working until then — after that, paste a fresh one.
          For a permanent connection, add a Service Principal instead.
        </p>
      </form>
    </Modal>
  );
}
