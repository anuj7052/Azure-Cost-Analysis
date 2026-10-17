import { useEffect, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { typesFor, useBillingTypes } from '../../utils/billingTypes';

/*
 * What one BOQ category is made of, in plain words:
 *   1. lines from the estimate and what Azure billed against each,
 *   2. charges no estimate line covers,
 *   3. how Azure billed each service (Reserved / Pay-as-you-go / Savings plan),
 *      read from Azure's own PricingModel — never guessed from names.
 * DR / ASR is only marked where the Azure service is literally Site Recovery.
 */

const isAsr = text => /site recovery/i.test(String(text || ''));

function Tag({ tone, children }) {
  const tones = {
    ri: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    payg: 'bg-[#ffedd5] text-[#9a3412] ring-[#fdba74]',
    sp: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    asr: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
    none: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    ok: 'bg-slate-800 text-slate-300 ring-slate-700',
  };
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${tones[tone]}`}>{children}</span>;
}

function Section({ title, hint, children }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

const TYPE_TAGS = { ri: ['ri', 'RI'], payg: ['payg', 'PAYG'], asr: ['asr', 'DR / ASR'] };

function ChargeTags({ item, index, loading }) {
  const types = typesFor(index, item);
  return (
    <>
      {types.map(type => <Tag key={type} tone={TYPE_TAGS[type][0]}>{TYPE_TAGS[type][1]}</Tag>)}
      {!types.length && (loading ? <span className="text-[10px] text-slate-500">checking type…</span> : index && <Tag tone="ok">Type not reported</Tag>)}
    </>
  );
}

export default function BoqCategoryDetail({ category: c, fmt, per, query }) {
  const billing = useBillingTypes(query);
  const pricing = useAppStore(s => s.pricingData);
  const pricingLoading = useAppStore(s => s.pricingLoading);
  const loadPricing = useAppStore(s => s.loadPricing);
  const imported = useAppStore(s => s.imported);
  useEffect(() => { if (!pricing && !imported) loadPricing(); }, [pricing, imported, loadPricing]);

  const planLines = [...(c.lines || []), ...(c.pooledLines || [])];
  const notCovered = c.unmatched || [];
  const covered = (c.actual || 0) - (c.unmatchedTotal || 0);
  const pooled = (c.pooledBudget || 0) > 0;
  const groupGap = (c.unmatchedTotal || 0) - (c.pooledBudget || 0);
  const models = useMemo(() => {
    const byName = Object.fromEntries((pricing?.services || []).map(s => [s.service, s]));
    return (c.actualServices || []).map(s => ({ ...s, model: byName[s.name] || null }));
  }, [pricing, c.actualServices]);

  if (c.key === 'reconciliation') {
    return (
      <p className="flex gap-2 text-sm text-slate-300"><Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
        Azure&apos;s monthly total is {fmt(c.actual)} higher than the sum of its detailed line items. This is not a resource or a saving — it is shown only so every total on the page matches the Dashboard.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {/* One-sentence answer */}
      <p className="text-sm leading-6 text-slate-300">
        {c.budgeted > 0 ? <>You planned <strong className="text-slate-100">{fmt(c.budgeted)}</strong> for {c.label}</> : <>Your estimate had <strong className="text-rose-300">nothing planned</strong> for {c.label}</>}
        {' '}and Azure billed <strong className="text-slate-100">{fmt(c.actual)}</strong> ({per}).{' '}
        {c.actual > 0 && !pooled && <>Of that, <strong className="text-slate-100">{fmt(covered)}</strong> matches lines in your estimate and <strong className={notCovered.length ? 'text-rose-300' : 'text-slate-100'}>{fmt(c.unmatchedTotal || 0)}</strong> is not covered by any line.</>}
        {c.actual > 0 && pooled && <>Of that, <strong className="text-slate-100">{fmt(covered)}</strong> matches a specific estimate line. The other <strong className="text-slate-100">{fmt(c.unmatchedTotal || 0)}</strong> is compared as a group with your <strong className="text-slate-100">{fmt(c.pooledBudget)}</strong> of group lines (backup, site recovery, support — Azure does not bill these per named item), so it is <strong className={groupGap > 0 ? 'text-rose-300' : 'text-emerald-300'}>{fmt(Math.abs(groupGap))} {groupGap > 0 ? 'over' : 'under'}</strong> those lines.</>}
        {c.unused && ' None of it was used.'}
      </p>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="1 · In your estimate" hint="Each line you planned, and what Azure billed for it.">
          {!planLines.length ? <p className="text-sm text-slate-500">No lines in your estimate for this category.</p> : (
            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
              {planLines.map(line => {
                const pooled = !line.hasSku && line.matches?.length === 0;
                return (
                  <li key={line.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-200" title={line.description}>{line.custom_name || line.service_type || 'Estimate line'}</p>
                        <p className="truncate text-[11px] text-slate-500">{line.service_type}{line.boq ? ` · ${line.boq}` : ''}</p>
                      </div>
                      <div className="shrink-0 text-right text-xs tabular-nums">
                        <p className="text-slate-400">Planned {fmt(line.monthly_cost)}</p>
                        {pooled
                          ? <p className="text-slate-500">compared as a group</p>
                          : <p className={line.variance > 0 ? 'text-rose-400' : 'text-emerald-400'}>Billed {fmt(line.actual)}</p>}
                      </div>
                    </div>
                    {!pooled && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        {line.matched ? `${line.billedCount} resource${line.billedCount === 1 ? '' : 's'} billed${line.budgetQty ? `, ${line.budgetQty} planned` : ''}` : 'Nothing billed against this line'}
                        {line.matches?.length > 0 && <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">{[...new Set(line.matches.flatMap(m => typesFor(billing.index, m)))].map(type => <Tag key={type} tone={TYPE_TAGS[type][0]}>{TYPE_TAGS[type][1]}</Tag>)}</span>}
                        {!line.matches?.length && isAsr(line.service_type) && <> · <Tag tone="asr">DR / ASR</Tag></>}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={pooled ? '2 · Compared with your group lines' : '2 · Not covered by your estimate'} hint={pooled ? `No exact line matches these charges, so they are checked together against ${fmt(c.pooledBudget)} of group lines in your estimate.` : 'Charged by Azure, but no line in your estimate pays for it.'}>
          {!notCovered.length ? (
            <p className="flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />Everything billed here is covered by your estimate.</p>
          ) : (
            <ul className={`max-h-80 divide-y divide-slate-800 overflow-y-auto rounded-lg border ${pooled ? 'border-slate-800' : 'border-rose-500/30'}`}>
              {notCovered.map(item => (
                <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200" title={item.label}>{item.resource_name || item.label}</p>
                    <p className="truncate text-[11px] text-slate-500">{item.resource_name ? item.label : ''}{item.resource_group ? `${item.resource_name ? ' · ' : ''}${item.resource_group}` : ''}</p>
                    <p className="mt-1 flex flex-wrap gap-1">{pooled ? <Tag tone="ok">Group line</Tag> : <Tag tone="none">Not in BOQ</Tag>}<ChargeTags item={item} index={billing.index} loading={billing.loading} />{item.cost < 0 && <Tag tone="ok">Credit</Tag>}</p>
                  </div>
                  <p className={`shrink-0 text-sm font-semibold tabular-nums ${pooled ? 'text-slate-100' : 'text-rose-300'}`}>{fmt(item.cost)}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {billing.error && <p className="text-[11px] text-amber-300">RI / PAYG could not be read: {billing.error}</p>}

      <Section title="3 · How Azure billed these services" hint="How each service was paid for, as a share of that service's whole bill (Azure's own pricing model). RI = reserved instance, PAYG = pay-as-you-go, DR / ASR = Azure Site Recovery.">
        {!models.length ? <p className="text-sm text-slate-500">No services billed in this category.</p> : (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="px-3 py-2 font-medium">Service</th>
                  <th className="px-3 py-2 text-right font-medium">In this view</th>
                  <th className="px-3 py-2 text-right font-medium">RI share</th>
                  <th className="px-3 py-2 text-right font-medium">PAYG share</th>
                  <th className="px-3 py-2 text-right font-medium">Savings plan share</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {models.map(s => {
                  const m = s.model;
                  const whole = m ? (m.reserved || 0) + (m.on_demand || 0) + (m.savings_plan || 0) + (m.spot || 0) : 0;
                  const share = v => (!m ? '…' : !v || !whole ? '—' : `${Math.round((v / whole) * 100)}%`);
                  const types = [];
                  if (m?.reserved) types.push(<Tag key="ri" tone="ri">RI</Tag>);
                  if (m?.on_demand) types.push(<Tag key="payg" tone="payg">PAYG</Tag>);
                  if (m?.savings_plan) types.push(<Tag key="sp" tone="sp">Savings plan</Tag>);
                  if (isAsr(s.name)) types.push(<Tag key="asr" tone="asr">DR / ASR</Tag>);
                  return (
                    <tr key={s.name} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-3 py-2 text-slate-200">{s.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-100">{fmt(s.cost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-300">{share(m?.reserved)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-300">{share(m?.on_demand)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-300">{share(m?.savings_plan)}</td>
                      <td className="px-3 py-2"><span className="flex flex-wrap gap-1">{types.length ? types : <span className="text-xs text-slate-500">{pricing ? 'Not reported' : ''}</span>}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pricingLoading && !pricing && <p className="mt-2 flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />Reading the pricing model from Azure…</p>}
        {pricing && !pricing.has_pricing_data && <p className="mt-2 flex items-center gap-2 text-xs text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />Azure did not report a pricing model for this scope, so RI and PAYG cannot be separated.</p>}
      </Section>
    </div>
  );
}
