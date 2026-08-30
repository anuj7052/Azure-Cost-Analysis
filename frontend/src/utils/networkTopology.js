/**
 * Laying out a network topology.
 *
 * The layout is deterministic: the same estate produces the same picture every
 * time, in the same places. A force-directed layout looks livelier and settles
 * somewhere different on every load, which makes two screenshots of the same
 * network impossible to compare and makes "did this move?" an unanswerable
 * question during an incident.
 *
 * Nothing here decides what is connected to what -- that came from Azure and
 * arrives already decided. This file only decides where to put it.
 */

const text = (v) => String(v ?? '').trim();

export const NODE_LABEL = {
  vnet: 'Virtual Network',
  gateway: 'Virtual Network Gateway',
  firewall: 'Azure Firewall',
  bastion: 'Azure Bastion',
  nat: 'NAT Gateway',
  nsg: 'Network Security Group',
  route_table: 'Route Table',
  public_ip: 'Public IP Address',
  load_balancer: 'Load Balancer',
  app_gateway: 'Application Gateway',
  private_endpoint: 'Private Endpoint',
  connection: 'Connection',
  virtual_hub: 'Virtual Hub',
  virtual_wan: 'Virtual WAN',
  other: 'Network resource',
};

/**
 * What each kind of resource is, in one sentence.
 *
 * A network diagram is the artefact people are handed on their first day and
 * during their worst incident. Assuming the vocabulary is the fastest way to
 * make it useless to the person who needs it most.
 */
export const NODE_HELP = {
  vnet: 'A private address space in Azure. Resources inside it can reach each other; nothing outside can, unless something below allows it.',
  gateway: 'The doorway between this network and somewhere else — an office, another cloud, or a laptop on a VPN.',
  firewall: 'Inspects and filters traffic passing through the hub. Traffic only reaches it if a route table sends it there.',
  bastion: 'Browser-based access to virtual machines without giving them public IP addresses. The safe alternative to opening RDP or SSH.',
  nat: 'Lets resources reach the internet outbound from one predictable address, without being reachable inbound.',
  nsg: 'A list of allow and deny rules applied to a subnet. This is where "who can reach this" is actually decided.',
  route_table: 'Overrides where traffic goes next. This is how traffic is forced through a firewall — or accidentally around one.',
  public_ip: 'An address reachable from anywhere on the internet.',
  load_balancer: 'Spreads incoming connections across several backends.',
  app_gateway: 'A web-aware load balancer, usually the public entry point for an application.',
  private_endpoint: 'A private address inside your network for an Azure service that would otherwise be reached over the internet.',
  connection: 'One leg of a VPN or ExpressRoute link.',
  virtual_hub: 'A Microsoft-managed hub in a Virtual WAN.',
  virtual_wan: 'A Microsoft-managed backbone connecting hubs and branches.',
  other: 'A networking resource in this estate.',
};

/**
 * Plain-language names for the lines, and what each one means.
 *
 * The label and the explanation live beside the colour so the key, the tooltip
 * and the drawing cannot drift apart.
 */
export const LEGEND_LABEL = {
  peering: 'Peering',
  vwan: 'VWAN Connection',
  gateway: 'Gateway / Public IP',
  nsg: 'Network Security Groups',
  route_table: 'Route Tables',
  vpn: 'VPN Connections',
  bastion: 'Azure Bastion',
  nat: 'NAT Gateway',
  child: 'Child Resource',
};

export const LEGEND_HELP = {
  peering: 'These two networks can reach each other directly, as though they were one.',
  vwan: 'This network is attached to a Microsoft-managed Virtual WAN hub.',
  gateway: 'A doorway to outside this network, or an address reachable from the internet.',
  nsg: 'A set of allow and deny rules is applied to this subnet.',
  route_table: 'This subnet has custom routing that overrides Azure defaults.',
  vpn: 'An encrypted tunnel to somewhere outside Azure.',
  bastion: 'Browser-based virtual machine access, without public IP addresses.',
  nat: 'Outbound internet access from a fixed address, with no inbound path.',
  child: 'This resource lives inside that network.',
};

