# Search visibility

Canonical site: https://azure.microsoftupdates.co.in/

## Build and deploy

Run `npm ci && npm run build` in `frontend`. Publish **all** of `dist` to the
backend's `static` directory, including both `index.html` and `app.html`, and
deploy the matching backend code.

The build renders the actual Landing component into the homepage HTML. It makes
no authenticated requests. The private routes use an empty app shell with
`noindex`, and the backend adds an `X-Robots-Tag` header to those responses.
The build checks the public heading, FAQ, canonical and private shell.

The sitemap now lists thirteen public URLs: the homepage, four `/features/`
product-detail pages, `/guides/`, and seven
articles on cost spikes, reservation cost basis, BOQ reconciliation, idle
resources, bandwidth charges, VM rightsizing and monthly cost reviews. Each
guide is prerendered to `dist/guides/<slug>/index.html`, with a unique canonical,
description, Article and BreadcrumbList markup. Copy nested directories during
deployment. The backend serves these pages without sign-in and returns 404 for
unknown guide paths. The live discovered-page count can increase only after
these files and the updated backend have been deployed and Google rereads the
sitemap; submitted URLs do not guarantee indexed pages.

## Search Console — 15 September 2026

The verified `microsoftupdates.co.in` domain property covers the Azure subdomain.
Ego Lite checks confirmed:

- The homepage is already indexed.
- Google's live URL test passed: available to Google, page can be indexed.
- The homepage indexing request was accepted into the priority crawl queue.
- `https://azure.microsoftupdates.co.in/sitemap.xml` was resubmitted successfully.
  Its original submission retained a "Couldn't fetch" result even though Google's
  live URL test fetched it and the XML parsed correctly.
- Submitting `https://azure.microsoftupdates.co.in/sitemap.xml?v=20260915`
  resolved processing: Search Console reported **Success**, last read September
  15, 2026, and **1 discovered page**. The obsolete failed submission was removed.
  The query parameter serves the same XML; the homepage URL in it is unchanged.

After deploying, inspect the homepage again and review the sitemap's last-read
date and status. Check response codes, DNS/TLS and hosting request logs if the
fetch failure persists. The robots file and sitemap returned HTTP 200 in the
live browser check. The backend also now accepts HEAD on static document routes;
the deployed server previously returned 405 for HEAD. This improvement is pending
deployment and was not required for the successful Search Console submission.

## Ongoing work

- Filter Search Console Performance to URLs starting with the Azure subdomain;
  parent-domain totals include the other websites and are not this app's traffic.
- Compare clicks, impressions, CTR and position over 28-day periods, by query.
- Use real query data to prioritize original public guides: investigating Azure
  cost spikes, actual versus amortized reservation costs, and BOQ reconciliation.
  Include practical steps, source links and clearly labelled examples.
- Add guides to the sitemap only once their public URLs exist and return useful
  content without sign-in. Keep lastmod tied to real content edits.
- Review Core Web Vitals when Google has sufficient field data.

Search Console is already usable without putting verification credentials in
the repository. Analytics is a separate measurement choice and is not a ranking
requirement. Structured data describes the product; it does not guarantee rich
results or top positions. No ratings or reviews should be invented.
