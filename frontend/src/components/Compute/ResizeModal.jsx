import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowDown, Check, Loader2, ShieldAlert, X,
} from 'lucide-react';
import {
  fetchResizeOperation, fetchResizeOptions, previewResize, startResize,
} from '../../api/client';
import { Badge, Button, Callout, Status } from '../ui';
import useDialogChrome from '../../hooks/useDialogChrome';
import { formatAmountFull } from '../../utils/currency';
import {
  NOT_RETURNED, UNAVAILABLE, confidenceAdvice, confirmDisabled, describeOption,
  downtimeFor, filterOptions, opensOnPicker, optionsSummary, outcomeOf,
  savingSummary, shouldPoll, sortOptions, stepsOf, targetSkuOf,
} from '../../utils/resize';

/**
 * Review and perform a VM resize.
 *
 * This is the only component in the application that can change a customer's
 * infrastructure, so it is built around making the user's decision an informed
 * one rather than around making the action easy.
 *
 * Three deliberate frictions:
 *
 *   1. Opening this modal performs a read-only preview. The first click on
 *      "Review Resize" cannot alter anything.
 *   2. The confirm button is disabled until the backend says every check
 *      passed. A blocker is shown as a sentence, not a greyed-out button with
 *      no explanation.
 *   3. Confirming reveals a second, final acknowledgement that names the
 *      downtime. A machine is stopped by this action; one click is not enough.
 *
 * Progress is polled from the backend record rather than animated locally. A
 * progress bar that moves on a timer is a lie about a real operation, and the
 * one thing a person watching their production VM restart cannot afford is a
 * comforting fiction.
 */

const UNAVAILABLE_LABEL = UNAVAILABLE;

const STATUS_TONE = {
  available: 'good',
  allowed: 'good',
  compatible: 'good',
  unverified: 'medium',
  insufficient: 'critical',
  unavailable: 'critical',
  restricted: 'critical',
  denied: 'critical',
  incompatible: 'critical',
};

const STEP_ICON = {
  done: <Check className="h-3.5 w-3.5 text-emerald-400" />,
  active: <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />,
  failed: <X className="h-3.5 w-3.5 text-rose-400" />,
};

/** A number, or an honest gap. Never a zero standing in for "we don't know". */
function Money({ value, currency, className = '' }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return <span className="text-slate-500">{UNAVAILABLE_LABEL}</span>;
  }
  return <span className={className}>{formatAmountFull(value, currency)}</span>;
}

function Field({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="shrink-0 text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-sm text-slate-200">{children}</dd>
    </div>
  );
}

function Value({ value, suffix = '' }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-slate-500">{NOT_RETURNED}</span>;
  }
  return <span>{value}{suffix}</span>;
}

