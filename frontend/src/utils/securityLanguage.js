/**
 * Saying the same true thing in two vocabularies.
 *
 * Every string in this file exists because "Owner-level RBAC assignment at
 * subscription scope" and "one person can change or delete anything in this
 * subscription" describe the identical fact, and only the second one causes
 * anybody to act on it.
 *
 * The rule this file follows, and the reason it is pure and separately tested:
 * the plain sentence must never say more than the Azure term did. Translating
 * is allowed; embellishing is not. So `Owner` becomes "Full control", never
 * "dangerous" -- whether it is dangerous depends on who holds it and what they
 * do with it, which is a different question answered elsewhere with evidence.
 *
 * Each translation therefore returns three fields:
 *   plain     what a business user reads first
 *   technical the exact Azure term, always kept and always shown on request
 *   why       what it lets somebody do, in observable terms
 *
 * The technical term is never discarded. An administrator who needs to search
 * the Azure portal for "Microsoft.Authorization/roleAssignments" must still be
 * able to find that string on the page.
 */

/** Every status this section may display, and what each one actually claims. */
export const STATUS = {
  HEALTHY: {
    key: 'healthy',
    label: 'Healthy',
    tone: 'good',
    tooltip: 'This was checked against Azure and nothing needing attention was found.',
  },
  ATTENTION: {
    key: 'attention',
    label: 'Needs attention',
    tone: 'warn',
    tooltip: 'Problems were found. None of them are urgent, but they should be reviewed.',
  },
  HIGH_RISK: {
    key: 'high_risk',
    label: 'High risk',
    tone: 'danger',
    tooltip: 'Serious problems were found that could let someone reach or damage your resources.',
  },
  CRITICAL: {
    key: 'critical',
    label: 'Critical',
    tone: 'danger',
    tooltip: 'Azure is reporting something that may already be happening. Look at this first.',
  },
  NOT_CHECKED: {
    key: 'not_checked',
    label: 'Not checked',
    tone: 'muted',
    tooltip: 'This has not been read from Azure yet, so nothing is known either way. It does not mean everything is fine.',
  },
  UNAVAILABLE: {
    key: 'unavailable',
    label: 'Unavailable',
    tone: 'muted',
    tooltip: 'Azure would not answer. This is a missing permission or an error, not a clean result.',
  },
  PARTIAL: {
    key: 'partial',
    label: 'Partially checked',
    tone: 'warn',
    tooltip: 'Some subscriptions were read and others were not, so these numbers are a floor rather than a total.',
  },
};

/**
 * What an Azure role actually lets somebody do.
 *
 * Deliberately phrased as capability, not as judgement. "Can change or delete
 * anything" is a fact about the role; "over-privileged" is a conclusion that
 * requires knowing whether the holder needs it, which only the access review
 * has the evidence to decide.
 */
const ROLES = {
  owner: {
    plain: 'Full control',
    why: 'Can create, change and delete anything here, and can also give other people access.',
  },
  contributor: {
    plain: 'Can change everything',
    why: 'Can create, change and delete anything here, but cannot give other people access.',
  },
  reader: {
    plain: 'View only',
    why: 'Can look at resources and settings but cannot change anything.',
  },
  'user access administrator': {
    plain: 'Manages who has access',
    why: 'Cannot change resources, but can give anybody — including themselves — any level of access.',
  },
  'security admin': {
    plain: 'Manages security settings',
    why: 'Can change security policies and dismiss security recommendations.',
  },
  'security reader': {
    plain: 'Views security information',
    why: 'Can read security findings and scores but cannot change them.',
  },
};

/**
 * Translate a role name into what it permits.
 *
 * `permissions` is the backend's reading of the role *definition*, and when it
 * is present it wins. A custom role named "Reader" that holds a write action is
 * precisely the case a name-based lookup gets wrong, and getting it wrong here
 * would tell a user that somebody who can delete their production database can
 * only look at it.
 *
 * `derived` says the description came from the role's permissions rather than
 * from a recognised name. It deliberately does NOT claim the role is a custom
 * definition -- Azure has hundreds of built-in roles and only a handful are
 * recognised here, so "Storage Blob Data Reader" is derived but not custom.
 * Azure does not tell us which it is on this API, so we do not say.
 */
