# Phase 6: Source Report and Intake Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff see, per source, how many leads of one type came in, were submitted and made it over 7, 30, 90 days or all time (Reports → Sources), and every 15 minutes the backend pushes a test lead through the website's intake code on a hidden site, deletes it, and alerts the owner when that fails and once when it passes again.

**Architecture:** The report is one SQL statement in a tenant transaction over `app.leads`, grouping by a source label computed in SQL with `deriveSource`'s precedence and by UTM campaign, over the same leads `GET /leads/stats` counts; a pure TypeScript function ranks the groups and applies the 50-source and 20-campaign caps. The intake check is a runner on `DatabaseLeadStore.createLead` (after the website route's own `createLeadRequestSchema` and `checkLeadIntake`) plus a small store for leftovers, read-back and delete, scheduled as a fourth in-process task `intake_check` and runnable by hand at `POST /api/internal/jobs/intake-check`; a pure alert rule decides when the owner channel hears about it. No migration, no new table, nothing sent to or read from Umami.

**Tech Stack:** TypeScript (strict), Zod 4, Express 5, Drizzle + PostgreSQL 17, Next.js 16 + React 19 + Tailwind 4 + shadcn, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-phase-6-source-report-intake-check-design.md` (owner-approved 2026-10-31; binding). Hand-off: `docs/superpowers/phases/phase-6-reports-dashboard-checks.md` (Umami is out of scope, spec O3). Ported from Canadian Plans (`/home/user/canadianplans-web-app`): `apps/backend/src/reports/store.ts` (grouping in Postgres, the fixed-key literal rule), `apps/admin/src/components/source-report.tsx` (stale-response guard), `apps/backend/src/synthetic/check.ts` (`safeCode`, step tracking), `apps/backend/src/scheduler.ts` l.274-293 (an optional task that never takes the scheduler down), `apps/backend/src/routes/synthetic-check.ts` (machine auth).

**Rulings made while planning** (read the code on 2026-10-31):

- **R1. No migration.** Deleting the test lead needs only `DELETE` on `app.leads`, which `app_runtime` has (0001). Every table that references a lead and that a submitted `internet` lead can have rows in cascades (`lead_activities`, `lead_tasks`, `draft_grants`, `idempotency_keys`, `automation_runs`, `change_requests`, `lead_identities`); a cascade runs as the referencing table's owner with FORCE RLS lifted (PostgreSQL's RI triggers), so no `DELETE` grant on the append-only timeline is needed. The three non-cascading FKs (`email_messages`, `marketing_consents`, `follow_up_schedules`) get no row: intake writes none, and the test site has no sender and no rules. Task 5's integration test proves the cascade as `app_runtime`; if it fails, stop and report, do not add grants.
- **R2. No index.** `app.leads` has no `(workspace_id, lead_type, created_at)` index (the spec assumed one). The report reads exactly the rows `GET /leads/stats` reads (prefix `(workspace_id, lead_type)` of `leads_workspace_id_lead_type_idx`, then a `created_at` filter), production holds 928 leads, so no index; revisit if a site passes ~100 000 leads.
- **R3. The test lead's form is a fixed fictional internet form**, not an empty one: `internetLeadPayloadSchema` requires `planId`, `planLabel`, `dateOfBirth`, `streetAddress`, `city`, `consent` and `consentedAt`, so an empty form is refused (`form`).
- **R4. The check goes through the route's checks too:** the runner builds the website body, parses it with `createLeadRequestSchema` and runs `checkLeadIntake` before `createLead`, as `POST /website/leads` does; a refusal is a `create` failure with code `intake_refused_<problem>`.
- **R5. Identity.** The scheduled task and the manual route act as the scheduler entry selected by `JOB_RUNNER_SELECTOR` and verified with `CRON_SECRET`, which must also hold the scope `synthetic:check`. The test site's id comes from `INTAKE_CHECK_WORKSPACE_ID` (deployment config, never request input), so it need not be in the entry's `workspaceIds`. Variable set but scope missing or the id not a uuid: the scheduler starts without the task and logs the code once (Canadian Plans' pattern); the outbox, cleanup and retention never stop for it.
- **R6. Only scheduled runs alert.** The alert state lives on the scheduler replica; the manual route returns the result and neither alerts nor touches that state.
- **R7. The production controlled failure** removes and re-creates the test site row with the same id (paste file sections C and D), not a variable change: a variable change restarts the service, which empties the in-memory alert state, so the all-clear would never be seen.
- **R8. A campaign row carries `other: boolean`** (true only on the summed "Other" row, whose `campaign` is `null`), because a real `utmCampaign` may be the text "other" and `null` already means "no campaign". The source "Other" row needs no flag: its `kind` is `other` and `source` is `'other'`, which no `deriveSource` label can be.
- **R9. The alert subject** of `synthetic_check_failed` becomes "GT Sales CRM: intake check failed" (no other caller uses the kind).
- **R10. The manual route stays out of the endpoint registry,** as `/api/internal/jobs/run` does; its result type is the backend's `IntakeCheckResult`.
- **R11. The report opens on the last 30 days** with the dashboard's four windows; the dashboard keeps 7.

**Batches** (two implementers, one worktree each: Batch R in `/home/user/crm-wt/t1` on `p6/t1` with `gt_sales_t1_test`, Batch I in `/home/user/crm-wt/t2` on `p6/t2` with `gt_sales_t2_test`; tasks run in order inside a batch):

| Batch                  | Tasks                                                                         | Model                  |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------- |
| R (source report)      | T1 contracts → T2 backend store and route → T3 admin page → T4 e2e journey    | easy, hard, hard, hard |
| I (intake check)       | T5 runner and store → T6 alert rule and scheduler → T7 manual route → T8 docs | hard, hard, easy, easy |
| Controller, after both | T9 merge, regenerate OpenAPI, gate, PR, provisioning, deploy, live check      | controller             |

**Shared files.** `docs/api/openapi.json`: both batches regenerate it (R adds the endpoint, I adds the `intake_check_off` code); the controller resolves the merge by taking either side and re-running `pnpm --filter @gt-sales/contracts build`, then commits. `packages/contracts/src/common.ts` belongs to Batch I (the one new error code); Batch R adds no error code. `packages/contracts/src/{index,endpoints,client}.ts` belong to Batch R; Batch I exports nothing new from contracts. `apps/backend/src/routes/staff.ts` is Batch R's, `apps/backend/src/app.ts`, `scheduler.ts` and `http/domain-errors.ts` are Batch I's. Every document (`AGENTS.md`, `docs/**` except `openapi.json`) is Batch I's, in T8, written from this plan's names for Batch R; the controller checks T8 against R's merged code.

## Global Constraints

- Strict TypeScript, no `any`, no `as`; typecheck, lint, format clean before every commit; every SQL value bound (JSON keys are fixed internal constants, inlined as literals, never input); integration suites on a `_test` database, re-runnable, fixed UUIDs: report suites `…-00000000f6NN`, intake suites `…-00000000f7NN` (site prefix `16000000-0000-4000-8000-`, actor prefix `26000000-0000-4000-8000-`).
- `ENV(n)`: `TEST_MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gt_sales_t<n>_test MIGRATION_DATABASE_SSL_MODE=disable DB_TEST_ALLOW_DESTRUCTIVE=1 DATABASE_URL=postgresql://app_runtime:local_ci_runtime_password@localhost:5432/gt_sales_t<n>_test DATABASE_SSL_MODE=disable EMAIL_CONTACT_HASH_SECRET=ci-email-contact-hash-secret-0123456789`. Backend filter: `backend`.
- Report route `GET /api/v1/staff/workspaces/:workspaceId/reports/sources?leadType=<type>&days=7|30|90`, no `days` = all time (`LEAD_STATS_WINDOWS`), permission `workspace.read`. Counted leads: `workspace_id = app.workspace_id`, the type, `deleted_at is null`, `customer_data_restricted_at is null`, `created_at >= now() - make_interval(days => n)` (the stats query's exact window); `received` all, `submitted` `status = 'submitted'`, `madeIt` `stage` in `SOURCE_REPORT_SUCCESS_STAGES = ['activated', 'installed', 'completed', 'won']`; `withSourceData` the counted leads whose `attribution <> '{}'::jsonb`.
- Source label precedence (as `deriveSource`): non-empty `partnerCode` → `partner:<code>`, plus ` (unmatched)` unless `partnerCodeMatched` is JSON `true`; else non-empty `utmSource` → `utm:<source>` plus `/<medium>` when `utmMedium` is non-empty; else non-empty `referrerHost` → `referrer:<host>`; else `direct`. Kinds `partner`, `utm`, `referrer`, `direct`, and `other` for the summed row. Campaigns only on `utm` rows (others `[]`), `campaign` = non-empty `utmCampaign` or `null`.
- Caps: `SOURCE_REPORT_MAX_SOURCES = 50`, `SOURCE_REPORT_MAX_CAMPAIGNS = 20`; order by `received` desc, then the label ascending by code point (`null` campaign last among ties); the rest summed into one row at the end (`source: 'other'`, `kind: 'other'`, `campaigns: []`; a campaign row `{ campaign: null, other: true }`). Totals are over every counted lead, before capping.
- Lengths: source ≤ 300 (`utm:` + 120 + `/` + 120 = 245, `referrer:` + 253 = 262), campaign ≤ 120. Attribution is customer-influenced text: the admin renders it as text, never as HTML or a link.
- Intake check: test site slug `intake-check`, name "Intake check", status `active`, no members, keys, email settings or automation rows; `INTAKE_CHECK_WORKSPACE_ID` (backend only, a uuid); every `INTAKE_CHECK_INTERVAL_MS = 15 * 60_000`; leftovers older than `INTAKE_CHECK_LEFTOVER_AGE_MS = 10 * 60_000`; lead type `internet`, `submit: true`, contact `{ fullName: 'Intake Check', email: 'intake-check@example.invalid', phone: '403 555 0199', countryCode: 'CA' }`, consent version `intake-check-v1`, a fresh `requestId` (`randomUUID()`), no attribution, no order, no idempotency key.
- Result `{ status: 'ok', durationMs }` or `{ status: 'failed', step: 'leftovers' | 'create' | 'verify' | 'delete', code, durationMs }`; `code` matches `/^[a-z][a-z0-9_]{0,63}$/`.
- Alerts: `synthetic_check_failed` (detail `<step>:<code>`) on the first failure and again only when the last alert is ≥ `INTAKE_ALERT_REPEAT_MS = 60 * 60_000` old; `synthetic_check_recovered` (subject "GT Sales CRM: intake check passing again", detail `failed_runs:<n>`) once on the first `ok` after a failure, then reset; a send that throws logs `intake_check_alert_failed` and leaves the state unchanged.
- Never: write to a site but the test site; queue an email; leave a lead past the next run; count in a real site's numbers; log a value (logs carry step, code, counts, ids and durations only).
- Admin copy in sentence case, every control labelled, keyboard-usable, the PR #5 look. Commit trailers: `Co-Authored-By:` for the model that wrote the commit, and the session's `Claude-Session:` line.

## Review Focus

1. **A source value with odd characters or the maximum length** (a 120-character `utmSource` holding `'"<b>x</b> %_\`, a 120-character medium, a 253-character referrer host). Expected: grouped under exactly the label `deriveSource` gives it, the response schema accepts it, the admin shows it as literal text without breaking the table. Tests: Task 2 (`odd characters and the maximum length group under deriveSource's label`), Task 3 (`renders a source with markup as plain text`).
2. **Two scheduler ticks overlap** (a run slower than 15 minutes), or a manual run lands during a scheduled one. Expected: the scheduler skips the tick (one run in flight), and neither run deletes the other's fresh lead (leftovers are only those older than 10 minutes). Tests: Task 6 (`skips an intake tick while the previous run is still in flight`), Task 5 (`a concurrent run's fresh lead is not a leftover`).
3. **The check fails half-way** (lead created, delete failed; or the read-back is wrong). Expected: the failure names the step, a verify failure still deletes the lead, and the next run's leftovers step removes anything left. Tests: Task 5 (`a failed delete is cleaned up by the next run`, `a failed verify still deletes the lead`).
4. **The alert storms while intake stays broken** for hours, or the alert channel itself is down. Expected: one alert at the first failure, then at most one an hour, one all-clear when it passes; a failed send is retried by the next run, not swallowed. Tests: Task 6 (`alerts on the first failure, then at most hourly`, `sends one all-clear and resets`, `a failed send changes nothing`).
5. **Another site's leads leak into the counts** (the same type, window and attribution on a second site; another type on the same site; archived and restricted leads). Expected: none counted, and the totals equal `GET /leads/stats`'s for every window; the intake check never touches another site's leads. Tests: Task 2 (`another site's leads, other types, archived and restricted leads are never counted`, `totals match the dashboard's stats for every window`), Task 5 (`never deletes another site's leads`).

---

## Batch R: source report

### Task 1: Contracts: the source report query, response, endpoint and client

Batch R. Model: easy.

**Files:**

- Create: `packages/contracts/src/reports.ts`, `packages/contracts/src/reports.test.ts`
- Modify: `packages/contracts/src/endpoints.ts` (after `getWorkspaceLeadStats`), `client.ts`, `index.ts`, `client.test.ts`
- Regenerate: `docs/api/openapi.json`

**Interfaces (Produces):**

```ts
// reports.ts
export const SOURCE_REPORT_SUCCESS_STAGES = ['activated', 'installed', 'completed', 'won'] as const;
export const SOURCE_REPORT_MAX_SOURCES = 50;
export const SOURCE_REPORT_MAX_CAMPAIGNS = 20;
export const SOURCE_REPORT_OTHER_SOURCE = 'other';
export const SOURCE_KINDS = ['partner', 'utm', 'referrer', 'direct', 'other'] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS); export type SourceKind;
export const sourceReportQuerySchema = z.object({ leadType: leadTypeSchema, days: z.coerce.number().pipe(z.literal([...LEAD_STATS_WINDOWS])).optional() }).strict();
export type SourceReportQuery = z.infer<typeof sourceReportQuerySchema>;
const counts = { received: z.int().nonnegative(), submitted: z.int().nonnegative(), madeIt: z.int().nonnegative() };
export const sourceReportCampaignSchema = z.object({ campaign: z.string().min(1).max(120).nullable(), other: z.boolean(), ...counts }).strict();
export const sourceReportRowSchema = z.object({ source: z.string().min(1).max(300), kind: sourceKindSchema, ...counts, campaigns: z.array(sourceReportCampaignSchema).max(SOURCE_REPORT_MAX_CAMPAIGNS + 1) }).strict();
export const sourceReportResponseSchema = z.object({
  leadType: leadTypeSchema,
  days: z.literal([...LEAD_STATS_WINDOWS]).nullable(),
  totals: z.object(counts).strict(),
  rows: z.array(sourceReportRowSchema).max(SOURCE_REPORT_MAX_SOURCES + 1),
  withSourceData: z.int().nonnegative(),
  requestId: requestIdSchema,
});
export type SourceReportCampaign, SourceReportRow, SourceReportResponse;
// endpoints.ts
{ operationId: 'getWorkspaceSourceReport', method: 'GET', path: '/api/v1/staff/workspaces/{workspaceId}/reports/sources', summary: "Leads per source for one lead type: received, submitted and made it, over 7, 30 or 90 days or all time.", auth: 'staff', successStatus: 200, query: sourceReportQuerySchema, response: sourceReportResponseSchema }
// client.ts, staff namespace
sourceReport(workspaceId: string, query: SourceReportQuery): Promise<SourceReportResponse>; // GET …/reports/sources, query { leadType, days }
```

`index.ts` exports every name above. Keep the doc comments short: the counting rules live in the backend store.

- [ ] **Step 1: Write the failing tests.** `reports.test.ts`: `SOURCE_REPORT_SUCCESS_STAGES` equals `['activated', 'installed', 'completed', 'won']` and each is a stage key of some `leadTypeCatalog` type; the query parses `{ leadType: 'internet', days: '30' }` to `days: 30`, accepts no `days`, refuses `days: '14'`, an unknown type and an extra key; a full response (one `utm` row with a named and a `null` campaign, one `direct` row with `campaigns: []`, one `other` row) round-trips unchanged; refused: a 301-character source, a 121-character campaign, a negative count, `days: 14`, a campaign without `other`, 52 rows. `client.test.ts`: `sourceReport(ws, { leadType: 'internet', days: 30 })` issues `GET /api/v1/staff/workspaces/<ws>/reports/sources?leadType=internet&days=30` and parses the body; without `days` the URL has no `days`.
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- reports client` → FAIL.
- [ ] **Step 3: Implement**, then `pnpm --filter @gt-sales/contracts build` (regenerates `docs/api/openapi.json`).
- [ ] **Step 4: Run** the contracts suite and `pnpm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): source report query, response, endpoint and client`

---

### Task 2: Backend: the source report store and route

Batch R. Model: hard.

**Files:**

- Create: `apps/backend/src/reports/store.ts`, `apps/backend/src/routes/reports.ts`
- Modify: `apps/backend/src/routes/staff.ts` (`reportStore?: ReportStore` in `StaffRouteDependencies`; `reportStore: new DatabaseReportStore()` in `createDefaultStaffRouteDependencies`; an `unconfiguredReportStore` stand-in; `router.use(createReportRoutes({ store, decide, reportFailure }))` beside `createPlanRoutes`)
- Test: `apps/backend/tests/source-report.test.ts` (unit), `apps/backend/tests/source-report.integration.test.ts`, `apps/backend/tests/report-routes.test.ts`

**Interfaces:**

- Consumes: Task 1's schemas and constants; `Scope` (`../tenant-scope.js`); `contextWorkspaceId`, `withTenantTx`, `DatabaseClient` from `@gt-sales/db`; `PlanRouteDependencies['decide' | 'reportFailure']`.
- Produces:

```ts
// reports/store.ts
export type SourceReport = Pick<SourceReportResponse, 'totals' | 'rows' | 'withSourceData'>;
export interface SourceGroupRow {
  source: string;
  kind: Exclude<SourceKind, 'other'>;
  campaign: string | null;
  received: number;
  submitted: number;
  madeIt: number;
}
export interface ReportStore {
  sourceReport(input: Scope & { leadType: string; days?: number }): Promise<SourceReport>;
}
export class DatabaseReportStore implements ReportStore {
  constructor(database?: Pick<DatabaseClient, 'withTenantTx'>);
}
/** The `deriveSource` label of a jsonb attribution expression, in SQL. */
export function sourceLabelSql(attribution: SQL): SQL;
export function sourceKindSql(attribution: SQL): SQL;
/** Ranks grouped rows into report rows and applies both caps; totals are not its job. */
export function shapeSourceReport(groups: readonly SourceGroupRow[]): SourceReportRow[];
// routes/reports.ts
export interface ReportRouteDependencies {
  store: ReportStore;
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
}
export function createReportRoutes(dependencies: ReportRouteDependencies): Router;
```

The statement (one `tx.execute` inside `withTenantTx`): a `scoped` CTE over `app.leads l` with the Global Constraints' filters, selecting `sourceLabelSql(sql\`l.attribution\`) as source`, the kind, the campaign (`case when <kind> = 'utm' then nullif(l.attribution ->> 'utmCampaign', '') end`), `l.status = 'submitted'`, `l.stage in (<SOURCE_REPORT_SUCCESS_STAGES bound>)`and`l.attribution <> '{}'::jsonb`; then `json_agg`of`group by source, kind, campaign`with the three`count(_) filter (…)::int`s, and `count(_) filter (where has_source)::int as "withSourceData"`. Group in the outer query over the CTE's columns (Canadian Plans' note: a bind parameter repeated in `select`and`group by`renders as two placeholders and Postgres refuses it). Parse the row with a Zod schema; totals are the sums of the groups.`sourceLabelSql` (the one algorithm the signature does not fix):

