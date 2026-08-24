/**
 * Design tokens.
 *
 * Split from the components purely because `react-refresh/only-export-components`
 * requires a module to export components or plain values, never both. Keeping
 * the palette here also makes it importable by non-component code (chart
 * config, table cell formatters) without pulling React in.
 *
 * Colour is authored dark-first against the Tailwind slate ramp; `index.css`
 * remaps those tokens for the light theme, so nothing here needs a light
 * variant and nothing here may be a raw hex value.
 */

/**
 * The severity palette — one vocabulary for the whole product.
 *
 * `chip` for a filled badge, `text` for standalone wording, `bar` for a card's
 * left accent rule, `ring` for a bordered surface, `dot` for a status dot.
 * A page that invents its own red teaches the user that red means nothing.
 */
export const TONE = {
  critical: {
    chip: 'bg-red-500/15 text-red-300 border-red-500/30',
    text: 'text-red-300', bar: 'border-l-red-500', ring: 'border-red-500/30',
    dot: 'bg-red-500', label: 'Critical',
  },
  high: {
    chip: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
    text: 'text-orange-300', bar: 'border-l-orange-500', ring: 'border-orange-500/30',
    dot: 'bg-orange-500', label: 'High',
  },
  medium: {
    chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    text: 'text-amber-300', bar: 'border-l-amber-500', ring: 'border-amber-500/30',
    dot: 'bg-amber-500', label: 'Medium',
  },
  low: {
    chip: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    text: 'text-sky-300', bar: 'border-l-sky-500', ring: 'border-sky-500/30',
    dot: 'bg-sky-500', label: 'Low',
  },
  info: {
    chip: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    text: 'text-blue-300', bar: 'border-l-blue-500', ring: 'border-blue-500/30',
    dot: 'bg-blue-500', label: 'Info',
  },
  good: {
    chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    text: 'text-emerald-300', bar: 'border-l-emerald-500', ring: 'border-emerald-500/30',
    dot: 'bg-emerald-500', label: 'Healthy',
  },
  neutral: {
    chip: 'bg-slate-800 text-slate-400 border-slate-700',
    text: 'text-slate-400', bar: 'border-l-slate-700', ring: 'border-slate-800',
    dot: 'bg-slate-600', label: 'None',
  },
};

/** Falls back to `neutral` so an unrecognised severity renders grey, not blank. */
export const tone = (name) => TONE[name] || TONE.neutral;

export const BUTTON_VARIANT = {
  primary: 'bg-blue-600 text-white hover:bg-blue-500 disabled:hover:bg-blue-600',
  secondary: 'border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100',
  ghost: 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};

export const BUTTON_SIZE = {
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
};