export function plainRole(roleName, permissions = null) {
  const technical = roleName || 'Unknown role';
  const known = ROLES[String(roleName || '').trim().toLowerCase()];

  if (permissions && permissions.known) {
    const derived = describePermissions(permissions);
    // Only override the friendly name when the definition disagrees with it --
    // otherwise the well-known wording is clearer than anything generated.
    if (known && derived.level === levelOfKnownRole(roleName)) {
      return { plain: known.plain, technical, why: known.why, derived: false };
    }
    return { ...derived, technical, derived: true };
  }

  if (known) return { plain: known.plain, technical, why: known.why, derived: false };

  return {
    plain: technical,
    technical,
    why: 'What this role permits could not be read from Azure.',
    derived: false,
  };
}

function levelOfKnownRole(roleName) {
  const key = String(roleName || '').trim().toLowerCase();
  if (key === 'owner' || key === 'user access administrator') return 'grant';
  if (key === 'contributor' || key === 'security admin') return 'write';
  return 'read';
}

function describePermissions(p) {
  if (p.can_grant_access) {
    return {
      plain: 'Full control',
      level: 'grant',
      why: 'Can change resources and can also give other people access.',
    };
  }
  if (p.can_delete) {
    return {
      plain: 'Can change and delete',
      level: 'write',
      why: 'Can create, change and delete resources here.',
    };
  }
  if (p.can_write) {
    return {
      plain: 'Can make changes',
      level: 'write',
      why: 'Can create and change resources here, but cannot delete them.',
    };
  }
  return {
    plain: 'View only',
    level: 'read',
    why: 'Can look at resources but cannot change them.',
  };
}

/**
 * Where a grant applies, said in terms of how much it covers.
 *
 * The reason scope gets its own translation is that "subscription" sounds
 * smaller than "resource group" to anybody who has not used Azure, when it is
 * in fact very much larger.
 */
export function plainScope(scopeKind) {
  switch (String(scopeKind || '').toLowerCase()) {
    case 'tenant root':
      return { plain: 'Your entire Azure account', technical: 'Tenant root scope' };
    case 'management group':
      return { plain: 'A group of subscriptions', technical: 'Management group scope' };
    case 'subscription':
      return { plain: 'One whole subscription', technical: 'Subscription scope' };
    case 'resource group':
      return { plain: 'One group of resources', technical: 'Resource group scope' };
    case 'resource':
      return { plain: 'A single resource', technical: 'Resource scope' };
    default:
      return { plain: 'Unknown area', technical: scopeKind || 'Unknown scope' };
  }
}

/**
 * The five access-review findings, each stated as an observation plus the
 * question it raises -- never as an instruction.
 *
 * "No activity was recorded" is something the Activity Log can support.
 * "This access is unused, remove it" is not: a service principal that runs a
 * quarterly billing job and a person on parental leave produce exactly the same
 * empty log. Every wording below stops at the evidence and asks for a human.
 */
const ACCESS_KINDS = {
  unused: {
    title: 'Access that has never been used',
    why: 'Access nobody uses is still access somebody could misuse. It is also the easiest kind to remove safely.',
    action: 'Check whether this account still needs access, then remove it if not.',
    caution: 'Accounts that only run occasionally, and people on long leave, look identical to genuinely dead access.',
  },
  stale: {
    title: 'Access that has not been used recently',
    why: 'The account is real and active, but has not touched this area for a long time. The access may no longer match the job.',
    action: 'Confirm this access is still part of the person or service\u2019s work.',
    caution: 'A long gap is not proof the access is unnecessary.',
  },
  'over-privileged': {
    title: 'More power than the account actually uses',
    why: 'This account can give other people access but has never done so. A lesser role would cover everything it actually did.',
    action: 'Consider moving this account to a narrower role.',
    caution: '',
  },
  'over-scoped': {
    title: 'Access wider than the work it supports',
    why: 'The access covers a whole subscription, but every recorded action happened somewhere else. The grant is broader than it needs to be.',
    action: 'Narrow this access to the area actually being used.',
    caution: '',
  },
  sprawl: {
    title: 'Access granted many times over',
    why: 'The same account has been given access repeatedly in different places, which makes it hard for anyone to see what it can really do.',
    action: 'Consolidate these grants into one.',
    caution: '',
  },
  redundant: {
    title: 'Access that another grant already covers',
    why: 'This grant adds nothing, because a wider grant on the same account already permits everything it does.',
    action: 'Remove the duplicate grant. It changes nothing about what the account can do.',
    caution: '',
  },
};