```sql
case
  when nullif(a ->> 'partnerCode', '') is not null then
    'partner:' || (a ->> 'partnerCode') || case when a -> 'partnerCodeMatched' = 'true'::jsonb then '' else ' (unmatched)' end
  when nullif(a ->> 'utmSource', '') is not null then
    'utm:' || (a ->> 'utmSource') || coalesce('/' || nullif(a ->> 'utmMedium', ''), '')
  when nullif(a ->> 'referrerHost', '') is not null then 'referrer:' || (a ->> 'referrerHost')
  else 'direct'
end
```

Route: `GET /workspaces/:workspaceId/reports/sources`; a bad uuid or query → 400 `invalid_request`; `decide(req, id, 'workspace.read')` denied → 403 with `denyReasonOf`; else 200 `{ leadType, days: days ?? null, ...report, requestId: req.id }`; a throw → `reportFailure` and 500 `internal_error` (the stats route's shape).

- [ ] **Step 1: Write the failing unit tests** (`source-report.test.ts`, `shapeSourceReport` only): 55 `utm` sources `utm:s01`…`utm:s55`, `utm:s01` with 5 leads, the rest 1 → 51 rows, the first `utm:s01` (5), then `utm:s02`…`utm:s50`, the last `{ source: 'other', kind: 'other', received: 5, campaigns: [] }`; ties ordered by code point (`utm:B` before `utm:a`); 25 campaigns on one source → 21 campaign rows, the last `{ campaign: null, other: true }` summing the five smallest; a `null` campaign sorts after a named one with the same count; one source split over three campaign groups gives one row whose counts are their sums; `partner`, `referrer` and `direct` rows have `campaigns: []`; 50 sources exactly → no Other row.
- [ ] **Step 2: Write the failing integration tests** (`source-report.integration.test.ts`, as `lead-stats.integration.test.ts`: leads inserted through the admin connection, read through `DatabaseReportStore` and `DatabaseLeadWorkStore` on the runtime client; sites `…f601`, `…f602`, `…f603`). Seed on `f601`, type `internet`: `{ partnerCode: 'PT-7', partnerCodeMatched: true }` won 1 d; `{ partnerCode: 'PT-7' }` new 1 d; `{ utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'fall' }` installed 2 d; `{ utmSource: 'google', utmMedium: 'cpc' }` new, status `incomplete`, 2 d; `{ utmSource: 'newsletter' }` contacted 20 d; `{ referrerHost: 'facebook.com' }` lost 60 d; `{}` new 3 d; `{ landingPath: '/plans' }` new 3 d. Never counted: an archived and a restricted `internet` lead on `f601`, a `sim_order` on `f601`, an `internet` `utm:google/cpc` lead on `f602`.
  - `counts per source over all time`: totals `{ received: 8, submitted: 7, madeIt: 2 }`, `withSourceData: 7`; rows contain `partner:PT-7` 1/1/1, `partner:PT-7 (unmatched)` 1/1/0, `utm:google/cpc` 2/1/1 with campaigns `[{ campaign: 'fall', other: false, 1, 1, 1 }, { campaign: null, other: false, 1, 0, 0 }]`, `utm:newsletter` 1/1/0 with `[{ campaign: null, … }]`, `referrer:facebook.com` 1/1/0 `[]`, `direct` 2/2/0 `[]`.
  - `the windows`: `days: 7` totals 6, `30` 7, `90` 8.
  - `totals match the dashboard's stats for every window`: for `undefined`, 7, 30, 90, `totals.received` equals `stats({ leadType: 'internet', days }).total`.
  - `another site's leads, other types, archived and restricted leads are never counted`: `f602`'s report has one row `utm:google/cpc` 1/1/0; `f601`'s has none of the excluded leads (the counts above already prove it; assert `f601` `sim_order` report totals 1).
  - `made it means activated, installed, completed or won`: on `f603`, `sim_order` leads at `activated`, `completed`, `delivered`, `cancelled` → `madeIt` 2.
  - `odd characters and the maximum length group under deriveSource's label`: on `f603`, `internet` leads with `{ utmSource: ('\'"<b>x</b> %_\\' ).padEnd(120, 'z'), utmMedium: 'm'.repeat(120) }` and `{ referrerHost: 'h'.repeat(249) + '.com' }` → rows whose `source` equals `deriveSource(attribution)` (245 and 262 characters) and which parse with `sourceReportRowSchema`.
  - `the SQL label is deriveSource's`: for each of `{}`, `{ partnerCode: 'P' }`, `{ partnerCode: 'P', partnerCodeMatched: true }`, `{ partnerCode: 'P', partnerCodeMatched: false }`, `{ partnerCode: '', utmSource: 'g' }`, `{ utmSource: 'g' }`, `{ utmSource: 'g', utmMedium: '' }`, `{ utmSource: 'g', utmMedium: 'cpc', referrerHost: 'bing.com' }`, `{ referrerHost: 'bing.com' }`, `{ landingPath: '/' }`: `select ${sourceLabelSql(sql\`${JSON.stringify(a)}::jsonb\`)}`in a tenant transaction equals`deriveSource(attributionSchema.parse(a))`.
  - `the 50-source cap sums the rest into Other`: on `f603`, 55 `internet` leads `utmSource` `s01`…`s55` plus four more `s01` → 51 rows, the last `other` with `received: 5`, totals 59.
- [ ] **Step 3: Write the failing route tests** (`report-routes.test.ts`, built like `plan-routes.test.ts` with a mocked store): a `viewer` gets 200 and the store receives `{ workspaceId, actorId, leadType: 'internet', days: 30 }`; no `days` → store `days` undefined and response `days: null`; `days=14`, `leadType=nope`, a bad uuid → 400 `invalid_request`, store not called; a caller with no membership → 403; the store throwing → 500 `internal_error` and `reportFailure` called.
- [ ] **Step 4: Run** `pnpm --filter backend test -- source-report report-routes` and `ENV(1) pnpm --filter backend test -- source-report.integration` → FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run** the backend suite with `ENV(1)`, typecheck, lint, format → PASS.
- [ ] **Step 7: Commit** — `feat(backend): source report store and route`

---

### Task 3: Admin: Reports → Sources

Batch R. Model: hard.

**Files:**

- Create: `apps/admin/src/app/w/[workspace]/reports/page.tsx` (`redirect` to `/w/<slug>/reports/sources`, as `w/[workspace]/page.tsx` does), `apps/admin/src/app/w/[workspace]/reports/sources/page.tsx`, `apps/admin/src/components/reports/source-report.tsx`, `apps/admin/src/lib/stats-windows.ts`
- Modify: `apps/admin/src/components/nav-items.ts` (`{ section: 'reports', label: 'Reports', icon: ChartColumnIcon }` after Documents), `apps/admin/src/components/dashboard.tsx` (imports `WINDOWS`, `StatsWindow`, `busiest` from `lib/stats-windows.ts` instead of defining them), `apps/admin/src/lib/api.ts`
- Test: `apps/admin/src/components/reports/source-report.test.tsx`; update `app-sidebar.test.tsx`

**Interfaces:**

- Consumes: Task 1's `SourceReportResponse`, `SourceReportQuery`, `SourceReportRow`; `getLeadsSummary`; `useResource`; `useStaffSession`.
- Produces:

```ts
// lib/stats-windows.ts (moved verbatim from dashboard.tsx)
export type StatsWindow = (typeof LEAD_STATS_WINDOWS)[number] | null;
export const WINDOWS: readonly { days: StatsWindow; label: string; period: string }[];
export function busiest(types: readonly LeadTypeCount[]): string | undefined;
// lib/api.ts
export async function getSourceReport(
  accessToken: string,
  workspaceId: string,
  query: SourceReportQuery,
): Promise<SourceReportResponse>;
// components/reports/source-report.tsx
export function SourceReport(props: { workspaceSlug: string }): JSX.Element;
export function sourceLabel(row: Pick<SourceReportRow, 'source' | 'kind'>): string; // 'Direct', 'Other', else the label as sent
export function madeItRate(madeIt: number, received: number): string; // '25%', '—' when received is 0
```

Behaviour: heading `Sources` (h1) and "Leads per source: how many came in, were submitted and made it."; the Period group (`role="group"`, `aria-label="Period"`, `aria-pressed` buttons from `WINDOWS`), opening on Last 30 days (R11); a `Lead type` select (`NativeSelect`, labelled) of the site's types from `getLeadsSummary`, defaulting to `busiest`. States, in this order: loading (`role="status"` "Loading the report…"); failed → `role="alert"` "Could not load the report." and a `Try again` button (`reload`), no table; `totals.received === 0` → "No leads in this period"; otherwise, when `withSourceData === 0`, the notice "No source data yet. Your websites don't send UTM tags or referrers to the CRM yet, so every lead counts as direct." above the table. The table: `<caption class="sr-only">` "Leads per source, <period>", header cells `Source`, `Received`, `Submitted`, `Made it`, `Made-it rate` (`scope="col"`), one row per source; a `utm` row with campaigns has a `<button type="button" aria-expanded aria-controls>` whose name is the source label, opening its campaign rows (campaign text, "(no campaign)" for `null`, "Other" for `other: true`); a `<tfoot>` row `Total`; under the table "Made it: the lead reached Activated, Installed, Completed or Won.". Every value goes in as a text child (no `dangerouslySetInnerHTML`, no link); long labels wrap (`break-all`). A response for an earlier type or window never overwrites a newer one (`useResource` already guarantees it).

- [ ] **Step 1: Write the failing tests** (`vi.mock('../../lib/api')`): it opens on Last 30 days and the busiest type and calls `getSourceReport` with `{ leadType: 'internet', days: 30 }`; All time sends no `days`; another type reloads; the table's rows read `utm:google/cpc 3 3 1 33%`, `Direct 1 1 0 0%`, footer `Total 4 4 1 25%`; the source button has `aria-expanded="false"`, Enter on it shows the campaign rows `fall_promo 1 1 0` and `(no campaign) 2 2 1` and sets `true`, Space hides them; the no-source-data notice shows only when `withSourceData` is 0 with leads; "No leads in this period" with no table; a rejected call shows "Could not load the report." with no table and no sample row, and Try again calls `getSourceReport` again; `renders a source with markup as plain text` (`utm:<b>x</b>` shows literally and the document has no `b` element); `sourceLabel` and `madeItRate` cases; the sidebar lists Reports linking to `/w/<slug>/reports`.
- [ ] **Step 2: Run** `pnpm --filter admin test -- source-report app-sidebar dashboard` → FAIL (dashboard's tests must still pass after the move).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the admin suite, typecheck, lint, format → PASS (delete `apps/admin/.next` if typecheck reads stale route types).
- [ ] **Step 5: Commit** — `feat(admin): Reports → Sources, leads per source with campaigns`

---

### Task 4: Done when: the source report journey

Batch R. Model: hard.

**Files:**

- Modify: `apps/backend/tests/e2e/harness.ts` (in the CanadaWide `people` loop: Blake Sample with `attribution: {}`, Casey Demo with `{ utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'fall_promo' }`, the rest unchanged; update the header comment), `apps/admin/e2e/leads.spec.ts` (the new journey placed **right after** "the dashboard lists the follow-ups due…", before any journey moves a CanadaWide lead; update the header comment)

- [ ] **Step 1: Add the journey** "the source report counts CanadaWide's internet leads per source and opens a source's campaigns": open `/w/canadawide/dashboard` → sidebar `Reports` → URL `/w/canadawide/reports/sources`, heading `Sources` → `All time` pressed → the `Lead type` select shows Internet → row `utm:google/cpc` reads 3, 3, 1, 33% → row `Direct` 1, 1, 0, 0% → footer `Total` 4, 4, 1, 25% → no "No source data yet" text → press Enter on the `utm:google/cpc` button → `aria-expanded="true"`, rows `fall_promo` 1, 1, 0 and `(no campaign)` 2, 2, 1 → Enter again → `false` → choose Mobility → row `utm:google/cpc` 1, 1, 0 → no console errors.
- [ ] **Step 2: Run** `pnpm --filter admin test:e2e:leads` and again with `TZ=UTC` → PASS, every journey (free ports 4100 and 3101 first; a failure in an earlier journey from the harness change is fixed here).
- [ ] **Step 3: Commit** — `test: source report journey`

---

## Batch I: intake check

### Task 5: Backend: the intake check runner and its store

Batch I. Model: hard.

**Files:**

- Create: `apps/backend/src/intake-check/check.ts`, `apps/backend/src/intake-check/store.ts`
- Test: `apps/backend/tests/intake-check.test.ts` (unit, fakes), `apps/backend/tests/intake-check.integration.test.ts`

**Interfaces (Produces):**

```ts
// check.ts
export const INTAKE_CHECK_LEFTOVER_AGE_MS = 10 * 60_000;
export const INTAKE_CHECK_LEAD_TYPE = 'internet';
export const INTAKE_CHECK_CONSENT_VERSION = 'intake-check-v1';
export const INTAKE_CHECK_CONTACT = {
  fullName: 'Intake Check',
  email: 'intake-check@example.invalid',
  phone: '403 555 0199',
  countryCode: 'CA',
} as const;
/** The fixed fictional internet form (R3); `consentedAt` is the run's time. */
export function intakeCheckForm(now: Date): LeadForm; // payload { planId: 'intake-check', planLabel: 'Intake check', dateOfBirth: '2000-01-01', streetAddress: '1 Intake Check Street', city: 'Toronto', consent: true, consentedAt: now.toISOString() }
export type IntakeCheckStep = 'leftovers' | 'create' | 'verify' | 'delete';
export type IntakeCheckResult =
  | { status: 'ok'; durationMs: number }
  | { status: 'failed'; step: IntakeCheckStep; code: string; durationMs: number };
export interface IntakeCheckDependencies {
  leads: Pick<LeadStore, 'createLead'>;
  store: IntakeCheckStore;
  now?: () => Date;
}
export interface IntakeCheckRunInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
}
/** Never throws: any failure is a `failed` result at the step in progress. */
export function runIntakeCheck(
  dependencies: IntakeCheckDependencies,
  input: IntakeCheckRunInput,
): Promise<IntakeCheckResult>;
/** A bounded snake-case code for any thrown value (never its message unless it is already a code). */
export function intakeCheckCode(error: unknown): string;
/** One JSON log line per run, written by `runIntakeCheck` itself (so manual runs log too): `{ event: 'intake_check', status, step?, code?, durationMs, leftovers? }`. */
export function logIntakeCheck(result: IntakeCheckResult, leftovers: number): void;
// store.ts
export interface IntakeCheckLead {
  leadType: string;
  status: string;
  stage: string;
}
export interface IntakeCheckStore {
  /** Deletes the site's leads created before `before`; returns how many. */
  deleteLeftovers(scope: Scope, before: Date): Promise<number>;
  readLead(scope: Scope, leadId: string): Promise<IntakeCheckLead | undefined>;
  /** Deletes one lead in one tenant transaction; `remaining` re-counts rows with that id afterwards. */
  deleteLead(scope: Scope, leadId: string): Promise<{ deleted: number; remaining: number }>;
}
export class DatabaseIntakeCheckStore implements IntakeCheckStore {
  constructor(database?: Pick<DatabaseClient, 'withTenantTx'>);
}
```

Steps of one run, in order (the spec's §4): **leftovers** `deleteLeftovers(scope, now − 10 min)` (a count > 0 goes into the log line); **create** build `{ leadType: 'internet', contact: INTAKE_CHECK_CONTACT, form: intakeCheckForm(now), consentVersion, submit: true }`, `createLeadRequestSchema.safeParse` (failure → code `intake_request_invalid`), `checkLeadIntake` (refused → `intake_refused_<problem>`), then `createLead({ ...body, workspaceId, actorId, requestId })`; **verify** `readLead`: missing → `lead_missing`, `leadType` not `internet` → `wrong_type`, `status` not `submitted` → `not_submitted`, `stage` not `initialLeadStage('internet')` → `wrong_stage`, and on any of these still call `deleteLead` (its own failure ignored) before returning the verify failure; **delete** `deleteLead`: `deleted !== 1` or `remaining !== 0` → `delete_incomplete`. `intakeCheckCode`: `isConnectionLevelError` → `persistence_unavailable`; an `Error` whose message matches `/^[a-z][a-z0-9_]{0,63}$/` → the message; a `code` matching `/^[0-9A-Z]{5}$/` on the error or its `cause` chain (depth ≤ 8) → `sqlstate_<code lower-cased>`; else `unexpected_error`. The store's deletes and reads filter on `workspace_id = app.workspace_id` (`contextWorkspaceId`) inside `withTenantTx`, never on a passed id alone.

- [ ] **Step 1: Write the failing unit tests** (`intake-check.test.ts`, fake `leads` and `store`, injected clock): `creates a submitted internet lead with the synthetic contact as the given actor` (the `createLead` input has `leadType: 'internet'`, `submit: true`, the contact, `consentVersion: 'intake-check-v1'`, `actorId`, `requestId`, and no `attribution`, `order` or `idempotency`); `the request passes the website route's own checks` (`createLeadRequestSchema.parse` and `checkLeadIntake(...).ok`); `reports ok with the duration`; `reports the step in progress when a dependency throws` (leftovers, create, delete); `a failed verify still deletes the lead` (each of `lead_missing`, `wrong_type`, `not_submitted`, `wrong_stage`, and `deleteLead` called once); `delete_incomplete` when `remaining` is 1; `intakeCheckCode`: `{ code: 'ECONNREFUSED' }` → `persistence_unavailable`, `new Error('customer_data_restricted')` → itself, an error with `cause: { code: '23503' }` → `sqlstate_23503`, `new Error('duplicate key value violates…')` → `unexpected_error`, a 65-character snake message → `unexpected_error`; `logs no value`: the captured log line holds `intake_check`, the step and code, and never the email, the phone or the street.
- [ ] **Step 2: Write the failing integration tests** (`intake-check.integration.test.ts`, real `DatabaseLeadStore` and `DatabaseIntakeCheckStore` on the runtime client; site `…f701` created through the admin connection with no members, `…f702` another site, actor `…f701`):
  - `a run creates, verifies and deletes its lead and leaves no row behind`: two runs → both `ok`; on `f701` 0 leads, 0 `lead_activities`, 0 `draft_grants`, 0 `outbox_jobs`, 0 `automation_runs`, 0 `email_messages`; exactly one `contacts` row with the synthetic email; two `lead.created` audit events.
  - `leftovers older than ten minutes are removed first` (a lead inserted 11 minutes old is gone after a run).
  - `a concurrent run's fresh lead is not a leftover` (a lead 2 minutes old survives a run; the test removes it).
  - `never deletes another site's leads` (an 11-minute-old lead on `f702` survives).
  - `the cascade needs no delete grant on the timeline` (a lead on `f701` with a `lead_activities` row and a `lead_tasks` row inserted by the admin connection: `deleteLead` as `app_runtime` returns `{ deleted: 1, remaining: 0 }` and both child rows are gone) — guards R1.
  - `a create on a site that does not exist fails at create with a bounded code` (`workspaceId` `…f7ff`, no row) → `{ status: 'failed', step: 'create', code: 'sqlstate_23503' }` and no contact row added.
  - `a failed delete is cleaned up by the next run` (a store whose `deleteLead` throws once → `failed` at `delete`, the lead is still there; the next run with the clock 11 minutes ahead → `ok` and the site has no lead).
- [ ] **Step 3: Run** `pnpm --filter backend test -- intake-check` and `ENV(2) pnpm --filter backend test -- intake-check.integration` → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the backend suite with `ENV(2)`, typecheck, lint, format → PASS. If the cascade test fails on a permission error, stop and report (R1).
- [ ] **Step 6: Commit** — `feat(backend): intake check runner on the website's intake code`

---

### Task 6: Alert rule, alert kind and the scheduler task

Batch I. Model: hard.

**Files:**

- Create: `apps/backend/src/intake-check/alert-rule.ts`
- Modify: `packages/adapters/src/alerts.ts` (`'synthetic_check_recovered'` appended to `ownerAlertKinds`; subjects per R9 and the Global Constraints), `apps/backend/src/scheduler.ts`
- Test: `apps/backend/tests/intake-alert-rule.test.ts`, `apps/backend/tests/scheduler.test.ts` (extend), `packages/adapters/src/alerts.test.ts` (the subject assertion)

**Interfaces:**

- Consumes: Task 5's `runIntakeCheck`, `IntakeCheckResult`, `IntakeCheckRunInput`, `DatabaseIntakeCheckStore`; `OwnerAlertChannel`, `OwnerAlert`.
- Produces:

```ts
// alert-rule.ts
export const INTAKE_ALERT_REPEAT_MS = 60 * 60_000;
export interface IntakeAlertState { readonly failedRuns: number; readonly lastAlertAt: number | null }
export const INITIAL_INTAKE_ALERT_STATE: IntakeAlertState; // { failedRuns: 0, lastAlertAt: null }
/** `next` is the state to keep once `alert` (if any) has been sent. */
export function decideIntakeAlert(state: IntakeAlertState, result: IntakeCheckResult, nowMs: number): { alert: OwnerAlert | null; next: IntakeAlertState };
/** Runs, decides, sends; applies `next` only when there was nothing to send or the send succeeded. */
export function runIntakeCheckWithAlert(run: () => Promise<IntakeCheckResult>, alerts: OwnerAlertChannel, getState: () => IntakeAlertState, setState: (state: IntakeAlertState) => void, now?: () => number): Promise<IntakeCheckResult>;
// scheduler.ts
export const INTAKE_CHECK_INTERVAL_MS = 15 * 60_000;
export type SchedulerTaskName = 'outbox' | 'document_cleanup' | 'data_retention' | 'intake_check';
BackendSchedulerDependencies += { runIntakeCheck(input: IntakeCheckRunInput): Promise<unknown> };
```

Rule: a failure → `failedRuns + 1`; alert `{ kind: 'synthetic_check_failed', detail: '<step>:<code>' }` when `lastAlertAt` is `null` or `nowMs − lastAlertAt ≥ 60 min` (then `lastAlertAt = nowMs`), else none. An `ok` with `failedRuns > 0` → `{ kind: 'synthetic_check_recovered', detail: 'failed_runs:<n>' }` and `next` the initial state; an `ok` with 0 → nothing, state unchanged. A send that rejects → `{ event: 'intake_check_alert_failed', kind }` logged and `setState` not called. Scheduler: `SCHEDULER_ERROR_PREFIXES.intake_check = 'scheduler:intake_check'`; `logSchedulerError` logs `error.code` for a `SchedulerConfigurationError` and `scheduler_task_failed` otherwise. In `createBackendScheduler`, after the three tasks: when `env.INTAKE_CHECK_WORKSPACE_ID` is non-empty, inside `try`: not a uuid → `SchedulerConfigurationError('intake_check_workspace_invalid')`; `resolveIdentity(registry, JOB_RUNNER_SELECTOR, CRON_SECRET, 'synthetic:check')`; push `{ name: 'intake_check', intervalMs: INTAKE_CHECK_INTERVAL_MS, run: () => dependencies.runIntakeCheck({ workspaceId, actorId: identity.actorId, requestId: randomUUID() }) }`; `catch` → `(config.onError ?? logSchedulerError)({ name: 'intake_check', error })`, other tasks unaffected (R5). `createDefaultSchedulerDependencies` keeps one `IntakeAlertState` in a closure and wires `runIntakeCheck: (input) => runIntakeCheckWithAlert(() => runIntakeCheck({ leads: new DatabaseLeadStore(), store: new DatabaseIntakeCheckStore() }, input), alerts, get, set)`.

- [ ] **Step 1: Write the failing tests.** `intake-alert-rule.test.ts`: `alerts on the first failure, then at most hourly` (failures at 0, 15, 30, 45 min → one alert `create:sqlstate_23503`; at 60 min a second; at 75 none); `sends one all-clear and resets` (five failures then `ok` → one `synthetic_check_recovered` `failed_runs:5`, state initial; another `ok` → none); `an ok with no failure sends nothing`; `a failed send changes nothing` (`send` rejects on the first failure → state still initial and `intake_check_alert_failed` logged; the next failing run alerts again; an all-clear whose send rejects is retried by the next `ok`); `runIntakeCheckWithAlert` returns the result unchanged. `scheduler.test.ts`: `registers intake_check every 15 minutes only when INTAKE_CHECK_WORKSPACE_ID is set` (registry scopes `['outbox:run', 'synthetic:check']`; fake timers; called with `{ workspaceId, actorId: ACTOR, requestId: <uuid> }` after the startup delay and again 15 min later; unset → never called); `skips an intake tick while the previous run is still in flight` (a run that resolves after 20 min → one call at 15 min, two after it resolves and the next tick); `leaves out the intake check, keeping the other tasks, when the scope is missing` (outbox still runs; `onError` receives `{ name: 'intake_check' }` with code `scheduler_scope_missing`); `an invalid INTAKE_CHECK_WORKSPACE_ID is logged by its code` (`intake_check_workspace_invalid`); `logs a configuration error by its code` (the default logger's line has that code, not `scheduler_task_failed`); existing tests pass with `runIntakeCheck` added to their dependencies. `alerts.test.ts`: the `synthetic_check_failed` subject contains `intake check failed`; `synthetic_check_recovered` is a kind with subject `GT Sales CRM: intake check passing again`.
- [ ] **Step 2: Run** `pnpm --filter backend test -- intake-alert-rule scheduler` and `pnpm --filter @gt-sales/adapters test -- alerts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend and adapters suites (`ENV(2)`), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): intake check every 15 minutes with failure and all-clear alerts`

---

### Task 7: The manual run route

Batch I. Model: easy.

**Files:**

- Create: `apps/backend/src/routes/intake-check.ts`
- Modify: `apps/backend/src/app.ts` (`intakeCheck?: IntakeCheckRouteDependencies` in the options; `app.use('/api/internal/jobs', createIntakeCheckRouter(options.intakeCheck ?? createDefaultIntakeCheckRouteDependencies()))` beside the jobs router), `packages/contracts/src/common.ts` (`'intake_check_off'` in `domainErrorCodeSchema`), `apps/backend/src/http/domain-errors.ts` (message "The intake check is off on this deployment."); regenerate `docs/api/openapi.json`
- Test: `apps/backend/tests/intake-check-route.test.ts`

**Interfaces:**

- Consumes: Task 5's `runIntakeCheck`, `IntakeCheckResult`, `IntakeCheckRunInput`; `MachineRegistry`, `loadMachineRegistry`, `loadDeploymentEnvironment`.
- Produces:

```ts
export interface IntakeCheckRouteDependencies {
  registry: MachineRegistry;
  /** `INTAKE_CHECK_WORKSPACE_ID`; absent or not a uuid, the route answers 404 `intake_check_off`. */
  workspaceId?: string;
  run(input: IntakeCheckRunInput): Promise<IntakeCheckResult>;
  selector?: string; // JOB_RUNNER_SELECTOR
  deploymentEnvironment?: string;
}
export function createDefaultIntakeCheckRouteDependencies(): IntakeCheckRouteDependencies;
export function createIntakeCheckRouter(dependencies: IntakeCheckRouteDependencies): Router; // POST /intake-check
```

Order, as `routes/jobs.ts`: preview → 403 `machine_unknown`; no selector (`X-Scheduler-Selector` header, else `selector`) or no `Bearer` secret → 401 `machine_unknown`; identity refused → 401 with its reason; no `synthetic:check` → 403 `scope_denied`; then no valid `workspaceId` → 404 `intake_check_off` (after authentication, so the configuration is not revealed to strangers); else `run({ workspaceId, actorId: identity.actorId, requestId: req.id })` → 200 `{ ...result, requestId }` for `ok` and `failed` alike; a throw → 500 `internal_error`. No alert (R6).

- [ ] **Step 1: Write the failing tests** (a `MachineRegistry` built from a config literal, as `jobs-route.test.ts`): no secret → 401; wrong secret → 401; an entry with only `outbox:run` → 403 `scope_denied`, run not called; authorized but no `workspaceId` → 404 `intake_check_off`; a `failed` result → 200 with `status: 'failed'`, `step`, `code`; `ok` → 200; the run receives the registry's `actorId` and the configured site id, never one from the request body (a body `{ workspaceId: <other> }` is ignored); `deploymentEnvironment: 'preview'` → 403; a throwing run → 500 `internal_error`; GET → 404 (POST only).
- [ ] **Step 2: Run** `pnpm --filter backend test -- intake-check-route` → FAIL.
- [ ] **Step 3: Implement**, then `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** the backend suite (`ENV(2)`), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): manual intake check run for the synthetic:check machine scope`

---

### Task 8: Paste file, runbook and docs

Batch I (its tail; written from this plan's names for Batch R, checked by the controller after both merge). Model: easy.

**Files:**

- Create: `docs/RUNBOOKS/manual/intake-check-site.sql`, `docs/RUNBOOKS/intake-check.md`
- Modify: `docs/ENV.md`, `docs/HANDOFF.md`, `docs/PLAN.md`, `AGENTS.md`, `docs/superpowers/phases/README.md`, `docs/superpowers/phases/phase-6-reports-dashboard-checks.md` (status line)

Content:

- **Paste file** (owner-run in the Supabase SQL editor, each section on its own): **A** pre-check `select id, slug, status from app.workspaces where slug = 'intake-check'`; **B** create, idempotent on the slug: `insert into app.workspaces (slug, name, status) values ('intake-check', 'Intake check', 'active') on conflict (slug) do nothing`, then the id to copy into `INTAKE_CHECK_WORKSPACE_ID`; verification selects, one at a time: 0 `memberships`, 0 `service_credentials`, 0 `workspace_email_settings`, 0 `automations` for that id; **C** controlled failure (R7): `delete from app.workspaces where slug = 'intake-check' and id = '<id>'` (cascades the site's rows; leave the variable as it is); **D** recovery: `insert into app.workspaces (id, slug, name, status) values ('<id>', 'intake-check', 'Intake check', 'active')`. No roles or permissions rows: the site has no members.
- **Runbook** `intake-check.md`: what it does (the four steps, every 15 minutes, on the one scheduler replica); provisioning (section B; add `synthetic:check` to the scheduler entry's `scopes` in `MACHINE_REGISTRY_JSON`; set `INTAKE_CHECK_WORKSPACE_ID`; redeploy; watch two or three `{"event":"intake_check","status":"ok"}` lines; a missing scope shows as `scheduler_scope_missing` at boot and no run); what an alert means: detail `<step>:<code>` with a table (`create:sqlstate_23503` the site row is gone or the id is wrong; `create:intake_refused_<part>` the intake rules changed, check `leads/types.ts`; `*:persistence_unavailable` the database or pooler; `verify:*` the store wrote something unexpected; `delete:delete_incomplete` the next run retries); the all-clear `failed_runs:<n>`; one repeat an hour while failing; a restart during an outage may repeat one alert; how to silence it (unset `INTAKE_CHECK_WORKSPACE_ID` and redeploy); the manual run (`POST /api/internal/jobs/intake-check` with `Authorization: Bearer <CRON_SECRET>`, never pasted into chat or docs; it never alerts); the controlled failure (C, wait for the alert within 15 minutes, D, wait for the all-clear); what stays on the site (one contact row, one `lead.created` audit row per run, about 96 a day, never pruned: a follow-up).
- **ENV.md** Scheduler: `INTAKE_CHECK_WORKSPACE_ID` (backend only; the test site's id; unset = the check is off and the manual route answers 404); the `MACHINE_REGISTRY_JSON` example's scopes gain `synthetic:check` with a note that the intake check needs it.
- **HANDOFF:** §2.1 the fourth scheduler task; §2.3 `GET /workspaces/:id/reports/sources` (`workspace.read`, counts only) and `POST /api/internal/jobs/intake-check` (machine, `synthetic:check`); §3 a new entry "2026-10-31: merge phase 6, source report and intake check" with rulings R1–R11; §5.1 owner steps (paste B, the registry scope, the variable, watch runs, C and D with the owner's agreement); §5.3 follow-ups (Umami later, websites sending attribution, a public-route check, the test site's audit rows, a stored check history).
- **PLAN** §7 status for phase 6 (built, Umami later); §10 the owner's provisioning steps.
- **AGENTS.md** vocabulary: the **source report** (per source label `deriveSource`, received, submitted, **made it** = `SOURCE_REPORT_SUCCESS_STAGES`, the caps), the **intake check** and the **test site** (`intake-check`, no members, `INTAKE_CHECK_WORKSPACE_ID`, alerts and all-clear); where things live: `src/reports/store.ts`, `src/routes/reports.ts`, `src/intake-check/`, `src/routes/intake-check.ts`, the scheduler's four tasks, `apps/admin/src/components/reports/` and `app/w/[workspace]/reports/sources`, contracts `packages/contracts/src/reports.ts`.
- **Phases README** status table: phase 5 "Deployed: PR #9 merged 2026-10-31; migrations 0017 and 0018 applied, except the owner-pasted `app.prune_operational_rows` replacement; switch day (`CRM_ORDERS`, the final import, `CRM_TRACKING`) pending"; phase 6 title "Source report and synthetic (intake) check; Umami later", done-when "the source report counts leads per source; a broken intake raises an alert", status "Built, not deployed" with the plan link `../plans/2026-10-31-phase-6-source-report-intake-check.md`.

- [ ] **Step 1: Write the files**, then `pnpm exec prettier --write` on every changed Markdown file and `pnpm run format` → PASS.
- [ ] **Step 2: Rehearse the paste file** on `gt_sales_t2_test`: A, B twice (one row), the verification selects, C, D (same id back) → as described.
- [ ] **Step 3: Commit** — `docs: phase 6 source report and intake check`

---

## Task 9: Controller: merge, gate, pull request, provisioning, deploy

After both batches. Not an implementer task.

- [ ] **Step 1:** Merge `p6/t1` and `p6/t2` into `phase-6-reports-checks`; resolve `docs/api/openapi.json` by `pnpm --filter @gt-sales/contracts build` and commit `chore: regenerate the OpenAPI document`; check T8's docs against Batch R's merged names.
- [ ] **Step 2: The gate:** `pnpm run lint && pnpm run typecheck && pnpm run format`; `ENV(9) pnpm run test`; `pnpm --filter admin test:e2e:leads` and again under `TZ=UTC`; `pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json` → all green. Then the final whole-branch review, one fix wave, one scoped re-review (README "Working method").
- [ ] **Step 3: Pull request** "Source report and intake check (merge phase 6)": what changed, no migration (R1, R2), the owner's provisioning steps, the gate's results, the footer; subscribe and schedule a check-in; merge with a merge commit once `verify` is green.
- [ ] **Step 4: Deploy in order:** Railway backend, `GET /api/v1/health` 200, then the Vercel admin. The check stays off until the owner runs paste B, adds the scope and sets the variable.
- [ ] **Step 5: Live check:** Reports → Sources for Get Canada Sim and CanadaWide shows the counts and the "No source data yet" notice; two or three green `intake_check` runs in the Railway logs; with the owner's agreement, paste C → the `synthetic_check_failed` alert `create:sqlstate_23503`, paste D → the `synthetic_check_recovered` alert; record what was seen in HANDOFF §5.1 and the README status row ("Deployed").
