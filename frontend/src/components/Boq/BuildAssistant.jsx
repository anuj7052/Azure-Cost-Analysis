import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Send, Sparkles, Loader2, AlertTriangle, CheckCircle2, KeyRound,
  Server, Plug, ExternalLink, Info,
} from 'lucide-react';

import {
  fetchIntegrations, fetchProvisionDeployment, sendProvisionChat,
  startProvisionDeploy,
} from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { errorMessage } from '../../utils/apiError';

/**
 * Build Azure resources by describing them, instead of clicking through the
 * portal.
 *
 * Three things about this panel are deliberate and worth keeping.
 *
 * The assistant drafts; it never creates. Every Create button below is bound
 * to a specification the server built and returned, not to text the model
 * wrote. A model that could both decide and act would turn a misread sentence
 * — including one hidden in a resource name — into a monthly bill.
 *
 * Nothing is created until a daily request limit exists on the endpoint. The
 * chat box stays closed until then, because the first thing someone should
 * decide about a key that bills them is how much of it may be spent.
 *
 * The SSH key is asked for here, not in the conversation. It is a public key
 * rather than a secret, but keeping credentials structurally out of the chat
 * transcript is a habit worth not breaking.
 */

const REGIONS = [
  'centralindia', 'southindia', 'westindia',
  'eastus', 'westeurope', 'uksouth', 'southeastasia',
];

// Two kinds of question, because the assistant now does two things: it reads
// the account you already have, and it builds new things in it.
const SUGGESTIONS = [
  'Which subscriptions can I see?',
  'What did my production subscription cost last month?',
  'What is running in that subscription?',
  'Create a small Linux VM for a test API',
  'I need a storage account for backups',
];

function errText(err) {
  // Through the shared reader: the backend wraps failures in { error: {...} },
  // and reading `detail` directly turned every one of them into the generic
  // line, hiding the provider's actual reason.
  return errorMessage(err);
}