export function plainAccessKind(kind) {
  return ACCESS_KINDS[String(kind || '').toLowerCase()] || {
    title: 'Access finding',
    why: 'Azure returned this finding without a category.',
    action: 'Review this grant.',
    caution: '',
  };
}

/** Advisor's five pillars, said as the question each one answers. */
const ADVISOR_CATEGORIES = {
  cost: { plain: 'Saving money', why: 'Ways to pay less for what you already run.' },
  security: { plain: 'Security', why: 'Settings that leave resources open to attack.' },
  reliability: { plain: 'Staying online', why: 'Things that could make a service fail or lose data.' },
  highavailability: { plain: 'Staying online', why: 'Things that could make a service fail or lose data.' },
  performance: { plain: 'Speed', why: 'Resources running slower than they could.' },
  operationalexcellence: { plain: 'Running things well', why: 'Housekeeping that makes the estate easier to manage.' },
};

export function plainAdvisorCategory(category) {
  const key = String(category || '').replace(/[\s_-]/g, '').toLowerCase();
  return ADVISOR_CATEGORIES[key] || { plain: category || 'General', why: '' };
}

/**
 * Turn a severity into the status a business user should read.
 *
 * Kept as a translation rather than a calculation: the severity is Azure's,
 * and re-ranking it here would mean this application quietly disagreeing with
 * the portal the user will check next.
 */
export function plainSeverity(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'critical': return { ...STATUS.CRITICAL, plain: 'Fix first' };
    case 'high': return { ...STATUS.HIGH_RISK, plain: 'Important' };
    case 'medium': return { ...STATUS.ATTENTION, plain: 'Worth reviewing' };
    case 'low': return { ...STATUS.ATTENTION, plain: 'Minor', tone: 'muted' };
    default: return { ...STATUS.NOT_CHECKED, plain: 'Unrated' };
  }
}

/** The plain-language glossary shown behind "What do these words mean?". */
export const GLOSSARY = [
  { term: 'Role assignment', plain: 'A record of one person or service being given a level of access to something.' },
  { term: 'Principal', plain: 'Whoever holds the access: a person, a group, or an automated service.' },
  { term: 'Service principal', plain: 'An account used by software rather than by a person.' },
  { term: 'Scope', plain: 'How much the access covers \u2014 one resource, one group, or an entire subscription.' },
  { term: 'RBAC', plain: 'Azure\u2019s system for deciding who can do what. Shown here as access permissions.' },
  { term: 'Policy', plain: 'A rule your organisation applies to Azure resources, such as requiring backups.' },
  { term: 'Compliant', plain: 'The resource follows the rule.' },
  { term: 'Non-compliant', plain: 'The resource breaks the rule.' },
  { term: 'Secure Score', plain: 'Microsoft\u2019s own rating of how closely your setup follows its security advice.' },
  { term: 'Defender for Cloud', plain: 'Microsoft\u2019s security service that watches Azure resources for problems.' },
  { term: 'Assessment', plain: 'A security check Microsoft ran against a resource.' },
  { term: 'Alert', plain: 'A warning that something suspicious may already have happened.' },
  { term: 'Advisor', plain: 'Microsoft\u2019s built-in suggestions for improving cost, security, speed and reliability.' },
  { term: 'Exemption', plain: 'Permission for one resource to ignore a rule, usually temporarily.' },
];
