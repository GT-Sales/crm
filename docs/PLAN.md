# GT Sales CRM — build plan

**Status:** in production · **Written:** 2026-10-25, reduced to the current
plan 2026-11-17 · **Owner:** Md Takibuddin (builds and runs it) · **Client:**
GT Sales (owns it)

This replaces `docs/CRM_PLATFORM_PLAN.md` in the Get-Canada-Sim repo, which now
points here. What is live, what waits for an owner step and what comes next is
in [HANDOFF.md](HANDOFF.md); this file holds the decisions, the target
architecture and rules, and the phases that are not finished.

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
| 8   | **One product, built from this repository, deployed per business.** Canadian Plans' features move in where they earn their place; an order is a lead carrying order tools; stages, payment status and carrier commission are separate properties. | Decided 2026-10-28; the merge decisions are in §1.1 and its phases in §7.                                                                                                                          |
| 9   | In code, a website is a **`workspace`** (Canadian Plans' term). The UI says **Site**.                                                                                                                                                             | Keeps the copied code intact.                                                                                                                                                                      |

Reuse note: Canadian Plans has no LICENSE file and is owned solely by the
owner, so copying it into this private client repo is the owner granting the
client a copy. Check the client contract if exclusivity matters. The Canadian
Plans repo is public on GitHub. The admin's look adapts the Shadcnblocks admin
kit and blocks the owner supplied (Shadcnblocks.com License, copyright 2024
Shadcnblocks.com, supplied for a customized end product); no Twenty source is
in the repository.

### 1.1 Merge decisions (owner, 2026-10-28)

The owner's answers when this repository became the one product
("merge decision _n_" in the code and runbooks):

1. The owner owns all the code; no ownership constraint on reuse.
2. A reusable product: one codebase, one deployment and database per business,
   each configured for its own modules, rules and branding.
3. The order flow is basically the same across businesses (lead → sale →
   dispatch → activation → commission): one set of order tools, configured per
   business.
4. Websites are outside the product, each in its own repository, calling the
   API with a site key.
5. Multi-factor sign-in is off in every deployment (can be added back as an
   option if a client asks).
6. The same person on several sites of one business is merged by email;
   businesses never share customers (each has its own database).
7. Only GT Sales' data is live.
8. Base: this repository and its migration history; ported features come in
   with additive migrations.
9. Plans are an object managed in the admin; no Sanity sync.
10. Plans are built on the shared property engine (built-in plus custom
    properties per site); staff create no object types.
11. Each plan belongs to one site; nothing is shared or copied between sites.
12. No quote step and no offer versions: the backend reads the plan's price at
    submission, ignores any browser price and freezes a copy on the lead.
13. An order is a lead; each website form is a lead type; order lead types
    carry the order tools.
14. Order state is separate properties: stage (progress only), payment status,
    carrier commission.
15. Partners later: the partner code stays on leads; no partner screens or
    payouts yet.
16. Every change is on the lead's timeline (who, when, which field), customer
    actions too.
17. Customer tracking follows Get Canada Sim's flow: email → one-time code →
    orders → change requests that staff approve.
18. No admin feature deletes customer data: requests come through the
    website's contact page and a developer deletes in the database; staff can
    only archive.
19. Backups: Canadian Plans' backup system (database and documents, encrypted,
    to Backblaze B2, a practised restore), first; the archive key may write but
    never delete.
20. The source report moves in.
21. The province waitlist is skipped.
22. The synthetic check moves in, simplified: a test lead to a hidden test site
    every 15 minutes, an alert on failure, the check cleans up after itself.
23. Admin look: the CRM's colours and fonts with Twenty's layout (compact
    tables, view bar, side panel, board).
24. Saved views are private only.
25. A full automation builder, built last.
26. Analytics are read-only from the self-hosted Umami; the CRM sends nothing
    to Umami.
27. The repository stays at `GT-Sales/crm` with the `@gt-sales/*` names for
    now; the owner moves and renames it later in one step.
28. Order tools: plan with frozen price, dispatch and activation details, the
    documents check with a recorded override, double-submit protection,
    automatic customer emails off until switched on.
