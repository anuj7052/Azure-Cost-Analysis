/** Shared chart card for BOQ and Cost Explorer. Drilldowns attach edge-to-edge. */
export default function SpendPanel({ title, subtitle, children, action }) {
  return <div className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </div>;
}
