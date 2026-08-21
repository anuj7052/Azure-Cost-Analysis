import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Layers, Search, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

/**
 * Subscription scope, in the navigation bar.
 *
 * Scope belongs next to tenant and date range, not halfway down one page. Every
 * figure in the app is the sum of whatever is selected here, so a reader
 * looking at a number needs to see what it covers without scrolling, and a
 * reader on the pages that never carried the filter needs to be able to change
 * it at all.
 *
 * Nothing is selected by default and that is deliberate — an estate can hold
 * hundreds of subscriptions and loading all of them unasked is a long wait for
 * a number nobody wanted. The button says so plainly rather than showing an
 * empty dashboard and letting the user work out why.
 */
export default function SubscriptionPicker() {
  const subscriptions = useAppStore(s => s.subscriptions);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const toggleSubscription = useAppStore(s => s.toggleSubscription);
  const setAllSubscriptions = useAppStore(s => s.setAllSubscriptions);
  const imported = useAppStore(s => s.imported);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef(null);

  // A scope control that stays open while the user reads the page behind it
  // invites them to trust a stale summary in the button. Close on an outside
  // click and on Escape, the two gestures people already expect.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = useMemo(
    () => new Set(selectedSubscriptionIds),
    [selectedSubscriptionIds],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return subscriptions;
    // Searching the id as well as the name: people paste a subscription id out
    // of a portal URL or a ticket far more often than they type its name.
    return subscriptions.filter(s =>
      s.display_name?.toLowerCase().includes(needle)
      || s.subscription_id?.toLowerCase().includes(needle));
  }, [subscriptions, query]);

  if (!subscriptions.length) return null;

  const count = selectedSubscriptionIds.length;
  const total = subscriptions.length;
  const none = count === 0;
  const all = count === total;

  const label = none
    ? 'No subscription'
    : all
      ? `All ${total} subscriptions`
      : count === 1
        ? (subscriptions.find(s => s.subscription_id === selectedSubscriptionIds[0])?.display_name
           || '1 subscription')
        : `${count} of ${total} subscriptions`;

  // Select-all follows the search, so filtering to "prod" and pressing it
  // selects the production subscriptions rather than silently selecting the
  // whole estate the user just filtered out of view.
  const visibleIds = matches.map(s => s.subscription_id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));

  const selectVisible = () => {
    const next = new Set(selectedSubscriptionIds);
    visibleIds.forEach(id => next.add(id));
    setAllSubscriptions([...next]);
  };

  const clearVisible = () => {
    const drop = new Set(visibleIds);
    setAllSubscriptions(selectedSubscriptionIds.filter(id => !drop.has(id)));
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={
          none
            ? 'Pick at least one subscription — nothing loads until you do'
            : `Scope: ${label}`
        }
        className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition ${
          none
            ? 'bg-amber-500/10 border-amber-500/40 text-amber-300 hover:bg-amber-500/20'
            : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:bg-slate-800'
        }`}
      >
        <Layers className="w-3.5 h-3.5 shrink-0" />
        <span className="max-w-[190px] truncate">{label}</span>
        <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl z-50 w-[22rem] overflow-hidden">
          <div className="p-3 border-b border-slate-700 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                Subscription scope
              </p>
              <span className="text-[10px] text-slate-500 tabular-nums">
                {count} of {total} selected
              </span>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name or ID…"
                className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-8 pr-8 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={selectVisible}
                disabled={allVisibleSelected}
                className="text-[11px] text-blue-400 hover:text-blue-300 disabled:text-slate-600 disabled:cursor-default transition"
              >
                {query ? `Select these ${visibleIds.length}` : 'Select all'}
              </button>
              <button
                onClick={clearVisible}
                disabled={!visibleIds.some(id => selected.has(id))}
                className="text-[11px] text-slate-400 hover:text-slate-200 disabled:text-slate-700 disabled:cursor-default transition"
              >
                {query ? 'Clear these' : 'Clear all'}
              </button>
              {imported && (
                <span className="ml-auto text-[10px] text-blue-400">from imported file</span>
              )}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {matches.length === 0 && (
              <p className="px-4 py-6 text-xs text-slate-500 text-center">
                No subscription matches “{query}”.
              </p>
            )}

            {matches.map(sub => {
              const active = selected.has(sub.subscription_id);
              // Azure keeps disabled and expired subscriptions in the list.
              // They carry no current cost, so flagging them stops a reader
              // wondering why selecting one changed nothing.
              const inactive = sub.state && sub.state !== 'Enabled';
              return (
                <button
                  key={sub.subscription_id}
                  onClick={() => toggleSubscription(sub.subscription_id)}
                  aria-pressed={active}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-slate-700/60 transition"
                >
                  <span
                    className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center shrink-0 transition ${
                      active
                        ? 'bg-blue-600 border-blue-500'
                        : 'border-slate-600'
                    }`}
                  >
                    {active && <Check className="w-3 h-3 text-white" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs truncate ${active ? 'text-blue-300' : 'text-slate-300'}`}>
                      {sub.display_name || sub.subscription_id}
                    </span>
                    <span className="block text-[10px] text-slate-500 truncate">
                      {sub.subscription_id}
                      {inactive && <span className="text-amber-400/80 ml-1.5">· {sub.state}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {none && (
            <p className="px-3 py-2.5 text-[11px] text-amber-300/90 border-t border-slate-700 leading-relaxed">
              Nothing is selected, so no page has any data to show. Pick at least one
              subscription — costs load only for what is scoped here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
