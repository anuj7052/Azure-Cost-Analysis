---
mode: agent
description: End-to-end verification sweep of every feature in the Azure Control & Intelligence Platform — checks each router, service and page actually works, and reports what is broken with evidence.
---

# Full platform verification sweep

You are auditing the **Azure Control & Intelligence Platform** in this
workspace. Your job is to establish, with evidence, whether every feature
actually works — not whether the code looks plausible.

Read `docs/05-platform-map.md` first. It is the authoritative map of routers,
services and pages, and every checklist item below refers to it.

## Ground rules

1. **Evidence, not assertion.** Never write "works" without the command you ran
   and its output. If you could not verify something, say *"not verified"* and
   why. A confident wrong answer is worse than an admitted gap.
2. **Distinguish the four failure kinds.** They look identical in a screenshot
   and have completely different fixes:
   - **Broken code** — a bug you should fix.
   - **Missing Azure permission** — e.g. `Microsoft.BillingBenefits/savingsPlans`
     returns 403. Not a bug. Report it against `permissions_manifest.py`.
   - **Rate limiting** — Cost Management is metered *per subscription*. Check
     whether the message says *Azure* is throttling or *our own queue is full*
     (`RateLimited(paced=True)`). Blaming the wrong one sends the user hunting a
     quota problem that does not exist.
   - **Genuinely empty estate** — nothing to show is a valid answer. It must not
     render as an error, and an error must not render as emptiness.
3. **Do not delete or deploy anything.** `provision/deploy`, `compute/resize`,
   `actions/*` and `security/access/*` create resources, change rights or start
   charges. Verify they are *reachable and correctly guarded*; do not fire them.
4. **Never touch the backend terminal.** The terminal running `bash start.sh`
   emits false "waiting for input" signals — it is only uvicorn logs scrolling.
   Do not read from it or send it input.
5. **A missing number is never a zero.** Wherever you check output, confirm an
   absent value renders as words or `—`, and that partial results carry their
   `coverage` / `partial` / `errors` rather than looking complete.

## Step 1 — Baseline

Run these and record the counts. Nothing below is trustworthy until they pass.

```bash
cd backend && .venv/bin/pytest -q 2>&1 | tail -5          # expect 1824 passed
cd frontend && npx vitest run tests/ 2>&1 | tail -5       # expect 1144 passed
cd frontend && npx eslint src 2>&1 | tail -30             # record pre-existing debt
curl -s localhost:8000/api/health
```

Note this machine has **no `python`** — use `python3`, and the venv binary for
tests.

## Step 2 — Per-feature checks

For each feature: name the router, the service, the page, then state
**Working / Broken / Not verified** with evidence.

### Cost
- [ ] **Cost Explorer** — `POST /api/costs` aggregates across subscriptions;
      `POST /api/costs/rows` returns cost **and usage quantity** so a rise splits
      into "used more" vs "charged more per unit". Confirm `coverage` is present
      on a partial read and is not dropped when one subscription succeeds.
- [ ] **Dashboard**, **Compare** — month-over-month diff behaves the same on live
      data and on an uploaded CSV (`upload` → `csv_parser` emits the same shape).
- [ ] **Bandwidth** — egress joined to Monitor metrics.
- [ ] **Prices** — Retail Prices lookup + recorded history.
- [ ] **cost_client pacing** — verify a cold-cache query waits
      (`MAX_PATIENT_WAIT`) instead of failing fast, and that a paced refusal
      says *our queue*, not *Azure is throttling you*.

### Findings
- [ ] **Anomalies** — spike/drop/started/stopped classified from **two reads
      only**, not one call per finding. Confirm the period selector and
      `previous_period` comparison agree for month, rolling and custom windows.
- [ ] **Orphaned** — findings are priced, and the page is **read-only** (no
      delete path exists).
- [ ] **Compute** — the four-source join degrades correctly: with Monitor
      missing you get a fleet list with "not enough data" per VM plus a
      `sources` block explaining the empty column, **not** an error page.
      Confirm `POST /api/compute/resize` requires workspace admin.
