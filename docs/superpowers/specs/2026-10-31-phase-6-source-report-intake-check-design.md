# Merge phase 6: source report and intake check

Status: design approved in chat by the owner on 2026-10-31; this file is the
written spec for review. Hand-off: `docs/superpowers/phases/phase-6-reports-dashboard-checks.md`.
Parent spec: `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md`
§2 (decisions 20, 22, 26), §9, §12 row 6.

## 1. Purpose

Two pieces of spec §9 ship now; the third waits.

- **Source report.** Staff see, per source, how many leads came in, how many
  were submitted and how many made it, for one lead type and a window.
- **Intake check.** Every 15 minutes the backend submits a test lead to a
  hidden test site through the same code a website's lead goes through,
  deletes it, and alerts the owner when that fails.
- **Umami is left for later** (owner, 2026-10-31). Nothing in this phase reads
  or sends to Umami. The phase's spec §12 "done when" is reduced to: **the source
  report counts leads per source; a broken intake raises an alert.**

## 2. Owner decisions (2026-10-31)

| #   | Question                                   | Answer                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O1  | Make Get Canada Sim send UTM and referrer? | No: the report only. The websites start sending source data in a later change.                                                                                                                                                                               |
| O2  | What counts as "made it"?                  | One rule for every lead type (every type will share one stage set later): the lead's stage is one of `activated`, `installed`, `completed`, `won`. Merging the stages is not in phase 6.                                                                     |
| O3  | Umami                                      | Later.                                                                                                                                                                                                                                                       |
| O4  | The test lead after a run                  | Deleted.                                                                                                                                                                                                                                                     |
| O5  | A message when the check passes again      | Yes, one all-clear on the first good run after a failure.                                                                                                                                                                                                    |
| O6  | How deep the check goes                    | In the backend only, through the lead store the website route uses; no call to the public route.                                                                                                                                                             |
| O7  | Defaults accepted                          | The report is visible with `workspace.read`; the test site is created by an owner-run SQL paste; the check is off until its variable is set; the alert is proven by an integration test and one controlled failure in production with the owner's agreement. |

Production fact behind O1 (2026-10-31, counts per key only): of 928 leads, one
carries any attribution (a Get Canada Sim partner code); CanadaWide sends none.

## 3. Source report

### API

`GET /workspaces/:workspaceId/reports/sources?leadType=<type>&days=7|30|90`
(no `days` means all time; the windows are `LEAD_STATS_WINDOWS`). Permission
`workspace.read`, like `GET /leads/stats`. The schemas and the endpoint go in
`packages/contracts` (a new `reports.ts`), the route beside the stats route.

Response:

```ts
{
  leadType: string;
  days: 7 | 30 | 90 | null;
  totals: {
    received: number;
    submitted: number;
    madeIt: number;
  }
  rows: Array<{
    source: string; // the deriveSource label, e.g. "utm:google/cpc", "direct"
    kind: 'partner' | 'utm' | 'referrer' | 'direct' | 'other';
    received: number;
    submitted: number;
    madeIt: number;
    campaigns: Array<{
      campaign: string | null;
      received: number;
      submitted: number;
      madeIt: number;
    }>;
  }>;
  withSourceData: number; // leads in the window whose attribution is not empty
}
```

### Counting rules

- **The leads counted** are the ones `GET /leads/stats` counts for the same
  type and window (same `created_at` window, same exclusions), so the report's
  totals match the dashboard's.
- **received**: every such lead; **submitted**: `status = 'submitted'`;
  **madeIt**: `stage` in `SOURCE_REPORT_SUCCESS_STAGES` =
  `['activated', 'installed', 'completed', 'won']`, a contracts constant. A type
  with none of these stages shows 0 made it.
- **The source label** is computed in SQL with the same precedence as
  `deriveSource` (`apps/backend/src/leads/source.ts`): partner code (with
  "(unmatched)"), then UTM source with medium, then referrer host, then
  `direct`. A unit test pins the SQL and the TypeScript function to the same
  labels for the same attribution.
- **campaigns** split a `utm` row by `utmCampaign` (null when absent); other
  kinds carry an empty list.
