import { useCallback, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useNav } from '../../store/useNav';
import { sectionForPath, sectionsFor } from '../../nav';

/*
 * The primary navigation.
 *
 * A flat list worked while every page answered a version of "what did this
 * cost". With four sections and twenty pages it stopped working: an unrelated
 * security page sitting three rows below Bandwidth reads as noise, and the
 * whole column stopped fitting on a laptop screen.
 *
 * Three decisions hold this together:
 *
 * 1. Sections open on click, and the one containing the current page opens by
 *    itself, so navigating never leaves the user staring at a closed list with
 *    no idea where they are. A section the user deliberately closed stays
 *    closed — silently reopening it would fight them.
 *
 * 2. The whole rail collapses to icons and remembers that choice. On a laptop
 *    beside a wide cost table, 240px of chrome is the difference between
 *    reading a row and scrolling to it.
 *
 * 3. Collapsing hides labels, never destinations. Every section is still one
 *    click away in the rail, and that click lands on the section overview,
 *    which lists its pages. Nothing in this app becomes unreachable because
 *    the nav got narrower.
 *
 * 4. Below `lg` the rail stops being a column and becomes a drawer over the
 *    page. A 240px fixed column on a 375px phone leaves 135px for the content,
 *    which is not a narrow layout -- it is an unusable one. The desktop
 *    behaviour above `lg` is deliberately untouched.
 */

const STORAGE_KEY = 'aca:sidebar-collapsed';

function initialCollapsed() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === '1';
}

const itemClass = ({ isActive }) =>
  `group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-gradient-to-r from-blue-600/25 to-transparent text-blue-300 border border-blue-500/30 shadow-sm shadow-blue-950/20'
      : 'text-slate-400 hover:bg-slate-800/80 hover:text-white'
  }`;

export default function Sidebar() {
  const isAdmin = useAppStore(s => s.me?.is_admin);
  const { pathname } = useLocation();
  const navOpen = useNav(s => s.navOpen);
  const closeNav = useNav(s => s.closeNav);

  // Only holds sections the user has explicitly toggled. Everything else falls
  // back to "open if it contains the current page", which needs no effect and
  // therefore cannot fall out of step with the route.
  const [overrides, setOverrides] = useState({});
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  // Tapping a destination on a phone should reveal the destination, not leave
  // the drawer sitting on top of it.
  useEffect(() => { closeNav(); }, [pathname, closeNav]);

  // Escape closes the drawer for anyone on a keyboard with a narrow window.
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeNav(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen, closeNav]);

  const sections = sectionsFor(isAdmin);
  const activeSection = sectionForPath(pathname, isAdmin);

  const toggle = (key, isOpen) => setOverrides(prev => ({ ...prev, [key]: !isOpen }));

  const setRail = useCallback((next) => {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    setCollapsed(next);
  }, []);

  // An icon-only rail is a reasonable trade on a wide screen, where the page
  // beside it supplies the context. Floating over a phone it is just a column
  // of unlabelled glyphs, so the drawer always shows words.
  const iconOnly = collapsed && !navOpen;

  return (
    <>
      {/* Backdrop, drawer only. Rendered rather than toggled with a class so
          it cannot swallow clicks on desktop. */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeNav}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        className={`z-50 flex h-screen min-h-screen shrink-0 flex-col border-r border-slate-800 bg-slate-900/95 backdrop-blur-xl transition-transform duration-200 lg:sticky lg:inset-auto lg:top-0 lg:translate-x-0 lg:bg-slate-900/90 lg:transition-[width] ${
          // Off-canvas below lg, an ordinary column from lg upwards.
          navOpen ? 'fixed inset-y-0 left-0 translate-x-0' : 'fixed inset-y-0 left-0 -translate-x-full'
        } ${
          // The drawer always shows labels: an icon-only rail floating over the
          // page gives a phone user no way to tell what they are tapping.
          collapsed ? 'w-64 lg:w-[68px]' : 'w-64 lg:w-60'
        }`}
      >
        <div className={`flex items-center gap-3 border-b border-slate-800 py-5 ${iconOnly ? 'px-5 lg:justify-center lg:px-3' : 'px-5'}`}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-950/40">
          <svg viewBox="0 0 96 96" className="h-5 w-5 fill-[#fff]" aria-hidden="true">
            <path d="M33.4 6.4L10 73.8h19.3l13.6-36.1 14.1 25.2-10.2 10.9H66l17.8 17.7H96L57.3 6.4H33.4z" />
          </svg>
        </div>
        {!iconOnly && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold leading-tight tracking-tight text-white">Azure Cost</p>
            <p className="text-[11px] font-medium uppercase tracking-wide text-blue-400">Intelligence</p>
          </div>
        )}
        <button
          type="button"
          onClick={closeNav}
          aria-label="Close navigation"
          className="-mr-1 rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-800 hover:text-white lg:hidden"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* min-h-0: without it this flex child refuses to shrink below its
          content, so a nav taller than the viewport overflows instead of
          scrolling and the last sections cannot be reached. */}
      <nav className={`min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain py-4 ${iconOnly ? 'px-2' : 'px-3'}`}>
        {sections.map((section) => {
          const isActive = activeSection?.key === section.key;
          const open = overrides[section.key] ?? isActive;
          const SectionIcon = section.icon;

          // Collapsed: one icon per section, linking to that section's
          // overview. The overview lists every page in the section, so the
          // rail loses labels but never loses a destination.
          if (iconOnly) {
            return (
              <NavLink
                key={section.key}
                to={section.hub}
                end={section.hub === '/'}
                title={section.title}
                aria-label={section.title}
                className={`relative flex h-11 w-full items-center justify-center rounded-lg transition-colors ${
                  isActive ? 'bg-blue-600/20 text-blue-300' : 'text-slate-500 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                {isActive && <span className="absolute left-0 h-6 w-0.5 rounded-r bg-blue-400" />}
                <SectionIcon className="h-5 w-5" />
              </NavLink>
            );
          }

          return (
            <div key={section.key}>
              <button
                type="button"
                onClick={() => toggle(section.key, open)}
                aria-expanded={open}
                className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                  isActive ? 'text-slate-200' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <SectionIcon className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider">
                  {section.title}
                </span>
                {/* A closed section still shows how much is inside, so nothing
                    feels hidden away. */}
                {!open && (
                  <span className="text-[10px] text-slate-600 group-hover:text-slate-500">
                    {section.items.length}
                  </span>
                )}
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
                />
              </button>

              {open && (
                <div className="mb-2 ml-4 mt-0.5 space-y-0.5 border-l border-slate-800 pl-2">
                  {section.items.map(item => (
                    <NavLink key={item.to} to={item.to} end={item.to === '/'} className={itemClass}>
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className={`border-t border-slate-800 py-3 ${iconOnly ? 'px-2' : 'px-3'}`}>
        <button
          type="button"
          onClick={() => setRail(!collapsed)}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          /* Collapsing only means anything where the rail is a column. */
          className={`hidden w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-800/80 hover:text-slate-300 lg:flex ${
            iconOnly ? 'justify-center px-0' : ''
          }`}
        >
          {iconOnly
            ? <PanelLeftOpen className="h-4 w-4 shrink-0" />
            : <><PanelLeftClose className="h-4 w-4 shrink-0" /><span>Collapse</span></>}
        </button>
        {!iconOnly && (
          <p className="px-3 pt-2 text-[11px] text-slate-600">Azure Cost Analysis v1.0</p>
        )}
      </div>
      </aside>
    </>
  );
}