/**
 * A short vocabulary for someone who has never opened this page.
 *
 * Deliberately short. A glossary long enough to be complete is one nobody
 * reads, and these are the six words that make the rest of the page legible.
 */export const GLOSSARY = [
  { term: 'Virtual network', meaning: 'A private address space. The basic unit on this page.' },
  { term: 'Subnet', meaning: 'A slice of a network. Security rules are applied here, not to the whole network.' },
  { term: 'Peering', meaning: 'A direct link between two networks. Both sides must declare it or no traffic flows.' },
  { term: 'Hub', meaning: 'The network holding the shared gateway or firewall that others route through.' },
  { term: 'Security group', meaning: 'The allow and deny rules on a subnet. Where exposure usually comes from.' },
  { term: 'Route table', meaning: 'Overrides where traffic goes next — including around a firewall.' },
];

export const SEVERITY_TONE = {
  critical: {
    border: 'border-rose-500/40', bg: 'bg-rose-950/25', text: 'text-rose-300',
    chip: 'bg-rose-500/20 text-rose-200',
  },
  high: {
    border: 'border-orange-500/35', bg: 'bg-orange-950/20', text: 'text-orange-300',
    chip: 'bg-orange-500/20 text-orange-200',
  },
  medium: {
    border: 'border-amber-500/30', bg: 'bg-amber-950/15', text: 'text-amber-300',
    chip: 'bg-amber-500/20 text-amber-200',
  },
  low: {
    border: 'border-slate-700', bg: 'bg-slate-900', text: 'text-slate-400',
    chip: 'bg-slate-800 text-slate-300',
  },
};

/**
 * Colours for each kind of line, matching the legend.
 *
 * Kept beside the labels rather than in the component so the key and the
 * drawing cannot drift apart -- a legend that disagrees with the picture is
 * worse than no legend.
 */
export const EDGE_COLOR = {
  peering: '#3b82f6',
  vwan: '#a855f7',
  gateway: '#22c55e',
  nsg: '#ef4444',
  route_table: '#eab308',
  vpn: '#f97316',
  bastion: '#06b6d4',
  nat: '#14b8a6',
  child: '#f43f5e',
};

/**
 * How many lines of each kind are actually on screen.
 */
export function edgeCounts(edges) {
  const counts = {};
  for (const edge of edges || []) {
    if (!edge || !edge.kind) continue;
    counts[edge.kind] = (counts[edge.kind] || 0) + 1;
  }
  return counts;
}

/**
 * The key, reduced to the lines the reader can actually see.
 *
 * A key listing nine kinds of connection when the picture contains two teaches
 * the reader that the key is decoration and not a description, and from then on
 * they stop consulting it. Ordered by how much of the picture each kind
 * accounts for, so the line they are most likely to be asking about is first.
 */
