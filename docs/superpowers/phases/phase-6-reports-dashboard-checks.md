# Merge phase 6: source report, Umami dashboard and synthetic check

Status on 2026-10-30: to do. Shared rules, the gate, the shipping procedure
and the working method are in [README.md](README.md#shared-conventions); this
page adds what is particular to phase 6.

## 1. Purpose and done when

Spec §12 row 6: "Source report, Umami dashboard, synthetic check (§9)". Done
when: **the dashboard shows visitors beside leads per source; a broken intake
raises an alert.**

In plain words, three pieces (spec §9):

- **Source report.** Counts of leads (and, for orders, how far they got) per
  source, from the attribution the websites already send and the backend
  already stores sanitized. Canadian Plans' `reports/` is the model, adapted to
  leads.
- **Umami dashboard.** A dashboard section that reads the site's own
  self-hosted Umami, read-only: visitors, page views, top sources and UTM,
  countries, top pages and devices for 7, 30 or 90 days, cached a few minutes,
  beside the CRM's leads and activations per source, with an "Open in Umami"
  link. Aggregates only, no personal data. The CRM sends nothing to Umami.
- **Synthetic check.** Every 15 minutes the backend's scheduler submits a test
  lead to a hidden test site through the same services the website route uses,
  removes it, and alerts the owner when it fails. Email is off on that site.

## 2. Read first

1. [README.md](README.md): the shared rules, gate, shipping and method.
2. `AGENTS.md`: rules, vocabulary, where things live.
3. `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md` §2
   (decisions 20, 21, 22, 26), §3 (per-deployment and per-site settings), §9,
   §12, §15 (the Umami open item).
4. `docs/HANDOFF.md` §2.1 (the scheduler), §2.3 (`GET /leads/stats`), §2.6
   (what websites send, `attribution`), §3.4 item 10 (the dashboard as it is).
5. `docs/ENV.md`: "Scheduler", "Optional" (`UMAMI_*`, `OUTBOX_ADAPTERS`), the
   owner alert variables under "Email (Resend)".
6. `docs/RUNBOOKS/database.md`, "Add a site": how a site row is created.
7. `docs/RUNBOOKS/backup-alert-response.md` and `jobs/src/monitor/run.ts`: the
   backup monitor, the pattern for "check, then alert the owner".
8. Canadian Plans (`/home/user/canadianplans-web-app`):
   `apps/backend/src/reports/store.ts` (`DatabaseReportStore.sourceReport`),
   its route `GET /workspaces/:workspaceId/reports/sources` in
   `apps/backend/src/routes/staff.ts`, `apps/admin/src/components/source-report.tsx`
   and `apps/admin/src/app/w/[workspace]/reports/sources/page.tsx`;
   `apps/backend/src/synthetic/check.ts` (`runSyntheticOrderCheck`) and
   `provider.ts`; `docs/ENV.md` sections "Synthetic order check (REQ 40)" and
   the Umami variables; `docs/RUNBOOKS/alerts.md`.

## 3. What already exists to build on

Attribution and sources:

- `attributionSchema` (`packages/contracts/src/leads.ts`): `utmSource`,
  `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent` (each up to 120
  characters), `partnerCode` (64), `partnerCodeMatched`, `landingPath` (512),
  `referrerHost` (253). A website sends raw attribution
  (`rawAttributionSchema`); `sanitizeAttribution`
  (`apps/backend/src/leads/attribution.ts`) bounds and allow-lists it into
  `leads.attribution` (jsonb, default `{}`).
- `deriveSource` (`apps/backend/src/leads/source.ts`) turns it into the list's
  `source` label: `partner:<code>` (or `(unmatched)`), `utm:<source>/<medium>`,
  `referrer:<host>` or `direct`.
- How much attribution GT Sales' websites actually send was not checked for
  this page. Before planning, count it in production (counts per key only,
  never values per lead).

The dashboard:

- `GET /workspaces/:id/leads/stats` (`workspace.read`; route in
  `apps/backend/src/routes/staff.ts`, query in `DatabaseLeadWorkStore.stats`,
  `apps/backend/src/leads/work-store.ts`): one lead type's counts by stage, per
  UTC day and the top 10 partner codes, for `days` 7, 30, 90
  (`LEAD_STATS_WINDOWS`) or all time (`leadStatsQuerySchema`,
  `leadStatsResponseSchema` in `packages/contracts/src/workspace-leads.ts`).
- The admin dashboard: `apps/admin/src/components/dashboard.tsx` and
  `dashboard-charts.tsx`, at `apps/admin/src/app/w/[workspace]/dashboard/page.tsx`
  (HANDOFF §3.4 item 10). The sidebar lists only sections that exist
  (`apps/admin/src/components/nav-items.ts`).

Umami:

- `UmamiAnalyticsSink` (`packages/adapters/src/analytics.ts`) and the
  `UMAMI_EVENTS_URL`, `UMAMI_WORKSPACE_WEBSITES`, `UMAMI_HOSTNAME`,
  `UMAMI_USER_AGENT` variables **send** events. Lead intake queues no analytics
  jobs (ENV.md), and the spec says the CRM sends nothing to Umami (decision 26).
  There is no Umami **read** client.
- Per the spec, each site stores its Umami website id (per-site settings in the
  database, §3) and the backend holds a read-only Umami user's login (§9).
  Neither exists.
- Canadian Plans' Vercel team had a project named `umami` (its
  `docs/RUNBOOKS/release-rollback.md`, recorded 2026-09-21, not re-checked).
  Whether GT Sales' sites use any Umami is the spec's open item (§15).