29. One lead is one sale, with a quantity.
30. Canadian Plans would move after phases 1–6 (since dropped, §7).
31. No blog editor and no partner portal in the CRM.
32. Customer email: one shared layout, site branding, editable text.

Hard to change once built on: an order is a lead; each plan belongs to one
site; contacts merged by email; stage keys (labels change freely, keys are
referenced by reports, emails and automations); the repository location and
package names.

## 2. Sources

| Repo                                     | Contributes                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Canadian-Plans/canadianplans-web-app`   | Monorepo tooling, strict TS + lint boundaries, CI, Dockerfile, Railway config; backend core (request ids, logging, errors, shutdown, scheduler, rate limits, machine registry); staff auth + MFA + RBAC; website credentials; documents (signed upload, signature verification); outbox + email module; audit; deletion/retention; admin shell, auth pages, site switcher, API client; `packages/*`. |
| `Md-Takibuddin/Get-Canada-Sim`           | Everything the business actually does: order flow, statuses, partners, commissions, invoices, blog editor, admin boards, partner portal, email templates, plan catalogue (`data.ts`), 44 SQL migrations, 30 test programs (converted to Vitest where useful).                                                                                                                                        |
| `Md-Takibuddin/Canadawide-Sales-website` | Field rules for internet and mobility leads (`lib/lead.ts`, `lib/mobility-application.ts`), ID upload step. Its lead routes send to the backend (`lib/crm.ts`).                                                                                                                                                                                                                                      |

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
  packages/
    contracts/        Zod request/response schemas, typed client, OpenAPI generator.
    db/               Drizzle schema, migrations, withTenantTx. Imported only by the backend.
    adapters/         Object store (S3), email (Resend), alerts, error tracking, logging.
    ui/               shadcn primitives + tokens.
    config/           tsconfig, ESLint (db import boundary), Prettier, Vitest, Playwright presets.
    observability/    Log-record builder + PII scrubber.
    types/            Shared domain types.
  jobs/               Outbox handlers; backup, monitor, retention and restore CLIs.
  docs/
```

At the cutover Get Canada Sim's `supabase/migrations` (0001–0044) are copied to
`supabase/legacy/` as the read-only record of the `public` schema (§6).

### Hosting

- **Backend:** Railway, Singapore (`asia-southeast1`), the Railway region nearest
  the Mumbai database and Auth. It started in US East (Virginia) on 2026-10-25,
  the closest region to the staff in Canada, but every staff request is a chain
  of sequential database round trips and the Virginia-to-Mumbai hop made the
  empty leads inbox take seven seconds; the owner moved it the same day. The
  admin stays on Vercel, so only API calls travel further. Long-lived
  container; the in-process scheduler runs the outbox, document clean-up, data
  retention, the automation tick and, when configured, the intake check
  (`apps/backend/src/scheduler.ts`).
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

## 4. What was reused

The Canadian Plans platform was copied on 2026-10-25 and pruned: the tooling
and packages (scope `@canadian-plans/*` → `@gt-sales/*`), the backend core,
staff auth and RBAC (without the authenticator-code step), website
credentials, documents, the outbox and email module, audit, retention and the
admin shell were kept; Sanity and the CMS contracts, the catalogue sync, offer
versions and quotes, Canadian Plans' own orders, commissions, invoices and
partners, `apps/site-1`, the region waitlist and SES were dropped. The migration
history started fresh (`0000_app_foundation` + `0001_runtime_functions`). The
backups (merge phase 1), the property engine, plans, order tools, customer
tracking, the source report, the intake check and automations were ported or
built later through the merge phases (§7). Get Canada Sim's own admin screens
(orders, partners, invoices, blog, admins, the partner portal) are not ported:
orders are leads with order tools here, and partners, invoices, the blog and
the portal are later or out of scope (§1.1, decisions 15 and 31).

## 5. Key adaptations

### 5.1 Site = workspace

`app.workspaces` gains `domain` and `status`. Seed rows: `getcanadasim`,
`canadawide`. Service credentials = site keys; their `scopes` say what the
site may do (`leads:write`, `uploads:customer`, `tracking`).

### 5.2 "All sites" reads

Canadian Plans' RLS allows one workspace per transaction. For the shared
inbox the backend runs one query per site the admin belongs to (2–5 sites)
and merges the results. No RLS change. If the number of sites grows, switch to
an `app.workspace_ids` setting with an `= any(...)` policy — a contained
change in `tenantPolicy`. Not built yet: phase 3b (§7).

### 5.3 Leads

`app.leads` keeps `workspace_id`, `status`, contact fields, `payload`,
`attribution`, `consent_version`, timestamps, and gains `lead_type`,
`contact_id`, `assigned_actor_id`, `deleted_at`, `external_ref` (the source
system's own id, e.g. `MS-123`; unique per site and type). A partner code
stays in `attribution` verbatim until partners come (§1.1, decision 15).

**Lead types are a registry in backend code** — Zod schema for `payload`,
allowed statuses, labels, which fields are PII. Adding a form = a registry
entry + a scope on the site's credential. The per-type working statuses are
the lead's `stage` (`leads.stage`), with labels, stages, allowed moves and
gates in `leadTypeCatalog` in the contracts so the admin shares them; `status`
stays the form's lifecycle.

| Type                  | Site           | Stages                                                                                                             |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `internet`            | CanadaWide     | `new`, `contacted`, `qualified`, `existing_shaw`, `non_serviceable_address`, `old_due`, `installed`, `won`, `lost` |
| `mobility`            | CanadaWide     | `new`, `contacted`, `qualified`, `activated`, `won`, `lost`                                                        |
| `sim_order`           | Get Canada Sim | `incomplete`, `pending`, `verified`, `on_hold`, `delivered`, `activated`, `completed`, `cancelled`                 |
| `partner_application` | Get Canada Sim | `new`, `contacted`, `approved`, `declined`; payload not modelled yet                                               |
| `contact_message`     | Get Canada Sim | `new`, `replied`, `closed` — **proposed**; today only emailed; payload not modelled yet                            |

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
and `+tags` are not stripped. Split/merge actions are audited (not built yet:
phase 3b).

### 5.5 Activities and tasks

`lead_activities` is the append-only timeline (note, status change,
assignment, email, call, edit, document, merge, system) and `lead_tasks` the
follow-ups (title, `due_at`, assignee, `status` open/in progress/done/cancelled,
`completed_at`). Get Canada Sim's per-table `reminder_*` columns became tasks
in the import.

### 5.6 Documents on Supabase Storage

Canadian Plans' `files` tables and documents service are kept whole. The S3
adapter's endpoint is the Supabase project's Storage S3 endpoint with Storage
S3 access keys, so the existing `documents` and `mobility-ids` buckets stay
put; Get Canada Sim's existing objects were copied into the CRM's part of the
`documents` bucket and registered as `files` rows by the import. Supabase
serves S3 under `/storage/v1/s3`, and SigV4 signs that path too.

### 5.7 Staff auth and roles

Supabase Auth (already part of the project), email and password, no
authenticator step. Mapping from Get Canada Sim:

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

Server-to-server with `Authorization: Bearer <credential>`; the full contract
is [HANDOFF.md](HANDOFF.md) §2.3 and §2.6.

| Route                                                   | Purpose                                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/website/leads`                            | Create a lead: `leadType`, optional `externalRef` (dedupe per site + type), `contact`, `form`, `consentVersion`, `attribution`. Returns `leadId` + a draft grant. |
| `PATCH /api/v1/website/leads/:id`                       | Step 2 of a two-step form (`X-Draft-Grant`). Same site only; expires.                                                                                             |
| `POST /api/v1/website/uploads/intents` → `.../finalize` | Signed upload URL for one path; backend re-reads the bytes, sniffs the type, attaches or deletes.                                                                 |

Idempotent per site + key; rate-limited per credential, forwarded visitor and
email (`rate_limit_buckets`).

### 5.9 Sensitive values

SIN (CanadaWide mobility) is sealed with `cipher.ts` (AES-256-GCM, key
`SENSITIVE_FIELDS_KEY` held only by the backend) on intake (the CRM's ID step,
`POST /website/leads/:leadId/identity`); shown as `*** *** 123`; full reveal
needs permission `sensitive.reveal` and writes an audit event. Documents:
private buckets, signed URLs, audited downloads. CanadaWide's
`public.mobility_id_uploads` (SINs in plain text) are not imported.

### 5.10 Dropped from Canadian Plans

Sanity and the CMS contracts, catalogue sync, offer versions and quotes,
CP's orders/commissions/invoices, site-1, region waitlist, SES, the Umami
sink, Turnstile (optional: production runs `WEBSITE_BOT_CHECK=delegated`,
docs/ENV.md).

## 6. Database plan

- **Schemas:** CRM tables in `app` (RLS, Drizzle migrations). Get Canada Sim's
  existing tables stay in `public`; the cutover adds `workspace_id` + RLS
  policies there when the backend takes them over.
- **Roles:** `app_runtime` (no `BYPASSRLS`, no superuser) for the backend over
  the pooled `DATABASE_URL`; migrations as the project's `postgres` role over
  `MIGRATION_DATABASE_URL`. `SET LOCAL app.workspace_id / app.actor_id` per
  transaction (`withTenantTx`), which works under the transaction-mode pooler.
- **Migration history:** fresh `0000_app_foundation` (drizzle-kit output,
  with the `app_runtime` role block prepended) + `0001_runtime_functions`
  (grants, FORCE RLS, `list_staff_workspaces`, `accept_staff_invitations`,
  `resolve_website_credential`, `rate_limit_hit`, `prune_operational_rows`,
  audit-redaction and customer-restriction triggers), then additive
  migrations applied deliberately (docs/RUNBOOKS/database.md). Get Canada
  Sim's `supabase/migrations` are copied to `supabase/legacy/` at the cutover
  as the record of `public`; future `public` changes are Drizzle migrations
  here.
- **Token prefixes:** site keys are `gtsk_…`, draft grants `gtdg_…`.
- **Data migration:** CanadaWide's and Get Canada Sim's histories are imported
  by re-runnable scripts (docs/RUNBOOKS/legacy-import.md), reconciled by
  counts. The old lead tables stay read-only and are dropped in a later step
  with the remaining anon insert policies.

## 7. Phases

| Phase                                                        | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM 0. Scaffold + deploy                                     | Done 2026-10-25.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CRM 1. Data + intake                                         | Done except CanadaWide's ID step (`CRM_ID_STEP=on` on CanadaWide, then the last two anon policies dropped) and modelling `partner_application` and `contact_message` when Get Canada Sim's forms move.                                                                                                                                                                                                                                                         |
| CRM 2. CRM screens                                           | Done, except retiring the old Internet/Mobility Leads pages at the staff cutover. The cross-site inbox, the contact page and split/merge moved to phase 3b.                                                                                                                                                                                                                                                                                                    |
| CRM 3b. Cross-site inbox, contact page, split/merge          | **Not started** (ruling of 2026-10-30): the inbox reading one query per site the member belongs to (§5.2), a contact page with one person's leads across sites, and audited split/merge of contacts.                                                                                                                                                                                                                                                           |
| Merge 1. Backups                                             | Built and merged 2026-10-29; the nightly backup runs (docs/RUNBOOKS/backup.md). Done when a restore drill (docs/RUNBOOKS/restore.md, "Drill") is recorded: status not confirmed in the repository.                                                                                                                                                                                                                                                             |
| Merge 2. Property engine, hybrid layout, private saved views | Done 2026-10-29.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Merge 3. Plans, stage clean-up, Archive                      | Done 2026-10-30.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Merge 4. Order tools and customer email                      | Done 2026-10-30.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Merge 5. Get Canada Sim orders, customer tracking            | CRM side deployed 2026-10-31; the website's checkout and `/track` through the CRM are merged dark. **Left: the switch day** (owner decision D10, HANDOFF.md §5.1). Done when a real customer's change request has been approved in the CRM.                                                                                                                                                                                                                    |
| Merge 6. Source report, intake check                         | Done 2026-10-31; the intake check is on since 2026-11-06. Visitors beside leads per source (Umami) not built; the Analytics page reads Umami separately.                                                                                                                                                                                                                                                                                                       |
| Merge 7. Canadian Plans moves                                | **Dropped** by the owner on 2026-10-31: Canadian Plans is out of scope; GT Sales only.                                                                                                                                                                                                                                                                                                                                                                         |
| Merge 8. Review, then automation flows                       | Done: step A live 2026-10-31 (PR #12), step B 2026-11-01 (PR #13).                                                                                                                                                                                                                                                                                                                                                                                             |
| Staff AI assistant ("Ask AI")                                | Live for both sites since 2026-11-04: read tools, confirmed tasks, notes, customer email and one-field lead updates, and automation drafts (docs/RUNBOOKS/ai-assistant.md, docs/design/ai-assistant.md). The saved chat (stored conversations, attached files, the owner's usage page; docs/design/ai-chat.md) is merged and waits on migrations 0034–0036 and `AI_ATTACHMENT_KINDS` (HANDOFF.md §3.2 items 15 and 16). Deferred items are in HANDOFF.md §5.2. |
| Cutover clean-up                                             | Waits for staff to move to the CRM: drop the 0002 mirror trigger and the 0005/0006 identity mirror functions in a new migration, remove the old pages from the Get Canada Sim admin (HANDOFF.md §5.2).                                                                                                                                                                                                                                                         |

## 8. Verification

Every phase ends with CI green: boundary lint (no `@gt-sales/db` outside the
backend), typecheck, lint, format, Vitest (including the RLS negative tests
against a disposable Postgres: missing context denies, wrong workspace sees
zero rows, runtime role cannot bypass), build, admin e2e. A data migration is
rehearsed with reconciled counts before the real run. Nothing reaches
production without the owner's approval.

## 9. Risks

| Risk                                        | Mitigation                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Admins must re-onboard (new password)       | Small team; invites sent by the owner; runbook copied                                                                              |
| Two admins in parallel until the cutover    | Move one area at a time; until switch day the old admin is Get Canada Sim's working system and the CRM's copy is refreshed nightly |
| Duplicate customer emails                   | Every automation starts off; the owner switches each one on per site after checking the website sends no copy of the same email    |
| Wrong merges by email                       | Email-only matching; audited split/merge                                                                                           |
| PII (SIN, IDs, DOB, addresses) under PIPEDA | Sealed fields, private storage, signed URLs, audited access, least privilege                                                       |

## 10. Needed from the owner

The full list of owner steps, with their status and runbooks, is
[HANDOFF.md](HANDOFF.md) §5.1. Decisions only the owner can make:

- When staff move from the old admin to the CRM (CanadaWide's staff cutover;
  Get Canada Sim's switch day).
- Whether the Orders role alone may override the documents check (ruling D1,
  §11).
- When to switch `OPERATIONAL_RETENTION_ENABLED` on (after a verified backup).
- Whether contact-form messages are stored as leads (`contact_message`), at
  the cutover.
- The list of admins to invite and who is `owner` / `finance`.
- The product name (working title: GT Sales CRM) and brand tokens.

## 11. Decisions and rulings cited from the code

Short definitions of the rulings and review findings that comments in the code
and AGENTS.md cite by name. The full write-ups are in `git log`.

**Phase 4 owner rulings (2026-10-30).** D1: the documents override is action
`order.override`, roles `owner` and `orders`, no individual permission; moving
a stage still needs `lead.manage`. D2: Activated is gated on `sim_order` and
`mobility`. D3: `EMAIL_SENDERS_JSON` was the fallback sender until phase 5
(removed). D4: customer tracking is phase 5. D5: automatic emails are
automation rules on the Automations page, all off until switched on; a template
is content only.

**Phase 5 (2026-10-30).** D10: one switch day after both parts are live:
`CRM_ORDERS` on, the final import, then `CRM_TRACKING` on. PF2: before the
first production test order, the switch-day seed runs with `+ 1000`. PF3: the
seed also sets the change request counter `change_request_no`. S1: the seed
leaves a gap of 9 past the old system's highest number (details in
docs/RUNBOOKS/legacy-import.md and `manual/gcs-switch-day.sql`).

**Phase 6 rulings (2026-10-31; intake check and source report).** R1: no
migration; deleting the test lead needs only `DELETE` on `app.leads`, its rows
elsewhere cascade. R2: no new index; revisit past about 100 000 leads on one
site. R3: the test lead's form is a fixed fictional internet form. R4: the
check goes through the website route's own checks; a refusal is a `create`
failure `intake_refused_<part>`. R5: the check runs as the scheduler entry,
which must hold `synthetic:check`; the site id comes only from
`INTAKE_CHECK_WORKSPACE_ID`; misconfigured, the check is left out and the
other tasks run. R6: only scheduled runs alert; the manual route returns the
result. R7: the production controlled failure removes and re-creates the test
site row (paste sections C and D), not a variable change. R8: a campaign row
carries `other`. R9: the alert subject is "GT Sales CRM: intake check failed".
R10: the manual route stays out of the endpoint registry. R11: the report
opens on the last 30 days.

**Phase 8 owner decisions (2026-10-31; automation flows).** O1: flows use
today's per-type stages. O2: triggers are submitted, enters a stage, time in a
stage (once per stay), task overdue, N days after submitted. O3: actions are
email the customer, create a task, assign the lead, notify staff (a link and
the flow's name, no customer details). O4: conditions on plan, lead type or a
non-sensitive property. O5: site-made email templates. O6: building and
switching need `integration.manage`; reading needs `workspace.read`. O7: a
visual canvas like Twenty's. O8: yes/no branches. O9: the first staff move out
of Incomplete counts as submitted, so the flows fire. O10: a built-in and a
custom flow on one event both send; the page warns. O11: flexible rules, a
Twenty-like canvas, the order emails as flows. O12: a rescued checkout counts
as submitted for every lead type. O13: the customer can no longer finish a
checkout staff rescued.

**Phase 8 design rulings.** R1: the 50-flow limit counts every flow not
archived, built-ins included. R2: a waiting run continues on the version it
started with; switching off or archiving cancels its waiting runs. R3: time
triggers never back-fill. R4: a submission counts as entering the stage the
lead stands in, so stage flows fire after the submitted flows. R5: lead changes
a flow makes are on the authority of the member who activated it, who needs
`lead.manage` too; each run re-checks it. R6: a flow naming something no
longer usable is skipped whole and marked "Needs attention". R7: an if/else is
the last step of its sequence. R8: flow moves chain at most 3 deep, never the
same flow twice. R9: staff notification mail goes to the member's sign-in
address recorded at sign-in, never shown. R10: the canvas is `@xyflow/react`
with our own auto-layout plus a list view. Controller ruling (2026-10-31): a
rescued checkout moved into a closing stage stays unsubmitted and fires
nothing; if the customer then submits it, it is submitted afresh at Pending
(SIM order) or the first stage (other types).

**Phase 8 plan rulings.** P5: chain depth 0 to 3; the fourth move is skipped
`chain_too_deep` while its emails still go. P6: a resumed run's chain comes from
`parent_run_id`. P7: every bulk change to waits and
timers claims rows `FOR UPDATE SKIP LOCKED`. P8: a staff notification job
carries no address. P10: the empty draft. P11: no flow sends `tracking_code`.
P12: unknown fill-ins refused; unusable properties are a site issue. P13: at
most 50 site-made templates, counted under a lock. P14: the 50-flow count
under an advisory lock. P15: changes are audited, draft saves are not. P17:
timers have no attempts column. P18: 200 items per site per tick. P19: lead
changes are written as the activator (a queued start as its write's actor).
P22: a write's response covers the flows it set off. P23: the site snapshot is
read lazily, once per write. P24: the test seam. P25: cancelling a waiting
run.

**Security review (2026-11-10).** M-1: the admin's per-request nonce CSP
(`apps/admin/src/proxy.ts`, `src/lib/csp.ts`). M-2: restricting an abandoned
draft erases its files, tasks, identities, note texts, contact link and
unreferenced contacts (migration 0030). L-1: a draft grant uploads and
downloads only while its lead is an unarchived draft. L-2: tracking-code
verification capped at 30 per email per 24 hours. L-3: a sent
`lead_customer_email` job is scrubbed to `{ leadId, template,
templateVersion }`. L-4: a per-visitor `uploads` budget and at most 10 open
upload intents per record. L-6, L-7, L-8: a malformed `MACHINE_REGISTRY_JSON`
disables machine routes only; process-level handlers and `GET /api/v1/ready`;
deadlines on Auth `getUser` (5 s) and tenant transactions (15 s statement, 30 s
idle). L-9, L-11: honest error statuses and no-store/nosniff/no-referrer on
`/api`. L-10: `/api/internal/jobs/run` is POST only and both job routes count
attempts per IP first. L-12: unsubscribe by POST (RFC 8058). L-13: set
`AI_ACTION_SIGNING_SECRET`. L-16: invitations expire after 14 days (migration
0031). I-1: pnpm override `qs@<6.16.1`. I-2: row security on and forced for
`app.workspaces` (0032, 0033). CW-B1: a website may send the lead's own id on
create (`409 lead_id_taken` when taken), so CanadaWide's fallback copy and a
late CRM save are one lead.

**AI and automation review (2026-11-05).** Chat: CHAT-1 the lead's name and
reference travel as a labelled data block, not in the system prompt; CHAT-2
the server replays only whole turns with a signed answer; CHAT-3
`AI_ACTION_SIGNING_SECRET` signs cards and proposals; CHAT-4 prepared cards
survive a failed explanation; CHAT-5 a failed request reports its own error;
CHAT-6 `app.ai_turns` usage rows and a 500-question daily ceiling per site;
CHAT-7 the replay guard goes through the shared limiter; CHAT-8 a named
authoring output limit; CHAT-9 a per-member budget on confirm and revise;
CHAT-10 fixed-window wording; CHAT-11 oversized chunks split; CHAT-12
per-tool progress labels. Actions: ACT-1 gated stage moves are marked and
refused with the staff edit's own errors; ACT-2 a revision supersedes its
card; ACT-3 a card signs a digest of the field's value; ACT-4 assignees beyond
24 members by name; ACT-5 no name or phone in clear in the token. Authoring:
AUTH-1 "assignee is" takes "me" or a name; AUTH-2 simulation applies allowed
moves and gates; AUTH-3 a simulated edit uses the edited flow's schema; AUTH-4
proposal statements name their actor and site; AUTH-5 revisions keep step ids;
AUTH-6 the three-card slot is taken before the row is written; AUTH-7 404 and
410 for missing and expired proposals; AUTH-8 simulation reads without
locking; AUTH-9 built-ins seeded as the system with an audit row; AUTH-10 NFKC
member names; AUTH-11 receipts and expired proposals leave the 100-row cap.
Engine: ENG-1 a Test run mails only the caller's own address; ENG-2 a flow
set off by an automation runs at most 3 times per lead in a rolling day; ENG-3 the switch-off advisory lock;
ENG-4 overdue work on a site the scheduler does not list is logged and
alerted; ENG-5 flows are matched inside the write and run after it commits;
ENG-6 archiving a lead cancels its waits and timers; ENG-7 a stay timer fires
only while its entry is the latest move (migration 0023); ENG-8 runs act as
the scheduler once the activator has left; ENG-9 the tick drains in passes and
reports a backlog; ENG-L1 runs keep their chain (migration 0026); ENG-L2
failed resumes back off 5/10/20/40 minutes; ENG-L3 built-ins are seeded
as the system, not by the viewer who opened the page; ENG-L4 switching on may carry `expectedRevision`; ENG-L5 the builder's
Test run follows live semantics; ENG-L6 staff notification links need an https
`ADMIN_ORIGIN`; ENG-L7 a step record that does not fit fails the step, not the
run; ENG-L8 (open) the lock order of `restore()` and `create()` differs. Admin:
UI-1 an automation card keeps its state when the panel closes; UI-2 card parts
merge by id; UI-3 a pending autosave is saved on leaving; UI-4 Reload says it
discards edits; UI-5 cards expire on time with specific errors; UI-6 no
placeholder ids; UI-7 no consecutive questions after Stop or an error; UI-8
abort-signal fallbacks; UI-9 Confirm and Edit wait while an answer streams;
UI-10 timeout and over-budget answers have their own advice.