function Block({ title, children, className = '' }) {
  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900/40 p-3 ${className}`}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </p>
      {children}
    </section>
  );
}

/** One size, described from Azure's own capability list. */
function SizeCard({ title, sku, monthly, currency, tone }) {
  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </p>
      <p className="mt-1 font-mono text-sm text-slate-100">
        <Value value={sku?.name} />
      </p>
      <p className="mt-1 text-xs text-slate-400">
        {typeof sku?.vcpu === 'number' ? `${sku.vcpu} vCPU` : `${NOT_RETURNED} vCPU`}
        {' · '}
        {typeof sku?.memory_gb === 'number' ? `${sku.memory_gb} GiB RAM` : `${NOT_RETURNED} RAM`}
      </p>
      <p className="mt-2 text-base font-semibold text-slate-100">
        <Money value={monthly} currency={currency} />
        {typeof monthly === 'number' && (
          <span className="text-xs font-normal text-slate-500"> / month list price</span>
        )}
      </p>
      <dl className="mt-2 border-t border-slate-800 pt-2">
        <Field label="Family"><Value value={sku?.family} /></Field>
        <Field label="Architecture"><Value value={sku?.architecture} /></Field>
        <Field label="Generation"><Value value={sku?.generation} /></Field>
        <Field label="Max data disks"><Value value={sku?.max_data_disks} /></Field>
        <Field label="Temp disk">
          <Value value={sku?.temp_disk_gb} suffix={sku?.temp_disk_gb ? ' GiB' : ''} />
        </Field>
        <Field label="Premium disks"><Value value={sku?.premium_disk_supported} /></Field>
      </dl>
    </div>
  );
}

function CheckRow({ label, check }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div>
        <p className="text-sm text-slate-200">{label}</p>
        {check?.note && (
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{check.note}</p>
        )}
      </div>
      <Status
        tone={STATUS_TONE[check?.status] || 'neutral'}
        label={check?.label || 'Not checked'}
      />
    </div>
  );
}

function SizeRow({ option, currency, selected, onChoose }) {
  const d = describeOption(option, currency);
  const disabled = !d.selectable;
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChoose(d.name)}
        className={[
          'w-full rounded-md border px-3 py-2 text-left transition',
          selected ? 'border-sky-600 bg-sky-950/30' : 'border-slate-800 bg-slate-900/40',
          disabled ? 'cursor-not-allowed opacity-55' : 'hover:border-slate-600',
        ].join(' ')}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-slate-100">{d.name}</span>
          {d.isRecommended && <Badge tone="info">Recommended</Badge>}
          {d.isCurrent && <Badge tone="neutral">Current</Badge>}
          <span className="ml-auto text-xs text-slate-400">{d.price}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span>{d.specs}</span>
          <Status tone={d.impact.tone} label={d.impact.text} />
          <Status tone={d.quotaOk ? 'good' : 'medium'} label={d.quota} />
          <Status tone={d.availableOk ? 'good' : 'high'} label={d.availability} />
        </div>
        {disabled && d.blockers.length > 0 && (
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            {d.blockers.join(' ')}
          </p>
        )}
      </button>
    </li>
  );
}

export default function ResizeModal({ vm, tenantId, currency, onClose, onResized }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState({});
  const [operation, setOperation] = useState(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef(null);

  // The size under review. It starts as whatever the algorithm proposed, but
  // it is the user's to change: a fleet only ever shrinks if the tool also
  // lets somebody grow the one machine that is genuinely too small.
  const [chosen, setChosen] = useState(targetSkuOf(vm));
  const [picking, setPicking] = useState(opensOnPicker(vm));
  const [catalogue, setCatalogue] = useState(null);
  const [loadingSizes, setLoadingSizes] = useState(false);
  const [sizeError, setSizeError] = useState('');
  const [search, setSearch] = useState('');
  const [changeFilter, setChangeFilter] = useState('all');
  const [onlySelectable, setOnlySelectable] = useState(true);

  const targetSku = chosen;
  const confidence = confidenceAdvice(vm);
  const downtime = downtimeFor(vm);
  const billed = typeof vm.monthly_cost === 'number' ? vm.monthly_cost : null;

  // Three separate acknowledgements, because they are three separate risks and
  // a single "I agree" invites one reflex click to cover all of them.
  const ACKS = [
    ['downtime', vm.power_state === 'running'
      ? `I understand that resizing ${vm.name} will cause downtime.`
      : `I understand that ${vm.name} will be resized while it stays stopped.`],
    ['suitable', `I have confirmed that ${targetSku} is suitable for this workload.`],
    ['restart', vm.power_state === 'running'
      ? 'I understand that Azure will deallocate and restart the VM.'
      : 'I understand that Azure will not start this VM after the resize.'],
  ];
  const allAcknowledged = ACKS.every(([key]) => acknowledged[key]);

  // The catalogue is a live read of the subscription's own sizes, quota and
  // prices, so it is fetched only when somebody actually opens the picker.
  //
  // `loadingSizes` is deliberately absent from both the guard and the
  // dependencies. It was in both, and setting it re-ran the effect, whose
  // cleanup then marked the in-flight request cancelled — so the response
  // arrived, was discarded, and the spinner span forever. A flag this effect
  // writes can never be a flag it depends on.
  useEffect(() => {
    if (!picking || catalogue) return undefined;
    let cancelled = false;
    setLoadingSizes(true);
    setSizeError('');
    fetchResizeOptions({
      tenant_id: tenantId,
      resource_id: vm.resource_id || vm.id,
      currency,
      billed_monthly: billed,
      recommended_sku: targetSkuOf(vm) || null,
    })
      .then((result) => { if (!cancelled) setCatalogue(result); })
      .catch((err) => {
        if (!cancelled) {
          setSizeError(err?.response?.data?.error?.message
            || err?.response?.data?.detail
            || 'Azure could not be asked which sizes this VM can move to.');
        }
      })
      .finally(() => { if (!cancelled) setLoadingSizes(false); });
    return () => { cancelled = true; };
  }, [picking, catalogue, tenantId, vm, currency, billed]);

  useEffect(() => {
    // A size nobody has chosen yet has nothing to preview.
    if (picking || !targetSku) { setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError('');
    setAcknowledged({});
    previewResize({
      tenant_id: tenantId,
      resource_id: vm.resource_id || vm.id,
      target_sku: targetSku,
      currency,
      // What this VM actually cost, so the review quotes the same saving the
      // fleet table does instead of a list-price figure that can exceed the bill.
      billed_monthly: billed,
    })
      .then((result) => { if (!cancelled) setPlan(result); })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.response?.data?.error?.message
            || err?.response?.data?.detail
            || 'Azure could not be asked about this resize.');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId, vm, targetSku, currency, picking, billed]);

  // Poll the backend record. The operation outlives this component and even
  // this browser tab, so the record — not local state — is the source of truth.
  const poll = useCallback((operationId) => {
    pollRef.current = setInterval(async () => {
      try {
        const next = await fetchResizeOperation(operationId);
        setOperation(next);
        if (!shouldPoll(next)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (next.state === 'SUCCESS') onResized?.();
        }
      } catch {
        // A single failed poll says nothing about the resize itself, so the
        // operation is left running and the next tick tries again.
      }
    }, 4000);
  }, [onResized]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const confirm = async () => {
    setStarting(true);
    setError('');
    try {
      const started = await startResize({
        tenant_id: tenantId,
        resource_id: vm.resource_id || vm.id,
        target_sku: targetSku,
        currency,
      });
      setOperation(started);
      poll(started.operation_id);
    } catch (err) {
      setError(err?.response?.data?.error?.message
        || err?.response?.data?.detail
        || 'The resize could not be started.');
    } finally {
      setStarting(false);
    }
  };

  const pricing = plan?.pricing;
  const saving = savingSummary(pricing);
  const outcome = outcomeOf(operation);
  const steps = stepsOf(operation);
  const running = shouldPoll(operation);

  // Escape and the scroll lock are switched off while the resize is actually
  // running: closing halfway through leaves the reader with no idea whether
  // Azure is still moving their VM.
  const panel = useDialogChrome({ onClose, busy: running });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Review VM Resize"
      ref={panel}
      tabIndex={-1}
    >
      {/* This dialog scrolls as a whole rather than pinning a footer: its
          content changes shape completely between choosing a size, reviewing
          the price and watching the resize run, and a fixed footer would have
          to mean something different in each. `overscroll-contain` stops a
          scroll that runs off the end from carrying on down the page behind. */}
      <div className="my-8 w-full max-w-3xl rounded-xl border border-slate-800 bg-slate-950 shadow-2xl outline-none">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-xl border-b border-slate-800 bg-slate-950 p-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              {operation ? 'Resize in progress' : 'Review VM Resize'}
            </h2>
            <p className="text-xs text-slate-500">{vm.name} · {vm.region}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={running}>
            {operation?.terminal ? 'Close' : 'Cancel'}
          </Button>
        </header>

        <div className="space-y-4 p-4">
          {/* ── choosing a size ────────────────────────────────────────── */}
          {picking && !operation && (
            <>
              {loadingSizes && (
                <p className="py-8 text-center text-sm text-slate-400">
                  Asking Azure which sizes this VM can move to, and what each
                  one costs…
                </p>
              )}

              {sizeError && !loadingSizes && (
                <Callout tone="critical" title="Azure could not be asked">{sizeError}</Callout>
              )}

              {catalogue && !loadingSizes && (
                <>
                  <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2">
                    <p className="text-sm text-slate-200">
                      Currently {catalogue.current?.name}
                      {typeof catalogue.current?.vcpu === 'number'
                        ? ` · ${catalogue.current.vcpu} vCPU` : ''}
                      {typeof catalogue.current?.memory_gb === 'number'
                        ? ` · ${catalogue.current.memory_gb} GiB` : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {optionsSummary(catalogue).text}
                    </p>
                    {billed !== null && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        Savings are measured against this VM’s actual
                        {' '}{formatAmountFull(billed, currency)} / month bill.
                      </p>
                    )}
                    {catalogue.notes?.map((note) => (
                      <p key={note} className="mt-1 text-xs text-amber-300/80">{note}</p>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search sizes…"
                      aria-label="Search sizes"
                      className="min-w-40 flex-1 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
                    />
                    <select
                      value={changeFilter}
                      onChange={(e) => setChangeFilter(e.target.value)}
                      aria-label="Filter by direction"
                      className="rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
                    >
                      <option value="all">All sizes</option>
                      <option value="smaller">Smaller</option>
                      <option value="larger">Larger</option>
                    </select>
                    <label className="flex items-center gap-1.5 text-xs text-slate-400">
                      <input
                        type="checkbox"
                        checked={onlySelectable}
                        onChange={(e) => setOnlySelectable(e.target.checked)}
                      />
                      Only sizes I can use
                    </label>
                  </div>

                  <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {sortOptions(filterOptions(catalogue.options, {
                      search, change: changeFilter, onlySelectable,
                    })).map((option) => (
                      <SizeRow
                        key={option.name}
                        option={option}
                        currency={catalogue.currency || currency}
                        selected={option.name === chosen}
                        onChoose={(name) => { setChosen(name); setPicking(false); }}
                      />
                    ))}
                  </ul>

                  <p className="text-xs leading-relaxed text-slate-500">
                    Sizes, quota, availability and prices are read from your own
                    subscription each time this opens. Prices shown are Azure’s
                    published rates and may differ from your negotiated or
                    reserved rates. Choosing a size opens a read-only review —
                    nothing changes yet.
                  </p>
                </>
              )}
            </>
          )}

          {loading && !picking && (
            <p className="py-8 text-center text-sm text-slate-400">
              Reading this VM, its quota and its price from Azure…
            </p>
          )}

          {error && !loading && !picking && (
            <Callout tone="critical" title="Azure could not be asked">{error}</Callout>
          )}

          {/* ── the review ─────────────────────────────────────────────── */}
          {plan && !operation && !picking && (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-slate-500">
                  Reviewing a change to {targetSku}
                </p>
                <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
                  Choose a different size
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <SizeCard
                  title="Current"
                  sku={plan.current}
                  monthly={pricing?.current_monthly}
                  currency={pricing?.currency || currency}
                  tone="border-slate-800 bg-slate-900/40"
                />
                <SizeCard
                  title={targetSku === targetSkuOf(vm) ? 'Recommended' : 'Selected'}
                  sku={plan.target}
                  monthly={pricing?.target_monthly}
                  currency={pricing?.currency || currency}
                  tone="border-sky-900/60 bg-sky-950/20"
                />
              </div>

              <Block title="Estimated saving">
                <div className="flex items-center justify-center gap-4 py-1">
                  <div className="text-center">
                    <p className="text-xs text-slate-500">Monthly</p>
                    <p className="text-xl font-semibold text-emerald-400">{saving.monthly}</p>
                  </div>
                  <ArrowDown className="h-4 w-4 text-slate-600" />
                  <div className="text-center">
                    <p className="text-xs text-slate-500">Annual</p>
                    <p className="text-xl font-semibold text-emerald-400">{saving.annual}</p>
                  </div>
                </div>
                <p className="mt-1 text-center text-xs text-slate-500">{saving.arithmetic}</p>
                <p className="mt-2 border-t border-slate-800 pt-2 text-xs leading-relaxed text-slate-500">
                  {pricing?.note}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  {plan.cost_scope_note}
                </p>
              </Block>

              <Block title="Checks">
                {/* Confidence rates the *algorithm's* suggestion. Showing it
                    beside a size the user chose themselves would attach a
                    telemetry verdict to a decision telemetry never made. */}
                {targetSku === targetSkuOf(vm) && (
                  <CheckRow
                    label="Recommendation confidence"
                    check={{
                      status: confidence.tone === 'good' ? 'available' : 'unverified',
                      label: confidence.level || 'Not rated',
                      note: confidence.text,
                    }}
                  />
                )}
                <CheckRow label="Quota" check={plan.quota} />
                {plan.quota?.limit !== null && plan.quota?.limit !== undefined && (
                  <dl className="mb-2 rounded-md bg-slate-900/60 px-3 py-2">
                    <Field label="Region"><Value value={plan.quota.region} /></Field>
                    <Field label="Family">
                      <Value value={plan.quota.family_label || plan.quota.family} />
                    </Field>
                    <Field label="Current usage">
                      <Value value={plan.quota.current_usage} suffix=" vCPU" />
                    </Field>
                    <Field label="Quota limit">
                      <Value value={plan.quota.limit} suffix=" vCPU" />
                    </Field>
                    <Field label="Available">
                      <Value value={plan.quota.available} suffix=" vCPU" />
                    </Field>
                    <Field label="Target requirement">
                      <Value value={plan.quota.required} suffix=" vCPU" />
                    </Field>
                  </dl>
                )}
                <CheckRow label="Region / SKU availability" check={plan.availability} />
                <CheckRow label="Compatibility" check={plan.compatibility} />
                <CheckRow label="Your permissions" check={plan.permission} />
              </Block>

              <Callout tone={downtime.tone} title={downtime.title}>
                {downtime.text}
                {vm.power_state === 'running' && (
                  <p className="mt-1.5 text-xs text-amber-200/70">{plan.downtime.duration}</p>
                )}
              </Callout>

              <Block title="What will happen">
                <ol className="space-y-1 text-sm text-slate-300">
                  {plan.plan.map((step, index) => (
                    <li key={step} className="flex gap-2">
                      <span className="text-slate-600">{index + 1}.</span>{step}
                    </li>
                  ))}
                </ol>
              </Block>

              {!plan.can_resize && (
                <Callout tone="critical" title="This resize cannot proceed">
                  <ul className="space-y-1">
                    {plan.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
                  </ul>
                </Callout>
              )}
            </>
          )}

          {/* ── live progress ──────────────────────────────────────────── */}
          {operation && (
            <>
              <div className="flex items-center gap-2">
                <Badge tone={outcome.kind === 'success' ? 'good'
                  : outcome.kind === 'running' ? 'info' : 'critical'}>
                  {operation.state_label}
                </Badge>
                <span className="font-mono text-xs text-slate-500">
                  {operation.old_sku} → {operation.new_sku || targetSku}
                </span>
              </div>

              <Block title="Progress">
                <ol className="space-y-1.5">
                  {steps.map(step => (
                    <li key={step.key} className="flex items-center gap-2 text-sm">
                      <span className="flex h-4 w-4 items-center justify-center">
                        {STEP_ICON[step.status] || (
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />
                        )}
                      </span>
                      <span className={step.status === 'pending'
                        ? 'text-slate-600' : 'text-slate-200'}>
                        {step.label}
                      </span>
                    </li>
                  ))}
                </ol>
              </Block>

              {outcome.kind === 'success' && (
                <Block title="Result">
                  <Callout tone="good" title="VM resized successfully">
                    {outcome.message}
                  </Callout>
                  <dl className="mt-2">
                    <Field label="VM">{operation.vm_name}</Field>
                    <Field label="Previous size">
                      <span className="font-mono">{operation.old_sku}</span>
                    </Field>
                    <Field label="Current size">
                      <span className="font-mono">{operation.new_sku}</span>
                    </Field>
                    <Field label="Previous estimated compute">
                      <Money value={operation.old_monthly_price} currency={operation.currency} />
                    </Field>
                    <Field label="New estimated compute">
                      <Money value={operation.new_monthly_price} currency={operation.currency} />
                    </Field>
                    <Field label="Estimated saving">
                      <Money
                        value={operation.estimated_monthly_saving}
                        currency={operation.currency}
                        className="text-emerald-400"
                      />
                    </Field>
                    <Field label="Power state">
                      <Value value={operation.final_power_state} />
                    </Field>
                    <Field label="Completed"><Value value={operation.completed_at} /></Field>
                  </dl>
                </Block>
              )}

              {(outcome.kind === 'failure' || outcome.kind === 'resized_but_stopped') && (
                <Callout
                  tone="critical"
                  title={outcome.kind === 'resized_but_stopped'
                    ? 'Resize completed, but the VM could not be started.'
                    : 'Resize did not complete'}
                >
                  {outcome.message}
                  <dl className="mt-2">
                    <Field label="Current size">
                      <Value value={operation.new_sku || operation.old_sku} />
                    </Field>
                    <Field label="Power state">
                      <Value value={operation.final_power_state} />
                    </Field>
                  </dl>
                </Callout>
              )}
            </>
          )}
        </div>

        {/* ── the confirmation gate ─────────────────────────────────────── */}
        {plan && !operation && !picking && (
          <footer className="space-y-3 border-t border-slate-800 p-4">
            {plan.can_resize && (
              <div className="space-y-1.5 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                {ACKS.map(([key, text]) => (
                  <label key={key} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={Boolean(acknowledged[key])}
                      onChange={e => setAcknowledged(
                        a => ({ ...a, [key]: e.target.checked }),
                      )}
                    />
                    <span className="text-sm text-amber-100">{text}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button
                onClick={confirm}
                disabled={confirmDisabled({
                  plan, acknowledged: allAcknowledged, starting, operation,
                })}
              >
                {starting ? 'Starting…' : 'Confirm & Resize'}
              </Button>
            </div>
            {!plan.can_resize && (
              <p className="flex items-center justify-end gap-1.5 text-xs text-slate-500">
                <ShieldAlert className="h-3.5 w-3.5" />
                Resize unavailable — see the reasons above.
              </p>
            )}
          </footer>
        )}

        {operation && !running && (
          <footer className="flex justify-end border-t border-slate-800 p-4">
            <Button onClick={onClose}>Close</Button>
          </footer>
        )}

        {running && (
          <footer className="flex items-center gap-2 border-t border-slate-800 p-4 text-xs text-slate-500">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            This operation continues on the server. You can close this page and
            come back to it.
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
