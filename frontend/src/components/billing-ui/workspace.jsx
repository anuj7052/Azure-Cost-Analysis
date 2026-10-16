import { Link, NavLink } from 'react-router-dom';
import { Menu, Moon, Sun, ReceiptText } from 'lucide-react';
import { useTheme } from '../../store/useTheme';
import { useNav } from '../../store/useNav';

export const billingInput = 'mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
export const billingButton = 'inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
export const billingSecondary = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50';
export const billingPanel = 'rounded-xl border border-slate-800 bg-slate-900 p-5 sm:p-6';

export function BillingTopbar() {
  const theme = useTheme(s => s.theme);
  const toggleTheme = useTheme(s => s.toggleTheme);
  const openNav = useNav(s => s.openNav);
  return <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-800 bg-slate-900 px-4 sm:px-6">
    <div className="flex items-center gap-3"><button onClick={openNav} className="rounded-lg p-2 text-slate-300 lg:hidden" aria-label="Open navigation"><Menu size={20} /></button><ReceiptText size={20} className="text-blue-400" /><Link to="/azure-billing/dashboard" className="text-sm font-semibold text-slate-100">Azure Billing</Link><span className="hidden text-xs text-slate-500 sm:inline">Your customer billing workspace</span></div>
    <button onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} className="rounded-lg border border-slate-700 p-2 text-slate-300">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
  </header>;
}

export function BillingPage({ title, description, actions, children }) {
  return <div className="billing-workspace mx-auto max-w-screen-2xl space-y-6 p-4 text-slate-100 sm:p-6 lg:p-8">
    <nav aria-label="Billing workspace" className="flex flex-wrap gap-1 border-b border-slate-800 pb-3">{[
      ['/azure-billing/dashboard', 'Overview'], ['/azure-billing', 'Customers'], ['/azure-billing/settings', 'Settings'],
    ].map(([to, label]) => <NavLink key={to} to={to} end className={({ isActive }) => `rounded-lg px-4 py-2 text-sm font-medium ${isActive ? 'bg-blue-500/10 text-blue-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>{label}</NavLink>)}</nav>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>{description && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{description}</p>}</div>{actions && <div className="flex flex-wrap gap-2">{actions}</div>}</div>
    {children}
  </div>;
}

export function BillingNotice({ children, error = false }) {
  return <p role={error ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm leading-6 ${error ? 'border-rose-500/30 bg-rose-500/5 text-rose-300' : 'border-blue-500/20 bg-blue-500/5 text-slate-300'}`}>{children}</p>;
}

export function BillingEmpty({ title, children, action }) {
  return <div className="rounded-xl border border-dashed border-slate-700 px-6 py-12 text-center"><ReceiptText className="mx-auto mb-4 text-slate-500" size={28} /><h3 className="font-semibold text-slate-200">{title}</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">{children}</p>{action && <div className="mt-5">{action}</div>}</div>;
}
