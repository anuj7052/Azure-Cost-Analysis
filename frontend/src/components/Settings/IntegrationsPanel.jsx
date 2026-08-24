import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Plug, Plus, Trash2, X, Loader2, Pencil, KeyRound, Link2, Cpu, Power,
} from 'lucide-react';
import {
  createIntegration, deleteIntegration, fetchIntegrations, updateIntegration,
} from '../../api/client';

const KINDS = [
  {
    key: 'openai',
    label: 'OpenAI',
    hint: 'Your own OpenAI key. Leave the URL blank for api.openai.com.',
    urlPlaceholder: 'https://api.openai.com/v1',
    modelPlaceholder: 'gpt-4o',
  },
  {
    key: 'azure_openai',
    label: 'Azure OpenAI',
    hint: 'Your Azure OpenAI resource. The model is the deployment name.',
    urlPlaceholder: 'https://my-resource.openai.azure.com/openai/v1',
    modelPlaceholder: 'my-gpt4o-deployment',
  },
  {
    key: 'custom',
    label: 'Custom / gateway',
    hint: 'Any OpenAI-compatible endpoint, such as a proxy or a self-hosted model.',
    urlPlaceholder: 'https://llm.mycompany.com/v1',
    modelPlaceholder: 'llama-3.1-70b',
  },
  {
    key: 'webhook',
    label: 'Webhook',
    hint: 'An endpoint of your own. Stored for your use; the assistant does not call it.',
    urlPlaceholder: 'https://hooks.mycompany.com/azure-costs',
    modelPlaceholder: '',
  },
];

const kindOf = (key) => KINDS.find(k => k.key === key) || KINDS[0];

const EMPTY = { label: '', kind: 'openai', base_url: '', model: '', api_key: '' };

function Field({ label, icon: Icon, hint, ...props }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      <div className="relative">
        {Icon && <Icon className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />}
        <input
          spellCheck={false}
          autoComplete="off"
          className={`w-full bg-slate-800 border border-slate-700 focus:border-blue-500 rounded-xl ${Icon ? 'pl-9' : 'pl-3'} pr-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition`}
          {...props}
        />
      </div>
      {hint && <p className="text-xs text-slate-500 mt-1.5">{hint}</p>}
    </div>
  );
}

function IntegrationModal({ existing, onClose, onSaved }) {
  const editing = Boolean(existing);
  const [form, setForm] = useState(
    existing
      ? { ...EMPTY, ...existing, api_key: '' }
      : EMPTY,
  );
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const kind = kindOf(form.kind);

  // A new integration is useless without a key; an edit may legitimately leave
  // the stored one alone.
  const valid = form.label.trim() && (editing || form.kind === 'webhook' || form.api_key);

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      const body = {
        label: form.label.trim(),
        kind: form.kind,
        base_url: form.base_url.trim(),
        model: form.model.trim(),
      };
      // Sending an empty key on an edit would be read as "no change", which is
      // exactly what we want, so only include it when the user typed one.
      if (form.api_key) body.api_key = form.api_key;

      const saved = editing
        ? await updateIntegration(existing.id, body)
        : await createIntegration(body);
      toast.success(editing ? 'Integration updated' : `Added "${saved.label}"`);
      onSaved(saved);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in">
      <form
        onSubmit={submit}
        className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto animate-scale-in"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-white">
              {editing ? 'Edit integration' : 'Configure an endpoint'}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Connect your own API, model or webhook. It is stored against your
              account only.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Type</label>
          <div className="grid grid-cols-2 gap-2">
            {KINDS.map(k => (
              <button
                key={k.key}
                type="button"
                onClick={() => set('kind', k.key)}
                className={`px-3 py-2 rounded-xl text-xs font-medium border text-left transition ${
                  form.kind === k.key
                    ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-2">{kind.hint}</p>
        </div>

        <Field
          label="Name"
          icon={Plug}
          value={form.label}
          onChange={(e) => set('label', e.target.value)}
          placeholder="My OpenAI account"
          hint="A label for you — anything you like."
        />

        <Field
          label="Endpoint URL"
          icon={Link2}
          value={form.base_url}
          onChange={(e) => set('base_url', e.target.value)}
          placeholder={kind.urlPlaceholder}
          hint="Must be https. Leave blank to use the provider default."
        />

        {form.kind !== 'webhook' && (
          <Field
            label="Model / deployment"
            icon={Cpu}
            value={form.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder={kind.modelPlaceholder}
            hint="Leave blank to use the platform default."
          />
        )}

        <Field
          label={editing ? 'API key (leave blank to keep the current one)' : 'API key'}
          icon={KeyRound}
          type="password"
          value={form.api_key}
          onChange={(e) => set('api_key', e.target.value)}
          placeholder={editing ? '••••••••' : 'Paste your key'}
          hint="Stored against your account and never shown again."
        />

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-300 text-sm hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || saving}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] text-sm font-semibold flex items-center justify-center gap-2 transition"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {editing ? 'Save changes' : 'Add integration'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function IntegrationsPanel() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | { existing }

  const reload = async () => {
    try {
      setItems(await fetchIntegrations());
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not load integrations.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const toggle = async (item) => {
    try {
      const saved = await updateIntegration(item.id, { enabled: !item.enabled });
      setItems(list => list.map(i => (i.id === saved.id ? saved : i)));
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not update that.');
    }
  };

  const remove = async (item) => {
    try {
      await deleteIntegration(item.id);
      setItems(list => list.filter(i => i.id !== item.id));
      toast.success(`Removed "${item.label}"`);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not remove that.');
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Integrations</h2>
          <p className="text-xs text-slate-500 mt-1">
            Bring your own API, model or webhook. The assistant uses the newest
            enabled endpoint, so it runs on your key and your quota.
          </p>
        </div>
        <button
          onClick={() => setModal({ existing: null })}
          title="Configure an API, model or webhook"
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-[#fff] text-sm font-medium transition"
        >
          <Plus className="w-4 h-4" />
          Configure
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => <div key={i} className="h-14 bg-slate-800 rounded-xl animate-pulse" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl">
          <Plug className="w-6 h-6 text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-400">Nothing connected yet</p>
          <p className="text-xs text-slate-600 mt-1">
            Press Configure to add your own OpenAI, Azure OpenAI or custom endpoint.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <div
              key={item.id}
              className="flex items-center gap-3 bg-slate-800/50 border border-slate-800 rounded-xl px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-white truncate">{item.label}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">
                    {kindOf(item.kind).label}
                  </span>
                  {!item.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                      Disabled
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  {[item.base_url || 'provider default', item.model, item.key_hint]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <button
                onClick={() => toggle(item)}
                title={item.enabled ? 'Disable' : 'Enable'}
                className={`p-2 rounded-lg transition ${item.enabled ? 'text-emerald-400 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-800'}`}
              >
                <Power className="w-4 h-4" />
              </button>
              <button
                onClick={() => setModal({ existing: item })}
                title="Edit"
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={() => remove(item)}
                title="Remove"
                className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <IntegrationModal
          existing={modal.existing}
          onClose={() => setModal(null)}
          onSaved={(saved) =>
            setItems(list =>
              list.some(i => i.id === saved.id)
                ? list.map(i => (i.id === saved.id ? saved : i))
                : [saved, ...list],
            )
          }
        />
      )}
    </div>
  );
}
