/**
 * Why the accounts on this page have no names, and what to do about it.
 *
 * Azure's role assignments carry object ids and nothing else. Turning those
 * into "Anuj Singh" needs Microsoft Graph, which is a separate consent from the
 * one that lets this application read subscriptions -- so a tenant can be fully
 * connected, every scan succeeding, and still show "Name unavailable" everywhere.
 *
 * Without this notice that looks like a bug in the product. With it, the reader
 * knows it is a permission they can grant, and can grant it in one click if
 * their account is allowed to. The three reasons are kept distinct because they
 * need three different responses: consent is an administrator's decision, a
 * missing token resolves itself, and an outage resolves itself later.
 */
import { useState } from 'react';
import { UserSearch } from 'lucide-react';
import { requestDirectoryConsent } from '../../api/client';

export default function DirectoryNotice({ directory, onResolved }) {
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);
  const reason = directory?.reason || '';

  // Names came through. Nothing to explain.
  if (!reason || directory?.resolved) return null;

  const denied = reason === 'denied';

  async function ask() {
    setAsking(true);
    const granted = await requestDirectoryConsent();
    setAsking(false);
    if (granted) onResolved?.();
    else setRefused(true);
  }

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-950/20 p-4">
      <UserSearch size={16} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium text-amber-200">
          Accounts are shown without names
        </p>
        <p className="text-xs leading-relaxed text-amber-200/75">
          {denied
            ? 'Reading names from your directory needs the Directory.Read.All permission. Until it is approved, accounts appear as "Name unavailable" and their identifiers are under technical details.'
            : 'Your directory was not read during this scan, so accounts appear without names. Their identifiers are still under technical details.'}
        </p>
        {refused && (
          <p className="text-xs leading-relaxed text-amber-200/60">
            Permission was not granted. In many organisations only an
            administrator can approve this, in which case they need to do it
            once for everyone.
          </p>
        )}
      </div>
      <button
        onClick={ask}
        disabled={asking}
        className="shrink-0 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-200 transition hover:bg-amber-500/10 disabled:opacity-60"
      >
        {asking ? 'Asking…' : 'Show names'}
      </button>
    </div>
  );
}
