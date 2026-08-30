import { useState } from 'react';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { addTenant } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import Modal from '../Common/Modal';
import PermissionsPanel from '../Common/PermissionsPanel';
import toast from 'react-hot-toast';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AddTenantModal({ onClose }) {
  const [form, setForm] = useState({ tenant_id: '', tenant_name: '', client_id: '', client_secret: '' });
  const [saving, setSaving] = useState(false);
  const [showPerms, setShowPerms] = useState(false);
  const addTenantToList = useAppStore(s => s.addTenantToList);

  const onChange = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const tenant = await addTenant(form);
      addTenantToList(tenant);
      toast.success(`Tenant "${tenant.tenant_name}" added`);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add Service Principal Tenant"
      subtitle="A permanent connection that does not expire the way a session token does"
      icon={Plus}
      onClose={onClose}
      busy={saving}
      size="md"
      footer={
        <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={saving} className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 disabled:opacity-50 transition text-sm">
            Cancel
          </button>
          <button
            type="submit"
            form="add-tenant-form"
            disabled={saving || !form.tenant_id || !form.client_id || !form.client_secret || !form.tenant_name}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] font-semibold flex items-center justify-center gap-2 text-sm transition"
          >
            <Plus className="w-4 h-4" />
            {saving ? 'Saving…' : 'Add Tenant'}
          </button>
        </div>
      }
    >
      {/* Four fields plus a note comfortably outgrow a short window; the shell
          scrolls this while the buttons below stay put. */}
      <form id="add-tenant-form" onSubmit={handleSubmit} className="space-y-4">
        <Field label="Tenant Name" value={form.tenant_name} onChange={v => onChange('tenant_name', v)} placeholder="My Production Tenant" />
        <Field label="Tenant ID (GUID)" value={form.tenant_id} onChange={v => onChange('tenant_id', v)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        <Field label="Client ID (App / Service Principal)" value={form.client_id} onChange={v => onChange('client_id', v)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        <Field label="Client Secret" value={form.client_secret} onChange={v => onChange('client_secret', v)} type="password" placeholder="Enter client secret" />

        <div className="rounded-lg bg-slate-800 p-3">
          <p className="text-xs leading-relaxed text-slate-500">
            At minimum the service principal needs{' '}
            <span className="font-medium text-slate-300">Reader</span> and{' '}
            <span className="font-medium text-slate-300">Cost Management Reader</span>{' '}
            on the target subscriptions. Several pages need more than that, and
            the ones that change anything in Azure need more still.
          </p>
          <button
            type="button"
            onClick={() => setShowPerms(v => !v)}
            className="mt-2 inline-flex items-center gap-1 text-xs text-blue-400 transition hover:text-blue-300"
          >
            {showPerms
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
            {showPerms ? 'Hide the full list' : 'See the full list, and what each one unlocks'}
          </button>
        </div>

        {showPerms && (
          <PermissionsPanel
            compact
            tenantId={GUID.test(form.tenant_id.trim()) ? form.tenant_id.trim() : undefined}
          />
        )}
      </form>
    </Modal>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition"
      />
    </div>
  );
}
