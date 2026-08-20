import { useAppStore } from '../../store/useAppStore';

/**
 * Subscription scope selector. Every page shares it so a filter set on one
 * page carries over, and it works identically for live and imported data.
 */
export default function SubscriptionFilter({ onChange }) {
  const {
    subscriptions, selectedSubscriptionIds, toggleSubscription,
    setAllSubscriptions, imported,
  } = useAppStore();

  if (!subscriptions.length) return null;

  const apply = (fn) => { fn(); onChange?.(); };
  const allSelected = selectedSubscriptionIds.length === subscriptions.length;
  const noneSelected = selectedSubscriptionIds.length === 0;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 elevated">
      {/* Nothing is selected by default, so the page is empty until the user
          chooses. Saying why beats an unexplained blank dashboard. */}
      {noneSelected && (
        <p className="text-xs text-amber-300/90 mb-3">
          Choose one or more subscriptions to load cost data.
        </p>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-slate-400 font-semibold uppercase tracking-wide">
          Subscriptions
        </span>

        <button
          onClick={() => apply(() => setAllSubscriptions(subscriptions.map(s => s.subscription_id)))}
          disabled={allSelected}
          className="text-xs text-blue-400 hover:text-blue-300 disabled:text-slate-600 disabled:cursor-default transition"
        >
          Select all
        </button>
        <button
          onClick={() => apply(() => setAllSubscriptions([]))}
          disabled={!selectedSubscriptionIds.length}
          className="text-xs text-slate-500 hover:text-slate-300 disabled:text-slate-700 disabled:cursor-default transition"
        >
          Clear
        </button>

        <span className="w-px h-4 bg-slate-800" />

        {subscriptions.map(sub => {
          const active = selectedSubscriptionIds.includes(sub.subscription_id);
          return (
            <button
              key={sub.subscription_id}
              onClick={() => apply(() => toggleSubscription(sub.subscription_id))}
              title={sub.subscription_id}
              aria-pressed={active}
              className={`text-xs px-3 py-1.5 rounded-full border transition max-w-[240px] truncate ${
                active
                  ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                  : 'border-slate-700 text-slate-500 hover:border-slate-600 hover:text-slate-300'
              }`}
            >
              {sub.display_name}
            </button>
          );
        })}

        <span className="ml-auto text-xs text-slate-500">
          {selectedSubscriptionIds.length} of {subscriptions.length} shown
          {imported && <span className="ml-2 text-blue-400">· imported file</span>}
        </span>
      </div>

      {selectedSubscriptionIds.length === 0 && (
        <p className="text-xs text-amber-400 mt-3">
          No subscription selected — pick at least one to see data.
        </p>
      )}
    </div>
  );
}
