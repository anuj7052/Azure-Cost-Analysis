/**
 * Network Visualizer — the estate's virtual networks, what connects them, and
 * what is wrong with them.
 *
 * Read-only by design. This draws what Azure reports and offers no way to
 * change it: a diagram people can also edit from is a diagram they stop
 * trusting as a faithful record, which is the only thing it is for.
 *
 * Three rules run through the page.
 *
 * Nothing is drawn that Azure did not report -- no relationship inferred from a
 * naming convention, no line drawn because a hub-and-spoke usually has one.
 *
 * Nothing that was read is hidden. That includes the parts a diagram normally
 * swallows: every subnet, every peering and its state, every address range.
 * Those live in the panel rather than on the canvas, because 400 subnet labels
 * would make the picture unreadable -- but they are one click away, not absent.
 *
 * And the page assumes the reader has never seen this estate before. A network
 * diagram is the artefact people are handed on their first day and during their
 * worst incident, so the vocabulary is explained in place rather than assumed.
 */
import { useMemo, useRef, useState, useEffect } from 'react';
import {
  Network, Eye, ExternalLink, Search, Loader2, Info, ShieldAlert, Ban,
  ChevronDown, ChevronRight, HelpCircle, Layers, GitBranch, X,
} from 'lucide-react';
import { fetchNetworkTopology } from '../api/client';
import {
  PageHeader, NeedsSelection, Failure, Empty,
} from '../components/Security/SecurityShell';
import { useAppStore } from '../store/useAppStore';
import { friendlyError } from '../utils/apiError';
import {
  layoutTopology, matchNodes, visibleEdges, detailRows, addressRows,
  neighbours, edgeCounts, activeLegend, EDGE_COLOR, LEGEND_LABEL,
  LEGEND_HELP, NODE_LABEL, NODE_HELP, GEOMETRY, SEVERITY_TONE, GLOSSARY,
  riskByNode, partitionNodes, shouldLabel, postureLine, RISK_RING,
} from '../utils/networkTopology';

const NODE_FILL = {
  vnet: '#e2e8f0',
  gateway: '#22c55e',
  firewall: '#f97316',
  bastion: '#06b6d4',
  nat: '#14b8a6',
  nsg: '#ef4444',
  route_table: '#eab308',
  public_ip: '#3b82f6',
};

function Row({ label, value, hint }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-1">
      <span className="text-xs text-slate-500" title={hint}>{label}</span>
      <span className="break-words text-xs text-slate-200">{value}</span>
    </div>
  );
}

function Section({ icon, title, count, children, open, onToggle }) {
  const Glyph = icon;
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Glyph size={13} className="text-slate-400" />
        <span className="flex-1 text-sm font-medium text-slate-200">{title}</span>
        {count !== undefined && (
          <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-400">
            {count}
          </span>
        )}
      </button>
      {open && <div className="border-t border-slate-800 px-4 py-3">{children}</div>}
    </div>
  );
}

/**
 * The key to the diagram.
 *
 * This used to float over the bottom-left corner of the canvas, permanently
 * covering whatever was drawn underneath it -- which on a real estate was a
 * whole band of resources. A key that hides the thing it describes is a bad
 * trade at any size, so it now sits below the picture in normal flow and takes
 * its own space. It also lists only the kinds of line actually present: a key
 * naming nine things when the picture contains three teaches the reader that
 * the key is decoration rather than a description.
 */
function Legend({ counts, risky }) {
  const entries = activeLegend(counts);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-2.5 text-[11px]">
      <span className="flex items-center gap-1.5 text-slate-400">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-purple-500" />
        Hub
      </span>
      {risky && (
        <span className="flex items-center gap-1.5 text-slate-400" title="The ring shows the most serious finding against that resource.">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-rose-500" />
          Has findings
        </span>
      )}
      {entries.map(([kind, count]) => (
        <span
          key={kind}
          title={LEGEND_HELP[kind]}
          className="flex items-center gap-1.5 text-slate-400"
        >
          <span className="h-0.5 w-4 shrink-0 rounded" style={{ background: EDGE_COLOR[kind] }} />
          {LEGEND_LABEL[kind]}
          <span className="text-slate-600">{count}</span>
        </span>
      ))}
      {entries.length === 0 && (
        <span className="text-slate-500">
          No connections between the resources on screen.
        </span>
      )}
    </div>
  );
}

