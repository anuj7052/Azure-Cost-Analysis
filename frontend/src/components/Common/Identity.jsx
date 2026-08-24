import { useMemo } from 'react';
import { Bot, Users, UserRound, HelpCircle } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import {
  isUnresolved, principalLabel, scopeLabel, shortId, subscriptionLabel, subscriptionNameMap,
} from '../../utils/identity';

/*
 * React bindings for the identity formatters.
 *
 * These read the subscription list the app has already loaded, so putting a
 * name where a GUID used to be costs no request. Components only, so Fast
 * Refresh stays happy — the pure functions live in utils/identity.js.
 */

function useNames() {
  const subscriptions = useAppStore(s => s.subscriptions);
  return useMemo(() => subscriptionNameMap(subscriptions || []), [subscriptions]);
}

const KIND_ICON = {
  'Service principal': Bot,
  Group: Users,
  User: UserRound,
};

/**
 * A principal, by name.
 *
 * When Azure gave us no display name the row still has to identify *something*,
 * so it shows the kind of principal and an abbreviated object id, visibly
 * marked as unnamed. The full id stays in the title attribute — an auditor
 * chasing one specific assignment still needs it.
 */
export function Principal({ item, className = '' }) {
  const Icon = KIND_ICON[item?.principal_type] || HelpCircle;
  const unresolved = isUnresolved(item);

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={item?.principal_id || ''}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
      <span className={`truncate ${unresolved ? 'italic text-slate-400' : ''}`}>
        {principalLabel(item)}
      </span>
    </span>
  );
}

/** A subscription's display name, falling back to an abbreviated id. */
export function SubscriptionName({ id, className = '' }) {
  const names = useNames();
  if (!id) return null;
  return (
    <span className={className} title={id}>{subscriptionLabel(id, names)}</span>
  );
}

/**
 * An ARM scope as a breadcrumb of names.
 *
 * The raw path stays in the title attribute because it is the only thing you
 * can paste into the Azure portal or the CLI.
 */
export function ScopePath({ scope, className = '' }) {
  const names = useNames();
  const { parts } = scopeLabel(scope, names);

  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1 ${className}`} title={scope || ''}>
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-700">/</span>}
          <span className={i === parts.length - 1 ? 'text-slate-300' : 'text-slate-500'}>{part}</span>
        </span>
      ))}
    </span>
  );
}

/** A GUID shown deliberately, abbreviated, as a copyable chip. */
export function IdChip({ value, className = '' }) {
  if (!value) return null;
  return (
    <span
      className={`rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 ${className}`}
      title={value}
    >
      {shortId(value)}
    </span>
  );
}