- [ ] **Commitments** — utilisation, spend, wastage, expiry, coverage groups,
      Azure recommendations, cancellation impact. Confirm `wastageBasis`
      distinguishes *billed as unused* from *derived from utilisation*, and that
      "Showing N of M" + Reset appear when filters are on — a filtered table and
      a small estate must not look identical.

### History
- [ ] **Estate scan** — a scan writes a full snapshot.
- [ ] **Global Search** — finds resources that no longer exist; a row click
      opens `ResourceTimeline`.
- [ ] **Change Tracking** — diffs two scans and **never calls Azure**; confirm it
      still answers while Cost Management is throttling.
- [ ] **Timelines** — `ResourceTimeline` and `GroupTimeline`. Check the 7/30/90
      presets and custom range, that days bucket by **UTC** (Azure bills by UTC
      day), that the window caps at 90 days (Activity Log retention), and that
      cost failing still renders the events — enrichment is best effort.
- [ ] **Activity Log** — filters by subscription, group, caller, operation,
      outcome; states the 90-day limit rather than implying older data is empty.

### Security
- [ ] **Security / Advisor / Defender / Policy** — each writes a snapshot as it
      reads (they have no history endpoint of their own), and a missing
      permission **names itself** rather than rendering as "nothing is wrong".
- [ ] **Access & Identity** — review → change → accept flow, history retained.
- [ ] **Network** — topology renders and is read-only.

### Build
- [ ] **BoQ** — build, import, chat-refine, workbook export, compare to actual.
- [ ] **Provision** — `/chat` returns a draft and spends one unit of the
      customer's own daily limit; `/deploy` requires a specification (not a
      sentence) **and** an explicit confirmation flag, is refused for team
      members, and runs on the caller's delegated token so Azure RBAC decides.
- [ ] **Actions** — the catalogue is served by code, every attempt is recorded in
      one table, and `Idempotency-Key` makes a retry not a second change.

### Workspace
- [ ] **Onboarding / Settings** — tenant connect, permission check against
      `permissions_manifest.py`, LLM endpoint + daily limit.
- [ ] **Team** — invitee gets view access and cannot deploy.
- [ ] **Account** — profile, sessions, sign-out everywhere, data export.
- [ ] **API Catalog** — renders the live OpenAPI schema.
- [ ] **Admin** — admin-only guard holds; backup runs.

### Shell
- [ ] Every page composes `PageHeader → NeedsSelection | Failure | Empty | data`,
      so "pick a subscription", "the call failed" and "there is nothing here"
      never look alike.
- [ ] Legacy `/api/...` and `/api/v1/...` both mount, with `Sunset` on the legacy
      pair.
- [ ] Auth: unauthenticated requests are rejected; a token for tenant A cannot
      read tenant B.

## Step 3 — Report

Produce, in this order:

1. **Summary table** — feature | status | evidence.
2. **Broken, ranked by user impact** — for each: the file and line, what the
   user sees, the root cause, and the fix. Fix them if they are small and
   in-scope; list them if they are not.
3. **Not bugs** — permission gaps and rate limiting, kept separate so they are
   not "fixed" by someone changing code that is already correct.
4. **Honesty risks** — anywhere a derived figure could be mistaken for a
   measured one, a partial result could read as complete, or a missing value
   renders as `0`. Treat these as high severity: a wrong number that looks
   trustworthy is the most expensive defect this product can ship.
5. **Not verified** — with the reason.

## Style

Match the repo's comment voice. Comments explain *why a reader would be misled
otherwise*, not what the line does. Keep the existing rules: a missing value is
words or `—`, never a zero; measured and derived figures must never look alike.

Validate anything you change:

```bash
cd backend && .venv/bin/pytest -q 2>&1 | tail -5
cd frontend && npx eslint <changed files> && npx vitest run tests/ 2>&1 | tail -5
```
