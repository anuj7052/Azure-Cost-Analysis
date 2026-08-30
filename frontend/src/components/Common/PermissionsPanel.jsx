import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  ShieldCheck, ShieldAlert, KeyRound, Copy, Check, ExternalLink,
  Search, Loader2, Info, ChevronDown, ChevronRight,
} from 'lucide-react';
import { fetchPermissions } from '../../api/client';
import { friendlyError } from '../../utils/apiError';
import {
  toneFor, accessLabel, tierVerdict, entriesOf, filterEntries,
  costOfSkipping, isDirectory, assignCommand, assignScript,
  manualEntries, needsAdmin, headline, CHANGE,
} from '../../utils/permissions';

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      toast.error('Could not copy to the clipboard.');
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-300 transition hover:border-slate-600 hover:text-white"
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : label}
    </button>
  );
}

function Entry({ entry, subscriptionId, assignee }) {
  const directory = isDirectory(entry);
  const command = assignCommand(entry, subscriptionId, assignee);
  const changes = entry.access === CHANGE;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-white">{entry.name}</span>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[11px] ${
            changes ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-800 text-slate-400'
          }`}
        >
          {accessLabel(entry.access)}
        </span>
        <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-400">
          {directory ? 'Entra permission' : 'Azure role'}
        </span>
        {entry.admin_consent && (
          <span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300">
            Needs an administrator
          </span>
        )}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-slate-300">{entry.why}</p>
      <p className="mt-1 text-xs text-slate-500">
        Granted at: {entry.scope_label}
      </p>
      <p className="mt-1 text-xs text-slate-500">{costOfSkipping(entry)}</p>

      {entry.caveat && (
        <p className="mt-2 flex gap-1.5 rounded-lg bg-slate-800/70 p-2.5 text-xs leading-relaxed text-slate-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span>{entry.caveat}</span>
        </p>
      )}

      {command && (
        <div className="mt-2.5 flex items-start gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-950 px-2.5 py-2 text-[11px] text-slate-400">
            {command}
          </code>
          <CopyButton text={command} />
        </div>
      )}
    </div>
  );
}

function Tier({ tier, subscriptionId, assignee, open, onToggle, query }) {
  const tone = toneFor(tier.key);
  const entries = useMemo(
    () => filterEntries(entriesOf(tier), query),
    [tier, query],
  );
  const script = assignScript(tier, subscriptionId, assignee);
  const manual = manualEntries(tier);

  if (query && !entries.length) return null;

  return (
    <section className={`rounded-2xl border ${tone.border} ${tone.bg} p-4`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 text-left"
      >
        {open
          ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-500" />
          : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-500" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-white">{tier.label}</span>
            <span className={`rounded-md px-1.5 py-0.5 text-[11px] ${tone.chip}`}>
              {tier.read_only ? 'Read only' : 'Includes changes'}
            </span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">{tier.summary}</p>
          <p className="mt-1 text-xs text-slate-500">{tierVerdict(tier)}</p>
        </div>
      </button>

      {open && (
        <div className="mt-3 space-y-2.5">
          {entries.map((entry) => (
            <Entry
              key={entry.name}
              entry={entry}
              subscriptionId={subscriptionId}
              assignee={assignee}
            />
          ))}

          {script && (
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-400">
                  All of the above, as one script
                </span>
                <CopyButton text={script} label="Copy all" />
              </div>
              <pre className="overflow-x-auto text-[11px] leading-relaxed text-slate-400">
                {script}
              </pre>
              {manual.length > 0 && (
                <p className="mt-2 text-xs text-slate-500">
                  {manual.map((m) => m.name).join(', ')}
                  {manual.length === 1 ? ' is not' : ' are not'} in this script
                  because {manual.length === 1 ? 'it cannot' : 'they cannot'} be
                  granted with a role assignment. See the note above.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The full permission list.
 *
 * Shown before anybody connects a tenant, not buried in a PDF, because the
 * question "what is this app going to be able to see?" is the one that
 * decides whether onboarding happens at all.
 */
function Panel({ tenantId, compact }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [open, setOpen] = useState(() => ({ core: true }));

  useEffect(() => {
    let live = true;
    fetchPermissions(tenantId)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(friendlyError(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [tenantId]);

  const admin = useMemo(() => needsAdmin(data), [data]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the permission list…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
        {error || 'The permission list could not be loaded.'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <header className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
          <div className="min-w-0">
            <h3 className="font-semibold text-white">What this app needs access to</h3>
            <p className="mt-1 text-sm text-slate-400">{headline(data)}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{data.note}</p>
          </div>
        </div>

        {data.consent_url && (
          <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950 p-3">
            <p className="text-xs leading-relaxed text-slate-400">
              An administrator in your directory consents once, here. This creates
              the app inside <em>your</em> tenant — no key, secret or credential is
              exchanged with anyone else in either direction.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href={data.consent_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500"
              >
                Grant admin consent
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <CopyButton text={data.consent_url} label="Copy link" />
            </div>
            {admin.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                Only {admin.map((a) => a.name).join(', ')} actually requires this.
                Everything else is either granted by each user at sign-in, or is
                an Azure role you assign yourself.
              </p>
            )}
          </div>
        )}
      </header>

      {!compact && (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="relative sm:col-span-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a role or a page"
              className="w-full rounded-xl border border-slate-700 bg-slate-800 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-600 outline-none focus:border-blue-500"
            />
          </label>
          <input
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
            placeholder="Subscription id (for the commands)"
            spellCheck={false}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-blue-500"
          />
          <input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Who to grant it to"
            spellCheck={false}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-blue-500"
          />
        </div>
      )}

      {data.tiers.map((tier) => (
        <Tier
          key={tier.key}
          tier={tier}
          query={query}
          subscriptionId={subscriptionId}
          assignee={assignee}
          open={!!open[tier.key] || !!query}
          onToggle={() => setOpen((o) => ({ ...o, [tier.key]: !o[tier.key] }))}
        />
      ))}

      <p className="flex gap-2 rounded-2xl border border-slate-800 bg-slate-900 p-3.5 text-xs leading-relaxed text-slate-500">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
        <span>
          Every directory permission here is <strong className="text-slate-400">Delegated</strong>,
          meaning the app acts as the person signed in and can never see more
          than they already could. No application permission is used, so this app
          never holds standing access to your directory on its own.
        </span>
      </p>

      {!compact && (
        <p className="flex gap-2 text-xs leading-relaxed text-slate-500">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
          <span>
            Prefer signing in over pasting a client secret. Consent creates the
            connection without any credential ever leaving your tenant.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Remounted whenever the tenant changes.
 *
 * Switching tenant has to clear the previous answer, and a key is the honest
 * way to say "this is a different question" — the alternative is resetting
 * four pieces of state inside an effect and hoping none is forgotten.
 */
export default function PermissionsPanel({ tenantId, compact = false }) {
  return <Panel key={tenantId || 'self'} tenantId={tenantId} compact={compact} />;
}
