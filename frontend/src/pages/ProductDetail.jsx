import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronRight, Moon, Sun } from 'lucide-react';
import { PRODUCTS, productPath } from '../content/products';
import { SECTIONS } from '../nav';
import { useTheme } from '../store/useTheme';

/** Shared chrome so every public page reads as one site. */
function Chrome({ children }) {
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggleTheme);

  return (
    <div className="marketing min-h-screen bg-slate-950 text-white">
      <header style={{ borderBottom: '1px solid var(--hairline)' }}>
        <nav aria-label="Main navigation" className="mx-auto flex h-12 max-w-[1024px] items-center justify-between px-5">
          <a href="/" className="text-[15px] font-semibold tracking-tight">Cloudledger</a>
          <div className="flex items-center gap-6">
            <a href="/#product" className="text-[13px] text-slate-400 hover:text-white">Product</a>
            <a href="/guides/" className="text-[13px] text-slate-400 hover:text-white">Guides</a>
            <a href="/login" className="text-[13px] text-slate-400 hover:text-white">Sign in</a>
            <button
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:text-white"
            >
              {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
          </div>
        </nav>
      </header>

      {children}

      <footer className="px-5 py-12 text-[12px] text-slate-500" style={{ borderTop: '1px solid var(--hairline)' }}>
        <div className="mx-auto flex max-w-[1024px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p><a href="/" className="hover:text-slate-300">Cloudledger</a> · <a href="/guides/" className="hover:text-slate-300">Azure cost guides</a></p>
          <p>Not affiliated with Microsoft.</p>
        </div>
      </footer>
    </div>
  );
}

export default function ProductDetail() {
  const { pathname } = useLocation();
  const product = PRODUCTS.find((p) => productPath(p) === `${pathname.replace(/\/$/, '')}/`);
  const section = SECTIONS.find((s) => s.key === product?.key);

  useEffect(() => {
    document.title = `${product ? `Azure ${product.label}` : 'Feature not found'} | Cloudledger`;
  }, [product]);

  if (!product) {
    return (
      <Chrome>
        <main className="mx-auto max-w-[1024px] px-5 py-32">
          <h1 className="marketing-headline">Feature not found</h1>
          <a href="/#product" className="marketing-cta mt-6 text-[17px]">
            Explore the product
            <ChevronRight className="marketing-chevron h-4 w-4" />
          </a>
        </main>
      </Chrome>
    );
  }

  const items = section.items.filter((item) => !item.overview);

  return (
    <Chrome>
      <main className="mx-auto max-w-[1024px] px-5 py-16 sm:py-24">
        <nav aria-label="Breadcrumb" className="text-[13px] text-slate-500">
          <a href="/" className="hover:text-slate-300">Home</a>
          <span className="px-1.5">/</span>
          <a href="/#product" className="hover:text-slate-300">Product</a>
          <span className="px-1.5">/</span>
          {product.label}
        </nav>

        <div className="mt-10 grid items-start gap-12 lg:grid-cols-[1.35fr_1fr]">
          <div>
            <p className="marketing-eyebrow">{product.audience}</p>
            <h1 className="marketing-display mt-4">{product.title}</h1>
            <p className="marketing-lead mt-6">{product.description}</p>
            <a href="/login" className="mt-9 inline-block rounded-full bg-blue-600 px-7 py-3 text-[17px] font-medium text-white transition hover:bg-blue-500">
              Explore with your Azure account
            </a>
          </div>

          <aside className="marketing-panel p-9">
            <section.icon className="h-7 w-7 text-blue-400" />
            <h2 className="mt-7 text-xl font-semibold tracking-tight">{product.outcome}</h2>
            <ol className="mt-6 space-y-4">
              {product.steps.map((step, i) => (
                <li key={step} className="flex gap-4 text-[15px] leading-7 text-slate-400">
                  <span className="shrink-0 font-semibold text-blue-400">{String(i + 1).padStart(2, '0')}</span>
                  {step}
                </li>
              ))}
            </ol>
          </aside>
        </div>

        <div className="mt-24 grid gap-12 lg:grid-cols-[210px_1fr]">
          <nav aria-label="Feature details" className="self-start lg:sticky lg:top-8">
            <p className="text-[13px] font-semibold text-slate-300">In this product area</p>
            <ul className="mt-4 space-y-1">
              {items.map((item) => (
                <li key={item.to}>
                  <a href={`#${item.to.slice(1)}`} className="block py-1.5 text-[14px] text-slate-400 hover:text-blue-400">{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            {items.map((item, i) => (
              <section
                key={item.to}
                id={item.to.slice(1)}
                className="scroll-mt-8 py-10"
                style={{ borderTop: i === 0 ? undefined : '1px solid var(--hairline)' }}
              >
                <item.icon className="h-6 w-6 text-blue-400" />
                <h2 className="mt-5 text-2xl font-semibold tracking-tight">{item.label}</h2>
                <p className="mt-4 text-[17px] leading-8 text-slate-400">{product.details[item.to.slice(1)]}</p>
                <a href={item.to} className="marketing-cta mt-5 text-[15px]">
                  Open {item.label} · sign-in required
                  <ChevronRight className="marketing-chevron h-4 w-4" />
                </a>
              </section>
            ))}
          </div>
        </div>

        <aside className="marketing-panel mt-16 p-9 sm:p-11">
          <h2 className="text-xl font-semibold tracking-tight">What to know before you connect</h2>
          <p className="mt-4 text-[15px] leading-7 text-slate-400">{product.context}</p>
        </aside>

        <section className="mt-24">
          <h2 className="marketing-headline">Explore the connected platform.</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {PRODUCTS.filter((p) => p !== product).map((other) => (
              <a key={other.key} href={productPath(other)} className="marketing-link p-8">
                <h3 className="text-lg font-semibold tracking-tight">{other.label}</h3>
                <p className="mt-3 text-[15px] leading-7 text-slate-400">{other.description}</p>
                <span className="marketing-cta mt-6 text-[15px]">
                  Learn more
                  <ChevronRight className="marketing-chevron h-4 w-4" />
                </span>
              </a>
            ))}
          </div>
        </section>
      </main>
    </Chrome>
  );
}
