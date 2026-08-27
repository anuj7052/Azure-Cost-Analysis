import { useState } from 'react';
import { Plus } from 'lucide-react';
import { addTenant } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import Modal from '../Common/Modal';
import toast from 'react-hot-toast';

export default function AddTenantModal({ onClose }) {
  const [form, setForm] = useState({ tenant_id: '', tenant_name: '', client_id: '', client_secret: '' });
  const [saving, setSaving] = useState(false);
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

        <p className="text-xs text-slate-500 bg-slate-800 rounded-lg p-3 leading-relaxed">
          The service principal needs <span className="text-slate-300 font-medium">Reader</span> and <span className="text-slate-300 font-medium">Cost Management Reader</span> roles on the target subscriptions.
        </p>
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
