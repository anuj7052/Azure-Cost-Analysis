import { describe, it, expect } from 'vitest';
import {
  layoutTopology, pickHub, neighbours, perRow, matchNodes, visibleEdges,
  detailRows, addressRows, EDGE_COLOR, GEOMETRY,
  edgeCounts, activeLegend, LEGEND_LABEL, LEGEND_HELP,
  NODE_LABEL, NODE_HELP, GLOSSARY, SEVERITY_TONE,
  riskByNode, partitionNodes, shouldLabel, postureLine, RISK_RING,
} from '../src/utils/networkTopology';

const vnet = (name, over = {}) => ({
  key: `/subscriptions/s1/providers/microsoft.network/virtualnetworks/${name}`.toLowerCase(),
  id: `/subscriptions/s1/providers/Microsoft.Network/virtualNetworks/${name}`,
  kind: 'vnet',
  name,
  type: 'virtualNetworks',
  resource_group: 'rg-net',
  subscription_id: 's1',
  location: 'eastus2',
  address_spaces: ['10.0.0.0/16'],
  subnet_count: 2,
  peering_count: 0,
  dns_label: 'Azure Provided',
  is_hub: false,
  ...over,
});

const edge = (source, target, kind = 'peering') => ({ source, target, kind });

const nsg = (name) => ({
  key: `/subscriptions/s1/providers/microsoft.network/networksecuritygroups/${name}`.toLowerCase(),
  id: `/subscriptions/s1/providers/Microsoft.Network/networkSecurityGroups/${name}`,
  kind: 'nsg',
  name,
  type: 'networkSecurityGroups',
  resource_group: 'rg-net',
  subscription_id: 's1',
  location: 'eastus2',
});

describe('choosing the centre of the diagram', () => {
  it('prefers a network Azure marked as a hub', () => {
    const spoke = vnet('spoke', { peering_count: 9 });
    const hub = vnet('hub', { is_hub: true, peering_count: 1 });
    expect(pickHub([spoke, hub]).name).toBe('hub');
  });

  it('falls back to the most peered network when nothing is marked', () => {
    const a = vnet('a', { peering_count: 1 });
    const b = vnet('b', { peering_count: 5 });
    expect(pickHub([a, b]).name).toBe('b');
  });

  it('breaks ties by name so the picture is stable between loads', () => {
    // Two loads of an unchanged estate must not pick different centres, or
    // "did this move?" becomes unanswerable.
    const a = vnet('alpha', { peering_count: 3 });
    const z = vnet('zulu', { peering_count: 3 });
    expect(pickHub([a, z]).name).toBe('alpha');
    expect(pickHub([z, a]).name).toBe('alpha');
  });

  it('ignores non-network resources when picking a centre', () => {
    const nsg = { key: 'nsg-1', kind: 'nsg', name: 'nsg-1' };
    expect(pickHub([nsg])).toBeNull();
  });

  it('returns nothing for an empty estate rather than throwing', () => {
    expect(pickHub([])).toBeNull();
    expect(pickHub(undefined)).toBeNull();
  });
});

describe('neighbours', () => {
  const edges = [edge('a', 'b'), edge('c', 'a'), edge('b', 'c')];

  it('finds links in both directions', () => {
    // An edge is one line; which end is "source" is an implementation detail
    // of whichever VNet Azure listed first.
    expect(neighbours(edges, 'a')).toEqual(new Set(['b', 'c']));
  });

  it('returns an empty set for an unconnected node', () => {
    expect(neighbours(edges, 'lonely').size).toBe(0);
  });

  it('survives no edges at all', () => {
    expect(neighbours(undefined, 'a').size).toBe(0);
  });
});

