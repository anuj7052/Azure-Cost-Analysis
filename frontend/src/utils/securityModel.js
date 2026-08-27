/**
 * Turning five Azure security responses into one readable answer.
 *
 * The governing rule for this whole file, and the reason it is pure and
 * separately tested: on a security page, *absent*, *zero*, *denied* and
 * *not looked at* are four different answers, and only one of them means
 * "nothing is wrong". Every function here refuses to collapse them.
 *
 * Concretely that means a source which returned 403 never contributes a zero,
 * never lowers a score, and never lets a KPI render. It contributes a named
 * gap instead. The alternative -- treating a missing permission as a clean
 * result -- is the single most dangerous thing this application could do.
 *
 * Severity vocabulary and the display primitives are imported from estate.js
 * rather than restated, so the two command centres cannot drift into ranking
 * the same finding differently.
 */
import { NOT_AVAILABLE, SEVERITY_RANK, isNum } from './estate';

export const INSUFFICIENT = 'Not enough data';

/** What state a single source is in. Rendered differently in every case. */
export const SOURCE = {
  NOT_LOADED: 'not_loaded',
  LOADING: 'loading',
  NO_ACCESS: 'no_access',
  THROTTLED: 'throttled',
  PARTIAL: 'partial',
  EMPTY: 'empty',
  OK: 'ok',
};

/** The six modules, in navigation order, with the routes findings link to. */
export const MODULE_ROUTE = {
  access: '/access-optimization',
  rbac: '/role-assignments',
  advisor: '/advisor',
  defender: '/defender',
  policy: '/policy',
};

const MODULE_LABEL = {
  access: 'Access Optimisation',
  rbac: 'Role Assignments',
  advisor: 'Azure Advisor',
  defender: 'Microsoft Defender',
  policy: 'Policy Governance',
};

/**
 * Read the `errors[]` every security endpoint returns into a per-source verdict.
 *
 * The kinds come from the backend unchanged (`permission`, `throttled`,
 * `unavailable`, `error`) precisely so that this layer never has to guess what
 * a failure meant.
 */
export function sourceState(key, data, { loading = false, error = null } = {}) {
  const label = MODULE_LABEL[key] || key;
  const base = { key, label, route: MODULE_ROUTE[key] || null };

  if (loading && !data) return { ...base, state: SOURCE.LOADING, note: 'Reading Azure…' };
  if (!data && error) {
    return { ...base, state: SOURCE.NO_ACCESS, note: error, denied: 0, read: 0, requested: 0 };
  }
  if (!data) {
    return { ...base, state: SOURCE.NOT_LOADED, note: 'Not read yet in this session.' };
  }

  const errors = Array.isArray(data.errors) ? data.errors : [];
  const denied = errors.filter(e => e?.kind === 'permission');
  const throttled = errors.filter(e => e?.kind === 'throttled');
  const requested = countRequested(data, errors);
  const read = Math.max(requested - uniqueSubs(errors).length, 0);

  const permissions = [...new Set(denied.map(e => e?.permission).filter(Boolean))];

  // Everything denied is not a partial answer, it is no answer.
  if (requested > 0 && read === 0 && denied.length > 0) {
    return {
      ...base,
      state: SOURCE.NO_ACCESS,
      requested,
      read: 0,
      denied: denied.length,
      permissions,
      note: data.coverage || 'Every selected subscription refused this read.',
    };
  }

  if (requested > 0 && read === 0 && throttled.length > 0) {
    return {
      ...base,
      state: SOURCE.THROTTLED,
      requested,
      read: 0,
      permissions: [],
      note: data.coverage || 'Azure rate limited every subscription for this source.',
    };
  }

  const state = errors.length > 0
    ? SOURCE.PARTIAL
    : (countFindings(key, data) === 0 ? SOURCE.EMPTY : SOURCE.OK);

  return {
    ...base,
    state,
    requested,
    read,
    denied: denied.length,
    permissions,
    truncated: Boolean(data.truncated),
    note: data.coverage || '',
  };
}

function uniqueSubs(errors) {
  return [...new Set(errors.map(e => e?.subscription_id).filter(Boolean))];
}

