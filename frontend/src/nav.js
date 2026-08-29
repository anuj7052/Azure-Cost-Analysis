import {
  Activity, AlertTriangle, ClipboardList, Cpu, FileCode, FolderOpen, Gauge,
  GitCompareArrows, KeyRound, LayoutDashboard, Lightbulb, Network,
  Plug, Scale,
  Search, Server, Settings, Shield, ShieldAlert, ShieldCheck, Trash2,
  TrendingUp, UserCog, Users, Wallet,
} from 'lucide-react';

/**
 * One definition of the navigation, used by both the sidebar and the section
 * landing pages.
 *
 * Two copies of this list would drift within a week — a page added to the
 * sidebar but missing from its section hub is invisible to anyone who navigates
 * by hub, and nobody would notice because both screens look complete.
 *
 * Every entry carries a `blurb` saying what question the page answers. The
 * labels alone do not: "Changes", "Activity Explorer" and "Anomalies" are three
 * different things and the names barely hint at which is which.
 */
export const SECTIONS = [
  {
    key: 'cost',
    title: 'Cost',
    icon: Wallet,
    hub: '/',
    tagline: 'What you are spending, and why it moved.',
    items: [
      {
        to: '/', label: 'Dashboard', icon: LayoutDashboard, overview: true,
        blurb: 'Headline spend, top services and the trend at a glance.',
      },
      {
        to: '/search', label: 'Global Search', icon: Search,
        blurb: 'Find any resource, meter or resource group by name across every subscription.',
      },
      {
        to: '/explorer', label: 'Cost Explorer', icon: TrendingUp,
        blurb: 'Spend over time with a forecast, split by service, region, resource group or meter, down to the resource.',
      },
      {
        to: '/compare', label: 'Month Compare', icon: GitCompareArrows,
        blurb: 'Two months side by side, with the services that drove the difference.',
      },
      {
        to: '/bandwidth', label: 'Bandwidth', icon: Network,
        blurb: 'Data transfer costs by resource, with the egress meters that caused them.',
      },
      {
        to: '/boq', label: 'BOQ vs Actual', icon: ClipboardList,
        blurb: 'Your Pricing Calculator estimate against the real bill, line by line.',
      },
      {
        to: '/deploy', label: 'Deployment Assistant', icon: FileCode,
        blurb: 'Upload a BOQ or describe what you need; it drafts and prices, and you press Create.',
      },
    ],
  },
  {
    key: 'estate',
    title: 'Estate',
    icon: Gauge,
    hub: '/estate',
    tagline: 'What is actually running, what changed, and what is being wasted.',
    items: [
      {
        to: '/estate', label: 'Overview', icon: Gauge, overview: true,
        blurb: 'Everything in this section, and what each page is for.',
      },
      {
        to: '/anomalies', label: 'Anomalies', icon: AlertTriangle,
        blurb: 'Costs that jumped further than normal variation explains.',
      },
      {
        to: '/changes', label: 'Change Tracking', icon: GitCompareArrows,
        blurb: 'Resources added, removed or resized between two points in time.',
      },
      {
        to: '/activity', label: 'Activity Explorer', icon: Activity,
        blurb: 'Who did what in Azure, from the Activity Log. Retained 90 days.',
      },
      {
        to: '/compute', label: 'Compute Intelligence', icon: Cpu,
        blurb: 'Every VM judged against 30 days of real utilization: idle, oversized or correct.',
      },
      {
        to: '/orphaned', label: 'Orphaned Resources', icon: Trash2,
        blurb: 'Disks, IPs and NICs still being billed with nothing attached to them.',
      },
      {
        to: '/resource-groups', label: 'Resource Groups', icon: FolderOpen,
        blurb: 'Spend by resource group, for chargeback and ownership questions.',
      },
    ],
  },
  {
    key: 'security',
    title: 'Access & Security',
    icon: Shield,
    hub: '/security',
    tagline: 'Who can reach what, and how exposed the estate is.',
    items: [
      {
        to: '/security', label: 'Overview', icon: Shield, overview: true,
        blurb: 'Everything in this section, and what each page is for.',
      },
      {
        to: '/access-optimization', label: 'Access Optimization', icon: KeyRound,
        blurb: 'Access that looks unused, stale, over-privileged or duplicated \u2014 each with the evidence behind it.',
      },
      {
        to: '/role-assignments', label: 'Role Assignments', icon: UserCog,
        blurb: 'Start from a person and see every resource they can reach, ranked by risk.',
      },
      {
        to: '/advisor', label: 'Azure Advisor', icon: Lightbulb,
        blurb: 'Advisor recommendations across every subscription, and what changed since last time.',
      },
      {
        to: '/defender', label: 'Microsoft Defender', icon: ShieldAlert,
        blurb: 'Defender findings and secure score, with alerts kept separate from misconfigurations.',
      },
      {
        to: '/policy', label: 'Policy Governance', icon: Scale,
        blurb: 'Compliance, policy assignments and exemption expiry, tracked scan over scan.',
      },
    ],
  },
  {
    key: 'account',
    title: 'Account',
    icon: Settings,
    hub: '/account',
    tagline: 'Connections, data sources and who can use this app.',
    items: [
      {
        to: '/account', label: 'Overview', icon: Settings, overview: true,
        blurb: 'Everything in this section, and what each page is for.',
      },
      {
        to: '/settings', label: 'Settings', icon: Settings,
        blurb: 'Connect Azure tenants, import usage files and set the reporting period.',
      },
      {
        to: '/team', label: 'Team', icon: Users,
        blurb: 'Pick up to five colleagues from your directory and choose what each may do.',
      },
      {
        to: '/apis', label: 'API Catalog', icon: Plug,
        blurb: 'Every Microsoft endpoint behind this app, with the public ones you can open yourself.',
      },
    ],
  },
];

/** The Admin Center only exists for administrators, so it is added on demand. */
export const ADMIN_ITEM = {
  to: '/admin', label: 'Admin Center', icon: ShieldCheck,
  blurb: 'Accounts, tenant access and who is allowed into this app.',
};

/** The sections as this user should see them. */
export function sectionsFor(isAdmin) {
  if (!isAdmin) return SECTIONS;
  return SECTIONS.map(section =>
    section.key === 'account'
      ? { ...section, items: [...section.items, ADMIN_ITEM] }
      : section,
  );
}

/** The section a path belongs to, so the sidebar can open the right one. */
export function sectionForPath(pathname, isAdmin = false) {
  const sections = sectionsFor(isAdmin);
  // Longest match wins: "/" is a prefix of everything, so a plain prefix test
  // would put every page in the Cost section.
  let best = null;
  let bestLength = -1;
  for (const section of sections) {
    for (const item of section.items) {
      const exact = item.to === pathname;
      const nested = item.to !== '/' && pathname.startsWith(`${item.to}/`);
      if ((exact || nested) && item.to.length > bestLength) {
        best = section;
        bestLength = item.to.length;
      }
    }
  }
  return best;
}
