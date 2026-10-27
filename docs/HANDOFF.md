# GT Sales CRM — handoff

State as of 2026-10-27, written for whoever (person or AI session) picks this
up next. Everything here was read from the live systems or the code on that
day, not from memory. When something below stops being true, change it here.

Reading order for a new session: [AGENTS.md](../AGENTS.md) (rules, commands,
where things live) → this file → [PLAN.md](PLAN.md) (decisions, phases,
why) → [ENV.md](ENV.md) (every variable) → [RUNBOOKS/database.md](RUNBOOKS/database.md)
(migrations, trackers, passwords, adding a site) → [RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md)
(the CanadaWide history import).

## 1. Where everything is

| System       | Facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**   | `GT-Sales/crm`. `main` deploys both apps. Development branch for this work: `claude/phase-0-scaffold`, fast-forwarded into `main` (identical histories). CI (`.github/workflows/ci.yml`, job `verify`) runs on every push to `main` and on PRs: lint, format, typecheck, migrations on a disposable Postgres, the full test suite with integration suites forced on, OpenAPI drift check, affected builds, the shell browser checks and the lead journeys against the real backend.                                                                                                                                                                                                                             |
| **Backend**  | Railway project `GT Sales CRM` (`ea4ffa36-d587-45b8-a64d-9f8f84fbd42f`), service `crm` (`01c9dcfa-644d-4c52-ade1-b08d65114443`), environment `production` (`112461fd-4e06-44bc-a5ae-13f40438f69e`). Region **Singapore `asia-southeast1`** (one replica). Follows `main`; build per `railway.json` at the repo root. Public URL `https://crm-production-cf2e.up.railway.app`, `PORT` pinned to 4000. Lives in the developer's personal Railway workspace for now.                                                                                                                                                                                                                                               |
| **Admin**    | Vercel team `gt-sales` (`team_PDmnYZIjHmPgGmDSYFB0Ru3K`), project `gt-sales-crm-admin` (`prj_cjhH8QnFnO5RdOHHRZVhOrxsStnp`). Root `apps/admin`, framework Next.js, **Node 22.x** (the repo's `engines` field rejects Vercel's default of 24), production branch `main`, functions in `iad1` (`apps/admin/vercel.json`). Live at **`https://gt-sales-crm-admin.vercel.app`**. The `…-gt-sales.vercel.app` alias and per-deployment URLs sit behind Vercel's login wall.                                                                                                                                                                                                                                          |
| **Database** | Supabase project `xykrphbgpwisqacpyeiv`, region `ap-south-1` (Mumbai), shared with the Get Canada Sim website's `public` schema. The CRM owns the **`app` schema** (25 tables) and the **`app_runtime`** role (NOBYPASSRLS). Backend connects through the transaction pooler `aws-1-ap-south-1.pooler.supabase.com:6543` as `app_runtime.xykrphbgpwisqacpyeiv` (the `aws-0` host does not know this tenant). Storage bucket `documents` exists; S3 keys not yet issued.                                                                                                                                                                                                                                         |
| **Auth**     | Supabase Auth on the same project: email + password, confirmation required, sign-ups allowed (the invitation flow needs them). Site URL and redirect URL are the admin domain above. No multi-factor step (owner decision, see §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Email**    | The Resend account this session can reach has no domains; CanadaWide and Get Canada Sim send their own mail with their own Resend keys. The backend's email provider and Supabase custom SMTP are unset. Supabase's built-in mailer **delivers only to members of the Supabase organization's team**, at about two messages an hour: the owner's own sign-up worked because the owner is on the team, but any other admin's confirmation email is refused until custom SMTP is set (§5.1).                                                                                                                                                                                                                      |
| **Owner**    | Md Takibuddin, gamertakib@gmail.com — GitHub org owner, Railway workspace, Vercel team, Supabase org. First `owner` of both sites in the CRM (Auth user `b8fbfaea-a3a8-4cfd-b609-d9d422fa7b7e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Websites** | Get Canada Sim (`Md-Takibuddin/Get-Canada-Sim`, Next.js on Vercel, its own admin and tables in `public`; sends nothing here until phase 3). CanadaWide (`Md-Takibuddin/Canadawide-Sales-website`, Next.js on Vercel in the owner's personal team, which this session's Vercel token cannot see): its internet and mobility forms send to the CRM once `CRM_API_URL` and `CRM_SITE_KEY` are set in its Vercel project (code on `main` since 2026-10-26, inert until then); its ID-upload step still writes Supabase directly. All 708 of its historical leads are in the CRM (imported 2026-10-27, re-run before the staff cutover); staff still use the Get Canada Sim admin until the owner moves them (§5.1). |

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
 │ /login (+ invitation sign-up) · /recovery · /denied · /w/[site]/{leads, leads/[id],    │
 │ tasks, documents, settings, settings/jobs}; every API call = fetch(API base, bearer)   │
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

| Path                     | What it holds                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src`       | `app.ts` (middleware + mounts), `server.ts`, `scheduler.ts`, `shutdown.ts`; `auth/` (Supabase session verifier), `staff/` (authorization, staff store), `website/` (credential auth, rate limits, bot check), `leads/`, `documents/`, `email/`, `jobs/` (outbox), `retention/`, `machines/`, `crypto/`, `http/`, `routes/`.                                               |
| `apps/backend/tests`     | Vitest unit tests, `*.integration.test.ts` against a disposable Postgres, `isolation.spec.ts` (the tenant-isolation gate), `e2e/harness.ts` (the real backend for the lead journeys, one stub session verifier), `support/` (replica legacy tables).                                                                                                                      |
| `apps/admin/src`         | `app/` routes, `components/` (shell, sidebar, switcher, `leads/` — inbox, table, board, lead page, timeline, tasks, my tasks — credentials manager, jobs status, invite form, display name, session provider), `lib/` (`api.ts`, `use-resource.ts`, `dates.ts`, `people.ts`, `supabase-auth.ts`). `next.config.ts` builds the CSP from the public env.                    |
| `apps/admin/e2e`         | `shell.spec.ts` (public routes, desktop + mobile) and `leads.spec.ts` (four lead journeys against the backend harness, `playwright.leads.config.ts`). README explains the compiled-out test session seam.                                                                                                                                                                 |
| `packages/db`            | `src/schema.ts` (Drizzle schema incl. RLS policies), `drizzle/` (SQL migrations + journal), `src/index.ts` (pooled client, `withTenantTx`, `withActorTx`, `rateLimitHit`, `resolveWebsiteCredential`), `src/seed.ts` (sites, roles, permissions, owner invitation), `src/migrate.ts`, `sql/` (data scripts run by hand, e.g. the CanadaWide import). Backend-only import. |
| `packages/contracts`     | Zod schemas for every request/response, the endpoint registry (`src/endpoints.ts`), the one typed client, and `scripts/generate-openapi.ts` → `docs/api/openapi.json` (CI fails if stale).                                                                                                                                                                                |
| `packages/types`         | Role, permission, scope and status name tuples shared by db, backend, contracts and admin.                                                                                                                                                                                                                                                                                |
| `packages/ui`            | shadcn-style components (Tailwind 4) for the admin.                                                                                                                                                                                                                                                                                                                       |
| `packages/adapters`      | Error tracking (Sentry-shaped, inert when unset) and other thin provider adapters.                                                                                                                                                                                                                                                                                        |
| `packages/config`        | Shared ESLint/TS/Prettier config.                                                                                                                                                                                                                                                                                                                                         |
| `packages/observability` | Logger and request-log shape.                                                                                                                                                                                                                                                                                                                                             |
| `jobs`                   | Standalone job runner entry (same code as the scheduler tasks) for one-off runs.                                                                                                                                                                                                                                                                                          |
| `scripts`                | `affected-builds.mjs` (Vercel ignore step and `build:affected`), tooling tests.                                                                                                                                                                                                                                                                                           |
| `docs`                   | This file, PLAN.md, ENV.md, RUNBOOKS/ (database, legacy import), `api/openapi.json`, `RUNBOOKS/manual/0001-remaining.sql` (the statements the Supabase tool refuses to run).                                                                                                                                                                                              |

### 2.3 Backend surfaces

Staff routes (`/api/v1/staff`, Supabase bearer token; `action` is what
`decideAccess` checks against the actor's roles and permission overrides):

| Method          | Path                                                        | Action                       | Notes                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET             | `/workspaces`                                               | —                            | Accepts pending invitations for the verified email, then lists active sites.                                                                                            |
| GET             | `/workspaces/:id/access`                                    | workspace.read               | Roles and permission names for the site switcher.                                                                                                                       |
| PATCH           | `/profile`                                                  | —                            | The caller's own display name, on every site they belong to.                                                                                                            |
| GET             | `/workspaces/:id/leads`                                     | workspace.read               | Paged; filters type, stage, assignee (`me`/`none`/id), `q`, `view=trash`. Contact fields hidden unless lead.manage, order.manage or financial.read; `q` needs that too. |
| GET             | `/workspaces/:id/leads/summary` · `/leads/board`            | workspace.read               | Active leads per type and the trash; one type's leads by stage (a column per catalogue stage, counts, newest 50 each).                                                  |
| GET             | `/workspaces/:id/leads/:leadId`                             | workspace.read               | Lead with form, timeline and tasks; readers without contact access get stage and source only.                                                                           |
| PATCH           | `/workspaces/:id/leads/:leadId`                             | lead.manage                  | Stage (checked against the type), assignee (active member), contact corrections; writes timeline + audit.                                                               |
| POST            | `/workspaces/:id/leads/:leadId/{notes,tasks,trash,restore}` | lead.manage                  | Note, follow-up task, soft delete and back. A trashed lead refuses changes (`lead_trashed`).                                                                            |
| PATCH · GET     | `/workspaces/:id/tasks/:taskId` · `/tasks`                  | lead.manage · workspace.read | Complete, reopen, cancel, edit; "my tasks" (needs contact access).                                                                                                      |
| GET             | `/workspaces/:id/members`                                   | workspace.read               | Assignee options: membership and actor ids, roles and display names, never emails.                                                                                      |
| GET             | `/workspaces/:id/jobs`                                      | workspace.read               | Outbox jobs and alerts.                                                                                                                                                 |
| POST            | `/workspaces/:id/jobs/:jobId/retry` · `/resolve`            | integration.manage           | Retry a failed job; resolve an uncertain delivery.                                                                                                                      |
| POST            | `/workspaces/:id/invitations`                               | staff.invite                 | Invite by email with roles; `memberships.status = pending`.                                                                                                             |
| DELETE          | `/workspaces/:id/memberships/:membershipId`                 | staff.remove                 | Revoke; takes effect on the member's next request.                                                                                                                      |
| GET/POST/DELETE | `/workspaces/:id/service-credentials[/:credId]`             | integration.manage           | Site keys `gtsk_…`, shown once, stored hashed, scoped.                                                                                                                  |
| POST            | `/workspaces/:id/files/:fileId/review`                      | order.manage                 | Approve/reject an uploaded document.                                                                                                                                    |
| POST            | `/workspaces/:id/files/:fileId/download-link`               | document.download            | Short-lived signed URL.                                                                                                                                                 |

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

| Group        | Tables                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sites, staff | `workspaces`, `memberships` (user_id or invited_email; pending/active/revoked; `display_name`), `roles`, `membership_roles`, `permissions`, `membership_permissions`, `service_credentials`                                                                                                                                                                             |
| CRM          | `contacts` (global, unique by `lower(btrim(email))`), `leads` (lead_type, status = the form's lifecycle, **stage** = where staff work it, payload, attribution, contact_id, assigned_actor_id, external_ref, restriction and soft-delete stamps), `lead_activities` (append-only timeline: note, status_change, assignment, edit, system), `lead_tasks`, `draft_grants` |
| Documents    | `files`, `file_revisions`, `file_review_events`                                                                                                                                                                                                                                                                                                                         |
| Email        | `email_messages`, `email_provider_events`, `email_suppressions`, `marketing_consents`, `follow_up_schedules`, `deleted_email_messages`                                                                                                                                                                                                                                  |
| Operations   | `outbox_jobs`, `outbox_job_alerts`, `audit_events` (redaction-only updates), `rate_limit_buckets`                                                                                                                                                                                                                                                                       |

Tenancy: `withTenantTx` opens a transaction and sets `app.workspace_id` and
`app.actor_id` with `set_config(…, true)`; every policy (`tenantPolicy`) requires
both and matches the row's `workspace_id`. `contacts` use `actorPolicy` (actor
present). FORCE RLS on all 24 tenant tables, so even the table owner cannot
bypass it, and `app_runtime` is NOBYPASSRLS. Work that must cross the tenant
boundary goes through SECURITY DEFINER functions: `list_staff_workspaces`,
`accept_staff_invitations`, `resolve_website_credential`, `rate_limit_hit`,
`prune_operational_rows`. Triggers: `audit_events_redaction_only`,
`leads/files/jobs_customer_restriction` (a restricted lead's data cannot be
touched by ordinary writes), and the transitional
`leads_mirror_canadawide_legacy` (below).

**CanadaWide legacy mirror (migration 0002, temporary).** An AFTER INSERT
trigger on `app.leads` copies every new `internet` / `mobility` lead of the
`canadawide` site into `public.internet_leads` / `public.mobility_leads` under
the same id, in the same transaction, through the SECURITY DEFINER function
`app.mirror_canadawide_legacy_lead()`. It exists so the old Get Canada Sim admin
pages keep working, and so the mobility ID-upload step, which still writes
`public.mobility_id_uploads` keyed by that id, keeps linking, while staff have
no CRM screens yet. It is insert-only and idempotent (`on conflict (id) do
nothing`), so importing historical legacy rows into `app.leads` under their own
ids passes through, and it is a no-op where the legacy tables do not exist
(CI). Drop it, in a new migration, when phase 2 retires the old Internet and
Mobility Leads pages.

**Historical import (2026-10-27).** Every legacy row is also in `app.leads`
under its own id, with its note and reminder (RUNBOOKS/legacy-import.md). The
mirror and the import meet without loops: an imported lead's mirror insert
finds its legacy row and does nothing. Until the cutover, staff may still
change a lead in the old admin; re-running the import carries that over except
onto leads already worked in the CRM.

Migrations: `packages/db/drizzle/0000_app_foundation.sql` (generated),
`0001_runtime_functions.sql` (hand-written), `0002_canadawide_legacy_mirror.sql`
(hand-written, `drizzle-kit generate --custom`) and
`0003_lead_stages_and_staff_names.sql` (generated: `stage`, `display_name`,
board and task indexes, five foreign-key indexes). All are recorded in two trackers,
`drizzle.__drizzle_migrations` (hash = sha256 of the file, created_at = journal
`when`) and `supabase_migrations.schema_migrations`. Verify by querying the
objects, never the trackers (the Get Canada Sim project learned that the hard
way). The Supabase MCP tool asks for a confirmation that never reaches the
owner for any SQL containing `REVOKE`, `ALTER` or `DELETE`; those statements
go into `docs/RUNBOOKS/manual/` for the owner to paste into the SQL editor.

Seeded: sites `getcanadasim` (`10000000-0000-4000-8000-000000000101`) and
`canadawide` (`…102`, domain `canadawideinternet.com`), each with the seven
roles and six permissions, and the owner's membership (active since
2026-10-25 13:44 UTC). As of 2026-10-27: `canadawide` holds the 708 imported
leads (129 of them in the trash, including the two smoke tests); `getcanadasim`
has none; no live site keys (one revoked smoke-test key).

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
   `Authorization: Bearer <key>`, `leadType`, `contact`, `form`
   (`{ schemaVersion, payload }`), `consentVersion`, optional `attribution`,
   `externalRef` (the website's own id, unique per site and type) and `submit`.
3. **The lead-type registry decides what a lead must carry**
   (`apps/backend/src/leads/types.ts`; payload schemas in
   `packages/contracts/src/lead-types.ts`). An unlisted type is a 400.
   `internet` and `mobility` (CanadaWide) are modelled: strict payloads, name,
   email and phone required, and **one-shot**: they must be sent with
   `submit: true`, are stored `submitted`, and get no draft grant.
   `sim_order`, `partner_application`, `contact_message` are listed but not yet
   modelled (any payload, resumable drafts). A refusal is
   `validation_error` with `details.field` naming the refused part, never a
   value. Contact rules are deliberately no stricter than the sites' own.
4. Multi-step forms keep the returned draft grant and `PATCH` the lead.
5. Documents: `uploads/intents` → browser uploads to the signed target →
   `uploads/:id/finalize` re-reads the bytes and checks the file signature.
6. Rate limits are per credential, per visitor and per endpoint. A website
   server can send `x-website-visitor-id` (64 hex; CanadaWide sends an HMAC of
   the customer's IP keyed with its site key) so the visitor limit applies per
   customer, not per hosting egress address.
7. **Human proof** is `WEBSITE_BOT_CHECK` (ENV.md). `turnstile`, the default,
   verifies a forwarded Turnstile token and refuses every write when Turnstile
   is not configured. `delegated` trusts the calling website's own screening
   (CanadaWide's honeypot, origin check, per-IP and per-email limits); the
   site key and the limits above still apply. Production runs `delegated`.

Full schemas: `packages/contracts/src/leads.ts`, `lead-types.ts`,
`workspace-leads.ts`, `website-auth.ts`; rendered in `docs/api/openapi.json`.
Reference client: `lib/crm.ts` in the CanadaWide repository.

## 3. What was done

### 3.1 2026-10-25: phase 0

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

### 3.2 2026-10-26: CanadaWide intake

The live database showed CanadaWide writing every lead with the project's
publishable key, through four anon policies with `with check (true)`:
`internet_leads` (663 rows, ~20 a day), `mobility_leads` (38),
`mobility_id_uploads` (14, SINs in plain text) and `storage.objects` for the
private `mobility-ids` bucket. That key also ships in this admin's and Get
Canada Sim's browser code, so anyone could insert rows or upload files past
CanadaWide's validation. Nothing was readable; volumes looked organic.

1. **Intake:** the lead-type registry, `submit: true` for one-shot types,
   contact rules relaxed to the sites' own (phone ≤ 40, any `a@b.c` address),
   and `WEBSITE_BOT_CHECK=delegated`. Before this, no website could write at
   all: the Turnstile check refused everything without Turnstile keys. Intake
   no longer queues `analytics_lead_saved` (no provider; the plan dropped the
   server-side analytics sink).
2. **Migration 0002**, the legacy mirror above, with an integration test
   against replica legacy tables.
3. **CanadaWide** (`lib/crm.ts`): `/api/leads` and `/api/mobility-leads` send to
   the CRM when `CRM_API_URL` and `CRM_SITE_KEY` are set, and write Supabase
   as before otherwise. Emails, the Meta event and the ID step are unchanged.
4. **Verified end to end locally:** both forms through CanadaWide's built
   server into a local backend and Postgres with replica legacy tables; rows
   and ids matched on both sides; a stopped backend gave the customer the same
   "please call us" answer as a failed insert.
5. **Deployed and smoke-tested in production** (CRM `f05e9e4`, CanadaWide
   `f8f4885`): migration 0002 applied and recorded in both trackers;
   `WEBSITE_BOT_CHECK=delegated` on Railway. With a temporary CanadaWide key,
   one internet and one mobility lead (named `CRM SMOKE TEST - ignore`) were
   stored `submitted` with a contact and mirrored into the legacy tables under
   the same ids, about 2 s per request; no key → 401, a bad payload → 400
   naming only the field. Afterwards the key was revoked and all four test
   rows soft-deleted (the old admin hides them unless "show deleted" is on).
   CanadaWide's switch itself waits on §5.1 step 1.

### 3.3 2026-10-26/27: phase 2 core and the CanadaWide history

1. **Migration 0003** (additive, applied before the code): `leads.stage`,
   `memberships.display_name`, the board and "my tasks" indexes, and the five
   foreign-key indexes the performance advisor flagged.
2. **Lead work in the backend** (`leads/work-store.ts`, `leads/staff-queries.ts`,
   routes in §2.3): lead detail with form, timeline and tasks; stage, assignee
   and contact corrections; notes; tasks; trash and restore; the board; the
   per-type summary; "my tasks"; display names. Each write locks the lead,
   records a timeline entry and an audit event in one tenant transaction;
   neither stores contact values or note text a second time. The stage list
   per type is `leadTypeCatalog` in the contracts, shared with the admin and
   identical to CanadaWide's old admin, so its history imports one to one.
3. **Twenty-style admin**: the inbox (type tabs with counts, search, stage and
   assignee filters, table or board with drag-and-drop and a keyboard "Move to"
   menu, everything in the URL), the lead page, My tasks, and Settings → Your
   name. Read-only roles see the stage and source and nothing personal.
4. **Browser journeys** (`apps/admin/e2e/leads.spec.ts`) against the real
   backend and a disposable database through `apps/backend/tests/e2e/harness.ts`,
   now a CI step. They caught two bugs before release: a delayed search update
   that undid a tab clicked while it waited, and a task checkbox that only
   moved once the server answered.
5. **Historical import** in production (`packages/db/sql/canadawide-legacy-import.sql`):
   all 708 legacy CanadaWide leads (669 internet, 39 mobility; four more than
   the morning's count, sent by customers meanwhile), 623 contacts, 279 notes,
   28 tasks; stages and trash matched the legacy rows one for one; a second run
   changed nothing.

## 4. What is verified, and how

| Claim                                       | Evidence                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend serves and the scheduler runs clean | `GET /api/v1/health` 200; deployment logs show no `scheduler_task_failed` since the pooler fix                                                                                                   |
| Admin is reachable and wired                | `/login` 200 on `gt-sales-crm-admin.vercel.app`; the JS bundle contains the backend URL, Supabase URL and key                                                                                    |
| CORS                                        | `OPTIONS /api/v1/staff/me` from the admin origin → 204 with `access-control-allow-origin` set                                                                                                    |
| Owner access                                | `app.memberships`: two `active` rows for the owner's user id; log shows `/staff/workspaces` 200 and leads 200                                                                                    |
| Code gates                                  | typecheck, lint, Prettier, 557/557 tests with integration suites, both builds, 14 shell browser checks and 4 lead journeys against the real backend (2026-10-27); CI run 8 green on `b1409cf`    |
| Website intake in production                | Smoke test 2026-10-26: two labelled leads stored and mirrored with matching ids; 401 without a key; 400 on a bad payload                                                                         |
| Phase 2 live                                | Railway deployment of `b1409cf` SUCCESS; `/w/canadawide/tasks` and `/w/canadawide/leads/<id>` answer 200 on the admin domain (they did not exist before); migration 0003 verified in the catalog |
| Import complete and idempotent              | Reconciliation in RUNBOOKS/legacy-import.md: 0 legacy rows missing, 0 stage or trash mismatches, every new id a valid UUID; identical counts and fingerprints after a second run                 |

## 5. What comes next, in order

### 5.1 Owner, before anything else

1. **Switch CanadaWide to the CRM** (closes phase 0 and starts closing the anon
   write paths). In the CRM admin, open CanadaWide → Settings → site keys,
   create one with scope `leads:write` and copy it (shown once). In Vercel,
   open the CanadaWide project → Settings → Environment Variables, add
   `CRM_API_URL=https://crm-production-cf2e.up.railway.app` and
   `CRM_SITE_KEY=<the key>` for Production, then redeploy. The next CanadaWide
   lead should appear in both the CRM inbox and the old admin. Then the next
   session (or a scheduled check) verifies and drops the two lead policies
   (§5.4).
2. **Custom SMTP for Supabase Auth**, before inviting anyone else: the
   built-in mailer refuses addresses outside the Supabase team. Simplest: in
   the Resend account Get Canada Sim already uses (domain `getcanadasim.com`
   verified there), create an API key, then Supabase → Authentication → Emails
   → SMTP: host `smtp.resend.com`, port 465, user `resend`, password the API
   key, sender e.g. `GT Sales CRM <crm@getcanadasim.com>`. The same account
   can later back the backend's `EMAIL_PROVIDER=resend`.
3. Supabase → Storage → S3 access keys for the `documents` bucket; put them in
   Railway as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, then set
   `R2_ENDPOINT=https://xykrphbgpwisqacpyeiv.storage.supabase.co/storage/v1/s3`,
   `R2_REGION=ap-south-1`, `R2_BUCKET=documents`, `R2_ACCOUNT_ID` (ENV.md). Until
   then document uploads fail, and CanadaWide's ID step cannot move here.
4. Names and roles of the other admins; invite them from the admin (after 2).
   Each sets their own name under Settings → Your name (the owner too: until
   then colleagues see "Unnamed owner").
5. **Decide when staff move from the old admin to the CRM** for CanadaWide.
   On the day: re-run the import (RUNBOOKS/legacy-import.md) so the last
   statuses and notes come over, then staff work only in the CRM. After that a
   session drops the 0002 mirror trigger and removes the Internet and Mobility
   Leads pages from the Get Canada Sim admin.
6. Move the Railway project into a GT Sales workspace; rotate the secrets
   generated during the build (`app_runtime` password, `CRON_SECRET`,
   `EMAIL_CONTACT_HASH_SECRET`, registry secrets) once stored properly.
7. Enable leaked-password protection (Supabase → Authentication → Policies);
   the security advisor flags it.
8. Optional: switch Supabase Auth's TOTP toggle off; nothing uses it.

### 5.2 Engineering: what remains of phases 1 and 2, per PLAN.md §6–7

- **Done:** the lead-type registry with `internet` and `mobility` modelled,
  one-shot intake, the legacy mirror, CanadaWide's two lead routes behind its
  env switch (§3.2); the historical import, stages, lead page, timeline, notes,
  tasks, assignment, board, My tasks, trash (§3.3). Still to do in phase 1:
- **CanadaWide's ID step** (`/api/mobility-applications`): needs Storage S3
  keys (§5.1) and `SENSITIVE_FIELDS_KEY` for SIN sealing. Route a licence
  photo through `uploads/intents` → `finalize` onto the mobility lead, and a
  SIN as a sealed field; mirror the `mobility_id_uploads` row (SIN in plain
  text there, as the old admin shows it) until phase 2. Then drop the last two
  anon policies.
- **Documents on Supabase Storage** through the existing S3 adapter (verify the
  endpoint quirks first thing; a thin Storage-API adapter is the fallback).
- **SIN sealing** with `crypto/cipher.ts` (AES-256-GCM, label
  `gt-sales-crm:sealed-value:v1`) before any identity field is stored.
- **Model the planned types** (`sim_order`, `partner_application`,
  `contact_message`) when Get Canada Sim's forms move (phase 3).

Still to do in phase 2:

- **Documents on the lead page**: a mobility lead's licence photo (after the
  ID step moves and S3 keys exist), with review and download, reusing the
  existing `files` routes.
- **One inbox across sites** (PLAN.md §5.2: a query per site the admin belongs
  to, merged), **saved views** (`saved_views` table), the **contact page** (all
  leads of one person across sites) and **split/merge** of contacts, audited.
- **Cutover clean-up** once staff are on the CRM (§5.1 step 5): a migration
  dropping `leads_mirror_canadawide_legacy` and its function, and removing the
  old pages from the Get Canada Sim admin.

Then phase 3 (port Get Canada Sim's orders, partners, finance, blog, staff
management and portal; its forms call the intake API; read
`docs/CRM_PLATFORM_PLAN.md` in that repository first) and phase 4 (remove
admin, portal and database code from the website repositories; drop legacy
tables).

### 5.3 Technical follow-ups found during the build

- **Latency, second round.** Measure warm staff requests from the deploy logs
  (`durationMs`). Remaining cost per request: one Auth API call, one rate-limit
  statement, two transactions (membership, then the data). Options, in order of
  safety: pipeline the independent statements inside a transaction; a 10–30 s
  per-token cache of `getUser` results (changes revocation latency slightly,
  decide with the owner); a read-through cache of the membership snapshot
  keyed by actor+site invalidated by the staff mutation routes.
- **Turnstile is off by design** (`WEBSITE_BOT_CHECK=delegated`). If a site
  ever shows abuse that its own screening misses, add Turnstile to that site's
  forms, forward the token as `x-turnstile-token`, set the `TURNSTILE_*`
  variables and switch the mode back to `turnstile`.
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

### 5.4 Closing the anonymous write paths

| Policy (production)                                                      | Status                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `public.internet_leads` "anon can submit leads"                          | Drop once every new `internet_leads` row has a matching `app.leads` id (CanadaWide switched, §5.1 step 1). |
| `public.mobility_leads` "anon can insert mobility leads"                 | Same check against `mobility_leads`.                                                                       |
| `public.mobility_id_uploads` "anon can insert mobility id uploads"       | Stays until the ID step moves (§5.2).                                                                      |
| `storage.objects` "anon can upload mobility ids" (bucket `mobility-ids`) | Stays until the ID step moves (§5.2).                                                                      |

Verification query for the first two (zero rows = safe to drop):

```sql
select 'internet' as t, i.id from public.internet_leads i
where i.created_at > '<switch time>' and not exists (select 1 from app.leads l where l.id = i.id)
union all
select 'mobility', m.id from public.mobility_leads m
where m.created_at > '<switch time>' and not exists (select 1 from app.leads l where l.id = m.id);
```

Then `drop policy "anon can submit leads" on public.internet_leads;` and
`drop policy "anon can insert mobility leads" on public.mobility_leads;`, and
confirm in `pg_policies`. CanadaWide's direct-write fallback then stops working,
which is the point: unset CRM variables would fail loudly instead of reopening
the path.

## 6. How to work in this repository

- **Branches and deploys.** `main` is production for both apps; push there only
  with the owner's say-so (given for this phase). Work on `claude/<topic>`
  branches; CI runs on PRs and on `main`. Railway and Vercel both skip builds
  when only docs change (`watchPatterns`, `affected-builds.mjs`).
- **Gate before every commit**: `pnpm run typecheck && pnpm run lint && pnpm run format && pnpm test && pnpm run build`,
  with the integration variables set so the database suites run (they are what
  catch SQL mistakes the type system cannot). Browser checks: `pnpm run test:e2e`
  after an admin build, and `pnpm --filter admin test:e2e:leads` (needs local
  Postgres with a `gt_sales_crm_e2e_test` database; it builds its own admin
  into `.next-e2e` and puts `next-env.d.ts` back afterwards).
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
