import { useEffect, useMemo, useState } from 'react';
import {
  Trash2, Wallet, ShieldAlert, AlertTriangle, CheckCircle2, Loader2,
  ExternalLink, Search, Info, TrendingDown, Layers, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { formatAmountFull } from '../utils/currency';
import { exactAmount } from '../utils/exact';
import {
  MISSING, flatten, sumCost, groupTree, ruleOptions, severityOptions,
  filterItems, savings, evidenceRows, coverageNote, headline,
  severityLabel, severityTone, CERTAIN,
} from '../utils/orphaned';

const PORTAL = 'https://portal.azure.com/#@/resource';

function Kpi({ icon, label, value, sub, tone = 'slate', title }) {
  const Glyph = icon;
  const accent = {
    emerald: 'text-emerald-400',
    red: 'text-rose-400',
    slate: 'text-slate-400',
  }[tone] || 'text-slate-400';

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Glyph className={`h-4 w-4 ${accent}`} />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold text-white" title={title}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

/**
 * A resource group heading inside a subscription section.
 *
 * The group is shown even when it holds one finding: the whole point of
 * grouping is to tell the reader who owns the cleanup, and a lone resource
 * with no group above it loses that.
 */
function GroupHeader({ name, count, cost, currency, collapsed, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 bg-slate-900 py-1.5 pl-8 pr-4 text-left transition hover:bg-slate-800/40"
    >
      {collapsed
        ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-600" />
        : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-600" />}
      <span className="truncate text-xs font-medium text-slate-400" title={name}>{name}</span>
      <span className="shrink-0 text-[11px] text-slate-600">({count})</span>
      <span className="flex-1" />
      {cost > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
          {formatAmountFull(cost, currency)}
        </span>
      )}
    </button>
  );
}

/** A subscription section heading — the top level of the grouping. */
function SubHeader({ name, count, cost, currency, collapsed, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 border-y border-slate-800 bg-slate-800/40 px-4 py-2.5 text-left transition hover:bg-slate-800/70"
    >
      {collapsed
        ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
        : <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />}
      <span className="truncate text-sm font-semibold text-white" title={name}>{name}</span>
      <span className="shrink-0 rounded-md bg-slate-700/60 px-1.5 py-0.5 text-[11px] text-slate-300">
        {count}
      </span>
      <span className="flex-1" />
      {cost > 0 && (
        <span className="shrink-0 text-xs font-medium tabular-nums text-emerald-300">
          {formatAmountFull(cost, currency)}/mo
        </span>
      )}
    </button>
  );
}

/** One finding. The cost column is right-aligned and tabular so it scans. */
function Row({ item, currency, selected, onSelect }) {
  const tone = severityTone(item.severity);
  const cost = item.monthly_cost === null || item.monthly_cost === undefined
    ? null
    : Number(item.monthly_cost);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 border-l-2 py-2 pl-12 pr-4 text-left transition ${
        selected
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-transparent hover:bg-slate-800/50'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-slate-200" title={item.name}>
          {item.name}
        </span>
        <span className="block truncate text-[11px] text-slate-500" title={item.rule_title}>
          {item.rule_title || item.type}
        </span>
      </span>

      <span className="hidden w-28 shrink-0 truncate text-xs text-slate-500 sm:block">
        {item.location || MISSING}
      </span>

      <span className="hidden w-32 shrink-0 md:block">
        <span className={`rounded-md px-1.5 py-0.5 text-[11px] ${tone.chip}`}>
          {severityLabel(item.severity)}
        </span>
      </span>

      <span className="w-24 shrink-0 text-right text-xs tabular-nums">
        {cost === null
          ? <span className="italic text-slate-600">No cost</span>
          : <span className="font-medium text-white">{formatAmountFull(cost, currency)}</span>}
      </span>
    </button>
  );
}

function EvidenceRow({ label, value, hint }) {
  const absent = value === MISSING;
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-slate-500" title={hint}>{label}</span>
      <span className={`text-right text-xs ${absent ? 'italic text-slate-600' : 'text-slate-200'}`}>
        {value}
      </span>
    </div>
  );
}

/** The right-hand panel: why this is a finding, and what removing it saves. */
function Detail({ item, currency }) {
  const money = savings(item);
  const rows = evidenceRows(item);
  const tone = severityTone(item.severity);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-white">{item.rule_title || MISSING}</h2>
            <span className={`rounded-md px-1.5 py-0.5 text-[11px] ${tone.chip}`}>
              {severityLabel(item.severity)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500" title={item.name}>{item.name}</p>
        </div>
        {item.id && (
          <a
            href={`${PORTAL}${item.id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-slate-600 hover:text-white"
          >
            Open in Azure Portal
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <p className="mb-2 text-xs font-semibold text-slate-300">Detection evidence</p>
        <div className="divide-y divide-slate-800">
          {rows.map(row => <EvidenceRow key={row.label} {...row} />)}
          <EvidenceRow label="Resource group" value={item.resource_group || MISSING} />
          <EvidenceRow label="Location" value={item.location || MISSING} />
          <EvidenceRow label="Type" value={item.type || MISSING} />
        </div>
      </section>

      <section className={`rounded-xl border p-4 ${
        money.monthly === null
          ? 'border-slate-800 bg-slate-900/60'
          : 'border-emerald-500/25 bg-emerald-500/5'
      }`}
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <TrendingDown className="h-3.5 w-3.5 text-emerald-400" />
          What removing it saves
        </div>
        {money.monthly === null ? (
          <p className="mt-2 text-sm text-slate-400">{MISSING}</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-6">
            <div>
              <p className="text-2xl font-semibold text-white" title={exactAmount(money.monthly, currency)}>
                {formatAmountFull(money.monthly, currency)}
              </p>
              <p className="text-xs text-slate-500">per month, billed</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-slate-300" title={exactAmount(money.annual, currency)}>
                {formatAmountFull(money.annual, currency)}
              </p>
              <p className="text-xs text-slate-500">per year, projected</p>
            </div>
          </div>
        )}
        <p className="mt-2.5 text-xs leading-relaxed text-slate-500">{money.basis}</p>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <p className="mb-1.5 text-xs font-semibold text-slate-300">Why this was flagged</p>
        <p className="text-sm leading-relaxed text-slate-400">{item.reason || MISSING}</p>
        {item.detail && (
          <p className="mt-2 text-xs text-slate-500">{item.detail}</p>
        )}
        <p className="mt-3 flex gap-1.5 rounded-lg bg-slate-800/70 p-2.5 text-xs leading-relaxed text-slate-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {item.severity === CERTAIN
              ? 'Azure reports this as attached to nothing. Check it is not kept deliberately — a detached disk can still be somebody’s backup.'
              : 'This one needs a look before you act. The rule matches a pattern that is usually waste but is sometimes intentional.'}
          </span>
        </p>
      </section>
    </div>
  );
}

export default function Orphaned() {
  const {
    selectedTenantId, selectedSubscriptionIds, imported, subscriptions,
    orphanedData, orphanedLoading, orphanedError, loadOrphaned,
  } = useAppStore();

  const [rule, setRule] = useState('');
  const [severity, setSeverity] = useState('');
  const [query, setQuery] = useState('');
  const [hideUnpriced, setHideUnpriced] = useState(false);
  const [picked, setPicked] = useState('');
  // Collapsed rather than expanded, so the default is everything visible: a
  // page that opens fully folded hides the finding count it exists to report.
  const [collapsed, setCollapsed] = useState(() => new Set());

  const toggle = (key) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  useEffect(() => {
    if (selectedTenantId && selectedSubscriptionIds.length > 0) loadOrphaned();
  }, [selectedTenantId, selectedSubscriptionIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = orphanedData?.currency || 'INR';
  const all = useMemo(() => flatten(orphanedData), [orphanedData]);
  const shown = useMemo(
    () => filterItems(all, { rule, severity, query, hideUnpriced }),
    [all, rule, severity, query, hideUnpriced],
  );
  const tree = useMemo(() => groupTree(shown, subscriptions), [shown, subscriptions]);
  const rules = useMemo(() => ruleOptions(all), [all]);
  const severities = useMemo(() => severityOptions(all), [all]);
  const certainCost = useMemo(
    () => sumCost(shown.filter(i => i.severity === CERTAIN)),
    [shown],
  );
  const totalCost = useMemo(() => sumCost(shown), [shown]);

  // Falling back to the first finding keeps the panel populated as filters
  // change. A selection that no longer exists silently resolving to nothing
  // would leave the reader staring at an empty pane with no clue why.
  const item = shown.find(i => i.id === picked) || shown[0] || null;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-5 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Orphaned Resources</h1>
        <p className="mt-1 text-sm text-slate-400">
          Resources that are still billed but attached to nothing — grouped by the
          subscription and resource group they sit in, so the cleanup lands with
          somebody.
        </p>
      </div>

      {imported && (
        <div className="rounded-2xl border border-blue-500/30 bg-blue-950/40 p-5">
          <p className="text-sm font-medium text-blue-300">Live Azure data required</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            A billing export lists charges, not what each resource is attached to. Remove the
            imported file to scan this tenant for orphaned resources.
          </p>
        </div>
      )}

      {!selectedTenantId && !imported && (
        <div className="rounded-2xl border border-blue-500/30 bg-blue-950/40 p-6 text-center">
          <p className="font-medium text-blue-300">No tenant selected</p>
          <p className="mt-1 text-sm text-slate-400">Add a tenant from Settings to get started.</p>
        </div>
      )}

      {orphanedError && (
        <div className="rounded-2xl border border-red-500/30 bg-red-950/30 p-4 text-sm text-red-400">
          {orphanedError}
        </div>
      )}

      {orphanedLoading && !orphanedData && (
        <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          Scanning subscriptions…
        </div>
      )}

      {orphanedData && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Kpi
              icon={Wallet}
              label="Recoverable per month"
              value={formatAmountFull(certainCost, currency)}
              title={exactAmount(certainCost, currency)}
              sub="From definite waste only"
              tone="emerald"
            />
            <Kpi
              icon={Trash2}
              label="Findings shown"
              value={shown.length}
              sub={headline(shown)}
            />
            <Kpi
              icon={ShieldAlert}
              label="Total billed waste"
              value={formatAmountFull(totalCost, currency)}
              title={exactAmount(totalCost, currency)}
              sub="Includes items needing review"
              tone="red"
            />
          </div>

          <p className="text-xs text-slate-500">
            {coverageNote(shown, {
              month: orphanedData.cost_month,
              partial: orphanedData.cost_partial,
            })}
          </p>

          {orphanedData.cost_errors?.length > 0 && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-950/30 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                Costs could not be read for every subscription
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                The findings below are complete, but the money against them is not. Cost
                Management refused or did not answer for{' '}
                {orphanedData.cost_errors.length} subscription
                {orphanedData.cost_errors.length === 1 ? '' : 's'}, so those resources show
                no cost even though they are still being billed.
              </p>
              <ul className="mt-2 space-y-1">
                {orphanedData.cost_errors.map(e => (
                  <li key={e.subscription_id} className="text-xs text-slate-500">
                    <span className="text-slate-400">
                      {e.subscription_name || e.subscription_id}
                    </span>
                    {' — '}{e.error || 'no reason given'}
                    {e.retryable && ' This one is worth trying again.'}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                A billing query that fails needs the Cost Management Reader role on the
                subscription — Reader alone is not enough to see costs.
              </p>
            </div>
          )}

          {!orphanedData.cost_errors?.length
            && orphanedData.priced_count === 0
            && shown.length > 0 && (
            <div className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
                <Info className="h-4 w-4" />
                Azure billed nothing against these subscriptions
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                The billing query succeeded and came back empty, so the missing costs are
                not a fault here. That happens on a brand new subscription, on one whose
                charges land on a different billing account, and in the first day or two of
                a month before Azure has published anything.
              </p>
            </div>
          )}

          {orphanedData.errors?.length > 0 && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-950/30 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                Some checks could not complete
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                These results are partial. The service principal may lack read access for:{' '}
                {orphanedData.errors.map(e => e.rule).join(', ')}.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search a resource, group or location"
                className="w-full rounded-xl border border-slate-700 bg-slate-800 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-600 outline-none focus:border-blue-500"
              />
            </label>

            <select
              value={rule}
              onChange={e => setRule(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
            >
              <option value="">All types ({all.length})</option>
              {rules.map(r => (
                <option key={r.key} value={r.key}>{r.label} ({r.count})</option>
              ))}
            </select>

            <select
              value={severity}
              onChange={e => setSeverity(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
            >
              <option value="">All statuses</option>
              {severities.map(s => (
                <option key={s.key} value={s.key}>{s.label} ({s.count})</option>
              ))}
            </select>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={hideUnpriced}
                onChange={e => setHideUnpriced(e.target.checked)}
                className="accent-blue-500"
              />
              Only findings with a known cost
            </label>
          </div>

          {!shown.length ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center">
              <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-400" />
              <p className="font-semibold text-white">
                {all.length ? 'Nothing matches those filters' : 'No orphaned resources found'}
              </p>
              <p className="mt-1 text-sm text-slate-400">
                {all.length
                  ? 'Widen the search or clear a filter.'
                  : 'Every scanned resource is attached to something.'}
              </p>
            </div>
          ) : (
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
              <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
                {/* A column header row, so the right-hand figure is labelled
                    once instead of every cost carrying a "/mo" suffix. */}
                <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <span className="min-w-0 flex-1">Resource</span>
                  <span className="hidden w-28 shrink-0 sm:block">Location</span>
                  <span className="hidden w-32 shrink-0 md:block">Status</span>
                  <span className="w-24 shrink-0 text-right">Per month</span>
                </div>

                <div className="max-h-[38rem] overflow-y-auto">
                  {tree.map(s => (
                    <div key={s.key}>
                      <SubHeader
                        name={s.name}
                        count={s.count}
                        cost={s.cost}
                        currency={currency}
                        collapsed={collapsed.has(s.key)}
                        onToggle={() => toggle(s.key)}
                      />
                      {!collapsed.has(s.key) && s.groups.map(g => {
                        const gk = `${s.key}/${g.key}`;
                        return (
                          <div key={gk}>
                            <GroupHeader
                              name={g.name}
                              count={g.count}
                              cost={g.cost}
                              currency={currency}
                              collapsed={collapsed.has(gk)}
                              onToggle={() => toggle(gk)}
                            />
                            {!collapsed.has(gk) && g.items.map(i => (
                              <Row
                                key={i.id}
                                item={i}
                                currency={currency}
                                selected={i.id === item?.id}
                                onSelect={() => setPicked(i.id)}
                              />
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {/* Sticky so the evidence stays beside the list while scrolling
                  a long estate, which is when it is actually being read. */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 xl:sticky xl:top-6">
                {item ? (
                  <Detail item={item} currency={currency} />
                ) : (
                  <p className="flex items-center gap-2 py-10 text-sm text-slate-500">
                    <Layers className="h-4 w-4" />
                    Pick a resource to see why it was flagged.
                  </p>
                )}
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-slate-600">
            This report is read-only. Delete resources from the Azure portal or your
            infrastructure-as-code, so the change is recorded where the rest of your
            estate is managed.
          </p>
        </>
      )}
    </div>
  );
}
