import { useState } from 'react';
import { ChevronDown, ExternalLink, HelpCircle } from 'lucide-react';

/**
 * Collapsible, numbered walkthrough that tells the user exactly where a number
 * on screen comes from in the Azure portal, so any figure can be verified.
 */
export default function PortalGuide({
  title = 'How to check this in the Azure portal',
  intro,
  steps = [],
  links = [],
  tips = [],
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl elevated overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-800/40 transition-colors"
      >
        <span className="w-9 h-9 rounded-xl bg-blue-500/15 text-blue-400 flex items-center justify-center shrink-0">
          <HelpCircle className="w-4.5 h-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-white">{title}</span>
          <span className="block text-xs text-slate-500 mt-0.5">
            {open ? 'Hide the step-by-step walkthrough' : 'Step-by-step — verify every number yourself'}
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-5 border-t border-slate-800 pt-5">
          {intro && <p className="text-sm text-slate-400 leading-relaxed">{intro}</p>}

          <ol className="space-y-3">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-6 h-6 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm text-slate-200 font-medium">{step.title}</p>
                  {step.detail && (
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">{step.detail}</p>
                  )}
                  {step.path && (
                    <p className="text-[11px] text-blue-400 mt-1.5 font-mono break-words">{step.path}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {tips.length > 0 && (
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Good to know</p>
              {tips.map((tip, i) => (
                <p key={i} className="text-xs text-slate-400 leading-relaxed">• {tip}</p>
              ))}
            </div>
          )}

          {links.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {links.map(link => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 border border-blue-500/25 rounded-lg px-3 py-1.5 transition-colors"
                >
                  {link.label}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
