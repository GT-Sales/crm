# Merge phases 5 to 8: hand-off documents

These pages let a fresh AI session, with no memory of this project, start any
remaining phase of the GT Sales CRM and Canadian Plans merge. Each phase file
says what the phase is for, what already exists, every decision already
taken, what to ask the owner first, a task outline for the planner, how to
test and ship, and the working method that delivered phases 1 to 4.

Written 2026-10-30, after merge phase 4 (PR #6) merged. Every file name,
route, table, permission and constant named here was opened and checked on
that day. Where something is planned and not built, the page says "to do".
When a page stops being true, change it in the same pull request that makes
it untrue.

## The eight phases

The phases are the merge design's
([spec §12](../specs/2026-10-28-merge-canadian-plans-design.md#12-phases)).
Each ships on its own and leaves GT Sales working.

| #   | Phase                                                                                                             | Done when (spec §12)                                                                                             | Status on 2026-10-30                                                                                                                                                                                                                                                                                                                                    | Page or plan                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Backups                                                                                                           | A nightly archive lands in B2 and a restore has been practised.                                                  | Built and merged (PR #2, 2026-10-29); migrations 0007 and 0008 applied. The "done when" waits on the owner's set-up steps B1 to B6 ([HANDOFF §5.1](../../HANDOFF.md#51-owner-before-anything-else)): until then every scheduled backup run fails for want of secrets.                                                                                   | [plan](../plans/2026-10-29-phase-1-backups.md)                             |
| 2   | Property engine for leads, hybrid layout, private saved views                                                     | Staff work leads in the new layout, filter by any property and add a custom property.                            | Done: PR #3 merged 2026-10-29, migrations 0009 and 0010 applied. PR #5 (2026-10-30) put the table, toolbar and shell back to the pre-phase-2 look at the owner's request, keeping every feature.                                                                                                                                                        | [plan](../plans/2026-10-29-phase-2-properties-layout-views.md)             |
| 3   | Plans and stage clean-up, Archive                                                                                 | Staff manage plans; a test website reads them; no lead is left in an `invoiced` or `paid` stage.                 | Done: migrations 0011 and 0012 applied, PR #4 merged 2026-10-30, deployed, post-deploy check clean.                                                                                                                                                                                                                                                     | [plan](../plans/2026-10-30-phase-3-plans-stages-archive.md)                |
| 4   | Order tools and customer email                                                                                    | A test SIM order goes from submitted to activated with branded emails; an unapproved document blocks activation. | Done: migrations 0013 and 0014 applied 2026-10-30, PR #6 merged 2026-10-30 15:19 UTC, Railway deploy `862df29a` succeeded with health 200, Vercel admin built from `main`; live check: no automation rows, no saved templates or settings yet. The owner's per-site steps (Settings → Email, a test send, switching rules on) are to do (HANDOFF §5.1). | [plan](../plans/2026-10-30-phase-4-order-tools-email.md)                   |
| 5   | Customer tracking; Get Canada Sim's `/track` switches                                                             | A real customer's change request is approved in the CRM.                                                         | To do                                                                                                                                                                                                                                                                                                                                                   | [phase-5-customer-tracking.md](phase-5-customer-tracking.md)               |
| 6   | Source report, Umami dashboard, synthetic check                                                                   | The dashboard shows visitors beside leads per source; a broken intake raises an alert.                           | To do                                                                                                                                                                                                                                                                                                                                                   | [phase-6-reports-dashboard-checks.md](phase-6-reports-dashboard-checks.md) |
| 7   | Canadian Plans moves: new deployment and database, `apps/site-1` to its own repository, old backend and admin off | A Canadian Plans test order goes through the new deployment.                                                     | To do                                                                                                                                                                                                                                                                                                                                                   | [phase-7-canadian-plans-cutover.md](phase-7-canadian-plans-cutover.md)     |
| 8   | Review, then automations                                                                                          | Decided then.                                                                                                    | To do                                                                                                                                                                                                                                                                                                                                                   | [phase-8-review-and-automations.md](phase-8-review-and-automations.md)     |

Not in any phase yet: **phase 3b** (the cross-site inbox, the contact page and
split/merge of contacts, deferred twice, ruling of 2026-10-30, HANDOFF §5.2)
and the **CanadaWide cutover clean-up** (drop the 0002 mirror trigger once staff
work only in the CRM, HANDOFF §5.1 item 7). Ask the owner where they go when a
phase touches the same screens.

## How to start a phase

Tell the new session "start merge phase N". It reads, in this order,
[AGENTS.md](../../../AGENTS.md), this README in full, the phase file in full
and every file in the phase's "Read first" list; it adds any repository the
phase needs with the session's add-repository tool (do not pre-check it with
`curl` or `gh`); it loads `superpowers:brainstorming` and puts the phase's open
decisions to the owner one at a time, each with a plain explanation and the
recommended default; it writes the plan with `superpowers:writing-plans` into
`docs/superpowers/plans/YYYY-MM-DD-phase-N-<topic>.md`; the owner approves the
plan; it executes with `superpowers:subagent-driven-development` as in
[Working method](#working-method); it ships as in [How to ship](#how-to-ship);
and it updates HANDOFF, PLAN, ENV, the runbooks and this README's status row.

## Shared conventions

Every phase file links here. The rules below bind every phase; a phase file
lists only what it adds.

### Where things are

| System                    | Facts (read from HANDOFF §1 and the live systems on 2026-10-30)                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This repository           | `GT-Sales/crm`. `main` is production for both apps. CI is `.github/workflows/ci.yml`, job `verify`.                                                                                                                                                                                                                                           |
| Backend (GT Sales)        | Railway project `GT Sales CRM` (`ea4ffa36-d587-45b8-a64d-9f8f84fbd42f`), service `crm` (`01c9dcfa-644d-4c52-ade1-b08d65114443`), environment `production` (`112461fd-4e06-44bc-a5ae-13f40438f69e`), Singapore. Health: `https://crm-production-cf2e.up.railway.app/api/v1/health` (200 on 2026-10-30). Builds from `main` per `railway.json`. |
| Admin (GT Sales)          | Vercel team `gt-sales`, project `gt-sales-crm-admin`, root `apps/admin`, Node 22, production branch `main`, live at `https://gt-sales-crm-admin.vercel.app`.                                                                                                                                                                                  |
| Database, Auth, Storage   | Supabase project `xykrphbgpwisqacpyeiv` (Mumbai, `ap-south-1`), shared with the Get Canada Sim website's `public` schema. The CRM owns schema `app` and the role `app_runtime`.                                                                                                                                                               |
| Canadian Plans repository | `/home/user/canadianplans-web-app` in the hand-off session (`Canadian-Plans/canadianplans-web-app`). Source material only; bug fixes only until phase 7 (spec decision 30).                                                                                                                                                                   |
| Get Canada Sim website    | `Md-Takibuddin/Get-Canada-Sim`. Not attached to the hand-off session, so none of its files were opened for these pages; a phase that changes it must add it first.                                                                                                                                                                            |
| CanadaWide website        | `Md-Takibuddin/Canadawide-Sales-website`; its `lib/crm.ts` is the reference client of the website API (HANDOFF §2.6).                                                                                                                                                                                                                         |

### Rules that bind every phase

Each is "decision: why (where recorded)".

1. **Only the backend talks to Postgres**, as `app_runtime` (`NOBYPASSRLS`,
   owns nothing): one door for data and one place to authorize (AGENTS.md
   rule 1).
2. **Every new tenant table** carries `workspace_id`, a `tenantPolicy`, a
   `backupReadPolicy`, FORCE RLS and `app_runtime` grants: a table without the
   backup read policy makes the nightly backup fail on purpose (AGENTS.md rules
   2 and 3; phase 1 plan, Review Focus 1).
3. **Migrations are additive and come in pairs**: a generated `00NN_<name>.sql`
   (`pnpm --filter @gt-sales/db db:generate -- --name <name>`) and a hand-written
   `00NN_<name>_runtime.sql` (`--custom --name <name>_runtime`) for FORCE RLS,
   grants and functions, safe to run twice. **Never edit an applied migration**,
   because both trackers hold its hash (AGENTS.md rule 3,
   `docs/RUNBOOKS/database.md`).
4. **A migration is applied to the hosted project before the deploy that reads
   it**, deliberately, never by the deploy (AGENTS.md "Git").
5. **`packages/contracts` holds every request and response schema and the
   endpoint registry** (`src/endpoints.ts`), and the typed client; after any
   change run `pnpm --filter @gt-sales/contracts build`, which regenerates
   `docs/api/openapi.json`, which CI diffs (AGENTS.md "Commands").
6. **Strict TypeScript, no `any`, no `as`**; parse with Zod (PLAN §3 rule 10;
   every plan's Global Constraints).
7. **Side effects go through the outbox** (`app.outbox_jobs`), deduped on
   `(workspace, job_type, dedupe_key)` (AGENTS.md rule 6).
8. **No PII in logs, audit, timeline or automation runs**: they carry keys,
   ids, versions and field names, never values; an address outside a job
   payload only as a keyed `contact_hash`. A staff-written reason (the
   documents override) may sit on the timeline (AGENTS.md rule 7; phase 4
   Global Constraints; phase 4 ruling on Task 1).
9. **Sensitive properties never appear in filters, sorts, columns, saved views,
   board cards or the timeline** (spec §5.2; phase 2 Global Constraints).
10. **Staff authorization is per action** (`apps/backend/src/staff/authorization.ts`):
    roles `owner`, `leads`, `orders`, `partners`, `finance`, `content`,
    `viewer`; contact details only for `lead.manage`, `order.manage` or
    `financial.read`; every change to a lead needs `lead.manage` (AGENTS.md
    rule 4).
11. **An Orders-only member cannot reach the documents override**: the stage
    `PATCH` needs `lead.manage`, which the `orders` role lacks, so only the
    owner and members holding both Leads and Orders can use `order.override`.
    Widening it is a one-line role change the owner has not asked for (ruling
    D1 and the Task 12 ruling of phase 4; HANDOFF §5.3).
12. **Every automation rule is off until someone with `integration.manage`
    switches it on**; a site without a row has the rule off; a rule that is off
    queues nothing and records no run. Why: websites may already send the same
    email (spec §15; ruling D5; AGENTS.md vocabulary).
13. **A lead the customer never submitted gets no stage-rule mail**, and that
    includes an abandoned checkout staff rescue by hand (Incomplete → Pending
    and on), because a staff move never changes `leads.status`. Mailing rescued
    checkouts is a small follow-up the owner has not asked for (phase 4 final
    review, Important 1 and Minor 7; HANDOFF §3.7 item 6).
14. **No multi-factor sign-in in any deployment** (owner decision 2026-10-25;
    spec decision 5).
15. **Admin copy in sentence case, every control labelled, keyboard-usable**;
    the look is the one PR #5 restored (256 px sidebar, 56 px top bar, roomy
    table rows, the CRM colour tokens in `apps/admin/src/app/crm-theme.css`)
    (every plan's Global Constraints; PR #5).
16. **Integration suites run on a database whose name ends in `_test`**, are
    re-runnable on a persistent local database, and use fixed UUIDs in a range
    of their own per suite (AGENTS.md rule 9; phase 4 Global Constraints).
17. **No secrets, credentials or customer data in the repository, docs, commit
    messages or chat** (AGENTS.md rule 8).
18. **Websites stay outside the product** and call the API with a per-site key;
    the browser never sends a price (spec decisions 4 and 12).
19. **Each phase ships on its own and leaves GT Sales working** (spec §12).
20. **Stage keys are referenced by reports, emails and automations**: labels
    may change freely, keys should be settled before phase 8 (spec §14).
21. **Money is integer cents in CAD; one lead is one sale, with a quantity of 1
    to 99** (spec decision 29; phase 3 Global Constraints).
22. **A date that defaults to "today" is today in `America/Toronto`**
    (`todayInToronto` in `apps/backend/src/leads/stage-move.ts`; phase 4).
23. **There is no delete in the admin**: staff archive; customer data is
    deleted by a developer on request (spec decision 18).

### Commands and the gate

`ENV(n)` means these variables, for a database created once with
`psql -h localhost -U postgres -c 'create database gt_sales_t<n>_test'` (the
local `postgres` password is `postgres`, local only):

```sh
TEST_MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gt_sales_t<n>_test \
MIGRATION_DATABASE_SSL_MODE=disable DB_TEST_ALLOW_DESTRUCTIVE=1 \
DATABASE_URL=postgresql://app_runtime:local_ci_runtime_password@localhost:5432/gt_sales_t<n>_test \
DATABASE_SSL_MODE=disable EMAIL_CONTACT_HASH_SECRET=ci-email-contact-hash-secret-0123456789
```

The gate, all green before the pull request and again before the merge:

```sh
pnpm run lint && pnpm run typecheck && pnpm run format
ENV(n) pnpm run test
pnpm --filter admin test:e2e:leads        # needs a local gt_sales_crm_e2e_test database
pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json
```

Run the lead journeys once more under `TZ=UTC`: phase 4's re-review caught a
journey that assumed the browser's day was Toronto's.

### How to ship

1. **Pull request.** Title "<what it does> (merge phase N)", as in
   "Order tools and customer email (merge phase 4)". The body: what changed,
   what to do before deploying (the migrations), the gate's results, and the
   footer the session's attribution instructions give. Commits end with the
   trailers the session gives (`Co-Authored-By:` for the model that wrote the
   commit, and `Claude-Session:`). Subscribe the session to the PR's activity
   and schedule a check-in (`send_later`) so a red CI or a review is not missed.
   Merge with a merge commit once `verify` is green.
2. **Migrations on the hosted project, before the merge.** The Supabase tool
   asks for a confirmation on `apply_migration`, and on any `execute_sql` whose
   text holds a `DELETE` or a function body with deletes; that prompt does not
   reach the session and times out. What worked in phase 4:
   - write the paste file `docs/RUNBOOKS/manual/00NN-00MM-<topic>.sql` first:
     a header with each file's `sha256sum` and journal `when`, a pre-check
     select, `BEGIN` … both files verbatim and the tracker rows … `COMMIT`, and
     the verification selects (run them one at a time: the SQL editor shows
     only the last result); rehearse it on a local database migrated to the
     previous migration;
   - run the plain DDL and grants through `execute_sql` in small batches;
   - hand the owner any statement that trips the prompt (in phase 4, the
     `CREATE OR REPLACE FUNCTION app.prune_operational_rows`) as a paste for
     the SQL editor, and wait for "done";
   - insert the Drizzle tracker row
     (`insert into drizzle.__drizzle_migrations (hash, created_at) values ('<sha256>', <when>)`)
     and the `supabase_migrations.schema_migrations` row by hand;
   - verify against the catalog (`pg_class`, `pg_policies`, `pg_proc`,
     `has_table_privilege`), never against the trackers;
   - record the date, tracker versions and every result in
     `docs/RUNBOOKS/database.md` and HANDOFF §5.1.
3. **Deploy in order.** Merge → Railway builds the backend from `main` → wait
   for the deployment to succeed and `GET /api/v1/health` to answer 200 → then
   the Vercel admin from `main`. Docs-only changes skip both builds.
4. **Live check.** Open the live admin as the owner and walk the phase's "done
   when" by hand; record what you saw in HANDOFF.

### Working method

The procedure that delivered phases 1 to 4:

1. **Brainstorm with the owner** (`superpowers:brainstorming`), one decision at
   a time, each with a plain explanation of what it means for staff and
   customers and a recommended default. The owner asked for this.
2. **Write the plan** (`superpowers:writing-plans`) into
   `docs/superpowers/plans/YYYY-MM-DD-phase-N-<topic>.md`, in the style of the
   phase 4 plan: Goal, Architecture, Tech Stack, Spec references, a dependency
   waves table, Global Constraints (exact names, limits and keys), Review Focus
   (five concrete failure scenarios, each with its test), then numbered tasks
   with Files, Interfaces, the failing tests first, the run command, the
   commit message, and "Model: easy" or "Model: hard".
3. **The owner approves the plan.** Owner rulings on the draft are written into
   the plan header (as D1 to D5 were).
4. **Execute** with `superpowers:subagent-driven-development`: two or three
   implementers in parallel, each in its own worktree `/home/user/crm-wt/t<n>`
   on a branch `p<N>/t<n>`, each with its own `_test` database
   (`gt_sales_t<n>_test`). Sonnet 5.5 for mechanical tasks, Opus 5.5 for
   integration and judgement tasks. A pre-flight scan of what each task
   produces and consumes comes first. Each task gets a review; up to five fix
   rounds; then it merges into the work branch. Keep a ledger
   (`.superpowers/sdd/<date>-phase-N-<topic>/progress.md` in the main
   checkout, ignored by git) with every ruling and every deferred minor.
5. **One final whole-branch review on Opus**, given the deferred minors, then
   **one** fix wave (split by disjoint files across parallel implementers if
   useful), then **one** scoped re-review of the fix diff. The controller
   adjudicates what is left: small residuals are controller edits with tests;
   the rest is parked in HANDOFF §5.3 with a reason. No second fix wave.

Operational lessons:

- After a worker restart Postgres is down: `service postgresql start` (or
  `pg_ctlcluster 16 main start`).
- In each new worktree: `pnpm install --offline --frozen-lockfile`.
- Test database names must end in `_test`, or the suites refuse to run.
- Never read a subagent's JSONL output file; use its report.
- Review packages exclude generated files: drizzle `meta/` snapshots,
  `docs/api/openapi.json`, `pnpm-lock.yaml`.
- The lead journeys use ports 4100 (backend harness) and 3101 (admin); a
  leftover server blocks them: `lsof -ti tcp:4100 | xargs -r kill` (and 3101).
- `pkill -f <pattern>` also matches the shell running it; kill by port or pid.
- Delete `apps/admin/.next` when typecheck reads stale route types.
- A subagent's commit may carry its own model's co-author line; a pushed commit
  is not amended.

### Documents to keep current

HANDOFF (§2.3 routes, §2.4 tables, §2.6 website contract, §3 what was done,
§5.1 owner steps, §5.3 follow-ups), PLAN §7 status and §10 owner items, ENV.md
for any variable, `docs/RUNBOOKS/database.md` for any migration, AGENTS.md
vocabulary and "Where things live", and this README's status table.
