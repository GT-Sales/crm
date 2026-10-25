# GT Sales CRM — handoff

State as of 2026-10-25, written for whoever (person or AI session) picks this
up next. Everything here was read from the live systems or the code on that
day, not from memory. When something below stops being true, change it here.

Reading order for a new session: [AGENTS.md](../AGENTS.md) (rules, commands,
where things live) → this file → [PLAN.md](PLAN.md) (decisions, phases,
why) → [ENV.md](ENV.md) (every variable) → [RUNBOOKS/database.md](RUNBOOKS/database.md)
(migrations, trackers, passwords, adding a site).

## 1. Where everything is

| System       | Facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**   | `GT-Sales/crm`. `main` deploys both apps. Development branch for this work: `claude/phase-0-scaffold`, fast-forwarded into `main` (identical histories). CI (`.github/workflows/ci.yml`, job `verify`) runs on every push to `main` and on PRs: lint, format, typecheck, migrations on a disposable Postgres, the full test suite with integration suites forced on, OpenAPI drift check, affected builds, browser tests.                                               |
| **Backend**  | Railway project `GT Sales CRM` (`ea4ffa36-d587-45b8-a64d-9f8f84fbd42f`), service `crm` (`01c9dcfa-644d-4c52-ade1-b08d65114443`), environment `production` (`112461fd-4e06-44bc-a5ae-13f40438f69e`). Region **Singapore `asia-southeast1`** (one replica). Follows `main`; build per `railway.json` at the repo root. Public URL `https://crm-production-cf2e.up.railway.app`, `PORT` pinned to 4000. Lives in the developer's personal Railway workspace for now.       |
| **Admin**    | Vercel team `gt-sales` (`team_PDmnYZIjHmPgGmDSYFB0Ru3K`), project `gt-sales-crm-admin` (`prj_cjhH8QnFnO5RdOHHRZVhOrxsStnp`). Root `apps/admin`, framework Next.js, **Node 22.x** (the repo's `engines` field rejects Vercel's default of 24), production branch `main`, functions in `iad1` (`apps/admin/vercel.json`). Live at **`https://gt-sales-crm-admin.vercel.app`**. The `…-gt-sales.vercel.app` alias and per-deployment URLs sit behind Vercel's login wall.  |
| **Database** | Supabase project `xykrphbgpwisqacpyeiv`, region `ap-south-1` (Mumbai), shared with the Get Canada Sim website's `public` schema. The CRM owns the **`app` schema** (25 tables) and the **`app_runtime`** role (NOBYPASSRLS). Backend connects through the transaction pooler `aws-1-ap-south-1.pooler.supabase.com:6543` as `app_runtime.xykrphbgpwisqacpyeiv` (the `aws-0` host does not know this tenant). Storage bucket `documents` exists; S3 keys not yet issued. |
| **Auth**     | Supabase Auth on the same project: email + password, confirmation required, sign-ups allowed (the invitation flow needs them). Site URL and redirect URL are the admin domain above. No multi-factor step (owner decision, see §4).                                                                                                                                                                                                                                     |
| **Email**    | Resend account exists; no verified sending domain yet, so the backend's email provider and Supabase custom SMTP are unset. Supabase's built-in mailer sends the confirmation emails for now (low rate limit).                                                                                                                                                                                                                                                           |
| **Owner**    | Md Takibuddin, gamertakib@gmail.com — GitHub org owner, Railway workspace, Vercel team, Supabase org. First `owner` of both sites in the CRM (Auth user `b8fbfaea-a3a8-4cfd-b609-d9d422fa7b7e`).                                                                                                                                                                                                                                                                        |
| **Websites** | Get Canada Sim (`Md-Takibuddin/Get-Canada-Sim`, Next.js on Vercel, its own admin and tables in `public`) and CanadaWide (`canadawideinternet.com`, writes leads to legacy tables). Neither sends anything to this backend yet (phase 1 and 3).                                                                                                                                                                                                                          |

