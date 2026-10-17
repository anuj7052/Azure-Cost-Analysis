import { Fragment, useState } from 'react';
import { CheckCircle2, ChevronRight, FileSpreadsheet, Scale, Search } from 'lucide-react';
import BoqCategoryDetail from './BoqCategoryDetail';

/**
 * Plain-language layer for BOQ vs Actual, for readers who are not cloud or
 * finance specialists: what the page does, the answer in one sentence, and
 * what each term means. The detailed sections below stay unchanged.
 */

export function BoqHowItWorks({ hasEstimate }) {
  const steps = [
    { icon: FileSpreadsheet, title: 'Add your plan', text: 'Upload the estimate you made in the Azure Pricing Calculator. This is what you expected to pay.' },
    { icon: Scale, title: 'We compare', text: 'We line it up against what Azure actually billed for the dates selected at the top of the page.' },
    { icon: Search, title: 'See the gaps', text: 'You see where you paid more, less, or for things that were never in the plan.' },
  ];
  return (
    <section aria-label="How this page works" className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-sm font-semibold text-slate-100">How this works</h2>
      <ol className="mt-4 grid gap-4 md:grid-cols-3">
        {steps.map((step, index) => {
          const done = index === 0 && hasEstimate;
          return (
            <li key={step.title} className="flex gap-3">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${done ? 'bg-emerald-500/15 text-emerald-300' : 'bg-[#ffedd5] text-[#9a3412]'}`}>
                {done ? <CheckCircle2 className="h-4 w-4" aria-label="Done" /> : index + 1}
              </span>
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-100"><step.icon className="h-4 w-4 text-[#ea580c]" aria-hidden="true" />{step.title}</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">{step.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * How the headline numbers are built, category by category, so the totals on
 * this page visibly add up. A category groups several Azure services, which is
 * why a category amount never matches a single service or resource amount.
 */
export function BoqReconcile({ report, fmt, per, query }) {
  const cats = (report.categories || []).filter(c => (c.budgeted || 0) !== 0 || (c.actual || 0) !== 0);
  const status = c => {
    if (c.key === 'reconciliation') return ['Billing difference', 'text-slate-400'];
    if (!(c.budgeted > 0)) return ['Not in plan', 'text-rose-400'];
    if (!(c.actual > 0)) return ['Not used', 'text-slate-400'];
    if (c.variance > 0) return ['Over plan', 'text-rose-400'];
    if (c.variance < 0) return ['Under plan', 'text-emerald-400'];
    return ['On plan', 'text-slate-300'];
  };
  const sum = key => cats.reduce((total, c) => total + (Number(c[key]) || 0), 0);
  const over = cats.filter(c => c.variance > 0).reduce((t, c) => t + c.variance, 0);
  const under = cats.filter(c => c.variance < 0).reduce((t, c) => t - c.variance, 0);
  const rows = [...cats].sort((a, b) => (b.actual || 0) - (a.actual || 0));
  const diff = report.actualTotal - report.budgetTotal;
  const [open, setOpen] = useState(null);

  return (
    <section aria-labelledby="boq-reconcile-title" className="rounded-2xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 p-5">
        <h2 id="boq-reconcile-title" className="text-base font-semibold text-slate-100">How the numbers add up</h2>
        <p className="mt-1 text-sm text-slate-400">Every amount on this page comes from the same total, {per}. A <strong className="text-slate-300">category</strong> (for example Compute) groups several Azure services, so a category amount will not match one service or one resource — but every view adds up to the same billed total.</p>
      </div>

      <ol className="grid gap-px bg-slate-800 sm:grid-cols-5">
        {[
          ['Planned', fmt(report.budgetTotal), 'text-slate-100', ''],
          ['+ Over plan', fmt(over), 'text-rose-400', 'Categories that cost more than planned, including ones never planned'],
          ['− Under plan', fmt(under), 'text-emerald-400', 'Categories that cost less, or were not used'],
          ['= Billed', fmt(report.actualTotal), 'text-slate-100', 'What Azure charged'],
          [diff > 0 ? 'Paid more by' : 'Paid less by', fmt(Math.abs(diff)), diff > 0 ? 'text-rose-400' : 'text-emerald-400', 'Billed minus planned'],
        ].map(([label, value, tone, hint]) => (
          <li key={label} className="bg-slate-900 p-4">
            <p className="text-xs text-slate-400">{label}</p>
            <p className={`mt-1 text-lg font-bold tabular-nums ${tone}`}>{value}</p>
            {hint && <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{hint}</p>}
          </li>
        ))}
      </ol>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Planned and billed amount for each category</caption>
          <thead>
            <tr className="border-y border-slate-800 text-left text-xs text-slate-500">
              <th className="px-5 py-2.5 font-medium">Category</th>
              <th className="px-3 py-2.5 text-right font-medium">Planned</th>
              <th className="px-3 py-2.5 text-right font-medium">Billed</th>
              <th className="px-3 py-2.5 text-right font-medium">Difference</th>
              <th className="px-5 py-2.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const [text, tone] = status(c);
              return (
                <Fragment key={c.key}>
                <tr className={`border-b border-slate-800/60 hover:bg-slate-800/30 ${open === c.key ? 'bg-slate-800/40' : ''}`}>
                  <td className="px-5 py-2.5">
                    <button type="button" aria-expanded={open === c.key} onClick={() => setOpen(open === c.key ? null : c.key)} className="flex items-center gap-2 text-left font-medium text-slate-200 hover:text-[#c2410c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]">
                      <ChevronRight className={`h-4 w-4 shrink-0 text-[#ea580c] transition-transform ${open === c.key ? 'rotate-90' : ''}`} aria-hidden="true" />{c.label}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{c.budgeted ? fmt(c.budgeted) : '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-100">{fmt(c.actual || 0)}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${c.variance > 0 ? 'text-rose-400' : c.variance < 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{c.variance > 0 ? '+' : c.variance < 0 ? '−' : ''}{fmt(Math.abs(c.variance || 0))}</td>
                  <td className={`px-5 py-2.5 text-xs font-medium ${tone}`}>{text}</td>
                </tr>
                {open === c.key && (
                  <tr className="border-b border-slate-800">
                    <td colSpan={5} className="bg-slate-950/40 px-5 py-5">
                      <BoqCategoryDetail category={c} fmt={fmt} per={per} query={query} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-700 font-semibold">
              <td className="px-5 py-3 text-slate-100">Total</td>
              <td className="px-3 py-3 text-right tabular-nums text-slate-100">{fmt(sum('budgeted'))}</td>
              <td className="px-3 py-3 text-right tabular-nums text-slate-100">{fmt(sum('actual'))}</td>
              <td className={`px-3 py-3 text-right tabular-nums ${diff > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{diff > 0 ? '+' : '−'}{fmt(Math.abs(sum('actual') - sum('budgeted')))}</td>
              <td className="px-5 py-3" />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="border-t border-slate-800 px-5 py-3 text-[11px] leading-5 text-slate-500">
        “Billing difference” is the small gap between Azure’s monthly total and its detailed line items; it is shown so the totals still match the Dashboard. Click a category to see what it is made of.
      </p>
    </section>
  );
}
