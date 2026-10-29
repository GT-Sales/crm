# GT Sales CRM — guide for AI agents and new sessions

Read this first, then [docs/HANDOFF.md](docs/HANDOFF.md) (what is live, what
was done, what comes next and how, with the architecture map),
[docs/PLAN.md](docs/PLAN.md) (decisions, phases) and [docs/ENV.md](docs/ENV.md)
(every variable). Keep all three current when you change what they describe.

## What this is

One backend and one admin for every GT Sales website (Get Canada Sim,
CanadaWide, more to come). Websites keep their own repositories and send leads
to the backend with a per-site key; staff work every site from this admin.
The code was copied from the Canadian Plans platform and pruned
(`docs/PLAN.md` §4); its business data, brand and catalogue were not.

| Path                                                       | Role                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/backend`                                             | Express 5 + strict TypeScript. **The only database client.** Docker image for Railway (`apps/backend/Dockerfile`).     |
| `apps/admin`                                               | Next.js staff app (Tailwind + shadcn). Talks to the backend only. Vercel, root `apps/admin`.                           |
| `packages/db`                                              | Drizzle schema (`src/schema.ts`), migrations (`drizzle/`), pooled runtime client, synthetic seed. Backend-only import. |
| `packages/contracts`                                       | Zod request/response schemas, the endpoint registry, the generated OpenAPI document and the one typed client.          |
| `packages/types`                                           | Value lists (roles, permissions, lead statuses, scopes) that schema, contracts and apps all derive from.               |
| `packages/adapters`                                        | Object store (S3 protocol), Resend email, alerts, error tracking, Umami sink.                                          |
| `jobs`                                                     | Outbox job types, handlers and runner.                                                                                 |
| `packages/ui`, `packages/config`, `packages/observability` | shadcn components; tsconfig/eslint/prettier/vitest/playwright bases; logging.                                          |

## Rules that are not negotiable

1. **Only the backend talks to Postgres**, as the `app_runtime` role
   (`NOBYPASSRLS`, owns nothing) over the Supabase transaction-mode pooler.
   The admin and the websites hold no database credential. An ESLint boundary
   rule fails the build if anything but `apps/backend` imports `@gt-sales/db`.
2. **Every tenant table carries `workspace_id`** and a row-level policy that
   reads `app.workspace_id` / `app.actor_id` set per transaction by
   `withTenantTx`. A query that forgets its tenant sees nothing. `contacts` is
   the one documented global table (merge by email); the backend exposes a
   contact only through a lead of the current site.
3. **Hand-written SQL lives in `drizzle/0001_runtime_functions.sql`** (grants,
   FORCE RLS, SECURITY DEFINER bootstrap functions, triggers). Adding a table
   means a generated migration **and** its grants + FORCE RLS in a new custom
   migration, and a seed/test touching it. `drizzle-kit generate --custom` makes
   the empty file. Never edit an applied migration.
4. **Staff authorization is per action** (`apps/backend/src/staff/authorization.ts`).
   Roles: `owner`, `leads`, `orders`, `partners`, `finance`, `content`,
   `viewer`. A privileged action needs only the role or per-member permission that
   grants it; there is no authenticator-code step (owner decision, 25 Oct 2026).
   Contact details, a lead's form, notes and tasks (and search, which would
   reveal them) are shown only to roles with `lead.manage`, `order.manage` or
   `financial.read`; every change to a lead needs `lead.manage`.
5. **Websites authenticate with a service credential** (`gtsk_…`, hashed at
   rest, scoped, revocable; its row id is the actor for its writes) and prove a
   visitor owns a draft with a draft grant (`gtdg_…`). They can create and
   resume their own leads and upload documents against them, nothing else.
6. **Side effects go through the outbox** (`app.outbox_jobs`), never straight
   from a request handler: emails, analytics, alerts. Dedupe on
   `(workspace, job_type, dedupe_key)`.
7. **No PII in logs, audit `before`/`after` may be redacted to null and never
   rewritten, email tables store a keyed `contact_hash`, never the address.**
8. **No secrets in the repo.** Keys, passwords and customer data live in
   Railway/Vercel/Supabase. Treat the repository as public.
9. **Demo-proof tests.** Integration suites run against a disposable database
   whose name ends in `_test`; the synthetic seed refuses hosted databases.
   Every integration test must be re-runnable on a persistent local database
   (clean what it asserts on).

## Commands

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format   # must pass before a commit
pnpm run test                                            # unit + integration (integration needs the env below)
pnpm run test:tooling                                    # scripts/*.test.mjs
pnpm run test:e2e                                        # admin shell browser checks (build the admin first)
pnpm --filter admin test:e2e:leads                       # lead journeys against the real backend (needs Postgres)
pnpm --filter @gt-sales/contracts build                  # regenerates docs/api/openapi.json (CI diffs it)
pnpm --filter @gt-sales/db db:generate                   # drizzle-kit generate after a schema change
```

