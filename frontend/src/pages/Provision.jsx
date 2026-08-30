import { useEffect, useMemo, useState } from 'react';
import {
  Boxes, Plus, Trash2, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Server, HardDrive, Network, Globe, RefreshCw,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  fetchProvisionCatalog, startProvisionDeploy,
  fetchProvisionDeployments, fetchProvisionDeployment,
} from '../api/client';
import { friendlyError } from '../utils/apiError';

/**
 * Building things in Azure, from a form rather than a conversation.
 *
 * The chat assistant on the Deployment Assistant page could already do this,
 * and for someone who knows what they want to say it is faster. It is a poor
 * fit for the opposite case: a person who does not yet know what a resource
 * needs cannot ask for it, and a chat window does not show them the shape of
 * the answer. This page renders the same catalogue the assistant is given, as
 * fields, so the required decisions are visible before anything is typed.
 *
 * Both paths end at the same endpoint and the same server-side validation.
 * Nothing here is trusted: the backend re-drafts every resource from the
 * catalogue before it builds a template, so a field added by hand in the
 * browser cannot introduce a property the catalogue does not define.
 */

// One icon per kind, matched on the catalogue key. An unknown kind still
// renders -- the catalogue is the server's to extend, and a page that hid
// resources it had no icon for would silently lose them.
const ICONS = {
  linux_vm: Server,
  storage_account: HardDrive,
  virtual_network: Network,
  web_app: Globe,
};

const STATE_STYLE = {
  SUCCEEDED: { icon: CheckCircle2, tone: 'text-emerald-400', chip: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  FAILED: { icon: XCircle, tone: 'text-red-400', chip: 'bg-red-500/10 text-red-300 border-red-500/30' },
  CREATING: { icon: Loader2, tone: 'text-blue-400', chip: 'bg-blue-500/10 text-blue-300 border-blue-500/30', spin: true },
  VALIDATING: { icon: Loader2, tone: 'text-slate-400', chip: 'bg-slate-500/10 text-slate-300 border-slate-500/30', spin: true },
};

function money(value, currency) {
  if (value === null || value === undefined) return 'Not available';
  if (value === 0) return 'No charge';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency || ''} ${Math.round(value).toLocaleString()}`;
  }
}

/** One catalogue field, rendered as the control its definition implies. */
function Field({ field, value, onChange }) {
  const id = `field-${field.name}`;
  const common =
    'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm ' +
    'text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500';

  return (
    <label htmlFor={id} className="block">
      <span className="text-xs font-medium text-slate-300">
        {field.label}
        {field.required && <span className="text-red-400 ml-1">*</span>}
      </span>

      {field.options?.length ? (
        <select
          id={id}
          className={`${common} mt-1`}
          value={value ?? field.suggested_default ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          id={id}
          className={`${common} mt-1`}
          value={value ?? ''}
          placeholder={
            field.suggested_default === null || field.suggested_default === undefined
              ? ''
              : String(field.suggested_default)
          }
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.help && <span className="block text-[11px] text-slate-500 mt-1">{field.help}</span>}
    </label>
  );
}

/** The form for one resource kind, plus the button that adds it to the plan. */
function KindForm({ kind, onAdd }) {
  const [values, setValues] = useState({});
  const Icon = ICONS[kind.kind] || Boxes;

  const missing = kind.fields
    .filter(f => f.required)
    .filter(f => !String(values[f.name] ?? f.suggested_default ?? '').trim())
    .map(f => f.label);

  const add = () => {
    // Blank entries are dropped rather than sent as empty strings: the server
    // treats a missing field as "use the suggestion" and an empty one as a
    // deliberate empty value, and those are different requests.
    const fields = {};
    for (const [key, value] of Object.entries(values)) {
      if (String(value ?? '').trim() !== '') fields[key] = value;
    }
    onAdd({ kind: kind.kind, fields });
    setValues({});
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-slate-800 grid place-items-center shrink-0">
          <Icon className="w-4 h-4 text-slate-300" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-100">{kind.label}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{kind.summary}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        {kind.fields.map(f => (
          <Field
            key={f.name}
            field={f}
            value={values[f.name]}
            onChange={(v) => setValues(s => ({ ...s, [f.name]: v }))}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 mt-4">
        <p className="text-[11px] text-slate-500">
          {missing.length
            ? `Still needed: ${missing.join(', ')}`
            : 'Ready to add. Nothing is created until you deploy.'}
        </p>
        <button
          type="button"
          onClick={add}
          disabled={missing.length > 0}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800
                     hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed
                     text-slate-100 text-sm font-medium transition"
        >
          <Plus className="w-4 h-4" /> Add to plan
        </button>
      </div>
    </div>
  );
}

function DeploymentRow({ deployment }) {
  const style = STATE_STYLE[deployment.state] || STATE_STYLE.VALIDATING;
  const Icon = style.icon;
  return (
    <div className="flex items-start gap-3 py-3 border-b border-slate-800 last:border-0">
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${style.tone} ${style.spin ? 'animate-spin' : ''}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-slate-200 font-medium">{deployment.resource_group}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${style.chip}`}>
            {deployment.state_label || deployment.state}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-0.5">
          {(deployment.resources || []).map(r => r.name).join(', ') || 'No resources recorded'}
          {' · '}{deployment.location}
        </p>
        {deployment.message && (
          <p className="text-xs text-slate-400 mt-1">{deployment.message}</p>
        )}
      </div>
      <span className="text-xs text-slate-500 shrink-0 tabular-nums">
        {money(deployment.estimated_monthly, deployment.currency)}
      </span>
    </div>
  );
}

