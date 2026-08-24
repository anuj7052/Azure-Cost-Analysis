import { Server, Info } from 'lucide-react';
import { formatAmount } from '../../utils/currency';

/**
 * Resource group, service, size, cost — the four columns that answer
 * "who spent this".
 *
 * Deliberately plain. The expandable per-meter tables elsewhere give depth;
 * this one exists so the answer is legible at a glance, which is what the
 * question actually deserves.
 */
export default function ResourceCostTable({ rows, currency, dense = false, emptyNote }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="flex gap-2 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3 text-xs text-slate-400">
        <Info size={14} className="mt-0.5 shrink-0 text-slate-500" />
        <span>{emptyNote || 'Azure did not attribute this charge to a named resource.'}</span>
      </div>
    );
  }

  const pad = dense ? 'py-1.5' : 'py-2';

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-700/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className={`${pad} pr-3 font-medium`}>Service</th>
            <th className={`${pad} pr-3 font-medium`}>Resource group</th>
            <th className={`${pad} pr-3 text-right font-medium`}>Data size</th>
            <th className={`${pad} text-right font-medium`}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-slate-800/60 last:border-0">
              <td className={`${pad} pr-3`}>
                <div className="flex items-center gap-2">
                  <Server size={13} className="shrink-0 text-sky-400" />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-200">{row.name}</div>
                    <div className="truncate text-[10px] text-slate-500">
                      {row.kind}
                      {row.region && ` · ${row.region}`}
                    </div>
                  </div>
                </div>
              </td>
              <td className={`${pad} pr-3 text-slate-400`}>
                {row.resource_group || '—'}
              </td>
              <td className={`${pad} pr-3 text-right tabular-nums text-slate-300`}>
                {/* A meter billed by the hour has a cost but no size. Saying
                    "0 GB" would imply it moved nothing worth charging for. */}
                {row.gb ? `${row.gb.toLocaleString(undefined, { maximumFractionDigits: 2 })} GB` : '—'}
              </td>
              <td className={`${pad} text-right tabular-nums font-medium text-slate-100`}>
                {formatAmount(row.cost, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
