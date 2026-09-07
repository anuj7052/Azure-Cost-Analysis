import { useState } from 'react';
import { ChevronDown, Filter, Search, X } from 'lucide-react';

/**
 * The filter controls shared by every table on the BOQ page.
 *
 * These lived inside the Full breakdown panel, which meant the category table
 * above it had to grow its own. Two filter bars over the same money, built
 * from different parts and behaving differently, teach a reader that the two
 * tables are unrelated tools -- and they are not, they are one bill shown
 * twice. So the controls are defined once here and imported by both, and any
 * change to how filtering looks or behaves lands in both places at once.
 */

/** A multi-select filter rendered as a compact dropdown of checkboxes. */
export function MultiFilter({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  // Nothing to choose between: a filter offering one option filters nothing
  // and costs a reader the time it takes to find that out.
  if (options.length <= 1) return null;

  const toggle = (value) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
          selected.size > 0
            ? 'border-blue-500/30 bg-blue-600/20 text-blue-300'
            : 'border-slate-800 text-slate-400 hover:bg-slate-800/60 hover:text-white'
        }`}
      >
        {label}
        {selected.size > 0 && <span className="text-blue-400">{selected.size}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-xl animate-scale-in">
            {selected.size > 0 && (
              <button
                onClick={() => onChange(new Set())}
                className="mb-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                Clear {label.toLowerCase()}
              </button>
            )}
            {options.map(opt => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                <input
                  type="checkbox"
                  checked={selected.has(opt)}
                  onChange={() => toggle(opt)}
                  className="accent-blue-500"
                />
                <span className="truncate" title={opt}>{opt}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A single-choice filter — the verdict a row is being judged on. */
export function FilterSelect({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 focus:border-blue-500/40 focus:outline-none"
    >
      {options.map(o => (
        <option key={o.key} value={o.key}>{o.label}</option>
      ))}
    </select>
  );
}

export function SearchBox({ value, onChange, placeholder, width = 'w-56' }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${width} rounded-lg border border-slate-800 bg-slate-900 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus:border-blue-500/40 focus:outline-none`}
      />
    </div>
  );
}

/**
 * Counts what is currently hidden. A filtered table and a small estate look
 * identical, so the number of active filters is always on screen when there
 * is one.
 */
export function ClearFilters({ count, onClear }) {
  if (!count) return null;
  return (
    <button
      onClick={onClear}
      className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-400 transition hover:bg-slate-700 hover:text-white"
    >
      <X className="h-3 w-3" />
      Clear {count}
    </button>
  );
}

/** A labelled row of controls: the `GROUP BY` and `FILTER` bands. */
export function ControlRow({ label, children }) {
  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** The funnel that opens the filter band, so both bars start the same way. */
export function FilterIcon() {
  return <Filter className="h-3.5 w-3.5 text-slate-600" />;
}

/** A pill in a single-choice row, as used by `Group by`. */
export function PillButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        active
          ? 'border border-blue-500/30 bg-blue-600/25 text-blue-300'
          : 'border border-slate-800 text-slate-400 hover:bg-slate-800/60 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}
