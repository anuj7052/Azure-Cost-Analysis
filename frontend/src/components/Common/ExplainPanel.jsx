import { useState } from 'react';
import {
  ExternalLink, FileSpreadsheet, Cloud, KeyRound, Sigma, Copy, Check, Terminal,
} from 'lucide-react';
import DetailPanel from './DetailPanel';
import { exactAmount, displayUnit } from '../../utils/exact';
import {
  COST_API_VERSION,
  costAnalysisLink,
  costQueryBody,
  costQueryCli,
  costQueryCliWithDebug,
  hasExplicitRange,
  resourceGraphLink,
  resourceLookupKql,
  usageDetailsLink,
} from '../../utils/azureLinks';

/**
 * How a figure was arrived at, and how to check it at its source.
 *
 * Every number on this page is derived — a sum, a difference, or a division —
 * and a derived number nobody can verify is worth very little when the
 * conversation is about an invoice. So the working is shown, along with a way
 * to reproduce it in whichever source the figure actually came from.
 *
 * Verification differs completely by source, which is why it is not written as
 * one generic paragraph: checking a spreadsheet column is nothing like running
 * a Cost Management query, and sending someone to the wrong one wastes more
 * time than saying nothing.
 */

function Step({ n, children }) {
  return (
    <li className="flex gap-3">
      <span className="w-5 h-5 rounded-md bg-slate-800 text-slate-300 text-[11px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
        {n}
      </span>
      <span className="text-sm text-slate-300 leading-relaxed">{children}</span>
    </li>
  );
}

function Formula({ children }) {
  return (
    <pre className="bg-slate-950/70 border border-slate-800 rounded-xl p-3.5 text-[12px] text-slate-300 whitespace-pre-wrap leading-relaxed overflow-x-auto">
      {children}
    </pre>
  );
}

/** A query the user is expected to run, so copying it must be one click. */
function CopyBlock({ title, code, note, action }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is blocked outside a secure context; the text is
      // selectable either way, so this fails quietly rather than alarming.
    }
  };

  return (
    <div className="border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-800/50 border-b border-slate-800">
        <span className="text-[11px] font-semibold text-slate-300">{title}</span>
        <div className="flex items-center gap-2">
          {action}
          <button
            onClick={copy}
            className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-white transition"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre className="p-3.5 text-[11.5px] text-slate-300 whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-72">
        {code}
      </pre>
      {note && <p className="text-[11px] text-slate-500 px-3.5 pb-3 leading-relaxed">{note}</p>}
    </div>
  );
}

function OpenLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 text-[11px] text-blue-400 hover:text-blue-300 transition"
    >
      {children} <ExternalLink className="w-3 h-3" />
    </a>
  );
}

