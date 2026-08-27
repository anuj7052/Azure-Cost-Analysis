import { describe, it, expect } from 'vitest';
import {
  SOURCE, attentionList, correlatedResources, isQuotable, permissionGaps,
  searchSecurity, securityKpis, securityPosture, sourceState,
} from '../src/utils/securityModel';

/**
 * The rule under test throughout this file: on a security page, "denied",
 * "not looked at", "nothing found" and "zero" are four different answers.
 *
 * Almost every assertion here is really the same assertion — that a source
 * which could not be read never contributes a reassuring number. That is the
 * failure mode worth spending a test file on, because it is silent, it looks
 * exactly like good news, and it is the one mistake a security tool must
 * never make.
 */

const denied = (source, sub) => ({
  source, subscription_id: sub, kind: 'permission',
  permission: 'Security Reader (Microsoft.Security/assessments/read)',
  message: 'Access denied.',
});
const throttled = (source, sub) => ({
  source, subscription_id: sub, kind: 'throttled', permission: '', message: 'Rate limited.',
});

const advisorOk = {
  findings: [
    { key: 'a1', title: 'Enable backup', category: 'Reliability', severity: 'High',
      resource_id: '/subscriptions/s1/vm/one', resource_name: 'vm-one',
      subscription_id: 's1', solution: 'Turn on backup', annual_saving: null, currency: '' },
  ],
  summary: { total: 1, high_count: 1, by_subscription: { s1: 1 }, by_severity: {}, by_category: {} },
  errors: [],
  coverage: 'All 1 subscription(s) read successfully.',
};

describe('reading the state of a source', () => {
  it('a source that was never requested is not a clean result', () => {
    const state = sourceState('advisor', null);
    expect(state.state).toBe(SOURCE.NOT_LOADED);
    expect(isQuotable(state)).toBe(false);
  });

  it('a fully denied source reports no access rather than zero findings', () => {
    const state = sourceState('defender', {
      assessments: [], alerts: [], errors: [denied('defender', 's1')],
      summary: { by_subscription: {} }, coverage: 'nothing read',
    });
    expect(state.state).toBe(SOURCE.NO_ACCESS);
    expect(isQuotable(state)).toBe(false);
  });

  it('names the Azure permission that would fix the denial', () => {
    const state = sourceState('defender', {
      assessments: [], alerts: [], errors: [denied('defender', 's1')],
      summary: { by_subscription: {} },
    });
    expect(state.permissions).toEqual([
      'Security Reader (Microsoft.Security/assessments/read)',
    ]);
  });

  it('separates being rate limited from being denied', () => {
    const state = sourceState('policy', {
      non_compliant: [], errors: [throttled('policy', 's1')],
      summary: { by_subscription: {} },
    });
    expect(state.state).toBe(SOURCE.THROTTLED);
    // Nothing was read, so nothing may be quoted -- but nobody should be sent
    // to request a role they already hold.
    expect(state.permissions).toEqual([]);
  });

  it('a partial read is quotable but flagged as partial', () => {
    const state = sourceState('advisor', {
      ...advisorOk,
      errors: [denied('advisor', 's2')],
      summary: { ...advisorOk.summary, by_subscription: { s1: 1 } },
    });
    expect(state.state).toBe(SOURCE.PARTIAL);
    expect(state.read).toBe(1);
    expect(state.requested).toBe(2);
    expect(isQuotable(state)).toBe(true);
  });

  it('distinguishes "read it, found nothing" from "did not read it"', () => {
    const empty = sourceState('advisor', {
      findings: [], errors: [], summary: { by_subscription: { s1: 0 } },
    });
    expect(empty.state).toBe(SOURCE.EMPTY);
    // This one *is* a real measurement and may be quoted as zero.
    expect(isQuotable(empty)).toBe(true);
  });

  it('does not count the literal "unknown" bucket as a subscription', () => {
    const state = sourceState('advisor', {
      ...advisorOk,
      summary: { ...advisorOk.summary, by_subscription: { s1: 1, unknown: 4 } },
    });
    expect(state.requested).toBe(1);
  });

  it('trusts an explicit subscription count over the reconstructed one', () => {
    const state = sourceState('rbac', {
      principals: [{ principal_id: 'p1' }], errors: [], subscription_count: 9,
    });
    expect(state.requested).toBe(9);
  });
});