describe('layout', () => {
  it('is deterministic — same input, same positions', () => {
    const nodes = [vnet('a'), vnet('b'), vnet('hub', { is_hub: true })];
    const edges = [edge(nodes[2].key, nodes[0].key), edge(nodes[2].key, nodes[1].key)];
    const first = layoutTopology(nodes, edges, 900);
    const second = layoutTopology(nodes, edges, 900);
    expect(first.positions).toEqual(second.positions);
  });

  it('puts the hub in the middle', () => {
    const hub = vnet('hub', { is_hub: true });
    const out = layoutTopology([hub], [], 900);
    expect(out.positions[hub.key]).toEqual({ x: 450, y: GEOMETRY.hubY });
    expect(out.hubKey).toBe(hub.key);
  });

  it('places a gateway above the hub, where the estate meets the outside', () => {
    const hub = vnet('hub', { is_hub: true });
    const gw = { key: 'gw', kind: 'gateway', name: 'gw-a' };
    const out = layoutTopology([hub, gw], [edge(hub.key, 'gw', 'gateway')], 900);
    expect(out.positions.gw.y).toBeLessThan(out.positions[hub.key].y);
  });

  it('places peered networks below the hub', () => {
    const hub = vnet('hub', { is_hub: true });
    const spoke = vnet('spoke');
    const out = layoutTopology([hub, spoke], [edge(hub.key, spoke.key)], 900);
    expect(out.positions[spoke.key].y).toBeGreaterThan(out.positions[hub.key].y);
  });

  it('still places a network with no path to the hub', () => {
    // An isolated network is a real and usually interesting thing to see.
    // Dropping it would make it look like it does not exist.
    const hub = vnet('hub', { is_hub: true });
    const island = vnet('island');
    const out = layoutTopology([hub, island], [], 900);
    expect(out.positions[island.key]).toBeTruthy();
    expect(out.isolatedCount).toBe(1);
  });

  it('gives every node a position', () => {
    const nodes = Array.from({ length: 25 }, (_, i) => vnet(`v${i}`));
    nodes[0].is_hub = true;
    const edges = nodes.slice(1).map(n => edge(nodes[0].key, n.key));
    const out = layoutTopology(nodes, edges, 900);
    for (const n of nodes) expect(out.positions[n.key]).toBeTruthy();
  });

  it('grows taller rather than wider on a narrow canvas', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => vnet(`v${i}`));
    nodes[0].is_hub = true;
    const edges = nodes.slice(1).map(n => edge(nodes[0].key, n.key));
    const wide = layoutTopology(nodes, edges, 1600);
    const narrow = layoutTopology(nodes, edges, 500);
    expect(narrow.height).toBeGreaterThan(wide.height);
  });

  it('handles an empty estate', () => {
    expect(layoutTopology([], [], 900)).toEqual({ positions: {}, hubKey: null, height: 0 });
  });
});

describe('perRow', () => {
  it('never drops below a usable minimum', () => {
    // A single unreadable column is worse than a slightly cramped row.
    expect(perRow(120)).toBe(GEOMETRY.minPerRow);
  });

  it('fits more across a wider canvas', () => {
    expect(perRow(1600)).toBeGreaterThan(perRow(800));
  });
});

describe('search', () => {
  const nodes = [
    vnet('vnet-payments', { resource_group: 'rg-prod', address_spaces: ['10.42.1.0/24'] }),
    vnet('vnet-landing', { resource_group: 'rg-dev', location: 'westeurope' }),
  ];

  it('matches on name', () => {
    expect(matchNodes(nodes, 'payments')).toHaveLength(1);
  });

  it('matches on resource group, because tickets quote those', () => {
    expect(matchNodes(nodes, 'rg-dev')[0].name).toBe('vnet-landing');
  });

  it('matches on an address range, because firewall logs quote those', () => {
    expect(matchNodes(nodes, '10.42.')[0].name).toBe('vnet-payments');
  });

  it('matches on region', () => {
    expect(matchNodes(nodes, 'westeurope')).toHaveLength(1);
  });

  it('is case insensitive', () => {
    expect(matchNodes(nodes, 'PAYMENTS')).toHaveLength(1);
  });

  it('shows everything when the box is empty rather than nothing', () => {
    expect(matchNodes(nodes, '')).toHaveLength(2);
    expect(matchNodes(nodes, '   ')).toHaveLength(2);
  });
});

describe('edges follow the filter', () => {
  it('drops a line whose far end was filtered away', () => {
    // A line with one end missing would point into empty space and imply a
    // connection to whatever happens to be drawn nearby.
    const a = vnet('a');
    const b = vnet('b');
    const edges = [edge(a.key, b.key)];
    expect(visibleEdges(edges, [a, b])).toHaveLength(1);
    expect(visibleEdges(edges, [a])).toHaveLength(0);
  });

  it('survives missing input', () => {
    expect(visibleEdges(undefined, undefined)).toEqual([]);
  });
});

