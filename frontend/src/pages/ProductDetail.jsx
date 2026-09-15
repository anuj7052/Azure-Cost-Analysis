import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Check, Cloud, Moon, Sun } from 'lucide-react';
import { PRODUCTS, productPath } from '../content/products';
import { SECTIONS } from '../nav';
import { useTheme } from '../store/useTheme';

export default function ProductDetail() {
  const { pathname } = useLocation();
  const product = PRODUCTS.find(p => productPath(p) === `${pathname.replace(/\/$/, '')}/`);
  const theme = useTheme(s => s.theme);
  const toggleTheme = useTheme(s => s.toggleTheme);
  useEffect(() => { document.title = `${product ? `Azure ${product.label}` : 'Feature not found'} | Cloudledger`; }, [product]);
  const section = SECTIONS.find(s => s.key === product?.key);
  return <div className="marketing aca-motion min-h-screen bg-slate-950 text-white">
    <header className="border-b border-slate-800"><nav aria-label="Main navigation" className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5">
      <a href="/" className="flex items-center gap-2 font-bold"><Cloud className="text-blue-400" /> CLOUDLEDGER</a>
      <div className="flex items-center gap-5 text-sm"><a href="/#features">Product</a><a href="/guides/">Guides</a><a href="/login">Sign in</a><button onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} className="rounded-lg border border-slate-700 p-2">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div>
    </nav></header>
    <main className="mx-auto max-w-6xl px-6 py-14 sm:py-20">
      <nav aria-label="Breadcrumb" className="mb-10 text-sm text-slate-400"><a href="/">Home</a> / <a href="/#features">Product</a> / {product?.label || 'Not found'}</nav>
      {!product ? <><h1 className="text-4xl font-semibold">Feature not found</h1><a href="/#features" className="mt-6 block text-blue-400">Explore the product →</a></> : <>
        <div className="grid items-start gap-10 lg:grid-cols-[1.4fr_1fr]">
          <div><p className="marketing-eyebrow">{product.audience}</p><h1 className="mt-4 text-4xl font-semibold leading-tight sm:text-6xl">{product.title}</h1><p className="mt-6 text-lg leading-8 text-slate-300">{product.description}</p><a href="/login" className="mt-8 inline-flex items-center gap-3 rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white">Explore with your Azure account <ArrowRight size={18} /></a></div>
          <aside className="marketing-panel rounded-3xl border border-blue-500/30 p-8"><section.icon className="mb-8 h-10 w-10 text-blue-400" /><h2 className="text-2xl font-semibold">{product.outcome}</h2><ol className="mt-6 space-y-5">{product.steps.map((step, i) => <li key={step} className="flex gap-3 text-slate-300"><span className="text-blue-400">0{i + 1}</span>{step}</li>)}</ol></aside>
        </div>
        <div className="mt-20 grid gap-10 lg:grid-cols-[220px_1fr]">
          <nav aria-label="Feature details" className="self-start rounded-2xl border border-slate-800 p-5 lg:sticky lg:top-6"><p className="mb-4 font-semibold">In this product area</p>{section.items.filter(i => !i.overview).map(item => <a key={item.to} href={`#${item.to.slice(1)}`} className="block py-2 text-sm text-slate-400 hover:text-blue-400">{item.label}</a>)}</nav>
          <div className="space-y-6">{section.items.filter(i => !i.overview).map(item => <section key={item.to} id={item.to.slice(1)} className="scroll-mt-8 rounded-2xl border border-slate-800 bg-slate-900/60 p-7"><item.icon className="mb-4 text-blue-400" /><h2 className="text-2xl font-semibold">{item.label}</h2><p className="mt-4 leading-8 text-slate-300">{product.details[item.to.slice(1)]}</p><a href={item.to} className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-blue-400">Open {item.label} · sign-in required <ArrowUpRight size={16} /></a></section>)}</div>
        </div>
        <aside className="my-14 flex gap-4 rounded-2xl border border-slate-800 p-7"><Check className="shrink-0 text-blue-400" /><div><h2 className="font-semibold">What to know before you connect</h2><p className="mt-3 leading-7 text-slate-400">{product.context}</p></div></aside>
        <h2 className="text-2xl font-semibold">Explore the connected platform</h2><div className="mt-6 grid gap-5 md:grid-cols-3">{PRODUCTS.filter(p => p !== product).map(p => <a key={p.key} href={productPath(p)} className="marketing-link rounded-2xl border border-slate-800 p-6"><h3 className="font-semibold">{p.label}</h3><p className="mt-3 text-sm leading-7 text-slate-400">{p.description}</p><span className="mt-4 inline-block text-blue-400">Explore details →</span></a>)}</div>
      </>}
    </main><footer className="border-t border-slate-800 px-6 py-8 text-center text-sm text-slate-400"><a href="/">Cloudledger</a> · <a href="/guides/">Azure cost guides</a> · Not affiliated with Microsoft.</footer>
  </div>;
}