describe('KPIs', () => {
  const sources = {
    advisor: sourceState('advisor', advisorOk),
    defender: sourceState('defender', null),
    policy: sourceState('policy', null),
    access: sourceState('access', null),
    rbac: sourceState('rbac', null),
  };

  it('omits a card entirely when its source was not read', () => {
    const cards = securityKpis(sources, { advisor: advisorOk });
    expect(cards.some(c => c.source === 'defender')).toBe(false);
    expect(cards.some(c => c.source === 'advisor')).toBe(true);
  });

  it('never renders a zero for a denied source', () => {
    const deniedDefender = {
      assessments: [], alerts: [], errors: [denied('defender', 's1')],
      summary: { by_subscription: {} },
    };
    const cards = securityKpis(
      { ...sources, defender: sourceState('defender', deniedDefender) },
      { advisor: advisorOk, defender: deniedDefender },
    );
    expect(cards.some(c => c.source === 'defender')).toBe(false);
  });

  it('marks a partial count as a floor rather than a total', () => {
    const partial = { ...advisorOk, errors: [denied('advisor', 's2')] };
    const cards = securityKpis(
      { ...sources, advisor: sourceState('advisor', partial) },
      { advisor: partial },
    );
    const card = cards.find(c => c.id === 'advisor');
    expect(card.partial).toBe(true);
    expect(card.readNote).toContain('floor, not a total');
  });

  it('quotes the secure score only when Azure supplied one', () => {
    const withoutScore = { assessments: [], alerts: [], errors: [], secure_score_overall: null, summary: { by_subscription: { s1: 0 } } };
    const cards = securityKpis(
      { ...sources, defender: sourceState('defender', withoutScore) },
      { defender: withoutScore },
    );
    expect(cards.some(c => c.id === 'secure-score')).toBe(false);
  });
});

describe('posture', () => {
  const none = {
    advisor: sourceState('advisor', null),
    defender: sourceState('defender', null),
    policy: sourceState('policy', null),
    access: sourceState('access', null),
    rbac: sourceState('rbac', null),
  };

  it('refuses to score a dimension whose source was never read', () => {
    const dims = securityPosture(none, {});
    expect(dims.every(d => d.score === null)).toBe(true);
  });

  it('says "not available" for denial and "not enough data" for an empty read', () => {
    const deniedPolicy = { non_compliant: [], errors: [denied('policy', 's1')], summary: { by_subscription: {} } };
    const readButEmpty = { non_compliant: [], errors: [], compliance_rate: null, summary: { by_subscription: { s1: 0 } } };

    const a = securityPosture({ ...none, policy: sourceState('policy', deniedPolicy) }, { policy: deniedPolicy });
    const b = securityPosture({ ...none, policy: sourceState('policy', readButEmpty) }, { policy: readButEmpty });

    expect(a.find(d => d.key === 'policy').verdict).toBe('Not available');
    expect(b.find(d => d.key === 'policy').verdict).toBe('Not enough data');
  });

  it('quotes the Microsoft secure score rather than recomputing one', () => {
    const defender = {
      assessments: [], alerts: [], errors: [],
      summary: { by_subscription: { s1: 0 } },
      secure_score_overall: { current: 30, max: 60, percentage: 50, subscription_count: 1 },
    };
    const dim = securityPosture({ ...none, defender: sourceState('defender', defender) }, { defender })
      .find(d => d.key === 'defender');
    expect(dim.score).toBe(50);
    expect(dim.basis).toContain('30 of 60 points');
  });

  it('explains an identity score in terms of the principals it counted', () => {
    const rbac = {
      principals: [{ principal_id: 'p' }], errors: [], subscription_count: 1,
      totals: { principal_count: 10, critical_count: 2, assignment_count: 40 },
    };
    const dim = securityPosture({ ...none, rbac: sourceState('rbac', rbac) }, { rbac })
      .find(d => d.key === 'rbac');
    expect(dim.score).toBe(80);
    expect(dim.basis).toContain('2 of 10 principal(s)');
  });

  it('never produces a single combined score', () => {
    const dims = securityPosture(none, {});
    expect(dims.some(d => /overall|total|combined/i.test(d.name))).toBe(false);
  });
});

