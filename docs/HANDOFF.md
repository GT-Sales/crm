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

| System       | Facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**   | `GT-Sales/crm`. `main` deploys both apps. Development branch for this work: `claude/phase-0-scaffold`, fast-forwarded into `main` (identical histories). CI (`.github/workflows/ci.yml`, job `verify`) runs on every push to `main` and on PRs: lint, format, typecheck, migrations on a disposable Postgres, the full test suite with integration suites forced on, OpenAPI drift check, affected builds, the shell browser checks and the lead journeys against the real backend.                                                                                                                                                                                                                                                    |
| **Backend**  | Railway project `GT Sales CRM` (`ea4ffa36-d587-45b8-a64d-9f8f84fbd42f`), service `crm` (`01c9dcfa-644d-4c52-ade1-b08d65114443`), environment `production` (`112461fd-4e06-44bc-a5ae-13f40438f69e`). Region **Singapore `asia-southeast1`** (one replica). Follows `main`; build per `railway.json` at the repo root. Public URL `https://crm-production-cf2e.up.railway.app`, `PORT` pinned to 4000. Lives in the developer's personal Railway workspace for now.                                                                                                                                                                                                                                                                      |
| **Admin**    | Vercel team `gt-sales` (`team_PDmnYZIjHmPgGmDSYFB0Ru3K`), project `gt-sales-crm-admin` (`prj_cjhH8QnFnO5RdOHHRZVhOrxsStnp`). Root `apps/admin`, framework Next.js, **Node 22.x** (the repo's `engines` field rejects Vercel's default of 24), production branch `main`, functions in `iad1` (`apps/admin/vercel.json`). Live at **`https://gt-sales-crm-admin.vercel.app`**. The `…-gt-sales.vercel.app` alias and per-deployment URLs sit behind Vercel's login wall.                                                                                                                                                                                                                                                                 |
| **Database** | Supabase project `xykrphbgpwisqacpyeiv`, region `ap-south-1` (Mumbai), shared with the Get Canada Sim website's `public` schema. The CRM owns the **`app` schema** (30 tables) and the **`app_runtime`** role (NOBYPASSRLS). Backend connects through the transaction pooler `aws-1-ap-south-1.pooler.supabase.com:6543` as `app_runtime.xykrphbgpwisqacpyeiv` (the `aws-0` host does not know this tenant). Storage bucket `documents` exists; S3 keys not yet issued.                                                                                                                                                                                                                                                                |
| **Auth**     | Supabase Auth on the same project: email + password, confirmation required, sign-ups allowed (the invitation flow needs them). Site URL and redirect URL are the admin domain above. No multi-factor step (owner decision, see §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Email**    | The Resend account this session can reach has no domains; CanadaWide and Get Canada Sim send their own mail with their own Resend keys. The backend's email provider stays off until the owner adds the Resend key (§5.1 step 3; Get Canada Sim's sender is already configured), and Supabase custom SMTP is unset. Supabase's built-in mailer **delivers only to members of the Supabase organization's team**, at about two messages an hour: the owner's own sign-up worked because the owner is on the team, but any other admin's confirmation email is refused until custom SMTP is set (§5.1).                                                                                                                                  |
| **Owner**    | Md Takibuddin, gamertakib@gmail.com — GitHub org owner, Railway workspace, Vercel team, Supabase org. First `owner` of both sites in the CRM (Auth user `b8fbfaea-a3a8-4cfd-b609-d9d422fa7b7e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Websites** | Get Canada Sim (`Md-Takibuddin/Get-Canada-Sim`, Next.js on Vercel, its own admin and tables in `public`; sends nothing here until the cutover (merge design §12)). CanadaWide (`Md-Takibuddin/Canadawide-Sales-website`, Next.js on Vercel in the owner's personal team, which this session's Vercel token cannot see): its internet and mobility forms send to the CRM once `CRM_API_URL` and `CRM_SITE_KEY` are set in its Vercel project (code on `main` since 2026-10-26, inert until then); its ID-upload step still writes Supabase directly. All 708 of its historical leads are in the CRM (imported 2026-10-27, re-run before the staff cutover); staff still use the Get Canada Sim admin until the owner moves them (§5.1). |

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
 │  scheduler (in-process):   outbox 60 s · document_cleanup 1 h · data_retention 1 d · intake_check 15 min    │
 │  every data access: withTenantTx → set_config(app.workspace_id, app.actor_id) → RLS decides                  │
 └───────────────┬───────────────────────────────────────────────┬───────────────────────────────┬──────────────┘
                 │ postgres (pooler, app_runtime)                │ Auth API (getUser)            │ S3 API (unset)
                 ▼                                               ▼                               ▼
      Supabase Postgres, schema `app`                     Supabase Auth                  Supabase Storage
      30 tables, FORCE RLS, SECURITY DEFINER functions   email+password sessions         bucket `documents`
                 ▲
                 │ NEXT_PUBLIC_SUPABASE_* (browser signs in directly with Supabase Auth, nothing else)
 ┌───────────────┴────────── admin: apps/admin (Next.js 16, Vercel iad1) ───────────────┐
 │ /login (+ invitation sign-up) · /recovery · /denied · /w/[site]/{leads, leads/[id],    │
 │ tasks, documents, reports, settings, settings/jobs}; every call = fetch(API, bearer)   │
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

| Path                     | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src`       | `app.ts` (middleware + mounts), `server.ts`, `scheduler.ts`, `shutdown.ts`; `auth/` (Supabase session verifier), `staff/` (authorization, staff store), `website/` (credential auth, rate limits, bot check), `leads/`, `documents/`, `email/`, `jobs/` (outbox), `retention/`, `machines/`, `crypto/`, `http/`, `routes/`.                                                                                                                                                                                           |
| `apps/backend/tests`     | Vitest unit tests, `*.integration.test.ts` against a disposable Postgres, `isolation.spec.ts` (the tenant-isolation gate), `e2e/harness.ts` (the real backend for the lead journeys, one stub session verifier), `support/` (replica legacy tables).                                                                                                                                                                                                                                                                  |
| `apps/admin/src`         | `app/` routes, `components/` (shell, sidebar, switcher, `leads/` — inbox, table, board, lead page, timeline, tasks, my tasks — credentials manager, jobs status, invite form, display name, session provider), `lib/` (`api.ts`, `use-resource.ts`, `dates.ts`, `people.ts`, `supabase-auth.ts`). `next.config.ts` builds the CSP from the public env.                                                                                                                                                                |
| `apps/admin/e2e`         | `shell.spec.ts` (public routes, desktop + mobile) and `leads.spec.ts` (the lead journeys against the backend harness, `playwright.leads.config.ts`). README explains the compiled-out test session seam.                                                                                                                                                                                                                                                                                                              |
| `packages/db`            | `src/schema.ts` (Drizzle schema incl. RLS policies), `drizzle/` (SQL migrations + journal), `src/index.ts` (pooled client, `withTenantTx`, `withActorTx`, `rateLimitHit`, `resolveWebsiteCredential`), `src/seed.ts` (sites, roles, permissions, owner invitation), `src/migrate.ts`, `sql/` (data scripts run by hand, e.g. the CanadaWide import). Backend-only import.                                                                                                                                             |
| `packages/contracts`     | Shared lead property catalogue (`src/lead-properties.ts`), the per-site catalogue with custom properties (`src/properties.ts`), record layouts (`src/property-layouts.ts`), private saved views (`src/saved-views.ts`), custom value edits (`src/custom-values.ts`) and per-type field definitions (`src/lead-fields.ts`), Zod schemas for every request/response, the endpoint registry (`src/endpoints.ts`), the one typed client, and `scripts/generate-openapi.ts` → `docs/api/openapi.json` (CI fails if stale). |
| `packages/types`         | Role, permission, scope and status name tuples shared by db, backend, contracts and admin.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/ui`            | shadcn-style components (Tailwind 4) for the admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/adapters`      | Error tracking (Sentry-shaped, inert when unset) and other thin provider adapters.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/config`        | Shared ESLint/TS/Prettier config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/observability` | Logger and request-log shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `jobs`                   | Standalone job runner entry (same code as the scheduler tasks) for one-off runs.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts`                | `affected-builds.mjs` (Vercel ignore step and `build:affected`), tooling tests.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs`                   | This file, PLAN.md, ENV.md, RUNBOOKS/ (database, legacy import), `api/openapi.json`, `RUNBOOKS/manual/0001-remaining.sql` (the statements the Supabase tool refuses to run).                                                                                                                                                                                                                                                                                                                                          |

### 2.3 Backend surfaces

Staff routes (`/api/v1/staff`, Supabase bearer token; `action` is what
`decideAccess` checks against the actor's roles and permission overrides):

| Method          | Path                                                                     | Action                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET             | `/workspaces`                                                            | —                            | Accepts pending invitations for the verified email, then lists active sites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET             | `/workspaces/:id/access`                                                 | workspace.read               | Roles and permission names for the site switcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PATCH           | `/profile`                                                               | —                            | The caller's own display name, on every site they belong to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET             | `/workspaces/:id/leads`                                                  | workspace.read               | Paged; filters type, stage, assignee (`me`/`none`/id), `q`, `view=archived` (`trash` is the deprecated alias), `dueBy` (a follow-up due by that day, most overdue first), `where` (up to 10 typed property filters), `sort` (`createdAt`, `updatedAt`, `fullName`, `externalRef`, or `prop.<key>`), and `columns` (up to 6 property keys returned in `properties`); all three are checked against the site's property catalogue, custom properties included. Contact fields, `properties` and the countdown date hidden unless lead.manage, order.manage or financial.read; `q`, `where`, a `fullName` or property `sort` and `columns` need that too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET             | `/workspaces/:id/leads/stats`                                            | workspace.read               | The dashboard's counts for one type (`leadType`, `days` 7/30/90 or none for all time): by stage, per UTC day and the top 10 partner codes (named by their partner application's company), lost stages left out of the last two. Counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET             | `/workspaces/:id/reports/sources`                                        | workspace.read               | Reports → Sources: one type's leads per source (`leadType`, `days` 7/30/90 or none for all time), each source as `deriveSource` labels it (`partner:<code>`, with ` (unmatched)` when no partner application matched; `utm:<source>[/<medium>]`; `referrer:<host>`; `direct`), with `received`, `submitted` and `madeIt` (the stage is one of `SOURCE_REPORT_SUCCESS_STAGES`: `activated`, `installed`, `completed`, `won`), a `utm` source's campaigns, the totals and `withSourceData` (counted leads with any attribution). At most 50 sources and 20 campaigns per source; the rest summed into one `other` row. The same leads `/leads/stats` counts. Counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET             | `/workspaces/:id/leads/summary` · `/leads/board`                         | workspace.read               | Active leads per type (with how many nobody has opened) and the archive (`archived`; `trash` carries the same number, deprecated); one type's leads by stage (a column per catalogue stage, counts, newest 50 each; accepts `where` property filters with contact access).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET             | `/workspaces/:id/leads/:leadId`                                          | workspace.read               | Lead with form, timeline, tasks, identities and current documents; readers without contact access get stage and source only; `access.downloadDocuments` says whether the caller may open the documents. Returns `customValues` and, for an order type, `order` (the order details) with contact access. `allowedMoves` lists the stages the lead may move to from where it is; `access` also says whether the caller may `emailCustomer`, `reviewDocuments` (`order.manage`) and `overrideDocuments` (`order.override`). With contact access it also carries `changeRequest`, the customer's pending change request (number, version, fields asked for, documents sent with it) or null, and `access.decideChanges` (`lead.manage`) says whether the caller may decide it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PATCH           | `/workspaces/:id/leads/:leadId`                                          | lead.manage                  | Stage (checked against the type), assignee (active member), contact and form corrections (`form`, checked against the type's field definitions) `customValues` (checked against the site's custom properties) and, for an order type, `order` (`planId` re-freezes the plan from the site's current one: it must be active and of the lead's type, `null` clears it; `quantity`, `paymentStatus`, `carrierCommission`; a refused order is 400 `validation_error` with `details.field` `plan` or `order`); timeline + audit. A stage is also checked against the type's allowed moves, and `order` takes the dispatch and activation fields `courier`, `trackingNumber`, `dispatchedAt`, `activatedAt`, `activationNumber` and `activationAccount`. `documentsOverrideReason` (1–2000 characters, only with `stage`) moves an order on without its required documents approved and needs `order.override` (owner, Orders role). The response carries `allowedMoves` and `emailSkipped`: one item per automation rule that was on but queued nothing (`automation`, `template`, `reason`, and the `missing` fill-ins). Refusals: 409 `illegal_stage_move` (`details { from, to, allowed }`); 400 `dispatch_details_required` (`details.field` `courier`, needed for Delivered); 400 `activation_details_required` (`details.field` `activatedAt`, when it is set to null for Activated); 409 `documents_incomplete` (`details.missing` lists the document types, for Delivered and Activated); 400 `document_override_reason_required` (a blank reason); 409 `documents_override_not_allowed` (a reason from a caller without `order.override`). |
| POST            | `/workspaces/:id/leads/:leadId/opened`                                   | lead.manage                  | The lead page's first open: clears the "New" badge for the team (an `opened` system entry). Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST            | `/workspaces/:id/leads/:leadId/customer-emails`                          | lead.manage                  | Queues a mail to the customer (`sim_number_ready`) from the site's own sender; 409 `feature_not_ready` while the site cannot send, `conflict` with `details.missing` when the lead lacks the email or the number. 202. The mail is rendered from the site's `sim_number_ready` template when it is queued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST            | `/workspaces/:id/leads/:leadId/{notes,tasks,archive,restore}`            | lead.manage                  | Note, follow-up task, archive (soft delete; `/trash` is the deprecated alias of `/archive`) and back. An archived lead refuses changes (`lead_trashed`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST            | `/workspaces/:id/leads/:leadId/change-requests/:changeRequestId/approve` | lead.manage                  | Approves the customer's pending change request at `expectedVersion`: the fields go through the staff edit (`applyLeadUpdate`: one `edit` entry naming keys, audit `lead.updated`, the plan frozen again on a plan change), its held documents become current and wait for an `order.manage` review, a `change_approved` entry, and the Change approved email queued in the same transaction (or `emailSkipped` with its reason). 409 `version_conflict` when the customer replaced it since, `change_request_resolved` when it was decided, `lead_trashed` on an archived lead; 404 `change_request_not_found`; 400 `validation_error` with `details.field` when a value no longer fits (an inactive plan). Returns `{ lead, activities, allowedMoves, emailSkipped? }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST            | `/workspaces/:id/leads/:leadId/change-requests/:changeRequestId/reject`  | lead.manage                  | Rejects it at `expectedVersion`: nothing on the lead changes, its held documents are deleted, a `change_rejected` entry, and the Change rejected email queued (or `emailSkipped`). The same refusals as approve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PATCH · GET     | `/workspaces/:id/tasks/:taskId` · `/tasks`                               | lead.manage · workspace.read | Complete, reopen, cancel, edit; "my tasks", or the team's (`assignee=all`), optionally due by a day (`dueBy`); needs contact access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GET             | `/workspaces/:id/members`                                                | workspace.read               | Assignee options: membership and actor ids, roles and display names, never emails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET             | `/workspaces/:id/properties`                                             | workspace.read               | The site's lead properties (code built-ins as the site relabelled or hid them, then custom ones), every lead type's record layout (the saved one, else the default at version 0), for leads the site's `plans` (id, name, active, lead type: each order type's `plan` offers only its own) and `capabilities.canManage`. The five property routes (this one, `POST`, `PATCH`/`DELETE` `/properties/:key` and `PATCH /properties/layouts`) take `?object=lead` (the default) or `?object=plan`: see the plan properties below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST            | `/workspaces/:id/properties`                                             | property.manage              | Adds a custom property (label, kind, options, `staffOnly`, `sensitive`, `leadTypes`); its key `custom_<snake>` is generated from the label. 201; 409 `property_limit` at 100 live custom properties per site (tombstones do not count).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PATCH           | `/workspaces/:id/properties/:key`                                        | property.manage              | Edits a property with `expectedVersion`. A built-in takes only `label` and `hidden` (400 `builtin_property_locked` otherwise). 400 `invalid_request` when the options do not fit the kind, 404 `property_not_found`, 409 `version_conflict`, 409 `property_option_in_use` when a removed choice option is still on leads (`details { optionValue, leadCount, active, trashed, restricted }`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DELETE          | `/workspaces/:id/properties/:key`                                        | property.manage              | Tombstones a custom property; the key stays reserved. 404 `property_not_found`, 400 `builtin_property_locked`, 409 `property_in_use` while any lead, trashed and restricted ones included, holds a value; `details { leadCount, active, trashed, restricted }` tells the owner which leads to clear, restore first, or that hiding is the only way out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PATCH           | `/workspaces/:id/properties/layouts/:leadType`                           | property.manage              | Saves the record layout (sections and property keys) for one lead type with `expectedVersion` (absent only for the first save; a save without one over a saved layout is a conflict, never an overwrite). 400 `unknown_property_key`, 409 `version_conflict`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET             | `/workspaces/:id/plans`                                                  | workspace.read               | The site's plans, active ones unless `includeInactive=true`, optionally one `leadType` (`sim_order`, `internet` or `mobility`). A plan has a name, a price in cents (CAD), a billing period (`one_time`, `month`, `30_days`, `90_days`, `year`), whether payment is required, `active`, the documents it requires, its custom values and a `position`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST            | `/workspaces/:id/plans`                                                  | order.manage                 | Adds a plan. Its name is 1–80 characters (it is the plan's option label on the order's `plan` property; `PATCH` keeps the same limit). 201; 409 `plan_name_taken` (names compare case-insensitively per lead type), 409 `plan_limit` at 200 plans per site, 400 `invalid_request` with `details.field` for a bad custom value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PATCH           | `/workspaces/:id/plans/:planId`                                          | order.manage                 | Edits, reorders, deactivates or reactivates a plan with `expectedVersion`; the lead type is fixed at creation. A plan is never deleted: `active` off hides it. 404 `plan_not_found`, 409 `version_conflict`, 409 `plan_name_taken`, 400 `invalid_request` with `details.field` for a bad custom value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET             | `/workspaces/:id/email/settings`                                         | integration.manage           | The site's saved sender and look (`settings`, null until saved; a site with none sends no customer email). Every email route needs the Integrations permission (`integration.manage`; the owner has it, and a member given the `integration_management` override has it too), reading included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PUT             | `/workspaces/:id/email/settings`                                         | integration.manage           | Saves the whole form: from name (1–80) and address, optional reply-to, logo and site address (https only), brand colour `#rrggbb` (default `#d72638`), footer (up to 500 characters). 400 `invalid_request`; audited as `email.settings_updated`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET             | `/workspaces/:id/email/templates`                                        | integration.manage           | The site's nine templates (`tracking_code`, `order_received`, `information_needed`, `dispatched`, `activated`, `cancelled`, `sim_number_ready`, `change_approved`, `change_rejected`), the starter text at version 0 where none is saved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PUT             | `/workspaces/:id/email/templates/:key`                                   | integration.manage           | Saves a subject (1–150) and body (1–5000) against `expectedVersion`; every save is a new version and is audited as `email.template_saved`. 409 `version_conflict`; 400 `invalid_fill_in` (`details { fillIn, where }`: a misspelt fill-in, or one this template may not use); 400 `invalid_email_markup` (`details.reason`: `two_buttons`, `button_not_alone`, `bad_link`); 404 `not_found` for an unknown key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST            | `/workspaces/:id/email/templates/:key/preview`                           | integration.manage           | Renders an unsaved subject and body in the site's look with sample values, never a lead's. The same 400 codes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST            | `/workspaces/:id/email/templates/:key/test`                              | integration.manage           | 202. Queues the saved template, with sample values, to the signed-in member's own verified address; `queued` is false when it was not queued (one per template, member and minute). 409 `feature_not_ready` while the site has no sender.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET             | `/workspaces/:id/automations`                                            | workspace.read               | The site's six built-in rules (`order_received`, `sim_order_information_needed`, `sim_order_dispatched`, `sim_order_activated`, `sim_order_cancelled`, `mobility_activated`) with `enabled`, `lastRunAt` and `runCount`, and `canManage` (`integration.manage`) and `hasSender` (the deployment can send and the site has a sender).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PUT             | `/workspaces/:id/automations/:key`                                       | integration.manage           | Switches a rule on or off with `{ enabled }`, nothing else; audited as `automation.toggled` when the state changes. 404 `automation_not_found` for a key that is not one of the six (checked after the permission).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET             | `/workspaces/:id/automations/:key/runs`                                  | workspace.read               | The rule's latest 50 runs, newest first: lead id, outcome `queued` or `skipped`, the reason (`no_sender`, `no_customer_email`, `missing_fill_in`) and time; the lead's name only with contact access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET             | `/workspaces/:id/views?object=lead`                                      | workspace.read               | The caller's own saved views, each cleaned against the site's current catalogue. Needs contact access (403 otherwise).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST            | `/workspaces/:id/views`                                                  | workspace.read               | Saves the caller's current inbox state under a name (1–60 characters). 201; 409 `saved_view_name_taken` (names compare case-insensitively per person), 409 `saved_view_limit` at 30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PATCH           | `/workspaces/:id/views/:viewId`                                          | workspace.read               | Renames a view or replaces its state with `expectedVersion`. 404 `saved_view_not_found`, 409 `saved_view_name_taken`, 409 `version_conflict`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DELETE          | `/workspaces/:id/views/:viewId`                                          | workspace.read               | Deletes the caller's own view. 404 `saved_view_not_found`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET             | `/workspaces/:id/jobs`                                                   | workspace.read               | Outbox jobs and alerts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST            | `/workspaces/:id/jobs/:jobId/retry` · `/resolve`                         | integration.manage           | Retry a failed job; resolve an uncertain delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST            | `/workspaces/:id/invitations`                                            | staff.invite                 | Invite by email with roles; `memberships.status = pending`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DELETE          | `/workspaces/:id/memberships/:membershipId`                              | staff.remove                 | Revoke; takes effect on the member's next request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET/POST/DELETE | `/workspaces/:id/service-credentials[/:credId]`                          | integration.manage           | Site keys `gtsk_…`, shown once, stored hashed, scoped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST            | `/workspaces/:id/files/:fileId/review`                                   | order.manage                 | Approve/reject an uploaded document.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST            | `/workspaces/:id/files/:fileId/download-link`                            | document.download            | Short-lived signed URL: a download, or with `{ "disposition": "inline" }` one showing the verified PDF/JPEG/PNG in a tab of its own; audited either way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Plan properties.** With `?object=plan` the property routes work on the
site's plan properties instead of its lead properties: custom ones only, kept
in `app.plans.custom_values`, with one layout for all plans (saved at
`PATCH /properties/layouts?object=plan`, no lead type in the path). A plan
property carries `websiteVisible` (the admin's _Show on website_ switch),
which decides whether the website's plan listing and a lead's frozen plan carry
its value; a lead property cannot be made website visible (400). Usage counts
of a plan property return `planCount` (the plans holding the value).
`property.manage` (owner) is still the action for all of it.

Website routes (`/api/v1/website`, `Authorization: Bearer gtsk_…`):

| Method | Path                                                     | Scope            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/plans`                                                 | leads:write      | The site's active plans for its storefront, optionally one `?leadType=`: id, lead type, name, `priceMinor`, currency, billing period, `paymentRequired`, `requiredDocuments` and `properties` (only the custom plan values the site marked _Show on website_). No bot check (a read with no visitor to prove); `Cache-Control: no-store`.                                                                                                                             |
| POST   | `/leads`                                                 | leads:write      | Creates a lead; `leadType` required (`^[a-z0-9_]{1,64}$`), optional `externalRef` unique per site+type. Contact merged by normalized email. Returns a draft grant `gtdg_…`. An order type (`sim_order`, `internet`, `mobility`) may carry `order: { planId, quantity }` (quantity 1–99, default 1; never a price): see §2.6 item 8. Takes an optional `Idempotency-Key` header: see §2.6 item 9.                                                                      |
| GET    | `/leads/:leadId`                                         | leads:write      | Resume a draft with its grant.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PATCH  | `/leads/:leadId`                                         | leads:write      | Complete or update the draft. Takes `order: { planId, quantity }` and `submit: true` (submits the draft: `incomplete` → `submitted`, its plan frozen). 400 `plan_not_available` when the plan is inactive, another site's or of another lead type. A submitting `PATCH` takes the optional `Idempotency-Key` header too (§2.6 item 9).                                                                                                                                |
| POST   | `/uploads/intents`                                       | uploads:customer | Signed upload intent for a customer document.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/uploads/:uploadId/finalize`                            | uploads:customer | Verifies the real bytes' signature, links the file to the lead.                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/files/:fileId/download-link`                           | uploads:customer | Customer-side download of their own document.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/tracking/code`                                         | tracking         | A customer's email (`{ email }`). Always `200 { status: 'code_sent' }`, after at least 500 ms from the request's start, whether or not the email has orders on this site; only when it has does a challenge and its `tracking_code_email` job get written. 5 per email and 20 per visitor in 10 minutes, counted for every email; over them it still answers 200 and sends nothing. Bot action `tracking-request`. Tracking unconfigured: the same 200, nothing sent. |
| POST   | `/tracking/verify`                                       | tracking         | `{ email, code }` → `{ grant: { token, expiresAt } }`, a 30-minute grant for this site and email. A wrong, used, expired, superseded or exhausted code (5 tries) is one `400 tracking_challenge_invalid`. 10 per email and 40 per visitor in 10 minutes, then 429. Bot action `tracking-verify`.                                                                                                                                                                      |
| GET    | `/tracking/orders`                                       | tracking         | With `X-Customer-Grant`: the email's submitted orders on this site, newest first, at most 50 (§2.6 item 11). 401 `not_found` for a missing, forged, expired or other site's grant.                                                                                                                                                                                                                                                                                    |
| POST   | `/tracking/orders/:reference/changes`                    | tracking         | With the grant: `{ fields }`, at least one changeable field, never `email`. 201 `{ changeRequest }`; a pending request of the customer's is replaced in place. 409 `change_request_not_allowed` when the order is not a `sim_order` at `pending`, `verified` or `on_hold`; 400 `validation_error` with `details.field` (`planId`, `shippingAddress`); 404 `order_not_found`. 30 writes per email in 10 minutes.                                                       |
| POST   | `/tracking/orders/:reference/uploads/intents`            | tracking         | With the grant: a held passport or visa upload for the order's change request (`documentType`, `contentType`, `sizeBytes`); the same signed target as `/uploads/intents`. 409 `change_request_not_allowed` when the order can no longer change; 409 `feature_not_ready` without a document store.                                                                                                                                                                     |
| POST   | `/tracking/orders/:reference/uploads/:uploadId/finalize` | tracking         | With the grant: only the order's own held upload; verifies the bytes as `/uploads/:uploadId/finalize` does, then joins the file to the pending request (made if none, `version + 1` otherwise). 200 `{ changeRequest }`; 404 `upload_not_found` for any other file.                                                                                                                                                                                                   |

Other: `GET /api/v1/health`; `/api/internal/jobs/run` (GET/POST, machine
secret) for manual scheduler runs; `POST /api/internal/jobs/intake-check`
(machine secret, scope `synthetic:check`) for one intake check run by hand,
returning its result and never alerting (404 `intake_check_off` without
`INTAKE_CHECK_WORKSPACE_ID`; docs/RUNBOOKS/intake-check.md); `/api/v1/email/unsubscribe`,
`/api/v1/email/staff/workspaces/:id/delivery`; `/api/v1/webhooks/resend`
(raw body, signature-verified, `POST /:selector`).

Scheduler (`ENABLE_SCHEDULER=true`, one replica): `outbox` 60 s,
`document_cleanup` 1 h, `data_retention` 24 h (calls
`app.prune_operational_rows`) and, when `INTAKE_CHECK_WORKSPACE_ID` is set,
`intake_check` 15 min (one test lead through intake on the test site, an owner
alert on failure and one all-clear; it needs `synthetic:check` on the
scheduler entry, and when that or the id is wrong it is left out and its code
logged once at boot while the other three run). Overlap-guarded; failures are
logged as `scheduler_task_failed` and nothing else, so a quiet log is a
healthy log; each intake check run writes one `intake_check` line.

### 2.4 Data model and tenancy

Schema `app`, all tables carry `workspace_id` except `contacts` and
`rate_limit_buckets`. A workspace **is a site**.

| Group                                    | Tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sites, staff                             | `workspaces`, `memberships` (user_id or invited_email; pending/active/revoked; `display_name`), `roles`, `membership_roles`, `permissions`, `membership_permissions`, `service_credentials`                                                                                                                                                                                                                                                                                                                                                |
| CRM                                      | `contacts` (global, unique by `lower(btrim(email))`), `leads` (lead_type, status = the form's lifecycle, **stage** = where staff work it, payload, attribution, contact_id, assigned_actor_id, external_ref, restriction and soft-delete stamps), `lead_activities` (append-only timeline: note, status_change, assignment, edit, system), `lead_tasks`, `draft_grants`                                                                                                                                                                    |
| Properties                               | `properties` (a site's built-in overrides and custom properties; tombstones keep keys reserved), `property_layouts`, `saved_views` (a person's private views, owner policy), and `leads.custom_values`                                                                                                                                                                                                                                                                                                                                     |
| Plans                                    | `plans` (a site's plans, one order lead type each; never deleted, `active` off hides one), `leads.order_details` (an order lead's plan link, frozen plan, quantity, payment status and carrier commission; `{}` on every other lead) and `properties.website_visible`                                                                                                                                                                                                                                                                      |
| Documents                                | `files` (`held_for_change_request`: a customer's file sent with a pending change request, not current until it is approved), `file_revisions`, `file_review_events`                                                                                                                                                                                                                                                                                                                                                                        |
| Email                                    | `email_messages` (`template_version` records the site template version a mail was rendered from), `email_provider_events`, `email_suppressions`, `marketing_consents`, `follow_up_schedules`, `deleted_email_messages`                                                                                                                                                                                                                                                                                                                     |
| Order tools, email settings, automations | `idempotency_keys` (a website submission's key hash and request fingerprint), `workspace_email_settings` (a site's sender and look), `email_templates` (the current copy of each of nine emails) and `email_template_versions` (every saved version, append-only), `automations` (a site's on/off state and counters for each built-in rule) and `automation_runs` (one firing of a rule for a lead, append-only); `site_counters` (merge phase 5: a site's running numbers, today `sim_order_ref`, the last `MS-<n>` order number issued) |
| Order numbers, customer tracking         | `site_counters` (a site's running numbers: `sim_order_ref` for `MS-<n>`, `change_request_no` for change requests), `tracking_challenges` (one tracking code's keyed hash, tries and expiry, pruned a day after it expires; never the email or the code) and `change_requests` (a customer's change request: the values asked for in `requested`, the only place they are kept, its held files, `version`, status and who decided it; at most one pending per lead; never pruned)                                                           |
| Operations                               | `outbox_jobs`, `outbox_job_alerts`, `audit_events` (redaction-only updates), `rate_limit_buckets`                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Tenancy: `withTenantTx` opens a transaction and sets `app.workspace_id` and
`app.actor_id` with `set_config(…, true)`; every policy (`tenantPolicy`) requires
both and matches the row's `workspace_id`. `contacts` use `actorPolicy` (actor
present). FORCE RLS on all 38 tenant tables, each with a backup read policy
(`<table>_backup_reader_read`, 38 in all), so even the table owner cannot
bypass it, and `app_runtime` is NOBYPASSRLS. (Migrations 0017 and 0018, which
add `tracking_challenges`, `change_requests` and the file column, are **not
applied** to the hosted project yet; until they are, it has 36.) Work that must cross the tenant
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
(order.manage, order.override), `partners`, `content`, `viewer` (read only), `finance`
(financial.read, invoice.approve). Actions: `workspace.read`, `lead.manage`,
`order.manage`, `staff.invite`, `staff.remove`, `staff.roles.manage`,
`document.download`, `financial.read`, `export.bulk`, `record.delete`,
`invoice.approve`, `integration.manage`, `sensitive.reveal`, `property.manage` and `order.override`. `sensitive.reveal` and `property.manage` are owner only; `order.override` (moving an order on without its required documents approved, with a reason) belongs to the roles `owner` and `orders`, and no individual permission grants it. Per-member overrides
(`membership_permissions`, allow or deny) map to `document.download` through `integration.manage`; a deny always
wins. Decision logic: `apps/backend/src/staff/authorization.ts`
(`decideAccess` is pure; `createAuthorize` loads then decides). Authorization is
re-read from the database on every request, so a revoked member is out on their
next call. **There is no multi-factor step**: owner decision 2026-10-25.

Staff sign-in: the admin signs the user in with Supabase Auth in the browser
(`signInWithPassword`; "I have a staff invitation" uses `signUp` with the
invited email and a confirmation email). The first `GET /staff/workspaces`
calls `accept_staff_invitations(verified_email)`, which turns pending
memberships for that email into active ones bound to the Auth user id. Backend
verification is `auth.getUser(token)` (`auth/session.ts`), never the token's
own claims; the email must be confirmed. A successful verification is cached
for 60 seconds per token (owner decision, 2026-10-27), never past the token's
expiry: a session signed out in Auth can keep working that long, while a
removed membership stops at the next request, since site access is read on
every request.

### 2.6 How a website integrates (the contract for phase 1 and 3)

1. An owner creates a site key in the admin (`/w/<site>/settings`), scopes
   `leads:write`, `uploads:customer` and, for customer tracking, `tracking`
   ("Order tracking", never preselected). The secret is shown once.
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
   `sim_order` (Get Canada Sim's checkout) is modelled since merge phase 5:
   its strict payload (`simOrderLeadPayloadSchema`) has only optional keys,
   `planId` (the website's own slug, kept as submitted), `planLabel`,
   `delivery` (`esim` or `pickup`, a mailed SIM), `arrivalDate`,
   `permitType` (`newcomer`, `student`, `worker`, `tourist`), `gotVisa`,
   `flightBooked`, `shippingAddress`, `canadaAddress` and `reference`, and
   never `simNumber`, `customerNotes` or an email. A draft may hold any part
   of it (or no form yet), on the create and on every `PATCH`. A submission
   (on the create, or a `PATCH` with `submit: true`, checked as the save
   leaves the lead) needs the contact's name and email (`contact`), a plan
   (`order.planId`, else the draft's: `order`) and a `delivery`, with a
   non-blank `shippingAddress` for `pickup` (`form`); a refused `PATCH`
   writes nothing and claims no idempotency key. `partner_application` and
   `contact_message` are not modelled yet and take any payload as resumable
   drafts. A refusal is `validation_error` with `details.field` naming the
   refused part (`leadType`, `submit`, `form`, `contact` or `order`), never a
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
   site key and the limits above still apply. Production runs `delegated`,
   which is why the OpenAPI document marks `X-Turnstile-Token` as needed
   only in `turnstile` mode: a website that sends none (Get Canada Sim,
   CanadaWide) is correct, and nothing needs "fixing" on either side.
8. **Plans and orders** (phase 3). A site's plans are read with
   `GET /api/v1/website/plans?leadType=sim_order`: only active plans, each with
   its price in cents, billing period, `paymentRequired`, required documents and
   the custom plan values the site marked _Show on website_. The response is
   never cached. An order lead (`sim_order`, `internet`, `mobility`) is created
   or updated with `order: { planId, quantity }`; the browser sends no price,
   and the backend reads the plan itself. A draft keeps the plan and quantity
   only. When the lead is submitted (`submit: true` on the create, or on a
   `PATCH` of the draft), the backend freezes a copy of the plan on the lead
   (name, price, billing period, payment required, required documents and the
   website-visible values, with the moment it was frozen), so a later price or
   name change never rewrites an order already taken, and the order's payment
   status starts at `pending` when the plan requires payment, else
   `not_needed`. A plan that is inactive, another site's or of another lead
   type is a 400 `plan_not_available` (`details.field` `order`); `order` on a
   type that takes none is a 400 `invalid_request`. The `submit` field is new on
   `PATCH`.
9. **Safe retries and order emails** (phase 4). A website may send an
   `Idempotency-Key` header (8–200 characters of letters, digits and
   `_ . : -`) on `POST /leads` and on a `PATCH` that submits (`submit: true`);
   a plain draft save ignores a valid key, and a malformed
   one is a 400 `validation_error` with `details.field` `Idempotency-Key` on
   either call. The same key with
   the same request within 24 hours answers the first status again (201 for
   a create, 200 for a `PATCH`) with the same lead and `replayed: true`: no
   second lead, no second email. The same key with another request is 409
   `idempotency_conflict`; while the first is still being processed it is 409
   `idempotency_in_progress` with `Retry-After: 2`. Only a hash of the key is
   stored, for 7 days. Submitting an order also fires the site's
   `order_received` automation rule, if the owner has switched it on: the
   customer then gets the Order received email once per lead (§3.7 item 6). A
   website that sends its own order emails and has this rule on would send
   two, which is why every rule starts off (§5.1).
10. **Order numbers** (merge phase 5). Every create and save answers with
    `lead.externalRef`: the lead's own reference, or `null`. A `sim_order`
    created with no `externalRef` gets the next `MS-<n>` from the site's
    counter (`app.site_counters`, `sim_order_ref`), taken in the create's
    transaction, so concurrent orders never share a number and a replayed or
    refused create takes none. The counter starts after the site's highest
    imported `MS-<n>` and is raised on switch day past the old checkout's
    last `order_no` (RUNBOOKS/legacy-import.md, "The final run"). It never
    issues a number a lead already holds: behind the site's highest `MS-<n>`
    it jumps past it. A number taken at the same moment by a concurrent
    import, or a website's own `externalRef` another lead holds, is `409
external_ref_taken`. A website that sends its own `externalRef` keeps it
    as sent. Get Canada Sim reads its order number from the response; it
    never chooses one. A submitted SIM order is at stage `pending` at once
    (a draft is `incomplete`), with a `submitted` timeline entry.
11. **Customer tracking** (merge phase 5, step B). The website's
    `/tracking/*` routes (§2.3) need a site key with the `tracking` scope and
    `TRACKING_HASH_SECRET` on the backend (unset or under 32 characters:
    the code route answers neutrally and sends nothing, the others `409
feature_not_ready`). The customer types an email; the website calls
    `POST /tracking/code`, which always answers `200 { status: 'code_sent' }`
    after at least 500 ms, so an email with no orders on this site looks the
    same as one with orders; only the latter gets a code. The code is six
    digits, lives 10 minutes and allows 5 tries; a new request replaces the
    pending one. Per email per 10 minutes: 5 code requests, 10 verifications,
    30 customer writes; per visitor per 10 minutes: 20 code requests and 40
    verifications; and the endpoint budget (30 a minute per visitor,
    `RATE_LIMIT_TRACKING_*`). `POST /tracking/verify` turns the right code
    into a **grant**, which the website keeps server-side and sends as
    `X-Customer-Grant`; it is valid 30 minutes, for this site and the
    normalized email only (`trim().toLowerCase()`). **What is listed**: the
    email's submitted `sim_order`, `internet` and `mobility` leads on this
    site, not archived or restricted, newest first, at most 50: the
    reference (`MS-<n>`, or the lead id), the stage in the customer's words
    ("Received", "Confirmed", "Waiting on you", "On its way", "Active",
    "Completed", "Cancelled" for a SIM order), the frozen plan (with no
    frozen plan, as on an imported order: `plan` null and the website's own
    plan slug and label from the stored form in `details.websitePlanSlug`
    and `details.websitePlanLabel`), quantity, delivery, dispatch details,
    SIM number, the customer's own answers, each document's state
    (`missing`, `received`, `approved`, `needs_replacement`, never a link;
    a SIM order always lists the passport and visa, whatever its plan lists,
    which drives only staff's documents check) and their pending change
    request. Never payment status,
    carrier commission, notes, tasks, assignee or custom values. **What may
    change**: on a `sim_order` at `pending`, `verified` or `on_hold`, the
    name, phone, plan (a CRM plan id), delivery, arrival date, permit type,
    Canada and shipping addresses and flight booked, plus a new passport or
    visa sent as a held upload; never the email. One pending request per
    order, replaced in place by the customer's next one; staff approve or
    reject it on the lead page, and the customer is emailed the decision.
    `internet` and `mobility` orders are listed read-only
    (`canRequestChange: false`).

Full schemas: `packages/contracts/src/leads.ts`, `lead-types.ts`,
`workspace-leads.ts`, `plans.ts`, `website-auth.ts`, `tracking.ts`; rendered in `docs/api/openapi.json`.
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
6. **Fewer round trips per staff request.** Production had no staff traffic
   yet, so the cost was measured instead: one round trip from the backend
   (Singapore) to the pooler (Mumbai) is about 58 ms (the rate-limit statement
   alone logs 115–138 ms), Auth's `getUser` about 100 ms, and every statement
   with bind parameters costs two round trips, because with prepared
   statements off (transaction pooler) postgres-js has the parameters
   described first. The queries themselves run in 1–14 ms on the real data.
   Cut: the tenant context and plain rate-limit keys travel as validated
   literals; the access check is one call to `app.staff_access_snapshot`
   (migration 0004) instead of a transaction; the lead page is one statement;
   writes return their timeline rows instead of reading them back. Through a
   local proxy adding 58 ms per round trip (no limiter, no Auth): list
   713 → 359 ms, summary 718 → 298, board 715 → 358, lead page 951 → 358, My
   tasks 711 → 357, stage change 1308 → 831, note 1185 → 714. Production adds
   the limiter (now one round trip) and Auth, so a warm list or lead page
   should answer in about half a second, from about 0.9–1.2 s. Verified after
   the deploy: the limiter statement logs 57–58 ms, from 115–138 ms.
7. **The same person's other requests** on the lead page (same contact, same
   site, newest first, trashed ones marked; part of the lead page's one
   statement, and only for roles that see contacts), and **Settings → Team**:
   every active member under the name they set, with roles; the owner can
   remove someone's access behind a confirmation (the existing revoke route,
   audited; their past work stays on the leads).

### 3.4 2026-10-27: Get Canada Sim's orders in the CRM

1. **Survey** of what staff do in Get Canada Sim's admin today:
   [GCS_ADMIN_INVENTORY.md](GCS_ADMIN_INVENTORY.md).
2. **Import** (`packages/db/sql/getcanadasim-legacy-import.sql`,
   [runbook](RUNBOOKS/legacy-import.md#get-canada-sim-historical-import)): all
   138 orders as `sim_order` leads (`MS-<number>`, status as stage, archived
   ones in the trash) and 5 partner applications (`PT-<number>`), with staff
   and partner notes, reminders as tasks and SIM numbers. Re-runnable, like
   CanadaWide's.
3. **Order details**: each lead type has field definitions in the contracts
   (`packages/contracts/src/lead-fields.ts`: label, kind, choices, editable,
   staff-only, a countdown date), and one list drives the lead page, its edit
   form and the backend's check. Staff correct an order's plan, SIM type,
   arrival, permit, visa and flight answers, addresses and reference; the
   timeline and audit name the fields changed, never their values. A mailed
   SIM needs a shipping address.
4. **SIM number**: a staff-only field in its own card. After a new number is
   saved staff are asked **"Email the customer this number?"** (and can send
   it again later from the card). The mail is the old admin's "Your Canadian
   mobile number is ready (MS-101)", in its words. It goes through the outbox
   from the site's own sender (`EMAIL_SENDERS_JSON`: Get Canada Sim as
   itself, never as the CRM), with the suppression check and the delivery
   record. The timeline says "emailed the customer their SIM number", with
   no address and no number. It goes live once Resend is set up (§5.1 step
   3); until then the card says the site cannot email yet. Since phase 4 the
   mail is the site's `sim_number_ready` template and sender from Settings →
   Email, with `EMAIL_SENDERS_JSON` as the fallback (§3.7).
5. **"New" badge**: a lead nobody who works leads has opened carries a badge
   on the table, the board and its page, and the menu counts them. The first
   open records an `opened` entry (hidden from the timeline when the old admin
   wrote it). Both imports carry the old admins over: Get Canada Sim's
   `viewed_at`, and every imported CanadaWide lead counts as opened, so only
   leads from the CRM's own intake start New (1 in production after the
   re-runs). Opening a lead is not working it: the imports keep carrying the
   old admin's changes onto it.

6. **Follow-ups due and the arrival countdown.** A **Dashboard** (now the
   page staff land on, as in Get Canada Sim's admin) opens with the team's
   follow-ups due: open tasks due today or earlier, most overdue first, six
   shown ("Overdue by 3 days", the task, the customer and `MS-` number), each
   linking to its lead. Leads gains a **Follow-ups due** filter with its count
   (`?due=1`). A SIM order's arrival shows "N days left" (amber within a week,
   red on the day) in a table column, on board cards and on the lead page;
   the field definition's `countdown` flag decides which date, so another
   type can count down to its own. "Due" is a calendar day: the admin sends
   the viewer's today, since due dates are stored as days at noon UTC.
7. **Documents.** The import queues a copy of every file Get Canada Sim's
   admin keeps (passport, approval letter, SIM card photo, billing contract,
   a partner's business licence) as a `legacy_document_import` outbox job; the
   backend copies each into the CRM's part of the shared `documents` bucket
   and verifies it like an upload (size, PDF/JPEG/PNG by its bytes, its
   SHA-256). Get Canada Sim's originals are only read. The lead page's
   **Documents** card lists the current file of each type with View (a new
   tab) and Download, for anyone with `document.download` (owners, or the
   individual permission); others see the list and who can grant it. A file
   replaced in the old admin arrives as a newer revision on the next import
   run. In production on 2026-10-27: 121 files on 60 orders and partner
   applications, every one matching its original. Uploading or replacing a
   document in the CRM waits for moving day.
8. **Copy info and Print delivery letter** in the lead page's header, as
   in the old admin's row menu. Copy info puts the lead on the clipboard as
   plain text: its number, stage, customer, every answer and staff field as
   the page shows them, and which documents are on file. A SIM order's
   Print delivery letter opens Get Canada Sim's own mailer
   (`getcanadasim.com/delivery-letter.html`, the type's `deliveryLetterUrl`)
   filled from its query exactly as the old admin fills it; the page sends
   nothing anywhere, and the link carries no referrer.
9. **Carrier commission**: a staff-only SIM order field (Invoiced,
   Commission received, Clawback; unset means not tracked), edited in Staff
   details and imported from Get Canada Sim's `commission_status` (unused
   there so far). It voids nothing, as there.
10. **The full dashboard**, as Get Canada Sim's: the period (All time, Last
    3 months, Last 30 days, Last 7 days, opening on 7 days, as there) and the
    lead type (the site's busiest first) scope everything below. For SIM
    orders the tiles are its own: Received, Completed, Pending action
    (pending and verified, with the follow-ups due) and Cancellations with
    their rate, from the type's `outcomes` in the catalogue; a type without
    them lists its stages. Then the follow-ups due, the volume per day
    (cancellations aside; hover or the arrow keys read a day; a table for
    screen readers) and the top 10 partners. The stats query runs in about
    11 ms on Get Canada Sim's orders.
11. **Customer change requests** (Get Canada Sim's `/track` edits) come over
    with the import as the order's history: "Customer asked to change the
    arrival in canada and sent a new passport (request #12)", then "Old
    admin approved the customer's change request #12", naming fields and
    documents, never their values. While one still waits there, the lead
    page says so and where it is decided; approving and applying a request
    in the CRM comes with the move (its `/track` must then send them here).
    In production: all 69 requests on 57 orders (64 approved, 4 rejected, 1
    waiting).
12. **Shared property catalogue, property filters, sorting and columns.**
    Every form property is defined once in `packages/contracts/src/lead-properties.ts`
    (`leadPropertyCatalog` + `leadTypeProperties`), and `leadFieldCatalog`
    derives from it (`dateOfBirth` marked `sensitive: true`). `GET /workspaces/:id/leads`
    accepts `where` (up to 10 typed property filters combined with AND),
    `sort` (`createdAt`, `updatedAt`, `fullName`, `externalRef`, or `prop.<key>`)
    and `columns` (up to 6 property keys); `/leads/board` accepts `where`.
    All three (and a `fullName` sort) require contact access and reject sensitive properties. The
    admin inbox adds an `Add filter` builder, removable filter chips, sortable
    column headers (`aria-sort`) and a `Columns` picker (`?where=…&sort=…&cols=…`).

**Until staff move**, Get Canada Sim orders are worked in its own admin: the
CRM's copy is refreshed by re-running the import, and nothing the CRM changes
flows back to `public.orders`, which `/track`, the partner portal and the
invoices read.

### 3.5 2026-10-29: merge phase 2, property engine, layout and private saved views

Built on this branch from
[docs/superpowers/plans/2026-10-29-phase-2-properties-layout-views.md](superpowers/plans/2026-10-29-phase-2-properties-layout-views.md)
(it supersedes [briefs/lead-properties.md](briefs/lead-properties.md), which
PR #1 delivered). The code is merged on the branch; the migrations are **not
applied to the hosted project yet** (§5.1), so this is not deployed.

1. **Data.** Migration `0009_properties` adds `app.properties` (a site's
   built-in overrides, `origin = 'builtin'`, and custom properties,
   `origin = 'custom'`; a deleted custom property is a tombstone and its key
   stays reserved), `app.property_layouts` (one layout per site, object and
   lead type) and `app.saved_views` (a person's private views; its owner
   policy checks workspace and actor, so a colleague's view reads as missing),
   plus `leads.custom_values` (jsonb, default `{}`). `0010_properties_runtime`
   forces row security on the three tables, grants `app_runtime` and adds the
   `properties_identity_guard` trigger. Details and the verification selects
   are in [RUNBOOKS/database.md](RUNBOOKS/database.md); the owner's paste file
   is `RUNBOOKS/manual/0009-0010-properties.sql`.
2. **Contracts.** `packages/contracts/src/properties.ts`: `PropertyCatalog`,
   `buildPropertyCatalog` (code built-ins plus a site's rows),
   `codePropertyCatalog` (no rows), the twelve kinds (`text`, `longText`,
   `number`, `money` in integer cents of CAD, `date`, `dateTime`, `count`,
   `yesNo`, `choice`, `email`, `phone`, `url`; a custom property may be any
   but `dateTime` and `count`), custom keys `custom_<snake>` generated from
   the label, and the key rule `^[a-z][A-Za-z0-9_]{0,63}$`.
   `property-layouts.ts` (layout shape, default layout, rendering),
   `saved-views.ts` (`SavedViewState`, `SAVED_VIEW_LIMIT` 30, never the search
   `q` or the `page`) and `custom-values.ts` (applying edits to stored
   values). The endpoints and typed client carry the nine routes of §2.3.
3. **Backend.** `apps/backend/src/properties/{store,catalog}.ts` and
   `routes/properties.ts`; `views/store.ts` and `routes/views.ts`. The lead
   list, board, detail and PATCH routes load the site's catalogue once per
   request and validate `where`, `sort` and `columns` against it; custom
   values are filtered, sorted and returned like form values, and a stored
   value of the wrong type never matches and never throws. The new action
   `property.manage` is granted to the `owner` role only. A saved view's
   state is stored cleaned against the catalogue (no filter, column or sort
   on a sensitive, hidden or unknown key is ever written) and returned
   cleaned again (a property hidden or deleted since the view was saved drops
   out of that response; the stored row is untouched).
4. **Admin.** `components/crm/` holds the menus, filter chip, side panel and
   page header, with light and dark tokens in `app/crm-theme.css` (the shell
   keeps the shared 256 px sidebar and 56 px top bar). The leads inbox is the
   roomy table or the board under one toolbar (search, stage, assignee, Add
   filter, Follow-ups due, then Sort, Columns and View options as outline
   buttons; active filters as chips in a row of their own), with the saved
   view switcher at the right end of the type tabs
   (`saved-view-switcher.tsx`: save, rename, delete, dirty state). Its URL
   now carries `layout=` (`table` or `board`; the old
   `view=board` still works), `hide=` (hidden table columns, which replaces
   the browser setting `gt-table-hidden-cols`: it is read once, moved into the
   URL and forgotten), `view=` (a saved view's id), `lead=` (the record open in
   the side panel), and as before `where`, `sort`, `cols`.
   `components/properties/` holds `use-property-model`, `property-value`,
   `property-sections`, `properties-settings`, `property-editor` and
   `layout-editor`. **Settings → Properties** (everyone may read it; the write
   controls need `property.manage`) lists built-in and custom properties, adds,
   edits, hides and deletes them, and edits each lead type's layout. The lead
   record is rendered from the site's layout, and custom values are saved in
   the same PATCH as the form (`customValues`); the inbox opens it in the
   side panel (`lead=`, with "Open full page"), and "Copy info" copies what
   the layout shows (site labels, custom values, hidden properties left
   out). Date of birth and sensitive custom values show to every role with
   contact access; `access.revealSensitive` (`sensitive.reveal`, owners)
   gates only the sealed SIN reveal.

### 3.6 2026-10-30: merge phase 3, plans, stage clean-up and Archive

Built on this branch from
[docs/superpowers/plans/2026-10-30-phase-3-plans-stages-archive.md](superpowers/plans/2026-10-30-phase-3-plans-stages-archive.md).
The backend, the contracts, the Settings pages, the admin's Order section
and the Archive wording were merged to `main` with PR #4 on 2026-10-30. The
migrations were applied to the hosted project first (§5.1) and the backend
(which selects `leads.order_details`) deployed after them.

1. **Data.** Migration `0011_plans` (generated) adds `app.plans` (one order lead
   type each: name, price in cents, currency CAD, billing period `one_time`,
   `month`, `30_days`, `90_days` or `year`, payment required, active, required
   documents, custom values, position, version; a plan is never deleted, and
   `active` off hides it), `leads.order_details` (jsonb, default `{}`) and
   `properties.website_visible`. `0012_plans_runtime` forces row security on
   `plans`, grants `app_runtime` `SELECT, INSERT, UPDATE`, seeds Get Canada
   Sim's six SIM plans (monthly, payment required) and migrates the `sim_order`
   leads: every one gets its order details; `paid` becomes `pending` with
   payment status paid, `invoiced` becomes `completed` with payment status
   paid and carrier commission invoiced, and each lead so moved gets a system timeline entry by the "Old
   admin" actor. Details, hashes and the verification selects are in
   [RUNBOOKS/database.md](RUNBOOKS/database.md); the owner's paste file, with
   a before and after reconciliation, is
   `RUNBOOKS/manual/0011-0012-plans.sql`.
2. **Order details and stages.** A lead of an order type (`sim_order`,
   `internet`, `mobility`) carries `order_details`: `planId`, a frozen `plan`
   (the snapshot taken at submission or at a staff plan change), `quantity`
   (1–99), `paymentStatus` (`not_needed`, `pending`, `paid`) and
   `carrierCommission` (`not_yet`, `invoiced`, `received`, `clawback`). The
   `sim_order` stages are now exactly `incomplete`, `pending`, `verified`,
   `on_hold`, `delivered`, `activated`, `completed` and `cancelled`: payment
   and the carrier's commission are order details, not stages, and
   `commissionStatus` left the form. The Get Canada Sim import maps `paid` and
   `invoiced` the same way and no longer writes `commissionStatus`; the first
   import run after 0012 removes that key from orders that had one
   ([RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md)).
3. **Contracts.** `packages/contracts/src/plans.ts` (plan, snapshot, order
   details, `freezePlan`, `initialPaymentStatus`, `PLAN_LIMIT` 200 and the
   request and response schemas), the value lists in `packages/types`, and the
   endpoints and typed client for the three plan routes and the website plan
   list. The property engine has a third storage, `order`: the built-ins
   `plan`, `quantity`, `paymentStatus` and `carrierCommission` on order lead
   types, read from `leads.order_details`; `plan` reads `order_details.planId`
   through `storageKey` (the one map is `ORDER_STORAGE_KEYS` /
   `orderStorageKey`, beside `isOrderLeadType`), and its options are the
   site's plans of the lead's own type (`PlanOption.leadType`): an inactive
   plan, or another type's, stays readable as a hidden option, a typed filter
   lists only the type's plans, and the filter across types names each plan's
   type (`Basic (Mobility)`). `GET /properties` carries the site's plans with
   their types as `plans`, which the admin builds its catalogue from. A layout
   saved before phase 3 that places none of the order properties opens the
   record with them in an **Order** section instead of under "Other".
   `object=plan` selects plan properties on the property routes, and plan
   usage counts return `planCount`. `leadViewSchema` accepts `archived` and
   still `trash`.
4. **Backend.** `apps/backend/src/plans/{store,options}.ts` and
   `routes/plans.ts` (the routes of §2.3), `routes/website.ts` (`GET /plans`,
   `order` on intake, `submit` on `PATCH`, and a resumed draft's
   `order: { planId, quantity }` on `GET /leads/:id`), `leads/order.ts` and the lead
   store and work store (freeze at submission, re-freeze when staff change the
   plan, the order in the lead list, filters, sort and columns as the
   catalogue's order properties; a staff order edit writes only the changed
   fields over the stored `order_details`, so an unknown key or the stored
   frozen copy survives, and an order field's `empty` filter matches only
   order types). `POST /leads/:id/archive` is the new name of
   `/trash` (both work), `view=archived` of `view=trash`, and the summary
   returns `archived` (and `trash`, the same number).
5. **Admin.** **Settings → Plans** (`apps/admin/src/components/plans/`: the
   plans per order lead type, an editor, an Active switch; everyone reads it,
   `order.manage` writes) with **Plan properties** as a page under it
   (`settings/plans/properties`: custom plan properties and their _Show on
   website_ switch, through the same `PropertiesSettings` with `object="plan"`).
   The lead record gets an **Order** section (plan select of the site's
   active plans, an inactive current one marked, with the frozen copy beneath
   it or "No plan frozen yet"; quantity, payment status, carrier commission);
   the inbox filters and columns cover them; the timeline shows what the 0012
   migration changed. The admin says Archive instead of Trash. The URL
   parameter is `archived=1`, with the legacy `trash=1` still read (and
   rewritten, in the same change as the one-time move of this browser's
   hidden columns into `?hide=`), and a saved view with the legacy `trash` key
   opens the archive. Closing the side panel after a change reloads the list
   and the tab counts (an archive there shows the Archive tab at once).

### 3.7 2026-10-30: merge phase 4, order tools, customer email and automations

Built on this branch from
[docs/superpowers/plans/2026-10-30-phase-4-order-tools-email.md](superpowers/plans/2026-10-30-phase-4-order-tools-email.md).
The contracts, the migrations, the backend, Settings → Email, the Automations
page and the lead page's changes are merged on the branch. Migrations 0013 and
0014 were applied to the hosted project on 2026-10-30 (§5.1,
[RUNBOOKS/database.md](RUNBOOKS/database.md#0013_order_tools)), before the
branch's backend was deployed (it reads the six new tables and
`email_messages.template_version`). PR #6 merged 2026-10-30 15:19 UTC
(`acb9266`); Railway deployment `862df29a` succeeded, health 200; the Vercel
admin built from `main`. Live check after the deploy: no `app.automations`
rows (every rule off), no saved templates or email settings, no idempotency
keys, 920 leads untouched.

Owner rulings of 2026-10-30 on the plan's first draft:

- **D1.** The Orders role may override the documents check too (action
  `order.override`: owner and Orders, no individual permission). Moving a stage
  still needs `lead.manage`, so in practice the override is for the owner or a
  member who holds both the Leads and Orders roles; an Orders-only member
  cannot reach it. Widening that is a one-line role change if the owner wants
  it.
- **D2.** Activation is gated on `sim_order` and on `mobility`.
- **D3.** `EMAIL_SENDERS_JSON` stays as the fallback sender until a site's
  Settings → Email is saved; phase 5 removes it.
- **D4.** Customer tracking (the `tracking_code` email and the tracking page)
  stays phase 5. The template exists and can be edited, but nothing sends it
  yet.
- **D5.** Automatic emails are automation rules on a new Automations page, all
  off until the owner switches them on. A template is content only.

1. **Data.** Migration `0013_order_tools` (generated) adds six tables and one
   column: `app.idempotency_keys`, `app.workspace_email_settings`,
   `app.email_templates`, `app.email_template_versions`, `app.automations`,
   `app.automation_runs`, and the nullable `app.email_messages.template_version`.
   `0014_order_tools_runtime` forces row security on the six, grants
   `app_runtime` `SELECT, INSERT, UPDATE` on the first four and
   `SELECT, INSERT` only on the two append-only ones (versions and runs; no
   DELETE anywhere), and replaces `app.prune_operational_rows` with 0001's body
   plus two blocks: idempotency keys older than 7 days and automation runs older
   than 90 days. There is no data migration and no `enabled` column on a
   template. Details, hashes and the verification selects are in
   [RUNBOOKS/database.md](RUNBOOKS/database.md#0013_order_tools); the owner's
   paste file is `RUNBOOKS/manual/0013-0014-order-tools.sql`.
2. **Allowed moves and gates.** `leadTypeCatalog` now carries each type's
   `moves` and `gates` (`packages/contracts/src/lead-types.ts`). `sim_order`
   follows `incomplete` → `pending` → `verified` → `delivered` → `activated` →
   `completed`, with `on_hold` and `cancelled` off to the side
   (`cancelled` → `pending` takes an order up again); every other type allows
   any move. Delivered needs the dispatch details and the documents check;
   Activated (`sim_order` and `mobility`) needs the activation details and the
   documents check. The six new built-in order properties are `courier`,
   `trackingNumber` and `dispatchedAt` (dispatch) and `activatedAt`,
   `activationNumber` and `activationAccount` (activation), in
   `leads.order_details`, so the property engine shows, filters, sorts and lays
   them out as it does the other order properties. A move into Delivered
   requires a courier; the dates default to today in `America/Toronto`.
   `apps/backend/src/leads/stage-move.ts` decides a move and the `PATCH` (§2.3)
   answers `illegal_stage_move` with the moves that are allowed. A lead at a
   stage its type no longer lists may move to any listed one.
3. **Documents check and override.** `leads/documents-check.ts` finds the
   document types the order's frozen plan requires that have no current file
   with an `approved` latest review (a file replaced by a newer upload no
   longer counts, and a later rejection blocks again). A lead with no frozen
   plan, or a plan that requires nothing, is not blocked. The override takes a
   reason of 1–2000 characters, which the timeline shows as
   `documents_override` (the missing types and the reason) and the audit as
   `lead.documents_overridden`. The review itself stays `order.manage`.
4. **Double-submit protection.** `leads/idempotency.ts` ports Canadian Plans'
   scoped key and request fingerprint into `app.idempotency_keys`: the key is
   claimed in the lead's own transaction, so a retry (even two at once) makes
   one lead (§2.6 item 9).
5. **Customer email.** `apps/backend/src/email/`. A site's
   **sender and look** are in `app.workspace_email_settings`; its seven
   **templates** are in `app.email_templates`, each save appended to
   `app.email_template_versions`. The markup is parsed by `markup.ts` and drawn
   by one shared layout (`layout.ts`), with the site's logo, colour and footer.
   The backend renders a mail when it queues it (a rule firing, the staff
   "email the customer this number" send, a test), so the outbox job
   `lead_customer_email` only sends it, and the message records the template
   version (`email_messages.template_version`; 0 is the starter text). A mail is
   skipped, never half-sent, when the site has no sender (`no_sender`, also
   what every site gets while the deployment is not ready for customer mail;
   docs/ENV.md, `EMAIL_CONTACT_HASH_SECRET`), the lead
   has no email address (`no_customer_email`) or the template uses a fill-in
   the order has no value for (`missing_fill_in`). The sender is the saved
   settings, else the site's `EMAIL_SENDERS_JSON` entry in the default look,
   else none. The old `lead_sim_number_email` job type is still registered so a
   job queued before this phase still sends; new SIM number mails use the new
   job.
6. **Automations.** `apps/backend/src/automations/`. The six built-in rules
   (`BUILT_IN_AUTOMATIONS`) are: Order received when an order is submitted on
   the website (all three order types), Information needed on a SIM order
   moving to On hold, Dispatched on Delivered, Activated on Activated,
   Cancelled on Cancelled, and Activated again for a mobility order moving to
   Activated. Each site switches them on or off (`app.automations`, off by
   default, switching needs `integration.manage`). A stage move or a website
   submit fires the rules that are on **inside its own transaction**, once per
   occurrence (the move's timeline entry, or `submitted`), so a retry never
   mails twice. A lead the customer never submitted (`status` still
   `incomplete`, an abandoned checkout) fires no stage rule at all, so moving
   it to Cancelled mails nobody. That also holds for a checkout staff rescue
   by hand (Incomplete → Pending and onward): its Dispatched and Activated
   emails stay silent, because a staff move never changes `status`. If the
   owner wants rescued checkouts mailed, that is a small follow-up (flip
   `status` on the first staff move out of Incomplete). Each firing writes a
   run: `queued` with its
   outbox job, or `skipped` with the reason. A skipped rule never blocks the
   move or the submit; the move's response lists it as `emailSkipped` and the
   admin says so.
   The timeline shows a mailed customer as "<Template> email queued by an
   automation (version n)". Phase 8's builder adds custom rules to the same
   tables.
7. **Admin.** **Settings → Email** (`settings/email`,
   `src/components/email/`; it needs the Integrations permission,
   `integration.manage`, which the owner has and a member given the
   `integration_management` override has too): the sender and look, the seven
   templates with an editor (the fill-ins each may use, a live preview in a
   sandboxed frame, "Send me a test", the version, and which automation
   rules send the template). **Automations** (`automations`,
   `src/components/automations/`): the six rules in the owner's words with an
   On/Off switch (switching needs the Integrations permission, as Settings →
   Email does; everyone reads), how many emails each has
   queued, and Recent runs (lead, Queued or Skipped, why). On the lead page
   (`src/components/leads/`): the stage select lists the current stage and the
   allowed moves; a move into Delivered or Activated opens a dialog (Courier,
   Tracking number and Dispatched on, or Activated on, Activation number and
   Activation account, prefilled from the order). A refused documents check
   names the missing documents (“Missing approved documents: Passport”); with
   `overrideDocuments` it asks for a reason and offers "Move anyway", without it
   says to approve the documents first or ask someone with the Orders role.
   Each skipped email is explained after the move. The Documents card shows a
   badge (Approved, Rejected, Not reviewed) and, with `reviewDocuments`, Approve
   and Reject buttons. The timeline shows document reviews, an override and an
   automation's email. The board refuses a drop on Delivered or Activated
   (“Open the lead to move it to <stage>: it needs details.”) and puts a refused
   move's card back.
8. **Verified.** `apps/backend/tests/order-flow.integration.test.ts` runs a SIM
   order through the real stores and handler: a website submit with a key sends
   one Order received mail at template version 2; Verified; Delivered refused
   with `documents_incomplete` until the passport is approved, then Dispatched at
   version 1; the passport rejected again blocks Activated; a Leads-only
   member's override reason is refused at the route, one from a member with the
   Orders role is accepted (stored, on the timeline and audited), and one outbox run sends the three mails. The
   Playwright journey in `apps/admin/e2e/leads.spec.ts` ("a SIM order is
   approved, dispatched and activated by automations, and a template is edited
   and previewed") does the same through the admin, ending with a template
   saved as Version 2. It caught two bugs before release: the backend's CORS
   did not allow `PUT`, so the admin could not switch a rule or save Settings →
   Email from its own origin, and a move's response left out the email entry
   its automation wrote, so the timeline showed it only after a reload.

### 3.8 2026-10-30: merge phase 5, step A (Get Canada Sim orders in the CRM)

Built on branch `p5/a-crm` from
[docs/superpowers/plans/2026-10-30-phase-5-gcs-orders-and-tracking.md](superpowers/plans/2026-10-30-phase-5-gcs-orders-and-tracking.md)
(Part A, CRM tasks A1 to A5). The website side (Get Canada Sim's checkout
through the CRM behind `CRM_ORDERS`, tasks A6 to A8) is built in parallel in
that repository. Nothing is
deployed yet; migrations 0015 and 0016 were applied to the hosted project on
2026-10-30 (§5.1).

1. **Contracts.** `simOrderLeadPayloadSchema` (the checkout's ten optional
   keys), `SIM_ORDER_DELIVERIES`, `SIM_ORDER_PERMIT_TYPES`,
   `SIM_ORDER_REF_PREFIX` (`MS-`), `simOrderRef(n)` and `parseSimOrderRef`;
   `leadSummarySchema.externalRef` (string or null), so every website create
   and save returns the lead's reference.
2. **Database.** `0015_order_numbers` (generated): `app.site_counters`
   (`workspace_id`, `counter` checked to `sim_order_ref`, `last_value >= 0`,
   `updated_at`; primary key `(workspace_id, counter)`; tenant and backup
   read policies, so 36 of those). `0016_order_numbers_runtime`: FORCE RLS
   and `SELECT, INSERT, UPDATE` for `app_runtime`, no DELETE. Paste file
   [`RUNBOOKS/manual/0015-0016-order-numbers.sql`](RUNBOOKS/manual/0015-0016-order-numbers.sql),
   rehearsed on a local database migrated to 0014.
3. **SIM order intake** (§2.6 item 3). `sim_order` is modelled in the
   registry (`apps/backend/src/leads/types.ts`): a strict payload, a
   `submitCheck` (name and email, a plan, a delivery, an address for a mailed
   SIM), `checkLeadForm` for a save and `checkLeadSubmit` for a submission.
   The `PATCH` refuses an unmodelled field or an incomplete submission with
   `submission_incomplete` before anything is written; the route answers
   `400 validation_error { field }`.
4. **Order numbers** (§2.6 item 10). `nextSiteNumber`
   (`apps/backend/src/leads/site-counter.ts`) advances the site's counter in
   one statement, seeding itself from the site's highest `MS-<n>`;
   `createLead` takes a number only for a `sim_order` with no `externalRef`,
   after the idempotency claim and the order check.
5. **Switch day.** [`RUNBOOKS/manual/gcs-switch-day.sql`](RUNBOOKS/manual/gcs-switch-day.sql)
   holds the counter's seed (the highest `order_no` plus 9, `greatest`, so it
   never lowers) and four reconciliation selects;
   [RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md#the-final-run-switch-day)
   has the order of the day (seed, flip, final import, reconcile) and the
   `+ 1000` seed to run before any production test order.
6. **Verified.** `packages/db/tests/order-numbers.integration.test.ts` (RLS,
   FORCE, grants, checks, the cascade, 0016 re-run);
   `apps/backend/tests/sim-order-intake.test.ts` and the SIM order cases in
   `leads.test.ts` and `leads-store.integration.test.ts`;
   `apps/backend/tests/order-number.integration.test.ts` (imported `MS-140`
   and `MS-143` → `MS-144`, ten concurrent creates distinct, a website's own
   `MS-9000` kept, another site from `MS-1`, a replay and a refused create
   take none); the switch-day suite in
   `getcanadasim-legacy-import.integration.test.ts` (an order on each side of
   the flip, the `+ 1000` pre-switch case, the reconciliation).

**Step B (customer tracking)**, built on 2026-10-30 from the same plan (Part
B, CRM tasks B1 to B12 and B14) on the branch `phase-5-customer-tracking`
(the last two on `p5/b-finish`).
The website side (Get Canada Sim's `/track` through the CRM behind
`CRM_TRACKING`, task B13) is built in that repository and not merged. Nothing
of step B was deployed then, and migrations 0017 and 0018 were not applied
(both done on 2026-10-31, see "Deployed 2026-10-31" below).

1. **Contracts** (`packages/contracts/src/tracking.ts`). The limits
   (`TRACKING_CODE_TTL_MS`, `TRACKING_MAX_ATTEMPTS`, the per-email budgets,
   `TRACKING_GRANT_TTL_MS`, `TRACKING_GRANT_HEADER`), the changeable fields
   and stages, the customer's order shape (`trackingOrderSchema`), the six
   website endpoints and the two staff ones, the typed client
   (`client.tracking`, `client.staff.approveChangeRequest` /
   `rejectChangeRequest`), the `tracking` scope, the bot actions
   `tracking-request` and `tracking-verify`, the templates `change_approved`
   and `change_rejected` (nine in all) and `ALWAYS_SENT_TEMPLATES`.
2. **Database.** `0017_customer_tracking` (generated): `app.tracking_challenges`,
   `app.change_requests` (one pending per lead by a partial unique index),
   `files.held_for_change_request`, the leads email index and the widened
   template and counter checks. `0018_customer_tracking_runtime`: FORCE RLS,
   `SELECT, INSERT, UPDATE` without DELETE, and `prune_operational_rows`
   pruning challenges a day after they expire. Paste file
   [`RUNBOOKS/manual/0017-0018-customer-tracking.sql`](RUNBOOKS/manual/0017-0018-customer-tracking.sql),
   rehearsed on a local database migrated to 0016
   ([RUNBOOKS/database.md](RUNBOOKS/database.md#0017_customer_tracking)).
3. **Tracking core** (`apps/backend/src/tracking/`, ported from Canadian
   Plans and adapted to leads). `secrets.ts`: keyed hashes of the email, the
   code and the rate buckets, the six-digit code, the signed grant and the
   sealed values. `store.ts` and `service.ts`: the challenge (an advisory lock
   per email, a new request supersedes the pending one and its job), consume
   (5 tries, expiry, one use), the customer's order list (§2.6 item 11).
4. **The code mail.** Job type `tracking_code_email` (`tracking/delivery.ts`):
   it carries the code sealed, renders the site's `tracking_code` template
   only when it sends, skips a challenge that was used, superseded or
   expired, and leaves `{ challengeId }` as the payload whenever the job ends.
5. **Change requests and held documents** (`tracking/change-requests.ts`).
   The lead is locked first, then its pending request; a new request from the
   customer replaces the pending one (same number, `version + 1`, documents
   kept), and a document joining it bumps the version too. A customer's file
   is a held lead file: not on the Documents card, not current, never
   superseded by a staff upload while held. Numbers come from the counter
   `change_request_no`, after the imported ones.
6. **Approve and reject.** The staff edit's body was extracted as
   `applyLeadUpdate` (`leads/work-store.ts`), and approval applies the
   fields through it; the held files are released (current, waiting for an
   Orders review) or, on a rejection, tombstoned and their objects deleted
   after the commit. The Change approved or Change rejected email is queued
   in the decision's own transaction (dedupe
   `${leadId}:${template}:${changeRequestId}`), or the answer says why it
   was not (`emailSkipped`).
7. **Routes** (`src/routes/tracking.ts`, the decisions in `src/routes/staff.ts`),
   as in §2.3; the endpoint limit `tracking` (`RATE_LIMIT_TRACKING_*`).
8. **Admin.** The change request card on the lead page, above the Timeline
   (`components/leads/change-request-card.tsx`): each field now and asked
   for, the documents sent with it, Approve changes and Reject for the Leads
   role, "Restore this lead to decide this request." on an archived lead,
   and the outcome kept on screen with the focus on it; the timeline's words
   for the three entries; Settings → Email's "Always sent" lines; the
   `tracking` scope ("Order tracking") on site keys.
9. **The two phase 4 clean-ups** (§5.3): `EMAIL_SENDERS_JSON` and the
   `lead_sim_number_email` job type are gone from the code; a site without
   saved Settings → Email sends nothing (`no_sender`).
10. **Verified.** `apps/backend/tests/tracking-flow.integration.test.ts` is
    the done-when test: a submitted SIM order, the code requested through
    the route and sent by an outbox run, verified, the order listed, a change
    asked for with a passport uploaded, the request on the lead page without
    the held passport on its Documents card, an Orders-only member refused
    and a Leads member approving version 2, the timeline (`change_requested`
    twice, `edit`, `change_approved`, `customer_emailed`), the Change approved
    mail sent, the passport received then approved for the customer, the code
    job scrubbed, and no audit or timeline row holding the new phone. Beside
    it `tracking-store`, `tracking-secrets`, `tracking-code-mail`,
    `change-requests`, `change-request-decisions` and `tracking-routes` in
    `apps/backend/tests/`, `customer-tracking.integration.test.ts` in
    `packages/db/tests/`, and the tenth lead journey in
    `apps/admin/e2e/leads.spec.ts` (Nadia Khan's change request #1 approved
    on the lead page; the harness seeds it through
    `DatabaseChangeRequestStore.requestChange`).

11. **Final fix wave** (from the final review, on `p5/fix`). A submitted SIM
    order is Pending at once (a draft stays Incomplete), with `stage` in the
    audit and a `submitted` timeline entry; an imported order on `/track`
    names the website's plan from its form (`details.websitePlanSlug`,
    `details.websitePlanLabel`) and every SIM order lists the passport and
    visa; the order counter never issues a number a lead holds, and a number
    taken in the same moment answers `409 external_ref_taken`; a held file
    finalized after its order left the changeable stages is deleted rather
    than orphaned; the timeline reads "the phone and arrival in Canada"; the
    OpenAPI document marks `X-Turnstile-Token` as needed only in `turnstile`
    mode.

**Deployed 2026-10-31.** PR #9 (steps A and B) merged at 01:49 UTC as
`c9aa16c`; Railway deployment `93036a9a` succeeded at 01:51 UTC, health 200
throughout and the deploy logs clean; the admin was redeployed from `main`.
Migrations 0017 and 0018 were applied to production the same day through the
Supabase tool's `execute_sql`, verified against the schema: FORCE RLS, the
policies and grants, the `files.held_for_change_request` column and the
widened counter check. Get Canada Sim's website PR #28 merged the same day,
dark (`CRM_ORDERS` and `CRM_TRACKING` unset). PR #10 (the database test
suites run serially, after the other projects) merged the same day, after a
deadlock on `main`'s CI. Still open (§5.1): the owner's paste of the new
`app.prune_operational_rows` body (until then pruning skips tracking
challenges), then the 0017 and 0018 tracker rows, saving Settings → Email for
Get Canada Sim, the Railway tracking variables, then the switch day.

### 3.9 2026-10-31: merge phase 6, source report and intake check

Built on 2026-10-31 from
[docs/superpowers/plans/2026-10-31-phase-6-source-report-intake-check.md](superpowers/plans/2026-10-31-phase-6-source-report-intake-check.md)
(spec
[2026-10-31-phase-6-source-report-intake-check-design.md](superpowers/specs/2026-10-31-phase-6-source-report-intake-check-design.md),
owner-approved), in two batches merged into `phase-6-reports-checks`. No
migration. Umami (reading it or sending to it) is left for later (spec O3).
Nothing is deployed yet, and the intake check stays off until the owner's
steps in §5.1.

1. **Source report contracts** (`packages/contracts/src/reports.ts`):
   `SOURCE_REPORT_SUCCESS_STAGES` (`activated`, `installed`, `completed`,
   `won`), `SOURCE_REPORT_MAX_SOURCES` (50), `SOURCE_REPORT_MAX_CAMPAIGNS`
   (20), `SOURCE_KINDS`, the query (`leadType`, `days` 7/30/90 or none) and
   response schemas, the endpoint `getWorkspaceSourceReport` and the client's
   `staff.sourceReport`.
2. **Source report backend** (`apps/backend/src/reports/store.ts`,
   `src/routes/reports.ts`): one SQL statement in a tenant transaction over the
   leads `GET /leads/stats` counts (the site, the type, not archived, not
   restricted, the window), grouped by the source label computed in SQL with
   `deriveSource`'s precedence (`sourceLabelSql`) and by UTM campaign; a pure
   `shapeSourceReport` ranks the groups (most received first, then the label
   by code point) and sums whatever passes the caps into one `other` row (a
   campaign "Other" row carries `other: true`). Route
   `GET /api/v1/staff/workspaces/:id/reports/sources`, `workspace.read`.
3. **Reports → Sources** in the admin (`apps/admin/src/app/w/[workspace]/reports/sources`,
   `src/components/reports/source-report.tsx`, a Reports item in the sidebar):
   the period buttons (opening on the last 30 days), the lead type, a table of
   received, submitted, made it and the made-it rate per source with a
   source's campaigns behind a keyboard-usable toggle, a total row, and the
   notice "No source data yet…" while no counted lead carries attribution.
   Attribution is customer-influenced text: it is rendered as text only. The
   dashboard's period list moved to `src/lib/stats-windows.ts`.
4. **Intake check** (`apps/backend/src/intake-check/`): `check.ts` runs the
   four steps (leftovers older than 10 minutes, create through the website
   route's own `createLeadRequestSchema` and `checkLeadIntake` then
   `DatabaseLeadStore.createLead`, verify, delete) and never throws: any
   failure is `{ status: 'failed', step, code }` with a bounded snake-case
   code; `store.ts` deletes and reads only on the transaction's own site;
   `alert-rule.ts` decides the owner alerts (`synthetic_check_failed` with
   `<step>:<code>` on the first failure and at most hourly after, one
   `synthetic_check_recovered` with `failed_runs:<n>` on the first pass). The
   scheduler's fourth task `intake_check` (every 15 minutes) and the manual
   `POST /api/internal/jobs/intake-check` (`src/routes/intake-check.ts`). The
   error code `intake_check_off`. Paste file
   [`RUNBOOKS/manual/intake-check-site.sql`](RUNBOOKS/manual/intake-check-site.sql),
   rehearsed on a local database; runbook
   [RUNBOOKS/intake-check.md](RUNBOOKS/intake-check.md).
5. **Rulings made while planning** (plan header):
   - R1, no migration: deleting the test lead needs only `DELETE` on
     `app.leads`, which `app_runtime` has; every table a submitted `internet`
     lead can have rows in cascades, and a cascade runs as the referencing
     table's owner, so no delete grant on the append-only timeline is needed
     (proved as `app_runtime` by "the cascade needs no delete grant on the
     timeline").
   - R2, no index: the report reads exactly the rows the stats query reads;
     revisit past about 100 000 leads on one site.
   - R3, the test lead's form is a fixed fictional internet form, since an
     empty one is refused.
   - R4, the check goes through the route's own checks too; a refusal is a
     `create` failure `intake_refused_<part>`.
   - R5, identity: the scheduler entry `JOB_RUNNER_SELECTOR` names, verified
     with `CRON_SECRET`, holding `synthetic:check`; the site id comes from
     `INTAKE_CHECK_WORKSPACE_ID`, never from a request. A missing scope or a
     bad id leaves the check out and logs its code once; the other tasks run.
   - R6, only scheduled runs alert; the manual route returns the result.
   - R7, the production controlled failure removes and re-creates the test
     site row with the same id (paste sections C and D), not a variable
     change, which would restart the service and lose the alert state.
   - R8, a campaign row carries `other`, because a real campaign may be
     called "other" and `null` already means "no campaign".
   - R9, the alert subject is "GT Sales CRM: intake check failed".
   - R10, the manual route stays out of the endpoint registry, as
     `/api/internal/jobs/run` does.
   - R11, the report opens on the last 30 days; the dashboard keeps 7.
6. **Verified.** Backend: `source-report.test.ts`,
   `source-report.integration.test.ts` (counts per window and stage, totals
   equal to the stats for every window, other sites, types, archived and
   restricted leads never counted, odd characters and the maximum lengths,
   the SQL label equal to `deriveSource`, the 50-source cap),
   `report-routes.test.ts`; `intake-check.test.ts`,
   `intake-check.integration.test.ts` (a run leaves no lead, timeline, grant,
   job, run or mail behind; leftovers removed, a concurrent run's fresh lead
   kept, another site's lead never touched, the cascade as `app_runtime`, a
   missing site fails at create with `sqlstate_23503`, a failed delete
   cleaned up by the next run), `intake-alert-rule.test.ts`, the scheduler
   cases in `scheduler.test.ts` and `intake-check-route.test.ts`. Admin:
   `source-report.test.tsx` and the lead journey "the source report counts
   CanadaWide's internet leads per source and opens a source's campaigns".

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

### 5.0 The merge with Canadian Plans (approved 2026-10-28)

The merge design,
[docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md](superpowers/specs/2026-10-28-merge-canadian-plans-design.md),
approved by the owner on 2026-10-28, makes this repository one product,
deployed per business, and moves Canadian Plans' features in. Backups are its
phase 1, and
[docs/superpowers/plans/2026-10-29-phase-1-backups.md](superpowers/plans/2026-10-29-phase-1-backups.md)
is the implementation plan for that phase. Until phase 7, when Canadian Plans
moves, the Canadian Plans repository takes bug fixes only.

The remaining phases, 5 to 8, each have a hand-off page in
[docs/superpowers/phases/](superpowers/phases/README.md): what the phase is
for, what exists to build on, the decisions already taken, the questions for
the owner, a task outline, how to ship and the working method. A new session
told to start a phase reads that folder's README and the phase's page first.

### 5.1 Owner, before anything else

**Backups first (merge phase 1).** The code, the three workflows and the
runbooks are built and merged (pull request #2, 2026-10-29, on the owner's
instruction to complete everything that could be done from the session;
migrations 0007 + 0008 went in the same day). Until the owner finishes
[RUNBOOKS/backup.md](RUNBOOKS/backup.md) steps 3–6, every scheduled run of
the three backup workflows fails for want of secrets: noise only, nothing is
written anywhere. To silence it meanwhile, disable the three workflows in
GitHub → Actions (each workflow → "…" → Disable workflow) and enable them
again at step 7. The session never sees a secret; it reads only the run
logs.

| #   | Step ([backup.md](RUNBOOKS/backup.md))                                                                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Backblaze B2: private bucket `gt-sales-crm-archive` with the 30-day lifecycle rule; the writer, reader and retention keys with the B2 tool, into the password manager (step 3).                                                                                | To do                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B2  | Recovery key: `age-keygen` on the owner's computer; the private key in the password manager and one offline copy, the file deleted; the `age1…` recipient noted (step 4).                                                                                      | To do                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B3  | Supabase: the pre-paste check, migrations 0007 + 0008 from `RUNBOOKS/manual/0007-0008-backup-reader.sql`, the `backup_reader` password, the five verification selects one at a time, and a Storage S3 key for the backup (step 5).                             | Partly done 2026-10-29: pre-paste check, both migrations (through the Supabase tool, both trackers) and the five selects done by the developer. Select 4 gave `false, true, true, 0` and 5 returned both tables: Supabase keeps row security on `auth.users` and `auth.identities` and `postgres` cannot grant `USAGE` on `auth`, so gt-sales runs with `BACKUP_AUTH_DATA=skip` (workflow matrix). **Left for the owner: the password (step 5.3) and the Storage S3 key.** |
| B4  | GitHub: Environments `backup-gt-sales`, `backup-monitor-gt-sales`, `backup-retention-gt-sales`, each limited to `main` and holding only its own key, with their secrets; no required reviewers (step 6).                                                       | To do                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B5  | Merge the pull request, then the first run: Backup (`backup_completed`, `referencedObjectCount` 122 or today's count), Backup monitor (`status` `ok`), Backup retention as a dry run, read, then once for real; then one scheduled night stays green (step 7). | Merged 2026-10-29 (#2); the first run waits on B1–B4.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B6  | Restore drill on a scratch project ([RUNBOOKS/restore.md](RUNBOOKS/restore.md), "Drill"). Merge phase 1 is done when this is recorded.                                                                                                                         | To do                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Properties migrations (merge phase 2).** `0009_properties` and
`0010_properties_runtime` were applied to the hosted project on 2026-10-29 by
the developer through the Supabase tool (two migrations, both trackers), before
the branch's backend deploys (its lead queries select `leads.custom_values`).
The six verification selects of
[`RUNBOOKS/manual/0009-0010-properties.sql`](RUNBOOKS/manual/0009-0010-properties.sql)
all matched; the record is in
[RUNBOOKS/database.md](RUNBOOKS/database.md#0009_properties). Status: **done**.
For another deployment, paste that file into the SQL Editor as `postgres`, once.

**Plans migrations (merge phase 3).** `0011_plans` and `0012_plans_runtime`
were **applied to the hosted project on 2026-10-30** (Supabase tracker
versions `20261030041921` and `20261030041954`, both Drizzle tracker rows in
place), through the Supabase tool with the files' statements verbatim, with
the pre-check, the before/after reconciliation and the seven verification
selects of
[`RUNBOOKS/manual/0011-0012-plans.sql`](RUNBOOKS/manual/0011-0012-plans.sql)
around them. Before: 139 `sim_order` leads (44 archived), 20 in `paid`. After:
the 20 `paid` orders are `pending` with payment status `paid` (`pending` 59 →
79), every other stage unchanged, none left in `paid` or `invoiced`, every
SIM order with a payment status, six Get Canada Sim plans seeded, 20 timeline
entries. The statement-by-statement record is in
[RUNBOOKS/database.md](RUNBOOKS/database.md#0011_plans). For another
deployment, paste that file into the SQL Editor as `postgres`, once.
**Until this branch's backend is deployed, SIM orders are frozen:** run no Get
Canada Sim import from `main`'s old script (it writes the old admin's
`orders.status` straight into `stage`, so it would put the 20 orders back on
`paid`, and 0012 cannot be run again to repair them: its data step only
touches leads whose `order_details` is still `'{}'`), and staff should not move
SIM orders in the old admin in that window (a later import would carry the
move over). After the deploy, run verification select 7 again: `old_stages_left`
must be `0`. If it is not, run this branch's import (it maps the old statuses),
or remap the stragglers by hand in the SQL Editor; for a `paid` row:
`UPDATE app.leads SET stage = 'pending', order_details = order_details || '{"paymentStatus":"paid"}'::jsonb, updated_at = now() WHERE lead_type = 'sim_order' AND stage = 'paid';`
(an `invoiced` row becomes `completed` with `paymentStatus` `paid` and
`carrierCommission` `invoiced`).
PR #4 merged 2026-10-30 (`e33a70a`); the Railway deploy succeeded, health 200, and select 7 after it read `old_stages_left` 0: the freeze window is closed. Status: **done**.

**Order tools and email migrations (merge phase 4).** `0013_order_tools` and
`0014_order_tools_runtime` were applied to the hosted project on 2026-10-30,
before this branch's backend was deployed (it reads the six new tables and
`email_messages.template_version`): pre-check A clean, 0013 through the
Supabase tool, 0014 statement by statement (the `prune_operational_rows`
replacement pasted by the owner in the SQL editor), the seven verification
selects all as expected. The change is additive, with no data migration, so no
existing lead, stage or mail changed. The record is in
[RUNBOOKS/database.md](RUNBOOKS/database.md#0013_order_tools). Status:
**done**.

After that deploy, the owner's steps for each site (nothing is sent to a
customer until they are done):

1. **Settings → Email** (needs the Integrations permission,
   `integration.manage`: the owner has it, and so does a member given the
   `integration_management` override): the from name, the from address (on a
   domain verified in the Resend account of `RESEND_API_KEY`; for Get Canada
   Sim that is `getcanadasim.com`), optionally a reply-to, logo, brand colour,
   footer and the site's address (which makes `{tracking link}` work). Until
   they are saved, a site's `EMAIL_SENDERS_JSON` entry is the sender, in the
   default look, but only until the step B backend is deployed: from then on
   a site without saved settings sends no customer email (step B step 3).
2. **Read and edit the templates** (seven today, nine with step B's
   Change approved and Change rejected) if the starter text is not wanted, and
   press "Send me a test" on each one that will be used; the test goes to the
   signed-in owner's own address.
3. **Automations** (every rule starts off): switch a rule on only after
   checking that the website does not already send the same email, or customers
   get two. "When an order is submitted on the website" fires for every
   website order the moment it is on. Afterwards each rule's Recent runs show
   who was mailed and any that were skipped and why.
4. **Decide whether the Orders role alone may override the documents check**
   (the PATCH needs the Leads role; see the follow-ups in §5.3).
5. Optional, for each website's developer: send `Idempotency-Key` on a
   submission so a retry never makes a second order (§2.6 item 9).

**Get Canada Sim orders in the CRM (merge phase 5, step A).** Deployed
2026-10-31 with step B (PR #9, `c9aa16c`, §3.8); the website's checkout
through the CRM merged dark (Get Canada Sim PR #28, `CRM_ORDERS` unset). The
owner's steps, in order:

1. **Apply 0015 and 0016** before deploying the backend that numbers SIM
   orders: the pre-check, the paste and the six verification selects of
   [`RUNBOOKS/manual/0015-0016-order-numbers.sql`](RUNBOOKS/manual/0015-0016-order-numbers.sql)
   ([RUNBOOKS/database.md](RUNBOOKS/database.md#0015_order_numbers)).
   Status: **done** 2026-10-30 (all six verification selects as expected).
2. **Create the Get Canada Sim site key** in the admin
   (`/w/getcanadasim/settings`), scopes `leads:write` and `uploads:customer`
   (and `tracking`, so one key serves step B too; step B step 5); it goes
   into Get Canada Sim's Vercel project as `CRM_SITE_KEY` with `CRM_API_URL`,
   leaving `CRM_ORDERS` unset. Status: to do.
3. **The "Website slug" plan property and six plans.** Settings → Plans →
   properties: a custom plan property labelled "Website slug"
   (`custom_website_slug`), _Show on website_ on; then the six active
   `sim_order` plans each carry one of the website's slugs
   (`unlimited-data-120gb-rogers`, `unlimited-data-rogers`, `75gb-fido`,
   `95gb-chatr`, `25gb-chatr`, `75gb-chatr`). The checkout refuses to submit
   when no active plan, or more than one, carries a slug. Status: to do.
4. **Before the first production test order**, run the `SEED` block of
   [`RUNBOOKS/manual/gcs-switch-day.sql`](RUNBOOKS/manual/gcs-switch-day.sql)
   with `+ 1000` in place of both `+ 9` (so a test order's number, and a
   test change request's, is one the old checkout and the old admin cannot
   reach before the switch).
5. **Switch day** (plan Task A11, after Part B is deployed, owner decision
   D10): staff resolve the old admin's pending change requests; the `SEED`
   block (the order counter and the change request counter `change_request_no`,
   each past the old system's highest number plus 9), then `CRM_ORDERS=on`; the final import; the `RECONCILE` selects
   (`rows_missing` 0, no duplicated `MS-` reference); a test order checked in
   the CRM; then `CRM_TRACKING=on`. The steps are in
   [RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md#the-final-run-switch-day).
   Record the day, the two seed values and the reconciliation here and in §3.8.

**Customer tracking (merge phase 5, step B).** Deployed 2026-10-31: PR #9
merged at 01:49 UTC (`c9aa16c`), Railway deployment `93036a9a` succeeded at
01:51 UTC with health 200 throughout and clean deploy logs, the admin
redeployed from `main`; the website's `/track` through the CRM merged dark
(Get Canada Sim PR #28, `CRM_TRACKING` unset). Left: the
`app.prune_operational_rows` paste and the tracker rows (step 2), saving
Settings → Email for Get Canada Sim (step 3), the Railway tracking variables
(step 1 and check 3 below), then the switch day. The owner's steps, in order
(plan Task B15, then the switch day):

1. **`TRACKING_HASH_SECRET` on Railway** (service `crm`), before the deploy:
   a new secret of at least 32 characters (`openssl rand -base64 48`) that
   reuses no other one (docs/ENV.md, "Customer tracking"). Unset, tracking
   is off, not broken. Status: to do.
2. **Apply 0017 and 0018** before deploying the backend that has customer
   tracking: the pre-check, the paste and the eight verification selects of
   [`RUNBOOKS/manual/0017-0018-customer-tracking.sql`](RUNBOOKS/manual/0017-0018-customer-tracking.sql)
   ([RUNBOOKS/database.md](RUNBOOKS/database.md#0017_customer_tracking)); the
   `prune_operational_rows` replacement is the statement the owner pastes.
   Status: **applied 2026-10-31** through the Supabase tool's `execute_sql`,
   verified against the schema (FORCE RLS, the policies, the grants, the
   `files.held_for_change_request` column, the widened counter check). Left:
   the owner's paste of the new `app.prune_operational_rows` body (until then
   the daily pruning skips tracking challenges), then the 0017 and 0018
   tracker rows, inserted after that paste.
3. **Before the deploy, every sending site has saved Settings → Email.** This
   backend no longer reads `EMAIL_SENDERS_JSON`, so a site that still relies
   on it stops sending customer mail **at the deploy**, not when the variable
   is removed: the SIM-number mail and, from this step on, the tracking code
   and the two decision mails (they skip as `no_sender`). On 2026-10-30
   production had no saved settings for either site and had sent no customer
   mail in 30 days, so the settings are saved first (Settings → Email, the
   phase 4 steps above) and check 1 below is run. Then **deploy** the backend
   and then the admin, with `CRM_TRACKING` still unset on Get Canada Sim.
   Status: deployed 2026-10-31; Get Canada Sim's Settings → Email is not saved
   yet, so it sends no customer mail until it is.
4. **Remove `EMAIL_SENDERS_JSON` from Railway** after that deploy: nothing
   reads it any more. Status: to do.
5. **The Get Canada Sim site key gets the `tracking` scope**: create a new key
   in the admin (`/w/getcanadasim/settings`) with `leads:write`,
   `uploads:customer` and `tracking` ("Order tracking", not preselected) and
   put it into Get Canada Sim's Vercel project as `CRM_SITE_KEY`, or the
   website's tracking calls answer `403 scope_denied`. Status: to do.
6. **`PORTAL_SESSION_SECRET` on Get Canada Sim's Vercel project** (it signs
   the website's grant cookie; it is set in production today, check it is
   still there). Without it, `/track` with `CRM_TRACKING=on` says order
   tracking is unavailable. Status: check.
7. **A CORS check for the browser upload.** The customer's browser uploads a
   document straight to the signed upload URL on the Supabase Storage S3
   endpoint (`<project-ref>.storage.supabase.co`), a cross-origin `PUT` from
   `https://getcanadasim.com` with the signed headers. Nobody has checked yet
   that the endpoint accepts it; check it with the test order below before
   `CRM_TRACKING` goes on (the site's CSP already allows `*.supabase.co`). If
   it is refused, the customer sees "Upload failed. Please try again." while
   everything else works. Status: to do.
8. **A test order and a test change request** with a staff address, with
   the `+ 1000` seed of step A step 4 run first (for change request numbers
   too, PF3). Approve the request on the lead page; the Change approved
   email arrives.
9. **`CRM_TRACKING=on` is a switch-day step** (owner decision D10, plan Task
   A11), not one of these: it goes on after `CRM_ORDERS`, the final import
   and the switch-day test order (step A step 5). Phase 5 is done when a
   real customer's change request has been approved in the CRM; record it
   here and in §3.8.

**Pre-deploy and switch-day checks (step B, from the final review).** Run
each in the SQL editor or the dashboard named, and record the result here.

Before applying 0017/0018 and before the CRM deploy:

1. **Senders.** Every site that sends mail has saved settings. Expect one
   row per sending site with `saved` true (Get Canada Sim at least):
   ```sql
   select w.slug, s.workspace_id is not null as saved, s.from_address
   from app.workspaces w left join app.workspace_email_settings s on s.workspace_id = w.id
   order by w.slug;
   ```
   Compare with the site keys in Railway's `EMAIL_SENDERS_JSON` (names
   only): a key without a saved row means that site's mail stops at the
   deploy.
2. **Old SIM-number jobs.** Expect no rows; a pending or failed one would end
   `handler_not_registered`, so let it drain on the old backend or resolve
   it in the jobs admin first:
   ```sql
   select status, count(*) from app.outbox_jobs
   where job_type = 'lead_sim_number_email' and status <> 'completed' group by status;
   ```
3. **Railway variables** (names only): `TRACKING_HASH_SECRET` set (at least
   32 characters, new); `EMAIL_PROVIDER=resend` with `RESEND_API_KEY` (else
   every tracking code skips as `no_sender`); `WEBSITE_BOT_CHECK=delegated`
   (else every Get Canada Sim tracking and upload call answers 403: the
   website sends no Turnstile token); `EMAIL_CONTACT_HASH_SECRET` still set.
4. **Order of work.** 0017/0018 before the backend deploy: the new
   backend's document queries read `files.held_for_change_request`, so a
   deploy before the column exists breaks every document read and finalize,
   checkout uploads included. The paste file's select 5 confirms the column.

Before the B15 test order and before switch day:

5. **Site key scope.** Expect the active key to include `leads:write`,
   `uploads:customer` and `tracking`; then confirm Vercel's `CRM_SITE_KEY`
   is that key and redeploy (Vercel variables need a redeploy):
   ```sql
   select c.id, c.scopes, c.created_at from app.service_credentials c
   join app.workspaces w on w.id = c.workspace_id
   where w.slug = 'getcanadasim' and c.revoked_at is null;
   ```
6. **Plans.** Six active `sim_order` plans, one slug each, and the
   documents the business requires for staff's documents check (the
   customer is always asked for the passport and visa on `/track`):
   ```sql
   select p.name, p.active, p.custom_values ->> 'custom_website_slug' as slug, p.required_documents
   from app.plans p join app.workspaces w on w.id = p.workspace_id
   where w.slug = 'getcanadasim' and p.lead_type = 'sim_order' order by p.name;
   ```
7. **CORS** for the browser upload (step 7 above). With a signed URL from
   the B15 test order's upload intent (or a staff intent on a test lead):
   ```
   curl -i -X OPTIONS '<signed url>' -H 'Origin: https://getcanadasim.com' \
     -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: content-type'
   ```
   Expect 2xx with `access-control-allow-origin` covering
   `https://getcanadasim.com` and `PUT` allowed, then do the real browser
   upload in the test order: the passport must show on the request card. If
   CORS is refused, `CRM_TRACKING` can still go on with everything but
   uploads working (customers see "Upload failed"): the owner's call.
8. **The code mail was really sent** after the B15 test. Expect `completed`
   with a real provider id, never `skipped:…`, and payloads holding only
   `challengeId`:
   ```sql
   select status, provider_id, count(*) from app.outbox_jobs
   where job_type = 'tracking_code_email' group by status, provider_id;
   select payload from app.outbox_jobs where job_type='tracking_code_email' and status='completed' limit 3;
   ```
9. **Seeds** (PF2/PF3). Before the first test order run the `SEED` block
   with `+ 1000` in both places, then expect two rows, each at least the old
   system's highest number plus 1000; on the day run it with `+ 9`: the
   values must not drop:
   ```sql
   select counter, last_value from app.site_counters c join app.workspaces w on w.id = c.workspace_id
   where w.slug='getcanadasim';
   ```
10. **Vercel functions** (Get Canada Sim): Fluid compute on, or a maximum
    duration of at least 30 s for the project, unless `maxDuration` is set in
    the code; the checkout's step 2 can take 25 s.
11. **Switch-day stragglers.** After `CRM_ORDERS` goes on, expect 0 from
    `select count(*) from public.order_edit_requests where status = 'pending';`.
    Requests filed between staff's clean-up and the flip are frozen in the old
    admin; staff apply them by hand in the CRM.
12. **After the final import**, the `RECONCILE` block, and no CRM-made order
    at stage `incomplete` (a submitted SIM order is Pending at once). Expect
    no rows:
    ```sql
    select l.external_ref, l.stage from app.leads l join app.workspaces w on w.id=l.workspace_id
    where w.slug='getcanadasim' and l.status='submitted' and l.stage='incomplete'
      and not exists (select 1 from public.orders o where o.id=l.id);
    ```

If a switch-day step has to be undone, the rollback is in
[RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md#rollback): turning only
`CRM_TRACKING` off is safe; turning `CRM_ORDERS` off once CRM orders exist
needs the old checkout's order number moved past the CRM's first.

**Intake check (merge phase 6).** Built (§3.9), not deployed; once deployed
it stays off until these steps. The owner's steps, in order
([RUNBOOKS/intake-check.md](RUNBOOKS/intake-check.md)):

1. **Create the test site**: sections A and B of
   [`RUNBOOKS/manual/intake-check-site.sql`](RUNBOOKS/manual/intake-check-site.sql)
   in the SQL Editor, then the four verification selects (each 0); copy the
   id. Status: to do.
2. **The registry scope**: add `synthetic:check` to the `scopes` of the
   scheduler entry `JOB_RUNNER_SELECTOR` names in Railway's
   `MACHINE_REGISTRY_JSON`. Status: to do.
3. **`INTAKE_CHECK_WORKSPACE_ID`** on Railway (service `crm`) = the id from
   step 1, then redeploy. Status: to do.
4. **Watch two or three runs** in the deploy logs:
   `{"event":"intake_check","status":"ok",…}` every 15 minutes. A missing
   scope shows as `scheduler_scope_missing` at boot and no run. Status: to do.
5. **The controlled failure**, with the owner's agreement: section C of the
   paste file, the failure alert `create:sqlstate_23503` within 15 minutes,
   section D, the all-clear `failed_runs:<n>`. Record what was seen here and
   in the phases README status row ("Deployed"). Status: to do.

Then the CRM's own owner items:

1. **Switch CanadaWide to the CRM.** Done 2026-10-27: its first lead through
   the CRM arrived at 07:22 UTC and reached the old admin too. Left: its ID
   step. In Vercel, open the CanadaWide project → Settings → Environment
   Variables, add `CRM_ID_STEP=on` for Production, then redeploy; the next
   mobility application's ID then goes to the CRM (and still to the old
   admin), after which its two policies can go (§5.4).
2. ~~Close CanadaWide's anonymous lead inserts~~: done 2026-10-27; neither
   policy exists any more, and every CanadaWide lead since the switch is in
   the CRM (§5.4).
3. **Email from the CRM (SIM numbers to customers).** Set 2026-10-27:
   `RESEND_API_KEY` and `EMAIL_PROVIDER` are on Railway, applied, and the
   backend starts cleanly with them; the first SIM-number email is the
   proof that the key sends. As it was asked for: in the Resend account
   where `getcanadasim.com` is verified (the one Get Canada Sim sends with),
   create an API key: name "GT Sales CRM", permission "Sending access",
   domain `getcanadasim.com`. In Railway → project GT Sales CRM → service
   `crm` → Variables, add **both** `RESEND_API_KEY=<the key>` and
   `EMAIL_PROVIDER=resend`, then deploy (one without the other either does
   nothing or stops the backend from starting). The sender ("Get Canada Sim
   <order@getcanadasim.com>", customer replies to `info@getcanadasim.com`,
   the owner's choice of 2026-10-27), the default sender and the account
   label are already set. Optional later: a Resend webhook, so bounces and
   complaints reach the CRM's suppression list (ENV.md). Since phase 4 a site's
   sender is set in Settings → Email (the steps above); the `EMAIL_SENDERS_JSON`
   entry is only the fallback until then, and only until step B's backend is
   deployed (it no longer reads the variable).
4. **Custom SMTP for Supabase Auth**: on since 2026-10-27 04:50 UTC, when
   Auth's email limit went from 2 an hour to 30 (Supabase allows that only
   with custom SMTP). The first invitee's confirmation email is the proof
   that it delivers. As it was asked for: the built-in mailer refuses
   addresses outside the Supabase team. Simplest: in
   the Resend account Get Canada Sim already uses (domain `getcanadasim.com`
   verified there), create an API key, then Supabase → Authentication → Emails
   → SMTP: host `smtp.resend.com`, port 465, user `resend`, password the API
   key, sender e.g. `GT Sales CRM <crm@getcanadasim.com>`. The same account
   can later back the backend's `EMAIL_PROVIDER=resend`.
5. ~~Supabase Storage S3 keys in Railway~~: done; the `R2_*` variables are
   set, and the ID step's smoke test and the Get Canada Sim document copies
   ran through them.
6. Names and roles of the other admins; invite them from the admin (after 4).
   One invitation is out (2026-10-27, owner of CanadaWide only); it waits for
   the invitee to create their account with "I have a staff invitation".
   Each sets their own name under Settings → Your name (the owner too: until
   then colleagues see "Unnamed owner"); Settings → Team shows who has not.
7. **Decide when staff move from the old admin to the CRM** for CanadaWide.
   On the day: re-run the import (RUNBOOKS/legacy-import.md) so the last
   statuses and notes come over, then staff work only in the CRM. After that a
   session drops the 0002 mirror trigger and removes the Internet and Mobility
   Leads pages from the Get Canada Sim admin.
8. Move the Railway project into a GT Sales workspace; rotate the secrets
   generated during the build (`app_runtime` password, `CRON_SECRET`,
   `EMAIL_CONTACT_HASH_SECRET`, registry secrets) once stored properly.
9. Enable leaked-password protection (Supabase → Authentication → Policies);
   the security advisor flags it.
10. Optional: switch Supabase Auth's TOTP toggle off; nothing uses it.

### 5.2 Engineering: what remains of phases 1 and 2, per PLAN.md §6–7

- **Done:** the lead-type registry with `internet` and `mobility` modelled,
  one-shot intake, the legacy mirror, CanadaWide's two lead routes behind its
  env switch (§3.2); the historical import, stages, lead page, timeline, notes,
  tasks, assignment, board, My tasks, trash, related requests, the team list (§3.3).
  Still to do in phase 1:
- **CanadaWide's ID step** (`/api/mobility-applications`). The CRM side is
  built (2026-10-27), waiting on migration 0006 in production
  ([database runbook](RUNBOOKS/database.md#0006_legacy_identity_mirror_result-2026-10-27)):
  - `POST /website/leads/:leadId/identity/uploads` authorises a licence photo
    upload (the usual signed PUT, `drivers_licence` on the lead), and
    `POST /website/leads/:leadId/identity` records the identity: the finished
    upload (verified like any document) or a SIN with the date of birth. Both
    take `leads:write`, the `identity` endpoint limit (10 a minute per
    visitor), and only a mobility lead (the registry's `takesIdentity`) that is
    under 24 hours old, live and not restricted, with at most three
    identities. A retried submit returns the identity already on file.
  - The SIN is sealed under `SENSITIVE_FIELDS_KEY` (AES-256-GCM, bound to its
    row; `crypto/cipher.ts`); the database keeps only the last three digits
    readable. Without the key both routes answer `feature_not_ready`.
  - For a CanadaWide mobility lead the identity also goes to
    `public.mobility_id_uploads` in the same transaction (SIN in plain text
    there, as the old admin always had it), and a licence photo is first
    copied to the old admin's `mobility-ids` bucket at
    `<lead id>/<file id>.<ext>`. A failed copy fails the step (503,
    retryable), so the two admins never disagree.
  - Staff see identities on the lead page with contact access, a SIN as
    `*** *** 123`; only an owner can reveal it
    (`POST /staff/workspaces/:id/leads/:leadId/identities/:identityId/reveal`,
    action `sensitive.reveal`, no individual permission grants it), audited as
    `lead.identity_revealed` before the number is returned.
  - The lead page's **ID check** card lists them: a SIN masked, with Reveal
    for owners (shown for a minute, then masked again), a licence photo with
    Download (the usual `document.download` check).
  - CanadaWide's `/api/mobility-applications` sends the ID to the CRM once
    `CRM_ID_STEP=on` is set there as well (2026-10-27, its commit `2af30b7`):
    a SIN as it is, a licence photo with the signed PUT and then its SHA-256,
    one retry when the CRM is busy. Unset, it writes Supabase as before.
  - Smoke-tested in production 2026-10-27 after migration 0006, with a
    temporary CanadaWide key against the live backend: a mobility test lead,
    a test SIN (sealed, last three digits readable; a retry returned the same
    identity), a licence photo through the signed PUT to Supabase Storage
    (the first real upload through the S3 adapter) and its verified copy in
    `mobility-ids`, a third identity, then `identity_limit_reached` at the
    cap and a refused bad SIN that echoed nothing. All three identities were
    in `public.mobility_id_uploads` under the same ids, the audit trail held
    no SIN, about 1–2 s per call (4.4 s for the licence). The key was revoked
    and the test lead trashed in both admins; the 286-byte test photo stays
    in storage (no delete path without the Storage API key).
  - Next: the owner sets `CRM_ID_STEP=on` on CanadaWide's Vercel project and
    redeploys; once real IDs arrive, drop the last two anon policies.
- **Documents on Supabase Storage** through the existing S3 adapter. Its first
  quirk is fixed: Supabase serves S3 under `/storage/v1/s3`, and SigV4 must
  sign that path too (the adapter signed only `/bucket/key`). The owner's
  `R2_*` variables are applied; the first real upload is the ID step's smoke
  test (no current lead type has a draft grant for `uploads/intents`).
- **Model the planned types** (`sim_order`, `partner_application`,
  `contact_message`) when Get Canada Sim's forms move, at the cutover (merge design §12).

Still to do in phase 2:

- **Documents on the lead page**: done for Get Canada Sim's files (§3.4
  item 7); a mobility lead's licence photo shows in its ID check card. Left:
  staff upload and replace, and the review buttons (the `files/:id/review`
  route exists), with moving day.
- **Saved views** are done (§3.5): private, per person and site, in
  `app.saved_views`. **Plans, the stage clean-up and Archive** are built
  (§3.6); migrations 0011 and 0012 are applied in production (§5.1) and the
  branch ships with PR #4.
- **Phase 3b: the cross-site inbox, the contact page and split/merge.** The
  inbox that reads a query per site the admin belongs to (PLAN.md §5.2), the
  **contact page** (all leads of one person across sites) and **split/merge**
  of contacts, audited, were deferred from phase 2 to phase 3 and are
  deferred again (ruling of 2026-10-30). They are a small plan of their own,
  called phase 3b.
- **Merge phase 4: order tools and customer email** is built (§3.7): dispatch
  and activation, allowed stage moves, the documents gate and its override,
  protection against a double submit, customer emails per site and automation
  rules. Migrations 0013 and 0014 are applied (§5.1); PR #6 carries the code.
  Customer tracking is phase 5.
- **Cutover clean-up** once staff are on the CRM (§5.1 step 7): a migration
  dropping `leads_mirror_canadawide_legacy` and its function, and removing the
  old pages from the Get Canada Sim admin.

After that, the order of work is the merge design's: §5.0 above and its
phases ([spec §12](superpowers/specs/2026-10-28-merge-canadian-plans-design.md#12-phases)).

### 5.3 Technical follow-ups found during the build

- **Latency, what is left** (numbers in §3.3 item 6). A warm staff read is now
  the limiter (one round trip), Auth (~100 ms), the access snapshot (one) and
  the data transaction (begin, context, the statement's two, commit). Verify
  with `durationMs` in the deploy logs once staff use it. The remaining
  levers, safest first: (1) send BEGIN and the tenant context together
  (postgres-js awaits BEGIN alone; a reserved connection running
  `begin; select set_config(…)` over the simple protocol saves one round trip
  per transaction, but replaces drizzle's transaction wrapper); (2) the session
  pooler (port 5432) with `prepare: true`: every repeated statement one round
  trip instead of two, writes gain most; needs the session port in
  `DATABASE_URL` and a pool within the session-mode limit; (3) the access
  read and the data in one transaction. (The `getUser` cache, ~100 ms a
  request, is done: 60 seconds, the owner's choice, §2.5.) The query plans are not the problem: the slowest, the list
  page, runs in 14 ms on CanadaWide's 708 leads.
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
- **Properties follow-ups** (from the merge phase 2 reviews, none blocking):
  - `app.guard_restricted_lead()` (0001) does not cover `custom_values`. The
    work store already refuses edits on a restricted lead; extend the trigger
    in a later migration so the database refuses them too.
  - `customFilterCondition` duplicates the per-kind switch of
    `formFilterCondition` in `apps/backend/src/leads/staff-queries.ts`; fold
    them into one.
  - `apps/admin/src/components/leads/leads-inbox.tsx` has grown past 1200
    lines; extract the filter, sort and columns menus and a `useSavedViews`
    hook.
  - The trash and restore responses return the raw stored custom values
    instead of the shaped ones the detail route returns.
  - `property.manage` is granted to the `owner` role only; a per-member grant
    is not possible yet.
  - A built-in label override cannot be cleared back to the code label from
    the UI.
- **Plans follow-ups** (from the merge phase 3 reviews, none blocking; the
  properties list above stays):
  - An `empty` filter on an order property (`plan`, `quantity`,
    `paymentStatus`, `carrierCommission`) in an inbox list across all lead
    types also matches the leads of types that take no order.
  - A combined contact and order `PATCH` that the order part refuses still
    refreshes the contact (a pattern that was already there).
  - A plan property marked `staffOnly` can also be marked `websiteVisible`, and
    then the website sees it. Nothing refuses the pair yet.
  - The plan-versus-property-delete race, as the one known for leads: a plan
    saved at the moment its property is deleted can keep a value for it.
  - ~~Per-type allowed stage moves are unconstrained~~: done in phase 4 (§3.7
    item 2); `sim_order` follows its path, the other types allow any move.
- **Order tools and email follow-ups** (from the merge phase 4 reviews, none
  blocking). Cleanup that belongs to phase 5, when customer tracking replaces
  the old sending:
  - ~~Remove `EMAIL_SENDERS_JSON` (the fallback sender, ruling D3) once every
    site has saved Settings → Email, and remove the old `lead_sim_number_email`
    job type (kept only so a job queued before phase 4 still sends) with it.~~
    Done in the code in merge phase 5, step B (§3.8 step B item 9), not yet
    deployed; the variable comes off Railway after that deploy (§5.1, step B
    step 4).
  - Phase 8 builds custom automation rules on `app.automations` and
    `app.automation_runs`; until then the six rules are fixed.

  Things staff or the owner can run into:
  - ~~A `{fill-in}` inside a button label is neither filled nor refused~~:
    fixed in the phase 4 fix wave. A button label's fill-ins are filled and
    checked like body text, and a typed link address with `{` or `}` in it is
    refused (`bad_link`); `{tracking link}` as the whole address still works.
    Two markup oddities remain: `[button: ](url)` with an empty label reads as
    an ordinary link, and a `**` can close inside a link label.
  - ~~If a template was saved elsewhere after the editor loaded it, Save
    answers `version_conflict` and every further Save fails until the page is
    reloaded.~~ Fixed in the phase 4 fix wave: on a conflict the page reloads
    the templates itself, keeps the draft, and the next Save sends the fresh
    version.
  - A skipped automation run says why (`no sender`, `no customer email`,
    `missing fill-ins`) but the Automations page does not name the missing fill-ins;
    only the immediate notice after a stage move does.
  - A rule whose stored template no longer parses (not possible through the
    editor, which refuses it), or whose mail would not fit its outbox job (a
    long name can push a subject past 300 characters), is skipped without a
    run or a notice, so the move still succeeds and nothing is mailed; the
    backend logs the failure. A staff "email the customer this number" send of
    such a template is a 500 rather than a clear message.
  - A sender name with accented or other non-ASCII characters is quoted, not
    encoded as RFC 2047, so a provider may show it garbled. The Resend adapter
    is the one in use; test a name with "Send me a test".
  - An Orders-only member cannot reach the documents override: the stage
    `PATCH` needs `lead.manage`, so they cannot move a stage at all (this was
    already so). The override works for the owner and for members who hold both
    the Leads and Orders roles. Letting Orders move stages is a one-line role
    change; the owner decides (ruling D1).
  - A replayed draft create (a retry with the same `Idempotency-Key` and no
    `submit`) returns the same lead with a fresh draft grant each time, since
    the first token is never stored.

  Engineering notes:
  - The documents check reads files and reviews without locking them, so a
    review that lands during the same instant as a move may be missed; the
    window is narrow and a later move re-checks.
  - ~~The stage `PATCH` handler's outcome `switch` has no `never` guard.~~
    Fixed in the phase 4 fix wave: an unmapped outcome fails typecheck and
    answers 500 at runtime.
  - Tests: no test ties the SQL key lists of `0013` to the contracts
    (`BUILT_IN_AUTOMATION_KEYS` and the template keys are CHECK constraints, so
    a new rule needs a migration); the concurrency test of two simultaneous
    submits does not force the two to overlap.

- **Backups follow-ups** (from the merge phase 1 review, none blocking):
  - A CLI smoke step in CI: each of the four CLIs (backup, monitor,
    retention, restore) run with an empty environment must exit 1.
  - Scrub inherited `PGHOSTADDR`, `PGSERVICE` and `PGOPTIONS` in
    `pgConnectionEnv` (`jobs/src/backup/pg-dump.ts`), so a runner's own
    variables cannot redirect or reconfigure the dump connection.
  - A guard for tables in schemas the dump does not list (a table created in
    a new schema is silently outside the backup today).
  - `--no-psqlrc` and `ON_ERROR_STOP=1` on the sources' `psql` calls
    (`jobs/src/backup/sources.ts`).
  - A `baseEnv` parameter on the guard and the referenced-objects sources,
    as the exporter has, instead of reading `process.env` (the rehearsal
    stubs `PGSSLMODE` for them).
  - Retention reports the `deleted` count so far when it fails mid-run.
  - A SIGINT handler in the restore CLI that removes the decrypted
    temporary folder.
  - `requiredEnv` returns the trimmed value (it already rejects blanks).
  - Lost-key wording: one sentence, the same in backup.md §4, restore.md and
    the alert response.
  - Validate `BACKUP_RUN_ID` against the `run-<id>` shape the restore
    expects.
- **Phase 6 follow-ups** (spec §7 and the plan; none blocking):
  - **Umami**: the dashboard's visitors beside leads per source (reading the
    site's own Umami, read-only), left out of phase 6 (spec O3).
  - **Websites sending attribution**: neither website sends UTM tags or a
    referrer to the CRM yet, so every lead counts as `direct` and Reports →
    Sources shows "No source data yet". The CRM side already stores and
    counts it (`attribution` on `POST /website/leads`).
  - **A public-route check**: the intake check calls the store directly; a
    check through `POST /api/v1/website/leads` with a real site key (auth,
    rate limits, bot check) would also catch a broken route or credential.
  - **The test site's audit rows**: each intake check run leaves one
    `lead.created` audit row on the test site, about 96 a day, never pruned.
    Prune them, or record the check elsewhere.
  - **A stored check history**: runs are only in the logs and the alert
    state only in memory; a small table would show the last runs in the
    admin and keep the alert state across restarts.

### 5.4 Closing the anonymous write paths

| Policy (production)                                                      | Status                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `public.internet_leads` "anon can submit leads"                          | Dropped 2026-10-27, after every new `internet_leads` row had its `app.leads` id. |
| `public.mobility_leads` "anon can insert mobility leads"                 | Dropped 2026-10-27, the same check against `mobility_leads`.                     |
| `public.mobility_id_uploads` "anon can insert mobility id uploads"       | Stays until the ID step moves (§5.2).                                            |
| `storage.objects` "anon can upload mobility ids" (bucket `mobility-ids`) | Stays until the ID step moves (§5.2).                                            |

Verification for the first two. A matching `app.leads` id proves nothing on
its own: the historical import copies direct inserts into the CRM too. A row
came through the CRM only if intake audited its creation, so the check is the
rows that did **not** (zero rows after the switch = safe to drop):

```sql
select 'internet' as t, i.id, i.created_at from public.internet_leads i
where i.created_at > '<switch time>' and not exists (
  select 1 from app.audit_events e
  where e.entity_id = i.id and e.action = 'lead.created' and e.actor_label = 'website credential')
union all
select 'mobility', m.id, m.created_at from public.mobility_leads m
where m.created_at > '<switch time>' and not exists (
  select 1 from app.audit_events e
  where e.entity_id = m.id and e.action = 'lead.created' and e.actor_label = 'website credential');
```

`<switch time>` is the creation time of the first lead that did come through
intake. The scheduled check-in (daily from 2026-10-27 21:00 UTC until
2026-11-03) runs exactly this, refreshes the import while CanadaWide has not
switched, and drops the two policies once it has.

Then `drop policy "anon can submit leads" on public.internet_leads;` and
`drop policy "anon can insert mobility leads" on public.mobility_leads;`, and
confirm in `pg_policies`. CanadaWide's direct-write fallback then stops working,
which is the point: unset CRM variables would fail loudly instead of reopening
the path.

Checked 2026-10-27 10:25 UTC: switch at 07:22:21 UTC, every legacy row since
then came through intake (0 direct). CanadaWide's lead routes have no
Supabase fallback while the CRM is configured. The drop is ready as
[`RUNBOOKS/manual/close-canadawide-lead-inserts.sql`](RUNBOOKS/manual/close-canadawide-lead-inserts.sql):
it repeats this check inside its transaction and drops nothing unless it
passes (rehearsed on a scratch database both ways). The Supabase connector
holds DROP statements for a confirmation, so it is a paste in the SQL Editor.

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