function money(value, currency) {
  if (value == null) return 'Not available';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString()}`;
  }
}

/** One resource the assistant has fully specified, ready to be authorised. */
function DraftCard({ draft, onCreate, busy }) {
  const fields = Object.entries(draft.fields || {});
  const assumed = new Set((draft.assumed || []).map(a => a.name));

  return (
    <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white flex items-center gap-2">
            <Server className="w-4 h-4 text-blue-400 shrink-0" />
            {draft.label}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {money(draft.price?.monthly, draft.price?.currency)}
            <span className="text-slate-600"> / month</span>
            {draft.price?.basis ? ` · ${draft.price.basis}` : ''}
          </p>
        </div>
        <button
          onClick={() => onCreate(draft)}
          disabled={busy}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] text-sm font-semibold transition"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Create
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
        {fields.map(([key, value]) => (
          <div key={key} className="min-w-0">
            <dt className="text-[11px] text-slate-500 truncate">
              {key.replace(/_/g, ' ')}
              {/* Shown so the reader can tell their choices from ours. */}
              {assumed.has(key) && <span className="text-amber-500/80"> · suggested</span>}
            </dt>
            <dd className="text-xs text-slate-200 truncate">
              {String(value) || <span className="text-slate-600">none</span>}
            </dd>
          </div>
        ))}
      </dl>

      {draft.price?.note && (
        <p className="text-[11px] text-slate-500 mt-3 flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
          {draft.price.note}
        </p>
      )}
    </div>
  );
}

function DeploymentCard({ deployment }) {
  const failed = deployment.state === 'FAILED';
  const done = deployment.state === 'SUCCEEDED';
  const tone = failed
    ? 'border-red-500/30 bg-red-500/5'
    : done ? 'border-emerald-500/30 bg-emerald-500/5'
      : 'border-slate-700 bg-slate-800/40';

  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        {failed ? <AlertTriangle className="w-4 h-4 text-red-400" />
          : done ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            : <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
        {deployment.state_label}
      </p>
      <p className="text-xs text-slate-400 mt-1">
        {deployment.resource_group} · {deployment.location}
      </p>
      {deployment.message && (
        <p className="text-xs text-slate-300 mt-2 whitespace-pre-wrap">{deployment.message}</p>
      )}
      {deployment.resources?.length > 0 && (
        <ul className="mt-2 space-y-1">
          {deployment.resources.map(r => (
            <li key={r.id} className="text-xs text-slate-300 truncate">· {r.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function BuildAssistant() {
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const subscriptions = useAppStore(s => s.subscriptions);
  const me = useAppStore(s => s.me);

  const [integrations, setIntegrations] = useState(null);
  const [messages, setMessages] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState('');
  const [deployment, setDeployment] = useState(null);
  const [error, setError] = useState('');

  const [location, setLocation] = useState('centralindia');
  const [resourceGroup, setResourceGroup] = useState('rg-assistant');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [sshKey, setSshKey] = useState('');

  const endRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    fetchIntegrations().then(setIntegrations).catch(() => setIntegrations([]));
  }, []);

  useEffect(() => {
    if (!subscriptionId && selectedSubscriptionIds.length > 0) {
      setSubscriptionId(selectedSubscriptionIds[0]);
    }
  }, [selectedSubscriptionIds, subscriptionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, drafts]);

  // Stop polling when the panel goes away, so a closed tab does not leave a
  // timer running against a deployment nobody is watching.
  useEffect(() => () => clearInterval(pollRef.current), []);

  const isOwner = me?.can_administer !== false;
  const ready = integrations === null
    ? null
    : integrations.some(i => i.enabled && i.has_key && i.rate_limit_per_day > 0);
  const exhausted = (integrations || []).some(
    i => i.enabled && i.has_key && i.rate_limit_per_day > 0 && i.remaining_today === 0,
  );

  const send = async (text) => {
    const message = (text ?? input).trim();
    if (!message || sending) return;
    setInput('');
    setError('');
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    setMessages(m => [...m, { role: 'user', content: message }]);
    setSending(true);
    try {
      const result = await sendProvisionChat({
        message,
        history,
        location,
        currency: 'INR',
        // Lets the assistant read this directory to answer questions about
        // what is already there, rather than only describing what it can build.
        tenant_id: selectedTenantId || '',
        // The building conversation: catalogue, drafting and pricing on top of
        // the read-only tools. The read-only assistant lives on its own page.
        mode: 'build',
      });
      setMessages(m => [...m, { role: 'assistant', content: result.answer }]);
      setDrafts(result.drafts || []);
    } catch (err) {
      setError(errText(err));
      setMessages(m => m.slice(0, -1));
      setInput(message);
    } finally {
      setSending(false);
    }
  };

  const poll = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const latest = await fetchProvisionDeployment(id);
        setDeployment(latest);
        if (latest.state === 'SUCCEEDED' || latest.state === 'FAILED') {
          clearInterval(pollRef.current);
        }
      } catch {
        clearInterval(pollRef.current);
      }
    }, 10000);
  };

  const create = async (draft) => {
    if (!selectedTenantId) {
      toast.error('Select a tenant first.');
      return;
    }
    if (!subscriptionId) {
      toast.error('Select a subscription to build into.');
      return;
    }
    if (draft.kind === 'linux_vm' && !sshKey.trim()) {
      toast.error('Paste an SSH public key — it is the only way into the VM once it exists.');
      return;
    }
    if (!window.confirm(
      `Create ${draft.label} "${draft.fields.name}" in ${resourceGroup} (${location})?\n\n`
      + `This creates real resources in your Azure subscription and starts a `
      + `recurring charge of about ${money(draft.price?.monthly, draft.price?.currency)} per month.`,
    )) return;

    setCreating(draft.kind);
    setError('');
    try {
      const started = await startProvisionDeploy({
        tenant_id: selectedTenantId,
        subscription_id: subscriptionId,
        resource_group: resourceGroup.trim(),
        location,
        currency: draft.price?.currency || 'INR',
        resources: [{ kind: draft.kind, fields: draft.fields }],
        ssh_public_key: draft.kind === 'linux_vm' ? sshKey.trim() : '',
        confirm: true,
      });
      setDeployment(started);
      poll(started.id);
      toast.success('Azure accepted the deployment.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setCreating('');
    }
  };

  if (ready === null) {
    return <div className="h-40 bg-slate-900 border border-slate-800 rounded-2xl animate-pulse" />;
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-blue-400" />
          Build on Azure
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Ask about the subscriptions, spend and resources you already have, or
          describe something new and the assistant works out the specification.
          It reads, drafts and prices; you press Create. Azure decides whether
          your account is allowed to build it.
        </p>
      </div>

      {!ready && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm text-amber-200 font-medium flex items-center gap-2">
            <Plug className="w-4 h-4" />
            Add an endpoint before you start
          </p>
          <p className="text-xs text-slate-400 mt-1.5">
            The assistant runs on your own model endpoint and key. Add one under
            Settings → Integrations. The first thing it asks is how many
            requests a day it may use, because the endpoint bills you and a
            limit set afterwards is a limit set too late.
          </p>
          <a
            href="/settings"
            className="inline-flex items-center gap-1.5 mt-3 text-xs font-medium text-blue-400 hover:text-blue-300"
          >
            Go to Integrations <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}

      {ready && !isOwner && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
          <p className="text-xs text-slate-400">
            You have view access to this workspace. You can draft and price
            resources here, but only the workspace owner can create them.
          </p>
        </div>
      )}

      {ready && exhausted && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs text-amber-200">
            Your endpoint has used its daily request limit. It resets at
            midnight UTC, or you can raise it under Settings → Integrations.
          </p>
        </div>
      )}

      {ready && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-slate-400 mb-1.5">Subscription</span>
              <select
                value={subscriptionId}
                onChange={(e) => setSubscriptionId(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 transition"
              >
                <option value="">Select…</option>
                {subscriptions.map(s => (
                  <option key={s.subscription_id} value={s.subscription_id}>
                    {s.display_name || s.subscription_id}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-400 mb-1.5">Region</span>
              <select
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 transition"
              >
                {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-400 mb-1.5">Resource group</span>
              <input
                value={resourceGroup}
                onChange={(e) => setResourceGroup(e.target.value)}
                spellCheck={false}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 transition"
              />
              <span className="block text-[11px] text-slate-600 mt-1">Created if it does not exist.</span>
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-slate-400 mb-1.5 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" />
              SSH public key — needed for a virtual machine
            </span>
            <textarea
              value={sshKey}
              onChange={(e) => setSshKey(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder="ssh-ed25519 AAAA… you@your-laptop"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-xs font-mono text-white placeholder-slate-600 outline-none focus:border-blue-500 transition resize-none"
            />
            <span className="block text-[11px] text-slate-600 mt-1">
              The public half of your key pair, not the private one. Password
              login is disabled on anything built here, so this is the only way in.
            </span>
          </label>

          <div className="max-h-80 overflow-y-auto space-y-3 pr-1">
            {messages.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:border-slate-600 hover:text-white transition"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`text-sm whitespace-pre-wrap rounded-xl px-3.5 py-2.5 max-w-[92%] ${
                  m.role === 'user'
                    ? 'ml-auto bg-blue-600/20 border border-blue-500/30 text-blue-100'
                    : 'bg-slate-800/60 border border-slate-800 text-slate-200'
                }`}
              >
                {m.content}
              </div>
            ))}
            {sending && (
              <p className="text-xs text-slate-500 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Working it out…
              </p>
            )}
            <div ref={endRef} />
          </div>

          {error && (
            <p className="text-xs text-red-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              {error}
            </p>
          )}

          {drafts.length > 0 && isOwner && (
            <div className="space-y-3">
              {drafts.map(d => (
                <DraftCard
                  key={d.kind}
                  draft={d}
                  busy={creating === d.kind}
                  onCreate={create}
                />
              ))}
            </div>
          )}

          {deployment && <DeploymentCard deployment={deployment} />}

          <form
            onSubmit={(e) => { e.preventDefault(); send(); }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Create a VM for a small API…"
              className="flex-1 min-w-0 bg-slate-800 border border-slate-700 focus:border-blue-500 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition"
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="shrink-0 p-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-[#fff] transition"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </>
      )}
    </div>
  );
}
