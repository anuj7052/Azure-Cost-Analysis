import { useState } from 'react';
import CostChangeExplainer from './CostChangeExplainer';
import CostDeltaDetails from './CostDeltaDetails';
import { comparisonMonths, resolveMonthPair } from '../../utils/monthCompare';
import { Callout, EmptyState, Panel, Select, TableSkeleton } from '../ui';

export default function MonthCompare({ months = [], currency, loading = false, filtered = false, coverage = null, currentMonth }) {
  const [choice, setChoice] = useState({ baseline: '', selected: '' });
  const ordered = comparisonMonths(months);
  const pair = resolveMonthPair(ordered, choice.baseline, choice.selected);
  if (loading) return <Panel title="Loading monthly comparison"><TableSkeleton rows={6} cols={4} /></Panel>;
  if (ordered.length < 2) return <EmptyState title="Choose at least two months" description="Widen the date range in the header to compare two returned billing months. Missing months are not assumed to cost zero." />;
  const prior = ordered.find(row => row.month === pair.baseline);
  const current = ordered.find(row => row.month === pair.selected);
  const options = ordered.map(row => ({ value: row.month, label: row.month }));
  return (
    <Panel title="Month compare" hint="Compare any two returned months. Change is selected month minus baseline.">
      <div className="flex flex-wrap gap-3">
        <Select label="Baseline month" value={pair.baseline} options={options.filter(option => option.value !== pair.selected)} onChange={baseline => setChoice({ ...pair, baseline })} />
        <Select label="Selected month" value={pair.selected} options={options} onChange={selected => setChoice(resolveMonthPair(ordered, pair.baseline, selected))} />
      </div>
      {(pair.baseline === currentMonth || pair.selected === currentMonth) && <Callout tone="medium" title="Current month is partial">This month is still being billed; comparison with a completed month is not like-for-like.</Callout>}
      <p className="mt-3 text-xs text-slate-400">A date range starting or ending within a month can also contain partial months. Compare equivalent billing coverage before drawing conclusions.</p>
      {filtered && <Callout tone={coverage !== null && coverage < 0.95 ? 'medium' : 'info'} title="Showing a filtered slice of the bill">Totals and service deltas are re-summed from matching meter rows, not the full invoice.{coverage !== null && coverage < 0.95 && <> Meter rows cover about {Math.round(coverage * 100)}% of the real total for this range; treat these figures as a floor.</>}</Callout>}
      <div className="mt-4">
        <CostChangeExplainer current={current} prior={prior} label={pair.selected} priorLabel={pair.baseline} currency={currency} totalKey="total_cost" partial={pair.selected === currentMonth} priorPartial={pair.baseline === currentMonth} />
      </div>
      <CostDeltaDetails current={current} prior={prior} label={pair.selected} priorLabel={pair.baseline} currency={currency} totalKey="total_cost" />
    </Panel>
  );
}