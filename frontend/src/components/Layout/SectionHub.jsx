import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { SECTIONS, sectionsFor } from '../../nav';
import { useAppStore } from '../../store/useAppStore';
import { Breadcrumb } from './HubKit';

/**
 * The landing page for a section.
 *
 * Twenty pages behind four labels is a discoverability problem, not a layout
 * one. "Anomalies", "Change Tracking" and "Activity Explorer" sound like the
 * same page to anyone who has not used all three, so people open one, decide
 * the app cannot answer their question, and never open the other two.
 *
 * This is the fix: each page listed with the question it answers, in the words
 * a user would ask it. Rendered from the same nav definition the sidebar uses,
 * so a page can never exist in one and be missing from the other.
 */
export default function SectionHub({ sectionKey, breadcrumb, actions, children }) {
  const isAdmin = useAppStore(s => s.me?.is_admin);
  const section = sectionsFor(isAdmin).find(s => s.key === sectionKey)
    || SECTIONS.find(s => s.key === sectionKey);

  if (!section) return null;

  const SectionIcon = section.icon;
  const pages = section.items.filter(item => !item.overview);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <Breadcrumb items={breadcrumb || [{ label: 'Home', to: '/' }, { label: section.title }]} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
            <SectionIcon className="h-5 w-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">{section.title}</h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
              {section.tagline}
            </p>
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {children}

      <div>
        <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Pages in this section
        </p>
        <div className="stagger-children grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {pages.map((page) => (
          <Link
            key={page.to}
            to={page.to}
            className="group rounded-2xl border border-slate-800 bg-slate-900 p-4 transition hover:-translate-y-0.5 hover:border-blue-500/30 hover:bg-slate-800/60"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-800 bg-slate-800/60 transition group-hover:border-blue-500/30">
                <page.icon className="h-4 w-4 text-slate-400 transition group-hover:text-blue-300" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-semibold text-white">{page.label}</p>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-700 transition group-hover:translate-x-0.5 group-hover:text-blue-400" />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{page.blurb}</p>
              </div>
            </div>
          </Link>
        ))}
        </div>
      </div>
    </div>
  );
}
