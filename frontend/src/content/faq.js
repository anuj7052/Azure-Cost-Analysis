/**
 * The questions on the public page.
 *
 * Kept out of the page component because the same text has to appear twice:
 * once for a reader, and once as FAQPage structured data in `index.html` for a
 * search engine. Google requires those to match -- structured data that
 * promises an answer the page does not contain is treated as deception and
 * costs the rich result, not just the mismatch.
 *
 * A build cannot import a `.js` module into static HTML, so the duplication is
 * unavoidable. What is avoidable is the drift, and `tests/seo.test.js` fails
 * the moment the two disagree.
 */
export const FAQ = [
  {
    q: 'Does it change anything in my Azure account?',
    a: 'Reporting and cost exploration are read-only. Build can create supported Azure resources, but requires explicit confirmation, workspace-admin authorization and sufficient Azure permissions. Review generated templates and deployment details before creating resources.',
  },
  {
    q: 'What does it cost to run?',
    a: 'The app reads the Azure Cost Management and Resource Graph APIs, which Microsoft does not charge for. If you connect a model endpoint for the assistants, that is billed by your own provider against your own key.',
  },
  {
    q: 'Can I use it across more than one tenant?',
    a: 'Yes. Connect each tenant you have access to and switch between them from the top bar. Data from one is never mixed into another.',
  },
  {
    q: 'Where do the numbers come from?',
    a: 'Billed costs come from Azure Cost Management. Resource inventory and findings come from the relevant Azure services. Forecasts, retail-price estimates and optimization projections are distinct from billed actuals. Check the reporting period, freshness and any partial-data messages.',
  },
  {
    q: 'Can my colleagues use it?',
    a: 'You can invite people from your directory and choose what each of them is allowed to do. Roles are checked on the server, not just hidden in the menu.',
  },
];
