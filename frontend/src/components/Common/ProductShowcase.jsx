import { useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react';

const SCENES = [
  { label: 'Cost Explorer', title: 'See where the change starts.', image: '/showcase-cost.svg', alt: 'Illustrated cost explorer with daily bars highlighting a change and the path from service to billing meter.', body: 'Start with a daily cost change, then inspect the services, resource groups and meters behind it.', href: '/features/azure-cost-intelligence/#explorer', actions: ['Compare reporting periods', 'Inspect daily contributors', 'Review reservation context'] },
  { label: 'Resource optimization', title: 'Make the estate easier to act on.', image: '/showcase-resources.svg', alt: 'Illustrated compute, unattached-resource and change-history reviews connected to an owner validation workflow.', body: 'Bring utilization, resource inventory and cost together before deciding what to resize or retire.', href: '/features/azure-resource-optimization/', actions: ['Review VM utilization', 'Find orphaned candidates', 'Investigate resource changes'] },
  { label: 'Access & governance', title: 'Follow access beyond the headline.', image: '/showcase-governance.svg', alt: 'Illustrated relationships between identities, policy findings and network controls around a governance review.', body: 'Explore who can reach your resources and review the policy, Defender and network context around them.', href: '/features/azure-access-governance/', actions: ['Inspect role assignments', 'Review policy and findings', 'Explore network relationships'] },
];

export default function ProductShowcase() {
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const scene = SCENES[active];
  const change = (index) => { setActive(index); setExpanded(false); };

  return <section id="showcase" className="product-showcase px-5" aria-labelledby="showcase-title">
    <div className="mx-auto max-w-[1120px]">
      <div className="showcase-heading"><div><p className="marketing-eyebrow">Take a closer look</p><h2 id="showcase-title" className="marketing-headline mt-3">A clearer picture.<br />A more useful next step.</h2></div><p className="max-w-sm text-[15px] leading-7 text-slate-400">Choose a workflow to explore how Cloudledger connects the bill, the resource and the context.</p></div>
      <div role="tablist" aria-label="Product walkthrough" className="showcase-tabs">
        {SCENES.map((item, index) => <button key={item.label} role="tab" id={`showcase-tab-${index}`} aria-controls={`showcase-panel-${index}`} aria-selected={active === index} tabIndex={active === index ? 0 : -1} onClick={() => change(index)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % SCENES.length : event.key === 'ArrowLeft' ? (index + SCENES.length - 1) % SCENES.length : event.key === 'Home' ? 0 : event.key === 'End' ? SCENES.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); change(next); document.getElementById(`showcase-tab-${next}`)?.focus();
        }}>{item.label}</button>)}
      </div>
      <div role="tabpanel" id={`showcase-panel-${active}`} aria-labelledby={`showcase-tab-${active}`} className={`showcase-panel ${expanded ? 'showcase-expanded' : ''}`}>
        <div className="showcase-visual">
          <img key={scene.image} src={scene.image} alt={scene.alt} width="800" height="440" loading="lazy" className="showcase-image" />
          <button className="showcase-expand" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-label={expanded ? 'Reduce illustration' : 'Enlarge illustration'}>{expanded ? <X size={16} /> : <Maximize2 size={16} />} {expanded ? 'Reduce' : 'Enlarge'}</button>
        </div>
        <div className="showcase-copy"><p className="marketing-eyebrow">0{active + 1} / Explore the workflow</p><h3 className="mt-4 text-2xl font-semibold tracking-tight">{scene.title}</h3><p className="mt-4 text-sm leading-7 text-slate-400">{scene.body}</p><ul className="mt-5 space-y-3 text-sm text-slate-300">{scene.actions.map(action => <li key={action} className="flex gap-2"><ChevronRight size={16} className="brand-text shrink-0" />{action}</li>)}</ul><a href={scene.href} className="marketing-cta mt-7 text-sm font-semibold">Explore {scene.label} <ArrowRight size={16} /></a></div>
      </div>
      <div className="showcase-bottom"><p>Product illustrations. Connect Azure to see your own data.</p><div className="flex gap-2"><button aria-label="Previous workflow" onClick={() => change((active + SCENES.length - 1) % SCENES.length)}><ChevronLeft size={18} /></button><button aria-label="Next workflow" onClick={() => change((active + 1) % SCENES.length)}><ChevronRight size={18} /></button></div></div>
    </div>
  </section>;
}
