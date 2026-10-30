# GT Sales CRM — build plan

**Status:** approved to start · **Written:** 2026-10-25 · **Owner:** Md Takibuddin
(builds and runs it) · **Client:** GT Sales (owns it)

This replaces `docs/CRM_PLATFORM_PLAN.md` in the Get-Canada-Sim repo, which now
points here.

---

## 1. Decisions

| #   | Decision                                                                                                                                                                                                                                          | Notes                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Websites today: **Get Canada Sim** and **CanadaWide**. More will follow.                                                                                                                                                                          | A new site must need no new tables or admin pages.                                                                                                                                                 |
| 2   | **This repo** holds the backend, the admin and the shared packages. Each website stays in its own repo.                                                                                                                                           | Backend and admin change together; websites rarely touch the API.                                                                                                                                  |
| 3   | **Every SIM order is also a lead** in the shared inbox.                                                                                                                                                                                           | The order keeps its fulfilment screens.                                                                                                                                                            |
| 4   | **People are merged by email** across sites.                                                                                                                                                                                                      | Trimmed + lower-cased. Email only — never name or phone. Admins can split a wrong merge.                                                                                                           |
| 5   | **The database stays where it is**: the existing Get Canada Sim Supabase project (Mumbai, `ap-south-1`).                                                                                                                                          | Additive changes only. No copy to a new database.                                                                                                                                                  |
| 6   | **Copy and adapt the Canadian Plans platform** instead of building from scratch.                                                                                                                                                                  | Canadian Plans is the owner's own code. Its structure, infrastructure, auth, admin shell and tooling are reused. Its business data, brand, legal texts, plan catalogue and Sanity CMS are **not**. |
| 7   | Follows from 6: **Drizzle over a pooled Postgres connection with row-level security**, **Supabase Auth for staff**, **a service credential per website**, **S3-compatible object storage adapter**.                                               | Replaces Get Canada Sim's supabase-js-with-secret-key pattern.                                                                                                                                     |
| 8   | **One product, built from this repository, deployed per business.** Canadian Plans' features move in where they earn their place; an order is a lead carrying order tools; stages, payment status and carrier commission are separate properties. | Decided 2026-10-28; every decision and the phases are in docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md §2 and §12.                                                              |
| 9   | In code, a website is a **`workspace`** (Canadian Plans' term). The UI says **Site**.                                                                                                                                                             | Keeps the copied code intact.                                                                                                                                                                      |

Reuse note: Canadian Plans has no LICENSE file and is owned solely by the
owner, so copying it into this private client repo is the owner granting the
client a copy. Check the client contract if exclusivity matters. The Canadian
Plans repo is public on GitHub.

## 2. Sources

| Repo                                     | Contributes                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Canadian-Plans/canadianplans-web-app`   | Monorepo tooling, strict TS + lint boundaries, CI, Dockerfile, Railway config; backend core (request ids, logging, errors, shutdown, scheduler, rate limits, machine registry); staff auth + MFA + RBAC; website credentials; documents (signed upload, signature verification); outbox + email module; audit; deletion/retention; admin shell, auth pages, site switcher, API client; `packages/*`. |
| `Md-Takibuddin/Get-Canada-Sim`           | Everything the business actually does: order flow, statuses, partners, commissions, invoices, blog editor, admin boards, partner portal, email templates, plan catalogue (`data.ts`), 44 SQL migrations, 30 test programs (converted to Vitest where useful).                                                                                                                                        |
| `Md-Takibuddin/Canadawide-Sales-website` | Field rules for internet and mobility leads (`lib/lead.ts`, `lib/mobility-application.ts`), ID upload step. Phase 1 switches its three API routes to the backend.                                                                                                                                                                                                                                    |

## 3. Target architecture

```
getcanadasim.com ──┐
CanadaWide site ───┼── service credential ──►  Backend (Express, Railway) ──► Supabase Postgres
next website ──────┘                                   ▲          │             (pooled, RLS)
                                                       │          └──► Supabase Storage (S3 API)
                                            Admin / CRM (Next.js, Vercel)
                                            Supabase Auth session
```

### Repo layout

```
crm/
  apps/
    backend/          Express + strict TS. The only database client. Long-lived container on Railway.
    admin/            Next.js CRM. API client only.
    portal/           A later merge phase — partner portal (Next.js), ported from Get Canada Sim.
  packages/
    contracts/        Zod request/response schemas, typed client, OpenAPI generator.
    db/               Drizzle schema, migrations, withTenantTx. Imported only by the backend.
    adapters/         Object store (S3), email (Resend), alerts, error tracking, logging.
    ui/               shadcn primitives + tokens.
    config/           tsconfig, ESLint (db import boundary), Prettier, Vitest, Playwright presets.
    observability/    Log-record builder + PII scrubber.
    types/            Shared domain types.
  jobs/               Outbox handlers; backup/restore tooling later.
  supabase/legacy/    Get Canada Sim's 0001–0044 SQL, read-only record of the `public` schema.
  docs/
```

### Hosting

- **Backend:** Railway, Singapore (`asia-southeast1`), the Railway region nearest
  the Mumbai database and Auth. It started in US East (Virginia) on 2026-10-25,
  the closest region to the staff in Canada, but every staff request is a chain
  of sequential database round trips and the Virginia-to-Mumbai hop made the
  empty leads inbox take seven seconds; the owner moved it the same day. The
  admin stays on Vercel, so only API calls travel further. Long-lived container; in-process scheduler runs the outbox,
  the monthly invoice job and the daily notification drain.
- **Admin:** its own Vercel project.
- **Database / Auth / Storage:** the existing Supabase project. Backend connects
  through the transaction-mode pooler (port 6543) as a restricted
  `app_runtime` role. Staff sign in with Supabase Auth. Files stay in the
  existing private buckets, reached through Storage's S3-compatible endpoint.

### Rules

1. **The backend is the only database client.** Websites and the admin never
   hold a database key. (Browser-direct upload via a backend-issued signed URL
   is the one documented exception, as in both source repos.)
2. **Every tenant table carries `workspace_id NOT NULL`.** Cross-site tables
   are only `workspaces`, `memberships`, the Auth identities and `contacts`
   (§5.4).
3. **Isolation is enforced twice:** the backend authorizes each request, and
   Postgres RLS reads `app.workspace_id` set per transaction. Missing context
   denies.
4. **Each website authenticates with its own service credential**, stored
   hashed, revocable, scoped to the lead types it may submit.
5. **Server-side validation per lead type**: length caps, allow-listed enums,
   date formats, file signatures from magic bytes.
6. **Admin access = role × site membership.** An admin with membership only in
   CanadaWide never sees a Get Canada Sim lead, including on a merged contact.
7. **Sensitive values are protected.** ID documents stay private behind
   short-lived signed URLs; SINs are encrypted and shown masked; every reveal
   or download is audited.
8. **External side effects go through the outbox**, executed after commit.
9. **No PII in logs, errors or URLs.** No service-role key in application code.
10. **Strict TypeScript, no `any`.** Types, schemas and DB rows derive from one
    source; API responses expose only the fields each audience may see.
11. **"Not configured" and "the query failed" are different states.** A failed
    load shows an error, never sample data. A website never fakes success.

## 4. Reuse map

Legend: **Copy** = as-is apart from the package rename · **Adapt** = copy, then
change · **New** · **Drop** = not copied.

### Tooling and packages

| Item                                                                             | Action | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pnpm workspace, catalog, Node 22.19 / pnpm 9.15 pins, `.npmrc`                   | Copy   | Package scope `@canadian-plans/*` → `@gt-sales/*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/config` (tsconfig, ESLint boundary rule, Prettier, Vitest, Playwright) | Copy   | The rule that only the backend may import `@gt-sales/db` stays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/observability`, `packages/types`                                       | Copy   | Prune catalogue/quote types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/contracts`                                                             | Adapt  | Keep `common`, `health`, `client`, `openapi`, `staff-auth`, `files`, `jobs`, `members`, `uploads`, `exports`. Adapt `leads` (lead type, external ref, contact fields). New in phase 1–2: `sites`, `contacts`, `activities`, `tasks`, `lead-types`. `deletion` and `reports` return later on CRM data. Drop `catalogue`, `cms/*`, `quotes`, `orders` (CP's), `partners` (CP's), `regions`, `region-waitlist`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/db`                                                                    | Adapt  | Keep `index` (pooled client, `withTenantTx`), `migrate`, `ssl`, `tenantPolicy`, test helpers. Keep tables: `workspaces` (+ `domain`, `status`), `memberships`, `roles`, `membership_roles`, `permissions`, `membership_permissions`, `service_credentials`, `audit_events`, `rate_limit_buckets`, `outbox_jobs`, `outbox_job_alerts`, `files`, `file_revisions`, `file_review_events`, `email_*`, `marketing_consents`, `follow_up_schedules`. Adapt `leads`. New: `contacts`, `lead_activities`, `lead_tasks` (phase 0); `saved_views` (phase 2). `idempotency_keys`, `deletion_*` and `tracking_challenges` were CP-order-shaped and are not carried; contact deletion (phase 2) and order tracking (a later merge phase) add their own tables. Drop `products`, `offer_versions`, `product_availability`, `catalogue_sync_*`, `quotes`, CP `orders`/`order_*`, `commission_*`, `invoices`/`invoice_lines`, `dispatch_records`, `payment_records`, `region_waitlist`, `backup_leases` (the backups, ported in phase 1 of the merge, need no lease). **Fresh migration history**: `0000_app_foundation` (generated) + `0001_runtime_functions` (hand-written grants, FORCE RLS, functions, triggers). |
| `packages/adapters`                                                              | Adapt  | Keep `r2-s3` + `sigv4` (rename `object-store`; endpoint → Supabase Storage S3), `messaging` (Resend; drop SES), `alerts`, `error-tracking`, `logging`. Drop `sanity`, `static-catalogue`, `analytics` (Umami sink; add back if wanted), `deletion-ledger` (not ported with the backups).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/ui`                                                                    | Adapt  | Keep primitives, sidebar, sheet, table, file-drop, stepper. Drop `canadian-plans` tokens/components; add GT tokens when the client supplies a brand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CI (`ci.yml`), `Dockerfile`, `railway.json`, `.dockerignore`                     | Adapt  | Remove site-1 steps and Sanity; keep migration test against a disposable Postgres, boundary lint, typecheck, lint, format, unit tests, build, admin e2e.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `jobs/`                                                                          | Adapt  | Keep the outbox handler framework. Backup/monitor/restore/retention CLIs: ported in phase 1 of the merge (docs/RUNBOOKS/backup.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Backend (`apps/backend`)

| Module                                                                                                                      | Action | Notes                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`, `server`, `requestId`, `shutdown`, `scheduler`, `http/*`, `config/*`, `types/*`                                      | Copy   | Mount list pruned.                                                                                                                                                   |
| `machines/registry`                                                                                                         | Copy   | Scheduler identity, webhook secrets.                                                                                                                                 |
| `auth/session` (Supabase session)                                                                                           | Copy   |                                                                                                                                                                      |
| `staff/*` (memberships, roles, permissions, `authorize`, invitations, bootstrap lookup)                                     | Adapt  | Add a `leads` role; map Get Canada Sim sections (§5.7).                                                                                                              |
| `website/*` (credential middleware, session, turnstile)                                                                     | Adapt  | Turnstile optional — websites already run their own bot checks.                                                                                                      |
| `leads/*` (attribution, source sanitizer, draft-grant token, store)                                                         | Adapt  | Lead types, contacts, assignment, soft delete.                                                                                                                       |
| `documents/*` (grant, finalize, signature check, resolver, store)                                                           | Copy   | Store points at Supabase Storage.                                                                                                                                    |
| `tracking/*` (OTP, cipher)                                                                                                  | Copy   | `cipher.ts` (AES-256-GCM) generalized to seal SINs. Tracking itself returns in a later merge phase for `/track`.                                                     |
| `email/*`, `jobs/*`, `retention/*`                                                                                          | Copy   | Customer email comes in a later merge phase. `deletion/*` and `synthetic/*` were coupled to CP's order tables and were dropped; contact deletion arrives in phase 2. |
| `routes/health`, `routes/staff`, `routes/jobs`, `routes/email`, `routes/synthetic-check`                                    | Adapt  | Prune catalogue and CP-order endpoints.                                                                                                                              |
| `routes/website`                                                                                                            | Adapt  | Keep credential auth, rate limits, leads create/resume, documents. Drop offers/quotes/orders routes (Get Canada Sim's order flow arrives at the cutover).            |
| `catalogue/*`, `orders/*`, `partners/*` (CP's), `waitlist/*`, `routes/catalogue-sync`, `routes/sanity-webhook`, `reports/*` | Drop   | Reports return later on CRM data.                                                                                                                                    |

### Admin (`apps/admin`)

| Item                                                                                                                                                                                | Action | Notes                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| App shell, `app-sidebar`, `top-bar`, `workspace-switcher`, `protected-workspace-shell`, `staff-session-provider`, `lib/api`, `lib/supabase-auth`, `instrumentation`, error tracking | Copy   | Switcher gains **All sites**.                       |
| `/login`, `/recovery`, `/denied`                                                                                                                                                    | Copy   |                                                     |
| `/w/[workspace]/settings` (service credentials manager, jobs status, customer-data deletion, staff invite)                                                                          | Copy   | Credentials manager = site keys.                    |
| `leads-list`, `/w/[workspace]/leads`, `/documents`                                                                                                                                  | Adapt  | Starting point for the CRM inbox.                   |
| `/orders`, `/partners`, `/settings/catalogue`, `catalogue-status`, `source-report`                                                                                                  | Drop   | Replaced by the order tools of a later merge phase. |
| CRM pages: inbox, kanban, lead page, contact page, my tasks, saved views                                                                                                            | New    | Phase 2.                                            |

### From Get Canada Sim (at the cutover, ported into the backend + admin)

| Item                                                     | Size        | Notes                                                                                                               |
| -------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `lib/orders.ts`, `admin/actions.ts`, `OrdersBoard.tsx`   | ~5.2k lines | PostgREST chains → Drizzle queries; board copied (already Tailwind + shadcn), data layer swapped to the API client. |
| `lib/partners.ts`, `PartnersBoard.tsx`, `admin/partners` | ~1k         |                                                                                                                     |
| `lib/invoices.ts`, `admin/finance`                       | ~1.7k       | Monthly cron → scheduler job.                                                                                       |
| `admin/blog`, `lib/posts-server.ts`, `lib/markdown.ts`   | ~1.8k       | MDX editor stays in the admin; sanitizer moves to the backend.                                                      |
| `admin/admins`, `lib/admin-users.ts`                     | ~1.5k       | Becomes staff management on top of CP memberships/roles.                                                            |
| `app/portal`                                             | ~2.8k       | New `apps/portal`, partner login via OTP as today.                                                                  |
| `lib/email.ts` (templates)                               | ~1.3k       | Rendered in the backend, sent via the outbox.                                                                       |
| `lib/data.ts` (plans, prices), `lib/faq.ts`              | —           | Plan catalogue lives in the backend; the website reads it.                                                          |
| `scripts/test-*.mts`                                     | 30 files    | Behaviour carried into Vitest tests next to the ported code.                                                        |

## 5. Key adaptations

### 5.1 Site = workspace

`app.workspaces` gains `domain` and `status`. Seed rows: `getcanadasim`,
`canadawide`. Service credentials = site keys; their `scopes` list the lead
types the site may submit (`leads:internet`, `leads:mobility`, `leads:sim_order`,
`leads:partner_application`, `leads:contact_message`, `documents`).

### 5.2 "All sites" reads

Canadian Plans' RLS allows one workspace per transaction. For the shared
inbox the backend runs one query per site the admin belongs to (2–5 sites)
and merges the results. No RLS change. If the number of sites grows, switch to
an `app.workspace_ids` setting with an `= any(...)` policy — a contained
change in `tenantPolicy`.

### 5.3 Leads

`app.leads` keeps `workspace_id`, `status`, contact fields, `payload`,
`attribution`, `consent_version`, timestamps, and gains `lead_type`,
`contact_id`, `assigned_actor_id`, `deleted_at`, `external_ref` (the source
system's own id, e.g. `MS-123`; unique per site and type). `partner_id` and
`selected_offer_version_id` are dropped — a partner code stays in
`attribution` verbatim until a later merge phase brings a partner registry.

**Lead types are a registry in backend code** — Zod schema for `payload`,
allowed statuses, labels, which fields are PII. Adding a form = a registry
entry + a scope on the site's credential. (As built: the per-type working
statuses below are the lead's `stage`, column `leads.stage` from migration
0003, and the labels and stages live in `leadTypeCatalog` in the contracts so
the admin shares them; `status` stays the form's lifecycle.)

| Type                  | Site           | Statuses                                                                                                           |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `internet`            | CanadaWide     | `new`, `contacted`, `qualified`, `existing_shaw`, `non_serviceable_address`, `old_due`, `installed`, `won`, `lost` |
| `mobility`            | CanadaWide     | `new`, `contacted`, `qualified`, `activated`, `won`, `lost`                                                        |
| `sim_order`           | Get Canada Sim | The order's own statuses (`incomplete` … `cancelled`); stored once, on the order, from the cutover                 |
| `partner_application` | Get Canada Sim | `new`, `contacted`, `approved`, `declined`                                                                         |
| `contact_message`     | Get Canada Sim | `new`, `replied`, `closed` — **proposed**; today only emailed                                                      |

### 5.4 Contacts (merge by email)

`app.contacts`: `id`, `email` (normalized `lower(btrim(...))`, unique),
`full_name`, `phone`, `country_code`, timestamps. Global by design — the
documented exception to rule 2. Its RLS policy requires only a verified actor
(not "a lead in this workspace points at it"): intake on site B must find the
contact site A created before any lead of B references it, and the upsert
itself runs before the lead row exists. Tenant scoping is therefore enforced
by the backend, which only ever exposes a contact through a lead of the
current workspace and never lists the table. Intake normalizes the email,
finds-or-creates the contact, attaches the lead, and refreshes name/phone/
country from the latest submission without erasing earlier values. Gmail dots
and `+tags` are not stripped. Split/merge actions are audited.

### 5.5 Activities and tasks

Canadian Plans' `order_notes`, `order_status_history` and `order_reminders`
patterns become `lead_activities` (append-only timeline: note, status change,
assignment, email, call, edit, document, merge, system) and `lead_tasks`
(title, `due_at`, assignee, `status` open/done/cancelled, `completed_at`).
Both tables exist from phase 0; the screens that write them arrive in phase 2. Get Canada Sim's per-table `reminder_*`
columns migrate into `lead_tasks`.

### 5.6 Documents on Supabase Storage

Canadian Plans' `files` tables and documents service are kept whole. The S3
adapter's endpoint is set to the Supabase project's Storage S3 endpoint with
Storage S3 access keys, so the existing `documents` and `mobility-ids` buckets
stay put and existing objects are registered as `files` rows during
migration. Verify the endpoint and presigned URLs in phase 1 before relying on
it; fallback is a thin Supabase Storage adapter behind the same interface.

### 5.7 Staff auth and roles

Supabase Auth (already part of the project, unused today), email and password, no
authenticator step. Mapping
from Get Canada Sim:

| Get Canada Sim                                            | Here                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Super admin                                               | `owner` role in every workspace                                                                                                  |
| Section `orders` / `partners` / `finance` / `blog` (edit) | Roles `orders` / `partners` / `finance` / `content`                                                                              |
| Sections `internet_leads`, `mobility_leads`               | New role `leads` + membership in the matching site                                                                               |
| View-only on a section                                    | `viewer` role (whole workspace). Per-section view-only can be added as permissions later if needed                               |
| Email-or-username login, scrypt                           | Supabase Auth email + password. Existing hashes can't be imported, so each admin receives an invite and sets a new password once |
| Break-glass env super admin                               | Canadian Plans' recovery runbook (Auth dashboard)                                                                                |

Owner decision (25 Oct 2026): no multi-factor step. Canadian Plans' TOTP
requirement for `owner` and `finance` was removed, so a privileged action needs
only the role or permission that grants it.

### 5.8 Intake API (what websites call)

Server-to-server with `Authorization: Bearer <credential>`.

| Route                                                   | Purpose                                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/website/leads`                            | Create a lead: `leadType`, optional `externalRef` (dedupe per site + type), `contact`, `form`, `consentVersion`, `attribution`. Returns `leadId` + a draft grant. |
| `PATCH /api/v1/website/leads/:id`                       | Step 2 of a two-step form (`X-Draft-Grant`). Same site only; expires.                                                                                             |
| `POST /api/v1/website/documents/grant` → `.../finalize` | Signed upload URL for one path; backend re-reads the bytes, sniffs the type, attaches or deletes.                                                                 |

Idempotent per site + key; rate-limited per credential, forwarded IP and
email (`rate_limit_buckets`). Websites keep their own emails and ad events
until the cutover.

### 5.9 Sensitive values

SIN (CanadaWide mobility, `mobility_id_uploads.sin`, plain text today) is
sealed with `cipher.ts` (AES-256-GCM, key `SENSITIVE_FIELDS_KEY` held only by
the backend) at migration and on intake; shown as `*** *** 123`; full reveal
needs permission `sensitive.reveal` and writes an audit event. Documents:
private buckets, signed URLs, audited downloads.

### 5.10 Dropped from Canadian Plans

Sanity and the CMS contracts, catalogue sync, offer versions and quotes,
CP's orders/commissions/invoices, site-1, region waitlist, SES, Umami sink,
backup jobs (since ported back in phase 1 of the merge), Turnstile (optional: production runs `WEBSITE_BOT_CHECK=delegated`, docs/ENV.md).

## 6. Database plan

- **Schemas:** new CRM tables in `app` (RLS, Drizzle migrations). Get Canada
  Sim's existing tables stay in `public`; the cutover adds `workspace_id` + RLS
  policies there when the backend takes them over.
- **Roles:** `app_runtime` (no `BYPASSRLS`, no superuser) for the backend over
  the pooled `DATABASE_URL`; migrations as the project's `postgres` role over
  `MIGRATION_DATABASE_URL`. `SET LOCAL app.workspace_id / app.actor_id` per
  transaction (`withTenantTx`), which works under the transaction-mode pooler.
- **Migration history:** fresh `0000_app_foundation` (drizzle-kit output,
  with the `app_runtime` role block prepended) + `0001_runtime_functions`
  (grants, FORCE RLS, `list_staff_workspaces`, `accept_staff_invitations`,
  `resolve_website_credential`, `rate_limit_hit`, `prune_operational_rows`,
  audit-redaction and customer-restriction triggers). Get Canada Sim's
  `supabase/migrations` are copied to `supabase/legacy/` at the cutover as the
  record of `public`; future `public` changes are Drizzle migrations here.
- **Token prefixes:** site keys are `gtsk_…`, draft grants `gtdg_…`.
- **Auth:** enable email sign-in; custom SMTP via Resend so invites are not
  rate-limited; invite the owner first.
- **Storage:** create Storage S3 access keys; buckets unchanged.
- **Data migration** (phase 1, rehearsed on a Supabase branch or local
  restore, then row counts reconciled):
  1. seed `workspaces` + credentials;
  2. `internet_leads` → `leads(internet)` + `contacts`; `notes` → activity;
     `reminder_*` → task; keep `deleted_at`;
  3. `mobility_leads` + `mobility_id_uploads` → `leads(mobility)` + `files`,
     sealing SINs;
  4. `orders` → `leads(sim_order)` + contacts; `partners` →
     `leads(partner_application)`;
  5. old lead tables read-only; dropped in a later merge phase with the anon
     insert policies.

## 7. Phases

| Phase                    | Work                                                                                                                                                                                                                                                                                                                                                | Done when                                                                                                           | Effort     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| **0. Scaffold + deploy** | Copy and prune per §4; rename scope; fresh `0000`/`0001`; `contacts`, `lead_activities`, `lead_tasks` tables and lead-type/contact-merge intake; backend builds with auth, RBAC, credentials, documents, outbox, rate limits, audit; admin builds with shell, auth pages, switcher, settings; Supabase roles + Auth; Railway (US East) + Vercel; CI | Health check live on Railway; owner signs in; sees `getcanadasim` and `canadawide`; can create a site key; CI green | ~1 week    |
| **1. Data + intake**     | Lead-type registry (payload schemas, per-type statuses); intake routes per type; documents on Supabase Storage; SIN sealing; data migration; CanadaWide's three routes → backend; drop anon policies                                                                                                                                                | New CanadaWide submissions land in `app.leads`; counts reconcile; no anon write path left                           | ~1.5 weeks |
| **2. CRM screens**       | Inbox (all sites, filters, search, saved views), kanban per type, lead page (timeline, notes, tasks, documents, assign, status), contact page, my tasks, split/merge                                                                                                                                                                                | Staff work every lead here; old Internet/Mobility Leads pages retired                                               | ~2 weeks   |
| **3+. Merge phases**     | The eight phases of the merge design (spec §12): backups, property engine and layout, plans and stage clean-up, order tools and customer email, customer tracking, reports and checks, Canadian Plans' move, automations.                                                                                                                           | Each phase's own plan in docs/superpowers/plans/.                                                                   |            |

Status 2026-10-29: CRM phase 0 done; what remains of CRM phase 1 is in
docs/HANDOFF.md §5.2. CRM phase 2 core live as before: stages, lead page
(timeline, notes, tasks, assignment, contact corrections, trash), board per
type, My tasks. The merge design was approved on 2026-10-28. Phase 1 of the
merge (backups): the code, workflows and runbooks are built; it waits for the
owner's setup (§10, docs/RUNBOOKS/backup.md) and a practised restore. Phase 2
of the merge (property engine, hybrid layout, private saved views; plan in
docs/superpowers/plans/2026-10-29-phase-2-properties-layout-views.md) was
built on 2026-10-29: it waits on migrations 0009 and 0010 (§10) and the deploy.
Phase 3 of the merge (plans, the stage clean-up and Archive; plan in
docs/superpowers/plans/2026-10-30-phase-3-plans-stages-archive.md) was built
on 2026-10-30: it waits on migrations 0011 and 0012 (§10) and the deploy. The
CRM's own open items (the cross-site inbox, the contact page and split/merge)
move to a small phase 3b of their own (ruling of 2026-10-30); the cutover
clean-up waits for staff to move to the CRM (docs/HANDOFF.md §5.1).

## 8. Verification

Every phase ends with CI green: boundary lint (no `@gt-sales/db` outside the
backend), typecheck, lint, format, Vitest (including the RLS negative tests
against a disposable Postgres: missing context denies, wrong workspace sees
zero rows, runtime role cannot bypass), build, admin e2e. CRM phase 1 and the
cutover add a rehearsed data migration with reconciled counts before the real run. Nothing
reaches production without the owner's approval.

## 9. Risks

| Risk                                                                           | Mitigation                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Supabase Storage S3 endpoint differs from R2 in a detail the adapter relies on | Verified first thing in phase 1; thin Storage adapter behind the same interface as fallback |
| Custom `app_runtime` role + pooler on Supabase                                 | Canadian Plans runs exactly this; proven in its CI against disposable Postgres              |
| Admins must re-onboard (new password)                                          | Small team; invites sent by the owner; runbook copied                                       |
| Two admins in parallel during phases 2–3                                       | Link between them; move one area at a time                                                  |
| Losing leads during the CanadaWide switch                                      | Switch one route at a time; old route stays deployable until the new one is verified        |
| Wrong merges by email                                                          | Email-only matching; audited split/merge                                                    |
| PII (SIN, IDs, DOB, addresses) under PIPEDA                                    | Sealed fields, private storage, signed URLs, audited access, least privilege                |

## 10. Needed from the owner

State as of 2026-10-27 21:00 UTC (CRM phase 2 core live; CanadaWide switched to the CRM; both histories imported); the backup rows and the properties row were added 2026-10-29, the plans row 2026-10-30:

| Item                                                                                                                                                                                                                                   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backups, B2** (merge phase 1, docs/RUNBOOKS/backup.md step 3): private bucket `gt-sales-crm-archive` with the 30-day lifecycle rule; the writer, reader and retention keys                                                           | To do. The keys go into the password manager and then only into GitHub.                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Backups, recovery key** (step 4): an `age` key pair made on the owner's computer                                                                                                                                                     | To do. Private key in the password manager and one offline copy, never in GitHub, Railway, Vercel or chat; losing it makes every backup unreadable.                                                                                                                                                                                                                                                                                                                         |
| **Backups, Supabase** (step 5): the pre-paste check, migrations 0007 + 0008 (`docs/RUNBOOKS/manual/0007-0008-backup-reader.sql`), the `backup_reader` password, the verification selects, a Storage S3 key for the backup              | Migrations applied and verified 2026-10-29 (both trackers). `auth.users` and `auth.identities` keep row security and `USAGE` on `auth` is not grantable, so gt-sales backs up with `BACKUP_AUTH_DATA=skip` (workflow matrix). Left: the password and the Storage S3 key.                                                                                                                                                                                                    |
| **Backups, GitHub** (step 6): Environments `backup-gt-sales`, `backup-monitor-gt-sales`, `backup-retention-gt-sales`, limited to `main` and holding only its own key, with their secrets; no required reviewers                        | To do, before the pull request is merged (as are the three rows above).                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Backups, merge then first run** (step 7: retention dry run read, then once for real) and a restore drill (docs/RUNBOOKS/restore.md, "Drill")                                                                                         | To do. Merge phase 1 is done when one nightly run has landed and the drill is recorded.                                                                                                                                                                                                                                                                                                                                                                                     |
| **Properties migrations** (merge phase 2): `0009_properties` and `0010_properties_runtime` from `docs/RUNBOOKS/manual/0009-0010-properties.sql`, then its six verification selects                                                     | Applied 2026-10-29 through the Supabase tool (both trackers), six verification selects matched.                                                                                                                                                                                                                                                                                                                                                                             |
| **Plans migrations** (merge phase 3): `0011_plans` and `0012_plans_runtime` from `docs/RUNBOOKS/manual/0011-0012-plans.sql`: pre-check, the reconciliation before, the paste, its seven verification selects, the reconciliation after | To do, before the branch's backend is deployed (it selects `leads.order_details`). Production on 2026-10-30: 139 `sim_order` leads; the 20 in stage `paid` become `pending`, nothing else changes stage.                                                                                                                                                                                                                                                                    |
| **Supabase** `xykrphbgpwisqacpyeiv` (renamed `gtsales-crm`): `app` schema and `app_runtime` role                                                                                                                                       | Both migrations applied and recorded in both trackers. `0001` went in two parts: grants, DELETE-free functions and triggers through the Supabase tool, the rest (REVOKEs, FORCE RLS, three functions) pasted by the owner from `docs/RUNBOOKS/manual/0001-remaining.sql`. Verified against the schema, not the tracker: 10 functions, 24 tables with FORCE RLS, 4 triggers, PUBLIC cannot execute `accept_staff_invitations`.                                               |
| Sites `getcanadasim` and `canadawide` with roles, permissions and a pending `owner` invitation for the developer in both                                                                                                               | Done.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `app_runtime` password                                                                                                                                                                                                                 | Set 2026-10-25 and stored only in Railway `DATABASE_URL`. Rotate per docs/RUNBOOKS/database.md if it is ever exposed.                                                                                                                                                                                                                                                                                                                                                       |
| **Supabase Auth** (dashboard, not scriptable here): email provider on, Site URL `https://gt-sales-crm-admin.vercel.app`, redirect URL `https://gt-sales-crm-admin.vercel.app/**`, custom SMTP                                          | Site URL and redirects done by the owner 2026-10-25. Custom SMTP on since 2026-10-27 04:50 UTC (Auth's email limit went from 2 an hour to 30, which Supabase allows only with custom SMTP); the first invitee's confirmation email proves delivery.                                                                                                                                                                                                                         |
| **Supabase Storage** S3 access keys for the `documents` bucket                                                                                                                                                                         | Done: the backend's `R2_*` variables are set; the ID step's smoke test and the 121 Get Canada Sim document copies ran through them.                                                                                                                                                                                                                                                                                                                                         |
| **Resend**: which domain sends CRM mail (invites, alerts, later customer email)                                                                                                                                                        | Get Canada Sim's Resend account (`getcanadasim.com`). `RESEND_API_KEY` and `EMAIL_PROVIDER` are set on Railway (2026-10-27) and the backend starts cleanly with them; customer replies go to `info@getcanadasim.com`. The first SIM-number email proves the key sends.                                                                                                                                                                                                      |
| **Railway**: project `GT Sales CRM`, service `crm`, Singapore (nearest to the Mumbai database; see §7), public URL `https://crm-production-cf2e.up.railway.app`                                                                        | Created 2026-10-25 in the developer's personal Railway workspace (move to a client workspace later). Follows `main`. Variables set per docs/ENV.md; `ADMIN_ORIGIN` is `https://gt-sales-crm-admin.vercel.app`. The scheduler has run clean against the finished schema since the pooler host was corrected.                                                                                                                                                                 |
| **Vercel** team `gt-sales`: project `gt-sales-crm-admin`, repo `GT-Sales/crm`, root `apps/admin`                                                                                                                                       | Created 2026-10-25 by the owner in the dashboard (the connected token can update but not create projects on the team). Root `apps/admin`, Node 22 (the repo's `engines` field rejects the Vercel default of 24), production from `main`, the three `NEXT_PUBLIC_*` variables set. Live at `https://gt-sales-crm-admin.vercel.app`; use that host. The `gt-sales-crm-admin-gt-sales.vercel.app` alias is gated by Vercel's deployment protection and is not the CORS origin. |
| **CanadaWide switch**: a `leads:write` site key from the CRM admin, and `CRM_API_URL` + `CRM_SITE_KEY` on CanadaWide's Vercel project (personal team, not reachable from here)                                                         | Done: CanadaWide's first lead through the CRM arrived 2026-10-27 07:22 UTC, and the two anon lead-insert policies are dropped (confirmed by the daily check at 21:00 UTC). Left: `CRM_ID_STEP=on` on CanadaWide for its ID step (docs/HANDOFF.md §5.1 step 1).                                                                                                                                                                                                              |
| List of admins to invite, and who is `owner` / `finance`                                                                                                                                                                               | Owner. Each member sets a display name under Settings → Your name (colleagues see it on assignments and the timeline; emails are never shown).                                                                                                                                                                                                                                                                                                                              |
| **Staff cutover** for CanadaWide: the day staff stop using the old Internet/Mobility Leads pages                                                                                                                                       | Owner decision. On the day the import is re-run (docs/RUNBOOKS/legacy-import.md); afterwards the 0002 mirror is dropped and the old pages removed.                                                                                                                                                                                                                                                                                                                          |
| `SENSITIVE_FIELDS_KEY` for sealing SINs (§5.9)                                                                                                                                                                                         | Owner decision; blocks moving CanadaWide's ID step and importing `mobility_id_uploads`.                                                                                                                                                                                                                                                                                                                                                                                     |
| Confirm storing contact-form messages as leads (`contact_message`)                                                                                                                                                                     | At the cutover (merge design §12).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Product name (working title: GT Sales CRM) and brand tokens                                                                                                                                                                            | Any time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
