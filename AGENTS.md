# GT Sales CRM — guide for AI agents and new sessions

Read this first, then [docs/PLAN.md](docs/PLAN.md) (decisions, architecture,
phases) and [docs/ENV.md](docs/ENV.md) (every variable). Keep both current
when you change what they describe.

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
   `viewer`. Privileged actions need an MFA-verified (`aal2`) session.
   Contact details on the leads list are shown only to roles with
   `lead.manage`, `order.manage` or `financial.read`.
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
pnpm run test:e2e                                        # admin browser checks (build the admin first)
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
  merge and lead-type handling), routes in `src/routes/website.ts`.
- Staff routes (sites, access, leads list, members, jobs, credentials, files):
  `src/routes/staff.ts`.
- Documents: `src/documents/` (signed upload intent → finalize with
  signature verification → attach; staff review and download links).
- Scheduler: `src/scheduler.ts` (`outbox`, `document_cleanup`,
  `data_retention`), identities in `src/machines/registry.ts`.
- Admin pages: `apps/admin/src/app/w/[workspace]/{leads,documents,settings}`;
  API client `apps/admin/src/lib/api.ts`.

## Vocabulary

`workspace` in code = **Site** in the UI = one website. `lead_type` names the
form a lead came from (`sim_order`, `internet`, `mobility`,
`partner_application`, `contact_message`); its payload schema and working
statuses arrive with the lead-type registry in phase 1.

## Git

Feature branches (`claude/<topic>`), PR into `main`. CI must be green. Pushing
`main` is a release: Railway builds the backend image, Vercel builds the
admin. Migrations are applied deliberately (docs/RUNBOOKS/database.md), not by
the deploy.