Secrets never live in this repository. The `app_runtime` password exists only
in Railway's `DATABASE_URL`; every other secret is listed by name in ENV.md and
set on Railway or Vercel. Several were generated during the build session and
should be rotated once the owner has a password manager for them (§6).

## 2. Architecture map

### 2.1 System

```
   Get Canada Sim (Next.js, Vercel)     CanadaWide (site)       …more sites
          │  POST /api/v1/website/*  (Authorization: Bearer gtsk_…, per-site key, scopes)
          ▼
 ┌──────────────────────────── backend: apps/backend (Express 5, Railway, Singapore) ────────────────────────────┐
 │ requestId → requestLog → CORS(ADMIN_ORIGIN) → JSON 64 kB                                                     │
 │  /api/v1/health            liveness, no auth                                                                 │
 │  /api/internal/jobs/*      machine identity (MACHINE_REGISTRY_JSON + CRON_SECRET), manual job runs           │
 │  /api/v1/staff/*           Supabase bearer → verified by Auth API → per-IP rate limit → per-action authorize │
 │  /api/v1/website/*         service credential (hash lookup) → scope → per-endpoint rate limit → bot check    │
 │  /api/v1/email/*           unsubscribe links, delivery view;  /api/v1/webhooks/resend signed events          │
 │  scheduler (in-process):   outbox every 60 s · document_cleanup hourly · data_retention daily               │
 │  every data access: withTenantTx → set_config(app.workspace_id, app.actor_id) → RLS decides                  │
 └───────────────┬───────────────────────────────────────────────┬───────────────────────────────┬──────────────┘
                 │ postgres (pooler, app_runtime)                │ Auth API (getUser)            │ S3 API (unset)
                 ▼                                               ▼                               ▼
      Supabase Postgres, schema `app`                     Supabase Auth                  Supabase Storage
      25 tables, FORCE RLS, SECURITY DEFINER functions   email+password sessions         bucket `documents`
                 ▲
                 │ NEXT_PUBLIC_SUPABASE_* (browser signs in directly with Supabase Auth, nothing else)
 ┌───────────────┴────────── admin: apps/admin (Next.js 16, Vercel iad1) ───────────────┐
 │ /login (+ invitation sign-up) · /recovery · /denied · /w/[site]/{leads,documents,     │
 │ settings,settings/jobs}; every API call = fetch(NEXT_PUBLIC_API_BASE_URL, bearer)     │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

Two facts shape everything: the admin never touches the database (an ESLint
boundary rule fails the build if `apps/admin` imports `@gt-sales/db`), and the
backend never trusts a caller's claim about who they are or which site they
belong to — identity comes from Supabase Auth or a credential hash, tenancy from
the database row that identity resolves to, enforced again by RLS.

### 2.2 Repository

pnpm 9 workspace, Node 22, strict TypeScript, ESLint 9, Prettier, Vitest,
Playwright. `pnpm-workspace.yaml` pins every tool version in its `catalog`.

| Path                     | What it holds                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src`       | `app.ts` (middleware + mounts), `server.ts`, `scheduler.ts`, `shutdown.ts`; `auth/` (Supabase session verifier), `staff/` (authorization, staff store), `website/` (credential auth, rate limits, bot check), `leads/`, `documents/`, `email/`, `jobs/` (outbox), `retention/`, `machines/`, `crypto/`, `http/`, `routes/`. |
| `apps/backend/tests`     | Vitest unit tests, `*.integration.test.ts` against a disposable Postgres, `isolation.spec.ts` (the tenant-isolation gate), `e2e/harness.ts` for browser tests.                                                                                                                                                              |
| `apps/admin/src`         | `app/` routes, `components/` (shell, sidebar, switcher, leads list, credentials manager, jobs status, invite form, session provider), `lib/` (`api.ts` typed client, `supabase-auth.ts`, `auth-navigation.ts`). `next.config.ts` builds the CSP from the public env.                                                        |
| `apps/admin/e2e`         | `shell.spec.ts` (public routes, desktop + mobile) and `orders.spec.ts` (full journey against the backend harness). README explains the compiled-out test session seam.                                                                                                                                                      |
| `packages/db`            | `src/schema.ts` (Drizzle schema incl. RLS policies), `drizzle/` (SQL migrations + journal), `src/index.ts` (pooled client, `withTenantTx`, `withActorTx`, `rateLimitHit`, `resolveWebsiteCredential`), `src/seed.ts` (sites, roles, permissions, owner invitation), `src/migrate.ts`. Backend-only import.                  |
| `packages/contracts`     | Zod schemas for every request/response, the endpoint registry (`src/endpoints.ts`), the one typed client, and `scripts/generate-openapi.ts` → `docs/api/openapi.json` (CI fails if stale).                                                                                                                                  |
| `packages/types`         | Role, permission, scope and status name tuples shared by db, backend, contracts and admin.                                                                                                                                                                                                                                  |
| `packages/ui`            | shadcn-style components (Tailwind 4) for the admin.                                                                                                                                                                                                                                                                         |
| `packages/adapters`      | Error tracking (Sentry-shaped, inert when unset) and other thin provider adapters.                                                                                                                                                                                                                                          |
| `packages/config`        | Shared ESLint/TS/Prettier config.                                                                                                                                                                                                                                                                                           |
| `packages/observability` | Logger and request-log shape.                                                                                                                                                                                                                                                                                               |
| `jobs`                   | Standalone job runner entry (same code as the scheduler tasks) for one-off runs.                                                                                                                                                                                                                                            |
| `scripts`                | `affected-builds.mjs` (Vercel ignore step and `build:affected`), tooling tests.                                                                                                                                                                                                                                             |
| `docs`                   | This file, PLAN.md, ENV.md, RUNBOOKS/, `api/openapi.json`, `RUNBOOKS/manual/0001-remaining.sql` (the statements the Supabase tool refuses to run).                                                                                                                                                                          |

