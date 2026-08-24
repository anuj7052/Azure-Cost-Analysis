import { useState } from 'react';
import { X, KeyRound } from 'lucide-react';
import { addSessionToken } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import toast from 'react-hot-toast';

const CLI_COMMAND = 'az account get-access-token --resource https://management.azure.com';

export default function AddSessionTokenModal({ onClose }) {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const addTenantToList = useAppStore(s => s.addTenantToList);
  const setSelectedTenant = useAppStore(s => s.setSelectedTenant);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const tenant = await addSessionToken({
        access_token: token,
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
      toast.error(err.response?.data?.detail || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl animate-scale-in">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-white">Sign in with a session token</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              No app registration needed — paste a token from a session you already have
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-slate-800 rounded-xl p-3 mb-4">
          <p className="text-xs text-slate-400 mb-2">
            Run this in Azure Cloud Shell or a local terminal, then paste the whole output below — or just the <code className="text-slate-300">accessToken</code> value:
          </p>
          <code className="block text-[11px] text-blue-300 bg-slate-950/60 rounded-lg px-3 py-2 break-all">
            {CLI_COMMAND}
          </code>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Access token</label>
            <textarea
              value={token}
              onChange={e => setToken(e.target.value)}
              rows={5}
              placeholder={'{ "accessToken": "eyJ0eXAiOiJKV1QiLCJhbGciOi..." }  — or just the token'}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition resize-none"
            />
            <p className="text-[11px] text-slate-600 mt-1">
              The tenant, account and expiry are read from the token itself.
            </p>
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

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 transition text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !token.trim()}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] font-semibold flex items-center justify-center gap-2 text-sm transition"
            >
              <KeyRound className="w-4 h-4" />
              {saving ? 'Verifying…' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