describe('the detail panel', () => {
  it('reports every field Azure gave', () => {
    const rows = detailRows(vnet('vnet-a'));
    expect(rows.find(r => r.label === 'Name').value).toBe('vnet-a');
    expect(rows.find(r => r.label === 'Location').value).toBe('eastus2');
  });

  it('says "Not available" rather than inventing a blank', () => {
    const rows = detailRows(vnet('vnet-a', { location: '' }));
    expect(rows.find(r => r.label === 'Location').value).toBe('Not available');
  });

  it('shows nothing at all when no node is selected', () => {
    expect(detailRows(null)).toEqual([]);
  });

  it('distinguishes a real zero from an unknown count', () => {
    // Zero subnets and an unread subnet count lead to different decisions,
    // so they must not render the same.
    const known = addressRows(vnet('a', { subnet_count: 0 }));
    const unknown = addressRows(vnet('a', { subnet_count: undefined }));
    expect(known.find(r => r.label === 'Subnet Count').value).toBe('0');
    expect(unknown.find(r => r.label === 'Subnet Count').value).toBe('Not available');
  });

  it('reports Azure-provided DNS as a configuration, not an absence', () => {
    const rows = addressRows(vnet('a'));
    expect(rows.find(r => r.label === 'DNS Servers').value).toBe('Azure Provided');
  });

  it('has no address section for things that are not networks', () => {
    expect(addressRows({ kind: 'nsg', name: 'nsg-1' })).toEqual([]);
  });
});