- **Grouping happens in Postgres** inside `withTenantTx`, with bound
  parameters; the JSON keys are fixed internal constants (the Canadian Plans
  report's pattern).
- **Caps:** the 50 sources with the most received leads are listed; the rest
  are summed into one `other` row labelled "Other". Campaigns are capped at 20
  per source, the rest summed into one "Other" campaign row.
- **Values are data:** attribution is customer-influenced text already bounded
  by `sanitizeAttribution` (120 characters for UTM values, 253 for a host); the
  admin renders it as text, never as HTML or a link.

### Admin

- A new sidebar item **Reports** (shown with `workspace.read`) opening
  **Sources**, at `/w/[workspace]/reports/sources`.
- A lead type select and the 7, 30, 90 days and all time choice, as on the
  dashboard.
- A real table: Source, Received, Submitted, Made it, Made-it rate; a source
  with campaigns expands (a button with `aria-expanded`) to its campaign rows.
- **Not enough data:** when `withSourceData` is 0, the page says "No source
  data yet. Your websites don't send UTM tags or referrers to the CRM yet, so
  every lead counts as direct." above the table (which then has one Direct row).
- **States:** loading; "Could not load the report" with a retry, never sample
  rows; empty window ("No leads in this period").
- Copy in sentence case, keyboard-usable, the PR #5 look.

## 4. Intake check

### The test site

- One row in `app.workspaces`, slug `intake-check`, name "Intake check",
  status `active`, **no members, no site keys, no saved email settings, no
  automation rows**, created by an owner-run paste
  (`docs/RUNBOOKS/manual/intake-check-site.sql`, idempotent on the slug). No
  member means no staff list shows it; it is not `canadawide`, so the legacy
  mirror trigger (0002) never fires for it.
- The backend learns its id from **`INTAKE_CHECK_WORKSPACE_ID`** (backend
  only). Unset: the scheduler task is not registered and the manual route
  answers 404 `intake_check_off`.

### One run

1. **leftovers**: delete any lead on the test site older than
   10 minutes, so a run that died between create and delete is cleaned up by
   the next one. A leftover found is logged as a count.
2. **create**: `DatabaseLeadStore.createLead` with `leadType: 'internet'`,
   `submit: true`, a fixed synthetic contact (`Intake Check`,
   `intake-check@example.invalid`, a fixed fictional phone), an empty form, the
   consent version `intake-check-v1`, a fresh `requestId`, as the scheduler's
   machine identity.
3. **verify**: read the lead back in the same site and check it exists, is
   `submitted` and is at the type's first stage.
4. **delete**: delete the lead (its draft grant, tasks and activities go by
   cascade or explicit delete within one tenant transaction) and confirm no
   row is left. The contact row stays and is reused (no `DELETE` grant on
   `app.contacts`); audit events stay (append-only, no values).

Result: `{ status: 'ok', durationMs }` or
`{ status: 'failed', step: 'create' | 'verify' | 'delete' | 'leftovers', code, durationMs }`,
where `code` is a bounded snake-case string (the Canadian Plans `safeCode`
rule), never a message or a value.

### Scheduling

- A fourth task `intake_check` in `SchedulerTaskName`, every 15 minutes, with
  the same overlap guard and failure logging as the others; registered only
  when `INTAKE_CHECK_WORKSPACE_ID` is set.
- A manual run `POST /api/internal/jobs/intake-check` for a machine identity
  with the existing scope `synthetic:check` (`machineScopeNames`), returning
  the result.

### Alerts

- Kinds `synthetic_check_failed` (exists) and a new
  `synthetic_check_recovered` ("GT Sales CRM: intake check passing again"),
  through `createOwnerAlertChannelFromEnv` (owner email and optional webhook).
  `detail` is `<step>:<code>`, or the failure count for the all-clear.
- **Rule** (pure function, unit-tested): alert on the first failure; while it
  keeps failing, alert again only when the last alert is at least 60 minutes
  old; on the first `ok` after one or more failures, send one all-clear and
  reset. The state is in memory on the one scheduler replica: a restart during
  an outage can repeat one failure alert, accepted.
- An alert that cannot be sent is logged (`intake_check_alert_failed`) and does
  not change the state, so the next run tries again.

### What it must never do

Write to any site but its own; queue an email (no sender, no rules); leave a
lead behind past the next run; count in a real site's numbers; log a value.

## 5. Database

No migration: the report reads existing columns, the test site is one row.
The plan checks the report's query plan against the existing indexes on
`app.leads (workspace_id, lead_type, created_at)` and adds an index pair only
if a production-sized `EXPLAIN` shows a sequential scan that matters.

## 6. Testing

- Contracts: schema round-trips; the success stage constant.
- Backend unit: SQL label equals `deriveSource` for a table of attributions;
  the alert rule (first failure, hourly repeat, one all-clear, failed send).
- Backend integration (`ENV(n)`): counts per window and per stage; another
  site's leads never counted; odd characters and the maximum length in a UTM
  value; the 50-row cap and "Other"; a run leaves no lead; leftovers cleaned;
  a forced failure alerts once with the step; two overlapping ticks run once.
- Admin: component tests for each state, the expandable rows by keyboard, the
  "no source data" notice; one Playwright journey reads the report (and the
  journeys pass under `TZ=UTC`).
- Production: after deploy and the owner's paste and variable, two or three
  green runs in the logs, then one controlled failure the owner agrees to (the
  plan picks the mechanism, for example pointing the variable at a site id
  that does not exist) and the all-clear after.

## 7. Not in this phase

Umami (reading or sending), websites sending attribution, merging the stage
sets, a public-route check, a stored check history.