export function activeLegend(counts) {
  return Object.entries(counts || {})
    .filter(([kind, count]) => count > 0 && EDGE_COLOR[kind])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const GEOMETRY = {
  nodeRadius: 15,
  columnGap: 78,
  rowGap: 46,
  hubY: 165,
  crownY: 60,
  spokeTopY: 280,
  minPerRow: 4,
};

/**
 * Which node the picture should be centred on.
 *
 * Prefers a network Azure's own configuration marks as a hub. Between several
 * hubs the most-peered one wins, and ties are broken by name so that two loads
 * of an unchanged estate cannot pick different centres.
 */
export function pickHub(nodes) {
  const vnets = (nodes || []).filter(n => n.kind === 'vnet');
  if (!vnets.length) return null;
  const hubs = vnets.filter(n => n.is_hub);
  const pool = hubs.length ? hubs : vnets;
  return [...pool].sort((a, b) =>
    (b.peering_count || 0) - (a.peering_count || 0)
    || text(a.name).localeCompare(text(b.name))
  )[0];
}

/**
 * The keys of every node with a line to `key`.
 *
 * Used both for the spoke ring and for dimming everything unrelated to a
 * selection, so it is worth having in one place.
 */
export function neighbours(edges, key) {
  const found = new Set();
  for (const edge of edges || []) {
    if (edge.source === key) found.add(edge.target);
    else if (edge.target === key) found.add(edge.source);
  }
  return found;
}

/**
 * How many nodes fit across the canvas.
 *
 * Floored at a few per row so that a narrow window produces a tall diagram
 * rather than a single unreadable column.
 */
export function perRow(width, gap = GEOMETRY.columnGap) {
  return Math.max(GEOMETRY.minPerRow, Math.floor((width - gap) / gap));
}

/**
 * Position every node.
 *
 * Three bands, top to bottom: what sits inside the hub (gateway, firewall,
 * bastion), the hub itself, then everything peered to it. Anything with no path
 * to the hub goes below that in its own band rather than being dropped -- an
 * isolated network is a real and usually interesting thing to see.
 */
export function layoutTopology(nodes, edges, width = 900) {
  const list = nodes || [];
  if (!list.length) return { positions: {}, hubKey: null, height: 0 };

  const hub = pickHub(list);
  const hubKey = hub ? hub.key : null;
  const positions = {};
  const placed = new Set();
  const centre = width / 2;

  if (hub) {
    positions[hubKey] = { x: centre, y: GEOMETRY.hubY };
    placed.add(hubKey);
  }

  const linked = hubKey ? neighbours(edges, hubKey) : new Set();
  const byKey = new Map(list.map(n => [n.key, n]));

  // The crown: things that live inside the hub itself. Placed above it because
  // that is where the estate's edge is -- traffic entering from outside meets
  // these first.
  const crownKinds = new Set(['gateway', 'firewall', 'bastion', 'public_ip']);
  const crown = [...linked]
    .map(k => byKey.get(k))
    .filter(n => n && crownKinds.has(n.kind))
    .sort((a, b) => text(a.name).localeCompare(text(b.name)));

  crown.forEach((node, i) => {
    const offset = (i - (crown.length - 1) / 2) * GEOMETRY.columnGap;
    positions[node.key] = { x: centre + offset, y: GEOMETRY.crownY };
    placed.add(node.key);
  });

  const columns = perRow(width);

  const spokes = [...linked]
    .map(k => byKey.get(k))
    .filter(n => n && !placed.has(n.key))
    .sort((a, b) => text(a.name).localeCompare(text(b.name)));

  let y = GEOMETRY.spokeTopY;
  y = placeGrid(spokes, positions, placed, centre, y, columns);

  // Everything the hub does not reach. Kept visible, and separated by a gap so
  // it reads as "not connected to the rest" rather than as another spoke row.
  const rest = list
    .filter(n => !placed.has(n.key))
    .sort((a, b) => text(a.kind).localeCompare(text(b.kind))
      || text(a.name).localeCompare(text(b.name)));

  if (rest.length) {
    y += GEOMETRY.rowGap;
    y = placeGrid(rest, positions, placed, centre, y, columns);
  }

  return {
    positions,
    hubKey,
    isolatedCount: rest.length,
    height: Math.max(y + GEOMETRY.rowGap * 2, 420),
  };
}

function placeGrid(items, positions, placed, centre, startY, columns) {
  let y = startY;
  for (let i = 0; i < items.length; i += columns) {
    const row = items.slice(i, i + columns);
    row.forEach((node, j) => {
      const offset = (j - (row.length - 1) / 2) * GEOMETRY.columnGap;
      positions[node.key] = { x: centre + offset, y };
      placed.add(node.key);
    });
    y += GEOMETRY.rowGap;
  }
  return y;
}

/**
 * Narrow the diagram to what someone typed.
 *
 * Matches on name, resource group and address space, because those are the
 * three things people have in front of them when they come looking: a name from
 * an alert, a resource group from a ticket, an IP range from a firewall log.
 *
 * Returns every node when the query is empty rather than none -- an empty
 * search box should not blank the page.
 */
export function matchNodes(nodes, query) {
  const q = text(query).toLowerCase();
  if (!q) return nodes || [];
  return (nodes || []).filter(node => {
    const spaces = (node.address_spaces || []).join(' ');
    return [node.name, node.resource_group, node.location, node.type, spaces]
      .some(field => text(field).toLowerCase().includes(q));
  });
}

/**
 * Keep only the edges whose both ends are still on screen.
 *
 * A line with one end filtered away would point off into nothing and imply a
 * connection to whatever happens to be nearby.
 */
export function visibleEdges(edges, nodes) {
  const keys = new Set((nodes || []).map(n => n.key));
  return (edges || []).filter(e => keys.has(e.source) && keys.has(e.target));
}

/**
 * The detail rows for one node.
 *
 * Every value is either a fact from Azure or the words "Not available". Nothing
 * is defaulted to zero or to a plausible-looking placeholder, because a subnet
 * count of 0 and an unknown subnet count lead to different decisions.
 */
export function detailRows(node) {
  if (!node) return [];
  const missing = 'Not available';
  const rows = [
    ['Subscription', node.subscription_id || missing],
    ['Resource Group', node.resource_group || missing],
    ['Name', node.name || missing],
    ['Type', node.type || NODE_LABEL[node.kind] || missing],
    ['Location', node.location || missing],
  ];
  return rows.map(([label, value]) => ({ label, value }));
}

export function addressRows(node) {
  if (!node || node.kind !== 'vnet') return [];
  const spaces = node.address_spaces || [];
  return [
    { label: 'Address Spaces', value: spaces.length ? spaces.join(', ') : 'Not available' },
    // A count is only shown when it was actually read. `subnet_count` is
    // present on every VNet the scan returned, so an undefined value here means
    // the node came from somewhere else, not that the VNet has no subnets.
    {
      label: 'Subnet Count',
      value: Number.isFinite(node.subnet_count) ? String(node.subnet_count) : 'Not available',
    },
    {
      label: 'Peering Count',
      value: Number.isFinite(node.peering_count) ? String(node.peering_count) : 'Not available',
    },
    { label: 'DNS Servers', value: node.dns_label || 'Not available' },
  ];
}

/**
 * The ring colour for each severity, so risk is visible on the diagram itself.
 *
 * Putting the worst finding on the node closes the gap between "there are 43
 * findings" and "that one, there". A list beside a picture makes the reader do
 * the join by hand, and on a 52-node estate they will not.
 */
export const RISK_RING = {
  critical: '#f43f5e',
  high: '#fb923c',
  medium: '#fbbf24',
  low: '#64748b',
};

const RISK_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * The worst finding against each node, keyed the way nodes are keyed.
 *
 * Matching is on resource id, lowercased, because Azure is not consistent about
 * the casing of the ids it returns and a case-sensitive join would silently
 * show a clean ring on a resource that has a critical finding. Falling back to
 * `evidence.vnet` catches findings raised against a subnet, which has no node of
 * its own but belongs to one that does.
 */
export function riskByNode(findings, nodes) {
  const byName = new Map();
  for (const node of nodes || []) {
    if (node.name) byName.set(String(node.name).toLowerCase(), node.key);
  }

  const worst = new Map();
  const mark = (key, severity) => {
    if (!key) return;
    const rank = RISK_RANK[severity] || 0;
    if (!rank) return;
    const held = worst.get(key);
    if (!held || RISK_RANK[held] < rank) worst.set(key, severity);
  };

  for (const finding of findings || []) {
    if (finding.resource_id) mark(String(finding.resource_id).toLowerCase(), finding.severity);
    const parent = finding.evidence && finding.evidence.vnet;
    if (parent) mark(byName.get(String(parent).toLowerCase()), finding.severity);
  }
  return worst;
}

/**
 * Split the estate into what is wired into something and what is not.
 *
 * On a real estate most of the nodes are security groups, route tables and
 * public IPs. Drawn together with the networks they become forty identical
 * circles with no lines, which buries the handful of nodes the diagram exists
 * to show. They are not dropped -- an unattached security group or a public IP
 * pointing at nothing is worth knowing about -- but they are a separate
 * question and get a separate band the reader can collapse.
 */
export function partitionNodes(nodes, edges) {
  const wired = new Set();
  for (const edge of edges || []) {
    wired.add(edge.source);
    wired.add(edge.target);
  }
  const connected = [];
  const unattached = [];
  for (const node of nodes || []) {
    // A network is always structural even with nothing joined to it: an
    // isolated VNet is a finding in its own right, not background noise.
    if (node.kind === 'vnet' || wired.has(node.key)) connected.push(node);
    else unattached.push(node);
  }
  return { connected, unattached };
}

/**
 * Whether a node's name should be painted under it.
 *
 * Past roughly this many nodes the labels collide into a grey smear that is
 * worse than no labels, because it looks like text and cannot be read. Beyond
 * that point names come from hovering and from selection instead.
 */
export function shouldLabel(count, selectedKey, hoveredKey, node) {
  if (!node) return false;
  if (node.key === selectedKey || node.key === hoveredKey) return true;
  if (count <= 24) return true;
  return node.kind === 'vnet';
}

/**
 * A one-line, honest posture line for the header.
 *
 * Deliberately not a score out of a hundred. A number like that implies the
 * page weighed everything in the estate, and this page has read configuration
 * from one resource type family and nothing else.
 */
export function postureLine(summary) {
  const total = (summary && summary.total) || 0;
  if (!total) return 'No findings in the configuration that was read.';
  const parts = [];
  for (const level of ['critical', 'high', 'medium', 'low']) {
    const count = (summary && summary[level]) || 0;
    if (count) parts.push(`${count} ${level}`);
  }
  return parts.join(' · ');
}