describe('what needs attention', () => {
  const defender = {
    errors: [],
    summary: { by_subscription: { s1: 0 } },
    assessments: [
      { key: 'd1', title: 'Disk not encrypted', severity: 'High',
        resource_id: '/subscriptions/s1/vm/one', resource_name: 'vm-one',
        subscription_id: 's1', description: 'why', solution: 'encrypt it' },
    ],
    alerts: [
      { key: 'al1', title: 'Suspicious sign-in', severity: 'High',
        resource_id: '/subscriptions/s1/vm/one', resource_name: 'vm-one',
        subscription_id: 's1', description: 'seen', solution: 'investigate' },
    ],
  };
  const sources = {
    advisor: sourceState('advisor', advisorOk),
    defender: sourceState('defender', defender),
    policy: sourceState('policy', null),
    access: sourceState('access', null),
    rbac: sourceState('rbac', null),
  };

  it('ranks an alert above a configuration finding of equal severity', () => {
    const { rows } = attentionList(sources, { defender, advisor: advisorOk });
    const alert = rows.findIndex(r => r.category === 'Defender alert');
    const assessment = rows.findIndex(r => r.category === 'Defender recommendation');
    // An alert says something may already have happened.
    expect(alert).toBeLessThan(assessment);
  });

  it('collapses one Azure finding repeated across subscriptions into a single row', () => {
    const repeated = {
      ...advisorOk,
      findings: [
        { ...advisorOk.findings[0], subscription_id: 's1' },
        { ...advisorOk.findings[0], subscription_id: 's2' },
        { ...advisorOk.findings[0], subscription_id: 's3' },
      ],
    };
    const { rows } = attentionList(
      { ...sources, advisor: sourceState('advisor', repeated) },
      { advisor: repeated },
    );
    const row = rows.find(r => r.source === 'advisor');
    expect(row.affected).toBe(3);
    expect(row.subscriptions).toEqual(['s1', 's2', 's3']);
    expect(rows.filter(r => r.source === 'advisor')).toHaveLength(1);
  });

  it('every row carries a stable unique key', () => {
    const { rows } = attentionList(sources, { defender, advisor: advisorOk });
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
  });

  it('contributes nothing at all from a denied source', () => {
    const deniedDefender = {
      assessments: defender.assessments, alerts: defender.alerts,
      errors: [denied('defender', 's1')], summary: { by_subscription: {} },
    };
    const { rows } = attentionList(
      { ...sources, defender: sourceState('defender', deniedDefender) },
      { defender: deniedDefender, advisor: advisorOk },
    );
    expect(rows.every(r => r.source !== 'defender')).toBe(true);
  });
});

describe('cross-module correlation', () => {
  it('lists a resource flagged by two sources without inventing a score', () => {
    const defender = {
      errors: [], summary: { by_subscription: { s1: 0 } }, alerts: [],
      assessments: [{ key: 'd1', title: 'Disk not encrypted', severity: 'High',
        resource_id: '/subscriptions/s1/vm/one', resource_name: 'vm-one', subscription_id: 's1' }],
    };
    const sources = {
      advisor: sourceState('advisor', advisorOk),
      defender: sourceState('defender', defender),
      policy: sourceState('policy', null), access: sourceState('access', null), rbac: sourceState('rbac', null),
    };
    const { rows } = correlatedResources(sources, { advisor: advisorOk, defender });
    expect(rows).toHaveLength(1);
    expect(rows[0].issueCount).toBe(2);
    expect(rows[0].sources).toEqual(['Azure Advisor', 'Microsoft Defender']);
    expect(rows[0]).not.toHaveProperty('score');
  });

  it('ignores a resource that only one source mentions', () => {
    const sources = {
      advisor: sourceState('advisor', advisorOk),
      defender: sourceState('defender', null), policy: sourceState('policy', null),
      access: sourceState('access', null), rbac: sourceState('rbac', null),
    };
    expect(correlatedResources(sources, { advisor: advisorOk }).rows).toHaveLength(0);
  });
});

describe('permission gaps', () => {
  it('reports each unreadable source with the role that would fix it', () => {
    const deniedDefender = {
      assessments: [], alerts: [], errors: [denied('defender', 's1')], summary: { by_subscription: {} },
    };
    const gaps = permissionGaps({
      defender: sourceState('defender', deniedDefender),
      advisor: sourceState('advisor', advisorOk),
      policy: sourceState('policy', null),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].label).toBe('Microsoft Defender');
    expect(gaps[0].permissions[0]).toContain('Security Reader');
  });

  it('a source that was simply never read is not reported as a permission gap', () => {
    const gaps = permissionGaps({ policy: sourceState('policy', null) });
    expect(gaps).toHaveLength(0);
  });
});

describe('search', () => {
  const sources = {
    advisor: sourceState('advisor', advisorOk),
    defender: sourceState('defender', null), policy: sourceState('policy', null),
    access: sourceState('access', null), rbac: sourceState('rbac', null),
  };

  it('says nothing until there is something to match on', () => {
    expect(searchSecurity(sources, { advisor: advisorOk }, 'a')).toBeNull();
  });

  it('finds a resource by name', () => {
    const result = searchSecurity(sources, { advisor: advisorOk }, 'vm-one');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].route).toBe('/advisor');
  });

  it('states which sources it could not search, so no match is not proof of absence', () => {
    const result = searchSecurity(sources, { advisor: advisorOk }, 'nothing-matches');
    expect(result.rows).toHaveLength(0);
    expect(result.unread).toContain('Microsoft Defender');
    expect(result.note).toContain('not been read');
  });
});