### 2.3 Backend surfaces

Staff routes (`/api/v1/staff`, Supabase bearer token; `action` is what
`decideAccess` checks against the actor's roles and permission overrides):

| Method          | Path                                             | Action             | Notes                                                                            |
| --------------- | ------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------- |
| GET             | `/workspaces`                                    | —                  | Accepts pending invitations for the verified email, then lists active sites.     |
| GET             | `/workspaces/:id/access`                         | workspace.read     | Roles and permission names for the site switcher.                                |
| GET             | `/workspaces/:id/leads`                          | workspace.read     | Paged; contact fields hidden unless lead.manage, order.manage or financial.read. |
| GET             | `/workspaces/:id/members`                        | workspace.read     | Assignee options: membership ids and roles only.                                 |
| GET             | `/workspaces/:id/jobs`                           | workspace.read     | Outbox jobs and alerts.                                                          |
| POST            | `/workspaces/:id/jobs/:jobId/retry` · `/resolve` | integration.manage | Retry a failed job; resolve an uncertain delivery.                               |
| POST            | `/workspaces/:id/invitations`                    | staff.invite       | Invite by email with roles; `memberships.status = pending`.                      |
| DELETE          | `/workspaces/:id/memberships/:membershipId`      | staff.remove       | Revoke; takes effect on the member's next request.                               |
| GET/POST/DELETE | `/workspaces/:id/service-credentials[/:credId]`  | integration.manage | Site keys `gtsk_…`, shown once, stored hashed, scoped.                           |
| POST            | `/workspaces/:id/files/:fileId/review`           | order.manage       | Approve/reject an uploaded document.                                             |
| POST            | `/workspaces/:id/files/:fileId/download-link`    | document.download  | Short-lived signed URL.                                                          |

Website routes (`/api/v1/website`, `Authorization: Bearer gtsk_…`):

| Method | Path                           | Scope            | Notes                                                                                                                                                                       |
| ------ | ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/leads`                       | leads:write      | Creates a lead; `leadType` required (`^[a-z0-9_]{1,64}$`), optional `externalRef` unique per site+type. Contact merged by normalized email. Returns a draft grant `gtdg_…`. |
| GET    | `/leads/:leadId`               | leads:write      | Resume a draft with its grant.                                                                                                                                              |
| PATCH  | `/leads/:leadId`               | leads:write      | Complete or update the draft.                                                                                                                                               |
| POST   | `/uploads/intents`             | uploads:customer | Signed upload intent for a customer document.                                                                                                                               |
| POST   | `/uploads/:uploadId/finalize`  | uploads:customer | Verifies the real bytes' signature, links the file to the lead.                                                                                                             |
| POST   | `/files/:fileId/download-link` | uploads:customer | Customer-side download of their own document.                                                                                                                               |

Other: `GET /api/v1/health`; `/api/internal/jobs/run` (GET/POST, machine
secret) for manual scheduler runs; `/api/v1/email/unsubscribe`,
`/api/v1/email/staff/workspaces/:id/delivery`; `/api/v1/webhooks/resend`
(raw body, signature-verified, `POST /:selector`).

Scheduler (`ENABLE_SCHEDULER=true`, one replica): `outbox` 60 s,
`document_cleanup` 1 h, `data_retention` 24 h (calls
`app.prune_operational_rows`). Overlap-guarded; failures are logged as
`scheduler_task_failed` and nothing else, so a quiet log is a healthy log.

### 2.4 Data model and tenancy

Schema `app`, all tables carry `workspace_id` except `contacts` and
`rate_limit_buckets`. A workspace **is a site**.

| Group        | Tables                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sites, staff | `workspaces`, `memberships` (user_id or invited_email; pending/active/revoked), `roles`, `membership_roles`, `permissions`, `membership_permissions`, `service_credentials`                                                                             |
| CRM          | `contacts` (global, unique by `lower(btrim(email))`), `leads` (lead_type, status, payload, attribution, contact_id, assigned_actor_id, external_ref, restriction and soft-delete stamps), `lead_activities` (append-only), `lead_tasks`, `draft_grants` |
| Documents    | `files`, `file_revisions`, `file_review_events`                                                                                                                                                                                                         |
| Email        | `email_messages`, `email_provider_events`, `email_suppressions`, `marketing_consents`, `follow_up_schedules`, `deleted_email_messages`                                                                                                                  |
| Operations   | `outbox_jobs`, `outbox_job_alerts`, `audit_events` (redaction-only updates), `rate_limit_buckets`                                                                                                                                                       |

Tenancy: `withTenantTx` opens a transaction and sets `app.workspace_id` and
`app.actor_id` with `set_config(…, true)`; every policy (`tenantPolicy`) requires
both and matches the row's `workspace_id`. `contacts` use `actorPolicy` (actor
present). FORCE RLS on all 24 tenant tables, so even the table owner cannot
bypass it, and `app_runtime` is NOBYPASSRLS. Work that must cross the tenant
boundary goes through SECURITY DEFINER functions: `list_staff_workspaces`,
`accept_staff_invitations`, `resolve_website_credential`, `rate_limit_hit`,
`prune_operational_rows`. Triggers: `audit_events_redaction_only`,
`leads/files/jobs_customer_restriction` (a restricted lead's data cannot be
touched by ordinary writes).

Migrations: `packages/db/drizzle/0000_app_foundation.sql` (generated) and
`0001_runtime_functions.sql` (hand-written). Both are recorded in two trackers,
`drizzle.__drizzle_migrations` (hash = sha256 of the file, created_at = journal
`when`) and `supabase_migrations.schema_migrations`. Verify by querying the
objects, never the trackers (the Get Canada Sim project learned that the hard
way). The Supabase MCP tool asks for a confirmation that never reaches the
owner for any SQL containing `REVOKE`, `ALTER` or `DELETE`; those statements
go into `docs/RUNBOOKS/manual/` for the owner to paste into the SQL editor.

Seeded: sites `getcanadasim` (`10000000-0000-4000-8000-000000000101`) and
`canadawide` (`…102`, domain `canadawideinternet.com`), each with the seven
roles and six permissions, and the owner's membership (active since 13:44 UTC).
Zero leads, zero service credentials.

### 2.5 Identity, roles, permissions

Roles: `owner` (everything), `leads` (workspace.read, lead.manage), `orders`
(order.manage), `partners`, `content`, `viewer` (read only), `finance`
(financial.read, invoice.approve). Actions: `workspace.read`, `lead.manage`,
`order.manage`, `staff.invite`, `staff.remove`, `staff.roles.manage`,
`document.download`, `financial.read`, `export.bulk`, `record.delete`,
`invoice.approve`, `integration.manage`. Per-member overrides
(`membership_permissions`, allow or deny) map to the last six; a deny always
wins. Decision logic: `apps/backend/src/staff/authorization.ts`
(`decideAccess` is pure; `createAuthorize` loads then decides). Authorization is
re-read from the database on every request, so a revoked member is out on their
next call. **There is no multi-factor step**: owner decision 2026-10-25.

Staff sign-in: the admin signs the user in with Supabase Auth in the browser
(`signInWithPassword`; "I have a staff invitation" uses `signUp` with the
invited email and a confirmation email). The first `GET /staff/workspaces`
calls `accept_staff_invitations(verified_email)`, which turns pending
memberships for that email into active ones bound to the Auth user id. Backend
verification is `auth.getUser(token)` per request (`auth/session.ts`), never
the token's own claims; the email must be confirmed.

### 2.6 How a website integrates (the contract for phase 1 and 3)

1. An owner creates a site key in the admin (`/w/<site>/settings`), scopes
   `leads:write` and/or `uploads:customer`. The secret is shown once.
2. The website stores it server-side only and calls
   `POST https://crm-production-cf2e.up.railway.app/api/v1/website/leads` with
   `Authorization: Bearer <key>`, `leadType`, contact fields, `payload`,
   `attribution`, `consentVersion`, optional `externalRef` (e.g. the website's
   order number, unique per site and type).
3. Multi-step forms keep the returned draft grant and `PATCH` the lead.
4. Documents: `uploads/intents` → browser uploads to the signed target →
   `uploads/:id/finalize` re-reads the bytes and checks the file signature.
5. Rate limits are per credential and per IP; a bot check (Turnstile) runs when
   configured and is skipped with a startup warning (`bot_check_unconfigured`)
   when not.

Full schemas: `packages/contracts/src/leads.ts`, `workspace-leads.ts`,
`website-auth.ts`; rendered in `docs/api/openapi.json`.

## 3. What was done (2026-10-25)

1. **Scaffold.** Copied the Canadian Plans platform (code only), pruned to the
   surfaces above, renamed the scope to `@gt-sales/*`, fresh `0000`/`0001`
   migrations, CRM tables (`contacts`, `lead_activities`, `lead_tasks`,
   lead_type/external_ref on leads), new `leads` role and `lead.manage` action,
   token prefixes `gtsk_`/`gtdg_`. Tests rewritten and made re-runnable on a
   persistent local database (491 tests, 67 files, 18 browser checks).
2. **Database.** `app` schema and `app_runtime` role applied to the production
   Supabase project; `0001` applied in two parts (tool + owner paste); verified
   against the schema: 10 functions, 24 FORCE-RLS tables, 4 triggers, 72
   grants, both trackers.
3. **Backend deploy.** Railway project created by the owner; Dockerfile build
   fixed (`tsup` bundles the workspace packages because they export TS source);
   pooler host corrected to `aws-1`; `PORT` pinned to 4000; region US East, then
   **Singapore** (see 6).
4. **Admin deploy.** Vercel project created by the owner (the connected token
   can update but not create projects on the team); root, Node 22 and the three
   public variables set from here; first production deploy triggered from the
   branch, then `main` took over.
5. **Merge.** `main` fast-forwarded to the phase 0 branch; CI green on every
   push since; Railway switched to follow `main`.
6. **Owner sign-in.** Supabase Auth configured by the owner (email, Site URL,
   redirects). Owner signed up through the invitation flow, both memberships
   went active, the leads inbox loaded for both sites.
7. **MFA removed** (owner decision): enrol/challenge pages deleted, assurance
   level dropped from the session verifier and the authorizer, `mfa_required`
   gone from the contracts and OpenAPI, Finance now sees lead contacts. A
   sign-in bug fixed on the way: the post-login redirect targeted `/orders`,
   which has no route; it is `/leads` now.
8. **Latency.** The empty leads inbox took 7.2 s from Virginia: ~30 sequential
   round trips to Mumbai. Fixed by (a) deciding contact visibility from the
   membership the request already loaded instead of three more loads, (b)
   reading membership + roles + overrides in one statement, (c) the leads
   page total as a window function; and by moving the service to Singapore.
   First request after the move: 1.8 s (cold connections included).

## 4. What is verified, and how

| Claim                                       | Evidence                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Backend serves and the scheduler runs clean | `GET /api/v1/health` 200; deployment logs show no `scheduler_task_failed` since the pooler fix                |
| Admin is reachable and wired                | `/login` 200 on `gt-sales-crm-admin.vercel.app`; the JS bundle contains the backend URL, Supabase URL and key |
| CORS                                        | `OPTIONS /api/v1/staff/me` from the admin origin → 204 with `access-control-allow-origin` set                 |
| Owner access                                | `app.memberships`: two `active` rows for the owner's user id; log shows `/staff/workspaces` 200 and leads 200 |
| Code gates                                  | typecheck, lint, Prettier, 491/491 tests with integration suites, both builds, 14 browser checks, CI run 4    |

## 5. What comes next, in order

### 5.1 Owner, before anything else

1. Create one site key per website in `/w/<site>/settings` (closes phase 0).
2. Supabase → Storage → S3 access keys for the `documents` bucket; put them in
   Railway as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, then set
   `R2_ENDPOINT=https://xykrphbgpwisqacpyeiv.storage.supabase.co/storage/v1/s3`,
   `R2_REGION=ap-south-1`, `R2_BUCKET=documents`, `R2_ACCOUNT_ID` (ENV.md). Until
   then document uploads fail.
3. Resend: verify a sending domain, then set `EMAIL_PROVIDER=resend`, the
   `RESEND_*` variables and a webhook (`MACHINE_REGISTRY_JSON.webhooks`), and
   point Supabase Auth's custom SMTP at Resend so confirmation emails are not
   rate-limited.
4. Names and roles of the other admins; invite them from the admin.
5. Move the Railway project into a GT Sales workspace; rotate the secrets
   generated during the build (`app_runtime` password, `CRON_SECRET`,
   `EMAIL_CONTACT_HASH_SECRET`, registry secrets) once stored properly.
6. Optional: switch Supabase Auth's TOTP toggle off; nothing uses it.

### 5.2 Engineering: phase 1 (data + intake), per PLAN.md §6

- **Lead-type registry** (`packages/contracts`): one schema per type
  (`sim_order`, `internet_lead`, `mobility_lead`, `partner_application`,
  `contact_message`…) with its payload shape and allowed statuses; the backend
  validates `payload` by type on intake and the admin renders type-specific
  columns. Today `leadType` is a free-form slug and `payload` is opaque JSON.
- **Intake per type** on `POST /website/leads`; keep the contact-merge rule
  (email only, normalized) and the `externalRef` uniqueness.
- **Documents on Supabase Storage** through the existing S3 adapter (verify the
  endpoint quirks first thing; a thin Storage-API adapter is the fallback).
- **SIN sealing** with `crypto/cipher.ts` (AES-256-GCM, label
  `gt-sales-crm:sealed-value:v1`) before any identity field is stored.
- **CanadaWide**: move its three lead routes to the backend one at a time, old
  route kept deployable until the new one is verified. Drop the anon policies
  on its legacy tables afterwards.
- **Data migration**: import existing website leads/orders into `leads` with
  the right `lead_type` and `external_ref`, contacts merged by email.

Then phase 2 (CRM screens: inbox across sites, kanban per type, lead page with
timeline/notes/tasks/documents/assignment, contact page, my tasks,
split/merge), phase 3 (port Get Canada Sim's orders, partners, finance, blog,
staff management and portal; its forms call the intake API; read
`docs/CRM_PLATFORM_PLAN.md` in that repository first), phase 4 (remove admin,
portal and database code from the website repositories; drop legacy tables).

### 5.3 Technical follow-ups found during the build

- **Latency, second round.** Measure warm staff requests from the deploy logs
  (`durationMs`). Remaining cost per request: one Auth API call, one rate-limit
  statement, two transactions (membership, then the data). Options, in order of
  safety: pipeline the independent statements inside a transaction; a 10–30 s
  per-token cache of `getUser` results (changes revocation latency slightly,
  decide with the owner); a read-through cache of the membership snapshot
  keyed by actor+site invalidated by the staff mutation routes.
- **Bot check unset.** `bot_check_unconfigured` is logged at startup; set the
  Turnstile keys (ENV.md) before the first website goes live on the intake API.
- **Error tracking unset.** `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` empty; the
  adapters are inert until set.
- **Vercel deployment protection** gates everything except the production
  domain; fine for staff, but preview deployments need a Vercel login.
- **`.next/types` after deleting a route**: `apps/admin` typecheck reads stale
  generated types; delete `apps/admin/.next` and run again.
- **Local Postgres in the cloud dev container** is a Postgres 16 cluster that
  stops on worker restarts: `pg_ctlcluster 16 main start`; the `postgres`
  password there is `postgres` (local only). Integration suites need the CI
  values from `.github/workflows/ci.yml` (`TEST_MIGRATION_DATABASE_URL`,
  `DB_TEST_ALLOW_DESTRUCTIVE=1`, `DATABASE_URL` as `app_runtime`, …).
- **Plan drift.** PLAN.md §5.7 and §10 are current; §4's copy table still names
  the `aal2` check in one row as historical context.

## 6. How to work in this repository

- **Branches and deploys.** `main` is production for both apps; push there only
  with the owner's say-so (given for this phase). Work on `claude/<topic>`
  branches; CI runs on PRs and on `main`. Railway and Vercel both skip builds
  when only docs change (`watchPatterns`, `affected-builds.mjs`).
- **Gate before every commit**: `pnpm run typecheck && pnpm run lint && pnpm run format && pnpm test && pnpm run build`,
  with the integration variables set so the database suites run (they are what
  catch SQL mistakes the type system cannot; one such mistake was caught this
  session). Browser checks: `pnpm --filter admin exec playwright test e2e/shell.spec.ts`
  after an admin build.
- **Contracts change → regenerate** `docs/api/openapi.json` with
  `pnpm --filter @gt-sales/contracts build`; CI diffs it.
- **Schema change**: edit `packages/db/src/schema.ts`, generate a migration
  (`drizzle-kit generate`, `--custom` for hand-written SQL), apply it to the
  hosted project deliberately (never from a deploy), record it in both
  trackers, verify the objects, and add a seed/test touching it. Statements the
  Supabase tool refuses go to `docs/RUNBOOKS/manual/` for the owner.
- **Docs to keep current**: this file, PLAN.md §10 (owner checklist), ENV.md on
  any variable, RUNBOOKS/database.md on any database procedure.
- **No secrets, ever**, in code, docs, commits or chat transcripts; the Get
  Canada Sim repository once leaked a service-role key this way and had to
  rotate it.
- Commit messages explain the why; one change per commit; the attribution
  trailer the session requires.