function SourceBadge({ source, fileName }) {
  const meta = {
    import: {
      icon: FileSpreadsheet,
      label: fileName ? `Imported file — ${fileName}` : 'Imported usage file',
      tone: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
    },
    service_principal: {
      icon: Cloud,
      label: 'Live Azure — service principal',
      tone: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    },
    session_token: {
      icon: KeyRound,
      label: 'Live Azure — pasted session token',
      tone: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    },
    delegated: {
      icon: Cloud,
      label: 'Live Azure — your Microsoft sign-in',
      tone: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    },
  }[source] || {
    icon: Cloud,
    label: 'Live Azure',
    tone: 'bg-slate-500/10 text-slate-300 border-slate-600/30',
  };

  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border ${meta.tone}`}>
      <Icon className="w-3.5 h-3.5" />
      {meta.label}
    </span>
  );
}

/**
 * Reproduce the figure from the uploaded file.
 *
 * The file is the entire source of truth — nothing was fetched from Azure — so
 * verification means filtering the same rows and summing the same column.
 */
function ImportSteps({ item, currency, fileName }) {
  const unit = displayUnit(item.unit) || 'unit';

  return (
    <>
      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
          How this was calculated
        </h4>
        <Formula>
{`Every row in ${fileName || 'your file'} matching:
  meter          = ${item.meter || '(this line item)'}
  resource group = ${item.resource_group || '(any)'}

was grouped by month, then:

  quantity  = SUM of the usage quantity column
  cost      = SUM of the cost column
  unit rate = cost ÷ quantity        (per ${unit})

  previous month : ${item.prev_qty ?? '—'} ${unit} costing ${exactAmount(item.prev_cost, currency)}
  current  month : ${item.curr_qty ?? '—'} ${unit} costing ${exactAmount(item.curr_cost, currency)}
  change         = ${exactAmount(item.delta, currency)}`}
        </Formula>
      </section>

      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
          Check it in your file
        </h4>
        <ol className="space-y-2.5">
          <Step n={1}>
            Open <span className="text-slate-100 font-medium">{fileName || 'the uploaded file'}</span> in
            Excel or Google Sheets.
          </Step>
          <Step n={2}>
            Filter the meter column to{' '}
            <span className="text-slate-100 font-medium">{item.meter || item.label}</span>
            {item.resource_group && (
              <> and the resource group column to <span className="text-slate-100 font-medium">{item.resource_group}</span></>
            )}.
          </Step>
          <Step n={3}>Group the remaining rows by billing month.</Step>
          <Step n={4}>
            Sum the cost column per month. Those totals are the two figures
            compared here; their difference is the change.
          </Step>
        </ol>
        <p className="text-xs text-slate-500 mt-3 leading-relaxed">
          Column names vary between Azure exports — cost appears as PreTaxCost,
          Cost or CostInBillingCurrency, and quantity as UsageQuantity or Quantity.
          The parser accepts all of them, so match on meaning rather than the exact header.
        </p>
      </section>
    </>
  );
}

/**
 * Reproduce the figure against live Azure.
 *
 * Two tools, because one cannot answer both halves: Cost Analysis and the Cost
 * Management API hold the money, and Resource Graph holds the resource. The KQL
 * offered here finds the resource behind the charge — it deliberately does not
 * pretend to return a cost, because Resource Graph has no billing data at all.
 */
function AzureSteps({ item, currency, subscriptionId, fromDate, toDate }) {
  const unit = displayUnit(item.unit) || 'unit';
  const kql = resourceLookupKql({
    resourceName: item.resource_name || item.label,
    resourceGroup: item.resource_group,
  });

  return (
    <>
      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
          How this was calculated
        </h4>
        <Formula>
{`Azure Cost Management was queried per subscription, then
the rows for this meter were summed by month:

  meter          = ${item.meter || '(this line item)'}
  resource group = ${item.resource_group || '(any)'}

  previous month : ${item.prev_qty ?? '—'} ${unit} costing ${exactAmount(item.prev_cost, currency)}
  current  month : ${item.curr_qty ?? '—'} ${unit} costing ${exactAmount(item.curr_cost, currency)}
  change         = ${exactAmount(item.delta, currency)}

  unit rate = cost ÷ quantity  (per ${unit})
              ${exactAmount(item.prev_rate, currency)} → ${exactAmount(item.curr_rate, currency)}`}
        </Formula>
      </section>

      <section className="space-y-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Verify the cost
        </h4>

        <CopyBlock
          title="Cost Management API — the exact request behind this figure"
          code={costQueryCli({ subscriptionId, fromDate, toDate })}
          note={
            `Where to paste: Azure Cloud Shell (shell.azure.com), or a local terminal after "az login". ` +
            `One line, so it runs unchanged in PowerShell and bash. ` +
            (hasExplicitRange(fromDate, toDate)
              ? `Dates cover the two months being compared. `
              : `No month pair is selected, so this defaults to the last two whole months — pick a pair above to target the exact window. `) +
            (subscriptionId
              ? ''
              : `Replace <subscription-id> with the subscription holding this charge. `) +
            `API version ${COST_API_VERSION}.`
          }
          action={<OpenLink href="https://shell.azure.com">Cloud Shell</OpenLink>}
        />

        {/* Cost Management throttles hard and this app queries the same
            endpoint, so a manual check often collides with the app's own
            traffic. Without this note a 429 reads as a broken command. */}
        <div className="border border-amber-500/30 bg-amber-950/20 rounded-xl p-3.5 space-y-2.5">
          <p className="text-xs text-amber-300/90 font-medium">
            If Azure replies 429 (Too many requests)
          </p>
          <p className="text-xs text-slate-400 leading-relaxed">
            The command is correct — Cost Management rate-limits per subscription, and
            this app queries the same endpoint, so the two compete.
          </p>

          <ul className="text-xs text-slate-400 leading-relaxed space-y-1.5 list-disc pl-4">
            <li>
              <span className="text-slate-200">Wait 60 seconds</span> and run it again. That
              clears most throttles.
            </li>
            <li>
              Still throttled? Wait <span className="text-slate-200">5 minutes</span>. Large
              queries sit in a slower bucket.
            </li>
            <li>
              Close or idle this app's tab first — its background queries consume the
              same quota.
            </li>
            <li>
              Narrow the request: one subscription and a two-month window are far less
              likely to be limited than many subscriptions across a year.
            </li>
          </ul>

          <p className="text-xs text-slate-500 leading-relaxed">
            Azure states the exact wait rather than leaving you to guess. Run the command
            below and it prints the <span className="text-slate-300">retry-after</span> header,
            in seconds — wait that long, then retry.
          </p>
        </div>

        <CopyBlock
          title="Read the exact retry wait from Azure"
          code={costQueryCliWithDebug({ subscriptionId, fromDate, toDate })}
          note='Where to paste: the same Cloud Shell session. Look for "retry-after" or "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after" — the value is the number of seconds to wait. On bash, replace the Select-String pipe with: grep -i retry-after'
        />

        <CopyBlock
          title="Request body"
          code={JSON.stringify(costQueryBody({ fromDate, toDate }), null, 2)}
          note="Where to paste: the --body argument above, or the request body box in the portal's API try-it console. Grouping by ServiceName, ResourceGroupName and Meter is what produces one row per line item."
        />

        <ol className="space-y-2.5 pt-1">
          <Step n={1}>
            Open{' '}
            <a
              href={costAnalysisLink(subscriptionId)}
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
            >
              Cost analysis{subscriptionId ? ' for this subscription' : ''} <ExternalLink className="w-3 h-3" />
            </a>
            {' '}— it opens in a new tab, scoped for you.
          </Step>
          <Step n={2}>
            Set granularity to <span className="text-slate-100 font-medium">Monthly</span> and the
            date range to cover both months.
          </Step>
          <Step n={3}>
            Group by <span className="text-slate-100 font-medium">Meter</span>, then filter to{' '}
            <span className="text-slate-100 font-medium">{item.meter || item.label}</span>
            {item.resource_group && (
              <> and resource group <span className="text-slate-100 font-medium">{item.resource_group}</span></>
            )}.
          </Step>
          <Step n={4}>
            The monthly totals there are the figures compared here. Add the usage
            quantity column to check the rate.
          </Step>
        </ol>
      </section>

      <section className="space-y-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Verify the {unit.toLowerCase() === 'hours' ? 'hours' : 'quantity'}
        </h4>

        <Formula>
{`The ${unit} figure is Azure's own UsageQuantity, summed —
it is not derived or converted:

  ${item.prev_qty ?? '—'} → ${item.curr_qty ?? '—'} ${unit}

  = SUM(UsageQuantity) for meter "${item.meter || item.label}"
    in each billing month${item.resource_group ? `,\n    scoped to resource group ${item.resource_group}` : ''}`}
        </Formula>

        <ol className="space-y-2.5">
          <Step n={1}>
            Open{' '}
            <a
              href={usageDetailsLink(subscriptionId)}
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
            >
              Cost Management → Cost analysis <ExternalLink className="w-3 h-3" />
            </a>
            {' '}and set the scope to the subscription holding this charge.
          </Step>
          <Step n={2}>
            Open the <span className="text-slate-100 font-medium">Metric</span> selector at the top
            and switch it from Cost to <span className="text-slate-100 font-medium">Usage</span>.
            The chart then reports quantity instead of money.
          </Step>
          <Step n={3}>
            Set granularity to <span className="text-slate-100 font-medium">Monthly</span>, group by{' '}
            <span className="text-slate-100 font-medium">Meter</span>, and filter to{' '}
            <span className="text-slate-100 font-medium">{item.meter || item.label}</span>.
          </Step>
          <Step n={4}>
            The monthly values are the {unit} shown here. Azure reports them in the
            meter's own unit — <span className="text-slate-100 font-medium">{item.unit || unit}</span> —
            so no conversion is applied.
          </Step>
        </ol>

        <p className="text-xs text-slate-500 leading-relaxed">
          If your view has no Usage metric, use{' '}
          <span className="text-slate-300">Cost Management → Exports</span> or{' '}
          <span className="text-slate-300">Download usage + charges</span> instead. The resulting CSV
          has a <span className="text-slate-300">Quantity</span> (or{' '}
          <span className="text-slate-300">UsageQuantity</span>) column — filter it to the same meter
          and month and sum it. That column is the exact field the API request above aggregates.
        </p>

        {/* Days are derived; hours are not. Saying which is which prevents the
            portal figure being read as disagreeing with this page. */}
        <p className="text-xs text-slate-500 leading-relaxed">
          Any day count shown elsewhere in this app is
          <span className="text-slate-300"> hours ÷ 24</span>, calculated here for readability.
          Azure bills and reports hours only, so the portal will always show the hour figure.
        </p>
      </section>

      <section className="space-y-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Find the resource (KQL)
        </h4>

        <CopyBlock
          title="Resource Graph — locate the resource behind this charge"
          code={kql}
          note='Where to paste: Azure Portal → search "Resource Graph Explorer" → the query editor → Run. Or press "Run in portal" above, which opens it with this query already loaded. It returns no cost: Resource Graph holds inventory, not billing.'
          action={
            <OpenLink href={resourceGraphLink(kql)}>
              <span className="inline-flex items-center gap-1"><Terminal className="w-3 h-3" /> Run in portal</span>
            </OpenLink>
          }
        />

        <p className="text-xs text-slate-500 leading-relaxed">
          There is no KQL query for the cost itself. Cost Management is a REST API,
          not a Log Analytics table, so billing figures are checked through Cost
          Analysis or the request above. KQL applies to Resource Graph, which
          describes what exists rather than what it cost.
        </p>
      </section>
    </>
  );
}

export default function ExplainPanel({
  open,
  onClose,
  item,
  currency,
  source,
  fileName,
  subscriptionId,
  fromDate,
  toDate,
}) {
  if (!item) return null;

  return (
    <DetailPanel
      open={open}
      title={item.label || item.meter || 'Line item'}
      subtitle="Where this figure comes from, and how to verify it"
      onClose={onClose}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <SourceBadge source={source} fileName={fileName} />
        <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-slate-700 bg-slate-800/60 text-slate-400">
          <Sigma className="w-3.5 h-3.5" />
          Derived, not reported by Azure as a single number
        </span>
      </div>

      {source === 'import'
        ? <ImportSteps item={item} currency={currency} fileName={fileName} />
        : (
          <AzureSteps
            item={item}
            currency={currency}
            subscriptionId={subscriptionId}
            fromDate={fromDate}
            toDate={toDate}
          />
        )}
    </DetailPanel>
  );
}