export default function Provision() {
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const subscriptions = useAppStore(s => s.subscriptions);

  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState('');
  const [plan, setPlan] = useState([]);
  const [subscriptionId, setSubscriptionId] = useState('');
  const [resourceGroup, setResourceGroup] = useState('');
  const [location, setLocation] = useState('centralindia');
  const [sshKey, setSshKey] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    fetchProvisionCatalog()
      .then(data => setCatalog(data.resources || []))
      .catch(err => setCatalogError(friendlyError(err)));
    fetchProvisionDeployments()
      .then(setHistory)
      .catch(() => { /* history is context, not the point of the page */ });
  }, []);

  useEffect(() => {
    if (!subscriptionId && selectedSubscriptionIds.length > 0) {
      setSubscriptionId(selectedSubscriptionIds[0]);
    }
  }, [selectedSubscriptionIds, subscriptionId]);

  const needsSshKey = useMemo(() => plan.some(r => r.kind === 'linux_vm'), [plan]);

  const blockers = useMemo(() => {
    const list = [];
    if (!selectedTenantId) list.push('Choose a tenant.');
    if (!subscriptionId) list.push('Choose a subscription.');
    if (!resourceGroup.trim()) list.push('Name the resource group.');
    if (!location.trim()) list.push('Choose a region.');
    if (!plan.length) list.push('Add at least one resource.');
    if (needsSshKey && !sshKey.trim()) {
      list.push('A Linux VM needs an SSH public key — it is the only way in once it is built.');
    }
    return list;
  }, [selectedTenantId, subscriptionId, resourceGroup, location, plan, needsSshKey, sshKey]);

  /**
   * Poll until Azure reaches a state that will not change again.
   *
   * The deployment runs on the server after the request returns, so the only
   * honest way to report progress is to ask. Stops on a terminal state or when
   * the answer stops being readable, rather than polling forever.
   */
  const poll = async (id) => {
    for (let i = 0; i < 180; i += 1) {
      await new Promise(r => setTimeout(r, 10000));
      try {
        const latest = await fetchProvisionDeployment(id);
        setCurrent(latest);
        if (latest.state === 'SUCCEEDED' || latest.state === 'FAILED') {
          fetchProvisionDeployments().then(setHistory).catch(() => {});
          return;
        }
      } catch {
        return;
      }
    }
  };

  const deploy = async () => {
    setError('');
    const estimate = current?.estimated_monthly;
    const confirmed = window.confirm(
      `This will create ${plan.length} resource${plan.length === 1 ? '' : 's'} in ` +
      `${resourceGroup} (${location}). These are real Azure resources and they ` +
      `will be billed to this subscription.` +
      (estimate ? `\n\nEstimated: ${money(estimate)} per month.` : '')
    );
    if (!confirmed) return;

    setDeploying(true);
    try {
      const started = await startProvisionDeploy({
        tenant_id: selectedTenantId,
        subscription_id: subscriptionId,
        resource_group: resourceGroup.trim(),
        location: location.trim(),
        resources: plan,
        ssh_public_key: sshKey.trim(),
        confirm: true,
      });
      setCurrent(started);
      setPlan([]);
      poll(started.id);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setDeploying(false);
    }
  };

  const subOptions = subscriptions.filter(s => selectedSubscriptionIds.includes(s.subscription_id));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-100 flex items-center gap-2">
          <Boxes className="w-5 h-5 text-blue-400" /> Build
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Create resources in Azure from the catalogue below. Everything is
          created in one deployment, in one resource group, and the resource
          group is created if it does not exist.
        </p>
      </header>

      {catalogError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 text-sm text-red-300">
          The catalogue could not be loaded, so nothing can be built right now. {catalogError}
        </div>
      )}

      {/* Where it goes. Asked once, above the catalogue, because every
          resource in one deployment shares these. */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-100">Where</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-300">Subscription</span>
            <select
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2
                         text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
            >
              <option value="">Select…</option>
              {subOptions.map(s => (
                <option key={s.subscription_id} value={s.subscription_id}>
                  {s.display_name || s.subscription_id}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-300">Resource group</span>
            <input
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2
                         text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500"
              value={resourceGroup}
              placeholder="rg-my-app"
              onChange={(e) => setResourceGroup(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-300">Region</span>
            <input
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2
                         text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500"
              value={location}
              placeholder="centralindia"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
        </div>

        {needsSshKey && (
          <label className="block mt-3">
            <span className="text-xs font-medium text-slate-300">SSH public key</span>
            <textarea
              rows={2}
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2
                         text-xs font-mono text-slate-100 placeholder-slate-600
                         focus:outline-none focus:border-blue-500"
              value={sshKey}
              placeholder="ssh-ed25519 AAAA…"
              onChange={(e) => setSshKey(e.target.value)}
            />
            <span className="block text-[11px] text-slate-500 mt-1">
              This is a public key, not a secret. Password sign-in is disabled on
              every machine built here, so without this key the VM cannot be reached.
            </span>
          </label>
        )}
      </section>

      {/* The catalogue. */}
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {catalog.map(kind => (
          <KindForm key={kind.kind} kind={kind} onAdd={(r) => setPlan(p => [...p, r])} />
        ))}
      </section>

      {/* The plan. */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-100">
          Plan {plan.length > 0 && <span className="text-slate-500 font-normal">({plan.length})</span>}
        </h2>

        {!plan.length ? (
          <p className="text-sm text-slate-500 mt-2">
            Nothing added yet. Adding a resource here does not create it —
            only Deploy does.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-800">
            {plan.map((r, i) => {
              const Icon = ICONS[r.kind] || Boxes;
              const kind = catalog.find(k => k.kind === r.kind);
              return (
                <li key={`${r.kind}-${i}`} className="flex items-center gap-3 py-2.5">
                  <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-200">{r.fields.name || kind?.label}</p>
                    <p className="text-xs text-slate-500 truncate">
                      {kind?.label}
                      {Object.entries(r.fields)
                        .filter(([k]) => k !== 'name')
                        .map(([k, v]) => ` · ${k}: ${v}`)
                        .join('')}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${r.fields.name || r.kind} from the plan`}
                    onClick={() => setPlan(p => p.filter((_, j) => j !== i))}
                    className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-red-400 transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {blockers.length > 0 && plan.length > 0 && (
          <div className="mt-4 flex items-start gap-2 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>{blockers.join(' ')}</span>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={deploy}
          disabled={blockers.length > 0 || deploying}
          className="mt-4 w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5
                     rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40
                     disabled:cursor-not-allowed text-white text-sm font-medium transition"
        >
          {deploying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {deploying ? 'Starting…' : 'Deploy to Azure'}
        </button>
        <p className="text-[11px] text-slate-500 mt-2">
          These are real resources and they are billed from the moment they exist.
          This page cannot delete them again — use the Azure portal for that.
        </p>
      </section>

      {/* What is happening now, and what happened before. */}
      {current && (
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-slate-100">Current deployment</h2>
          <div className="mt-2">
            <DeploymentRow deployment={current} />
          </div>
          {(current.state === 'VALIDATING' || current.state === 'CREATING') && (
            <p className="text-xs text-slate-500 mt-2">
              Checked every 10 seconds. Leaving this page does not stop the
              deployment — it is running on Azure.
            </p>
          )}
        </section>
      )}

      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Recent deployments</h2>
          <button
            type="button"
            aria-label="Refresh deployments"
            onClick={() => fetchProvisionDeployments().then(setHistory).catch(() => {})}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 transition"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        {!history.length ? (
          <p className="text-sm text-slate-500 mt-2">Nothing has been deployed from here yet.</p>
        ) : (
          <div className="mt-1">
            {history.map(d => <DeploymentRow key={d.id} deployment={d} />)}
          </div>
        )}
      </section>
    </div>
  );
}
