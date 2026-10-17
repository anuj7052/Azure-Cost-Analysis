// Adapted from shadcn/ui (MIT, Copyright (c) 2023 shadcn) — Button, Badge,
// Input, Select (native trigger styling), Tabs (list/trigger), Label.
// https://ui.shadcn.com/docs/components
// JSX and colour tokens adapted to the Cloudledger theme so light/dark mode
// keep working through the existing slate remapping. Brand accent is orange.
import { forwardRef } from 'react';

const cx = (...parts) => parts.filter(Boolean).join(' ');
const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--app-bg)]';

const BUTTON_VARIANTS = {
  default: 'bg-[#EA580C] text-white shadow-sm hover:bg-[#c2410c]',
  secondary: 'bg-slate-800 text-slate-100 hover:bg-slate-700',
  outline: 'border border-slate-700 bg-slate-900 text-slate-200 shadow-sm hover:bg-slate-800 hover:text-slate-100',
  ghost: 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
  active: 'border border-[#fdba74] bg-[#ffedd5] text-[#9a3412] shadow-sm',
};
const BUTTON_SIZES = { default: 'h-9 px-4 py-2 text-sm', sm: 'h-8 rounded-md px-3 text-xs', lg: 'h-10 px-6 text-sm', icon: 'h-9 w-9' };

export const Button = forwardRef(({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cx('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0', ring, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
    {...props}
  />
));
Button.displayName = 'Button';

const BADGE_VARIANTS = {
  default: 'border-transparent bg-[#ffedd5] text-[#9a3412]',
  secondary: 'border-transparent bg-slate-800 text-slate-300',
  outline: 'border-slate-700 text-slate-300',
};
export function Badge({ className, variant = 'default', ...props }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium', BADGE_VARIANTS[variant], className)} {...props} />;
}

export const Input = forwardRef(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cx('flex h-9 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1 text-sm text-slate-100 shadow-sm transition-colors placeholder:text-slate-500', ring, className)}
    {...props}
  />
));
Input.displayName = 'Input';

export function Label({ className, ...props }) {
  return <label className={cx('text-xs font-medium text-slate-400', className)} {...props} />;
}

/** Native <select> with the shadcn SelectTrigger look; keeps full keyboard and mobile support. */
export const NativeSelect = forwardRef(({ className, children, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cx('h-9 w-full appearance-none truncate rounded-md border border-slate-700 bg-slate-900 py-1 pl-3 pr-8 text-sm text-slate-100 shadow-sm', ring, className)}
      {...props}
    >
      {children}
    </select>
    <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
  </div>
));
NativeSelect.displayName = 'NativeSelect';

/** shadcn TabsList + TabsTrigger, driven by `value`/`onValueChange`. */
export function TabsList({ items, value, onValueChange, label, className, size = 'default' }) {
  const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  return (
    <div role="tablist" aria-label={label} className={cx('inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-slate-800/70 p-1 text-slate-400', className)}>
      {items.map(item => {
        const on = item.value === value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onValueChange(item.value)}
            className={cx('inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-all', pad, ring,
              on ? 'bg-slate-900 text-[#c2410c] shadow-sm ring-1 ring-slate-700/60' : 'hover:text-slate-100')}
          >
            {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {item.label}
            {item.count != null && <span className={cx('rounded px-1.5 text-[10px] font-semibold tabular-nums', on ? 'bg-[#ffedd5] text-[#9a3412]' : 'bg-slate-700/60 text-slate-300')}>{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