Integration tests: `TEST_MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/crm_test
DB_TEST_ALLOW_DESTRUCTIVE=1 MIGRATION_DATABASE_SSL_MODE=disable`, plus for the
backend `DATABASE_URL=postgres://app_runtime:local_ci_runtime_password@localhost:5432/crm_test
DATABASE_SSL_MODE=disable EMAIL_CONTACT_HASH_SECRET=<≥16 chars>`. CI
(`.github/workflows/ci.yml`) runs exactly this on every PR and on `main`.

## Where things live

- Lead intake and store: `apps/backend/src/leads/` (`store.ts` does the contact
  merge and lead-type handling, `types.ts` the registry), routes in
  `src/routes/website.ts`.
- Staff lead work (detail, stage, assignee, notes, tasks, board, trash):
  `src/leads/work-store.ts` for writes, `src/leads/staff-queries.ts` for reads
  (plain SQL with explicit aliases; see the comment at its top).
- Staff routes (sites, access, profile, leads, board, tasks, members, jobs,
  credentials, files): `src/routes/staff.ts`.
- Documents: `src/documents/` (signed upload intent → finalize with
  signature verification → attach; staff review and download links).
- Scheduler: `src/scheduler.ts` (`outbox`, `document_cleanup`,
  `data_retention`), identities in `src/machines/registry.ts`.
- Site properties and record layouts: `apps/backend/src/properties/`
  (`store.ts` for definitions, tombstones and layouts, `catalog.ts` for the
  per-request catalogue) with routes in `src/routes/properties.ts`; staff
  private saved views in `src/views/store.ts` with routes in
  `src/routes/views.ts`.
- Admin pages: `apps/admin/src/app/w/[workspace]/{leads,leads/[leadId],tasks,documents,settings}`
  (Settings → Properties at `settings/properties`); lead screens in
  `src/components/leads/`; the CRM view bar, menus, side panel and page header
  in `src/components/crm/` (tokens in `src/app/crm-theme.css`); property
  rendering, editing and the settings screens in `src/components/properties/`;
  API client `apps/admin/src/lib/api.ts`.
- Historical CanadaWide import: `packages/db/sql/canadawide-legacy-import.sql`
  (docs/RUNBOOKS/legacy-import.md).

## Vocabulary

`workspace` in code = **Site** in the UI = one website. `lead_type` names the
form a lead came from (`sim_order`, `internet`, `mobility`,
`partner_application`, `contact_message`). A lead's `status` is the form's
lifecycle (`incomplete` → `submitted`); its `stage` is where staff are working
it (`new`, `contacted`, `won`…). Labels and stages per type live in one place,
`leadTypeCatalog` in `packages/contracts/src/lead-types.ts`; the backend
registry (`apps/backend/src/leads/types.ts`) adds payload schemas and intake
rules. Form property definitions live once in `leadPropertyCatalog` in
`packages/contracts/src/lead-properties.ts` (paired with each lead type's field
list in `leadTypeProperties`), and `leadFieldCatalog` in
`packages/contracts/src/lead-fields.ts` derives from it.

A **property** is one field of a lead, built-in or custom. Built-in properties
are the form fields defined in code (`leadPropertyCatalog`); a site may
relabel or hide one through a row in `app.properties`. A **custom property** is
a property staff of one site add under Settings → Properties (owner only): its
key is generated from the label as `custom_<snake>`, its kind is one of
`text`, `longText`, `number`, `money` (integer cents, CAD), `date`, `yesNo`,
`choice`, `email`, `phone` or `url`, and its values live in
`leads.custom_values`. A deleted custom property leaves a tombstone so its key
is never reused. The **catalogue** is the set of properties one site resolves
to (code built-ins plus its rows), built by `buildPropertyCatalog` in
`packages/contracts/src/properties.ts`; `codePropertyCatalog` is the same with
no rows. Every list, board, filter, sort, column and record screen reads the
catalogue, never the code list directly. A **layout** orders the sections and
property keys of the lead record for one site and lead type
(`app.property_layouts`). A **saved view** is one staff member's private copy
of the leads inbox state (layout, type, stage, assignee, trash, due today,
filters, sort, property columns and hidden columns), never the free-text search or the page; `app.saved_views` is
visible only to its owner, at most 30 per person per site.

## Git

Feature branches (`claude/<topic>`), PR into `main`. CI must be green. Pushing
`main` is a release: Railway builds the backend image, Vercel builds the
admin. Migrations are applied deliberately (docs/RUNBOOKS/database.md), not by
the deploy.
