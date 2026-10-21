import {
  Activity, AlertTriangle, Boxes, ClipboardList, Cpu, FileCode, Gauge,
  GitCompareArrows, KeyRound, LayoutDashboard, Lightbulb, Network,
  Plug, Scale,
  ReceiptText, Search, Server, Settings, Shield, ShieldAlert, ShieldCheck, Trash2,
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
    title: 'Dashboard',
    flat: true,
    icon: Wallet,
    hub: '/',
    tagline: 'What you are spending, and why it moved.',
    items: [
      {
        to: '/', label: 'Dashboard', icon: LayoutDashboard, overview: true,
        blurb: 'Headline spend, top services and the trend at a glance.',
      },
      {
        to: '/explorer', label: 'Cost Explorer', icon: TrendingUp,
        blurb: 'Spend over time with a forecast, a daily timeline, month-on-month variance and data transfer — split by service, region, resource group or meter, down to the resource.',
      },
      {
        to: '/boq', label: 'BOQ vs Actual', icon: ClipboardList,
        blurb: 'Your Pricing Calculator estimate against the real bill, line by line.',
      },
    ],
  },
  {
    key: 'billing',
    title: 'Azure Billing',
    icon: FileCode,
    hub: '/azure-billing/dashboard',
    flat: true,
    tagline: 'Customer profiles, invoices, cloud documents and profit/loss reconciliation.',
    // This CRM workspace is separate from the Azure infrastructure product
    // areas featured on the public landing page.
    publicProduct: false,
    items: [
      {
        to: '/azure-billing/dashboard', label: 'Dashboard', icon: LayoutDashboard, overview: true,
        blurb: 'Customer, distributor and usage totals with exact-date allocations and workspace-scoped access.',
      },
      {
        to: '/azure-billing/entries', label: 'Add entry', icon: ReceiptText,
        blurb: 'Customer, subscription, month, invoice number, our billing and distributor amounts.',
      },
      {
        to: '/azure-billing', label: 'Customers', icon: Users, end: true,
        blurb: 'Manage customers, upload customer/distributor/usage bills and compare reviewed invoice totals.',
      },
      {
        to: '/azure-billing/settings', label: 'Settings', icon: Settings,
        blurb: 'Cloud document storage, invoice extraction and billing preferences.',
      },
    ],
  },
  {
    key: 'estate',
    title: 'Inventory',
    flat: true,
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
        to: '/search', label: 'Resource search', icon: Search,
        blurb: 'Find any resource by name across every scan, including ones since deleted.',
      },
      {
        to: '/provision', label: 'Build', icon: Boxes,
        blurb: 'Create a VM, storage account, virtual network or web app from a form, in one deployment.',
      },
    ],
  },
  {
    key: 'security',
    title: 'Access & Security',
    flat: true,
    icon: Shield,
    hub: '/security',
    tagline: 'Who can reach what, and how exposed the estate is.',
    items: [
      {
        to: '/security', label: 'Overview', icon: Shield, overview: true,
        blurb: 'Everything in this section, and what each page is for.',
      },
      {
        to: '/access-identity', label: 'Access & Identity', icon: KeyRound,
        blurb: 'Grants that look unused, stale, over-privileged or duplicated \u2014 and, for any account, everything it can reach.',
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
      {
        to: '/network', label: 'Network Visualizer', icon: Network,
        blurb: 'Virtual networks, peerings, gateways and the security groups and route tables attached to each subnet.',
      },
    ],
  },
  {
    key: 'account',
    title: 'Settings',
    // One sidebar link; its pages are tabs inside the section, like Cost.
    flat: true,
    icon: Settings,
    hub: '/settings',
    tagline: 'Connections, data sources and who can use this app.',
    items: [
      {
        to: '/settings', label: 'Settings', icon: Settings, overview: true,
        blurb: 'Tenants, subscriptions, data sources and your team, on one page.',
      },
    ],
  },
];

export const PRODUCT_SECTIONS = SECTIONS.filter(section => section.publicProduct !== false);

/** The sections as this user should see them. Admin tools live on the Settings page. */
export function sectionsFor() {
  return SECTIONS;
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