function Graph({ nodes, edges, selected, onSelect, hubKey, risk }) {
  const box = useRef(null);
  const [width, setWidth] = useState(900);
  const [hovered, setHovered] = useState('');

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(360, entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { positions, height } = useMemo(
    () => layoutTopology(nodes, edges, width),
    [nodes, edges, width],
  );

  // When one node is selected, everything with no line to it is dimmed rather
  // than removed. Removing it would answer "what is connected to this" by
  // deleting the evidence for the answer.
  const related = useMemo(
    () => (selected ? neighbours(edges, selected) : null),
    [edges, selected],
  );

  const dim = (key) => Boolean(related) && key !== selected && !related.has(key);

  return (
    <div ref={box} className="h-[560px] overflow-auto rounded-2xl border border-slate-800 bg-slate-950">
      <svg width={width} height={height} className="block">
        {edges.map((edge, i) => {
          const a = positions[edge.source];
          const b = positions[edge.target];
          if (!a || !b) return null;
          const faded = dim(edge.source) || dim(edge.target);
          return (
            <line
              key={`${edge.source}-${edge.target}-${edge.kind}-${i}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={EDGE_COLOR[edge.kind] || '#475569'}
              strokeWidth={edge.kind === 'peering' ? 1.4 : 1}
              strokeOpacity={faded ? 0.07 : 0.55}
              strokeDasharray={edge.kind === 'child' ? '3 3' : undefined}
            />
          );
        })}

        {nodes.map((node) => {
          const at = positions[node.key];
          if (!at) return null;
          const faded = dim(node.key);
          const isHub = node.key === hubKey;
          const severity = risk.get(String(node.id || '').toLowerCase())
            || risk.get(node.key);
          // Hub first: a hub that also has findings still needs to read as the
          // hub, because that is what orients the whole picture.
          const ring = isHub ? '#a855f7'
            : node.key === selected ? '#38bdf8'
            : severity ? RISK_RING[severity]
            : '#0f172a';
          const labelled = shouldLabel(nodes.length, selected, hovered, node);
          return (
            <g
              key={node.key}
              transform={`translate(${at.x}, ${at.y})`}
              opacity={faded ? 0.12 : 1}
              className="cursor-pointer"
              onClick={() => onSelect(node.key === selected ? '' : node.key)}
              onMouseEnter={() => setHovered(node.key)}
              onMouseLeave={() => setHovered('')}
            >
              <title>
                {`${node.name} — ${NODE_LABEL[node.kind] || node.kind}`
                  + (severity ? `\nMost serious finding: ${severity}` : '')
                  + `\n${NODE_HELP[node.kind] || ''}`}
              </title>
              {severity && !isHub && (
                <circle r={GEOMETRY.nodeRadius + 4} fill="none"
                  stroke={RISK_RING[severity]} strokeWidth={1} strokeOpacity={0.35} />
              )}
              <circle
                r={GEOMETRY.nodeRadius}
                fill={NODE_FILL[node.kind] || '#cbd5e1'}
                stroke={ring}
                strokeWidth={isHub || node.key === selected || severity ? 3 : 1.5}
              />
              {labelled && (
                <text
                  y={GEOMETRY.nodeRadius + 12}
                  textAnchor="middle"
                  className={node.key === hovered ? 'fill-slate-100' : 'fill-slate-400'}
                  style={{ fontSize: 8 }}
                >
                  {node.name.length > 16 ? `${node.name.slice(0, 15)}…` : node.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function FindingCard({ finding }) {
  const [open, setOpen] = useState(false);
  const blocker = finding.category === 'blocker';
  const Icon = blocker ? Ban : ShieldAlert;
  const tone = SEVERITY_TONE[finding.severity] || SEVERITY_TONE.low;

  return (
    <div className={`rounded-xl border p-3 ${tone.border} ${tone.bg}`}>
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-start gap-2 text-left">
        <Icon size={13} className={`mt-0.5 shrink-0 ${tone.text}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-slate-100">{finding.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tone.chip}`}>
              {finding.severity}
            </span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
              {blocker ? 'Traffic will not flow' : 'Traffic will flow'}
            </span>
          </span>
        </span>
        {open ? <ChevronDown size={12} className="mt-1" /> : <ChevronRight size={12} className="mt-1" />}
      </button>

      {open && (
        <div className="mt-2 space-y-2 border-t border-slate-700/50 pt-2">
          <p className="text-[11px] leading-relaxed text-slate-300">{finding.detail}</p>
          <p className="text-[11px] leading-relaxed text-emerald-300/80">
            <span className="font-medium">What to do: </span>{finding.fix}
          </p>
          {/* Stated, not buried. A reviewer who gets burned once by a false
              positive stops reading the entire list. */}
          {finding.caveat && (
            <p className="text-[11px] leading-relaxed text-slate-500">
              <span className="font-medium">This may be wrong if: </span>{finding.caveat}
            </p>
          )}
          {Object.keys(finding.evidence || {}).length > 0 && (
            <div className="rounded-lg bg-slate-950/60 p-2">
              {Object.entries(finding.evidence).map(([k, v]) => (
                <div key={k} className="flex gap-2 py-0.5 text-[10px]">
                  <span className="w-28 shrink-0 text-slate-500">{k.replace(/_/g, ' ')}</span>
                  <span className="break-all text-slate-300">
                    {Array.isArray(v) ? v.join(', ') : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Primer({ onClose }) {
  return (
    <div className="rounded-2xl border border-blue-500/25 bg-blue-950/20 p-4">
      <div className="mb-2 flex items-start gap-2">
        <HelpCircle size={14} className="mt-0.5 shrink-0 text-blue-400" />
        <p className="flex-1 text-sm font-medium text-blue-200">
          What you are looking at
        </p>
        <button onClick={onClose} className="text-blue-300/60 hover:text-blue-200">
          <X size={14} />
        </button>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-blue-200/75">
        Each circle is one Azure networking resource. Each line is a real
        relationship read from that resource&apos;s own configuration — not
        guessed from its name. The network at the top with a purple ring is the
        hub: the one everything else routes through. Click any circle to see
        every subnet, address range and peering it has.
      </p>
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {GLOSSARY.map(({ term, meaning }) => (
          <p key={term} className="text-[11px] leading-relaxed text-blue-200/60">
            <span className="font-medium text-blue-200/90">{term} — </span>
            {meaning}
          </p>
        ))}
      </div>
    </div>
  );
}

export default function NetworkVisualizer() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const subscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [primer, setPrimer] = useState(true);
  const [tab, setTab] = useState('details');
  const [openSection, setOpenSection] = useState('subnets');
  const [showLoose, setShowLoose] = useState(false);

  const ready = Boolean(tenantId) && (subscriptionIds || []).length > 0;

  async function run() {
    if (!ready) return;
    setLoading(true);
    setError('');
    try {
      const result = await fetchNetworkTopology({
        tenant_id: tenantId,
        subscription_ids: subscriptionIds,
      });
      setData(result);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setData(null);
    setSelected('');
  }, [tenantId, subscriptionIds]);

  const nodes = useMemo(() => data?.nodes || [], [data]);
  const matched = useMemo(() => matchNodes(nodes, query), [nodes, query]);
  const allEdges = useMemo(() => visibleEdges(data?.edges, matched), [data, matched]);

  // Most of a real estate is security groups, route tables and public IPs. Drawn
  // alongside the networks they become dozens of identical circles with no lines
  // between them, which buries the handful of nodes the diagram exists to show.
  const split = useMemo(() => partitionNodes(matched, allEdges), [matched, allEdges]);
  const shown = useMemo(
    () => (showLoose ? matched : split.connected),
    [showLoose, matched, split],
  );
  const edges = useMemo(() => visibleEdges(allEdges, shown), [allEdges, shown]);
  const counts = useMemo(() => edgeCounts(edges), [edges]);
  const hubKey = useMemo(() => layoutTopology(shown, edges).hubKey, [shown, edges]);
  const node = useMemo(
    () => nodes.find(n => n.key === selected) || null,
    [nodes, selected],
  );

  const findings = useMemo(() => data?.findings || [], [data]);
  const stats = data?.findings_summary || {};
  const risk = useMemo(() => riskByNode(findings, nodes), [findings, nodes]);
  // When a node is selected the findings narrow to it, so the panel answers
  // "what is wrong with this one" rather than making the reader scan a list.
  const relevant = useMemo(
    () => (node ? findings.filter(f => f.resource_id === node.id
      || f.resource_name === node.name
      || (f.evidence?.vnet && f.evidence.vnet === node.name)) : findings),
    [findings, node],
  );

  const toggle = (key) => setOpenSection(v => (v === key ? '' : key));

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4 p-6">
      <PageHeader
        title="Network Visualization"
        subtitle="Every virtual network in the selected subscriptions, what connects them, and what in that configuration will block traffic or expose it. Read from Azure — nothing here is inferred from naming."
        onRun={run}
        loading={loading}
        disabled={!ready}
        lastUpdated={lastUpdated}
        loaded={Boolean(data)}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <Failure message={error} onRetry={run} stale={Boolean(data)} />}

      {ready && !data && !loading && !error && (
        <Empty title="Nothing read yet">
          Choose your subscriptions above and press Refresh to read the network
          topology. It is a single query, but a large one on a big estate.
        </Empty>
      )}

      {loading && !data && (
        <div className="flex h-64 items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Reading networks from Azure…
        </div>
      )}

      {data && (
        <>
          {primer && <Primer onClose={() => setPrimer(false)} />}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[16rem] flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name, resource group, region or address space…"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-600"
              />
            </div>
            {!primer && (
              <button
                onClick={() => setPrimer(true)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 hover:bg-slate-800"
              >
                <HelpCircle size={12} /> What am I looking at?
              </button>
            )}
            <span className="text-xs text-slate-500">
              {shown.length} of {nodes.length} resources · {edges.length} connections
            </span>
          </div>

          {(stats.blockers > 0 || stats.exposures > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {stats.blockers > 0 && (
                <button
                  onClick={() => { setTab('security'); setSelected(''); }}
                  className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-950/25 px-3 py-1.5 text-xs text-rose-200 transition hover:bg-rose-950/45"
                >
                  <Ban size={12} /> {stats.blockers} will stop traffic
                </button>
              )}
              {stats.exposures > 0 && (
                <button
                  onClick={() => { setTab('security'); setSelected(''); }}
                  className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-950/25 px-3 py-1.5 text-xs text-amber-200 transition hover:bg-amber-950/45"
                >
                  <ShieldAlert size={12} /> {stats.exposures} allow traffic worth checking
                </button>
              )}
              <span className="text-xs text-slate-500">{postureLine(stats)}</span>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
            {shown.length === 0 ? (
              <Empty title="Nothing matches that search">
                Try a network name, a resource group, a region, or part of an
                address range such as 10.42.
              </Empty>
            ) : (
              <div className="space-y-3">
                <Graph
                  nodes={shown}
                  edges={edges}
                  selected={selected}
                  onSelect={setSelected}
                  hubKey={hubKey}
                  risk={risk}
                />
                <Legend counts={counts} risky={risk.size > 0} />
                {split.unattached.length > 0 && (
                  <button
                    onClick={() => setShowLoose(v => !v)}
                    className="flex w-full items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-2.5 text-left text-xs text-slate-400 transition hover:bg-slate-800"
                  >
                    {showLoose ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="flex-1">
                      {showLoose ? 'Hide' : 'Show'} {split.unattached.length} resources
                      not attached to any network on screen
                    </span>
                    <span className="text-slate-600">
                      security groups, route tables, addresses
                    </span>
                  </button>
                )}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1">
                {[
                  ['details', 'Details'],
                  ['security', `Security${findings.length ? ` (${findings.length})` : ''}`],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      tab === key ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'details' && (
                <>
                  <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                    <p className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
                      <Network size={14} /> Resource Details
                    </p>
                    {node ? (
                      <>
                        {detailRows(node).map(row => <Row key={row.label} {...row} />)}
                        <p className="mt-2 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
                          {NODE_HELP[node.kind] || ''}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs leading-relaxed text-slate-500">
                        Select a resource in the diagram to see where it lives,
                        how it is addressed, and every subnet and peering it has.
                      </p>
                    )}
                  </div>

                  {node && addressRows(node).length > 0 && (
                    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                      <p className="mb-2 text-sm font-medium text-slate-200">
                        Address Configuration
                      </p>
                      {addressRows(node).map(row => <Row key={row.label} {...row} />)}
                    </div>
                  )}

                  {/* The parts a diagram normally swallows. A VNet with 40
                      subnets cannot show them on the canvas, but "not on the
                      canvas" must not become "not available". */}
                  {node?.subnets?.length > 0 && (
                    <Section
                      icon={Layers} title="Subnets" count={node.subnets.length}
                      open={openSection === 'subnets'} onToggle={() => toggle('subnets')}
                    >
                      <div className="space-y-2">
                        {node.subnets.map(s => (
                          <div key={s.id} className="rounded-lg bg-slate-950/60 p-2">
                            <p className="text-[11px] font-medium text-slate-200">{s.name}</p>
                            <p className="text-[10px] text-slate-500">
                              {s.prefix || (s.prefixes || []).join(', ') || 'No range reported'}
                            </p>
                            <p className="mt-1 flex flex-wrap gap-1">
                              <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                                s.nsg_id ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
                              }`}>
                                {s.nsg_id ? 'Security group attached' : 'No security group'}
                              </span>
                              {s.route_table_id && (
                                <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] text-yellow-300">
                                  Route table
                                </span>
                              )}
                              {s.nat_gateway_id && (
                                <span className="rounded bg-teal-500/15 px-1.5 py-0.5 text-[10px] text-teal-300">
                                  NAT gateway
                                </span>
                              )}
                            </p>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  {node?.peerings?.length > 0 && (
                    <Section
                      icon={GitBranch} title="Peerings" count={node.peerings.length}
                      open={openSection === 'peerings'} onToggle={() => toggle('peerings')}
                    >
                      <div className="space-y-2">
                        {node.peerings.map(p => (
                          <div key={p.name} className="rounded-lg bg-slate-950/60 p-2">
                            <p className="flex items-center gap-2 text-[11px] font-medium text-slate-200">
                              {p.name}
                              <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                                String(p.state).toLowerCase() === 'connected'
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : 'bg-rose-500/15 text-rose-300'
                              }`}>
                                {p.state || 'State not reported'}
                              </span>
                            </p>
                            <p className="mt-1 flex flex-wrap gap-1">
                              {p.allow_forwarded_traffic && (
                                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                                  Accepts forwarded traffic
                                </span>
                              )}
                              {p.allow_gateway_transit && (
                                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                                  Shares its gateway
                                </span>
                              )}
                              {p.use_remote_gateways && (
                                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                                  Uses the remote gateway
                                </span>
                              )}
                            </p>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  {node && (
                    <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900 p-4">
                      <a
                        href={`https://portal.azure.com/#@/resource${node.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-center gap-2 rounded-lg border border-slate-700 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
                      >
                        <ExternalLink size={12} /> Open in Azure Portal
                      </a>
                      <a
                        href={`/explorer?q=${encodeURIComponent(node.name)}`}
                        className="flex items-center justify-center gap-2 rounded-lg border border-slate-700 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
                      >
                        <Eye size={12} /> View in Explorer
                      </a>
                    </div>
                  )}
                </>
              )}

              {tab === 'security' && (
                <>
                  <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                    <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
                      <Info size={12} className="mt-0.5 shrink-0" />
                      {data.findings_note}
                    </p>
                    {node && (
                      <p className="mt-2 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
                        Showing findings for {node.name} only.{' '}
                        <button
                          onClick={() => setSelected('')}
                          className="underline underline-offset-2"
                        >
                          Show all {findings.length}
                        </button>
                      </p>
                    )}
                  </div>

                  {relevant.length === 0 ? (
                    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                      <p className="text-xs leading-relaxed text-slate-400">
                        {node
                          ? `Nothing was found in ${node.name}'s configuration.`
                          : 'Nothing was found in the configuration that was read.'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {relevant.map((f, i) => (
                        <FindingCard key={`${f.kind}-${f.resource_id}-${i}`} finding={f} />
                      ))}
                    </div>
                  )}
                </>
              )}

              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
                  <Info size={12} className="mt-0.5 shrink-0" />
                  {data.note}
                </p>
              </div>

              {(data.external || []).length > 0 && (
                <div className="rounded-2xl border border-amber-500/25 bg-amber-950/20 p-4">
                  <p className="mb-2 text-xs font-medium text-amber-200">
                    Connects to networks outside your selection
                  </p>
                  <ul className="space-y-1">
                    {data.external.map(id => (
                      <li key={id} className="break-all text-[11px] text-amber-200/70">
                        {id}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.coverage?.refused > 0 && (
                <p className="text-xs leading-relaxed text-slate-500">
                  {data.coverage.refused} of the subscriptions you selected were
                  not readable with this tenant&apos;s token and were left out.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
