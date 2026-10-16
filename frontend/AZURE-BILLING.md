# Azure Billing workspace

## Everyday navigation

- **Overview**: customer billed, distributor cost and profit/loss first; usage
  and customer/service counts below. Extra filters and calculation rules are
  collapsed. Search customers or show only those needing attention.
- **Customers**: searchable company cards, add customer and spreadsheet import.
  Each company opens Monthly billing, Bills & uploads, and Company details.
- **Monthly billing**: one useful month at a time, expandable charge rows and a
  shortcut to records needing review. All-month totals, source cells, history,
  archived records and subscription metadata remain available on demand.
- **Bills & uploads**: save one original, check suggested amounts, and mark it
  reviewed. Reviewed is not the same as paid; payment notes are not interpreted
  into an outstanding balance. Invoice totals remain separate from monthly records.
- **Settings**: document storage and extraction setup. These no longer fill the
  customer screen. Billing uses its own navigation bar without Azure resource
  subscription/date controls, which never governed CRM amounts.

## Billing Dashboard

Open **Azure Billing → Dashboard** at `/azure-billing/dashboard`.
Customer and distributor amounts, Azure usage, active customer count and
subscription/workload count are scoped to the authenticated workspace. A workload
is a customer ledger record, not necessarily a distinct Azure subscription ID.

Filters include month/year, exact inclusive date range, source and currency.
Monthly ledger and reviewed invoice documents are separate sources to avoid
double-counting. Readers can view; admin status comes from the server, never a
client-selectable role filter. Only existing admin-gated workspace routes edit data.

For exact ranges, recurring Monthly ledger entries use overlap/calendar-month
proration. October 16–November 16 covers 32 inclusive days: 16/31 of October plus
16/30 of November. This is an allocation estimate, not measured daily consumption.
One-time, unknown-frequency records and invoice documents are not prorated when
only part of the billing month is selected. Their amounts are flagged unallocated.
Missing amounts stay unknown; different currencies are never combined. Overall
net profit is withheld for incomplete/unreviewed/non-net comparisons.

Dashboard cards are adapted from shadcn/ui's MIT-licensed Card source, using the
existing app colour tokens. Project authoring guidance is in
`.opencode/skills/azure-billing-ui/SKILL.md`.

## Editable customer ledger

Azure Billing has a separate monthly ledger for customer spreadsheets. It is
not automatically merged with reviewed invoice documents, which would count the
same revenue twice.

- Import the two-header company CSV with an explicitly selected billing year.
- A blank company cell inherits the preceding company. Workloads and original
  PO/date/requirement/payment notes are preserved, including rows with no charges.
- Every declared month gets a slot. Blank amounts mean unknown, not zero.
- Ambiguous amount cells are retained as source evidence and marked Needs review.
- Create or edit customer profiles, workloads and monthly entries in the UI.
  Old years remain editable; use Add month for future periods.
- Delete removes a record from active views. Show deleted exposes Restore;
  source documents and edit history are retained.
- Entries/workloads use revision checks so a stale edit cannot silently overwrite
  another user's correction. Imports are transactional and identical files are
  idempotent. A new year may reuse a workload; conflicting months must be edited.
- Net profit appears only when the relevant distributor costs are present,
  entries are reviewed, and amounts are explicitly marked net/excluding tax.
- Excel exports include Monthly ledger and Workload entries sheets separately
  from the invoice-document comparison.

The production sign-in redirect must use `https://azure.microsoftupdates.co.in`
in `VITE_AZURE_REDIRECT_URI`. The `.com` hostname is not this application.
Source CSVs and real customer data belong only in private storage, never Git.

## Configured Azure resources

All billing resources are in `rg-azure-cost-analysis` (Central India):

- Storage account: `cloudledgerbilling9f0625`
- Private container: `billing-documents`
- Document Intelligence: `cloudledger-invoice-ocr` (S0, pay-per-use)
- Hosting application: `azure-cost-analysis-anuj`

The app's system-assigned managed identity has Storage Blob Data Contributor
at container scope. Public blobs and shared-key access are disabled. Blob
versioning and 14-day blob/container soft-delete retention are enabled.
Versions and retained deletions consume billable storage.

The production app settings contain the Blob destination and OCR configuration.
The OCR key is held only in App Service configuration; it must never be committed
or returned to the browser. Local verification loads it into the backend process
environment without writing it to a file. Restarting that process requires
loading its settings again.