/**
 * How many subscriptions the answer was asked about.
 *
 * Only `/role-assignments` states this outright. For the others it is
 * reconstructed from the summary's per-subscription buckets plus the failures,
 * because a coverage fraction invented from the wrong denominator is worse
 * than no fraction at all.
 */
function countRequested(data, errors) {
  if (isNum(data.subscription_count)) return data.subscription_count;
  const buckets = data.summary?.by_subscription;
  const succeeded = buckets && typeof buckets === 'object'
    ? Object.keys(buckets).filter(k => k && k !== 'unknown').length
    : 0;
  return succeeded + uniqueSubs(errors).length;
}

function countFindings(key, data) {
  switch (key) {
    case 'advisor': return len(data.findings);
    case 'defender': return len(data.assessments) + len(data.alerts);
    case 'policy': return len(data.non_compliant);
    case 'access': return len(data.findings);
    case 'rbac': return len(data.principals);
    default: return 0;
  }
}

const len = (v) => (Array.isArray(v) ? v.length : 0);

/**
 * Whether a source may be quoted as a number at all.
 *
 * A KPI is only honest when something was actually read. `EMPTY` qualifies --
 * "0 findings across 9 subscriptions read" is a real measurement -- but
 * `NO_ACCESS`, `THROTTLED` and `NOT_LOADED` do not.
 */