Checks and alerts:

- The scheduler (`apps/backend/src/scheduler.ts`): tasks `outbox` (60 s),
  `document_cleanup` (1 h), `data_retention` (24 h); `SchedulerTaskName` is
  exactly those three; one replica runs it (`ENABLE_SCHEDULER`). Failures log
  `scheduler_task_failed`.
- `runOutboxWithQueueMonitor` in the same file raises the owner alert
  `job_queue_stuck`; `apps/backend/src/server.ts` raises
  `scheduler_not_started`.
- The owner alert channel (`packages/adapters/src/alerts.ts`):
  `ownerAlertKinds` already includes `synthetic_check_failed` (subject "GT
  Sales CRM: synthetic order check failed"); `createOwnerAlertChannelFromEnv`
  sends to `OWNER_ALERT_EMAIL` and the optional webhook; an alert's `detail`
  is a code or a count, never free text or PII.
- The machine scope `synthetic:check` exists in `machineScopeNames`
  (`packages/types/src/index.ts`); nothing uses it yet. Machine identities are
  in `MACHINE_REGISTRY_JSON` (`apps/backend/src/machines/registry.ts`); manual
  runs go through `/api/internal/jobs/*` (`apps/backend/src/routes/jobs.ts`).
- The backup monitor (`jobs/src/monitor/run.ts`: heartbeat age against a
  threshold, `requiresAlert`, `alertDetail`) is the pattern for a check that
  alerts.

A hidden test site:

- A site is a row in `app.workspaces` (`slug`, `name`, `domain`, `status`
  `active` or `paused`), created by hand ("Add a site" in
  `docs/RUNBOOKS/database.md`) with its roles and permissions.
- Staff see a site only through `app.list_staff_workspaces()`, which lists the
  sites where the caller has an active membership (0001), so a site with no
  members is in nobody's list. `app_runtime` cannot read `app.workspaces` at
  all (0001 comment).
- Website intake is `DatabaseLeadStore` (`apps/backend/src/leads/store.ts`),
  the store the website route calls once the site key is checked.
- Removing the test lead: `app_runtime` has `DELETE` on `app.leads`,
  `app.draft_grants` and `app.lead_tasks` (0001); `app.lead_activities` cascades
  from its lead; audit events are append-only; `app.contacts` has no `DELETE`
  grant, so a fixed synthetic address leaves one contact row that is reused.
- A site with no saved Settings → Email and (after phase 5) no fallback
  sender cannot email (`no_sender`), and with no `app.automations` rows every
  rule is off.

## 4. Decisions already made (binding)

Shared rules 1 to 23 in [README.md](README.md#rules-that-bind-every-phase) bind
this phase. In particular: no PII in logs, audit, timeline or runs (8);
sensitive properties never in filters, columns, views or the timeline (9); never
edit an applied migration (3); contracts hold every schema and the endpoint
registry (5); admin copy in sentence case, labelled, keyboard-usable (15);
strict TypeScript (6); integration suites on a `_test` database with fixed UUID
ranges (16); the Orders-only member cannot reach the documents override (11);
rescued incomplete checkouts get no rule mail (13); every rule off until
switched on (12).

| Decision                                                                                                                                                       | Why                                                         | Where recorded                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| Move Canadian Plans' source report, adapted to leads, counting over stored sanitized attribution.                                                              | Owner choice.                                               | Spec §2 decision 20; §4; §9            |
| Move the synthetic check, simplified: a test lead to a hidden test site every 15 minutes, alert on failure, the robot cleans up after itself; email off there. | Owner choice: catch a broken intake before customers do.    | Spec §2 decision 22; §9                |
| Analytics read-only from the self-hosted Umami: basic numbers on the dashboard, "Open in Umami" for detail. The CRM sends nothing to Umami.                    | Websites keep their own events.                             | Spec §2 decision 26; §4 (sink skipped) |
| One Umami per deployment is supported; the owner creates the read-only user.                                                                                   | Each business has its own deployment.                       | Spec §15                               |
| The Umami website id is a per-site setting in the database, edited in the admin; which modules are on (the synthetic check) is per-deployment environment.     | Staff change site settings; deployments differ by env only. | Spec §3                                |
| Aggregates only on the Umami section, cached a few minutes.                                                                                                    | No personal data; Umami is not hit per page view.           | Spec §9                                |
| The province waitlist is skipped.                                                                                                                              | Owner choice.                                               | Spec §2 decision 21                    |
| "Not configured" and "the query failed" are different states; a failed load shows an error, never sample data.                                                 | Staff must know when numbers are missing.                   | PLAN §3 rule 11                        |
| Counts only are visible to every role (as `GET /leads/stats`).                                                                                                 | Counts carry no contact data.                               | HANDOFF §2.3                           |
| Lead intake queues no analytics jobs.                                                                                                                          | No provider; websites keep their events.                    | HANDOFF §3.2 item 1; ENV.md            |
| Side effects through the outbox; the alert channel is separate from customer email and never gated by consent.                                                 | Alerts must always reach the owner.                         | AGENTS.md rule 6; `alerts.ts` comment  |

## 5. Open decisions to put to the owner before planning

1. **Which sources the report shows.** Recommended: the `deriveSource` groups
   (partner, UTM source and medium, referrer host, direct) with a drill-down
   into UTM campaign, for one lead type and 7, 30, 90 days or all time; for each
   source the leads received, submitted, and for order types activated
   (Activated or later). Ask whether "won" should count for `internet` and
   `mobility` and which stage that is.
2. **Where Umami runs for GT Sales.** Spec open item. Ask: does Get Canada Sim
   or CanadaWide send to an Umami today, which instance, and who hosts it?
   Recommended: one Umami for the GT Sales deployment, its address and a
   read-only user created by the owner; if the sites use none, the Umami part
   waits and the rest of the phase ships.
3. **How the backend signs in to Umami.** Recommended: two backend-only
   variables for the API address and the read-only user's credentials (names
   to choose in the plan, documented in ENV.md, set by the owner on Railway),
   a token cached in memory, and stats cached 5 minutes per site and window.
4. **Where the website id lives.** Recommended: a small per-site row (a new
   table in this phase's migration, like `app.workspace_email_settings`),
   edited under Settings by someone with `integration.manage`.
5. **Who sees the new dashboard sections.** Recommended: everyone with
   `workspace.read`, since everything shown is counts.
6. **The synthetic check's site and lead.** Recommended: one site row (slug
   chosen with the owner) with no members, no email settings and no rules,
   created by an owner-run SQL paste (it is deployment data, as Canadian Plans'
   was), its id in a backend-only variable, a fixed synthetic contact, a lead
   type with one-shot intake (`internet` or `mobility`), and the lead deleted
   after each run (spec: "deletes it"). Ask whether deleting is right or the
   robot should archive instead.
7. **Alerting.** Recommended: alert on the first failed run, at most once an
   hour while it keeps failing, to the existing owner channel
   (`OWNER_ALERT_EMAIL`, optional webhook), with the failing step as the
   detail. Ask whether a recovery message is wanted.
8. **How deep the check goes.** Spec answers "through the same services the
   website route uses", in process. Note to the owner: that does not catch a
   broken Railway edge, CORS or a revoked site key. Optional: a second check
   that calls the public route with a key of the test site.
9. **Switching the check on.** Spec answers "per-deployment environment".
   Recommended: off unless its variables are set.
10. **Showing the alert works.** The "done when" needs a broken intake to raise
    an alert. Recommended: prove it in an integration test with a fake channel,
    and in production by one controlled failure the owner agrees to.

## 6. Constraints and conventions

[README.md shared conventions](README.md#shared-conventions) first. Then:

- The report and the Umami section show counts only; no lead, contact or
  visitor detail, and a URL never carries a personal value.
- Group by stored attribution fields with bound parameters; attribution values
  are customer-influenced text, so treat them as data and cap what is shown.
- An Umami failure or a missing configuration never breaks the dashboard: each
  section has its own "not set up" and "could not load" state.
- The synthetic check writes only to its own site, never to a real one; it
  must not leave a lead behind, queue an email or count in any real site's
  numbers.
- A new scheduler task joins `SchedulerTaskName`, is overlap-guarded like the
  others and logs failures without values.
- Migrations: the next free pair after phase 5's (check
  `packages/db/drizzle/meta/_journal.json`), generated plus `_runtime`, with a
  paste file.

## 7. Suggested task breakdown

| #   | Task                                                                                                                                                                     | Files (main)                                                                                                                                     | Tests                                                                                                           | Model | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| 1   | Contracts: source report query and response, analytics summary response with its states, the per-site analytics setting, endpoints, client.                              | `packages/contracts/src/` (a new reports file), `endpoints.ts`, `client.ts`, `index.ts`; `docs/api/openapi.json`                                 | Contracts unit tests.                                                                                           | easy  | decisions  |
| 2   | Database: the per-site analytics settings table (website id), generated plus `_runtime`, paste file.                                                                     | `packages/db/src/schema.ts`, `packages/db/drizzle/`, `docs/RUNBOOKS/manual/`, `docs/RUNBOOKS/database.md`                                        | `packages/db/tests/` integration (RLS, FORCE, grants, checks).                                                  | hard  | none       |
| 3   | Backend: the source report store and route, ported from Canadian Plans' `reports/store.ts`.                                                                              | `apps/backend/src/reports/` (new), `apps/backend/src/routes/staff.ts`                                                                            | Integration on `ENV(n)`: per-source counts, windows, another site's leads never counted, malformed attribution. | hard  | 1          |
| 4   | Adapters and backend: the Umami read client with its cache; the analytics route; the settings routes.                                                                    | `packages/adapters/src/` (a read client beside `analytics.ts`), `apps/backend/src/routes/`                                                       | Unit with a fake Umami: success, not configured, failure, cache hit.                                            | hard  | 1, 2       |
| 5   | Backend: the synthetic check: runner on the lead store, cleanup, the scheduler task, the alert with its once-an-hour rule, a manual run route.                           | `apps/backend/src/synthetic/` (new), `apps/backend/src/scheduler.ts`, `apps/backend/src/routes/jobs.ts`, `apps/backend/src/machines/registry.ts` | Unit (alert rules); integration (a run leaves no lead; a forced failure alerts once).                           | hard  | none       |
| 6   | Admin: the dashboard's visitors beside leads per source, "Open in Umami", the source report, the website id field in Settings.                                           | `apps/admin/src/components/dashboard.tsx`, `dashboard-charts.tsx`, a settings component, `apps/admin/src/lib/api.ts`                             | Component tests: each state, keyboard and screen-reader table, as the existing charts.                          | hard  | 1 (mocks)  |
| 7   | Done when: harness seeds attribution and a fake Umami; a Playwright journey reads the dashboard; the synthetic failure test.                                             | `apps/backend/tests/e2e/harness.ts`, `apps/admin/e2e/leads.spec.ts`, `apps/backend/tests/`                                                       | All journeys pass.                                                                                              | hard  | 3 to 6     |
| 8   | Docs and runbooks: ENV.md (the new variables), a synthetic check runbook (provisioning, what the alert means, how to silence it), HANDOFF, PLAN, AGENTS.md, this README. | `docs/`                                                                                                                                          | Prettier.                                                                                                       | easy  | all        |
| 9   | Gate, PR, migration, provisioning of the test site, variables, deploy, first green runs, the controlled failure, live check.                                             | none                                                                                                                                             | The gate.                                                                                                       | easy  | all        |

Parallel worktrees: 1 ∥ 2 ∥ 5 first; then 3 ∥ 4 ∥ 6 (admin against mocks);
then 7, 8, 9.

## 8. How to ship

The gate (README "Commands and the gate"):

```sh
pnpm run lint && pnpm run typecheck && pnpm run format
ENV(n) pnpm run test
pnpm --filter admin test:e2e:leads
pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json
```

Then, as in README "How to ship": PR titled "Source report, Umami dashboard and
synthetic check (merge phase 6)" with the footer, subscribe and schedule a
check-in; apply the migration pair to `xykrphbgpwisqacpyeiv` before the merge
(plain DDL and grants through `execute_sql` in small batches, anything that
trips the prompt pasted by the owner, both tracker rows by hand, the
verification selects one at a time, the record in `docs/RUNBOOKS/database.md`);
merge; Railway backend, health 200; Vercel admin.

Phase-specific order:

1. The owner provisions the synthetic site (the paste) and sets its variables
   and the Umami variables on Railway; the check stays off until then.
2. After the deploy, watch two or three runs in the Railway logs (counts and
   codes only), then the controlled failure and its alert.
3. Live check: the dashboard shows visitors beside leads per source for Get
   Canada Sim (or "not set up" if decision 2 left Umami for later).

## 9. Working method

As in [README.md](README.md#working-method). For this phase:

- Brainstorm the ten decisions above one at a time; decision 2 may need the
  owner to check Umami first, so ask it early.
- Tasks 2 to 7 are Opus work; 1, 8 and 9 suit Sonnet.
- Port Canadian Plans' report and synthetic tests with the code (spec §13).
- The Review Focus should include: a source value with odd characters or the
  maximum length; Umami down or slow during a dashboard load; two scheduler
  ticks overlapping; the check failing half-way (lead created, delete failed);
  the alert storming while intake stays broken.

## 10. Definition of done checklist

- [ ] The owner's answers to section 5 are recorded in the plan header.
- [ ] The plan is approved and committed in `docs/superpowers/plans/`.
- [ ] The source report counts per source for each window, counts only.
- [ ] The dashboard shows Umami visitors beside leads per source, with its own
      states for "not set up" and "could not load", and "Open in Umami".
- [ ] The synthetic check runs every 15 minutes on its hidden site, leaves
      nothing behind and alerts the owner on failure; a controlled failure
      raised the alert in production.
- [ ] The migration pair is applied to the hosted project and recorded.
- [ ] The gate is green; the PR merged with a merge commit; Railway and Vercel
      deployed in order.
- [ ] ENV.md, the new runbook, HANDOFF, PLAN, AGENTS.md and this folder's
      README are current.