// ---------------------------------------------------------------------------
// Action centre, per-subscription rollup and trends
// ---------------------------------------------------------------------------

import { actionCentre, subscriptionSecurity, securityTrend } from '../src/utils/securityModel';

const quotable = (key, payload) => sourceState(key, payload);
const nothing = key => sourceState(key, null);

describe('the action centre', () => {
  const defender = {
    errors: [], summary: { by_subscription: { s1: 2 }, high_count: 1 },
    alerts: [{ key: 'a1', severity: 'High', resource_name: 'prod-vm', title: 'Suspicious sign-in' }],
    assessments: [{ key: 'd1', severity: 'High', resource_name: 'prod-vm', title: 'Disk not encrypted' }],
  };

  it('puts an active alert above every configuration finding', () => {
    const items = actionCentre(
      { defender: quotable('defender', defender), advisor: nothing('advisor'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { defender },
    );
    expect(items[0].id).toBe('defender-alerts');
    expect(items[0].severity).toBe('critical');
  });

  it('names the affected resource rather than only counting it', () => {
    const items = actionCentre(
      { defender: quotable('defender', defender), advisor: nothing('advisor'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { defender },
    );
    expect(items[0].resource).toBe('prod-vm');
  });

  it('sends the button to a page already filtered to the rows it counted', () => {
    const items = actionCentre(
      { defender: quotable('defender', defender), advisor: nothing('advisor'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { defender },
    );
    expect(items.find(i => i.id === 'defender-high').route).toBe('/defender?severity=high');
    // Every action must be able to go somewhere. A dead button is worse than
    // no button, because it costs the user a click to learn nothing.
    expect(items.every(i => typeof i.route === 'string' && i.route.startsWith('/'))).toBe(true);
  });

  it('offers no action at all for a source that could not be read', () => {
    const items = actionCentre(
      { defender: nothing('defender'), advisor: nothing('advisor'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      {},
    );
    expect(items).toHaveLength(0);
  });

  it('drops a job with nothing to do rather than showing a zero', () => {
    const clean = { errors: [], summary: { by_subscription: { s1: 0 }, high_count: 0 }, alerts: [], assessments: [] };
    const items = actionCentre(
      { defender: quotable('defender', clean), advisor: nothing('advisor'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { defender: clean },
    );
    expect(items).toHaveLength(0);
  });
});

describe('the per-subscription breakdown', () => {
  const subs = [{ subscription_id: 's1', display_name: 'Production' }, { subscription_id: 's2', display_name: 'Dev' }];

  it('shows a denied subscription as unknown, never as zero', () => {
    const advisor = {
      findings: [], summary: { by_subscription: { s1: 4 } },
      errors: [denied('advisor', 's2')],
    };
    const rows = subscriptionSecurity(
      { advisor: quotable('advisor', advisor), defender: nothing('defender'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { advisor }, subs,
    );
    const dev = rows.find(r => r.id === 's2');
    expect(dev.advisor.known).toBe(false);
    expect(dev.advisor.count).toBeNull();
    expect(dev.issues).toBeNull();
  });

  it('counts a genuine zero as a zero', () => {
    const advisor = { findings: [], summary: { by_subscription: { s1: 4, s2: 0 } }, errors: [] };
    const rows = subscriptionSecurity(
      { advisor: quotable('advisor', advisor), defender: nothing('defender'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { advisor }, subs,
    );
    expect(rows.find(r => r.id === 's2').advisor).toMatchObject({ known: true, count: 0 });
  });

  it('sorts the worst subscription first and the unknown one last', () => {
    const advisor = {
      findings: [], summary: { by_subscription: { s1: 1, s2: 9 } }, errors: [],
    };
    const rows = subscriptionSecurity(
      { advisor: quotable('advisor', advisor), defender: nothing('defender'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { advisor }, [...subs, { subscription_id: 's3', display_name: 'Unread' }],
    );
    expect(rows.map(r => r.id)).toEqual(['s2', 's1', 's3']);
  });

  it('names which sources it knows nothing about for a row', () => {
    const advisor = { findings: [], summary: { by_subscription: { s1: 1 } }, errors: [] };
    const rows = subscriptionSecurity(
      { advisor: quotable('advisor', advisor), defender: nothing('defender'), policy: nothing('policy'), access: nothing('access'), rbac: nothing('rbac') },
      { advisor }, [subs[0]],
    );
    expect(rows[0].complete).toBe(false);
    expect(rows[0].unknownSources).toContain('Microsoft Defender');
  });
});

describe('trends', () => {
  const at = days => new Date(Date.now() - days * 86400000).toISOString();

  it('refuses to draw a line through a single reading', () => {
    const trend = securityTrend([{ captured_at: at(1), finding_count: 10, errors: [] }]);
    expect(trend.ready).toBe(false);
    expect(trend.note).toContain('at least two');
  });

  it('says so plainly when nothing has been saved yet', () => {
    expect(securityTrend([]).note).toContain('No readings');
  });

  it('excludes a truncated reading, which would look like a sudden improvement', () => {
    const trend = securityTrend([
      { captured_at: at(5), finding_count: 100, errors: [] },
      { captured_at: at(3), finding_count: 12, errors: [], truncated: true },
      { captured_at: at(1), finding_count: 98, errors: [] },
    ]);
    expect(trend.series).toHaveLength(2);
    expect(trend.series.map(p => p.total)).toEqual([100, 98]);
  });

  it('reports movement between two dated readings rather than a rate', () => {
    const trend = securityTrend([
      { captured_at: at(5), finding_count: 100, high_count: 10, errors: [] },
      { captured_at: at(1), finding_count: 80, high_count: 4, errors: [] },
    ]);
    expect(trend.ready).toBe(true);
    expect(trend.change).toBe(-20);
    expect(trend.direction).toBe('down');
    expect(trend.note).toMatch(/100 finding\(s\) on .+, 80 on /);
  });

  it('ignores readings older than the window', () => {
    const trend = securityTrend([
      { captured_at: at(200), finding_count: 5, errors: [] },
      { captured_at: at(180), finding_count: 6, errors: [] },
    ], 30);
    expect(trend.ready).toBe(false);
  });

  it('admits when a reading in the series did not cover everything', () => {
    const trend = securityTrend([
      { captured_at: at(5), finding_count: 100, errors: [denied('advisor', 's2')] },
      { captured_at: at(1), finding_count: 80, errors: [] },
    ]);
    expect(trend.note).toContain('did not cover every subscription');
  });
});

describe('rows a person has to tell apart', () => {
  it('distinguishes one principal holding the same role in three places', () => {
    const access = {
      errors: [], totals: {}, summary: { by_subscription: { s1: 3 } },
      findings: [1, 2, 3].map(n => ({
        kind: 'unused', severity: 'high', principal_id: 'p1', principal_name: 'p1',
        scope: `/providers/Microsoft.Management/managementGroups/mg-${n}`,
        scope_kind: 'management group', subscription_id: 's1',
        headline: 'p1 has not used Owner', detail: 'No activity.',
      })),
    };
    const { rows } = attentionList(
      { access: sourceState('access', access), advisor: nothing('advisor'), defender: nothing('defender'), policy: nothing('policy'), rbac: nothing('rbac') },
      { access },
    );
    expect(rows).toHaveLength(3);
    // The headline is identical for all three, so without the scope line the
    // page shows the same sentence three times and looks broken.
    expect(new Set(rows.map(r => r.where)).size).toBe(3);
    expect(rows[0].where).toBe('management group: mg-1');
  });

  it('does not pass a bare object id off as somebody\u2019s name', () => {
    const access = {
      errors: [], totals: {}, summary: { by_subscription: { s1: 1 } },
      findings: [{
        kind: 'unused', severity: 'high',
        principal_id: '265b1023-8610-487b-8eac-76245f735289',
        principal_name: '265b1023-8610-487b-8eac-76245f735289',
        scope: '/subscriptions/s1', scope_kind: 'subscription', subscription_id: 's1',
        headline: 'has not used Owner', detail: '',
      }],
    };
    const { rows } = attentionList(
      { access: sourceState('access', access), advisor: nothing('advisor'), defender: nothing('defender'), policy: nothing('policy'), rbac: nothing('rbac') },
      { access },
    );
    expect(rows[0].resource).toBe('Unnamed principal · 265b1023…');
  });

  it('does not echo the title back as the recommended action', () => {
    const advisor = {
      errors: [], summary: { by_subscription: { s1: 1 } },
      findings: [{
        key: 'a1', severity: 'High', title: 'Restrict all network ports',
        solution: 'Restrict all network ports', resource_name: 'vm', subscription_id: 's1',
      }],
    };
    const { rows } = attentionList(
      { advisor: sourceState('advisor', advisor), access: nothing('access'), defender: nothing('defender'), policy: nothing('policy'), rbac: nothing('rbac') },
      { advisor },
    );
    expect(rows[0].action).toBe('');
  });
});