export function isQuotable(source) {
  return source?.state === SOURCE.OK
    || source?.state === SOURCE.EMPTY
    || source?.state === SOURCE.PARTIAL;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

/**
 * The headline numbers, each one omitted rather than faked.
 *
 * Every card carries the source it came from and a `partial` flag, because
 * "47 findings" from six of nine subscriptions is a floor, not a total, and
 * presenting it as a total invites the wrong conclusion.
 */
export function securityKpis(sources, data) {
  const cards = [];

  const add = (key, card) => {
    const source = sources[key];
    if (!isQuotable(source)) return;
    cards.push({
      ...card,
      source: key,
      route: MODULE_ROUTE[key],
      partial: source.state === SOURCE.PARTIAL,
      readNote: source.state === SOURCE.PARTIAL
        ? `${source.read} of ${source.requested} subscriptions read — this is a floor, not a total.`
        : '',
    });
  };

  const rbac = data.rbac?.totals;
  if (rbac) {
    add('rbac', {
      id: 'principals',
      label: 'Principals with access',
      value: rbac.principal_count,
      hint: `${rbac.assignment_count ?? 0} assignment(s)`,
    });
    add('rbac', {
      id: 'privileged',
      label: 'Privileged assignments',
      value: rbac.critical_count,
      hint: 'Owner or equivalent',
      tone: rbac.critical_count > 0 ? 'high' : 'good',
    });
  }

  const access = data.access?.totals;
  if (access) {
    add('access', {
      id: 'high-risk-access',
      label: 'High-risk access findings',
      value: access.high_count,
      hint: `${access.finding_count ?? 0} finding(s) in total`,
      tone: access.high_count > 0 ? 'high' : 'good',
    });
  }

  const advisor = data.advisor?.summary;
  if (advisor) {
    add('advisor', {
      id: 'advisor',
      label: 'Advisor recommendations',
      value: advisor.total,
      hint: `${advisor.high_count ?? 0} high impact`,
    });
  }

  const defender = data.defender;
  if (defender) {
    add('defender', {
      id: 'defender',
      label: 'Defender findings',
      value: len(defender.assessments),
      hint: `${len(defender.alerts)} active alert(s)`,
      tone: len(defender.alerts) > 0 ? 'critical' : (len(defender.assessments) > 0 ? 'high' : 'good'),
    });
    const score = defender.secure_score_overall;
    if (score && isNum(score.percentage)) {
      add('defender', {
        id: 'secure-score',
        label: 'Secure score',
        value: `${score.percentage}%`,
        hint: `${score.current} of ${score.max} points`,
      });
    }
  }

  const policy = data.policy;
  if (policy) {
    if (isNum(policy.compliance_rate)) {
      add('policy', {
        id: 'compliance',
        label: 'Policy compliance',
        value: `${policy.compliance_rate}%`,
        hint: `${policy.evaluated_count ?? 0} resource evaluation(s)`,
        tone: policy.compliance_rate >= 90 ? 'good' : 'high',
      });
    }
    add('policy', {
      id: 'non-compliant',
      label: 'Non-compliant resources',
      value: len(policy.non_compliant),
      hint: policy.evaluated_count
        ? `of ${policy.evaluated_count} evaluated`
        : 'Nothing evaluated yet',
      tone: len(policy.non_compliant) > 0 ? 'high' : 'good',
    });
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

/**
 * Four posture dimensions, each computed from findings that were actually read.
 *
 * There is no overall score and there will not be one. Averaging identity
 * hygiene against patch compliance produces a number that moves for reasons
 * nobody can explain, and a security figure nobody can explain is one nobody
 * should act on. Each dimension states its own basis instead.
 */
export function securityPosture(sources, data) {
  const dims = [];

  const push = (key, name, measures, compute) => {
    const source = sources[key];
    if (!isQuotable(source)) {
      dims.push({
        key, name, measures,
        score: null,
        verdict: source?.state === SOURCE.NO_ACCESS ? NOT_AVAILABLE : INSUFFICIENT,
        basis: source?.note || 'This source has not been read.',
        route: MODULE_ROUTE[key],
      });
      return;
    }
    const result = compute();
    dims.push({
      key, name, measures, route: MODULE_ROUTE[key],
      partial: source.state === SOURCE.PARTIAL,
      ...result,
    });
  };

  push('rbac', 'Identity security',
    'Share of principals holding Owner-level access',
    () => {
      const t = data.rbac?.totals || {};
      const principals = t.principal_count || 0;
      if (!principals) {
        return { score: null, verdict: INSUFFICIENT, basis: 'No role assignments were returned for this scope.' };
      }
      const privileged = t.critical_count || 0;
      const share = (privileged / principals) * 100;
      return {
        score: Math.round(100 - Math.min(share, 100)),
        verdict: null,
        basis: `${privileged} of ${principals} principal(s) hold Owner-level access (${share.toFixed(1)}%).`,
      };
    });

  push('access', 'Access hygiene',
    'Share of access findings rated high severity',
    () => {
      const t = data.access?.totals || {};
      const assignments = t.assignment_count || 0;
      if (!assignments) {
        return { score: null, verdict: INSUFFICIENT, basis: 'No assignments were available to review.' };
      }
      const findings = t.finding_count || 0;
      const share = (findings / assignments) * 100;
      return {
        score: Math.round(100 - Math.min(share, 100)),
        verdict: null,
        basis: `${findings} finding(s) across ${assignments} assignment(s) reviewed.`,
      };
    });

  push('defender', 'Defender coverage',
    'Microsoft secure score, as Azure calculates it',
    () => {
      const score = data.defender?.secure_score_overall;
      const plans = data.defender?.plan_coverage;
      if (!score || !isNum(score.percentage)) {
        return {
          score: null,
          verdict: INSUFFICIENT,
          basis: plans?.note || 'Azure did not return a secure score for these subscriptions.',
        };
      }
      return {
        score: Math.round(score.percentage),
        verdict: null,
        // Quoted, never recomputed. This is Microsoft's number.
        basis: `Microsoft secure score: ${score.current} of ${score.max} points across `
          + `${score.subscription_count ?? 0} subscription(s).`
          + (plans?.unmonitored ? ` ${plans.note}` : ''),
      };
    });

  push('policy', 'Policy compliance',
    'Compliant resource evaluations, as Azure Policy reports them',
    () => {
      const rate = data.policy?.compliance_rate;
      if (!isNum(rate)) {
        return { score: null, verdict: INSUFFICIENT, basis: 'Azure Policy returned no evaluations for this scope.' };
      }
      const evaluated = data.policy?.evaluated_count || 0;
      return {
        score: Math.round(rate),
        verdict: null,
        basis: `${data.policy?.compliant_count ?? 0} of ${evaluated} resource evaluation(s) compliant.`
          + (data.policy?.truncated ? ' This reading was cut short by Azure paging, so it covers only part of the estate.' : ''),
      };
    });

  return dims;
}

// ---------------------------------------------------------------------------
// What needs attention
// ---------------------------------------------------------------------------

const severityOf = (raw) => {
  const value = String(raw || '').toLowerCase();
  if (value in SEVERITY_RANK) return value;
  if (value === 'informational') return 'info';
  if (value === 'error') return 'high';
  if (value === 'warning') return 'medium';
  return 'low';
};

/**
 * One ranked list drawn from all five sources.
 *
 * Two things matter here beyond sorting. First, a finding is keyed by source
 * plus its Azure id, so the same recommendation published against nine
 * subscriptions does not appear nine times -- it appears once, saying it
 * affects nine. Second, nothing is invented: every row carries the resource and
 * the reason Azure itself gave.
 */
export function attentionList(sources, data, limit = 12) {
  const rows = [];

  const take = (key, items, map) => {
    if (!isQuotable(sources[key])) return;
    for (const item of (Array.isArray(items) ? items : [])) {
      const row = map(item);
      if (row) rows.push({ ...row, source: key, route: MODULE_ROUTE[key] });
    }
  };

  take('defender', data.defender?.alerts, (a) => ({
    key: `defender-alert:${a.key || a.id}`,
    severity: severityOf(a.severity),
    category: 'Defender alert',
    title: a.title || 'Unnamed alert',
    resource: a.resource_name || a.resource_id || '',
    subscriptionId: a.subscription_id || '',
    reason: a.description || '',
    action: a.solution || 'Investigate in Microsoft Defender for Cloud.',
    // An alert is the only finding class that says something may already have
    // happened, so it outranks configuration findings of equal severity.
    urgent: true,
  }));

  take('defender', data.defender?.assessments, (a) => ({
    key: `defender:${a.key || a.id}`,
    severity: severityOf(a.severity),
    category: 'Defender recommendation',
    title: a.title || 'Unnamed assessment',
    resource: a.resource_name || a.resource_id || '',
    subscriptionId: a.subscription_id || '',
    reason: a.description || a.cause || '',
    action: a.solution || '',
  }));

  take('access', data.access?.findings, (f) => ({
    key: `access:${f.kind}:${f.principal_id}:${f.scope}`,
    severity: severityOf(f.severity),
    category: 'Access optimisation',
    title: f.headline || 'Access finding',
    resource: namedPrincipal(f),
    // Without this, one principal holding Owner on three management groups
    // produces three rows whose visible text is identical, because the backend
    // headline says "this management group" without naming which.
    where: f.scope_kind ? `${f.scope_kind}: ${shortScope(f.scope)}` : '',
    subscriptionId: f.subscription_id || '',
    reason: f.detail || '',
    action: 'Review this grant before removing it.',
  }));

  take('advisor', data.advisor?.findings, (f) => ({
    key: `advisor:${f.key || f.id}`,
    severity: severityOf(f.severity),
    category: `Advisor · ${f.category || 'General'}`,
    title: f.title || 'Advisor recommendation',
    resource: f.resource_name || f.resource_id || '',
    subscriptionId: f.subscription_id || '',
    reason: '',
    action: f.solution || '',
    saving: isNum(f.annual_saving) ? f.annual_saving : null,
    currency: f.currency || '',
  }));

  take('policy', data.policy?.non_compliant, (p) => ({
    key: `policy:${p.key || p.resource_id}`,
    severity: severityOf(p.severity),
    category: 'Policy violation',
    title: p.title || p.assignment_name || 'Non-compliant resource',
    resource: p.resource_name || p.resource_id || '',
    subscriptionId: p.subscription_id || '',
    reason: `Compliance state: ${p.compliance_state || 'unknown'}.`,
    action: 'Review the policy assignment or remediate the resource.',
  }));

  // Collapse repeats. Azure publishes the same recommendation once per
  // subscription with an identical key; nine identical rows crowd out nine
  // distinct problems.
  const merged = new Map();
  for (const row of rows) {
    const existing = merged.get(row.key);
    if (!existing) {
      merged.set(row.key, { ...row, affected: 1, subscriptions: row.subscriptionId ? [row.subscriptionId] : [] });
      continue;
    }
    existing.affected += 1;
    if (row.subscriptionId && !existing.subscriptions.includes(row.subscriptionId)) {
      existing.subscriptions.push(row.subscriptionId);
    }
  }

  const all = [...merged.values()]
    // Azure frequently sets an Advisor recommendation's "solution" to the same
    // sentence as its title. Printing it twice reads as a rendering fault and
    // costs the row the line that could have said something new.
    .map(row => (row.action && row.action === row.title ? { ...row, action: '' } : row))
    .sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    if (Boolean(b.urgent) !== Boolean(a.urgent)) return b.urgent ? 1 : -1;
    return b.affected - a.affected;
  });

  return { rows: all.slice(0, limit), total: all.length };
}

/**
 * A principal's name, or an honest admission that there is not one.
 *
 * Reading display names needs Microsoft Graph, which this application does not
 * call. Where Azure returns only an object id the row would otherwise show a
 * bare GUID as though it were a person's name, which reads as a rendering
 * fault rather than as a missing lookup.
 */
function namedPrincipal(finding) {
  const name = finding.principal_name;
  const id = finding.principal_id;
  if (name && name !== id) return name;
  return id ? `Unnamed principal · ${String(id).slice(0, 8)}…` : '';
}

/** The last segment of a scope path, which is the part that identifies it. */
function shortScope(scope) {
  const parts = String(scope || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

// ---------------------------------------------------------------------------
// Cross-module correlation
// ---------------------------------------------------------------------------

/**
 * Resources that more than one source is unhappy about.
 *
 * Deliberately a count and a list, never a combined score. A VM flagged by
 * Defender, Policy and Advisor has three specific problems with three specific
 * fixes; folding them into a single risk number would destroy exactly the
 * information that makes the row worth opening.
 */
export function correlatedResources(sources, data, limit = 8) {
  const byResource = new Map();

  const note = (key, resourceId, name, label) => {
    if (!resourceId || !isQuotable(sources[key])) return;
    const id = String(resourceId).toLowerCase();
    const entry = byResource.get(id)
      || { resourceId, name: name || resourceId, issues: [], sources: new Set() };
    entry.issues.push(label);
    entry.sources.add(key);
    if (name) entry.name = name;
    byResource.set(id, entry);
  };

  for (const a of (data.defender?.assessments || [])) note('defender', a.resource_id, a.resource_name, a.title);
  for (const a of (data.defender?.alerts || [])) note('defender', a.resource_id, a.resource_name, a.title);
  for (const p of (data.policy?.non_compliant || [])) note('policy', p.resource_id, p.resource_name, p.title);
  for (const f of (data.advisor?.findings || [])) note('advisor', f.resource_id, f.resource_name, f.title);

  const rows = [...byResource.values()]
    .filter(entry => entry.sources.size > 1)
    .map(entry => ({
      resourceId: entry.resourceId,
      name: entry.name,
      issueCount: entry.issues.length,
      sources: [...entry.sources].map(k => MODULE_LABEL[k] || k).sort(),
      issues: entry.issues.slice(0, 6),
    }))
    .sort((a, b) => b.sources.length - a.sources.length || b.issueCount - a.issueCount);

  return { rows: rows.slice(0, limit), total: rows.length };
}

// ---------------------------------------------------------------------------
// Permission gaps
// ---------------------------------------------------------------------------

/**
 * Every source that could not be read, and the Azure role that would fix it.
 *
 * This is rendered prominently rather than tucked into a footnote: on this
 * page, what could not be seen is as important as what was found.
 */
export function permissionGaps(sources) {
  return Object.values(sources)
    .filter(s => s && (s.state === SOURCE.NO_ACCESS || s.state === SOURCE.PARTIAL || s.state === SOURCE.THROTTLED))
    .map(s => ({
      key: s.key,
      label: s.label,
      route: s.route,
      state: s.state,
      permissions: s.permissions || [],
      note: s.note,
      complete: s.state === SOURCE.PARTIAL ? `${s.read} of ${s.requested}` : null,
    }));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * One search box across principals, resources, policies and recommendations.
 *
 * Matching is plain substring on the fields a person would actually type. It
 * searches only what has been loaded, and says so, rather than implying the
 * absence of a match proves the absence of the thing.
 */
export function searchSecurity(sources, data, query, limit = 25) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return null;

  const hits = [];
  const push = (key, entry) => {
    if (hits.length >= limit * 4) return;
    if (!isQuotable(sources[key])) return;
    hits.push({ ...entry, source: key, route: MODULE_ROUTE[key] });
  };

  const matches = (...values) => values.some(v => String(v || '').toLowerCase().includes(needle));

  for (const p of (data.rbac?.principals || [])) {
    if (matches(p.principal_name, p.principal_upn, p.principal_id)) {
      push('rbac', {
        id: `rbac:${p.principal_id}`,
        name: p.principal_name || p.principal_id,
        type: p.principal_type || 'Principal',
        detail: `${p.assignment_count || 0} assignment(s) · ${p.top_privilege || 'unknown privilege'}`,
      });
    }
  }

  for (const a of (data.defender?.assessments || [])) {
    if (matches(a.resource_name, a.title, a.resource_id)) {
      push('defender', {
        id: `defender:${a.key || a.id}`,
        name: a.resource_name || a.title,
        type: 'Defender finding',
        detail: a.title || '',
        severity: severityOf(a.severity),
      });
    }
  }

  for (const p of (data.policy?.non_compliant || [])) {
    if (matches(p.resource_name, p.title, p.assignment_name, p.resource_id)) {
      push('policy', {
        id: `policy:${p.key || p.resource_id}`,
        name: p.resource_name || p.resource_id,
        type: 'Non-compliant resource',
        detail: p.title || p.assignment_name || '',
        severity: severityOf(p.severity),
      });
    }
  }

  for (const f of (data.advisor?.findings || [])) {
    if (matches(f.resource_name, f.title, f.resource_id)) {
      push('advisor', {
        id: `advisor:${f.key || f.id}`,
        name: f.resource_name || f.title,
        type: `Advisor · ${f.category || 'General'}`,
        detail: f.title || '',
        severity: severityOf(f.severity),
      });
    }
  }

  const unread = Object.values(sources).filter(s => s && !isQuotable(s)).map(s => s.label);

  return {
    query: needle,
    rows: hits.slice(0, limit),
    total: hits.length,
    unread,
    note: unread.length
      ? `${unread.join(', ')} ${unread.length === 1 ? 'has' : 'have'} not been read, so this search does not cover ${unread.length === 1 ? 'it' : 'them'}.`
      : '',
  };
}

// ---------------------------------------------------------------------------
// Action centre
// ---------------------------------------------------------------------------

/**
 * The short list of things worth doing next, in the order worth doing them.
 *
 * This is deliberately not the attention list. The attention list is every
 * individual finding; this is the handful of *jobs* those findings add up to,
 * because "review 175 high-impact recommendations" is an afternoon's work with
 * a clear beginning, and 175 separate rows are not.
 *
 * Every entry carries a real route and a real filter, so the button lands on
 * the page already showing the rows it counted. An action button that leads to
 * an unfiltered list is a button that makes the user start the work over.
 */
export function actionCentre(sources, data) {
  const items = [];

  const add = (item) => {
    if (item && item.count > 0) items.push(item);
  };

  // 1. Alerts first. Everything else on this page describes a way in;
  //    an alert describes somebody who may already have used one.
  if (isQuotable(sources.defender)) {
    const alerts = arr(data.defender?.alerts);
    add({
      id: 'defender-alerts',
      rank: 1,
      severity: 'critical',
      count: alerts.length,
      title: `Investigate ${alerts.length} active security alert${alerts.length === 1 ? '' : 's'}`,
      impact: 'Azure is reporting suspicious activity that may already be in progress.',
      resource: describeTargets(alerts.map(a => a.resource_name || a.resource_id)),
      action: 'Open the alerts and confirm whether each one is genuine.',
      cta: 'Review alerts',
      route: `${MODULE_ROUTE.defender}?tab=alerts`,
    });

    const critical = arr(data.defender?.assessments)
      .filter(a => ['critical', 'high'].includes(severityOf(a.severity)));
    add({
      id: 'defender-high',
      rank: 3,
      severity: 'high',
      count: critical.length,
      title: `Fix ${critical.length} important security recommendation${critical.length === 1 ? '' : 's'}`,
      impact: 'These are settings Microsoft considers likely to leave resources exposed.',
      resource: describeTargets(critical.map(a => a.resource_name || a.resource_id)),
      action: 'Work through the high-severity findings, starting with anything reachable from the internet.',
      cta: 'Review recommendations',
      route: `${MODULE_ROUTE.defender}?severity=high`,
    });
  }

  // 2. Access that can grant further access. The compounding risk.
  if (isQuotable(sources.rbac)) {
    const critical = data.rbac?.totals?.critical_count;
    add({
      id: 'rbac-critical',
      rank: 2,
      severity: 'high',
      count: isNum(critical) ? critical : 0,
      title: `Review ${critical} account${critical === 1 ? '' : 's'} with full control`,
      impact: 'These accounts can change or delete anything, and can also give access to others.',
      resource: 'Across the selected subscriptions',
      action: 'Confirm each one needs full control, and move the rest to a narrower role.',
      cta: 'Review access',
      route: `${MODULE_ROUTE.rbac}?filter=critical`,
    });
  }

  if (isQuotable(sources.access)) {
    const high = data.access?.totals?.high_count;
    add({
      id: 'access-high',
      rank: 4,
      severity: 'high',
      count: isNum(high) ? high : 0,
      title: `Review ${high} high-risk access finding${high === 1 ? '' : 's'}`,
      impact: 'Access that appears wider than the work it supports, based on recorded activity.',
      resource: 'Across the selected subscriptions',
      action: 'Check each finding against what the account actually does before changing anything.',
      cta: 'Review findings',
      route: `${MODULE_ROUTE.access}?severity=high`,
    });
  }

  // 3. Rules the organisation set for itself and resources are breaking.
  if (isQuotable(sources.policy)) {
    const broken = arr(data.policy?.non_compliant).length;
    add({
      id: 'policy',
      rank: 5,
      severity: 'medium',
      count: broken,
      title: `Review ${broken} resource${broken === 1 ? '' : 's'} breaking a rule`,
      impact: 'These resources do not follow the policies your organisation applied to Azure.',
      resource: 'Across the selected subscriptions',
      action: 'Fix the resource, or record an exemption if the rule genuinely should not apply.',
      cta: 'Review violations',
      route: MODULE_ROUTE.policy,
    });

    const expiring = arr(data.policy?.expiring_exemptions).length;
    add({
      id: 'policy-exemptions',
      rank: 6,
      severity: 'medium',
      count: expiring,
      title: `${expiring} rule exemption${expiring === 1 ? '' : 's'} expiring soon`,
      impact: 'When these expire the resources will start being reported as breaking the rule.',
      resource: 'Across the selected subscriptions',
      action: 'Renew the exemption or fix the resource before the date passes.',
      cta: 'Review exemptions',
      route: `${MODULE_ROUTE.policy}?tab=exemptions`,
    });
  }

  // 4. Microsoft's own suggestions, last because they are advice rather than
  //    findings, and because Advisor volume would otherwise drown the list.
  if (isQuotable(sources.advisor)) {
    const high = data.advisor?.summary?.high_count;
    const count = isNum(high) ? high : 0;
    const saving = data.advisor?.summary?.annual_saving;
    add({
      id: 'advisor-high',
      rank: 7,
      severity: 'medium',
      count,
      title: `Review ${count} high-impact Azure recommendation${count === 1 ? '' : 's'}`,
      impact: isNum(saving) && saving > 0
        ? 'Microsoft suggests these for cost, security, reliability or speed. Some carry a stated saving.'
        : 'Microsoft suggests these for cost, security, reliability or speed.',
      resource: 'Across the selected subscriptions',
      action: 'Work through the high-impact recommendations first.',
      cta: 'Review recommendations',
      route: `${MODULE_ROUTE.advisor}?severity=high`,
    });
  }

  return items.sort((a, b) => a.rank - b.rank);
}

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Name the affected thing when there is one, count them when there are many.
 *
 * A row saying "3 resources" invites the question "which three?", but a row
 * listing forty names is unreadable. One name is worth more than a count.
 */
function describeTargets(names) {
  const clean = [...new Set(names.filter(Boolean).map(String))];
  if (clean.length === 0) return 'Across the selected subscriptions';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean[0]} and ${clean.length - 1} other resource(s)`;
}

// ---------------------------------------------------------------------------
// Per-subscription breakdown
// ---------------------------------------------------------------------------

/**
 * One row per subscription, so a problem concentrated in a single place is
 * visible as such rather than averaged away across the estate.
 *
 * A subscription that a source could not read shows that source as unknown,
 * never as zero. That is the whole reason this cannot be a simple group-by:
 * the absence of a bucket in `by_subscription` means "no findings" when the
 * read succeeded and "no idea" when it did not, and only the errors list
 * distinguishes the two.
 */
export function subscriptionSecurity(sources, data, subscriptions = []) {
  const rows = subscriptions.map(sub => {
    const id = typeof sub === 'string' ? sub : sub?.subscription_id;
    const name = typeof sub === 'string' ? sub : (sub?.display_name || sub?.subscription_id || id);

    const cell = (key, bucketOwner) => {
      const source = sources[key];
      if (!isQuotable(source)) return { known: false, count: null, reason: source?.state };
      if (deniedFor(data[bucketOwner], id)) {
        return { known: false, count: null, reason: SOURCE.NO_ACCESS };
      }
      const buckets = data[bucketOwner]?.summary?.by_subscription || {};
      return { known: true, count: Number(buckets[id]) || 0, reason: null };
    };

    const defender = cell('defender', 'defender');
    const advisor = cell('advisor', 'advisor');
    const policy = cell('policy', 'policy');
    const access = cell('access', 'access');

    const known = [defender, advisor, policy, access].filter(c => c.known);
    const issues = known.reduce((sum, c) => sum + c.count, 0);

    return {
      id,
      name,
      defender,
      advisor,
      policy,
      access,
      // Only meaningful when at least one source answered for this subscription.
      issues: known.length ? issues : null,
      complete: known.length === 4,
      unknownSources: [
        !defender.known && 'Microsoft Defender',
        !advisor.known && 'Azure Advisor',
        !policy.known && 'Policy Governance',
        !access.known && 'Access Optimisation',
      ].filter(Boolean),
    };
  });

  // Worst first, but a subscription nothing is known about sorts to the bottom
  // rather than to the top -- an unknown is not a zero and is not an emergency.
  return rows.sort((a, b) => {
    if ((a.issues === null) !== (b.issues === null)) return a.issues === null ? 1 : -1;
    return (b.issues || 0) - (a.issues || 0);
  });
}

function deniedFor(payload, subscriptionId) {
  return arr(payload?.errors).some(e => e?.subscription_id === subscriptionId);
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/**
 * Movement over time, drawn only from readings that were actually taken.
 *
 * Two rules make this trustworthy. Readings that Azure truncated are excluded,
 * because a partial reading plotted next to a complete one looks like a sudden
 * improvement. And a single point is never drawn as a line: one reading shows
 * where you are, not where you are going, and a two-point line through one real
 * value and one assumed origin is a fabrication.
 */
export function securityTrend(history, days = 30) {
  const points = arr(history)
    .filter(h => h && h.captured_at && isNum(h.finding_count))
    .filter(h => !h.truncated)
    .map(h => ({
      at: h.captured_at,
      date: String(h.captured_at).slice(0, 10),
      total: h.finding_count,
      high: isNum(h.high_count) ? h.high_count : null,
      partial: arr(h.errors).length > 0,
    }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const cutoff = Date.now() - days * 86400000;
  const within = points.filter(p => {
    const t = Date.parse(p.at);
    return Number.isFinite(t) ? t >= cutoff : false;
  });

  const series = within.length >= 2 ? within : [];

  if (series.length < 2) {
    return {
      series: [],
      points: within.length,
      ready: false,
      note: within.length === 0
        ? 'No readings have been saved in this period yet.'
        : 'Only one reading has been saved in this period. A trend needs at least two.',
    };
  }

  const first = series[0];
  const last = series[series.length - 1];
  const change = last.total - first.total;
  const anyPartial = series.some(p => p.partial);

  return {
    series,
    points: series.length,
    ready: true,
    change,
    direction: change === 0 ? 'flat' : (change > 0 ? 'up' : 'down'),
    // Stated as a comparison between two dated readings, never as a rate,
    // because the readings are taken whenever somebody opens the page.
    note: `${first.total} finding(s) on ${first.date}, ${last.total} on ${last.date}.`
      + (anyPartial ? ' Some readings did not cover every subscription.' : ''),
  };
}

export { NOT_AVAILABLE };
