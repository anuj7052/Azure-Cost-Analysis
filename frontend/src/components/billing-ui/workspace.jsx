import { Link } from 'react-router-dom';
import { CostTabs } from '../Layout/CostNavigation';
import { SECTIONS } from '../../nav';

const BILLING = SECTIONS.find(section => section.key === 'billing');
import { Menu, ReceiptText } from 'lucide-react';
import { useNav } from '../../store/useNav';

export const billingInput = 'mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
export const billingButton = 'inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
export const billingSecondary = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50';
export const billingPanel = 'rounded-xl border border-slate-800 bg-slate-900 p-5 sm:p-6';

export function BillingTopbar() {
  const openNav = useNav(s => s.openNav);
  return <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-800 bg-slate-900 px-4 sm:px-6">
    <div className="flex items-center gap-3"><button onClick={openNav} className="rounded-lg p-2 text-slate-300 lg:hidden" aria-label="Open navigation"><Menu size={20} /></button><ReceiptText size={20} className="text-[#ea580c]" /><Link to="/azure-billing/dashboard" className="text-sm font-semibold text-slate-100">Azure Billing</Link><span className="hidden text-xs text-slate-500 sm:inline">Your customer billing workspace</span></div>

  </header>;
}

export function BillingPage({ title, description, actions, children }) {
  return <div className="billing-workspace mx-auto max-w-screen-2xl space-y-6 p-4 text-slate-100 sm:p-6 lg:p-8">
    <div className="rounded-xl border border-slate-800 bg-slate-900 px-2 py-1.5 shadow-sm"><CostTabs items={BILLING.items} label="Billing workspace" /></div>
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
