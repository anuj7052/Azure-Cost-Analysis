/**
 * The portal walkthroughs rendered by <PortalGuide>.
 *
 * Plain data, kept out of the component file so that file exports only
 * components -- a module that mixes the two breaks Fast Refresh, which then
 * full-reloads the page on every edit and loses whatever scope and filters
 * were selected.
 */

/** Walkthrough for the bandwidth / data-transfer figures. */
export const BANDWIDTH_GUIDE = {
  title: 'How to check these bandwidth costs in the Azure portal',
  intro:
    'Every number on this page comes from the same Cost Management data Azure bills you on. '
    + 'Follow these steps to see the identical figures in the portal.',
  steps: [
    {
      title: 'Open Cost analysis',
      detail: 'Sign in to the Azure portal and search for "Cost Management". Open Cost analysis, then pick the same scope (subscription) you selected here.',
      path: 'portal.azure.com → Cost Management + Billing → Cost analysis',
    },
    {
      title: 'Match the date range',
      detail: 'Set the date picker to the same period shown at the top of this page. Use the same granularity (monthly) so the totals line up.',
      path: 'Cost analysis → date picker (top bar) → Last 6 months / Custom',
    },
    {
      title: 'Group by Meter category',
      detail: 'Change "Group by" to Meter category. The Bandwidth row is your data-transfer spend — it should match the Bandwidth Spend tile here.',
      path: 'Cost analysis → Group by → Meter category → Bandwidth',
    },
    {
      title: 'Drill into the individual meters',
      detail: 'Switch Group by to Meter to see rows like "Data Transfer Out - GB". These are the same meters listed in the Data Transfer Meters table below.',
      path: 'Cost analysis → Group by → Meter',
    },
    {
      title: 'See the transferred volume, not just the cost',
      detail: 'Add the Usage quantity column (or download the usage details). Azure reports network meters in GB, which is what we convert into the GB / TB figures shown here.',
      path: 'Cost analysis → Download → Usage details (CSV) → UnitOfMeasure + Quantity columns',
    },
    {
      title: 'Cross-check live traffic in Azure Monitor',
      detail: 'For per-resource traffic, open the resource and look at the Network In / Network Out metrics. Cost Management reports billed transfer, so it excludes free ingress.',
      path: 'Resource → Monitoring → Metrics → Network In Total / Network Out Total',
    },
  ],
  tips: [
    'Ingress (data into Azure) is almost always free — that is why its cost column is usually zero while its volume is not.',
    'Egress (data leaving Azure) is billed, with the first few GB per month free, so cost per GB is a blended rate rather than a list price.',
    'Intra-region and availability-zone transfer is billed at a lower rate than internet egress.',
    'Cost Management data can lag live usage by up to 8–24 hours, so today\'s numbers may still be settling.',
  ],
  links: [
    { label: 'Open Cost analysis', href: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis' },
    { label: 'Bandwidth pricing', href: 'https://azure.microsoft.com/pricing/details/bandwidth/' },
    { label: 'Docs: Understand cost details', href: 'https://learn.microsoft.com/azure/cost-management-billing/automate/understand-usage-details-fields' },
  ],
};

/** Walkthrough for the overall cost figures on the dashboard. */
export const COST_GUIDE = {
  title: 'How to verify these cost figures in the Azure portal',
  intro: 'These totals are pulled from the Cost Management Query API — the same source the portal uses.',
  steps: [
    {
      title: 'Open Cost analysis for the same scope',
      detail: 'Select the identical subscription(s) that are enabled in the filter bar on this page.',
      path: 'portal.azure.com → Cost Management + Billing → Cost analysis → Scope',
    },
    {
      title: 'Set the same period and granularity',
      detail: 'Match the date range shown in the page subtitle and set granularity to Monthly.',
      path: 'Cost analysis → date picker → Granularity: Monthly',
    },
    {
      title: 'Compare the Actual cost total',
      detail: 'The headline "Actual cost" in the portal equals the Actual Cost tile here. Amortized cost will differ if you own reservations.',
      path: 'Cost analysis → Metric → Actual cost',
    },
    {
      title: 'Group by Service name to check the table',
      detail: 'The portal list should match the Top Services by Spend table, row for row.',
      path: 'Cost analysis → Group by → Service name',
    },
    {
      title: 'Export the raw data to audit a single number',
      detail: 'Download the usage details CSV, then filter by month and service. You can re-upload that same file here from Settings → Import cost file.',
      path: 'Cost analysis → Download → Usage details (CSV)',
    },
  ],
  tips: [
    'Numbers are pre-tax and exclude credits unless your billing account applies them at source.',
    'A subscription with no charges in a period simply will not appear in the breakdown.',
    'Switching the currency in the portal changes the totals — this app shows the billing currency returned by the API.',
  ],
  links: [
    { label: 'Open Cost analysis', href: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis' },
    { label: 'Docs: Quick start — Cost analysis', href: 'https://learn.microsoft.com/azure/cost-management-billing/costs/quick-acm-cost-analysis' },
  ],
};

/** Walkthrough for exporting a file to import into this app. */
export const EXPORT_GUIDE = {
  title: 'How to export a cost file from the Azure portal',
  intro: 'Any Cost Management export works here — CSV, Excel or a PDF invoice with a cost table.',
  steps: [
    {
      title: 'Open Cost analysis',
      detail: 'Pick the subscription, resource group or billing account you want to analyse.',
      path: 'portal.azure.com → Cost Management + Billing → Cost analysis',
    },
    {
      title: 'Choose the period you need',
      detail: 'For example "Last 6 months" with Monthly granularity.',
      path: 'Cost analysis → date picker',
    },
    {
      title: 'Group by the detail you want to keep',
      detail: 'Group by Service name for cost analysis, or by Meter to also get the bandwidth breakdown.',
      path: 'Cost analysis → Group by',
    },
    {
      title: 'Download the file',
      detail: 'Choose "Download data to CSV" or "Download to Excel". Usage details give the richest import, including quantities and units.',
      path: 'Cost analysis → Download → CSV / Excel',
    },
    {
      title: 'Upload it here',
      detail: 'Drop the file on the import box. Subscriptions found in the file appear in the filter bar so you can view them one at a time.',
      path: 'This app → Settings → Import cost file',
    },
  ],
  tips: [
    'Include the SubscriptionId (or SubscriptionName) column to filter by subscription after import.',
    'Include Meter, UnitOfMeasure and Quantity to unlock the bandwidth report from the file.',
    'Column names are matched case-insensitively and common Azure aliases are understood.',
  ],
  links: [
    { label: 'Open Cost analysis', href: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis' },
    { label: 'Docs: Export cost data', href: 'https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-export-acm-data' },
  ],
};