A synthetic PNG invoice passed live Document Intelligence extraction (invoice
number, currency, net subtotal and tax). Synthetic originals and an Excel report
also passed live Blob upload/download checks. These checks validate the cloud
services; the Billing module still needs deployment before the public site can
use them.

Open **Azure Billing → Customer workspace** in its own top-level sidebar section.
Customer profiles and bill metadata belong to the
current workspace; only workspace owners/admins can edit or upload. Read-only
workspace members can view the comparison and download an Excel report.

## Azure Blob Storage (primary destination)

Set `BILLING_BLOB_ACCOUNT` and `BILLING_BLOB_CONTAINER` in the backend environment.
Use a private container and grant the App Service system-assigned managed identity
Storage Blob Data Contributor at that container's scope. Shared-key and public
blob access are not needed. No key or SAS URL is sent to the frontend.

The app stores originals by workspace/customer/month/type and offers authenticated
downloads only after checking workspace ownership. Save Excel to cloud writes
reports into the same customer's Reports prefix. Profile/invoice metadata stays
in the application's database (on the persistent Azure App Service volume in the
current production configuration).

For local development only, `BILLING_BLOB_LOCAL_CLI=true` explicitly allows the
developer's signed-in Azure CLI identity to access this app-owned storage. Give
that identity container-scoped access. Production never uses the CLI fallback.
These credentials are not used to query customer subscriptions.

Use **Test cloud storage** to check connectivity before uploading. OCR is separate
from storage and still needs the configuration described below.

## SharePoint setup (optional legacy destination when Blob is not configured)

1. In Azure Billing, click **Connect Microsoft file access**. Use the same
   Microsoft identity used to sign into the app.
2. Your Microsoft Entra app registration must allow delegated Graph permissions
   `User.Read`, `Files.ReadWrite.All` and `Sites.Read.All`. Tenant policy may require admin
   consent. The user must also have write access to the chosen library.
3. Enter the site URL, exact document-library display name, and an optional
   existing folder path. Example site: `https://company.sharepoint.com/sites/Finance`.
4. Select **Verify & save destination**. No passwords or keys belong in this form.

Originals are saved under the chosen folder:

`Azure Billing/workspace-<id>/customer-<id>/<YYYY-MM>/<bill-type>/<hash>.<extension>`

The document keeps its original filename in the app. Hash-based filenames and a
database uniqueness constraint prevent identical uploads being counted twice.
Folders use stable customer IDs so renaming a profile does not break storage.

The backend forwards a short-lived Graph access token to Microsoft Graph only;
it does not persist this token. Uploads require an active user session; this is
not an unattended synchronization service. SharePoint's own ACLs still control
who can open originals; workspace access does not grant SharePoint access.

If SharePoint fails, the app does not claim the invoice was saved. If the file
is saved but extraction fails, it remains available for manual review. Excel
comparisons can be downloaded or saved to the customer's Reports folder.

## Invoice extraction and OCR

- PDFs with embedded text, CSV and XLSX can supply suggestions without an OCR service.
- For scanned PDFs/JPEG/PNG, configure Azure Document Intelligence in backend
  deployment settings: `BILLING_OCR_ENDPOINT` and `BILLING_OCR_KEY`.
- Use the resource HTTPS endpoint and a valid key from that resource. Do not
  commit the key, copy it into frontend code or paste it into support messages.
- The integration uses `prebuilt-invoice`, API version `2024-11-30`. OCR is
  billed by Azure. It inspects at most 10 pages per document.
- When OCR is not configured or fails, the original is still saved and the app
  explicitly requests manual entry. It never invents a successful OCR result.
- Upload one invoice per document. Spreadsheet/text recognition is a limited
  suggestion pass, not a generic financial statement or line-item reconciliation engine.

## Reviewed comparison

Confirm billing month, invoice number, ISO currency code, net amount excluding
tax and tax amount after checking the original. Only confirmed documents enter
the comparison. Credit notes use negative amounts. Excluding a document removes
it from totals but does not delete its SharePoint original.

- Gross profit/loss = customer net total − distributor net total.
- Margin = gross profit / customer net revenue; unavailable if revenue is zero/negative.
- Distributor less Azure usage is a separate reconciliation difference.
- Months and currencies are never added together. Missing bills are not zero.
- Pending bills are excluded and make the comparison provisional; overheads,
  FX conversions, payment status and tax profitability are not modelled here.

Live verification requires the real SharePoint destination, consent and (for
scans) an OCR resource. Unit tests use isolated databases and mocked Graph/OCR.