describe('the legend', () => {
  it('gives every edge kind a colour', () => {
    for (const colour of Object.values(EDGE_COLOR)) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('uses a distinct colour per kind, or the key is useless', () => {
    const colours = Object.values(EDGE_COLOR);
    expect(new Set(colours).size).toBe(colours.length);
  });
});

describe('the key, reduced to what is on screen', () => {
  it('counts each kind of line', () => {
    const counts = edgeCounts([
      { kind: 'peering' }, { kind: 'peering' }, { kind: 'nsg' },
    ]);
    expect(counts).toEqual({ peering: 2, nsg: 1 });
  });

  it('ignores malformed edges rather than counting an undefined kind', () => {
    expect(edgeCounts([null, {}, { kind: 'nsg' }])).toEqual({ nsg: 1 });
  });

  it('lists only the kinds actually drawn', () => {
    // A key naming nine things when the picture contains two teaches the
    // reader that the key is decoration, and they stop consulting it.
    const shown = activeLegend({ peering: 3, nsg: 1 }).map(([kind]) => kind);
    expect(shown).toEqual(['peering', 'nsg']);
  });

  it('puts the most common line first', () => {
    const shown = activeLegend({ nsg: 1, peering: 9 }).map(([kind]) => kind);
    expect(shown[0]).toBe('peering');
  });

  it('breaks ties by name so the key does not reshuffle between loads', () => {
    const a = activeLegend({ vpn: 2, nsg: 2 });
    const b = activeLegend({ nsg: 2, vpn: 2 });
    expect(a).toEqual(b);
  });

  it('drops kinds with no colour instead of drawing an unexplained line', () => {
    expect(activeLegend({ mystery: 4 })).toEqual([]);
  });

  it('an empty diagram has an empty key', () => {
    expect(activeLegend({})).toEqual([]);
    expect(activeLegend(undefined)).toEqual([]);
  });

  it('every legend entry has a label and an explanation', () => {
    for (const kind of Object.keys(EDGE_COLOR)) {
      expect(LEGEND_LABEL[kind]).toBeTruthy();
      expect(LEGEND_HELP[kind]).toBeTruthy();
    }
  });
});

describe('explaining the estate to somebody who has never seen it', () => {
  it('every node kind that can be drawn has a plain-language description', () => {
    for (const kind of Object.keys(NODE_LABEL)) {
      expect(NODE_HELP[kind]).toBeTruthy();
    }
  });

  it('the glossary defines every term without leaning on jargon', () => {
    expect(GLOSSARY.length).toBeGreaterThan(0);
    for (const { term, meaning } of GLOSSARY) {
      expect(term).toBeTruthy();
      expect(meaning.length).toBeGreaterThan(20);
    }
  });

  it('every severity has a tone, so no finding renders unstyled', () => {
    for (const level of ['critical', 'high', 'medium', 'low']) {
      expect(SEVERITY_TONE[level].chip).toBeTruthy();
      expect(SEVERITY_TONE[level].border).toBeTruthy();
    }
  });
});

describe('showing risk on the diagram itself', () => {
  const nodes = [vnet('hub-vnet'), nsg('bad-nsg')];

  it('marks the node a finding names', () => {
    const risk = riskByNode(
      [{ resource_id: nodes[1].id, severity: 'critical' }], nodes,
    );
    expect(risk.get(nodes[1].id.toLowerCase())).toBe('critical');
  });

  it('matches ids regardless of casing', () => {
    // Azure is not consistent about the casing of the ids it returns. A
    // case-sensitive join would paint a clean ring on a critical finding,
    // which is worse than painting no ring at all.
    const risk = riskByNode(
      [{ resource_id: nodes[1].id.toUpperCase(), severity: 'high' }], nodes,
    );
    expect(risk.get(nodes[1].id.toLowerCase())).toBe('high');
  });

  it('keeps the worst finding when a resource has several', () => {
    const risk = riskByNode([
      { resource_id: nodes[1].id, severity: 'low' },
      { resource_id: nodes[1].id, severity: 'critical' },
      { resource_id: nodes[1].id, severity: 'medium' },
    ], nodes);
    expect(risk.get(nodes[1].id.toLowerCase())).toBe('critical');
  });

  it('does not let a later low finding overwrite an earlier high one', () => {
    const risk = riskByNode([
      { resource_id: nodes[1].id, severity: 'high' },
      { resource_id: nodes[1].id, severity: 'low' },
    ], nodes);
    expect(risk.get(nodes[1].id.toLowerCase())).toBe('high');
  });

  it('raises a subnet finding onto the network that owns it', () => {
    // A subnet has no circle of its own, so a finding against one would be
    // invisible on the diagram unless it surfaces on its parent.
    const risk = riskByNode(
      [{ resource_id: '', severity: 'medium', evidence: { vnet: 'hub-vnet' } }],
      nodes,
    );
    expect(risk.get(nodes[0].key)).toBe('medium');
  });

  it('ignores a severity it does not recognise rather than inventing a ring', () => {
    const risk = riskByNode(
      [{ resource_id: nodes[1].id, severity: 'catastrophic' }], nodes,
    );
    expect(risk.size).toBe(0);
  });

  it('a clean estate produces no rings', () => {
    expect(riskByNode([], nodes).size).toBe(0);
    expect(riskByNode(undefined, undefined).size).toBe(0);
  });

  it('every severity that can be ranked has a ring colour', () => {
    for (const level of ['critical', 'high', 'medium', 'low']) {
      expect(RISK_RING[level]).toBeTruthy();
    }
  });
});

describe('keeping loose resources from burying the diagram', () => {
  it('separates resources with no connection from the rest', () => {
    const hub = vnet('hub');
    const attached = nsg('nsg-a');
    const loose = nsg('nsg-loose');
    const edges = [{ source: hub.key, target: attached.key, kind: 'nsg' }];
    const { connected, unattached } = partitionNodes([hub, attached, loose], edges);
    expect(connected.map(n => n.name)).toEqual(['hub', 'nsg-a']);
    expect(unattached.map(n => n.name)).toEqual(['nsg-loose']);
  });

  it('keeps an isolated network on the diagram', () => {
    // A virtual network with nothing joined to it is a finding in its own
    // right, not background noise, so it stays in the picture.
    const lonely = vnet('vnet-orphan');
    const { connected, unattached } = partitionNodes([lonely], []);
    expect(connected).toHaveLength(1);
    expect(unattached).toHaveLength(0);
  });

  it('nothing is lost between the two halves', () => {
    const all = [vnet('a'), nsg('b'), nsg('c')];
    const { connected, unattached } = partitionNodes(all, []);
    expect(connected.length + unattached.length).toBe(all.length);
  });

  it('an empty estate splits into two empty halves', () => {
    expect(partitionNodes([], [])).toEqual({ connected: [], unattached: [] });
  });
});

describe('deciding when a name is readable', () => {
  const small = vnet('a');
  const group = nsg('b');

  it('labels everything on a small diagram', () => {
    expect(shouldLabel(10, '', '', group)).toBe(true);
  });

  it('drops the noise labels once they would collide', () => {
    // Past this density the labels merge into a grey smear that looks like
    // text and cannot be read, which is worse than no labels.
    expect(shouldLabel(60, '', '', group)).toBe(false);
  });

  it('always labels the networks, however dense', () => {
    expect(shouldLabel(60, '', '', small)).toBe(true);
  });

  it('labels whatever is hovered or selected', () => {
    expect(shouldLabel(60, group.key, '', group)).toBe(true);
    expect(shouldLabel(60, '', group.key, group)).toBe(true);
  });

  it('a missing node is never labelled', () => {
    expect(shouldLabel(5, '', '', null)).toBe(false);
  });
});

describe('the posture line', () => {
  it('lists what was counted, worst first', () => {
    expect(postureLine({ total: 3, critical: 1, high: 2 }))
      .toBe('1 critical · 2 high');
  });

  it('omits levels with nothing in them', () => {
    expect(postureLine({ total: 1, low: 1 })).toBe('1 low');
  });

  it('is never a score out of a hundred', () => {
    // A score implies the page weighed the whole estate. It read one family of
    // resource types and nothing else, and should not imply otherwise.
    const line = postureLine({ total: 5, high: 5 });
    expect(line).not.toMatch(/\/\s*100|%/);
  });

  it('says nothing was found rather than reporting a clean score', () => {
    expect(postureLine({ total: 0 })).toMatch(/No findings/);
    expect(postureLine(undefined)).toMatch(/No findings/);
  });
});
